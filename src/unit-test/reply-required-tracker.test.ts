import { describe, expect, test } from "bun:test";
import { ReplyRequiredTracker } from "../reply-required-tracker";

describe("ReplyRequiredTracker", () => {
  test("a fresh tracker is not armed", () => {
    expect(new ReplyRequiredTracker().isArmed).toBe(false);
  });

  test("arm() activates force-forward", () => {
    const t = new ReplyRequiredTracker();
    t.arm();
    expect(t.isArmed).toBe(true);
  });

  test("B1 regression: a require_reply turn that never injected must stay unarmed", () => {
    // The daemon arms ONLY after a successful injection. When injection is
    // rejected (Codex busy), arm() is never called, so an unrelated in-flight
    // turn's chatter is NOT force-forwarded and the real request is not lost.
    const t = new ReplyRequiredTracker();
    // (no arm())
    t.noteForwarded(); // unrelated traffic must not flip any state while unarmed
    expect(t.isArmed).toBe(false);
    expect(t.consumeOnTurnComplete()).toEqual({ warnReplyMissing: false });
  });

  test("armed turn with no forwarded reply warns at completion, then resets", () => {
    const t = new ReplyRequiredTracker();
    t.arm();
    expect(t.consumeOnTurnComplete()).toEqual({ warnReplyMissing: true });
    expect(t.isArmed).toBe(false);
  });

  test("armed turn with a forwarded reply does not warn, then resets", () => {
    const t = new ReplyRequiredTracker();
    t.arm();
    t.noteForwarded();
    expect(t.consumeOnTurnComplete()).toEqual({ warnReplyMissing: false });
    expect(t.isArmed).toBe(false);
  });

  test("noteForwarded() is a no-op while unarmed", () => {
    const t = new ReplyRequiredTracker();
    t.noteForwarded();
    t.arm();
    // The pre-arm noteForwarded must not count toward THIS turn.
    expect(t.consumeOnTurnComplete()).toEqual({ warnReplyMissing: true });
  });

  test("reset() clears armed state without warning", () => {
    const t = new ReplyRequiredTracker();
    t.arm();
    t.reset();
    expect(t.isArmed).toBe(false);
    expect(t.consumeOnTurnComplete()).toEqual({ warnReplyMissing: false });
  });

  test("re-arming after completion starts a fresh turn", () => {
    const t = new ReplyRequiredTracker();
    t.arm();
    t.noteForwarded();
    t.consumeOnTurnComplete();
    t.arm(); // next require_reply turn
    expect(t.isArmed).toBe(true);
    expect(t.consumeOnTurnComplete()).toEqual({ warnReplyMissing: true });
  });
});

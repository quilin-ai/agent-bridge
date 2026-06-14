import { describe, expect, test } from "bun:test";
import { ResumeAckTracker } from "../budget/resume-ack-tracker";
import type { ResumeScheduler } from "../budget/resume-injection-queue";

/**
 * Deterministic fake scheduler: never touches real setTimeout, so the suite is
 * hermetic (no open handles, no hang, exit 0). Each scheduled callback gets a
 * synthetic timer handle; `flush()` fires the next pending timer (FIFO), which
 * is how we drive timeout/re-push transitions in tests.
 */
function createFakeScheduler() {
  let nextId = 1;
  const timers = new Map<number, { callback: () => void; delayMs: number }>();
  const scheduler: ResumeScheduler = {
    setTimeout(callback: () => void, delayMs: number) {
      const id = nextId++;
      timers.set(id, { callback, delayMs });
      return id;
    },
    clearTimeout(timer: unknown) {
      if (typeof timer === "number") timers.delete(timer);
    },
  };
  return {
    scheduler,
    /** Number of timers still pending (i.e. not fired and not cleared). */
    pending: () => timers.size,
    /** Fire the oldest pending timer once (simulating its delay elapsing). */
    flush() {
      const next = timers.keys().next();
      if (next.done) throw new Error("no pending timer to flush");
      const id = next.value as number;
      const entry = timers.get(id)!;
      timers.delete(id);
      entry.callback();
    },
  };
}

interface PushEvent {
  resumeId: string;
  deliveryId: string;
  attempt: number;
}

function createTracker(overrides: Partial<{
  timeoutMs: number;
  retries: number;
  onDegraded: (resumeId: string) => void;
}> = {}) {
  const fake = createFakeScheduler();
  const pushes: PushEvent[] = [];
  const degraded: string[] = [];
  const tracker = new ResumeAckTracker({
    push: (event: PushEvent) => pushes.push({ ...event }),
    scheduler: fake.scheduler,
    timeoutMs: overrides.timeoutMs ?? 60_000,
    retries: overrides.retries ?? 3,
    onDegraded: overrides.onDegraded ?? ((resumeId: string) => degraded.push(resumeId)),
  });
  return { tracker, fake, pushes, degraded };
}

describe("ResumeAckTracker — start", () => {
  test("start pushes once and arms a single timer", () => {
    const { tracker, fake, pushes } = createTracker();
    tracker.start("system_budget_claude_recovered_1");

    expect(pushes).toHaveLength(1);
    expect(pushes[0].resumeId).toBe("system_budget_claude_recovered_1");
    expect(pushes[0].attempt).toBe(0);
    expect(fake.pending()).toBe(1);

    const entry = tracker.get("system_budget_claude_recovered_1");
    expect(entry?.state).toBe("awaiting_ack");
    expect(entry?.attempts).toBe(0);
  });

  test("duplicate start for same resumeId is a no-op (idempotent)", () => {
    const { tracker, fake, pushes } = createTracker();
    tracker.start("rid_dup");
    tracker.start("rid_dup");

    expect(pushes).toHaveLength(1); // not re-pushed
    expect(fake.pending()).toBe(1); // not a second timer
    expect(tracker.size).toBe(1);
  });
});

describe("ResumeAckTracker — ack", () => {
  test("ack clears the timer and DELETES the terminal entry (map hygiene)", () => {
    const { tracker, fake } = createTracker();
    tracker.start("rid_ack");
    expect(fake.pending()).toBe(1);
    expect(tracker.size).toBe(1);

    tracker.ack("rid_ack");
    // Terminal entry is removed: get() returns undefined and size drops to 0.
    expect(tracker.get("rid_ack")).toBeUndefined();
    expect(tracker.size).toBe(0);
    expect(fake.pending()).toBe(0); // timer cleared on ack
  });

  test("repeated ack after resumed is a no-op (idempotent, no re-push, no throw)", () => {
    const { tracker, pushes } = createTracker();
    tracker.start("rid_ack2");
    tracker.ack("rid_ack2");
    const before = pushes.length;

    // Late/duplicate ack hits the unknown-id no-op path (entry already deleted).
    expect(() => tracker.ack("rid_ack2")).not.toThrow();
    expect(pushes.length).toBe(before); // no re-push
    expect(tracker.size).toBe(0);
  });

  test("ack for an unknown resumeId is a no-op (no throw)", () => {
    const { tracker } = createTracker();
    expect(() => tracker.ack("never_started")).not.toThrow();
    expect(tracker.size).toBe(0);
  });
});

describe("ResumeAckTracker — timeout / re-push", () => {
  test("timeout re-pushes with a NEW delivery id but the SAME resumeId, attempts++", () => {
    const { tracker, fake, pushes } = createTracker({ retries: 3 });
    tracker.start("rid_retry");

    const firstDelivery = pushes[0].deliveryId;
    expect(pushes[0].attempt).toBe(0);

    fake.flush(); // first timeout fires

    expect(pushes).toHaveLength(2);
    // resumeId is stable so Claude's echoed ack still correlates.
    expect(pushes[1].resumeId).toBe("rid_retry");
    // delivery id MUST differ so the LRU dedup in pushNotification does not drop it.
    expect(pushes[1].deliveryId).not.toBe(firstDelivery);
    expect(pushes[1].attempt).toBe(1);

    const entry = tracker.get("rid_retry");
    expect(entry?.attempts).toBe(1);
    expect(entry?.state).toBe("awaiting_ack");
    // A fresh timer is armed for the next retry window.
    expect(fake.pending()).toBe(1);
  });

  test("consecutive timeouts past retries degrade (terminal), DELETE the entry, and stop re-pushing", () => {
    const { tracker, fake, pushes, degraded } = createTracker({ retries: 3 });
    tracker.start("rid_degrade"); // attempt 0 push

    fake.flush(); // attempt 1
    fake.flush(); // attempt 2
    fake.flush(); // attempt 3 -> exhausts retries -> degraded

    // Terminal entry deleted: get() undefined, size 0 (map hygiene). The degrade
    // hook still fired with the resumeId.
    expect(tracker.get("rid_degrade")).toBeUndefined();
    expect(tracker.size).toBe(0);
    expect(degraded).toContain("rid_degrade");
    // No timer left running once degraded.
    expect(fake.pending()).toBe(0);

    // EXACTLY 3 pushes total (attempt 0 + 2 re-pushes; the 3rd timeout degrades
    // WITHOUT a 4th push) — pins the anti-spam upper bound, not just a floor.
    expect(pushes.length).toBe(3);
    // Every delivery id is distinct so the adapter's LRU dedup never drops a
    // re-push (the whole point of the per-attempt deliveryId).
    const deliveryIds = pushes.map((p) => p.deliveryId);
    expect(new Set(deliveryIds).size).toBe(3);
  });

  test("late ack after degraded is a no-op (entry gone, no re-push, no throw)", () => {
    const { tracker, fake, pushes } = createTracker({ retries: 3 });
    tracker.start("rid_late");
    fake.flush();
    fake.flush();
    fake.flush();
    expect(tracker.get("rid_late")).toBeUndefined(); // degraded → deleted
    expect(tracker.size).toBe(0);

    const before = pushes.length;
    expect(() => tracker.ack("rid_late")).not.toThrow(); // late ack after degrade
    expect(tracker.size).toBe(0);
    expect(pushes.length).toBe(before);
  });
});

describe("ResumeAckTracker — finitePositive option fallback", () => {
  // Captures the delay each timer is armed with so we can assert the timeoutMs
  // fallback, plus exposes flush() to drive the retries fallback.
  function createDelayCapturingScheduler() {
    let nextId = 1;
    const timers = new Map<number, () => void>();
    const delays: number[] = [];
    const scheduler: ResumeScheduler = {
      setTimeout(callback: () => void, delayMs: number) {
        const id = nextId++;
        timers.set(id, callback);
        delays.push(delayMs);
        return id;
      },
      clearTimeout(timer: unknown) {
        if (typeof timer === "number") timers.delete(timer);
      },
    };
    return {
      scheduler,
      delays,
      flush() {
        const next = timers.keys().next();
        if (next.done) throw new Error("no pending timer to flush");
        const id = next.value as number;
        const cb = timers.get(id)!;
        timers.delete(id);
        cb();
      },
    };
  }

  test("illegal timeoutMs (0) falls back to the 60_000 default, not literal 0", () => {
    const cap = createDelayCapturingScheduler();
    const tracker = new ResumeAckTracker({
      push: () => {},
      scheduler: cap.scheduler,
      timeoutMs: 0,
      retries: 3,
    });
    tracker.start("rid_to0");
    expect(cap.delays[0]).toBe(60_000);
  });

  test("illegal timeoutMs (NaN) falls back to the 60_000 default", () => {
    const cap = createDelayCapturingScheduler();
    const tracker = new ResumeAckTracker({
      push: () => {},
      scheduler: cap.scheduler,
      timeoutMs: Number.NaN,
      retries: 3,
    });
    tracker.start("rid_tonan");
    expect(cap.delays[0]).toBe(60_000);
  });

  test("illegal retries (0) falls back to the 3 default — 3 flushes to degrade, not 1", () => {
    const cap = createDelayCapturingScheduler();
    const degraded: string[] = [];
    const tracker = new ResumeAckTracker({
      push: () => {},
      scheduler: cap.scheduler,
      timeoutMs: 60_000,
      retries: 0, // literal 0 would degrade on the FIRST timeout; fallback 3 must not
      onDegraded: (rid) => degraded.push(rid),
    });
    tracker.start("rid_re0");

    cap.flush(); // attempt 1
    cap.flush(); // attempt 2
    expect(degraded).toHaveLength(0); // still awaiting → proves 0 fell back to 3
    expect(tracker.get("rid_re0")?.state).toBe("awaiting_ack");

    cap.flush(); // attempt 3 → exhausts the fallback-3 → degrade
    expect(degraded).toContain("rid_re0");
  });
});

describe("ResumeAckTracker — stop", () => {
  test("stop clears all pending timers and empties the tracker (no open handles)", () => {
    const { tracker, fake } = createTracker();
    tracker.start("rid_a");
    tracker.start("rid_b");
    expect(fake.pending()).toBe(2);

    tracker.stop();
    expect(fake.pending()).toBe(0);
    expect(tracker.size).toBe(0);
  });
});

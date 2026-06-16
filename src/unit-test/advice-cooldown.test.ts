import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AdviceCooldown,
  DEFAULT_ADVICE_COOLDOWN_SEC,
  resolveAdviceCooldownSec,
} from "../budget/advice-cooldown";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "abg-cooldown-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.BUDGET_STATE_DIR;
});

const NOW = 1_700_000_000;

function cooldown(cooldownSec = 1800): AdviceCooldown {
  return new AdviceCooldown({ homeDir: home, cooldownSec });
}

describe("AdviceCooldown", () => {
  test("first acquire succeeds and persists, second within window is denied", () => {
    const c = cooldown();
    expect(c.tryAcquire("underutilization", NOW)).toBe(true);
    expect(c.tryAcquire("underutilization", NOW + 60)).toBe(false);
    expect(existsSync(join(home, ".budget-guard", "advice-cooldown.json"))).toBe(true);
  });

  test("acquire succeeds again once the cooldown window elapses", () => {
    const c = cooldown(1800);
    expect(c.tryAcquire("underutilization", NOW)).toBe(true);
    expect(c.tryAcquire("underutilization", NOW + 1799)).toBe(false);
    expect(c.tryAcquire("underutilization", NOW + 1800)).toBe(true);
  });

  test("⑦ cross-pair / restart: a fresh instance honors the persisted cooldown", () => {
    // First "pair" acquires; a second instance over the SAME state dir (another
    // pair, or this pair after a daemon restart) must see the persisted record.
    expect(cooldown().tryAcquire("underutilization", NOW)).toBe(true);
    expect(cooldown().tryAcquire("underutilization", NOW + 100)).toBe(false);
    // …and acquires once the window passes.
    expect(cooldown().tryAcquire("underutilization", NOW + 2000)).toBe(true);
  });

  test("⑦ BUDGET_STATE_DIR override is honored (account-level shared dir)", () => {
    const shared = join(home, "shared-guard");
    process.env.BUDGET_STATE_DIR = shared;
    expect(cooldown().tryAcquire("underutilization", NOW)).toBe(true);
    expect(existsSync(join(shared, "advice-cooldown.json"))).toBe(true);
    expect(cooldown().tryAcquire("underutilization", NOW + 60)).toBe(false);
  });

  test("⑦ whitespace-only BUDGET_STATE_DIR falls back to ~/.budget-guard (parity with pending-reader)", () => {
    // A whitespace override must NOT be taken literally — both advice-cooldown and
    // pending-reader trim+fallback, or they would split into different dirs and
    // break the cross-pair shared file.
    process.env.BUDGET_STATE_DIR = "   ";
    expect(cooldown().tryAcquire("underutilization", NOW)).toBe(true);
    expect(existsSync(join(home, ".budget-guard", "advice-cooldown.json"))).toBe(true);
  });

  test("cooldownSec=0 disables the brake (always acquire)", () => {
    const c = cooldown(0);
    expect(c.tryAcquire("underutilization", NOW)).toBe(true);
    expect(c.tryAcquire("underutilization", NOW)).toBe(true);
  });

  test("corrupt file fails OPEN (acquire), never wedges the advice", () => {
    const dir = join(home, ".budget-guard");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "advice-cooldown.json"), "{ not json", "utf-8");
    expect(cooldown().tryAcquire("underutilization", NOW)).toBe(true);
  });

  test("a future lastEmittedEpoch (clock skew) does not wedge — acquire and re-anchor", () => {
    const dir = join(home, ".budget-guard");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "advice-cooldown.json"),
      JSON.stringify({ underutilization: { lastEmittedEpoch: NOW + 10_000 } }),
      "utf-8",
    );
    expect(cooldown().tryAcquire("underutilization", NOW)).toBe(true);
    // Re-anchored to NOW → a later check within the window is now denied.
    const parsed = JSON.parse(readFileSync(join(dir, "advice-cooldown.json"), "utf-8"));
    expect(parsed.underutilization.lastEmittedEpoch).toBe(NOW);
  });
});

describe("resolveAdviceCooldownSec", () => {
  test("defaults when unset", () => {
    expect(resolveAdviceCooldownSec({})).toBe(DEFAULT_ADVICE_COOLDOWN_SEC);
  });
  test("honors a valid override", () => {
    expect(resolveAdviceCooldownSec({ AGENTBRIDGE_BUDGET_ADVICE_COOLDOWN_SEC: "600" })).toBe(600);
  });
  test("rejects out-of-range / non-numeric → default", () => {
    expect(resolveAdviceCooldownSec({ AGENTBRIDGE_BUDGET_ADVICE_COOLDOWN_SEC: "-1" })).toBe(DEFAULT_ADVICE_COOLDOWN_SEC);
    expect(resolveAdviceCooldownSec({ AGENTBRIDGE_BUDGET_ADVICE_COOLDOWN_SEC: "nope" })).toBe(DEFAULT_ADVICE_COOLDOWN_SEC);
    expect(resolveAdviceCooldownSec({ AGENTBRIDGE_BUDGET_ADVICE_COOLDOWN_SEC: "999999" })).toBe(DEFAULT_ADVICE_COOLDOWN_SEC);
  });
});

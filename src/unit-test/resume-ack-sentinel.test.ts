import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RESUME_ACK_DEGRADED_SENTINEL,
  resumeAckSentinelPath,
  writeResumeAckDegradedSentinel,
  type ResumeAckDegradedSentinel,
} from "../budget/resume-ack-sentinel";
import { ResumeAckTracker } from "../budget/resume-ack-tracker";
import type { ResumeScheduler } from "../budget/resume-injection-queue";

/**
 * Covers PR4 §6 — the degrade→sentinel escape hatch. This is the SOLE recovery
 * path when a Claude session is idle/dead and never acks a resume directive, so
 * the payload shape, atomic temp+rename, 0o600 mode, and the full
 * ResumeAckTracker → onDegraded → sentinel wiring all need automated pins (the
 * bash consumer in health-check.sh parses exactly what this writer emits).
 */

const tmpDirs: string[] = [];

function tempStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "abg-resume-sentinel-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe("resumeAckSentinelPath", () => {
  test("joins the state dir with the well-known sentinel filename", () => {
    expect(resumeAckSentinelPath("/state")).toBe(`/state/${RESUME_ACK_DEGRADED_SENTINEL}`);
    expect(RESUME_ACK_DEGRADED_SENTINEL).toBe("resume-ack-degraded.json");
  });
});

describe("writeResumeAckDegradedSentinel", () => {
  test("writes a parseable {resumeId, degradedAt} payload at the sentinel path", () => {
    const stateDir = tempStateDir();
    writeResumeAckDegradedSentinel({
      stateDir,
      resumeId: "system_budget_claude_recovered_7",
      now: () => 1_700_000_000_000,
    });

    const target = resumeAckSentinelPath(stateDir);
    expect(existsSync(target)).toBe(true);
    const parsed = JSON.parse(readFileSync(target, "utf-8")) as ResumeAckDegradedSentinel;
    expect(parsed.resumeId).toBe("system_budget_claude_recovered_7");
    expect(parsed.degradedAt).toBe(1_700_000_000_000);
    expect(typeof parsed.degradedAt).toBe("number");
  });

  test("the bash health-check regex extracts the same resumeId from what TS writes", () => {
    // Pins bash↔TS parity: the hook reads resumeId via
    //   grep -o '"resumeId"[[:space:]]*:[[:space:]]*"[^"]*"'  then sed.
    // Reproduce that against the actual JSON.stringify(payload, null, 2) output so
    // a future change to either side that breaks parsing fails here.
    const stateDir = tempStateDir();
    const resumeId = "system_budget_claude_recovered_42";
    writeResumeAckDegradedSentinel({ stateDir, resumeId, now: () => 1 });
    const raw = readFileSync(resumeAckSentinelPath(stateDir), "utf-8");
    const m = raw.match(/"resumeId"\s*:\s*"([^"]*)"/);
    expect(m?.[1]).toBe(resumeId);
    // And the value passes the hook's charset guard (^[A-Za-z0-9._-]+$).
    expect(/^[A-Za-z0-9._-]+$/.test(m![1])).toBe(true);
  });

  test("writes with 0o600 mode (owner-only)", () => {
    const stateDir = tempStateDir();
    writeResumeAckDegradedSentinel({ stateDir, resumeId: "rid_mode", now: () => 0 });
    const mode = statSync(resumeAckSentinelPath(stateDir)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("leaves no temp file behind (atomic temp+rename)", () => {
    const stateDir = tempStateDir();
    writeResumeAckDegradedSentinel({ stateDir, resumeId: "rid_tmp", now: () => 0 });
    const leftovers = readdirSync(stateDir).filter((name) => name.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
    expect(readdirSync(stateDir)).toEqual([RESUME_ACK_DEGRADED_SENTINEL]);
  });

  test("best-effort: a write failure (missing state dir) is swallowed, never throws, and logs", () => {
    const stateDir = join(tempStateDir(), "does", "not", "exist");
    const logs: string[] = [];
    expect(() =>
      writeResumeAckDegradedSentinel({
        stateDir,
        resumeId: "rid_fail",
        now: () => 0,
        log: (m) => logs.push(m),
      }),
    ).not.toThrow();
    expect(existsSync(resumeAckSentinelPath(stateDir))).toBe(false);
    expect(logs.some((m) => m.includes("failed"))).toBe(true);
  });
});

/**
 * Deterministic fake scheduler (mirrors resume-ack-tracker.test.ts) so the
 * end-to-end wiring test stays hermetic — no real setTimeout, exit 0.
 */
function createFakeScheduler() {
  let nextId = 1;
  const timers = new Map<number, () => void>();
  const scheduler: ResumeScheduler = {
    setTimeout(callback: () => void) {
      const id = nextId++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(timer: unknown) {
      if (typeof timer === "number") timers.delete(timer);
    },
  };
  return {
    scheduler,
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

describe("ResumeAckTracker → writeResumeAckDegradedSentinel (end-to-end §6 wiring)", () => {
  test("retries-exhausted degrade lands a sentinel file carrying the pushed resumeId", () => {
    const stateDir = tempStateDir();
    const fake = createFakeScheduler();
    const resumeId = "system_budget_claude_recovered_99";
    const tracker = new ResumeAckTracker({
      push: () => {},
      scheduler: fake.scheduler,
      timeoutMs: 60_000,
      retries: 3,
      // Wire the REAL sentinel writer (not an in-memory stub) so the whole
      // degrade→sentinel chain is exercised.
      onDegraded: (rid) => writeResumeAckDegradedSentinel({ stateDir, resumeId: rid, now: () => 5 }),
    });

    tracker.start(resumeId);
    // No ack: drive past retries to the terminal degrade.
    fake.flush();
    fake.flush();
    fake.flush();

    const target = resumeAckSentinelPath(stateDir);
    expect(existsSync(target)).toBe(true);
    const parsed = JSON.parse(readFileSync(target, "utf-8")) as ResumeAckDegradedSentinel;
    expect(parsed.resumeId).toBe(resumeId);
    expect(parsed.degradedAt).toBe(5);
  });

  test("a timely ack means NO sentinel is ever written", () => {
    const stateDir = tempStateDir();
    const fake = createFakeScheduler();
    const tracker = new ResumeAckTracker({
      push: () => {},
      scheduler: fake.scheduler,
      timeoutMs: 60_000,
      retries: 3,
      onDegraded: (rid) => writeResumeAckDegradedSentinel({ stateDir, resumeId: rid }),
    });

    tracker.start("rid_acked");
    tracker.ack("rid_acked"); // acked before any timeout → never degrades
    expect(existsSync(resumeAckSentinelPath(stateDir))).toBe(false);
  });
});

import { describe, test, expect } from "bun:test";
import { probeLiveness, type ProbeTarget } from "../liveness-probe";

const OPEN = 1;
const CLOSED = 3;

function makeTarget(initial: Partial<ProbeTarget> = {}): ProbeTarget & { pingCount: number } {
  return {
    readyState: OPEN,
    pongCount: 0,
    pingCount: 0,
    ping() { this.pingCount++; },
    ...initial,
  } as ProbeTarget & { pingCount: number };
}

describe("probeLiveness", () => {
  test("returns true when a pong (counter advances) is observed before timeout", async () => {
    const target = makeTarget();
    const promise = probeLiveness(target, { timeoutMs: 500, pollMs: 10 });
    // Simulate a pong landing after the first poll tick.
    setTimeout(() => { target.pongCount++; }, 30);
    expect(await promise).toBe(true);
    expect(target.pingCount).toBe(1);
  });

  test("returns false when no pong (counter never advances) within timeout", async () => {
    const target = makeTarget();
    const result = await probeLiveness(target, { timeoutMs: 120, pollMs: 20 });
    expect(result).toBe(false);
    expect(target.pingCount).toBe(1);
  });

  test("returns false immediately when socket is not OPEN", async () => {
    const target = makeTarget({ readyState: CLOSED });
    const result = await probeLiveness(target, { timeoutMs: 500, pollMs: 10 });
    expect(result).toBe(false);
    expect(target.pingCount).toBe(0);
  });

  test("returns false when ping throws", async () => {
    const target = makeTarget({
      ping() { throw new Error("socket broken"); },
    });
    const result = await probeLiveness(target, { timeoutMs: 500, pollMs: 10 });
    expect(result).toBe(false);
  });

  test("returns false if readyState transitions to CLOSED mid-probe", async () => {
    const target = makeTarget();
    setTimeout(() => { target.readyState = CLOSED; }, 30);
    const result = await probeLiveness(target, { timeoutMs: 500, pollMs: 10 });
    expect(result).toBe(false);
  });

  test("a pong observed BEFORE the probe (already in baseline) is NOT proof of liveness", async () => {
    // pongCount is non-zero at probe start (a prior keepalive pong). The probe
    // snapshots it as the baseline; with no NEW pong during the probe, it must
    // return false — a stale pre-probe pong can't be mistaken for fresh liveness.
    const target = makeTarget({ pongCount: 7 });
    const result = await probeLiveness(target, { timeoutMs: 80, pollMs: 20 });
    expect(result).toBe(false);
  });

  test("REGRESSION: a pong landing in the SAME tick/ms as the probe start still registers", async () => {
    // The old implementation compared `lastPongAt(ms) > max(lastPongAt, now())`,
    // which false-negatived whenever the localhost round-trip completed within the
    // probe's start millisecond. With a counter, a synchronous same-tick pong
    // (incremented inside ping()) is unambiguously counted → alive.
    const target = makeTarget();
    target.ping = () => { target.pingCount++; target.pongCount++; };
    const result = await probeLiveness(target, { timeoutMs: 100, pollMs: 25 });
    expect(result).toBe(true);
    expect(target.pingCount).toBe(1);
  });

  test("uses injected clock and sleep for deterministic timeout", async () => {
    let fakeNow = 0;
    const sleeps: number[] = [];
    const target = makeTarget();
    const result = await probeLiveness(target, {
      timeoutMs: 100,
      pollMs: 25,
      now: () => fakeNow,
      sleep: async (ms) => { sleeps.push(ms); fakeNow += ms; },
    });
    expect(result).toBe(false);
    // With a 100ms budget and 25ms polls, expect 4 sleeps then timeout.
    expect(sleeps.length).toBe(4);
    expect(sleeps.every((s) => s === 25)).toBe(true);
  });

  test("a counter advance DURING the probe (after ping) is accepted with injected clock", async () => {
    let fakeNow = 10_000;
    const target = makeTarget({ pongCount: 3 });
    target.ping = () => { target.pingCount++; target.pongCount++; }; // peer pongs in response
    const result = await probeLiveness(target, {
      timeoutMs: 100,
      pollMs: 25,
      now: () => fakeNow,
      sleep: async (ms) => { fakeNow += ms; },
    });
    expect(result).toBe(true);
  });
});

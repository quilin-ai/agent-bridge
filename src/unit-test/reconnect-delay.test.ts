import { describe, test, expect } from "bun:test";
import { reconnectDelay } from "../broker-client";

describe("reconnectDelay — equal-jitter backoff (§8.2)", () => {
  test("rand=0 ⇒ ceiling/2 (the fixed floor); rand→1 ⇒ approaches ceiling", () => {
    // attempt 0, base 100: ceiling = min(max, 100) = 100
    expect(reconnectDelay(100, 10_000, 0, 0)).toBe(50);
    expect(reconnectDelay(100, 10_000, 0, 1)).toBe(100);
    expect(reconnectDelay(100, 10_000, 0, 0.5)).toBe(75);
  });

  test("grows exponentially with attempt until clamped at maxMs", () => {
    expect(reconnectDelay(100, 10_000, 1, 0)).toBe(100); // ceiling 200 → /2
    expect(reconnectDelay(100, 10_000, 2, 0)).toBe(200); // ceiling 400 → /2
    // attempt 10: 100*1024=102400 clamped to maxMs 10000 → /2 = 5000
    expect(reconnectDelay(100, 10_000, 10, 0)).toBe(5000);
    expect(reconnectDelay(100, 10_000, 10, 1)).toBe(10_000);
  });

  test("never exceeds maxMs for any rand in [0,1)", () => {
    for (const attempt of [0, 1, 5, 20, 100]) {
      for (const r of [0, 0.3, 0.7, 0.9999]) {
        const d = reconnectDelay(250, 10_000, attempt, r);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(10_000);
      }
    }
  });
});

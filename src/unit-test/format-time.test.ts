import { describe, expect, test } from "bun:test";
import { formatBeijing, formatBeijingClock } from "../budget/format-time";

// Epochs are built with Date.UTC so these assertions are independent of the
// host timezone — they verify the +8h Beijing (Asia/Shanghai) conversion.
describe("formatBeijing", () => {
  test("renders an epoch as Beijing-time YYYY-MM-DD HH:MM (UTC+8)", () => {
    // 2026-06-17 16:00 UTC = 2026-06-18 00:00 北京时间 (next day).
    const epoch = Date.UTC(2026, 5, 17, 16, 0, 0) / 1000;
    expect(formatBeijing(epoch)).toBe("2026-06-18 00:00");
  });

  test("does not carry a UTC 'Z' suffix", () => {
    const epoch = Date.UTC(2026, 5, 17, 16, 0, 0) / 1000;
    expect(formatBeijing(epoch)).not.toContain("Z");
  });

  test("returns 未知 for missing / non-positive / invalid input", () => {
    expect(formatBeijing(0)).toBe("未知");
    expect(formatBeijing(null)).toBe("未知");
    expect(formatBeijing(undefined)).toBe("未知");
    expect(formatBeijing(-5)).toBe("未知");
  });
});

describe("formatBeijingClock", () => {
  test("renders a Beijing-time HH:MM wall clock (UTC+8)", () => {
    // 2026-06-17 16:05 UTC = 2026-06-18 00:05 北京时间.
    const epoch = Date.UTC(2026, 5, 17, 16, 5, 0) / 1000;
    expect(formatBeijingClock(epoch)).toBe("00:05");
  });

  test("returns 未知 for invalid input", () => {
    expect(formatBeijingClock(0)).toBe("未知");
    expect(formatBeijingClock(null)).toBe("未知");
  });
});

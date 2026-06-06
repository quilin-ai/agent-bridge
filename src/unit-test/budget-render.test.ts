import { describe, expect, test } from "bun:test";
import { renderBudgetSnapshot, BUDGET_UNAVAILABLE_TEXT } from "../budget/render";
import type { AgentUsage, BudgetSnapshot } from "../budget/types";

function usage(overrides: Partial<AgentUsage> = {}): AgentUsage {
  return {
    ok: true,
    stale: false,
    gateUtil: 42,
    warnUtil: 45,
    fiveHour: { util: 42, resetEpoch: 1_780_750_000 },
    weekly: { util: 19, resetEpoch: 1_781_193_812 },
    remaining: 58,
    rateLimitedUntil: 0,
    fetchedAt: 1_780_711_639,
    ...overrides,
  };
}

function snapshot(overrides: Partial<BudgetSnapshot> = {}): BudgetSnapshot {
  return {
    phase: "normal",
    updatedAt: 1_780_711_700,
    claude: usage(),
    codex: usage({ gateUtil: 10, warnUtil: 14, fiveHour: { util: 10, resetEpoch: 1_780_699_485 } }),
    driftPct: 31,
    paused: false,
    pauseReason: null,
    resumeAfterEpoch: null,
    parallelRecommended: false,
    codexTier: "full",
    ...overrides,
  };
}

describe("renderBudgetSnapshot", () => {
  test("renders both agents with window percentages and gate/warn utils", () => {
    const text = renderBudgetSnapshot(snapshot());
    expect(text).toContain("Claude：");
    expect(text).toContain("Codex：");
    expect(text).toContain("5h 42%");
    expect(text).toContain("周 19%");
    expect(text).toContain("门控 42%");
    expect(text).toContain("预警 45%");
  });

  test("shows drift direction with heavier side first", () => {
    const text = renderBudgetSnapshot(snapshot({ driftPct: 31 }));
    expect(text).toContain("Claude 比 Codex 高 31 个百分点");

    const reversed = renderBudgetSnapshot(snapshot({ driftPct: -12 }));
    expect(reversed).toContain("Codex 比 Claude 高 12 个百分点");
  });

  test("renders paused state with reason and resume epoch", () => {
    const text = renderBudgetSnapshot(
      snapshot({
        phase: "paused",
        paused: true,
        pauseReason: "Codex 5h 窗口已达 92%",
        resumeAfterEpoch: 1_780_750_000,
      }),
    );
    expect(text).toContain("paused（联合暂停）");
    expect(text).toContain("暂停：是 — Codex 5h 窗口已达 92%");
    expect(text).toContain("预计恢复不早于");
  });

  test("renders unknown side when one agent's probe is unavailable", () => {
    const text = renderBudgetSnapshot(snapshot({ codex: null }));
    expect(text).toContain("Codex：未知（探测不可用）");
    // Drift line is suppressed when either side is unknown.
    expect(text).not.toContain("个百分点");
  });

  test("annotates rate-limited and stale usage", () => {
    const text = renderBudgetSnapshot(
      snapshot({ claude: usage({ rateLimitedUntil: 1_780_712_000, stale: true }) }),
    );
    expect(text).toContain("限流至");
    expect(text).toContain("（缓存数据）");
  });

  test("shows parallel recommendation and non-full codex tier", () => {
    const text = renderBudgetSnapshot(
      snapshot({ phase: "parallel", parallelRecommended: true, codexTier: "eco" }),
    );
    expect(text).toContain("并行建议");
    expect(text).toContain("Codex 档位：eco");
  });

  test("always carries the account-level disclaimer", () => {
    expect(renderBudgetSnapshot(snapshot())).toContain("账号级");
  });

  test("unavailable text mentions the probe path", () => {
    expect(BUDGET_UNAVAILABLE_TEXT).toContain("budget-probe");
  });
});

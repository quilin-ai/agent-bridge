/**
 * Shared human-readable rendering for budget snapshots.
 *
 * Used by both the `get_budget` MCP tool (claude-adapter) and the `abg budget`
 * CLI so the two surfaces stay consistent (plan v2.2 acceptance criterion).
 * User-facing text is Chinese per project convention.
 */

import type { AgentUsage, BudgetSnapshot } from "./types";

function formatEpoch(epochSeconds: number | null | undefined): string {
  if (!epochSeconds || epochSeconds <= 0) return "未知";
  return new Date(epochSeconds * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

function formatWindow(window: { util: number; resetEpoch: number } | null, label: string): string {
  if (!window) return `${label} 未知`;
  return `${label} ${window.util}%（重置 ${formatEpoch(window.resetEpoch)}）`;
}

function formatAgent(name: string, usage: AgentUsage | null): string {
  if (!usage) return `${name}：未知（探测不可用）`;
  const parts = [
    formatWindow(usage.fiveHour, "5h"),
    formatWindow(usage.weekly, "周"),
    `门控 ${usage.gateUtil}%`,
    `预警 ${usage.warnUtil}%`,
  ];
  if (usage.rateLimitedUntil > 0) {
    parts.push(`限流至 ${formatEpoch(usage.rateLimitedUntil)}`);
  }
  if (usage.stale) parts.push("（缓存数据）");
  return `${name}：${parts.join(" · ")}`;
}

const PHASE_LABELS: Record<BudgetSnapshot["phase"], string> = {
  normal: "normal（正常）",
  balance: "balance（需均衡）",
  parallel: "parallel（建议并行提速）",
  paused: "paused（联合暂停）",
};

/** Render a budget snapshot as readable Chinese text. */
export function renderBudgetSnapshot(snapshot: BudgetSnapshot): string {
  const lines: string[] = [];
  lines.push(`【预算快照 · 账号级】阶段：${PHASE_LABELS[snapshot.phase]} · 更新于 ${formatEpoch(snapshot.updatedAt)}`);
  lines.push(formatAgent("Claude", snapshot.claude));
  lines.push(formatAgent("Codex", snapshot.codex));

  if (snapshot.claude && snapshot.codex) {
    const abs = Math.abs(snapshot.driftPct);
    if (abs > 0) {
      const heavier = snapshot.driftPct > 0 ? "Claude" : "Codex";
      const lighter = snapshot.driftPct > 0 ? "Codex" : "Claude";
      lines.push(`漂移：${heavier} 比 ${lighter} 高 ${abs} 个百分点`);
    } else {
      lines.push("漂移：双方持平");
    }
  }

  if (snapshot.paused) {
    const resume = snapshot.resumeAfterEpoch ? `；预计恢复不早于 ${formatEpoch(snapshot.resumeAfterEpoch)}` : "";
    lines.push(`暂停：是 — ${snapshot.pauseReason ?? "额度接近耗尽"}${resume}`);
  } else {
    lines.push("暂停：否");
  }

  if (snapshot.parallelRecommended) {
    lines.push("并行建议：额度富余且临近结算，建议拆分更多并行子任务");
  }
  if (snapshot.codexTier !== "full") {
    lines.push(`Codex 档位：${snapshot.codexTier}`);
  }

  lines.push("注：百分比为订阅账号级用量（同机其他会话共享同一额度池）。");
  return lines.join("\n");
}

/** Rendered fallback when budget sensing is unavailable (probe missing or disabled). */
export const BUDGET_UNAVAILABLE_TEXT =
  "预算感知不可用：未检测到 agent-quota-guard 探针（~/.budget-guard/bin/budget-probe）或 budget 功能已禁用。协作不受影响。";

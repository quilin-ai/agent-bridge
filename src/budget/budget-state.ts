import type { AgentName, AgentUsage, BudgetConfig, BudgetState } from "./types";

interface PauseTrigger {
  agent: AgentName;
  reason: string;
}

const AGENT_LABEL: Record<AgentName, string> = {
  claude: "Claude",
  codex: "Codex",
};

function pct(value: number): string {
  return `${Math.round(value * 10) / 10}%`;
}

function formatEpoch(epoch: number | null): string {
  if (!epoch || epoch <= 0) return "未知";
  return new Date(epoch * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

function usageSummary(name: AgentName, usage: AgentUsage | null): string {
  if (!usage) return `${AGENT_LABEL[name]} 未知`;
  return `${AGENT_LABEL[name]} gate=${pct(usage.gateUtil)} warn=${pct(usage.warnUtil)} 5h重置=${formatEpoch(usage.fiveHour?.resetEpoch ?? 0)}`;
}

function matchingGateReset(usage: AgentUsage | null, now: number): number {
  if (!usage) return 0;
  if (usage.rateLimitedUntil > now) return usage.rateLimitedUntil;

  const windows = [usage.fiveHour, usage.weekly].filter((window): window is NonNullable<typeof window> =>
    !!window && window.resetEpoch > 0
  );
  const matching = windows.filter((window) => Math.abs(window.util - usage.gateUtil) < 0.0001);
  const candidates = matching.length > 0 ? matching : windows;
  if (candidates.length === 0) return 0;
  return Math.min(...candidates.map((window) => window.resetEpoch));
}

function resumeBlockingEpoch(usage: AgentUsage | null, cfg: BudgetConfig, now: number): number {
  if (!usage) return 0;
  if (usage.rateLimitedUntil > now) return usage.rateLimitedUntil;
  if (usage.gateUtil >= cfg.resumeBelow) return matchingGateReset(usage, now);
  return 0;
}

function resumeAfterEpoch(
  claude: AgentUsage | null,
  codex: AgentUsage | null,
  cfg: BudgetConfig,
  now: number,
): number | null {
  const epochs = [
    resumeBlockingEpoch(claude, cfg, now),
    resumeBlockingEpoch(codex, cfg, now),
  ].filter((epoch) => epoch > 0);
  if (epochs.length === 0) return null;
  return Math.max(...epochs);
}

function pauseTrigger(agent: AgentName, usage: AgentUsage | null, cfg: BudgetConfig, now: number): PauseTrigger | null {
  if (!usage) return null;
  if (usage.rateLimitedUntil > now) {
    return {
      agent,
      reason: `${AGENT_LABEL[agent]} 探针被限流至 ${formatEpoch(usage.rateLimitedUntil)}`,
    };
  }
  if (usage.gateUtil >= cfg.pauseAt) {
    return {
      agent,
      reason: `${AGENT_LABEL[agent]} gateUtil ${pct(usage.gateUtil)} ≥ pauseAt ${pct(cfg.pauseAt)}`,
    };
  }
  return null;
}

function driftFor(
  claude: AgentUsage | null,
  codex: AgentUsage | null,
  cfg: BudgetConfig,
): BudgetState["drift"] {
  if (!claude || !codex) return { pct: 0, heavier: null, lighter: null };
  const drift = Math.round((claude.warnUtil - codex.warnUtil) * 10) / 10;
  if (Math.abs(drift) <= cfg.syncDriftPct) {
    return { pct: drift, heavier: null, lighter: null };
  }
  return {
    pct: drift,
    heavier: drift > 0 ? "claude" : "codex",
    lighter: drift > 0 ? "codex" : "claude",
  };
}

function parallelState(
  claude: AgentUsage | null,
  codex: AgentUsage | null,
  cfg: BudgetConfig,
  now: number,
): BudgetState["parallel"] {
  if (!claude || !codex) return { recommended: false, reason: null };
  if (claude.remaining <= cfg.parallel.minRemainingPct || codex.remaining <= cfg.parallel.minRemainingPct) {
    return { recommended: false, reason: null };
  }
  const claudeReset = claude.fiveHour?.resetEpoch ?? 0;
  const codexReset = codex.fiveHour?.resetEpoch ?? 0;
  if (claudeReset <= now || codexReset <= now) return { recommended: false, reason: null };

  const nearestResetSec = Math.min(claudeReset - now, codexReset - now);
  if (nearestResetSec >= cfg.parallel.timeWindowSec) return { recommended: false, reason: null };

  const minutes = Math.ceil(nearestResetSec / 60);
  return {
    recommended: true,
    reason: `双方剩余额度均高于 ${pct(cfg.parallel.minRemainingPct)}，最近 5h 桶约 ${minutes} 分钟后重置`,
  };
}

function pauseDirective(
  claude: AgentUsage | null,
  codex: AgentUsage | null,
  triggers: PauseTrigger[],
  resetEpochs: BudgetState["pause"]["resetEpochs"],
  resumeEpoch: number | null,
  cfg: BudgetConfig,
): string {
  const sideText = triggers.length > 1 ? "双方" : AGENT_LABEL[triggers[0].agent];
  return [
    "【预算协调 · 账号级】进入联合暂停。",
    `触发方：${sideText}；原因：${triggers.map((trigger) => trigger.reason).join("；")}。`,
    `${usageSummary("claude", claude)}；${usageSummary("codex", codex)}。`,
    `恢复条件：Claude 与 Codex 的 gateUtil 都低于 ${pct(cfg.resumeBelow)}，且没有有效 rate_limit。预计恢复不早于 ${formatEpoch(resumeEpoch)}。`,
    "请收尾当前步、写 checkpoint、停止继续委派；pause 期间不要重试向 Codex 发送 reply。",
  ].join("\n");
}

function balanceDirective(
  claude: AgentUsage,
  codex: AgentUsage,
  drift: BudgetState["drift"],
  parallel: BudgetState["parallel"],
): string {
  const heavier = drift.heavier ? AGENT_LABEL[drift.heavier] : "未知";
  const lighter = drift.lighter ? AGENT_LABEL[drift.lighter] : "未知";
  const lines = [
    "【预算协调 · 账号级】检测到双方用量比例漂移。",
    `${usageSummary("claude", claude)}；${usageSummary("codex", codex)}。`,
    `${heavier} 比 ${lighter} 高 ${pct(Math.abs(drift.pct))}，请优先把后续可拆分任务分给 ${lighter}，直到 warnUtil 接近。`,
  ];
  if (parallel.recommended && parallel.reason) {
    lines.push(`${parallel.reason}；可让 ${lighter} 承担更多并行子任务，兼顾均衡与提速。`);
  }
  return lines.join("\n");
}

function parallelDirective(
  claude: AgentUsage,
  codex: AgentUsage,
  parallel: BudgetState["parallel"],
): string {
  return [
    "【预算协调 · 账号级】当前额度富余且临近 5h 结算，建议动态并行。",
    `${usageSummary("claude", claude)}；${usageSummary("codex", codex)}。`,
    `${parallel.reason}；可以拆更多独立子任务并行推进。`,
  ].join("\n");
}

export function computeBudgetState(
  claude: AgentUsage | null,
  codex: AgentUsage | null,
  cfg: BudgetConfig,
  now: number,
): BudgetState {
  const triggers = [
    pauseTrigger("claude", claude, cfg, now),
    pauseTrigger("codex", codex, cfg, now),
  ].filter((trigger): trigger is PauseTrigger => trigger !== null);
  const paused = triggers.length > 0;
  const drift = driftFor(claude, codex, cfg);
  const parallel = paused ? { recommended: false, reason: null } : parallelState(claude, codex, cfg, now);
  const resetEpochs = {
    claude: matchingGateReset(claude, now),
    codex: matchingGateReset(codex, now),
  };
  const filteredResumeAfterEpoch = paused ? resumeAfterEpoch(claude, codex, cfg, now) : null;

  let phase: BudgetState["phase"] = "normal";
  if (paused) phase = "paused";
  else if (drift.heavier && drift.lighter) phase = "balance";
  else if (parallel.recommended) phase = "parallel";

  const pauseSide = !paused
    ? null
    : triggers.length > 1
      ? "both"
      : triggers[0].agent;

  let directiveToClaude: string | null = null;
  if (phase === "paused") {
    directiveToClaude = pauseDirective(claude, codex, triggers, resetEpochs, filteredResumeAfterEpoch, cfg);
  } else if (phase === "balance" && claude && codex) {
    directiveToClaude = balanceDirective(claude, codex, drift, parallel);
  } else if (phase === "parallel" && claude && codex) {
    directiveToClaude = parallelDirective(claude, codex, parallel);
  }

  return {
    phase,
    now,
    perAgent: { claude, codex },
    drift,
    pause: {
      active: paused,
      side: pauseSide,
      reason: paused ? triggers.map((trigger) => trigger.reason).join("；") : null,
      resumeBelow: cfg.resumeBelow,
      resumeAfterEpoch: filteredResumeAfterEpoch,
      resetEpochs,
    },
    parallel,
    effort: { claudeAdvice: null, codexTier: "full" },
    directiveToClaude,
  };
}

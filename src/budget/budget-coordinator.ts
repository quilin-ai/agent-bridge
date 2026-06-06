import { computeBudgetState } from "./budget-state";
import type {
  AgentName,
  AgentUsage,
  BudgetConfig,
  BudgetSnapshot,
  BudgetState,
  CodexTurnOverrides,
} from "./types";
import type { QuotaSource } from "./quota-source";

type QuotaSourceLike = Pick<QuotaSource, "fetchBoth">;

export interface BudgetCoordinatorOptions {
  source: QuotaSourceLike;
  config: BudgetConfig;
  emit: (id: string, content: string) => void;
  onPauseChange: (paused: boolean) => void;
  now?: () => number;
  log?: (message: string) => void;
}

const AGENT_LABEL: Record<AgentName, string> = {
  claude: "Claude",
  codex: "Codex",
};

function pct(value: number): string {
  return `${Math.round(value * 10) / 10}%`;
}

function usageLine(agent: AgentName, usage: AgentUsage | null): string {
  if (!usage) return `${AGENT_LABEL[agent]} 未知`;
  return `${AGENT_LABEL[agent]} gate=${pct(usage.gateUtil)} warn=${pct(usage.warnUtil)}`;
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

export class BudgetCoordinator {
  private readonly source: QuotaSourceLike;
  private readonly config: BudgetConfig;
  private readonly emit: (id: string, content: string) => void;
  private readonly onPauseChange: (paused: boolean) => void;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private paused = false;
  private lastDirectiveFingerprint: string | null = null;
  private latestSnapshot: BudgetSnapshot | null = null;
  private pauseReason: string | null = null;
  private pauseResumeAfterEpoch: number | null = null;
  private sequence = 0;

  constructor(options: BudgetCoordinatorOptions) {
    this.source = options.source;
    this.config = options.config;
    this.emit = options.emit;
    this.onPauseChange = options.onPauseChange;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.log = options.log ?? (() => {});
  }

  async start(): Promise<void> {
    if (this.running || !this.config.enabled) return;
    this.running = true;
    await this.pollOnce();
    if (this.running) this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  isPaused(): boolean {
    return this.paused;
  }

  getSnapshot(): BudgetSnapshot | null {
    return this.latestSnapshot;
  }

  getCodexTurnOverrides(): CodexTurnOverrides | null {
    return null;
  }

  private scheduleNext(): void {
    if (!this.running) return;
    const delayMs = Math.max(0, this.config.pollSeconds * 1000);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.pollAndReschedule();
    }, delayMs);
  }

  private async pollAndReschedule(): Promise<void> {
    await this.pollOnce();
    if (this.running) this.scheduleNext();
  }

  private async pollOnce(): Promise<void> {
    let usage: Awaited<ReturnType<QuotaSourceLike["fetchBoth"]>>;
    try {
      usage = await this.source.fetchBoth();
    } catch (error) {
      this.log(`budget coordinator poll failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    if (!usage) {
      if (!this.paused) this.latestSnapshot = null;
      return;
    }

    if (!this.running) {
      return;
    }

    const state = computeBudgetState(usage.claude, usage.codex, this.config, this.now());
    this.applyState(state);
    this.latestSnapshot = this.toSnapshot(state);
  }

  private applyState(state: BudgetState): void {
    if (state.pause.active) {
      this.pauseReason = state.pause.reason;
      this.pauseResumeAfterEpoch = state.pause.resumeAfterEpoch;
      const fingerprint = this.directiveFingerprint(state);
      if (!this.paused) {
        this.paused = true;
        this.onPauseChange(true);
        this.emitDirective("system_budget_pause", state.directiveToClaude ?? this.pauseReason ?? "预算协调进入联合暂停。");
      } else if (fingerprint !== this.lastDirectiveFingerprint) {
        this.emitDirective("system_budget_pause", state.directiveToClaude ?? this.pauseReason ?? "预算协调进入联合暂停。");
      }
      this.lastDirectiveFingerprint = fingerprint;
      return;
    }

    if (this.paused) {
      if (!this.canResume(state)) {
        this.pauseResumeAfterEpoch = this.resumeAfterEpoch(state) ?? this.pauseResumeAfterEpoch;
        return;
      }

      this.paused = false;
      this.pauseReason = null;
      this.pauseResumeAfterEpoch = null;
      this.lastDirectiveFingerprint = null;
      this.onPauseChange(false);
      this.emitDirective("system_budget_resume", this.resumeDirective(state));
      return;
    }

    if (!state.directiveToClaude) {
      this.lastDirectiveFingerprint = null;
      return;
    }

    const fingerprint = this.directiveFingerprint(state);
    if (fingerprint !== this.lastDirectiveFingerprint) {
      const prefix = state.phase === "balance" ? "system_budget_balance" : "system_budget_parallel";
      this.emitDirective(prefix, state.directiveToClaude);
      this.lastDirectiveFingerprint = fingerprint;
    }
  }

  private canResume(state: BudgetState): boolean {
    return this.canAgentResume(state.perAgent.claude, state.now) && this.canAgentResume(state.perAgent.codex, state.now);
  }

  private canAgentResume(usage: AgentUsage | null, now: number): boolean {
    if (!usage) return false;
    if (usage.rateLimitedUntil > now) return false;
    return usage.gateUtil < this.config.resumeBelow;
  }

  private resumeAfterEpoch(state: BudgetState): number | null {
    const epochs = [
      this.resumeBlockingEpoch(state.perAgent.claude, state.now),
      this.resumeBlockingEpoch(state.perAgent.codex, state.now),
    ].filter((epoch) => epoch > 0);
    if (epochs.length === 0) return null;
    return Math.max(...epochs);
  }

  private resumeBlockingEpoch(usage: AgentUsage | null, now: number): number {
    if (!usage) return 0;
    if (usage.rateLimitedUntil > now) return usage.rateLimitedUntil;
    if (usage.gateUtil >= this.config.resumeBelow) return matchingGateReset(usage, now);
    return 0;
  }

  private directiveFingerprint(state: BudgetState): string {
    const side = state.pause.side ?? "none";
    let reset = 0;
    if (side === "claude") reset = state.pause.resetEpochs.claude;
    else if (side === "codex") reset = state.pause.resetEpochs.codex;
    else if (side === "both") reset = Math.max(state.pause.resetEpochs.claude, state.pause.resetEpochs.codex);

    return [
      state.phase,
      state.drift.heavier ?? "none",
      side,
      reset,
    ].join("|");
  }

  private emitDirective(prefix: string, content: string): void {
    this.emit(`${prefix}_${this.sequence++}`, content);
  }

  private resumeDirective(state: BudgetState): string {
    return [
      "【预算协调 · 账号级】联合暂停解除。",
      `${usageLine("claude", state.perAgent.claude)}；${usageLine("codex", state.perAgent.codex)}。`,
      `闸门已放开：双方 gateUtil 均低于 ${pct(this.config.resumeBelow)}，且没有有效 rate_limit。`,
      "建议 Claude 用 reply 带上当前目标、checkpoint 和下一步，唤醒 Codex 接续执行。",
    ].join("\n");
  }

  private toSnapshot(state: BudgetState): BudgetSnapshot {
    const paused = this.paused;
    return {
      phase: paused ? "paused" : state.phase,
      updatedAt: state.now,
      claude: state.perAgent.claude,
      codex: state.perAgent.codex,
      driftPct: state.drift.pct,
      paused,
      pauseReason: paused ? this.pauseReason ?? state.pause.reason : null,
      resumeAfterEpoch: paused ? state.pause.resumeAfterEpoch ?? this.pauseResumeAfterEpoch : null,
      parallelRecommended: paused ? false : state.parallel.recommended,
      codexTier: state.effort.codexTier,
    };
  }
}

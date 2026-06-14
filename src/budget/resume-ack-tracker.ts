/**
 * ResumeAckTracker — Claude-side auto-resume ack/retry state machine (PR4).
 *
 * Daemon-owned single source of truth for the "did Claude acknowledge the
 * budget resume directive?" lifecycle. Unlike PR3's Codex ResumeInjectionQueue
 * (which injects a turn into the Codex app-server), the Claude side is push-only:
 * the daemon pushes a `system_budget_resume` channel notification carrying a
 * stable `resumeId`, and waits for Claude to echo it back via the `ack_resume`
 * MCP tool. If no ack arrives within `timeoutMs`, it re-pushes (a fresh
 * deliveryId each time so the adapter's LRU dedup never drops the retry, while
 * the resumeId stays stable so Claude's echo still correlates). After `retries`
 * timeouts with no ack, the entry transitions to a terminal `degraded` state.
 *
 * Timer hygiene (PR3 timer-leak lesson): every timer is tracked and clearable;
 * `stop()` clears all timers and empties the tracker (called on daemon
 * shutdown); the production scheduler unrefs its timers so a pending ack window
 * never keeps the process alive. Unit tests inject a fake scheduler — no real
 * setTimeout is ever armed, so `bun test src` exits 0 with no open handles.
 *
 * Map hygiene: a terminal entry (acked → resumed, or retries-exhausted →
 * degraded) is DELETED from the map immediately. The Map can therefore only ever
 * hold entries that are actively awaiting an ack, so a long-lived daemon never
 * accumulates dead entries. Idempotency is preserved by the unknown-id no-op
 * path: a repeated/late ack for an already-removed resumeId hits `!entry` and is
 * a silent no-op (exactly as it was when the entry was kept in a terminal state).
 */

import type { ResumeScheduler } from "./resume-injection-queue";

export type ResumeAckState = "awaiting_ack" | "resumed" | "degraded";

/** Payload handed to the push callback for one delivery attempt. */
export interface ResumeAckPushEvent {
  /** Stable correlation id — same across retries so Claude's echo matches. */
  resumeId: string;
  /** Per-attempt delivery id — UNIQUE per push so LRU dedup never drops it. */
  deliveryId: string;
  /** 0 on the first push; incremented on each timeout-driven re-push. */
  attempt: number;
}

export interface ResumeAckEntry {
  resumeId: string;
  attempts: number;
  state: ResumeAckState;
}

interface InternalEntry extends ResumeAckEntry {
  timer?: unknown;
}

export interface ResumeAckTrackerOptions {
  /** Push one delivery attempt of the resume directive to Claude. */
  push: (event: ResumeAckPushEvent) => void;
  /** Timer DI — shared with ResumeInjectionQueue ({ setTimeout, clearTimeout }). */
  scheduler: ResumeScheduler;
  /** Per-attempt ack window before a re-push fires. */
  timeoutMs: number;
  /** Number of timeouts tolerated before the entry degrades (terminal). */
  retries: number;
  /** Invoked once when an entry reaches the terminal degraded state. */
  onDegraded?: (resumeId: string) => void;
}

function finitePositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export class ResumeAckTracker {
  private readonly push: ResumeAckTrackerOptions["push"];
  private readonly scheduler: ResumeScheduler;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly onDegraded: (resumeId: string) => void;
  private readonly entries = new Map<string, InternalEntry>();
  // Monotonic counter for unique delivery ids (independent of attempt number so
  // even a same-attempt re-push — which never happens today — stays unique).
  private deliverySeq = 0;

  constructor(options: ResumeAckTrackerOptions) {
    this.push = options.push;
    this.scheduler = options.scheduler;
    this.timeoutMs = finitePositive(options.timeoutMs, 60_000);
    this.retries = finitePositive(options.retries, 3);
    this.onDegraded = options.onDegraded ?? (() => {});
  }

  get size(): number {
    return this.entries.size;
  }

  /** Public, timer-free view of an entry (for diagnostics + tests). */
  get(resumeId: string): ResumeAckEntry | undefined {
    const entry = this.entries.get(resumeId);
    if (!entry) return undefined;
    const { timer: _timer, ...publicEntry } = entry;
    return { ...publicEntry };
  }

  /**
   * Register a resume directive and push attempt 0. Idempotent: a duplicate
   * start for a resumeId already tracked (in any state) is a no-op — it does NOT
   * re-push or re-arm a timer.
   */
  start(resumeId: string): void {
    if (this.entries.has(resumeId)) return;
    const entry: InternalEntry = { resumeId, attempts: 0, state: "awaiting_ack" };
    this.entries.set(resumeId, entry);
    this.pushAttempt(entry);
    this.armTimer(entry);
  }

  /**
   * Record Claude's ack. Clears the entry's timer and DELETES it from the map
   * (terminal `resumed`). No-op for an unknown resumeId, a repeated/late ack
   * (the entry is already gone), or an ack arriving after degrade (also gone) —
   * all collapse to the same `!entry` unknown-id no-op, preserving idempotency.
   */
  ack(resumeId: string): void {
    const entry = this.entries.get(resumeId);
    if (!entry) return;
    this.clearTimer(entry);
    // Terminal: drop the entry so the map never grows with dead state. The
    // state flip is bookkeeping for any synchronous observer before deletion.
    entry.state = "resumed";
    this.entries.delete(resumeId);
  }

  /** Clear all timers and empty the tracker (daemon shutdown). */
  stop(): void {
    for (const entry of this.entries.values()) {
      this.clearTimer(entry);
    }
    this.entries.clear();
  }

  private pushAttempt(entry: InternalEntry): void {
    const deliveryId = `${entry.resumeId}_retry${entry.attempts}_${++this.deliverySeq}`;
    this.push({ resumeId: entry.resumeId, deliveryId, attempt: entry.attempts });
  }

  private armTimer(entry: InternalEntry): void {
    this.clearTimer(entry);
    entry.timer = this.scheduler.setTimeout(() => {
      delete entry.timer;
      this.onTimeout(entry);
    }, this.timeoutMs);
    (entry.timer as { unref?: () => void } | undefined)?.unref?.();
  }

  private onTimeout(entry: InternalEntry): void {
    // Defensive: a cleared/terminal entry should never reach here (its timer was
    // cleared and the entry deleted on ack/degrade), but guard anyway so a
    // fired-then-acked race is inert.
    if (entry.state !== "awaiting_ack" || !this.entries.has(entry.resumeId)) return;
    entry.attempts += 1;
    if (entry.attempts >= this.retries) {
      // Terminal degrade: flip the state for any synchronous observer, fire the
      // degrade hook, then DELETE the entry so the map never retains dead state.
      // A late ack afterwards hits the unknown-id no-op path (idempotent).
      entry.state = "degraded";
      this.entries.delete(entry.resumeId);
      this.onDegraded(entry.resumeId);
      return;
    }
    this.pushAttempt(entry);
    this.armTimer(entry);
  }

  private clearTimer(entry: InternalEntry): void {
    if (entry.timer === undefined) return;
    this.scheduler.clearTimeout(entry.timer);
    delete entry.timer;
  }
}

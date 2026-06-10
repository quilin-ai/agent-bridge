/**
 * Liveness probe for half-open WebSocket detection.
 *
 * Sends a WebSocket ping and waits up to `timeoutMs` for a pong. Returns true
 * if a NEW pong is observed (via `pongCount` advancing past the snapshot taken
 * before ping()). Used by challenge-on-contest admission in daemon.ts to detect
 * half-open dead peers that still report readyState=OPEN (issue #68).
 *
 * Accepts a minimal probe target interface so the loop can be unit-tested
 * against an in-memory fake without spinning up a real WebSocket.
 */

export interface ProbeTarget {
  /** WebSocket.OPEN = 1. Anything else aborts the probe. */
  readyState: number;
  /**
   * Monotonic COUNT of pong frames observed. The caller increments this in its
   * `pong` handler. A counter — not a timestamp — because the previous design
   * (`baseline = max(lastPongAt, now())`, then wait for `lastPongAt > baseline`)
   * false-negatived whenever the localhost ping→pong round-trip completed within
   * the same millisecond the probe started: the pong handler set
   * `lastPongAt = Date.now()`, which equalled `baseline`, and `baseline > baseline`
   * is false. On localhost that happened ~70% of probes, so LIVE frontends were
   * judged dead and wrongly evicted on contest (the root cause of spurious
   * "stopped responding to liveness probes" evictions). A counter increment is
   * unambiguous and clock-granularity independent.
   */
  pongCount: number;
  /** Send a ping frame. May throw synchronously on a failed write. */
  ping(): void;
}

export interface ProbeLivenessOptions {
  timeoutMs: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const OPEN = 1;

export async function probeLiveness(
  target: ProbeTarget,
  options: ProbeLivenessOptions,
): Promise<boolean> {
  const {
    timeoutMs,
    pollMs = 50,
    now = Date.now,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = options;

  if (target.readyState !== OPEN) return false;

  // Snapshot the pong COUNT before pinging. Any pong observed after this snapshot
  // — the reply to our ping, or a concurrent Bun keepalive pong — proves the peer
  // is alive. Pongs that arrived before the snapshot are already folded into
  // `baseline`, so a stale pre-probe pong can never be mistaken for fresh liveness.
  // (No wall-clock comparison: the old `lastPongAt > max(lastPongAt, now())` check
  // false-negatived on same-millisecond localhost round-trips — see ProbeTarget.)
  const baseline = target.pongCount;
  try {
    target.ping();
  } catch {
    return false;
  }

  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (target.pongCount > baseline) return true;
    if (target.readyState !== OPEN) return false;
    await sleep(pollMs);
  }
  return target.pongCount > baseline;
}

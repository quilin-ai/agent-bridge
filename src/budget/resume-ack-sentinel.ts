/**
 * Resume-ack degraded sentinel (PR4 §6 — SessionStart escape hatch).
 *
 * When the Claude-side ResumeAckTracker exhausts its retries with no ack, the
 * resume directive never reached an active Claude session (idle/dead session, or
 * a session that ignored the channel push). The daemon drops a sentinel file in
 * the state dir; the next SessionStart hook reads it and surfaces a recovery
 * hint — BEFORE the health-check cooldown gate, so a fresh session within the
 * cooldown window still sees it (otherwise the notice would be swallowed).
 *
 * The hook CONSUMES (deletes) the sentinel after surfacing it, so the notice is
 * shown exactly once per degrade event. Writing is best-effort and atomic-ish
 * (write to a temp path then rename) so a concurrent read never sees a partial
 * file.
 */

import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const RESUME_ACK_DEGRADED_SENTINEL = "resume-ack-degraded.json";

export interface ResumeAckDegradedSentinel {
  resumeId: string;
  degradedAt: number;
}

export function resumeAckSentinelPath(stateDir: string): string {
  return join(stateDir, RESUME_ACK_DEGRADED_SENTINEL);
}

export function writeResumeAckDegradedSentinel(opts: {
  stateDir: string;
  resumeId: string;
  now?: () => number;
  log?: (message: string) => void;
}): void {
  const now = opts.now ?? (() => Date.now());
  const payload: ResumeAckDegradedSentinel = {
    resumeId: opts.resumeId,
    degradedAt: now(),
  };
  const target = resumeAckSentinelPath(opts.stateDir);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    renameSync(tmp, target);
    opts.log?.(`Resume-ack degraded sentinel written: ${opts.resumeId}`);
  } catch (err: any) {
    opts.log?.(`Resume-ack degraded sentinel write failed (${opts.resumeId}): ${err?.message ?? err}`);
  }
}

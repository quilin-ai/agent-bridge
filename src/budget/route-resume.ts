/**
 * routeResume — pure side-aware dispatch for a committed budget recovery (PR4).
 *
 * The daemon's BudgetCoordinator calls `onResume(side, directive, resumeId)`
 * once PER recovered side (the coordinator iterates `effect.recoveredSides`,
 * which is an `AgentName[]` — it NEVER passes the synthetic "both"; a joint
 * recovery surfaces as two independent calls, one per concrete side). This
 * function is the single source of truth for that routing rule:
 *
 *   - side === "codex"  → PR3's Codex resume-injection queue (enqueueCodex). The
 *     Claude ack tracker is DELIBERATELY untouched here.
 *   - side === "claude" → arm the Claude-side ResumeAckTracker (claudeTracker.start),
 *     which pushes the resume directive over the channel and retries until acked.
 *
 * Extracting this into a pure, exported function means the daemon's onResume
 * closure and the wiring unit test import the SAME implementation — eliminating
 * the prior "re-implemented closure" drift where the test pinned a hand-copied
 * routing rule that could silently diverge from the real daemon.
 */

import type { AgentName } from "./types";

/** The two collaborators routeResume dispatches into (daemon-owned). */
export interface ResumeRouterDeps {
  /** Arm the Claude-side ack/retry tracker for a Claude recovery. */
  claudeTracker: { start: (resumeId: string) => void };
  /** Hand a Codex recovery to PR3's injection queue path. */
  enqueueCodex: (resumeId: string) => void;
}

/**
 * Route a single committed recovery to the correct side.
 *
 * @param side     the concrete recovered side (AgentName — never "both").
 * @param resumeId stable correlation id for this recovery.
 * @param deps     the daemon-owned collaborators (Claude tracker + Codex enqueue).
 */
export function routeResume(side: AgentName, resumeId: string, deps: ResumeRouterDeps): void {
  if (side === "codex") {
    deps.enqueueCodex(resumeId);
    return;
  }
  // side === "claude": arm the ack tracker (push + retry until acked).
  deps.claudeTracker.start(resumeId);
}

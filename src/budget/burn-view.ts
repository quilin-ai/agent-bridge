/**
 * Burn-rate CONSUMPTION layer (budget v3 §3.3, layered amendment).
 *
 * agent-quota-guard owns collection, EWMA estimation, confidence gating and
 * persistence; its probe emits decision-grade per-bucket fields
 * (`burn_rate_pct_per_hour` / `burn_confident` / `runway_seconds` /
 * `depleted_at_epoch` / `five_hour_windows_left`). This module only projects
 * those fields — already validated by quota-source — into the snapshot shapes.
 * Two hard constraints (Codex acceptance):
 *
 *  1. Missing fields / old schema / non-numeric / stale / reset-unknown all
 *     degrade to conserve: no runway is ever fabricated (no runway → no line).
 *  2. The bridge NEVER recomputes burn rates or runways — selection (minimum
 *     across windows) is the only operation performed here.
 */

import { isDecisionGrade } from "./budget-state";
import type {
  AgentBurnRates,
  AgentUsage,
  BudgetWindow,
  BudgetWindowKey,
  BurnRate,
  RunwayEstimate,
} from "./types";

/** Project one window's guard burn fields into the BurnRate display shape. */
export function windowBurnRate(window: BudgetWindow | null): BurnRate | null {
  if (!window || window.burnRate === undefined) return null;
  return {
    pctPerHour: window.burnRate,
    // Absent burn_confident is NOT confidence — constraint #1.
    confident: window.burnConfident === true,
  };
}

/** Per-agent burn rates straight off the probe windows. */
export function agentBurnRates(usage: AgentUsage | null): AgentBurnRates {
  if (!usage) return { fiveHour: null, weekly: null };
  return {
    fiveHour: windowBurnRate(usage.fiveHour),
    weekly: windowBurnRate(usage.weekly),
  };
}

/**
 * Agent-level runway: the MINIMUM `runway_seconds` across windows that are
 * decision-grade (fresh reset, non-stale record per isDecisionGrade) and
 * carry a confident guard rate. Pure selection — never arithmetic on rates.
 * Null when no window qualifies (constraint #1: conserve, render no line).
 */
export function agentRunway(usage: AgentUsage | null, now: number): RunwayEstimate | null {
  // Constraint #1 spells out stale explicitly; isDecisionGrade covers
  // freshness (window reset + fetchedAt age) but not the probe's stale/ok
  // flags, so both gates apply.
  if (!usage || usage.stale || !usage.ok) return null;
  if (!isDecisionGrade(usage, now)) return null;

  let best: RunwayEstimate | null = null;
  const candidates: Array<[BudgetWindowKey, BudgetWindow | null]> = [
    ["fiveHour", usage.fiveHour],
    ["weekly", usage.weekly],
  ];
  for (const [basis, window] of candidates) {
    if (!window || window.resetEpoch <= now) continue; // reset-unknown/expired → conserve
    if (window.burnConfident !== true) continue;
    if (window.runwaySeconds === undefined) continue;
    if (best === null || window.runwaySeconds < best.seconds) {
      best = {
        seconds: window.runwaySeconds,
        basis,
        depletedAtEpoch: window.depletedAtEpoch ?? null,
      };
    }
  }
  return best;
}

/** Weekly 5h-window count, gated by the same freshness/confidence rules as runway. */
export function agentWeeklyFiveHourWindowsLeft(usage: AgentUsage | null, now: number): number | null {
  if (!usage || usage.stale || !usage.ok) return null;
  if (!isDecisionGrade(usage, now)) return null;
  const weekly = usage.weekly;
  if (!weekly || weekly.resetEpoch <= now) return null;
  if (weekly.burnConfident !== true) return null;
  if (weekly.runwaySeconds === undefined) return null;
  return weekly.fiveHourWindowsLeft ?? null;
}

/** True when either agent carries any burn signal worth a snapshot field. */
export function hasAnyBurnSignal(
  rates: { claude: AgentBurnRates; codex: AgentBurnRates },
  runway: { claude: RunwayEstimate | null; codex: RunwayEstimate | null },
): boolean {
  return (
    rates.claude.fiveHour !== null ||
    rates.claude.weekly !== null ||
    rates.codex.fiveHour !== null ||
    rates.codex.weekly !== null ||
    runway.claude !== null ||
    runway.codex !== null
  );
}

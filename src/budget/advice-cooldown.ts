/**
 * Per-account advice cooldown (v3 P4 §3.4 / R8 / SUSPECT-6).
 *
 * The underutilization ("accelerate / delegate more") advice is account-level:
 * every bridge pair on this machine sees the SAME account quota, so without a
 * shared brake several daemons would each nag "split more parallel work" at the
 * same time and collectively push toward over-parallelism. An in-memory
 * coordinator fingerprint cannot prevent that (each daemon has its own memory),
 * so the cooldown is persisted to a SHARED file in the guard's account-level
 * state dir — the same dir the guard `pending` files live in — keyed by advice
 * direction. A fresh acquire within `cooldownSec` of the last one (by ANY pair)
 * is denied.
 *
 * File layout (mirrors pending-reader's dir resolution):
 *   stateDir = process.env.BUDGET_STATE_DIR ?? join(homeDir, ".budget-guard")
 *   <stateDir>/advice-cooldown.json  →  { "<direction>": { lastEmittedEpoch } }
 *
 * Resilience: every read / JSON.parse is wrapped (ENOENT / malformed / scalar
 * are all treated as "no record" — fail OPEN so a corrupt file never wedges the
 * advice permanently). The cross-process read-modify-write is intentionally NOT
 * locked: an occasional double-emit across pairs in a tight race is acceptable
 * (the design explicitly accepts disk-level redundancy here); the cooldown's job
 * is to damp sustained collective nagging, not to guarantee exactly-once.
 *
 * `homeDir` is injected (never `homedir()` directly) so tests isolate to a temp
 * dir — the same seam pending-reader / QuotaSource use.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson } from "../atomic-json";

/** Default cooldown window: 30 minutes (design §3.4 / R8). */
export const DEFAULT_ADVICE_COOLDOWN_SEC = 1800;

/** Advice directions the cooldown brakes. Open string for forward-compat, but
 * the only producer today is the underutilization / accelerate signal. */
export type AdviceDirection = "underutilization";

const COOLDOWN_FILENAME = "advice-cooldown.json";

interface CooldownRecord {
  lastEmittedEpoch: number;
}

type CooldownFile = Record<string, CooldownRecord>;

/**
 * Resolve the cooldown window from the env (AGENTBRIDGE_BUDGET_ADVICE_COOLDOWN_SEC),
 * else the default. Out-of-range / non-numeric falls back. Bounds [0, 86400]:
 * 0 disables the cooldown (always acquire), one day is a generous ceiling.
 */
export function resolveAdviceCooldownSec(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.AGENTBRIDGE_BUDGET_ADVICE_COOLDOWN_SEC;
  if (raw === undefined || raw.trim() === "") return DEFAULT_ADVICE_COOLDOWN_SEC;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 86400) return DEFAULT_ADVICE_COOLDOWN_SEC;
  return parsed;
}

/**
 * Resolve the guard state dir: BUDGET_STATE_DIR env override, else ~/.budget-guard.
 * MUST stay byte-for-byte identical to pending-reader's resolveStateDir (trim +
 * compare + return the TRIMMED value) — both modules write into the same
 * account-level dir, so a whitespace-only override that one trims and the other
 * does not would split them into different directories and break the cross-pair
 * shared cooldown file.
 */
function resolveStateDir(homeDir: string): string {
  const override = process.env.BUDGET_STATE_DIR;
  if (override && override.trim() !== "") return override.trim();
  return join(homeDir, ".budget-guard");
}

export interface AdviceCooldownOptions {
  /** Injected home dir (test seam); the file lands under its .budget-guard. */
  homeDir: string;
  /** Cooldown window in seconds; default {@link DEFAULT_ADVICE_COOLDOWN_SEC}. */
  cooldownSec?: number;
  /** Optional diagnostic logger (no-op default). */
  log?: (message: string) => void;
}

export class AdviceCooldown {
  private readonly path: string;
  private readonly cooldownSec: number;
  private readonly log: (message: string) => void;

  constructor(options: AdviceCooldownOptions) {
    this.path = join(resolveStateDir(options.homeDir), COOLDOWN_FILENAME);
    this.cooldownSec = options.cooldownSec ?? DEFAULT_ADVICE_COOLDOWN_SEC;
    this.log = options.log ?? (() => {});
  }

  /**
   * Attempt to acquire the cooldown slot for `direction` at `now` (unix seconds).
   * Returns true (and records `now` to disk) when no record exists or the last
   * emit is older than `cooldownSec`; returns false (records nothing) when the
   * cooldown is still active. A cooldownSec of 0 always acquires.
   */
  tryAcquire(direction: AdviceDirection, now: number): boolean {
    const file = this.read();
    const last = file[direction]?.lastEmittedEpoch;
    if (
      this.cooldownSec > 0 &&
      typeof last === "number" &&
      Number.isFinite(last) &&
      now - last < this.cooldownSec &&
      // A future lastEmittedEpoch (clock skew / another host's clock ahead) would
      // otherwise wedge the advice; only honor a cooldown anchored in the past.
      last <= now
    ) {
      return false;
    }
    this.write({ ...file, [direction]: { lastEmittedEpoch: now } });
    return true;
  }

  private read(): CooldownFile {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf-8");
    } catch {
      return {}; // ENOENT and any read error → no record (fail open).
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      return parsed as CooldownFile;
    } catch {
      this.log(`advice-cooldown: ignoring malformed ${this.path}`);
      return {};
    }
  }

  private write(file: CooldownFile): void {
    try {
      atomicWriteJson(this.path, file);
    } catch (error) {
      // A write failure must never break advice emission — log and move on.
      this.log(`advice-cooldown: write failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * STM v2.3 §D2 P3: pair → port-assignment registry.
 *
 * Single source of truth for which pair name owns which (appPort, proxyPort)
 * tuple. Lives at `<stateDir>/pairs/registry.json` as an atomic-rename
 * JSON file. Not part of the project-local `.agentbridge/config.json` —
 * port allocation is a machine-global concern, not a per-project one.
 *
 * Allocation strategy:
 *   - `default` always maps to `(4500, 4501)` (the v2.2 values).
 *   - Named pairs are assigned the next free stride from
 *     `(STRIDE_BASE + STRIDE_STEP * n, STRIDE_BASE + STRIDE_STEP * n + 1)`
 *     where `n >= 1` and the ports aren't already claimed by another entry.
 *   - Up to `AGENTBRIDGE_MAX_PAIRS` live pairs and
 *     `AGENTBRIDGE_PAIR_PORT_MAX` stride scans before MAX_PAIRS /
 *     ALLOCATION_FAILED.
 *
 * Concurrency:
 *   - Atomic write (temp file + `rename()`) prevents partial writes from
 *     corrupting the registry across crashes.
 *   - Daemon serializes registry mutations through a daemon-wide promise
 *     chain mutex (lives in daemon.ts, not here — this module is pure).
 *
 * Validation:
 *   - Pair names must match D1's regex `^[a-z0-9][a-z0-9_-]{0,31}$`.
 *     Reserved values like `.` / `..` and any path-traversal char are
 *     rejected. `default` is permitted (D1 v0.3 clarification).
 *   - Invalid entries on load are dropped with a logged warning so a
 *     corrupted registry never blocks the daemon from booting.
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";

// ── Constants ──────────────────────────────────────────────────────────

/** Default pair's port tuple. Fixed by v2.2 compatibility. */
export const DEFAULT_PAIR_PORTS = { appPort: 4500, proxyPort: 4501 } as const;

/** Stride start (first named pair gets STRIDE_BASE). Default 4510. */
const STRIDE_BASE = 4510;
/** Distance between consecutive pair allocations. */
const STRIDE_STEP_DEFAULT = 10;
/** Number of strides scanned before giving up with `ALLOCATION_FAILED`. */
const STRIDE_MAX_DEFAULT = 20;
/** Maximum live pairs the daemon will accept. */
const MAX_PAIRS_DEFAULT = 8;

// ── Pair name validation (D1) ──────────────────────────────────────────

const PAIR_NAME_REGEX = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * D1 validation: lowercase alphanumeric + underscore + hyphen, 1-32 chars,
 * first char must be alphanumeric. `default` is permitted (and is the
 * reserved name with fixed ports). Anything that could escape a
 * filesystem path is rejected (D5 uses the pair name as a directory).
 */
export function isValidPairName(name: string): boolean {
  if (typeof name !== "string") return false;
  if (!PAIR_NAME_REGEX.test(name)) return false;
  // Belt-and-suspenders: the regex already excludes these but check
  // explicitly so the intent is recorded.
  if (name === "." || name === "..") return false;
  return true;
}

// ── Types ──────────────────────────────────────────────────────────────

export interface PairRegistryEntry {
  pairId: string;
  appPort: number;
  proxyPort: number;
  /** ms-since-epoch when this entry was first allocated. */
  allocatedAt: number;
}

export interface PairRegistrySnapshot {
  version: 1;
  entries: PairRegistryEntry[];
}

export type AllocateError =
  | { code: "INVALID_PAIR_NAME"; message: string }
  | { code: "MAX_PAIRS"; message: string }
  | { code: "ALLOCATION_FAILED"; message: string };

export type AllocateResult =
  | { ok: true; entry: PairRegistryEntry }
  | { ok: false; error: AllocateError };

// ── Registry class ─────────────────────────────────────────────────────

export interface PairRegistryOptions {
  /** Path to the registry JSON file. Parent dir is created if missing. */
  filePath: string;
  /** Logger (defaults to no-op). */
  log?: (msg: string) => void;
  /** Override stride step (default 10). */
  strideStep?: number;
  /** Override stride scan max (default 20). */
  strideMax?: number;
  /** Override max live pairs (default 8). */
  maxPairs?: number;
}

export class PairRegistry {
  private entries = new Map<string, PairRegistryEntry>();
  private readonly filePath: string;
  private readonly log: (msg: string) => void;
  private readonly strideStep: number;
  private readonly strideMax: number;
  private readonly maxPairs: number;

  constructor(opts: PairRegistryOptions) {
    this.filePath = opts.filePath;
    this.log = opts.log ?? (() => {});
    this.strideStep = opts.strideStep ?? STRIDE_STEP_DEFAULT;
    this.strideMax = opts.strideMax ?? STRIDE_MAX_DEFAULT;
    this.maxPairs = opts.maxPairs ?? MAX_PAIRS_DEFAULT;
  }

  /** Load registry from disk. Missing file or invalid contents → empty registry. */
  load(): void {
    this.entries.clear();
    if (!existsSync(this.filePath)) {
      this.log(`[pair-registry] no registry file at ${this.filePath} — starting empty`);
      return;
    }
    let raw: string;
    try {
      raw = readFileSync(this.filePath, "utf8");
    } catch (err: any) {
      this.log(`[pair-registry] failed to read ${this.filePath}: ${err?.message ?? err} — starting empty`);
      return;
    }
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch (err: any) {
      this.log(`[pair-registry] invalid JSON in ${this.filePath}: ${err?.message ?? err} — starting empty`);
      return;
    }
    if (!parsed || typeof parsed !== "object" || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      this.log(`[pair-registry] unexpected registry shape (missing version/entries) — starting empty`);
      return;
    }
    for (const candidate of parsed.entries) {
      if (this.isValidEntry(candidate)) {
        this.entries.set(candidate.pairId, candidate);
      } else {
        this.log(`[pair-registry] dropping invalid entry: ${JSON.stringify(candidate)}`);
      }
    }
    this.log(`[pair-registry] loaded ${this.entries.size} entries from ${this.filePath}`);
  }

  private isValidEntry(e: any): e is PairRegistryEntry {
    return (
      e !== null &&
      typeof e === "object" &&
      typeof e.pairId === "string" &&
      isValidPairName(e.pairId) &&
      typeof e.appPort === "number" &&
      typeof e.proxyPort === "number" &&
      Number.isInteger(e.appPort) &&
      Number.isInteger(e.proxyPort) &&
      e.appPort > 0 &&
      e.proxyPort > 0 &&
      e.appPort < 65536 &&
      e.proxyPort < 65536 &&
      typeof e.allocatedAt === "number"
    );
  }

  /** Atomic save: write to temp, then rename over the target. */
  save(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp.${randomBytes(6).toString("hex")}`;
    const snapshot: PairRegistrySnapshot = {
      version: 1,
      entries: [...this.entries.values()],
    };
    try {
      writeFileSync(tmp, JSON.stringify(snapshot, null, 2), "utf8");
      renameSync(tmp, this.filePath);
    } catch (err: any) {
      // Cleanup the temp on failure — leave the existing registry alone.
      try { if (existsSync(tmp)) unlinkSync(tmp); } catch {}
      throw new Error(`[pair-registry] save failed: ${err?.message ?? err}`);
    }
  }

  /** Get the registered entry for a pair name, or null. */
  get(pairId: string): PairRegistryEntry | null {
    return this.entries.get(pairId) ?? null;
  }

  /** Return all registered entries in insertion order. */
  list(): PairRegistryEntry[] {
    return [...this.entries.values()];
  }

  has(pairId: string): boolean {
    return this.entries.has(pairId);
  }

  /**
   * Allocate (or return existing) ports for `pairId`. Always uses the fixed
   * (4500, 4501) tuple for `"default"`; for other names, scans stride
   * positions to find the first free one.
   *
   * Caller must hold the daemon's registry-write mutex before invoking
   * allocate() + save() so concurrent allocations don't race.
   */
  allocate(pairId: string): AllocateResult {
    if (!isValidPairName(pairId)) {
      return {
        ok: false,
        error: {
          code: "INVALID_PAIR_NAME",
          message: `pair name "${pairId}" fails validation (regex ${PAIR_NAME_REGEX.source})`,
        },
      };
    }

    const existing = this.entries.get(pairId);
    if (existing) return { ok: true, entry: existing };

    if (this.entries.size >= this.maxPairs) {
      return {
        ok: false,
        error: {
          code: "MAX_PAIRS",
          message: `pair registry is at the ${this.maxPairs}-entry limit; destroy an unused pair (--forget) before allocating a new one`,
        },
      };
    }

    let appPort: number;
    let proxyPort: number;

    if (pairId === "default") {
      appPort = DEFAULT_PAIR_PORTS.appPort;
      proxyPort = DEFAULT_PAIR_PORTS.proxyPort;
      // If something else already holds these in the registry under a
      // different name (would be invalid), reject the allocation rather
      // than overwrite.
      for (const other of this.entries.values()) {
        if (other.appPort === appPort || other.proxyPort === proxyPort) {
          return {
            ok: false,
            error: {
              code: "ALLOCATION_FAILED",
              message: `default pair's reserved ports (${appPort}, ${proxyPort}) collide with registry entry "${other.pairId}"`,
            },
          };
        }
      }
    } else {
      const usedPorts = new Set<number>();
      for (const e of this.entries.values()) {
        usedPorts.add(e.appPort);
        usedPorts.add(e.proxyPort);
      }
      // Also reserve the default tuple even if it's not currently in the
      // registry, so a future ensurePair("default") won't collide.
      usedPorts.add(DEFAULT_PAIR_PORTS.appPort);
      usedPorts.add(DEFAULT_PAIR_PORTS.proxyPort);

      let found = false;
      appPort = 0;
      proxyPort = 0;
      for (let i = 1; i <= this.strideMax; i++) {
        const candidateApp = STRIDE_BASE + this.strideStep * (i - 1);
        const candidateProxy = candidateApp + 1;
        if (!usedPorts.has(candidateApp) && !usedPorts.has(candidateProxy)) {
          appPort = candidateApp;
          proxyPort = candidateProxy;
          found = true;
          break;
        }
      }
      if (!found) {
        return {
          ok: false,
          error: {
            code: "ALLOCATION_FAILED",
            message: `no free stride within ${this.strideMax} positions starting at ${STRIDE_BASE} (step ${this.strideStep})`,
          },
        };
      }
    }

    const entry: PairRegistryEntry = {
      pairId,
      appPort,
      proxyPort,
      allocatedAt: Date.now(),
    };
    this.entries.set(pairId, entry);
    this.log(`[pair-registry] allocated pair="${pairId}" appPort=${appPort} proxyPort=${proxyPort}`);
    return { ok: true, entry };
  }

  /**
   * Remove an entry. Returns true if something was removed. Caller is
   * responsible for calling save() and holding the registry mutex.
   */
  remove(pairId: string): boolean {
    if (!this.entries.has(pairId)) return false;
    this.entries.delete(pairId);
    this.log(`[pair-registry] removed pair="${pairId}"`);
    return true;
  }

  size(): number {
    return this.entries.size;
  }
}

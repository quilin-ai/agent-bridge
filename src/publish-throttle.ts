import { readFileSync } from "node:fs";
import { atomicWriteJson } from "./atomic-json";

export interface PublishThrottleOptions {
  filePath: string;
  windowMs: number;
  /** Clock injection for tests. */
  now?: () => number;
}

/**
 * Cross-process publish throttle (§3.3 noise control).
 *
 * `abg publish --from-hook` runs as a FRESH process per completion, so the
 * last-publish time per caller-chosen key (the publish path uses
 * `agentId|repo|branch|commit`) is persisted to a JSON file. A second completion
 * for the same key within `windowMs` is suppressed, so
 * a burst of Stop hooks collapses to one room event instead of spamming every
 * member. The file is written 0600 (it sits next to the collab secrets).
 *
 * ponytail: best-effort noise control, not exactly-once. The load-modify-write
 * is unlocked, so two truly-concurrent publishers for the same key can both pass
 * peek() and double-announce — harmless (one extra soft notice, no data loss);
 * add an O_EXCL/flock guard only if duplicate notices ever actually bite.
 */
export class PublishThrottle {
  constructor(private readonly opts: PublishThrottleOptions) {}

  private load(): Record<string, number> {
    try {
      const parsed = JSON.parse(readFileSync(this.opts.filePath, "utf-8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  /** True iff a publish for `key` is allowed now (no prior publish still inside the window). Pure read — does NOT consume the slot. */
  peek(key: string): boolean {
    const now = (this.opts.now ?? Date.now)();
    const last = this.load()[key];
    return last === undefined || now - last >= this.opts.windowMs;
  }

  /** Stamp `key` as published now (load-modify-write so other keys are preserved). */
  record(key: string): void {
    const state = this.load();
    state[key] = (this.opts.now ?? Date.now)();
    atomicWriteJson(this.opts.filePath, state, { mode: 0o600 });
  }

  /**
   * Check-and-consume a publish for `key` in one call: false if throttled,
   * else stamp + true. Prefer the {@link peek}/{@link record} pair when the
   * publish can fail — record only AFTER a confirmed send so a failed attempt
   * doesn't burn the dedup window.
   */
  allow(key: string): boolean {
    if (!this.peek(key)) return false;
    this.record(key);
    return true;
  }
}

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPairs } from "../cli/pairs";
import { writeRegistry, type PairEntry } from "../pair-registry";

/**
 * Regression: a corrupt registry (duplicate slot / duplicate lowercased pairId)
 * must NOT crash the recovery commands `abg pairs prune` and `abg pairs` (list).
 *
 * `readRegistry` deliberately throws PAIR_REGISTRY_CORRUPT on a duplicate slot/id
 * (so two pairs never silently share ports). Every registry-reading path funnels
 * through it, so the cleanup tooling meant to FIX a broken registry must degrade
 * gracefully — print the registry path + run the disk-scan reclamation that does
 * not need a parseable registry — exactly like `abg kill --all` already does.
 */

function pairEntry(slot: number, pairId: string, cwd = `/tmp/${pairId}`): PairEntry {
  return {
    pairId,
    slot,
    cwd,
    name: pairId.split("-")[0],
    source: "cwd",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("abg pairs against a corrupt (duplicate) registry", () => {
  let base: string;
  let savedBase: string | undefined;
  let savedState: string | undefined;
  let logs: string[];
  let errs: string[];
  let exitCode: number | undefined;
  let origLog: typeof console.log;
  let origErr: typeof console.error;

  beforeEach(() => {
    savedBase = process.env.AGENTBRIDGE_BASE_DIR;
    savedState = process.env.AGENTBRIDGE_STATE_DIR;
    base = mkdtempSync(join(tmpdir(), "abg-pairs-corrupt-"));
    process.env.AGENTBRIDGE_BASE_DIR = base;
    delete process.env.AGENTBRIDGE_STATE_DIR;

    logs = [];
    errs = [];
    origLog = console.log;
    origErr = console.error;
    console.log = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
    console.error = (...a: unknown[]) => void errs.push(a.map(String).join(" "));
    exitCode = undefined;
    process.exitCode = 0;
  });

  afterEach(() => {
    console.log = origLog;
    console.error = origErr;
    const restore = (k: string, v: string | undefined) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    };
    restore("AGENTBRIDGE_BASE_DIR", savedBase);
    restore("AGENTBRIDGE_STATE_DIR", savedState);
    // Reset to 0 (not undefined): the degraded prune/list path sets process.exitCode = 2,
    // and Bun — unlike Node — does NOT treat `process.exitCode = undefined` as a reset to
    // 0, so leaving it undefined leaks exit code 2 to the whole `bun test` run.
    process.exitCode = 0;
    rmSync(base, { recursive: true, force: true });
    void exitCode;
  });

  /** Write a registry whose JSON parses fine but trips readRegistry's duplicate guard. */
  function seedDuplicateSlotRegistry() {
    // Two distinct ids on the SAME slot — readRegistry throws PAIR_REGISTRY_CORRUPT.
    writeRegistry(base, {
      version: 1,
      // Cast: writeRegistry only serializes; the duplicate guard lives in readRegistry.
      pairs: [pairEntry(0, "alpha-0000aaaa"), pairEntry(0, "beta-1111bbbb")] as PairEntry[],
    });
  }

  function seedDuplicatePairIdRegistry() {
    // Same lowercased pairId on different slots — also a corrupt registry.
    writeRegistry(base, {
      version: 1,
      pairs: [pairEntry(0, "Alpha-0000aaaa"), pairEntry(1, "alpha-0000aaaa")] as PairEntry[],
    });
  }

  /** Drop an orphan pair-dir on disk so the disk-scan path has something to find. */
  function seedOrphanDir(id: string) {
    mkdirSync(join(base, "pairs", id), { recursive: true });
  }

  test("`abg pairs` (list) does not crash on a duplicate-slot registry; reports the path + degrades to disk scan", async () => {
    seedDuplicateSlotRegistry();
    seedOrphanDir("gamma-2222cccc");

    await expect(runPairs([])).resolves.toBeUndefined();

    const out = [...logs, ...errs].join("\n");
    // Readable error that names the registry file so the user can find/fix it.
    expect(out).toContain(join(base, "pairs", "registry.json"));
    // Degraded to a disk scan — the on-disk pair dir is surfaced.
    expect(out).toContain("gamma-2222cccc");
  });

  test("`abg pairs` (list, --json) does not crash on a duplicate-pairId registry", async () => {
    seedDuplicatePairIdRegistry();
    seedOrphanDir("delta-3333dddd");

    await expect(runPairs(["--json"])).resolves.toBeUndefined();
    const out = [...logs, ...errs].join("\n");
    expect(out).toContain(join(base, "pairs", "registry.json"));
  });

  test("`abg pairs prune` (dry run) does not crash on a duplicate-slot registry; reports the path + lists disk-scan reclaimable dirs", async () => {
    seedDuplicateSlotRegistry();
    seedOrphanDir("gamma-2222cccc");

    await expect(runPairs(["prune"])).resolves.toBeUndefined();

    const out = [...logs, ...errs].join("\n");
    expect(out).toContain(join(base, "pairs", "registry.json"));
    // The disk-scan reclamation offers the orphan dir even though the registry is unreadable.
    expect(out).toContain("gamma-2222cccc");
    // It must not have crashed with a non-degrading global error.
    expect(process.exitCode === 1).toBe(false);
  });

  test("`abg pairs prune --apply` does not crash on a duplicate-slot registry and removes the orphan dir", async () => {
    seedDuplicateSlotRegistry();
    seedOrphanDir("gamma-2222cccc");

    await expect(runPairs(["prune", "--apply"])).resolves.toBeUndefined();

    const out = [...logs, ...errs].join("\n");
    expect(out).toContain(join(base, "pairs", "registry.json"));
    // The orphan dir is actually removed by the disk-scan path under --apply.
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(base, "pairs", "gamma-2222cccc"))).toBe(false);
  });
});

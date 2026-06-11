import { join } from "node:path";
import { DaemonLifecycle } from "../daemon-lifecycle";
import {
  classifyReclaimableEntries,
  detectLegacyRootDaemon,
  listPairDirs,
  pairDirDaemonAlive,
  PairError,
  pairsRootDir,
  removeOrphanPairDirIgnoringRegistry,
  removePairEntryAndDir,
  removeUnregisteredPairDir,
  validatePairId,
  type PairEntry,
  type PairPorts,
  type ReclaimableEntry,
} from "../pair-registry";
import {
  computeBaseDir,
  findPairForFlag,
  listPairs,
  portsForEntry,
} from "../pair-resolver";
import { StateDirResolver } from "../state-dir";
import { readRawCurrentThread } from "../thread-state";
import { stopPairEntry } from "./kill";

interface PairRow {
  pairId: string;
  name: string;
  slot: number | null;
  ports: PairPorts;
  source: PairEntry["source"] | "legacy";
  cwd: string;
  running: boolean;
  pid: number | null;
  threadId: string | null;
  threadStatus: string | null;
  threadUpdatedAt: string | null;
}

/**
 * The registry is exactly the state that gets corrupted when things go wrong — a
 * duplicate slot / duplicate pairId (a manual edit or downgrade-then-upgrade)
 * makes `readRegistry` throw PAIR_REGISTRY_CORRUPT. The recovery commands
 * (`abg pairs` / `abg pairs prune`) must not crash on the very thing they exist
 * to clean up, so they catch THIS error (by code, never by string match) and
 * degrade to the disk-scan reclamation that does not need a parseable registry —
 * mirroring `abg kill --all` (see cli/kill.ts). Any other error still propagates.
 */
function isRegistryCorruptError(error: unknown): error is PairError {
  return error instanceof PairError && error.code === "PAIR_REGISTRY_CORRUPT";
}

/** Best-effort registry file path for the degraded notice (prefers the error's own path). */
function registryPathForNotice(base: string, error: PairError): string {
  const fromDetails = error.details?.path;
  return typeof fromDetails === "string" && fromDetails.length > 0
    ? fromDetails
    : join(pairsRootDir(base), "registry.json");
}

export async function runPairs(args: string[] = []) {
  const [command, ...rest] = args;

  if (command === "rm") {
    await runRemove(rest);
    return;
  }

  if (command === "prune") {
    await runPrune(rest);
    return;
  }

  if (command && command !== "list" && command !== "--json" && command !== "--threads") {
    console.error(`Unknown pairs command: ${command}`);
    console.error(
      "Usage: abg pairs [--json] [--threads] | abg pairs rm <name|id> | abg pairs prune [--apply]",
    );
    process.exit(1);
  }

  const json = command === "--json" || rest.includes("--json");
  const includeThreads = rest.includes("--threads") || args.includes("--threads");
  const rows = await collectRows();
  if (json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  printTable(rows, { includeThreads });
}

async function runRemove(args: string[]) {
  const flag = args[0];
  if (!flag) {
    console.error("Error: `abg pairs rm <name|id>` requires a pair name or id.");
    process.exit(1);
  }

  const base = computeBaseDir();
  // Accept a cwd-scoped friendly name (e.g. "work") OR a raw composite id copied
  // from `abg pairs` — same resolution kill uses, for consistency.
  let pair: PairEntry | null;
  try {
    pair = findPairForFlag(base, process.cwd(), flag);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (!pair) {
    console.log(`No such pair: "${flag}" in ${process.cwd()}`);
    printKnownPairs(base);
    return;
  }

  const stop = await stopPairEntry(base, pair);
  if (stop.error) {
    // Stopping failed (e.g. a process refused to die) — do NOT delete the
    // registry entry or its state dir, or we would orphan a still-running
    // daemon/TUI and leak its slot. Leave everything for a retry.
    console.error(
      `Error: failed to stop pair ${pair.pairId}; leaving it registered. ` +
        `${stop.error instanceof Error ? stop.error.message : String(stop.error)}`,
    );
    process.exit(1);
  }

  // Remove the registry entry AND the state dir atomically under the registry
  // lock (removePairEntryAndDir). Holding the lock across the delete closes the
  // re-register-DURING-delete window: a concurrent `abg claude/codex` re-registers
  // the same deterministic id under the SAME lock (in resolvePair), so it cannot
  // slip in between our membership/liveness check and the delete and have its
  // fresh dir removed. A live daemon in the dir aborts the delete (keptLive); a
  // dir-delete failure throws with the entry still registered (retryable via
  // prune). NOTE: a pre-existing launch-side window remains (a launcher that
  // reused the entry before we locked, pre-pid) — see removePairEntryAndDir.
  let result: { entry: PairEntry | null; dirRemoved: boolean; keptLive: boolean };
  try {
    result = await removePairEntryAndDir(base, pair.pairId);
  } catch (err) {
    console.error(
      `Error: could not delete state dir for ${pair.pairId}; registry entry kept — retry or run \`abg pairs prune\`. ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }

  if (result.keptLive) {
    console.log(`Pair ${pair.pairId} is live again (relaunched concurrently); not removed. Stop it first, then retry.`);
    return;
  }

  const dirNote = result.dirRemoved ? " State directory deleted." : "";
  if (result.entry) {
    console.log(`Removed pair ${result.entry.pairId}; slot ${result.entry.slot} is now available.${dirNote}`);
  } else {
    console.log(`Pair ${pair.pairId} was already absent from the registry.${dirNote}`);
  }
}

/**
 * `abg pairs prune [--apply]` — reclaim two kinds of registry leak:
 *
 *   1. ORPHAN DIRS — a state dir under `<base>/pairs` with NO registry entry and
 *      no live daemon (older builds / pre-B1 `abg pairs rm` dropped the entry but
 *      left the dir). Reclaimed via removeUnregisteredPairDir.
 *   2. RECLAIMABLE ENTRIES (P1 #9) — a registry entry that is permanently invalid:
 *      its cwd is gone, no live daemon owns it, and it is older than
 *      RECLAIMABLE_MIN_AGE_MS. The canonical case is a double-hash-bug strand that
 *      permanently occupies a slot/port range. Reclaimed (entry + dir together)
 *      via removePairEntryAndDir.
 *
 * DRY RUN IS THE DEFAULT — the command only ever reports what it WOULD reclaim.
 * `--apply` is required to actually delete. Registered-and-valid, live, or
 * too-young entries/dirs are never touched.
 */
async function runPrune(args: string[]) {
  // Dry run is the default; deletion requires an explicit --apply. `--dry-run` is
  // still accepted as an explicit no-op alias for the default so older muscle
  // memory / scripts keep working.
  const apply = args.includes("--apply");
  for (const arg of args) {
    if (arg !== "--apply" && arg !== "--dry-run") {
      console.error(`Unknown prune argument: ${arg}`);
      console.error("Usage: abg pairs prune [--apply]");
      process.exit(1);
    }
  }
  if (apply && args.includes("--dry-run")) {
    console.error("Error: --apply and --dry-run are mutually exclusive.");
    console.error("Usage: abg pairs prune [--apply]");
    process.exit(1);
  }

  const base = computeBaseDir();

  // Classify reclaimable entries up front so the orphan-dir pass can SKIP the
  // dirs that the entry pass will reclaim — otherwise a stranded entry's dir is
  // double-reported (once as "registered" in Kept, once as a reclaimed entry).
  //
  // The registry is the very thing prune exists to repair, so a CORRUPT registry
  // (duplicate slot/pairId from a manual edit or downgrade-then-upgrade) must NOT
  // crash the command — `classifyReclaimableEntries` funnels through `readRegistry`
  // which throws PAIR_REGISTRY_CORRUPT. Degrade like `abg kill --all`: report the
  // registry path, then run the registry-free disk-scan reclamation (orphan dirs)
  // that needs no parseable registry. The entry pass is skipped (it cannot run
  // without a readable registry) and `registryReadable=false` switches the dir
  // pass to a membership-check-free delete.
  let reclaimable: ReclaimableEntry[];
  let registryReadable = true;
  try {
    reclaimable = classifyReclaimableEntries(base);
  } catch (error) {
    if (!isRegistryCorruptError(error)) throw error;
    registryReadable = false;
    reclaimable = [];
    console.error(
      `⚠️  pair registry 不可读（${error.message}）——` +
        `位于 ${registryPathForNotice(base, error)}。` +
        `跳过 registry 条目回收，降级为磁盘扫描清理孤儿目录（无需可解析的 registry）。` +
        `修复或删除该文件后可恢复完整 prune。`,
    );
    // Scriptability: a degraded run is not a clean success.
    process.exitCode = 2;
  }
  const reclaimableIds = new Set(reclaimable.map((c) => c.entry.pairId.toLowerCase()));

  const dirResult = pruneOrphanDirs(base, apply, reclaimableIds, registryReadable);
  const entryResult = await pruneReclaimableEntries(reclaimable, base, apply);
  // The orphan-dir prune may itself perform locked deletes; await it after we
  // have its (synchronously-built) plan so both passes report coherently.
  const resolvedDirResult = await dirResult;

  printPruneSummary(resolvedDirResult, entryResult, apply);
}

interface OrphanDirResult {
  removed: string[];
  kept: Array<{ name: string; reason: string }>;
}

/**
 * Reclaim orphan pair state dirs (dir exists, no registry entry, not live).
 * `reclaimableIds` are the lowercased pairIds the ENTRY pass will reclaim — their
 * dirs are skipped here so they are not also reported as "registered" Kept dirs.
 *
 * `registryReadable=false` is the corrupt-registry degradation: `listPairs` would
 * itself throw, so we treat the registered set as empty and switch the `--apply`
 * delete to {@link removeOrphanPairDirIgnoringRegistry} (liveness gate only, no
 * registry membership read). This is the registry-free disk-scan reclamation the
 * recovery command must still offer when the registry cannot be parsed.
 */
async function pruneOrphanDirs(
  base: string,
  apply: boolean,
  reclaimableIds: ReadonlySet<string>,
  registryReadable: boolean,
): Promise<OrphanDirResult> {
  // On a corrupt registry `listPairs` throws — degrade to an empty registered set
  // so the disk scan can still surface (and, under --apply, reclaim) orphan dirs.
  const registered = registryReadable
    ? new Set(listPairs(base).map((pair) => pair.pairId.toLowerCase()))
    : new Set<string>();
  const removed: string[] = [];
  const kept: Array<{ name: string; reason: string }> = [];

  for (const name of listPairDirs(base)) {
    let id: string;
    try {
      id = validatePairId(name);
    } catch {
      kept.push({ name, reason: "not a managed pair-id directory" });
      continue;
    }
    // validatePairId trims surrounding whitespace; only ever act on a dir whose
    // raw on-disk name IS the canonical id, so a hand-crafted " main" can never
    // be trimmed into and delete a different real pair "main".
    if (id !== name) {
      kept.push({ name, reason: "directory name is not a canonical pair id" });
      continue;
    }
    // The entry pass owns this dir (it will reclaim the entry + dir together) —
    // don't report it here at all.
    if (reclaimableIds.has(id.toLowerCase())) {
      continue;
    }
    if (registered.has(id.toLowerCase())) {
      kept.push({ name, reason: "registered — use `abg pairs rm`" });
      continue;
    }
    // Cheap pre-filter using the SAME conservative liveness probe as the
    // authoritative in-lock gate (pairDirDaemonAlive), so the dry-run preview
    // matches what a real prune would do and the pid logic lives in one place.
    if (pairDirDaemonAlive(base, id)) {
      kept.push({ name, reason: "daemon still alive" });
      continue;
    }
    if (!apply) {
      removed.push(name);
      continue;
    }
    try {
      // Delete under the registry lock so a concurrent (re)registration or a
      // daemon start for this id cannot race the orphan check — under the lock
      // removeUnregisteredPairDir re-verifies membership AND liveness before it
      // removes anything (the initial gates above are just a cheap pre-filter).
      //
      // On a corrupt registry the membership re-check is impossible (readRegistry
      // throws under the lock too), so degrade to the liveness-only delete — still
      // locked, still refusing any live daemon's dir.
      const outcome = registryReadable
        ? await removeUnregisteredPairDir(base, id)
        : await removeOrphanPairDirIgnoringRegistry(base, id);
      if (outcome.removed) {
        removed.push(name);
      } else if (outcome.reason === "registered") {
        kept.push({ name, reason: "registered during prune — use `abg pairs rm`" });
      } else if (outcome.reason === "live") {
        kept.push({ name, reason: "daemon became live during prune" });
      } else {
        kept.push({ name, reason: "already gone" });
      }
    } catch (err) {
      kept.push({ name, reason: `error: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  return { removed, kept };
}

interface EntryReclaimResult {
  /** Entries reclaimed (--apply) or that WOULD be reclaimed (default dry run). */
  reclaimed: Array<{ pairId: string; slot: number; reason: string }>;
  /** Entries skipped at apply time because a concurrent relaunch made them live. */
  kept: Array<{ pairId: string; reason: string }>;
}

/**
 * Reclaim permanently-invalid registry entries (cwd-gone + dead + old).
 *
 * `candidates` is the read-only classification from `classifyReclaimableEntries`,
 * which also builds the dry-run preview. Under `--apply` each candidate is deleted
 * via `removePairEntryAndDir`, whose in-lock liveness gate is the authoritative
 * check: if a relaunch made the pair live between classify and delete, it is kept
 * (keptLive), never destroyed.
 */
async function pruneReclaimableEntries(
  candidates: ReclaimableEntry[],
  base: string,
  apply: boolean,
): Promise<EntryReclaimResult> {
  const reclaimed: Array<{ pairId: string; slot: number; reason: string }> = [];
  const kept: Array<{ pairId: string; reason: string }> = [];

  for (const candidate of candidates) {
    const reason = describeReclaimReason(candidate);
    if (!apply) {
      reclaimed.push({ pairId: candidate.entry.pairId, slot: candidate.entry.slot, reason });
      continue;
    }
    try {
      const res = await removePairEntryAndDir(base, candidate.entry.pairId);
      if (res.keptLive) {
        kept.push({ pairId: candidate.entry.pairId, reason: "became live during prune" });
      } else {
        reclaimed.push({ pairId: candidate.entry.pairId, slot: candidate.entry.slot, reason });
      }
    } catch (err) {
      kept.push({
        pairId: candidate.entry.pairId,
        reason: `error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return { reclaimed, kept };
}

/** Human-readable reason string for a reclaimable entry (cwd-gone, dead, age). */
function describeReclaimReason(candidate: ReclaimableEntry): string {
  const { signals } = candidate;
  const age = signals.ageMs === null ? "age?" : `age ${formatAgeDays(signals.ageMs)}`;
  return `cwd-gone, dead, ${age}`;
}

/** Format a millisecond age as a compact "Nd" / "N.Nd" day count for the reason line. */
function formatAgeDays(ageMs: number): string {
  const days = ageMs / (24 * 60 * 60 * 1000);
  return days >= 10 ? `${Math.round(days)}d` : `${days.toFixed(1)}d`;
}

function printPruneSummary(dirResult: OrphanDirResult, entryResult: EntryReclaimResult, apply: boolean) {
  const { removed: dirsRemoved, kept: dirsKept } = dirResult;
  const { reclaimed: entriesReclaimed, kept: entriesKept } = entryResult;

  const nothingFound =
    dirsRemoved.length === 0 &&
    dirsKept.length === 0 &&
    entriesReclaimed.length === 0 &&
    entriesKept.length === 0;
  if (nothingFound) {
    console.log("Nothing to prune: no orphan pair directories or reclaimable entries found.");
    return;
  }

  // --- Orphan dirs ---
  if (dirsRemoved.length > 0) {
    console.log(apply ? "Removed orphan pair directories:" : "Would remove orphan pair directories:");
    for (const name of dirsRemoved) console.log(`  ${name}`);
  }

  // --- Reclaimable entries ---
  if (entriesReclaimed.length > 0) {
    console.log(apply ? "Reclaimed registry entries:" : "Would reclaim registry entries:");
    for (const { pairId, slot, reason } of entriesReclaimed) {
      console.log(`  ${pairId} (slot ${slot}) — ${reason}`);
    }
  }

  if (dirsRemoved.length === 0 && entriesReclaimed.length === 0) {
    console.log(apply ? "Nothing was reclaimed." : "Nothing to reclaim.");
  }

  // --- Kept (skipped) ---
  const keptLines = [
    ...dirsKept.map(({ name, reason }) => `  ${name} (${reason})`),
    ...entriesKept.map(({ pairId, reason }) => `  ${pairId} (${reason})`),
  ];
  if (keptLines.length > 0) {
    console.log("Kept:");
    for (const line of keptLines) console.log(line);
  }

  if (!apply) {
    console.log("\n(dry run — nothing was deleted. Re-run with --apply to reclaim.)");
  }
}

async function collectRows(): Promise<PairRow[]> {
  const base = computeBaseDir();
  // The list command is itself a recovery aid, so a CORRUPT registry (duplicate
  // slot/pairId) must not crash it — `listPairs` funnels through `readRegistry`
  // which throws PAIR_REGISTRY_CORRUPT. Degrade like `abg kill --all`: report the
  // registry path, then enumerate the on-disk pair dirs (disk scan) so the user
  // can still see — and clean up — what is on disk.
  let rows: PairRow[];
  try {
    rows = await Promise.all(listPairs(base).map((pair) => rowForPair(base, pair)));
  } catch (error) {
    if (!isRegistryCorruptError(error)) throw error;
    console.error(
      `⚠️  pair registry 不可读（${error.message}）——` +
        `位于 ${registryPathForNotice(base, error)}。` +
        `降级为磁盘扫描列出 ${pairsRootDir(base)} 下的 pair 目录（slot/name/cwd 等需 registry 的字段显示为 -）。` +
        `修复或删除该文件后可恢复完整列表；用 \`abg pairs prune\` 清理孤儿目录。`,
    );
    // Scriptability: a degraded list is not a clean success.
    process.exitCode = 2;
    rows = await collectDiskScanRows(base);
  }
  const legacy = detectLegacyRootDaemon(base);
  if (legacy) {
    rows.push({
      pairId: "(legacy-root)",
      name: "-",
      slot: null,
      ports: { appPort: 4500, proxyPort: 4501, controlPort: legacy.controlPort },
      source: "legacy",
      cwd: base,
      running: true,
      pid: legacy.pid,
      threadId: null,
      threadStatus: null,
      threadUpdatedAt: null,
    });
  }
  return rows;
}

async function rowForPair(base: string, pair: PairEntry): Promise<PairRow> {
  const ports = portsForEntry(pair);
  const stateDir = new StateDirResolver(join(base, "pairs", pair.pairId));
  const lifecycle = new DaemonLifecycle({
    stateDir,
    controlPort: ports.controlPort,
    log: () => {},
  });
  const [running, record] = await Promise.all([
    lifecycle.isHealthy(),
    Promise.resolve(lifecycle.readDaemonRecord()),
  ]);
  const thread = readRawCurrentThread(stateDir);

  return {
    pairId: pair.pairId,
    name: pair.name ?? "-",
    slot: pair.slot,
    ports,
    source: pair.source,
    cwd: pair.cwd,
    running,
    pid: typeof record?.pid === "number" ? record.pid : null,
    threadId: thread?.threadId ?? null,
    threadStatus: thread?.status ?? null,
    threadUpdatedAt: thread?.updatedAt ?? null,
  };
}

/**
 * Degraded row source for a CORRUPT registry: enumerate the on-disk pair dirs
 * (no registry read) and read each daemon's own advertised record from disk. The
 * registry-only fields (slot / friendly name / source / registered cwd) are not
 * available, so they render as `-` / 0 — the dir name (pairId) plus liveness is
 * still enough for the user to act (`abg pairs prune`, `abg kill --all`).
 */
async function collectDiskScanRows(base: string): Promise<PairRow[]> {
  const names = listPairDirsSafe(base);
  return Promise.all(names.map((name) => rowForDiskScanDir(base, name)));
}

function listPairDirsSafe(base: string): string[] {
  try {
    return listPairDirs(base);
  } catch {
    return [];
  }
}

async function rowForDiskScanDir(base: string, dirName: string): Promise<PairRow> {
  const stateDir = new StateDirResolver(join(base, "pairs", dirName));
  // Read the daemon's own advertised record from disk to recover ports/pid — the
  // slot→port arithmetic needs a registry entry we cannot read here.
  const record = new DaemonLifecycle({ stateDir, controlPort: 0, log: () => {} }).readDaemonRecord();
  const ports: PairPorts = {
    appPort: record?.ports?.appPort ?? 0,
    proxyPort: record?.ports?.proxyPort ?? 0,
    controlPort: record?.ports?.controlPort ?? 0,
  };
  const running =
    ports.controlPort > 0
      ? await new DaemonLifecycle({ stateDir, controlPort: ports.controlPort, log: () => {} }).isHealthy()
      : false;
  const thread = readRawCurrentThread(stateDir);
  return {
    pairId: dirName,
    name: "-",
    slot: null,
    ports,
    source: "cwd",
    cwd: "-",
    running,
    pid: typeof record?.pid === "number" ? record.pid : null,
    threadId: thread?.threadId ?? null,
    threadStatus: thread?.status ?? null,
    threadUpdatedAt: thread?.updatedAt ?? null,
  };
}

function printTable(rows: PairRow[], options: { includeThreads?: boolean } = {}) {
  if (rows.length === 0) {
    console.log("No pairs registered.");
    return;
  }

  const data = rows.map((row) => ({
    name: row.name,
    pairId: row.pairId,
    slot: row.slot === null ? "-" : String(row.slot),
    ports: `${row.ports.appPort}/${row.ports.proxyPort}/${row.ports.controlPort}`,
    source: row.source,
    cwd: row.cwd,
    status: row.running ? "running" : "stopped",
    pid: row.pid === null ? "-" : String(row.pid),
    thread: row.threadId === null ? "-" : row.threadId,
    threadStatus: row.threadStatus === null ? "-" : row.threadStatus,
  }));

  const headers = {
    name: "name",
    pairId: "pairId",
    slot: "slot",
    ports: "app/proxy/control",
    source: "source",
    status: "status",
    pid: "pid",
    thread: "threadId",
    threadStatus: "thread",
    cwd: "cwd",
  };
  const visibleKeys = options.includeThreads
    ? ["name", "pairId", "slot", "ports", "source", "status", "pid", "thread", "threadStatus", "cwd"] as const
    : ["name", "pairId", "slot", "ports", "source", "status", "pid", "cwd"] as const;
  const widths = Object.fromEntries(
    visibleKeys.map((key) => [
      key,
      Math.max(
        headers[key as keyof typeof headers].length,
        ...data.map((row) => row[key as keyof typeof row].length),
      ),
    ]),
  ) as Record<keyof typeof headers, number>;

  const line = (row: Record<keyof typeof headers, string>) =>
    visibleKeys.map((key) => row[key].padEnd(widths[key])).join("  ");

  console.log(line(headers));
  console.log(
    visibleKeys.map((key) => "-".repeat(widths[key])).join("  "),
  );
  for (const row of data) {
    console.log(line(row));
  }
}

function printKnownPairs(base: string) {
  const pairs = listPairs(base);
  if (pairs.length === 0) {
    console.log("No pairs registered.");
    return;
  }
  console.log("Known pairs:");
  for (const pair of pairs) {
    console.log(`  ${pair.pairId}`);
  }
}

import { join } from "node:path";
import { DaemonLifecycle } from "../daemon-lifecycle";
import { detectLegacyRootDaemon, type PairEntry, type PairPorts } from "../pair-registry";
import {
  computeBaseDir,
  findPairForFlag,
  listPairs,
  portsForEntry,
  removePair,
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

export async function runPairs(args: string[] = []) {
  const [command, ...rest] = args;

  if (command === "rm") {
    await runRemove(rest);
    return;
  }

  if (command && command !== "list" && command !== "--json" && command !== "--threads") {
    console.error(`Unknown pairs command: ${command}`);
    console.error("Usage: abg pairs [--json] [--threads] | abg pairs rm <name|id>");
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

  await stopPairEntry(base, pair);
  const removed = await removePair(base, pair.pairId);
  if (removed) {
    console.log(`Removed pair ${removed.pairId}; slot ${removed.slot} is now available.`);
  } else {
    console.log(`Pair ${pair.pairId} was already absent from the registry.`);
  }
}

async function collectRows(): Promise<PairRow[]> {
  const base = computeBaseDir();
  const rows = await Promise.all(listPairs(base).map((pair) => rowForPair(base, pair)));
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
  const [running, status] = await Promise.all([
    lifecycle.isHealthy(),
    Promise.resolve(lifecycle.readStatus()),
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
    pid: typeof status?.pid === "number" ? status.pid : null,
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

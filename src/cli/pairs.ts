/**
 * STM v2.3 §8.2 P4c — `abg pairs` subcommand surface.
 *
 *   abg pairs                  → help / list of pairs (shorthand for `abg pairs ls`)
 *   abg pairs ls               → list all registered pairs (live + registry-only)
 *   abg pairs rm NAME [--forget] [--force]
 *                              → destroy a pair via daemon's destroy_pair RPC
 *
 * Implementation: thin wrappers around the control-WS protocol added in
 * P3b (ensure_pair / destroy_pair / list_pairs). Uses one-shot WS
 * requests rather than a long-lived DaemonClient since these are
 * fire-and-exit commands.
 */

import { isValidPairName } from "../pair-registry";

const CONTROL_PORT_DEFAULT = parseInt(process.env.AGENTBRIDGE_CONTROL_PORT ?? "4502", 10);

interface PairListEntry {
  pairId: string;
  isLive: boolean;
  appServerUrl: string;
  proxyUrl: string;
  tuiConnected: boolean;
  proxyTuiConnected: boolean;
  pairedChatId: string | null;
  threadId: string | null;
  attachedClaudes: { chatId: string; paired: boolean }[];
}

async function controlWsRequest<TReq extends { type: string; requestId: string }, TRes>(
  controlPort: number,
  request: TReq,
  matchResponse: (msg: any) => msg is TRes,
  timeoutMs = 5000,
): Promise<TRes> {
  const url = `ws://127.0.0.1:${controlPort}/ws`;
  return new Promise<TRes>((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      reject(new Error(`control-WS request timed out after ${timeoutMs}ms (type=${request.type})`));
    }, timeoutMs);
    ws.addEventListener("open", () => {
      try { ws.send(JSON.stringify(request)); } catch (err: any) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { ws.close(); } catch {}
        reject(new Error(`control-WS send failed: ${err?.message ?? err}`));
      }
    });
    ws.addEventListener("message", (ev) => {
      if (settled) return;
      try {
        const msg = JSON.parse(ev.data.toString());
        if (matchResponse(msg)) {
          settled = true;
          clearTimeout(timer);
          try { ws.close(); } catch {}
          resolve(msg);
        }
      } catch { /* ignore */ }
    });
    ws.addEventListener("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("control-WS connection error — is the daemon running?"));
    });
    ws.addEventListener("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error("control-WS closed before response"));
    });
  });
}

export async function runPairs(args: string[]): Promise<void> {
  const subcommand = args[0];
  const subArgs = args.slice(1);
  switch (subcommand) {
    case undefined:
    case "ls":
    case "list":
      await runPairsLs();
      break;
    case "rm":
    case "destroy":
      await runPairsRm(subArgs);
      break;
    case "--help":
    case "-h":
      printPairsHelp();
      break;
    default:
      console.error(`Unknown subcommand: pairs ${subcommand}`);
      console.error(`Run \`abg pairs --help\` for usage.`);
      process.exit(1);
  }
}

async function runPairsLs(): Promise<void> {
  let response: { pairs: PairListEntry[] };
  try {
    response = await controlWsRequest<
      { type: "list_pairs"; requestId: string },
      { type: "pair_list"; requestId: string; pairs: PairListEntry[] }
    >(
      CONTROL_PORT_DEFAULT,
      {
        type: "list_pairs",
        requestId: `cli-pairs-ls-${Date.now()}`,
      },
      (msg): msg is { type: "pair_list"; requestId: string; pairs: PairListEntry[] } => {
        return msg && msg.type === "pair_list";
      },
    );
  } catch (err: any) {
    console.error(`[agentbridge] Failed to list pairs: ${err?.message ?? err}`);
    console.error(`[agentbridge] Is the daemon running? Try \`abg codex\` to start it.`);
    process.exit(1);
  }

  if (response.pairs.length === 0) {
    console.log("No pairs registered.");
    return;
  }

  // Column widths sized to current pair names; capped so output stays readable.
  const nameWidth = Math.max(4, ...response.pairs.map((p) => p.pairId.length));
  const proxyWidth = Math.max(10, ...response.pairs.map((p) => p.proxyUrl.length));
  const appWidth = Math.max(10, ...response.pairs.map((p) => p.appServerUrl.length));
  const pairedWidth = Math.max(11, ...response.pairs.map((p) => (p.pairedChatId ?? "-").length));

  const header = `${"PAIR".padEnd(nameWidth)}  ${"LIVE".padEnd(4)}  ${"PROXY".padEnd(proxyWidth)}  ${"APP".padEnd(appWidth)}  ${"TUI".padEnd(3)}  ${"PAIRED-CHAT".padEnd(pairedWidth)}  CHATS`;
  console.log(header);
  console.log("-".repeat(header.length));
  for (const p of response.pairs) {
    const liveDot = p.isLive ? "●" : "○";
    const tuiDot = p.proxyTuiConnected ? "●" : "○";
    const paired = p.pairedChatId ?? "-";
    const chats = p.attachedClaudes.length;
    console.log(
      `${p.pairId.padEnd(nameWidth)}  ${liveDot.padEnd(4)}  ${p.proxyUrl.padEnd(proxyWidth)}  ${p.appServerUrl.padEnd(appWidth)}  ${tuiDot.padEnd(3)}  ${paired.padEnd(pairedWidth)}  ${chats}`,
    );
  }
}

async function runPairsRm(args: string[]): Promise<void> {
  let pairId: string | undefined;
  let forget = false;
  let force = false;
  for (const a of args) {
    if (a === "--forget") { forget = true; continue; }
    if (a === "--force") { force = true; continue; }
    if (a.startsWith("--")) {
      console.error(`Unknown flag: ${a}`);
      console.error(`Usage: abg pairs rm NAME [--forget] [--force]`);
      process.exit(1);
    }
    if (pairId) {
      console.error(`Error: only one pair name accepted; got "${pairId}" and "${a}".`);
      process.exit(1);
    }
    pairId = a;
  }
  if (!pairId) {
    console.error(`Error: pair name required.`);
    console.error(`Usage: abg pairs rm NAME [--forget] [--force]`);
    process.exit(1);
  }
  if (!isValidPairName(pairId)) {
    console.error(`Error: pair name "${pairId}" is invalid.`);
    process.exit(1);
  }

  let response: { type: "pair_destroyed" | "pair_error"; [k: string]: any };
  try {
    response = await controlWsRequest<
      { type: "destroy_pair"; requestId: string; pairId: string; forget: boolean; force: boolean },
      { type: "pair_destroyed" | "pair_error"; requestId: string; [k: string]: any }
    >(
      CONTROL_PORT_DEFAULT,
      {
        type: "destroy_pair",
        requestId: `cli-pairs-rm-${Date.now()}`,
        pairId,
        forget,
        force,
      },
      (msg): msg is { type: "pair_destroyed" | "pair_error"; requestId: string; [k: string]: any } => {
        return msg && (msg.type === "pair_destroyed" || msg.type === "pair_error");
      },
    );
  } catch (err: any) {
    console.error(`[agentbridge] Failed to destroy pair: ${err?.message ?? err}`);
    process.exit(1);
  }

  if (response.type === "pair_error") {
    if (response.code === "PAIR_BUSY_NOT_FORCED") {
      console.error(`Error: pair "${pairId}" has a paired Claude — pass --force to tear down anyway.`);
      console.error(`  ${response.message ?? ""}`);
    } else if (response.code === "PAIR_NOT_FOUND") {
      console.error(`Error: pair "${pairId}" not found (neither live nor registered).`);
    } else {
      console.error(`Error (${response.code}): ${response.message ?? ""}`);
    }
    process.exit(1);
  }

  const parts: string[] = [];
  if (response.wasLive) parts.push("torn down live pair");
  else parts.push("no live pair to tear down");
  if (response.registryEntryRemoved) parts.push("removed registry entry");
  else if (forget) parts.push("registry entry was not present");
  else parts.push("kept registry entry (use --forget to remove)");
  console.log(`Pair "${pairId}" destroyed: ${parts.join("; ")}.`);
}

function printPairsHelp(): void {
  console.log(`
AgentBridge pair management

Usage:
  abg pairs                          # alias for \`abg pairs ls\`
  abg pairs ls                       # list all pairs (live + registry-only)
  abg pairs rm NAME [--forget] [--force]
                                     # destroy a pair (and optionally remove
                                     # its registry entry)

Flags:
  --forget   Remove the registry entry so a future \`ensure_pair\` re-allocates
             from scratch (use after PAIR_PORTS_BUSY to release stale ports).
  --force    Tear down the pair even if it has a paired Claude. Without
             --force, paired-live pairs return PAIR_BUSY_NOT_FORCED.
`.trim());
}

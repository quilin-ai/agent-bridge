/**
 * `abg budget` — show the budget coordination snapshot for a pair's daemon.
 *
 * Reads DaemonStatus.budget via the daemon's /healthz endpoint (same payload the
 * get_budget MCP tool renders, via the shared renderer — plan v2.2 requires the
 * two surfaces to stay consistent).
 */

import { applyPairEnv, parsePairFlag } from "../pair-resolver";
import type { DaemonStatus } from "../control-protocol";
import { renderBudgetSnapshot, BUDGET_UNAVAILABLE_TEXT } from "../budget/render";

const STATUS_FETCH_TIMEOUT_MS = 1000;

export async function runBudget(args: string[]) {
  const json = args.includes("--json");
  const { pairFlag } = parsePairFlag(args.filter((arg) => arg !== "--json"));
  const pair = await applyPairEnv({ pairFlag });

  const status = await fetchDaemonStatus(pair.ports.controlPort);
  if (!status) {
    if (json) {
      console.log(JSON.stringify({ ok: false, pairId: pair.pairId, error: "daemon_unreachable" }));
    } else {
      console.error(
        `AgentBridge daemon 未运行（pair ${pair.pairId}，控制端口 ${pair.ports.controlPort}）。` +
          "先运行 `abg claude` 启动会话。",
      );
    }
    process.exit(1);
  }

  if (json) {
    console.log(
      JSON.stringify(
        { ok: true, pairId: status.pairId ?? pair.pairId, budget: status.budget ?? null },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`pair: ${status.pairId ?? pair.pairId}`);
  console.log(status.budget ? renderBudgetSnapshot(status.budget) : BUDGET_UNAVAILABLE_TEXT);
}

async function fetchDaemonStatus(port: number): Promise<DaemonStatus | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STATUS_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: controller.signal });
    if (!response.ok) return null;
    return (await response.json()) as DaemonStatus;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

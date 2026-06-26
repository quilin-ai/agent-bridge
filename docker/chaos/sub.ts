/**
 * Chaos subscriber. Counts UNIQUE task_completed (by idempotencyKey) over the
 * real auto-reconnecting BrokerClient.
 *
 * MODE=drain : connect, subscribe, collect until 2s quiet, print DRAINED, exit.
 * MODE=watch : stay online; heartbeat every 5s; print FINAL on SIGTERM/SIGINT.
 */
import { readFileSync } from "node:fs";
import { BrokerClient } from "../../src/broker-client";

const URL = process.env.BROKER_URL ?? "ws://broker:4700/ws";
const ROOM = process.env.ROOM ?? "chaos-room";
const TOKEN_FILE = process.env.TOKEN_FILE ?? "/data/token-sub";
const MODE = process.env.MODE ?? "watch";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const seen = new Set<string>();
let count = 0;
const client = new BrokerClient({
  url: URL,
  token: readFileSync(TOKEN_FILE, "utf8").trim(),
  presence: { agentType: "claude" },
  log: (m) => console.error(`[sub] ${m}`),
});
client.onEvent((_t, env) => {
  if (env.kind !== "task_completed") return;
  if (seen.has(env.idempotencyKey)) return; // dedup redeliveries
  seen.add(env.idempotencyKey);
  count++;
});
await client.connect();
client.subscribe(ROOM);
console.log(`[sub] online (mode=${MODE})`);

if (MODE === "drain") {
  let last = -1;
  let quiet = 0;
  while (quiet < 2000) {
    await sleep(250);
    if (count !== last) {
      last = count;
      quiet = 0;
    } else {
      quiet += 250;
    }
  }
  console.log(`[sub] DRAINED unique=${count}`);
  client.close();
  process.exit(0);
} else {
  const beat = setInterval(() => console.log(`[sub] HEARTBEAT unique=${count} connected=${client.connected}`), 5000);
  const done = (sig: string) => {
    clearInterval(beat);
    console.log(`[sub] FINAL unique=${count} (${sig})`);
    client.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => done("SIGTERM"));
  process.on("SIGINT", () => done("SIGINT"));
}

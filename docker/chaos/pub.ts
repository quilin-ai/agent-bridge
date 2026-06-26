/**
 * Chaos publisher / load generator. Opens CONN parallel BrokerClient connections
 * (one identity, many sessions) and each publishes COUNT task_completed events
 * with distinct idempotencyKeys, then exits.
 *
 * CONN     parallel connections (default 1)
 * COUNT    events per connection (default 100)
 * DELIVERY store_if_offline (default) | online_only
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { BrokerClient } from "../../src/broker-client";
import type { Envelope } from "../../src/backbone/envelope";

const URL = process.env.BROKER_URL ?? "ws://broker:4700/ws";
const ROOM = process.env.ROOM ?? "chaos-room";
const TOKEN_FILE = process.env.TOKEN_FILE ?? "/data/token-pub";
const CONN = parseInt(process.env.CONN ?? "1", 10);
const COUNT = parseInt(process.env.COUNT ?? "100", 10);
const DELIVERY = (process.env.DELIVERY ?? "store_if_offline") as "store_if_offline" | "online_only";

const token = readFileSync(TOKEN_FILE, "utf8").trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();

const clients: BrokerClient[] = [];
for (let i = 0; i < CONN; i++) {
  const c = new BrokerClient({ url: URL, token, log: () => {} });
  await c.connect();
  clients.push(c);
}

function ev(label: string): Envelope {
  return {
    roomId: ROOM,
    messageId: randomUUID(),
    traceId: randomUUID(),
    idempotencyKey: randomUUID(),
    from: { agentId: "pub@chaos", agentType: "claude" },
    kind: "task_completed",
    payload: { summary: label },
    timestamp: Date.now(),
    deliveryMode: DELIVERY,
  };
}

let total = 0;
await Promise.all(
  clients.map(async (c, ci) => {
    for (let j = 0; j < COUNT; j++) {
      c.publish(ROOM, ev(`load c${ci} #${j}`));
      total++;
    }
  }),
);
await sleep(1500); // let frames flush before closing
const ms = Date.now() - t0;
console.log(`[pub] PUBLISHED total=${total} (conn=${CONN} x count=${COUNT}) delivery=${DELIVERY} in ${ms}ms (${Math.round((total / ms) * 1000)}/s)`);
for (const c of clients) c.close();
process.exit(0);

/**
 * Simulated agent client (one per container = one "machine"). Authenticates by
 * PSK over the broker WS, then either subscribes-and-waits or publishes.
 *
 * ROLE=subscriber: subscribe to TOPIC, wait for one event, print SIM_OK, exit 0.
 * ROLE=publisher : wait for the subscriber, publish a few task_completed events.
 */
import { readFileSync } from "node:fs";

const url = process.env.BROKER_URL ?? "ws://broker:4700/ws";
const role = process.env.ROLE ?? "subscriber";
const topic = process.env.TOPIC ?? "demo";
const token = (process.env.TOKEN ?? readFileSync(process.env.TOKEN_FILE ?? "/data/token", "utf8")).trim();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ws = new WebSocket(url);
const inbox: any[] = [];
const waiters: ((m: any) => void)[] = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data as string);
  const w = waiters.shift();
  if (w) w(m);
  else inbox.push(m);
};
function next(): Promise<any> {
  const m = inbox.shift();
  if (m !== undefined) return Promise.resolve(m);
  return new Promise((r) => waiters.push(r));
}
const send = (m: unknown) => ws.send(JSON.stringify(m));

await new Promise<void>((res, rej) => {
  ws.onopen = () => res();
  ws.onerror = () => rej(new Error("connect failed"));
});

send({ type: "hello", token });
const welcome = await next();
if (welcome.type !== "welcome") {
  console.error(`[${role}] AUTH FAILED:`, welcome);
  process.exit(1);
}
console.log(`[${role}] authenticated as ${welcome.identity.id}`);

if (role === "subscriber") {
  send({ type: "subscribe", topic });
  await next(); // subscribed ack
  console.log(`[subscriber] subscribed to "${topic}", awaiting event...`);
  const ev = await next();
  console.log(`[subscriber] RECEIVED:`, JSON.stringify(ev));
  if (ev.type === "event" && ev.envelope?.from?.agentId) {
    console.log("SIM_OK");
    process.exit(0);
  }
  console.error("[subscriber] unexpected message:", ev);
  process.exit(1);
} else {
  await sleep(5000); // give the subscriber container time to subscribe
  for (let i = 0; i < 3; i++) {
    send({
      type: "publish",
      topic,
      envelope: {
        roomId: topic,
        messageId: `m${i}`,
        traceId: "trace-sim",
        idempotencyKey: `k${i}`,
        from: { agentId: "sim-publisher", agentType: "claude" },
        kind: "task_completed",
        timestamp: Date.now(),
        deliveryMode: "store_if_offline",
        payload: { summary: "hello from the publisher container" },
      },
    });
    await sleep(1000);
  }
  console.log("[publisher] published 3 events");
  process.exit(0);
}

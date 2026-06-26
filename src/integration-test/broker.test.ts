import { describe, test, expect } from "bun:test";
import { Broker } from "../broker";
import { InMemoryStore } from "../backbone/store/memory-store";
import { IdentityService } from "../backbone/identity-service";
import { StorePskIdentityProvider } from "../backbone/identity/store-psk-identity-provider";

/** Minimal buffering WS client so no inbound message is lost between awaits. */
class WsClient {
  ws!: WebSocket;
  private queue: any[] = [];
  private waiters: ((m: any) => void)[] = [];
  private closed?: { code: number; reason: string };
  private closeWaiters: ((c: { code: number; reason: string }) => void)[] = [];

  static async connect(url: string): Promise<WsClient> {
    const c = new WsClient();
    c.ws = new WebSocket(url);
    c.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data as string);
      const w = c.waiters.shift();
      if (w) w(m);
      else c.queue.push(m);
    };
    c.ws.onclose = (ev) => {
      c.closed = { code: ev.code, reason: ev.reason };
      for (const w of c.closeWaiters) w(c.closed);
      c.closeWaiters = [];
    };
    await new Promise<void>((res, rej) => {
      c.ws.onopen = () => res();
      c.ws.onerror = () => rej(new Error("ws connect failed"));
    });
    return c;
  }

  next(): Promise<any> {
    const m = this.queue.shift();
    if (m !== undefined) return Promise.resolve(m);
    return new Promise((res) => this.waiters.push(res));
  }

  waitClose(): Promise<{ code: number; reason: string }> {
    if (this.closed) return Promise.resolve(this.closed);
    return new Promise((res) => this.closeWaiters.push(res));
  }

  send(m: unknown) {
    this.ws.send(JSON.stringify(m));
  }
  close() {
    this.ws.close();
  }
}

async function startBroker() {
  const store = new InMemoryStore();
  const svc = new IdentityService(store);
  await svc.registerIdentity("alice@x.com", "Alice");
  await svc.registerIdentity("bob@x.com", "Bob");
  const token = await svc.issueToken("alice@x.com");
  const tokenB = await svc.issueToken("bob@x.com");
  const broker = new Broker({
    store,
    identityProvider: new StorePskIdentityProvider(store),
    host: "127.0.0.1",
    port: 0, // random free port
    log: () => {},
  });
  const { port } = broker.start();
  return { broker, store, token, tokenB, url: `ws://127.0.0.1:${port}/ws` };
}

describe("Broker — WSS + PSK auth + transport fan-out", () => {
  test("a valid PSK token authenticates; an invalid one is rejected and closed", async () => {
    const { broker, store, token, url } = await startBroker();
    try {
      const ok = await WsClient.connect(url);
      ok.send({ type: "hello", token });
      expect(await ok.next()).toEqual({
        type: "welcome",
        identity: { id: "alice@x.com", displayName: "Alice" },
      });

      const bad = await WsClient.connect(url);
      bad.send({ type: "hello", token: "not-a-real-token" });
      expect(await bad.next()).toMatchObject({ type: "auth_error" });
      expect((await bad.waitClose()).code).toBe(4401);

      ok.close();
    } finally {
      broker.stop();
      await store.close();
    }
  });

  test("publish fans out the envelope to a (different-identity) subscriber", async () => {
    const { broker, store, token, tokenB, url } = await startBroker();
    try {
      const pub = await WsClient.connect(url);
      pub.send({ type: "hello", token }); // alice publishes
      await pub.next(); // welcome

      const sub = await WsClient.connect(url);
      sub.send({ type: "hello", token: tokenB }); // bob subscribes
      await sub.next(); // welcome
      sub.send({ type: "subscribe", topic: "room-1" });
      expect(await sub.next()).toEqual({ type: "subscribed", topic: "room-1" });

      const envelope = {
        roomId: "room-1",
        messageId: "e1",
        traceId: "t1",
        idempotencyKey: "k1",
        from: { agentId: "ag-1", agentType: "claude" },
        kind: "task_completed",
        timestamp: 1,
        deliveryMode: "store_if_offline" as const,
      };
      pub.send({ type: "publish", topic: "room-1", envelope });

      const ev = await sub.next();
      expect(ev).toMatchObject({ type: "event", topic: "room-1", envelope: { messageId: "e1" } });

      pub.close();
      sub.close();
    } finally {
      broker.stop();
      await store.close();
    }
  });

  test("a non-hello message before auth is rejected", async () => {
    const { broker, store, url } = await startBroker();
    try {
      const c = await WsClient.connect(url);
      c.send({ type: "subscribe", topic: "x" });
      expect(await c.next()).toMatchObject({ type: "error" });
      c.close();
    } finally {
      broker.stop();
      await store.close();
    }
  });

  test("malformed-but-valid JSON (null / number) is rejected, never crashes the handler", async () => {
    const { broker, store, url } = await startBroker();
    try {
      const c = await WsClient.connect(url);
      c.ws.send("null"); // valid JSON, not a tagged object → would throw on .type access
      expect(await c.next()).toMatchObject({ type: "error" });
      c.ws.send("42");
      expect(await c.next()).toMatchObject({ type: "error" });
      // still responsive after malformed input (handler did not die)
      c.send({ type: "subscribe", topic: "x" });
      expect(await c.next()).toMatchObject({ type: "error" });
      c.close();
    } finally {
      broker.stop();
      await store.close();
    }
  });
});

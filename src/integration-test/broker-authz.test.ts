import { describe, test, expect, afterEach } from "bun:test";
import { Broker } from "../broker";
import { InMemoryStore } from "../backbone/store/memory-store";
import { IdentityService } from "../backbone/identity-service";
import { StorePskIdentityProvider } from "../backbone/identity/store-psk-identity-provider";

const ROOM = "secret-room";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Minimal buffering WS client. */
class WsClient {
  ws!: WebSocket;
  private q: any[] = [];
  private waiters: ((m: any) => void)[] = [];
  static async connect(url: string): Promise<WsClient> {
    const c = new WsClient();
    c.ws = new WebSocket(url);
    c.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data as string);
      const w = c.waiters.shift();
      if (w) w(m);
      else c.q.push(m);
    };
    await new Promise<void>((res, rej) => {
      c.ws.onopen = () => res();
      c.ws.onerror = () => rej(new Error("connect failed"));
    });
    return c;
  }
  next(): Promise<any> {
    const m = this.q.shift();
    if (m !== undefined) return Promise.resolve(m);
    return new Promise((r) => this.waiters.push(r));
  }
  drainNow(): any[] {
    const all = this.q;
    this.q = [];
    return all;
  }
  send(m: unknown) {
    this.ws.send(JSON.stringify(m));
  }
  close() {
    this.ws.close();
  }
}

/** alice is a MEMBER of ROOM; mallory authenticates (valid PSK) but is NOT a member. */
async function start() {
  const store = new InMemoryStore();
  const svc = new IdentityService(store);
  await svc.registerIdentity("alice@x.com", "Alice");
  await svc.registerIdentity("mallory@x.com", "Mallory");
  const alice = await svc.issueToken("alice@x.com");
  const mallory = await svc.issueToken("mallory@x.com");
  await store.addMember(ROOM, "alice@x.com"); // only alice is a member
  const broker = new Broker({ store, identityProvider: new StorePskIdentityProvider(store), host: "127.0.0.1", port: 0, log: () => {} });
  const { port } = broker.start();
  return { broker, store, alice, mallory, url: `ws://127.0.0.1:${port}/ws` };
}

function envelope(roomId: string) {
  return {
    roomId,
    messageId: "m1",
    traceId: "t1",
    idempotencyKey: "k1",
    from: { agentId: "x", agentType: "claude" },
    kind: "task_completed",
    payload: { summary: "malicious payload" },
    timestamp: 1,
    deliveryMode: "store_if_offline",
  };
}

describe("Broker room authorization (§11.2) — closed by default", () => {
  let stop: (() => void) | undefined;
  afterEach(() => {
    stop?.();
    stop = undefined;
  });

  test("an authenticated NON-member is denied subscribe", async () => {
    const { broker, mallory, url } = await start();
    stop = () => broker.stop();
    const c = await WsClient.connect(url);
    c.send({ type: "hello", token: mallory });
    expect(await c.next()).toMatchObject({ type: "welcome", identity: { id: "mallory@x.com" } }); // PSK auth ok
    c.send({ type: "subscribe", topic: ROOM });
    expect(await c.next()).toMatchObject({ type: "error", reason: "not a room member" }); // but no room access
    c.close();
  });

  test("an authenticated NON-member is denied publish; members never receive it", async () => {
    const { broker, alice, mallory, url } = await start();
    stop = () => broker.stop();
    // alice (member) subscribes and listens.
    const a = await WsClient.connect(url);
    a.send({ type: "hello", token: alice });
    await a.next(); // welcome
    a.send({ type: "subscribe", topic: ROOM });
    await a.next(); // subscribed
    await sleep(30);

    // mallory (non-member) tries to inject an event into the room.
    const m = await WsClient.connect(url);
    m.send({ type: "hello", token: mallory });
    await m.next(); // welcome
    m.send({ type: "publish", topic: ROOM, envelope: envelope(ROOM) });
    expect(await m.next()).toMatchObject({ type: "error", reason: "not a room member" });

    await sleep(60);
    expect(a.drainNow()).toEqual([]); // alice received NOTHING — mallory's event never reached the room
    a.close();
    m.close();
  });

  test("a member subscribes + publishes normally", async () => {
    const { broker, alice, url } = await start();
    stop = () => broker.stop();
    const a = await WsClient.connect(url);
    a.send({ type: "hello", token: alice });
    await a.next();
    a.send({ type: "subscribe", topic: ROOM });
    expect(await a.next()).toMatchObject({ type: "subscribed", topic: ROOM });
    a.close();
  });
});

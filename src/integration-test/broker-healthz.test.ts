import { describe, test, expect, afterEach } from "bun:test";
import { Broker } from "../broker";
import { InMemoryStore } from "../backbone/store/memory-store";
import { IdentityService } from "../backbone/identity-service";
import { StorePskIdentityProvider } from "../backbone/identity/store-psk-identity-provider";

describe("Broker /healthz — liveness probe (§8.2 watchdog)", () => {
  let stop: (() => void) | undefined;
  afterEach(() => {
    stop?.();
    stop = undefined;
  });

  async function start() {
    const store = new InMemoryStore();
    const svc = new IdentityService(store);
    await svc.registerIdentity("alice@x.com", "Alice");
    const token = await svc.issueToken("alice@x.com");
    const broker = new Broker({ store, identityProvider: new StorePskIdentityProvider(store), host: "127.0.0.1", port: 0, log: () => {} });
    const { port } = broker.start();
    stop = () => broker.stop();
    return { port, token, base: `http://127.0.0.1:${port}` };
  }

  test("GET /healthz returns 200 + a minimal non-sensitive JSON body", async () => {
    const { base, token } = await start();
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.pid).toBe("number");
    expect(typeof body.uptimeMs).toBe("number");
    expect(body.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(body.connections).toBe(0); // no ws connected yet
    // must NOT leak secrets/PII
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(token);
    expect(raw).not.toContain("alice@x.com");
  });

  test("connections reflects a live ws and drops when it closes", async () => {
    const { base, port, token } = await start();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((res, rej) => {
      ws.onopen = () => res();
      ws.onerror = () => rej(new Error("ws failed"));
    });
    await new Promise((r) => setTimeout(r, 30));
    expect((await (await fetch(`${base}/healthz`)).json()).connections).toBe(1);
    ws.close();
    await new Promise((r) => setTimeout(r, 60));
    expect((await (await fetch(`${base}/healthz`)).json()).connections).toBe(0);
  });
});

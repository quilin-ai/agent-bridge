import type { ServerWebSocket } from "bun";
import type { Store } from "./backbone/store";
import type { Identity, IdentityProvider } from "./backbone/identity";
import type { MessageTransport } from "./backbone/transport";
import type { Envelope } from "./backbone/envelope";
import { InProcTransport } from "./backbone/transport/inproc-transport";

export const DEFAULT_BROKER_PORT = 4700; // outside the multi-pair 4500/4501/4502+stride range
const CLOSE_AUTH_FAILED = 4401;

interface BrokerSocketData {
  connId: number;
  identity?: Identity;
  /** topic → unsubscribe handle for this connection's subscriptions. */
  subs: Map<string, () => void>;
}

type ClientMessage =
  | { type: "hello"; token: string }
  | { type: "subscribe"; topic: string }
  | { type: "unsubscribe"; topic: string }
  | { type: "publish"; topic: string; envelope: Envelope };

export interface BrokerOptions {
  store: Store;
  identityProvider: IdentityProvider;
  /** Bind host. Default 127.0.0.1; for Tailscale bind the 100.x address (never 0.0.0.0, §7.3). */
  host?: string;
  /** Bind port. Default {@link DEFAULT_BROKER_PORT}; 0 picks a random free port. */
  port?: number;
  transport?: MessageTransport;
  log?: (msg: string) => void;
}

/**
 * The always-on, multi-tenant control-plane event broker (§11.1).
 *
 * A WSS endpoint that authenticates every connection by PSK (IdentityProvider),
 * then routes Envelopes between authenticated clients via a MessageTransport
 * (in-process bus + WSS fan-out, §6.2). **CONTROL PLANE ONLY**: it accepts and
 * forwards Envelopes (structured signals) and NEVER reads/writes repo files —
 * code sync is git's job (§2.6). It is a SEPARATE process from the per-pair
 * daemon (independent failure domain) and binds a CONFIGURABLE host (default
 * loopback; Tailscale uses the 100.x address, never 0.0.0.0 — §7.3).
 *
 * Loop prevention / dedup (traceId/hop) and three-tier routing (broadcast /
 * @mention / DM) are layered on top in a later PR; this PR is plain topic fan-out.
 */
export class Broker {
  private server: ReturnType<typeof Bun.serve> | null = null;
  private nextConnId = 0;
  private readonly transport: MessageTransport;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: BrokerOptions) {
    this.log = opts.log ?? (() => {});
    this.transport =
      opts.transport ??
      new InProcTransport({ onHandlerError: (e) => this.log(`subscriber handler error: ${String(e)}`) });
  }

  /** Start listening. Returns the bound { host, port } (port resolved if 0 was given). */
  start(): { host: string; port: number } {
    // `||` not `??`: a programmatically-passed empty string must fall back to
    // loopback rather than become an all-interfaces bind (`Bun.serve({hostname:""})`).
    const host = this.opts.host || "127.0.0.1";
    const port = this.opts.port ?? DEFAULT_BROKER_PORT;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const server = Bun.serve<BrokerSocketData>({
      hostname: host,
      port,
      fetch(req, server) {
        if (new URL(req.url).pathname === "/ws") {
          if (server.upgrade(req, { data: { connId: ++self.nextConnId, subs: new Map() } })) {
            return undefined;
          }
        }
        return new Response("AgentBridge broker");
      },
      websocket: {
        message(ws, raw) {
          // Catch any unexpected rejection so a bad message can never become an
          // unhandled promise rejection that takes the process down.
          self.handleMessage(ws, typeof raw === "string" ? raw : raw.toString()).catch((e) => {
            self.log(`message handler error (#${ws.data.connId}): ${String(e)}`);
          });
        },
        close(ws) {
          for (const unsub of ws.data.subs.values()) unsub();
          ws.data.subs.clear();
          self.log(`conn #${ws.data.connId} closed`);
        },
      },
    });
    this.server = server;
    this.log(`broker listening on ${host}:${server.port}`);
    return { host, port: server.port ?? port };
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
  }

  private send(ws: ServerWebSocket<BrokerSocketData>, msg: unknown): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch (e) {
      this.log(`send failed (#${ws.data.connId}): ${String(e)}`);
    }
  }

  private async handleMessage(ws: ServerWebSocket<BrokerSocketData>, raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.send(ws, { type: "error", reason: "invalid JSON" });
      return;
    }
    // Valid JSON that isn't a tagged object (null / number / string / array)
    // must not reach `.type` access — that would throw out of this async handler
    // and become an unhandled rejection. Reject it as malformed.
    if (typeof parsed !== "object" || parsed === null || typeof (parsed as { type?: unknown }).type !== "string") {
      this.send(ws, { type: "error", reason: "malformed message" });
      return;
    }
    const msg = parsed as ClientMessage;

    if (msg.type === "hello") {
      try {
        const identity = await this.opts.identityProvider.authenticate(msg.token);
        ws.data.identity = identity;
        this.send(ws, { type: "welcome", identity });
        this.log(`conn #${ws.data.connId} authenticated as ${identity.id}`);
      } catch {
        // Never echo the presented token or the underlying reason.
        this.send(ws, { type: "auth_error", reason: "invalid token" });
        ws.close(CLOSE_AUTH_FAILED, "auth failed");
      }
      return;
    }

    // Every non-hello message requires a prior successful hello.
    if (!ws.data.identity) {
      this.send(ws, { type: "error", reason: "not authenticated (send hello first)" });
      return;
    }

    switch (msg.type) {
      case "subscribe": {
        if (ws.data.subs.has(msg.topic)) return; // idempotent
        const topic = msg.topic;
        const unsub = this.transport.subscribe(topic, (envelope) => {
          this.send(ws, { type: "event", topic, envelope });
        });
        ws.data.subs.set(topic, unsub);
        this.send(ws, { type: "subscribed", topic }); // ack: safe to publish now
        return;
      }
      case "unsubscribe": {
        const unsub = ws.data.subs.get(msg.topic);
        if (unsub) {
          unsub();
          ws.data.subs.delete(msg.topic);
        }
        return;
      }
      case "publish": {
        // CONTROL PLANE ONLY: forward the structured Envelope. No filesystem,
        // no repo access — code sync is git's job (§2.6).
        await this.transport.publish(msg.topic, msg.envelope);
        return;
      }
      default: {
        this.send(ws, { type: "error", reason: "unknown message type" });
      }
    }
  }
}

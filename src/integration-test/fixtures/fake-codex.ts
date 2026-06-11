#!/usr/bin/env bun
/**
 * Single parameterized fake `codex app-server` for integration tests.
 *
 * Before this fixture, every integration test that needed a stand-in for the
 * real `codex app-server` carried its own inline template-string program. Those
 * copies drifted: one answered `thread/start`, another did not; the interrupt
 * delay switch lived in only one. This file collapses all of them into ONE real
 * TypeScript program (type-checked by `tsc --noEmit`, no `eval`'d strings),
 * gated by capability tier so each call site asks for exactly the protocol
 * surface it exercises.
 *
 * The daemon launches the codex binary as `codex app-server --listen ws://…`
 * by resolving `codex` on PATH. Tests therefore drop an executable `bin/codex`
 * that re-execs this file (see `installFakeCodex` in ./fake-codex-install.ts).
 *
 * ── Capability tiers ───────────────────────────────────────────────────────
 *  - "minimal":        healthz/readyz + WS accept + clean SIGTERM. Nothing
 *                      more — the daemon only needs the app-server to be
 *                      reachable and to die cleanly (e2e-reconnect lifecycle).
 *  - "handshake":      minimal + auto-respond to `thread/start` so the adapter
 *                      can set an active thread and reach "ready".
 *  - "command-driven": handshake + the full turn protocol the daemon-wiring
 *                      tests drive: turn/start (+ optional log), turn/interrupt
 *                      (+ optional log, + FAKE_APP_INTERRUPT_DELAY_MS deferral),
 *                      turn/steer (+ optional log, error markers), plus a
 *                      command-file injection loop (start-turn / complete-turn /
 *                      agent-message:<text> / close-app-server).
 *
 * Each higher tier is a strict superset of the lower one, so a call site can
 * always pick the LEAST capable tier that still passes — keeping the contract
 * each test depends on explicit.
 *
 * Tier + injection wiring are read from the environment so the single program
 * stays parameterized at runtime:
 *  - FAKE_CODEX_CAPABILITY      "minimal" | "handshake" | "command-driven"
 *                               (default "minimal")
 *  - FAKE_APP_COMMAND_FILE      path polled for injection commands (command-driven)
 *  - FAKE_APP_TURNSTART_LOG     append turn/start params (command-driven)
 *  - FAKE_APP_TURNINTERRUPT_LOG append turn/interrupt params (command-driven)
 *  - FAKE_APP_TURNSTEER_LOG     append turn/steer params (command-driven)
 *  - FAKE_APP_INTERRUPT_DELAY_MS defer the interrupt terminal boundary (command-driven)
 */

import { appendFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";

export type FakeCodexCapability = "minimal" | "handshake" | "command-driven";

const CAPABILITIES: readonly FakeCodexCapability[] = ["minimal", "handshake", "command-driven"] as const;

function parseCapability(raw: string | undefined): FakeCodexCapability {
  if (raw && (CAPABILITIES as readonly string[]).includes(raw)) {
    return raw as FakeCodexCapability;
  }
  return "minimal";
}

/** Tier ordering for superset checks: command-driven ⊇ handshake ⊇ minimal. */
function capabilityRank(capability: FakeCodexCapability): number {
  return CAPABILITIES.indexOf(capability);
}

function hasAtLeast(active: FakeCodexCapability, required: FakeCodexCapability): boolean {
  return capabilityRank(active) >= capabilityRank(required);
}

function main(): void {
  if (process.argv.includes("--version")) {
    console.log("codex fake");
    process.exit(0);
  }

  // Any non-`app-server` invocation (e.g. a stray `codex --enable …`) just idles
  // then exits — the real binary would block on its own subcommand. Matches the
  // legacy inline behavior so PATH lookups that aren't app-server don't crash.
  if (process.argv[2] !== "app-server") {
    void Bun.sleep(60_000).then(() => process.exit(0));
    return;
  }

  const capability = parseCapability(process.env.FAKE_CODEX_CAPABILITY);

  const listenIndex = process.argv.indexOf("--listen");
  const listen = process.argv[listenIndex + 1];
  if (!listen) {
    console.error("fake codex app-server: missing --listen <url>");
    process.exit(1);
  }
  const port = Number(new URL(listen).port);

  const commandFile = process.env.FAKE_APP_COMMAND_FILE;
  const turnStartLog = process.env.FAKE_APP_TURNSTART_LOG;
  const turnInterruptLog = process.env.FAKE_APP_TURNINTERRUPT_LOG;
  const turnSteerLog = process.env.FAKE_APP_TURNSTEER_LOG;
  const interruptDelayMs = Number(process.env.FAKE_APP_INTERRUPT_DELAY_MS || 0);

  // Single live app-server WS — the daemon keeps ONE persistent connection.
  let appWs: import("bun").ServerWebSocket<unknown> | null = null;
  let lastStartedTurnId: string | null = null;
  let turnStartCounter = 0;
  let agentMessageCounter = 0;

  const handshakeEnabled = hasAtLeast(capability, "handshake");
  const turnProtocolEnabled = hasAtLeast(capability, "command-driven");

  function handleMessage(ws: import("bun").ServerWebSocket<unknown>, raw: string | Buffer): void {
    let msg: {
      id?: unknown;
      method?: unknown;
      params?: { turnId?: string; expectedTurnId?: unknown; input?: Array<{ text?: string }> };
    };
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
    } catch {
      return;
    }

    // handshake: auto-respond to thread/start so the adapter can detect an
    // active thread and emit "ready" (used by budget/ready-gate tests).
    if (handshakeEnabled && msg.method === "thread/start") {
      ws.send(JSON.stringify({ id: msg.id, result: { thread: { id: "thread-fake-1" } } }));
      return;
    }

    if (!turnProtocolEnabled) return;

    // Record received turn/start params (tier-override assertions), then respond
    // success with the created turn id like the real app-server
    // (TurnStartResponse.turn.id) so the bridge's turn_started ACK correlation
    // can be asserted end-to-end. NOTE: deliberately NO turn/started notification
    // here — emitting one would mark the adapter busy and break the multi-injection
    // budget tests; the "start-turn" command drives the busy state explicitly.
    if (msg.method === "turn/start") {
      if (turnStartLog) {
        appendFileSync(turnStartLog, JSON.stringify(msg.params) + "\n");
      }
      turnStartCounter += 1;
      ws.send(JSON.stringify({ id: msg.id, result: { turn: { id: "turn-injected-" + turnStartCounter } } }));
      return;
    }

    // turn/interrupt: record params, respond success ({}), then emit the terminal
    // turn/completed for that turnId — mirroring the REAL app-server (verified in
    // codex-rs): the success response is deferred until TurnAborted and the
    // interrupted turn's terminal notification is a normal turn/completed with
    // status "interrupted".
    if (msg.method === "turn/interrupt") {
      if (turnInterruptLog) {
        appendFileSync(turnInterruptLog, JSON.stringify(msg.params) + "\n");
      }
      const turnId = msg.params?.turnId;
      // Harness-only switch (TOCTOU test): defer the terminal boundary so the
      // daemon's waitForInterruptOutcome await stays open long enough for the
      // originating control socket to detach and another to attach mid-wait. Real
      // app-server defers the success response until TurnAborted, so deferring
      // BOTH the {} response and the terminal turn/completed faithfully models a
      // slow interrupt.
      const emitInterruptTerminal = () => {
        ws.send(JSON.stringify({ id: msg.id, result: {} }));
        ws.send(JSON.stringify({ method: "turn/completed", params: { turn: { id: turnId, status: "interrupted" } } }));
        if (lastStartedTurnId === turnId) lastStartedTurnId = null;
      };
      if (interruptDelayMs > 0) {
        setTimeout(emitInterruptTerminal, interruptDelayMs);
      } else {
        emitInterruptTerminal();
      }
      return;
    }

    // turn/steer: record params, then ack — or reject when the text carries the
    // [force-steer-error] marker (drives the steerFailed wiring test). Strict
    // emulation of the real app-server (expectedTurnId has been REQUIRED since
    // turn/steer was introduced — live-E2E regression: B0 shipped without the
    // field and every steer bounced): missing field → serde-style error; wrong
    // value → ExpectedTurnMismatch-style error.
    if (msg.method === "turn/steer") {
      if (turnSteerLog) {
        appendFileSync(turnSteerLog, JSON.stringify(msg.params) + "\n");
      }
      const steerText = msg.params?.input?.[0]?.text ?? "";
      const expectedTurnId = msg.params?.expectedTurnId;
      if (typeof expectedTurnId !== "string" || expectedTurnId.length === 0) {
        ws.send(JSON.stringify({ id: msg.id, error: { message: "Invalid request: missing field `expectedTurnId`" } }));
      } else if (lastStartedTurnId && expectedTurnId !== lastStartedTurnId) {
        ws.send(JSON.stringify({ id: msg.id, error: { message: "expected active turn id `" + expectedTurnId + "` but found `" + lastStartedTurnId + "`" } }));
      } else if (steerText.includes("[hang-steer]")) {
        // Deliberately send NO verdict — simulate a steer whose app-server
        // response is lost while the WS stays open (drives the PR B #3
        // lost-response orphan test: turnTrackingReset must clean it up).
      } else if (steerText.includes("[force-steer-error]")) {
        ws.send(JSON.stringify({ id: msg.id, error: { message: "ActiveTurnNotSteerable" } }));
      } else {
        ws.send(JSON.stringify({ id: msg.id, result: { turnId: expectedTurnId } }));
      }
    }
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(req, serverInstance) {
      const url = new URL(req.url);
      if (url.pathname === "/healthz" || url.pathname === "/readyz") {
        return Response.json({ ok: true });
      }
      if (serverInstance.upgrade(req)) return undefined;
      return new Response("fake codex app-server");
    },
    websocket: {
      open(ws) {
        appWs = ws;
      },
      message(ws, raw) {
        handleMessage(ws, raw);
      },
      close(ws) {
        if (appWs === ws) appWs = null;
      },
    },
  });

  // command-driven injection loop: poll a file the test writes injection commands
  // into, and drive the corresponding app-server notifications.
  if (turnProtocolEnabled && commandFile) {
    setInterval(() => {
      if (!existsSync(commandFile)) return;
      const command = readFileSync(commandFile, "utf-8").trim();
      try {
        unlinkSync(commandFile);
      } catch {}
      const ws = appWs;
      if (!ws) return;
      if (command === "start-turn") {
        lastStartedTurnId = "turn-1";
        ws.send(JSON.stringify({ method: "turn/started", params: { turn: { id: "turn-1" } } }));
      }
      if (command === "complete-turn" && lastStartedTurnId) {
        ws.send(JSON.stringify({ method: "turn/completed", params: { turn: { id: lastStartedTurnId } } }));
        lastStartedTurnId = null;
      }
      if (command.startsWith("agent-message:")) {
        const content = command.slice("agent-message:".length);
        const id = "agent-message-" + (++agentMessageCounter);
        ws.send(JSON.stringify({ method: "item/started", params: { item: { id, type: "agentMessage" } } }));
        ws.send(JSON.stringify({ method: "item/agentMessage/delta", params: { itemId: id, delta: content } }));
        ws.send(JSON.stringify({ method: "item/completed", params: { item: { id, type: "agentMessage" } } }));
      }
      if (command === "close-app-server") {
        ws.close(1011, "test app-server close");
        setTimeout(() => server.stop(true), 20);
      }
    }, 25).unref();
  }

  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
}

main();

// Keep the process alive for the `app-server` path; --version / non-app-server
// paths have already exited (or scheduled their own exit) inside main().
if (process.argv[2] === "app-server") {
  await new Promise(() => {});
}

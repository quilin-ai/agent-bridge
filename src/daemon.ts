#!/usr/bin/env bun

/**
 * AgentBridge daemon — multi-Claude variant.
 *
 * Each attached Claude session gets:
 *   - A `chatId` (sent by the MCP at `claude_connect` time).
 *   - A dedicated `ClaudeThread` (own WebSocket to codex app-server, own
 *     codex thread). Turns on different threads run in parallel — verified
 *     by the concurrency probe under `probes/`.
 *   - Per-chat attention window, statusBuffer, replyRequired, and offline
 *     message buffer.
 *
 * Codex TUI continues to use the existing CodexAdapter proxy with its own
 * thread. TUI activity is NOT cross-broadcast to attached Claudes — every
 * Claude sees only events from its own ClaudeThread. This keeps the two
 * surfaces (TUI = human ↔ Codex, Claude = MCP ↔ Codex) isolated.
 */

import { appendFileSync } from "node:fs";
import type { ServerWebSocket } from "bun";
import { CodexAdapter } from "./codex-adapter";
import { ClaudeThread } from "./claude-thread";
import {
  BRIDGE_CONTRACT_REMINDER,
  REPLY_REQUIRED_INSTRUCTION,
  StatusBuffer,
  classifyMessage,
  type FilterMode,
} from "./message-filter";
import { TuiConnectionState } from "./tui-connection-state";
import { DaemonLifecycle } from "./daemon-lifecycle";
import { StateDirResolver } from "./state-dir";
import { ConfigService } from "./config-service";
import { CLOSE_CODE_REPLACED } from "./control-protocol";
import type { ControlClientMessage, ControlServerMessage, DaemonStatus } from "./control-protocol";
import type { BridgeMessage } from "./types";

interface ControlSocketData {
  clientId: number;
  attached: boolean;
  chatId: string | null;
}

interface ChatState {
  chatId: string;
  ws: ServerWebSocket<ControlSocketData> | null;
  thread: ClaudeThread;
  ready: boolean;

  inAttentionWindow: boolean;
  attentionWindowTimer: ReturnType<typeof setTimeout> | null;
  replyRequired: boolean;
  replyReceivedDuringTurn: boolean;

  bufferedMessages: BridgeMessage[];
  statusBuffer: StatusBuffer;

  disconnectTimer: ReturnType<typeof setTimeout> | null;
  reaperTimer: ReturnType<typeof setTimeout> | null;
  lastAttachStatusSentTs: number;
  onlineNoticeSent: boolean;
  nextSystemMessageId: number;
}

const stateDir = new StateDirResolver();
stateDir.ensure();
const configService = new ConfigService();
const config = configService.loadOrDefault();

const CODEX_APP_PORT = parseInt(process.env.CODEX_WS_PORT ?? String(config.codex.appPort), 10);
const CODEX_PROXY_PORT = parseInt(process.env.CODEX_PROXY_PORT ?? String(config.codex.proxyPort), 10);
const CONTROL_PORT = parseInt(process.env.AGENTBRIDGE_CONTROL_PORT ?? "4502", 10);
const TUI_DISCONNECT_GRACE_MS = parseInt(process.env.TUI_DISCONNECT_GRACE_MS ?? "2500", 10);
const CLAUDE_DISCONNECT_GRACE_MS = 5_000;
const CLAUDE_REAP_AFTER_MS = parseInt(process.env.AGENTBRIDGE_CLAUDE_REAP_MS ?? "600000", 10); // 10 min
const MAX_BUFFERED_MESSAGES = parseInt(process.env.AGENTBRIDGE_MAX_BUFFERED_MESSAGES ?? "100", 10);
const FILTER_MODE: FilterMode =
  (process.env.AGENTBRIDGE_FILTER_MODE as FilterMode) === "full" ? "full" : "filtered";
const IDLE_SHUTDOWN_MS = parseInt(
  process.env.AGENTBRIDGE_IDLE_SHUTDOWN_MS ?? String(config.idleShutdownSeconds * 1000),
  10,
);
const ATTENTION_WINDOW_MS = parseInt(
  process.env.AGENTBRIDGE_ATTENTION_WINDOW_MS ??
    String(config.turnCoordination.attentionWindowSeconds * 1000),
  10,
);

const daemonLifecycle = new DaemonLifecycle({ stateDir, controlPort: CONTROL_PORT, log });

const codex = new CodexAdapter(CODEX_APP_PORT, CODEX_PROXY_PORT, stateDir.logFile);
const attachCmd = `codex --enable tui_app_server --remote ${codex.proxyUrl}`;

let controlServer: ReturnType<typeof Bun.serve> | null = null;
let nextControlClientId = 0;
let codexBootstrapped = false;
let shuttingDown = false;
let idleShutdownTimer: ReturnType<typeof setTimeout> | null = null;

/** chatId → ChatState. Survives WS disconnects (lazy reap, see CLAUDE_REAP_AFTER_MS). */
const chats = new Map<string, ChatState>();

const tuiConnectionState = new TuiConnectionState({
  disconnectGraceMs: TUI_DISCONNECT_GRACE_MS,
  log,
  onDisconnectPersisted: (connId) => {
    broadcastToAllClaudes(
      systemMessage(
        "system_tui_disconnected",
        `⚠️ Codex TUI disconnected (conn #${connId}). Codex is still running in the background — reconnect the TUI to resume.`,
      ),
    );
  },
  onReconnectAfterNotice: (connId) => {
    broadcastToAllClaudes(
      systemMessage(
        "system_tui_reconnected",
        `✅ Codex TUI reconnected (conn #${connId}). Bridge restored.`,
      ),
    );
  },
});

// ── TUI / app-server event wiring ────────────────────────────────
// Codex TUI activity is INTENTIONALLY not cross-broadcast to Claude sessions.
// We only listen for lifecycle events that affect all chats (TUI connected,
// codex ready, codex exit, etc.).

codex.on("ready", (threadId: string) => {
  tuiConnectionState.markBridgeReady();
  log(`Codex TUI thread ready: ${threadId} (bridge fully operational)`);
});

codex.on("tuiConnected", (connId: number) => {
  tuiConnectionState.handleTuiConnected(connId);
  cancelIdleShutdown();
  log(`Codex TUI connected (conn #${connId})`);
  broadcastStatus();
});

codex.on("tuiDisconnected", (connId: number) => {
  tuiConnectionState.handleTuiDisconnected(connId);
  log(`Codex TUI disconnected (conn #${connId})`);
  broadcastStatus();
  scheduleIdleShutdown();
});

codex.on("error", (err: Error) => {
  log(`Codex error: ${err.message}`);
});

codex.on("exit", (code: number | null) => {
  log(`Codex app-server process exited (code ${code})`);
  codexBootstrapped = false;
  tuiConnectionState.handleCodexExit();
  broadcastToAllClaudes(
    systemMessage(
      "system_codex_exit",
      `⚠️ Codex app-server exited (code ${code ?? "unknown"}). All ClaudeThread sessions terminated.`,
    ),
  );
  for (const state of chats.values()) {
    try { state.thread.close(); } catch {}
    state.ready = false;
  }
  broadcastStatus();
});

// ── Control server / Claude WS handling ─────────────────────────

function startControlServer() {
  controlServer = Bun.serve({
    port: CONTROL_PORT,
    hostname: "127.0.0.1",
    fetch(req, server) {
      const url = new URL(req.url);

      if (url.pathname === "/healthz") return Response.json(currentStatus());
      if (url.pathname === "/readyz") {
        return Response.json(currentStatus(), { status: codexBootstrapped ? 200 : 503 });
      }
      if (url.pathname === "/ws" &&
          server.upgrade(req, { data: { clientId: 0, attached: false, chatId: null } })) {
        return undefined;
      }

      return new Response("AgentBridge daemon");
    },
    websocket: {
      idleTimeout: 960,
      sendPings: true,
      open: (ws: ServerWebSocket<ControlSocketData>) => {
        ws.data.clientId = ++nextControlClientId;
        log(`Frontend socket opened (#${ws.data.clientId})`);
      },
      close: (ws: ServerWebSocket<ControlSocketData>, code: number, reason: string) => {
        const chatId = ws.data.chatId;
        log(`Frontend socket closed (#${ws.data.clientId}, code=${code}, reason=${reason || "none"}, chatId=${chatId ?? "-"})`);
        if (chatId) {
          const state = chats.get(chatId);
          if (state && state.ws === ws) {
            detachClaudeWs(state, "frontend socket closed");
          }
        }
      },
      message: (ws: ServerWebSocket<ControlSocketData>, raw) => {
        handleControlMessage(ws, raw);
      },
    },
  });
}

function handleControlMessage(ws: ServerWebSocket<ControlSocketData>, raw: string | Buffer) {
  let message: ControlClientMessage;
  try {
    const text = typeof raw === "string" ? raw : raw.toString();
    message = JSON.parse(text);
  } catch (e: any) {
    log(`Failed to parse control message: ${e.message}`);
    return;
  }

  switch (message.type) {
    case "claude_connect":
      void attachClaude(ws, message.chatId);
      return;
    case "claude_disconnect": {
      const chatId = message.chatId ?? ws.data.chatId;
      if (!chatId) return;
      const state = chats.get(chatId);
      if (state) detachClaudeWs(state, "frontend requested disconnect");
      return;
    }
    case "status":
      sendStatus(ws);
      return;
    case "claude_to_codex":
      handleClaudeToCodex(ws, message);
      return;
  }
}

async function attachClaude(
  ws: ServerWebSocket<ControlSocketData>,
  requestedChatId?: string,
) {
  const chatId = requestedChatId ?? `auto_${ws.data.clientId}_${Date.now()}`;
  ws.data.chatId = chatId;

  let state = chats.get(chatId);
  if (state) {
    // Resume: same chatId reconnecting. If another WS is still bound, replace it.
    if (state.ws && state.ws !== ws && state.ws.readyState !== WebSocket.CLOSED) {
      log(`Replacing prior WS for chatId=${chatId} (#${state.ws.data.clientId} → #${ws.data.clientId})`);
      try { state.ws.close(CLOSE_CODE_REPLACED, "replaced by newer connection for same chatId"); } catch {}
    }
    state.ws = ws;
    ws.data.attached = true;
    clearDisconnectTimer(state, "claude resumed");
    clearReaperTimer(state, "claude resumed");
    cancelIdleShutdown();
    log(`Claude resumed chatId=${chatId} (#${ws.data.clientId})`);
    statusBufferFlushIfPaused(state, "claude resumed");
    flushBufferedMessages(state);
    sendStatus(ws);
    return;
  }

  // New chat: create state + ClaudeThread
  state = createChatState(chatId);
  chats.set(chatId, state);
  state.ws = ws;
  ws.data.attached = true;
  cancelIdleShutdown();
  log(`New Claude session attached: chatId=${chatId} (#${ws.data.clientId}, total=${chats.size})`);

  sendStatus(ws);
  emitToChat(state, systemMessage("system_bridge_provisioning",
    "✅ AgentBridge daemon attached. Provisioning your dedicated Codex thread..."));

  try {
    const threadId = await state.thread.bootstrap();
    state.ready = true;
    log(`ClaudeThread ready: chatId=${chatId} threadId=${threadId}`);
    emitToChat(state, systemMessage("system_thread_ready",
      `✅ Your Codex thread is ready (threadId=${threadId}). You can now send messages via the reply tool.`));
    broadcastStatus();
  } catch (err: any) {
    log(`ClaudeThread bootstrap failed for chatId=${chatId}: ${err?.message ?? err}`);
    emitToChat(state, systemMessage("system_thread_failed",
      `❌ Failed to provision Codex thread: ${err?.message ?? err}. Reconnect to retry.`));
  }
}

function createChatState(chatId: string): ChatState {
  const state: ChatState = {
    chatId,
    ws: null,
    thread: new ClaudeThread({
      appServerUrl: codex.appServerUrl,
      chatId,
      logFile: stateDir.logFile,
      cwd: process.cwd(),
    }),
    ready: false,
    inAttentionWindow: false,
    attentionWindowTimer: null,
    replyRequired: false,
    replyReceivedDuringTurn: false,
    bufferedMessages: [],
    statusBuffer: null as any, // assigned below
    disconnectTimer: null,
    reaperTimer: null,
    lastAttachStatusSentTs: 0,
    onlineNoticeSent: false,
    nextSystemMessageId: 0,
  };
  state.statusBuffer = new StatusBuffer((summary) => emitToChat(state, summary));

  // Wire ClaudeThread events to per-chat routing.
  state.thread.on("agentMessage", (msg: BridgeMessage) => {
    if (msg.source !== "codex") return;
    const result = classifyMessage(msg.content, FILTER_MODE);

    if (state.replyRequired) {
      log(`[${chatId}] Codex → Claude [${result.marker}/force-forward-reply-required] (${msg.content.length} chars)`);
      state.replyReceivedDuringTurn = true;
      if (state.statusBuffer.size > 0) {
        state.statusBuffer.flush("reply-required message arrived");
      }
      emitToChat(state, msg);
      return;
    }

    if (state.inAttentionWindow && result.marker === "status") {
      log(`[${chatId}] Codex → Claude [${result.marker}/buffer-attention] (${msg.content.length} chars)`);
      state.statusBuffer.add(msg);
      return;
    }

    log(`[${chatId}] Codex → Claude [${result.marker}/${result.action}] (${msg.content.length} chars)`);
    switch (result.action) {
      case "forward":
        if (result.marker === "important" && state.statusBuffer.size > 0) {
          state.statusBuffer.flush("important message arrived");
        }
        emitToChat(state, msg);
        if (result.marker === "important") startAttentionWindow(state);
        break;
      case "buffer":
        state.statusBuffer.add(msg);
        break;
      case "drop":
        break;
    }
  });

  state.thread.on("turnStarted", () => {
    log(`[${chatId}] Codex turn started`);
    emitToChat(state, systemMessage(
      "system_turn_started",
      "⏳ Codex is working on the current task. Wait for completion before sending a reply.",
    ));
  });

  state.thread.on("turnCompleted", () => {
    log(`[${chatId}] Codex turn completed`);
    state.statusBuffer.flush("turn completed");

    if (state.replyRequired && !state.replyReceivedDuringTurn) {
      log(`[${chatId}] ⚠️ Reply was required but Codex did not send any agentMessage`);
      emitToChat(state, systemMessage(
        "system_reply_missing",
        "⚠️ Codex completed the turn without sending a reply (require_reply was set).",
      ));
    }
    state.replyRequired = false;
    state.replyReceivedDuringTurn = false;

    emitToChat(state, systemMessage(
      "system_turn_completed",
      "✅ Codex finished the current turn. You can reply now if needed.",
    ));
    startAttentionWindow(state);
  });

  state.thread.on("close", () => {
    log(`[${chatId}] ClaudeThread WS closed`);
    state.ready = false;
  });

  state.thread.on("error", (err: any) => {
    log(`[${chatId}] ClaudeThread error: ${err?.message ?? err}`);
  });

  return state;
}

function detachClaudeWs(state: ChatState, reason: string) {
  if (!state.ws) return;
  log(`Claude WS detached: chatId=${state.chatId} (#${state.ws.data.clientId}, ${reason})`);
  state.ws = null;
  scheduleDisconnectTimer(state);
  scheduleReaperTimer(state);
  scheduleIdleShutdown();
}

function scheduleReaperTimer(state: ChatState) {
  if (state.reaperTimer) clearTimeout(state.reaperTimer);
  state.reaperTimer = setTimeout(() => {
    state.reaperTimer = null;
    if (state.ws) return; // reattached
    log(`Reaping idle chat: chatId=${state.chatId} (no WS for ${CLAUDE_REAP_AFTER_MS}ms)`);
    try { state.thread.close(); } catch {}
    state.statusBuffer.dispose();
    if (state.attentionWindowTimer) clearTimeout(state.attentionWindowTimer);
    chats.delete(state.chatId);
    broadcastStatus();
  }, CLAUDE_REAP_AFTER_MS);
}

function clearReaperTimer(state: ChatState, _reason: string) {
  if (state.reaperTimer) {
    clearTimeout(state.reaperTimer);
    state.reaperTimer = null;
  }
}

function scheduleDisconnectTimer(state: ChatState) {
  if (state.disconnectTimer) clearTimeout(state.disconnectTimer);
  state.disconnectTimer = setTimeout(() => {
    state.disconnectTimer = null;
    // No-op placeholder for future "tell codex this claude went offline" logic.
  }, CLAUDE_DISCONNECT_GRACE_MS);
}

function clearDisconnectTimer(state: ChatState, _reason: string) {
  if (state.disconnectTimer) {
    clearTimeout(state.disconnectTimer);
    state.disconnectTimer = null;
  }
}

function statusBufferFlushIfPaused(state: ChatState, reason: string) {
  if (state.statusBuffer.size > 0) state.statusBuffer.flush(reason);
}

// ── Claude → Codex injection ────────────────────────────────────

function handleClaudeToCodex(
  ws: ServerWebSocket<ControlSocketData>,
  message: Extract<ControlClientMessage, { type: "claude_to_codex" }>,
) {
  const chatId = message.chatId ?? ws.data.chatId;
  if (!chatId) {
    return sendProtocolMessage(ws, {
      type: "claude_to_codex_result",
      requestId: message.requestId,
      success: false,
      error: "No chatId — claude_connect was never sent.",
    });
  }

  const state = chats.get(chatId);
  if (!state) {
    return sendProtocolMessage(ws, {
      type: "claude_to_codex_result",
      requestId: message.requestId,
      success: false,
      error: `Unknown chatId ${chatId}. Reattach via claude_connect.`,
    });
  }

  if (message.message.source !== "claude") {
    return sendProtocolMessage(ws, {
      type: "claude_to_codex_result",
      requestId: message.requestId,
      success: false,
      error: "Invalid message source",
    });
  }

  if (!state.ready) {
    return sendProtocolMessage(ws, {
      type: "claude_to_codex_result",
      requestId: message.requestId,
      success: false,
      error: "Your Codex thread is still provisioning. Wait for system_thread_ready.",
    });
  }

  const requireReply = !!message.requireReply;
  let contentWithReminder = message.message.content + "\n\n" + BRIDGE_CONTRACT_REMINDER;
  if (requireReply) {
    contentWithReminder += REPLY_REQUIRED_INSTRUCTION;
    state.replyRequired = true;
    state.replyReceivedDuringTurn = false;
    log(`[${chatId}] Reply required flag set`);
  }

  log(`[${chatId}] Forwarding Claude → Codex (${message.message.content.length} chars, requireReply=${requireReply})`);
  const injected = state.thread.injectMessage(contentWithReminder);
  if (!injected) {
    const reason = state.thread.isTurnInProgress
      ? "Codex is busy executing a turn on your thread. Wait for it to finish."
      : "Injection failed: thread WS not connected.";
    return sendProtocolMessage(ws, {
      type: "claude_to_codex_result",
      requestId: message.requestId,
      success: false,
      error: reason,
    });
  }
  clearAttentionWindow(state);
  sendProtocolMessage(ws, {
    type: "claude_to_codex_result",
    requestId: message.requestId,
    success: true,
  });
}

// ── Per-chat helpers ────────────────────────────────────────────

function startAttentionWindow(state: ChatState) {
  clearAttentionWindow(state);
  state.inAttentionWindow = true;
  state.statusBuffer.pause();
  log(`[${state.chatId}] Attention window started (${ATTENTION_WINDOW_MS}ms)`);
  state.attentionWindowTimer = setTimeout(() => {
    state.attentionWindowTimer = null;
    state.inAttentionWindow = false;
    state.statusBuffer.resume();
    log(`[${state.chatId}] Attention window ended`);
  }, ATTENTION_WINDOW_MS);
}

function clearAttentionWindow(state: ChatState) {
  if (state.attentionWindowTimer) {
    clearTimeout(state.attentionWindowTimer);
    state.attentionWindowTimer = null;
  }
  if (state.inAttentionWindow) state.statusBuffer.resume();
  state.inAttentionWindow = false;
}

function emitToChat(state: ChatState, message: BridgeMessage) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    if (trySendBridgeMessage(state.ws, message, state.chatId)) return;
    log(`[${state.chatId}] Send to Claude failed, buffering`);
  }
  state.bufferedMessages.push(message);
  if (state.bufferedMessages.length > MAX_BUFFERED_MESSAGES) {
    const dropped = state.bufferedMessages.length - MAX_BUFFERED_MESSAGES;
    state.bufferedMessages.splice(0, dropped);
    log(`[${state.chatId}] Message buffer overflow: dropped ${dropped} oldest`);
  }
}

function trySendBridgeMessage(
  ws: ServerWebSocket<ControlSocketData>,
  message: BridgeMessage,
  chatId: string,
): boolean {
  try {
    const payload: ControlServerMessage = { type: "codex_to_claude", chatId, message };
    const result = ws.send(JSON.stringify(payload));
    if (typeof result === "number" && result <= 0) {
      log(`Bridge message send returned ${result} (0=dropped, -1=backpressure)`);
      return false;
    }
    return true;
  } catch (err: any) {
    log(`Failed to send bridge message: ${err.message}`);
    return false;
  }
}

function flushBufferedMessages(state: ChatState) {
  if (!state.ws || state.bufferedMessages.length === 0) return;
  const messages = state.bufferedMessages.splice(0, state.bufferedMessages.length);
  for (const message of messages) {
    if (!trySendBridgeMessage(state.ws, message, state.chatId)) {
      const idx = messages.indexOf(message);
      state.bufferedMessages.unshift(...messages.slice(idx));
      log(`[${state.chatId}] Flush interrupted: re-buffered ${messages.length - idx} message(s)`);
      return;
    }
  }
}

function broadcastToAllClaudes(message: BridgeMessage) {
  for (const state of chats.values()) emitToChat(state, message);
}

function sendStatus(ws: ServerWebSocket<ControlSocketData>) {
  sendProtocolMessage(ws, { type: "status", status: currentStatus() });
}

function broadcastStatus() {
  for (const state of chats.values()) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) sendStatus(state.ws);
  }
}

function sendProtocolMessage(ws: ServerWebSocket<ControlSocketData>, message: ControlServerMessage) {
  try {
    ws.send(JSON.stringify(message));
  } catch (err: any) {
    log(`Failed to send control message: ${err.message}`);
  }
}

function currentStatus(): DaemonStatus {
  const snapshot = tuiConnectionState.snapshot();
  return {
    bridgeReady: tuiConnectionState.canReply() || codexBootstrapped,
    tuiConnected: snapshot.tuiConnected,
    threadId: codex.activeThreadId,
    queuedMessageCount: [...chats.values()].reduce(
      (n, s) => n + s.bufferedMessages.length + s.statusBuffer.size,
      0,
    ),
    proxyUrl: codex.proxyUrl,
    appServerUrl: codex.appServerUrl,
    pid: process.pid,
    attachedClaudeCount: [...chats.values()].filter((s) => s.ws).length,
  };
}

function systemMessage(idPrefix: string, content: string): BridgeMessage {
  return {
    id: `${idPrefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    source: "codex",
    content,
    timestamp: Date.now(),
  };
}

// ── Idle shutdown ───────────────────────────────────────────────

function scheduleIdleShutdown() {
  cancelIdleShutdown();
  if ([...chats.values()].some((s) => s.ws !== null)) return; // still have a live claude
  if (tuiConnectionState.snapshot().tuiConnected) return;

  log(`No clients connected. Daemon will shut down in ${IDLE_SHUTDOWN_MS}ms if no one reconnects.`);
  idleShutdownTimer = setTimeout(() => {
    if ([...chats.values()].some((s) => s.ws !== null) || tuiConnectionState.snapshot().tuiConnected) {
      log("Idle shutdown cancelled: client reconnected during grace period");
      return;
    }
    shutdown("idle — no clients connected");
  }, IDLE_SHUTDOWN_MS);
}

function cancelIdleShutdown() {
  if (idleShutdownTimer) {
    clearTimeout(idleShutdownTimer);
    idleShutdownTimer = null;
  }
}

// ── Lifecycle ───────────────────────────────────────────────────

function writePidFile() { daemonLifecycle.writePid(); }
function removePidFile() { daemonLifecycle.removePidFile(); }

function writeStatusFile() {
  daemonLifecycle.writeStatus({
    proxyUrl: codex.proxyUrl,
    appServerUrl: codex.appServerUrl,
    controlPort: CONTROL_PORT,
    pid: process.pid,
  });
}

function removeStatusFile() { daemonLifecycle.removeStatusFile(); }

async function bootCodex() {
  log("Starting AgentBridge daemon (multi-Claude variant)...");
  log(`Codex app-server: ${codex.appServerUrl}`);
  log(`Codex proxy: ${codex.proxyUrl}`);
  log(`Control server: ws://127.0.0.1:${CONTROL_PORT}/ws`);

  try {
    await codex.start();
    codexBootstrapped = true;
    writeStatusFile();
    broadcastStatus();
  } catch (err: any) {
    log(`Failed to start Codex: ${err.message}`);
    broadcastToAllClaudes(
      systemMessage(
        "system_codex_start_failed",
        `❌ AgentBridge failed to start Codex app-server: ${err.message}`,
      ),
    );
    broadcastStatus();
  }
}

function shutdown(reason: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`Shutting down daemon (${reason})...`);
  tuiConnectionState.dispose(`daemon shutdown (${reason})`);
  for (const state of chats.values()) {
    if (state.attentionWindowTimer) clearTimeout(state.attentionWindowTimer);
    if (state.disconnectTimer) clearTimeout(state.disconnectTimer);
    if (state.reaperTimer) clearTimeout(state.reaperTimer);
    state.statusBuffer.dispose();
    try { state.thread.close(); } catch {}
  }
  chats.clear();
  controlServer?.stop();
  controlServer = null;
  codex.stop();
  removePidFile();
  removeStatusFile();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("exit", () => { removePidFile(); removeStatusFile(); });
process.on("uncaughtException", (err) => {
  log(`UNCAUGHT EXCEPTION: ${err.stack ?? err.message}`);
});
process.on("unhandledRejection", (reason: any) => {
  log(`UNHANDLED REJECTION: ${reason?.stack ?? reason}`);
});

function log(msg: string) {
  const line = `[${new Date().toISOString()}] [AgentBridgeDaemon] ${msg}\n`;
  process.stderr.write(line);
  try {
    appendFileSync(stateDir.logFile, line);
  } catch {}
}

// Refuse to start if user intentionally killed the daemon.
if (daemonLifecycle.wasKilled()) {
  log("Killed sentinel found — daemon was intentionally stopped. Exiting immediately.");
  process.exit(0);
}

writePidFile();
startControlServer();
void bootCodex();

// Silence unused-warning for the legacy import; we keep the symbol around in
// case future tooling wants to surface the attach command in status.
void attachCmd;

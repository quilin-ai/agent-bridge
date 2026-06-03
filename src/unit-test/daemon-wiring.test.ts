import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import type { BridgeMessage } from "../types";
import type { ControlServerMessage, DaemonStatus } from "../control-protocol";
import { portsForSlot, type PairPorts } from "../pair-registry";

const DAEMON_PATH = join(process.cwd(), "src", "daemon.ts");
const DEFAULT_TEST_SLOT_START = 2500 + (process.pid % 500);
const DIAGNOSTIC_TAIL_CHARS = 4000;

interface Harness {
  root: string;
  cwd: string;
  stateDir: string;
  binDir: string;
  commandFile: string;
  appPort: number;
  proxyPort: number;
  controlPort: number;
  slot: number;
  daemon: ChildProcess;
  messages: BridgeMessage[];
  statusMessages: ControlServerMessage[];
  close: () => Promise<void>;
  sendAppCommand: (command: string) => void;
  attachClaude: () => Promise<void>;
}

const harnesses: Harness[] = [];

describe("daemon wiring", () => {
  afterEach(async () => {
    while (harnesses.length > 0) {
      const harness = harnesses.pop()!;
      await harness.close();
    }
  });

  test("waiting notice uses pair-aware waiting message formatting", async () => {
    const harness = await startHarness({ pairId: "main-testabcd", pairName: "main" });

    await harness.attachClaude();

    const waiting = await waitForMessage(
      harness.messages,
      (message) => message.id.startsWith("system_waiting_"),
      "system_waiting message",
    );

    expect(waiting.content).toContain("Waiting for Codex TUI");
    expect(waiting.content).toContain(`cwd=${harness.cwd}`);
    expect(waiting.content).toContain("pair=main");
    expect(waiting.content).toContain("pairId=main-testabcd");
    expect(waiting.content).toContain(`slot=${harness.slot}`);
    expect(waiting.content).toContain(`proxy=ws://127.0.0.1:${harness.proxyPort}`);
    expect(waiting.content).toContain("different cwd");
    expect(waiting.content).toContain("another pair");
  }, 20000);

  test("turnAborted event emits system_turn_aborted to the attached Claude client", async () => {
    const harness = await startHarness({ pairId: "main-abortabcd", pairName: "main" });

    await harness.attachClaude();
    await waitForMessage(
      harness.messages,
      (message) => message.id.startsWith("system_waiting_"),
      "initial system_waiting message",
    );

    harness.sendAppCommand("start-turn");
    await sleep(100);
    harness.sendAppCommand("close-app-server");

    const aborted = await waitForMessage(
      harness.messages,
      (message) => message.id.startsWith("system_turn_aborted_"),
      "system_turn_aborted message",
    );

    expect(aborted.content).toContain("ended without completing");
    expect(aborted.content).toContain("app-server connection closed");
    expect(aborted.content).toContain("retry");
  }, 20000);
});

async function startHarness(opts: {
  pairId: string;
  pairName: string;
}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "agentbridge-daemon-wiring-"));
  const cwdPath = join(root, "project");
  const stateDir = join(root, "state");
  const binDir = join(root, "bin");
  const commandFile = join(root, "app-command.txt");
  mkdirSync(cwdPath, { recursive: true });
  const cwd = realpathSync(cwdPath);
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  const { slot, ports } = await reserveFreePairSlot();
  const { appPort, proxyPort, controlPort } = ports;

  const codexPath = join(binDir, "codex");
  writeFileSync(codexPath, fakeCodexScript(), "utf-8");
  chmodSync(codexPath, 0o755);

  const env = {
    ...scrubAgentBridgeEnv(process.env),
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    AGENTBRIDGE_PAIR_ID: opts.pairId,
    AGENTBRIDGE_PAIR_NAME: opts.pairName,
    AGENTBRIDGE_STATE_DIR: stateDir,
    AGENTBRIDGE_CONTROL_PORT: String(controlPort),
    AGENTBRIDGE_IDLE_SHUTDOWN_MS: "60000",
    AGENTBRIDGE_BOOTSTRAP_TIMEOUT_MS: "10000",
    AGENTBRIDGE_CODEX_TRANSPORT: "ws",
    CODEX_WS_PORT: String(appPort),
    CODEX_PROXY_PORT: String(proxyPort),
    FAKE_APP_COMMAND_FILE: commandFile,
  };

  const daemon = spawn("bun", ["run", DAEMON_PATH], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr: string[] = [];
  const stdout: string[] = [];
  daemon.stdout?.on("data", (chunk) => stdout.push(chunk.toString()));
  daemon.stderr?.on("data", (chunk) => stderr.push(chunk.toString()));

  const harness: Harness = {
    root,
    cwd,
    stateDir,
    binDir,
    commandFile,
    appPort,
    proxyPort,
    controlPort,
    slot,
    daemon,
    messages: [],
    statusMessages: [],
    close: async () => {
      if (daemon.exitCode === null && daemon.signalCode === null) {
        daemon.kill("SIGTERM");
        await waitFor(() => daemon.exitCode !== null || daemon.signalCode !== null, "daemon exit", 100, 50)
          .catch(() => {
            try { daemon.kill("SIGKILL"); } catch {}
          });
      }
      await sleep(50);
      rmSync(root, { recursive: true, force: true });
    },
    sendAppCommand: (command: string) => {
      writeFileSync(commandFile, `${command}\n`, "utf-8");
    },
    attachClaude: async () => {
      const ws = await connectControlSocket(controlPort);
      ws.onmessage = (event) => {
        const raw = typeof event.data === "string" ? event.data : event.data.toString();
        const message = JSON.parse(raw) as ControlServerMessage;
        harness.statusMessages.push(message);
        if (message.type === "codex_to_claude") {
          harness.messages.push(message.message);
        }
      };
      ws.send(JSON.stringify({
        type: "claude_connect",
        identity: {
          pairId: opts.pairId,
          pairName: opts.pairName,
          cwd,
          stateDir,
          clientPid: process.pid,
          contractVersion: 1,
        },
      }));
    },
  };
  harnesses.push(harness);

  await waitForHarnessDaemonReady({
    controlPort,
    daemon,
    expectedPairId: opts.pairId,
    stateDir,
    stdout,
    stderr,
  });

  return harness;
}

function fakeCodexScript(): string {
  return `#!/usr/bin/env bun
import { existsSync, readFileSync, unlinkSync } from "node:fs";

if (process.argv.includes("--version")) {
  console.log("codex fake");
  process.exit(0);
}

if (process.argv[2] !== "app-server") {
  await Bun.sleep(60_000);
  process.exit(0);
}

const listenIndex = process.argv.indexOf("--listen");
const listen = process.argv[listenIndex + 1];
const port = Number(new URL(listen).port);
const commandFile = process.env.FAKE_APP_COMMAND_FILE;
let appWs = null;

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
    message() {},
    close(ws) {
      if (appWs === ws) appWs = null;
    },
  },
});

setInterval(() => {
  if (!commandFile || !existsSync(commandFile)) return;
  const command = readFileSync(commandFile, "utf-8").trim();
  try { unlinkSync(commandFile); } catch {}
  if (!appWs) return;
  if (command === "start-turn") {
    appWs.send(JSON.stringify({ method: "turn/started", params: { turn: { id: "turn-1" } } }));
  }
  if (command === "close-app-server") {
    appWs.close(1011, "test app-server close");
    setTimeout(() => server.stop(true), 20);
  }
}, 25).unref();

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

await new Promise(() => {});
`;
}

function scrubAgentBridgeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(scrubbed)) {
    if (key.startsWith("AGENTBRIDGE_") || key.startsWith("CODEX_")) {
      delete scrubbed[key];
    }
  }
  return scrubbed;
}

async function reserveFreePairSlot(startSlot = DEFAULT_TEST_SLOT_START): Promise<{ slot: number; ports: PairPorts }> {
  for (let slot = startSlot; slot < startSlot + 100; slot++) {
    const ports = portsForSlot(slot);
    const reservations: Array<ReturnType<typeof createServer>> = [];
    try {
      for (const port of [ports.appPort, ports.proxyPort, ports.controlPort]) {
        reservations.push(await listenOnPort(port));
      }
      await Promise.all(reservations.map((server) => closeServer(server)));
      return { slot, ports };
    } catch {
      await Promise.all(reservations.map((server) => closeServer(server).catch(() => {})));
    }
  }
  throw new Error("Could not find a free pair slot for daemon wiring test");
}

function listenOnPort(port: number): Promise<ReturnType<typeof createServer>> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function waitForHarnessDaemonReady(opts: {
  controlPort: number;
  daemon: ChildProcess;
  expectedPairId: string;
  stateDir: string;
  stdout: string[];
  stderr: string[];
}): Promise<void> {
  let lastReadyz = "<not probed>";

  for (let i = 0; i < 120; i++) {
    if (opts.daemon.exitCode !== null || opts.daemon.signalCode !== null) {
      throw new Error(
        `Daemon exited before readyz matched spawned process identity\n${daemonDiagnostics(opts, lastReadyz)}`,
      );
    }

    try {
      const response = await fetch(`http://127.0.0.1:${opts.controlPort}/readyz`);
      const body = await response.text();
      const status = parseReadyzStatus(body);
      lastReadyz = `HTTP ${response.status} pid=${status?.pid ?? "<missing>"} pairId=${status?.pairId ?? "<missing>"} body=${tailText(body)}`;

      if (response.ok && status?.pid === opts.daemon.pid && status?.pairId === opts.expectedPairId) {
        return;
      }
    } catch (err: any) {
      lastReadyz = `fetch error: ${err?.message ?? String(err)}`;
    }

    await sleep(100);
  }

  throw new Error(
    `Timed out waiting for daemon readyz from spawned process identity\n${daemonDiagnostics(opts, lastReadyz)}`,
  );
}

function parseReadyzStatus(body: string): Partial<DaemonStatus> | null {
  try {
    return JSON.parse(body) as Partial<DaemonStatus>;
  } catch {
    return null;
  }
}

function daemonDiagnostics(
  opts: {
    daemon: ChildProcess;
    stateDir: string;
    stdout: string[];
    stderr: string[];
  },
  lastReadyz: string,
): string {
  return [
    `daemon.pid=${opts.daemon.pid ?? "<none>"} exitCode=${opts.daemon.exitCode ?? "<running>"} signalCode=${opts.daemon.signalCode ?? "<none>"}`,
    `lastReadyz=${lastReadyz}`,
    `stdout.tail=${tailText(opts.stdout.join(""))}`,
    `stderr.tail=${tailText(opts.stderr.join(""))}`,
    `agentbridge.log.tail=${readFileTail(join(opts.stateDir, "agentbridge.log"))}`,
  ].join("\n");
}

function readFileTail(path: string): string {
  if (!existsSync(path)) return "<missing>";
  try {
    return tailText(readFileSync(path, "utf-8"));
  } catch (err: any) {
    return `<failed to read: ${err?.message ?? String(err)}>`;
  }
}

function tailText(value: string): string {
  if (value.length <= DIAGNOSTIC_TAIL_CHARS) return value;
  return value.slice(-DIAGNOSTIC_TAIL_CHARS);
}

function connectControlSocket(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error("timed out connecting to daemon control socket"));
    }, 2000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve(ws);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("failed to connect to daemon control socket"));
    };
  });
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  label: string,
  maxRetries = 80,
  delayMs = 50,
): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    if (await condition()) return;
    await sleep(delayMs);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function waitForMessage(
  messages: BridgeMessage[],
  predicate: (message: BridgeMessage) => boolean,
  label: string,
): Promise<BridgeMessage> {
  await waitFor(() => messages.some(predicate), `${label}; observed=${JSON.stringify(messages)}`);
  return messages.find(predicate)!;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

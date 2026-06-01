import { spawn, execSync } from "node:child_process";
import {
  openSync,
  writeSync,
  closeSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  appendFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { ConfigService } from "../config-service";
import { DaemonLifecycle } from "../daemon-lifecycle";
import { pairScopedCommand } from "../pair-command";
import { applyPairEnv, parsePairFlag, type PairResolution } from "../pair-resolver";
import { StderrRingBuffer } from "../stderr-ring-buffer";
import { checkOwnedFlagConflicts } from "./claude";

/**
 * Write a timestamped entry to the codex wrapper log.
 *
 * Silent on IO failure — logging must never break the wrapper itself.
 */
function appendWrapperLog(path: string, entry: string): void {
  try {
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    appendFileSync(path, `[${new Date().toISOString()}] ${entry}\n`, "utf-8");
  } catch {
    /* ignore */
  }
}

/**
 * Build the child env for codex.
 *
 * Enables Rust tracing + full backtrace so that the next "silent exit" shows
 * up in `~/.codex/log/codex-tui.log` and on stderr (which we also tee).
 * User-provided values take precedence — we only set defaults.
 */
function buildChildEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    RUST_BACKTRACE: process.env.RUST_BACKTRACE ?? "full",
    RUST_LOG:
      process.env.RUST_LOG ??
      "info,codex_core=debug,codex_tui=debug,codex_app_server=debug",
  };
}

/** Flags that AgentBridge owns for codex command. */
const OWNED_FLAGS = ["--remote"];

/**
 * Codex subcommands that still launch the TUI and benefit from AgentBridge's
 * remote proxy. Bridge flags for these must be injected *after* the subcommand
 * name, because clap defines `--remote` / `--enable` as per-subcommand options
 * (not `global`). See docs/issues-2026-04-18-codex-stuck-and-resume.md (Issue D).
 */
const TUI_SUBCOMMANDS = new Set(["resume", "fork"]);

/**
 * Codex subcommands that do NOT launch a TUI. Bridge flags are not applicable
 * and must not be injected. Keep in sync with `codex --help` output.
 */
const NON_TUI_SUBCOMMANDS = new Set([
  "exec", "e",
  "review",
  "login", "logout",
  "mcp", "mcp-server",
  "plugin",
  "remote-control",
  "update",
  "app-server", "exec-server",
  "app",
  "completion",
  "sandbox",
  "debug",
  "apply", "a",
  "cloud",
  "features",
  "help",
]);

export interface BuildArgsResult {
  /** Final argv for `codex`. */
  fullArgs: string[];
  /** Whether bridge flags (`--enable tui_app_server --remote <proxy>`) were injected. */
  injectedBridgeFlags: boolean;
}

/**
 * Build the final codex command-line arguments, positioning bridge flags so
 * clap parses them as options of the actually-invoked (sub)command.
 *
 * - Bare `codex` / `codex --<flag>…` / `codex <prompt>` → inject at front (root TUI).
 * - `codex resume|fork …` → inject after the subcommand name.
 * - Any known non-TUI subcommand (`exec`, `review`, `login`, `mcp`, …) → pass
 *   through unchanged; those do not launch a TUI and must not receive `--remote`.
 * - Unknown first token → treat as a bare prompt (TUI mode). Safer than
 *   silently dropping bridge flags for an unrecognized subcommand.
 */
export function buildCodexArgs(userArgs: string[], proxyUrl: string): BuildArgsResult {
  const bridgeFlags = ["--enable", "tui_app_server", "--remote", proxyUrl];
  const first = userArgs[0];

  if (!first || first.startsWith("-")) {
    return { fullArgs: [...bridgeFlags, ...userArgs], injectedBridgeFlags: true };
  }

  if (TUI_SUBCOMMANDS.has(first)) {
    return {
      fullArgs: [first, ...bridgeFlags, ...userArgs.slice(1)],
      injectedBridgeFlags: true,
    };
  }

  if (NON_TUI_SUBCOMMANDS.has(first)) {
    return { fullArgs: userArgs, injectedBridgeFlags: false };
  }

  return { fullArgs: [...bridgeFlags, ...userArgs], injectedBridgeFlags: true };
}

/**
 * Best-effort warning when the project's AGENTS.md has an AgentBridge marker block
 * from an OLDER version that predates the collaboration contract now living in
 * AGENTS.md. The daemon no longer appends that contract (message markers /
 * git-write rules / role guidance) to every message, so an un-refreshed AGENTS.md
 * would leave Codex without it. Read-only; never blocks startup; silent when there
 * is no block (project simply hasn't been `abg init`-ed in this dir).
 */
function warnIfStaleAgentsMdContract(cwd: string): void {
  try {
    const agentsPath = join(cwd, "AGENTS.md");
    if (!existsSync(agentsPath)) return;
    const content = readFileSync(agentsPath, "utf-8");
    if (!content.includes("<!-- AgentBridge:start -->")) return; // no block → not an upgrade-drift case
    if (content.includes("Git operations — FORBIDDEN for you")) return; // already has the new contract
    console.error(
      "[agentbridge] ⚠️ Your AGENTS.md AgentBridge block predates the Codex collaboration contract " +
        "(message markers / git-write rules / role guidance).",
    );
    console.error(
      "[agentbridge]    Re-run `abg init` to refresh it — Codex now relies on AGENTS.md for that contract " +
        "(it is no longer injected into every message).",
    );
  } catch {
    /* best-effort; never block startup */
  }
}

export async function runCodex(args: string[]) {
  // Strip `--pair <name>` first; the rest flows through to codex.
  const { pairFlag, rest } = parsePairFlag(args);

  // Read-only nudge if this project's AGENTS.md contract block is stale (pre-upgrade).
  warnIfStaleAgentsMdContract(process.cwd());

  // Check for owned flag conflicts (on the real codex args, not the pair flag).
  checkOwnedFlagConflicts(rest, "agentbridge codex", OWNED_FLAGS);

  // Specifically check for --enable tui_app_server (not all --enable values)
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--enable" && rest[i + 1] === "tui_app_server") {
      console.error(`Error: "--enable tui_app_server" is automatically set by agentbridge codex.`);
      console.error("");
      console.error("If you need full control over these flags, use the native command directly:");
      console.error("  codex [your flags here]");
      process.exit(1);
    }
    if (rest[i] === "--enable=tui_app_server") {
      console.error(`Error: "--enable=tui_app_server" is automatically set by agentbridge codex.`);
      console.error("");
      console.error("If you need full control over these flags, use the native command directly:");
      console.error("  codex [your flags here]");
      process.exit(1);
    }
  }

  // Resolve the pair and inject its env BEFORE ensureRunning, so the daemon this
  // launches binds this pair's Codex app-server / proxy / control ports.
  let pair: PairResolution;
  try {
    pair = await applyPairEnv({ pairFlag });
  } catch (err: any) {
    console.error(`[agentbridge] ${err.message}`);
    process.exit(1);
  }

  if (pair.warning) console.error(`[agentbridge] ⚠️  ${pair.warning}`);

  const stateDir = pair.stateDir;
  const controlPort = pair.ports.controlPort;

  const lifecycle = new DaemonLifecycle({
    stateDir,
    controlPort,
    log: (msg) => console.error(`[agentbridge] ${msg}`),
  });

  if (!pair.manual) {
    console.error(
      `[agentbridge] pair "${pair.pairId}" (slot ${pair.slot}) — control :${controlPort}, ` +
        `codex :${pair.ports.appPort}/:${pair.ports.proxyPort}`,
    );
  }

  // Ensure daemon is running
  console.error("[agentbridge] Ensuring daemon is running...");
  try {
    lifecycle.clearKilled();
    await lifecycle.ensureRunning();
    console.error("[agentbridge] Daemon is ready.");
  } catch (err: any) {
    console.error(`[agentbridge] Failed to start daemon: ${err.message}`);
    console.error(`[agentbridge] Try: ${pairScopedCommand("kill")} && ${pairScopedCommand("claude")}`);
    process.exit(1);
  }

  // Read proxyUrl from daemon status or fall back to config
  let proxyUrl: string;
  const status = lifecycle.readStatus();
  if (status?.proxyUrl) {
    proxyUrl = status.proxyUrl;
  } else {
    // Mirror exactly how the daemon resolves its proxy port (daemon.ts:39):
    // CODEX_PROXY_PORT (set by applyPairEnv in pair mode; user-set in manual mode)
    // else the project config. This is correct for BOTH multi-pair (env carries
    // the slot's port) and manual/legacy mode (config may be a custom port).
    const fallbackProxyPort = process.env.CODEX_PROXY_PORT ?? String(new ConfigService().loadOrDefault().codex.proxyPort);
    proxyUrl = `ws://127.0.0.1:${fallbackProxyPort}`;
    console.error(`[agentbridge] No daemon status found, using fallback proxy port: ${proxyUrl}`);
  }

  try {
    await waitForProxyReady(proxyUrl);
  } catch (err: any) {
    console.error(`[agentbridge] ${err.message}`);
    process.exit(1);
  }

  // Save terminal state and launch Codex with protection
  console.log(`Connecting Codex TUI to AgentBridge at ${proxyUrl}...`);

  // Save terminal state
  let savedStty: string | null = null;
  if (process.stdin.isTTY) {
    try {
      savedStty = execSync("stty -g", { encoding: "utf-8", stdio: ["inherit", "pipe", "pipe"] }).trim();
    } catch {}
  }

  function restoreTerminal() {
    // Restore saved terminal settings
    if (savedStty && process.stdin.isTTY) {
      try {
        execSync(`stty ${savedStty}`, { stdio: ["inherit", "ignore", "ignore"] });
      } catch {
        try {
          execSync("stty sane", { stdio: ["inherit", "ignore", "ignore"] });
        } catch {}
      }
    }

    // Write escape sequences to /dev/tty if available
    let ttyFd: number | null = null;
    try {
      ttyFd = openSync("/dev/tty", "w");
    } catch {
      if (process.stdout.isTTY) {
        ttyFd = 1; // stdout
      }
    }

    if (ttyFd !== null) {
      const sequences = [
        "\x1b[<u",       // Disable keyboard enhancement
        "\x1b[?2004l",   // Disable bracketed paste
        "\x1b[?1004l",   // Disable focus tracking
        "\x1b[?1049l",   // Leave alternate screen
        "\x1b[?25h",     // Show cursor
        "\x1b[0m",       // Reset character attributes
      ];
      for (const seq of sequences) {
        try {
          writeSync(ttyFd, seq);
        } catch {}
      }
      if (ttyFd !== 1) {
        try { closeSync(ttyFd); } catch {}
      }
    }
  }

  const { fullArgs } = buildCodexArgs(rest, proxyUrl);

  // Capture the last 64KB of child stderr so the "ERROR: ..." line from
  // codex-rs on ExitReason::Fatal survives even when stdio is inherited by
  // a terminal that clears on exit. See codex-rs/cli/src/main.rs:553.
  const stderrTail = new StderrRingBuffer();
  const wrapperLogPath = stateDir.codexWrapperLogFile;
  const startedAt = Date.now();

  stateDir.ensure();
  appendWrapperLog(
    wrapperLogPath,
    `spawn: codex ${fullArgs.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`,
  );

  const child = spawn("codex", fullArgs, {
    // inherit stdin + stdout (TUI needs raw TTY), pipe stderr so we can tee.
    stdio: ["inherit", "inherit", "pipe"],
    env: buildChildEnv(),
  });

  if (typeof child.pid === "number") {
    writeFileSync(stateDir.tuiPidFile, `${child.pid}\n`, "utf-8");
    appendWrapperLog(wrapperLogPath, `child pid=${child.pid}`);
  }

  // Tee stderr: pass through to user's terminal, tail into ring buffer.
  if (child.stderr) {
    child.stderr.on("data", (chunk: Buffer) => {
      try {
        process.stderr.write(chunk);
      } catch {
        /* stderr may be closed during shutdown */
      }
      stderrTail.append(chunk);
    });
  }

  let cleanedTuiPid = false;
  function cleanupTuiPidFile() {
    if (cleanedTuiPid) return;
    cleanedTuiPid = true;
    try {
      unlinkSync(stateDir.tuiPidFile);
    } catch {}
  }

  process.on("exit", () => { restoreTerminal(); cleanupTuiPidFile(); });
  process.on("SIGINT", () => { restoreTerminal(); cleanupTuiPidFile(); process.exit(130); });
  process.on("SIGTERM", () => { restoreTerminal(); cleanupTuiPidFile(); process.exit(143); });

  child.on("exit", (code, signal) => {
    cleanupTuiPidFile();

    const runtimeMs = Date.now() - startedAt;
    const tail = stderrTail.toString();
    const tailLines = tail.length === 0
      ? "(no stderr captured)"
      : tail;
    // Heuristic classification for quick scanning of the wrapper log.
    //
    // Source-of-truth from codex-rs (verified via Codex's PTY experiment):
    //   - "ERROR: remote app server ... disconnected: ..." → exit code 1
    //     (comes from codex-rs/cli/src/main.rs:553 on ExitReason::Fatal,
    //      triggered by app-server WS close regardless of close code)
    //   - "thread/closed" ServerNotification → exit code 0, EMPTY stderr
    //     (ExitMode::Immediate, invisible in wrapper logs alone —
    //      correlate with agentbridge.log where the adapter sniffs it)
    //   - Plain Ctrl+C → signal:SIGINT
    //   - Other non-zero → likely upstream bug
    let classification = "normal";
    if (/ERROR: remote app server/.test(tail)) classification = "fatal_exit";
    else if (/Error: .* failed: Not initialized/.test(tail)) classification = "not_initialized_after_reconnect";
    else if (/Error: .* failed:/.test(tail)) classification = "rpc_error_exit";
    else if (signal) classification = `signal:${signal}`;
    else if (typeof code === "number" && code !== 0) classification = `nonzero_exit:${code}`;
    else if (code === 0 && tail.trim().length === 0) classification = "exit_0_empty_stderr";

    appendWrapperLog(
      wrapperLogPath,
      [
        `exit: code=${code ?? "null"} signal=${signal ?? "null"} runtime_ms=${runtimeMs} pid=${child.pid ?? "unknown"} classification=${classification}`,
        `--- last stderr (${stderrTail.byteLength} bytes) ---`,
        tailLines,
        `--- end stderr ---`,
      ].join("\n"),
    );

    process.exit(code ?? 0);
  });

  child.on("error", (err) => {
    cleanupTuiPidFile();
    appendWrapperLog(wrapperLogPath, `spawn error: ${err.message}`);
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error("Error: codex not found in PATH.");
      console.error("Install Codex: https://github.com/openai/codex");
      process.exit(1);
    }
    console.error(`Error starting Codex: ${err.message}`);
    process.exit(1);
  });
}

function proxyHealthUrl(proxyUrl: string): string {
  const url = new URL(proxyUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/healthz";
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function waitForProxyReady(proxyUrl: string, maxRetries = 20, delayMs = 100): Promise<void> {
  const healthUrl = proxyHealthUrl(proxyUrl);

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) {
        return;
      }
    } catch {}

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  throw new Error(`Timed out waiting for Codex proxy readiness on ${healthUrl}`);
}

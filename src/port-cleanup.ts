/**
 * Platform-aware pre-flight port cleanup.
 *
 * Before the daemon spawns `codex app-server`, ports left occupied by a stale
 * spawn (daemon hard-killed, child survived) must be reclaimed — otherwise the
 * fresh spawn dies with EADDRINUSE / os error 10048 and the user lands in the
 * recurring "PARTIAL state" failure that needs a manual `agentbridge kill`.
 *
 * The POSIX path uses lsof/ps/kill. The win32 path (issue #76, contributed by
 * @Tominori666) uses PowerShell: `Get-NetTCPConnection` for port→PID,
 * `Get-CimInstance Win32_Process` for the command line, `Stop-Process -Force`
 * to kill — all available on every supported Windows without extra tooling.
 *
 * Every command is expressed as argv (no shell interpolation) and the runner
 * is injectable so the decision logic is unit-testable on any platform.
 */

export interface PortCommand {
  cmd: string;
  args: string[];
}

export type CommandRunner = (command: PortCommand) => string;

/**
 * Command that lists PIDs LISTENing on a TCP port, one per line.
 *
 * POSIX: restricting to `-sTCP:LISTEN` is critical — a bare `lsof -ti :PORT`
 * also returns processes that merely have an outbound (client) FD to that
 * port, including stale CLOSED connections from crashed clients. Those false
 * positives caused `abg claude` to refuse startup whenever a previous Codex
 * TUI process lingered with a half-closed connection to port 4501.
 *
 * win32: `Get-NetTCPConnection -State Listen` has the LISTEN restriction
 * built in; `-ErrorAction SilentlyContinue` makes "no match" emit nothing
 * instead of failing, mirroring lsof's exit-1-on-empty handled by the caller.
 */
export function portPidsCommand(port: number, platform: NodeJS.Platform = process.platform): PortCommand {
  if (platform === "win32") {
    return {
      cmd: "powershell.exe",
      args: [
        "-NoProfile",
        "-Command",
        `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique`,
      ],
    };
  }
  return { cmd: "lsof", args: ["-ti", `tcp:${port}`, "-sTCP:LISTEN"] };
}

/** Command that prints the full command line of a PID (empty when gone). */
export function processCommandLineCommand(pid: string, platform: NodeJS.Platform = process.platform): PortCommand {
  if (platform === "win32") {
    return {
      cmd: "powershell.exe",
      args: [
        "-NoProfile",
        "-Command",
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction SilentlyContinue; if ($p -and $p.CommandLine) { $p.CommandLine }`,
      ],
    };
  }
  return { cmd: "ps", args: ["-p", pid, "-o", "args="] };
}

/**
 * Command that terminates a PID. POSIX keeps plain SIGTERM (the pre-existing
 * behavior — stale app-servers exit cleanly on TERM). win32 uses -Force:
 * there is no TERM equivalent a headless app-server responds to, and the
 * whole point is reclaiming the port from an already-orphaned process.
 */
export function killPidCommand(pid: string, platform: NodeJS.Platform = process.platform): PortCommand {
  if (platform === "win32") {
    return {
      cmd: "powershell.exe",
      args: ["-NoProfile", "-Command", `Stop-Process -Id ${pid} -Force -ErrorAction Stop`],
    };
  }
  return { cmd: "kill", args: [pid] };
}

/** Split command output into deduplicated, trimmed, non-empty PID strings. */
export function parsePids(output: string): string[] {
  const seen = new Set<string>();
  const pids: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const pid = line.trim();
    // PIDs only — PowerShell failures can emit error text on stdout in some
    // hosts; anything non-numeric must not reach kill.
    if (!/^\d+$/.test(pid)) continue;
    // PID 0 is never a reclaimable user process: on Windows it's the System
    // Idle pseudo-process (would classify as foreign and spuriously block
    // startup); on POSIX `kill 0` signals the whole process group.
    if (pid === "0") continue;
    if (seen.has(pid)) continue;
    seen.add(pid);
    pids.push(pid);
  }
  return pids;
}

/**
 * Is this command line one of our own `codex app-server` spawns?
 *
 * Case-insensitive ONLY on win32 (paths like `C:\...\Codex\codex.exe` are
 * case-preserving but case-insensitive). POSIX keeps the pre-existing
 * case-sensitive match — widening it would reclassify a foreign process
 * with `Codex` in a path component from "refuse startup with a clear error"
 * to "silently kill".
 */
export function isCodexAppServerCommandLine(cmdline: string, platform: NodeJS.Platform = process.platform): boolean {
  const s = platform === "win32" ? cmdline.toLowerCase() : cmdline;
  return s.includes("codex") && s.includes("app-server");
}

export interface CleanupPortsOptions {
  ports: Array<{ port: number; envVar: string }>;
  run: CommandRunner;
  log: (message: string) => void;
  sleep: (ms: number) => Promise<void>;
  platform?: NodeJS.Platform;
}

/**
 * Reclaim stale `codex app-server` listeners on the given ports.
 *
 * Only kills processes whose command line identifies them as codex
 * app-servers (our own previous spawns). Throws with an actionable message
 * when a foreign process holds the port, or when the port is still occupied
 * after cleanup.
 */
export async function cleanupPorts(options: CleanupPortsOptions): Promise<void> {
  const platform = options.platform ?? process.platform;

  const listPids = (port: number): string[] => {
    try {
      return parsePids(options.run(portPidsCommand(port, platform)));
    } catch {
      // lsof exits 1 when nothing matches — port is free.
      return [];
    }
  };

  for (const { port, envVar } of options.ports) {
    const pidList = listPids(port);
    if (pidList.length === 0) continue;

    const staleCodexPids: string[] = [];
    const foreignPids: string[] = [];
    for (const pid of pidList) {
      try {
        const cmdline = options.run(processCommandLineCommand(pid, platform)).trim();
        if (isCodexAppServerCommandLine(cmdline, platform)) {
          staleCodexPids.push(pid);
        } else {
          foreignPids.push(pid);
        }
      } catch {
        // Process already gone between the two commands.
      }
    }

    if (staleCodexPids.length > 0) {
      options.log(`Cleaning up stale codex app-server on port ${port}: PID(s) ${staleCodexPids.join(", ")}`);
      for (const pid of staleCodexPids) {
        try {
          options.run(killPidCommand(pid, platform));
        } catch {
          // Already exited; the post-cleanup re-check below is the authority.
        }
      }
      await options.sleep(500);
    }

    if (foreignPids.length > 0) {
      throw new Error(
        `Port ${port} is already in use by non-Codex process(es): PID(s) ${foreignPids.join(", ")}. ` +
          `Please stop the process or set a different port via ${envVar} env var.`,
      );
    }

    const remaining = listPids(port);
    if (remaining.length > 0) {
      throw new Error(
        `Port ${port} is still occupied (PID(s): ${remaining.join(", ")}) after cleanup. ` +
          `Please stop the process or set a different port via ${envVar} env var.`,
      );
    }
  }
}

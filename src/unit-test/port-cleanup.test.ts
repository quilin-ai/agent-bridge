import { describe, expect, test } from "bun:test";
import {
  cleanupPorts,
  isCodexAppServerCommandLine,
  killPidCommand,
  parsePids,
  portPidsCommand,
  processCommandLineCommand,
  type PortCommand,
} from "../port-cleanup";

describe("port-cleanup command construction", () => {
  test("posix port listing keeps the TCP:LISTEN restriction", () => {
    expect(portPidsCommand(4501, "darwin")).toEqual({
      cmd: "lsof",
      args: ["-ti", "tcp:4501", "-sTCP:LISTEN"],
    });
    expect(portPidsCommand(4501, "linux")).toEqual(portPidsCommand(4501, "darwin"));
  });

  test("win32 port listing uses Get-NetTCPConnection with Listen state", () => {
    const { cmd, args } = portPidsCommand(4500, "win32");
    expect(cmd).toBe("powershell.exe");
    expect(args[0]).toBe("-NoProfile");
    expect(args[2]).toContain("Get-NetTCPConnection -LocalPort 4500 -State Listen");
    expect(args[2]).toContain("OwningProcess");
  });

  test("command line lookup per platform", () => {
    expect(processCommandLineCommand("123", "linux")).toEqual({
      cmd: "ps",
      args: ["-p", "123", "-o", "args="],
    });
    const win = processCommandLineCommand("123", "win32");
    expect(win.cmd).toBe("powershell.exe");
    expect(win.args[2]).toContain("Win32_Process");
    expect(win.args[2]).toContain("ProcessId = 123");
  });

  test("kill keeps plain SIGTERM on posix and Stop-Process -Force on win32", () => {
    expect(killPidCommand("99", "darwin")).toEqual({ cmd: "kill", args: ["99"] });
    const win = killPidCommand("99", "win32");
    expect(win.cmd).toBe("powershell.exe");
    expect(win.args[2]).toContain("Stop-Process -Id 99 -Force");
  });
});

describe("parsePids", () => {
  test("splits, trims, dedupes and drops non-numeric noise", () => {
    expect(parsePids("123\n456\n123\n")).toEqual(["123", "456"]);
    // CRLF from PowerShell output
    expect(parsePids("123\r\n456\r\n")).toEqual(["123", "456"]);
    // Error text or prompts must never reach kill
    expect(parsePids("Get-NetTCPConnection : error\n123\n")).toEqual(["123"]);
    expect(parsePids("")).toEqual([]);
    expect(parsePids("\n\n")).toEqual([]);
  });
});

describe("isCodexAppServerCommandLine", () => {
  test("matches posix and windows codex app-server command lines", () => {
    expect(isCodexAppServerCommandLine("/usr/local/bin/codex app-server", "darwin")).toBe(true);
    expect(isCodexAppServerCommandLine('"C:\\Users\\x\\AppData\\Local\\Programs\\Codex\\codex.exe" app-server', "win32")).toBe(true);
    expect(isCodexAppServerCommandLine("node /srv/other-server.js", "darwin")).toBe(false);
    // A codex TUI without app-server must NOT be treated as a stale spawn
    expect(isCodexAppServerCommandLine("codex resume abc --yolo", "darwin")).toBe(false);
  });

  test("POSIX match stays case-sensitive: foreign Codex-cased paths must refuse startup, not get killed", () => {
    expect(isCodexAppServerCommandLine("/opt/Codex/app-server-helper", "darwin")).toBe(false);
    expect(isCodexAppServerCommandLine("/opt/Codex/app-server-helper", "linux")).toBe(false);
    // win32 is case-insensitive by design (case-preserving filesystem)
    expect(isCodexAppServerCommandLine("C:\\Tools\\CODEX.EXE APP-SERVER", "win32")).toBe(true);
  });
});

describe("parsePids PID 0 guard", () => {
  test("PID 0 never reaches classification or kill", () => {
    expect(parsePids("0\n123\n")).toEqual(["123"]);
    expect(parsePids("0")).toEqual([]);
  });
});

interface FakeProcess {
  cmdline: string;
}

/**
 * Simulates the OS surface cleanupPorts talks to: a port→PID table and a
 * PID→cmdline table; kill removes the process and frees its ports.
 */
function fakeRunner(state: {
  ports: Map<number, string[]>;
  processes: Map<string, FakeProcess>;
  killed: string[];
}) {
  return ({ cmd, args }: PortCommand): string => {
    const joined = args.join(" ");
    if (cmd === "lsof" || (cmd === "powershell.exe" && joined.includes("Get-NetTCPConnection"))) {
      const port = Number(/(?:tcp:|LocalPort )(\d+)/.exec(joined)?.[1]);
      const pids = (state.ports.get(port) ?? []).filter((pid) => state.processes.has(pid));
      if (pids.length === 0 && cmd === "lsof") {
        // lsof exits 1 on no match
        throw new Error("lsof: no match");
      }
      return pids.join("\n");
    }
    if (cmd === "ps" || (cmd === "powershell.exe" && joined.includes("Win32_Process"))) {
      const pid = cmd === "ps" ? args[1]! : /ProcessId = (\d+)/.exec(joined)![1]!;
      const proc = state.processes.get(pid);
      if (!proc) throw new Error("no such process");
      return proc.cmdline;
    }
    if (cmd === "kill" || (cmd === "powershell.exe" && joined.includes("Stop-Process"))) {
      const pid = cmd === "kill" ? args[0]! : /-Id (\d+)/.exec(joined)![1]!;
      state.killed.push(pid);
      state.processes.delete(pid);
      return "";
    }
    throw new Error(`unexpected command: ${cmd} ${joined}`);
  };
}

function harness(platform: NodeJS.Platform) {
  const state = {
    ports: new Map<number, string[]>(),
    processes: new Map<string, FakeProcess>(),
    killed: [] as string[],
  };
  const logs: string[] = [];
  const runCleanup = () =>
    cleanupPorts({
      ports: [
        { port: 4500, envVar: "CODEX_WS_PORT" },
        { port: 4501, envVar: "CODEX_PROXY_PORT" },
      ],
      run: fakeRunner(state),
      log: (m) => logs.push(m),
      sleep: async () => {},
      platform,
    });
  return { state, logs, runCleanup };
}

for (const platform of ["darwin", "win32"] as const) {
  describe(`cleanupPorts decision logic (${platform})`, () => {
    test("free ports are a no-op", async () => {
      const { runCleanup, state } = harness(platform);
      await runCleanup();
      expect(state.killed).toEqual([]);
    });

    test("stale codex app-server is killed and the port reclaimed", async () => {
      const { runCleanup, state, logs } = harness(platform);
      state.ports.set(4500, ["111"]);
      state.processes.set("111", { cmdline: platform === "win32" ? "C:\\codex.exe app-server" : "codex app-server" });
      await runCleanup();
      expect(state.killed).toEqual(["111"]);
      expect(logs.some((l) => l.includes("stale codex app-server on port 4500"))).toBe(true);
    });

    test("foreign process on the port throws with the env var hint", async () => {
      const { runCleanup, state } = harness(platform);
      state.ports.set(4501, ["222"]);
      state.processes.set("222", { cmdline: "nginx -g daemon" });
      await expect(runCleanup()).rejects.toThrow(/non-Codex process.*222.*CODEX_PROXY_PORT/s);
      expect(state.killed).toEqual([]);
    });

    test("mixed stale + foreign: stale is killed, then foreign still fails the start", async () => {
      const { runCleanup, state } = harness(platform);
      state.ports.set(4500, ["111", "222"]);
      state.processes.set("111", { cmdline: "codex app-server" });
      state.processes.set("222", { cmdline: "some-other-daemon" });
      await expect(runCleanup()).rejects.toThrow(/non-Codex process/);
      expect(state.killed).toEqual(["111"]);
    });

    test("port still occupied after kill throws the post-cleanup error", async () => {
      const { runCleanup, state } = harness(platform);
      state.ports.set(4500, ["111"]);
      const immortal: FakeProcess = { cmdline: "codex app-server" };
      state.processes.set("111", immortal);
      const base = fakeRunner(state);
      // Kill that doesn't actually free the port
      const run = (c: PortCommand) => {
        const out = base(c);
        if (c.cmd === "kill" || c.args.join(" ").includes("Stop-Process")) {
          state.processes.set("111", immortal);
        }
        return out;
      };
      await expect(
        cleanupPorts({
          ports: [{ port: 4500, envVar: "CODEX_WS_PORT" }],
          run,
          log: () => {},
          sleep: async () => {},
          platform,
        }),
      ).rejects.toThrow(/still occupied.*111/s);
    });

    test("process vanishing between list and cmdline lookup is tolerated", async () => {
      const { runCleanup, state } = harness(platform);
      state.ports.set(4500, ["333"]);
      // Simulate the race with a one-shot listing: the PID appears on the
      // port once, but is gone by the time the cmdline lookup runs.
      let listed = false;
      const base = fakeRunner(state);
      const run = (c: PortCommand) => {
        const joined = c.args.join(" ");
        if ((c.cmd === "lsof" || joined.includes("Get-NetTCPConnection")) && !listed) {
          listed = true;
          return "333";
        }
        return base(c);
      };
      await cleanupPorts({
        ports: [{ port: 4500, envVar: "CODEX_WS_PORT" }],
        run,
        log: () => {},
        sleep: async () => {},
        platform,
      });
      expect(state.killed).toEqual([]);
    });
  });
}

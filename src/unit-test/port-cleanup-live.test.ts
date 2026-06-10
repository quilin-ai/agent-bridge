import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import type { TCPSocketListener } from "bun";
import { parsePids, portPidsCommand, processCommandLineCommand } from "../port-cleanup";

/**
 * Live verification against the REAL platform commands — this is what the
 * windows-latest CI job exists for (issue #76: no maintainer has a local
 * Windows box). On POSIX it doubles as a live check of the lsof path.
 *
 * The test binds a real TCP listener and asserts the platform command finds
 * our own PID on that port, then that the command-line lookup returns a
 * non-empty command line for it.
 */
describe("port-cleanup live platform commands", () => {
  let server: TCPSocketListener | null = null;
  let port = 0;

  beforeAll(() => {
    server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {} },
    }) as TCPSocketListener;
    port = server.port;
  });

  afterAll(() => {
    server?.stop(true);
  });

  test("portPidsCommand finds our own listener PID", () => {
    const { cmd, args } = portPidsCommand(port);
    const output = execFileSync(cmd, args, { encoding: "utf-8" });
    const pids = parsePids(output);
    expect(pids).toContain(String(process.pid));
  });

  test("processCommandLineCommand returns a command line for our PID", () => {
    const { cmd, args } = processCommandLineCommand(String(process.pid));
    const output = execFileSync(cmd, args, { encoding: "utf-8" }).trim();
    expect(output.length).toBeGreaterThan(0);
    // Our own process is the bun test runner.
    expect(output.toLowerCase()).toContain("bun");
  });

  test("portPidsCommand returns nothing for a free port", () => {
    const free = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const freePort = free.port;
    free.stop(true);
    const { cmd, args } = portPidsCommand(freePort);
    let output = "";
    try {
      output = execFileSync(cmd, args, { encoding: "utf-8" });
    } catch {
      // lsof exits 1 on no match — that IS the free-port signal on POSIX.
    }
    expect(parsePids(output)).toEqual([]);
  });
});

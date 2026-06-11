import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { homedir, platform, tmpdir } from "node:os";
import { StateDirResolver, resolveXdgStateBase } from "../state-dir";

describe("StateDirResolver", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "agentbridge-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("uses env override when provided", () => {
    const resolver = new StateDirResolver(tempDir);
    expect(resolver.dir).toBe(tempDir);
  });

  test("returns correct file paths under state dir", () => {
    const resolver = new StateDirResolver(tempDir);
    expect(resolver.pidFile).toBe(join(tempDir, "daemon.pid"));
    expect(resolver.tuiPidFile).toBe(join(tempDir, "codex-tui.pid"));
    expect(resolver.lockFile).toBe(join(tempDir, "daemon.lock"));
    expect(resolver.statusFile).toBe(join(tempDir, "status.json"));
    expect(resolver.logFile).toBe(join(tempDir, "agentbridge.log"));
    expect(resolver.updateCheckFile).toBe(join(tempDir, "update-check.json"));
  });

  test("ensure() creates directory if it does not exist", () => {
    const nested = join(tempDir, "nested", "state");
    const resolver = new StateDirResolver(nested);
    resolver.ensure();
    expect(Bun.file(nested).size).toBeUndefined; // directory exists
    // Verify by writing a file
    const { writeFileSync, existsSync } = require("node:fs");
    writeFileSync(join(nested, "test.txt"), "ok");
    expect(existsSync(join(nested, "test.txt"))).toBe(true);
  });

  test("ensure() is idempotent", () => {
    const resolver = new StateDirResolver(tempDir);
    resolver.ensure();
    resolver.ensure(); // should not throw
    expect(resolver.dir).toBe(tempDir);
  });

  test("uses platform default when no override", () => {
    // Just verify it doesn't throw and returns a non-empty string
    const resolver = new StateDirResolver();
    expect(resolver.dir.length).toBeGreaterThan(0);
  });
});

describe("resolveXdgStateBase — XDG_STATE_HOME empty/unset handling (Linux)", () => {
  // platformBaseDir's XDG branch only runs off-darwin, so test the pure helper
  // directly with an explicit raw value — this exercises the bug on ANY host.
  const expectedFallback = join(homedir(), ".local", "state", "agentbridge");

  test("empty string falls back to ~/.local/state (absolute, NOT cwd-relative)", () => {
    const base = resolveXdgStateBase("");
    // The crux of the bug: join("", "agentbridge") returns the RELATIVE path
    // "agentbridge". The fix must treat "" as unset and produce an absolute path.
    expect(isAbsolute(base)).toBe(true);
    expect(base).toBe(expectedFallback);
  });

  test("undefined (unset) falls back to ~/.local/state", () => {
    const base = resolveXdgStateBase(undefined);
    expect(isAbsolute(base)).toBe(true);
    expect(base).toBe(expectedFallback);
  });

  test("non-empty value is honored", () => {
    const custom = join(tmpdir(), "xdg-state-fixture");
    expect(resolveXdgStateBase(custom)).toBe(join(custom, "agentbridge"));
  });
});

describe("StateDirResolver.platformBaseDir — always absolute", () => {
  let savedXdg: string | undefined;

  beforeEach(() => {
    savedXdg = process.env.XDG_STATE_HOME;
  });

  afterEach(() => {
    if (savedXdg === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = savedXdg;
  });

  test("empty XDG_STATE_HOME never yields a cwd-relative base", () => {
    process.env.XDG_STATE_HOME = "";
    expect(isAbsolute(StateDirResolver.platformBaseDir())).toBe(true);
  });

  test("non-darwin: empty XDG_STATE_HOME resolves to ~/.local/state", () => {
    if (platform() === "darwin") return; // XDG branch unreachable on macOS
    process.env.XDG_STATE_HOME = "";
    expect(StateDirResolver.platformBaseDir()).toBe(
      join(homedir(), ".local", "state", "agentbridge"),
    );
  });
});

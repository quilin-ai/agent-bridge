import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateDirResolver } from "../state-dir";
import {
  findCodexRolloutFile,
  persistCurrentThreadWithRolloutRetry,
  promoteCurrentThreadIfRolloutExists,
  readRawCurrentThread,
  readUsableCurrentThread,
  writePendingCurrentThread,
} from "../thread-state";

function tempDir(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function identity(root: string, codexHome: string) {
  return {
    stateDir: new StateDirResolver(join(root, "pair-state")),
    pairId: "main-12345678",
    pairName: "main",
    cwd: root,
    env: { CODEX_HOME: codexHome } as NodeJS.ProcessEnv,
  };
}

describe("thread-state", () => {
  test("pending current thread is not usable for resume", () => {
    const root = tempDir("agentbridge-thread-state-");
    const codexHome = tempDir("agentbridge-codex-home-");
    try {
      const id = identity(root, codexHome);
      writePendingCurrentThread(id, "thread-pending", "test");

      expect(readUsableCurrentThread(id, id.env)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  test("rollout-backed current thread is usable", () => {
    const root = tempDir("agentbridge-thread-state-");
    const codexHome = tempDir("agentbridge-codex-home-");
    try {
      const sessionsDir = join(codexHome, "sessions", "2026", "06", "02");
      mkdirSync(sessionsDir, { recursive: true });
      const rolloutPath = join(sessionsDir, "rollout-thread-current.jsonl");
      writeFileSync(rolloutPath, "{}\n", "utf-8");

      const id = identity(root, codexHome);
      const state = promoteCurrentThreadIfRolloutExists(id, "thread-current", "test", id.env);

      expect(state.status).toBe("current");
      expect(state.rolloutPath).toBe(rolloutPath);
      expect(readUsableCurrentThread(id, id.env)?.threadId).toBe("thread-current");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  test("persistCurrentThreadWithRolloutRetry promotes to current once the rollout appears", async () => {
    const root = tempDir("agentbridge-thread-state-");
    const codexHome = tempDir("agentbridge-codex-home-");
    try {
      const sessionsDir = join(codexHome, "sessions", "2026", "06", "02");
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(join(sessionsDir, "rollout-thread-X.jsonl"), "{}\n", "utf-8");
      const id = identity(root, codexHome);

      const state = await persistCurrentThreadWithRolloutRetry(id, "thread-X", "test", {
        env: id.env,
        attempts: 2,
        delayMs: 1,
      });

      expect(state?.status).toBe("current");
      expect(readUsableCurrentThread(id, id.env)?.threadId).toBe("thread-X");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  test("a superseded persistence loop abandons and does not clobber the active thread's mapping", async () => {
    const root = tempDir("agentbridge-thread-state-");
    const codexHome = tempDir("agentbridge-codex-home-");
    try {
      const id = identity(root, codexHome);
      // "thread-B" is the active, newer thread already on disk.
      writePendingCurrentThread(id, "thread-B", "newer");

      // A stale loop for "thread-A" whose guard reports it is already superseded
      // must write nothing and return null — current-thread.json stays thread-B.
      const result = await persistCurrentThreadWithRolloutRetry(id, "thread-A", "stale", {
        env: id.env,
        attempts: 5,
        delayMs: 1,
        shouldContinue: () => false,
      });

      expect(result).toBeNull();
      expect(readRawCurrentThread(id.stateDir)?.threadId).toBe("thread-B");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  test("findCodexRolloutFile returns null when sessions are absent", () => {
    const codexHome = tempDir("agentbridge-codex-home-");
    try {
      expect(findCodexRolloutFile("missing", { CODEX_HOME: codexHome } as NodeJS.ProcessEnv)).toBeNull();
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });
});

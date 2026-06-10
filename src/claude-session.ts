import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Claude Code stores one transcript per session under
 * `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`. The directory name
 * encodes the project cwd with every non-alphanumeric character replaced by
 * `-` (verified against real installs: `/Users/x/repo/agent_bridge` →
 * `-Users-x-repo-agent-bridge`).
 */
export function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export interface ClaudeSessionInfo {
  sessionId: string;
  file: string;
  mtimeMs: number;
}

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The most recently active Claude Code session for a project directory, by
 * transcript mtime. Returns null when the project has no sessions (or the
 * projects dir is unreadable). Non-session entries (memory/, subagent dirs,
 * stray files) are ignored — only uuid-named .jsonl transcripts count.
 */
export function findLatestClaudeSession(
  cwd: string,
  // Claude Code honors CLAUDE_CONFIG_DIR to relocate its config dir — without
  // this, a relocated install would get a false "no session found".
  // `||` (not `??`): empty-string env is treated as unset (codebase convention,
  // see computeBaseDir).
  claudeHome: string = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
): ClaudeSessionInfo | null {
  const dir = join(claudeHome, "projects", encodeClaudeProjectDir(cwd));
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }

  let best: ClaudeSessionInfo | null = null;
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const sessionId = name.slice(0, -".jsonl".length);
    if (!SESSION_ID_PATTERN.test(sessionId)) continue;
    const file = join(dir, name);
    let mtimeMs: number;
    try {
      const st = statSync(file);
      if (!st.isFile()) continue;
      mtimeMs = st.mtimeMs;
    } catch {
      continue;
    }
    if (!best || mtimeMs > best.mtimeMs) {
      best = { sessionId, file, mtimeMs };
    }
  }
  return best;
}

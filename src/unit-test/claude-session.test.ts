import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeClaudeProjectDir, findLatestClaudeSession } from "../claude-session";

const UUID_A = "11111111-2222-3333-4444-555555555555";
const UUID_B = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function makeClaudeHome(cwd: string): { home: string; projectDir: string } {
  const home = mkdtempSync(join(tmpdir(), "abg-claude-session-test-"));
  const projectDir = join(home, "projects", encodeClaudeProjectDir(cwd));
  mkdirSync(projectDir, { recursive: true });
  return { home, projectDir };
}

function writeSession(projectDir: string, id: string, mtimeSeconds: number) {
  const file = join(projectDir, `${id}.jsonl`);
  writeFileSync(file, "{}\n");
  utimesSync(file, mtimeSeconds, mtimeSeconds);
  return file;
}

describe("encodeClaudeProjectDir", () => {
  test("replaces every non-alphanumeric character with a dash (incl. underscores)", () => {
    expect(encodeClaudeProjectDir("/Users/x/repo/agent_bridge")).toBe(
      "-Users-x-repo-agent-bridge",
    );
  });

  test("keeps alphanumerics intact", () => {
    expect(encodeClaudeProjectDir("/tmp/Abc123")).toBe("-tmp-Abc123");
  });
});

describe("findLatestClaudeSession", () => {
  test("picks the most recently modified uuid-named transcript", () => {
    const cwd = "/tmp/abg-resume-fixture";
    const { home, projectDir } = makeClaudeHome(cwd);
    writeSession(projectDir, UUID_A, 1_000_000);
    writeSession(projectDir, UUID_B, 2_000_000);

    const found = findLatestClaudeSession(cwd, home);
    expect(found?.sessionId).toBe(UUID_B);
  });

  test("ignores non-uuid jsonl files, directories, and non-jsonl entries", () => {
    const cwd = "/tmp/abg-resume-fixture2";
    const { home, projectDir } = makeClaudeHome(cwd);
    writeSession(projectDir, UUID_A, 1_000_000);
    // Distractors: stray jsonl, memory dir, session-named SUBDIR (subagent layout).
    writeFileSync(join(projectDir, "notes.jsonl"), "{}\n");
    utimesSync(join(projectDir, "notes.jsonl"), 9_000_000, 9_000_000);
    mkdirSync(join(projectDir, "memory"), { recursive: true });
    mkdirSync(join(projectDir, `${UUID_B}.jsonl.d`), { recursive: true });

    const found = findLatestClaudeSession(cwd, home);
    expect(found?.sessionId).toBe(UUID_A);
  });

  test("returns null when the project has no sessions or no directory", () => {
    const cwd = "/tmp/abg-resume-fixture3";
    const { home } = makeClaudeHome(cwd);
    expect(findLatestClaudeSession(cwd, home)).toBeNull();
    expect(findLatestClaudeSession("/tmp/never-seen-cwd", home)).toBeNull();
  });
});

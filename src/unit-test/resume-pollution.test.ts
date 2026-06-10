import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  extractFirstRealUserMessage,
  isKickoffText,
  scanResumePollution,
} from "../resume-pollution";

const KICKOFF = `Claude Code has connected via AgentBridge.
You are now in a multi-agent collaboration session.
When you receive a complex task, propose a division of labor to Claude.`;

function setupDb(root: string) {
  const codexHome = join(root, "codex-home");
  mkdirSync(codexHome, { recursive: true });
  const dbPath = join(codexHome, "state_5.sqlite");
  const db = new Database(dbPath);
  db.run(`
    create table threads (
      id text primary key,
      rollout_path text not null,
      created_at integer not null,
      updated_at integer not null,
      cwd text not null,
      title text not null,
      first_user_message text not null default '',
      preview text not null default '',
      archived integer not null default 0
    )
  `);
  db.close();
  return { codexHome, dbPath };
}

function writeRollout(path: string, realMessage: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    [
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "AGENTS.md instructions for /tmp/x" }],
        },
      }),
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: KICKOFF } }),
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: realMessage } }),
    ].join("\n") + "\n",
    "utf-8",
  );
}

function writeKickoffOnlyRollout(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    [
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "AGENTS.md instructions for /tmp/x" }],
        },
      }),
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: KICKOFF } }),
    ].join("\n") + "\n",
    "utf-8",
  );
}

function insertThread(dbPath: string, id: string, rollout: string) {
  const db = new Database(dbPath);
  db.run(
    `insert into threads (id, rollout_path, created_at, updated_at, cwd, title, first_user_message, preview, archived)
     values (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [id, rollout, 1, 1, "/repo", KICKOFF, KICKOFF, KICKOFF],
  );
  db.close();
}

describe("resume pollution scanner", () => {
  test("detects kickoff text", () => {
    expect(isKickoffText(KICKOFF)).toBe(true);
    expect(isKickoffText("real task")).toBe(false);
  });

  test("extracts first real user message from rollout", () => {
    const root = mkdtempSync(join(tmpdir(), "agentbridge-pollution-"));
    try {
      const rollout = join(root, "rollout-thread.jsonl");
      writeRollout(rollout, "Please fix the real bug");
      expect(extractFirstRealUserMessage(rollout)).toBe("Please fix the real bug");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("dry-run reports polluted metadata and apply updates after backup", () => {
    const root = mkdtempSync(join(tmpdir(), "agentbridge-pollution-"));
    try {
      const { codexHome, dbPath } = setupDb(root);
      const rollout = join(codexHome, "sessions", "2026", "06", "02", "rollout-thread-1.jsonl");
      writeRollout(rollout, "Fix the current AgentBridge bugs");

      const db = new Database(dbPath);
      db.run(
        `insert into threads (id, rollout_path, created_at, updated_at, cwd, title, first_user_message, preview, archived)
         values (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        ["thread-1", rollout, 1, 1, "/repo", KICKOFF, KICKOFF, KICKOFF],
      );
      db.close();

      const dry = scanResumePollution({ codexHome });
      expect(dry.candidates).toHaveLength(1);
      expect(dry.candidates[0]!.replacementFirstUserMessage).toBe("Fix the current AgentBridge bugs");
      expect(dry.applied).toBe(0);

      const applied = scanResumePollution({ codexHome, apply: true, now: "2026-06-02T00:00:00.000Z" });
      expect(applied.applied).toBe(1);
      expect(applied.backupDir).toContain("agentbridge-backups");

      const verify = new Database(dbPath, { readonly: true });
      const row = verify.query("select title, first_user_message, preview from threads where id = ?")
        .get("thread-1") as { title: string; first_user_message: string; preview: string };
      verify.close();
      expect(row.first_user_message).toBe("Fix the current AgentBridge bugs");
      expect(row.title).toContain("Fix the current AgentBridge bugs");
      expect(row.preview).toContain("Fix the current AgentBridge bugs");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("thread with real work is classified rename and apply relabels it", () => {
    const root = mkdtempSync(join(tmpdir(), "agentbridge-pollution-"));
    try {
      const { codexHome, dbPath } = setupDb(root);
      const rollout = join(codexHome, "sessions", "2026", "06", "02", "rollout-real.jsonl");
      writeRollout(rollout, "Implement the parser fix");
      insertThread(dbPath, "thread-real", rollout);

      const dry = scanResumePollution({ codexHome });
      expect(dry.candidates).toHaveLength(1);
      expect(dry.candidates[0]!.action).toBe("rename");

      const applied = scanResumePollution({ codexHome, apply: true, now: "2026-06-02T00:00:00.000Z" });
      expect(applied.renamed).toBe(1);
      expect(applied.deleted).toBe(0);
      expect(applied.applied).toBe(1);

      const verify = new Database(dbPath, { readonly: true });
      const row = verify.query("select title, first_user_message from threads where id = ?")
        .get("thread-real") as { title: string; first_user_message: string } | null;
      verify.close();
      expect(row).not.toBeNull();
      expect(row!.first_user_message).toBe("Implement the parser fix");
      expect(row!.title).toContain("Implement the parser fix");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("kickoff-only thread is classified delete and apply removes the row with backup", () => {
    const root = mkdtempSync(join(tmpdir(), "agentbridge-pollution-"));
    try {
      const { codexHome, dbPath } = setupDb(root);
      const rollout = join(codexHome, "sessions", "2026", "06", "02", "rollout-kickoff.jsonl");
      writeKickoffOnlyRollout(rollout);
      insertThread(dbPath, "thread-kickoff", rollout);

      const dry = scanResumePollution({ codexHome });
      expect(dry.candidates).toHaveLength(1);
      expect(dry.candidates[0]!.action).toBe("delete");
      expect(dry.applied).toBe(0);

      const applied = scanResumePollution({ codexHome, apply: true, now: "2026-06-02T00:00:00.000Z" });
      expect(applied.deleted).toBe(1);
      expect(applied.renamed).toBe(0);
      expect(applied.applied).toBe(1);
      expect(applied.backupDir).toContain("agentbridge-backups");
      expect(existsSync(applied.backupDir!)).toBe(true);

      const verify = new Database(dbPath, { readonly: true });
      const row = verify.query("select id from threads where id = ?").get("thread-kickoff");
      verify.close();
      expect(row).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("dry-run applies nothing (no delete, no update)", () => {
    const root = mkdtempSync(join(tmpdir(), "agentbridge-pollution-"));
    try {
      const { codexHome, dbPath } = setupDb(root);
      const renameRollout = join(codexHome, "sessions", "2026", "06", "02", "rollout-rn.jsonl");
      const deleteRollout = join(codexHome, "sessions", "2026", "06", "02", "rollout-del.jsonl");
      writeRollout(renameRollout, "Real task to keep");
      writeKickoffOnlyRollout(deleteRollout);
      insertThread(dbPath, "thread-keep", renameRollout);
      insertThread(dbPath, "thread-drop", deleteRollout);

      const dry = scanResumePollution({ codexHome });
      expect(dry.candidates).toHaveLength(2);
      expect(dry.applied).toBe(0);
      expect(dry.renamed).toBe(0);
      expect(dry.deleted).toBe(0);
      expect(dry.backupDir).toBeUndefined();

      // No write happened: both rows still present and unchanged (still polluted).
      const verify = new Database(dbPath, { readonly: true });
      const rows = verify.query("select id, title from threads order by id").all() as Array<{
        id: string;
        title: string;
      }>;
      verify.close();
      expect(rows.map((r) => r.id).sort()).toEqual(["thread-drop", "thread-keep"]);
      expect(rows.every((r) => r.title === KICKOFF)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

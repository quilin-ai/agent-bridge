import { Database } from "bun:sqlite";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { codexHome as defaultCodexHome } from "./thread-state";

export type PollutionAction = "rename" | "delete";

export interface PollutionCandidate {
  id: string;
  cwd: string;
  rolloutPath: string;
  title: string;
  firstUserMessage: string;
  preview: string;
  action: PollutionAction;
  replacementTitle: string;
  replacementFirstUserMessage: string;
  replacementPreview: string;
  reason: string;
}

export interface PollutionReport {
  codexHome: string;
  dbPath: string;
  scanned: number;
  candidates: PollutionCandidate[];
  applied: number;
  renamed: number;
  deleted: number;
  backupDir?: string;
}

const KICKOFF_FINGERPRINTS = [
  "Claude Code has connected via AgentBridge",
  "You are now in a multi-agent collaboration session",
  "When you receive a complex task, propose a division of labor to Claude",
];

export function isKickoffText(text: string | null | undefined): boolean {
  if (!text) return false;
  return KICKOFF_FINGERPRINTS.some((fingerprint) => text.includes(fingerprint));
}

export function extractFirstRealUserMessage(rolloutPath: string): string | null {
  if (!existsSync(rolloutPath)) return null;
  const raw = readFileSync(rolloutPath, "utf-8");
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const message = extractUserText(entry);
    if (!message) continue;
    if (isSyntheticUserMessage(message)) continue;
    return message.trim();
  }
  return null;
}

export function scanResumePollution(options: {
  codexHome?: string;
  dbPath?: string;
  apply?: boolean;
  now?: string;
} = {}): PollutionReport {
  const codexHome = options.codexHome ?? defaultCodexHome();
  const dbPath = options.dbPath ?? join(codexHome, "state_5.sqlite");
  if (!existsSync(dbPath)) {
    return { codexHome, dbPath, scanned: 0, candidates: [], applied: 0, renamed: 0, deleted: 0 };
  }

  const db = options.apply ? new Database(dbPath) : new Database(dbPath, { readonly: true });
  try {
    const rows = db.query(`
      select id, cwd, rollout_path as rolloutPath, title,
             first_user_message as firstUserMessage, preview
      from threads
      where archived = 0 and (
        first_user_message like '%AgentBridge%' or
        first_user_message like '%multi-agent collaboration%' or
        title like '%AgentBridge%' or
        title like '%multi-agent collaboration%' or
        preview like '%AgentBridge%' or
        preview like '%multi-agent collaboration%'
      )
      order by updated_at desc
    `).all() as Array<{
      id: string;
      cwd: string;
      rolloutPath: string;
      title: string;
      firstUserMessage: string;
      preview: string;
    }>;

    const candidates: PollutionCandidate[] = [];
    for (const row of rows) {
      const pollutedFields = [
        isKickoffText(row.title) ? "title" : null,
        isKickoffText(row.firstUserMessage) ? "first_user_message" : null,
        isKickoffText(row.preview) ? "preview" : null,
      ].filter(Boolean);
      if (pollutedFields.length === 0) continue;

      const realMessage = extractFirstRealUserMessage(row.rolloutPath);
      if (!realMessage) {
        // Kickoff-only session with no real user work — meaningless, delete it.
        candidates.push({
          id: row.id,
          cwd: row.cwd,
          rolloutPath: row.rolloutPath,
          title: row.title,
          firstUserMessage: row.firstUserMessage,
          preview: row.preview,
          action: "delete",
          replacementTitle: row.title,
          replacementFirstUserMessage: row.firstUserMessage,
          replacementPreview: row.preview,
          reason: `kickoff-only, polluted ${pollutedFields.join(", ")}`,
        });
        continue;
      }

      // Session has real work — relabel the polluted metadata, keep the row.
      candidates.push({
        id: row.id,
        cwd: row.cwd,
        rolloutPath: row.rolloutPath,
        title: row.title,
        firstUserMessage: row.firstUserMessage,
        preview: row.preview,
        action: "rename",
        replacementTitle: isKickoffText(row.title) ? sidebarTitle(realMessage) : row.title,
        replacementFirstUserMessage: isKickoffText(row.firstUserMessage) ? realMessage : row.firstUserMessage,
        replacementPreview: isKickoffText(row.preview) ? previewText(realMessage) : row.preview,
        reason: `polluted ${pollutedFields.join(", ")}`,
      });
    }

    let renamed = 0;
    let deleted = 0;
    let backupDir: string | undefined;
    if (options.apply && candidates.length > 0) {
      // Always back up state files BEFORE any destructive write.
      backupDir = backupCodexStateFiles(dbPath, options.now);
      const update = db.prepare(`
        update threads
        set title = ?,
            first_user_message = ?,
            preview = ?
        where id = ?
      `);
      const remove = db.prepare(`delete from threads where id = ?`);
      const tx = db.transaction((items: PollutionCandidate[]) => {
        for (const item of items) {
          if (item.action === "delete") {
            remove.run(item.id);
            deleted++;
          } else {
            update.run(
              item.replacementTitle,
              item.replacementFirstUserMessage,
              item.replacementPreview,
              item.id,
            );
            renamed++;
          }
        }
      });
      tx(candidates);
    }

    const applied = renamed + deleted;
    return { codexHome, dbPath, scanned: rows.length, candidates, applied, renamed, deleted, backupDir };
  } finally {
    db.close();
  }
}

export function backupCodexStateFiles(dbPath: string, now = new Date().toISOString()): string {
  const safeStamp = now.replace(/[:.]/g, "-");
  const base = join(dirname(dbPath), "agentbridge-backups", `resume-pollution-${safeStamp}`);
  mkdirSync(base, { recursive: true });
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    if (!existsSync(path)) continue;
    const target = join(base, path.split("/").pop()!);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(path, target);
  }
  return base;
}

function extractUserText(entry: any): string | null {
  if (entry?.type === "event_msg" && entry.payload?.type === "user_message") {
    return typeof entry.payload.message === "string" ? entry.payload.message : null;
  }
  if (entry?.type === "response_item" && entry.payload?.type === "message" && entry.payload?.role === "user") {
    const content = entry.payload.content;
    if (!Array.isArray(content)) return null;
    const parts = content
      .map((item: any) => typeof item?.text === "string" ? item.text : typeof item?.input_text?.text === "string" ? item.input_text.text : null)
      .filter((part: string | null): part is string => !!part);
    return parts.length > 0 ? parts.join("\n") : null;
  }
  return null;
}

function isSyntheticUserMessage(message: string): boolean {
  return (
    isKickoffText(message) ||
    message.includes("AGENTS.md instructions for") ||
    message.includes("<environment_context>")
  );
}

function sidebarTitle(message: string): string {
  return compact(message).slice(0, 80);
}

function previewText(message: string): string {
  return compact(message).slice(0, 160);
}

function compact(message: string): string {
  return message.replace(/\s+/g, " ").trim();
}

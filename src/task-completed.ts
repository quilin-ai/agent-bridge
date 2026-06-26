import { randomUUID } from "node:crypto";
import type { Envelope } from "./backbone/envelope";

export interface TaskCompletedPayload {
  /** One-line human-readable summary (the only large field stored in the ledger, §4.1). */
  summary: string;
  repo?: string;
  branch?: string;
  commit?: string;
  /** The contract/interface this completion touches (§3.3). */
  contract?: string;
  /** In-room relevance highlight: agentIds or "topic:xxx" this unblocks (§3.3). */
  unblocks?: string[];
}

export interface BuildTaskCompletedInput extends TaskCompletedPayload {
  roomId: string;
  from: { agentId: string; agentType: string; sessionId?: string; name?: string };
  /** Clock injection for tests. */
  now?: () => number;
}

/**
 * Assemble a `task_completed` Envelope (§3.3, Appendix A). Broadcast to the room
 * (no `to`), `store_if_offline` so absent members catch up on reconnect. The
 * `unblocks` field (agentIds / "topic:xxx") is the in-room relevance highlight,
 * carried in the payload for the receiving adapter to render.
 */
export function buildTaskCompletedEnvelope(input: BuildTaskCompletedInput): Envelope {
  const now = (input.now ?? Date.now)();
  const payload: TaskCompletedPayload = { summary: input.summary };
  if (input.repo) payload.repo = input.repo;
  if (input.branch) payload.branch = input.branch;
  if (input.commit) payload.commit = input.commit;
  if (input.contract) payload.contract = input.contract;
  if (input.unblocks && input.unblocks.length > 0) payload.unblocks = input.unblocks;
  return {
    roomId: input.roomId,
    messageId: randomUUID(),
    traceId: randomUUID(),
    idempotencyKey: randomUUID(),
    from: input.from,
    kind: "task_completed",
    payload,
    timestamp: now,
    deliveryMode: "store_if_offline",
  };
}

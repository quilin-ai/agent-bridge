import { randomUUID } from "node:crypto";

import type { BridgeMessage } from "./types";

// Per-process salt + monotonic counter for status_summary ids.
//
// The summary id is used as the dedup key by ClaudeAdapter.rememberDelivery
// (claude-adapter.ts). Using `Date.now()` alone collides when two summaries
// flush within the same millisecond — the second is silently suppressed as a
// "duplicate". The salt makes ids unique ACROSS processes/restarts (so a fresh
// process never re-emits an id a previous process used inside the dedup TTL),
// and the monotonic counter makes ids unique WITHIN a process (no same-ms
// collision). This mirrors the monotonic id discipline #313 applied to the
// system message ids in bridge.ts / daemon.ts.
const STATUS_SUMMARY_SALT = randomUUID().slice(0, 8);
let statusSummaryCounter = 0;

export type MarkerLevel = "important" | "status" | "fyi" | "untagged";
export type FilterMode = "filtered" | "full";

export interface FilterResult {
  action: "forward" | "buffer" | "drop";
  marker: MarkerLevel;
}

export interface RouteCodexMessageContext {
  mode: FilterMode;
  replyArmed: boolean;
  inAttentionWindow: boolean;
}

export interface RouteCodexMessageResult extends FilterResult {
  reason: "forward" | "buffer" | "drop" | "buffer-attention" | "force-forward-reply-required";
  flushStatusBuffer?: boolean;
  startAttentionWindow?: boolean;
  noteReplyForwarded?: boolean;
}

const MARKER_REGEX = /^\s*\[(IMPORTANT|STATUS|FYI)\]\s*/i;

export function parseMarker(content: string): { marker: MarkerLevel; body: string } {
  const match = content.match(MARKER_REGEX);
  if (!match) return { marker: "untagged", body: content };
  return {
    marker: match[1].toLowerCase() as MarkerLevel,
    body: content.slice(match[0].length),
  };
}

export function classifyMessage(content: string, mode: FilterMode): FilterResult {
  if (mode === "full") return { action: "forward", marker: "untagged" };
  const { marker } = parseMarker(content);
  switch (marker) {
    case "important":
      return { action: "forward", marker };
    case "status":
      return { action: "buffer", marker };
    case "fyi":
      return { action: "drop", marker };
    case "untagged":
      return { action: "forward", marker };
  }
}

export function routeCodexMessage(
  content: string,
  ctx: RouteCodexMessageContext,
): RouteCodexMessageResult {
  const result = classifyMessage(content, ctx.mode);

  if (ctx.replyArmed) {
    return {
      action: "forward",
      marker: result.marker,
      reason: "force-forward-reply-required",
      flushStatusBuffer: true,
      noteReplyForwarded: true,
    };
  }

  if (ctx.inAttentionWindow && result.marker === "status") {
    return {
      action: "buffer",
      marker: result.marker,
      reason: "buffer-attention",
    };
  }

  if (result.action === "forward" && result.marker === "important") {
    return {
      ...result,
      reason: "forward",
      flushStatusBuffer: true,
      startAttentionWindow: true,
    };
  }

  return {
    ...result,
    reason: result.action,
  };
}

// NOTE: the static "bridge contract" (message markers, git-write prohibition,
// Codex role guidance) used to be appended to EVERY claude→codex message here.
// It now lives once in AGENTS_MD_SECTION (src/collaboration-content.ts), injected
// into the project's AGENTS.md by `abg init` and loaded by Codex on startup.
// Appending it per-message polluted every Codex thread + its resume title, so it
// was removed. AGENTS.md is the single source of truth for that contract now.
// Only the DYNAMIC, per-message reply-required instruction remains here.
const REPLY_REQUIRED_INSTRUCTION = `\n\n[⚠️ REPLY REQUIRED] Claude has explicitly requested a reply. You MUST send an agentMessage with [IMPORTANT] marker containing your response. This is a mandatory requirement — do not skip or use [STATUS]/[FYI] markers for this reply.`;

export { REPLY_REQUIRED_INSTRUCTION };

export class StatusBuffer {
  private buffer: BridgeMessage[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly flushThreshold: number;
  private readonly flushTimeoutMs: number;
  private readonly maxBuffered: number;
  private paused = false;
  // Number of oldest STATUS updates dropped because the buffer hit maxBuffered
  // (e.g. a long attention window with auto-flush paused). Surfaced in the next
  // summary so the drop is observable rather than silent, then reset on flush.
  private droppedCount = 0;

  constructor(
    private readonly onFlush: (summary: BridgeMessage) => void,
    options?: { flushThreshold?: number; flushTimeoutMs?: number; maxBuffered?: number },
  ) {
    this.flushThreshold = options?.flushThreshold ?? 3;
    this.flushTimeoutMs = options?.flushTimeoutMs ?? 15000;
    // Upper bound on retained STATUS updates. Mirrors the bounded buffers on
    // the daemon side (bufferedMessages / pendingBackpressure) so a paused
    // buffer cannot grow without limit during a long attention window.
    this.maxBuffered = options?.maxBuffered ?? 200;
  }

  get size(): number {
    return this.buffer.length;
  }

  /** Pause automatic flushing (threshold + timeout). Manual flush() still works. */
  pause(): void {
    this.paused = true;
    this.clearTimer();
  }

  /** Resume automatic flushing. Restarts timer if buffer has content. */
  resume(): void {
    this.paused = false;
    if (this.buffer.length > 0) {
      this.resetTimer();
      if (this.buffer.length >= this.flushThreshold) {
        this.flush("threshold reached after resume");
      }
    }
  }

  add(message: BridgeMessage): void {
    this.buffer.push(message);
    // Enforce the upper bound regardless of pause state: drop the OLDEST so the
    // most recent STATUS context is preserved. Track how many we shed so the
    // next summary can report it instead of dropping silently.
    while (this.buffer.length > this.maxBuffered) {
      this.buffer.shift();
      this.droppedCount++;
    }
    if (this.paused) return; // Don't auto-flush while paused
    this.resetTimer();
    if (this.buffer.length >= this.flushThreshold) {
      this.flush("threshold reached");
    }
  }

  flush(reason: string): void {
    if (this.buffer.length === 0) return;
    this.clearTimer();
    const combined = this.buffer
      .map((m) => parseMarker(m.content).body)
      .join("\n---\n");
    const droppedNote =
      this.droppedCount > 0 ? `, ${this.droppedCount} older dropped` : "";
    const summary: BridgeMessage = {
      // Process-unique id (salt + monotonic counter): no same-ms collision
      // and no cross-process reuse, so the ClaudeAdapter deduper never
      // suppresses a distinct summary. timestamp below stays wall-clock.
      id: `status_summary_${STATUS_SUMMARY_SALT}_${++statusSummaryCounter}`,
      source: "codex",
      content: `[STATUS summary — ${this.buffer.length} update(s)${droppedNote}, flushed: ${reason}]\n${combined}`,
      timestamp: Date.now(),
    };
    // Clear AFTER calling onFlush — if the send fails, emitToClaude's
    // bufferedMessages fallback will still capture the summary. Clearing
    // first would lose messages when ws.send() throws on a closing socket.
    this.onFlush(summary);
    this.buffer = [];
    this.droppedCount = 0;
  }

  dispose(): void {
    this.clearTimer();
    this.buffer = [];
    this.droppedCount = 0;
  }

  private clearTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private resetTimer(): void {
    this.clearTimer();
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush("timeout");
    }, this.flushTimeoutMs);
  }
}

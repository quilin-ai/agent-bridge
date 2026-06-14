import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { DaemonClient } from "../daemon-client";
import { ResumeAckTracker } from "../budget/resume-ack-tracker";
import { routeResume } from "../budget/route-resume";
import type { ResumeScheduler } from "../budget/resume-injection-queue";

/**
 * Wiring tests for PR4 Claude-side auto-resume:
 *  - control-protocol ack_resume message round-trip (bridge -> daemon).
 *  - the SHARED routeResume dispatch the daemon installs: claude ->
 *    claudeResumeTracker.start, codex -> enqueueCodex (PR3 owns the Codex
 *    queue, untouched here). Importing the real routeResume (not a re-impl)
 *    means the test pins the daemon's actual routing, not a hand-copied rule.
 *  - daemon shutdown -> claudeResumeTracker.stop().
 */

// ── Fake scheduler (no real timers; hermetic) ──────────────────
function fakeScheduler(): ResumeScheduler {
  let nextId = 1;
  const timers = new Map<number, () => void>();
  return {
    setTimeout(cb: () => void) {
      const id = nextId++;
      timers.set(id, cb);
      return id;
    },
    clearTimeout(timer: unknown) {
      if (typeof timer === "number") timers.delete(timer);
    },
  };
}

// ── control-protocol ack_resume round-trip ─────────────────────
let server: ReturnType<typeof Bun.serve> | null = null;
let serverPort = 0;
let client: DaemonClient;
let serverSockets: Set<any>;
let onServerMessage: (ws: any, raw: string | Buffer) => void = () => {};

function startServer() {
  serverSockets = new Set();
  const srv = Bun.serve({
    port: 0,
    fetch(req, s) {
      if (s.upgrade(req)) return undefined;
      return new Response("ok");
    },
    websocket: {
      open(ws: any) {
        serverSockets.add(ws);
      },
      message(ws: any, raw: any) {
        onServerMessage(ws, raw);
      },
      close(ws: any) {
        serverSockets.delete(ws);
      },
    },
  });
  server = srv;
  serverPort = srv.port as number;
}

function stopServer() {
  if (server) {
    server.stop(true);
    server = null;
  }
}

describe("control-protocol ack_resume round-trip (bridge -> daemon)", () => {
  beforeEach(() => {
    onServerMessage = () => {};
    startServer();
    client = new DaemonClient(`ws://127.0.0.1:${serverPort}/ws`);
  });

  afterEach(async () => {
    await client.disconnect();
    stopServer();
  });

  test("sendAckResume emits an ack_resume control message carrying resumeId + status", async () => {
    await client.connect();

    const received = new Promise<any>((resolve) => {
      onServerMessage = (_ws, raw) => {
        resolve(JSON.parse(typeof raw === "string" ? raw : raw.toString()));
      };
    });

    client.sendAckResume("system_budget_resume_9", "resumed");

    const msg = await received;
    expect(msg.type).toBe("ack_resume");
    expect(msg.resumeId).toBe("system_budget_resume_9");
    expect(msg.status).toBe("resumed");
  });
});

// ── routeResume dispatch contract (the SHARED daemon routing) ───
//
// These tests import the REAL routeResume the daemon installs, so the contract
// they pin is the daemon's actual dispatch — not a re-implemented copy that
// could drift. `side` is always a concrete AgentName (codex | claude); the
// coordinator iterates recoveredSides, so "both" is never passed (a joint
// recovery is two distinct calls — see the both-sides test below).
describe("routeResume(side, resumeId, deps) — shared daemon dispatch", () => {
  test("side=claude starts the Claude tracker and does NOT enqueue Codex", () => {
    const codexEnqueued: string[] = [];
    const pushes: string[] = [];
    const tracker = new ResumeAckTracker({
      push: (e: { resumeId: string }) => pushes.push(e.resumeId),
      scheduler: fakeScheduler(),
      timeoutMs: 60_000,
      retries: 3,
    });

    routeResume("claude", "rid_claude", {
      claudeTracker: tracker,
      enqueueCodex: (rid) => codexEnqueued.push(rid),
    });

    expect(tracker.get("rid_claude")?.state).toBe("awaiting_ack");
    expect(pushes).toContain("rid_claude");
    expect(codexEnqueued).toHaveLength(0);
    tracker.stop();
  });

  test("side=codex enqueues Codex and does NOT touch the Claude tracker (PR3 owns the queue)", () => {
    const codexEnqueued: string[] = [];
    const tracker = new ResumeAckTracker({
      push: () => {},
      scheduler: fakeScheduler(),
      timeoutMs: 60_000,
      retries: 3,
    });

    routeResume("codex", "rid_codex", {
      claudeTracker: tracker,
      enqueueCodex: (rid) => codexEnqueued.push(rid),
    });

    expect(tracker.size).toBe(0); // Claude tracker untouched
    expect(codexEnqueued).toEqual(["rid_codex"]);
    tracker.stop();
  });

  test("both-sides recovery = two independent routeResume calls (distinct resumeIds)", () => {
    // The coordinator never passes "both": a joint recovery iterates
    // recoveredSides = ["codex", "claude"] and calls routeResume once per side
    // with its OWN resumeId. Codex enqueues exactly once; Claude starts exactly
    // once — neither cross-contaminates the other.
    const codexEnqueued: string[] = [];
    const tracker = new ResumeAckTracker({
      push: () => {},
      scheduler: fakeScheduler(),
      timeoutMs: 60_000,
      retries: 3,
    });
    const deps = {
      claudeTracker: tracker,
      enqueueCodex: (rid: string) => codexEnqueued.push(rid),
    };

    routeResume("codex", "rid_codex_side", deps);
    routeResume("claude", "rid_claude_side", deps);

    expect(codexEnqueued).toEqual(["rid_codex_side"]); // Codex enqueued once
    expect(tracker.size).toBe(1); // Claude tracker has exactly one entry
    expect(tracker.get("rid_claude_side")?.state).toBe("awaiting_ack");
    expect(tracker.get("rid_codex_side")).toBeUndefined(); // codex rid not in Claude tracker
    tracker.stop();
  });
});

describe("setResumeAckHandler wiring -> tracker.ack", () => {
  test("the ack handler the daemon wires resolves the awaiting entry", () => {
    const tracker = new ResumeAckTracker({
      push: () => {},
      scheduler: fakeScheduler(),
      timeoutMs: 60_000,
      retries: 3,
    });
    tracker.start("rid_wire");

    // daemon wires setResumeAckHandler -> (resumeId) => tracker.ack(resumeId)
    const ackHandler = (resumeId: string, _status: string) => tracker.ack(resumeId);
    ackHandler("rid_wire", "resumed");

    // ack resolves and DELETES the terminal entry (map hygiene): the re-push
    // loop is stopped and the map is empty.
    expect(tracker.get("rid_wire")).toBeUndefined();
    expect(tracker.size).toBe(0);
    tracker.stop();
  });
});

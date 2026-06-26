import { describe, test, expect } from "bun:test";
import { renderRoomEvent, renderWhiteboard } from "../room-bridge";
import { buildTaskCompletedEnvelope } from "../task-completed";
import { buildPresenceEnvelope } from "../presence";
import type { Envelope } from "../backbone/envelope";

describe("renderRoomEvent — broker Envelope → one-line Claude notice", () => {
  test("task_completed: summary + repo@branch commit + unblocks", () => {
    const env = buildTaskCompletedEnvelope({
      roomId: "r1",
      from: { agentId: "bob@x.com", agentType: "codex" },
      summary: "auth contract landed",
      repo: "app",
      branch: "main",
      commit: "abc123",
      unblocks: ["alice@x.com"],
    });
    const text = renderRoomEvent(env)!;
    expect(text).toContain("🏁");
    expect(text).toContain("bob@x.com"); // task_completed has no displayName ⇒ agentId
    expect(text).toContain("auth contract landed");
    expect(text).toContain("app@main");
    expect(text).toContain("abc123");
    expect(text).toContain("解锁: alice@x.com");
  });

  test("task_completed: minimal (summary only) omits the location parens and unblocks", () => {
    const env = buildTaskCompletedEnvelope({
      roomId: "r1",
      from: { agentId: "bob@x.com", agentType: "codex" },
      summary: "done",
    });
    const text = renderRoomEvent(env)!;
    expect(text).toBe("🏁 bob@x.com 完成任务：done");
  });

  test("member_joined: uses displayName + host when present", () => {
    const env = buildPresenceEnvelope({
      kind: "member_joined",
      roomId: "r1",
      agentId: "alice@x.com",
      displayName: "Alice",
      meta: { host: "tailnet-1" },
    });
    expect(renderRoomEvent(env)).toBe("👋 Alice 加入房间（tailnet-1）");
  });

  test("member_left: displayName, no host", () => {
    const env = buildPresenceEnvelope({ kind: "member_left", roomId: "r1", agentId: "alice@x.com", displayName: "Alice" });
    expect(renderRoomEvent(env)).toBe("👋 Alice 离开房间");
  });

  test("unknown kinds are not rendered (null, never a raw payload dump)", () => {
    const env: Envelope = {
      roomId: "r1",
      messageId: "m",
      traceId: "t",
      idempotencyKey: "k",
      from: { agentId: "x", agentType: "claude" },
      kind: "some_future_kind",
      payload: { secret: "leak" },
      timestamp: 1,
      deliveryMode: "online_only",
    };
    expect(renderRoomEvent(env)).toBeNull();
  });

  test("renderWhiteboard summarizes counts + recent items; empty/absent ⇒ null", () => {
    expect(renderWhiteboard(null)).toBeNull();
    expect(renderWhiteboard("nope")).toBeNull();
    expect(
      renderWhiteboard({ contractsReady: [], inProgress: [], blockers: [], recentMilestones: [] }),
    ).toBeNull();
    const text = renderWhiteboard({
      contractsReady: [{ contract: "auth/v1" }, { contract: "checkout/v1" }],
      inProgress: [{ summary: "x" }],
      blockers: [],
      recentMilestones: [{ summary: "auth done" }, { summary: "checkout shipped" }],
    })!;
    expect(text).toContain("📋 房间白板");
    expect(text).toContain("已就绪契约 2");
    expect(text).toContain("auth/v1");
    expect(text).toContain("进行中 1");
    expect(text).toContain("checkout shipped");
  });

  test("label falls back from.name → payload.displayName → agentId → 某成员", () => {
    const base = {
      roomId: "r1",
      messageId: "m",
      traceId: "t",
      idempotencyKey: "k",
      kind: "member_left" as const,
      timestamp: 1,
      deliveryMode: "online_only" as const,
    };
    expect(renderRoomEvent({ ...base, from: { agentId: "id", agentType: "c", name: "Named" }, payload: {} })).toBe(
      "👋 Named 离开房间",
    );
    expect(renderRoomEvent({ ...base, from: { agentId: "id", agentType: "c" }, payload: { displayName: "DN" } })).toBe(
      "👋 DN 离开房间",
    );
    expect(renderRoomEvent({ ...base, from: { agentId: "id", agentType: "c" }, payload: {} })).toBe("👋 id 离开房间");
  });
});

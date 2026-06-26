import { describe, test, expect } from "bun:test";
import { buildTaskCompletedEnvelope } from "../task-completed";

describe("buildTaskCompletedEnvelope (§3.3 / Appendix A)", () => {
  test("assembles a broadcast store_if_offline task_completed with a full payload", () => {
    const env = buildTaskCompletedEnvelope({
      roomId: "r1",
      from: { agentId: "ag-1", agentType: "claude" },
      summary: "auth contract landed",
      repo: "app",
      branch: "main",
      commit: "abc123",
      contract: "auth/v1",
      unblocks: ["ag-3", "topic:checkout"],
      now: () => 42,
    });
    expect(env.roomId).toBe("r1");
    expect(env.kind).toBe("task_completed");
    expect(env.deliveryMode).toBe("store_if_offline");
    expect(env.to).toBeUndefined(); // broadcast, not a DM
    expect(env.timestamp).toBe(42);
    expect(env.from).toEqual({ agentId: "ag-1", agentType: "claude" });
    expect(env.payload).toEqual({
      summary: "auth contract landed",
      repo: "app",
      branch: "main",
      commit: "abc123",
      contract: "auth/v1",
      unblocks: ["ag-3", "topic:checkout"],
    });
    expect(typeof env.idempotencyKey).toBe("string");
    expect(typeof env.traceId).toBe("string");
    expect(typeof env.messageId).toBe("string");
  });

  test("omits absent optional fields and an empty unblocks list", () => {
    const env = buildTaskCompletedEnvelope({
      roomId: "r1",
      from: { agentId: "ag-1", agentType: "claude" },
      summary: "done",
      unblocks: [],
    });
    expect(env.payload).toEqual({ summary: "done" });
  });
});

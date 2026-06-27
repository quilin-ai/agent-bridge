import { describe, expect, test } from "bun:test";
import { ClaudeAdapter } from "../claude-adapter";

// The MCP Server stores wrapped request handlers in a Map keyed by JSON-RPC method.
// Invoking them directly drives ListTools / CallTool without a transport (same seam
// as claude-adapter-resume.test.ts).
function callTool(adapter: any, name: string, args?: Record<string, unknown>) {
  const handler = adapter.server._requestHandlers.get("tools/call");
  return handler({ method: "tools/call", params: { name, arguments: args ?? {} } }, {});
}

const textOf = (res: any) => res.content.map((c: any) => c.text).join("\n");

describe("room_say MCP tool — agent → room (§5)", () => {
  function withSender() {
    const adapter = new ClaudeAdapter() as any;
    const calls: Array<{ text: string; mentions?: string[] }> = [];
    adapter.setRoomMessageSender(async (text: string, mentions?: string[]) => {
      calls.push({ text, mentions });
      return { success: true };
    });
    return { adapter, calls };
  }

  test("all=true maps to the wildcard mention ['*'] (@所有人)", async () => {
    const { adapter, calls } = withSender();
    const res = await callTool(adapter, "room_say", { text: "全员注意", all: true });
    expect(res.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].mentions).toEqual(["*"]);
    expect(textOf(res)).toContain("@所有人");
  });

  test("to=[ids] maps straight to mentions (specific @, not owner-gated here)", async () => {
    const { adapter, calls } = withSender();
    await callTool(adapter, "room_say", { text: "看下", to: ["bob@x.com", "carol@x.com"] });
    expect(calls[0].mentions).toEqual(["bob@x.com", "carol@x.com"]);
  });

  test("all wins over to (takes precedence)", async () => {
    const { adapter, calls } = withSender();
    await callTool(adapter, "room_say", { text: "x", to: ["bob@x.com"], all: true });
    expect(calls[0].mentions).toEqual(["*"]);
  });

  test("no to/all → undefined mentions (plain room broadcast)", async () => {
    const { adapter, calls } = withSender();
    await callTool(adapter, "room_say", { text: "大家好" });
    expect(calls[0].mentions).toBeUndefined();
  });

  test("empty/whitespace text is rejected and the sender is NOT called", async () => {
    const { adapter, calls } = withSender();
    const res = await callTool(adapter, "room_say", { text: "   " });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("a non-string / empty member in `to` is rejected before sending", async () => {
    const { adapter, calls } = withSender();
    const res = await callTool(adapter, "room_say", { text: "hi", to: ["bob@x.com", ""] });
    expect(res.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("a sender failure (e.g. not in a room) surfaces as an error to the agent", async () => {
    const adapter = new ClaudeAdapter() as any;
    adapter.setRoomMessageSender(async () => ({ success: false, error: "未接入房间（room bridge 未启动）" }));
    const res = await callTool(adapter, "room_say", { text: "hi" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("未接入房间");
  });

  test("no sender registered → clean error, never a throw", async () => {
    const adapter = new ClaudeAdapter() as any;
    const res = await callTool(adapter, "room_say", { text: "hi" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("bridge not initialized");
  });
});

describe("room_members MCP tool — room roster (§5)", () => {
  test("renders the roster and marks the owner + self", async () => {
    const adapter = new ClaudeAdapter() as any;
    adapter.setRoomMembersProvider(async () => ({
      members: ["alice@x.com", "bob@x.com", "carol@x.com"],
      ownerId: "alice@x.com",
      self: "bob@x.com",
    }));
    const res = await callTool(adapter, "room_members", {});
    const t = textOf(res);
    expect(t).toContain("房间成员（3）");
    expect(t).toContain("alice@x.com（房主）");
    expect(t).toContain("bob@x.com（你）");
    expect(t).toContain("carol@x.com"); // a plain member has no tag
    expect(t).toContain("只有房主能 @所有人");
  });

  test("self that is ALSO the owner is tagged with both", async () => {
    const adapter = new ClaudeAdapter() as any;
    adapter.setRoomMembersProvider(async () => ({
      members: ["alice@x.com", "bob@x.com"],
      ownerId: "alice@x.com",
      self: "alice@x.com",
    }));
    expect(textOf(await callTool(adapter, "room_members", {}))).toContain("alice@x.com（房主·你）");
  });

  test("a transport failure (null) reports unavailable, never throws", async () => {
    const adapter = new ClaudeAdapter() as any;
    adapter.setRoomMembersProvider(async () => null);
    const res = await callTool(adapter, "room_members", {});
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("暂不可用");
  });

  test("an error result (e.g. not in a room) reports the reason", async () => {
    const adapter = new ClaudeAdapter() as any;
    adapter.setRoomMembersProvider(async () => ({ members: null, ownerId: null, self: null, error: "未接入房间（未登录或当前目录未映射到房间）" }));
    const res = await callTool(adapter, "room_members", {});
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("未接入房间");
  });

  test("an empty room renders a no-members notice", async () => {
    const adapter = new ClaudeAdapter() as any;
    adapter.setRoomMembersProvider(async () => ({ members: [], ownerId: "", self: "" }));
    expect(textOf(await callTool(adapter, "room_members", {}))).toContain("没有成员");
  });

  test("no provider registered → clean error, never a throw", async () => {
    const adapter = new ClaudeAdapter() as any;
    const res = await callTool(adapter, "room_members", {});
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("bridge not initialized");
  });
});

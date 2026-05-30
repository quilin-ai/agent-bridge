import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { pairScopedCommand } from "../pair-command";

describe("pairScopedCommand", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.AGENTBRIDGE_PAIR_ID;
    delete process.env.AGENTBRIDGE_PAIR_ID;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.AGENTBRIDGE_PAIR_ID;
    else process.env.AGENTBRIDGE_PAIR_ID = saved;
  });

  test("legacy/manual mode (no AGENTBRIDGE_PAIR_ID) → bare command", () => {
    expect(pairScopedCommand("codex")).toBe("agentbridge codex");
    expect(pairScopedCommand("claude")).toBe("agentbridge claude");
    expect(pairScopedCommand("kill")).toBe("agentbridge kill");
  });

  test("pair mode → injects --pair <id> right after the subcommand", () => {
    process.env.AGENTBRIDGE_PAIR_ID = "work";
    expect(pairScopedCommand("codex")).toBe("agentbridge codex --pair work");
    expect(pairScopedCommand("claude")).toBe("agentbridge claude --pair work");
    expect(pairScopedCommand("kill")).toBe("agentbridge kill --pair work");
  });

  test("--pair is placed before the subcommand's own extra args", () => {
    process.env.AGENTBRIDGE_PAIR_ID = "review";
    expect(pairScopedCommand("claude --resume")).toBe("agentbridge claude --pair review --resume");
  });

  test("an empty-string AGENTBRIDGE_PAIR_ID is treated as unset (no --pair)", () => {
    process.env.AGENTBRIDGE_PAIR_ID = "";
    expect(pairScopedCommand("codex")).toBe("agentbridge codex");
  });

  test("a cwd-derived id (with a hash suffix) renders verbatim", () => {
    process.env.AGENTBRIDGE_PAIR_ID = "myproj-1a2b3c4d";
    expect(pairScopedCommand("codex")).toBe("agentbridge codex --pair myproj-1a2b3c4d");
  });
});

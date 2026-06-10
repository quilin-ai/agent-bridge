import { describe, expect, test } from "bun:test";
import { CLOSE_CODE_PAIR_MISMATCH } from "../control-protocol";
import { validateClaudeClientIdentity } from "../daemon-identity";

describe("daemon Claude identity admission", () => {
  test("pair daemon rejects identity-less Claude clients by default", async () => {
    const result = validateClaudeClientIdentity({
      expectedPairId: "main-12345678",
      daemonCwd: "/tmp/project",
      identity: undefined,
      allowIdentityless: false,
    });

    expect(result).toEqual({
      ok: false,
      closeCode: CLOSE_CODE_PAIR_MISMATCH,
      reason: "missing client identity",
    });
  });

  test("pair daemon rejects pairId and cwd mismatches", () => {
    expect(validateClaudeClientIdentity({
      expectedPairId: "main-12345678",
      daemonCwd: "/tmp/project",
      identity: { pairId: "other-aaaaaaaa", cwd: "/tmp/project" },
      allowIdentityless: false,
    }).ok).toBe(false);

    expect(validateClaudeClientIdentity({
      expectedPairId: "main-12345678",
      daemonCwd: "/tmp/project",
      identity: { pairId: "main-12345678", cwd: "/tmp/other" },
      allowIdentityless: false,
    }).ok).toBe(false);
  });

  test("matching identity or explicit compat passes", () => {
    expect(validateClaudeClientIdentity({
      expectedPairId: "main-12345678",
      daemonCwd: "/tmp/project",
      identity: { pairId: "main-12345678", cwd: "/tmp/project" },
      allowIdentityless: false,
    }).ok).toBe(true);

    expect(validateClaudeClientIdentity({
      expectedPairId: "main-12345678",
      daemonCwd: "/tmp/project",
      identity: undefined,
      allowIdentityless: true,
    }).ok).toBe(true);
  });
});

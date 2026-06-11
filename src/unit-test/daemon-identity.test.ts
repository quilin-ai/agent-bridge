import { describe, expect, test } from "bun:test";
import {
  CLOSE_CODE_CONTRACT_MISMATCH,
  CLOSE_CODE_PAIR_MISMATCH,
  CLOSE_CODE_TOKEN_MISMATCH,
} from "../control-protocol";
import {
  evaluateInjectionAttachGuard,
  validateClaudeClientIdentity,
} from "../daemon-identity";

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

describe("control-token admission gate (arch-review P1 #283)", () => {
  const goodIdentity = (controlToken?: string | null) => ({
    pairId: "main-12345678",
    cwd: "/tmp/project",
    ...(controlToken !== undefined ? { controlToken } : {}),
  });

  test("token correct + identity correct → admitted", () => {
    const result = validateClaudeClientIdentity({
      expectedPairId: "main-12345678",
      daemonCwd: "/tmp/project",
      identity: goodIdentity("the-secret-token"),
      allowIdentityless: false,
      expectedControlToken: "the-secret-token",
    });
    expect(result.ok).toBe(true);
  });

  test("token missing while the daemon expects one → rejected with TOKEN_MISMATCH (4005)", () => {
    const result = validateClaudeClientIdentity({
      expectedPairId: "main-12345678",
      daemonCwd: "/tmp/project",
      identity: goodIdentity(undefined), // pair/cwd correct, but NO token
      allowIdentityless: false,
      expectedControlToken: "the-secret-token",
    });
    expect(result).toEqual({
      ok: false,
      closeCode: CLOSE_CODE_TOKEN_MISMATCH,
      reason: "missing control token",
    });
  });

  test("token wrong → rejected with TOKEN_MISMATCH even when pair/cwd are correct", () => {
    const result = validateClaudeClientIdentity({
      expectedPairId: "main-12345678",
      daemonCwd: "/tmp/project",
      identity: goodIdentity("attacker-guess"),
      allowIdentityless: false,
      expectedControlToken: "the-secret-token",
    });
    expect(result).toEqual({
      ok: false,
      closeCode: CLOSE_CODE_TOKEN_MISMATCH,
      reason: "control token mismatch",
    });
  });

  test("token gate runs BEFORE pair/cwd — a wrong token is rejected as TOKEN_MISMATCH", () => {
    // Even with a wrong pairId, the token gate (first) decides the close code, so
    // the failure is unambiguously attributable to the token.
    const result = validateClaudeClientIdentity({
      expectedPairId: "main-12345678",
      daemonCwd: "/tmp/project",
      identity: { pairId: "other-aaaaaaaa", cwd: "/tmp/elsewhere", controlToken: "wrong" },
      allowIdentityless: false,
      expectedControlToken: "the-secret-token",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.closeCode).toBe(CLOSE_CODE_TOKEN_MISMATCH);
  });

  test("token enforced even in legacy mode (no expectedPairId) — arbitrary socket without token is rejected", () => {
    const result = validateClaudeClientIdentity({
      expectedPairId: null,
      daemonCwd: "/tmp/project",
      identity: { controlToken: undefined }, // no token presented
      allowIdentityless: false,
      expectedControlToken: "legacy-secret",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.closeCode).toBe(CLOSE_CODE_TOKEN_MISMATCH);

    // The legitimate legacy client that read the token is admitted.
    expect(validateClaudeClientIdentity({
      expectedPairId: null,
      daemonCwd: "/tmp/project",
      identity: { controlToken: "legacy-secret" },
      allowIdentityless: false,
      expectedControlToken: "legacy-secret",
    }).ok).toBe(true);
  });

  test("expectedControlToken null disables the gate (older daemon / write failure) — compat", () => {
    const result = validateClaudeClientIdentity({
      expectedPairId: "main-12345678",
      daemonCwd: "/tmp/project",
      identity: goodIdentity(undefined),
      allowIdentityless: false,
      expectedControlToken: null,
    });
    expect(result.ok).toBe(true);
  });

  test("identityless compat escape hatch bypasses the token gate", () => {
    // AGENTBRIDGE_COMPAT_IDENTITYLESS: no identity object means no token can be
    // carried; the explicit operator opt-out must still admit.
    const result = validateClaudeClientIdentity({
      expectedPairId: "main-12345678",
      daemonCwd: "/tmp/project",
      identity: undefined,
      allowIdentityless: true,
      expectedControlToken: "the-secret-token",
    });
    expect(result.ok).toBe(true);
  });

  test("an identity-CARRYING client under the compat flag still must present the right token", () => {
    // The escape hatch only bypasses when identity is ABSENT. A client that sends
    // an identity (so it could carry a token) is held to the token gate.
    const result = validateClaudeClientIdentity({
      expectedPairId: "main-12345678",
      daemonCwd: "/tmp/project",
      identity: { pairId: "main-12345678", cwd: "/tmp/project", controlToken: "wrong" },
      allowIdentityless: true,
      expectedControlToken: "the-secret-token",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.closeCode).toBe(CLOSE_CODE_TOKEN_MISMATCH);
  });
});

describe("contract-version admission gate (arch-review P1 #303)", () => {
  // A fully-correct token+pair+cwd identity so the ONLY variable under test is
  // the contract version (everything before the contract gate already passes).
  const identity = (contractVersion?: number) => ({
    pairId: "main-12345678",
    cwd: "/tmp/project",
    controlToken: "the-secret-token",
    ...(contractVersion !== undefined ? { contractVersion } : {}),
  });

  const baseInput = {
    expectedPairId: "main-12345678",
    daemonCwd: "/tmp/project",
    allowIdentityless: false,
    expectedControlToken: "the-secret-token",
    expectedContractVersion: 1,
  };

  test("matching contract version → admitted", () => {
    const result = validateClaudeClientIdentity({ ...baseInput, identity: identity(1) });
    expect(result.ok).toBe(true);
  });

  test("missing contractVersion (daemon expects one) → rejected with CONTRACT_MISMATCH (4006)", () => {
    const result = validateClaudeClientIdentity({ ...baseInput, identity: identity(undefined) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.closeCode).toBe(CLOSE_CODE_CONTRACT_MISMATCH);
      expect(result.reason).toContain("missing contract version");
    }
  });

  test("null contractVersion is treated as missing → 4006", () => {
    // A JSON wire payload can deliver `contractVersion: null`; the validator must
    // treat null exactly like an absent version. The field type is `number?`, so
    // the null is constructed via a typed-loophole to mirror real wire data.
    const result = validateClaudeClientIdentity({
      ...baseInput,
      identity: {
        pairId: "main-12345678",
        cwd: "/tmp/project",
        controlToken: "the-secret-token",
        contractVersion: null as unknown as number,
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.closeCode).toBe(CLOSE_CODE_CONTRACT_MISMATCH);
  });

  test("mismatched contractVersion → rejected with 4006", () => {
    const result = validateClaudeClientIdentity({ ...baseInput, identity: identity(2) });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.closeCode).toBe(CLOSE_CODE_CONTRACT_MISMATCH);
      expect(result.reason).toContain("contract version mismatch");
    }
  });

  test("expectedContractVersion undefined disables the gate (older daemon) — compat", () => {
    const result = validateClaudeClientIdentity({
      ...baseInput,
      expectedContractVersion: undefined,
      identity: identity(undefined), // no version at all, but gate is off
    });
    expect(result.ok).toBe(true);
  });

  // --- Priority: 4004 (pair/cwd) > 4005 (token) > 4006 (contract), contract LAST ---

  test("PRIORITY: pair mismatch wins over a (correct) contract version → 4004, not 4006", () => {
    const result = validateClaudeClientIdentity({
      ...baseInput,
      identity: {
        pairId: "other-aaaaaaaa", // wrong pair
        cwd: "/tmp/elsewhere",
        controlToken: "the-secret-token",
        contractVersion: 1, // correct contract — but pair fails first
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.closeCode).toBe(CLOSE_CODE_PAIR_MISMATCH);
  });

  test("PRIORITY: token mismatch wins over a missing/wrong contract version → 4005, not 4006", () => {
    // BOTH the token AND the contract are wrong; the token gate runs first, so a
    // contract error must NOT mask the (more fundamental) token failure.
    const result = validateClaudeClientIdentity({
      ...baseInput,
      identity: {
        pairId: "main-12345678",
        cwd: "/tmp/project",
        controlToken: "attacker-guess", // wrong token
        contractVersion: 999, // also wrong contract
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.closeCode).toBe(CLOSE_CODE_TOKEN_MISMATCH);
  });

  test("PRIORITY: contract is checked LAST — a wrong contract with everything else correct → 4006", () => {
    // Pair/cwd/token all pass; only the contract is wrong. The contract gate is
    // the final word, proving it runs after (not before) the other gates.
    const result = validateClaudeClientIdentity({ ...baseInput, identity: identity(7) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.closeCode).toBe(CLOSE_CODE_CONTRACT_MISMATCH);
  });

  // --- Backward-compat: identityless clients are exempt (mirror the token gate) ---

  test("identityless client is EXEMPT from the contract gate (legacy / COMPAT_IDENTITYLESS)", () => {
    const result = validateClaudeClientIdentity({
      ...baseInput,
      allowIdentityless: true,
      identity: undefined, // no identity → no version to negotiate
    });
    expect(result.ok).toBe(true);
  });

  test("legacy mode (no expectedPairId) still enforces the contract for identity-carrying clients", () => {
    // Token cleared, no pair enforcement, but the contract is wrong → 4006. This
    // mirrors the token gate which also fires in legacy mode for identity clients.
    const result = validateClaudeClientIdentity({
      expectedPairId: null,
      daemonCwd: "/tmp/project",
      allowIdentityless: false,
      expectedControlToken: "legacy-secret",
      expectedContractVersion: 1,
      identity: { controlToken: "legacy-secret", contractVersion: 2 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.closeCode).toBe(CLOSE_CODE_CONTRACT_MISMATCH);

    // The legitimate legacy client with the right token AND contract is admitted.
    expect(validateClaudeClientIdentity({
      expectedPairId: null,
      daemonCwd: "/tmp/project",
      allowIdentityless: false,
      expectedControlToken: "legacy-secret",
      expectedContractVersion: 1,
      identity: { controlToken: "legacy-secret", contractVersion: 1 },
    }).ok).toBe(true);
  });

  test("legacy identityless client carries no version → admitted unchanged", () => {
    const result = validateClaudeClientIdentity({
      expectedPairId: null,
      daemonCwd: "/tmp/project",
      allowIdentityless: false,
      expectedControlToken: null, // token gate off
      expectedContractVersion: 1,
      identity: undefined,
    });
    expect(result.ok).toBe(true);
  });
});

describe("injection attach-convergence guard (arch-review P1 #283)", () => {
  // Reference-identity sentinels stand in for the daemon's ServerWebSockets.
  const attached = { id: "attached" };
  const other = { id: "other" };

  test("the attached socket is allowed to inject", () => {
    expect(evaluateInjectionAttachGuard(attached, attached)).toEqual({ allowed: true });
  });

  test("a different (non-attached) socket is rejected with not_attached", () => {
    const result = evaluateInjectionAttachGuard(attached, other);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.code).toBe("not_attached");
      expect(result.reason).toContain("not the attached Claude session");
    }
  });

  test("no live frontend attached (null/undefined) rejects every injection", () => {
    expect(evaluateInjectionAttachGuard(null, other).allowed).toBe(false);
    expect(evaluateInjectionAttachGuard(undefined, other).allowed).toBe(false);
    // Even the socket itself cannot inject if it is not the recorded attached one.
    expect(evaluateInjectionAttachGuard(null, attached).allowed).toBe(false);
  });
});

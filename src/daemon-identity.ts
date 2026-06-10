import {
  CLOSE_CODE_PAIR_MISMATCH,
  type ControlClientIdentity,
} from "./control-protocol";

export interface ClaudeIdentityValidationInput {
  expectedPairId: string | null;
  daemonCwd: string;
  identity?: ControlClientIdentity;
  allowIdentityless?: boolean;
}

export type ClaudeIdentityValidationResult =
  | { ok: true }
  | { ok: false; closeCode: number; reason: string };

export function validateClaudeClientIdentity(
  input: ClaudeIdentityValidationInput,
): ClaudeIdentityValidationResult {
  if (!input.expectedPairId) return { ok: true };
  if (!input.identity) {
    return input.allowIdentityless
      ? { ok: true }
      : { ok: false, closeCode: CLOSE_CODE_PAIR_MISMATCH, reason: "missing client identity" };
  }
  if (input.identity.pairId !== input.expectedPairId) {
    return {
      ok: false,
      closeCode: CLOSE_CODE_PAIR_MISMATCH,
      reason: `pair mismatch: expected ${input.expectedPairId}, got ${input.identity.pairId ?? "<none>"}`,
    };
  }
  if (!input.identity.cwd || input.identity.cwd !== input.daemonCwd) {
    return {
      ok: false,
      closeCode: CLOSE_CODE_PAIR_MISMATCH,
      reason: `cwd mismatch: expected ${input.daemonCwd}, got ${input.identity.cwd ?? "<none>"}`,
    };
  }
  return { ok: true };
}

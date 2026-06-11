/**
 * Helper for integration tests to drop the parameterized fake `codex` binary
 * (see ./fake-codex.ts) onto a per-test PATH directory.
 *
 * The daemon resolves `codex` on PATH and spawns `codex app-server --listen …`.
 * Tests therefore write an executable `bin/codex` that re-execs the fixture
 * program under Bun, forwarding argv. The capability tier is baked into the
 * generated shim via `FAKE_CODEX_CAPABILITY` so the spawned process selects the
 * right protocol surface; tests still pass per-run wiring (command file, logs,
 * interrupt delay) through the daemon's spawn env, which the fixture reads.
 */

import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { FakeCodexCapability } from "./fake-codex";

/** Absolute path to the fake-codex fixture program. */
const FAKE_CODEX_PATH = fileURLToPath(new URL("./fake-codex.ts", import.meta.url));

export type { FakeCodexCapability };

/**
 * Write an executable `codex` shim into `binDir` that runs the shared fake-codex
 * fixture at the given capability tier. Returns the absolute path to the shim.
 *
 * The shim forwards all CLI args to the fixture and sets FAKE_CODEX_CAPABILITY
 * only when not already present in the environment, so a caller can still
 * override the tier via the daemon spawn env if needed.
 */
export function installFakeCodex(opts: { binDir: string; capability: FakeCodexCapability }): string {
  const { binDir, capability } = opts;
  const codexPath = join(binDir, "codex");
  // exec the fixture with the same Bun runtime, forwarding argv. `exec` replaces
  // the shell so the daemon's SIGTERM/SIGKILL reach the fixture process directly
  // (no intermediate shell holding the pid).
  const shim =
    "#!/usr/bin/env bash\n" +
    `export FAKE_CODEX_CAPABILITY="\${FAKE_CODEX_CAPABILITY:-${capability}}"\n` +
    `exec bun run ${JSON.stringify(FAKE_CODEX_PATH)} "$@"\n`;
  writeFileSync(codexPath, shim, "utf-8");
  chmodSync(codexPath, 0o755);
  return codexPath;
}

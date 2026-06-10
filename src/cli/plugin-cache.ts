import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { MARKETPLACE_NAME, PLUGIN_NAME } from "../cli";

/**
 * Single source of truth for the Claude Code plugin cache directory of this
 * plugin: `~/.claude/plugins/cache/<marketplace>/<plugin>`.
 *
 * Built from MARKETPLACE_NAME / PLUGIN_NAME (not hardcoded string literals) so
 * doctor's artifact-alignment check and the `abg claude` preflight resolve the
 * exact same path. `home` is injectable for tests.
 */
export function pluginCacheRoot(home: string = homedir()): string {
  return join(home, ".claude", "plugins", "cache", MARKETPLACE_NAME, PLUGIN_NAME);
}

/**
 * Detect whether we are running from a real AgentBridge repository checkout
 * (as opposed to a globally installed npm package). Uses the SAME signal as
 * `abg dev`: the published package does not ship the build scripts, so the
 * presence of `scripts/build-bundles.mjs` under the package root means "repo".
 *
 * `projectRoot` should be the result of findPackageRoot().
 */
export function isInsideRepoCheckout(projectRoot: string): boolean {
  const buildScript = resolve(projectRoot, "scripts", "build-bundles.mjs");
  return existsSync(buildScript);
}

/**
 * The three marketplace install steps, sourced verbatim from README.md
 * "Install via Plugin Marketplace". Used by init's failure fallback (npm-global
 * context) and the `abg claude` preflight warning so both stay in sync with the
 * documented marketplace name + plugin id.
 */
export const MARKETPLACE_STEPS: readonly string[] = [
  `/plugin marketplace add raysonmeng/agent-bridge`,
  `/plugin install ${PLUGIN_NAME}@${MARKETPLACE_NAME}`,
  `/reload-plugins`,
];

/**
 * Pure preflight decision for `abg claude`: given whether the plugin cache dir
 * exists, decide whether to emit the "plugin not installed" warning. Extracted
 * so the fail-open behaviour is unit-testable without touching a real HOME.
 */
export function shouldWarnMissingPluginCache(cacheExists: boolean): boolean {
  return !cacheExists;
}

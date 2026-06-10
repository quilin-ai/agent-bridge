import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { existsSync, cpSync, rmSync } from "node:fs";
import { MARKETPLACE_NAME, PLUGIN_NAME } from "../cli";
import { findPackageRoot, registerMarketplace } from "./pkg-root";
import { isInsideRepoCheckout, pluginCacheRoot } from "./plugin-cache";

export async function runDev(args: string[] = []) {
  console.log("AgentBridge Dev Setup\n");

  // Used by install-global.mjs, which has already run the full prepublishOnly build.
  const skipBuild = args.includes("--skip-build");

  const projectRoot = findPackageRoot();
  const marketplacePath = resolve(projectRoot, ".claude-plugin", "marketplace.json");
  const pluginDir = resolve(projectRoot, "plugins", "agentbridge");
  const pluginManifest = resolve(pluginDir, ".claude-plugin", "plugin.json");

  // Guard: `dev` only works inside a repository checkout. When invoked from a
  // globally installed package, findPackageRoot() resolves to the published
  // package directory, which does not ship the build scripts — fail with
  // guidance instead of a raw MODULE_NOT_FOUND from the build step. The same
  // repo-vs-npm-global signal is reused by init's plugin-install fallback.
  if (!isInsideRepoCheckout(projectRoot)) {
    console.error("  ERROR: 'agentbridge dev' must run inside an AgentBridge repository checkout —");
    console.error("  the published package does not ship the build scripts.");
    console.error("");
    console.error("    cd <agent_bridge repo> && bun src/cli.ts dev");
    console.error("");
    console.error("  Tip: from the repo, `bun run install:global` updates the global CLI");
    console.error("  AND syncs the Claude Code plugin in one step.");
    process.exit(1);
  }

  if (skipBuild) {
    console.log("Skipping builds (--skip-build: caller already built CLI + plugin)\n");
  } else {
    // Step 0a: Build CLI from source
    console.log("Building CLI from source...");
    const cliBuild = spawnSync("bun", ["run", "build:cli"], {
      cwd: projectRoot,
      stdio: "inherit",
    });
    if (cliBuild.status !== 0) {
      console.error("  ERROR: CLI build failed. Fix build errors and try again.");
      process.exit(1);
    }
    console.log("  ✓ CLI built successfully\n");

    // Step 0b: Build plugin bundles from source
    console.log("Building plugin from source...");
    const buildResult = spawnSync("bun", ["run", "build:plugin"], {
      cwd: projectRoot,
      stdio: "inherit",
    });
    if (buildResult.status !== 0) {
      console.error("  ERROR: Plugin build failed. Fix build errors and try again.");
      process.exit(1);
    }
    console.log("  ✓ Plugin built successfully\n");
  }

  // Step 1: Validate local plugin exists
  if (!existsSync(pluginManifest)) {
    console.error(`  ERROR: Plugin manifest not found at ${pluginManifest}`);
    console.error("  Run 'bun run build:plugin' first, or check your working tree.");
    process.exit(1);
  }
  if (!existsSync(marketplacePath)) {
    console.error(`  ERROR: Marketplace manifest not found at ${marketplacePath}`);
    process.exit(1);
  }
  console.log(`  Plugin source: ${pluginDir}`);

  // Step 2: Register local marketplace (idempotent — safe to call repeatedly)
  console.log("\nRegistering local marketplace...");
  try {
    registerMarketplace(projectRoot);
  } catch (e: any) {
    console.error(`  ERROR: Failed to register marketplace: ${e.message}`);
    process.exit(1);
  }

  // Step 3: Install plugin, then force-sync local files to cache
  const pluginRef = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
  console.log("\nInstalling plugin...");
  try {
    const listOutput = execFileSync("claude", ["plugin", "list"], { encoding: "utf-8" });
    if (!listOutput.includes(pluginRef)) {
      execFileSync("claude", ["plugin", "install", pluginRef], { stdio: "inherit" });
    } else {
      console.log(`  Plugin '${pluginRef}' already installed.`);
    }
  } catch (e: any) {
    console.error(`  ERROR: Failed to install plugin: ${e.message}`);
    process.exit(1);
  }

  // Step 4: Force-sync local plugin files to cache (bypasses version check)
  console.log("\nSyncing local plugin to cache...");
  const cacheDir = pluginCacheRoot();
  if (existsSync(cacheDir)) {
    // Find the version directory (e.g., 0.1.0)
    const versionDirs = Bun.spawnSync(["ls", cacheDir]).stdout.toString().trim().split("\n").filter(Boolean);
    for (const ver of versionDirs) {
      const targetDir = resolve(cacheDir, ver);
      // Remove old cached files and copy fresh ones
      rmSync(targetDir, { recursive: true, force: true });
      cpSync(pluginDir, targetDir, { recursive: true });
      console.log(`  Synced to ${targetDir}`);
    }
  } else {
    console.log("  Cache directory not found, plugin install should have created it.");
  }

  console.log("\n✅ Dev setup complete!\n");
  console.log("Next steps:");
  console.log("  agentbridge claude    # Start Claude Code (plugin auto-loaded)");
  console.log("  agentbridge codex     # Start Codex TUI");
  console.log("");
  console.log("Code changed? Run 'agentbridge dev' again, then restart Claude Code or /reload-plugins.");
}

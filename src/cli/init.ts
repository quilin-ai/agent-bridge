import { execSync, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigService } from "../config-service";
import { MARKETPLACE_NAME, PLUGIN_NAME } from "../cli";
import { findPackageRoot, registerMarketplace } from "./pkg-root";
import { isInsideRepoCheckout, MARKETPLACE_STEPS } from "./plugin-cache";
import { upsertMarkedSection } from "../marker-section";
import { compareVersions } from "../version-utils";
import {
  MARKER_ID,
  CLAUDE_MD_SECTION,
  AGENTS_MD_SECTION,
} from "../collaboration-content";

const MIN_CLAUDE_VERSION = "2.1.80";

export async function runInit() {
  console.log("AgentBridge Init\n");

  // Step 1: Check dependencies
  console.log("Checking dependencies...");
  checkBun();
  checkClaude();
  checkCodex();
  console.log("");

  // Step 2: Generate project config
  console.log("Generating project config...");
  const configService = new ConfigService();
  const created = configService.initDefaults();

  if (created.length > 0) {
    for (const file of created) {
      console.log(`  Created: ${file}`);
    }
  } else {
    console.log("  Project config already exists, skipping.");
  }
  console.log("");

  // Step 3: Write collaboration sections to CLAUDE.md and AGENTS.md
  console.log("Writing collaboration sections...");
  const projectRoot = process.cwd();
  const collabResults = writeCollaborationSections(projectRoot);
  for (const result of collabResults) {
    console.log(`  ${result}`);
  }
  console.log("");

  // Step 4: Register marketplace + install plugin (best-effort)
  console.log("Installing AgentBridge plugin...");
  let pluginInstalled = false;
  try {
    const packageRoot = findPackageRoot();
    registerMarketplace(packageRoot);
    execFileSync("claude", ["plugin", "install", `${PLUGIN_NAME}@${MARKETPLACE_NAME}`], {
      stdio: "inherit",
    });
    console.log("  Plugin installed successfully.");
    pluginInstalled = true;
  } catch {
    // Context-aware fallback: a global npm install (no repo build scripts)
    // cannot use `abg dev`, so point those users at the documented marketplace
    // steps instead. Only inside a repo checkout is `abg dev` the right path.
    // Detect context independently here so a findPackageRoot() failure above
    // (no package.json) is still treated as "not a repo" → marketplace steps.
    console.log("  Plugin install skipped (marketplace registration or install failed).");
    for (const line of pluginInstallFallbackGuidance(detectRepoCheckout())) {
      console.log(line);
    }
  }
  console.log("");

  // Step 5: Done — be honest about a failed plugin install instead of faking
  // success, and surface it to the shell via a non-zero exit code.
  if (pluginInstalled) {
    console.log("Setup complete!\n");
  } else {
    console.log("Setup incomplete — plugin not installed.\n");
    process.exitCode = 1;
  }
  console.log("Next steps:");
  console.log("  1. If Claude Code is already running, execute /reload-plugins in your session");
  console.log("  2. Start Claude Code:  agentbridge claude");
  console.log("  3. Start Codex TUI:    agentbridge codex");
}

/**
 * Best-effort repo-vs-npm-global detection for the failure fallback. If the
 * package root cannot be resolved at all (no package.json), treat it as a
 * non-repo install so the user gets the recoverable marketplace steps.
 */
function detectRepoCheckout(): boolean {
  try {
    return isInsideRepoCheckout(findPackageRoot());
  } catch {
    return false;
  }
}

/**
 * Guidance lines printed when step-4 plugin install fails. Repo checkouts can
 * recover with `abg dev`; global npm installs cannot (the published package
 * ships no build scripts), so those users get the README marketplace steps.
 * Pure + exported for unit testing.
 */
export function pluginInstallFallbackGuidance(insideRepo: boolean): string[] {
  if (insideRepo) {
    return [
      "  You can install it later with:",
      "    abg dev   # registers marketplace and installs plugin",
    ];
  }
  return [
    "  Install the plugin from Claude Code with these steps:",
    ...MARKETPLACE_STEPS.map((step) => `    ${step}`),
  ];
}

function checkBun() {
  try {
    const version = execSync("bun --version", { encoding: "utf-8" }).trim();
    console.log(`  bun: ${version}`);
  } catch {
    console.error("  ERROR: bun not found in PATH.");
    console.error("  Install Bun: https://bun.sh");
    process.exit(1);
  }
}

function checkClaude() {
  try {
    const versionOutput = execSync("claude --version", { encoding: "utf-8" }).trim();
    // Extract version number (may be in format "claude v2.1.80" or just "2.1.80")
    const match = versionOutput.match(/(\d+\.\d+\.\d+)/);
    if (match) {
      const version = match[1];
      console.log(`  claude: ${version}`);
      if (compareVersions(version, MIN_CLAUDE_VERSION) < 0) {
        console.error(`  ERROR: Claude Code version ${version} is too old.`);
        console.error(`  Channels require >= ${MIN_CLAUDE_VERSION}.`);
        console.error("  Update: npm update -g @anthropic-ai/claude-code");
        process.exit(1);
      }
    } else {
      console.log(`  claude: ${versionOutput} (version check skipped)`);
    }
  } catch {
    console.error("  ERROR: claude not found in PATH.");
    console.error("  Install Claude Code: npm install -g @anthropic-ai/claude-code");
    process.exit(1);
  }
}

function checkCodex() {
  try {
    const version = execSync("codex --version", { encoding: "utf-8" }).trim();
    console.log(`  codex: ${version}`);
  } catch {
    console.error("  ERROR: codex not found in PATH.");
    console.error("  Install Codex: https://github.com/openai/codex");
    process.exit(1);
  }
}

/**
 * Write or update AgentBridge collaboration sections in CLAUDE.md and AGENTS.md.
 * Returns human-readable status lines for each file.
 */
export function writeCollaborationSections(projectRoot: string): string[] {
  const results: string[] = [];

  const files: Array<{ name: string; path: string; section: string }> = [
    { name: "CLAUDE.md", path: join(projectRoot, "CLAUDE.md"), section: CLAUDE_MD_SECTION },
    { name: "AGENTS.md", path: join(projectRoot, "AGENTS.md"), section: AGENTS_MD_SECTION },
  ];

  for (const { name, path, section } of files) {
    let existing = "";
    try {
      existing = readFileSync(path, "utf-8");
    } catch {
      // File doesn't exist — will be created
    }

    let updated: string;
    try {
      updated = upsertMarkedSection(existing, MARKER_ID, section);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push(`${name}: skipped — ${msg}`);
      continue;
    }

    if (updated === existing) {
      results.push(`${name}: unchanged (section already up to date)`);
      continue;
    }

    writeFileSync(path, updated, "utf-8");
    if (existing === "") {
      results.push(`${name}: created with collaboration section`);
    } else if (existing.includes(`<!-- ${MARKER_ID}:start -->`)) {
      results.push(`${name}: updated collaboration section`);
    } else {
      results.push(`${name}: appended collaboration section`);
    }
  }

  return results;
}

export { compareVersions };

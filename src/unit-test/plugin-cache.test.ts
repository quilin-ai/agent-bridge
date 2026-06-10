import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MARKETPLACE_NAME, PLUGIN_NAME } from "../cli";
import {
  pluginCacheRoot,
  isInsideRepoCheckout,
  MARKETPLACE_STEPS,
  shouldWarnMissingPluginCache,
} from "../cli/plugin-cache";
import { pluginInstallFallbackGuidance } from "../cli/init";

describe("plugin-cache: pluginCacheRoot", () => {
  test("builds the path from the marketplace + plugin constants (no hardcoded literal)", () => {
    const home = "/tmp/fake-home";
    expect(pluginCacheRoot(home)).toBe(
      join(home, ".claude", "plugins", "cache", MARKETPLACE_NAME, PLUGIN_NAME),
    );
  });

  test("matches the documented marketplace + plugin id segments", () => {
    // README markets this as agentbridge@agentbridge — the cache root must agree.
    const root = pluginCacheRoot("/h");
    expect(root.endsWith(join("cache", "agentbridge", "agentbridge"))).toBe(true);
  });
});

describe("plugin-cache: isInsideRepoCheckout", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "agentbridge-repo-detect-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("true when scripts/build-bundles.mjs exists (repo checkout)", () => {
    mkdirSync(join(tempDir, "scripts"), { recursive: true });
    writeFileSync(join(tempDir, "scripts", "build-bundles.mjs"), "// build\n", "utf-8");
    expect(isInsideRepoCheckout(tempDir)).toBe(true);
  });

  test("false when build scripts are absent (global npm install)", () => {
    // A published package dir with no scripts/ folder.
    expect(isInsideRepoCheckout(tempDir)).toBe(false);
  });
});

describe("plugin-cache: MARKETPLACE_STEPS", () => {
  test("matches README.md marketplace install steps verbatim", () => {
    expect(MARKETPLACE_STEPS).toEqual([
      "/plugin marketplace add raysonmeng/agent-bridge",
      "/plugin install agentbridge@agentbridge",
      "/reload-plugins",
    ]);
  });
});

describe("plugin-cache: shouldWarnMissingPluginCache", () => {
  test("warns when cache dir is missing", () => {
    expect(shouldWarnMissingPluginCache(false)).toBe(true);
  });

  test("does not warn when cache dir is present", () => {
    expect(shouldWarnMissingPluginCache(true)).toBe(false);
  });
});

describe("init: pluginInstallFallbackGuidance", () => {
  test("npm-global context → marketplace steps, never `abg dev`", () => {
    const lines = pluginInstallFallbackGuidance(false);
    const joined = lines.join("\n");
    // All three documented marketplace steps appear.
    for (const step of MARKETPLACE_STEPS) {
      expect(joined).toContain(step);
    }
    // The non-repo audience must NOT be pointed at `abg dev` (it hard-errors).
    expect(joined).not.toContain("abg dev");
  });

  test("repo context → suggests `abg dev`, not marketplace steps", () => {
    const lines = pluginInstallFallbackGuidance(true);
    const joined = lines.join("\n");
    expect(joined).toContain("abg dev");
    expect(joined).not.toContain("/plugin marketplace add");
  });
});

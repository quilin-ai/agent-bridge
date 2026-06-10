import { describe, expect, test } from "bun:test";
import {
  BUILD_INFO,
  daemonStatusBuildInfo,
  sameBuildInfo,
  sameRuntimeContract,
  type AgentBridgeBuildInfo,
} from "../build-info";

const base: AgentBridgeBuildInfo = {
  version: "0.1.6",
  commit: "6c24127",
  bundle: "dist",
  contractVersion: 1,
};

describe("build info", () => {
  test("exposes stable runtime build metadata for daemon status", () => {
    expect(BUILD_INFO.version).toBeString();
    expect(BUILD_INFO.commit).toBeString();
    expect(BUILD_INFO.bundle).toMatch(/^(source|dist|plugin)$/);
    expect(BUILD_INFO.contractVersion).toBeNumber();
  });

  test("serializes into the daemon status payload shape", () => {
    expect(daemonStatusBuildInfo()).toEqual({
      version: BUILD_INFO.version,
      commit: BUILD_INFO.commit,
      bundle: BUILD_INFO.bundle,
      contractVersion: BUILD_INFO.contractVersion,
    });
  });

  test("sameRuntimeContract ignores bundle kind (dist vs plugin are interchangeable)", () => {
    expect(sameRuntimeContract(base, { ...base, bundle: "plugin" })).toBe(true);
    expect(sameRuntimeContract(base, { ...base, bundle: "source" })).toBe(true);
    // sameBuildInfo, used only for diagnostics, still distinguishes the bundle.
    expect(sameBuildInfo(base, { ...base, bundle: "plugin" })).toBe(false);
  });

  test("sameRuntimeContract still detects a real upgrade (version/commit/contract)", () => {
    expect(sameRuntimeContract(base, { ...base, commit: "deadbee" })).toBe(false);
    expect(sameRuntimeContract(base, { ...base, version: "0.1.7" })).toBe(false);
    expect(sameRuntimeContract(base, { ...base, contractVersion: 2 })).toBe(false);
    expect(sameRuntimeContract(base, null)).toBe(false);
    expect(sameRuntimeContract(base, { ...base })).toBe(true);
  });
});

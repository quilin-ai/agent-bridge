import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PublishThrottle } from "../publish-throttle";

describe("PublishThrottle — cross-process windowed throttle (§3.3)", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test("first publish allowed; repeat within window suppressed; allowed after window", () => {
    dir = mkdtempSync(join(tmpdir(), "agentbridge-throttle-"));
    const file = join(dir, "throttle.json");
    let t = 1000;
    const th = new PublishThrottle({ filePath: file, windowMs: 5000, now: () => t });
    expect(th.allow("ag|repo|main")).toBe(true);
    expect(th.allow("ag|repo|main")).toBe(false);
    t = 1000 + 4999;
    expect(th.allow("ag|repo|main")).toBe(false);
    t = 1000 + 5000;
    expect(th.allow("ag|repo|main")).toBe(true);
  });

  test("distinct (agent, repo, branch) keys throttle independently", () => {
    dir = mkdtempSync(join(tmpdir(), "agentbridge-throttle-"));
    const file = join(dir, "throttle.json");
    const th = new PublishThrottle({ filePath: file, windowMs: 5000, now: () => 1000 });
    expect(th.allow("ag|repo|main")).toBe(true);
    expect(th.allow("ag|repo|feature")).toBe(true);
    expect(th.allow("ag2|repo|main")).toBe(true);
    expect(th.allow("ag|repo|main")).toBe(false);
  });

  test("state persists across instances (a fresh `abg publish` process sees the throttle)", () => {
    dir = mkdtempSync(join(tmpdir(), "agentbridge-throttle-"));
    const file = join(dir, "throttle.json");
    expect(new PublishThrottle({ filePath: file, windowMs: 5000, now: () => 1000 }).allow("k")).toBe(true);
    expect(new PublishThrottle({ filePath: file, windowMs: 5000, now: () => 2000 }).allow("k")).toBe(false);
  });
});

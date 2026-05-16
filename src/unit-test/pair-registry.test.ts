/**
 * Unit tests for `PairRegistry` (STM v2.3 §D2 P3).
 *
 * Covers: D1 pair-name validation, atomic save (temp+rename), allocation
 * for default + named pairs, MAX_PAIRS + ALLOCATION_FAILED edge cases,
 * registry round-trip across load(), invalid-entry filtering.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PairRegistry, isValidPairName, DEFAULT_PAIR_PORTS } from "../pair-registry";

describe("isValidPairName (spec v2.3 D1)", () => {
  test("accepts lowercase alphanumeric + underscore + hyphen", () => {
    for (const name of ["default", "work", "side", "a", "abc-123", "x_y_z", "1pair", "p9_3-a"]) {
      expect(isValidPairName(name)).toBe(true);
    }
  });

  test("rejects names that violate the D1 contract", () => {
    const bad = [
      "",            // empty
      "_starts-underscore",  // first char must be alphanumeric
      "-starts-hyphen",
      "UPPER",       // uppercase
      "MixedCase",
      "has space",
      "has/slash",
      "has\\back",
      ".",
      "..",
      "..hidden",
      "has.dot",
      "a".repeat(33), // 33 chars — over the 32-char cap
    ];
    for (const name of bad) {
      expect(isValidPairName(name)).toBe(false);
    }
  });

  test("rejects non-string inputs", () => {
    expect(isValidPairName(undefined as any)).toBe(false);
    expect(isValidPairName(null as any)).toBe(false);
    expect(isValidPairName(123 as any)).toBe(false);
  });
});

describe("PairRegistry", () => {
  let tempDir: string;
  let logs: string[];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "agentbridge-pair-registry-test-"));
    logs = [];
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function makeRegistry(overrides: { strideStep?: number; strideMax?: number; maxPairs?: number } = {}) {
    return new PairRegistry({
      filePath: join(tempDir, "pairs", "registry.json"),
      log: (msg) => logs.push(msg),
      ...overrides,
    });
  }

  test("starts empty when no file exists", () => {
    const reg = makeRegistry();
    reg.load();
    expect(reg.size()).toBe(0);
    expect(reg.get("anything")).toBeNull();
  });

  test("default pair allocates to (4500, 4501)", () => {
    const reg = makeRegistry();
    const result = reg.allocate("default");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.pairId).toBe("default");
      expect(result.entry.appPort).toBe(DEFAULT_PAIR_PORTS.appPort);
      expect(result.entry.proxyPort).toBe(DEFAULT_PAIR_PORTS.proxyPort);
    }
  });

  test("named pairs allocate from the stride table", () => {
    const reg = makeRegistry();
    reg.allocate("default"); // 4500/4501

    const r1 = reg.allocate("work");
    expect(r1.ok).toBe(true);
    if (r1.ok) {
      expect(r1.entry.appPort).toBe(4510);
      expect(r1.entry.proxyPort).toBe(4511);
    }

    const r2 = reg.allocate("side");
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.entry.appPort).toBe(4520);
      expect(r2.entry.proxyPort).toBe(4521);
    }
  });

  test("allocate returns existing entry on duplicate (idempotent)", () => {
    const reg = makeRegistry();
    const first = reg.allocate("work");
    expect(first.ok).toBe(true);
    const second = reg.allocate("work");
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.entry).toEqual(first.entry);
    }
  });

  test("INVALID_PAIR_NAME for bad names", () => {
    const reg = makeRegistry();
    const result = reg.allocate("Has Space");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_PAIR_NAME");
    }
  });

  test("MAX_PAIRS fires when registry is at the limit", () => {
    const reg = makeRegistry({ maxPairs: 2 });
    expect(reg.allocate("default").ok).toBe(true);
    expect(reg.allocate("work").ok).toBe(true);
    const third = reg.allocate("side");
    expect(third.ok).toBe(false);
    if (!third.ok) {
      expect(third.error.code).toBe("MAX_PAIRS");
    }
  });

  test("ALLOCATION_FAILED when stride range is exhausted", () => {
    const reg = makeRegistry({ strideMax: 1 });
    // 1 stride slot available; default doesn't consume it (fixed at 4500/4501).
    expect(reg.allocate("default").ok).toBe(true);
    expect(reg.allocate("work").ok).toBe(true);  // consumes 4510/4511
    const second = reg.allocate("side");
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe("ALLOCATION_FAILED");
    }
  });

  test("save() creates the file atomically (temp file is gone afterwards)", () => {
    const reg = makeRegistry();
    reg.allocate("default");
    reg.allocate("work");
    reg.save();

    expect(existsSync(join(tempDir, "pairs", "registry.json"))).toBe(true);
    // No leftover temp files in the pairs/ dir.
    const leftoverTmps = readdirSync(join(tempDir, "pairs"))
      .filter((f) => f.includes(".tmp."));
    expect(leftoverTmps).toEqual([]);
  });

  test("load() round-trips a saved registry", () => {
    const reg1 = makeRegistry();
    reg1.allocate("default");
    const work = reg1.allocate("work");
    reg1.save();

    const reg2 = makeRegistry();
    reg2.load();
    expect(reg2.size()).toBe(2);
    expect(reg2.get("default")?.appPort).toBe(DEFAULT_PAIR_PORTS.appPort);
    if (work.ok) {
      expect(reg2.get("work")?.appPort).toBe(work.entry.appPort);
    }
  });

  test("load() filters invalid entries with a warning, keeps valid ones", () => {
    const filePath = join(tempDir, "pairs", "registry.json");
    const dir = join(tempDir, "pairs");
    require("node:fs").mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, JSON.stringify({
      version: 1,
      entries: [
        { pairId: "default", appPort: 4500, proxyPort: 4501, allocatedAt: 1 },
        { pairId: "BAD CASE", appPort: 4510, proxyPort: 4511, allocatedAt: 1 },  // invalid name
        { pairId: "work", appPort: "not-a-port", proxyPort: 4521, allocatedAt: 1 },  // invalid port
        { pairId: "side", appPort: 4520, proxyPort: 4521, allocatedAt: 1 },
      ],
    }), "utf8");

    const reg = makeRegistry();
    reg.load();
    expect(reg.size()).toBe(2);
    expect(reg.get("default")).not.toBeNull();
    expect(reg.get("side")).not.toBeNull();
    expect(reg.get("BAD CASE")).toBeNull();
    expect(reg.get("work")).toBeNull();
    // Verify drop messages went to log.
    expect(logs.filter((l) => l.includes("dropping invalid entry")).length).toBe(2);
  });

  test("load() handles malformed JSON gracefully", () => {
    const filePath = join(tempDir, "pairs", "registry.json");
    const dir = join(tempDir, "pairs");
    require("node:fs").mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, "{not valid json", "utf8");

    const reg = makeRegistry();
    reg.load();
    expect(reg.size()).toBe(0);
    expect(logs.some((l) => l.includes("invalid JSON"))).toBe(true);
  });

  test("load() handles missing version field", () => {
    const filePath = join(tempDir, "pairs", "registry.json");
    const dir = join(tempDir, "pairs");
    require("node:fs").mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, JSON.stringify({ entries: [] }), "utf8");

    const reg = makeRegistry();
    reg.load();
    expect(reg.size()).toBe(0);
    expect(logs.some((l) => l.includes("unexpected registry shape"))).toBe(true);
  });

  test("remove() takes an entry out of the registry", () => {
    const reg = makeRegistry();
    reg.allocate("work");
    expect(reg.has("work")).toBe(true);
    expect(reg.remove("work")).toBe(true);
    expect(reg.has("work")).toBe(false);
    expect(reg.remove("work")).toBe(false); // idempotent
  });

  test("allocation reuses ports freed by remove()", () => {
    const reg = makeRegistry();
    const first = reg.allocate("work");
    expect(first.ok).toBe(true);
    reg.remove("work");
    const second = reg.allocate("work");
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      // Same name re-allocated → same ports.
      expect(second.entry.appPort).toBe(first.entry.appPort);
    }
  });

  test("named-pair stride skips the default-pair ports even when default is absent", () => {
    const reg = makeRegistry();
    // No default allocated yet. First named pair must still avoid 4500/4501.
    const r = reg.allocate("solo");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entry.appPort).toBe(4510);
      expect(r.entry.proxyPort).toBe(4511);
    }
  });

  test("list() returns entries in insertion order", () => {
    const reg = makeRegistry();
    reg.allocate("default");
    reg.allocate("work");
    reg.allocate("side");
    const list = reg.list();
    expect(list.map((e) => e.pairId)).toEqual(["default", "work", "side"]);
  });
});

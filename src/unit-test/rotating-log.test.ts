import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRotatingLog } from "../rotating-log";

describe("appendRotatingLog", () => {
  test("rotates when appending would exceed max bytes", () => {
    const root = mkdtempSync(join(tmpdir(), "agentbridge-log-"));
    try {
      const path = join(root, "agentbridge.log");
      appendRotatingLog(path, "aaaa\n", { maxBytes: 8, keep: 2 });
      appendRotatingLog(path, "bbbb\n", { maxBytes: 8, keep: 2 });

      expect(readFileSync(path, "utf-8")).toBe("bbbb\n");
      expect(readFileSync(`${path}.1`, "utf-8")).toBe("aaaa\n");
      expect(existsSync(`${path}.2`)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

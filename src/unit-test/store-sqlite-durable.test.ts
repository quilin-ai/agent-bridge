import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../backbone/store/sqlite-store";
import { makeEnvelope } from "./backbone-fixtures";

// §8.2 durability: pending_deliveries (and the ledger) must survive a broker
// restart so a reconnecting member still drains what was queued while it was
// offline. The WAL is checkpointed on close(); reopening the SAME db file is the
// in-test stand-in for "stop the broker, start it again".
describe("SqliteStore — durability across close/reopen (§8.2)", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test("pending deliveries enqueued before close are drainable after reopen", async () => {
    dir = mkdtempSync(join(tmpdir(), "agentbridge-durable-"));
    const dbPath = join(dir, "collab.db");

    const s1 = new SqliteStore(dbPath);
    await s1.enqueuePending("ag-9", makeEnvelope({ idempotencyKey: "k1", messageId: "m1" }));
    await s1.enqueuePending("ag-9", makeEnvelope({ idempotencyKey: "k2", messageId: "m2" }));
    await s1.close(); // checkpoints WAL — the graceful-shutdown path

    // "restart": a fresh Store over the same file.
    const s2 = new SqliteStore(dbPath);
    const drained = await s2.drainPending("ag-9");
    expect(drained.map((e) => e.idempotencyKey).sort()).toEqual(["k1", "k2"]);
    await s2.close();
  });

  test("ledger events survive a reopen", async () => {
    dir = mkdtempSync(join(tmpdir(), "agentbridge-durable-"));
    const dbPath = join(dir, "collab.db");

    const s1 = new SqliteStore(dbPath);
    await s1.appendEvent("r1", makeEnvelope({ messageId: "e1", timestamp: 1 }));
    await s1.close();

    const s2 = new SqliteStore(dbPath);
    const events = await s2.getRecentEvents("r1", 10);
    expect(events.map((e) => e.messageId)).toContain("e1");
    await s2.close();
  });
});

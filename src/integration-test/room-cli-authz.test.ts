import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../backbone/store/sqlite-store";
import { IdentityService } from "../backbone/identity-service";
import { createRoom, joinRoom } from "../cli/room";

// §11.2 closed-by-default: neither `abg room create <existing>` nor `abg join`
// may self-grant membership of a room the caller isn't already in.
describe("room CLI membership is admin-only (no self-grant)", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function setup() {
    dir = mkdtempSync(join(tmpdir(), "agentbridge-roomcli-"));
    const dbPath = join(dir, "collab.db");
    const store = new SqliteStore(dbPath);
    const svc = new IdentityService(store);
    await svc.registerIdentity("alice@x.com", "Alice");
    await svc.registerIdentity("mallory@x.com", "Mallory");
    const aliceTok = await svc.issueToken("alice@x.com");
    const malloryTok = await svc.issueToken("mallory@x.com");
    await store.close();
    const tokenFile = join(dir, "auth-token");
    return { dbPath, tokenFile, aliceTok, malloryTok };
  }

  test("createRoom on an EXISTING room by a non-member is rejected (no self-grant)", async () => {
    const { dbPath, tokenFile, aliceTok, malloryTok } = await setup();
    writeFileSync(tokenFile, aliceTok, { mode: 0o600 });
    const created = await createRoom({ name: "Secret Checkout", cwd: dir!, dbPath });
    expect(created.created).toBe(true); // alice creates + is the member

    // mallory tries to "create" the same (existing) room → must be denied.
    writeFileSync(tokenFile, malloryTok, { mode: 0o600 });
    await expect(createRoom({ name: "Secret Checkout", cwd: dir!, dbPath })).rejects.toThrow(/不是成员/);
  });

  test("join by a non-member is rejected (membership granted only by abg room add)", async () => {
    const { dbPath, tokenFile, aliceTok, malloryTok } = await setup();
    writeFileSync(tokenFile, aliceTok, { mode: 0o600 });
    const created = await createRoom({ name: "Secret Checkout", cwd: dir!, dbPath });

    writeFileSync(tokenFile, malloryTok, { mode: 0o600 });
    await expect(joinRoom({ roomId: created.roomId, cwd: dir!, dbPath })).rejects.toThrow(/不是.*成员/);
  });
});

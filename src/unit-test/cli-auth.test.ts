import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authLogin } from "../cli/auth";
import { StorePskIdentityProvider } from "../backbone/identity/store-psk-identity-provider";
import { SqliteStore } from "../backbone/store/sqlite-store";

describe("authLogin", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("issues a persisted 0600 token that round-trips via StorePskIdentityProvider", async () => {
    dir = mkdtempSync(join(tmpdir(), "agentbridge-auth-"));
    const dbPath = join(dir, "collab.db");

    const result = await authLogin({ id: "alice@x.com", name: "Alice", dbPath });

    // token + identity shape
    expect(result.token).toBeTruthy();
    expect(result.identity).toEqual({ id: "alice@x.com", displayName: "Alice" });

    // token file exists, content matches, and is 0600
    expect(existsSync(result.tokenFile)).toBe(true);
    expect(readFileSync(result.tokenFile, "utf-8")).toBe(result.token);
    expect(statSync(result.tokenFile).mode & 0o777).toBe(0o600);

    // the issued token authenticates back to the same identity
    const store = new SqliteStore(dbPath);
    try {
      const provider = new StorePskIdentityProvider(store);
      const identity = await provider.authenticate(result.token);
      expect(identity).toEqual({ id: "alice@x.com", displayName: "Alice" });
    } finally {
      await store.close();
    }
  });

  it("locks a freshly-created collab DB directory to 0700 (raw tokens + PII at rest)", async () => {
    dir = mkdtempSync(join(tmpdir(), "agentbridge-auth-"));
    const collabDir = join(dir, "nested", "collab"); // does not exist yet → mkdirSync creates it
    await authLogin({ id: "bob@x.com", name: "Bob", dbPath: join(collabDir, "collab.db") });
    // collab.db is 0644 (bun:sqlite default), so the directory must block traversal.
    expect(statSync(collabDir).mode & 0o777).toBe(0o700);
  });

  it("tightens a pre-existing loose collab dir to 0700", async () => {
    dir = mkdtempSync(join(tmpdir(), "agentbridge-auth-"));
    const collabDir = join(dir, "loose");
    mkdirSync(collabDir);
    chmodSync(collabDir, 0o755); // simulate a world-traversable dir
    await authLogin({ id: "c@x.com", name: "C", dbPath: join(collabDir, "collab.db") });
    expect(statSync(collabDir).mode & 0o777).toBe(0o700);
  });
});

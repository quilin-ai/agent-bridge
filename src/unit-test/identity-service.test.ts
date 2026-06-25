import { describe, test, expect, beforeEach } from "bun:test";
import { IdentityService } from "../backbone/identity-service";
import { InMemoryStore } from "../backbone/store/memory-store";

describe("IdentityService — three-layer identity + id/name separation", () => {
  let store: InMemoryStore;
  let svc: IdentityService;
  beforeEach(() => {
    store = new InMemoryStore();
    svc = new IdentityService(store);
  });

  test("registerIdentity separates id/displayName, trims id, reuses on same id", async () => {
    const a = await svc.registerIdentity(" alice@x.com ", "Alice");
    expect(a).toEqual({ id: "alice@x.com", displayName: "Alice" });
    // two Bobs: same display name allowed, distinct ids
    await svc.registerIdentity("bob1@x.com", "Bob");
    await svc.registerIdentity("bob2@x.com", "Bob");
    expect((await svc.getIdentity("bob1@x.com"))!.id).not.toBe(
      (await svc.getIdentity("bob2@x.com"))!.id,
    );
    // same id (second device) reuses the row and updates the display name
    await svc.registerIdentity("alice@x.com", "Alice (laptop)");
    expect(await svc.getIdentity("alice@x.com")).toEqual({
      id: "alice@x.com",
      displayName: "Alice (laptop)",
    });
  });

  test("empty id is rejected", async () => {
    await expect(svc.registerIdentity("   ", "X")).rejects.toThrow();
  });

  test("registerAgent + resolvePerson rolls a logical agent up to its person", async () => {
    await svc.registerIdentity("alice@x.com", "Alice");
    await svc.registerAgent("ag-claude", "alice@x.com", "claude");
    await svc.registerAgent("ag-cursor", "alice@x.com", "cursor");
    expect(await svc.resolvePerson("ag-claude")).toBe("alice@x.com");
    expect(await svc.resolvePerson("ag-cursor")).toBe("alice@x.com");
    expect(await svc.resolvePerson("ag-unknown")).toBeNull();
  });

  test("issueToken binds a fresh token to an existing identity; unknown identity rejected", async () => {
    await svc.registerIdentity("alice@x.com", "Alice");
    const token = await svc.issueToken("alice@x.com");
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
    expect(await store.resolveToken(token)).toBe("alice@x.com");
    await expect(svc.issueToken("nobody@x.com")).rejects.toThrow();
  });

  test("two issued tokens for the same identity are distinct", async () => {
    await svc.registerIdentity("alice@x.com", "Alice");
    const t1 = await svc.issueToken("alice@x.com");
    const t2 = await svc.issueToken("alice@x.com");
    expect(t1).not.toBe(t2);
  });
});

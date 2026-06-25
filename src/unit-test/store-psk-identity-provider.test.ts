import { describe, test, expect } from "bun:test";
import { InMemoryStore } from "../backbone/store/memory-store";
import { IdentityService } from "../backbone/identity-service";
import { StorePskIdentityProvider } from "../backbone/identity/store-psk-identity-provider";
import { runIdentityProviderContract } from "./identity-contract";

// Pre-seed a store with one issued token so the shared IdentityProvider contract
// (which calls makeProvider().authenticate(validCredential) synchronously) has a
// resolvable credential. Top-level await runs before the contract's tests register.
const store = new InMemoryStore();
const svc = new IdentityService(store);
await svc.registerIdentity("alice@x.com", "Alice");
const VALID_TOKEN = await svc.issueToken("alice@x.com");

runIdentityProviderContract("store-psk", {
  makeProvider: () => new StorePskIdentityProvider(store),
  validCredential: VALID_TOKEN,
  expected: { id: "alice@x.com", displayName: "Alice" },
  invalidCredential: "not-a-real-token",
});

describe("StorePskIdentityProvider — Store-backed token resolution", () => {
  test("a token issued AFTER construction still authenticates (reads live Store)", async () => {
    const s = new InMemoryStore();
    const provider = new StorePskIdentityProvider(s); // built before any token exists
    const service = new IdentityService(s);
    await service.registerIdentity("bob@x.com", "Bob");
    const token = await service.issueToken("bob@x.com");
    expect(await provider.authenticate(token)).toEqual({ id: "bob@x.com", displayName: "Bob" });
  });

  test("rejects a token that resolves to no identity row", async () => {
    const s = new InMemoryStore();
    await s.issueToken("orphan-tok", "ghost@x.com"); // binding exists, identity does not
    const provider = new StorePskIdentityProvider(s);
    await expect(provider.authenticate("orphan-tok")).rejects.toThrow();
  });
});

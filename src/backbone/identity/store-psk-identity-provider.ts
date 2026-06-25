import type { Store } from "../store";
import type { Identity, IdentityProvider } from "../identity";

/**
 * Store-backed PSK IdentityProvider — the real broker auth driver (§6.2).
 *
 * Resolves a presented token via the Store's persisted (token → identity)
 * bindings issued by `abg auth login`. Unlike the in-memory PskIdentityProvider
 * (seeded at construction), this reads the live Store, so a freshly-issued token
 * authenticates without restarting the broker.
 *
 * Note (security, MVP): tokens are stored raw in the local Store. The collab DB
 * file itself is 0644 (bun:sqlite default), so its CONTAINING directory is locked
 * to 0700 by the writer (`abg auth login`, src/cli/auth.ts) to block other local
 * users — the durable equivalent of control-token.ts's 0600 file. The token is an
 * unguessable randomUUID and the link is WireGuard-encrypted over Tailscale (§7).
 * Hashing tokens at rest is a §11.3 hardening item.
 */
export class StorePskIdentityProvider implements IdentityProvider {
  constructor(private readonly store: Store) {}

  async authenticate(credential: string): Promise<Identity> {
    const identityId = await this.store.resolveToken(credential);
    if (!identityId) throw new Error("invalid PSK token");
    const identity = await this.store.getIdentity(identityId);
    if (!identity) {
      // The token's identity row was deleted out from under it.
      throw new Error(`token resolved to unknown identity: ${identityId}`);
    }
    return { id: identity.id, displayName: identity.displayName };
  }
}

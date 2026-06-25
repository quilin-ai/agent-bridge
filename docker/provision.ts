/**
 * Provision step for the multi-machine sim: register an identity, issue a PSK
 * token, write it to the shared volume for the client containers to read.
 *
 * (In a real deployment the token is distributed out of band; the sim shares a
 * volume purely for convenience.)
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SqliteStore } from "../src/backbone/store/sqlite-store";
import { IdentityService } from "../src/backbone/identity-service";

const db = process.env.COLLAB_DB ?? "/data/collab.db";
const id = process.env.SIM_ID ?? "sim@example.com";
const name = process.env.SIM_NAME ?? "Sim Agent";
const tokenFile = process.env.TOKEN_FILE ?? "/data/token";

mkdirSync(dirname(db), { recursive: true, mode: 0o700 });
chmodSync(dirname(db), 0o700);

const store = new SqliteStore(db);
const svc = new IdentityService(store);
await svc.registerIdentity(id, name);
const token = await svc.issueToken(id);
await store.close();

writeFileSync(tokenFile, token, { mode: 0o600 });
console.log(`[provision] identity ${id} registered, token written to ${tokenFile}`);

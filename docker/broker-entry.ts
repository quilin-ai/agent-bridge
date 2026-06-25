/**
 * Container entrypoint for the broker (multi-machine simulation, §11.1/§13).
 * Constructs the broker directly (no CLI) so the image needs no extra deps.
 */
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Broker } from "../src/broker";
import { SqliteStore } from "../src/backbone/store/sqlite-store";
import { StorePskIdentityProvider } from "../src/backbone/identity/store-psk-identity-provider";

const host = process.env.BROKER_HOST ?? "0.0.0.0"; // 0.0.0.0 is fine INSIDE a container
const port = parseInt(process.env.BROKER_PORT ?? "4700", 10);
const db = process.env.COLLAB_DB ?? "/data/collab.db";

mkdirSync(dirname(db), { recursive: true, mode: 0o700 });
chmodSync(dirname(db), 0o700);

const store = new SqliteStore(db);
const broker = new Broker({
  store,
  identityProvider: new StorePskIdentityProvider(store),
  host,
  port,
  log: (m) => console.error(`[broker] ${m}`),
});
const bound = broker.start();
console.log(`[broker] up on ${bound.host}:${bound.port} (db ${db})`);

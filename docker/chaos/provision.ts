/** Chaos provisioning: a publisher identity + a subscriber identity + one room. */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SqliteStore } from "../../src/backbone/store/sqlite-store";
import { IdentityService } from "../../src/backbone/identity-service";
import { RoomService } from "../../src/room-service";

const db = process.env.COLLAB_DB ?? "/data/collab.db";
const dir = process.env.TOKEN_DIR ?? "/data";
const room = process.env.ROOM ?? "chaos-room";

mkdirSync(dirname(db), { recursive: true, mode: 0o700 });
chmodSync(dirname(db), 0o700);

const store = new SqliteStore(db);
const svc = new IdentityService(store);
const rooms = new RoomService(store);
await rooms.createRoom(room, "Chaos Room", "pub@chaos");
for (const [id, file] of [
  ["pub@chaos", "token-pub"],
  ["sub@chaos", "token-sub"],
] as const) {
  await svc.registerIdentity(id, id);
  writeFileSync(join(dir, file), await svc.issueToken(id), { mode: 0o600 });
  await rooms.join(room, id); // member ⇒ eligible for store_if_offline
}
await store.close();
console.log(`[chaos-provision] done (room=${room})`);

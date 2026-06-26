import { describe, test, expect, afterEach } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Broker } from "../broker";
import { BrokerClient } from "../broker-client";
import { InMemoryStore } from "../backbone/store/memory-store";
import { IdentityService } from "../backbone/identity-service";
import { StorePskIdentityProvider } from "../backbone/identity/store-psk-identity-provider";
import { RoomService } from "../room-service";
import { publishCompletion, runPublish } from "../cli/publish";

const ROOM = "checkout";

async function delay(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = performance.now();
  while (!cond()) {
    if (performance.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await delay(10);
  }
}

/** Stand up a broker + shared store, seed two identities, return a temp collab dir with alice's auth-token written. */
async function setup(opts: { mapCwd?: boolean; writeToken?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agentbridge-publish-"));
  const store = new InMemoryStore();
  const svc = new IdentityService(store);
  await svc.registerIdentity("alice@x.com", "Alice");
  await svc.registerIdentity("bob@x.com", "Bob");
  const token = await svc.issueToken("alice@x.com");
  const tokenB = await svc.issueToken("bob@x.com");

  const rooms = new RoomService(store);
  await rooms.createRoom(ROOM, "Checkout", "alice@x.com");
  await rooms.join(ROOM, "alice@x.com");
  await rooms.join(ROOM, "bob@x.com");
  if (opts.mapCwd !== false) await rooms.mapCwd(dir, ROOM);
  if (opts.writeToken !== false) writeFileSync(join(dir, "auth-token"), token, { mode: 0o600 });

  const broker = new Broker({
    store,
    identityProvider: new StorePskIdentityProvider(store),
    host: "127.0.0.1",
    port: 0,
    log: () => {},
  });
  const { port } = broker.start();
  const url = `ws://127.0.0.1:${port}/ws`;
  return { dir, store, token, tokenB, broker, url, dbPath: join(dir, "collab.db") };
}

describe("publishCompletion — task_completed end-to-end (§3.3)", () => {
  let cleanup: Array<() => void> = [];
  afterEach(() => {
    for (const fn of cleanup) fn();
    cleanup = [];
  });

  test("a manual announce is delivered to a room subscriber, sender stamped by the broker", async () => {
    const { dir, store, tokenB, broker, url, dbPath } = await setup();
    cleanup.push(() => broker.stop(), () => rmSync(dir, { recursive: true, force: true }));

    const received: any[] = [];
    const sub = new BrokerClient({ url, token: tokenB });
    sub.onEvent((_topic, env) => received.push(env));
    await sub.connect();
    sub.subscribe(ROOM);
    await delay(50); // let the subscribe register before we publish

    const res = await publishCompletion({
      store,
      dbPath,
      cwd: dir,
      brokerUrl: url,
      argv: ["--summary", "auth contract landed", "--repo", "app", "--unblocks", "bob@x.com,topic:checkout"],
    });
    expect(res.status).toBe("published");
    expect(res.roomId).toBe(ROOM);

    await waitFor(() => received.length > 0);
    sub.close();
    expect(received[0].kind).toBe("task_completed");
    expect(received[0].deliveryMode).toBe("store_if_offline");
    expect(received[0].from.agentId).toBe("alice@x.com"); // broker re-stamps the authenticated sender
    expect(received[0].payload).toMatchObject({
      summary: "auth contract landed",
      repo: "app",
      unblocks: ["bob@x.com", "topic:checkout"],
    });
  });

  test("skips (never throws) when not logged in / cwd has no room / summary is empty", async () => {
    const noToken = await setup({ writeToken: false });
    cleanup.push(() => noToken.broker.stop(), () => rmSync(noToken.dir, { recursive: true, force: true }));
    expect(
      (await publishCompletion({ store: noToken.store, dbPath: noToken.dbPath, cwd: noToken.dir, brokerUrl: noToken.url, argv: ["--summary", "x"] })).status,
    ).toBe("skipped-no-login");

    const noRoom = await setup({ mapCwd: false });
    cleanup.push(() => noRoom.broker.stop(), () => rmSync(noRoom.dir, { recursive: true, force: true }));
    expect(
      (await publishCompletion({ store: noRoom.store, dbPath: noRoom.dbPath, cwd: noRoom.dir, brokerUrl: noRoom.url, argv: ["--summary", "x"] })).status,
    ).toBe("skipped-no-room");

    const empty = await setup();
    cleanup.push(() => empty.broker.stop(), () => rmSync(empty.dir, { recursive: true, force: true }));
    // No --summary and no --from-hook (so no git subject) ⇒ nothing to announce.
    expect(
      (await publishCompletion({ store: empty.store, dbPath: empty.dbPath, cwd: empty.dir, brokerUrl: empty.url, argv: [] })).status,
    ).toBe("skipped-empty");
  });

  test("a broker that never accepts the connection yields skipped-offline within the timeout", async () => {
    const { dir, store, broker, dbPath } = await setup();
    broker.stop(); // nothing listening on a fresh port now
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const res = await publishCompletion({
      store,
      dbPath,
      cwd: dir,
      brokerUrl: "ws://127.0.0.1:1/ws", // unroutable
      connectTimeoutMs: 300,
      argv: ["--summary", "x"],
    });
    expect(res.status).toBe("skipped-offline");
  });

  test("--from-hook dedups the same commit (2nd call throttled) but a new commit announces", async () => {
    const { dir, store, tokenB, broker, url, dbPath } = await setup();
    cleanup.push(() => broker.stop(), () => rmSync(dir, { recursive: true, force: true }));

    // A real git repo in the workspace so --from-hook can derive summary/commit.
    const g = (args: string[]) =>
      execFileSync("git", args, {
        cwd: dir,
        encoding: "utf-8",
        env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
        stdio: ["ignore", "pipe", "ignore"],
      });
    g(["init", "-q"]);
    writeFileSync(join(dir, "a.txt"), "1");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "first task done"]);

    const sub = new BrokerClient({ url, token: tokenB });
    const received: any[] = [];
    sub.onEvent((_t, env) => received.push(env));
    await sub.connect();
    sub.subscribe(ROOM);
    await delay(50);

    const first = await publishCompletion({ store, dbPath, cwd: dir, brokerUrl: url, argv: ["--from-hook"] });
    expect(first.status).toBe("published");
    await waitFor(() => received.length === 1);
    expect(received[0].payload.summary).toBe("first task done");

    // Same commit again → throttled (no second event).
    const again = await publishCompletion({ store, dbPath, cwd: dir, brokerUrl: url, argv: ["--from-hook"] });
    expect(again.status).toBe("skipped-throttled");

    // A new commit (new hash) is a new throttle key → announces.
    writeFileSync(join(dir, "b.txt"), "2");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "second task done"]);
    const third = await publishCompletion({ store, dbPath, cwd: dir, brokerUrl: url, argv: ["--from-hook"] });
    expect(third.status).toBe("published");
    await waitFor(() => received.length === 2);
    sub.close();
    expect(received[1].payload.summary).toBe("second task done");
  });

  test("--from-hook: a broker-offline first attempt does NOT burn the window — a later retry still announces", async () => {
    const { dir, store, tokenB, broker, url, dbPath } = await setup();
    cleanup.push(() => broker.stop(), () => rmSync(dir, { recursive: true, force: true }));

    const g = (args: string[]) =>
      execFileSync("git", args, {
        cwd: dir,
        encoding: "utf-8",
        env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
        stdio: ["ignore", "pipe", "ignore"],
      });
    g(["init", "-q"]);
    writeFileSync(join(dir, "a.txt"), "1");
    g(["add", "-A"]);
    g(["commit", "-q", "-m", "task done"]);

    // First Stop hook fires while the broker is unreachable → offline, slot NOT consumed.
    const offline = await publishCompletion({
      store,
      dbPath,
      cwd: dir,
      brokerUrl: "ws://127.0.0.1:1/ws",
      connectTimeoutMs: 300,
      argv: ["--from-hook"],
    });
    expect(offline.status).toBe("skipped-offline");

    // Broker is back; a later Stop hook for the SAME commit must still get through.
    const sub = new BrokerClient({ url, token: tokenB });
    const received: any[] = [];
    sub.onEvent((_t, env) => received.push(env));
    await sub.connect();
    sub.subscribe(ROOM);
    await delay(50);

    const retry = await publishCompletion({ store, dbPath, cwd: dir, brokerUrl: url, argv: ["--from-hook"] });
    expect(retry.status).toBe("published");
    await waitFor(() => received.length === 1);

    // And NOW the slot is consumed — a further same-commit fire is deduped.
    const again = await publishCompletion({ store, dbPath, cwd: dir, brokerUrl: url, argv: ["--from-hook"] });
    expect(again.status).toBe("skipped-throttled");
    sub.close();
    expect(received[0].payload.summary).toBe("task done");
  });

  test("not-logged-in: leaves NO collab.db and does NOT tighten the shared state dir (v1-only inert)", async () => {
    // No store injection → exercises the real openStore-avoidance path. No
    // auth-token written → the user never opted into v3 collab.
    const dir = mkdtempSync(join(tmpdir(), "agentbridge-v1only-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const before = statSync(dir).mode & 0o777;
    const dbPath = join(dir, "collab.db");

    const res = await publishCompletion({ dbPath, cwd: dir, argv: ["--from-hook"], connectTimeoutMs: 200 });

    expect(res.status).toBe("skipped-no-login");
    expect(existsSync(dbPath)).toBe(false); // no collab.db created
    expect(statSync(dir).mode & 0o777).toBe(before); // state dir permissions untouched (no 0700 chmod)
  });

  test("logged-in but cwd is not a git repo: --from-hook has no commit subject ⇒ skipped-empty", async () => {
    const { dir, store, broker, url, dbPath } = await setup();
    broker.stop();
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    // setup() wrote the auth-token + mapped the cwd, but never `git init`'d the dir.
    const res = await publishCompletion({ store, dbPath, cwd: dir, brokerUrl: url, argv: ["--from-hook"] });
    expect(res.status).toBe("skipped-empty");
  });

  test("runPublish is the fail-open boundary: a thrown publishCompletion never escapes (no reject)", async () => {
    // Force publishCompletion to throw AFTER the login gate: a present auth-token
    // gets past readAuthToken, then openStore's `new SqliteStore(<a directory>)`
    // throws. runPublish must swallow it (console.error) and resolve, never reject.
    const dir = mkdtempSync(join(tmpdir(), "agentbridge-failopen-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "auth-token"), "tok", { mode: 0o600 });
    const dbAsDir = join(dir, "collab.db");
    mkdirSync(dbAsDir); // dbPath is a directory ⇒ opening it as sqlite throws
    const prev = process.env.AGENTBRIDGE_COLLAB_DB;
    process.env.AGENTBRIDGE_COLLAB_DB = dbAsDir;
    try {
      await expect(runPublish(["--summary", "x"])).resolves.toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.AGENTBRIDGE_COLLAB_DB;
      else process.env.AGENTBRIDGE_COLLAB_DB = prev;
    }
  });
});

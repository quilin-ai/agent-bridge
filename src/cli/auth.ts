/**
 * `abg auth login` — issue a PSK token bound to a collaboration identity (§2.2, §6).
 *
 * Registers (or refreshes) a person identity in the local collab Store, issues a
 * fresh PSK token, and writes it to `<state>/auth-token` (0600) for the broker to
 * verify via StorePskIdentityProvider. The Store double as the (token → identity)
 * binding source, so a freshly-issued token authenticates without a broker restart.
 */

import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteText } from "../atomic-json";
import { IdentityService } from "../backbone/identity-service";
import { SqliteStore } from "../backbone/store/sqlite-store";
import { StateDirResolver } from "../state-dir";

export interface AuthLoginOptions {
  id: string;
  name: string;
  dbPath?: string;
}

export interface AuthLoginResult {
  token: string;
  identity: { id: string; displayName: string };
  tokenFile: string;
}

/** Resolve the collab DB path: explicit > env override > `<state>/collab.db`. */
function resolveDbPath(dbPath?: string): string {
  if (dbPath) return dbPath;
  const env = process.env.AGENTBRIDGE_COLLAB_DB;
  if (env && env.length > 0) return env;
  return join(new StateDirResolver().dir, "collab.db");
}

/**
 * Register the identity, issue a token, and persist it next to the collab DB.
 * Directly unit-testable: pass an explicit `dbPath` to a temp dir.
 */
export async function authLogin(opts: AuthLoginOptions): Promise<AuthLoginResult> {
  const dbPath = resolveDbPath(opts.dbPath);
  const dir = dirname(dbPath);
  // The collab DB holds RAW PSK tokens (auth_tokens) + identity emails/PII
  // (identities). bun:sqlite creates the DB file 0644, and its WAL/SHM sidecars
  // are recreated 0644 on every reopen, so file-level chmod is not durable —
  // lock the CONTAINING directory to 0700 instead (matches codex-transport.ts),
  // blocking any other local user from traversing in to read the secrets
  // (CWE-732). chmodSync covers the case where the dir already existed looser.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);

  const store = new SqliteStore(dbPath);
  try {
    const svc = new IdentityService(store);
    const identity = await svc.registerIdentity(opts.id, opts.name);
    const token = await svc.issueToken(identity.id);
    const tokenFile = join(dir, "auth-token");
    // 0600 from creation (CWE-732): the token is a local secret.
    atomicWriteText(tokenFile, token, { mode: 0o600 });
    return { token, identity, tokenFile };
  } finally {
    await store.close();
  }
}

const LOGIN_USAGE = "用法：abg auth login --id <email|github> --name <displayName>";

/** Parse `--id`/`--name` (space- or `=`-separated) and run the login. */
export async function runAuthLoginCli(argv: string[]): Promise<void> {
  let id: string | undefined;
  let name: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--id") {
      id = argv[++i];
    } else if (a.startsWith("--id=")) {
      id = a.slice("--id=".length);
    } else if (a === "--name") {
      name = argv[++i];
    } else if (a.startsWith("--name=")) {
      name = a.slice("--name=".length);
    }
  }

  if (!id || !name) {
    console.error("缺少必填参数 --id 或 --name。");
    console.error(LOGIN_USAGE);
    process.exit(1);
    return;
  }

  const result = await authLogin({ id, name });
  console.log(
    `已为 ${result.identity.id}（${result.identity.displayName}）签发令牌：${result.token}`,
  );
  console.log(`令牌文件：${result.tokenFile}`);
}

/** Dispatch `abg auth <subcommand>`. Only `login` is supported today. */
export async function runAuth(args: string[]): Promise<void> {
  const sub = args[0];
  switch (sub) {
    case "login":
      await runAuthLoginCli(args.slice(1));
      break;
    default:
      console.error(`未知的 auth 子命令：${sub ?? "(空)"}`);
      console.error(LOGIN_USAGE);
      process.exit(1);
  }
}

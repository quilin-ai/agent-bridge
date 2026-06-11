/**
 * Ownership checks for the daemon's SHARED per-pair identity files
 * (daemon.pid / status.json / daemon.json / control token).
 *
 * These files live in the pair's state dir and are owned by whichever daemon is
 * the LIVE incumbent. A losing daemon (D2) that races a live incumbent (D1) for
 * the control port — and exits when the bind fails with EADDRINUSE — must NEVER
 * delete or clobber D1's files. The process-level `process.on("exit")` cleanup is
 * unconditional, so we make the removers OWNERSHIP-AWARE: a remover only unlinks
 * a shared file when this process can prove the file is ITS OWN.
 *
 * This module is the pure, IO-injectable predicate behind that gate so it can be
 * unit-tested without importing daemon.ts (which has port-bind side effects).
 */

import { readFileSync } from "node:fs";

export type ReadFile = (path: string) => string;

const defaultRead: ReadFile = (path) => readFileSync(path, "utf-8");

/**
 * True iff the pid currently written in `pidFilePath` is EXACTLY `ourPid`.
 *
 * Used by the ownership-aware pid-file remover: a losing D2 (pid 2222) reading a
 * file that still holds the live D1's pid (1111) gets `false` and skips the
 * unlink, so D1's identity survives the race. An unreadable file, an empty file,
 * or a non-integer payload also yields `false` (do not assume ownership we can't
 * prove). The match is strict integer equality — "4242abc" is rejected even
 * though parseInt would coerce it to 4242.
 */
export function pidFileOwnedByUs(
  pidFilePath: string,
  ourPid: number,
  read: ReadFile = defaultRead,
): boolean {
  let raw: string;
  try {
    raw = read(pidFilePath);
  } catch {
    return false;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return false;
  // Strict: require the WHOLE trimmed payload to be an integer (no trailing
  // garbage). parseInt("4242abc") === 4242 would be a false-positive ownership.
  if (!/^[+-]?\d+$/.test(trimmed)) return false;
  const pid = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(pid)) return false;
  return pid === ourPid;
}

/**
 * Async file logger — shared WriteStream pool keyed by file path.
 *
 * Replaces `appendFileSync` in the hot path. `appendFileSync` was
 * synchronously blocking the event loop on every log line; with a
 * busy proxy producing dozens-to-hundreds of lines per Codex response,
 * that materially slowed end-to-end latency.
 *
 * Design:
 * - One WriteStream per file (process-wide). Multiple call sites
 *   sharing the same log file write through the same stream, so
 *   ordering matches their call order.
 * - `write()` is fire-and-forget. WriteStream's internal buffer
 *   absorbs bursts; drains async to disk. Backpressure (returns
 *   false) is accepted — we don't pause callers, just keep
 *   buffering. Worst case: memory grows briefly until disk catches up.
 * - On `error` we emit to stderr and keep going. A broken log file
 *   never crashes the process — that's how the previous synchronous
 *   `try { appendFileSync(...) } catch {}` pattern behaved too.
 * - `close()` is provided for graceful shutdown — daemon SIGTERM
 *   handler calls it to flush pending lines before exit.
 *
 * Performance note: this is a P0 optimization (2026-05-17). Combined
 * with P1 (proxy frame logs gated behind AGENTBRIDGE_DEBUG_PROXY),
 * the daemon's per-message log overhead drops from O(disk-IO sync)
 * to O(buffer-write) on the hot path.
 */

import { createWriteStream, mkdirSync, existsSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";

export interface AsyncFileLogger {
  write(line: string): void;
  /** Flush + close. Resolves when the underlying stream has finished. */
  close(): Promise<void>;
}

const writers = new Map<string, WriteStream>();

function getStream(filePath: string): WriteStream {
  const existing = writers.get(filePath);
  if (existing && !existing.destroyed) return existing;
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    try { mkdirSync(dir, { recursive: true }); } catch { /* race / EACCES — let createWriteStream surface it */ }
  }
  const stream = createWriteStream(filePath, { flags: "a" });
  stream.on("error", (err) => {
    process.stderr.write(`[log-writer] write error on ${filePath}: ${err.message}\n`);
  });
  writers.set(filePath, stream);
  return stream;
}

export function getAsyncFileLogger(filePath: string): AsyncFileLogger {
  return {
    write(line: string): void {
      const stream = getStream(filePath);
      try {
        stream.write(line);
      } catch (err: any) {
        // Defensive: if the stream is somehow in a bad state, fall back
        // to stderr without crashing.
        process.stderr.write(`[log-writer] sync write failed on ${filePath}: ${err?.message ?? err}\n`);
      }
    },
    close(): Promise<void> {
      return new Promise<void>((resolve) => {
        const stream = writers.get(filePath);
        if (!stream || stream.destroyed) { resolve(); return; }
        writers.delete(filePath);
        stream.end(() => resolve());
      });
    },
  };
}

/** Close all open file loggers — used by SIGTERM handlers for clean flush. */
export async function closeAllAsyncFileLoggers(): Promise<void> {
  const all = [...writers.entries()];
  writers.clear();
  await Promise.all(all.map(([_path, stream]) =>
    new Promise<void>((resolve) => {
      if (stream.destroyed) { resolve(); return; }
      stream.end(() => resolve());
    }),
  ));
}

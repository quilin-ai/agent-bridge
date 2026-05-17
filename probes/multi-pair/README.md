# Multi-pair probes (STM v2.3 §10)

Manual end-to-end probe scripts for verifying STM v2.3 multi-pair
behavior against a live daemon. Run each probe against a fresh
`abg kill && bun src/daemon.ts` daemon.

**Status**: spec drafted, implementation pending. The harness work
(spawning daemon + multiple codex app-servers + control-WS coordination)
is substantial — likely a follow-up effort modeled after
`probes/shared-thread/lib.ts` (686 lines).

This README freezes the probe specs so the implementation work has a
concrete target.

## Probes

### M01 — two pairs, two Claudes, independent communication

Setup:
- `abg codex --pair work --via-proxy`
- `abg codex --pair side --via-proxy`
- Claude #1 attaches with no pairId → FIFO claims `work`
- Claude #2 attaches with no pairId → FIFO claims `side`

Asserts:
- Each pair has its own threadId (different from the other)
- Message sent in Claude #1's reply appears in `work`'s TUI but NOT
  in `side`'s TUI
- User typed in `side`'s TUI reaches Claude #2 but NOT Claude #1
- `abg pairs ls` shows both as live + paired

### M02 — kill one pair's codex, other survives (crash isolation)

Setup: M01 setup, both pairs healthy.

Action: `kill -9` work's codex app-server PID directly.

Asserts:
- `work`'s chats see `system_codex_exit`
- `side`'s chats keep responding to messages
- `abg pairs ls` shows `work` isLive=false, `side` isLive=true
- Subsequent `abg codex --pair work --via-proxy` re-spawns work
  cleanly using the same registered ports

### M03 — `abg codex --pair work --via-proxy` rejects second invocation

Action: run `abg codex --pair work --via-proxy` twice in series.

Asserts:
- Second invocation exits 1 with message scoped to pair "work"
- First TUI keeps running
- `abg codex --pair side --via-proxy` (different pair) succeeds in
  parallel

### M04 — explicit pair attach when not live

Setup: daemon up, no pairs ensured yet.

Action: Claude attaches with `AGENTBRIDGE_PAIR=ghost-pair`.

Asserts:
- `claude_connect_result { ok:false, error: "PAIR_NOT_FOUND" }`
- Bridge enters disabled state with `daemon_rejected_attach`
- System message includes the pair name + actionable instruction

### M05 — 3 Claudes, 2 pairs live, FIFO claim

Setup:
- Two pairs ensured (`default`, `work`) with `--via-proxy` TUIs.
- Three Claudes attach in sequence WITHOUT `AGENTBRIDGE_PAIR`.

Asserts:
- Claude #1 claims `default` (insertion order first)
- Claude #2 claims `work`
- Claude #3 attaches as isolated (no free pair) against default's
  app-server, with own thread

### M06 — destroy_pair --force on a paired-live pair mid-turn

Setup: pair "work" live with paired Claude mid-turn.

Action: `abg pairs rm work --force --forget`

Asserts:
- Paired Claude receives `system_pair_torn_down`
- transitionToIsolated runs → fresh ClaudeThread on default's
  app-server (or reap with "reconnect" instruction if default is
  also gone)
- Pair removed from `pairs` Map; registry entry removed
- `abg pairs ls` no longer shows `work`

### M07 — PAIR_PORTS_BUSY recovery

Setup: pair "work" was previously live, then `abg kill` killed daemon
+ codex. Start an unrelated process on port 4510 (`work`'s registered
appPort).

Action: `abg codex --pair work --via-proxy`

Asserts:
- CLI exits with `PAIR_PORTS_BUSY` message
- `conflictPort: 4510` shown
- `conflictPid: <unrelated process PID>` shown (per P5c)
- Recovery: `abg pairs rm work --forget` succeeds, then
  `abg codex --pair work --via-proxy` allocates new ports and works

### M08 — daemon restart with registry persisted

Setup: pairs `default`, `work`, `side` previously ensured. Run
`abg kill && bun src/daemon.ts` to restart daemon.

Asserts:
- Registry survives in `pairs/registry.json`
- After restart, `abg pairs ls` shows all 3 with isLive=false
  (registry-only entries)
- `abg codex --pair work --via-proxy` rehydrates `work` using the
  SAME ports as before (registry reused)

### M09 — concurrent ensure_pair("work") dedup

Setup: daemon up, no pairs live yet.

Action: from two separate processes, simultaneously open control WS
and send `ensure_pair("work")` with different requestIds.

Asserts:
- Both receive `pair_ensured` with the same URLs
- daemon spawns work's CodexAdapter exactly once (verified via
  `ps` count — should be 1, not 2)

### M10 — `abg pairs ls` output formatting

Setup: 3 pairs live with various paired/isolated chat counts.

Asserts:
- Table renders with proper column alignment
- LIVE column shows ● vs ○ correctly
- PAIRED-CHAT column shows chatId or `-`
- CHATS column reflects attachedClaudes count

### M11 — `abg pairs rm work --force` while paired

Setup: pair "work" live with paired Claude.

Action: `abg pairs rm work` (no `--force`)

Asserts:
- Exits with `PAIR_BUSY_NOT_FORCED` message
- Pair untouched

Action: `abg pairs rm work --force`

Asserts: same as M06.

### M12 — crash isolation smoke (any code path throws)

Setup: 3 live pairs.

Action: inject a thrown exception into one pair's `agentMessage` handler.

Asserts:
- Daemon's `uncaughtException` handler logs but doesn't crash
- Other 2 pairs continue serving messages

## Implementation notes

When implementing, reuse the v2.2 `probes/shared-thread/lib.ts` harness
pattern. Specifically:

- `ProbeOptions` with `basePort` offset to avoid colliding with the
  developer's running daemon
- `startManagedDaemon()` spawn + `await waitForHealth()` synchronization
- Cleanup hook that walks every pair's codex.pid and kills the lot
- Per-probe state dir under `/tmp/agentbridge-multi-pair-probe-<name>`

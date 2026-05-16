# Shared Thread Mode — Multi-Pair Vertical Upgrade (v2.3)

**Status:** Draft v0.3 — Codex second-pass review (codex_msg_5753c73beafc_70) integrated. §0-§4 awaiting third-pass (lock) review before §5-§12 are drafted.
**Builds on:** `docs/shared-thread-mode-spec.md` (v2.2, implemented in commits `f84346e` + `54e806e`).
**Author:** Claude (Opus 4.7), cross-reviewed by Codex.
**Date:** 2026-05-16

## 0. v2.2 → v2.3 changelog

v2.2 ships a single `proxyTuiSlot` per daemon and a single shared Codex thread. By design, only one `--via-proxy` TUI can connect at a time; a second is rejected at the WS handshake (spec v2.2 §2 non-goal, §4.6 rejection logic, §8 E1). That decision was correct for v2.2's scope but it explicitly excludes the use case the user actually wants: running several independent (Claude, TUI, Codex thread) pairs in parallel on the same machine, each isolated from the others.

v2.3 lifts this restriction by generalizing the daemon's cardinality from "one slot" to "N slots", where each slot owns its own CodexAdapter, its own Codex app-server port, and its own paired Claude. The single-pair v2.2 case continues to work without any user-visible change.

### v0.1 → v0.2

- §2 Goals: split "stable pair identifiers" into namespace-vs-binding clarification; added "pair crash isolation" as an explicit goal.
- §3 Architecture: added explicit singleton-vs-per-pair table; removed misleading "TUI passes pair id at WS handshake" wording — pair identity is implicit in the per-pair proxy port, which CLI obtains by `ensurePair`-ing the daemon first.
- §4: revised D2/D3/D4 per Codex finding; added pair-name validation rules to D1; added migration-impact details to D5; introduced D6-D9 (duplicate TUI, status schema, resource limits, event routing).

### v0.2 → v0.3 (this revision)

Codex second-pass review (codex_msg_5753c73beafc_70) flagged spec-level protocol/lifecycle gaps. Architecture direction was approved; this revision tightens contracts before §5-§12 depend on them.

- **D1**: clarified `--pair default` semantics — it is accepted as an explicit alias for omission (not rejected). "Reserved" only means the user-allocation path cannot remove or remap it, not that the name is unspeakable.
- **D2**: rewrote port-allocation persistence and recovery — registry source-of-truth is the state-dir's `pairs/registry.json` (NOT the project-local `.agentbridge/config.json` which `ConfigService` reads). Added in-daemon `ensurePairInFlight` mutex to serialize concurrent allocations. Specified atomic registry write (temp file + rename). Defined `PAIR_PORTS_BUSY` recovery semantics.
- **D3**: added an explicit daemon-restart row to the lifecycle table — restart cancels all in-flight grace windows, brings no pairs live, reconciles stale pair dirs/pids on first `ensurePair`, and surfaces `PAIR_NOT_FOUND` for a Claude that explicit-attaches before any TUI ensures the pair.
- **D5**: corrected migration-impact list per Codex investigation — `e2e-cli.test.ts` does not actually read root `codex-wrapper.log`; the real touch points are `codex-tui.pid`, top-level `status.json` field readers, fake daemon status fixtures, `state-dir.test`, and `kill.ts`'s single-pid walk. Added an explicit implementation-order constraint: **P1 must not move filesystem layout — D5 changes land in P3 alongside the `ensurePair` API**.
- **D6**: added `requestId` correlation to all pair-management control messages; added `claude_connect_result` to the protocol shape so the bridge can surface explicit-pair failures as a user-visible disabled state; clarified `/readyz` semantics — in v2.3 daemon readiness means "control-plane ready", pair readiness is conveyed by `ensurePair`'s response.
- **D9**: replaced `removeAllListeners()` with targeted `off(name, ref)` tracking — pair tear-down only removes the handlers it registered, leaving diagnostics or future internal listeners intact.

## 1. Motivation

Today, the user works on multiple projects in parallel — for example, two Claude Code windows side-by-side, each with its own Codex TUI on the right. v2.2's hard limit means the second window's `abg codex --via-proxy` exits with:

```
[agentbridge] Error: another `agentbridge codex --via-proxy` TUI is already
connected to the daemon. Shared-thread mode supports at most one proxy TUI
at a time.
```

The workaround in v2.2 (`abg codex` direct mode, no proxy, no pairing) is not equivalent: it loses the right-pane TUI ↔ paired Claude shared-thread experience that v2.2 was built for. The user wants that experience for every window.

This is explicitly the "C-1 vertical upgrade" path agreed upon during v2.2 kickoff (`project_agentbridge_v2_kickoff.md`).

## 2. Goals & non-goals

### Goals

- **Multiple parallel pairs**: N independent (Claude, TUI, Codex thread) pairs on the same machine, each isolated from the others. No cross-talk in messages, threads, or state.
- **v2.2 single-pair compatibility**: `abg codex --via-proxy` with no extra flags should behave exactly as it does in v2.2. No user retraining for the simple case.
- **Per-pair Codex app-server**: each pair has its own `codex app-server` process listening on its own port. The daemon manages all of them.
- **Per-pair CodexAdapter**: the daemon owns a `Map<pairId, CodexAdapter>` instead of a single `codex` singleton.
- **Per-pair proxy slot**: the daemon owns a `Map<pairId, ProxyTuiSlot>` instead of a single `proxyTuiSlot`.
- **Pair-aware ClaudeAdapter routing**: each Claude is associated with at most one pair (its "home pair"). Reply / inject / event routing happens within that pair's scope only.
- **Stable pair identifier namespace + config across daemon restarts**: pair *names* and their port assignments (the registry) survive daemon restarts; live pair *bindings* (which Claude is paired with which slot) do not. This makes "reconnect Claude to its previous pair" mean "reconnect to a pair with the same id and ports", not "restore the in-memory paired-chat state". (Per Codex review: §1-§2 finding on conflicting wording.)
- **Pair crash isolation**: one pair's Codex app-server crashing or its TUI dying must not affect any other pair. Each pair is its own failure domain. (Per Codex review: explicitly elevated from edge case to goal.)
- **Backwards-compatible MCP surface**: the existing `reply` / `get_messages` tools keep working without per-pair API; pair context is derived from the Claude's connection (via the `pairId` field carried in the `claude_connect` control message — see D4).

### Non-goals

- **Cross-pair routing**: messages stay inside their pair. No `@pair-other:` addressing in v2.3. That belongs to a future "rooms" model (`docs/v2-architecture.zh-CN.md`).
- **Pair migration**: once a Claude is paired with pair X, it cannot be moved to pair Y without disconnect+reconnect.
- **Mid-session pair rename**: pair IDs are immutable for the lifetime of the pair.
- **SQLite persistence of pair live state**: live pair binding (paired-chat slot, readiness, in-flight turn flags) is in-memory; daemon restart loses it. Pair *registry* (id → port assignment) MAY be persisted via a small JSON file under the state dir — see D2.
- **Approval/permission cross-pair UI**: each TUI shows only its own pair's approvals.
- **Auto-pairing policies beyond FIFO**: v2.3 keeps the v2.2 rule (first attaching Claude claims the slot it can claim) — no semantic matching, no name-based affinity. That's `v2-architecture.zh-CN.md` Policy layer territory.

## 3. Architecture overview

```
                  ┌──────────────────────────────────────────┐
                  │             AgentBridge Daemon           │
                  │     (control WS :4502, shared by all)    │
                  │                                          │
                  │  pairs: Map<pairId, PairState> {         │
                  │    "default" → PairState (4500/4501)     │
                  │    "work"    → PairState (4510/4511)     │
                  │    "side"    → PairState (4520/4521)     │
                  │  }                                       │
                  │                                          │
                  │  chats: Map<chatId, ChatState> {         │
                  │    chat_a → home=default, paired         │
                  │    chat_b → home=work,    paired         │
                  │    chat_c → home=default, isolated       │
                  │    chat_d → home=null,    isolated       │
                  │  }                                       │
                  └─────────┬──────────────┬─────────────────┘
                            │              │
            ┌───────────────┴──────────────┴──────────────┐
            │              │              │               │
   ┌────────▼────┐ ┌───────▼─────┐ ┌──────▼────────┐ ┌────▼─────────┐
   │ CodexAdapter│ │ CodexAdapter│ │ proxy TUI     │ │ proxy TUI    │
   │ pair=default│ │ pair=work   │ │ pair=default  │ │ pair=work    │
   │ app:4500    │ │ app:4510    │ │ via :4501     │ │ via :4511    │
   │ proxy:4501  │ │ proxy:4511  │ │               │ │              │
   └─────────────┘ └─────────────┘ └───────────────┘ └──────────────┘
            │              │
   ┌────────▼─────────┐ ┌──▼─────────────┐
   │ codex app-server │ │ codex app-server│
   │  port 4500       │ │  port 4510      │
   └──────────────────┘ └─────────────────┘
```

### What stays singleton vs what becomes per-pair

Per Codex review: explicit list of cardinality.

| Concept | v2.2 location | v2.3 cardinality |
|---|---|---|
| Daemon control WebSocket (`:4502`) | global | **singleton** (shared by all bridges/CLI clients) |
| `daemon.pid` / `daemon.lock` / `killed` sentinel | global state dir | **singleton** |
| `agentbridge.log` (daemon-level events) | global state dir | **singleton** |
| Root `status.json` | global state dir | **singleton**, but content becomes aggregate (see D7) |
| `ConfigService` | global | **singleton** |
| `chats: Map<chatId, ChatState>` | global | **singleton** (chats know their home pair via `homePairId` field) |
| `idleShutdownTimer` coordinator | global | **singleton** (considers all pairs + chats) |
| `TuiConnectionState` | global | **per-pair** (each pair has its own connect/disconnect notice flow) |
| `CodexAdapter` instance | global `codex` | **per-pair** (one per pair, with its own ports/process/event emitter) |
| `proxyTuiSlot` | global `let` | **per-pair** (each `PairState` owns its slot) |
| Codex app-server process | global | **per-pair** (spawned by the pair's CodexAdapter) |
| Per-pair log (`codex-<pair>.log` or `pairs/<pair>/codex.log`) | n/a (single `codex-wrapper.log`) | **per-pair** (see D5) |

### How pair identity reaches the TUI

There is no pair id field in the TUI ↔ daemon WebSocket handshake. Instead:

1. User runs `abg codex --pair work --via-proxy`.
2. CLI sends `ensure_pair("work")` over the existing daemon control WS (see D6 for the protocol shape).
3. Daemon allocates ports for `work`, spawns the per-pair CodexAdapter + Codex app-server, and returns `{ proxyUrl: "ws://127.0.0.1:4511", appServerUrl: "ws://127.0.0.1:4510" }`.
4. CLI spawns `codex --remote ws://127.0.0.1:4511 --remote-auth-token-env AGENTBRIDGE_PROXY_TOKEN ...` as it does in v2.2.
5. Pair identity is **implicit in the proxy port** the TUI is connected to. Daemon looks up the pair by the proxy port it observed the connection on.

The Authorization Bearer token from v2.2 §4.6 still applies — but only to distinguish the primary `--via-proxy` TUI from its own secondary picker connection *within the same pair*. It does not encode pair identity.

## 4. Key architectural decisions

Nine decisions that shape §5-§12. After Codex first-pass review (codex_msg_5753c73beafc_65) D2/D3/D4 were revised, D1/D5 had validation/migration details added, and D6-D9 were introduced.

### D1. Pair identification: how are pairs named?

**Decision: named pairs with strict validation; `default` is explicit-addressable.**

- User chooses the name: `abg codex --pair work`.
- Omitting `--pair` defaults to `"default"`. `abg codex --pair default` is **accepted** as an explicit alias for omission — same code path, same pair, no error. (Codex v0.3 clarification: `default` is "reserved" in the sense that no one can remove or remap it, not that the name is unspeakable.)
- Valid pair name regex: `^[a-z0-9][a-z0-9_-]{0,31}$`. Lowercase letters, digits, underscores, hyphens; first character must be alphanumeric; length 1-32 chars.
- Disallowed names: `.`, `..`, anything containing `/`, `\`, control chars, whitespace, or other filesystem-sensitive characters. (`default` itself is permitted, see above.)
- Pair names are case-sensitive but lowercase-only (so collision on case folding is impossible).
- Validation lives in a single helper (`isValidPairName`) reused by CLI parsing, control protocol message validation, and state-dir path construction.

**Why these limits**: D5 uses pair id directly as a filesystem path component (`pairs/<pair>/...`). Anything that's safe as a path component and a JSON key is safe everywhere else we use pair ids. (Codex review: validation is not optional with D5 in place.)

### D2. Port allocation: how does each pair get its ports?

**Decision: state-dir registry as source of truth, fixed `default`, mutex-guarded allocation, atomic writes, with CLI always asking the daemon for the actual URL.**

**Source of truth (Codex v0.3 clarification):**

The pair → port assignment lives in `<stateDir>/pairs/registry.json` — NOT in the project-local `.agentbridge/config.json` that `ConfigService` reads. Reasoning: ports are a machine-global concern (you can't have two daemons own the same port), so the assignment must live next to the daemon's other machine-global state. `ConfigService` stays project-scoped for project-tunable settings (filter mode, attention window, etc.) and is not extended for pair ports.

**Allocation algorithm:**

- `default` pair gets fixed ports `4500/4501` (the v2.2 values). Always. The default entry is materialized in the registry on first daemon boot if missing.
- Named pairs are assigned the next free stride: `4510/4511`, `4520/4521`, `4530/4531`, ... up to `AGENTBRIDGE_PAIR_PORT_MAX` (default 20 strides, max ports `4710/4711`).
- Stride step (`AGENTBRIDGE_PAIR_PORT_STRIDE`, default 10) leaves headroom for future per-pair ports (e.g. a per-pair health endpoint) without colliding with the next pair.
- Optional **machine-global override** via an env var read by the daemon at boot: `AGENTBRIDGE_PAIR_PORTS_FILE` pointing to a JSON like `{ "work": { "appPort": 5510, "proxyPort": 5511 } }`. If set and the file exists, those entries take precedence over stride allocation but are still merged into the registry on first ensure. This is the escape hatch for power users; the registry remains the live source-of-truth that the daemon reads/writes during normal operation.
- **CLI never assumes ports from a stride formula.** `abg codex --pair NAME` always calls `ensurePair(NAME)` first and uses the daemon's reply for `--remote ws://...`.

**Concurrency safety (Codex v0.3 finding):**

- Daemon maintains an in-memory `ensurePairInFlight: Map<pairId, Promise<EnsurePairResult>>`. A second `ensurePair(pairId)` arriving while the first is mid-flight subscribes to the same promise rather than racing into a duplicate allocation/spawn path.
- Registry writes are **atomic**: write to `<stateDir>/pairs/registry.json.tmp.<random>`, then `rename()` over the target. A partial write or crash mid-write cannot corrupt the registry.
- On startup, daemon reads the registry, validates each entry (port range, name regex), and discards any entry that fails validation with a logged warning.

**Port-busy recovery (`PAIR_PORTS_BUSY`):**

- If a registry-assigned port is held by a foreign process at `ensurePair` time, daemon returns `pair_error { code: "PAIR_PORTS_BUSY", message, details: { conflictPort, conflictPid } }` and does NOT reallocate.
- Registry entry is preserved (so the user can fix the upstream conflict and retry).
- User recovery actions:
  - Stop the conflicting process and retry `ensurePair`.
  - Use `abg pairs rm NAME --forget` to drop the registry entry; the next `ensurePair(NAME)` allocates from the stride table again.
  - Manually edit registry.json (with daemon stopped) or use `AGENTBRIDGE_PAIR_PORTS_FILE` override.
- Daemon does NOT auto-kill AgentBridge-owned stale processes (to avoid cascading kills across pairs). If `conflictPid` matches an entry in `<stateDir>/pairs/<other>/codex.pid`, the daemon logs that the conflict is internal so the user knows to use `abg kill` rather than fight with random PIDs.

**Why this rather than pure deterministic stride**: with lazy creation, `work` could be 4510 today and 4520 tomorrow depending on which pair was created first. Registry persistence breaks that ambiguity. The stride is only a default; once a port is assigned it sticks.

### D3. Pair lifecycle: when are pairs created and destroyed?

**Decision: lazy creation by CLI via `ensurePair`, lazy destruction with separate TUI grace and Claude grace.**

**Creation:**
- Daemon starts with empty `pairs` map (the registry is loaded but not live).
- `abg codex --pair NAME` calls `ensurePair(NAME)` on the daemon:
  - If pair already live → return its current URLs.
  - If pair has a registry entry → bring it up using the registered ports.
  - If pair is new → validate name (D1), allocate ports (D2), persist to registry, start the CodexAdapter + Codex app-server, return URLs.
- Pair creation is bounded by `AGENTBRIDGE_MAX_PAIRS` (default 8) — see D8.

**Destruction (the key clarification per Codex review):**

The two grace windows from v2.2 §5 split into independent dimensions in v2.3:

| Trigger | What gets reaped | What stays |
|---|---|---|
| Proxy TUI WS disconnect on pair P | After `AGENTBRIDGE_TUI_REAP_MS` grace (default 30s): tear down pair P entirely — stop CodexAdapter, kill codex app-server, release ports, transition P's paired chat to isolated (using v2.2's `transitionToIsolated` machinery). | Other pairs unaffected. P's registry entry survives so a future `ensurePair(P)` re-allocates the same ports. |
| Paired Claude WS detaches on pair P | After `AGENTBRIDGE_PAIR_REAP_MS` grace (default 30s, same as v2.2): clear `pairs.get(P).pairedChatId`; reap the paired chat state (same as v2.2 `detachClaudeWs` reaper). | Pair P itself stays live — its Codex app-server, TUI, and ports remain. Another Claude can attach and claim the now-empty slot. |
| Both TUI and Claude gone with no other Claude in P | TUI grace fires first (or simultaneously) → pair tear-down → no Claude transition needed. | Other pairs unaffected. |
| Daemon receives an explicit `destroyPair(P)` control message | Immediate teardown of P, equivalent to TUI grace expiry. | Other pairs unaffected. Registry entry survives unless `--forget` flag is set. |
| Daemon restart (`abg kill` + `abg codex` cycle, or process crash + supervisor restart) | All in-flight grace timers cancelled; `pairs` map is empty on boot (no pairs live); chats map is empty (lost with daemon); any stale `pairs/<pair>/codex.pid` files are reconciled on first `ensurePair(P)` for that pair (existing pid checked; if dead, file removed and fresh app-server spawned; if alive but unowned, returns `PAIR_PORTS_BUSY` per D2). | Registry survives on disk. Pair names + port assignments preserved for the next `ensurePair`. |

`ensurePair` and `destroyPair` are new control messages in the existing daemon control WS — see D6 for the API choice and protocol shape.

**Edge-case interaction with D4 after daemon restart**: a Claude that attaches with an explicit `pairId` (e.g. `AGENTBRIDGE_PAIR=work`) before any TUI has called `ensurePair("work")` since the daemon came back up will get `PAIR_NOT_FOUND` from `attachClaude`, NOT auto-creation. The user must start the TUI first (`abg codex --pair work --via-proxy`) so the pair goes live again. This is the strict semantics already specified in D4; the daemon-restart row is what makes it visible.

### D4. Claude → pair binding: how is a Claude assigned to a pair?

**Decision: pair id travels in `claude_connect` as a typed field; FIFO claim when omitted; strict error when an explicit pair is unavailable.**

**Path** (Codex review: env cannot reach daemon directly):

```
User opens Claude window
  → MCP client launches Claude Code (`agentbridge claude` or normal `claude`)
  → ENV is propagated: AGENTBRIDGE_PAIR=work (optional)
  → bridge.ts reads process.env.AGENTBRIDGE_PAIR
  → DaemonClient.attachClaude(chatId, { pairId: "work" })
  → control message: { type: "claude_connect", chatId, pairId?: "work" }
  → daemon's attachClaude resolves pairId
```

**Resolution rules in `attachClaude`:**

1. If `pairId` is provided in `claude_connect`:
   - Validate name (D1). If invalid → reply with `claude_connect_result { ok: false, error: "INVALID_PAIR_NAME" }`.
   - If pair is not live → reply with `claude_connect_result { ok: false, error: "PAIR_NOT_FOUND" }`. Do NOT auto-create; pairs are created by `abg codex`, not by Claude.
   - If pair is live and has no paired chat → claim it.
   - If pair is live but already paired → reply with `claude_connect_result { ok: false, error: "PAIR_BUSY" }`. Claude stays unattached; no fallback to isolated.
2. If `pairId` is omitted:
   - Iterate `pairs` in registry insertion order. Claim the first pair that is live AND has `pairedChatId === null`.
   - If no such pair exists, attach as isolated (`homePairId = null`).
   - This is the v2.2 default behavior preserved as FIFO-across-pairs.

**Once bound, `homePairId` is sticky for the chat's lifetime.** Reconnect with the same chatId re-binds to the same home pair (assuming that pair is still live).

### D5. State directory layout

**Decision: per-pair subdir + migration map.**

**Layout:**

```
~/Library/Application Support/AgentBridge/      (on macOS)
├── daemon.pid                  ← daemon-wide, singleton
├── daemon.lock                 ← daemon-wide, singleton
├── killed                      ← daemon-wide kill sentinel
├── agentbridge.log             ← daemon-wide events
├── status.json                 ← daemon-wide status (aggregate — see D7)
├── pairs/
│   ├── registry.json           ← pair name → port assignments (D2)
│   ├── default/
│   │   ├── codex.pid           ← per-pair codex app-server pid
│   │   ├── codex-wrapper.log   ← per-pair codex-tui spawn log (was root-level in v2.2)
│   │   └── status.json         ← per-pair detailed status (optional)
│   ├── work/
│   │   ├── codex.pid
│   │   ├── codex-wrapper.log
│   │   └── status.json
│   └── ...
```

**Migration impact (Codex v0.3 investigated against actual repo state):**

- v2.2's `codex-tui.pid` at the state-dir root → moves to `pairs/default/codex.pid`. Touch points: `DaemonLifecycle` (writes/reads pid), `cli/codex.ts` (reads via `lifecycle.readTuiPid()`), `kill.ts` (currently kills a single root-level pid).
- v2.2's `codex-wrapper.log` at the root → moves to `pairs/<pair>/codex-wrapper.log`. Touch points: `CodexAdapter` writes it via `StateDirResolver.codexWrapperLogFile`. (Codex investigated: `e2e-cli.test.ts` does NOT read this file directly — earlier v0.2 wording was wrong.)
- Root `status.json` becomes aggregate with `pairs: [...]` (see D7). Top-level `appServerUrl` / `proxyUrl` / `tuiConnected` / `proxyTuiConnected` / `threadId` keep working as `default`-pair flat-compat shims. Touch points: `DaemonLifecycle.writeStatus()`, the e2e fake-daemon fixture in `e2e-cli.test.ts:appServer / proxyServer` blocks (which fabricate a `DaemonStatus`), and `state-dir.test`.
- `abg kill` (`src/cli/kill.ts` per current layout) must walk `pairs/*/codex.pid` and SIGTERM each before SIGTERM-ing the daemon. Cleanup must be best-effort: a malformed pair dir should not block kill of others.
- D1 name validation is a precondition for D5 — daemon must never accept a pair name that escapes `pairs/`.

**Implementation-order constraint (Codex v0.3 finding):**

D5 changes (filesystem layout, fake-daemon fixtures, kill walker) land in **P3** alongside the `ensurePair` API and registry — NOT in P1's internal refactor. P1 keeps the v2.2 root-level paths intact and merely introduces the `Map<pairId, PairState>` data structure keyed by `"default"`. This preserves the "P1 behavior unchanged" promise (see §11 phasing) and keeps the existing test suite green without touching test fixtures until P3 is ready to redo them coherently.

### D6. Pair management API: control WS or HTTP?

**Decision: extend the existing control WS protocol with request-correlated `ensurePair` / `destroyPair` / `listPairs` messages plus a typed `claude_connect_result`.**

**Protocol shape (Codex v0.3 finding: all messages need `requestId` for correlation):**

```typescript
// Existing claude_connect now carries optional pairId (D4) and the daemon
// MUST reply with a typed result so the bridge can surface explicit-pair
// failures as a user-visible disabled state.
{ type: "claude_connect", requestId, chatId, pairId?: string }
  → { type: "claude_connect_result", requestId, ok: true, homePairId: string | null, paired: boolean }
  → { type: "claude_connect_result", requestId, ok: false, error: "INVALID_PAIR_NAME" | "PAIR_NOT_FOUND" | "PAIR_BUSY" }

// New: lazy pair creation
{ type: "ensure_pair", requestId, pairId: string }
  → { type: "pair_ensured", requestId, pairId, appServerUrl, proxyUrl, isLive: true }
  → { type: "pair_error", requestId, pairId, code: "INVALID_PAIR_NAME" | "PAIR_PORTS_BUSY" | "MAX_PAIRS" | "ALLOCATION_FAILED", message, details? }

// New: destroy
{ type: "destroy_pair", requestId, pairId: string, forget?: boolean }
  → { type: "pair_destroyed", requestId, pairId, registryEntryRemoved: boolean }
  → { type: "pair_error", requestId, pairId, code: "PAIR_NOT_FOUND" | "PAIR_BUSY_NOT_FORCED", message }

// New: introspection
{ type: "list_pairs", requestId }
  → { type: "pair_list", requestId, pairs: PairStatus[] }   // PairStatus shape defined in D7
```

- All messages reuse the existing `ControlClientMessage` / `ControlServerMessage` union from `src/control-protocol.ts`. `requestId` is added uniformly (existing `claude_to_codex` already uses it; the rest follow the same pattern).
- Why not HTTP: the existing daemon already uses control WS for `claude_connect`/`claude_to_codex`. Adding HTTP for one operation creates two parallel surfaces. Keeping it in control WS preserves a single auth/dispatch path.

**Liveness vs readiness (Codex v0.3 clarification):**

- `/healthz` GET endpoint stays for liveness — daemon process is up and the control WS is accepting connections. Returns aggregate `DaemonStatus` (see D7).
- `/readyz` GET endpoint changes semantics: in v2.2 it meant "the single Codex app-server is booted". In v2.3 lazy pairs mean there is no single app-server to wait for. **`/readyz` in v2.3 means "control plane ready"** — i.e. the daemon can accept WS connections and answer `ensurePair`. Pair-level readiness is conveyed by `pair_ensured`'s `isLive: true` field, not by `/readyz`.
- CLI clients should treat `/readyz` as "daemon is up, you can call `ensurePair`". They should NOT poll `/readyz` and assume that means their pair's app-server is reachable.

**CLI usage:**

- `abg codex --pair NAME --via-proxy` connects to daemon control WS as a transient client, sends `ensure_pair(NAME)` with a fresh `requestId`, waits for the correlated `pair_ensured` or `pair_error`, then spawns codex with the returned `proxyUrl`.
- Optional new commands: `abg pairs ls`, `abg pairs rm NAME`. Both are thin wrappers around `list_pairs` / `destroy_pair`.

### D7. Status schema: aggregate vs flat

**Decision: aggregate `DaemonStatus` with a flat-compatibility shim for `default`.**

`DaemonStatus` in `src/control-protocol.ts` becomes:

```typescript
interface DaemonStatus {
  bridgeReady: boolean;
  pid: number;
  // Backwards-compat fields populated from `pairs.default` (or null if no default pair live):
  appServerUrl: string | null;
  proxyUrl: string | null;
  tuiConnected: boolean;
  proxyTuiConnected: boolean;
  threadId: string | null;
  // New aggregate fields:
  attachedClaudeCount: number;            // total across all pairs + isolated
  queuedMessageCount: number;             // total across all chats
  pairs: PairStatus[];                    // detailed per-pair view
}

interface PairStatus {
  pairId: string;
  isLive: boolean;
  appServerUrl: string;
  proxyUrl: string;
  tuiConnected: boolean;
  proxyTuiConnected: boolean;
  pairedChatId: string | null;
  threadId: string | null;
  attachedClaudes: { chatId: string; paired: boolean }[];  // chats whose homePairId === pairId
}
```

Existing code that reads `appServerUrl`/`proxyUrl`/`tuiConnected` at the top level keeps working as long as the user has a default pair. Tests that drove specific pairs in v2.2 (only one ever existed) trivially target `default`.

### D8. Resource limits and crash isolation

**Decision: caps + per-pair process supervision + crash containment.**

| Limit / behavior | Default | Override |
|---|---|---|
| Maximum live pairs | 8 | `AGENTBRIDGE_MAX_PAIRS` |
| Maximum strides scanned for allocation | 20 (`4500..4710`) | `AGENTBRIDGE_PAIR_PORT_MAX` |
| TUI reap grace | 30s | `AGENTBRIDGE_TUI_REAP_MS` |
| Pair reap grace (paired-Claude detach) | 30s | `AGENTBRIDGE_PAIR_REAP_MS` |
| Stride step | 10 | `AGENTBRIDGE_PAIR_PORT_STRIDE` |

**Crash isolation rules:**

- Each pair's codex app-server is spawned by its CodexAdapter and supervised by it. If app-server exits, only that pair's CodexAdapter emits an `exit` event and only that pair's chats are notified.
- An exception thrown in one pair's event handler must not unwind the whole daemon. Per-pair handlers are wrapped in `try/catch` at the registration site (best-effort; the v2.2 daemon already has a top-level `uncaughtException` handler that we keep as final safety net).
- `bun run check` adds a smoke test that brings up 3 pairs, kills one's codex app-server, and asserts the others still respond.

### D9. Event routing pattern across multiple CodexAdapters

**Decision: each CodexAdapter is an independent EventEmitter; daemon handlers close over the pair's id at registration time.**

In v2.2, daemon code looks like:

```typescript
codex.on("agentMessage", (msg) => {
  const paired = getPairedChatState();   // walks the single proxyTuiSlot
  ...
});
```

In v2.3, the equivalent registration is per-pair, closing over `pairId`:

```typescript
function attachPairHandlers(pair: PairState) {
  const { pairId, codex } = pair;
  codex.on("agentMessage", (msg) => {
    const paired = getPairedChatStateForPair(pairId);  // walks pair.proxyTuiSlot
    if (!paired) return;
    ...
  });
  // turnCompleted, errorItem, threadClosed, etc. — all the v2.2 handlers, rebound here.
}
```

`attachPairHandlers` runs when a pair becomes live (`ensurePair`). A symmetric `detachPairHandlers` runs on tear-down.

**Handler tracking (Codex v0.3 finding):**

`detachPairHandlers` MUST NOT call `removeAllListeners()` on the per-pair CodexAdapter — that would wipe diagnostics listeners, internal CodexAdapter machinery, and any future subscribers that the daemon does not own. Instead, `attachPairHandlers` records each `(eventName, handlerRef)` pair it registers, and `detachPairHandlers` walks that list calling `codex.off(eventName, handlerRef)` for exactly the handlers it added:

```typescript
type PairHandlerRegistration = { eventName: string; handler: (...args: unknown[]) => void };

function attachPairHandlers(pair: PairState): PairHandlerRegistration[] {
  const refs: PairHandlerRegistration[] = [];
  const register = <E extends string>(eventName: E, handler: (...args: any[]) => void) => {
    pair.codex.on(eventName, handler);
    refs.push({ eventName, handler });
  };

  register("agentMessage", (msg) => { /* ... */ });
  register("turnCompleted", () => { /* ... */ });
  // ... all v2.2 handlers, rebound here.

  return refs;
}

function detachPairHandlers(pair: PairState) {
  for (const { eventName, handler } of pair.handlerRefs) {
    pair.codex.off(eventName, handler);
  }
  pair.handlerRefs = [];
}
```

**No shared event emitter.** Daemon never registers a global `codex.on(...)` callback — every handler is scoped to one pair. This is the cleanest way to prevent event leaks across pairs and keep crash isolation (a thrown handler can't take down sibling pairs' subscriptions).

## 5. CodexAdapter changes

The CodexAdapter class is unchanged in spirit — it still owns one Codex app-server connection, one proxy TUI slot, and one `pairedChatId`. The change is that the daemon now instantiates **N adapters** (one per pair) instead of a singleton.

### 5.1 Constructor signature

v2.2:

```typescript
new CodexAdapter(appPort = 4500, proxyPort = 4501, logFile = stateDir.logFile)
```

v2.3:

```typescript
interface CodexAdapterOptions {
  pairId: string;
  appPort: number;
  proxyPort: number;
  logFile: string;       // per-pair wrapper log path under pairs/<pairId>/ (P3+)
  // optional knobs already present in v2.2 are unchanged
}
new CodexAdapter(opts: CodexAdapterOptions)
```

Why an options object: positional args are already ambiguous (`appPort` / `proxyPort` are easy to swap). Adding `pairId` as a positional fourth arg compounds that. The options object is also easier to extend in P5+ for additional per-pair tunables.

### 5.2 New accessor

```typescript
get pairId(): string { return this.opts.pairId; }
```

Used by the daemon's per-pair event handlers (D9) for logging and message correlation. Not used by CodexAdapter's own logic — the adapter doesn't need to know its pair id to do its job.

### 5.3 What is NOT changing

- `pairedChatId` semantics, `setPairedChat()`, `isPaired()`, `injectMessage()` — all per-adapter, unchanged.
- Secondary-picker token discrimination (spec v2.2 §4.6) — still per-adapter. Each adapter has its own `proxyTuiSlot.token`; the WS-upgrade check compares the incoming `Authorization: Bearer` against THAT adapter's token. Different pairs have different tokens by construction (each `abg codex --pair NAME` generates its own `AGENTBRIDGE_PROXY_TOKEN`), so there is no cross-pair token reuse concern.
- Echo dedup (spec v2.2 §4.5) — per-adapter `injectedTurnIds` / `pendingInjectionHashes` maps stay scoped to the adapter instance.
- Event names and payload shapes (`agentMessage`, `turnStarted`, `turnCompleted`, `userMessage`, `errorItem`, `threadClosed`, etc.) — unchanged.

### 5.4 Process supervision

CodexAdapter already owns its `codex app-server` child process via `spawn()`. v2.3 does not change that — each adapter spawns its own. Per-pair crash isolation (D8) comes for free: adapter A's app-server dying triggers only adapter A's `exit` event; the daemon's per-pair handler decides whether to surface that as a system message to A's chats and tear A down. Adapter B keeps running.

## 6. Daemon state machine

### 6.1 New types

```typescript
interface PairState {
  pairId: string;
  appPort: number;
  proxyPort: number;
  codex: CodexAdapter;                                        // owns the app-server + proxy WS
  tuiConnectionState: TuiConnectionState;                     // per-pair (was singleton in v2.2)
  proxyTuiSlot: ProxyTuiSlot | null;                          // same shape as v2.2, scoped per pair
  pairedChatId: string | null;                                // mirror of proxyTuiSlot.pairedChatId for fast lookups
  readiness: "not-ready" | "ready";
  tuiReapTimer: ReturnType<typeof setTimeout> | null;         // expires the pair after TUI gone
  pairReapTimer: ReturnType<typeof setTimeout> | null;        // expires the paired-chat slot
  handlerRefs: PairHandlerRegistration[];                     // for D9 targeted off()
  isLive: boolean;                                            // false during ensurePair race window or after destroyPair
  createdAt: number;
}

interface ChatState {
  // ... all v2.2 fields ...
  homePairId: string | null;                                  // NEW: which pair this chat belongs to (null = isolated, no home)
}

// Daemon globals replace v2.2's `codex` + `proxyTuiSlot` + assorted timers:
const pairs: Map<string, PairState> = new Map();
const pairRegistry: PairRegistry = loadRegistry(stateDir);    // pairs/registry.json
const ensurePairInFlight: Map<string, Promise<EnsurePairResult>> = new Map();
const chats: Map<string, ChatState> = new Map();              // unchanged from v2.2 except for homePairId field
```

### 6.2 `ensurePair(pairId)` flow

```
1. validate pairId per D1 — reject INVALID_PAIR_NAME
2. if pairs.has(pairId) && pairs.get(pairId).isLive → return existing URLs
3. if ensurePairInFlight.has(pairId) → return the existing promise
4. promise = (async () => {
     a. resolve ports:
        - if pairId === "default" → (4500, 4501)
        - else if registry has entry → use it
        - else allocate next stride; reject MAX_PAIRS if exhausted
     b. probe ports for foreign-process conflict → reject PAIR_PORTS_BUSY with conflictPid/Port
     c. write registry atomically (temp+rename) if entry is new
     d. construct CodexAdapter({pairId, appPort, proxyPort, logFile: pairLogPath(pairId)})
     e. construct PairState; set isLive=false until step (g)
     f. attachPairHandlers(pair) per D9 — record handler refs
     g. await codex.start() — spawns app-server, awaits health
     h. pair.isLive = true; pairs.set(pairId, pair); broadcastStatus()
     i. return { pairId, appServerUrl, proxyUrl, isLive: true }
   })().finally(() => ensurePairInFlight.delete(pairId))
5. ensurePairInFlight.set(pairId, promise)
6. return promise
```

If step (a) — (h) throws, the promise rejects with a `pair_error`. The partial state (CodexAdapter spawned but not started, registry written but not used) is cleaned up in a `catch` before rejecting: kill child process if any, leave registry entry intact (so the next attempt sees the same ports).

### 6.3 `destroyPair(pairId, { forget })`

```
1. validate pairId
2. pair = pairs.get(pairId); if !pair return pair_error PAIR_NOT_FOUND
3. cancel pair.tuiReapTimer / pair.pairReapTimer
4. detachPairHandlers(pair) per D9
5. for each chat where chat.homePairId === pairId:
     - if chat.paired → transitionChatToIsolatedAcrossPairs(chat) — see 6.5
     - else chat.homePairId = null (chat keeps its own ClaudeThread; no message)
6. pair.codex.stop()         // closes WS, kills app-server child
7. pairs.delete(pairId)
8. if forget → remove registry entry (atomic write); else keep entry so ensurePair re-allocates same ports
9. broadcastStatus()
10. respond pair_destroyed
```

`destroyPair` is the explicit teardown. The implicit teardown via TUI reap grace (D3) goes through the same step list except step (1)-(2) come from a timer callback instead of an inbound control message.

### 6.4 `attachClaude` v2.3

```
1. parse claude_connect → { chatId, pairId? } (D4 protocol shape)
2. if chats.has(chatId): resume branch (unchanged from v2.2 except for pairId reconciliation below)
3. else: new chat branch
4. resolve homePairId:
     a. if pairId provided:
        - validate per D1; reject INVALID_PAIR_NAME if bad
        - if !pairs.has(pairId) || !pair.isLive → reply claude_connect_result { ok:false, error: PAIR_NOT_FOUND }
        - if pair.pairedChatId !== null → reply { ok:false, error: PAIR_BUSY }
        - claim: pair.pairedChatId = chatId; chat.homePairId = pairId; chat.paired = true
     b. else: iterate pairs in registry insertion order; claim the first live pair with pairedChatId === null:
        - claim same as above
        - if none found → chat.homePairId = null; chat.paired = false (isolated)
5. if chat.paired: skip ClaudeThread.bootstrap() — uses pair.codex.injectMessage; chat.ready = pair.readiness === "ready"
6. else: construct ClaudeThread targeting (we still need a Codex app-server for isolated chats — see 6.6 below)
7. reply claude_connect_result { ok:true, homePairId, paired }
```

### 6.5 Cross-pair isolation transition

When a pair tears down (TUI gone or `destroyPair`), its paired chat needs to keep working. v2.2's `transitionToIsolated(state, reason)` is generalized:

```typescript
function transitionChatToIsolatedAcrossPairs(state: ChatState) {
  const formerPair = pairs.get(state.homePairId!);  // may already be undefined post-tear-down
  state.paired = false;
  state.homePairId = null;                          // chat is now homeless / isolated
  // remaining steps identical to v2.2 transitionToIsolated:
  //  - reset replyRequired / replyReceivedDuringTurn / pairedTurnSawAgentMessage
  //  - emit system_pair_torn_down
  //  - construct fresh ClaudeThread targeting the chat's old app-server URL
  //  - bootstrap with the v2.2 retry helper bootstrapIsolatedThread()
}
```

The ClaudeThread for the new isolated chat targets which app-server? Two options:

- **(a)** Target the former pair's `appServerUrl` if that app-server is still up (e.g. only the TUI WS died, the codex process is still healthy). Reuse the existing thread connection. **Risk**: pair tear-down kills the app-server too (6.3 step 6), so by the time `transitionChatToIsolatedAcrossPairs` runs, the URL points to nothing.
- **(b)** Target the `default` pair's app-server, ensuring `default` is live first. This guarantees the isolated chat has a working backend, but it means a `work`-paired Claude transitions onto the `default` Codex thread, which may be running unrelated turns for other chats.

**Spec choice (a) with a caveat**: tear-down ordering is changed so `transitionChatToIsolatedAcrossPairs` runs BEFORE `pair.codex.stop()`. The chat's new ClaudeThread connects to the soon-to-die app-server during a small window where the app-server is still alive. The thread bootstrap establishes a new Codex thread (per v2.2 §5 "no replay"), and then `pair.codex.stop()` kills the app-server. Result: the chat's new isolated ClaudeThread loses its connection almost immediately and triggers the v2.2 retry helper (`bootstrapIsolatedThread`, max 2 attempts). The retries will fail (no app-server), and the chat ends in the v2.2 "reap chat after retries exhausted" path with the "reconnect Claude" instruction — which IS now actionable thanks to commit 54e806e.

This is acceptable because the alternative (option b, attaching to `default`) violates pair isolation (D8). If a user wants the chat to continue, they should re-attach Claude — the daemon will then iterate pairs, find `default` (or whichever is now live) and either claim its slot or attach isolated against its app-server.

### 6.6 Isolated chats and their app-server

A chat that is `homePairId = null` (was never paired, or was reaped) needs a Codex app-server to talk to. v2.2 had only one; v2.3 has N. Spec choice: **isolated chats target the `default` pair's app-server**. The `default` pair is always present in the registry (D1) and is always live during normal use (its app-server starts on first `abg codex --via-proxy` with no `--pair` flag).

If `default` is not live (e.g. user destroyed it explicitly), isolated chats are stranded — `bootstrapIsolatedThread` fails and the chat is reaped with the "reconnect Claude" instruction. This is consistent with v2.2 behavior where the singleton codex going down strands all chats.

## 7. ClaudeAdapter / routing changes

The MCP-facing surface (`reply`, `get_messages`) is unchanged. Pair routing is entirely server-side; Claude never sees a `pairId` in the tool surface.

### 7.1 Per-chat pair context

`ChatState.homePairId` (added in §6.1) is the only routing knob. Every server-side branching point that v2.2 keyed off `state.paired` now keys off `state.homePairId` + `state.paired`:

```typescript
function handleClaudeToCodex(ws, message) {
  // ... existing chatId resolution and state lookup ...
  if (state.paired) {
    const pair = pairs.get(state.homePairId!);  // homePairId is set when paired===true
    if (!pair?.isLive || pair.readiness !== "ready") {
      return sendError("Shared Codex TUI thread is still provisioning. Retry shortly.");
    }
    const injected = pair.codex.injectMessage(contentWithReminder);
    // ... rest identical to v2.2 ...
  } else {
    // isolated path: state.thread (a ClaudeThread targeting default pair's app-server) — unchanged
    const injected = state.thread.injectMessage(contentWithReminder);
    // ... rest identical to v2.2 ...
  }
}
```

### 7.2 Outbound event routing

D9 already locked the pattern: per-pair handlers close over `pairId`, look up `pair.pairedChatId`, emit to that chat only. The v2.2 daemon-level `codex.on(...)` handlers all move into `attachPairHandlers(pair)`, with the existing logic preserved verbatim — the only change is replacing `proxyTuiSlot` / `codex` references with `pair.proxyTuiSlot` / `pair.codex`.

### 7.3 UX clarity: surfacing pair id in system messages

System messages emitted to a paired chat are augmented with `[pair: NAME]` prefix when there is more than one live pair:

```
"✅ This Claude session is paired with the right-pane Codex TUI."
   → "✅ [pair: work] This Claude session is paired with the right-pane Codex TUI."  (when N > 1)
```

When only one pair exists (the v2.2 single-pair case), the prefix is omitted to preserve the v2.2 user experience. The "more than one" check happens at message-emission time so the prefix appears/disappears dynamically.

### 7.4 `get_messages` and the offline buffer

Unchanged. The offline buffer is per-chat (already), so cross-pair leakage is impossible by construction — messages buffered for chat A are only flushed to chat A's WS.

## 8. CLI changes

### 8.1 `abg codex` flag changes

- New flag: `--pair NAME`. Default value is `"default"`. Passes `NAME` to the daemon via `ensure_pair` (§6.2).
- `--pair default` is accepted (D1) and equivalent to omitting the flag.
- Validation: CLI rejects invalid pair names locally (`isValidPairName` regex from D1) before contacting the daemon, returning a clear `error: invalid --pair value` message with the allowed character set spelled out.
- Pre-flight flow (replaces the v2.2 `/healthz` `proxyTuiConnected` check):
  1. CLI calls `ensure_pair(NAME)` over control WS.
  2. On `pair_error PAIR_PORTS_BUSY` → CLI exits with `error: ports for pair "NAME" (appPort=X, proxyPort=Y) are held by PID Z. Stop that process or use 'abg pairs rm NAME --forget' to reassign.`
  3. On `pair_error MAX_PAIRS` → CLI exits with `error: max pairs reached (N). Destroy an unused pair with 'abg pairs rm NAME'.`
  4. On `pair_ensured` with `proxyTuiConnected: true` (returned via a follow-up `list_pairs` call if the spec wants strict separation, or piggybacked on `pair_ensured`) → CLI exits with the v2.2-style "another --via-proxy TUI is already connected" message, scoped to this pair.
  5. On `pair_ensured` clean → CLI proceeds to spawn `codex` with `--remote <proxyUrl>` and `--remote-auth-token-env AGENTBRIDGE_PROXY_TOKEN`. Pair id is NOT passed to codex — it does not need to know.

### 8.2 New commands

- `abg pairs ls` → calls `list_pairs`, prints a table:
  ```
  PAIR     APP-SERVER          PROXY                TUI  PAIRED-CHAT       CHATS
  default  ws://...:4500       ws://...:4501        ●    chat_abc          2
  work     ws://...:4510       ws://...:4511        ●    chat_def          1
  side     (not live)          (not live)           ○    -                 0
  ```
- `abg pairs rm NAME [--forget]` → calls `destroy_pair(NAME, { forget })`. Without `--forget`, the registry entry stays so the same name + ports can be re-ensured later. With `--forget`, the registry entry is deleted and a fresh `ensure_pair(NAME)` will allocate a new stride.
- `abg pairs rm NAME` is rejected if `NAME` is currently paired with a live Claude unless `--force` is also passed (avoids accidentally killing a working session).
- `abg pairs` with no subcommand prints help.

### 8.3 `agentbridge claude` flag changes

- New flag: `--pair NAME`. Sets `AGENTBRIDGE_PAIR=NAME` in the spawned Claude's environment. Default: not set, which yields the FIFO claim behavior from D4.
- This is the only env-wiring needed. `bridge.ts` reads `process.env.AGENTBRIDGE_PAIR` at MCP connection time and includes the value in `DaemonClient.attachClaude()`'s `claude_connect` message.

### 8.4 `abg kill` walker change

Per D5, `abg kill` must walk `<stateDir>/pairs/*/codex.pid` and SIGTERM each before SIGTERM-ing the daemon. Cleanup is best-effort — a malformed pair dir (missing or unreadable `codex.pid`) is logged and skipped, not fatal.

## 9. Edge cases

| # | Scenario | Resolution |
|---|---|---|
| ME1 | `ensure_pair("work")` racing with `ensure_pair("work")` from two CLI clients | `ensurePairInFlight` mutex (§6.2 / D2). Both subscribers see the same resolved URLs. |
| ME2 | `ensure_pair("work")` racing with `ensure_pair("side")` from two CLI clients | No conflict — different pairId. Two independent promises, two atomic registry writes. Registry writes use temp+rename so concurrent renames serialize via filesystem. |
| ME3 | Registry corruption (manual edit, partial write before crash) | Daemon validates each entry on startup (port range, name regex); invalid entries are dropped with a logged warning and the user gets a clean slate for those names. Valid entries continue to work. |
| ME4 | Daemon restart with stale `pairs/<pair>/codex.pid` files | Next `ensure_pair(pair)` checks `pid` against `isProcessAlive`. If dead → file removed, fresh app-server spawned. If alive but unowned (foreign user) → `PAIR_PORTS_BUSY` per D2. |
| ME5 | `destroy_pair("work")` while a paired Claude is mid-turn | Tear-down proceeds: the chat is transitioned to isolated (§6.5), but the in-flight turn is abandoned — the paired Claude sees `system_pair_torn_down` and a subsequent retry error. v2.2 had no equivalent because singleton tear-down meant the whole daemon went down. Documented in D3. |
| ME6 | Codex app-server crash on pair `work` (other pairs healthy) | Per-pair `exit` event handler emits `system_codex_exit` to chats whose `homePairId === "work"` only. Other pairs' handlers do not fire. CodexAdapter records the exit; the next `ensure_pair("work")` re-spawns. (D8 crash isolation.) |
| ME7 | `MAX_PAIRS` reached (default 8 live pairs) | `ensure_pair` returns `pair_error MAX_PAIRS`. CLI exits with a clear message. Already-live pairs unaffected. |
| ME8 | Port range exhaustion (`AGENTBRIDGE_PAIR_PORT_MAX` strides all assigned in registry to different names) | `ensure_pair` for a new name returns `pair_error MAX_PAIRS` (same code, message clarifies it's a port range issue). User must `destroy_pair NAME --forget` an unused entry or extend the stride range. |
| ME9 | Claude with `AGENTBRIDGE_PAIR=ghost` attaches before any TUI ensures `"ghost"` | Per D4 strict semantics → `claude_connect_result { ok:false, error: "PAIR_NOT_FOUND" }`. Bridge surfaces a `system_bridge_disabled` message to the user explaining how to start the TUI for that pair. |
| ME10 | Two TUIs `abg codex --pair work` in quick succession | Second TUI's `ensure_pair("work")` returns `pair_ensured` (idempotent), then the CLI's `list_pairs` follow-up shows `proxyTuiConnected: true` and exits with the v2.2-style message scoped to pair "work". First TUI keeps running. |
| ME11 | `default` pair port (4500/4501) conflicts at daemon startup (e.g. unrelated process bound 4500) | On daemon startup, only the registry is loaded — no pairs go live. The first `ensure_pair("default")` (triggered by the first `abg codex --via-proxy`) then runs the port probe and surfaces `PAIR_PORTS_BUSY` to that CLI. Daemon itself stays up. |
| ME12 | Renaming a pair (user wants `work` to become `office`) | Not supported in v2.3 (non-goal §2). Workaround: `abg pairs rm work --forget`, then `abg codex --pair office --via-proxy`. |
| ME13 | `kill` command racing with `ensure_pair` | `kill` writes the killed sentinel and SIGTERMs daemon; SIGTERM handler in daemon rejects any in-flight `ensurePairInFlight` promises with a `pair_error DAEMON_SHUTTING_DOWN`. Pair processes get killed by `kill` walking `pairs/*/codex.pid` (§8.4). |

## 10. Test matrix

Mirrors v2.2 spec §9 — probe scripts under `probes/multi-pair/` plus daemon-level unit tests extending the v2.2 suite.

### 10.1 Probes (live WS clients, run manually or via `bun probes/multi-pair/m*.ts`)

| # | Scenario | Asserts |
|---|---|---|
| M01 | Bring up two pairs (`default` + `work`), one Claude each, send a message in each. | Two distinct threadIds. Messages routed to the correct paired Claude. No cross-talk. |
| M02 | Bring up two pairs; kill `work`'s codex app-server with SIGKILL. | `work` chats see `system_codex_exit`; `default` chats unaffected; `default` keeps responding to messages. |
| M03 | Two `abg codex --pair work` invocations in series; second exits 1 with "already connected" message scoped to pair "work". | Pre-flight rejection works per-pair. |
| M04 | Claude with `AGENTBRIDGE_PAIR=work` attaches before TUI ensures "work". | `claude_connect_result.error === "PAIR_NOT_FOUND"`. Bridge enters disabled state with a clear system message. |
| M05 | Three Claudes attach with no `AGENTBRIDGE_PAIR`; two pairs live (`default`, `work`); user typed in TUI of each. | FIFO claim: Claude 1 → default (paired), Claude 2 → work (paired), Claude 3 → isolated against default's app-server. |
| M06 | `destroy_pair("work")` while paired Claude is mid-turn. | Paired Claude receives `system_pair_torn_down`; new ClaudeThread created targeting default; bootstrap retries exhausted (work's app-server is dying); chat reaped with "reconnect Claude" instruction. |
| M07 | `ensure_pair("work")` registered with port 4510; user starts an unrelated process on 4510; `abg codex --pair work --via-proxy` retried. | `pair_error PAIR_PORTS_BUSY` with `conflictPid` populated; CLI message includes the PID. |
| M08 | Daemon restart with `default` and `work` previously live. | Registry survives; both pairs absent from `pairs` map until each is `ensure_pair`'d again. CLI's first `abg codex --pair work` rehydrates work with the same ports. |
| M09 | Concurrent `ensure_pair("work")` from two CLI clients (race ME1). | Both see the same `pair_ensured` payload; only one CodexAdapter constructed; registry written once. |
| M10 | `abg pairs ls` with three live pairs and varied state. | Output table matches §8.2 example: live indicator, TUI dot, paired-chat column. |
| M11 | `abg pairs rm work --forget` while work is paired. | Rejected unless `--force`. With `--force`: transition chat to isolated, kill app-server, remove registry entry, port stride released. |
| M12 | Crash isolation: throw in one pair's `agentMessage` handler. | Other pairs' handlers still fire. Daemon-level `uncaughtException` logs the throw. |

Sandbox note (same as v2.2 §12): Codex cannot bind local listeners. Probes are written there but executed on user-side terminals or in Claude's local environment.

### 10.2 Unit tests (extends `src/unit-test/daemon.test.ts`)

| # | Scenario | What gets asserted |
|---|---|---|
| U01 | `isValidPairName` boundary cases | Regex matches D1 exactly; reserved-but-allowed `default` returns true; `..`, `/x`, `Work`, empty string return false. |
| U02 | Registry round-trip | `loadRegistry` after `saveRegistry({work: {4510,4511}})` returns same object; atomic write uses temp+rename (verify via file watcher). |
| U03 | `ensurePairInFlight` mutex | Two concurrent `ensurePair("work")` calls produce one promise; both callers see same `pair_ensured`. |
| U04 | `attachPairHandlers` / `detachPairHandlers` symmetry | After detach, `pair.codex.listenerCount(event)` is unchanged from baseline (no leaks, no over-removal). |
| U05 | `attachClaude` FIFO across pairs | Two live unpaired pairs; two Claudes attach without `pairId`; first claims pair 1, second claims pair 2. |
| U06 | `attachClaude` PAIR_BUSY | Pair with `pairedChatId` set; Claude attaches with explicit `pairId` for same pair; receives `claude_connect_result.error === "PAIR_BUSY"`. |
| U07 | `attachClaude` PAIR_NOT_FOUND | Pair not in pairs map; explicit `pairId` attach receives error. |
| U08 | `transitionChatToIsolatedAcrossPairs` flag reset | Pair-paired chat with `replyRequired=true`; trigger tear-down; chat's flag is `false` after transition (carries over the v2.2 bug fix from 54e806e). |
| U09 | `destroyPair` with `forget=false` keeps registry; `forget=true` removes | Verify registry.json contents after each. |
| U10 | Daemon restart reconciliation | Pre-seeded registry + stale `codex.pid` pointing to a dead PID; `ensurePair` on that pair cleans the pid file and spawns fresh. |

### 10.3 What stays from v2.2

All 17 tests in `daemon.test.ts` from commit `54e806e` continue to apply, but reframed: every "the proxy slot" becomes "the default pair's proxy slot". P1's internal refactor keeps the v2.2 tests passing unchanged by hardcoding `pairId = "default"` everywhere v2.2 referenced the singleton.

## 11. Implementation phases

Five small PRs, each independently mergeable to `master` (or the v2.3 long-running branch), each gated on `bun run check` and Codex review.

| Phase | Scope | Behavior change | Test impact |
|---|---|---|---|
| **P1** | Internal refactor: replace daemon-level singletons (`codex`, `proxyTuiSlot`, `TuiConnectionState`) with `pairs: Map<pairId, PairState>` keyed only by `"default"`. `ChatState` gains `homePairId` field, always set to `"default"`. CodexAdapter constructor moves to options object. No new control messages, no CLI flags, no filesystem layout change. | Externally none — `abg codex --via-proxy` works exactly as in v2.2. | All 17 daemon tests + 14 codex-adapter tests + e2e tests pass unchanged. |
| **P2** | CodexAdapter lifecycle as a peer-managed component: daemon spawns / stops adapters via `ensurePair` / `destroyPair` internal calls (no control-protocol API yet). Pair-aware event handler attach/detach (D9 pattern). Still only `default` ever ensured. | Externally none. | Add 5-8 daemon tests covering `attachPairHandlers` symmetry + lifecycle. |
| **P3** | `ensure_pair` / `destroy_pair` / `list_pairs` control protocol (D6). Registry + atomic writes (D2). State dir layout (D5) — files MOVE here, root-level pids/logs deprecated. `kill` walker (§8.4). `claude_connect_result` typed reply (D6). Fake-daemon fixtures and `state-dir.test` updated. | Behavioral: tooling that read root `codex-tui.pid` / `codex-wrapper.log` will break — only `kill.ts` and tests touch those, both updated in this PR. | Add 6-10 daemon tests for registry + protocol + cross-restart. |
| **P4** | CLI `--pair` flag in `abg codex` and `agentbridge claude` (D4, §8.1, §8.3). `abg pairs ls/rm` commands (§8.2). Pre-flight ports-busy / max-pairs error surfacing. | Behavioral: users can now create / list / destroy pairs. `default` remains the only pair anyone has unless they pass `--pair`. | Add CLI tests for new flag parsing + subcommands. Probes M03, M07, M10, M11 land here. |
| **P5** | FIFO pair claim + explicit `AGENTBRIDGE_PAIR` env path (D4 §6.4). Cross-pair isolation transition (§6.5). UX prefix for pair id (§7.3). Multi-pair probes M01, M02, M04, M05, M06, M08, M09, M12. Crash isolation smoke (M02 + M12). | Behavioral: multi-pair is now end-to-end functional. v2.3 use case ships. | Probes + daemon tests cover the new state machine paths. |

PRs land in order. Each merges to a v2.3 long-running branch; the branch merges to master after P5 lands and end-to-end probes pass.

## 12. Division of labor

Same model as v2.2 (`docs/shared-thread-mode-spec.md` §12), with one caveat learned during STM v2.2 implementation:

- **Claude (designer / reviewer / Git operator)**: Spec authorship + iteration. Architecture sign-off. PR review. All Git operations (commit, push, branch ops). Final commit messages (bilingual).
- **Codex (implementer / verifier)**: Per-PR implementation. Unit tests + probes. Empirical verification (`bun run check`, probe execution where Codex's sandbox allows it). Independent analysis of the spec at design time and of the diff at code-review time.
- **Both**: Cross-review at each phase boundary. Spec amendments when implementation surfaces unknowns.

**Caveat (from v2.2 retrospective in `project_agentbridge_v2_kickoff.md`)**: Codex's sandbox during STM v2.2 implementation was forced to `read-only` and could not write files via `apply_patch`. If that constraint persists into v2.3, the fallback is Claude-implements + Codex-read-only-review, as used in commit `54e806e`. The spec assumes the standard Codex-implements path; deviations are recorded in the PR description.

---

**Status**: Draft v0.3, locked. §0-§12 ready for implementation phases (§11) to begin with P1.

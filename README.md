# AgentBridge

[![CI](https://github.com/raysonmeng/agent-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/raysonmeng/agent-bridge/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[中文文档](README.zh-CN.md)

Local bridge for bidirectional communication between Claude Code and Codex inside the same working session.

AgentBridge uses a two-process architecture:

- **bridge.ts** is the foreground MCP client started by Claude Code via the AgentBridge plugin
- **daemon.ts** is a persistent local background process that owns the Codex app-server proxy and bridge state

When Claude Code closes, the foreground MCP process exits while the background daemon and Codex proxy keep running. When Claude Code starts again, it reconnects automatically with exponential backoff.

## What this project is / is not

**This project is:**

- A local developer tool for connecting Claude Code and Codex in one workflow
- A bridge that forwards messages between an MCP channel and the Codex app-server protocol
- An experimental setup for human-in-the-loop collaboration between multiple agents

**This project is not:**

- A hosted service or multi-tenant system
- A generic orchestration framework for arbitrary agent backends
- A hardened security boundary between tools you do not trust

## Features

- **Bidirectional Claude ↔ Codex messaging** in one working session — Codex output is intercepted and pushed to Claude as channel notifications; Claude replies via the `reply` MCP tool, injected into the Codex thread as a `turn/start`.
- **Push delivery with fallback** — messages arrive as channel notifications; a failed push falls back to an in-memory queue drained by `get_messages`. Loop prevention via the per-message `source` field.
- **Turn coordination** — a busy-guard rejects replies during an active Codex turn; a per-turn inactivity watchdog stops a lost `turn/completed` from locking injection forever; noisy intermediate events are collapsed so only meaningful `agentMessage` payloads reach Claude.
- **Multiple pairs side by side** — one Claude+Codex pair per project directory, ports allocated per pair in +10 strides from 4500. Pair-aware `claude` / `codex` / `resume` / `kill` / `doctor` / `budget` via `--pair`.
- **Resilient lifecycle** — a persistent background daemon survives Claude Code restarts (auto-reconnect with backoff); orphan-process cleanup; `abg doctor` read-only diagnostics; `abg pairs prune` reclaims stranded state.
- **Thread auto-resume** — bare `abg codex` resumes the pair's last Codex thread; `abg resume` prints/performs the resume commands for both sides.
- **Budget coordination, slowdown-line & fully-automatic resume** — keep a long task moving across subscription-quota windows instead of dying at a limit. See [Budget Coordination & Auto-Resume](#budget-coordination--auto-resume).

## Architecture

```
┌──────────────┐     MCP stdio / plugin     ┌────────────────────┐
│ Claude Code  │ ──────────────────────────▶ │ bridge.ts          │
│ Session      │ ◀──────────────────────────  │ foreground client  │
└──────────────┘                             └─────────┬──────────┘
                                                       │
                                                       │ control WS (:4502)
                                                       ▼
                                             ┌────────────────────┐
                                             │ daemon.ts          │
                                             │ bridge daemon      │
                                             └─────────┬──────────┘
                                                       │
                                     ws://127.0.0.1:4501 proxy
                                                       │
                                                       ▼
                                             ┌────────────────────┐
                                             │ Codex app-server   │
                                             └────────────────────┘
```

### Data flow

| Direction | Path |
|-----------|------|
| **Codex -> Claude** | `daemon.ts` captures `agentMessage` -> control WS -> `bridge.ts` -> `notifications/claude/channel` |
| **Claude -> Codex** | Claude calls the `reply` tool -> `bridge.ts` -> control WS -> `daemon.ts` -> `turn/start` injects into the Codex thread |

### Loop prevention

Each message carries a `source` field (`"claude"` or `"codex"`). The bridge never forwards a message back to its origin.

## Prerequisites

| Dependency | Version | Install |
|-----------|---------|---------|
| [Bun](https://bun.sh) | v1.0+ | `curl -fsSL https://bun.sh/install \| bash` |
| [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | v2.1.80+ | `npm install -g @anthropic-ai/claude-code` |
| [Codex CLI](https://github.com/openai/codex) | latest | `npm install -g @openai/codex` |

> **Note:** Bun is required as the runtime for the AgentBridge daemon and plugin server. Node.js alone is not sufficient.

## Quick Start

### Install via Plugin Marketplace (recommended)

Install AgentBridge directly from Claude Code using the plugin marketplace:

```bash
# 1. In Claude Code, add the AgentBridge marketplace
/plugin marketplace add raysonmeng/agent-bridge

# 2. Install the plugin
/plugin install agentbridge@agentbridge

# 3. Reload plugins to activate
/reload-plugins
```

Then install the CLI tool:

```bash
# 4. Install the CLI globally
npm install -g @raysonmeng/agentbridge

# 5. Generate project config (optional)
abg init

# 6. Start Claude Code with AgentBridge channel enabled
abg claude

# 7. Start Codex TUI connected to the bridge (in another terminal)
abg codex
```

> **Tip:** `abg` is a short alias for `agentbridge`. Both commands are identical — use whichever you prefer.

That's it. The daemon starts automatically when needed and reconnects if restarted.

#### Updating the plugin

When a new version is released, update from Claude Code:

```bash
/plugin marketplace update agentbridge
/reload-plugins
```

Or enable auto-update: run `/plugin` → **Marketplaces** tab → select **agentbridge** → **Enable auto-update**.

### Install for local development

If you want to modify AgentBridge source code, use the local development setup instead:

```bash
# 1. Clone and install dependencies
git clone https://github.com/raysonmeng/agent-bridge.git
cd agent-bridge
bun install
bun link

# 2. Set up local plugin + project config
agentbridge dev     # Register local marketplace + install plugin
agentbridge init    # Check dependencies, generate .agentbridge/config.json

# 3. Start Claude Code with AgentBridge plugin loaded
agentbridge claude

# 4. Start Codex TUI connected to the bridge (in another terminal)
agentbridge codex
```

> **Note:** `agentbridge claude` injects `--dangerously-load-development-channels plugin:agentbridge@agentbridge` automatically. This loads a local development channel into Claude Code (currently a Research Preview workflow). Only enable channels and MCP servers you trust.

#### Updating after code changes

After modifying AgentBridge source code, re-run `agentbridge dev` to sync changes to the plugin cache, then restart Claude Code or run `/reload-plugins` in an active session.

## CLI Reference

> All commands work with both `agentbridge` and the short alias `abg`.

| Command | Description |
|---------|-------------|
| `abg init` | Install plugin, check dependencies (bun/claude/codex), generate `.agentbridge/config.json` |
| `abg claude [args...]` | Start Claude Code with push channel enabled. **Runs with `--dangerously-skip-permissions` by default** (opt out: `--safe` or `AGENTBRIDGE_SAFE=1`). Clears any killed sentinel from a previous `kill`. Pass-through args are forwarded to `claude` |
| `abg codex [args...]` | Start Codex TUI connected to AgentBridge daemon. **Bare `abg codex` auto-resumes the pair's last thread; use `abg codex --new` for a fresh thread. TUI launches run with `--yolo` by default** (opt out: `--safe` or `AGENTBRIDGE_SAFE=1`; non-TUI subcommands like `exec` are never touched). Manages TUI process lifecycle (pid tracking, cleanup). Pass-through args forwarded to `codex` |
| `abg resume [claude\|codex]` | No target: print the resume commands for this directory's last Claude Code session and this pair's current Codex thread. With a target: resume that side directly (delegates to `abg claude --resume <id>` / `abg codex resume-current`) |
| `abg pairs` | List registered pairs; `abg pairs rm <name\|id>` removes one; `abg pairs prune` previews reclaimable orphan dirs + stranded registry entries (cwd-gone, dead, >1 day), `abg pairs prune --apply` deletes them |
| `abg doctor [--json]` | Read-only diagnosis: env, daemon health/readiness, build drift, artifact alignment, TUI attachment, logs |
| `abg budget [--json]` | Both agents' subscription quota snapshot (5h/weekly windows, drift, pause state) |
| `abg logs [--codex] [-f] [-n N]` | Tail this pair's daemon log (or the Codex wrapper log with `--codex`); `-f` follows, `-n N` sets the line count (default 100) |
| `abg kill` | Gracefully stop this pair's daemon and managed Codex TUI, write killed sentinel; `abg kill --all` stops every pair |
| `abg dev` | (Dev only) Register local marketplace + force-sync plugin to cache |
| `abg --help` | Show help |
| `abg --version` | Show version |

The pair-aware commands (`claude`, `codex`, `resume`, `kill`, `doctor`, `budget`, `logs`) accept `--pair <name>` to target a specific pair — one pair per project directory by default, with ports allocated per pair in +10 strides from 4500.

### Owned flags

Some flags are automatically injected and cannot be manually specified:

- `agentbridge claude` owns: `--channels`, `--dangerously-load-development-channels`
- `agentbridge codex` owns: `--remote`, `--enable tui_app_server`
- Both launchers consume the wrapper flag `--safe` (it is never forwarded): it disables the max-permission defaults for that launch. The defaults are also auto-suppressed when you pass any explicit permission flag yourself (`-a`/`--ask-for-approval`/`-s`/`--sandbox` for codex; `--permission-mode`/`--allow-dangerously-skip-permissions` for claude) — injecting `--yolo` next to an explicit approval policy is a hard codex CLI conflict.

Passing these flags manually will result in a hard error with guidance to use the native command directly.

> **Note on flag positioning for `agentbridge codex`:** For the bare TUI form
> (`agentbridge codex …`), bridge flags are injected at the front. For TUI
> subcommands that carry per-subcommand args (`resume`, `fork`), they are
> injected *after* the subcommand name (so clap parses them as options of the
> actually-invoked command, not the root). Non-TUI subcommands like `exec`,
> `mcp`, `plugin`, `remote-control`, `update` etc. are passed through
> unchanged — no bridge flags injected. See `src/cli/codex.ts buildCodexArgs`
> for the full positioning logic.

## Project Config

Running `agentbridge init` creates a `.agentbridge/` directory in your project root:

| File | Purpose |
|------|---------|
| `config.json` | Machine-readable project config (Codex ports, turn coordination, idle shutdown) |

The config is loaded by the CLI and daemon at startup. Re-running `init` is idempotent and will not overwrite existing files.

## File Structure

```
agent_bridge/
├── .github/
│   ├── ISSUE_TEMPLATE/           # Bug report and feature request templates
│   ├── pull_request_template.md
│   └── workflows/ci.yml          # GitHub Actions CI
├── assets/                        # Static assets (images, etc.)
├── docs/
│   ├── phase3-spec.md            # Phase 3 design spec (CLI + Plugin)
│   ├── v1-roadmap.md             # v1 feature roadmap
│   └── v2-architecture.md        # v2 multi-agent architecture design
├── plugins/agentbridge/           # Claude Code plugin bundle
│   ├── .claude-plugin/plugin.json
│   ├── commands/init.md
│   ├── hooks/hooks.json
│   ├── scripts/health-check.sh
│   └── server/                    # Bundled bridge-server.js + daemon.js
├── src/
│   ├── bridge.ts                  # Claude foreground MCP client (plugin entry point)
│   ├── daemon.ts                  # Persistent background daemon
│   ├── daemon-client.ts           # WebSocket client for daemon control port
│   ├── daemon-lifecycle.ts        # Shared daemon lifecycle (ensureRunning, kill, startup lock)
│   ├── control-protocol.ts        # Foreground/background control protocol types
│   ├── claude-adapter.ts          # MCP server adapter for Claude Code channels
│   ├── codex-adapter.ts           # Codex app-server WebSocket proxy and message interception
│   ├── config-service.ts          # Project config (.agentbridge/) read/write
│   ├── state-dir.ts               # Platform-aware state directory resolver
│   ├── message-filter.ts          # Smart message filtering (markers, summary buffer)
│   ├── types.ts                   # Shared types
│   ├── cli.ts                     # CLI entry point and command router
│   └── cli/
│       ├── init.ts                # agentbridge init
│       ├── claude.ts              # agentbridge claude
│       ├── codex.ts               # agentbridge codex
│       ├── pairs.ts               # agentbridge pairs (list / rm / prune)
│       ├── doctor.ts              # agentbridge doctor (read-only diagnosis)
│       ├── budget.ts              # agentbridge budget (quota snapshot)
│       ├── kill.ts                # agentbridge kill
│       ├── pkg-root.ts            # package-root resolution helper
│       └── dev.ts                 # agentbridge dev
├── CLAUDE.md                      # Project rules for AI agents
├── CODE_OF_CONDUCT.md
├── CONTRIBUTING.md
├── LICENSE
├── README.md
├── README.zh-CN.md
├── SECURITY.md
├── package.json
└── tsconfig.json
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CODEX_WS_PORT` | `4500` | Codex app-server WebSocket port |
| `CODEX_PROXY_PORT` | `4501` | Bridge proxy port for the Codex TUI |
| `AGENTBRIDGE_CONTROL_PORT` | `4502` | Control port between bridge.ts and daemon.ts |
| `AGENTBRIDGE_LIVENESS_PROBE_TIMEOUT_MS` | `3000` | Maximum wait for incumbent Claude pong before evicting on contention (issue #68) |
| `AGENTBRIDGE_TURN_WATCHDOG_MS` | `300000` | Per-turn inactivity watchdog: force-completes a turn after this many ms of app-server silence so a lost `turn/completed` can't lock injection forever (issue #69) |
| `AGENTBRIDGE_CODEX_TRANSPORT` | `auto` | How the daemon reaches the Codex app-server: `auto` (probe `codex app-server --help`, use `ws://` if supported else fall back to a `unix://` socket via a transparent relay), `ws` (force ws), or `unix` (force unix socket + relay). For builds that drop `ws://` listen support (issue #85) |
| `AGENTBRIDGE_STATE_DIR` | Platform default | State directory for pid, status, logs (macOS: `~/Library/Application Support/agentbridge/`, Linux: `$XDG_STATE_HOME/agentbridge/`) |
| `AGENTBRIDGE_DAEMON_ENTRY` | `./daemon.ts` | Override daemon entry point (used by plugin bundles) |
| `NO_UPDATE_NOTIFIER` | unset | Set to any value to disable the "update available" notice (ecosystem-standard opt-out) |
| `AGENTBRIDGE_NO_UPDATE_NOTIFIER` | unset | Namespaced opt-out for the update notice (same effect as `NO_UPDATE_NOTIFIER`) |
| `AGENTBRIDGE_UPDATE_PROMPT` | unset | Set to `0` to disable the interactive update prompt and keep pure notice-only behavior |
| `AGENTBRIDGE_UPDATE_CHECK_INTERVAL_MS` | `86400000` | How often `abg claude`/`abg codex` may check npm for a newer version (default once/day). The notice is otherwise printed from cache — zero network on most runs |

### Update notifications

`abg claude` and `abg codex` print a one-line notice to stderr when a newer **stable** AgentBridge is published to npm, e.g.:

```
⚠ AgentBridge update available: 0.1.6 → 0.1.7
  CLI:    npm install -g @raysonmeng/agentbridge@latest
  Plugin: /plugin marketplace update agentbridge   (then /reload-plugins)
```

The check is best-effort: the notice is printed from a cached result, the npm check runs at most once per day in the background, and any network/registry failure is silently ignored. On an interactive TTY, a cached update prompts before launch; answering `y` runs `npm install -g @raysonmeng/agentbridge@latest`, while `N` (or no answer within 15 seconds) records that version as dismissed and continues launching. Non-interactive output and CI never prompt, and the notice can be disabled with `NO_UPDATE_NOTIFIER=1` or kept notice-only with `AGENTBRIDGE_UPDATE_PROMPT=0`.

### State Directory

The daemon stores runtime state in a platform-aware directory:

| Platform | Default Path |
|----------|-------------|
| macOS | `~/Library/Application Support/agentbridge/` |
| Linux | `$XDG_STATE_HOME/agentbridge/` (fallback: `~/.local/state/agentbridge/`) |

Contents: `daemon.pid`, `status.json`, `agentbridge.log`, `killed` (sentinel), `startup.lock`

### Disabled Bridge States

The bridge can enter several dormant states when it cannot accept new MCP replies. Each state surfaces to the agent as an error message (and, for the transient ones, an in-band push notification):

| State | Cause | Recovery |
|-------|-------|----------|
| `killed` | `agentbridge kill` was run, sentinel file present. | Restart Claude Code (`agentbridge claude`), switch to a new conversation, or run `/resume`. |
| `rejected` | Daemon rejected the connection: another Claude session is already attached. | Close the other session, or run `agentbridge kill` to reset, then `agentbridge claude` again. |
| `evicted` | A newer session evicted this one after the incumbent failed a liveness probe (issue #68). | Close this session and start a fresh one with `agentbridge claude`. |
| `probe_in_progress` | A liveness probe is currently checking the incumbent — contention window. Transient (auto-recovers within `DISABLED_RECOVERY_INTERVAL_MS` × cap, ~30 s). | None needed; the recovery poller reconnects automatically when the slot clears. |
| `auto_recovery_exhausted` | The auto-recovery poller for `probe_in_progress` ran its full retry budget (6 attempts, ~30 s) without succeeding. Terminal. | Retry manually with `agentbridge claude`. |

## Budget Coordination & Auto-Resume

AgentBridge can keep a long task moving across subscription-quota windows instead of letting it die when one agent hits its limit. This whole capability is driven by the companion **agent-quota-guard** tool: the bridge reads its quota probe and its `pending` records — install the guard to enable it.

The daemon's budget coordinator polls **both** agents' account-level 5h/weekly quota (via the guard's probe) and coordinates the two sides; `abg budget [--json]` prints the live snapshot (both windows, drift, pause state). With the guard installed, two further capabilities activate:

- **Slowdown-line — no mid-task cut.** Near the quota hard-line the guard does NOT deny mid-tool-call. Instead it surfaces a reminder, lets the current turn finish, then stops cleanly at the turn boundary, writes a `.agent/checkpoint.md`, and drops a `pending` record the bridge detects.
- **Fully-automatic resume after the window refreshes.** When a paused side's quota window refreshes, the bridge resumes the task **in the original interactive TUI** — no headless background process, no manual step:
  - **Codex** — a queued `turn/start` injection (`ResumeInjectionQueue`) opens a fresh turn that continues from the checkpoint. Fully automatic.
  - **Claude** — a channel push carrying a stable `resume_id`; Claude echoes it back via the `ack_resume` MCP tool. Unacked pushes retry with a fresh delivery id (stable `resume_id`); after retries are exhausted a `SessionStart` degrade-sentinel surfaces a recovery hint the next session reads.
  - **Idempotency** — per-pending claim/consumed tombstones (a sha256 of agent + session + cwd + content hash) ensure a given resume is injected at most once, even across daemon restarts; stale tombstones are TTL-pruned.

Coordination directives the bridge may emit while a task runs: **balance** (route more work to the side with more runway / remaining work-time), **underutilized** (the account will not use its weekly quota before reset — split more parallel subtasks / raise delegation density), and **pause / handoff / resume**.

> Slowdown-line + auto-resume are an opt-in, companion-guard feature. The Claude-side resume is best-effort (ack + retry + a SessionStart fallback): channel pushes to a fully idle session have known upstream variability, so the bridge only marks a side resumed once it sees a real `ack_resume`.

## Current Limitations

- Only forwards `agentMessage` items, not intermediate `commandExecution`, `fileChange`, or similar events
- Single Codex thread per pair, no multi-session support within a pair yet
- Single Claude foreground connection per pair; a new Claude session replaces the previous one
- Multiple pairs run side-by-side on one machine (one per project directory, per-pair port allocation); Windows is not an officially supported platform yet

### Codex git restrictions

Codex runs in a sandboxed environment that **blocks all writes to the `.git` directory**. This means Codex cannot run `git commit`, `git push`, `git pull`, `git checkout -b`, `git merge`, or any other command that modifies git metadata. Attempting these commands will cause the Codex session to hang indefinitely.

**Recommendation:** Let Claude Code handle all git operations (branching, committing, pushing, creating PRs). Codex should focus on code changes and report completed work via `agentMessage`, then Claude Code takes care of the git workflow.

## Roadmap

- **v1.x (current)**: Improve the single-bridge experience without architectural refactoring -- less noise, better turn discipline, and clearer collaboration modes. See [docs/v1-roadmap.md](docs/v1-roadmap.md).
- **v2 (planned)**: Introduce the multi-agent foundation -- room-scoped collaboration, stable identity, a formal control protocol, and stronger recovery semantics. See [docs/v2-architecture.md](docs/v2-architecture.md).
- **v3+ (longer term)**: Explore smarter collaboration, richer policies, and more advanced orchestration across runtimes.

## How This Project Was Built

This project was built collaboratively by **Claude Code** (Anthropic) and **Codex** (OpenAI), communicating through AgentBridge itself -- the very tool they were building together. A human developer coordinated the effort, assigning tasks, reviewing progress, and directing the two agents to work in parallel and review each other's output.

In other words, AgentBridge is its own proof of concept: two AI agents from different providers, connected in real time, shipping code side by side.

## Contact

This is my first open-source project! I'd love to connect with anyone interested in multi-agent collaboration, AI tooling, or just building cool things together. Feel free to reach out:

- **Twitter/X**: [@raysonmeng](https://x.com/raysonmeng)
- **Xiaohongshu**: [Profile](https://www.xiaohongshu.com/user/profile/62a3709d0000000021028b7e)
- **WeChat**: Scan the QR code below to add me

<img src="assets/wechat-qr.jpg" alt="WeChat QR Code" width="300" />

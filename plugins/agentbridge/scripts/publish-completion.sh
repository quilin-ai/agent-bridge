#!/usr/bin/env bash
#
# Stop hook: announce a `task_completed` room event (§3.3).
#
# Best-effort and FAIL-OPEN by construction — a missing CLI, a down broker, a
# non-git dir, or a cwd with no collab room must NEVER block the agent's turn.
# The actual decision (room resolution, git summary, per-commit dedup, broker
# connect timeout) lives in `abg publish --from-hook`; this wrapper only locates
# the CLI and fires it detached so the Stop hook returns immediately.

set -uo pipefail

# Drain (and ignore) the hook's JSON stdin — the summary comes from git, not here.
cat >/dev/null 2>&1 || true

# Resolve the installed CLI; if neither name is on PATH, the user hasn't installed
# AgentBridge globally — nothing to do.
cli=""
if command -v abg >/dev/null 2>&1; then
  cli="abg"
elif command -v agentbridge >/dev/null 2>&1; then
  cli="agentbridge"
else
  exit 0
fi

# Run in the project dir so `publish` resolves the cwd→room map for THIS repo.
workspace="${CLAUDE_PROJECT_DIR:-${PWD}}"

# Detach so the Stop hook never waits on the broker connect timeout. nohup keeps
# the child alive past this hook process; all output is dropped (fire-and-forget).
nohup sh -c 'cd "$1" && "$2" publish --from-hook' _ "$workspace" "$cli" >/dev/null 2>&1 &

exit 0

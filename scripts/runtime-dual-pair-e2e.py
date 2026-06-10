#!/usr/bin/env python3
"""
Manual runtime E2E harness for AgentBridge route-A multi-pair.

This is intentionally outside `bun test src`: it launches real Claude Code and
Codex TUIs and therefore depends on local auth, terminal behavior, and plugin
setup. It is a repeatable operator harness for the final validation pass.

Example:
  python3 scripts/runtime-dual-pair-e2e.py --pairs a b --mode pull
  python3 scripts/runtime-dual-pair-e2e.py --state-base /tmp/abg-e2e --reserve-slots 2

Notes:
  - Requires the multi-pair branch where `abg claude/codex/kill --pair` and
    `abg pairs --json` exist.
  - Uses Python's stdlib pty module; no npm dependency is required.
  - If `--state-base` is supplied, the harness exports both AGENTBRIDGE_BASE_DIR
    (registry base) and AGENTBRIDGE_STATE_DIR (legacy/base compatibility).
"""

from __future__ import annotations

import argparse
import json
import os
import selectors
import shutil
import signal
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

import pty


BASE_PORT = 4500
STRIDE = 10


def now_stamp() -> str:
    return time.strftime("%Y%m%d-%H%M%S")


def strip_ansi(text: str) -> str:
    # Small, sufficient ANSI stripper for transcript searches.
    import re

    return re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)", "", text)


def run(
    args: list[str],
    env: dict[str, str] | None = None,
    timeout: float = 10,
    check: bool = False,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        args,
        text=True,
        capture_output=True,
        env=env,
        timeout=timeout,
        check=check,
    )


def command_exists(name: str) -> bool:
    return shutil.which(name) is not None


def lsof_listen_pid(port: int) -> str | None:
    if not command_exists("lsof"):
        return None
    proc = run(["lsof", "-ti", f"tcp:{port}", "-sTCP:LISTEN"], timeout=3)
    out = proc.stdout.strip().splitlines()
    return out[0].strip() if out else None


def curl_ok(port: int, path: str = "/healthz") -> bool:
    try:
        proc = run(
            ["curl", "-fsS", "--max-time", "1", f"http://127.0.0.1:{port}{path}"],
            timeout=2,
        )
        return proc.returncode == 0
    except Exception:
        return False


def ports_for_slot(slot: int) -> tuple[int, int, int]:
    app = BASE_PORT + slot * STRIDE
    return app, app + 1, app + 2


@dataclass
class PtyProcess:
    name: str
    argv: list[str]
    env: dict[str, str]
    log_path: Path
    pid: int | None = None
    fd: int | None = None
    _buffer: str = ""

    def start(self) -> None:
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        pid, fd = pty.fork()
        if pid == 0:
            os.execvpe(self.argv[0], self.argv, self.env)
        self.pid = pid
        self.fd = fd
        os.set_blocking(fd, False)

    def pump(self, duration: float = 0.5) -> str:
        if self.fd is None:
            return ""
        sel = selectors.DefaultSelector()
        sel.register(self.fd, selectors.EVENT_READ)
        deadline = time.time() + duration
        chunks: list[str] = []
        with self.log_path.open("ab") as out:
            while time.time() < deadline:
                timeout = max(0, min(0.1, deadline - time.time()))
                events = sel.select(timeout)
                if not events:
                    continue
                try:
                    data = os.read(self.fd, 8192)
                except BlockingIOError:
                    continue
                except OSError:
                    break
                if not data:
                    break
                out.write(data)
                out.flush()
                text = data.decode("utf-8", errors="replace")
                chunks.append(text)
                self._buffer += text
        return "".join(chunks)

    def send(self, text: str) -> None:
        if self.fd is not None:
            os.write(self.fd, text.encode("utf-8"))

    def wait_for(self, patterns: Iterable[str], timeout: float = 30) -> bool:
        wanted = list(patterns)
        deadline = time.time() + timeout
        while time.time() < deadline:
            self.pump(0.3)
            clean = strip_ansi(self._buffer)
            if any(p in clean for p in wanted):
                return True
        return False

    def terminate(self) -> None:
        if self.pid is None:
            return
        try:
            self.send("/exit\r")
            time.sleep(0.5)
            self.pump(0.5)
        except Exception:
            pass
        try:
            os.kill(self.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        except Exception:
            pass
        deadline = time.time() + 3
        while time.time() < deadline:
            try:
                pid, _ = os.waitpid(self.pid, os.WNOHANG)
                if pid == self.pid:
                    return
            except ChildProcessError:
                return
            time.sleep(0.1)
        try:
            os.kill(self.pid, signal.SIGKILL)
        except Exception:
            pass


def default_state_base() -> Path:
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "AgentBridge"
    xdg = os.environ.get("XDG_STATE_HOME")
    return Path(xdg) / "agentbridge" if xdg else Path.home() / ".local" / "state" / "agentbridge"


def build_env(args: argparse.Namespace) -> dict[str, str]:
    env = os.environ.copy()
    env["AGENTBRIDGE_MODE"] = args.mode
    if args.state_base:
        base = str(Path(args.state_base).expanduser().resolve())
        env["AGENTBRIDGE_BASE_DIR"] = base
        env["AGENTBRIDGE_STATE_DIR"] = base
    return env


def read_json(path: Path) -> dict:
    return json.loads(path.read_text())


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def seed_reserved_slots(state_base: Path, count: int) -> None:
    if count <= 0:
        return
    registry_path = state_base / "pairs" / "registry.json"
    registry_path.parent.mkdir(parents=True, exist_ok=True)
    if registry_path.exists():
        registry = read_json(registry_path)
    else:
        registry = {"version": 1, "pairs": []}
    require(registry.get("version") == 1 and isinstance(registry.get("pairs"), list), "registry shape is invalid")

    pairs = registry["pairs"]
    used_slots = {entry.get("slot") for entry in pairs if isinstance(entry, dict)}
    used_ids = {str(entry.get("pairId", "")).lower() for entry in pairs if isinstance(entry, dict)}
    created_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    for slot in range(count):
        pair_id = f"_reserved-slot-{slot}"
        if slot in used_slots:
            continue
        require(pair_id.lower() not in used_ids, f"reserved pair id already exists: {pair_id}")
        pairs.append(
            {
                "pairId": pair_id,
                "slot": slot,
                "cwd": str(state_base),
                "source": "flag",
                "createdAt": created_at,
            }
        )
    registry_path.write_text(json.dumps(registry, indent=2) + "\n", encoding="utf-8")


def assert_no_initial_port_conflicts(pairs: list[str], start_slot: int, allow_busy: bool) -> None:
    busy: list[str] = []
    for index, _pair in enumerate(pairs):
        slot = start_slot + index
        for port in ports_for_slot(slot):
            pid = lsof_listen_pid(port)
            if pid:
                busy.append(f"{port} pid={pid}")
    if busy and not allow_busy:
        raise RuntimeError(
            "Target ports are already busy; aborting before launch: " + ", ".join(busy)
        )


def dump_diagnostics(artifact: Path, state_base: Path, pairs: list[str], start_slot: int, env: dict[str, str], abg: str) -> None:
    diag = artifact / "diagnostics.txt"
    with diag.open("w", encoding="utf-8") as f:
        f.write("== ports ==\n")
        for index, pair in enumerate(pairs):
            slot = start_slot + index
            f.write(f"# pair {pair} slot {slot}\n")
            for port in ports_for_slot(slot):
                proc = run(["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN"], timeout=3)
                f.write(proc.stdout or proc.stderr or f"(no listener on {port})\n")
        f.write("\n== abg pairs --json ==\n")
        proc = run([abg, "pairs", "--json"], env=env, timeout=10)
        f.write(proc.stdout)
        f.write(proc.stderr)
        f.write("\n== state files ==\n")
        for pair in pairs:
            state = state_base / "pairs" / pair
            f.write(f"\n# {state}\n")
            for rel in ["status.json", "daemon.pid", "codex-tui.pid", "agentbridge.log", "codex-wrapper.log"]:
                path = state / rel
                f.write(f"--- {path} ---\n")
                if path.exists():
                    content = path.read_text(errors="replace")
                    f.write(content[-20000:])
                else:
                    f.write("(missing)\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pairs", nargs=2, default=["a", "b"], metavar=("PAIR_A", "PAIR_B"))
    parser.add_argument("--mode", choices=["pull", "push"], default="pull")
    parser.add_argument("--abg", default="abg", help="agentbridge/abg command")
    parser.add_argument("--artifact-dir", default=f"artifacts/runtime-dual-pair/{now_stamp()}")
    parser.add_argument("--state-base", help="optional multi-pair registry base override")
    parser.add_argument(
        "--reserve-slots",
        type=int,
        default=0,
        help="pre-seed registry placeholders for slots 0..N-1 so test pairs start at slot N",
    )
    parser.add_argument("--allow-busy-ports", action="store_true")
    parser.add_argument("--skip-launch", action="store_true", help="only run state/port assertions")
    parser.add_argument("--no-cleanup", action="store_true")
    args = parser.parse_args()

    artifact = Path(args.artifact_dir).resolve()
    artifact.mkdir(parents=True, exist_ok=True)
    env = build_env(args)
    state_base = Path(args.state_base).expanduser().resolve() if args.state_base else default_state_base()
    pairs = list(args.pairs)

    require(command_exists(args.abg), f"{args.abg} not found")
    require(command_exists("lsof"), "lsof not found")
    require(command_exists("curl"), "curl not found")

    processes: list[PtyProcess] = []
    try:
        require(args.reserve_slots >= 0, "--reserve-slots must be >= 0")
        require(args.reserve_slots == 0 or args.state_base, "--reserve-slots requires an isolated --state-base")
        if args.reserve_slots > 0:
            seed_reserved_slots(state_base, args.reserve_slots)
        assert_no_initial_port_conflicts(pairs, args.reserve_slots, args.allow_busy_ports)

        if not args.skip_launch:
            for pair in pairs:
                claude = PtyProcess(
                    name=f"claude-{pair}",
                    argv=[args.abg, "claude", "--pair", pair],
                    env=env,
                    log_path=artifact / "pty" / f"claude-{pair}.log",
                )
                codex = PtyProcess(
                    name=f"codex-{pair}",
                    argv=[args.abg, "codex", "--pair", pair],
                    env=env,
                    log_path=artifact / "pty" / f"codex-{pair}.log",
                )
                print(f"starting {claude.name}: {' '.join(claude.argv)}")
                claude.start()
                processes.append(claude)
                time.sleep(1)
                claude.pump(1)
                clean_prompt = strip_ansi(claude._buffer)
                if "Enter" in clean_prompt and "confirm" in clean_prompt:
                    claude.send("\r")
                print(f"starting {codex.name}: {' '.join(codex.argv)}")
                codex.start()
                processes.append(codex)
                time.sleep(2)
                codex.pump(1)

        # Let daemons and TUIs settle.
        deadline = time.time() + 90
        while time.time() < deadline:
            for proc in processes:
                proc.pump(0.05)
            if all(curl_ok(ports_for_slot(args.reserve_slots + i)[2]) for i in range(len(pairs))):
                break
            time.sleep(0.5)

        # Port/status assertions.
        for index, pair in enumerate(pairs):
            slot = args.reserve_slots + index
            app, proxy, control = ports_for_slot(slot)
            state = state_base / "pairs" / pair
            status_path = state / "status.json"
            require(status_path.exists(), f"missing status for {pair}: {status_path}")
            status = read_json(status_path)
            require(status.get("controlPort") == control, f"{pair} wrong controlPort: {status}")
            require(status.get("appServerUrl") == f"ws://127.0.0.1:{app}", f"{pair} wrong appServerUrl: {status}")
            require(status.get("proxyUrl") == f"ws://127.0.0.1:{proxy}", f"{pair} wrong proxyUrl: {status}")
            require(curl_ok(control), f"{pair} control healthz failed on {control}")
            require(lsof_listen_pid(control) is not None, f"{pair} no LISTEN on control {control}")
            require(lsof_listen_pid(proxy) is not None, f"{pair} no LISTEN on proxy {proxy}")
            require(lsof_listen_pid(app) is not None, f"{pair} no LISTEN on app {app}")

            log = (state / "agentbridge.log").read_text(errors="replace")
            require(f"Control server: ws://127.0.0.1:{control}/ws" in log, f"{pair} daemon log missing control port")
            require(f"Codex app-server: ws://127.0.0.1:{app}" in log, f"{pair} daemon log missing app port")
            require(f"Codex proxy: ws://127.0.0.1:{proxy}" in log, f"{pair} daemon log missing proxy port")
            require(
                f"Starting AgentBridge frontend (daemon ws ws://127.0.0.1:{control}/ws)" in log,
                f"{pair} frontend log missing control port",
            )

        # Cross-negative checks.
        state_a = state_base / "pairs" / pairs[0] / "agentbridge.log"
        state_b = state_base / "pairs" / pairs[1] / "agentbridge.log"
        if state_a.exists() and state_b.exists():
            a_log = state_a.read_text(errors="replace")
            b_log = state_b.read_text(errors="replace")
            pair_a_control = ports_for_slot(args.reserve_slots)[2]
            pair_b_control = ports_for_slot(args.reserve_slots + 1)[2]
            require(f"ws://127.0.0.1:{pair_b_control}/ws" not in a_log, "pair a log mentions pair b control port")
            require(f"ws://127.0.0.1:{pair_a_control}/ws" not in b_log, "pair b log mentions pair a control port")

        print("PASS: dual-pair port/state/log assertions passed")
        print(f"artifacts: {artifact}")
        return 0
    except Exception as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        dump_diagnostics(artifact, state_base, pairs, args.reserve_slots, env, args.abg)
        print(f"diagnostics: {artifact / 'diagnostics.txt'}", file=sys.stderr)
        return 1
    finally:
        if not args.no_cleanup:
            for pair in pairs:
                run([args.abg, "kill", "--pair", pair], env=env, timeout=20)
            for proc in reversed(processes):
                proc.terminate()


if __name__ == "__main__":
    raise SystemExit(main())

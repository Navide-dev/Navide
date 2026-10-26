"""onboarding.run: installs and maintenance run in a PTY the window shows.

The window names a kind and ids, never a command; the backend resolves the
registry command, spawns it, and the ordinary terminal.* messages carry its
output, input, kill and exit code.
"""

from __future__ import annotations

import asyncio
import subprocess
import sys
import time
from typing import Any

import pytest

from agent_team_backend import app as app_mod
from agent_team_backend import onboarding_deps as ob
from agent_team_backend import ws_handlers
from agent_team_backend.terminals import TerminalService

posix_only = pytest.mark.skipif(sys.platform == "win32", reason="POSIX shell run")


class _FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send_json(self, payload: dict) -> None:
        self.sent.append(payload)


class _RecordingTerminals:
    """Stands in for TerminalService.create: records what would be spawned."""

    def __init__(self, fail: Exception | None = None) -> None:
        self.created: list[dict[str, Any]] = []
        self.fail = fail

    def create(self, **kwargs: Any) -> Any:
        if self.fail is not None:
            raise self.fail
        self.created.append(kwargs)
        return type("T", (), {"id": f"term-{len(self.created)}"})()


def _session(terminals: Any) -> Any:
    session = app_mod.Session(_FakeWebSocket())  # type: ignore[arg-type]
    session.terminals = terminals
    return session


async def _send(session: Any, type_: str, payload: dict) -> dict:
    await app_mod.handle_message(session, {"id": "m1", "type": type_, "payload": payload})
    return session.websocket.sent[-1]


@pytest.fixture(autouse=True)
def _clean_owners():
    yield
    for tid in [t for t in app_mod._PTY_OWNERS if t.startswith("term-")]:
        app_mod._PTY_OWNERS.pop(tid, None)


# ── whitelist ─────────────────────────────────────────────────────────────────
@pytest.mark.asyncio
@pytest.mark.parametrize("payload", [
    {"kind": "install", "dep_id": "rm-rf-everything"},
    {"kind": "maintenance", "agent_key": "claude", "action": "rm -rf /"},
    {"kind": "pull_model", "model": "evil; rm -rf /"},
    {"kind": "shell", "command": "rm -rf /"},
    {},
])
async def test_a_request_outside_the_registry_spawns_nothing(payload: dict) -> None:
    terminals = _RecordingTerminals()
    session = _session(terminals)
    reply = await _send(session, "onboarding.run", payload)
    assert reply["payload"]["ok"] is False
    assert terminals.created == []
    assert session._onboarding_runs == set()


@pytest.mark.asyncio
async def test_the_spawned_command_is_the_registry_one(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ob.osplat, "platform_id", "darwin")
    monkeypatch.setattr(ob.osplat.paths, "resolve_program", lambda name, *, path=None: f"/usr/bin/{name}")
    terminals = _RecordingTerminals()
    session = _session(terminals)
    # A command in the request is ignored: only the kind and the id count.
    reply = await _send(session, "onboarding.run", {
        "kind": "install", "dep_id": "python", "command": "rm -rf /", "cols": 90, "rows": 20,
    })
    payload = reply["payload"]
    assert payload["ok"] is True and payload["run_id"] == "term-1"
    assert payload["command"] == "brew install python3"
    created = terminals.created[0]
    assert created["command"] == ob.run_argv("brew install python3")
    assert created["agent_key"] == ws_handlers.ONBOARDING_RUN_AGENT_KEY
    assert (created["cols"], created["rows"]) == (90, 20)
    assert app_mod._PTY_OWNERS["term-1"] is session
    assert session._onboarding_runs == {"term-1"}


@pytest.mark.asyncio
async def test_a_missing_bootstrap_binary_is_reported_before_any_spawn(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(ob.osplat, "platform_id", "darwin")
    monkeypatch.setattr(ob.osplat.paths, "resolve_program", lambda _n, *, path=None: None)
    terminals = _RecordingTerminals()
    reply = await _send(_session(terminals), "onboarding.run", {"kind": "install", "dep_id": "node"})
    assert reply["payload"]["ok"] is False
    assert reply["payload"]["missing_requirements"] == ["brew"]
    assert terminals.created == []


@pytest.mark.asyncio
async def test_a_pty_that_cannot_start_still_returns_the_command(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The window falls back to the external terminal with this command.
    monkeypatch.setattr(ob, "resolve_run", lambda _r: {"ok": True, "command": "ollama pull x"})
    session = _session(_RecordingTerminals(fail=FileNotFoundError("executable not found: zsh")))
    reply = await _send(session, "onboarding.run", {"kind": "pull_model", "model": "x"})
    payload = reply["payload"]
    assert payload["ok"] is False and payload["spawn_failed"] is True
    assert payload["command"] == "ollama pull x"
    assert session._onboarding_runs == set()


@pytest.mark.asyncio
async def test_a_non_numeric_size_is_a_bad_request_not_a_spawn_failure() -> None:
    # spawn_failed makes the window offer the external terminal; a malformed
    # request has nothing to fall back to.
    terminals = _RecordingTerminals()
    session = _session(terminals)
    reply = await _send(session, "onboarding.run", {"kind": "install", "dep_id": "python", "cols": "wide"})
    assert reply["ok"] is False
    assert reply["error"]["code"] == "BAD_REQUEST"
    assert terminals.created == []


@pytest.mark.asyncio
async def test_a_renderer_cannot_open_a_pane_under_the_reserved_key() -> None:
    terminals = _RecordingTerminals()
    reply = await _send(_session(terminals), "terminal.create", {
        "pane_id": "p1", "agent_key": ws_handlers.ONBOARDING_RUN_AGENT_KEY,
        "command": ["/bin/sh"], "cwd": "/tmp",
    })
    assert reply["ok"] is False and reply["error"]["code"] == "RESERVED_AGENT_KEY"
    assert terminals.created == []


# ── argv per platform ─────────────────────────────────────────────────────────
def test_run_argv_reads_zshrc(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ob.osplat, "platform_id", "darwin")
    monkeypatch.setenv("SHELL", "/bin/zsh")
    assert ob.run_argv("brew install uv") == ["/bin/zsh", "-ilc", "brew install uv"]


def test_run_argv_macos_bash_is_a_plain_login_shell(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ob.osplat, "platform_id", "darwin")
    monkeypatch.setenv("SHELL", "/bin/bash")
    assert ob.run_argv("x") == ["/bin/bash", "-lc", "x"]


def test_run_argv_linux_bash_reads_bashrc(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ob.osplat, "platform_id", "linux")
    monkeypatch.setenv("SHELL", "/usr/bin/bash")
    assert ob.run_argv("x") == ["/usr/bin/bash", "-ilc", "x"]


def test_run_argv_windows_carries_the_native_exit_code(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ob.osplat, "platform_id", "win32")
    argv = ob.run_argv("winget install --id OpenJS.NodeJS.LTS -e")
    assert argv[:2] == ["powershell.exe", "-NoLogo"]
    assert argv[-2] == "-Command"
    assert "-NoExit" not in argv  # the run must end for its exit code to arrive
    script = argv[-1]
    assert script.startswith("winget install --id OpenJS.NodeJS.LTS -e\n")
    assert "exit $navideCode" in script and script.endswith("exit 1")


def test_run_argv_windows_trusts_success_over_a_stale_exit_code(monkeypatch: pytest.MonkeyPatch) -> None:
    # $LASTEXITCODE outlives the native program that set it: an `irm | iex`
    # installer that probed something (exit 1) and then installed fine must
    # exit 0. So success ($?) is judged before the native code is consulted.
    monkeypatch.setattr(ob.osplat, "platform_id", "win32")
    script = ob.run_argv("irm https://x.ai/cli/install.ps1 | iex")[-1]
    tail = script.split("\n")[1:]
    assert tail == [
        "$navideOk = $?; $navideCode = $LASTEXITCODE",
        "if ($navideOk) { exit 0 }",
        "if ($navideCode) { exit $navideCode }",
        "exit 1",
    ]


def test_run_argv_windows_calls_a_quoted_binary(monkeypatch: pytest.MonkeyPatch) -> None:
    # _command_on_the_resolved_binary quotes the path; bare, PowerShell reads
    # it as a string and fails on the argument after it.
    monkeypatch.setattr(ob.osplat, "platform_id", "win32")
    script = ob.run_argv("'C:\\npm\\claude.cmd' update")[-1]
    assert script.startswith("& 'C:\\npm\\claude.cmd' update\n")


def test_run_argv_windows_bypasses_the_execution_policy_for_this_process(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # `npm` resolves to npm.ps1 first, and the default Restricted / AllSigned
    # policy refuses to load it. The flag is process-scoped: it does not touch
    # the policy the user set, and it covers every .ps1 shim (pnpm, yarn, the
    # claude.ps1 npm itself writes), which calling npm.cmd would not.
    monkeypatch.setattr(ob.osplat, "platform_id", "win32")
    argv = ob.run_argv("npm install -g @openai/codex")
    i = argv.index("-ExecutionPolicy")
    assert argv[i + 1] == "Bypass"
    assert i < argv.index("-Command")  # after -Command it would be script text


# ── real PTY: exit code and kill ─────────────────────────────────────────────
def _exits(events: list[Any]) -> list[dict]:
    return [e["payload"] for e in events if isinstance(e, dict) and e.get("type") == "terminal.exit"]


async def _wait_for_exit(events: list[Any]) -> dict:
    for _ in range(1000):
        found = _exits(events)
        if found:
            return found[0]
        await asyncio.sleep(0.01)
    raise AssertionError(f"no terminal.exit; saw {events!r}")


def _real_session(monkeypatch: pytest.MonkeyPatch, command: str) -> tuple[Any, list[Any]]:
    events: list[Any] = []

    async def emit(event: Any) -> None:
        events.append(event)

    monkeypatch.setenv("SHELL", "/bin/sh")
    monkeypatch.setattr(ob, "resolve_run", lambda _r: {"ok": True, "command": command})
    return _session(TerminalService(emit)), events


@posix_only
@pytest.mark.asyncio
async def test_the_commands_exit_code_reaches_the_window(monkeypatch: pytest.MonkeyPatch) -> None:
    session, events = _real_session(monkeypatch, "printf 'brewing\\n'; exit 3")
    reply = await _send(session, "onboarding.run", {"kind": "install", "dep_id": "x"})
    run_id = reply["payload"]["run_id"]
    exit_event = await _wait_for_exit(events)
    assert exit_event["terminal_session_id"] == run_id
    assert exit_event["exit_code"] == 3
    output = b"".join(bytes(e) for e in events if isinstance(e, (bytes, bytearray)))
    assert b"brewing" in output
    app_mod._PTY_OWNERS.pop(run_id, None)


class _ReapedLate:
    """A child whose PTY reports EOF before it can be reaped: poll() says it
    is alive for ``delay`` after its first call (which is _close's, on EOF),
    whatever the real process is doing (seen under CI load as exit_code=None)."""

    def __init__(self, proc: Any, delay: float) -> None:
        self._proc = proc
        self._delay = delay
        self.held_from: float | None = None

    def poll(self) -> int | None:
        now = time.monotonic()
        if self.held_from is None:
            self.held_from = now
        return None if now < self.held_from + self._delay else self._proc.poll()

    def wait(self, timeout: float | None = None) -> int:
        deadline = None if timeout is None else time.monotonic() + timeout
        while (code := self.poll()) is None:
            if deadline is not None and time.monotonic() >= deadline:
                raise subprocess.TimeoutExpired("child", timeout)
            time.sleep(0.01)
        return code

    def __getattr__(self, name: str) -> Any:
        return getattr(self._proc, name)


@posix_only
@pytest.mark.asyncio
async def test_an_exit_code_reaped_just_after_eof_still_reaches_the_window(tmp_path: Any) -> None:
    events: list[Any] = []

    async def emit(event: Any) -> None:
        events.append(event)

    svc = TerminalService(emit)
    session = svc.create(pane_id="p1", agent_key=None, command=["/bin/sh", "-c", "exit 3"], cwd=str(tmp_path))
    # Nothing is read before the first await, so EOF always meets the wrapper.
    session.proc = _ReapedLate(session.proc, delay=0.3)
    exit_event = await _wait_for_exit(events)
    assert exit_event["reason"] == "exit"
    assert exit_event["exit_code"] == 3


@posix_only
@pytest.mark.asyncio
async def test_waiting_for_the_reap_does_not_block_the_loop(tmp_path: Any) -> None:
    # The backend's loop serves every pane: while one exit waits for its
    # reap, other coroutines must keep running on time.
    events: list[Any] = []

    async def emit(event: Any) -> None:
        events.append(event)

    svc = TerminalService(emit)
    session = svc.create(pane_id="p1", agent_key=None, command=["/bin/sh", "-c", "exit 3"], cwd=str(tmp_path))
    session.proc = late = _ReapedLate(session.proc, delay=0.6)
    ticks: list[float] = []

    async def ticker() -> None:
        while not _exits(events):
            await asyncio.sleep(0.05)
            ticks.append(time.monotonic())

    tick = asyncio.create_task(ticker())
    exit_event = await _wait_for_exit(events)
    await tick
    assert exit_event["exit_code"] == 3
    assert late.held_from is not None
    # A wait that blocked the loop would let no tick finish inside the hold.
    held = [t for t in ticks if late.held_from < t < late.held_from + 0.6]
    assert len(held) >= 3, (late.held_from, ticks)


@posix_only
@pytest.mark.asyncio
async def test_cancel_kills_the_run(monkeypatch: pytest.MonkeyPatch) -> None:
    session, events = _real_session(monkeypatch, "sleep 30")
    reply = await _send(session, "onboarding.run", {"kind": "install", "dep_id": "x"})
    run_id = reply["payload"]["run_id"]
    kill_reply = await _send(session, "terminal.kill", {"terminal_session_id": run_id})
    assert kill_reply["payload"] == {"ok": True}
    exit_event = await _wait_for_exit(events)
    assert exit_event["reason"] == "killed"
    assert run_id not in app_mod._PTY_OWNERS


@posix_only
@pytest.mark.asyncio
async def test_a_closed_connection_kills_its_runs(monkeypatch: pytest.MonkeyPatch) -> None:
    session, events = _real_session(monkeypatch, "sleep 30")
    reply = await _send(session, "onboarding.run", {"kind": "install", "dep_id": "x"})
    run_id = reply["payload"]["run_id"]
    await app_mod._kill_onboarding_runs(session)
    exit_event = await _wait_for_exit(events)
    assert exit_event["terminal_session_id"] == run_id
    assert exit_event["reason"] == "killed"
    assert session._onboarding_runs == set()
    app_mod._PTY_OWNERS.pop(run_id, None)


@posix_only
@pytest.mark.asyncio
async def test_a_run_that_ends_by_itself_leaves_the_kill_list(monkeypatch: pytest.MonkeyPatch) -> None:
    # Routed through the app's real output sink, which is where the exit
    # releases the PTY's owner.
    events: list[Any] = []

    async def emit(event: Any) -> None:
        events.append(event)
        await app_mod._active_emit(event)

    monkeypatch.setenv("SHELL", "/bin/sh")
    monkeypatch.setattr(ob, "resolve_run", lambda _r: {"ok": True, "command": "exit 0"})
    session = _session(TerminalService(emit))
    reply = await _send(session, "onboarding.run", {"kind": "install", "dep_id": "x"})
    run_id = reply["payload"]["run_id"]
    await _wait_for_exit(events)
    assert session._onboarding_runs == set()
    assert run_id not in app_mod._PTY_OWNERS

"""The CLI launch path keeps every command word as its own argv element.

The Host frontend wraps an agent launch as ``[shell, '-ilc'|'-lc', '<line>']``
(POSIX) or one command string (Windows agent panes), and every backend wiring
step appends its flags to that LAST element / string. When the frontend instead
handed the backend a raw executable argv, ``codex_session_hooks.wire`` appended
to ``command[-1]`` and collapsed the flag, ``-c`` and the hook value into one
argument — Codex then refused to start with
``unexpected argument '--dangerously-bypass-approvals-and-sandbox -c 'hooks…'``.

This drives the production ``terminal.create`` handler for every registered
vendor and asserts the argv the spawn path builds. No vendor binary is installed
and no network or credential is touched: the wiring is pure command rewriting,
and the argv is resolved by the production ``TerminalService`` seam.
"""

from __future__ import annotations

import asyncio
import json
import shlex
import sys
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import app, osplat
from agent_team_backend.cli_vendors.registry import VENDORS
from agent_team_backend.mcp_server import pane_home
from agent_team_backend.mcp_server import wiring as mcp_wiring
from agent_team_backend.terminals import TerminalService

# Every CLI in the shared frontend/backend registry. This literal is the gate:
# a new vendor must extend the launch coverage below; the inventory test fails
# first, so coverage cannot silently shrink.
EXPECTED_VENDORS = frozenset({
    "aider", "antigravity", "claude", "codex", "copilot", "cursor", "droid",
    "goose", "grok", "kilo", "kimi", "mcode", "muse", "opencode", "pi", "qwen",
})

# A literal second word so a merge into the first token is observable.
MARKER = "--navide-argv-separation"
SHELL = "/bin/zsh"
MCP_PORT = 45678

# Records the argv it was handed (minus the interpreter's own `-c` and the
# destination path), so a real spawn can be inspected without a vendor binary.
# Written via os.replace so a reader never sees a partial file.
FAKE_CLI_SOURCE = (
    "import json, pathlib, sys\n"
    "target = pathlib.Path(sys.argv[1])\n"
    "part = target.with_name(target.name + '.part')\n"
    "part.write_text(json.dumps(sys.argv[2:]), encoding='utf-8')\n"
    "part.replace(target)\n"
)


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


class FakeTerminals:
    """Test double at the ``TerminalService.create`` boundary, recording the
    exact command the production handler hands to a real service."""

    def __init__(self) -> None:
        self.created: list[dict[str, Any]] = []

    def create(self, **kwargs: Any) -> SimpleNamespace:
        self.created.append(kwargs)
        return SimpleNamespace(
            id="term-1",
            pane_id=kwargs["pane_id"],
            command=kwargs["command"],
            proc=SimpleNamespace(pid=1234),
        )

    async def kill(self, session_id: str, force: bool = False) -> None:
        return None

    def find_live_by_resume_id(self, *args: Any, **kwargs: Any) -> list[Any]:
        return []


class FakeAttribution:
    def register_pane(self, pane_id: str, **kwargs: Any) -> None:
        return None

    def scan_pane_baseline(self, pane_id: str) -> None:
        return None


class FakeCodexHomeManager:
    def __init__(self, root: Any) -> None:
        self.root = root
        self.real_home = root / "real-codex"

    def prepare(self, home_id: str) -> Any:
        return self.root / home_id

    def find_session_home(self, resume_id: str) -> Any:
        return None

    def resolve_user_thread_id(self, resume_id: str) -> str:
        return resume_id


@pytest.fixture(autouse=True)
def _isolated_spawn(monkeypatch: pytest.MonkeyPatch, tmp_path: Any) -> None:
    """Everything the spawn path touches that is not the command wiring."""
    monkeypatch.setattr(app, "attribution", FakeAttribution())
    monkeypatch.setattr(app, "codex_home_manager", FakeCodexHomeManager(tmp_path / "codex-panes"))
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    monkeypatch.setattr(
        app,
        "_probe_agent_cli_for_spawn",
        lambda agent_key, _command=None: {
            "agent_key": agent_key,
            "binary_path": f"/test/bin/{agent_key}",
            "version": "1.0.0",
            "duration_ms": 1,
        } if agent_key else None,
    )
    monkeypatch.setattr(
        app.credential_vault, "identity",
        lambda _key, _slot=None: {"email": None, "signedIn": True},
    )
    # A live MCP port so codex's `-c mcp_servers…` override is part of the argv.
    monkeypatch.setattr(mcp_wiring, "backend_port", lambda: MCP_PORT)
    # antigravity, grok and kimi build a per-pane shim home under the real home
    # (and on Windows harden it with icacls, whose `.navide-panes\<vendor>`
    # argument the real-CLI guard rightly refuses). Keep it under tmp_path.
    monkeypatch.setattr(pane_home, "real_home", lambda: tmp_path / "home")


def _session() -> app.Session:
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    session.terminals = FakeTerminals()  # type: ignore[assignment]
    return session


def _frontend_command(line: str) -> str | list[str]:
    """The exact command shape the Host frontend sends for this platform."""
    if osplat.platform_id == "win32":
        return line
    return [SHELL, "-ilc", line]


def _cli_argv(command: str | list[str]) -> list[str]:
    """The argv the spawned CLI process receives.

    Runs the production resolver. On POSIX the shell splits the wrapped line
    into the CLI's argv; on Windows the resolver's ``parse_command`` already
    split the single string with ``CommandLineToArgvW`` rules.
    """
    resolved = TerminalService(lambda *_args: None)._resolve_command(command)
    if isinstance(command, list):
        return shlex.split(resolved[-1])
    return resolved


async def _create(session: app.Session, *, agent_key: str, command: str | list[str]) -> None:
    await app.handle_message(session, {
        "id": "m1",
        "type": "terminal.create",
        "payload": {
            "pane_id": f"{agent_key}-pane",
            "agent_key": agent_key,
            "command": command,
            "cwd": "/ws",
            "metadata": {"workspace_path": "/ws"},
        },
    })


def test_inventory_matches_the_shared_vendor_registry() -> None:
    assert frozenset(VENDORS) == EXPECTED_VENDORS


@pytest.mark.asyncio
@pytest.mark.parametrize("vendor", sorted(VENDORS))
async def test_launch_keeps_the_executable_and_flags_as_separate_argv_words(vendor: str) -> None:
    session = _session()
    await _create(session, agent_key=vendor, command=_frontend_command(f"{vendor} {MARKER}"))

    command = session.terminals.created[-1]["command"]  # type: ignore[attr-defined]
    argv = _cli_argv(command)

    assert vendor in argv, f"{vendor}: executable word was merged into {argv!r}"
    assert MARKER in argv, f"{vendor}: flag word was merged into {argv!r}"
    # The regression produced one token equal to
    # "<binary> --flag -c 'hooks.SessionStart=…'". Exact membership above
    # already rejects that; name the shape so a failure reads plainly.
    assert not any(token.startswith(f"{vendor} ") for token in argv), argv


@pytest.mark.asyncio
async def test_codex_flags_and_config_overrides_stay_separate() -> None:
    session = _session()
    flag = "--dangerously-bypass-approvals-and-sandbox"
    await _create(session, agent_key="codex", command=_frontend_command(f"codex {flag}"))

    command = session.terminals.created[-1]["command"]  # type: ignore[attr-defined]
    argv = _cli_argv(command)

    assert "codex" in argv
    assert flag in argv
    # Two session hooks plus the Navide MCP server's URL and the variable its
    # credential is read from (never argv), each a `-c <value>` pair.
    assert argv.count("-c") == 4, argv
    values = [argv[i + 1] for i, token in enumerate(argv) if token == "-c"]
    assert any(value.startswith("hooks.SessionStart=") for value in values), argv
    assert any(value.startswith("hooks.PreToolUse=") for value in values), argv
    assert any(value.startswith("mcp_servers.navide.url=") for value in values), argv
    assert any(value.startswith("mcp_servers.navide.bearer_token_env_var=") for value in values), argv
    # The flag never absorbed the following `-c`.
    assert not any(token != flag and token.startswith(flag) for token in argv), argv


async def _drop_event(*_args: Any) -> None:
    """The live test reads the fake CLI's file, not the terminal's events."""


@pytest.mark.asyncio
async def test_codex_launch_really_starts_a_cli_that_sees_separate_arguments(tmp_path: Any) -> None:
    """End-to-end: a live PTY spawn through the production wiring, with a
    deterministic fake CLI that records the argv its process received.

    POSIX wraps the line in `/bin/sh -c`, not the Host's `zsh -ilc`: an
    interactive login zsh sources the developer's rc files (seconds on a busy
    machine) and is not installed on the Linux runner. The wiring only rewrites
    the LAST element, so the shell and its flags do not change what is tested.
    """
    destination = tmp_path / "codex-argv.json"
    quote = osplat.paths.quote_arg
    interpreter = getattr(sys, "_base_executable", None) or sys.executable
    fake_cli = (
        f"{quote(interpreter)} -c {quote(FAKE_CLI_SOURCE)} "
        f"{quote(str(destination))} codex {MARKER}"
    )
    line = f"{fake_cli} --dangerously-bypass-approvals-and-sandbox"
    command: str | list[str] = line if osplat.platform_id == "win32" else ["/bin/sh", "-c", line]
    service = TerminalService(_drop_event)
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    session.terminals = service  # type: ignore[assignment]

    try:
        await app.handle_message(session, {
            "id": "m1",
            "type": "terminal.create",
            "payload": {
                "pane_id": "codex-live-pane",
                "agent_key": "codex",
                "command": command,
                "cwd": str(tmp_path),
                "metadata": {"workspace_path": str(tmp_path)},
            },
        })

        # Generous for a cold interpreter on a loaded CI runner, but bounded.
        deadline = asyncio.get_running_loop().time() + 30
        while not destination.exists() and asyncio.get_running_loop().time() < deadline:
            await asyncio.sleep(0.05)
        assert destination.exists(), "the fake CLI never started"
        argv = json.loads(destination.read_text(encoding="utf-8"))
    finally:
        await service.kill_all(grace=0)

    assert "codex" in argv, argv
    assert MARKER in argv, argv
    assert argv.count("-c") == 4, argv
    # Each `-c` carries exactly one TOML override, never a merged bundle.
    values = [argv[i + 1] for i, token in enumerate(argv) if token == "-c"]
    assert all(value.startswith(("hooks.", "mcp_servers.")) for value in values), argv

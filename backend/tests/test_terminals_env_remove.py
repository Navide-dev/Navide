"""TerminalService env_remove: CLI account profile spawns must be able to DROP
inherited env keys (the env merge only ever update()ed), and spawns without
env_remove must build the spawn env exactly as before (byte-compatible)."""

from __future__ import annotations

import asyncio
import os
import sys

import pytest

from agent_team_backend import detached_servers
from agent_team_backend import terminals as terminals_mod
from agent_team_backend.terminals import TerminalService

# The fake Popen below only reaches the POSIX backend; on Windows the spawn
# goes through winpty, so each test would start a real python REPL in a
# ConPTY and never kill it.
pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="patches the POSIX backend's Popen")


class _FakeProc:
    """Never-exiting stand-in so create() captures env without a real child."""

    pid = 424242
    returncode = None

    def poll(self) -> None:
        return None


@pytest.fixture()
def capture_popen(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    captured: list[dict] = []

    def fake_popen(argv, **kwargs):
        captured.append({"argv": argv, "env": kwargs.get("env")})
        return _FakeProc()

    monkeypatch.setattr(terminals_mod.subprocess, "Popen", fake_popen)
    monkeypatch.setattr(terminals_mod.pty_registry, "register", lambda *_a, **_k: None)
    return captured


async def _emit(_event: dict) -> None:
    pass


async def _settle() -> None:
    # The fake child holds no slave fd, so the master EOFs immediately and the
    # service closes the session on its own; let that run before the test ends.
    await asyncio.sleep(0.05)


def _without_pane_mark(env: dict[str, str]) -> dict[str, str]:
    """The spawn env minus the per-session leftover-server marker every pane
    carries (detached_servers.MARK_ENV) — a fresh random value each spawn."""
    assert env.get(detached_servers.MARK_ENV)
    return {k: v for k, v in env.items() if k != detached_servers.MARK_ENV}


async def test_no_env_remove_is_byte_compatible(capture_popen: list[dict]) -> None:
    svc = TerminalService(_emit)
    expected = os.environ.copy()
    expected["TERM"] = expected.get("TERM", "xterm-256color")
    expected["COLUMNS"] = "100"
    expected["LINES"] = "30"

    svc.create(pane_id="p1", agent_key=None, command=[sys.executable], cwd=".")
    await _settle()

    assert _without_pane_mark(capture_popen[0]["env"]) == expected


async def test_env_remove_pops_inherited_keys(
    capture_popen: list[dict], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "leaked-key")
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "leaked-token")
    svc = TerminalService(_emit)

    svc.create(
        pane_id="p1",
        agent_key="claude",
        command=[sys.executable],
        cwd=".",
        env={"CLAUDE_CONFIG_DIR": "/profiles/claude/abcd1234"},
        env_remove=["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
    )
    await _settle()

    env = capture_popen[0]["env"]
    assert "ANTHROPIC_API_KEY" not in env
    assert "ANTHROPIC_AUTH_TOKEN" not in env
    assert env["CLAUDE_CONFIG_DIR"] == "/profiles/claude/abcd1234"


async def test_env_remove_wins_over_payload_env(capture_popen: list[dict]) -> None:
    """Removal happens after the merge — even a caller-supplied env value for a
    removed key must not survive."""
    svc = TerminalService(_emit)

    svc.create(
        pane_id="p1",
        agent_key="claude",
        command=[sys.executable],
        cwd=".",
        env={"ANTHROPIC_API_KEY": "from-payload"},
        env_remove=["ANTHROPIC_API_KEY"],
    )
    await _settle()

    assert "ANTHROPIC_API_KEY" not in capture_popen[0]["env"]


async def test_env_remove_missing_key_is_noop(capture_popen: list[dict]) -> None:
    svc = TerminalService(_emit)
    expected = os.environ.copy()
    expected["TERM"] = expected.get("TERM", "xterm-256color")
    expected["COLUMNS"] = "100"
    expected["LINES"] = "30"

    svc.create(
        pane_id="p1",
        agent_key=None,
        command=[sys.executable],
        cwd=".",
        env_remove=["DEFINITELY_NOT_SET_ANYWHERE_XYZ"],
    )
    await _settle()

    assert _without_pane_mark(capture_popen[0]["env"]) == expected

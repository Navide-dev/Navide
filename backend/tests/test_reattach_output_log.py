from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import app
from agent_team_backend import terminals as terminals_module

# A pane that reattaches to a surviving PTY never reaches terminal.create, so
# nothing opens a transcript for it — and the path its caller derives from the
# NEW pane id names a file that will never exist ("Failed to read log file …
# ENOENT" in Agent History, for every restored pane). The conversation is in
# the log the PTY opened under its original id, so reattach reports it back.


class RecordingSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


class FakeTerminals:
    def __init__(self, ids: list[str]) -> None:
        self._sessions = {i: SimpleNamespace(id=i, closed=False) for i in ids}

    def get(self, session_id: str) -> SimpleNamespace | None:
        return self._sessions.get(session_id)

    def force_redraw(self, *_args: Any, **_kwargs: Any) -> None:
        return None


def make_session(ids: list[str]) -> app.Session:
    session = app.Session(RecordingSocket())  # type: ignore[arg-type]
    session.terminals = FakeTerminals(ids)  # type: ignore[assignment]
    return session


@pytest.fixture(autouse=True)
def clean_live_logs() -> None:
    with terminals_module._live_output_logs_lock:  # noqa: SLF001
        terminals_module._live_output_logs.clear()  # noqa: SLF001
    app._PTY_OWNERS.clear()
    yield
    with terminals_module._live_output_logs_lock:  # noqa: SLF001
        terminals_module._live_output_logs.clear()  # noqa: SLF001
    app._PTY_OWNERS.clear()


async def reattach(session: app.Session, ids: list[str]) -> dict[str, Any]:
    await app.handle_message(
        session,
        {"id": "r1", "type": "terminal.reattach", "payload": {"terminal_session_ids": ids}},
    )
    return session.websocket.sent[-1]["payload"]  # type: ignore[attr-defined,no-any-return]


def test_live_output_log_for_reports_the_path_create_opened() -> None:
    terminals_module._register_live_log("term-1", "/ws/.agent-team/manual/20260825/claude-aaaa.log")  # noqa: SLF001
    assert terminals_module.live_output_log_for("term-1") == "/ws/.agent-team/manual/20260825/claude-aaaa.log"


def test_live_output_log_for_is_empty_for_an_unknown_session() -> None:
    # A session started without a transcript, or one already gone. Callers keep
    # whatever they derived rather than adopting an empty path.
    assert terminals_module.live_output_log_for("nope") == ""


@pytest.mark.asyncio
async def test_reattach_reports_each_survivor_s_transcript() -> None:
    terminals_module._register_live_log("term-1", "/ws/a.log")  # noqa: SLF001
    terminals_module._register_live_log("term-2", "/ws/b.log")  # noqa: SLF001
    session = make_session(["term-1", "term-2"])
    payload = await reattach(session, ["term-1", "term-2"])
    assert payload["alive"] == ["term-1", "term-2"]
    assert payload["logs"] == {"term-1": "/ws/a.log", "term-2": "/ws/b.log"}


@pytest.mark.asyncio
async def test_reattach_reports_what_a_pane_without_its_bypass_really_runs() -> None:
    session = make_session(["term-1", "term-2"])
    session.host_authenticated = True
    for stored, metadata in zip(
        session.terminals._sessions.values(),  # noqa: SLF001
        ({"bypass_dropped_command": "claude --permission-mode default"}, {}),
        strict=True,
    ):
        stored.metadata, stored.agent_key, stored.cwd = metadata, "claude", "/ws"
    payload = await reattach(session, ["term-1", "term-2"])
    assert payload["bypass_dropped"] == {"term-1": "claude --permission-mode default"}


@pytest.mark.asyncio
async def test_a_window_reattaching_learns_what_its_pane_really_runs() -> None:
    # A window's own connection is never Host-authenticated, and a window is
    # who reloads: gated on Host auth, the reattach told no window, and a
    # reloaded card went back to showing the bypass flag the pane does not run.
    # The create's own event reaches the window that asked, without Host auth.
    session = make_session(["term-1"])
    assert session.host_authenticated is False
    stored = session.terminals._sessions["term-1"]  # noqa: SLF001
    stored.metadata = {"bypass_dropped_command": "claude --resume s1 --permission-mode default"}
    stored.agent_key, stored.cwd = "claude", "/ws"
    payload = await reattach(session, ["term-1"])
    assert payload["bypass_dropped"] == {"term-1": "claude --resume s1 --permission-mode default"}
    assert "sessions" not in payload


@pytest.mark.asyncio
async def test_reattach_omits_a_session_with_no_transcript() -> None:
    # An empty path would overwrite the caller's derived one with nothing.
    terminals_module._register_live_log("term-1", "/ws/a.log")  # noqa: SLF001
    session = make_session(["term-1", "term-2"])
    payload = await reattach(session, ["term-1", "term-2"])
    assert payload["logs"] == {"term-1": "/ws/a.log"}


@pytest.mark.asyncio
async def test_reattach_reports_nothing_for_a_dead_session() -> None:
    # Its log is not this pane's to adopt: a dead id falls through to a fresh
    # spawn, which opens a transcript of its own.
    terminals_module._register_live_log("term-gone", "/ws/gone.log")  # noqa: SLF001
    session = make_session([])
    payload = await reattach(session, ["term-gone"])
    assert payload["alive"] == []
    assert payload["dead"] == ["term-gone"]
    assert payload["logs"] == {}

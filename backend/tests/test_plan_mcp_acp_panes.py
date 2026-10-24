"""MCP tools on an ACP pane (no PTY): cli_interrupt, cli_wait_idle,
cli_get_status and cli_read_log answer from the pane's ACP session, which
the backend owns, instead of a terminal or a window round trip.

A pane is an ACP pane exactly when ``acp_ws.session_for_pane`` returns its
session; for every other pane these tools behave as before (their own test
files cover that), which the last test here pins for each tool.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import acp_ws, agent_messaging
from agent_team_backend.mcp_server import server as plan_mcp, wiring as plan_mcp_wiring


@pytest.fixture(autouse=True)
def _clean_registry() -> Any:
    agent_messaging._reset_for_test()
    agent_messaging.register("pa", "caller", "/ws/alpha")
    agent_messaging.register("pacp", "acp-worker", "/ws/alpha", agent_key="opencode")
    yield
    agent_messaging._reset_for_test()


def _ctx(pane_id: str = "pa") -> Any:
    params = {"pane": pane_id, "t": plan_mcp_wiring.caller_token(pane_id)}
    return SimpleNamespace(request_context=SimpleNamespace(request=SimpleNamespace(query_params=params)))


class FakeService:
    def __init__(self, sessions: dict[str, Any]) -> None:
        self.sessions = sessions
        self.cancelled: list[str] = []

    async def cancel(self, session_id: str) -> bool:
        session = next((s for s in self.sessions.values() if s.id == session_id), None)
        if session is None:
            raise KeyError(session_id)
        self.cancelled.append(session_id)
        if session.state != "running":
            return False
        session.state = "cancelling"
        return True


def _acp(monkeypatch: pytest.MonkeyPatch, **fields: Any) -> tuple[Any, FakeService]:
    session = SimpleNamespace(
        id="acp-1", pane_id="pacp", state="idle", queue=[], permissions={}, transcript_path=None,
    )
    for key, value in fields.items():
        setattr(session, key, value)
    sessions = {"pacp": session}
    service = FakeService(sessions)
    monkeypatch.setattr(acp_ws, "session_for_pane", lambda pane_id: sessions.get(pane_id))
    monkeypatch.setattr(acp_ws, "get_service", lambda: service)
    return session, service


def _no_window(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []

    async def fake(workspace_path: str, op: str, **kwargs: Any) -> dict[str, Any]:
        calls.append({"op": op, **kwargs})
        return {"ok": False, "error": "no window"}

    monkeypatch.setattr(plan_mcp, "_ui_request", fake)
    return calls


@pytest.mark.asyncio
async def test_interrupt_cancels_the_turn_over_acp_without_a_window(monkeypatch: pytest.MonkeyPatch) -> None:
    _, service = _acp(monkeypatch, state="running")
    calls = _no_window(monkeypatch)

    result = await plan_mcp.cli_interrupt("acp-worker", _ctx())

    assert result["ok"] is True and result["sent"] is True
    assert result["via"] == "acp" and result["status_before"] == "running"
    assert service.cancelled == ["acp-1"]
    assert calls == []


@pytest.mark.asyncio
async def test_interrupt_with_no_turn_running_says_nothing_was_cancelled(monkeypatch: pytest.MonkeyPatch) -> None:
    _acp(monkeypatch, state="idle")
    _no_window(monkeypatch)

    result = await plan_mcp.cli_interrupt("acp-worker", _ctx())

    assert result["ok"] is True and result["sent"] is False
    assert "nothing was cancelled" in result["advisories"][0]


@pytest.mark.asyncio
async def test_wait_idle_returns_once_the_session_is_idle_with_nothing_queued(monkeypatch: pytest.MonkeyPatch) -> None:
    _acp(monkeypatch, state="idle")
    calls = _no_window(monkeypatch)
    # The window-reported busy flag must not keep an idle ACP pane waiting.
    agent_messaging.set_busy("pacp", True)

    result = await plan_mcp.cli_wait_idle("acp-worker", _ctx(), timeout_s=5)

    assert result["idle"] is True and result["source"] == "acp_state"
    assert calls == []


@pytest.mark.asyncio
async def test_wait_idle_on_a_turn_parked_on_a_permission_times_out_as_awaiting(monkeypatch: pytest.MonkeyPatch) -> None:
    _acp(monkeypatch, state="running", permissions={"r1": object()})
    calls = _no_window(monkeypatch)

    result = await plan_mcp.cli_wait_idle("acp-worker", _ctx(), timeout_s=0)

    assert result["idle"] is False and result["reason"] == "awaiting"
    assert calls == []


@pytest.mark.asyncio
async def test_wait_idle_ends_when_the_agent_exits(monkeypatch: pytest.MonkeyPatch) -> None:
    session, _ = _acp(monkeypatch, state="running")
    sessions = {"pacp": session}
    seen = {"n": 0}

    def session_for_pane(pane_id: str) -> Any:
        seen["n"] += 1
        return sessions.get(pane_id) if seen["n"] < 3 else None

    monkeypatch.setattr(acp_ws, "session_for_pane", session_for_pane)
    _no_window(monkeypatch)

    result = await plan_mcp.cli_wait_idle("acp-worker", _ctx(), timeout_s=10)

    assert result["idle"] is True and result["source"] == "acp_exited"


@pytest.mark.asyncio
async def test_get_status_reports_the_acp_session(monkeypatch: pytest.MonkeyPatch) -> None:
    _acp(monkeypatch, state="running", queue=["next"], permissions={"r1": object()})
    _no_window(monkeypatch)

    result = await plan_mcp.cli_get_status("acp-worker", _ctx())

    assert result["display"] == "acp"
    assert result["acp"] == {"state": "running", "queued": 1, "pending_permissions": 1}


@pytest.mark.asyncio
async def test_read_log_falls_back_to_the_backends_transcript(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    from agent_team_backend import app

    transcript = tmp_path / "acp-transcript-acp-1.log"
    transcript.write_text("> hi\n\nHello, world\n\n", encoding="utf-8")
    _acp(monkeypatch, transcript_path=transcript)
    monkeypatch.setattr(app.project_store, "peek", lambda workspace_path: None)

    result = await plan_mcp.cli_read_log("acp-worker", _ctx())

    assert result["ok"] is True
    assert result["log_path"] == str(transcript)
    assert "Hello, world" in result["text"]


@pytest.mark.asyncio
async def test_a_pane_that_is_not_acp_takes_none_of_these_branches(monkeypatch: pytest.MonkeyPatch) -> None:
    from agent_team_backend import app

    monkeypatch.setattr(acp_ws, "session_for_pane", lambda pane_id: None)
    calls = _no_window(monkeypatch)
    monkeypatch.setattr(app.project_store, "peek", lambda workspace_path: None)

    interrupt = await plan_mcp.cli_interrupt("acp-worker", _ctx())
    status = await plan_mcp.cli_get_status("acp-worker", _ctx())
    log = await plan_mcp.cli_read_log("acp-worker", _ctx())

    assert "via" not in interrupt
    assert [c["op"] for c in calls][:1] == ["invoke"]  # the window path was taken
    assert "display" not in status and "acp" not in status
    assert log["ok"] is False and "no log file recorded" in log["error"]


@pytest.mark.asyncio
async def test_wait_idle_on_a_pane_that_is_not_acp_runs_the_tools_own_loop(monkeypatch: pytest.MonkeyPatch) -> None:
    """The ACP hand-off answers None at once for any other pane, and the tool's
    own loop decides: here the pane reports no activity at all (never_started)."""
    from agent_team_backend import acp_mcp, app

    asked: list[str] = []
    monkeypatch.setattr(acp_ws, "session_for_pane", lambda pane_id: asked.append(pane_id))
    monkeypatch.setattr(app, "pane_activity", lambda pane_id: None)
    _no_window(monkeypatch)

    result = await plan_mcp.cli_wait_idle("acp-worker", _ctx(), timeout_s=5)

    assert asked == ["pacp"]  # looked once, found no ACP session, handed back
    assert result["source"] not in ("acp_state", "acp_exited")
    assert await acp_mcp.wait_idle("pacp", 1, lambda s: {}, lambda w: {}, lambda: None) is None  # type: ignore[arg-type]

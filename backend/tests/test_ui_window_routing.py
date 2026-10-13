"""Routing of global UI requests (ui.workspace.open) to a window that can
answer them.

Only a main window runs the UI action bus; the plugin, editor and manager
windows share the same WebSocket server but never answer ui.invoke.request.
A global request handed to one of those used to sit unanswered until the
15s deadline and was then reported as `workspace_path ''` having no window.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import app
from agent_team_backend.mcp_server import auth as plan_mcp_auth
from agent_team_backend.mcp_server import server as plan_mcp


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


def _session() -> app.Session:
    return app.Session(FakeWebSocket())  # type: ignore[arg-type]


def _requests(session: app.Session) -> list[dict[str, Any]]:
    return [e for e in session.websocket.sent if e.get("type") == "ui.invoke.request"]  # type: ignore[attr-defined]


@pytest.fixture
def sessions(monkeypatch: pytest.MonkeyPatch) -> set[app.Session]:
    live: set[app.Session] = set()
    monkeypatch.setattr(app, "_SESSIONS", live)
    return live


async def _ready(session: app.Session, *, focused: bool = False) -> None:
    await app.handle_message(session, {
        "id": "r1", "type": "ui.invoke.ready", "payload": {"focused": focused},
    })


@pytest.mark.asyncio
async def test_a_global_request_skips_windows_without_the_ui_bus(sessions: set[app.Session]) -> None:
    plugin_window = _session()
    main_window = _session()
    sessions.update({plugin_window, main_window})
    await _ready(main_window)

    sent = await app.unicast_any({"type": "ui.invoke.request", "payload": {}})

    assert sent is True
    assert _requests(plugin_window) == []
    assert len(_requests(main_window)) == 1


@pytest.mark.asyncio
async def test_a_global_request_goes_to_the_most_recently_focused_window(
    sessions: set[app.Session],
) -> None:
    first, second, third = _session(), _session(), _session()
    sessions.update({first, second, third})
    await _ready(first)
    await _ready(second, focused=True)
    await _ready(third)
    await app.handle_message(first, {"id": "f", "type": "ui.invoke.ready", "payload": {"focused": True}})

    await app.unicast_any({"type": "ui.invoke.request", "payload": {}})

    assert len(_requests(first)) == 1
    assert _requests(second) == [] and _requests(third) == []


@pytest.mark.asyncio
@pytest.mark.parametrize("order", [0, 1])
async def test_the_latest_focus_wins_when_the_clock_does_not_advance(
    monkeypatch: pytest.MonkeyPatch, order: int,
) -> None:
    # Windows' monotonic clock ticks every ~15.6ms, so two focus changes in
    # quick succession read the same time. The later one must still win,
    # whichever order the session set happens to iterate in.
    from agent_team_backend import ws_handlers

    monkeypatch.setattr(ws_handlers, "time", SimpleNamespace(monotonic=lambda: 1000.0))
    earlier, later = _session(), _session()
    # A dict keeps insertion order, so both iteration orders are exercised.
    windows = [earlier, later] if order == 0 else [later, earlier]
    monkeypatch.setattr(app, "_SESSIONS", dict.fromkeys(windows))
    await _ready(earlier, focused=True)
    await _ready(later, focused=True)

    await app.unicast_any({"type": "ui.invoke.request", "payload": {}})

    assert len(_requests(later)) == 1
    assert _requests(earlier) == []


@pytest.mark.asyncio
async def test_a_dead_ready_window_is_passed_over(sessions: set[app.Session]) -> None:
    gone, alive = _session(), _session()
    sessions.update({gone, alive})
    await _ready(alive)
    await _ready(gone, focused=True)
    gone.dead = True

    assert await app.unicast_any({"type": "ui.invoke.request", "payload": {}}) is True
    assert len(_requests(alive)) == 1


@pytest.mark.asyncio
async def test_no_window_with_the_ui_bus_is_reported_without_waiting(
    sessions: set[app.Session],
) -> None:
    sessions.add(_session())  # e.g. only a plugin window is connected

    result = await asyncio.wait_for(
        plan_mcp.workspace_open("/ws/elsewhere", _ctx()), timeout=2.0
    )

    assert result["ok"] is False
    assert result["error_code"] == "ui_no_window"
    assert plan_mcp._ui_invoke_pending.pending == {}


@pytest.mark.asyncio
async def test_workspace_open_reaches_the_main_window_and_succeeds(
    sessions: set[app.Session], monkeypatch: pytest.MonkeyPatch
) -> None:
    # The readiness wait after the open is covered in test_workspace_open_ready.
    monkeypatch.setattr(plan_mcp, "_WINDOW_READY_TIMEOUT_S", 0.05)
    monkeypatch.setattr(plan_mcp, "_WINDOW_PROBE_TIMEOUT_S", 0.01)
    monkeypatch.setattr(plan_mcp, "_mcp_opened_workspaces", {})
    plugin_window, main_window = _session(), _session()
    sessions.update({plugin_window, main_window})
    await _ready(main_window)

    async def answer() -> None:
        for _ in range(200):
            reqs = _requests(main_window)
            if reqs:
                plan_mcp.resolve_ui_invoke(
                    reqs[0]["payload"]["request_id"], {"ok": True, "result": None, "error": None}
                )
                return
            await asyncio.sleep(0.005)
        raise AssertionError("main window never got the request")

    task = asyncio.create_task(answer())
    result = await plan_mcp.workspace_open("/Users/me/project", _ctx())
    await task

    assert result["ok"] is True
    assert result["path"] == "/Users/me/project"
    payload = _requests(main_window)[0]["payload"]
    assert payload["global"] is True and payload["args"] == {"path": "/Users/me/project"}


@pytest.mark.asyncio
async def test_a_global_timeout_does_not_blame_an_empty_workspace_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def delivered(_event: dict[str, Any]) -> bool:
        return True

    monkeypatch.setattr(app, "unicast_any", delivered)
    monkeypatch.setattr(plan_mcp, "_UI_INVOKE_TIMEOUT_S", 0.05)

    result = await plan_mcp.workspace_open("/ws/slow", _ctx())

    assert result["ok"] is False
    assert result["error_code"] == "ui_action_timeout"
    assert "workspace_path ''" not in result["error"]
    assert "ui.workspace.open" in result["error"]


def _ctx() -> Any:
    """A Context carrying a valid host credential — the caller the bug was
    reported from (a host client has no window of its own)."""
    params = {"client": "host", "t": plan_mcp_auth.internal_token()}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )

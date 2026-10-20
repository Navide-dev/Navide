"""window_close / workspace_close (DESIGN-C S4a).

Neither ends a CLI unless the user agrees: window_close and the default
workspace_close leave every PTY running (measured in an isolated backend: a
PTY outlives its window's WS for as long as it runs and re-attaches). Only a
pane may call them, and never on its own window or workspace — that is S1's
_self_scope_refusal, which both tools go through.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging, agent_window_actions, app
from agent_team_backend.mcp_server import auth as plan_mcp_auth
from agent_team_backend.mcp_server import server as plan_mcp
from agent_team_backend.mcp_server import window_tools
from agent_team_backend.mcp_server import wiring as plan_mcp_wiring


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


@pytest.fixture(autouse=True)
def _clean(monkeypatch: pytest.MonkeyPatch, tmp_path: Any) -> Any:
    agent_messaging._reset_for_test()
    plan_mcp._ui_invoke_pending.pending.clear()
    monkeypatch.setattr(app, "_SESSIONS", set())
    monkeypatch.setattr(plan_mcp, "_WINDOW_DESCRIBE_TIMEOUT_S", 0.5)
    agent_window_actions._reset_for_test(tmp_path / "agent-window-actions.jsonl")
    yield
    agent_messaging._reset_for_test()
    plan_mcp._ui_invoke_pending.pending.clear()
    agent_window_actions._reset_for_test(None)


def _host_ctx() -> Any:
    params = {"client": "host", "t": plan_mcp_auth.internal_token()}
    return SimpleNamespace(request_context=SimpleNamespace(request=SimpleNamespace(query_params=params)))


def _pane_ctx(pane_id: str) -> Any:
    params = {"pane": pane_id, "t": plan_mcp_wiring.caller_token(pane_id)}
    return SimpleNamespace(request_context=SimpleNamespace(request=SimpleNamespace(query_params=params)))


async def _main_window(window_id: str) -> app.Session:
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    session.navide_window = True
    app._SESSIONS.add(session)
    await app.handle_message(session, {
        "id": "r", "type": "ui.invoke.ready", "payload": {"focused": False, "window_id": window_id},
    })
    return session


def _requests(session: app.Session, action: str) -> list[dict[str, Any]]:
    return [
        e["payload"] for e in session.websocket.sent  # type: ignore[attr-defined]
        if e.get("type") == "ui.invoke.request" and e["payload"].get("action") == action
    ]


def _events(session: app.Session, event_type: str) -> list[dict[str, Any]]:
    return [e["payload"] for e in session.websocket.sent if e.get("type") == event_type]  # type: ignore[attr-defined]


def _answer(session: app.Session, action: str, result: Any, *, ok: bool = True, error: str | None = None) -> asyncio.Task[None]:
    async def run() -> None:
        for _ in range(400):
            reqs = _requests(session, action)
            if reqs:
                plan_mcp.resolve_ui_invoke(reqs[0]["request_id"], {"ok": ok, "result": result, "error": error})
                return
            await asyncio.sleep(0.005)
        raise AssertionError(f"window never got {action}")
    return asyncio.create_task(run())


def _describe(window_id: str, workspaces: list[str], **extra: Any) -> dict[str, Any]:
    return {"window_id": window_id, "kind": "main", "on_screen": workspaces[0], "workspaces": workspaces,
            "focused": False, "panes": [], **extra}


async def _two_windows() -> tuple[app.Session, app.Session]:
    """The caller `pa` in window 1 (project alpha); `pb` in window 2 (beta, gamma)."""
    w1 = await _main_window("win-aaaa-1111")
    w2 = await _main_window("win-bbbb-2222")
    agent_messaging.register("pa", "asker", "/ws/alpha", agent_key="claude", owner=w1)
    agent_messaging.register("pb", "worker", "/ws/beta", agent_key="claude", owner=w2)
    agent_messaging.register("pc", "helper", "/ws/gamma", agent_key="claude", owner=w2)
    return w1, w2


# ── window_close ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_window_close_never_closes_the_callers_own_window() -> None:
    w1, _w2 = await _two_windows()

    result = await window_tools.window_close("win-aaaa-1111", _pane_ctx("pa"))

    assert result["ok"] is False and result["error_code"] == "self-window-close"
    assert _requests(w1, "ui.window.close") == []
    (entry,) = agent_window_actions.entries()
    assert entry["tool"] == "window_close" and entry["ok"] is False


@pytest.mark.asyncio
async def test_an_empty_window_id_is_the_callers_own_window_and_is_refused() -> None:
    w1, w2 = await _two_windows()

    result = await window_tools.window_close("", _pane_ctx("pa"))

    assert result["ok"] is False and result["error_code"] == "self-window-close"
    assert _requests(w1, "ui.window.close") == [] and _requests(w2, "ui.window.close") == []


@pytest.mark.asyncio
async def test_window_close_needs_a_pane_caller() -> None:
    _w1, w2 = await _two_windows()

    result = await window_tools.window_close("win-bbbb-2222", _host_ctx())

    assert result["ok"] is False and result["error_code"] == "pane-caller-required"
    assert _requests(w2, "ui.window.close") == []


@pytest.mark.asyncio
async def test_window_close_of_an_unknown_or_remote_window() -> None:
    await _two_windows()

    unknown = await window_tools.window_close("win-gone-9999", _pane_ctx("pa"))
    remote = await window_tools.window_close("laptop/win-bbbb-2222", _pane_ctx("pa"))

    assert unknown["error_code"] == "unknown-window"
    assert remote["error_code"] == "window-local-only"


@pytest.mark.asyncio
async def test_window_close_leaves_the_clis_running_and_says_what_that_means() -> None:
    w1, w2 = await _two_windows()
    task = _answer(w2, "ui.window.close", {
        "workspaces": ["/ws/beta", "/ws/gamma"],
        "panes": [{"pane_id": "pb", "workspace_path": "/ws/beta"}, {"pane_id": "pc", "workspace_path": "/ws/gamma"}],
    })

    result = await window_tools.window_close("win-bbbb-2222", _pane_ctx("pa"))
    await task

    assert result["ok"] is True
    assert result["window_id"] == "win-bbbb-2222"
    assert result["workspaces"] == ["/ws/beta", "/ws/gamma"]
    assert result["panes_left_running"] == ["beta/worker", "gamma/helper"]
    assert result["undo"] == [
        {"tool": "workspace_open", "args": {"path": "/ws/beta"}},
        {"tool": "workspace_open", "args": {"path": "/ws/gamma"}},
    ]
    notes = " ".join(result["notes"])
    assert "---MSG" in notes  # reports written while the window is closed reach nobody
    assert "cli_send" in notes  # the panes leave the roster at once
    (req,) = _requests(w2, "ui.window.close")
    assert req["addressed"] is True and req["args"]["windowId"] == "win-bbbb-2222"
    assert req["args"]["caller_address"] == "alpha/asker"
    # The caller's own window is told, with the undo.
    (shown,) = _events(w1, "agent.window_action")
    assert shown["tool"] == "window_close" and shown["caller"] == "alpha/asker"
    assert shown["undo"] == result["undo"]
    (entry,) = agent_window_actions.entries()
    assert entry["ok"] is True and entry["target"] == {"window_id": "win-bbbb-2222"}


@pytest.mark.asyncio
async def test_window_close_passes_the_windows_refusal_through() -> None:
    _w1, w2 = await _two_windows()
    task = _answer(w2, "ui.window.close", None, ok=False, error="pipeline-running: a pipeline is running in this window")

    result = await window_tools.window_close("win-bbbb-2222", _pane_ctx("pa"))
    await task

    assert result["ok"] is False and result["error_code"] == "pipeline-running"


# ── workspace_close ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize("spelled", ["/ws/alpha", "/ws/alpha/", ""])
async def test_workspace_close_never_closes_the_callers_own_workspace(spelled: str) -> None:
    w1, _w2 = await _two_windows()

    result = await window_tools.workspace_close(spelled, _pane_ctx("pa"))

    assert result["ok"] is False and result["error_code"] == "self-workspace-close"
    assert _requests(w1, "ui.workspace.close") == []
    assert _requests(w1, "ui.window.describe") == []


@pytest.mark.asyncio
async def test_workspace_close_needs_a_pane_caller() -> None:
    await _two_windows()

    result = await window_tools.workspace_close("/ws/beta", _host_ctx())

    assert result["ok"] is False and result["error_code"] == "pane-caller-required"


@pytest.mark.asyncio
async def test_workspace_close_keeps_the_panes_by_default_in_the_window_holding_it() -> None:
    w1, w2 = await _two_windows()
    d1 = _answer(w1, "ui.window.describe", _describe("win-aaaa-1111", ["/ws/alpha"]))
    d2 = _answer(w2, "ui.window.describe", _describe("win-bbbb-2222", ["/ws/beta", "/ws/gamma"]))
    close = _answer(w2, "ui.workspace.close", {"path": "/ws/beta", "panes": [{"pane_id": "pb", "workspace_path": "/ws/beta"}]})

    result = await window_tools.workspace_close("/ws/beta/", _pane_ctx("pa"))
    await asyncio.gather(d1, d2, close)

    assert result["ok"] is True
    assert result["keep_panes"] is True
    assert result["window_id"] == "win-bbbb-2222"
    assert result["panes_left_running"] == ["beta/worker"]
    assert result["undo"] == {"tool": "workspace_open", "args": {"path": "/ws/beta"}}
    (req,) = _requests(w2, "ui.workspace.close")
    # The window is handed its own spelling of the path, not the caller's.
    assert req["args"] == {"path": "/ws/beta", "keepPanes": True, "caller_address": "alpha/asker"}
    assert _requests(w1, "ui.workspace.close") == []


@pytest.mark.asyncio
async def test_workspace_close_ending_the_clis_reports_them_as_ended() -> None:
    w1, w2 = await _two_windows()
    d1 = _answer(w1, "ui.window.describe", _describe("win-aaaa-1111", ["/ws/alpha"]))
    d2 = _answer(w2, "ui.window.describe", _describe("win-bbbb-2222", ["/ws/beta", "/ws/gamma"]))
    close = _answer(w2, "ui.workspace.close", {"path": "/ws/gamma", "panes": [{"pane_id": "pc", "workspace_path": "/ws/gamma"}]})

    result = await window_tools.workspace_close("/ws/gamma", _pane_ctx("pa"), keep_panes=False)
    await asyncio.gather(d1, d2, close)

    assert result["ok"] is True and result["keep_panes"] is False
    assert result["panes_ended"] == ["gamma/helper"]
    assert "panes_left_running" not in result
    (req,) = _requests(w2, "ui.workspace.close")
    assert req["args"]["keepPanes"] is False


@pytest.mark.asyncio
async def test_workspace_close_reports_a_user_who_said_no() -> None:
    w1, w2 = await _two_windows()
    d1 = _answer(w1, "ui.window.describe", _describe("win-aaaa-1111", ["/ws/alpha"]))
    d2 = _answer(w2, "ui.window.describe", _describe("win-bbbb-2222", ["/ws/beta", "/ws/gamma"]))
    close = _answer(w2, "ui.workspace.close", None, ok=False, error="user-declined: the user did not agree")

    result = await window_tools.workspace_close("/ws/gamma", _pane_ctx("pa"), keep_panes=False)
    await asyncio.gather(d1, d2, close)

    assert result["ok"] is False and result["error_code"] == "user-declined"


@pytest.mark.asyncio
async def test_workspace_close_of_a_window_s_only_workspace_points_at_window_close() -> None:
    w1, w2 = await _two_windows()
    w3 = await _main_window("win-cccc-3333")
    d1 = _answer(w1, "ui.window.describe", _describe("win-aaaa-1111", ["/ws/alpha"]))
    d2 = _answer(w2, "ui.window.describe", _describe("win-bbbb-2222", ["/ws/beta", "/ws/gamma"]))
    d3 = _answer(w3, "ui.window.describe", _describe("win-cccc-3333", ["/ws/delta"]))

    result = await window_tools.workspace_close("/ws/delta", _pane_ctx("pa"))
    await asyncio.gather(d1, d2, d3)

    assert result["ok"] is False and result["error_code"] == "last-workspace"
    assert "window_close" in result["error"]
    assert _requests(w3, "ui.workspace.close") == []


@pytest.mark.asyncio
async def test_workspace_close_of_a_workspace_no_window_holds() -> None:
    w1, w2 = await _two_windows()
    d1 = _answer(w1, "ui.window.describe", _describe("win-aaaa-1111", ["/ws/alpha"]))
    d2 = _answer(w2, "ui.window.describe", _describe("win-bbbb-2222", ["/ws/beta", "/ws/gamma"]))

    result = await window_tools.workspace_close("/ws/nowhere", _pane_ctx("pa"))
    await asyncio.gather(d1, d2)

    assert result["ok"] is False and result["error_code"] == "workspace-not-open"


# ── ui_invoke routes to the same window commands ────────────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ["ui.window.close", "ui.workspace.close"])
async def test_ui_invoke_close_actions_need_a_pane_and_carry_its_name(monkeypatch: pytest.MonkeyPatch, action: str) -> None:
    sent: list[dict[str, Any]] = []

    async def fake_ui_request(workspace_path: str, op: str, **kwargs: Any) -> dict[str, Any]:
        sent.append(kwargs)
        return {"ok": True, "result": None, "error": None}

    monkeypatch.setattr(plan_mcp, "_ui_request", fake_ui_request)
    await _two_windows()
    args = {"windowId": "win-bbbb-2222", "path": "/ws/beta", "caller_address": "someone/else"}

    host = await plan_mcp.ui_invoke("", action, _host_ctx(), args=dict(args))
    pane = await plan_mcp.ui_invoke("", action, _pane_ctx("pa"), args=dict(args))

    assert host["ok"] is False and host["error_code"] == "pane-caller-required"
    assert len(sent) == 1 and sent[0]["args"]["caller_address"] == "alpha/asker"
    assert pane["ok"] is True

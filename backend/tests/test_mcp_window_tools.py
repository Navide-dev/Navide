"""window_list / window_focus and the roster's window_id (DESIGN-C S3).

A window is named by its page-load id (`ui.invoke.ready` window_id). The
backend asks each main window to describe itself over an addressed
ui.invoke.request (`ui.window.describe`), so one slow window is reported as
not answering instead of holding the whole listing up.
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging, agent_window_actions, app
from agent_team_backend.mcp_server import server as plan_mcp
from agent_team_backend.mcp_server import window_tools
from agent_team_backend.mcp_server import auth as plan_mcp_auth
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


async def _main_window(window_id: str, *, focused: bool = False) -> app.Session:
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    session.navide_window = True
    app._SESSIONS.add(session)
    await app.handle_message(session, {
        "id": "r", "type": "ui.invoke.ready", "payload": {"focused": focused, "window_id": window_id},
    })
    return session


def _requests(session: app.Session, action: str) -> list[dict[str, Any]]:
    return [
        e["payload"] for e in session.websocket.sent  # type: ignore[attr-defined]
        if e.get("type") == "ui.invoke.request" and e["payload"].get("action") == action
    ]


def _answer(session: app.Session, action: str, result: Any, *, ok: bool = True, error: str | None = None) -> asyncio.Task[None]:
    """Answer the first `action` request this window receives."""
    async def run() -> None:
        for _ in range(400):
            reqs = _requests(session, action)
            if reqs:
                plan_mcp.resolve_ui_invoke(reqs[0]["request_id"], {"ok": ok, "result": result, "error": error})
                return
            await asyncio.sleep(0.005)
        raise AssertionError(f"window never got {action}")
    return asyncio.create_task(run())


def _describe(window_id: str, workspaces: list[str], panes: list[dict[str, Any]], **extra: Any) -> dict[str, Any]:
    return {
        "window_id": window_id,
        "kind": "main",
        "on_screen": workspaces[0] if workspaces else "",
        "workspaces": workspaces,
        "focused": False,
        "panes": panes,
        **extra,
    }


# ── roster ──────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_roster_and_whoami_carry_the_window_id_of_the_mirroring_window() -> None:
    w1 = await _main_window("win-aaaa-1111")
    w2 = await _main_window("win-bbbb-2222")
    agent_messaging.register("pa", "asker", "/ws/alpha", agent_key="claude", owner=w1)
    agent_messaging.register("pb", "worker", "/ws/beta", agent_key="claude", owner=w2)

    roster = await plan_mcp.cli_list_targets(_pane_ctx("pa"))
    me = await plan_mcp.cli_whoami(_pane_ctx("pa"))

    assert [t["window_id"] for t in roster["targets"]] == ["win-bbbb-2222"]
    assert me["window_id"] == "win-aaaa-1111"


@pytest.mark.asyncio
async def test_a_pane_with_no_known_main_window_gets_no_window_id_key() -> None:
    # Byte-identical to main for a pane whose owner is not a main window
    # (an embedded panel, a test owner, a window that never announced an id).
    agent_messaging.register("pa", "asker", "/ws/alpha", agent_key="claude", owner=object())
    agent_messaging.register("pb", "worker", "/ws/alpha", agent_key="claude", owner=object())

    roster = await plan_mcp.cli_list_targets(_pane_ctx("pa"))

    assert "window_id" not in roster["targets"][0]


# ── window_list ─────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_window_list_describes_every_main_window_and_marks_the_callers(monkeypatch: pytest.MonkeyPatch) -> None:
    w1 = await _main_window("win-aaaa-1111")
    w2 = await _main_window("win-bbbb-2222")
    agent_messaging.register("pa", "asker", "/ws/alpha", agent_key="claude", owner=w1)
    agent_messaging.register("pb", "worker", "/ws/beta", agent_key="claude", owner=w2)
    t1 = _answer(w1, "ui.window.describe", _describe("win-aaaa-1111", ["/ws/alpha"], [
        {"pane_id": "pa", "name": "asker", "workspace_path": "/ws/alpha"},
    ], focused=True))
    t2 = _answer(w2, "ui.window.describe", _describe("win-bbbb-2222", ["/ws/beta"], [
        {"pane_id": "pb", "name": "worker", "workspace_path": "/ws/beta"},
    ]))

    result = await window_tools.window_list(_pane_ctx("pa"))
    await t1
    await t2

    assert result["ok"] is True
    assert result["you"] == {"window_id": "win-aaaa-1111", "workspace_path": "/ws/alpha"}
    by_id = {w["window_id"]: w for w in result["windows"]}
    assert set(by_id) == {"win-aaaa-1111", "win-bbbb-2222"}
    assert by_id["win-aaaa-1111"]["is_yours"] is True
    assert by_id["win-bbbb-2222"]["is_yours"] is False
    assert by_id["win-aaaa-1111"]["answered"] is True
    assert by_id["win-aaaa-1111"]["focused"] is True
    assert by_id["win-bbbb-2222"]["panes"] == [
        {"pane_id": "pb", "address": "beta/worker", "workspace_path": "/ws/beta"},
    ]
    # Every request went to its own window alone, addressed.
    for session in (w1, w2):
        (req,) = _requests(session, "ui.window.describe")
        assert req["addressed"] is True and req["caller_pane_id"] == "pa"


@pytest.mark.asyncio
async def test_window_list_marks_a_main_window_holding_the_callers_workspace_as_yours() -> None:
    # The caller sits in a detached group window; its workspace is held by
    # the main window, which is "yours" too (for display only here).
    detached = await _main_window("win-dddd-0001")
    main = await _main_window("win-mmmm-0002")
    agent_messaging.register("pa", "asker", "/ws/alpha", agent_key="claude", owner=detached)
    t1 = _answer(detached, "ui.window.describe", _describe(
        "win-dddd-0001", ["/ws/alpha"], [], kind="detached-group", detached_group="g1",
    ))
    t2 = _answer(main, "ui.window.describe", _describe("win-mmmm-0002", ["/ws/alpha", "/ws/beta"], []))

    result = await window_tools.window_list(_pane_ctx("pa"))
    await t1
    await t2

    by_id = {w["window_id"]: w for w in result["windows"]}
    assert by_id["win-dddd-0001"]["is_yours"] is True
    assert by_id["win-dddd-0001"]["kind"] == "detached-group"
    assert by_id["win-mmmm-0002"]["is_yours"] is True


@pytest.mark.asyncio
async def test_one_silent_window_does_not_hold_the_listing_up(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(plan_mcp, "_WINDOW_DESCRIBE_TIMEOUT_S", 0.05)
    quiet = await _main_window("win-qqqq-0001")
    talks = await _main_window("win-tttt-0002")
    task = _answer(talks, "ui.window.describe", _describe("win-tttt-0002", ["/ws/beta"], []))

    result = await asyncio.wait_for(window_tools.window_list(_host_ctx()), timeout=2.0)
    await task

    by_id = {w["window_id"]: w for w in result["windows"]}
    assert by_id["win-qqqq-0001"]["answered"] is False
    assert by_id["win-tttt-0002"]["answered"] is True
    assert result["you"] is None
    assert plan_mcp._ui_invoke_pending.pending == {}
    assert _requests(quiet, "ui.window.describe")


@pytest.mark.asyncio
async def test_window_list_skips_windows_that_are_not_main_windows() -> None:
    plugin = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    app._SESSIONS.add(plugin)  # never announced the UI bus
    main = await _main_window("win-aaaa-1111")
    task = _answer(main, "ui.window.describe", _describe("win-aaaa-1111", ["/ws/alpha"], []))

    result = await window_tools.window_list(_host_ctx())
    await task

    assert [w["window_id"] for w in result["windows"]] == ["win-aaaa-1111"]
    assert plugin.websocket.sent == []  # type: ignore[attr-defined]


# ── window_focus ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_window_focus_reaches_only_the_named_window_and_records_who_did_it() -> None:
    w1 = await _main_window("win-aaaa-1111", focused=True)
    w2 = await _main_window("win-bbbb-2222")
    agent_messaging.register("pa", "asker", "/ws/alpha", agent_key="claude", owner=w1)
    task = _answer(w2, "ui.window.focus", {"on_screen": "/ws/beta", "previous_on_screen": "/ws/gamma"})

    result = await window_tools.window_focus("win-bbbb-2222", _pane_ctx("pa"), workspace_path="/ws/beta")
    await task

    assert result["ok"] is True
    assert result["window_id"] == "win-bbbb-2222"
    assert result["on_screen"] == "/ws/beta"
    assert result["previous"] == {"focused_window_id": "win-aaaa-1111", "on_screen": "/ws/gamma"}
    assert _requests(w1, "ui.window.focus") == []
    (req,) = _requests(w2, "ui.window.focus")
    assert req["args"]["workspace_path"] == "/ws/beta"
    assert req["args"]["caller_address"] == "alpha/asker"
    (entry,) = agent_window_actions.entries()
    assert entry["tool"] == "window_focus"
    assert entry["caller"] == {"pane_id": "pa", "address": "alpha/asker"}
    assert entry["target"] == {"window_id": "win-bbbb-2222", "workspace_path": "/ws/beta"}
    assert entry["ok"] is True
    on_disk = [json.loads(line) for line in agent_window_actions._path().read_text().splitlines()]  # type: ignore[union-attr]
    assert on_disk == [entry]


@pytest.mark.asyncio
async def test_window_focus_of_an_unknown_window_is_refused_without_sending() -> None:
    w1 = await _main_window("win-aaaa-1111")

    result = await window_tools.window_focus("win-gone-9999", _host_ctx())

    assert result["ok"] is False and result["error_code"] == "unknown-window"
    assert "window_list" in result["error"]
    assert _requests(w1, "ui.window.focus") == []


@pytest.mark.asyncio
async def test_window_focus_of_another_device_is_local_only() -> None:
    result = await window_tools.window_focus("laptop/win-aaaa-1111", _host_ctx())

    assert result["ok"] is False and result["error_code"] == "window-local-only"


@pytest.mark.asyncio
async def test_window_focus_passes_a_failed_switch_through_and_records_it() -> None:
    w1 = await _main_window("win-aaaa-1111")
    task = _answer(w1, "ui.window.focus", None, ok=False, error="a pipeline is running in this window")

    result = await window_tools.window_focus("win-aaaa-1111", _host_ctx(), workspace_path="/ws/beta")
    await task

    assert result["ok"] is False
    assert "pipeline is running" in result["error"]
    (entry,) = agent_window_actions.entries()
    assert entry["ok"] is False and entry["caller"] == {"kind": "host"}


# ── helpers S2 builds on ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_window_session_finds_a_live_main_window_by_id_only() -> None:
    w1 = await _main_window("win-aaaa-1111")
    gone = await _main_window("win-gone-0002")
    gone.dead = True

    assert plan_mcp._window_session("win-aaaa-1111") is w1
    assert plan_mcp._window_session("win-gone-0002") is None
    assert plan_mcp._window_session("") is None


@pytest.mark.asyncio
async def test_ui_invoke_window_focus_names_the_caller_from_its_credential(monkeypatch: pytest.MonkeyPatch) -> None:
    sent: list[dict[str, Any]] = []

    async def fake_ui_request(workspace_path: str, op: str, **kwargs: Any) -> dict[str, Any]:
        sent.append(kwargs)
        return {"ok": True, "result": None, "error": None}

    monkeypatch.setattr(plan_mcp, "_ui_request", fake_ui_request)
    agent_messaging.register("pa", "asker", "/ws/alpha", agent_key="claude", owner=object())

    await plan_mcp.ui_invoke("", "ui.window.focus", _pane_ctx("pa"), args={"caller_address": "beta/someone-else"})

    assert sent[0]["args"]["caller_address"] == "alpha/asker"

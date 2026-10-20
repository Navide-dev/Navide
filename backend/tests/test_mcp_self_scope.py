"""An agent can never close its own pane, its own workspace or its own window.

"Own" is derived from the caller's credential only — the pane id its token
names, the workspace the registry holds for that pane, and the windows that
mirror its workspace's panes — never from anything in the call's arguments.
These pin the backend half; the renderer makes the same check again
(useUiActionBus.test.ts).
"""

from __future__ import annotations

import asyncio
import os
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging, app
from agent_team_backend.mcp_server import server as plan_mcp, wiring as plan_mcp_wiring


@pytest.fixture(autouse=True)
def _clean_registry() -> Any:
    agent_messaging._reset_for_test()
    plan_mcp._ui_invoke_pending.pending.clear()
    yield
    agent_messaging._reset_for_test()
    plan_mcp._ui_invoke_pending.pending.clear()


class _Window:
    """A renderer window's WS session, as owner() hands it back."""

    def __init__(self, window_id: str) -> None:
        self.dead = False
        self.window_id = window_id


def _pane_ctx(pane_id: str) -> Any:
    params = {"pane": pane_id, "t": plan_mcp_wiring.caller_token(pane_id)}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


def _no_window_reached(monkeypatch: pytest.MonkeyPatch) -> None:
    """A refusal must happen before any window is asked."""

    async def reached(*_args: Any, **_kwargs: Any) -> bool:
        raise AssertionError("the refusal is missing: the request reached a window")

    monkeypatch.setattr(app, "unicast_to", reached)
    monkeypatch.setattr(app, "broadcast", reached)
    monkeypatch.setattr(app, "unicast_any", reached)


@pytest.fixture
def sent(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """Captures what reaches a window, by any of the three routes."""
    events: list[dict[str, Any]] = []

    async def capture(*args: Any, **_kwargs: Any) -> bool:
        events.append(args[-1])
        return True

    monkeypatch.setattr(app, "unicast_to", capture)
    monkeypatch.setattr(app, "broadcast", capture)
    monkeypatch.setattr(app, "unicast_any", capture)
    return events


async def _answer(result: Any) -> None:
    for _ in range(200):
        keys = list(plan_mcp._ui_invoke_pending.pending)
        if keys:
            plan_mcp.resolve_ui_invoke(keys[0], {"ok": True, "result": result, "error": None})
            return
        await asyncio.sleep(0.005)
    raise AssertionError("no pending ui.invoke request appeared")


def _refusal(pane_id: str, action: str, args: dict[str, Any], workspace_path: str = "") -> dict[str, Any]:
    """The self check S4's window_close / workspace_close run, called directly:
    ui_invoke no longer reaches those two actions at all."""
    caller = plan_mcp._resolve_caller(_pane_ctx(pane_id))
    return plan_mcp._self_scope_refusal(caller, action, args, workspace_path) or {"ok": True}


@pytest.fixture
def workspace(tmp_path: Any) -> str:
    path = tmp_path / "alpha"
    path.mkdir()
    return str(path)


# ── ui.pane.close ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_ui_invoke_refuses_closing_the_callers_own_pane(
    monkeypatch: pytest.MonkeyPatch, workspace: str
) -> None:
    _no_window_reached(monkeypatch)
    agent_messaging.register("pa", "worker", workspace, agent_key="claude", owner=_Window("w1"))
    result = await plan_mcp.ui_invoke(workspace, "ui.pane.close", _pane_ctx("pa"), {"paneId": "pa"})
    assert result["ok"] is False
    assert result["error_code"] == "self-close"


@pytest.mark.asyncio
async def test_a_superseded_id_of_the_callers_own_pane_is_still_its_own(
    monkeypatch: pytest.MonkeyPatch, workspace: str
) -> None:
    """A re-attach gives the pane a new id and keeps the old one as an alias;
    naming yourself by the old id must not slip past the check."""
    _no_window_reached(monkeypatch)
    agent_messaging.register("pa2", "worker", workspace, agent_key="claude", owner=_Window("w1"))
    agent_messaging.add_aliases("pa2", ["pa"], workspace)
    result = await plan_mcp.ui_invoke(workspace, "ui.pane.close", _pane_ctx("pa2"), {"paneId": "pa"})
    assert result["error_code"] == "self-close"


@pytest.mark.asyncio
async def test_closing_another_pane_through_ui_invoke_still_goes_through(
    sent: list[dict[str, Any]], workspace: str
) -> None:
    agent_messaging.register("pa", "worker", workspace, agent_key="claude", owner=_Window("w1"))
    agent_messaging.register("pb", "child", workspace, agent_key="claude", owner=_Window("w1"))
    task = asyncio.create_task(_answer({}))
    result = await plan_mcp.ui_invoke(workspace, "ui.pane.close", _pane_ctx("pa"), {"paneId": "pb"})
    await task
    assert result["ok"] is True
    assert sent[0]["payload"]["args"] == {"paneId": "pb"}


# ── ui.pane.reclaim ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_reclaiming_only_yourself_is_refused_without_asking_a_window(
    monkeypatch: pytest.MonkeyPatch, workspace: str
) -> None:
    _no_window_reached(monkeypatch)
    agent_messaging.register("pa", "worker", workspace, agent_key="claude", owner=_Window("w1"))
    result = await plan_mcp.ui_invoke(workspace, "ui.pane.reclaim", _pane_ctx("pa"), {"paneId": "pa"})
    assert result["ok"] is True
    assert result["result"]["reclaimed"] == []
    assert [r["paneId"] for r in result["result"]["refused"]] == ["pa"]
    assert result["result"]["refused"][0]["reason"] == "self"


@pytest.mark.asyncio
async def test_a_reclaim_batch_drops_only_yourself_and_reports_it_refused(
    sent: list[dict[str, Any]], workspace: str
) -> None:
    agent_messaging.register("pa", "worker", workspace, agent_key="claude", owner=_Window("w1"))
    agent_messaging.register("pb", "child", workspace, agent_key="claude", owner=_Window("w1"))
    task = asyncio.create_task(_answer({"reclaimed": ["pb"], "refused": []}))
    result = await plan_mcp.ui_invoke(
        workspace, "ui.pane.reclaim", _pane_ctx("pa"), {"paneId": ["pa", "pb"]}
    )
    await task
    assert sent[0]["payload"]["args"] == {"paneId": ["pb"]}
    assert result["result"]["reclaimed"] == ["pb"]
    assert [(r["paneId"], r["reason"]) for r in result["result"]["refused"]] == [("pa", "self")]


# ── ui.workspace.close ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_closing_your_own_workspace_is_refused_however_the_path_is_spelled(
    monkeypatch: pytest.MonkeyPatch, workspace: str, tmp_path: Any
) -> None:
    _no_window_reached(monkeypatch)
    agent_messaging.register("pa", "worker", workspace, agent_key="claude", owner=_Window("w1"))
    link = tmp_path / "alias"
    link.symlink_to(workspace)
    home = os.path.expanduser("~")
    spellings = [workspace, workspace + "/", str(link)]
    if workspace.startswith(home):
        spellings.append("~" + workspace[len(home):])
    for path in spellings:
        result = _refusal("pa", "ui.workspace.close", {"path": path})
        assert result["ok"] is False, path
        assert result["error_code"] == "self-workspace-close", path


def test_closing_another_workspace_is_not_refused(workspace: str, tmp_path: Any) -> None:
    other = tmp_path / "beta"
    other.mkdir()
    agent_messaging.register("pa", "worker", workspace, agent_key="claude", owner=_Window("w1"))
    assert _refusal("pa", "ui.workspace.close", {"path": str(other)})["ok"] is True


@pytest.mark.asyncio
async def test_ui_invoke_sends_the_window_and_workspace_close_actions_to_their_own_tools(
    monkeypatch: pytest.MonkeyPatch, workspace: str, tmp_path: Any
) -> None:
    """Review #541 MED-1: closing through ui_invoke would leave no action record
    and no notice of which pane did it, so it is not a route at all."""
    _no_window_reached(monkeypatch)
    other = tmp_path / "beta"
    other.mkdir()
    agent_messaging.register("pa", "worker", workspace, agent_key="claude", owner=_Window("w1"))
    agent_messaging.register("pb", "else", str(other), agent_key="claude", owner=_Window("w2"))
    for action, args, tool in (
        ("ui.window.close", {"windowId": "w2"}, "window_close"),
        ("ui.workspace.close", {"path": str(other)}, "workspace_close"),
    ):
        result = await plan_mcp.ui_invoke(str(other), action, _pane_ctx("pa"), args)
        assert result["error_code"] == "ui_dedicated_tool", action
        assert tool in result["error"], action


# ── ui.window.close ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_closing_the_window_that_hosts_you_is_refused(
    monkeypatch: pytest.MonkeyPatch, workspace: str
) -> None:
    agent_messaging.register("pa", "worker", workspace, agent_key="claude", owner=_Window("w1"))
    assert _refusal("pa", "ui.window.close", {"windowId": "w1"})["error_code"] == "self-window-close"


@pytest.mark.asyncio
async def test_a_window_holding_your_workspace_is_yours_even_if_you_sit_elsewhere(
    monkeypatch: pytest.MonkeyPatch, workspace: str
) -> None:
    """A pane in a detached group window: the main window holding its workspace
    is just as much its own — closing it closes the caller's workspace."""
    agent_messaging.register("pa", "worker", workspace, agent_key="claude", owner=_Window("detached"))
    agent_messaging.register("pb", "sibling", workspace, agent_key="claude", owner=_Window("main"))
    assert _refusal("pa", "ui.window.close", {"windowId": "main"})["error_code"] == "self-window-close"


class _MainWindow:
    """A connected main window as app.main_window_sessions() lists it."""

    def __init__(self, window_id: str, held: tuple[str, ...]) -> None:
        self.dead = False
        self.window_id = window_id
        self.held_workspaces = held


def test_a_main_window_holding_your_workspace_with_none_of_its_panes_is_yours(
    monkeypatch: pytest.MonkeyPatch, workspace: str, tmp_path: Any
) -> None:
    """All the caller's workspace's panes sit in detached group windows; the
    main window that holds the workspace has none of them. It is still the
    caller's own, and the backend alone must refuse closing it."""
    variant = workspace[:-len("alpha")] + "ALPHA"
    held_spelling = variant if os.path.isdir(variant) else workspace + "/"
    monkeypatch.setattr(
        app, "main_window_sessions",
        lambda: [_MainWindow("main", (held_spelling,)), _MainWindow("other", (str(tmp_path),))],
    )
    agent_messaging.register("pa", "worker", workspace, agent_key="claude", owner=_Window("detached"))
    assert _refusal("pa", "ui.window.close", {"windowId": "main"})["error_code"] == "self-window-close"
    assert _refusal("pa", "ui.window.close", {"windowId": "other"})["ok"] is True


def test_closing_a_window_of_another_workspace_is_not_refused(workspace: str, tmp_path: Any) -> None:
    other = tmp_path / "beta"
    other.mkdir()
    agent_messaging.register("pa", "worker", workspace, agent_key="claude", owner=_Window("w1"))
    agent_messaging.register("pb", "else", str(other), agent_key="claude", owner=_Window("w2"))
    assert _refusal("pa", "ui.window.close", {"windowId": "w2"})["ok"] is True


# ── identity travels to the window ───────────────────────────────────────────


@pytest.mark.asyncio
async def test_the_request_carries_the_callers_workspace_from_the_registry(
    sent: list[dict[str, Any]], workspace: str
) -> None:
    """The renderer repeats the check, so it needs the caller's workspace — taken
    from the registry, never from args."""
    agent_messaging.register("pa", "worker", workspace, agent_key="claude", owner=_Window("w1"))
    task = asyncio.create_task(_answer({}))
    await plan_mcp.ui_invoke(workspace, "ui.layout.setMode", _pane_ctx("pa"), {"mode": "grid"})
    await task
    assert sent[0]["payload"]["caller_pane_id"] == "pa"
    assert sent[0]["payload"]["caller_workspace_path"] == workspace


def test_a_host_caller_has_no_self_scope() -> None:
    assert plan_mcp._self_scope(plan_mcp._Caller(kind="host")) is None


# ── review #534 ──────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_the_close_window_keybinding_command_is_only_reachable_through_window_close(
    monkeypatch: pytest.MonkeyPatch, workspace: str, tmp_path: Any
) -> None:
    """Review #534 HIGH-1 / R2 MED-1: workbench.action.closeWindow runs
    window.close() in whichever window answers — the caller's own, or someone
    else's with no record of who did it. ui_invoke sends it to window_close."""
    _no_window_reached(monkeypatch)
    other = tmp_path / "beta"
    other.mkdir()
    agent_messaging.register("pa", "worker", workspace, agent_key="claude", owner=_Window("w1"))
    agent_messaging.register("pb", "else", str(other), agent_key="claude", owner=_Window("w2"))
    for target in ("", workspace, workspace + "/", str(other)):
        result = await plan_mcp.ui_invoke(target, "workbench.action.closeWindow", _pane_ctx("pa"), None)
        assert result["error_code"] == "ui_dedicated_tool", target
        assert "window_close" in result["error"], target


def test_the_self_check_still_knows_which_windows_the_close_window_command_would_hit(
    workspace: str, tmp_path: Any
) -> None:
    """Kept for any route that runs it: one window holding two projects is the
    caller's own whichever of them is named."""
    other = tmp_path / "beta"
    other.mkdir()
    agent_messaging.register("pa", "worker", workspace, agent_key="claude", owner=_Window("w1"))
    agent_messaging.register("pb", "else", str(other), agent_key="claude", owner=_Window("w1"))
    for target in ("", workspace, str(other)):
        assert _refusal("pa", "workbench.action.closeWindow", {}, target)["error_code"] == "self-window-close"


# ── ui.pipeline.reset (review #534 R2 HIGH-1) ────────────────────────────────


@pytest.mark.asyncio
async def test_a_pipeline_reset_in_your_own_window_is_refused_on_both_routes(
    monkeypatch: pytest.MonkeyPatch, workspace: str
) -> None:
    """Reset ends every pane in the window (onKillAll), manual ones included and
    with no run needed — the caller's own with them."""
    _no_window_reached(monkeypatch)
    agent_messaging.register("pa", "worker", workspace, agent_key="claude", owner=_Window("w1"))
    via_invoke = await plan_mcp.ui_invoke("", "ui.pipeline.reset", _pane_ctx("pa"), {})
    assert via_invoke["error_code"] == "self-close"
    via_tool = await plan_mcp.pipeline_reset(_pane_ctx("pa"))
    assert via_tool["error_code"] == "self-close"


def test_a_pipeline_reset_aimed_at_a_project_your_window_holds_without_panes_is_refused(
    monkeypatch: pytest.MonkeyPatch, workspace: str, tmp_path: Any
) -> None:
    """The window holds the other project only as an announced workspace —
    no pane of it is registered — and is still the caller's own."""
    other = tmp_path / "beta"
    other.mkdir()
    monkeypatch.setattr(app, "main_window_sessions", lambda: [_MainWindow("w1", (workspace, str(other)))])
    agent_messaging.register("pa", "worker", workspace, agent_key="claude", owner=_Window("w1"))
    assert _refusal("pa", "ui.pipeline.reset", {}, str(other))["error_code"] == "self-close"


@pytest.mark.asyncio
async def test_a_pipeline_reset_in_another_window_still_goes_through(
    sent: list[dict[str, Any]], workspace: str, tmp_path: Any
) -> None:
    other = tmp_path / "beta"
    other.mkdir()
    agent_messaging.register("pa", "worker", workspace, agent_key="claude", owner=_Window("w1"))
    agent_messaging.register("pb", "else", str(other), agent_key="claude", owner=_Window("w2"))
    task = asyncio.create_task(_answer({}))
    result = await plan_mcp.ui_invoke(str(other), "ui.pipeline.reset", _pane_ctx("pa"), {})
    await task
    assert result["ok"] is True


def test_a_folder_that_is_gone_still_matches_its_case_variant_where_case_is_ignored(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(plan_mcp.sys, "platform", "darwin")
    assert plan_mcp._same_directory("/no/such/Proj", "/no/such/proj/") is True
    monkeypatch.setattr(plan_mcp.sys, "platform", "linux")
    assert plan_mcp._same_directory("/no/such/Proj", "/no/such/proj") is False


@pytest.mark.asyncio
async def test_a_case_variant_of_your_own_workspace_is_still_yours(
    monkeypatch: pytest.MonkeyPatch, workspace: str
) -> None:
    """MED-2: on a case-insensitive volume (macOS, Windows) Path.resolve keeps
    the case it is given, so a string compare missed it. Compared by identity
    of the directory instead."""
    variant = workspace[:-len("alpha")] + "ALPHA"
    if not os.path.isdir(variant):
        pytest.skip("case-sensitive volume: the variant is a different (missing) folder")
    _no_window_reached(monkeypatch)
    agent_messaging.register("pa", "worker", workspace, agent_key="claude", owner=_Window("w1"))
    for path in (variant, variant + "/"):
        assert _refusal("pa", "ui.workspace.close", {"path": path})["error_code"] == "self-workspace-close", path


@pytest.mark.asyncio
async def test_a_case_variant_registration_still_counts_its_window_as_yours(
    monkeypatch: pytest.MonkeyPatch, workspace: str
) -> None:
    variant = workspace[:-len("alpha")] + "ALPHA"
    if not os.path.isdir(variant):
        pytest.skip("case-sensitive volume")
    _no_window_reached(monkeypatch)
    agent_messaging.register("pa", "worker", workspace, agent_key="claude", owner=_Window("detached"))
    agent_messaging.register("pb", "sibling", variant, agent_key="claude", owner=_Window("main"))
    assert _refusal("pa", "ui.window.close", {"windowId": "main"})["error_code"] == "self-window-close"


@pytest.mark.asyncio
async def test_a_reclaim_batch_keeps_your_refused_row_when_the_window_errors(
    monkeypatch: pytest.MonkeyPatch, workspace: str
) -> None:
    """LOW-2: the caller's own row must not vanish with an error reply."""
    agent_messaging.register("pa", "worker", workspace, agent_key="claude", owner=_Window("w1"))
    agent_messaging.register("pb", "child", workspace, agent_key="claude", owner=_Window("w1"))

    async def failing(*_a: Any, **_k: Any) -> dict[str, Any]:
        return {"ok": False, "result": None, "error": "boom", "error_code": "ui_action_failed"}

    monkeypatch.setattr(plan_mcp, "_ui_request", failing)
    result = await plan_mcp.ui_invoke(
        workspace, "ui.pane.reclaim", _pane_ctx("pa"), {"paneId": ["pa", "pb"]}
    )
    assert result["ok"] is False
    assert [(r["paneId"], r["reason"]) for r in result["result"]["refused"]] == [("pa", "self")]


@pytest.mark.skip(reason="TODO(S4, review #534 MED-3): ui.workspace.close is registered in S4")
@pytest.mark.asyncio
async def test_s4_contract_an_empty_workspace_close_path_counts_as_your_own() -> None:
    """S4 must either require `path` or treat an empty one as the caller's own
    workspace — whichever it picks, `{}` must not close the caller's workspace.
    Turn this on with S4's handler."""


@pytest.mark.asyncio
async def test_a_window_announces_the_workspaces_it_holds() -> None:
    """ui.invoke.ready carries the held list the self checks read; anything
    that is not a non-empty string is dropped."""
    from agent_team_backend import ws_handlers

    replies: list[Any] = []

    async def send_json(message: Any) -> None:
        replies.append(message)

    session = SimpleNamespace(ui_bus_ready=False, window_id="", ui_focused_at=0, held_workspaces=(), send_json=send_json)
    await ws_handlers.ui_invoke_ready(
        session, "m1", "ui.invoke.ready", {"window_id": "abcdef12-3456", "workspaces": ["/ws/a", "", 3, "/ws/b"]}
    )
    assert session.held_workspaces == ("/ws/a", "/ws/b")
    assert session.window_id == "abcdef12-3456"

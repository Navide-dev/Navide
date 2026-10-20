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
        result = await plan_mcp.ui_invoke("", "ui.workspace.close", _pane_ctx("pa"), {"path": path})
        assert result["ok"] is False, path
        assert result["error_code"] == "self-workspace-close", path


@pytest.mark.asyncio
async def test_closing_another_workspace_is_not_refused(
    sent: list[dict[str, Any]], workspace: str, tmp_path: Any
) -> None:
    other = tmp_path / "beta"
    other.mkdir()
    agent_messaging.register("pa", "worker", workspace, agent_key="claude", owner=_Window("w1"))
    task = asyncio.create_task(_answer({}))
    result = await plan_mcp.ui_invoke(
        str(other), "ui.workspace.close", _pane_ctx("pa"), {"path": str(other)}
    )
    await task
    assert result["ok"] is True


# ── ui.window.close ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_closing_the_window_that_hosts_you_is_refused(
    monkeypatch: pytest.MonkeyPatch, workspace: str
) -> None:
    _no_window_reached(monkeypatch)
    agent_messaging.register("pa", "worker", workspace, agent_key="claude", owner=_Window("w1"))
    result = await plan_mcp.ui_invoke("", "ui.window.close", _pane_ctx("pa"), {"windowId": "w1"})
    assert result["error_code"] == "self-window-close"


@pytest.mark.asyncio
async def test_a_window_holding_your_workspace_is_yours_even_if_you_sit_elsewhere(
    monkeypatch: pytest.MonkeyPatch, workspace: str
) -> None:
    """A pane in a detached group window: the main window holding its workspace
    is just as much its own — closing it closes the caller's workspace."""
    _no_window_reached(monkeypatch)
    agent_messaging.register("pa", "worker", workspace, agent_key="claude", owner=_Window("detached"))
    agent_messaging.register("pb", "sibling", workspace, agent_key="claude", owner=_Window("main"))
    result = await plan_mcp.ui_invoke("", "ui.window.close", _pane_ctx("pa"), {"windowId": "main"})
    assert result["error_code"] == "self-window-close"


@pytest.mark.asyncio
async def test_closing_a_window_of_another_workspace_is_not_refused(
    sent: list[dict[str, Any]], workspace: str, tmp_path: Any
) -> None:
    other = tmp_path / "beta"
    other.mkdir()
    agent_messaging.register("pa", "worker", workspace, agent_key="claude", owner=_Window("w1"))
    agent_messaging.register("pb", "else", str(other), agent_key="claude", owner=_Window("w2"))
    task = asyncio.create_task(_answer({}))
    result = await plan_mcp.ui_invoke(str(other), "ui.window.close", _pane_ctx("pa"), {"windowId": "w2"})
    await task
    assert result["ok"] is True


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
async def test_the_close_window_keybinding_command_cannot_close_your_own_window(
    monkeypatch: pytest.MonkeyPatch, workspace: str
) -> None:
    """HIGH-1: workbench.action.closeWindow runs window.close() in whichever
    window the request lands in; for a pane caller with no workspace_path, or
    naming its own, that is the caller's own window."""
    _no_window_reached(monkeypatch)
    agent_messaging.register("pa", "worker", workspace, agent_key="claude", owner=_Window("w1"))
    for target in ("", workspace, workspace + "/"):
        result = await plan_mcp.ui_invoke(target, "workbench.action.closeWindow", _pane_ctx("pa"), None)
        assert result["error_code"] == "self-window-close", target


@pytest.mark.asyncio
async def test_the_close_window_command_aimed_at_another_project_still_goes_through(
    sent: list[dict[str, Any]], workspace: str, tmp_path: Any
) -> None:
    other = tmp_path / "beta"
    other.mkdir()
    agent_messaging.register("pa", "worker", workspace, agent_key="claude", owner=_Window("w1"))
    agent_messaging.register("pb", "else", str(other), agent_key="claude", owner=_Window("w2"))
    task = asyncio.create_task(_answer({}))
    result = await plan_mcp.ui_invoke(str(other), "workbench.action.closeWindow", _pane_ctx("pa"), None)
    await task
    assert result["ok"] is True


@pytest.mark.asyncio
async def test_the_close_window_command_aimed_at_another_project_your_window_also_holds_is_refused(
    monkeypatch: pytest.MonkeyPatch, workspace: str, tmp_path: Any
) -> None:
    """One window, two projects: naming the other project still lands in the
    caller's own window."""
    _no_window_reached(monkeypatch)
    other = tmp_path / "beta"
    other.mkdir()
    agent_messaging.register("pa", "worker", workspace, agent_key="claude", owner=_Window("w1"))
    agent_messaging.register("pb", "else", str(other), agent_key="claude", owner=_Window("w1"))
    result = await plan_mcp.ui_invoke(str(other), "workbench.action.closeWindow", _pane_ctx("pa"), None)
    assert result["error_code"] == "self-window-close"


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
        result = await plan_mcp.ui_invoke("", "ui.workspace.close", _pane_ctx("pa"), {"path": path})
        assert result["error_code"] == "self-workspace-close", path


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
    result = await plan_mcp.ui_invoke("", "ui.window.close", _pane_ctx("pa"), {"windowId": "main"})
    assert result["error_code"] == "self-window-close"


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

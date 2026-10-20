"""window_move_pane (DESIGN-C S4b).

A pane lives only in a window holding its project (approval (d)): it moves
alone only into a detached window of its own or, from one, back to its
project's main window; anything else is "pane-needs-workspace-move". Mode
"workspace" moves the whole project: the source lets go of it (CLIs keep
running) and the destination adopts it, or it goes back to the source.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging, agent_window_actions, app
from agent_team_backend.mcp_server import server as plan_mcp
from agent_team_backend.mcp_server import window_tools
from agent_team_backend.mcp_server import wiring as plan_mcp_wiring


class _Window:
    def __init__(self, window_id: str) -> None:
        self.dead = False
        self.window_id = window_id


@pytest.fixture
def world(monkeypatch: pytest.MonkeyPatch, tmp_path: Any) -> dict[str, Any]:
    agent_messaging._reset_for_test()
    agent_window_actions._reset_for_test(tmp_path / "actions.jsonl")
    m1, m2, d1 = _Window("m1"), _Window("m2"), _Window("d1")
    state: dict[str, Any] = {
        "w": {"m1": m1, "m2": m2, "d1": d1},
        "described": {
            m1: {"kind": "main", "workspaces": ["/ws/alpha", "/ws/beta"]},
            m2: {"kind": "main", "workspaces": ["/ws/gamma"]},
            d1: {"kind": "detached-group", "workspaces": ["/ws/beta"]},
        },
        "requests": [],
        "answers": {},
    }
    # The caller in m1 (alpha); a worker in m1 (beta); one in the detached window (beta).
    agent_messaging.register("pa", "lead", "/ws/alpha", agent_key="claude", owner=m1)
    agent_messaging.register("pb", "worker", "/ws/beta", agent_key="claude", owner=m1)
    agent_messaging.register("pd", "split", "/ws/beta", agent_key="claude", owner=d1)

    async def describe(_caller: Any) -> list[tuple[Any, dict[str, Any] | None]]:
        return [(s, {"ok": True, "result": d}) for s, d in state["described"].items()]

    async def request(session: Any, action: str, args: Any, _caller: Any, **_kw: Any) -> dict[str, Any] | None:
        state["requests"].append((session.window_id, action, args))
        answer = state["answers"].get((session.window_id, action))
        if answer is not None:
            return answer
        return {"ok": True, "result": {"panes": [{"pane_id": (args or {}).get("paneId") or "pb"}]}, "error": None}

    async def landed(pane_id: str, from_window: str, timeout: float = 15.0) -> tuple[str, str]:
        return pane_id, "new-window-id" if from_window != "new-window-id" else ""

    monkeypatch.setattr(plan_mcp, "_describe_windows", describe)
    monkeypatch.setattr(plan_mcp, "_window_request", request)
    monkeypatch.setattr(plan_mcp, "_window_session", lambda wid: state["w"].get(wid))
    monkeypatch.setattr(plan_mcp, "_pane_window_id", lambda pid: getattr(agent_messaging.owner(pid), "window_id", ""))
    monkeypatch.setattr(window_tools, "_wait_for_new_window", landed)
    yield state
    agent_messaging._reset_for_test()
    agent_window_actions._reset_for_test(None)


def _ctx(pane_id: str = "pa") -> Any:
    params = {"pane": pane_id, "t": plan_mcp_wiring.caller_token(pane_id)}
    return SimpleNamespace(request_context=SimpleNamespace(request=SimpleNamespace(query_params=params)))


def _actions(state: dict[str, Any]) -> list[str]:
    return [a for _w, a, _x in state["requests"]]


@pytest.mark.asyncio
async def test_a_single_pane_cannot_move_into_another_projects_window(world: dict[str, Any]) -> None:
    result = await window_tools.window_move_pane(_ctx(), to_window="m2", target="beta/worker")

    assert result["ok"] is False and result["error_code"] == "pane-needs-workspace-move"
    assert "mode \"workspace\"" in result["error"]
    assert "ui.pane.moveToWindow" not in _actions(world)
    (entry,) = agent_window_actions.entries()
    assert entry["ok"] is False


@pytest.mark.asyncio
async def test_a_main_window_pane_cannot_move_to_another_main_window_holding_its_project(world: dict[str, Any]) -> None:
    world["described"][world["w"]["m2"]]["workspaces"].append("/ws/beta")

    result = await window_tools.window_move_pane(_ctx(), to_window="m2", target="beta/worker")

    assert result["error_code"] == "pane-needs-workspace-move"


@pytest.mark.asyncio
async def test_a_pane_moves_alone_into_a_window_of_its_own(world: dict[str, Any]) -> None:
    result = await window_tools.window_move_pane(_ctx(), to_window="new", target="beta/worker")

    assert result["ok"] is True and result["mode"] == "pane"
    assert result["from_window_id"] == "m1" and result["to_window_id"] == "new-window-id"
    assert result["moved_panes"] == ["beta/worker"]
    assert result["undo"] == {"tool": "window_move_pane", "args": {"pane_id": "pb", "to_window": "m1", "mode": "pane"}}
    (req,) = [r for r in world["requests"] if r[1] == "ui.pane.moveToWindow"]
    assert req[0] == "m1" and req[2]["to"] == "new" and req[2]["caller_address"] == "alpha/lead"
    (entry,) = agent_window_actions.entries()
    assert entry["ok"] is True and entry["tool"] == "window_move_pane"


@pytest.mark.asyncio
async def test_a_detached_pane_goes_back_to_the_main_window_holding_its_project(world: dict[str, Any]) -> None:
    result = await window_tools.window_move_pane(_ctx(), to_window="m1", target="beta/split")

    assert result["ok"] is True
    (req,) = [r for r in world["requests"] if r[1] == "ui.pane.moveToWindow"]
    assert req[0] == "d1" and req[2]["to"] == "m1"


@pytest.mark.asyncio
async def test_a_project_moves_with_its_panes_to_an_existing_window(world: dict[str, Any]) -> None:
    result = await window_tools.window_move_pane(_ctx(), to_window="m2", target="beta/worker", mode="workspace")

    assert result["ok"] is True and result["mode"] == "workspace"
    order = [(w, a) for w, a, _x in world["requests"] if a in ("ui.workspace.moveToWindow", "ui.workspace.adopt")]
    # The source lets go first (one project, one window), then the destination takes it.
    assert order == [("m1", "ui.workspace.moveToWindow"), ("m2", "ui.workspace.adopt")]
    assert any("cards" in a for a in result["advisories"])


@pytest.mark.asyncio
async def test_a_project_the_destination_cannot_take_goes_back(world: dict[str, Any]) -> None:
    world["answers"][("m2", "ui.workspace.adopt")] = {"ok": False, "result": None, "error": "window-cannot-hold: no"}

    result = await window_tools.window_move_pane(_ctx(), to_window="m2", target="beta/worker", mode="workspace")

    assert result["ok"] is False and result["error_code"] == "window-cannot-hold"
    assert ("m1", "ui.workspace.adopt", {"path": "/ws/beta"}) in world["requests"]


@pytest.mark.asyncio
async def test_moving_your_own_pane_is_allowed_and_said(world: dict[str, Any]) -> None:
    result = await window_tools.window_move_pane(_ctx(), to_window="new", target="lead")

    assert result["ok"] is True
    assert any("your own" in a for a in result["advisories"])


@pytest.mark.asyncio
async def test_the_windows_refusal_passes_through(world: dict[str, Any]) -> None:
    world["answers"][("m1", "ui.workspace.moveToWindow")] = {
        "ok": False, "result": None, "error": "last-workspace: it would leave the window empty",
    }

    result = await window_tools.window_move_pane(_ctx(), to_window="new", target="beta/worker", mode="workspace")

    assert result["ok"] is False and result["error_code"] == "last-workspace"


@pytest.mark.asyncio
@pytest.mark.parametrize("to_window, code", [("gone", "unknown-window"), ("laptop/m2", "window-local-only"), ("m1", "already-there")])
async def test_bad_destinations(world: dict[str, Any], to_window: str, code: str) -> None:
    result = await window_tools.window_move_pane(_ctx(), to_window=to_window, target="beta/worker")

    assert result["ok"] is False and result["error_code"] == code


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ["ui.pane.moveToWindow", "ui.workspace.moveToWindow"])
async def test_ui_invoke_cannot_reach_the_move_commands(world: dict[str, Any], action: str) -> None:
    result = await plan_mcp.ui_invoke("", action, _ctx(), args={"paneId": "pb", "to": "new"})

    assert result["ok"] is False and result["error_code"] == "ui_dedicated_tool"
    assert "window_move_pane" in result["error"]


@pytest.mark.asyncio
async def test_a_project_move_hands_both_windows_the_registry_spelling(world: dict[str, Any]) -> None:
    # The pane's workspace as its window registered it is the spelling that
    # window holds (it matches exactly); the destination adopts that one.
    result = await window_tools.window_move_pane(_ctx(), to_window="m2", pane_id="pb", mode="workspace")

    assert result["ok"] is True
    sent = {(w, a): x for w, a, x in world["requests"]}
    assert sent[("m1", "ui.workspace.moveToWindow")]["path"] == "/ws/beta"
    assert sent[("m2", "ui.workspace.adopt")] == {"path": "/ws/beta"}

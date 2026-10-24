"""cli_open_agent(window="existing", window_id=...) (DESIGN-C §3.1, S4b).

"existing" opens the child in the window that already holds the project —
any window, not only the caller's — or, with window_id, in that window, which
adopts the project when nobody holds it. One project, one window still holds:
a project held by a window other than the named one is refused with the
holder named.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging, app
from agent_team_backend.mcp_server import server as plan_mcp, wiring as plan_mcp_wiring


class _Window:
    def __init__(self, window_id: str) -> None:
        self.dead = False
        self.window_id = window_id


@pytest.fixture(autouse=True)
def _clean_registry() -> Any:
    agent_messaging._reset_for_test()
    yield
    agent_messaging._reset_for_test()


@pytest.fixture
def windows(monkeypatch: pytest.MonkeyPatch, tmp_path: Any) -> dict[str, Any]:
    """Three windows: w1 (the caller's, alpha), w2 (gamma), w3 (a detached
    group window). Their descriptions and window requests are faked."""
    alpha, beta, gamma = (tmp_path / n for n in ("alpha", "beta", "gamma"))
    for d in (alpha, beta, gamma):
        d.mkdir()
    w1, w2, w3 = _Window("w1"), _Window("w2"), _Window("w3")
    state: dict[str, Any] = {
        "paths": {"alpha": str(alpha), "beta": str(beta), "gamma": str(gamma)},
        "w": {"w1": w1, "w2": w2, "w3": w3},
        "described": {
            w1: {"kind": "main", "workspaces": [str(alpha)]},
            w2: {"kind": "main", "workspaces": [str(gamma)]},
            w3: {"kind": "detached-group", "workspaces": [str(alpha)]},
        },
        "requests": [],
        "adopt": {"ok": True, "result": {"prepared": "adopted"}, "error": None},
        "events": [],
    }
    agent_messaging.register("pa", "lead", str(alpha), agent_key="claude", owner=w1)

    async def describe(_caller: Any) -> list[tuple[Any, dict[str, Any] | None]]:
        return [(s, {"ok": True, "result": d}) for s, d in state["described"].items()]

    async def request(session: Any, action: str, args: Any, _caller: Any, **_kw: Any) -> dict[str, Any] | None:
        state["requests"].append((session.window_id, action, args))
        return state["adopt"] if action == "ui.workspace.adopt" else {"ok": True, "result": {}, "error": None}

    async def broadcast(event: dict[str, Any], **_kw: Any) -> None:
        state["events"].append(event)

    async def ready(_path: str) -> bool:
        return True

    async def probe(_path: str, _timeout: float) -> bool:
        return False

    async def ui_request(workspace_path: str, op: str, **kwargs: Any) -> dict[str, Any]:
        state["requests"].append(("global" if kwargs.get("is_global") else "caller", kwargs.get("action"), kwargs.get("args")))
        return {"ok": True, "result": {}, "error": None}

    monkeypatch.setattr(plan_mcp, "_describe_windows", describe)
    monkeypatch.setattr(plan_mcp, "_window_request", request)
    monkeypatch.setattr(plan_mcp, "_window_session", lambda wid: state["w"].get(wid))
    monkeypatch.setattr(plan_mcp, "_wait_window_ready", ready)
    monkeypatch.setattr(plan_mcp, "_probe_window", probe)
    monkeypatch.setattr(plan_mcp, "_ui_request", ui_request)
    monkeypatch.setattr(app, "broadcast", broadcast)
    return state


def _ctx(pane_id: str = "pa") -> Any:
    params = {"pane": pane_id, "t": plan_mcp_wiring.caller_token(pane_id)}
    return SimpleNamespace(request_context=SimpleNamespace(request=SimpleNamespace(query_params=params)))


async def _open(state: dict[str, Any], workspace: str, owner_id: str = "w2", **kwargs: Any) -> dict[str, Any]:
    async def window() -> None:
        for _ in range(400):
            keys = list(plan_mcp._pending_spawns)
            if keys:
                agent_messaging.register("child-1", "reviewer", workspace, owner=state["w"][owner_id])
                plan_mcp.resolve_spawn(keys[0], {"ok": True, "pane_id": "child-1", "name": "reviewer"})
                plan_mcp.resolve_kickoff(keys[0], {"pane_id": "child-1", "kickoff": "sent"})
                return
            await asyncio.sleep(0.005)

    task = asyncio.create_task(window())
    try:
        return await plan_mcp.cli_open_agent(
            ctx=_ctx(), agent="claude", name="reviewer", task="go", workspace_path=workspace, **kwargs
        )
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


def _spawned(state: dict[str, Any]) -> bool:
    return any(e.get("type") == "agent_spawn.request" for e in state["events"])


@pytest.mark.asyncio
async def test_existing_opens_in_the_window_already_holding_the_project(windows: dict[str, Any]) -> None:
    result = await _open(windows, windows["paths"]["gamma"], window="existing")

    assert result["ok"] is True
    assert result["prepared"] == "already-open"
    assert result["window_id"] == "w2"
    assert result["parent"] == "alpha/lead"
    assert not any(a == "ui.workspace.adopt" for _w, a, _x in windows["requests"])


@pytest.mark.asyncio
async def test_existing_with_the_holders_id_opens_there(windows: dict[str, Any]) -> None:
    result = await _open(windows, windows["paths"]["gamma"], window="existing", window_id="w2")

    assert result["ok"] is True and result["prepared"] == "already-open"


@pytest.mark.asyncio
async def test_existing_with_another_windows_id_is_refused_naming_the_holder(windows: dict[str, Any]) -> None:
    result = await plan_mcp.cli_open_agent(
        ctx=_ctx(), agent="claude", name="reviewer", task="go",
        workspace_path=windows["paths"]["gamma"], window="existing", window_id="w1",
    )

    assert result["ok"] is False and result["error_code"] == "workspace-in-other-window"
    assert result["holding_window_id"] == "w2"
    assert not _spawned(windows)


@pytest.mark.asyncio
async def test_existing_with_an_id_adopts_a_project_nobody_holds(windows: dict[str, Any]) -> None:
    result = await _open(windows, windows["paths"]["beta"], window="existing", window_id="w2")

    assert result["ok"] is True and result["prepared"] == "adopted"
    assert ("w2", "ui.workspace.adopt", {"path": windows["paths"]["beta"]}) in windows["requests"]


@pytest.mark.asyncio
async def test_existing_without_an_id_opens_a_new_window_for_a_project_nobody_holds(windows: dict[str, Any]) -> None:
    result = await _open(windows, windows["paths"]["beta"], window="existing")

    assert result["ok"] is True and result["prepared"] == "new-window"
    assert ("global", "ui.workspace.open", {"path": windows["paths"]["beta"], "background": True}) in windows["requests"]


@pytest.mark.asyncio
async def test_a_detached_group_window_cannot_take_a_project(windows: dict[str, Any]) -> None:
    result = await plan_mcp.cli_open_agent(
        ctx=_ctx(), agent="claude", name="reviewer", task="go",
        workspace_path=windows["paths"]["beta"], window="existing", window_id="w3",
    )

    assert result["ok"] is False and result["error_code"] == "window-cannot-hold"
    assert not _spawned(windows)


@pytest.mark.asyncio
@pytest.mark.parametrize("window_id, code", [("w-gone", "unknown-window"), ("laptop/w2", "spawn-local-only")])
async def test_existing_with_a_bad_window_id(windows: dict[str, Any], window_id: str, code: str) -> None:
    result = await plan_mcp.cli_open_agent(
        ctx=_ctx(), agent="claude", name="reviewer", task="go",
        workspace_path=windows["paths"]["beta"], window="existing", window_id=window_id,
    )

    assert result["ok"] is False and result["error_code"] == code


@pytest.mark.asyncio
async def test_window_id_without_existing_is_refused(windows: dict[str, Any]) -> None:
    result = await plan_mcp.cli_open_agent(
        ctx=_ctx(), agent="claude", name="reviewer", task="go",
        workspace_path=windows["paths"]["beta"], window="new", window_id="w2",
    )

    assert result["ok"] is False and result["error_code"] == "invalid-window"


@pytest.mark.asyncio
async def test_existing_recognises_a_held_project_under_another_spelling(windows: dict[str, Any], tmp_path: Any) -> None:
    # Same folder, other spelling (a symlink): one project, one window, so it
    # is the one w2 holds, compared by folder identity like S2's checks.
    link = tmp_path / "gamma-link"
    link.symlink_to(windows["paths"]["gamma"])

    result = await _open(windows, str(link), window="existing", window_id="w2")

    assert result["ok"] is True and result["prepared"] == "already-open"
    assert not any(a == "ui.workspace.adopt" for _w, a, _x in windows["requests"])


@pytest.mark.asyncio
async def test_existing_refuses_another_windows_id_for_a_held_project_under_another_spelling(
    windows: dict[str, Any], tmp_path: Any
) -> None:
    link = tmp_path / "gamma-link"
    link.symlink_to(windows["paths"]["gamma"])

    result = await plan_mcp.cli_open_agent(
        ctx=_ctx(), agent="claude", name="reviewer", task="go",
        workspace_path=str(link), window="existing", window_id="w1",
    )

    assert result["ok"] is False and result["error_code"] == "workspace-in-other-window"
    assert result["holding_window_id"] == "w2"

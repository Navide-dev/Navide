"""cli_open_agent(workspace_path=...) from a pane: a child in another project.

A pane caller's workspace_path used to be ignored, so the child always opened
in the caller's own project. Now it is honoured: the child starts in the named
project, the caller stays its parent, and the caller chooses the window —
"current" (its own window takes the project in the background) or "new".
A project already held by a different window is refused with that window
named, never duplicated and never silently redirected.

Omitting workspace_path, or naming the caller's own workspace however it is
spelled, must leave the spawn request exactly as it was.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging, app
from agent_team_backend.mcp_server import server as plan_mcp, wiring as plan_mcp_wiring


@pytest.fixture(autouse=True)
def _clean_registry() -> Any:
    agent_messaging._reset_for_test()
    yield
    agent_messaging._reset_for_test()


class _Window:
    def __init__(self, window_id: str) -> None:
        self.dead = False
        self.window_id = window_id


@pytest.fixture
def captured(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []

    async def fake_broadcast(event: dict[str, Any], **_kwargs: Any) -> None:
        events.append(event)

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    return events


@pytest.fixture
def ui(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Stands in for the windows: records every UI request and answers it with
    whatever the test put in `answers[action]`."""
    state: dict[str, Any] = {"requests": [], "answers": {}, "held": set(), "ready": True}

    async def fake_ui_request(workspace_path: str, op: str, **kwargs: Any) -> dict[str, Any]:
        state["requests"].append({"workspace_path": workspace_path, "op": op, **kwargs})
        return state["answers"].get(kwargs.get("action"), {"ok": True, "result": {}, "error": None})

    async def fake_probe(workspace_path: str, timeout: float) -> bool:
        return plan_mcp._norm_workspace(workspace_path) in state["held"]

    async def fake_ready(workspace_path: str) -> bool:
        return state["ready"]

    monkeypatch.setattr(plan_mcp, "_ui_request", fake_ui_request)
    monkeypatch.setattr(plan_mcp, "_probe_window", fake_probe)
    monkeypatch.setattr(plan_mcp, "_wait_window_ready", fake_ready)
    return state


@pytest.fixture
def projects(tmp_path: Any) -> dict[str, str]:
    alpha = tmp_path / "alpha"
    beta = tmp_path / "beta"
    alpha.mkdir()
    beta.mkdir()
    agent_messaging.register("pa", "lead", str(alpha), agent_key="claude", owner=_Window("w1"))
    return {"alpha": str(alpha), "beta": str(beta), "root": str(tmp_path)}


def _ctx(pane_id: str = "pa") -> Any:
    params = {"pane": pane_id, "t": plan_mcp_wiring.caller_token(pane_id)}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


async def _run_open(child_workspace: str = "", **kwargs: Any) -> dict[str, Any]:
    """cli_open_agent with a window that answers both verdicts."""

    async def window() -> None:
        for _ in range(400):
            keys = list(plan_mcp._pending_spawns)
            if keys:
                agent_messaging.register(
                    "child-1", "reviewer", child_workspace or "/ws", owner=_Window("w1")
                )
                plan_mcp.resolve_spawn(keys[0], {"ok": True, "pane_id": "child-1", "name": "reviewer"})
                plan_mcp.resolve_kickoff(keys[0], {"pane_id": "child-1", "kickoff": "sent"})
                return
            await asyncio.sleep(0.005)

    task = asyncio.create_task(window())
    try:
        return await plan_mcp.cli_open_agent(ctx=_ctx(), agent="claude", name="reviewer", task="go", **kwargs)
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


def _spawn_payload(captured: list[dict[str, Any]]) -> dict[str, Any]:
    for event in captured:
        if event.get("type") == "agent_spawn.request":
            return event["payload"]
    raise AssertionError("no agent_spawn.request was broadcast")


def _without_request_id(payload: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in payload.items() if k != "request_id"}


# ── RULE ZERO: own workspace = the old path ─────────────────────────────────


@pytest.mark.asyncio
async def test_naming_your_own_workspace_sends_the_same_request_as_omitting_it(
    captured: list[dict[str, Any]], ui: dict[str, Any], projects: dict[str, str]
) -> None:
    omitted = await _run_open()
    baseline = _without_request_id(_spawn_payload(captured))
    captured.clear()
    agent_messaging._PANES.pop("child-1", None)
    for spelling in (projects["alpha"], projects["alpha"] + "/"):
        named = await _run_open(workspace_path=spelling)
        assert _without_request_id(_spawn_payload(captured)) == baseline, spelling
        assert named.keys() == omitted.keys(), spelling
        captured.clear()
        agent_messaging._PANES.pop("child-1", None)
    assert ui["requests"] == []


@pytest.mark.asyncio
async def test_an_ordinary_spawn_carries_none_of_the_new_keys(
    captured: list[dict[str, Any]], ui: dict[str, Any], projects: dict[str, str]
) -> None:
    result = await _run_open()
    payload = _spawn_payload(captured)
    for key in ("cross_workspace", "target_workspace", "parent_address"):
        assert key not in payload
    for key in ("workspace_path", "prepared", "parent", "window_id"):
        assert key not in result


# ── refusals ─────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_project_that_does_not_exist_is_refused_before_anything_opens(
    captured: list[dict[str, Any]], ui: dict[str, Any], projects: dict[str, str]
) -> None:
    result = await _run_open(workspace_path=projects["root"] + "/nope")
    assert result["ok"] is False
    assert result["error_code"] == "workspace-not-found"
    assert captured == [] and ui["requests"] == []


@pytest.mark.asyncio
async def test_an_unknown_window_choice_is_refused(
    captured: list[dict[str, Any]], ui: dict[str, Any], projects: dict[str, str]
) -> None:
    result = await _run_open(workspace_path=projects["beta"], window="somewhere")
    assert result["error_code"] == "invalid-window"
    assert captured == []


@pytest.mark.asyncio
async def test_current_refuses_a_project_another_window_holds_and_names_it(
    captured: list[dict[str, Any]], ui: dict[str, Any], projects: dict[str, str]
) -> None:
    agent_messaging.register("pz", "other", projects["beta"], owner=_Window("w2"))
    ui["answers"]["ui.workspace.adopt"] = {
        "ok": False,
        "result": None,
        "error": "workspace-in-other-window: Navide — beta",
    }
    result = await _run_open(workspace_path=projects["beta"])
    assert result["ok"] is False
    assert result["error_code"] == "workspace-in-other-window"
    assert result["holding_window_id"] == "w2"
    assert captured == []


@pytest.mark.asyncio
async def test_new_refuses_a_project_some_window_already_holds(
    captured: list[dict[str, Any]], ui: dict[str, Any], projects: dict[str, str]
) -> None:
    ui["held"].add(plan_mcp._norm_workspace(projects["beta"]))
    result = await _run_open(workspace_path=projects["beta"], window="new")
    assert result["error_code"] == "workspace-in-other-window"
    assert captured == []


# ── current: the caller's own window takes the project in the background ────


@pytest.mark.asyncio
async def test_current_adopts_in_the_callers_window_and_parents_the_child_on_the_caller(
    captured: list[dict[str, Any]], ui: dict[str, Any], projects: dict[str, str]
) -> None:
    ui["answers"]["ui.workspace.adopt"] = {"ok": True, "result": {"prepared": "adopted"}, "error": None}
    result = await _run_open(child_workspace=projects["beta"], workspace_path=projects["beta"])

    adopt = ui["requests"][0]
    assert adopt["action"] == "ui.workspace.adopt"
    assert adopt["args"] == {"path": projects["beta"]}
    assert adopt["caller"].pane_id == "pa"
    payload = _spawn_payload(captured)
    assert payload["cross_workspace"] is True
    assert payload["requester_pane_id"] == "pa"
    assert payload["target_workspace"] == projects["beta"]
    assert payload["parent_address"] == "alpha/lead"
    assert result["ok"] is True
    assert result["workspace_path"] == projects["beta"]
    assert result["prepared"] == "adopted"
    assert result["parent"] == "alpha/lead"
    assert result["window_id"] == "w1"
    assert result["address"] == "beta/reviewer"


@pytest.mark.asyncio
async def test_a_tilde_path_is_expanded_before_it_is_used(
    captured: list[dict[str, Any]], ui: dict[str, Any], projects: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HOME", projects["root"])
    ui["answers"]["ui.workspace.adopt"] = {"ok": True, "result": {"prepared": "already-open"}, "error": None}
    await _run_open(child_workspace=projects["beta"], workspace_path="~/beta")
    assert _spawn_payload(captured)["target_workspace"] == projects["beta"]


@pytest.mark.asyncio
async def test_a_window_that_never_comes_ready_opens_nothing_and_says_what_was_prepared(
    captured: list[dict[str, Any]], ui: dict[str, Any], projects: dict[str, str]
) -> None:
    ui["answers"]["ui.workspace.adopt"] = {"ok": True, "result": {"prepared": "adopted"}, "error": None}
    ui["ready"] = False
    result = await _run_open(workspace_path=projects["beta"])
    assert result["error_code"] == "window_not_ready"
    assert result["prepared"] == "adopted"
    assert captured == []


# ── new: a window of its own, opened without taking focus ───────────────────


@pytest.mark.asyncio
async def test_new_opens_a_background_window_for_the_project(
    captured: list[dict[str, Any]], ui: dict[str, Any], projects: dict[str, str]
) -> None:
    result = await _run_open(child_workspace=projects["beta"], workspace_path=projects["beta"], window="new")
    opened = ui["requests"][0]
    assert opened["action"] == "ui.workspace.open"
    assert opened["args"] == {"path": projects["beta"], "background": True}
    assert opened["is_global"] is True
    assert result["prepared"] == "new-window"
    assert _spawn_payload(captured)["cross_workspace"] is True


@pytest.mark.asyncio
async def test_a_group_is_checked_against_the_target_project_before_anything_is_prepared(
    captured: list[dict[str, Any]], ui: dict[str, Any], projects: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    beta = projects["beta"]
    monkeypatch.setattr(
        app.project_store, "peek",
        lambda path: SimpleNamespace(ui_run_groups=[{"id": "rg-beta"}]) if path == beta else None,
    )
    refused = await _run_open(workspace_path=beta, run_group_id="rg-alpha")
    assert refused["error_code"] == "unknown-run-group"
    assert ui["requests"] == [] and captured == []
    ui["answers"]["ui.workspace.adopt"] = {"ok": True, "result": {"prepared": "adopted"}, "error": None}
    accepted = await _run_open(child_workspace=beta, workspace_path=beta, run_group_id="rg-beta")
    assert accepted["ok"] is True
    assert _spawn_payload(captured)["run_group_id"] == "rg-beta"

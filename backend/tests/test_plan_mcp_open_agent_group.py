"""Explicit tab placement when opening a pane, without changing old defaults."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest

from agent_team_backend import agent_messaging, app
from agent_team_backend.mcp_server import auth, server as plan_mcp, wiring


def _ctx(*, host: bool = False) -> Any:
    params = (
        {"client": "host", "t": auth.internal_token()}
        if host else {"pane": "parent", "t": wiring.caller_token()}
    )
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


@pytest.fixture
def window(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    agent_messaging._reset_for_test()
    agent_messaging.register("parent", "lead", "/alpha", agent_key="codex")
    projects = {
        "/alpha": SimpleNamespace(ui_run_groups=[{"id": "rg-alpha"}]),
        "/beta": SimpleNamespace(ui_run_groups=[{"id": "rg-beta"}]),
    }
    monkeypatch.setattr(app.project_store, "peek", lambda path: projects.get(path))
    monkeypatch.setattr(app, "_session_exists", lambda *_args: True)
    monkeypatch.setattr(plan_mcp, "_resume_lineage", lambda *_args: {
        "spawned_by": "original-parent", "run_group_id": "rg-original",
    })
    events: list[dict[str, Any]] = []

    async def broadcast(event: dict[str, Any], **_kwargs: Any) -> None:
        payload = event["payload"]
        if event["type"] == "ui.invoke.request":
            plan_mcp.resolve_ui_invoke(payload["request_id"], {"ok": True, "result": [], "error": None})
            return
        events.append(event)
        plan_mcp.resolve_spawn(payload["request_id"], {
            "ok": True, "pane_id": "child", "name": "worker",
        })
        plan_mcp.resolve_kickoff(payload["request_id"], {"kickoff": "sent"})

    monkeypatch.setattr(app, "broadcast", broadcast)
    yield events
    agent_messaging._reset_for_test()


async def _open(**kwargs: Any) -> dict[str, Any]:
    return await plan_mcp.cli_open_agent(
        "codex", "worker", "review", kwargs.pop("ctx", _ctx()), **kwargs,
    )


@pytest.mark.asyncio
async def test_group_is_optional_in_the_mcp_schema() -> None:
    tool = next(t for t in await plan_mcp.server.list_tools() if t.name == "cli_open_agent")
    assert "run_group_id" in tool.inputSchema["properties"]
    assert "run_group_id" not in tool.inputSchema.get("required", [])
    group = tool.inputSchema["properties"]["run_group_id"]
    assert {"type": "string"} in group["anyOf"]
    assert {"type": "null"} in group["anyOf"]
    assert group["default"] is None


@pytest.mark.asyncio
@pytest.mark.parametrize("kwargs", [{}, {"run_group_id": None}])
async def test_omission_and_null_preserve_the_old_request(window: list, kwargs: dict) -> None:
    assert (await _open(**kwargs))["ok"] is True
    assert "run_group_id" not in window[0]["payload"]


@pytest.mark.asyncio
@pytest.mark.parametrize("group", ["", "rg-alpha"])
async def test_group_reaches_the_window_including_empty(window: list, group: str) -> None:
    result = await _open(run_group_id=group)
    assert result["ok"] is True
    assert window[0]["payload"]["run_group_id"] == group
    assert result["run_group_id"] == group


@pytest.mark.asyncio
async def test_pane_group_is_validated_in_its_own_workspace(window: list) -> None:
    result = await _open(run_group_id="rg-alpha", workspace_path="/beta")
    assert result["ok"] is True
    assert window[0]["payload"]["requester_pane_id"] == "parent"
    assert "target_workspace" not in window[0]["payload"]


@pytest.mark.asyncio
@pytest.mark.parametrize("group", ["rg-missing", "rg-beta", " ", " rg-alpha "])
async def test_invalid_or_foreign_group_never_dispatches(window: list, group: str) -> None:
    result = await _open(run_group_id=group, workspace_path="/beta")
    assert result["ok"] is False
    assert result["error_code"] == "unknown-run-group"
    assert window == []
    assert plan_mcp._pending_spawns == {}
    assert plan_mcp._pending_kickoffs == {}


@pytest.mark.asyncio
async def test_host_uses_the_requested_workspace(window: list) -> None:
    result = await _open(ctx=_ctx(host=True), workspace_path="/beta", run_group_id="rg-beta")
    assert result["ok"] is True
    assert window[0]["payload"]["target_workspace"] == "/beta"
    assert window[0]["payload"]["run_group_id"] == "rg-beta"


@pytest.mark.asyncio
@pytest.mark.parametrize("workspace,group", [("/beta", "rg-alpha"), ("/unknown", "rg-alpha")])
async def test_host_refuses_groups_outside_the_target(window: list, workspace: str, group: str) -> None:
    result = await _open(ctx=_ctx(host=True), workspace_path=workspace, run_group_id=group)
    assert result["ok"] is False
    assert result["error_code"] == "unknown-run-group"
    assert window == []


@pytest.mark.asyncio
@pytest.mark.parametrize("group", ["", "rg-alpha"])
async def test_resume_override_changes_only_the_group(window: list, group: str) -> None:
    result = await _open(session_id="session-1", run_group_id=group)
    payload = window[0]["payload"]
    assert payload["session_id"] == "session-1"
    assert payload["resume_spawned_by"] == "original-parent"
    assert payload["run_group_id"] == group
    assert result["restored_lineage"] == {
        "spawned_by": "original-parent", "run_group_id": group,
    }


@pytest.mark.asyncio
@pytest.mark.parametrize("group", ["", "rg-alpha"])
async def test_reopen_with_group_is_refused_before_reopening(
    window: list, monkeypatch: pytest.MonkeyPatch, group: str,
) -> None:
    reopen = AsyncMock(return_value={"ok": True})
    monkeypatch.setattr(plan_mcp, "_reopen_pane", reopen)
    result = await _open(pane_id="existing", run_group_id=group)
    assert result["ok"] is False
    assert result["error_code"] == "conflicting-target"
    assert "cli_place_pane" in result["error"]
    reopen.assert_not_awaited()
    assert window == []


@pytest.mark.asyncio
async def test_reopen_without_group_stays_unchanged(window: list, monkeypatch: pytest.MonkeyPatch) -> None:
    reopen = AsyncMock(return_value={"ok": True, "reopened": True})
    monkeypatch.setattr(plan_mcp, "_reopen_pane", reopen)
    assert await _open(pane_id="existing") == {"ok": True, "reopened": True}
    reopen.assert_awaited_once_with("existing")
    assert window == []

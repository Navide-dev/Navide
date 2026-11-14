"""cli_rename_pane: rename a CLI pane through the window's own rename path.

What these pin: the window is asked (never a backend-only write that would
leave the title stale), the answer carries the name the registry now holds,
a taken name comes back as the window's refusal code, the caller may rename
only itself and the panes it opened in its own workspace, a restore
placeholder is renamable, and a scheduled job still aimed at the old name is
reported but left alone.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging
from agent_team_backend.mcp_server import pane_rename_tool, server as core, wiring


@pytest.fixture(autouse=True)
def _clean_registry() -> Any:
    agent_messaging._reset_for_test()
    yield
    agent_messaging._reset_for_test()


@pytest.fixture(autouse=True)
def jobs(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """The scheduler's job list, empty unless a test adds to it."""
    listed: list[dict[str, Any]] = []

    async def list_jobs() -> list[dict[str, Any]]:
        return listed

    service = SimpleNamespace(store=SimpleNamespace(list_jobs=list_jobs))
    monkeypatch.setattr(core, "_scheduler_service", lambda: service)
    return listed


def _ctx(pane_id: str = "pa") -> Any:
    params = {"pane": pane_id, "t": wiring.caller_token(pane_id)}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


def _seed() -> None:
    agent_messaging.register("pa", "commander", "/ws/alpha", agent_key="claude")
    agent_messaging.register("pc", "child", "/ws/alpha", agent_key="claude", spawned_by="pa", opened_by="pa")
    agent_messaging.register("pg", "grandchild", "/ws/alpha", agent_key="codex", spawned_by="pc", opened_by="pc")
    agent_messaging.register("pu", "users-pane", "/ws/alpha", agent_key="claude")


def _window(monkeypatch: pytest.MonkeyPatch, reply: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """A window that renames like the renderer: it re-mirrors the handle to the
    registry, then answers with the handle it applied."""
    calls: list[dict[str, Any]] = []

    async def fake(workspace_path: str, op: str, **kwargs: Any) -> dict[str, Any]:
        calls.append({"workspace_path": workspace_path, "op": op, **kwargs})
        if reply is not None:
            return reply
        args = kwargs["args"]
        entry = agent_messaging.current(args["paneId"])
        agent_messaging.register(
            entry.pane_id, args["name"], entry.workspace_path,
            agent_key=entry.agent_key, realized=entry.realized, spawned_by=entry.spawned_by,
            opened_by=entry.opened_by,
        )
        return {"ok": True, "result": {"paneId": entry.pane_id, "oldName": entry.name, "name": args["name"]}}

    monkeypatch.setattr(core, "_ui_request", fake)
    return calls


@pytest.mark.asyncio
async def test_renaming_a_child_goes_through_the_window_and_the_new_name_resolves(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed()
    calls = _window(monkeypatch)

    result = await pane_rename_tool.cli_rename_pane("child", "vm-driver", _ctx())

    assert result == {
        "ok": True,
        "old_name": "child",
        "new_name": "vm-driver",
        "pane_id": "pc",
        "address": "alpha/vm-driver",
    }
    assert [(c["action"], c["args"], c["route_pane_id"]) for c in calls] == [
        ("ui.pane.rename", {"paneId": "pc", "name": "vm-driver"}, "pc")
    ]
    assert agent_messaging.resolve("pa", "vm-driver").pane.pane_id == "pc"
    assert agent_messaging.resolve("pa", "child").pane is None


@pytest.mark.asyncio
async def test_a_grandchild_and_the_caller_itself_may_be_renamed(monkeypatch: pytest.MonkeyPatch) -> None:
    _seed()
    _window(monkeypatch)

    assert (await pane_rename_tool.cli_rename_pane("grandchild", "reviewer", _ctx()))["ok"] is True
    assert (await pane_rename_tool.cli_rename_pane("commander", "lead", _ctx()))["new_name"] == "lead"


@pytest.mark.asyncio
async def test_a_taken_name_is_the_windows_refusal(monkeypatch: pytest.MonkeyPatch) -> None:
    _seed()
    _window(
        monkeypatch,
        {"ok": False, "error": 'ui.pane.rename: "users-pane" is already another pane\'s name', "error_code": "name-taken"},
    )

    result = await pane_rename_tool.cli_rename_pane("child", "users-pane", _ctx())

    assert result["ok"] is False
    assert result["error_code"] == "name-taken"
    assert agent_messaging.current("pc").name == "child"


@pytest.mark.asyncio
async def test_a_pane_the_caller_did_not_open_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    _seed()
    calls = _window(monkeypatch)

    result = await pane_rename_tool.cli_rename_pane("users-pane", "mine-now", _ctx())

    assert result["ok"] is False
    assert result["error_code"] == "rename-not-permitted"
    assert calls == []


@pytest.mark.asyncio
async def test_a_pane_in_another_workspace_is_refused_even_when_the_caller_opened_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed()
    agent_messaging.register("px", "far-child", "/ws/beta", agent_key="claude", spawned_by="pa", opened_by="pa")
    calls = _window(monkeypatch)

    result = await pane_rename_tool.cli_rename_pane("beta/far-child", "renamed", _ctx())

    assert result["ok"] is False
    assert result["error_code"] == "rename-not-permitted"
    assert calls == []


@pytest.mark.asyncio
async def test_a_restore_placeholder_can_be_renamed(monkeypatch: pytest.MonkeyPatch) -> None:
    _seed()
    agent_messaging.register(
        "pp", "parked", "/ws/alpha", agent_key="claude", realized=False, spawned_by="pa", opened_by="pa"
    )
    _window(monkeypatch)

    result = await pane_rename_tool.cli_rename_pane("", "awake", _ctx(), pane_id="pp")

    assert result["ok"] is True
    assert agent_messaging.current("pp").name == "awake"
    assert agent_messaging.current("pp").realized is False


@pytest.mark.asyncio
async def test_a_scheduled_job_on_the_old_name_is_reported_not_rewritten(
    monkeypatch: pytest.MonkeyPatch, jobs: list[dict[str, Any]]
) -> None:
    _seed()
    _window(monkeypatch)
    aimed = {"id": "job-1", "action": {"kind": "send", "workspace": "/ws/alpha/", "pane_name": "child", "text": "wake"}}
    elsewhere = {"id": "job-2", "action": {"kind": "send", "workspace": "/ws/beta", "pane_name": "child", "text": "x"}}
    jobs.extend([aimed, elsewhere])

    result = await pane_rename_tool.cli_rename_pane("child", "vm-driver", _ctx())

    assert result["warnings"] == ["scheduler job job-1 still targets old name"]
    assert aimed["action"]["pane_name"] == "child"


@pytest.mark.asyncio
async def test_adopting_a_pane_with_place_does_not_make_it_renamable(monkeypatch: pytest.MonkeyPatch) -> None:
    """cli_place_pane may hang any pane of the workspace under the caller; that
    moves spawned_by, not who opened it, so the rename is still refused."""
    _seed()
    calls = _window(monkeypatch)
    # What cli_place_pane(target="users-pane", spawned_by="pa") leaves behind.
    agent_messaging.register("pu", "users-pane", "/ws/alpha", agent_key="claude", spawned_by="pa")

    result = await pane_rename_tool.cli_rename_pane("users-pane", "mine-now", _ctx())

    assert result["error_code"] == "rename-not-permitted"
    assert calls == []


@pytest.mark.asyncio
async def test_a_pane_recorded_before_opened_by_can_rename_only_itself(monkeypatch: pytest.MonkeyPatch) -> None:
    """No opened_by means nobody opened it: no fallback to spawned_by."""
    _seed()
    agent_messaging.register("po", "old-child", "/ws/alpha", agent_key="claude", spawned_by="pa")
    _window(monkeypatch)

    refused = await pane_rename_tool.cli_rename_pane("old-child", "renamed", _ctx())
    itself = await pane_rename_tool.cli_rename_pane("old-child", "renamed", _ctx("po"))

    assert refused["error_code"] == "rename-not-permitted"
    assert itself["ok"] is True


def test_ui_invoke_cannot_reach_the_rename_action_around_the_tool() -> None:
    assert core._DEDICATED_CLOSE_ACTIONS["ui.pane.rename"] == "cli_rename_pane"

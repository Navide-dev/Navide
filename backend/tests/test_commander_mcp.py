"""The commander MCP surface (0.2.51, plan bot_48c8f6 section C): cli_open_agent
records dispatches through the opened_by chain, cli_whoami names the commander,
commander_list / get / tree are read-only and workspace-scoped, and only a
commander's own pane writes its memory."""

from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging, app, commander_service
from agent_team_backend.commander_service import CommanderService
from agent_team_backend.commander_store import CommanderStore
from agent_team_backend.db import Database
from agent_team_backend.mcp_server import commander_tools
from agent_team_backend.mcp_server import server as plan_mcp
from agent_team_backend.mcp_server import wiring as plan_mcp_wiring

pytestmark = pytest.mark.asyncio


def _fake_token() -> str:
    # Built at runtime so no credential-shaped literal sits in the repo.
    return "gh" + "p_" + "Ab1" * 12


@pytest.fixture(autouse=True)
def svc(tmp_path: Path) -> Any:
    agent_messaging._reset_for_test()
    service = CommanderService(
        CommanderStore(Database(tmp_path / "navide.db"), memory_root=tmp_path / "commanders"),
        pane=agent_messaging.current,
        activity=lambda _pane_id: None,
        reported=lambda *_args: False,
    )
    commander_service.configure(service)
    yield service
    commander_service.configure(None)
    agent_messaging._reset_for_test()


@pytest.fixture
def captured(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []

    async def fake_broadcast(event: dict[str, Any], **_kwargs: Any) -> None:
        events.append(event)

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    return events


def _ctx(pane_id: str) -> Any:
    params = {"pane": pane_id, "t": plan_mcp_wiring.caller_token(pane_id)}
    return SimpleNamespace(request_context=SimpleNamespace(request=SimpleNamespace(query_params=params)))


def _commander(svc: CommanderService, pane_id: str = "boss", name: str = "Lead", workspace: str = "/ws/alpha") -> Any:
    agent_messaging.register(pane_id, name.lower(), workspace, agent_key="claude")
    return svc.create(
        {"name": name, "workspaces": [workspace], "agent_key": "claude", "duty": "run the release",
         "account_id": "acct-123"},
        pane=SimpleNamespace(pane_id=pane_id, workspace_path=workspace, agent_key="claude"),
        session_id="sess-xyz",
    )


async def _open(opener: str, child: str, task: str = "review the PR") -> dict[str, Any]:
    async def answer() -> None:
        for _ in range(400):
            keys = list(plan_mcp._pending_spawns)
            if keys:
                agent_messaging.register(child, child, "/ws/alpha", opened_by=opener, spawned_by=opener)
                plan_mcp.resolve_spawn(keys[0], {"ok": True, "pane_id": child, "name": child})
                plan_mcp.resolve_kickoff(keys[0], {"pane_id": child, "kickoff": "sent"})
                return
            await asyncio.sleep(0.005)

    waiter = asyncio.create_task(answer())
    result = await plan_mcp.cli_open_agent("codex", child, task, _ctx(opener))
    await waiter
    return result


# ── cli_open_agent → commander_dispatches ──────────────────────────────────


async def test_open_agent_from_a_commander_records_a_dispatch(svc: CommanderService, captured: Any) -> None:
    c = _commander(svc)
    result = await _open("boss", "w1")
    assert result["ok"] is True
    [d] = svc.store.dispatches(c.id)
    assert (d.pane_id, d.opened_by, d.task) == ("w1", "boss", "review the PR")


async def test_a_grandchild_is_recorded_with_its_direct_opener(svc: CommanderService, captured: Any) -> None:
    c = _commander(svc)
    await _open("boss", "w1")
    await _open("w1", "w2")
    assert [(d.pane_id, d.opened_by) for d in svc.store.dispatches(c.id)] == [("w1", "boss"), ("w2", "w1")]


async def test_an_opened_by_ancestor_counts_even_without_a_dispatch_row(svc: CommanderService, captured: Any) -> None:
    """A pane the commander's body opened before any dispatch was recorded
    (opened before the upgrade): its child is still the commander's work."""
    c = _commander(svc)
    agent_messaging.register("old", "old", "/ws/alpha", opened_by="boss")
    await _open("old", "w3")
    [d] = svc.store.dispatches(c.id)
    assert (d.pane_id, d.opened_by) == ("w3", "old")


async def test_open_agent_from_an_ordinary_pane_records_nothing(svc: CommanderService, captured: Any) -> None:
    c = _commander(svc)
    agent_messaging.register("plain", "plain", "/ws/alpha")
    result = await _open("plain", "w1")
    assert result["ok"] is True
    assert svc.store.dispatches(c.id) == []


async def test_a_key_in_the_kickoff_is_not_stored(svc: CommanderService, captured: Any) -> None:
    c = _commander(svc)
    token = _fake_token()
    await _open("boss", "w1", f"deploy with {token} please")
    [d] = svc.store.dispatches(c.id)
    assert token not in d.task


async def test_a_failing_store_never_fails_the_spawn(
    svc: CommanderService, captured: Any, monkeypatch: pytest.MonkeyPatch,
) -> None:
    _commander(svc)

    def boom(*_a: Any, **_k: Any) -> None:
        raise RuntimeError("db gone")

    monkeypatch.setattr(svc, "note_open", boom)
    result = await _open("boss", "w1")
    assert result["ok"] is True and result["kickoff"] == "sent"


# ── cli_whoami ─────────────────────────────────────────────────────────────


async def test_whoami_names_the_commander_and_the_dispatcher(svc: CommanderService, captured: Any) -> None:
    c = _commander(svc)
    await _open("boss", "w1")
    await _open("w1", "w2")

    assert (await plan_mcp.cli_whoami(_ctx("boss")))["commander"] == {"id": c.id, "name": "Lead", "role": "commander"}
    worker = (await plan_mcp.cli_whoami(_ctx("w2")))["commander"]
    assert worker["role"] == "worker" and worker["id"] == c.id
    assert worker["dispatched_by"] == {"pane_id": "w1", "name": "w1", "address": agent_messaging.get("w1").qualified_name}


async def test_whoami_dispatcher_gone(svc: CommanderService, captured: Any) -> None:
    _commander(svc)
    await _open("boss", "w1")
    await _open("w1", "w2")
    agent_messaging.unregister("w1")
    worker = (await plan_mcp.cli_whoami(_ctx("w2")))["commander"]
    assert worker["dispatched_by"] == {"pane_id": "w1", "gone": True}


async def test_whoami_has_no_commander_key_for_an_ordinary_pane(svc: CommanderService) -> None:
    agent_messaging.register("plain", "plain", "/ws/alpha")
    assert "commander" not in await plan_mcp.cli_whoami(_ctx("plain"))


# ── commander_list / get / tree ────────────────────────────────────────────


async def test_list_and_get_in_the_same_workspace_are_full_and_hold_no_credential(svc: CommanderService) -> None:
    c = _commander(svc)
    listed = await commander_tools.commander_list(_ctx("boss"))
    [row] = listed["commanders"]
    assert row["visibility"] == "full" and row["duty"] == "run the release"
    assert row["body"]["pane_id"] == "boss" and row["body"]["live"] is True
    got = (await commander_tools.commander_get("Lead", _ctx("boss")))["commander"]
    assert got == row
    text = repr(listed)
    assert "acct-123" not in text and "sess-xyz" not in text and "account_id" not in text
    assert (await commander_tools.commander_get(c.id, _ctx("boss")))["commander"]["id"] == c.id


async def test_a_pane_in_another_workspace_sees_public_fields_only(svc: CommanderService) -> None:
    c = _commander(svc)
    agent_messaging.register("far", "far", "/ws/beta")
    got = (await commander_tools.commander_get("Lead", _ctx("far")))["commander"]
    assert got == {"id": c.id, "name": "Lead", "icon": "", "color": "", "visibility": "public"}
    assert (await commander_tools.commander_list(_ctx("far")))["commanders"] == [got]
    tree = await commander_tools.commander_tree("Lead", _ctx("far"))
    assert tree["ok"] is False and tree["error_code"] == "commander-other-workspace"


async def test_get_unknown(svc: CommanderService) -> None:
    agent_messaging.register("plain", "plain", "/ws/alpha")
    got = await commander_tools.commander_get("nobody", _ctx("plain"))
    assert got["ok"] is False and got["error_code"] == "commander-not-found"


async def test_tree_shows_the_dispatches_with_states(svc: CommanderService, captured: Any) -> None:
    _commander(svc)
    await _open("boss", "w1")
    await _open("w1", "w2")
    tree = await commander_tools.commander_tree("Lead", _ctx("w2"))
    assert tree["ok"] is True
    root = tree["root"]
    assert root["pane_id"] == "boss"
    [w1] = root["children"]
    [w2] = w1["children"]
    assert (w1["pane_id"], w2["pane_id"], w2["opened_by"]) == ("w1", "w2", "w1")
    assert w2["state"] in commander_service.STATES


# ── commander_memory_append ────────────────────────────────────────────────


async def test_only_the_commander_pane_appends_its_own_memory(svc: CommanderService, captured: Any) -> None:
    c = _commander(svc)
    await _open("boss", "w1")
    ok = await commander_tools.commander_memory_append("the user owns releases", _ctx("boss"))
    assert ok["ok"] is True and ok["commander_id"] == c.id and "repo" in ok["reminder"]
    assert "the user owns releases" in svc.store.read_memory(c.id)

    refused = await commander_tools.commander_memory_append("sneaky", _ctx("w1"))
    assert refused["ok"] is False and refused["error_code"] == "not-a-commander"
    assert "sneaky" not in svc.store.read_memory(c.id)


async def test_memory_append_masks_a_key_and_refuses_empty(svc: CommanderService) -> None:
    c = _commander(svc)
    token = _fake_token()
    assert (await commander_tools.commander_memory_append(f"key {token}", _ctx("boss")))["ok"] is True
    assert token not in svc.store.read_memory(c.id)
    assert (await commander_tools.commander_memory_append("  ", _ctx("boss")))["ok"] is False

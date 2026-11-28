"""Two gaps found by the mcp branch: a commander body whose pane id changed
is still found by its new id before anything re-keyed the store, and a pane
opened by a bare-line SPAWN block is recorded as a dispatch, once."""

from __future__ import annotations

from typing import Any

import pytest

from agent_team_backend import app as app_module
from agent_team_backend import commander_service, ws_handlers

from .commander_fakes import World, pane, service


def rekey(world: World, old: str, new: str) -> None:
    world.panes[new] = world.panes.pop(old)
    world.panes[new].pane_id = new
    world.aliases[old] = new


def test_role_of_finds_a_body_by_its_new_pane_id(tmp_path):
    world = World()
    svc = service(tmp_path, world)
    c = svc.create({"name": "C"}, pane=world.add(pane("old", "Boss")))
    rekey(world, "old", "new")
    assert svc.role_of("new") == {"id": c.id, "name": "C", "role": "commander"}
    assert svc.commander_of("new") == c.id
    # The store followed the hop, so the old id is history now.
    assert svc.store.current_body(c.id).pane_id == "new"


def test_role_of_finds_a_worker_by_its_new_pane_id(tmp_path):
    world = World()
    svc = service(tmp_path, world)
    c = svc.create({"name": "C"}, pane=world.add(pane("boss", "Boss")))
    world.add(pane("kid", "Kid"))
    svc.note_open("boss", "kid")
    rekey(world, "kid", "kid2")
    role = svc.role_of("kid2")
    assert role is not None and role["id"] == c.id and role["role"] == "worker"


def test_note_open_from_a_rekeyed_body(tmp_path):
    world = World()
    svc = service(tmp_path, world)
    c = svc.create({"name": "C"}, pane=world.add(pane("old", "Boss")))
    rekey(world, "old", "new")
    assert svc.note_open("new", "kid") is not None
    assert [d.pane_id for d in svc.store.dispatches(c.id)] == ["kid"]


def test_a_second_record_for_the_same_child_fills_the_task_only(tmp_path):
    world = World()
    svc = service(tmp_path, world)
    c = svc.create({"name": "C"}, pane=world.add(pane("boss", "Boss")))
    svc.note_open("boss", "kid", "")
    svc.note_open("boss", "kid", "the task")
    svc.note_open("boss", "kid", "another")
    rows = svc.store.dispatches(c.id)
    assert [(d.pane_id, d.task) for d in rows] == [("kid", "the task")]


class Session:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


@pytest.fixture
def spawn_env(tmp_path, monkeypatch):
    from agent_team_backend.db import Database
    from agent_team_backend.projects import ProjectStore

    monkeypatch.setattr(app_module, "database", Database(tmp_path / "app.db"))
    monkeypatch.setattr(app_module, "project_store", ProjectStore())
    world = World()
    svc = service(tmp_path, world)
    commander_service.configure(svc)
    from agent_team_backend.mcp_server import server as core

    monkeypatch.setattr(core, "agent_messaging_current", world.lookup)
    yield world, svc, tmp_path
    commander_service.configure(None)


async def spawn(workspace: str, **payload: Any) -> dict[str, Any]:
    session = Session()
    body = {"workspace_path": workspace, "agent": "claude", **payload}
    await ws_handlers._REGISTRY["manual_pane.spawn"](session, "id", "manual_pane.spawn", body)
    return session.sent[-1]


async def test_spawn_block_pane_is_recorded_once(spawn_env):
    world, svc, tmp_path = spawn_env
    ws = str(tmp_path / "proj")
    (tmp_path / "proj").mkdir()
    c = svc.create({"name": "C"}, pane=world.add(pane("boss", "Boss")))
    answer = await spawn(ws, pane_id="kid", origin="mcp", opened_by="boss")
    assert answer["ok"] is True
    assert [d.pane_id for d in svc.store.dispatches(c.id)] == ["kid"]
    # cli_open_agent's own hook for the same pane only adds its task.
    from agent_team_backend.mcp_server import commander_tools

    commander_tools.note_dispatch("boss", "kid", "build it")
    assert [(d.pane_id, d.task) for d in svc.store.dispatches(c.id)] == [("kid", "build it")]


async def test_spawn_without_a_commander_or_opener_records_nothing(spawn_env):
    world, svc, tmp_path = spawn_env
    ws = str(tmp_path / "proj")
    (tmp_path / "proj").mkdir()
    c = svc.create({"name": "C"}, pane=world.add(pane("boss", "Boss")))
    await spawn(ws, pane_id="a", origin="manual")
    await spawn(ws, pane_id="b", origin="mcp", opened_by="stranger")
    await spawn(ws, pane_id="c2", previous_pane_id="c1", origin="mcp", opened_by="boss")
    assert svc.store.dispatches(c.id) == []


async def test_a_failing_record_never_fails_the_spawn(spawn_env, monkeypatch):
    world, svc, tmp_path = spawn_env
    ws = str(tmp_path / "proj")
    (tmp_path / "proj").mkdir()

    def boom(*_a: Any, **_k: Any) -> None:
        raise RuntimeError("db gone")

    monkeypatch.setattr(svc, "note_open", boom)
    svc.create({"name": "C"}, pane=world.add(pane("boss", "Boss")))
    answer = await spawn(ws, pane_id="kid", origin="mcp", opened_by="boss")
    assert answer["ok"] is True

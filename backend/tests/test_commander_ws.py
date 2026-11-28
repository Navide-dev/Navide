"""commander.* messages: writes only from a main window; reads and events."""

from __future__ import annotations

from typing import Any

import pytest

from agent_team_backend import app as app_module
from agent_team_backend import commander_service, commander_ws, ws_handlers

from .commander_fakes import World, pane, service


class Session:
    def __init__(self, main: bool) -> None:
        self.navide_window = main
        self.ui_bus_ready = main
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


@pytest.fixture
def env(tmp_path, monkeypatch):
    world = World()
    svc = service(tmp_path, world)
    commander_service.configure(svc)
    events: list[dict[str, Any]] = []

    async def capture(event):
        events.append(event)

    monkeypatch.setattr(app_module, "broadcast_main_windows", capture)
    monkeypatch.setattr(commander_ws.agent_messaging, "current", world.lookup)
    yield world, svc, events
    commander_service.configure(None)


async def call(message: str, *, main: bool = True, **payload: Any) -> dict[str, Any]:
    session = Session(main)
    await commander_ws.HANDLERS[message](session, "id", message, payload)
    return session.sent[-1]


def test_every_message_is_registered():
    for name in commander_ws.HANDLERS:
        assert ws_handlers._REGISTRY[name] is commander_ws.HANDLERS[name]


@pytest.mark.parametrize(("message", "payload"), [
    ("commander.list", {}),
    ("commander.get", {"id": "any"}),
    ("commander.tree", {"id": "any"}),
    ("commander.create", {"name": "X"}),
    ("commander.upgrade_pane", {"pane_id": "p1"}),
    ("commander.downgrade", {"id": "any"}),
    ("commander.update", {"id": "any", "changes": {}}),
    ("commander.archive", {"id": "any"}),
])
async def test_refused_outside_a_main_window(env, message, payload):
    world, svc, events = env
    world.add(pane("p1", "Worker"))
    answer = await call(message, main=False, **payload)
    assert answer["error"]["code"] == "FORBIDDEN"
    assert svc.store.list(include_archived=True) == [] and events == []


async def test_create_list_get_update_archive(env):
    world, svc, events = env
    world.add(pane("p1", "Body"))
    created = await call("commander.create", name="Cmd", duty="d", pane_id="p1")
    summary = created["payload"]["commander"]
    assert summary["name"] == "Cmd" and summary["body"]["pane_id"] == "p1" and summary["body_live"]
    assert events[-1]["type"] == "commander.changed" and events[-1]["payload"]["id"] == summary["id"]
    listed = await call("commander.list")
    assert [c["id"] for c in listed["payload"]["commanders"]] == [summary["id"]]
    got = await call("commander.get", id=summary["id"])
    assert got["payload"]["memory"] == "" and got["payload"]["tree"]["root"]["pane_id"] == "p1"
    tree = await call("commander.tree", id=summary["id"])
    assert tree["payload"]["commander_id"] == summary["id"]
    updated = await call("commander.update", id=summary["id"], changes={"stall_minutes": 30})
    assert updated["payload"]["commander"]["stall_minutes"] == 30
    bad = await call("commander.update", id=summary["id"], changes={"id": "x"})
    assert bad["error"]["code"] == "BAD_REQUEST"
    await call("commander.archive", id=summary["id"])
    assert events[-1]["payload"]["commander"] is None
    assert (await call("commander.list"))["payload"]["commanders"] == []


async def test_upgrade_and_downgrade_over_ws(env):
    world, svc, events = env
    world.add(pane("p1", "Worker"))
    up = await call("commander.upgrade_pane", pane_id="p1")
    cid = up["payload"]["commander"]["id"]
    assert svc.store.commander_of_body("p1") == cid
    again = await call("commander.upgrade_pane", pane_id="p1")
    assert again["error"]["code"] == "BAD_REQUEST"
    down = await call("commander.downgrade", id=cid)
    assert down["payload"] == {"id": cid}
    assert svc.store.commander_of_body("p1") == ""


async def test_errors(env):
    assert (await call("commander.get", id="nope"))["error"]["code"] == "NOT_FOUND"
    assert (await call("commander.create", name="X", pane_id="ghost"))["error"]["code"] == "BAD_REQUEST"
    assert (await call("commander.upgrade_pane"))["error"]["code"] == "BAD_REQUEST"
    assert (await call("commander.update", id="x"))["error"]["code"] == "BAD_REQUEST"

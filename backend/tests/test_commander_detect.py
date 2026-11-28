"""The six detected states, from facts already held elsewhere, on a fake clock."""

from __future__ import annotations

import pytest

from agent_team_backend import commander_service as cs

from .commander_fakes import World, pane, service


@pytest.mark.parametrize(("facts", "state"), [
    ({"registered": False}, cs.GONE),
    ({"display_status": "awaiting", "busy": True}, cs.WAITING),
    ({"busy": True, "activity_age_s": 60}, cs.WORKING),
    ({"busy": True, "activity_age_s": None}, cs.WORKING),
    ({"busy": True, "activity_age_s": 20 * 60 + 1}, cs.STALLED),
    ({"busy": False, "reported": True}, cs.REPORTED),
    ({"busy": False}, cs.IDLE),
])
def test_classify(facts, state):
    base = {"registered": True, "busy": False, "display_status": "", "activity_age_s": None,
            "reported": False, "stall_minutes": 20}
    assert cs.classify(**(base | facts)) == state


def test_detect_follows_the_clock_and_reports(tmp_path):
    world = World()
    svc = service(tmp_path, world)
    world.add(pane("boss", "Boss"))
    child = world.add(pane("kid", "Kid", busy=True))
    world.touch("kid")
    assert svc.detect("kid", dispatcher="boss", stall_minutes=5) == cs.WORKING
    world.advance(5 * 60 + 1)
    assert svc.detect("kid", dispatcher="boss", stall_minutes=5) == cs.STALLED
    world.touch("kid")
    assert svc.detect("kid", dispatcher="boss", stall_minutes=5) == cs.WORKING
    child.display_status = "awaiting"
    assert svc.detect("kid", dispatcher="boss", stall_minutes=5) == cs.WAITING
    child.display_status, child.busy = "idle", False
    since = int(world.wall)
    assert svc.detect("kid", dispatcher="boss", since=since) == cs.IDLE
    world.messages.append(("Kid", "Someone", since))
    world.messages.append(("Kid", "Boss", since - 10))
    assert svc.detect("kid", dispatcher="boss", since=since) == cs.IDLE
    world.messages.append(("Kid", "Boss", since + 1))
    assert svc.detect("kid", dispatcher="boss", since=since) == cs.REPORTED
    del world.panes["kid"]
    assert svc.detect("kid", dispatcher="boss", since=since) == cs.GONE


def test_tree_nests_grandchildren_and_keeps_closed(tmp_path):
    world = World()
    svc = service(tmp_path, world)
    body = world.add(pane("boss", "Boss"))
    c = svc.create({"name": "C"}, pane=body)
    world.add(pane("kid", "Kid", busy=True))
    world.touch("kid")
    world.add(pane("grand", "Grand"))
    assert svc.note_open("boss", "kid", "build it") is not None
    assert svc.note_open("kid", "grand", "sub task") is not None
    assert svc.note_open("stranger", "x") is None
    svc.note_open("boss", "gone-kid")
    svc.store.close_dispatch("gone-kid")
    tree = svc.tree(c.id)
    root = tree["root"]
    assert root["pane_id"] == "boss" and root["name"] == "Boss"
    kids = {n["pane_id"]: n for n in root["children"]}
    assert kids["kid"]["state"] == cs.WORKING and kids["kid"]["task"] == "build it"
    assert kids["gone-kid"]["state"] == cs.GONE
    assert [g["pane_id"] for g in kids["kid"]["children"]] == ["grand"]
    assert kids["kid"]["children"][0]["state"] == cs.IDLE
    summary = svc.summary(svc.store.get(c.id))
    assert summary["dispatch_counts"][cs.WORKING] == 1 and summary["body_live"] is True


def test_role_of_commander_and_worker(tmp_path):
    world = World()
    svc = service(tmp_path, world)
    c = svc.create({"name": "C"}, pane=world.add(pane("boss", "Boss")))
    svc.note_open("boss", "kid")
    svc.note_open("kid", "grand")
    assert svc.role_of("boss") == {"id": c.id, "name": "C", "role": "commander"}
    assert svc.role_of("grand") == {"id": c.id, "name": "C", "role": "worker", "dispatched_by": "kid"}
    assert svc.role_of("nobody") is None
    svc.archive(c.id)
    assert svc.role_of("boss") is None and svc.role_of("kid") is None


def test_body_follows_an_alias(tmp_path):
    world = World()
    svc = service(tmp_path, world)
    c = svc.create({"name": "C"}, pane=world.add(pane("old", "Boss")))
    world.panes["new"] = world.panes.pop("old")
    world.panes["new"].pane_id = "new"
    world.aliases["old"] = "new"
    assert svc.body(c.id).pane_id == "new"
    assert svc.store.current_body(c.id).pane_id == "new"

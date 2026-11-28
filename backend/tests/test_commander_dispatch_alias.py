"""A dispatched child resumed under a new pane id (the window rebuilt its pane
around the same CLI, so agent_messaging aliases old -> new): the tree and the
dispatch rows report the new id, grandchildren stay nested under it."""

from __future__ import annotations

from agent_team_backend import commander_service as cs

from .commander_fakes import World, pane, service


def rekey(world: World, old: str, new: str) -> None:
    world.panes[new] = world.panes.pop(old)
    world.panes[new].pane_id = new
    world.aliases[old] = new


def test_tree_reports_a_resumed_childs_new_pane_id(tmp_path):
    world = World()
    svc = service(tmp_path, world)
    c = svc.create({"name": "C"}, pane=world.add(pane("boss", "Boss")))
    world.add(pane("kid", "Kid", busy=True))
    world.touch("kid")
    world.add(pane("grand", "Grand"))
    svc.note_open("boss", "kid", "build it")
    svc.note_open("kid", "grand", "sub task")
    rekey(world, "kid", "kid2")
    world.touch("kid2")

    root = svc.tree(c.id)["root"]
    assert [n["pane_id"] for n in root["children"]] == ["kid2"]
    kid = root["children"][0]
    assert kid["name"] == "Kid" and kid["task"] == "build it" and kid["state"] == cs.WORKING
    assert [(g["pane_id"], g["opened_by"]) for g in kid["children"]] == [("grand", "kid2")]
    # The rows followed, so everything else reading them agrees.
    assert [d.pane_id for d in svc.store.dispatches(c.id)] == ["kid2", "grand"]
    assert svc.store.dispatch_of("kid2").task == "build it"
    assert svc.role_of("kid2")["role"] == "worker"


def test_summary_counts_a_resumed_child_once(tmp_path):
    world = World()
    svc = service(tmp_path, world)
    c = svc.create({"name": "C"}, pane=world.add(pane("boss", "Boss")))
    world.add(pane("kid", "Kid", busy=True))
    world.touch("kid")
    svc.note_open("boss", "kid")
    rekey(world, "kid", "kid2")
    world.touch("kid2")
    counts = svc.summary(svc.store.get(c.id))["dispatch_counts"]
    assert counts[cs.WORKING] == 1 and sum(counts.values()) == 1
    assert [d.pane_id for d in svc.store.dispatches(c.id)] == ["kid2"]


def test_a_closed_dispatch_keeps_its_id(tmp_path):
    world = World()
    svc = service(tmp_path, world)
    c = svc.create({"name": "C"}, pane=world.add(pane("boss", "Boss")))
    svc.note_open("boss", "gone")
    svc.store.close_dispatch("gone")
    kid = svc.tree(c.id)["root"]["children"][0]
    assert kid["pane_id"] == "gone" and kid["state"] == cs.GONE

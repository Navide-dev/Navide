"""Upgrading a pane moves what targets it onto the commander; downgrading
puts every field back exactly as it was."""

from __future__ import annotations

import copy

import pytest

from agent_team_backend import commander_service as cs
from agent_team_backend.commander_store import CommanderInvalid

from .commander_fakes import World, pane, service


class Bindings:
    """A stand-in for channel bindings / schedules targeting panes."""

    def __init__(self, kind: str) -> None:
        self.kind = kind
        self.rows = {
            "b1": {"target_pane": "p1", "chat": "c1", "commander_id": "", "paused": False},
            "b2": {"target_pane": "p1", "chat": "c2", "commander_id": "", "paused": False},
            "b3": {"target_pane": "other", "chat": "c3", "commander_id": "", "paused": False},
        }
        self.fail_upgrade = False

    def upgrade(self, commander_id: str, pane_id: str):
        if self.fail_upgrade:
            raise RuntimeError("boom")
        moved = []
        for ref, row in self.rows.items():
            if row["target_pane"] == pane_id:
                moved.append((ref, copy.deepcopy(row)))
                row["target_pane"], row["commander_id"] = "", commander_id
        return moved

    def restore(self, commander_id: str, ref_id: str, before, pane_id: str) -> None:
        self.rows[ref_id] = dict(before, target_pane=pane_id)

    def set_paused(self, commander_id: str, paused: bool) -> None:
        for row in self.rows.values():
            if row["commander_id"] == commander_id:
                row["paused"] = paused

    def migrator(self) -> cs.Migrator:
        return cs.Migrator(self.kind, self.upgrade, self.restore, self.set_paused)


@pytest.fixture
def bindings():
    channel, sched = Bindings("channel_binding"), Bindings("scheduler_job")
    cs.register_migrator(channel.migrator())
    cs.register_migrator(sched.migrator())
    yield channel, sched
    cs.unregister_migrator("channel_binding")
    cs.unregister_migrator("scheduler_job")


def test_upgrade_then_downgrade_restores_every_field(tmp_path, bindings):
    world = World()
    svc = service(tmp_path, world)
    before = [copy.deepcopy(b.rows) for b in bindings]
    c = svc.upgrade_pane(world.add(pane("p1", "Worker")), {})
    assert c.name == "Worker" and c.workspaces == ["/ws"] and c.agent_key == "claude"
    for b in bindings:
        assert b.rows["b1"]["commander_id"] == c.id and b.rows["b3"]["commander_id"] == ""
    assert len(svc.store.pending_migrations(c.id)) == 4
    svc.downgrade(c.id)
    assert [b.rows for b in bindings] == before
    assert svc.store.pending_migrations(c.id) == []
    assert svc.store.get(c.id).archived_at and svc.store.current_body(c.id) is None


def test_downgrade_restores_onto_the_new_pane_id(tmp_path, bindings):
    world = World()
    svc = service(tmp_path, world)
    c = svc.upgrade_pane(world.add(pane("p1", "Worker")), {"name": "Cmd"})
    world.panes["p9"] = world.panes.pop("p1")
    world.panes["p9"].pane_id = "p9"
    world.aliases["p1"] = "p9"
    svc.downgrade(c.id)
    for b in bindings:
        assert b.rows["b1"]["target_pane"] == "p9" and b.rows["b2"]["target_pane"] == "p9"
        assert b.rows["b3"]["target_pane"] == "other"


def test_failed_upgrade_leaves_everything_as_it_was(tmp_path, bindings):
    world = World()
    svc = service(tmp_path, world)
    before = [copy.deepcopy(b.rows) for b in bindings]
    bindings[1].fail_upgrade = True
    with pytest.raises(RuntimeError):
        svc.upgrade_pane(world.add(pane("p1", "Worker")), {})
    assert [b.rows for b in bindings] == before
    assert svc.store.list() == [] and svc.store.commander_of_body("p1") == ""


def test_upgrade_twice_is_refused_and_archive_pauses(tmp_path, bindings):
    world = World()
    svc = service(tmp_path, world)
    p = world.add(pane("p1", "Worker"))
    c = svc.upgrade_pane(p, {})
    with pytest.raises(CommanderInvalid):
        svc.upgrade_pane(p, {"name": "Other"})
    svc.archive(c.id)
    assert all(b.rows["b1"]["paused"] for b in bindings)
    assert not any(b.rows["b3"]["paused"] for b in bindings)
    with pytest.raises(CommanderInvalid):
        svc.downgrade(c.id)


def test_no_migrators_means_nothing_moves(tmp_path):
    world = World()
    svc = service(tmp_path, world)
    c = svc.upgrade_pane(world.add(pane("p1", "Worker")), {})
    svc.downgrade(c.id)
    assert svc.store.pending_migrations(c.id) == []

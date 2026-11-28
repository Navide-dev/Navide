"""commander_store: CRUD, schema version, unique names, archive, bodies,
dispatches and the memory file."""

from __future__ import annotations

import os
import stat

import pytest

from agent_team_backend.commander_store import (
    SCHEMA_VERSION,
    CommanderInvalid,
    CommanderNotFound,
    CommanderStore,
)
from agent_team_backend.db import Database


@pytest.fixture
def store(tmp_path):
    return CommanderStore(Database(tmp_path / "navide.db"), memory_root=tmp_path / "commanders")


def test_create_read_update_round_trip(store):
    c = store.create(name="Navide指揮", icon="◎", duty="ship it", workspaces=["/a", "/b"],
                     agent_key="claude", account_id="acct-1", skills=["s"], mcp=["m"], now=10)
    got = store.get(c.id)
    assert got == c
    assert got.workspaces == ["/a", "/b"] and got.model == "" and got.stall_minutes == 20
    updated = store.update(c.id, {"duty": "new duty", "stall_minutes": 45}, now=20)
    assert updated.duty == "new duty" and updated.stall_minutes == 45 and updated.updated_at == 20
    assert updated.created_at == 10
    assert [x.id for x in store.list()] == [c.id]


def test_update_refuses_unknown_and_bad_fields(store):
    c = store.create(name="A")
    with pytest.raises(CommanderInvalid):
        store.update(c.id, {"archived_at": 1})
    with pytest.raises(CommanderInvalid):
        store.update(c.id, {"stall_minutes": 0})
    with pytest.raises(CommanderInvalid):
        store.update(c.id, {"skills": "not-a-list"})
    with pytest.raises(CommanderNotFound):
        store.update("missing", {"duty": "x"})


def test_schema_is_versioned_and_reopens(tmp_path):
    db = Database(tmp_path / "navide.db")
    assert db.schema_version("commanders") == 0
    first = CommanderStore(db)
    assert db.schema_version("commanders") == SCHEMA_VERSION
    c = first.create(name="A")
    again = CommanderStore(Database(tmp_path / "navide.db"))
    assert again.get(c.id).name == "A"


def test_names_are_unique_case_insensitively_among_active(store):
    a = store.create(name="Alpha")
    with pytest.raises(CommanderInvalid):
        store.create(name="alpha")
    b = store.create(name="Beta")
    with pytest.raises(CommanderInvalid):
        store.update(b.id, {"name": "ALPHA"})
    with pytest.raises(CommanderInvalid):
        store.create(name="   ")
    store.archive(a.id)
    assert store.create(name="Alpha").id != a.id


def test_archive_keeps_the_record(store):
    c = store.create(name="A")
    store.attach_body(c.id, pane_id="p1")
    store.record_dispatch(c.id, pane_id="k1", opened_by="p1", task="t" * 500)
    archived = store.archive(c.id, now=99)
    assert archived.archived_at == 99
    assert store.list() == []
    assert [x.id for x in store.list(include_archived=True)] == [c.id]
    assert store.dispatches(c.id)[0].task == "t" * 200
    assert store.archive(c.id).archived_at == 99
    with pytest.raises(CommanderNotFound):
        store.archive("missing")


def test_bodies_follow_one_current(store):
    c = store.create(name="A")
    store.attach_body(c.id, pane_id="p1", now=1)
    store.attach_body(c.id, pane_id="p2", session_id="s2", now=2)
    assert store.current_body(c.id).pane_id == "p2"
    assert [(b.pane_id, b.detached_at) for b in store.bodies(c.id)] == [("p1", 2), ("p2", 0)]
    assert store.commander_of_body("p2") == c.id and store.commander_of_body("p1") == ""
    other = store.create(name="B")
    with pytest.raises(CommanderInvalid):
        store.attach_body(other.id, pane_id="p2")
    store.update_body_pane("p2", "p3")
    assert store.current_body(c.id).pane_id == "p3"
    store.detach_body(c.id)
    assert store.current_body(c.id) is None


def test_dispatches_open_and_close(store):
    c = store.create(name="A")
    store.record_dispatch(c.id, pane_id="k1", opened_by="p1", now=5)
    store.record_dispatch(c.id, pane_id="g1", opened_by="k1", now=6)
    assert store.dispatch_of("g1").opened_by == "k1"
    assert store.close_dispatch("k1", now=7) == 1
    assert store.dispatch_of("k1") is None
    assert [d.pane_id for d in store.dispatches(c.id, open_only=True)] == ["g1"]
    assert len(store.dispatches(c.id)) == 2


def test_memory_file_is_private(store, tmp_path):
    c = store.create(name="A")
    assert store.read_memory(c.id) == ""
    store.append_memory(c.id, "one")
    store.append_memory(c.id, "two\n")
    assert store.read_memory(c.id) == "one\ntwo\n"
    path = store.memory_path(c.id)
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    assert stat.S_IMODE(os.stat(path.parent).st_mode) == 0o700
    assert [p.name for p in path.parent.iterdir()] == ["memory.md"]
    with pytest.raises(CommanderInvalid):
        store.memory_path("../x")

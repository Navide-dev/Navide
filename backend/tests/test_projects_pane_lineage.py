"""PaneRecord.spawned_by: persistence and the re-key that keeps it alive.

pane_id is regenerated on every restart and re-linked through
previous_pane_id. A persisted spawned_by therefore points at an id that no
longer exists the moment its parent is restored — unless the children are
rewritten in the same save(). Storing the field without that rewrite is worse
than not storing it at all, because spawn-depth checks read the lineage and
would mis-count against dead pointers.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from agent_team_backend.projects import PaneRecord, ProjectStore


@pytest.fixture
def store_ws(tmp_path: Path) -> tuple[ProjectStore, str]:
    return ProjectStore(), str(tmp_path)


def _panes(store: ProjectStore, ws: str) -> dict[str, PaneRecord]:
    return {p.pane_id: p for p in store.peek(ws).panes}


def test_spawned_by_defaults_empty() -> None:
    assert PaneRecord(pane_id="x").spawned_by == ""


def test_spawned_by_round_trips(store_ws: tuple[ProjectStore, str]) -> None:
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="parent", agent="claude")
    store.record_manual_pane_spawn(ws, pane_id="child", agent="claude",
                                   origin="mcp", spawned_by="parent")
    assert _panes(store, ws)["child"].spawned_by == "parent"


def test_omitted_spawned_by_does_not_orphan_a_child(
    store_ws: tuple[ProjectStore, str]
) -> None:
    """Guarded like origin: a later call without the field keeps the parent."""
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="child", agent="claude", spawned_by="parent")
    store.record_manual_pane_spawn(ws, pane_id="child", agent="claude")
    assert _panes(store, ws)["child"].spawned_by == "parent"


def test_restore_rekeys_children_to_the_parents_new_id(
    store_ws: tuple[ProjectStore, str]
) -> None:
    """The core of this commit.

    Parent is restored under a fresh pane_id via previous_pane_id; the child's
    spawned_by must follow, not keep pointing at the retired id.
    """
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="p-old", agent="claude")
    store.record_manual_pane_spawn(ws, pane_id="c1", agent="claude", spawned_by="p-old")
    store.record_manual_pane_spawn(ws, pane_id="c2", agent="claude", spawned_by="p-old")

    store.record_manual_pane_spawn(ws, pane_id="p-new", previous_pane_id="p-old",
                                   agent="claude")

    panes = _panes(store, ws)
    assert "p-old" not in panes, "the parent record was re-keyed, not duplicated"
    assert panes["c1"].spawned_by == "p-new"
    assert panes["c2"].spawned_by == "p-new"


def test_rekey_survives_a_second_restart(store_ws: tuple[ProjectStore, str]) -> None:
    """Two restarts in a row must not leave the child pointing at generation 1."""
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="p1", agent="claude")
    store.record_manual_pane_spawn(ws, pane_id="c", agent="claude", spawned_by="p1")
    store.record_manual_pane_spawn(ws, pane_id="p2", previous_pane_id="p1", agent="claude")
    store.record_manual_pane_spawn(ws, pane_id="p3", previous_pane_id="p2", agent="claude")
    assert _panes(store, ws)["c"].spawned_by == "p3"


def test_rekey_drops_a_self_reference(store_ws: tuple[ProjectStore, str]) -> None:
    """A record must never become its own parent — the lineage walk would loop.

    This happens when a pane is re-keyed onto the id its own child already
    holds a pointer to.
    """
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="a", agent="claude")
    store.record_manual_pane_spawn(ws, pane_id="b", agent="claude", spawned_by="a")
    # 'b' is re-keyed onto 'a' — without the guard it would point at itself.
    store.record_manual_pane_spawn(ws, pane_id="a2", previous_pane_id="a", agent="claude")
    panes = _panes(store, ws)
    for pane in panes.values():
        assert pane.spawned_by != pane.pane_id, f"{pane.pane_id} is its own parent"


def test_pipeline_slot_rekey_also_moves_children(
    store_ws: tuple[ProjectStore, str]
) -> None:
    """A pipeline pane has no parent, but it can be one (MCP spawn from inside
    it), so its re-key must move children too."""
    store, ws = store_ws
    store.start_pipeline(
        ws, task_description="t", total_stages=1,
        stage_blueprint=[{"stage_id": "01", "title": "Build",
                          "slots": [{"label": "Build", "agent": "codex", "role": "eng"}]}],
    )
    store.record_slot_spawn(ws, stage_index=0, slot_label="Build",
                            pane_id="slot-old", agent="codex")
    store.record_manual_pane_spawn(ws, pane_id="kid", agent="claude",
                                   origin="mcp", spawned_by="slot-old")
    store.record_slot_spawn(ws, stage_index=0, slot_label="Build",
                            pane_id="slot-new", agent="codex")
    assert _panes(store, ws)["kid"].spawned_by == "slot-new"


def test_unrelated_lineages_are_untouched(store_ws: tuple[ProjectStore, str]) -> None:
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="p1", agent="claude")
    store.record_manual_pane_spawn(ws, pane_id="p2", agent="claude")
    store.record_manual_pane_spawn(ws, pane_id="c1", agent="claude", spawned_by="p1")
    store.record_manual_pane_spawn(ws, pane_id="c2", agent="claude", spawned_by="p2")
    store.record_manual_pane_spawn(ws, pane_id="p1b", previous_pane_id="p1", agent="claude")
    panes = _panes(store, ws)
    assert panes["c1"].spawned_by == "p1b"
    assert panes["c2"].spawned_by == "p2", "an unrelated lineage must not move"


# ── set_pane_parent: re-parenting an existing pane ─────────────────────────
def test_set_pane_parent_adopts_a_pane(store_ws: tuple[ProjectStore, str]) -> None:
    """The write half of lineage: a root pane becomes someone's child."""
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="a", agent="claude")
    store.record_manual_pane_spawn(ws, pane_id="b", agent="claude")

    outcome = store.set_pane_parent(ws, pane_id="b", spawned_by="a")

    assert not isinstance(outcome, str)
    assert _panes(store, ws)["b"].spawned_by == "a"


def test_set_pane_parent_empty_makes_a_root(store_ws: tuple[ProjectStore, str]) -> None:
    """'' is a value, not a missing one: the pane is detached to the root."""
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="a", agent="claude")
    store.record_manual_pane_spawn(ws, pane_id="b", agent="claude",
                                   origin="mcp", spawned_by="a")

    outcome = store.set_pane_parent(ws, pane_id="b", spawned_by="")

    assert not isinstance(outcome, str)
    assert _panes(store, ws)["b"].spawned_by == ""


def test_set_pane_parent_refuses_an_unknown_pane(store_ws: tuple[ProjectStore, str]) -> None:
    store, ws = store_ws
    assert store.set_pane_parent(ws, pane_id="ghost", spawned_by="") == "not_found"


def test_set_pane_parent_refuses_an_unknown_parent(store_ws: tuple[ProjectStore, str]) -> None:
    """A dangling parent pointer would draw a subtree under nothing."""
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="a", agent="claude")
    assert store.set_pane_parent(ws, pane_id="a", spawned_by="ghost") == "parent_not_found"
    assert _panes(store, ws)["a"].spawned_by == ""


def test_set_pane_parent_refuses_self(store_ws: tuple[ProjectStore, str]) -> None:
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="a", agent="claude")
    assert store.set_pane_parent(ws, pane_id="a", spawned_by="a") == "cycle"


def test_set_pane_parent_refuses_a_descendant(store_ws: tuple[ProjectStore, str]) -> None:
    """a -> b -> c; parenting a under c would loop, and the sidebar's lineage
    walk would spin. Refused at every depth, not only the direct child."""
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="a", agent="claude")
    store.record_manual_pane_spawn(ws, pane_id="b", agent="claude",
                                   origin="mcp", spawned_by="a")
    store.record_manual_pane_spawn(ws, pane_id="c", agent="claude",
                                   origin="mcp", spawned_by="b")

    assert store.set_pane_parent(ws, pane_id="a", spawned_by="b") == "cycle"
    assert store.set_pane_parent(ws, pane_id="a", spawned_by="c") == "cycle"
    # Nothing was written by the refusals.
    assert _panes(store, ws)["a"].spawned_by == ""


def test_set_pane_parent_moving_a_subtree_keeps_it_intact(
    store_ws: tuple[ProjectStore, str]
) -> None:
    """Re-parenting b (with child c) under d moves the whole branch: c still
    hangs off b, and b now hangs off d."""
    store, ws = store_ws
    for pid in ("a", "d"):
        store.record_manual_pane_spawn(ws, pane_id=pid, agent="claude")
    store.record_manual_pane_spawn(ws, pane_id="b", agent="claude",
                                   origin="mcp", spawned_by="a")
    store.record_manual_pane_spawn(ws, pane_id="c", agent="claude",
                                   origin="mcp", spawned_by="b")

    store.set_pane_parent(ws, pane_id="b", spawned_by="d")

    panes = _panes(store, ws)
    assert panes["b"].spawned_by == "d"
    assert panes["c"].spawned_by == "b"


def test_retiring_a_superseded_record_hands_its_children_to_the_successor(
    store_ws: tuple[ProjectStore, str]
) -> None:
    """A record replaced by another pane on the same conversation is not a close.

    Its children belong to the pane that now holds the conversation; adopting
    them onto the retired record's own parent would make every child of a
    root commander a root (the 2026-11-01 Telegram wake).
    """
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="cmd-old", agent="claude", session_id="s-cmd")
    store.record_manual_pane_spawn(ws, pane_id="kid", agent="claude", origin="mcp", spawned_by="cmd-old")
    store.record_manual_pane_spawn(ws, pane_id="cmd-new", agent="claude", origin="mcp", session_id="s-cmd")
    store.record_pane_unspawn_by_id(ws, pane_id="cmd-old", successor="cmd-new")
    panes = _panes(store, ws)
    assert panes["cmd-old"].spawn_status == "removed"
    assert panes["kid"].spawned_by == "cmd-new"


def test_channels_wake_into_a_new_pane_keeps_the_commanders_children(
    store_ws: tuple[ProjectStore, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    """The wake's retire step runs against the real store (reproduces 2026-11-01)."""
    import agent_team_backend.channels as channels_pkg
    from agent_team_backend import agent_messaging, app

    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="cmd-old", agent="claude", session_id="s-cmd")
    store.record_manual_pane_spawn(ws, pane_id="kid-a", agent="claude", origin="mcp", spawned_by="cmd-old")
    store.record_manual_pane_spawn(ws, pane_id="kid-b", agent="claude", origin="mcp", spawned_by="cmd-old")
    store.record_manual_pane_spawn(ws, pane_id="grandkid", agent="claude", origin="mcp", spawned_by="kid-a")
    store.record_manual_pane_spawn(ws, pane_id="cmd-new", agent="claude", origin="mcp", session_id="s-cmd")
    monkeypatch.setattr(app, "project_store", store, raising=False)
    monkeypatch.setattr(agent_messaging, "current", lambda pid: None)
    channels_pkg._retire_superseded(ws, "s-cmd", "cmd-new")
    panes = _panes(store, ws)
    assert panes["cmd-old"].spawn_status == "removed"
    assert panes["kid-a"].spawned_by == "cmd-new"
    assert panes["kid-b"].spawned_by == "cmd-new"
    assert panes["grandkid"].spawned_by == "kid-a"


def test_a_stale_parent_naming_a_retired_record_does_not_overwrite_the_lineage(
    store_ws: tuple[ProjectStore, str]
) -> None:
    """The window still holds the retired id in a child's spawnedBy and sends it
    back when that child is realized; a retired record is never a live parent."""
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="cmd-old", agent="claude", session_id="s-cmd")
    store.record_manual_pane_spawn(ws, pane_id="kid", agent="claude", origin="mcp", spawned_by="cmd-old")
    store.record_manual_pane_spawn(ws, pane_id="cmd-new", agent="claude", origin="mcp", session_id="s-cmd")
    store.record_pane_unspawn_by_id(ws, pane_id="cmd-old", successor="cmd-new")
    store.record_manual_pane_spawn(ws, pane_id="kid-2", previous_pane_id="kid", agent="claude",
                                   spawned_by="cmd-old")
    assert _panes(store, ws)["kid-2"].spawned_by == "cmd-new"


# ── opened_by: who opened a pane, fixed at its spawn ──────────────────────
def test_opened_by_is_written_once(store_ws: tuple[ProjectStore, str]) -> None:
    """A re-spawn (restore, rebuild) naming someone else does not move it."""
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="child", agent="claude", spawned_by="a", opened_by="a")
    store.record_manual_pane_spawn(ws, pane_id="child", agent="claude", opened_by="b")
    store.record_manual_pane_spawn(ws, pane_id="child", agent="claude")
    assert _panes(store, ws)["child"].opened_by == "a"


def test_re_parenting_leaves_opened_by_alone(store_ws: tuple[ProjectStore, str]) -> None:
    """cli_place_pane's write path moves the sidebar position only."""
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="a", agent="claude")
    store.record_manual_pane_spawn(ws, pane_id="c", agent="claude")
    store.record_manual_pane_spawn(ws, pane_id="b", agent="claude", spawned_by="a", opened_by="a")
    store.set_pane_parent(ws, pane_id="b", spawned_by="c")
    assert _panes(store, ws)["b"].spawned_by == "c"
    assert _panes(store, ws)["b"].opened_by == "a"


def test_restoring_the_opener_rekeys_opened_by(store_ws: tuple[ProjectStore, str]) -> None:
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="p-old", agent="claude")
    store.record_manual_pane_spawn(ws, pane_id="child", agent="claude", spawned_by="p-old", opened_by="p-old")
    store.record_manual_pane_spawn(ws, pane_id="p-new", previous_pane_id="p-old", agent="claude")
    assert _panes(store, ws)["child"].opened_by == "p-new"

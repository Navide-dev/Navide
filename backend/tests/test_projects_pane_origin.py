"""PaneRecord.origin: the 'mcp' value and the four non-pipeline filters.

Before this suite, every filter that meant "not a pipeline pane" was written
as `origin == "manual"`. Adding a third origin value silently broke all four
of them, and no existing test covered a non-"manual" non-pipeline record — so
the breakage would have passed CI. These tests pin the `!= "pipeline"` intent.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from agent_team_backend.projects import PaneRecord, ProjectStore


@pytest.fixture
def store_ws(tmp_path: Path) -> tuple[ProjectStore, str]:
    return ProjectStore(), str(tmp_path)


def test_pane_record_origin_defaults_to_manual() -> None:
    assert PaneRecord(pane_id="x").origin == "manual"


def test_mcp_origin_round_trips_through_store(store_ws: tuple[ProjectStore, str]) -> None:
    """spawn(origin='mcp') -> persisted -> read back still 'mcp'."""
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="p1", agent="claude", origin="mcp")
    pane = next(p for p in store.peek(ws).panes if p.pane_id == "p1")
    assert pane.origin == "mcp"


def test_omitted_origin_does_not_blank_an_existing_mcp_record(
    store_ws: tuple[ProjectStore, str]
) -> None:
    """A later spawn call that forgets origin must not strip the mcp marker.

    The field is guarded like session_id / run_group_id; an unguarded write
    would silently demote the record back to 'manual'.
    """
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="p1", agent="claude", origin="mcp")
    store.record_manual_pane_spawn(ws, pane_id="p1", agent="claude")  # no origin
    pane = next(p for p in store.peek(ws).panes if p.pane_id == "p1")
    assert pane.origin == "mcp"


def test_start_pipeline_preserves_mcp_panes(store_ws: tuple[ProjectStore, str]) -> None:
    """Filter 1 (projects.py:498). `== "manual"` here wiped every mcp record."""
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="m1", agent="claude", origin="manual")
    store.record_manual_pane_spawn(ws, pane_id="x1", agent="claude", origin="mcp")
    store.start_pipeline(
        ws,
        task_description="t",
        total_stages=1,
        stage_blueprint=[{"stage_id": "01", "title": "Build", "slots": []}],
    )
    ids = {p.pane_id for p in store.peek(ws).panes}
    assert "m1" in ids, "manual pane must survive a pipeline start"
    assert "x1" in ids, "mcp pane must survive a pipeline start"


def test_find_manual_pane_matches_mcp_record(store_ws: tuple[ProjectStore, str]) -> None:
    """Filter 2 (projects.py:693). A miss here re-created the record on every
    spawn, demoted origin back to 'manual', and accumulated duplicates."""
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="p1", agent="claude", origin="mcp")
    store.record_manual_pane_spawn(ws, pane_id="p1", agent="claude", role="rev", origin="mcp")
    panes = [p for p in store.peek(ws).panes if p.pane_id == "p1"]
    assert len(panes) == 1, "must upsert, not duplicate"
    assert panes[0].role == "rev"
    assert panes[0].origin == "mcp"


def test_session_dedup_retires_stale_mcp_record(store_ws: tuple[ProjectStore, str]) -> None:
    """Filter 3 (projects.py:743). Without it a rebuilt mcp pane left a ghost
    record sharing the session, which restore resurrected.

    Three records are needed to exercise this. A rebuild hop re-keys the record
    its previous_pane_id points at (that one becomes "new"), so the ghost this
    filter retires is a *third* record that only shares the session id.
    """
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="keeper", agent="claude",
                                   session_id="s1", origin="mcp")
    store.record_manual_pane_spawn(ws, pane_id="ghost", agent="claude",
                                   session_id="s1", origin="mcp")
    store.record_manual_pane_spawn(ws, pane_id="new", previous_pane_id="keeper",
                                   agent="claude", session_id="s1", origin="mcp")
    by_id = {p.pane_id: p for p in store.peek(ws).panes}
    assert "keeper" not in by_id, "the rebuild hop re-keys keeper into new"
    assert by_id["new"].spawn_status == "spawned"
    assert by_id["ghost"].spawn_status == "removed", \
        "a third record sharing the session must be retired even when origin is mcp"


def test_unspawn_marks_mcp_pane_removed(store_ws: tuple[ProjectStore, str]) -> None:
    """Filter 4 (projects.py:775). A miss here made mcp panes un-closable —
    they came back on every restart."""
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="p1", agent="claude", origin="mcp")
    store.record_manual_pane_unspawn(ws, pane_id="p1")
    pane = next(p for p in store.peek(ws).panes if p.pane_id == "p1")
    assert pane.spawn_status == "removed"


def test_pipeline_panes_are_still_cleared_by_start_pipeline(
    store_ws: tuple[ProjectStore, str]
) -> None:
    """The != "pipeline" rewrite must not stop clearing real pipeline panes."""
    store, ws = store_ws
    store.start_pipeline(
        ws, task_description="t", total_stages=1,
        stage_blueprint=[{"stage_id": "01", "title": "Build",
                          "slots": [{"label": "Build", "agent": "codex", "role": "eng"}]}],
    )
    store.record_slot_spawn(ws, stage_index=0, slot_label="Build",
                            pane_id="pipe-1", agent="codex")
    assert any(p.pane_id == "pipe-1" for p in store.peek(ws).panes)
    store.abort_pipeline(ws)  # a live run refuses a new start
    store.start_pipeline(
        ws, task_description="t2", total_stages=1,
        stage_blueprint=[{"stage_id": "01", "title": "Build", "slots": []}],
    )
    assert not any(p.pane_id == "pipe-1" for p in store.peek(ws).panes), \
        "stale pipeline panes must still be cleared"

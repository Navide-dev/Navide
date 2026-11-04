"""A wake's lineage hand-off when the woken pane's record is not persisted yet.

_open_onto_session retires the records the woken pane replaced and moves their
children onto it. The store only hands the children over when the successor's
record exists; when the window has not written it yet the store re-parents them
a level up instead. The window is told `pane.lineage_rekeyed` either way, so the
backend and the window disagree and the next reload shows the old symptom.
These run against a real ProjectStore so the persisted lineage is what is checked.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from types import SimpleNamespace

import pytest

import agent_team_backend.channels as channels_pkg
from agent_team_backend.projects import ProjectStore


@pytest.fixture
def heir(monkeypatch, tmp_path: Path):
    from agent_team_backend import agent_messaging, app, scheduler
    from agent_team_backend.mcp_server import server as mcp

    store = ProjectStore()
    ws = str(tmp_path)
    store.record_manual_pane_spawn(ws, pane_id="root", agent="claude")
    store.record_manual_pane_spawn(ws, pane_id="old-1", agent="claude", session_id="sess-1",
                                   spawned_by="root")
    store.record_manual_pane_spawn(ws, pane_id="child-1", agent="claude", spawned_by="old-1")
    state = SimpleNamespace(store=store, ws=ws, broadcasts=[], record_after=None)

    async def broadcast_main_windows(event):
        state.broadcasts.append(event)

    async def open_agent(*a, **kw):
        # The window answers before it persists the new pane's record.
        if state.record_after is not None:
            async def persist():
                await asyncio.sleep(state.record_after)
                store.record_manual_pane_spawn(ws, pane_id="new-1", agent="claude",
                                               session_id="sess-1")
            asyncio.get_running_loop().create_task(persist())
        return {"ok": True, "pane_id": "new-1", "resumed_session_id": kw.get("session_id")}

    async def rebind(*args):
        return []

    monkeypatch.setattr(app, "project_store", store)
    monkeypatch.setattr(app, "broadcast_main_windows", broadcast_main_windows)
    monkeypatch.setattr(agent_messaging, "current", lambda pid: None)
    monkeypatch.setattr(mcp, "cli_open_agent", open_agent)
    monkeypatch.setattr(scheduler, "get_service", lambda: SimpleNamespace(rebind_after_rebuild=rebind))
    monkeypatch.setattr(channels_pkg, "_host_ctx", lambda: None)
    monkeypatch.setattr(channels_pkg, "WAKE_SUCCESSOR_WAIT_S", 0.5)
    monkeypatch.setattr(channels_pkg, "WAKE_SUCCESSOR_POLL_S", 0.01)
    return state


def _parent(state, pane_id: str) -> str:
    return next(p.spawned_by for p in state.store.peek(state.ws).panes if p.pane_id == pane_id)


def _record() -> SimpleNamespace:
    return SimpleNamespace(agent="claude", custom_name="api", auto_name="")


async def test_a_late_successor_record_still_inherits_the_children(heir) -> None:
    heir.record_after = 0.05
    result = await channels_pkg._open_onto_session(_record(), heir.ws, "sess-1")
    assert result == {"ok": True, "pane_id": "new-1"}
    # The backend and the window agree: the child sits under the woken pane.
    assert _parent(heir, "child-1") == "new-1"
    assert [(e["type"], e["payload"]) for e in heir.broadcasts] == [("pane.lineage_rekeyed", {
        "workspace_path": heir.ws, "old_pane_id": "old-1", "new_pane_id": "new-1"})]


async def test_a_successor_that_never_records_is_not_announced(heir, caplog) -> None:
    caplog.set_level(logging.WARNING, logger=channels_pkg.log.name)
    result = await channels_pkg._open_onto_session(_record(), heir.ws, "sess-1")
    assert result == {"ok": True, "pane_id": "new-1"}
    # The record is still retired (it would come back on restore), its child moved up a level...
    assert [p.spawn_status for p in heir.store.peek(heir.ws).panes if p.pane_id == "old-1"] == ["removed"]
    assert _parent(heir, "child-1") == "root"
    # ...and the window is not told otherwise.
    assert heir.broadcasts == []
    assert any("old-1" in r.getMessage() and "new-1" in r.getMessage() for r in caplog.records)

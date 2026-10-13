"""What a pane was doing when the app went away, persisted so a manual restart
can bring the interrupted ones back.

Two facts on PaneRecord: `last_turn_state` ("working" / "idle"; "" = never
reported, which is every record written before the field existed) and the
report a spawned pane still owes its parent (`report_to` + `report_pending`).
One store setter writes any subset of them and skips the save when nothing
changed, because the renderer reports on every turn transition.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import app
from agent_team_backend.projects import PaneRecord, ProjectStore


@pytest.fixture
def store_ws(tmp_path: Path) -> tuple[ProjectStore, str]:
    return ProjectStore(), str(tmp_path)


def test_defaults_mean_nothing_known() -> None:
    pane = PaneRecord(pane_id="x")
    assert pane.last_turn_state == ""
    assert pane.report_to == ""
    assert pane.report_pending is False


def test_turn_state_round_trips(store_ws: tuple[ProjectStore, str]) -> None:
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="p1", agent="claude")
    store.set_pane_resume_state(ws, pane_id="p1", last_turn_state="working")
    assert ProjectStore().peek(ws).panes[0].last_turn_state == "working"
    store.set_pane_resume_state(ws, pane_id="p1", last_turn_state="idle")
    assert ProjectStore().peek(ws).panes[0].last_turn_state == "idle"


def test_report_debt_round_trips_and_leaves_turn_state_alone(store_ws: tuple[ProjectStore, str]) -> None:
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="p1", agent="claude")
    store.set_pane_resume_state(ws, pane_id="p1", last_turn_state="working")
    store.set_pane_resume_state(ws, pane_id="p1", report_to="lead", report_pending=True)
    pane = ProjectStore().peek(ws).panes[0]
    assert (pane.report_to, pane.report_pending, pane.last_turn_state) == ("lead", True, "working")
    # Settling clears the flag but keeps who it was owed to.
    store.set_pane_resume_state(ws, pane_id="p1", report_pending=False)
    pane = ProjectStore().peek(ws).panes[0]
    assert (pane.report_to, pane.report_pending) == ("lead", False)


def test_unknown_turn_state_is_refused(store_ws: tuple[ProjectStore, str]) -> None:
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="p1", agent="claude")
    store.set_pane_resume_state(ws, pane_id="p1", last_turn_state="bogus")
    assert ProjectStore().peek(ws).panes[0].last_turn_state == ""


def test_unknown_pane_is_a_noop(store_ws: tuple[ProjectStore, str]) -> None:
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="p1", agent="claude")
    store.set_pane_resume_state(ws, pane_id="ghost", last_turn_state="working")
    assert [p.last_turn_state for p in ProjectStore().peek(ws).panes] == [""]


def test_unchanged_write_skips_the_save(store_ws: tuple[ProjectStore, str], monkeypatch: pytest.MonkeyPatch) -> None:
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="p1", agent="claude")
    store.set_pane_resume_state(ws, pane_id="p1", last_turn_state="working")
    saves: list[object] = []
    monkeypatch.setattr(store, "save", lambda project: saves.append(project))
    store.set_pane_resume_state(ws, pane_id="p1", last_turn_state="working")
    assert saves == []


def test_state_follows_the_record_through_a_restore_rekey(store_ws: tuple[ProjectStore, str]) -> None:
    """A restore re-spawns the record under a new pane_id; what it was doing and
    what it owes must stay on that record, not be reset by the re-spawn."""
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="old", agent="claude", session_id="s1")
    store.set_pane_resume_state(
        ws, pane_id="old", last_turn_state="working", report_to="lead", report_pending=True,
    )
    store.record_manual_pane_spawn(
        ws, pane_id="new", previous_pane_id="old", agent="claude", session_id="s1",
    )
    pane = next(p for p in ProjectStore().peek(ws).panes if p.pane_id == "new")
    assert (pane.last_turn_state, pane.report_to, pane.report_pending) == ("working", "lead", True)


def test_records_written_before_the_fields_load_with_defaults(store_ws: tuple[ProjectStore, str]) -> None:
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="p1", agent="claude")
    project = store.load_or_create(ws)
    raw = project.to_dict()
    for key in ("last_turn_state", "report_to", "report_pending"):
        del raw["panes"][0][key]
    loaded = type(project).from_dict(raw)
    assert (loaded.panes[0].last_turn_state, loaded.panes[0].report_pending) == ("", False)


# ── WS handler ───────────────────────────────────────────────────────────────


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


def _session() -> "app.Session":
    return app.Session(FakeWebSocket())  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_handler_persists_only_the_fields_sent(tmp_path: Path) -> None:
    ws = str(tmp_path)
    await app.handle_message(_session(), {
        "id": "m0",
        "type": "manual_pane.spawn",
        "payload": {"workspace_path": ws, "pane_id": "P1", "agent": "claude", "command": "claude"},
    })
    session = _session()
    await app.handle_message(session, {
        "id": "m1",
        "type": "project.set_pane_resume_state",
        "payload": {"workspace_path": ws, "pane_id": "P1", "report_to": "lead", "report_pending": True},
    })
    reply = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert reply["ok"] is True
    pane = ProjectStore().peek(ws).panes[0]
    assert (pane.report_to, pane.report_pending, pane.last_turn_state) == ("lead", True, "")


@pytest.mark.asyncio
async def test_handler_says_when_no_pane_took_the_write(tmp_path: Path) -> None:
    """An unknown pane is not an error, but the caller must be able to tell a
    write that landed from one that matched nothing."""
    ws = str(tmp_path)
    await app.handle_message(_session(), {
        "id": "m0",
        "type": "manual_pane.spawn",
        "payload": {"workspace_path": ws, "pane_id": "P1", "agent": "claude", "command": "claude"},
    })
    session = _session()
    await app.handle_message(session, {
        "id": "m1",
        "type": "project.set_pane_resume_state",
        "payload": {"workspace_path": ws, "pane_id": "ghost", "last_turn_state": "working"},
    })
    hit = _session()
    await app.handle_message(hit, {
        "id": "m2",
        "type": "project.set_pane_resume_state",
        "payload": {"workspace_path": ws, "pane_id": "P1", "last_turn_state": "working"},
    })
    miss_reply = session.websocket.sent[0]  # type: ignore[attr-defined]
    hit_reply = hit.websocket.sent[0]  # type: ignore[attr-defined]
    assert miss_reply["ok"] is True
    assert miss_reply["payload"] == {"ok": True, "applied": False}
    assert hit_reply["payload"] == {"ok": True, "applied": True}

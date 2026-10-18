"""DevTimeStore Phase 5: one-time Claude transcript backfill."""

from __future__ import annotations

import asyncio
import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

from agent_team_backend import dev_time_store
from agent_team_backend.db import DB_FILENAME, WorkspaceDatabases
from agent_team_backend.dev_time_store import (
    AGENT_GAP_S,
    BACKFILL_DAYS,
    BACKFILL_MARKER_KEY,
    DevTimeStore,
)
from agent_team_backend.log_readers.base import encode_claude_cwd
from agent_team_backend.projects import PROJECT_DIR_NAME

UTC = timezone.utc
T0 = datetime(2026, 9, 10, 12, 0, 0, tzinfo=UTC).timestamp()


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def _assistant(ts: float, stop_reason: str = "tool_use") -> dict:
    return {
        "type": "assistant",
        "timestamp": _iso(ts),
        "sessionId": "ignored-here",
        "message": {"role": "assistant", "stop_reason": stop_reason, "content": []},
    }


def _user(ts: float) -> dict:
    return {"type": "user", "timestamp": _iso(ts), "message": {"role": "user", "content": "hi"}}


@pytest.fixture
def ws(tmp_path):
    w = tmp_path / "ws"
    w.mkdir()
    return str(w)


@pytest.fixture
def claude_home(tmp_path, monkeypatch, ws):
    """A CLAUDE_CONFIG_DIR whose projects/<encoded ws> dir the real reader
    resolves — proves the reader's path derivation is what gets reused."""
    home = tmp_path / "claude-home"
    project_dir = home / "projects" / encode_claude_cwd(ws)
    project_dir.mkdir(parents=True)
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(home))
    return project_dir


@pytest.fixture
def clock_at_t0(monkeypatch):
    """start_backfill and the snapshot handler pass no ``now``: the store reads
    its module clock. Pin that clock to T0, as the other tests pass now=T0, so
    the 90-day cutoff stays relative to T0 and not to the real date."""
    monkeypatch.setattr(dev_time_store, "time", SimpleNamespace(time=lambda: T0))


@pytest.fixture
def store():
    return DevTimeStore(WorkspaceDatabases(), tz=UTC)


def _write(project_dir: Path, session_id: str, records: list[dict], mtime: float | None = None) -> Path:
    path = project_dir / f"{session_id}.jsonl"
    path.write_text("".join(json.dumps(r) + "\n" for r in records), encoding="utf-8")
    if mtime is not None:
        os.utime(path, (mtime, mtime))
    return path


def _rows(ws: str):
    conn = sqlite3.connect(f"{ws}/{PROJECT_DIR_NAME}/{DB_FILENAME}")
    try:
        return conn.execute(
            "SELECT pane_id, source, started_at, last_seen_at, closed"
            " FROM dev_time_intervals ORDER BY id"
        ).fetchall()
    finally:
        conn.close()


def _all(store, ws, now=T0):
    return store.snapshot(ws, now=now)["totals"]["all"]


def test_consecutive_assistant_records_merge_and_end_turn_closes(store, ws, claude_home):
    _write(claude_home, "sess-a", [
        _user(T0 - 3600),
        _assistant(T0 - 3600 + 5),
        _assistant(T0 - 3600 + 60),
        _assistant(T0 - 3600 + 120, "end_turn"),
        _user(T0 - 3000),                       # not a human beat
        _assistant(T0 - 3000 + 10),
        _assistant(T0 - 3000 + 40, "end_turn"),
    ])
    assert store.backfill_claude(ws, now=T0) == 2
    rows = _rows(ws)
    assert [(r[0], r[1], r[4]) for r in rows] == [
        ("backfill:sess-a", "backfill", 1),
        ("backfill:sess-a", "backfill", 1),
    ]
    assert (rows[0][2], rows[0][3]) == (_iso(T0 - 3600 + 5), _iso(T0 - 3600 + 120))
    got = _all(store, ws)
    assert got == {"merged_s": 115 + 30, "human_s": 0, "agent_s": 145, "overlap_s": 0, "wall_s": 635}


def test_gap_over_agent_threshold_splits_without_end_turn(store, ws, claude_home):
    _write(claude_home, "sess-b", [
        _assistant(T0 - 7200),
        _assistant(T0 - 7200 + 100),
        _assistant(T0 - 7200 + 100 + AGENT_GAP_S + 1),   # too late: new interval
        _assistant(T0 - 7200 + 100 + AGENT_GAP_S + 31),
    ])
    assert store.backfill_claude(ws, now=T0) == 2
    assert _all(store, ws)["agent_s"] == 100 + 30


def test_records_and_files_older_than_90_days_are_skipped(store, ws, claude_home):
    old = T0 - (BACKFILL_DAYS + 1) * 86400
    fresh = T0 - 86400
    # One file mixes an old turn and a fresh one: only the fresh turn lands.
    _write(claude_home, "mixed", [
        _assistant(old), _assistant(old + 60, "end_turn"),
        _assistant(fresh), _assistant(fresh + 45, "end_turn"),
    ])
    # A file untouched since before the cutoff is not even opened.
    _write(claude_home, "ancient", [
        _assistant(fresh), _assistant(fresh + 500, "end_turn"),
    ], mtime=old)
    assert store.backfill_claude(ws, now=T0) == 1
    assert _all(store, ws)["agent_s"] == 45
    assert store.snapshot(ws, now=T0)["totals"]["last7d"]["agent_s"] == 45


def test_marker_makes_backfill_idempotent_and_reset_allows_rerun(store, ws, claude_home):
    _write(claude_home, "sess-c", [_assistant(T0 - 100), _assistant(T0 - 40, "end_turn")])
    assert store.backfill_pending(ws) is True
    assert store.backfill_claude(ws, now=T0) == 1
    assert store.backfill_pending(ws) is False
    db = store._databases.get(ws)
    assert db.kv_get(BACKFILL_MARKER_KEY) == _iso(T0)
    # Second call: no new rows, even from a fresh store instance.
    assert store.backfill_claude(ws, now=T0 + 1) == 0
    assert DevTimeStore(WorkspaceDatabases(), tz=UTC).backfill_claude(ws, now=T0 + 2) == 0
    assert len(_rows(ws)) == 1
    # reset clears rows and the marker; the next run re-imports.
    store.reset(ws)
    assert db.kv_get(BACKFILL_MARKER_KEY) is None
    assert store.backfill_pending(ws) is True
    assert store.backfill_claude(ws, now=T0 + 3) == 1
    assert len(_rows(ws)) == 1


def test_by_pane_hides_backfill_rows_but_totals_and_days_include_them(store, ws, claude_home):
    _write(claude_home, "sess-d", [_assistant(T0 - 600), _assistant(T0 - 300, "end_turn")])
    store.backfill_claude(ws, now=T0)
    store.beat(ws, "real-pane", "human", T0 - 100)
    store.beat(ws, "real-pane", "human", T0 - 50)
    snap = store.snapshot(ws, now=T0)
    assert [p["pane_id"] for p in snap["by_pane"]] == ["real-pane"]
    assert snap["totals"]["all"] == {"merged_s": 350, "human_s": 50, "agent_s": 300, "overlap_s": 0, "wall_s": 550}
    assert snap["totals"]["today"]["agent_s"] == 300
    assert snap["by_day"][-1]["agent_s"] == 300


def test_backfill_overlapping_live_agent_interval_counts_once(store, ws, claude_home):
    # Live agent interval T0-200..T0-100 recorded first; backfill covers T0-300..T0-150.
    store.beat(ws, "live", "agent", T0 - 200)
    store.beat(ws, "live", "agent", T0 - 100)
    store.close(ws, "live", "agent", T0 - 100)
    _write(claude_home, "sess-e", [_assistant(T0 - 300), _assistant(T0 - 150, "end_turn")])
    store.backfill_claude(ws, now=T0)
    got = _all(store, ws)
    assert got["agent_s"] == 200           # union of [-300,-150] and [-200,-100]
    assert got["merged_s"] == 200
    assert store.snapshot(ws, now=T0)["by_pane"][0]["all_s"] == 100  # the live pane alone


def test_corrupt_lines_and_missing_project_dir_are_tolerated(store, ws, claude_home):
    path = claude_home / "sess-f.jsonl"
    path.write_text(
        '{"type":"assistant","timestamp":"' + _iso(T0 - 50) + '","message":{"stop_reason":"end_turn"}}\n'
        'not json {"assistant"\n'
        '{"type":"assistant","timestamp":"garbage","message":{}}\n',
        encoding="utf-8",
    )
    assert store.backfill_claude(ws, now=T0) == 0  # single beat = zero-length, dropped
    # A workspace whose encoded dir does not exist: marker still written, no rows.
    other = str(Path(ws).parent / "other")
    Path(other).mkdir()
    assert store.backfill_claude(other, now=T0) == 0
    assert store.backfill_pending(other) is False


@pytest.mark.asyncio
async def test_start_backfill_runs_once_off_loop_and_broadcasts(store, ws, claude_home, clock_at_t0):
    _write(claude_home, "sess-g", [_assistant(T0 - 100), _assistant(T0 - 40, "end_turn")])
    seen: list[str] = []

    async def on_change(label: str) -> None:
        seen.append(label)

    task = store.start_backfill(ws, on_change)
    assert task is not None
    assert store.start_backfill(ws, on_change) is None   # already in flight
    await asyncio.wait_for(task, timeout=5)
    assert seen == [ws]
    assert len(_rows(ws)) == 1
    assert store.start_backfill(ws, on_change) is None   # marker present


@pytest.mark.asyncio
async def test_devtime_snapshot_handler_triggers_backfill(ws, claude_home, monkeypatch, clock_at_t0):
    import uuid

    from agent_team_backend import app

    store = DevTimeStore(WorkspaceDatabases(), tz=UTC)
    monkeypatch.setattr(app, "dev_time_store", store)
    broadcasts: list[dict] = []

    async def fake_broadcast(event: dict) -> None:
        broadcasts.append(event)

    monkeypatch.setattr(app, "broadcast", fake_broadcast)

    class _WS:
        def __init__(self) -> None:
            self.sent: list[dict] = []

        async def send_json(self, payload: dict) -> None:
            self.sent.append(payload)

    _write(claude_home, "sess-h", [_assistant(T0 - 100), _assistant(T0 - 40, "end_turn")])
    session = app.Session(_WS())  # type: ignore[arg-type]
    msg_id = str(uuid.uuid4())
    await app.handle_message(
        session, {"id": msg_id, "type": "devtime.snapshot", "payload": {"workspace_path": ws}}
    )
    frame = [f for f in session.websocket.sent if f.get("id") == msg_id][-1]
    assert frame["payload"]["totals"]["all"]["agent_s"] == 0  # answered before the backfill
    await asyncio.gather(*store._backfill_tasks)
    assert broadcasts[-1] == {**broadcasts[-1], "type": "devtime.changed", "payload": {"workspace_path": ws}}
    assert store.snapshot(ws, now=T0)["totals"]["all"]["agent_s"] == 60

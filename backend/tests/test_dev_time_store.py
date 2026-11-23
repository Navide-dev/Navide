"""DevTimeStore: heartbeats -> intervals -> per-workspace totals."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from agent_team_backend.db import DB_FILENAME, WorkspaceDatabases
from agent_team_backend.dev_time_store import (
    AGENT_GAP_S,
    BEAT_PERSIST_S,
    CHANGED_THROTTLE_S,
    HUMAN_GAP_S,
    DevTimeStore,
    resolve_event_ts,
)
from agent_team_backend.projects import PROJECT_DIR_NAME

UTC = timezone.utc
# A fixed "now" well inside a day (12:00 UTC) so window math is unambiguous.
T0 = datetime(2026, 9, 10, 12, 0, 0, tzinfo=UTC).timestamp()


@pytest.fixture
def ws(tmp_path):
    return str(tmp_path)


@pytest.fixture
def store():
    return DevTimeStore(WorkspaceDatabases(), tz=UTC)


def _rows(ws: str):
    import sqlite3

    conn = sqlite3.connect(str(f"{ws}/{PROJECT_DIR_NAME}/{DB_FILENAME}"))
    try:
        return conn.execute(
            "SELECT pane_id, source, started_at, last_seen_at, closed"
            " FROM dev_time_intervals ORDER BY id"
        ).fetchall()
    finally:
        conn.close()


def _all(snap):
    return snap["totals"]["all"]


# ── Heartbeat merging ────────────────────────────────────────────────


def test_consecutive_beats_merge_into_one_interval(store, ws):
    assert store.beat(ws, "p1", "human", T0) is True   # opens
    assert store.beat(ws, "p1", "human", T0 + 60) is False
    assert store.beat(ws, "p1", "human", T0 + 120) is False
    snap = store.snapshot(ws, now=T0 + 130)
    assert _all(snap) == {"merged_s": 120, "human_s": 120, "agent_s": 0, "overlap_s": 0, "wall_s": 120}
    assert snap["active"] is True
    assert snap["active_sources"] == ["human"]
    assert len(_rows(ws)) == 1


def test_gap_over_threshold_splits_and_no_trailing_padding(store, ws):
    store.beat(ws, "p1", "human", T0)
    store.beat(ws, "p1", "human", T0 + 100)
    # HUMAN_GAP_S + 1 later: the first interval closes at its last beat.
    assert store.beat(ws, "p1", "human", T0 + 100 + HUMAN_GAP_S + 1) is True
    store.beat(ws, "p1", "human", T0 + 100 + HUMAN_GAP_S + 1 + 40)
    snap = store.snapshot(ws, now=T0 + 1000)
    assert _all(snap)["merged_s"] == 100 + 40
    rows = _rows(ws)
    assert [r[4] for r in rows] == [1, 0]
    assert rows[0][3] == "2026-09-10T12:01:40Z"  # closed at its last beat


def test_beat_exactly_at_threshold_still_extends(store, ws):
    store.beat(ws, "p1", "agent", T0)
    assert store.beat(ws, "p1", "agent", T0 + AGENT_GAP_S) is False
    assert _all(store.snapshot(ws, now=T0 + AGENT_GAP_S))["agent_s"] == AGENT_GAP_S


def test_out_of_order_beat_is_ignored(store, ws):
    store.beat(ws, "p1", "human", T0 + 50)
    assert store.beat(ws, "p1", "human", T0 + 10) is False
    assert _all(store.snapshot(ws, now=T0 + 60))["human_s"] == 0


def test_unknown_source_or_empty_pane_is_noop(store, ws):
    assert store.beat(ws, "p1", "bogus", T0) is False
    assert store.beat(ws, "", "human", T0) is False
    assert store.snapshot(ws, now=T0)["active"] is False


# ── Explicit close ───────────────────────────────────────────────────


def test_turn_complete_closes_agent_interval_at_event_time(store, ws):
    store.beat(ws, "p1", "agent", T0)
    store.beat(ws, "p1", "agent", T0 + 30)
    assert store.close(ws, "p1", "agent", T0 + 45) is True
    snap = store.snapshot(ws, now=T0 + 500)
    assert _all(snap)["agent_s"] == 45
    assert snap["active"] is False
    assert _rows(ws)[0][4] == 1
    # A later beat opens a fresh interval instead of extending the old one.
    assert store.beat(ws, "p1", "agent", T0 + 60) is True
    assert len(_rows(ws)) == 2


def test_close_ignores_event_time_outside_gap(store, ws):
    store.beat(ws, "p1", "agent", T0)
    store.close(ws, "p1", "agent", T0 + AGENT_GAP_S + 100)
    assert _all(store.snapshot(ws, now=T0 + 5000))["agent_s"] == 0


def test_close_without_open_interval_is_noop(store, ws):
    assert store.close(ws, "p1", "agent", T0) is False
    assert store.close_pane(ws, "p1", T0) is False


def test_close_pane_closes_both_sources(store, ws):
    store.beat(ws, "p1", "human", T0)
    store.beat(ws, "p1", "agent", T0 + 5)
    store.beat(ws, "p2", "agent", T0 + 5)
    assert store.close_pane(ws, "p1", T0 + 20) is True
    snap = store.snapshot(ws, now=T0 + 30)
    assert snap["active_sources"] == ["agent"]
    pane_states = {p["pane_id"]: p["active"] for p in snap["by_pane"]}
    assert pane_states == {"p1": False, "p2": True}


# ── Aggregation ──────────────────────────────────────────────────────


def test_two_panes_overlapping_count_once_in_merged(store, ws):
    store.beat(ws, "p1", "agent", T0)
    store.beat(ws, "p1", "agent", T0 + 600)
    store.beat(ws, "p2", "agent", T0 + 300)
    store.beat(ws, "p2", "agent", T0 + 900)
    snap = store.snapshot(ws, now=T0 + 900)
    assert _all(snap)["merged_s"] == 900          # union, not 600 + 600
    assert _all(snap)["agent_s"] == 900
    by_pane = {p["pane_id"]: p for p in snap["by_pane"]}
    assert by_pane["p1"]["all_s"] == 600
    assert by_pane["p2"]["all_s"] == 600
    assert by_pane["p1"]["today_s"] == 600


def test_human_agent_overlap(store, ws):
    # human 0..100, agent 50..200: merged 200, overlap 50
    store.beat(ws, "p1", "human", T0)
    store.beat(ws, "p1", "human", T0 + 100)
    store.beat(ws, "p1", "agent", T0 + 50)
    store.beat(ws, "p1", "agent", T0 + 200)
    got = _all(store.snapshot(ws, now=T0 + 200))
    assert got == {"merged_s": 200, "human_s": 100, "agent_s": 150, "overlap_s": 50, "wall_s": 200}
    assert store.snapshot(ws, now=T0 + 200)["active_sources"] == ["human", "agent"]


def test_human_beat_inside_agent_interval_bridges_gap(store, ws):
    # Plan's timeline note: a human beat > HUMAN_GAP_S after the previous one
    # still lands inside a running agent interval, so merged stays contiguous.
    store.beat(ws, "p1", "human", T0)
    store.beat(ws, "p1", "human", T0 + 60)
    store.beat(ws, "p1", "agent", T0 + 30)
    store.beat(ws, "p1", "agent", T0 + 700)
    store.beat(ws, "p1", "human", T0 + 500)   # > 300s after T0+60
    store.beat(ws, "p1", "human", T0 + 520)
    got = _all(store.snapshot(ws, now=T0 + 700))
    assert got["merged_s"] == 700
    assert got["human_s"] == 60 + 20


def test_by_pane_sorted_by_all_desc(store, ws):
    store.beat(ws, "small", "human", T0)
    store.beat(ws, "small", "human", T0 + 10)
    store.beat(ws, "big", "human", T0)
    store.beat(ws, "big", "human", T0 + 100)
    snap = store.snapshot(ws, now=T0 + 100)
    assert [p["pane_id"] for p in snap["by_pane"]] == ["big", "small"]


def test_backfill_source_counts_as_agent(store, ws):
    db = store._databases.get(ws)
    store._db(ws, create=True)
    with db.transaction() as cur:
        cur.execute(
            "INSERT INTO dev_time_intervals (pane_id, source, started_at, last_seen_at, closed)"
            " VALUES ('old', 'backfill', '2026-09-10T11:00:00Z', '2026-09-10T11:10:00Z', 1)"
        )
    got = _all(store.snapshot(ws, now=T0))
    assert got["agent_s"] == 600
    assert got["human_s"] == 0


def test_wall_s_spans_first_to_last_activity_in_window(store, ws):
    # One interval: wall == merged.
    store.beat(ws, "p1", "human", T0)
    store.beat(ws, "p1", "human", T0 + 100)
    one = _all(store.snapshot(ws, now=T0 + 100))
    assert one["wall_s"] == one["merged_s"] == 100
    # A second pane's agent interval after an idle gap: wall spans across
    # sources and panes, merged does not include the gap.
    store.beat(ws, "p2", "agent", T0 + 400)
    store.beat(ws, "p2", "agent", T0 + 460)
    two = _all(store.snapshot(ws, now=T0 + 460))
    assert two["merged_s"] == 160
    assert two["wall_s"] == 460
    assert two["wall_s"] > two["merged_s"]


def test_wall_s_is_clipped_to_the_window(store, ws):
    tz = timezone(timedelta(hours=8))
    store = DevTimeStore(WorkspaceDatabases(), tz=tz)
    start = datetime(2026, 9, 10, 23, 50, tzinfo=tz).timestamp()
    for offset in (0, 600, 1200):
        store.beat(ws, "p1", "agent", start + offset)   # 23:50 -> 00:10 local
    snap = store.snapshot(ws, now=datetime(2026, 9, 11, 1, 0, tzinfo=tz).timestamp())
    assert snap["totals"]["today"]["wall_s"] == 600       # only the post-midnight part
    assert snap["totals"]["all"]["wall_s"] == 1200
    assert snap["totals"]["last7d"]["wall_s"] == 1200


# ── Day buckets ──────────────────────────────────────────────────────


def test_interval_crossing_midnight_is_split_by_local_day(store, ws):
    tz = timezone(timedelta(hours=8))  # a "local" zone distinct from UTC
    store = DevTimeStore(WorkspaceDatabases(), tz=tz)
    # 23:50 -> 00:10 local on 2026-09-10/11
    start = datetime(2026, 9, 10, 23, 50, tzinfo=tz).timestamp()
    store.beat(ws, "p1", "agent", start)
    store.beat(ws, "p1", "agent", start + 10 * 60)
    store.beat(ws, "p1", "agent", start + 20 * 60)
    now = datetime(2026, 9, 11, 1, 0, tzinfo=tz).timestamp()
    snap = store.snapshot(ws, now=now)
    assert snap["totals"]["today"]["merged_s"] == 600
    assert snap["totals"]["all"]["merged_s"] == 1200
    assert snap["totals"]["last7d"]["merged_s"] == 1200
    days = {d["date"]: d["merged_s"] for d in snap["by_day"]}
    assert days["2026-09-10"] == 600
    assert days["2026-09-11"] == 600
    by_pane = snap["by_pane"][0]
    assert by_pane["today_s"] == 600 and by_pane["all_s"] == 1200


def test_by_day_has_seven_entries_ending_today_and_windows(store, ws):
    day = timedelta(days=1)
    for back in (0, 6, 7, 29, 30):
        t = T0 - back * day.total_seconds()
        store.beat(ws, f"p{back}", "human", t)
        store.beat(ws, f"p{back}", "human", t + 100)
        store.close_pane(ws, f"p{back}", t + 100)
    snap = store.snapshot(ws, now=T0)
    dates = [d["date"] for d in snap["by_day"]]
    assert len(dates) == 7
    assert dates[-1] == "2026-09-10"
    assert dates[0] == "2026-09-04"
    assert [d["merged_s"] for d in snap["by_day"]] == [100, 0, 0, 0, 0, 0, 100]
    assert snap["totals"]["today"]["merged_s"] == 100
    assert snap["totals"]["last7d"]["merged_s"] == 200      # today + 6 days back
    assert snap["totals"]["last30d"]["merged_s"] == 400     # + 7 and 29 days back
    assert snap["totals"]["all"]["merged_s"] == 500


# ── Persistence ──────────────────────────────────────────────────────


def test_last_seen_persisted_at_most_every_30s(store, ws):
    store.beat(ws, "p1", "human", T0)
    store.beat(ws, "p1", "human", T0 + 10)
    assert _rows(ws)[0][3] == "2026-09-10T12:00:00Z"  # not yet persisted
    store.beat(ws, "p1", "human", T0 + BEAT_PERSIST_S)
    assert _rows(ws)[0][3] == "2026-09-10T12:00:30Z"
    # The snapshot still sees the in-memory end even when disk lags.
    store.beat(ws, "p1", "human", T0 + BEAT_PERSIST_S + 5)
    assert _rows(ws)[0][3] == "2026-09-10T12:00:30Z"
    assert _all(store.snapshot(ws, now=T0 + 40))["human_s"] == BEAT_PERSIST_S + 5


def test_restart_closes_open_rows_at_persisted_last_seen(ws):
    first = DevTimeStore(WorkspaceDatabases(), tz=UTC)
    first.beat(ws, "p1", "agent", T0)
    first.beat(ws, "p1", "agent", T0 + BEAT_PERSIST_S)   # persisted
    first.beat(ws, "p1", "agent", T0 + BEAT_PERSIST_S + 10)  # memory only
    assert _rows(ws)[0][4] == 0

    second = DevTimeStore(WorkspaceDatabases(), tz=UTC)
    snap = second.snapshot(ws, now=T0 + 100)
    assert _rows(ws)[0][4] == 1
    assert snap["active"] is False
    assert _all(snap)["agent_s"] == BEAT_PERSIST_S  # the unpersisted 10s is lost
    # New beats after restart start a fresh row.
    assert second.beat(ws, "p1", "agent", T0 + 100) is True
    assert len(_rows(ws)) == 2


def test_reset_clears_rows_and_open_intervals(store, ws):
    store.beat(ws, "p1", "human", T0)
    store.beat(ws, "p1", "human", T0 + 30)
    store.reset(ws)
    assert _rows(ws) == []
    snap = store.snapshot(ws, now=T0 + 40)
    assert snap["active"] is False
    assert _all(snap)["merged_s"] == 0
    assert snap["by_pane"] == []
    # The stale in-memory interval is gone: the next beat opens a new row.
    assert store.beat(ws, "p1", "human", T0 + 50) is True


def test_snapshot_shape_for_untouched_workspace(store, ws):
    snap = store.snapshot(ws, now=T0)
    assert snap["workspace_path"] == ws
    assert snap["gap_human_s"] == HUMAN_GAP_S
    assert snap["gap_agent_s"] == AGENT_GAP_S
    assert snap["active"] is False and snap["active_sources"] == []
    assert set(snap["totals"]) == {"today", "last7d", "last30d", "all"}
    assert all(bucket["wall_s"] == 0 for bucket in snap["totals"].values())  # empty window
    assert len(snap["by_day"]) == 7 and snap["by_pane"] == []
    assert "wall_s" not in snap["by_day"][0]
    # A read never plants a database in the workspace.
    import os

    assert not os.path.exists(f"{ws}/{PROJECT_DIR_NAME}/{DB_FILENAME}")


def test_invalid_workspace_is_noop(store):
    assert store.beat("/nonexistent/path/zzz", "p1", "human", T0) is False
    assert store.snapshot("", now=T0)["active"] is False


# ── Timestamp rule ───────────────────────────────────────────────────


def test_resolve_event_ts_uses_event_time_within_60s():
    assert resolve_event_ts("2026-09-10T11:59:30Z", now=T0) == T0 - 30
    assert resolve_event_ts("2026-09-10T12:01:00Z", now=T0) == T0 + 60
    assert resolve_event_ts("2026-09-10T11:59:30.500Z", now=T0) == T0 - 29.5
    # Offset-carrying and naive (assumed UTC) forms parse too.
    assert resolve_event_ts("2026-09-10T20:00:10+08:00", now=T0) == T0 + 10
    assert resolve_event_ts("2026-09-10T12:00:05", now=T0) == T0 + 5


def test_resolve_event_ts_unparseable_falls_back_to_wall_clock():
    assert resolve_event_ts("", now=T0) == T0            # Stop-hook path
    assert resolve_event_ts("not a date", now=T0) == T0


def test_resolve_event_ts_skips_parseable_but_stale_timestamps():
    assert resolve_event_ts("2026-09-10T11:58:59Z", now=T0) is None   # 61s early
    assert resolve_event_ts("2026-09-09T12:00:00Z", now=T0) is None   # replayed log
    assert resolve_event_ts("2026-09-10T12:01:01Z", now=T0) is None   # 61s ahead


# ── Broadcast throttle ───────────────────────────────────────────────


def test_should_broadcast_throttles_but_not_transitions(store, ws):
    assert store.should_broadcast(ws, False, now=T0) is True   # first ever
    assert store.should_broadcast(ws, False, now=T0 + 5) is False
    assert store.should_broadcast(ws, True, now=T0 + 6) is True    # transition
    assert store.should_broadcast(ws, False, now=T0 + 7) is False
    assert store.should_broadcast(ws, False, now=T0 + 6 + CHANGED_THROTTLE_S) is True
    # Independent per workspace.
    assert store.should_broadcast("/other", False, now=T0 + 8) is True


# ── Stale sweep / shutdown / event adapters ──────────────────────────


def test_sweep_stale_closes_intervals_past_their_gap(store, ws):
    store.beat(ws, "p1", "human", T0)
    store.beat(ws, "p2", "agent", T0)
    # Human gap elapsed, agent gap not yet.
    assert store.sweep_stale(now=T0 + HUMAN_GAP_S + 1) == [ws]
    snap = store.snapshot(ws, now=T0 + HUMAN_GAP_S + 1)
    assert snap["active_sources"] == ["agent"]
    assert _rows(ws)[0][4] == 1 and _rows(ws)[1][4] == 0
    assert store.sweep_stale(now=T0 + HUMAN_GAP_S + 2) == []
    assert store.sweep_stale(now=T0 + AGENT_GAP_S + 1) == [ws]
    assert store.snapshot(ws, now=T0 + AGENT_GAP_S + 1)["active"] is False


def test_sweep_closes_at_last_beat_not_at_sweep_time(store, ws):
    # Last beat at T0+40; swept long after the gap. The interval must be 40s,
    # not 40s plus the idle tail up to the sweep.
    store.beat(ws, "p1", "human", T0)
    store.beat(ws, "p1", "human", T0 + 40)
    sweep_at = T0 + HUMAN_GAP_S + 600
    assert store.sweep_stale(now=sweep_at) == [ws]
    assert _all(store.snapshot(ws, now=sweep_at))["human_s"] == 40
    assert _rows(ws)[0][3] == "2026-09-10T12:00:40Z"
    assert _rows(ws)[0][4] == 1


def test_gap_is_measured_from_last_beat_not_interval_start(store, ws):
    # An interval that has run for far longer than the gap keeps extending as
    # long as consecutive beats stay within the gap of each other.
    t = T0
    store.beat(ws, "p1", "human", t)
    while t < T0 + 4 * HUMAN_GAP_S:
        t += HUMAN_GAP_S - 1
        assert store.beat(ws, "p1", "human", t) is False  # never a new interval
    assert len(_rows(ws)) == 1
    assert _all(store.snapshot(ws, now=t))["human_s"] == int(t - T0)


def test_pane_resolver_maps_events_to_the_current_id(ws):
    store = DevTimeStore(
        WorkspaceDatabases(), tz=UTC,
        resolve_pane=lambda pid: "new" if pid == "old" else "",
    )
    assert store.human_input(ws, "old") is True
    assert store.agent_event(ws, "old", "agent_active", "") is True
    assert [p["pane_id"] for p in store.snapshot(ws)["by_pane"]] == ["new"]
    assert store.pane_removed("old") == [ws]      # old and new both reach it
    assert store.snapshot(ws)["active"] is False


def test_shutdown_stops_the_backfill_executor(store, ws):
    from concurrent.futures import ThreadPoolExecutor

    store._backfill_executor = ThreadPoolExecutor(max_workers=1)
    executor = store._backfill_executor
    store.shutdown()
    assert store._backfill_executor is None
    assert executor._shutdown is True


def test_snapshot_reports_inactive_once_gap_elapsed_even_before_sweep(store, ws):
    store.beat(ws, "p1", "human", T0)
    assert store.snapshot(ws, now=T0 + HUMAN_GAP_S)["active"] is True
    late = store.snapshot(ws, now=T0 + HUMAN_GAP_S + 1)
    assert late["active"] is False
    assert late["by_pane"][0]["active"] is False
    assert _all(late)["human_s"] == 0  # still no trailing padding


def test_shutdown_closes_open_intervals_at_memory_last_seen(ws):
    first = DevTimeStore(WorkspaceDatabases(), tz=UTC)
    first.beat(ws, "p1", "agent", T0)
    first.beat(ws, "p1", "agent", T0 + 10)  # memory only
    first.shutdown()
    rows = _rows(ws)
    assert rows[0][4] == 1 and rows[0][3] == "2026-09-10T12:00:10Z"
    second = DevTimeStore(WorkspaceDatabases(), tz=UTC)
    assert _all(second.snapshot(ws, now=T0 + 20))["agent_s"] == 10


def test_agent_event_adapter_maps_types_and_timestamps(store, ws, monkeypatch):
    import agent_team_backend.dev_time_store as mod

    monkeypatch.setattr(mod.time, "time", lambda: T0 + 100)
    # Fresh log timestamp within 60s: used as-is.
    assert store.agent_event(ws, "p1", "agent_active", "2026-09-10T12:01:30Z") is True
    # Empty (Stop-hook path): wall clock.
    assert store.agent_event(ws, "p1", "turn_complete", "") is True
    got = _all(store.snapshot(ws, now=T0 + 100))
    assert got["agent_s"] == 10  # 12:01:30 -> 12:01:40
    assert store.snapshot(ws, now=T0 + 100)["active"] is False
    # Unknown event types are ignored.
    assert store.agent_event(ws, "p1", "something_else", "") is False
    # A stale replayed timestamp is history: neither an interval in the past
    # nor one "now".
    assert store.agent_event(ws, "p1", "agent_active", "2026-09-01T00:00:00Z") is False
    assert store.snapshot(ws, now=T0 + 100)["active"] is False
    assert len(_rows(ws)) == 1
    # ...and it cannot close a running interval either.
    store.beat(ws, "p1", "agent", T0 + 100)
    assert store.agent_event(ws, "p1", "turn_complete", "2026-09-01T00:00:00Z") is False
    assert store.snapshot(ws, now=T0 + 100)["active"] is True


def test_human_input_adapter_throttles_broadcasts(store, ws, monkeypatch):
    import agent_team_backend.dev_time_store as mod

    clock = [T0]
    monkeypatch.setattr(mod.time, "time", lambda: clock[0])
    assert store.human_input(ws, "p1") is True      # interval opened
    clock[0] = T0 + 1
    assert store.human_input(ws, "p1") is False     # throttled
    clock[0] = T0 + CHANGED_THROTTLE_S
    assert store.human_input(ws, "p1") is True      # throttle window elapsed
    assert _all(store.snapshot(ws, now=clock[0]))["human_s"] == CHANGED_THROTTLE_S


def test_pane_removed_closes_across_workspaces(store, tmp_path):
    ws_a = str(tmp_path / "a")
    ws_b = str(tmp_path / "b")
    for w in (ws_a, ws_b):
        __import__("os").makedirs(w)
    store.beat(ws_a, "p1", "human", T0)
    store.beat(ws_a, "p1", "agent", T0)
    store.beat(ws_b, "p1", "agent", T0)
    store.beat(ws_b, "p2", "agent", T0)
    touched = store.pane_removed("p1", T0 + 5)
    assert sorted(touched) == sorted([ws_a, ws_b])
    assert store.snapshot(ws_a, now=T0 + 6)["active"] is False
    assert store.snapshot(ws_b, now=T0 + 6)["active_sources"] == ["agent"]
    assert store.pane_removed("p1") == []


@pytest.mark.asyncio
async def test_stale_sweeper_broadcasts_for_swept_workspaces(store, ws, monkeypatch):
    import asyncio

    import agent_team_backend.dev_time_store as mod

    store.beat(ws, "p1", "human", T0)
    monkeypatch.setattr(mod.time, "time", lambda: T0 + HUMAN_GAP_S + 1)
    seen: list[str] = []
    swept = asyncio.Event()

    async def on_change(label: str) -> None:
        seen.append(label)
        swept.set()

    task = asyncio.create_task(store.stale_sweeper(on_change, interval_s=0.01))
    # The sweep runs on the shared db worker thread, behind any SQLite write
    # queued before it; a Windows runner's slow disk has taken seconds there.
    # Wait on the broadcast itself with a generous deadline, not a fixed
    # number of 10ms sleeps (~0.5s, or ~0.8s at Windows' 15.6ms tick).
    try:
        await asyncio.wait_for(swept.wait(), timeout=30)
    finally:
        task.cancel()
    assert seen == [ws]


# ── WS wiring ────────────────────────────────────────────────────────


class _FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send_json(self, payload: dict) -> None:
        self.sent.append(payload)


class _FakeTerminals:
    """Only what terminal.input touches: write() and get()."""

    def __init__(self, sessions: dict) -> None:
        self._sessions = sessions
        self.written: list[tuple[str, str]] = []

    def write(self, session_id: str, data: str) -> int:
        self.written.append((session_id, data))
        return 0

    def get(self, session_id: str):
        return self._sessions.get(session_id)


@pytest.fixture
def wired(monkeypatch, ws, tmp_path):
    from agent_team_backend import app

    # Keep the snapshot handler's one-time transcript backfill off the real home.
    (tmp_path / "claude-home" / "projects").mkdir(parents=True)
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-home"))
    store = DevTimeStore(WorkspaceDatabases(), tz=UTC)
    monkeypatch.setattr(app, "dev_time_store", store)
    broadcasts: list[dict] = []

    async def fake_broadcast(event: dict) -> None:
        broadcasts.append(event)

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    # Session is built inside the async test: its constructor needs a loop.
    return app, store, lambda: app.Session(_FakeWebSocket()), broadcasts


async def _call(app, session, msg_type: str, payload: dict) -> dict:
    import uuid

    msg_id = str(uuid.uuid4())
    await app.handle_message(session, {"id": msg_id, "type": msg_type, "payload": payload})
    frames = [f for f in session.websocket.sent if f.get("id") == msg_id]
    assert frames, f"no response frame for {msg_type}"
    assert frames[-1]["ok"] is True, frames[-1]
    return frames[-1]["payload"]


@pytest.mark.asyncio
async def test_terminal_input_beats_human_for_the_ptys_pane(wired, ws):
    from types import SimpleNamespace

    app, store, make_session, broadcasts = wired
    session = make_session()
    term = SimpleNamespace(pane_id="pane-1", cwd="/elsewhere", metadata={"workspace_path": ws})
    session.terminals = _FakeTerminals({"tsid-1": term})  # type: ignore[assignment]
    assert (await _call(app, session, "terminal.input", {"terminal_session_id": "tsid-1", "data": "x", "human": True})) == {"ok": True, "pending": 0}
    assert session.terminals.written == [("tsid-1", "x")]
    assert [e["type"] for e in broadcasts] == ["devtime.changed"]
    assert broadcasts[0]["payload"] == {"workspace_path": ws}
    snap = store.snapshot(ws)
    assert snap["active_sources"] == ["human"]
    assert snap["by_pane"][0]["pane_id"] == "pane-1"
    # Unknown PTY: still written, no beat.
    await _call(app, session, "terminal.input", {"terminal_session_id": "nope", "data": "y", "human": True})
    assert len(broadcasts) == 1


@pytest.mark.asyncio
async def test_devtime_snapshot_and_reset_handlers(wired, ws):
    app, store, make_session, broadcasts = wired
    session = make_session()
    store.beat(ws, "p1", "human", T0)
    store.beat(ws, "p1", "human", T0 + 10)
    snap = await _call(app, session, "devtime.snapshot", {"workspace_path": ws})
    assert snap["workspace_path"] == ws
    assert snap["totals"]["all"]["human_s"] == 10
    assert snap["gap_human_s"] == HUMAN_GAP_S
    assert (await _call(app, session, "devtime.reset", {"workspace_path": ws})) == {"ok": True}
    assert broadcasts[-1]["type"] == "devtime.changed"
    assert broadcasts[-1]["payload"] == {"workspace_path": ws}
    snap = await _call(app, session, "devtime.snapshot", {"workspace_path": ws})
    assert snap["totals"]["all"]["merged_s"] == 0 and snap["by_pane"] == []


def test_adapters_ignore_events_without_a_pane(store, ws):
    assert store.human_input(ws, "") is False
    assert store.agent_event(ws, "", "agent_active", "") is False
    assert store.snapshot(ws, now=T0)["active"] is False

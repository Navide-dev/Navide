"""Development-time tracker: heartbeats -> intervals -> per-workspace totals.

WakaTime-style model. Every ``terminal.input`` keystroke is a ``human``
heartbeat and every ``agent_active`` event an ``agent`` heartbeat, keyed by
(workspace, pane, source). Consecutive heartbeats of one key whose gap stays
within the source's threshold extend one open interval; a larger gap closes
it at its last heartbeat and opens a new one. ``turn_complete`` closes the
agent interval explicitly; pane removal closes both sources. Idle time is
simply the space between intervals, so nothing has to detect "idle began".

Intervals persist per workspace in ``<workspace>/.agent-team/navide.db``
(table ``dev_time_intervals``, shared with the other workspace stores). An
open interval's ``last_seen_at`` is written at most every BEAT_PERSIST_S;
the in-memory copy is always current. Rows still marked open when the
workspace is first touched in a process belong to a previous backend
lifetime and are closed at their persisted ``last_seen_at``.

All aggregation (union across panes and sources, human/agent overlap,
local-time day buckets with midnight splitting) happens at snapshot time —
interval volume is small.

Backfill (optional, once per workspace): the agent turns Claude Code wrote to
its transcripts before this feature existed are replayed through the same
gap engine and stored as ``source='backfill'`` rows under a synthetic
``backfill:<session_id>`` pane, so the lifetime total does not start at
zero. A kv marker makes it idempotent; ``reset()`` clears it.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import sqlite3
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import date, datetime, time as dtime, timedelta, timezone, tzinfo
from pathlib import Path
from threading import RLock
from typing import Any, Callable, Coroutine

from .db import WorkspaceDatabases

log = logging.getLogger("agent_team_backend.dev_time")

# Two human heartbeats further apart than this belong to different intervals.
HUMAN_GAP_S = 300
# Safety net for agent intervals: turn_complete normally closes them, the
# threshold only bounds the damage when a reader misses the closing event.
AGENT_GAP_S = 900
# An open interval's last_seen_at is persisted at most this often.
BEAT_PERSIST_S = 30
# A vendor-log timestamp further than this from the backend clock is ignored
# in favour of wall-clock (see resolve_event_ts).
TIMESTAMP_SKEW_S = 60
# devtime.changed is broadcast at most this often per workspace while beats
# keep arriving (open/close transitions and reset always broadcast).
CHANGED_THROTTLE_S = 30

SOURCE_HUMAN = "human"
SOURCE_AGENT = "agent"
SOURCE_BACKFILL = "backfill"
_GAP_BY_SOURCE = {SOURCE_HUMAN: HUMAN_GAP_S, SOURCE_AGENT: AGENT_GAP_S}

# Transcript backfill reads at most this far back (bounds the one-off scan).
BACKFILL_DAYS = 90
# kv marker in the workspace db: set once the backfill ran; reset() clears it.
BACKFILL_MARKER_KEY = "devtime.backfill.v1"
# Synthetic pane ids for backfilled sessions; by_pane hides them.
BACKFILL_PANE_PREFIX = "backfill:"

_COMPONENT = "dev_time"


def _create_schema(cur: sqlite3.Cursor) -> None:
    cur.execute(
        "CREATE TABLE dev_time_intervals ("
        " id INTEGER PRIMARY KEY AUTOINCREMENT,"
        " pane_id TEXT NOT NULL,"
        " source TEXT NOT NULL,"
        " started_at TEXT NOT NULL,"
        " last_seen_at TEXT NOT NULL,"
        " closed INTEGER NOT NULL DEFAULT 0)"
    )
    cur.execute(
        "CREATE INDEX dev_time_intervals_span"
        " ON dev_time_intervals (started_at, last_seen_at)"
    )


def _iso(ts: float) -> str:
    return (
        datetime.fromtimestamp(ts, timezone.utc)
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
    )


def parse_iso(raw: str) -> float | None:
    """Epoch seconds for an ISO-8601 string; naive values are taken as UTC."""
    text = (raw or "").strip()
    if not text:
        return None
    if text.endswith("Z") or text.endswith("z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def resolve_event_ts(raw: str, now: float | None = None) -> float | None:
    """When to credit an ``agent.activity`` event, or None to skip it.

    Parseable and within TIMESTAMP_SKEW_S of the backend clock: the event's
    own time (vendor logs stamp a few seconds before we read them).
    Parseable but outside that window: None — a replayed transcript is
    history (backfill covers it) and must not open an interval "now".
    Unparseable (the Stop-hook path sends ""): the backend clock.
    """
    wall = time.time() if now is None else now
    parsed = parse_iso(raw)
    if parsed is None:
        return wall
    if abs(parsed - wall) > TIMESTAMP_SKEW_S:
        return None
    return parsed


@dataclass
class _OpenInterval:
    row_id: int
    started_at: float
    last_seen_at: float
    persisted_at: float  # last_seen_at value currently on disk


_Span = tuple[float, float]


def _union(spans: list[_Span]) -> list[_Span]:
    """Merge overlapping/touching spans; result is sorted and disjoint."""
    merged: list[_Span] = []
    for start, end in sorted(spans):
        if end <= start:
            continue
        if merged and start <= merged[-1][1]:
            if end > merged[-1][1]:
                merged[-1] = (merged[-1][0], end)
        else:
            merged.append((start, end))
    return merged


def _intersect(a: list[_Span], b: list[_Span]) -> list[_Span]:
    """Intersection of two sorted disjoint span lists."""
    out: list[_Span] = []
    i = j = 0
    while i < len(a) and j < len(b):
        start = max(a[i][0], b[j][0])
        end = min(a[i][1], b[j][1])
        if end > start:
            out.append((start, end))
        if a[i][1] < b[j][1]:
            i += 1
        else:
            j += 1
    return out


def _clip(spans: list[_Span], lo: float, hi: float) -> list[_Span]:
    out: list[_Span] = []
    for start, end in spans:
        s, e = max(start, lo), min(end, hi)
        if e > s:
            out.append((s, e))
    return out


def _seconds(spans: list[_Span]) -> int:
    return int(round(sum(end - start for start, end in spans)))


def _transcript_intervals(path: Path, cutoff: float) -> list[_Span]:
    """Agent intervals from one Claude transcript: every ``assistant`` record's
    timestamp is a beat, ``stop_reason == 'end_turn'`` closes at that beat,
    a gap over AGENT_GAP_S splits. ``user`` records are ignored (the CLI
    writes them; they do not date a keystroke). Records before ``cutoff``
    are skipped."""
    spans: list[_Span] = []
    start: float | None = None
    last = 0.0
    try:
        fh = path.open(encoding="utf-8")
    except OSError:
        return spans
    with fh:
        for raw in fh:
            if '"assistant"' not in raw:
                continue  # cheap prefilter; the parse below is authoritative
            try:
                rec = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if rec.get("type") != "assistant":
                continue
            ts = parse_iso(str(rec.get("timestamp") or ""))
            if ts is None or ts < cutoff:
                continue
            if start is None:
                start = last = ts
            elif ts < last:
                continue  # out of order; keep the walk monotonic
            elif ts - last > AGENT_GAP_S:
                spans.append((start, last))
                start = last = ts
            else:
                last = ts
            if str((rec.get("message") or {}).get("stop_reason") or "") == "end_turn":
                spans.append((start, last))
                start = None
    if start is not None:
        spans.append((start, last))
    return spans


class DevTimeStore:
    """Heartbeat/interval engine over the per-workspace databases.

    ``tz`` fixes the day-bucket timezone (tests); None means the machine's
    local zone, which is what the panel shows. ``resolve_pane`` maps the id
    an event arrives under to the id the pane answers to now (a pane rebuilt
    around a live PTY has a newer one); the event adapters apply it so both
    ids accrue to one row set.
    """

    def __init__(
        self,
        databases: WorkspaceDatabases | None = None,
        *,
        tz: tzinfo | None = None,
        resolve_pane: Callable[[str], str] | None = None,
    ) -> None:
        self._databases = databases or WorkspaceDatabases()
        self._tz = tz
        self._resolve_pane = resolve_pane or (lambda pane_id: pane_id)
        self._input_error_logged = False
        self._lock = RLock()
        self._ready: set[str] = set()  # db paths whose schema + startup close ran
        self._open: dict[tuple[str, str, str], _OpenInterval] = {}
        # canonical workspace -> the spelling the frontend uses for it, so a
        # broadcast we originate names the workspace the way the panel does.
        self._labels: dict[str, str] = {}
        self._canonical: dict[str, str] = {}  # spelling -> canonical (cached: hot path)
        self._last_broadcast: dict[str, float] = {}
        # Backfill: one dedicated worker (never the shared default executor —
        # a multi-MB transcript scan must not starve the other stores), one
        # attempt per workspace per process, tasks held so they are not GC'd.
        self._backfill_executor: ThreadPoolExecutor | None = None
        self._backfill_started: set[str] = set()
        self._backfill_tasks: set[asyncio.Task[None]] = set()

    # ── Database access ──────────────────────────────────────────────

    def _key_ws(self, workspace_path: str) -> str:
        """In-memory key: one spelling per workspace, like WorkspaceDatabases."""
        if not workspace_path:
            return ""
        key = self._canonical.get(workspace_path)
        if key is None:
            key = os.path.realpath(os.path.abspath(workspace_path))
            self._canonical[workspace_path] = key
        return key

    def _db(self, workspace_path: str, *, create: bool):
        if create:
            db = self._databases.get(workspace_path)
        else:
            db = self._databases.peek(workspace_path)
        if db is None:
            return None
        key = str(db.path)
        if key not in self._ready:
            db.migrate(_COMPONENT, 1, _create_schema)
            # Rows left open by a previous backend lifetime end at their
            # last persisted heartbeat (at most BEAT_PERSIST_S of loss).
            with db.transaction() as cur:
                cur.execute("UPDATE dev_time_intervals SET closed = 1 WHERE closed = 0")
            self._ready.add(key)
        return db

    # ── Heartbeats ───────────────────────────────────────────────────

    def beat(
        self, workspace_path: str, pane_id: str, source: str, ts: float | None = None
    ) -> bool:
        """Record one heartbeat. Returns True when an interval opened or
        closed (a transition the UI should hear about immediately)."""
        gap = _GAP_BY_SOURCE.get(source)
        if gap is None or not pane_id:
            return False
        now = time.time() if ts is None else ts
        ws = self._key_ws(workspace_path)
        key = (ws, pane_id, source)
        with self._lock:
            open_iv = self._open.get(key)
            if open_iv is not None:
                if now <= open_iv.last_seen_at:
                    return False  # out-of-order or duplicate; nothing new
                if now - open_iv.last_seen_at <= gap:
                    # The common keystroke: no database handle needed.
                    open_iv.last_seen_at = now
                    if now - open_iv.persisted_at >= BEAT_PERSIST_S:
                        db = self._db(workspace_path, create=True)
                        if db is not None:
                            self._persist_last_seen(db, open_iv, closed=False)
                    return False
            db = self._db(workspace_path, create=True)
            if db is None:
                return False
            self._labels[ws] = workspace_path
            if open_iv is not None:
                self._close_locked(db, key, open_iv, open_iv.last_seen_at)
            with db.transaction() as cur:
                cur.execute(
                    "INSERT INTO dev_time_intervals"
                    " (pane_id, source, started_at, last_seen_at, closed)"
                    " VALUES (?, ?, ?, ?, 0)",
                    (pane_id, source, _iso(now), _iso(now)),
                )
                row_id = int(cur.lastrowid)
            self._open[key] = _OpenInterval(row_id, now, now, now)
            return True

    def close(
        self, workspace_path: str, pane_id: str, source: str, ts: float | None = None
    ) -> bool:
        """Close the open interval of (pane, source), if any. ``ts`` (the
        closing event's time) becomes the end when it lies within the gap
        after the last heartbeat. Returns True when something closed."""
        gap = _GAP_BY_SOURCE.get(source)
        if gap is None:
            return False
        key = (self._key_ws(workspace_path), pane_id, source)
        with self._lock:
            open_iv = self._open.get(key)
            if open_iv is None:
                return False
            db = self._db(workspace_path, create=True)
            if db is None:
                self._open.pop(key, None)
                return False
            end = open_iv.last_seen_at
            if ts is not None and end < ts <= end + gap:
                end = ts
            self._close_locked(db, key, open_iv, end)
            return True

    def close_pane(self, workspace_path: str, pane_id: str, ts: float | None = None) -> bool:
        closed = False
        for source in (SOURCE_HUMAN, SOURCE_AGENT):
            closed = self.close(workspace_path, pane_id, source, ts) or closed
        return closed

    def _close_locked(
        self, db, key: tuple[str, str, str], open_iv: _OpenInterval, end: float
    ) -> None:
        open_iv.last_seen_at = max(end, open_iv.started_at)
        self._persist_last_seen(db, open_iv, closed=True)
        self._open.pop(key, None)

    @staticmethod
    def _persist_last_seen(db, open_iv: _OpenInterval, *, closed: bool) -> None:
        try:
            with db.transaction() as cur:
                cur.execute(
                    "UPDATE dev_time_intervals SET last_seen_at = ?, closed = ?"
                    " WHERE id = ?",
                    (_iso(open_iv.last_seen_at), 1 if closed else 0, open_iv.row_id),
                )
        except sqlite3.Error as err:
            log.warning("dev time persist failed at %s: %s", db.path, err)
            return
        open_iv.persisted_at = open_iv.last_seen_at

    def sweep_stale(self, now: float | None = None) -> list[str]:
        """Close open intervals whose last heartbeat is older than their gap.

        Nothing else would: a pane the user walked away from sends no more
        events, so without this ``active`` would stay true (and the panel
        would keep ticking) until the next keystroke. Returns the workspace
        paths (as given at beat time) that had something to close.
        """
        wall = time.time() if now is None else now
        touched: list[str] = []
        with self._lock:
            for key, open_iv in list(self._open.items()):
                if wall - open_iv.last_seen_at <= _GAP_BY_SOURCE[key[2]]:
                    continue
                label = self._labels.get(key[0], key[0])
                db = self._db(label, create=True)
                if db is None:
                    self._open.pop(key, None)
                    continue
                self._close_locked(db, key, open_iv, open_iv.last_seen_at)
                if label not in touched:
                    touched.append(label)
        return touched

    def shutdown(self) -> None:
        """Close every open interval at its in-memory last heartbeat so a
        restart loses nothing (the startup close then finds no open rows)."""
        with self._lock:
            for key, open_iv in list(self._open.items()):
                db = self._db(self._labels.get(key[0], key[0]), create=True)
                if db is None:
                    self._open.pop(key, None)
                    continue
                self._close_locked(db, key, open_iv, open_iv.last_seen_at)
            if self._backfill_executor is not None:
                self._backfill_executor.shutdown(wait=False)
                self._backfill_executor = None

    # ── Event adapters (one call per wiring site) ────────────────────

    def _current(self, pane_id: str) -> str:
        return self._resolve_pane(pane_id) or pane_id

    def human_input(self, workspace_path: str, pane_id: str) -> bool:
        """A keyboard ``terminal.input`` frame reached ``pane_id``. True means
        broadcast ``devtime.changed`` now. Never raises: this sits on the
        keystroke path, so a failing store logs once and stays quiet."""
        if not pane_id:
            return False
        try:
            pane_id = self._current(pane_id)
            transition = self.beat(workspace_path, pane_id, SOURCE_HUMAN)
            return self.should_broadcast(workspace_path, transition)
        except Exception as err:  # noqa: BLE001
            if not self._input_error_logged:
                self._input_error_logged = True
                log.debug("dev time human beat failed (further failures muted): %s", err)
            return False

    def agent_event(
        self, workspace_path: str, pane_id: str, event_type: str, timestamp: str
    ) -> bool:
        """An ``agent.activity`` event is about to be broadcast. True means
        broadcast ``devtime.changed`` now."""
        if not pane_id:
            return False  # attributed to the workspace only; nothing to credit
        ts = resolve_event_ts(timestamp)
        if ts is None:
            return False  # replayed history: not "now", not ours to credit
        pane_id = self._current(pane_id)
        if event_type == "turn_complete":
            transition = self.close(workspace_path, pane_id, SOURCE_AGENT, ts)
        elif event_type == "agent_active":
            transition = self.beat(workspace_path, pane_id, SOURCE_AGENT, ts)
        else:
            return False
        return self.should_broadcast(workspace_path, transition)

    def pane_removed(self, pane_id: str, ts: float | None = None) -> list[str]:
        """The pane's record is going away: close both sources wherever it
        was beating. Returns the workspace paths to broadcast for."""
        touched: list[str] = []
        pane_id = self._current(pane_id)
        with self._lock:
            for ws in {k[0] for k in self._open if k[1] == pane_id}:
                label = self._labels.get(ws, ws)
                if self.close_pane(label, pane_id, ts):
                    self.should_broadcast(label, True)
                    touched.append(label)
        return touched

    async def stale_sweeper(self, on_change, interval_s: float = CHANGED_THROTTLE_S) -> None:
        """Run ``sweep_stale`` every ``interval_s``; ``on_change(workspace_path)``
        is awaited for each workspace that transitioned to inactive."""
        while True:
            await asyncio.sleep(interval_s)
            try:
                for label in self.sweep_stale():
                    self.should_broadcast(label, True)
                    await on_change(label)
            except Exception as err:  # noqa: BLE001 — the sweeper must survive
                log.warning("dev time stale sweep failed: %s", err)

    # ── Broadcast throttle ───────────────────────────────────────────

    def should_broadcast(
        self, workspace_path: str, transition: bool, now: float | None = None
    ) -> bool:
        """Throttle devtime.changed: always on a transition, otherwise at
        most once per CHANGED_THROTTLE_S per workspace."""
        wall = time.time() if now is None else now
        ws = self._key_ws(workspace_path)
        with self._lock:
            last = self._last_broadcast.get(ws)
            if transition or last is None or wall - last >= CHANGED_THROTTLE_S:
                self._last_broadcast[ws] = wall
                return True
            return False

    # ── Reset ────────────────────────────────────────────────────────

    def reset(self, workspace_path: str) -> None:
        ws = self._key_ws(workspace_path)
        with self._lock:
            for key in [k for k in self._open if k[0] == ws]:
                self._open.pop(key, None)
            db = self._db(workspace_path, create=False)
            if db is None:
                return
            with db.transaction() as cur:
                cur.execute("DELETE FROM dev_time_intervals")
                cur.execute("DELETE FROM kv WHERE key = ?", (BACKFILL_MARKER_KEY,))
            self._backfill_started.discard(ws)
            self._last_broadcast.pop(ws, None)

    # ── Transcript backfill (Claude only) ────────────────────────────

    def backfill_pending(self, workspace_path: str) -> bool:
        """True when this workspace has never been backfilled (no marker)
        and no attempt is in flight in this process."""
        ws = self._key_ws(workspace_path)
        with self._lock:
            if not ws or ws in self._backfill_started:
                return False
            db = self._db(workspace_path, create=False)
            if db is None:
                # No database yet: nothing recorded, and a backfill would be
                # the first writer. Treat as pending; backfill_claude creates it.
                return True
            return db.kv_get(BACKFILL_MARKER_KEY) is None

    def backfill_claude(
        self,
        workspace_path: str,
        now: float | None = None,
        *,
        session_files: list[Path] | None = None,
    ) -> int:
        """Replay this workspace's Claude transcripts (last BACKFILL_DAYS)
        through the agent gap engine and store the result as closed
        ``backfill`` rows. Idempotent via the kv marker. Returns the number
        of rows inserted. Blocking: run it off the event loop.
        """
        wall = time.time() if now is None else now
        ws = self._key_ws(workspace_path)
        with self._lock:
            db = self._db(workspace_path, create=True)
            if db is None:
                return 0
            if db.kv_get(BACKFILL_MARKER_KEY) is not None:
                return 0
            self._backfill_started.add(ws)
        if session_files is None:
            # Late import: the vendor module is heavy and app.py imports us early.
            from .cli_vendors.claude import ClaudeLogReader

            session_files = ClaudeLogReader().own_session_files(workspace_path)
        cutoff = wall - BACKFILL_DAYS * 86400
        rows: list[tuple[str, float, float]] = []
        for path in session_files:
            try:
                if path.stat().st_mtime < cutoff:
                    continue  # nothing in it can be newer than the cutoff
            except OSError:
                continue
            # The reader keys sessions by file stem too (Claude names the
            # transcript after its sessionId).
            pane_id = BACKFILL_PANE_PREFIX + path.stem
            rows.extend(
                (pane_id, s, e) for s, e in _transcript_intervals(path, cutoff) if e > s
            )
        with self._lock:
            with db.transaction() as cur:
                if db.kv_get(BACKFILL_MARKER_KEY) is not None:
                    return 0  # raced with another writer; keep theirs
                cur.executemany(
                    "INSERT INTO dev_time_intervals"
                    " (pane_id, source, started_at, last_seen_at, closed)"
                    " VALUES (?, ?, ?, ?, 1)",
                    [(pane_id, SOURCE_BACKFILL, _iso(s), _iso(e)) for pane_id, s, e in rows],
                )
                # Same transaction as the rows (kv_set joins the open one):
                # a crash between them would replay the import.
                db.kv_set(BACKFILL_MARKER_KEY, _iso(wall), now=int(wall))
        return len(rows)

    def start_backfill(
        self,
        workspace_path: str,
        on_change: Callable[[str], Coroutine[Any, Any, None]],
    ) -> "asyncio.Task[None] | None":
        """Kick off the one-time backfill for ``workspace_path`` on the
        dedicated worker if it is still pending; ``on_change(workspace_path)``
        is awaited afterwards when rows were added. Returns the task, or
        None when nothing needed doing."""
        if not self.backfill_pending(workspace_path):
            return None
        with self._lock:
            self._backfill_started.add(self._key_ws(workspace_path))
            if self._backfill_executor is None:
                self._backfill_executor = ThreadPoolExecutor(
                    max_workers=1, thread_name_prefix="devtime-backfill"
                )
            executor = self._backfill_executor

        async def run() -> None:
            try:
                loop = asyncio.get_running_loop()
                added = await loop.run_in_executor(
                    executor, self.backfill_claude, workspace_path
                )
                if added:
                    self.should_broadcast(workspace_path, True)
                    await on_change(workspace_path)
            except Exception as err:  # noqa: BLE001
                log.warning("dev time backfill failed for %s: %s", workspace_path, err)

        task = asyncio.create_task(run())
        self._backfill_tasks.add(task)
        task.add_done_callback(self._backfill_tasks.discard)
        return task

    # ── Snapshot ─────────────────────────────────────────────────────

    def _day_start(self, day: date) -> float:
        if self._tz is None:
            return datetime.combine(day, dtime.min).timestamp()  # local
        return datetime.combine(day, dtime.min, tzinfo=self._tz).timestamp()

    def _day_of(self, ts: float) -> date:
        if self._tz is None:
            return datetime.fromtimestamp(ts).date()
        return datetime.fromtimestamp(ts, self._tz).date()

    def _load_intervals(self, workspace_path: str) -> list[tuple[str, str, float, float]]:
        """(pane_id, source, start, end) for every interval; open rows take
        their end from memory."""
        ws = self._key_ws(workspace_path)
        db = self._db(workspace_path, create=False)
        if db is None:
            return []
        try:
            with db.transaction() as cur:
                rows = cur.execute(
                    "SELECT id, pane_id, source, started_at, last_seen_at"
                    " FROM dev_time_intervals"
                ).fetchall()
        except sqlite3.Error as err:
            log.warning("dev time read failed for %s: %s", workspace_path, err)
            return []
        live = {iv.row_id: iv for k, iv in self._open.items() if k[0] == ws}
        out: list[tuple[str, str, float, float]] = []
        for row in rows:
            iv = live.get(int(row["id"]))
            if iv is not None:
                start, end = iv.started_at, iv.last_seen_at
            else:
                start = parse_iso(row["started_at"])
                end = parse_iso(row["last_seen_at"])
                if start is None or end is None:
                    continue
            out.append((str(row["pane_id"]), str(row["source"]), start, end))
        return out

    @staticmethod
    def _bucket(human: list[_Span], agent: list[_Span], lo: float, hi: float) -> dict[str, int]:
        h = _clip(human, lo, hi)
        a = _clip(agent, lo, hi)
        merged = _union(h + a)
        return {
            "merged_s": _seconds(merged),
            "human_s": _seconds(h),
            "agent_s": _seconds(a),
            "overlap_s": _seconds(_intersect(h, a)),
            # Clock time between the first and last activity in the window
            # (both ends already clipped); the idle share is 1 - merged/wall.
            "wall_s": int(round(merged[-1][1] - merged[0][0])) if merged else 0,
        }

    def snapshot(self, workspace_path: str, now: float | None = None) -> dict[str, Any]:
        wall = time.time() if now is None else now
        ws = self._key_ws(workspace_path)
        with self._lock:
            intervals = self._load_intervals(workspace_path)
            # An open interval past its gap is over even if the sweeper has
            # not closed it yet; it must not keep the panel ticking.
            open_keys = [
                k for k, iv in self._open.items()
                if k[0] == ws and wall - iv.last_seen_at <= _GAP_BY_SOURCE[k[2]]
            ]

        human = _union([(s, e) for _, src, s, e in intervals if src == SOURCE_HUMAN])
        agent = _union([(s, e) for _, src, s, e in intervals if src != SOURCE_HUMAN])
        today = self._day_of(wall)
        today_lo = self._day_start(today)
        tomorrow_lo = self._day_start(today + timedelta(days=1))
        totals = {
            "today": self._bucket(human, agent, today_lo, tomorrow_lo),
            "last7d": self._bucket(
                human, agent, self._day_start(today - timedelta(days=6)), tomorrow_lo
            ),
            "last30d": self._bucket(
                human, agent, self._day_start(today - timedelta(days=29)), tomorrow_lo
            ),
            "all": self._bucket(human, agent, float("-inf"), float("inf")),
        }

        by_day: list[dict[str, Any]] = []
        for offset in range(6, -1, -1):
            day = today - timedelta(days=offset)
            bucket = self._bucket(
                human, agent, self._day_start(day), self._day_start(day + timedelta(days=1))
            )
            by_day.append({
                "date": day.isoformat(),
                "merged_s": bucket["merged_s"],
                "human_s": bucket["human_s"],
                "agent_s": bucket["agent_s"],
            })

        per_pane: dict[str, list[_Span]] = {}
        for pane_id, _, s, e in intervals:
            if pane_id.startswith(BACKFILL_PANE_PREFIX):
                continue  # counted in the totals, but not a real pane
            per_pane.setdefault(pane_id, []).append((s, e))
        active_panes = {k[1] for k in open_keys}
        by_pane = [
            {
                "pane_id": pane_id,
                "today_s": _seconds(_clip(_union(spans), today_lo, tomorrow_lo)),
                "all_s": _seconds(_union(spans)),
                "active": pane_id in active_panes,
            }
            for pane_id, spans in per_pane.items()
        ]
        by_pane.sort(key=lambda item: (-item["all_s"], item["pane_id"]))

        open_sources = {k[2] for k in open_keys}
        active_sources = [s for s in (SOURCE_HUMAN, SOURCE_AGENT) if s in open_sources]
        return {
            "workspace_path": workspace_path or "",
            "gap_human_s": HUMAN_GAP_S,
            "gap_agent_s": AGENT_GAP_S,
            "active": bool(open_keys),
            "active_sources": active_sources,
            "totals": totals,
            "by_day": by_day,
            "by_pane": by_pane,
        }

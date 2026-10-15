"""SQLite persistence for Navide's in-process scheduler.

Two tables in the global ``navide.db``:

- ``scheduler_jobs`` — one row per job. The definition (schedule / action /
  policy) and the runtime ``state`` are stored as separate JSON columns so a
  state write never rewrites what the user configured.
- ``scheduler_runs`` — append-only run history, trimmed to the newest
  :data:`RUNS_PER_JOB` rows of a job on every append.
- ``scheduler_usage`` (schema v3) — dispatched runs of agent-owned jobs per
  local day. Kept apart from the run history because deleting a job deletes
  its runs, which would otherwise let an agent reset its own daily total.

Schema v2 adds ``owner`` (who created the job) and ``updated_by`` (who
last changed it) to ``scheduler_jobs``. Rows that predate v2 — and any written
by a downgraded build, which leaves ``owner`` NULL — read as the user's.

Every public method is a coroutine that runs its SQLite work through
``asyncio.to_thread``: the scheduler lives on the event loop, and a disk stall
there freezes every PTY reader and WebSocket send (the 2026-08-24 typing-latency
incident). The shared :class:`~.db.Database` connection is used as-is — no
second connection — per the single-writer premise in ``db.py``.
"""

from __future__ import annotations

import asyncio
import json
import re
import sqlite3
from typing import Any

from .db import Database

_COMPONENT = "scheduler"

#: Run-history rows kept per job; older rows are pruned on append.
RUNS_PER_JOB = 200
#: A run recorded while its message still waited (scheduler.outcome_of_send).
_QUEUED_DETAIL = re.compile(r"queued \([^)]*\)")

_JSON_COLUMNS = ("schedule", "action", "policy", "state")
#: The owner of a job saved before owners were recorded.
LEGACY_OWNER: dict[str, Any] = {"kind": "user", "legacy": True}


def _create_scheduler_schema(cur: sqlite3.Cursor) -> None:
    cur.execute(
        "CREATE TABLE scheduler_jobs ("
        " id TEXT PRIMARY KEY,"
        " name TEXT NOT NULL,"
        " enabled INTEGER NOT NULL,"
        " created_at INTEGER NOT NULL,"
        " updated_at INTEGER NOT NULL,"
        " schedule TEXT NOT NULL,"
        " action TEXT NOT NULL,"
        " policy TEXT NOT NULL,"
        " state TEXT NOT NULL)"
    )
    cur.execute(
        "CREATE TABLE scheduler_runs ("
        " id INTEGER PRIMARY KEY AUTOINCREMENT,"
        " job_id TEXT NOT NULL,"
        " started_at INTEGER NOT NULL,"
        " ended_at INTEGER,"
        " status TEXT NOT NULL,"
        " reason TEXT,"
        " detail TEXT)"
    )
    cur.execute("CREATE INDEX scheduler_runs_job ON scheduler_runs (job_id, id)")


def _add_owners(cur: sqlite3.Cursor) -> None:
    cur.execute("ALTER TABLE scheduler_jobs ADD COLUMN owner TEXT")
    cur.execute("ALTER TABLE scheduler_jobs ADD COLUMN updated_by TEXT")
    cur.execute("UPDATE scheduler_jobs SET owner = ?", (_dumps(LEGACY_OWNER),))


def _create_usage(cur: sqlite3.Cursor) -> None:
    cur.execute("CREATE TABLE scheduler_usage (day TEXT PRIMARY KEY, runs INTEGER NOT NULL)")


def _dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _loads_or(value: Any, default: Any) -> Any:
    try:
        loaded = json.loads(value)
    except (TypeError, ValueError):
        return default
    return loaded if isinstance(loaded, dict) else default


def _job_row(row: sqlite3.Row) -> dict[str, Any]:
    job: dict[str, Any] = {
        "id": row["id"],
        "name": row["name"],
        "enabled": bool(row["enabled"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }
    for column in _JSON_COLUMNS:
        try:
            job[column] = json.loads(row[column])
        except (TypeError, ValueError):
            job[column] = {}
    job["owner"] = _loads_or(row["owner"], dict(LEGACY_OWNER))
    job["updated_by"] = _loads_or(row["updated_by"], None)
    return job


def _run_row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "job_id": row["job_id"],
        "started_at": row["started_at"],
        "ended_at": row["ended_at"],
        "status": row["status"],
        "reason": row["reason"],
        "detail": row["detail"],
    }


class SchedulerStore:
    """Jobs and run history in the global database."""

    def __init__(self, db: Database) -> None:
        self.db = db
        db.migrate(_COMPONENT, 1, _create_scheduler_schema)
        db.migrate(_COMPONENT, 2, _add_owners)
        db.migrate(_COMPONENT, 3, _create_usage)

    # ── sync bodies (always called through to_thread) ────────────────────

    def _list_jobs(self) -> list[dict[str, Any]]:
        with self.db.transaction() as cur:
            rows = cur.execute("SELECT * FROM scheduler_jobs ORDER BY created_at, id").fetchall()
        return [_job_row(row) for row in rows]

    def _get_job(self, job_id: str) -> dict[str, Any] | None:
        with self.db.transaction() as cur:
            row = cur.execute("SELECT * FROM scheduler_jobs WHERE id = ?", (job_id,)).fetchone()
        return _job_row(row) if row is not None else None

    def _put_job(self, job: dict[str, Any]) -> None:
        with self.db.transaction() as cur:
            cur.execute(
                "INSERT INTO scheduler_jobs"
                " (id, name, enabled, created_at, updated_at, schedule, action, policy, state,"
                " owner, updated_by)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
                " ON CONFLICT(id) DO UPDATE SET"
                " name = excluded.name, enabled = excluded.enabled,"
                " updated_at = excluded.updated_at, schedule = excluded.schedule,"
                " action = excluded.action, policy = excluded.policy, state = excluded.state,"
                " owner = excluded.owner, updated_by = excluded.updated_by",
                (
                    job["id"], job["name"], int(bool(job["enabled"])),
                    job["created_at"], job["updated_at"],
                    *(_dumps(job[column]) for column in _JSON_COLUMNS),
                    _dumps(job.get("owner") or LEGACY_OWNER),
                    _dumps(job["updated_by"]) if job.get("updated_by") else None,
                ),
            )

    def _set_state(self, job_id: str, state: dict[str, Any]) -> bool:
        with self.db.transaction() as cur:
            cur.execute(
                "UPDATE scheduler_jobs SET state = ? WHERE id = ?", (_dumps(state), job_id)
            )
            return cur.rowcount > 0

    def _set_enabled(
        self, job_id: str, enabled: bool, state: dict[str, Any], now: int,
        updated_by: dict[str, Any] | None, owner: dict[str, Any] | None,
    ) -> bool:
        """``updated_by`` / ``owner`` left None keep their stored value: the
        scheduler's own disables (a once job's run, expiry) are nobody's edit."""
        with self.db.transaction() as cur:
            cur.execute(
                "UPDATE scheduler_jobs SET enabled = ?, state = ?, updated_at = ?,"
                " updated_by = COALESCE(?, updated_by), owner = COALESCE(?, owner)"
                " WHERE id = ?",
                (
                    int(enabled), _dumps(state), now,
                    _dumps(updated_by) if updated_by else None,
                    _dumps(owner) if owner else None,
                    job_id,
                ),
            )
            return cur.rowcount > 0

    def _delete_job(self, job_id: str) -> bool:
        with self.db.transaction() as cur:
            cur.execute("DELETE FROM scheduler_jobs WHERE id = ?", (job_id,))
            removed = cur.rowcount > 0
            cur.execute("DELETE FROM scheduler_runs WHERE job_id = ?", (job_id,))
        return removed

    def _append_run(self, job_id: str, run: dict[str, Any]) -> None:
        with self.db.transaction() as cur:
            cur.execute(
                "INSERT INTO scheduler_runs"
                " (job_id, started_at, ended_at, status, reason, detail)"
                " VALUES (?, ?, ?, ?, ?, ?)",
                (
                    job_id, run["started_at"], run.get("ended_at"), run["status"],
                    run.get("reason"), run.get("detail"),
                ),
            )
            cur.execute(
                "DELETE FROM scheduler_runs WHERE job_id = ? AND id NOT IN ("
                " SELECT id FROM scheduler_runs WHERE job_id = ? ORDER BY id DESC LIMIT ?)",
                (job_id, job_id, RUNS_PER_JOB),
            )

    def _resolve_queued_run(self, job_id: str, status: str, reason: str | None, suffix: str) -> bool:
        """Finish the newest dispatched run if it is still the bare "queued (...)"
        record: append how its message ended, and take that status."""
        with self.db.transaction() as cur:
            row = cur.execute(
                "SELECT id, status, detail FROM scheduler_runs WHERE job_id = ? AND status != 'skipped'"
                " ORDER BY id DESC LIMIT 1",
                (job_id,),
            ).fetchone()
            if row is None or row["status"] != "ok" or not _QUEUED_DETAIL.fullmatch(str(row["detail"] or "")):
                return False
            cur.execute(
                "UPDATE scheduler_runs SET status = ?, reason = ?, detail = ? WHERE id = ?",
                (status, reason, f"{row['detail']}, {suffix}", row["id"]),
            )
            return True

    def _list_runs(self, job_id: str, limit: int) -> list[dict[str, Any]]:
        with self.db.transaction() as cur:
            rows = cur.execute(
                "SELECT * FROM scheduler_runs WHERE job_id = ? ORDER BY id DESC LIMIT ?",
                (job_id, limit),
            ).fetchall()
        return [_run_row(row) for row in rows]

    def _count_dispatched_since(self, job_id: str, since: int) -> int:
        with self.db.transaction() as cur:
            row = cur.execute(
                "SELECT COUNT(*) FROM scheduler_runs"
                " WHERE job_id = ? AND started_at >= ? AND status IN ('ok', 'error')",
                (job_id, since),
            ).fetchone()
        return int(row[0])

    def _usage(self, day: str) -> int:
        with self.db.transaction() as cur:
            row = cur.execute("SELECT runs FROM scheduler_usage WHERE day = ?", (day,)).fetchone()
        return int(row[0]) if row is not None else 0

    def _add_usage(self, day: str) -> None:
        with self.db.transaction() as cur:
            # Only today's row is ever read, so older days are dropped here.
            cur.execute("DELETE FROM scheduler_usage WHERE day <> ?", (day,))
            cur.execute(
                "INSERT INTO scheduler_usage (day, runs) VALUES (?, 1)"
                " ON CONFLICT(day) DO UPDATE SET runs = runs + 1",
                (day,),
            )

    # ── async API ────────────────────────────────────────────────────────

    async def list_jobs(self) -> list[dict[str, Any]]:
        return await asyncio.to_thread(self._list_jobs)

    async def get_job(self, job_id: str) -> dict[str, Any] | None:
        return await asyncio.to_thread(self._get_job, job_id)

    async def put_job(self, job: dict[str, Any]) -> None:
        await asyncio.to_thread(self._put_job, job)

    async def set_state(self, job_id: str, state: dict[str, Any]) -> bool:
        return await asyncio.to_thread(self._set_state, job_id, state)

    async def set_enabled(
        self, job_id: str, enabled: bool, state: dict[str, Any], now: int,
        *, updated_by: dict[str, Any] | None = None, owner: dict[str, Any] | None = None,
    ) -> bool:
        return await asyncio.to_thread(
            self._set_enabled, job_id, enabled, state, now, updated_by, owner
        )

    async def delete_job(self, job_id: str) -> bool:
        return await asyncio.to_thread(self._delete_job, job_id)

    async def append_run(self, job_id: str, run: dict[str, Any]) -> None:
        await asyncio.to_thread(self._append_run, job_id, run)

    async def resolve_queued_run(self, job_id: str, status: str, reason: str | None, suffix: str) -> bool:
        return await asyncio.to_thread(self._resolve_queued_run, job_id, status, reason, suffix)

    async def list_runs(self, job_id: str, limit: int) -> list[dict[str, Any]]:
        return await asyncio.to_thread(self._list_runs, job_id, limit)

    async def count_dispatched_since(self, job_id: str, since: int) -> int:
        return await asyncio.to_thread(self._count_dispatched_since, job_id, since)

    async def usage(self, day: str) -> int:
        return await asyncio.to_thread(self._usage, day)

    async def add_usage(self, day: str) -> None:
        await asyncio.to_thread(self._add_usage, day)

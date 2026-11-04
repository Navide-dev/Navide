"""Webhook trigger records in the global ``navide.db``.

Tables of their own, so nothing here changes an existing one:

- ``webhook_triggers`` — one row per trigger. A key is shown once and kept only
  as its SHA-256: a 256-bit random value needs no slow hash, and a stored hash
  means no secret store is involved at all. A deleted row stays, without its
  hash, because a run it started can be resumed and has to stay tainted.
- ``webhook_events`` — the audit trail. Time, outcome, status, size and the
  body's hash: never a key, a header, a query string or a body.
- ``webhook_usage`` — started runs per trigger per day, apart from the audit
  rows, which are trimmed.
- ``webhook_runs``, ``webhook_run_panes`` — the runs triggers started and their
  panes, kept after a run so a pane resumed later still starts without a bypass.

None of this is a sync scope or part of a settings bundle, and a trigger lives
outside the pipeline definition, so exporting a pipeline carries none of it.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import time
from collections.abc import Iterable
from typing import Any

from .db import Database

_COMPONENT = "webhook"
_SETTINGS_KEY = "webhook.listener"

KINDS = ("webhook", "form", "github")
#: A delivery seen again inside this window is not run again.
DUPLICATE_WINDOW_S = 24 * 60 * 60
DEFAULT_PER_MINUTE = 6
DEFAULT_PER_DAY = 20
MAX_PER_MINUTE = 60
MAX_PER_DAY = 500
DEFAULT_APPROVAL_TIMEOUT_MIN = 30
MIN_APPROVAL_TIMEOUT_MIN = 5
MAX_APPROVAL_TIMEOUT_MIN = 240
#: Audit rows kept per trigger; older rows are pruned on write.
EVENTS_PER_TRIGGER = 1000

_TOKEN_PREFIX = "nvwh_"
_HOSTNAME = re.compile(r"^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$")
_LOOPBACK_NAMES = frozenset({"localhost", "127.0.0.1", "::1"})
_EVENT_FIELDS = ("trigger_id", "ts", "outcome", "status", "size", "body_sha256", "count", "detail")


class WebhookInvalid(ValueError):
    """Settings the store refuses."""


class WebhookNotFound(LookupError):
    """No live trigger has this id."""


def _create_schema(cur: sqlite3.Cursor) -> None:
    cur.execute(
        "CREATE TABLE webhook_triggers ("
        " id TEXT PRIMARY KEY,"
        " name TEXT NOT NULL,"
        " workspace TEXT NOT NULL,"
        " pipeline_id TEXT NOT NULL,"
        " kind TEXT NOT NULL,"
        " enabled INTEGER NOT NULL,"
        " token_hash TEXT NOT NULL,"
        " per_minute INTEGER NOT NULL,"
        " per_day INTEGER NOT NULL,"
        " no_gate_ack INTEGER NOT NULL,"
        " created_at INTEGER NOT NULL,"
        " updated_at INTEGER NOT NULL,"
        " deleted_at INTEGER)"
    )
    cur.execute("CREATE INDEX webhook_triggers_pipeline ON webhook_triggers (pipeline_id)")
    cur.execute(
        "CREATE TABLE webhook_events ("
        " id INTEGER PRIMARY KEY AUTOINCREMENT,"
        " trigger_id TEXT NOT NULL,"
        " ts INTEGER NOT NULL,"
        " outcome TEXT NOT NULL,"
        " status INTEGER NOT NULL,"
        " size INTEGER,"
        " body_sha256 TEXT,"
        " count INTEGER NOT NULL DEFAULT 1,"
        " detail TEXT)"
    )
    cur.execute("CREATE INDEX webhook_events_trigger ON webhook_events (trigger_id, id)")
    cur.execute(
        "CREATE TABLE webhook_usage ("
        " trigger_id TEXT NOT NULL,"
        " day TEXT NOT NULL,"
        " runs INTEGER NOT NULL,"
        " PRIMARY KEY (trigger_id, day))"
    )


def _add_runs(cur: sqlite3.Cursor) -> None:
    cur.execute("ALTER TABLE webhook_triggers ADD COLUMN unattended INTEGER NOT NULL DEFAULT 0")
    cur.execute("ALTER TABLE webhook_triggers ADD COLUMN approval_timeout_min INTEGER NOT NULL DEFAULT 30")
    cur.execute(
        "CREATE TABLE webhook_runs ("
        " id TEXT PRIMARY KEY,"
        " trigger_id TEXT NOT NULL,"
        " workspace TEXT NOT NULL,"
        " project_id TEXT NOT NULL,"
        " pipeline_id TEXT NOT NULL,"
        " state TEXT NOT NULL,"
        " unattended INTEGER NOT NULL,"
        " started_at INTEGER NOT NULL,"
        " ended_at INTEGER)"
    )
    cur.execute("CREATE INDEX webhook_runs_state ON webhook_runs (state)")
    cur.execute(
        "CREATE TABLE webhook_run_panes ("
        " pane_id TEXT PRIMARY KEY,"
        " run_id TEXT NOT NULL,"
        " unattended INTEGER NOT NULL)"
    )


def _add_run_sessions(cur: sqlite3.Cursor) -> None:
    cur.execute(
        "CREATE TABLE webhook_run_sessions ("
        " session_id TEXT PRIMARY KEY,"
        " agent_key TEXT NOT NULL,"
        " run_id TEXT NOT NULL,"
        " unattended INTEGER NOT NULL,"
        " pane_id TEXT NOT NULL)"
    )


def _add_github(cur: sqlite3.Cursor) -> None:
    cur.execute("ALTER TABLE webhook_triggers ADD COLUMN github_secret BLOB")
    cur.execute("ALTER TABLE webhook_triggers ADD COLUMN github_events TEXT NOT NULL DEFAULT '[]'")
    cur.execute(
        "CREATE TABLE webhook_seen ("
        " trigger_id TEXT NOT NULL,"
        " body_sha256 TEXT NOT NULL,"
        " seen_at INTEGER NOT NULL,"
        " PRIMARY KEY (trigger_id, body_sha256))"
    )


def _add_forms(cur: sqlite3.Cursor) -> None:
    cur.execute("ALTER TABLE webhook_triggers ADD COLUMN form_fields TEXT NOT NULL DEFAULT '[]'")
    cur.execute("ALTER TABLE webhook_triggers ADD COLUMN form_public INTEGER NOT NULL DEFAULT 0")


def new_token() -> str:
    return _TOKEN_PREFIX + secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def key_matches(record: dict[str, Any], token: str) -> bool:
    """Constant-time check of a presented key against a snapshot record."""
    expected = record.get("token_hash") or ""
    if not expected or not token:
        return False
    return hmac.compare_digest(expected, hash_token(token))


def _public(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "workspace": row["workspace"],
        "pipeline_id": row["pipeline_id"],
        "kind": row["kind"],
        "enabled": bool(row["enabled"]),
        "per_minute": row["per_minute"],
        "per_day": row["per_day"],
        "no_gate_ack": bool(row["no_gate_ack"]),
        "unattended": bool(row["unattended"]),
        "approval_timeout_min": row["approval_timeout_min"],
        "github_events": json.loads(row["github_events"]),
        "form_fields": json.loads(row["form_fields"]),
        "form_public": bool(row["form_public"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _check(
    name: str, workspace: str, pipeline_id: str, kind: str, per_minute: int, per_day: int, approval_timeout_min: int,
) -> None:
    if not name.strip():
        raise WebhookInvalid("a trigger needs a name")
    if not os.path.isabs(workspace or ""):
        raise WebhookInvalid("a trigger needs an absolute workspace path")
    if not pipeline_id.strip():
        raise WebhookInvalid("a trigger needs a pipeline")
    if kind not in KINDS:
        raise WebhookInvalid(f"unknown trigger kind {kind!r}")
    if not 1 <= per_minute <= MAX_PER_MINUTE:
        raise WebhookInvalid(f"per_minute must be 1..{MAX_PER_MINUTE}")
    if not 1 <= per_day <= MAX_PER_DAY:
        raise WebhookInvalid(f"per_day must be 1..{MAX_PER_DAY}")
    if not MIN_APPROVAL_TIMEOUT_MIN <= approval_timeout_min <= MAX_APPROVAL_TIMEOUT_MIN:
        raise WebhookInvalid(f"approval_timeout_min must be {MIN_APPROVAL_TIMEOUT_MIN}..{MAX_APPROVAL_TIMEOUT_MIN}")


class WebhookStore:
    """Synchronous: every caller on the event loop goes through to_thread."""

    def __init__(self, db: Database) -> None:
        self.db = db
        db.migrate(_COMPONENT, 1, _create_schema)
        db.migrate(_COMPONENT, 2, _add_runs)
        db.migrate(_COMPONENT, 3, _add_github)
        db.migrate(_COMPONENT, 4, _add_forms)
        db.migrate(_COMPONENT, 5, _add_run_sessions)

    def create(
        self,
        *,
        name: str,
        workspace: str,
        pipeline_id: str,
        kind: str = "webhook",
        per_minute: int = DEFAULT_PER_MINUTE,
        per_day: int = DEFAULT_PER_DAY,
        no_gate_ack: bool = False,
        approval_timeout_min: int = DEFAULT_APPROVAL_TIMEOUT_MIN,
    ) -> tuple[dict[str, Any], str]:
        """A new, disabled trigger and its key, which is not stored."""
        _check(name, workspace, pipeline_id, kind, per_minute, per_day, approval_timeout_min)
        trigger_id, token, now = secrets.token_hex(16), new_token(), int(time.time())
        with self.db.transaction() as cur:
            cur.execute(
                "INSERT INTO webhook_triggers (id, name, workspace, pipeline_id, kind, enabled, token_hash,"
                " per_minute, per_day, no_gate_ack, approval_timeout_min, created_at, updated_at, deleted_at)"
                " VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, NULL)",
                (trigger_id, name.strip(), workspace, pipeline_id, kind, hash_token(token),
                 per_minute, per_day, int(no_gate_ack), approval_timeout_min, now, now),
            )
            row = cur.execute("SELECT * FROM webhook_triggers WHERE id = ?", (trigger_id,)).fetchone()
        return _public(row), token

    def list(self) -> list[dict[str, Any]]:
        with self.db.transaction() as cur:
            rows = cur.execute(
                "SELECT * FROM webhook_triggers WHERE deleted_at IS NULL ORDER BY created_at, id"
            ).fetchall()
        return [_public(row) for row in rows]

    def snapshot(self) -> dict[str, dict[str, Any]]:
        """What the listener needs in memory, keyed by id: enabled, live
        triggers only, so a disabled one is simply unknown to it."""
        with self.db.transaction() as cur:
            rows = cur.execute(
                "SELECT * FROM webhook_triggers WHERE enabled = 1 AND deleted_at IS NULL"
            ).fetchall()
        return {
            row["id"]: {**_public(row), "token_hash": row["token_hash"], "github_secret": row["github_secret"]}
            for row in rows
        }

    def _update_live(self, trigger_id: str, assignment: str, *values: Any) -> None:
        with self.db.transaction() as cur:
            done = cur.execute(
                f"UPDATE webhook_triggers SET {assignment}, updated_at = ? WHERE id = ? AND deleted_at IS NULL",
                (*values, int(time.time()), trigger_id),
            )
            if done.rowcount != 1:
                raise WebhookNotFound(trigger_id)

    def set_enabled(self, trigger_id: str, enabled: bool) -> None:
        self._update_live(trigger_id, "enabled = ?", int(enabled))

    def set_github(self, trigger_id: str, secret: bytes, events: list[str]) -> None:
        """A GitHub trigger's ciphertext and the events it runs on. Its key
        hash stays empty, so the Bearer path can never match it."""
        self._update_live(trigger_id, "token_hash = '', github_secret = ?, github_events = ?", secret, json.dumps(events))

    def set_form(self, trigger_id: str, fields: list[dict[str, Any]], public: bool) -> None:
        self._update_live(trigger_id, "form_fields = ?, form_public = ?", json.dumps(fields), int(public))

    def set_github_secret(self, trigger_id: str, secret: bytes) -> None:
        self._update_live(trigger_id, "github_secret = ?", secret)

    def seen_recently(self, trigger_id: str, body_sha256: str, now: int) -> bool:
        with self.db.transaction() as cur:
            cur.execute("DELETE FROM webhook_seen WHERE seen_at <= ?", (now - DUPLICATE_WINDOW_S,))
            row = cur.execute(
                "SELECT 1 FROM webhook_seen WHERE trigger_id = ? AND body_sha256 = ?", (trigger_id, body_sha256)
            ).fetchone()
        return row is not None

    def mark_seen(self, trigger_id: str, body_sha256: str, now: int) -> None:
        with self.db.transaction() as cur:
            cur.execute(
                "INSERT OR REPLACE INTO webhook_seen (trigger_id, body_sha256, seen_at) VALUES (?, ?, ?)",
                (trigger_id, body_sha256, now),
            )

    def set_limits(self, trigger_id: str, per_minute: int, per_day: int, approval_timeout_min: int) -> None:
        current = next((t for t in self.list() if t["id"] == trigger_id), None)
        if current is None:
            raise WebhookNotFound(trigger_id)
        _check(current["name"], current["workspace"], current["pipeline_id"], current["kind"],
               per_minute, per_day, approval_timeout_min)
        self._update_live(
            trigger_id, "per_minute = ?, per_day = ?, approval_timeout_min = ?",
            per_minute, per_day, approval_timeout_min,
        )

    def set_unattended(self, trigger_id: str, unattended: bool) -> None:
        self._update_live(trigger_id, "unattended = ?", int(unattended))

    def rotate(self, trigger_id: str) -> str:
        """A new key; the old one stops working at once."""
        token = new_token()
        self._update_live(trigger_id, "token_hash = ?", hash_token(token))
        return token

    def delete(self, trigger_id: str) -> None:
        """Soft: see the module docstring. The key's hash goes with it."""
        now = int(time.time())
        self._update_live(trigger_id, "enabled = 0, token_hash = '', github_secret = NULL, deleted_at = ?", now)

    def is_bound(self, pipeline_id: str) -> bool:
        """Whether a trigger was ever bound to this pipeline, deleted ones too."""
        with self.db.transaction() as cur:
            row = cur.execute(
                "SELECT 1 FROM webhook_triggers WHERE pipeline_id = ? LIMIT 1", (pipeline_id,)
            ).fetchone()
        return row is not None

    def count_run(self, trigger_id: str, day: str) -> int:
        with self.db.transaction() as cur:
            cur.execute(
                "INSERT INTO webhook_usage (trigger_id, day, runs) VALUES (?, ?, 1)"
                " ON CONFLICT (trigger_id, day) DO UPDATE SET runs = runs + 1",
                (trigger_id, day),
            )
            row = cur.execute(
                "SELECT runs FROM webhook_usage WHERE trigger_id = ? AND day = ?", (trigger_id, day)
            ).fetchone()
        return row["runs"]

    def runs_on(self, trigger_id: str, day: str) -> int:
        with self.db.transaction() as cur:
            row = cur.execute(
                "SELECT runs FROM webhook_usage WHERE trigger_id = ? AND day = ?", (trigger_id, day)
            ).fetchone()
        return row["runs"] if row else 0

    def record_events(self, events: list[dict[str, Any]]) -> None:
        for event in events:
            unknown = set(event) - set(_EVENT_FIELDS)
            if unknown:
                raise WebhookInvalid(f"audit field not defined: {sorted(unknown)}")
        with self.db.transaction() as cur:
            cur.executemany(
                "INSERT INTO webhook_events (trigger_id, ts, outcome, status, size, body_sha256, count, detail)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                [
                    (e["trigger_id"], e["ts"], e["outcome"], e["status"], e.get("size"),
                     e.get("body_sha256"), e.get("count", 1), e.get("detail"))
                    for e in events
                ],
            )
            for trigger_id in {e["trigger_id"] for e in events}:
                cur.execute(
                    "DELETE FROM webhook_events WHERE trigger_id = ? AND id NOT IN"
                    " (SELECT id FROM webhook_events WHERE trigger_id = ? ORDER BY id DESC LIMIT ?)",
                    (trigger_id, trigger_id, EVENTS_PER_TRIGGER),
                )

    def open_run(
        self, *, trigger_id: str, workspace: str, project_id: str, pipeline_id: str, unattended: bool,
    ) -> dict[str, Any]:
        run = {
            "id": secrets.token_hex(16), "trigger_id": trigger_id, "workspace": workspace,
            "project_id": project_id, "pipeline_id": pipeline_id, "state": "running",
            "unattended": int(unattended), "started_at": int(time.time()),
        }
        with self.db.transaction() as cur:
            cur.execute(
                "INSERT INTO webhook_runs"
                " (id, trigger_id, workspace, project_id, pipeline_id, state, unattended, started_at)"
                " VALUES (:id, :trigger_id, :workspace, :project_id, :pipeline_id, :state, :unattended, :started_at)",
                run,
            )
        return run

    def close_run(self, run_id: str, state: str) -> None:
        with self.db.transaction() as cur:
            cur.execute(
                "UPDATE webhook_runs SET state = ?, ended_at = ? WHERE id = ? AND state = 'running'",
                (state, int(time.time()), run_id),
            )

    def reopen_run(self, run_id: str) -> None:
        """A closed run Resume carries on: open again, and never unattended."""
        with self.db.transaction() as cur:
            cur.execute(
                "UPDATE webhook_runs SET state = 'running', ended_at = NULL, unattended = 0 WHERE id = ?",
                (run_id,),
            )

    def end_unattended(self, run_id: str) -> None:
        """For good: an interrupted run is never unattended again."""
        with self.db.transaction() as cur:
            cur.execute("UPDATE webhook_runs SET unattended = 0 WHERE id = ?", (run_id,))

    def latest_run_of(self, workspace: str, pipeline_ids: Iterable[str]) -> str | None:
        """The last run of any of these pipelines here, whatever became of it."""
        ids = [pipeline_id for pipeline_id in pipeline_ids if pipeline_id]
        if not ids:
            return None
        marks = ",".join("?" * len(ids))
        with self.db.transaction() as cur:
            row = cur.execute(
                f"SELECT id FROM webhook_runs WHERE workspace = ? AND pipeline_id IN ({marks})"
                " ORDER BY started_at DESC, rowid DESC LIMIT 1",
                (workspace, *ids),
            ).fetchone()
        return row["id"] if row else None

    def open_runs(self) -> list[dict[str, Any]]:
        with self.db.transaction() as cur:
            rows = cur.execute("SELECT * FROM webhook_runs WHERE state = 'running'").fetchall()
        return [dict(row) for row in rows]

    def interrupted_open_runs(self) -> set[str]:
        """Open runs already audited as interrupted: the event names the run."""
        with self.db.transaction() as cur:
            rows = cur.execute(
                "SELECT r.id FROM webhook_runs r WHERE r.state = 'running' AND EXISTS ("
                " SELECT 1 FROM webhook_events e WHERE e.trigger_id = r.trigger_id"
                " AND e.outcome = 'interrupted' AND e.detail = r.id)"
            ).fetchall()
        return {row["id"] for row in rows}

    def approval_timeout_s(self, trigger_id: str) -> int:
        """From the row, deleted triggers too: a run outlives its trigger."""
        with self.db.transaction() as cur:
            row = cur.execute(
                "SELECT approval_timeout_min FROM webhook_triggers WHERE id = ?", (trigger_id,)
            ).fetchone()
        return (row["approval_timeout_min"] if row else DEFAULT_APPROVAL_TIMEOUT_MIN) * 60

    def add_run_pane(self, pane_id: str, run_id: str, unattended: bool) -> None:
        with self.db.transaction() as cur:
            cur.execute(
                "INSERT OR REPLACE INTO webhook_run_panes (pane_id, run_id, unattended) VALUES (?, ?, ?)",
                (pane_id, run_id, int(unattended)),
            )

    def run_panes(self) -> dict[str, tuple[str, bool]]:
        """Every pane a webhook run ever started: its run, and whether it runs
        unattended."""
        with self.db.transaction() as cur:
            rows = cur.execute("SELECT pane_id, run_id, unattended FROM webhook_run_panes").fetchall()
        return {row["pane_id"]: (row["run_id"], bool(row["unattended"])) for row in rows}

    def add_run_sessions(
        self, session_ids: Iterable[str], agent_key: str, run_id: str, unattended: bool, pane_id: str,
    ) -> None:
        """Never removed, with the run, the trigger or the events: a transcript
        stays resumable for as long as it exists, and a missing row reads as
        "not a webhook session"."""
        rows = [(session_id, agent_key, run_id, int(unattended), pane_id) for session_id in session_ids]
        if not rows:
            return
        with self.db.transaction() as cur:
            cur.executemany(
                "INSERT OR IGNORE INTO webhook_run_sessions (session_id, agent_key, run_id, unattended, pane_id)"
                " VALUES (?, ?, ?, ?, ?)",
                rows,
            )

    def run_session(self, session_id: str) -> tuple[str, bool] | None:
        with self.db.transaction() as cur:
            row = cur.execute(
                "SELECT run_id, unattended FROM webhook_run_sessions WHERE session_id = ?", (session_id,)
            ).fetchone()
        return (row["run_id"], bool(row["unattended"])) if row else None

    def run_trigger_unattended(self, run_id: str) -> bool:
        """Whether the trigger that started this run exists and is unattended
        now, and the run itself still is (see end_unattended)."""
        with self.db.transaction() as cur:
            row = cur.execute(
                "SELECT t.unattended FROM webhook_runs r JOIN webhook_triggers t ON t.id = r.trigger_id"
                " WHERE r.id = ? AND t.deleted_at IS NULL AND r.unattended = 1",
                (run_id,),
            ).fetchone()
        return bool(row and row["unattended"])

    def run_workspaces(self) -> list[str]:
        """Every workspace a run ever started in. `webhook_runs` is never pruned."""
        with self.db.transaction() as cur:
            rows = cur.execute("SELECT DISTINCT workspace FROM webhook_runs").fetchall()
        return [row["workspace"] for row in rows]

    def events(self, trigger_id: str, limit: int = 200) -> list[dict[str, Any]]:
        with self.db.transaction() as cur:
            rows = cur.execute(
                "SELECT * FROM webhook_events WHERE trigger_id = ? ORDER BY id DESC LIMIT ?",
                (trigger_id, limit),
            ).fetchall()
        return [dict(row) for row in rows]


def listener_settings(db: Database) -> dict[str, Any]:
    """Off, with no port chosen, until the user turns it on."""
    stored = db.kv_get(_SETTINGS_KEY) or {}
    return {
        "enabled": stored.get("enabled") is True,
        "port": int(stored.get("port") or 0),
        "public_host": str(stored.get("public_host") or ""),
    }


def save_listener_settings(db: Database, *, enabled: bool, port: int, public_host: str, now: int) -> None:
    host = public_host.strip().lower()
    if host and (host in _LOOPBACK_NAMES or not _HOSTNAME.match(host)):
        raise WebhookInvalid("the public host must be a bare external hostname")
    if not 0 <= port <= 65535:
        raise WebhookInvalid("port out of range")
    db.kv_set(_SETTINGS_KEY, {"enabled": bool(enabled), "port": port, "public_host": host}, now=now)



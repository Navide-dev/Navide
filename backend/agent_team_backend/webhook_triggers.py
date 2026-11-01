"""Webhook trigger records in the global ``navide.db``.

Three tables of their own, so nothing here changes an existing one:

- ``webhook_triggers`` — one row per trigger. A key is shown once and kept only
  as its SHA-256: a 256-bit random value needs no slow hash, and a stored hash
  means no secret store is involved at all. A deleted row stays, without its
  hash, because a run it started can be resumed and has to stay tainted.
- ``webhook_events`` — the audit trail. Time, outcome, status, size and the
  body's hash: never a key, a header, a query string or a body.
- ``webhook_usage`` — started runs per trigger per day, apart from the audit
  rows, which are trimmed.

None of this is a sync scope or part of a settings bundle, and a trigger lives
outside the pipeline definition, so exporting a pipeline carries none of it.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import re
import secrets
import sqlite3
import time
from typing import Any

from .db import Database

_COMPONENT = "webhook"
_SETTINGS_KEY = "webhook.listener"

KINDS = ("webhook", "form")
DEFAULT_PER_MINUTE = 6
DEFAULT_PER_DAY = 20
MAX_PER_MINUTE = 60
MAX_PER_DAY = 500
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
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _check(name: str, workspace: str, pipeline_id: str, kind: str, per_minute: int, per_day: int) -> None:
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


class WebhookStore:
    """Synchronous: every caller on the event loop goes through to_thread."""

    def __init__(self, db: Database) -> None:
        self.db = db
        db.migrate(_COMPONENT, 1, _create_schema)

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
    ) -> tuple[dict[str, Any], str]:
        """A new, disabled trigger and its key, which is not stored."""
        _check(name, workspace, pipeline_id, kind, per_minute, per_day)
        trigger_id, token, now = secrets.token_hex(16), new_token(), int(time.time())
        with self.db.transaction() as cur:
            cur.execute(
                "INSERT INTO webhook_triggers (id, name, workspace, pipeline_id, kind, enabled, token_hash,"
                " per_minute, per_day, no_gate_ack, created_at, updated_at, deleted_at)"
                " VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, NULL)",
                (trigger_id, name.strip(), workspace, pipeline_id, kind, hash_token(token),
                 per_minute, per_day, int(no_gate_ack), now, now),
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
        return {row["id"]: {**_public(row), "token_hash": row["token_hash"]} for row in rows}

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

    def rotate(self, trigger_id: str) -> str:
        """A new key; the old one stops working at once."""
        token = new_token()
        self._update_live(trigger_id, "token_hash = ?", hash_token(token))
        return token

    def delete(self, trigger_id: str) -> None:
        """Soft: see the module docstring. The key's hash goes with it."""
        now = int(time.time())
        self._update_live(trigger_id, "enabled = 0, token_hash = '', deleted_at = ?", now)

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



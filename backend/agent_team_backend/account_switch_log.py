"""Record of account switches someone other than the user's own click asked for.

An agent (MCP cli_account_switch) or a chat button (Telegram /account) can
switch a CLI account without the user confirming it first. Nothing here gates
that switch: this is the after-the-fact record the user reads to learn who
switched what, when and why (plan agent-0-2-42_3f728e, D7).

One row per request, written when the request arrives and updated when it
settles — a switch that is queued behind busy panes keeps its row in
"queued" until the window reports the outcome. Only what the user needs to
recognise the switch is kept: account ids and display names, the pane names,
and the first 300 characters of the reason. Never an email the store did not
already use as a name, a credential or a backend message. Rows older than
90 days are dropped on every write.

Like agent_message_log, a sqlite failure is logged and swallowed: the record
is a notice, so failing to write it never stops or delays the switch.
"""

from __future__ import annotations

import logging
import sqlite3
import time
from threading import RLock
from typing import Any

from .db import Database

log = logging.getLogger("agent_team_backend.account_switch_log")

_COMPONENT = "account_switch_log"

RETENTION_S = 90 * 24 * 3600
REASON_MAX = 300
_NAME_MAX = 200
LIST_MAX = 500

_COLUMNS = (
    "id",
    "created_at",
    "updated_at",
    "source",
    "requester",
    "agent_key",
    "from_profile_id",
    "from_name",
    "to_profile_id",
    "to_name",
    "pane_name",
    "reason",
    "status",
    "code",
)


def _create_schema(cur: sqlite3.Cursor) -> None:
    cur.execute(
        "CREATE TABLE account_switch_log ("
        " id INTEGER PRIMARY KEY AUTOINCREMENT,"
        " created_at REAL NOT NULL,"
        " updated_at REAL NOT NULL,"
        " source TEXT NOT NULL,"
        " requester TEXT NOT NULL,"
        " agent_key TEXT NOT NULL,"
        " from_profile_id TEXT,"
        " from_name TEXT,"
        " to_profile_id TEXT NOT NULL,"
        " to_name TEXT,"
        " pane_name TEXT,"
        " reason TEXT NOT NULL,"
        " status TEXT NOT NULL,"
        " code TEXT)"
    )
    cur.execute("CREATE INDEX account_switch_log_created ON account_switch_log (created_at)")


def _text(value: Any, limit: int = _NAME_MAX) -> str | None:
    if value is None:
        return None
    text = " ".join(str(value).split())
    return text[:limit] if text else None


class AccountSwitchLog:
    def __init__(self, db: Database, *, clock: Any = time.time) -> None:
        self._lock = RLock()
        self._db = db
        self._clock = clock
        self._db.migrate(_COMPONENT, 1, _create_schema)

    def record_request(
        self,
        *,
        source: str,
        requester: str,
        agent_key: str,
        to_profile_id: str,
        reason: str,
        to_name: str | None = None,
        pane_name: str | None = None,
    ) -> int | None:
        """Write the row for a request that just arrived; None when it could not be written."""
        now = self._clock()
        with self._lock:
            try:
                with self._db.transaction() as cur:
                    cur.execute("DELETE FROM account_switch_log WHERE created_at < ?", (now - RETENTION_S,))
                    cur.execute(
                        "INSERT INTO account_switch_log (created_at, updated_at, source, requester,"
                        " agent_key, to_profile_id, to_name, pane_name, reason, status)"
                        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'requested')",
                        (
                            now, now, _text(source, 32) or "unknown", _text(requester) or "",
                            _text(agent_key, 64) or "", _text(to_profile_id) or "",
                            _text(to_name), _text(pane_name), _text(reason, REASON_MAX) or "",
                        ),
                    )
                    return int(cur.lastrowid)
            except sqlite3.Error:
                log.exception("account_switch_log: could not record a switch request")
                return None

    def finish(
        self,
        row_id: int,
        status: str,
        *,
        code: str | None = None,
        from_profile_id: str | None = None,
        from_name: str | None = None,
        to_name: str | None = None,
        pane_name: str | None = None,
    ) -> bool:
        """Set a request's outcome; fields left None keep what the row has."""
        fields = {
            "status": _text(status, 64) or "unknown",
            "code": _text(code, 64),
            "from_profile_id": _text(from_profile_id),
            "from_name": _text(from_name),
            "to_name": _text(to_name),
            "pane_name": _text(pane_name),
        }
        sets = [f"{k} = ?" for k, v in fields.items() if v is not None or k == "status"]
        values = [v for k, v in fields.items() if v is not None or k == "status"]
        with self._lock:
            try:
                with self._db.transaction() as cur:
                    cur.execute(
                        f"UPDATE account_switch_log SET {', '.join(sets)}, updated_at = ? WHERE id = ?",
                        (*values, self._clock(), int(row_id)),
                    )
                    return cur.rowcount > 0
            except (sqlite3.Error, ValueError, TypeError):
                log.exception("account_switch_log: could not record a switch outcome")
                return False

    def get(self, row_id: int) -> dict[str, Any] | None:
        with self._lock:
            try:
                with self._db.transaction() as cur:
                    row = cur.execute(
                        f"SELECT {', '.join(_COLUMNS)} FROM account_switch_log WHERE id = ?", (int(row_id),)
                    ).fetchone()
            except (sqlite3.Error, ValueError, TypeError):
                log.exception("account_switch_log: could not read a switch row")
                return None
        return dict(row) if row is not None else None

    def list_recent(self, limit: int = 100) -> list[dict[str, Any]]:
        """Newest first, within the retention window."""
        limit = max(1, min(int(limit or 100), LIST_MAX))
        with self._lock:
            try:
                with self._db.transaction() as cur:
                    rows = cur.execute(
                        f"SELECT {', '.join(_COLUMNS)} FROM account_switch_log"
                        " WHERE created_at >= ? ORDER BY created_at DESC, id DESC LIMIT ?",
                        (self._clock() - RETENTION_S, limit),
                    ).fetchall()
            except sqlite3.Error:
                log.exception("account_switch_log: could not list switches")
                return []
        return [dict(r) for r in rows]

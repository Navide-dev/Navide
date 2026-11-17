"""The Shipped Log ledger: what an agent says it put into production.

One table, ``ship_log``, in each workspace's own ``.agent-team/navide.db`` (a
local file the workspace's .gitignore keeps out of git; never synced). Rows are
only ever added: writes are INSERT OR IGNORE on a dedup key, so a retried call
never records the same change twice. The schema is versioned with
``Database.migrate``; a workspace whose migration fails has its ledger
disabled (the reason is reported to the caller) and nothing else is affected.

Nothing here stores a value: a summary or ref that carries a credential is
refused before it is written, never masked and kept.
"""

from __future__ import annotations

import hashlib
import logging
import sqlite3
import threading
import time
from typing import Any

from agent_team_backend import share_scan
from agent_team_backend.db import Database

log = logging.getLogger("agent_team_backend.plugins.builtin.navide_shipped_log.ledger")

COMPONENT = "ship_log"
SOURCE_KINDS = ("commit", "config", "migration", "other")
MAX_SUMMARY = 500
MAX_REF = 200

_INSERT = (
    "INSERT OR IGNORE INTO ship_log (dedup_key, at, recorded_at, summary, source_kind, ref, sensitive, pane)"
    " VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
)


def _create_schema_v1(cur: sqlite3.Cursor) -> None:
    cur.execute(
        "CREATE TABLE ship_log ("
        " dedup_key TEXT PRIMARY KEY,"
        " at INTEGER NOT NULL,"           # unix seconds the change went live
        " recorded_at INTEGER NOT NULL,"  # unix seconds it was recorded
        " summary TEXT NOT NULL,"         # one plain-language line, never a value
        " source_kind TEXT NOT NULL,"     # commit | config | migration | other
        " ref TEXT NOT NULL,"             # commit hash or other pointer; '' when none
        " sensitive INTEGER NOT NULL,"    # 1: shown only as a count outside Navide
        " pane TEXT NOT NULL)"            # the recording pane's label; '' when unknown
    )
    cur.execute("CREATE INDEX ship_log_at ON ship_log (at)")


class LedgerError(ValueError):
    """A record refused before anything was written."""


def _dedup_key(source_kind: str, ref: str, summary: str, at: int) -> str:
    if source_kind == "commit" and ref:
        # One row per commit, whoever records it and however often.
        return f"commit:{ref.lower()}"
    digest = hashlib.sha256("\x00".join((source_kind, ref, summary, str(at))).encode("utf-8"))
    return digest.hexdigest()


def secret_findings(text: str) -> list[str]:
    """Categories of the high-confidence secrets in ``text`` (empty when clean)."""
    result = share_scan.scan(text, kind="text")
    return sorted({f.category for f in result.findings if f.action == share_scan.MASKED})


class ShipLogLedger:
    def __init__(self, databases: Any = None) -> None:
        # None resolves app.workspace_databases on first use, so importing this
        # module never imports the app.
        self._databases = databases
        self._lock = threading.Lock()
        self._state: dict[str, str] = {}  # db path -> "" (ready) or why it is disabled

    def _registry(self) -> Any:
        if self._databases is None:
            from agent_team_backend import app

            self._databases = app.workspace_databases
        return self._databases

    def _ready(self, db: Database) -> str:
        """'' when the ledger can be used in ``db``, else why it is disabled."""
        key = str(db.path)
        with self._lock:
            if key in self._state:
                return self._state[key]
            try:
                db.migrate(COMPONENT, 1, _create_schema_v1)
                reason = ""
            except Exception as err:  # noqa: BLE001 - the ledger is optional
                reason = f"{type(err).__name__}: {err}"
                log.warning("ship log disabled in %s: its schema could not be migrated: %s", key, reason)
            self._state[key] = reason
            return reason

    def record(
        self,
        workspace_path: str,
        *,
        summary: str,
        source_kind: str,
        ref: str = "",
        at: int | None = None,
        sensitive: bool | None = None,
        pane: str = "",
        now: float | None = None,
    ) -> dict[str, Any]:
        """Add one entry. Raises LedgerError for a refused entry; answers
        ``{"ok": False, "disabled": reason}`` when the ledger is disabled."""
        summary = " ".join((summary or "").split())
        ref = (ref or "").strip()
        if not summary:
            raise LedgerError("summary is required: one plain-language line saying what changed")
        if len(summary) > MAX_SUMMARY:
            raise LedgerError(f"summary is longer than {MAX_SUMMARY} characters")
        if source_kind not in SOURCE_KINDS:
            raise LedgerError(f"source_kind must be one of {', '.join(SOURCE_KINDS)}")
        if len(ref) > MAX_REF or any(c.isspace() for c in ref):
            raise LedgerError(f"ref must be one token of at most {MAX_REF} characters")
        found = secret_findings(f"{summary}\n{ref}")
        if found:
            raise LedgerError(
                "refused: the entry looks like it carries a secret (" + ", ".join(found) + "). "
                "Record what changed, never the value."
            )
        if sensitive is None:
            sensitive = source_kind == "config"
        recorded_at = int(time.time() if now is None else now)
        when = recorded_at if at is None else int(at)
        db = self._registry().get(workspace_path)
        if db is None:
            raise LedgerError("workspace_path is not a directory")
        reason = self._ready(db)
        if reason:
            return {"ok": False, "disabled": reason}
        key = _dedup_key(source_kind, ref, summary, when)
        with db.transaction() as cur:
            cur.execute(_INSERT, (key, when, recorded_at, summary, source_kind, ref, int(bool(sensitive)), pane or ""))
            written = cur.rowcount == 1
        return {"ok": True, "recorded": written, "duplicate": not written, "at": when,
                "source_kind": source_kind, "sensitive": bool(sensitive)}

    def entries(self, workspace_path: str, since: int, until: int | None = None) -> dict[str, Any]:
        """Entries with ``since <= at < until``, oldest first. Reading never
        creates a workspace database."""
        db = self._registry().peek(workspace_path)
        if db is None:
            return {"ok": True, "entries": []}
        reason = self._ready(db)
        if reason:
            return {"ok": False, "disabled": reason, "entries": []}
        sql = "SELECT at, summary, source_kind, ref, sensitive, pane FROM ship_log WHERE at >= ?"
        args: list[Any] = [int(since)]
        if until is not None:
            sql += " AND at < ?"
            args.append(int(until))
        sql += " ORDER BY at, recorded_at"
        with db.transaction() as cur:
            rows = cur.execute(sql, args).fetchall()
        return {"ok": True, "entries": [
            {"at": r[0], "summary": r[1], "source_kind": r[2], "ref": r[3], "sensitive": bool(r[4]), "pane": r[5]}
            for r in rows
        ]}


ledger = ShipLogLedger()

"""The Shipped Log ledger: what an agent says it put into production.

One table, ``ship_log``, in each workspace's own ``.agent-team/navide.db`` (a
local file the workspace's .gitignore keeps out of git; never synced). Rows are
only ever added: writes are INSERT OR IGNORE on a dedup key, so a retried call
never records the same change twice. The schema is versioned with
``Database.migrate``; a workspace whose migration fails has its ledger
disabled (the reason is reported to the caller) and nothing else is affected.

Nothing here stores a value: a summary or ref that carries a credential is
refused before it is written, never masked and kept.

Schema v2 (the full version) adds four tables beside it:

- ``ship_detect``: deploy commands the CLI hooks saw an agent run. Recorded
  only — nothing is blocked — and only as a masked excerpt.
- ``ship_config``: the production settings a workspace has, by name and by
  where they live. Never a value: a field that looks like one is refused.
- ``ship_override``: the user's own plain-language line or sensitive mark for
  a report item. The row it covers is never rewritten.
- ``ship_settings``: the workspace's daily digest settings.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
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


def _create_schema_v2(cur: sqlite3.Cursor) -> None:
    cur.execute(
        "CREATE TABLE ship_detect ("
        " id INTEGER PRIMARY KEY AUTOINCREMENT,"
        " at INTEGER NOT NULL,"           # unix seconds the command finished
        " pane TEXT NOT NULL,"            # the pane's label; '' when unknown
        " vendor TEXT NOT NULL,"          # the CLI whose hook reported it
        " rule TEXT NOT NULL,"            # which deploy pattern matched
        " excerpt TEXT NOT NULL,"         # the command, masked and cut short
        " ok INTEGER NOT NULL,"           # 0 when the CLI reported it failed
        " status TEXT NOT NULL)"          # pending | confirmed | dismissed
    )
    cur.execute("CREATE INDEX ship_detect_at ON ship_detect (at)")
    cur.execute(
        "CREATE TABLE ship_config ("
        " key TEXT PRIMARY KEY,"          # one token, e.g. mail.sender
        " label TEXT NOT NULL,"           # what the setting is, in words
        " location TEXT NOT NULL,"        # where it lives, never its value
        " environment TEXT NOT NULL,"     # production, staging, ...
        " note TEXT NOT NULL,"
        " updated_at INTEGER NOT NULL,"
        " removed_at INTEGER)"            # set when unregistered; the row stays
    )
    cur.execute(
        "CREATE TABLE ship_override ("
        " item_key TEXT PRIMARY KEY,"     # commit:<hash>, or a ledger row's dedup key
        " summary TEXT,"                  # NULL keeps the item's own line
        " sensitive INTEGER,"             # NULL keeps the item's own mark
        " updated_at INTEGER NOT NULL)"
    )
    cur.execute("CREATE TABLE ship_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")


#: Steps in order; ``_ready`` applies every one the database has not had.
_STEPS = ((1, _create_schema_v1), (2, _create_schema_v2))

DETECT_STATUSES = ("pending", "confirmed", "dismissed")
MAX_EXCERPT = 160
MAX_LABEL = 120
MAX_LOCATION = 300
MAX_NOTE = 300
CONFIG_KEY_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$")
# What a setting's value looks like when someone types it in by mistake: an
# assignment with something after the sign (a URL query parameter is not
# one), or a URL that carries a login.
_ASSIGNMENT_RE = re.compile(r"(?<![\w?&#-])[A-Za-z_][\w.-]*\s*=\s*\S")
_URL_LOGIN_RE = re.compile(r"://[^/\s:@]+:[^/\s@]+@")

#: The digest settings and their defaults (see digest.py).
DEFAULT_SETTINGS: dict[str, Any] = {"digest_enabled": False, "digest_at": "09:00", "digest_tz": "",
                                    "digest_skip_empty": True}


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


def value_findings(text: str) -> list[str]:
    """``secret_findings`` plus the shapes a setting's value takes: a production
    setting is registered by where it lives, so any value is refused."""
    found = set(secret_findings(text))
    if _ASSIGNMENT_RE.search(text):
        found.add("assignment")
    if _URL_LOGIN_RE.search(text):
        found.add("url-credentials")
    return sorted(found)


def _one_line(value: Any, limit: int, what: str) -> str:
    text = " ".join(str(value or "").split())
    if len(text) > limit:
        raise LedgerError(f"{what} is longer than {limit} characters")
    return text


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
                for version, step in _STEPS:
                    db.migrate(COMPONENT, version, step)
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
        sql = "SELECT at, summary, source_kind, ref, sensitive, pane, dedup_key FROM ship_log WHERE at >= ?"
        args: list[Any] = [int(since)]
        if until is not None:
            sql += " AND at < ?"
            args.append(int(until))
        sql += " ORDER BY at, recorded_at"
        with db.transaction() as cur:
            rows = cur.execute(sql, args).fetchall()
        return {"ok": True, "entries": [
            {"at": r[0], "summary": r[1], "source_kind": r[2], "ref": r[3], "sensitive": bool(r[4]), "pane": r[5],
             "key": r[6]}
            for r in rows
        ]}

    # ── v2: shared plumbing ───────────────────────────────────────────────

    def _write_db(self, workspace_path: str) -> Database:
        db = self._registry().get(workspace_path)
        if db is None:
            raise LedgerError("workspace_path is not a directory")
        reason = self._ready(db)
        if reason:
            raise LedgerError(f"the ship log ledger is disabled in this workspace: {reason}")
        return db

    def _read_db(self, workspace_path: str) -> tuple[Database | None, str]:
        """(db, '') to read from; (None, '') when the workspace has no database
        yet; (None, reason) when the ledger is disabled. Never creates one."""
        db = self._registry().peek(workspace_path)
        if db is None:
            return None, ""
        reason = self._ready(db)
        return (None, reason) if reason else (db, "")

    # ── v2: deploy commands the hooks saw ─────────────────────────────────

    def record_detection(self, workspace_path: str, *, at: int, pane: str, vendor: str, rule: str,
                         excerpt: str, ok: bool) -> int:
        """Add one detected deploy command; ``excerpt`` must already be masked.
        Returns the row id."""
        db = self._write_db(workspace_path)
        with db.transaction() as cur:
            cur.execute(
                "INSERT INTO ship_detect (at, pane, vendor, rule, excerpt, ok, status)"
                " VALUES (?, ?, ?, ?, ?, ?, 'pending')",
                (int(at), pane or "", vendor or "", rule, excerpt[:MAX_EXCERPT], int(bool(ok))),
            )
            return int(cur.lastrowid or 0)

    def detections(self, workspace_path: str, since: int, until: int | None = None) -> dict[str, Any]:
        db, reason = self._read_db(workspace_path)
        if db is None:
            return {"ok": not reason, **({"disabled": reason} if reason else {}), "detections": []}
        sql = "SELECT id, at, pane, vendor, rule, excerpt, ok, status FROM ship_detect WHERE at >= ?"
        args: list[Any] = [int(since)]
        if until is not None:
            sql += " AND at < ?"
            args.append(int(until))
        with db.transaction() as cur:
            rows = cur.execute(sql + " ORDER BY at, id", args).fetchall()
        return {"ok": True, "detections": [
            {"id": r[0], "at": r[1], "pane": r[2], "vendor": r[3], "rule": r[4], "excerpt": r[5],
             "ok": bool(r[6]), "status": r[7]}
            for r in rows
        ]}

    def set_detection_status(self, workspace_path: str, detection_id: int, status: str) -> bool:
        if status not in DETECT_STATUSES:
            raise LedgerError(f"status must be one of {', '.join(DETECT_STATUSES)}")
        db = self._write_db(workspace_path)
        with db.transaction() as cur:
            cur.execute("UPDATE ship_detect SET status = ? WHERE id = ?", (status, int(detection_id)))
            return cur.rowcount == 1

    # ── v2: production settings, by name and place ────────────────────────

    def register_config(self, workspace_path: str, *, key: str, label: str = "", location: str = "",
                        environment: str = "", note: str = "", remove: bool = False,
                        now: float | None = None) -> dict[str, Any]:
        """Register (or update, or unregister) one production setting. Only its
        name and where it lives are kept; a field that looks like a value is
        refused, never masked and kept."""
        key = (key or "").strip()
        if not CONFIG_KEY_RE.match(key):
            raise LedgerError("key must be one token of at most 80 characters (letters, digits, . _ : / -)")
        stamp = int(time.time() if now is None else now)
        if remove:
            db = self._write_db(workspace_path)
            with db.transaction() as cur:
                cur.execute("UPDATE ship_config SET removed_at = ? WHERE key = ? AND removed_at IS NULL",
                            (stamp, key))
                return {"ok": True, "key": key, "removed": cur.rowcount == 1}
        label = _one_line(label, MAX_LABEL, "label") or key
        location = _one_line(location, MAX_LOCATION, "location")
        environment = _one_line(environment, 40, "environment") or "production"
        note = _one_line(note, MAX_NOTE, "note")
        if not location:
            raise LedgerError("location is required: where the setting lives (a console page, a parameter path, a file)")
        found = value_findings("\n".join((key, label, location, environment, note)))
        if found:
            raise LedgerError(
                "refused: this looks like it carries a value (" + ", ".join(found) + "). "
                "Register the setting's name and where it lives, never its value."
            )
        db = self._write_db(workspace_path)
        with db.transaction() as cur:
            existed = cur.execute("SELECT 1 FROM ship_config WHERE key = ? AND removed_at IS NULL",
                                  (key,)).fetchone() is not None
            cur.execute(
                "INSERT INTO ship_config (key, label, location, environment, note, updated_at, removed_at)"
                " VALUES (?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(key) DO UPDATE SET label = excluded.label,"
                " location = excluded.location, environment = excluded.environment, note = excluded.note,"
                " updated_at = excluded.updated_at, removed_at = NULL",
                (key, label, location, environment, note, stamp),
            )
        return {"ok": True, "key": key, "created": not existed, "updated": existed}

    def configs(self, workspace_path: str, *, include_removed: bool = False) -> dict[str, Any]:
        db, reason = self._read_db(workspace_path)
        if db is None:
            return {"ok": not reason, **({"disabled": reason} if reason else {}), "configs": []}
        sql = "SELECT key, label, location, environment, note, updated_at, removed_at FROM ship_config"
        if not include_removed:
            sql += " WHERE removed_at IS NULL"
        with db.transaction() as cur:
            rows = cur.execute(sql + " ORDER BY key").fetchall()
        return {"ok": True, "configs": [
            {"key": r[0], "label": r[1], "location": r[2], "environment": r[3], "note": r[4],
             "updated_at": r[5], "removed_at": r[6]}
            for r in rows
        ]}

    # ── v2: the user's own line or mark for an item ───────────────────────

    def set_override(self, workspace_path: str, item_key: str, *, summary: str | None = None,
                     sensitive: bool | None = None, now: float | None = None) -> dict[str, Any]:
        """Set (or, with both None, clear) the user's line and mark for one item."""
        item_key = (item_key or "").strip()
        if not item_key or len(item_key) > 200:
            raise LedgerError("item_key is required")
        if summary is not None:
            summary = _one_line(summary, MAX_SUMMARY, "summary") or None
            if summary and secret_findings(summary):
                raise LedgerError("refused: the line looks like it carries a secret. Say what changed, never the value.")
        db = self._write_db(workspace_path)
        with db.transaction() as cur:
            if summary is None and sensitive is None:
                cur.execute("DELETE FROM ship_override WHERE item_key = ?", (item_key,))
            else:
                cur.execute(
                    "INSERT INTO ship_override (item_key, summary, sensitive, updated_at) VALUES (?, ?, ?, ?)"
                    " ON CONFLICT(item_key) DO UPDATE SET summary = excluded.summary,"
                    " sensitive = excluded.sensitive, updated_at = excluded.updated_at",
                    (item_key, summary, None if sensitive is None else int(bool(sensitive)),
                     int(time.time() if now is None else now)),
                )
        return {"ok": True, "item_key": item_key}

    def overrides(self, workspace_path: str) -> dict[str, dict[str, Any]]:
        db, _ = self._read_db(workspace_path)
        if db is None:
            return {}
        with db.transaction() as cur:
            rows = cur.execute("SELECT item_key, summary, sensitive FROM ship_override").fetchall()
        return {r[0]: {"summary": r[1], "sensitive": None if r[2] is None else bool(r[2])} for r in rows}

    # ── v2: digest settings ───────────────────────────────────────────────

    def settings(self, workspace_path: str) -> dict[str, Any]:
        out = dict(DEFAULT_SETTINGS)
        db, _ = self._read_db(workspace_path)
        if db is None:
            return out
        with db.transaction() as cur:
            rows = cur.execute("SELECT key, value FROM ship_settings").fetchall()
        for key, value in rows:
            if key in out:
                try:
                    out[key] = json.loads(value)
                except ValueError:
                    pass
        return out

    def put_settings(self, workspace_path: str, values: dict[str, Any]) -> dict[str, Any]:
        unknown = sorted(set(values) - set(DEFAULT_SETTINGS))
        if unknown:
            raise LedgerError("unknown setting: " + ", ".join(unknown))
        db = self._write_db(workspace_path)
        with db.transaction() as cur:
            for key, value in values.items():
                cur.execute("INSERT INTO ship_settings (key, value) VALUES (?, ?)"
                            " ON CONFLICT(key) DO UPDATE SET value = excluded.value", (key, json.dumps(value)))
        return self.settings(workspace_path)


ledger = ShipLogLedger()

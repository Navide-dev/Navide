"""SQLite persistence layer for Navide-owned data.

One database per ownership domain:
- ``<app_data>/navide.db`` — global stores (settings, token accounting).
- ``<workspace>/.agent-team/navide.db`` — per-workspace stores.

Design constraints (see .agent-team/plans/storage-architecture-decision):
- Explicit transactions only. Connections run in autocommit
  (``isolation_level=None``) and every write goes through
  :meth:`Database.transaction`, which issues BEGIN IMMEDIATE / COMMIT /
  ROLLBACK itself. Python's sqlite3 implicit-transaction default (opens a
  transaction on DML but never commits it) turns a missing ``commit()``
  into silent data loss on shutdown; opting out entirely closes that trap.
- One connection per database, shared across threads behind an RLock
  (``check_same_thread=False``). The backend is a single process with a
  single event-loop writer plus one save thread, so a per-database lock
  suffices. ``journal_mode`` stays a rollback journal (not WAL) so a
  database's content is exactly one file on disk — backup/restore and
  "delete to reset" flows never have to know about ``-wal``/``-shm``
  siblings. It is TRUNCATE rather than the DELETE default: DELETE creates
  and deletes ``-journal`` on every commit, and on Windows any other
  process holding that file open (an antivirus or indexer scan) turns
  each create/delete into SQLite's sleep-and-retry loop — hundreds of
  milliseconds per commit, so a burst of commits stalls for minutes.
  TRUNCATE keeps the journal file and empties it instead; an empty
  journal is never hot, so ignoring it is still safe.
- Document-class stores keep their whole-document read/write API on top
  of the shared ``kv`` table. Record-class stores create their own tables
  through :meth:`Database.migrate`.
- JSON import is idempotent and crash-safe: the import runs inside one
  transaction, completion is recorded in ``schema_meta`` within that same
  transaction, and only then is the source file renamed to
  ``<name>.migrated-v1``. A crash mid-import rolls back to "not migrated";
  a crash between commit and rename re-runs detection, sees the marker,
  and just finishes the rename.
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from threading import RLock
from typing import Any

log = logging.getLogger(__name__)

MIGRATED_SUFFIX = ".migrated-v1"
# Canonical database filename inside an ownership domain's data dir.
DB_FILENAME = "navide.db"

# schema_meta keys are namespaced: "schema:<component>" holds that
# component's schema version, "import:<marker>" records a completed
# JSON import.
_SCHEMA_PREFIX = "schema:"
_IMPORT_PREFIX = "import:"


class Database:
    """A single SQLite file with explicit transactions and a kv table."""

    def __init__(self, path: Path) -> None:
        self._path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = RLock()
        self._conn = self._connect()
        with self.transaction() as cur:
            cur.execute(
                "CREATE TABLE IF NOT EXISTS schema_meta ("
                " key TEXT PRIMARY KEY, value TEXT NOT NULL)"
            )
            cur.execute(
                "CREATE TABLE IF NOT EXISTS kv ("
                " key TEXT PRIMARY KEY, value TEXT NOT NULL,"
                " updated_at INTEGER NOT NULL)"
            )

    @property
    def path(self) -> Path:
        return self._path

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(
            str(self._path), isolation_level=None, check_same_thread=False
        )
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=TRUNCATE")
        return conn

    # ── Transactions ─────────────────────────────────────────────────

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Cursor]:
        """All reads-for-write and writes go through here.

        BEGIN IMMEDIATE takes the write lock up front so a transaction
        never fails midway with SQLITE_BUSY after partial reads.
        Reentrant: a transaction opened inside an outer one joins it
        (SQLite has no nested BEGIN; the RLock makes this safe).
        """
        with self._lock:
            conn = self._conn
            cur = conn.cursor()
            outer = not self._conn.in_transaction
            if outer:
                cur.execute("BEGIN IMMEDIATE")
            try:
                yield cur
            except BaseException:
                if outer and self._conn.in_transaction:
                    self._rollback_after_failure()
                raise
            else:
                if outer and self._conn.in_transaction:
                    try:
                        self._conn.commit()
                    except BaseException:
                        # A failed COMMIT (SQLITE_BUSY, I/O error) leaves the
                        # transaction open and the write lock held: later
                        # writes would join it and never commit, and every
                        # other connection would see "database is locked".
                        if self._conn.in_transaction:
                            self._rollback_after_failure()
                        raise
            finally:
                # A connection replaced by _rollback_after_failure is closed,
                # and closing a cursor on it raises.
                if conn is self._conn:
                    cur.close()

    def _rollback_after_failure(self) -> None:
        """Roll back after a failed body or COMMIT without masking its error.

        Called from inside the ``except`` that re-raises the original
        exception, so a failing ROLLBACK is logged, never raised. If the
        transaction is still open afterwards, the connection is replaced:
        closing it discards the transaction and releases the write lock, so
        later writes don't join a transaction that can never commit.
        """
        try:
            self._conn.rollback()
        except sqlite3.Error as err:
            log.warning("rollback failed on %s: %s", self._path, err)
        if not self._conn.in_transaction:
            return
        try:
            self._conn.close()
        except sqlite3.Error as err:
            log.warning("closing a connection stuck in a transaction failed on %s: %s", self._path, err)
        self._conn = self._connect()

    # ── kv (document-class stores) ───────────────────────────────────

    def kv_get(self, key: str, default: Any = None) -> Any:
        with self._lock:
            row = self._conn.execute(
                "SELECT value FROM kv WHERE key = ?", (key,)
            ).fetchone()
        if row is None:
            return default
        try:
            return json.loads(row["value"])
        except json.JSONDecodeError:
            log.warning("kv %r holds invalid JSON; returning default", key)
            return default

    def kv_set(self, key: str, value: Any, *, now: int) -> None:
        payload = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        with self.transaction() as cur:
            cur.execute(
                "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)"
                " ON CONFLICT(key) DO UPDATE SET"
                " value = excluded.value, updated_at = excluded.updated_at",
                (key, payload, now),
            )

    def kv_updated_at(self, key: str) -> int | None:
        """The ``updated_at`` stamp of a kv row, or None when absent.

        Used by legacy-writer coexistence merges to compare a regenerated
        JSON file's mtime against when the kv document was last written.
        """
        with self._lock:
            row = self._conn.execute(
                "SELECT updated_at FROM kv WHERE key = ?", (key,)
            ).fetchone()
        return int(row["updated_at"]) if row is not None else None

    # ── Schema versioning (record-class stores) ──────────────────────

    def schema_version(self, component: str) -> int:
        with self._lock:
            row = self._conn.execute(
                "SELECT value FROM schema_meta WHERE key = ?",
                (_SCHEMA_PREFIX + component,),
            ).fetchone()
        return int(row["value"]) if row is not None else 0

    def migrate(
        self,
        component: str,
        version: int,
        apply: Callable[[sqlite3.Cursor], None],
    ) -> bool:
        """Apply a schema step if ``component`` is below ``version``.

        The DDL and the version bump commit atomically; a failed step
        rolls back whole. Returns True if the step ran.
        """
        with self.transaction() as cur:
            current = self.schema_version(component)
            if current >= version:
                return False
            if version != current + 1:
                raise ValueError(
                    f"schema step for {component!r} must be {current + 1}, got {version}"
                )
            apply(cur)
            cur.execute(
                "INSERT INTO schema_meta (key, value) VALUES (?, ?)"
                " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (_SCHEMA_PREFIX + component, str(version)),
            )
            return True

    # ── JSON import (backward compatibility) ─────────────────────────

    def import_completed(self, marker: str) -> bool:
        with self._lock:
            row = self._conn.execute(
                "SELECT 1 FROM schema_meta WHERE key = ?",
                (_IMPORT_PREFIX + marker,),
            ).fetchone()
        return row is not None

    def import_json(
        self,
        marker: str,
        source: Path,
        load: Callable[[sqlite3.Cursor, Any], None],
        *,
        parse: Callable[[str], Any] | None = None,
        merge: Callable[[sqlite3.Cursor, Any], None] | None = None,
    ) -> bool:
        """Import a legacy JSON file once, atomically.

        - Already imported: only finish the source rename if a previous
          run crashed between commit and rename, then return False.
        - Source missing or unreadable: mark the import done (there is
          nothing to carry over; an unreadable file is left in place for
          manual inspection rather than renamed).
        - Otherwise: parse, run ``load`` inside one transaction, record
          the marker in that transaction, then rename the source to
          ``<name>.migrated-v1``. Returns True when data was imported.

        ``parse`` overrides the default ``json.loads`` for sources that are
        not one JSON document (e.g. JSONL); it may raise ``ValueError`` to
        take the unreadable path.

        ``merge`` is legacy-writer coexistence support: an older app version
        sharing the same data dir can regenerate ``source`` after the import
        completed (dev build and installed build opening one workspace).
        When the marker is already set and ``source`` reappeared, a non-None
        ``merge`` is called inside one transaction with the parsed document
        so the store can fold the legacy writer's data back in; the source
        is then retired. Without ``merge`` a reappeared source is retired
        unmerged (the pre-existing behavior). An unreadable reappeared
        source is left in place for inspection and nothing is merged.
        """
        if self.import_completed(marker):
            if merge is not None and source.exists():
                try:
                    data = (parse or json.loads)(source.read_text(encoding="utf-8"))
                except (OSError, ValueError) as err:
                    log.warning(
                        "regenerated legacy %s unreadable (%s);"
                        " not merged, file kept for inspection",
                        source.name,
                        err,
                    )
                    return False
                with self.transaction() as cur:
                    merge(cur, data)
                if not self._retire_source(source):
                    # The merged data is safely in the database; a source
                    # left in place would be re-merged (re-appended) on every
                    # startup, so removing it beats keeping a backup.
                    try:
                        source.unlink(missing_ok=True)
                        log.warning(
                            "removed merged %s: retiring it failed", source.name
                        )
                    except OSError as err:
                        log.warning(
                            "could not remove merged %s: %s", source.name, err
                        )
                return True
            self._retire_source(source)
            return False
        if not source.exists():
            self._mark_imported(marker)
            return False
        try:
            data = (parse or json.loads)(source.read_text(encoding="utf-8"))
        except (OSError, ValueError) as err:
            log.warning(
                "legacy %s unreadable (%s); starting empty, file kept for inspection",
                source.name,
                err,
            )
            self._mark_imported(marker)
            return False
        with self.transaction() as cur:
            load(cur, data)
            cur.execute(
                "INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, '1')",
                (_IMPORT_PREFIX + marker,),
            )
        self._retire_source(source)
        return True

    def _mark_imported(self, marker: str) -> None:
        with self.transaction() as cur:
            cur.execute(
                "INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, '1')",
                (_IMPORT_PREFIX + marker,),
            )

    def _retire_source(self, source: Path) -> bool:
        """Rename the source out of the way; True when it is gone."""
        if not source.exists():
            return True
        # Never overwrite an earlier backup: a legacy writer regenerating the
        # source means retirement can happen more than once per file, so a
        # taken name falls through to <name>.migrated-v1-2, -3, ... (bounded).
        retired = source.with_name(source.name + MIGRATED_SUFFIX)
        n = 2
        while retired.exists():
            if n > 99:
                log.warning(
                    "not retiring %s: too many retired copies alongside it",
                    source.name,
                )
                return False
            retired = source.with_name(f"{source.name}{MIGRATED_SUFFIX}-{n}")
            n += 1
        try:
            os.replace(source, retired)
        except OSError as err:
            log.warning("could not retire %s: %s", source.name, err)
            return False
        return True

    # ── Lifecycle ────────────────────────────────────────────────────

    def close(self) -> None:
        with self._lock:
            self._conn.close()


class WorkspaceDatabases:
    """Shared per-workspace Database registry (path-keyed, thread-safe).

    Several stores persist into the same ``<workspace>/.agent-team/navide.db``;
    this registry hands each workspace out as one shared :class:`Database` so
    they all use a single connection and lock. Keys are symlink-resolved
    absolute paths, so every spelling of a workspace maps to the same handle.
    Entries are never evicted (a session touches a bounded set of workspaces);
    ``close_all()`` runs at shutdown.
    """

    def __init__(self) -> None:
        self._lock = RLock()
        self._dbs: dict[str, Database] = {}

    @staticmethod
    def _canonical(workspace_path: str) -> str | None:
        """Resolved workspace path, or None when empty / not a directory.

        Same guard semantics as the legacy JSON stores' safe no-op:
        an invalid workspace yields no database rather than creating one.
        """
        if not workspace_path:
            return None
        ws = os.path.realpath(os.path.abspath(workspace_path))
        if not os.path.isdir(ws):
            return None
        return ws

    @staticmethod
    def _db_file(ws: str) -> Path:
        # Late import: projects.py imports this module at top level.
        from .projects import PROJECT_DIR_NAME

        return Path(ws) / PROJECT_DIR_NAME / DB_FILENAME

    def peek(self, workspace_path: str) -> Database | None:
        """The workspace's Database only if it already exists on disk.

        Read paths use this so that looking at a workspace never plants a
        ``.agent-team/navide.db`` in it.
        """
        ws = self._canonical(workspace_path)
        if ws is None:
            return None
        with self._lock:
            db = self._dbs.get(ws)
        if db is not None:
            return db
        if not self._db_file(ws).exists():
            return None
        return self.get(workspace_path)

    def get(self, workspace_path: str) -> Database | None:
        """The workspace's shared Database, created on first use.

        None when ``workspace_path`` is empty or not a directory. The
        ``.agent-team`` dir (with its self-ignoring .gitignore) is ensured
        before the database file is created.
        """
        ws = self._canonical(workspace_path)
        if ws is None:
            return None
        with self._lock:
            db = self._dbs.get(ws)
            if db is None:
                # Late import: projects.py imports this module at top level.
                from .projects import ensure_workspace_data_dir

                data_dir = ensure_workspace_data_dir(ws)
                db = Database(data_dir / DB_FILENAME)
                self._dbs[ws] = db
            return db

    def close_all(self) -> None:
        # Close outside the registry lock: a thread inside a db transaction
        # (preview_log.batch) can ask the registry for that db again, so
        # holding the registry while waiting for the db's lock deadlocks.
        with self._lock:
            dbs = list(self._dbs.values())
            self._dbs.clear()
        for db in dbs:
            try:
                db.close()
            except Exception as err:  # noqa: BLE001
                log.warning("workspace db close failed at %s: %s", db.path, err)

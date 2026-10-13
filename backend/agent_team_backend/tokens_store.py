"""Token-usage aggregator with per-workspace + global persistence.

Records token deltas from two sources:
  - source="analyzer": local llama-cli classify / auto_answer real counts
  - source="cli":      vendor parser scraped from agent TUI output

Persistence lives in the shared SQLite database (`<app_data>/navide.db`):
  - kv ``tokens.global``           — global lifetime ledger
  - kv ``tokens.workspace.<sha8>`` — per-workspace ledger, where sha8 =
    first 8 hex chars of sha256(abs_workspace_path). Keyed on the workspace
    identity rather than its path so tokens survive renames and moves.
  - table ``ingestion_checkpoints`` — one row per (log file, scope) cursor,
    so advancing one offset costs one row UPSERT instead of rewriting a
    multi-megabyte state file.
  - kv ``tokens.legacy_event_keys`` / ``tokens.recent_event_keys`` — dedup
    windows, written only when they change.

The legacy JSON stores (tokens.json, token-ingestion-state.json plus its
delta log and write-ahead journal) are imported once at startup and retired
(renamed ``*.migrated-v1`` / removed).

We never estimate — if a source can't produce a real number, we record 0.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import sqlite3
import threading
import time
from collections import OrderedDict, deque
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
from threading import RLock
from typing import Any, Callable

from .applog import app_data_dir
from .db import DB_FILENAME, Database
from .log_readers.base import LogReader, TurnUsage
from .pane_account_history import UNKNOWN_PROFILE_ID, normalize_profile_id, parse_event_time
from .projects import PROJECT_DIR_NAME

log = logging.getLogger("agent_team_backend.tokens")

TOKENS_FILE = "tokens.json"
# Persisted-store schema version for the tokens documents (see
# store_migrations.py). v2 added the cli-source `by_profile` dimension
# (per-CLI-account attribution); v3 drops it again — accounts are now just
# alternate auth stores with a single global active one, so per-account usage
# is no longer tracked.
TOKENS_SCHEMA_VERSION = 3
# Legacy storage key the retired v1→v2 migration credits historic cli usage to.
# Still referenced by that migration; v2→v3 folds the whole dimension away.
DEFAULT_PROFILE_KEY = "default"
# Legacy JSON artifacts, kept as constants for the one-time import path and
# for storage_service's disk-usage accounting.
RECORDED_KEYS_FILE = "recorded-event-keys.json"
LEGACY_READER_KEYS_FILE = "log-readers-seen.json"
INGESTION_STATE_FILE = "token-ingestion-state.json"
PERSISTENCE_JOURNAL_FILE = "token-persistence-journal.json"
INGESTION_DELTA_FILE = "token-ingestion-delta.jsonl"
WORKSPACES_SUBDIR = "workspaces"
INGESTION_STATE_VERSION = 2
RECENT_EVENT_KEYS_LIMIT = 512
# The legacy migration dedup set must stay bounded: evicting a key only risks
# a one-off global double count if its event ever replays.
LEGACY_EVENT_KEYS_LIMIT = 4096
LEGACY_EVENT_KEYS_TTL_DAYS = 14
# Per-turn cuts kept in memory (tokens.turns); one entry per session log.
TURNS_CACHE_LIMIT = 32
# A session log untouched for this long will not be appended to again in
# practice, so the per-file dedup window readers stash in its checkpoint is
# dead weight. Stripping it is self-healing: the offset and identity stay, so
# a file that does come back to life rebuilds its window on the next read.
COLD_FILE_DAYS = 7
# A checkpoint row whose log file has been unreadable (stat fails) for this
# long is dead and is deleted outright. Both conditions must hold — the stat
# failure alone is not enough, so a transient I/O fault (an unmounted network
# home, say) cannot wipe live checkpoints.
DEAD_ENTRY_DAYS = 30

# kv keys inside navide.db.
_KV_GLOBAL = "tokens.global"
_KV_WORKSPACE_PREFIX = "tokens.workspace."
_KV_LEGACY_KEYS = "tokens.legacy_event_keys"
_KV_RECENT_KEYS = "tokens.recent_event_keys"

# import_json markers (schema_meta) for the one-time JSON import.
_IMPORT_INGESTION = "tokens-ingestion"
_IMPORT_GLOBAL = "tokens-global"

_UPSERT_CHECKPOINT = (
    "INSERT INTO ingestion_checkpoints (path, scope, data, last_seen)"
    " VALUES (?, ?, ?, ?)"
    " ON CONFLICT(path, scope) DO UPDATE SET"
    " data = excluded.data, last_seen = excluded.last_seen"
)

# Raw kv upsert for payloads serialized ahead of the flush transaction
# (kv_set would json.dumps multi-MB documents while holding the shared
# Database lock; the flush path serializes before entering it).
_UPSERT_KV = (
    "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)"
    " ON CONFLICT(key) DO UPDATE SET"
    " value = excluded.value, updated_at = excluded.updated_at"
)

# A successful stat only rewrites a row's last_seen when the stored value is
# older than this, so the hourly prune scan does not re-UPSERT every row.
_LAST_SEEN_REFRESH_S = 86400


def _create_tokens_schema(cur: sqlite3.Cursor) -> None:
    cur.execute(
        "CREATE TABLE ingestion_checkpoints ("
        " path TEXT NOT NULL,"       # log file absolute path
        " scope TEXT NOT NULL,"      # '' for global, else workspace path
        " data TEXT NOT NULL,"       # checkpoint dict as JSON
        " last_seen INTEGER NOT NULL,"  # unix ts of last successful stat/advance
        " PRIMARY KEY (path, scope))"
    )


# Per-account usage in fixed time slices, the sub-day resolution the quota
# cycle ledger needs (a 5h window starts at an arbitrary minute). Bounded by
# SLICE_RETENTION_S: a cycle's sums are finalized into quota_cycles when it
# closes; retained late events may still reconcile them. The longest open
# window is a calendar month (copilot / grok / qwen monthly credits, up to 31
# days back to the previous reset), so retention must cover more than that.
SLICE_S = 300
SLICE_RETENTION_S = 40 * 86400


def slice_coverage(start: float | None, end: float, since: float, wall: float) -> tuple[str, str | None]:
    if start is None:
        return "unavailable", "start_unknown"
    cutoff = wall - SLICE_RETENTION_S
    available_since = max(since, cutoff)
    if start >= available_since:
        return "available", None
    reason = "retention_expired" if cutoff > since else "collection_started_late"
    return ("partial" if min(end, wall) > available_since else "unavailable"), reason


def _create_slices_schema(cur: sqlite3.Cursor) -> None:
    cur.execute(
        "CREATE TABLE token_slices ("
        " agent TEXT NOT NULL,"
        " profile_id TEXT NOT NULL,"
        " slice_start INTEGER NOT NULL,"  # unix ts, multiple of SLICE_S
        " input INTEGER NOT NULL,"
        " cache_read INTEGER NOT NULL,"
        " cache_creation INTEGER NOT NULL,"
        " output INTEGER NOT NULL,"
        " calls INTEGER NOT NULL,"
        " turns INTEGER NOT NULL,"
        " PRIMARY KEY (agent, profile_id, slice_start))"
    )


_UPSERT_SLICE = (
    "INSERT INTO token_slices (agent, profile_id, slice_start, input, cache_read,"
    " cache_creation, output, calls, turns) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    " ON CONFLICT(agent, profile_id, slice_start) DO UPDATE SET"
    " input = excluded.input, cache_read = excluded.cache_read,"
    " cache_creation = excluded.cache_creation, output = excluded.output,"
    " calls = excluded.calls, turns = excluded.turns"
)


def _ws_dir_name(workspace_path: str) -> str:
    """First 8 hex chars of sha256(abs_workspace_path).

    Stable across workspace renames/moves — keyed on the canonical absolute
    path at the time the workspace was first used.
    """
    return hashlib.sha256(workspace_path.encode("utf-8")).hexdigest()[:8]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _days_from_now_iso(days: int) -> str:
    return (
        (datetime.now(timezone.utc) + timedelta(days=days))
        .isoformat(timespec="seconds")
        .replace("+00:00", "Z")
    )


def _today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _empty_bucket() -> dict[str, int]:
    """A single accounting unit. `calls` counts events; in/out are token sums."""
    return {"input": 0, "output": 0, "calls": 0}


def _add(into: dict[str, int], delta: dict[str, int]) -> None:
    into["input"] += int(delta.get("input", 0))
    into["output"] += int(delta.get("output", 0))
    into["calls"] += int(delta.get("calls", 0))


_DETAIL_FIELDS = ("input", "cache_read", "cache_creation", "output", "calls", "turns")


def _empty_detail_bucket() -> dict[str, int]:
    """The per-account ledgers keep the four token counts apart (nothing
    folded into input, like TurnUsage) plus calls and turns."""
    return dict.fromkeys(_DETAIL_FIELDS, 0)


def _add_detail(into: dict[str, int], delta: dict[str, int]) -> None:
    for field in _DETAIL_FIELDS:
        into[field] = int(into.get(field, 0)) + int(delta.get(field, 0))


def _version_key(vendor: str, cli_version: str) -> str:
    return f"{vendor}@{cli_version or 'unknown'}"


def _event_time(timestamp: str) -> float:
    """Epoch seconds of a usage event: its own stamp when the log has one,
    else ingestion time."""
    parsed = parse_event_time(timestamp)
    return time.time() if parsed is None else parsed


def _day_of(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d")


def _coerce_schema(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 1


def migrate_tokens_v1_to_v2(doc: Any) -> Any:
    """Seed the v2 `by_profile` dimension, crediting all historic cli usage to
    the default account. Handles both the global doc (top-level `by_vendor`) and
    a per-workspace doc (`cumulative.by_vendor`). Idempotent: gated on
    schemaVersion, returns the doc untouched once already >= v2. Returns a new
    dict when it changes anything so the disk migrator knows to write."""
    if not isinstance(doc, dict) or _coerce_schema(doc.get("schemaVersion", 1)) >= 2:
        return doc
    doc = deepcopy(doc)
    if "cumulative" in doc and isinstance(doc.get("cumulative"), dict):
        target = doc["cumulative"]
    else:
        target = doc
    source = target.get("by_vendor") if isinstance(target.get("by_vendor"), dict) else {}
    by_profile = target.setdefault("by_profile", {})
    for vendor, bucket in source.items():
        # cli-only dimension: the analyzer source has no CLI account.
        if vendor == "analyzer" or not isinstance(bucket, dict):
            continue
        by_profile.setdefault(vendor, {}).setdefault(DEFAULT_PROFILE_KEY, deepcopy(bucket))
    doc["schemaVersion"] = 2
    return doc


def migrate_tokens_v2_to_v3(doc: Any) -> Any:
    """Drop the v2 `by_profile` dimension. Per-account usage is no longer
    tracked (accounts are just alternate auth stores with one global active).

    No totals are lost: `by_profile` was always a redundant sub-ledger of
    `by_vendor`/`all_time` — every cli event credited both from the same delta —
    so the account totals already live in those global/provider dimensions.
    Removing the key preserves every total. Handles both the global doc
    (top-level `by_profile`) and a per-workspace doc (`cumulative.by_profile`).
    Idempotent: gated on schemaVersion, returns the doc untouched once >= v3.
    Returns a new dict when it changes anything so the disk migrator writes."""
    if not isinstance(doc, dict) or _coerce_schema(doc.get("schemaVersion", 1)) >= 3:
        return doc
    doc = deepcopy(doc)
    doc.pop("by_profile", None)
    if isinstance(doc.get("cumulative"), dict):
        doc["cumulative"].pop("by_profile", None)
    doc["schemaVersion"] = 3
    return doc


def _apply_tokens_migrations(doc: Any) -> Any:
    return migrate_tokens_v2_to_v3(migrate_tokens_v1_to_v2(doc))


def _empty_workspace_doc() -> dict[str, Any]:
    return {
        "schemaVersion": TOKENS_SCHEMA_VERSION,
        "current_run": None,  # see _new_run() shape
        "runs": [],           # archived runs
        "cumulative": {
            "totals": _empty_bucket(),
            "by_vendor": {},
            "by_stage": {},
            "by_group": {},   # sidebar run group id → bucket; "" = ungrouped
            "by_account": {},  # pane account pin (profile_id) → bucket
            "by_version": {},  # "<vendor>@<cli_version>" → bucket
        },
    }


def _empty_global_doc() -> dict[str, Any]:
    return {
        "schemaVersion": TOKENS_SCHEMA_VERSION,
        "all_time": _empty_bucket(),
        "by_vendor": {},
        "by_day": {},
        "by_account": {},
        "by_version": {},
        # agent → profile_id → UTC day → detail bucket (the monthly / yearly
        # per-account statistics are summed from this at query time).
        "by_account_day": {},
    }


def _empty_ingestion_state() -> dict[str, Any]:
    """Shape of the retired token-ingestion-state.json (import path only)."""
    return {
        "version": INGESTION_STATE_VERSION,
        "files": {},
        "legacy_event_keys": [],
        "legacy_event_keys_expires_at": None,
        "recent_event_keys": [],
    }


def _new_run(run_id: str, task: str, run_dir: str) -> dict[str, Any]:
    return {
        "run_id": run_id,
        "task": task,
        "run_dir": run_dir,
        "started_at": _now_iso(),
        "ended_at": None,
        "totals": _empty_bucket(),
        "by_vendor": {},
        "by_stage": {},
        "by_group": {},
        "by_pane": {},
    }


_SAVE_INTERVAL_S = 10  # batch window for dirty-flag saves
_PRUNE_INTERVAL_S = 3600  # how often the save loop rescans checkpoints for cold logs


class TokensStore:
    """Thread-safe in-memory aggregator persisted to SQLite.

    Writes are batched: record() marks dirty state under _lock and a
    background thread commits only the dirty rows every _SAVE_INTERVAL_S
    seconds inside one transaction. Call flush() before shutdown.
    """

    def __init__(
        self,
        global_path: Path | None = None,
        recorded_keys_path: Path | None = None,
        workspace_base_dir: Path | None = None,
        ingestion_state_path: Path | None = None,
        legacy_reader_keys_path: Path | None = None,
        db: Database | None = None,
    ) -> None:
        data_root = global_path.parent if global_path is not None else app_data_dir()
        # Legacy JSON locations, consumed only by the one-time import below.
        self._global_path = global_path or (data_root / TOKENS_FILE)
        self._recorded_keys_path = recorded_keys_path or (data_root / RECORDED_KEYS_FILE)
        self._legacy_reader_keys_path = (
            legacy_reader_keys_path or (data_root / LEGACY_READER_KEYS_FILE)
        )
        self._ingestion_state_path = (
            ingestion_state_path or (data_root / INGESTION_STATE_FILE)
        )
        self._persistence_journal_path = data_root / PERSISTENCE_JOURNAL_FILE
        self._ingestion_delta_path = data_root / INGESTION_DELTA_FILE
        self._workspace_base_dir = workspace_base_dir or (data_root / WORKSPACES_SUBDIR)

        self._db = db or Database(data_root / DB_FILENAME)
        self._db.migrate("tokens", 1, _create_tokens_schema)
        self._db.migrate("tokens", 2, _create_slices_schema)
        since = self._db.kv_get("tokens.slices_since")
        if not isinstance(since, (int, float)) or isinstance(since, bool):
            since = time.time()
            self._db.kv_set("tokens.slices_since", since, now=int(since))
        self.slices_since = float(since)

        # RLock because reset() calls snapshot() while holding the lock.
        self._lock = RLock()
        # Serialize complete commits. In-memory mutations only need _lock;
        # _flush_lock keeps a synchronous lifecycle save from interleaving
        # with an in-flight background batch.
        self._flush_lock = RLock()
        self._workspace_cache: dict[str, dict[str, Any]] = {}
        # Per-session live tallies: workspace_path -> session_key -> bucket.
        # A CACHE of what the vendor's session log actually holds, published by
        # set_live_total() after an off-loop scan — never an accumulator, so
        # nothing here can drift from the file. Not persisted: the first scan
        # after a restart re-derives the whole total.
        self._live_by_session: dict[str, dict[str, dict[str, int]]] = {}
        # Per-turn split of a session log, keyed on the file's identity at
        # scan time (path, mtime, size) plus the session filter, so a log that
        # grew is re-cut, an unchanged one is served from memory, and two
        # sessions sharing one source (opencode/kilo SQLite) never see each
        # other's cut. Never persisted.
        self._turns_cache: OrderedDict[tuple[str, float, int, str], list[TurnUsage]] = OrderedDict()

        # Dirty tracking (mutated inside _lock, consumed by the flush path).
        self._dirty_workspaces: set[str] = set()
        self._dirty_global = False
        # (path, scope) pairs whose row must be UPSERTed; scope '' = global.
        self._dirty_checkpoints: set[tuple[str, str]] = set()
        self._deleted_checkpoints: set[tuple[str, str]] = set()
        self._deleted_scopes: set[str] = set()
        self._delete_all_checkpoints = False
        self._dirty_legacy_keys = False
        self._dirty_recent_keys = False
        # (agent, profile_id, slice_start) -> detail bucket; the in-memory
        # mirror of token_slices within SLICE_RETENTION_S.
        self._slices: dict[tuple[str, str, int], dict[str, int]] = {}
        self._dirty_slices: set[tuple[str, str, int]] = set()
        self._delete_all_slices = False

        self._import_legacy_json()
        self._load_slices()
        # A bounded startup drain also repairs a crash between a slice flush
        # and its closed-cycle reconciliation. This is not a raw-event log.
        self._quota_changes: set[tuple[str, str, int]] = set(self._slices)

        self._global_data: dict[str, Any] = self._load_global()
        # In-memory checkpoint cache: path -> {"global": ckpt, "workspaces":
        # {workspace_path: ckpt}} — the shape record()/prune operate on.
        self._files: dict[str, dict[str, Any]] = {}
        self._last_seen: dict[str, int] = {}
        self._load_checkpoints()

        legacy_doc = self._db.kv_get(_KV_LEGACY_KEYS) or {}
        self._legacy_event_keys: set[str] = set(
            str(k) for k in legacy_doc.get("keys", []) if k
        )
        self._legacy_expires_at: str | None = (
            str(legacy_doc.get("expires_at")) if legacy_doc.get("expires_at") else None
        )
        recent = [str(k) for k in (self._db.kv_get(_KV_RECENT_KEYS) or [])]
        self._recent_event_keys = deque(recent[-RECENT_EVENT_KEYS_LIMIT:])
        self._recent_event_key_set = set(self._recent_event_keys)
        if self._enforce_legacy_key_bounds():
            self._dirty_legacy_keys = True
        self._prune_ingestion_files()

        # Background save loop
        self._stop_event = threading.Event()
        self._save_thread = threading.Thread(
            target=self._save_loop, name="tokens_store.save", daemon=True
        )
        self._save_thread.start()

    # ────────────────── One-time legacy JSON import ──────────────────

    def _import_legacy_json(self) -> None:
        """Import the retired JSON stores into the database, once.

        Order matters: an interrupted pre-SQLite batched commit (the
        write-ahead journal) is finished first so its whole-file writes land
        on the JSON files the import then reads, and its pending delta
        records are folded into the merged ingestion state.
        """
        journal_records = self._recover_legacy_journal()
        try:
            self._import_legacy_ingestion(journal_records)
        except Exception as err:  # noqa: BLE001
            log.warning("legacy ingestion-state import failed: %s", err)
        try:
            self._db.import_json(
                _IMPORT_GLOBAL, self._global_path, self._load_global_import
            )
        except Exception as err:  # noqa: BLE001
            log.warning("legacy global tokens import failed: %s", err)
        try:
            self._import_legacy_workspaces()
        except Exception as err:  # noqa: BLE001
            log.warning("legacy workspace tokens import failed: %s", err)

    def _import_legacy_ingestion(self, journal_records: list[dict[str, Any]]) -> None:
        if self._db.import_completed(_IMPORT_INGESTION):
            # Finish a rename a previous run crashed before; drop side files.
            self._db.import_json(
                _IMPORT_INGESTION, self._ingestion_state_path, self._load_ingestion_import
            )
            self._remove_ingestion_side_files()
            return
        doc, materialize = self._read_legacy_ingestion_state(journal_records)
        if materialize:
            # Give import_json a single crash-safe source that already has
            # the delta log and journal folded in.
            self._write_json_atomic(self._ingestion_state_path, doc)
        self._db.import_json(
            _IMPORT_INGESTION, self._ingestion_state_path, self._load_ingestion_import
        )
        if self._db.import_completed(_IMPORT_INGESTION):
            self._remove_ingestion_side_files()

    def _remove_ingestion_side_files(self) -> None:
        # The delta log's records are folded into the imported state; the
        # legacy key caches were migrated into legacy_event_keys.
        self._ingestion_delta_path.unlink(missing_ok=True)
        self._recorded_keys_path.unlink(missing_ok=True)
        self._legacy_reader_keys_path.unlink(missing_ok=True)

    def _read_legacy_ingestion_state(
        self, journal_records: list[dict[str, Any]]
    ) -> tuple[dict[str, Any], bool]:
        """Merge snapshot + delta log + journal records into one state doc.

        Returns (doc, materialize): materialize is True when the merged doc
        holds data the snapshot file alone does not (so it must be rewritten
        before import_json reads it). A corrupt snapshot with nothing else is
        left in place for import_json's keep-for-inspection path.
        """
        doc, snapshot_valid = self._read_legacy_snapshot()
        records = [r for r in self._read_legacy_delta()]
        records.extend(r for r in journal_records if isinstance(r, dict))
        for record in records:
            self._apply_delta_record(doc, record)
        has_content = bool(doc.get("files")) or bool(doc.get("legacy_event_keys"))
        materialize = bool(records) or (not snapshot_valid and has_content)
        return doc, materialize

    def _read_legacy_snapshot(self) -> tuple[dict[str, Any], bool]:
        if self._ingestion_state_path.exists():
            try:
                data = json.loads(self._ingestion_state_path.read_text(encoding="utf-8"))
                if isinstance(data, dict) and data.get("version") == INGESTION_STATE_VERSION:
                    doc = _empty_ingestion_state()
                    doc.update(data)
                    if not isinstance(doc.get("files"), dict):
                        doc["files"] = {}
                    return doc, True
            except (OSError, json.JSONDecodeError) as err:
                log.warning("token ingestion state unreadable (%s); rebuilding", err)
        # No usable snapshot: fall back to the even older per-purpose key
        # files. log-readers-seen.json was only a parser performance cache
        # that can contain events the accounting sink rejected as external,
        # so its bare keys must never suppress a migration replay.
        doc = _empty_ingestion_state()
        doc["legacy_event_keys"] = sorted(self._load_legacy_recorded_keys())
        return doc, False

    def _load_legacy_recorded_keys(self) -> set[str]:
        if not self._recorded_keys_path.exists():
            return set()
        try:
            data = json.loads(self._recorded_keys_path.read_text(encoding="utf-8"))
            if isinstance(data, list):
                return set(str(k) for k in data)
        except (OSError, json.JSONDecodeError) as err:
            log.warning("recorded-keys file unreadable (%s); starting empty", err)
        return set()

    def _snapshot_identity(self) -> dict[str, Any]:
        """Stat pin tying a legacy delta log to the snapshot it branched from."""
        try:
            st = self._ingestion_state_path.stat()
        except OSError:
            return {"mtime_ns": 0, "size": 0}
        return {"mtime_ns": st.st_mtime_ns, "size": st.st_size}

    def _read_legacy_delta(self) -> list[dict[str, Any]]:
        """Return the legacy delta log's records, or nothing if not ours.

        A mismatched header means something rewrote the snapshot without
        touching the log — an older build, most likely. Replaying then would
        drag checkpoints backwards, so the log is dropped and the snapshot
        stands on its own. A torn tail (crash mid-append) only invalidates
        the records after the tear.
        """
        if not self._ingestion_delta_path.exists():
            return []
        try:
            lines = self._ingestion_delta_path.read_text(encoding="utf-8").splitlines()
        except OSError as err:
            log.warning("ingestion delta unreadable (%s); ignoring it", err)
            return []
        if not lines:
            return []
        try:
            header = json.loads(lines[0])
        except json.JSONDecodeError:
            log.warning("ingestion delta header corrupt; ignoring the log")
            return []
        if header.get("base") != self._snapshot_identity():
            log.info("ingestion delta does not match the snapshot; ignoring the log")
            return []
        records: list[dict[str, Any]] = []
        for line in lines[1:]:
            if not line.strip():
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                log.info("ingestion delta truncated; replaying %d record(s)", len(records))
                break
            if isinstance(record, dict):
                records.append(record)
        return records

    @staticmethod
    def _apply_delta_record(doc: dict[str, Any], record: dict[str, Any]) -> None:
        """Replay one legacy delta record onto a state doc. Idempotent."""
        kind = record.get("t")
        if kind == "ckpt":
            path = str(record.get("p") or "")
            checkpoint = record.get("c")
            if not path or not isinstance(checkpoint, dict):
                return
            files = doc.setdefault("files", {})
            entry = files.setdefault(path, {"global": {}, "workspaces": {}})
            workspace = str(record.get("w") or "")
            if workspace:
                entry.setdefault("workspaces", {})[workspace] = checkpoint
            else:
                entry["global"] = checkpoint
        elif kind == "rek":
            key = str(record.get("k") or "")
            if not key:
                return
            keys = [k for k in doc.get("recent_event_keys", []) if k != key]
            keys.append(key)
            doc["recent_event_keys"] = keys[-RECENT_EVENT_KEYS_LIMIT:]

    def _recover_legacy_journal(self) -> list[dict[str, Any]]:
        """Finish an interrupted pre-SQLite batched commit.

        Whole-file writes are replayed onto the JSON files (which the import
        reads right after); the pending delta records are returned so the
        caller folds them into the merged ingestion state. An unreadable
        journal is kept in place for inspection — no build can apply it.
        """
        if not self._persistence_journal_path.exists():
            return []
        try:
            journal = json.loads(
                self._persistence_journal_path.read_text(encoding="utf-8")
            )
            writes = journal.get("writes", []) if isinstance(journal, dict) else []
            for item in writes:
                if (
                    not isinstance(item, dict)
                    or not item.get("path")
                    or not isinstance(item.get("data"), dict)
                ):
                    continue
                self._write_json_atomic(Path(str(item.get("path") or "")), item["data"])
            pending = journal.get("delta") if isinstance(journal, dict) else None
            records = (
                [r for r in pending if isinstance(r, dict)]
                if isinstance(pending, list)
                else []
            )
            self._persistence_journal_path.unlink(missing_ok=True)
            log.info("recovered interrupted token persistence batch")
            return records
        except (OSError, TypeError, ValueError, json.JSONDecodeError) as err:
            log.warning("token persistence journal recovery failed: %s", err)
            return []

    @staticmethod
    def _write_json_atomic(path: Path, data: dict[str, Any]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        try:
            tmp.write_text(
                json.dumps(data, ensure_ascii=False, separators=(",", ":")),
                encoding="utf-8",
            )
            os.replace(tmp, path)
        except Exception:
            tmp.unlink(missing_ok=True)
            raise

    def _load_ingestion_import(self, cur: sqlite3.Cursor, data: Any) -> None:
        if not isinstance(data, dict) or data.get("version") != INGESTION_STATE_VERSION:
            return
        now = int(time.time())
        files = data.get("files")
        if isinstance(files, dict):
            for path, entry in files.items():
                if not isinstance(entry, dict):
                    continue
                checkpoint = entry.get("global")
                if isinstance(checkpoint, dict) and checkpoint:
                    cur.execute(
                        _UPSERT_CHECKPOINT,
                        (str(path), "", _dump_compact(checkpoint), now),
                    )
                workspaces = entry.get("workspaces")
                if isinstance(workspaces, dict):
                    for workspace, ws_checkpoint in workspaces.items():
                        if isinstance(ws_checkpoint, dict) and ws_checkpoint:
                            cur.execute(
                                _UPSERT_CHECKPOINT,
                                (str(path), str(workspace), _dump_compact(ws_checkpoint), now),
                            )
        legacy = sorted(str(k) for k in (data.get("legacy_event_keys") or []) if k)
        expires_at = data.get("legacy_event_keys_expires_at") or None
        if legacy or expires_at:
            # kv_set joins the surrounding import transaction (reentrant).
            self._db.kv_set(
                _KV_LEGACY_KEYS, {"keys": legacy, "expires_at": expires_at}, now=now
            )
        recent = [str(k) for k in (data.get("recent_event_keys") or []) if k]
        if recent:
            self._db.kv_set(
                _KV_RECENT_KEYS, recent[-RECENT_EVENT_KEYS_LIMIT:], now=now
            )

    def _load_global_import(self, cur: sqlite3.Cursor, data: Any) -> None:
        if not isinstance(data, dict):
            return
        self._db.kv_set(
            _KV_GLOBAL, _apply_tokens_migrations(data), now=int(time.time())
        )

    def _import_legacy_workspaces(self) -> None:
        if not self._workspace_base_dir.is_dir():
            return
        for ws_dir in sorted(self._workspace_base_dir.iterdir()):
            if not ws_dir.is_dir():
                continue
            source = ws_dir / TOKENS_FILE
            if not source.exists() and not self._db.import_completed(
                f"tokens-workspace-{ws_dir.name}"
            ):
                continue
            kv_key = _KV_WORKSPACE_PREFIX + ws_dir.name

            def load(cur: sqlite3.Cursor, data: Any, key: str = kv_key) -> None:
                if not isinstance(data, dict):
                    return
                # A late-appearing file (e.g. restored from a backup) must
                # not clobber state the database has since accumulated.
                if self._db.kv_get(key) is not None:
                    return
                self._db.kv_set(
                    key, _apply_tokens_migrations(data), now=int(time.time())
                )

            try:
                self._db.import_json(f"tokens-workspace-{ws_dir.name}", source, load)
            except Exception as err:  # noqa: BLE001
                log.warning("workspace tokens import failed for %s: %s", ws_dir.name, err)

    # ───────────────────────── Loading ──────────────────────────────

    def _workspace_kv_key(self, workspace_path: str) -> str:
        return _KV_WORKSPACE_PREFIX + _ws_dir_name(workspace_path)

    def _load_workspace(self, workspace_path: str) -> dict[str, Any]:
        if workspace_path in self._workspace_cache:
            return self._workspace_cache[workspace_path]
        doc = self._db.kv_get(self._workspace_kv_key(workspace_path))
        if doc is None:
            doc = self._migrate_legacy_workspace_file(workspace_path)
        if not isinstance(doc, dict):
            doc = _empty_workspace_doc()
        else:
            doc = _apply_tokens_migrations(doc)
            # Forward-compat: fill in any missing top-level keys.
            for k, v in _empty_workspace_doc().items():
                doc.setdefault(k, v)
            # by_group arrived after by_stage; docs persisted before it lack the key.
            doc["cumulative"].setdefault("by_group", {})
            doc["cumulative"].setdefault("by_account", {})
            doc["cumulative"].setdefault("by_version", {})
            if doc["current_run"]:
                doc["current_run"].setdefault("by_group", {})
        self._workspace_cache[workspace_path] = doc
        return doc

    def _migrate_legacy_workspace_file(self, workspace_path: str) -> dict[str, Any] | None:
        """First access: carry over the old `<workspace>/.agent-team/tokens.json`."""
        old_wp = Path(workspace_path) / PROJECT_DIR_NAME / TOKENS_FILE
        if not old_wp.exists():
            return None
        try:
            doc = json.loads(old_wp.read_text(encoding="utf-8"))
            if not isinstance(doc, dict):
                return None
            doc = _apply_tokens_migrations(doc)
            self._db.kv_set(
                self._workspace_kv_key(workspace_path), doc, now=int(time.time())
            )
            old_wp.unlink()
            log.info("migrated workspace tokens.json from %s into the database", old_wp)
            return doc
        except Exception as err:  # noqa: BLE001
            log.warning("failed to migrate tokens.json from %s: %s", old_wp, err)
            return None

    def _load_global(self) -> dict[str, Any]:
        doc = self._db.kv_get(_KV_GLOBAL)
        if not isinstance(doc, dict):
            return _empty_global_doc()
        doc = _apply_tokens_migrations(doc)
        for k, v in _empty_global_doc().items():
            doc.setdefault(k, v)
        schema = _coerce_schema(doc.get("schemaVersion", TOKENS_SCHEMA_VERSION))
        if schema > TOKENS_SCHEMA_VERSION:
            # Written by a newer app version; load as-is (unknown keys are
            # preserved) and don't crash.
            log.warning(
                "global tokens schemaVersion %s is newer than supported %s; loading as-is",
                schema,
                TOKENS_SCHEMA_VERSION,
            )
        return doc

    def _load_slices(self) -> None:
        """Mirror token_slices into memory, dropping rows past retention."""
        cutoff = int(time.time()) - SLICE_RETENTION_S
        with self._db.transaction() as cur:
            cur.execute("DELETE FROM token_slices WHERE slice_start < ?", (cutoff,))
            rows = cur.execute(
                "SELECT agent, profile_id, slice_start, input, cache_read,"
                " cache_creation, output, calls, turns FROM token_slices"
            ).fetchall()
        for row in rows:
            key = (str(row["agent"]), str(row["profile_id"]), int(row["slice_start"]))
            self._slices[key] = {field: int(row[field]) for field in _DETAIL_FIELDS}

    def _prune_slices_locked(self) -> None:
        cutoff = int(time.time()) - SLICE_RETENTION_S
        stale = [key for key in self._slices if key[2] < cutoff]
        for key in stale:
            self._slices.pop(key, None)
            self._dirty_slices.discard(key)
        if stale:
            self._dirty_slices.add(("", "", cutoff))  # sentinel: prune on flush

    def _load_checkpoints(self) -> None:
        with self._db.transaction() as cur:
            rows = cur.execute(
                "SELECT path, scope, data, last_seen FROM ingestion_checkpoints"
            ).fetchall()
        for row in rows:
            try:
                checkpoint = json.loads(row["data"])
            except json.JSONDecodeError:
                log.warning("checkpoint row for %r holds invalid JSON; dropped", row["path"])
                self._deleted_checkpoints.add((row["path"], row["scope"]))
                continue
            if not isinstance(checkpoint, dict):
                continue
            entry = self._files.setdefault(
                row["path"], {"global": {}, "workspaces": {}}
            )
            if row["scope"]:
                entry["workspaces"][row["scope"]] = checkpoint
            else:
                entry["global"] = checkpoint
            last_seen = int(row["last_seen"] or 0)
            self._last_seen[row["path"]] = max(
                self._last_seen.get(row["path"], 0), last_seen
            )

    # ───────────────────────── Batch save loop ──────────────────────

    def _save_loop(self) -> None:
        """Background thread: flush dirty state every _SAVE_INTERVAL_S seconds."""
        ticks_per_prune = max(1, _PRUNE_INTERVAL_S // _SAVE_INTERVAL_S)
        tick = 0
        while not self._stop_event.wait(timeout=_SAVE_INTERVAL_S):
            tick += 1
            if tick % ticks_per_prune == 0:
                self._prune_cold_windows()
            self._flush_dirty()

    def _prune_cold_windows(self) -> None:
        """Rescan checkpoints for logs that went cold since the last scan.

        Pruning only at load is not enough: a long-running session keeps
        writing to logs that later go quiet, and their dedup windows only ever
        grow from that point on.
        """
        with self._lock:
            self._prune_ingestion_files()
            self._prune_slices_locked()

    def _flush_dirty(self) -> None:
        """Commit any dirty state (called from the save loop or flush())."""
        with self._flush_lock:
            self._flush_dirty_serialized()

    def _flush_dirty_serialized(self) -> None:
        """Commit one dirty batch while the caller owns _flush_lock."""
        now = int(time.time())
        with self._lock:
            if self._enforce_legacy_key_bounds():
                self._dirty_legacy_keys = True
            ws_docs = {
                self._workspace_kv_key(ws): deepcopy(doc)
                for ws in self._dirty_workspaces
                if (doc := self._workspace_cache.get(ws)) is not None
            }
            dirty_workspaces = set(self._dirty_workspaces)
            global_doc = deepcopy(self._global_data) if self._dirty_global else None
            checkpoint_pairs = set(self._dirty_checkpoints)
            rows: list[tuple[str, str, str, int]] = []
            for path, scope in checkpoint_pairs:
                checkpoint = self._checkpoint_for_locked(path, scope)
                if checkpoint:
                    rows.append(
                        (
                            path,
                            scope,
                            _dump_compact(checkpoint),
                            self._last_seen.get(path) or now,
                        )
                    )
            deletes = set(self._deleted_checkpoints)
            deleted_scopes = set(self._deleted_scopes)
            delete_all = self._delete_all_checkpoints
            legacy_payload = (
                {
                    "keys": sorted(self._legacy_event_keys),
                    "expires_at": self._legacy_expires_at,
                }
                if self._dirty_legacy_keys
                else None
            )
            recent_payload = (
                list(self._recent_event_keys) if self._dirty_recent_keys else None
            )
            slice_rows: list[tuple[Any, ...]] = []
            slice_prune_before: int | None = None
            for key in self._dirty_slices:
                if key[0] == "":
                    slice_prune_before = max(slice_prune_before or 0, key[2])
                    continue
                bucket = self._slices.get(key)
                if bucket is not None:
                    slice_rows.append((*key, *(bucket[f] for f in _DETAIL_FIELDS)))
            dirty_slices = set(self._dirty_slices)
            delete_all_slices = self._delete_all_slices
            self._dirty_workspaces.clear()
            self._dirty_global = False
            self._dirty_checkpoints.clear()
            self._deleted_checkpoints.clear()
            self._deleted_scopes.clear()
            self._delete_all_checkpoints = False
            self._dirty_legacy_keys = False
            self._dirty_recent_keys = False
            self._dirty_slices.clear()
            self._delete_all_slices = False
        if not (
            ws_docs
            or global_doc is not None
            or rows
            or deletes
            or deleted_scopes
            or delete_all
            or legacy_payload is not None
            or recent_payload is not None
            or slice_rows
            or slice_prune_before is not None
            or delete_all_slices
        ):
            return
        try:
            # Serialize before entering the transaction: the workspace/global
            # documents can be multiple MB, and dumping them while holding the
            # shared Database lock would stall every other store on it.
            kv_payloads: list[tuple[str, str]] = [
                (kv_key, _dump_compact(doc)) for kv_key, doc in ws_docs.items()
            ]
            if global_doc is not None:
                kv_payloads.append((_KV_GLOBAL, _dump_compact(global_doc)))
            if legacy_payload is not None:
                kv_payloads.append((_KV_LEGACY_KEYS, _dump_compact(legacy_payload)))
            if recent_payload is not None:
                kv_payloads.append((_KV_RECENT_KEYS, _dump_compact(recent_payload)))
            with self._db.transaction() as cur:
                if delete_all:
                    cur.execute("DELETE FROM ingestion_checkpoints")
                for scope in deleted_scopes:
                    cur.execute(
                        "DELETE FROM ingestion_checkpoints WHERE scope = ?", (scope,)
                    )
                for path, scope in deletes:
                    cur.execute(
                        "DELETE FROM ingestion_checkpoints WHERE path = ? AND scope = ?",
                        (path, scope),
                    )
                for row in rows:
                    cur.execute(_UPSERT_CHECKPOINT, row)
                for kv_key, payload in kv_payloads:
                    cur.execute(_UPSERT_KV, (kv_key, payload, now))
                if delete_all_slices:
                    cur.execute("DELETE FROM token_slices")
                if slice_prune_before is not None:
                    cur.execute(
                        "DELETE FROM token_slices WHERE slice_start < ?",
                        (slice_prune_before,),
                    )
                for slice_row in slice_rows:
                    cur.execute(_UPSERT_SLICE, slice_row)
        except (sqlite3.Error, OSError, TypeError, ValueError) as err:
            log.warning("failed to commit token persistence batch: %s", err)
            # Re-mark everything so the next interval retries with the
            # newest in-memory state.
            with self._lock:
                self._dirty_slices.update(dirty_slices)
                self._delete_all_slices = self._delete_all_slices or delete_all_slices
                self._dirty_workspaces.update(dirty_workspaces)
                self._dirty_global = self._dirty_global or global_doc is not None
                self._dirty_checkpoints.update(checkpoint_pairs)
                self._deleted_checkpoints.update(deletes)
                self._deleted_scopes.update(deleted_scopes)
                self._delete_all_checkpoints = self._delete_all_checkpoints or delete_all
                self._dirty_legacy_keys = (
                    self._dirty_legacy_keys or legacy_payload is not None
                )
                self._dirty_recent_keys = (
                    self._dirty_recent_keys or recent_payload is not None
                )

    def flush(self) -> None:
        """Flush all pending dirty state synchronously. Call before shutdown."""
        self._stop_event.set()
        if threading.current_thread() is not self._save_thread:
            self._save_thread.join()
        self._flush_dirty()

    def _checkpoint_for_locked(self, path: str, scope: str) -> dict[str, Any] | None:
        entry = self._files.get(path)
        if not isinstance(entry, dict):
            return None
        if scope:
            value = (entry.get("workspaces") or {}).get(scope)
        else:
            value = entry.get("global")
        return value if isinstance(value, dict) and value else None

    @staticmethod
    def _row_scopes(entry: dict[str, Any]) -> list[str]:
        """Scopes of `entry` that exist as database rows."""
        scopes: list[str] = []
        if entry.get("global"):
            scopes.append("")
        scopes.extend((entry.get("workspaces") or {}).keys())
        return scopes

    def _prune_ingestion_files(self) -> None:
        """Prune the in-memory checkpoint cache; call with _lock held.

        - A log that went cold (mtime older than COLD_FILE_DAYS) has the
          dedup window stripped from its checkpoints: the offset and identity
          stay, so a file that comes back to life rebuilds its window on the
          next read. Only a *successful* stat can strip anything.
          A reader that carries its window across a rotation is exempt —
          pi.py keeps it deliberately so an in-place rewrite is not double
          counted, and marks its checkpoints with `session_id` (pi.py:336).
        - A successful stat refreshes last_seen (throttled to once per
          _LAST_SEEN_REFRESH_S so the hourly scan does not rewrite every row).
        - A path that has been unreadable (stat OSError) for DEAD_ENTRY_DAYS
          straight (per last_seen) is deleted outright; a transient I/O fault
          alone cannot remove anything.
        """
        now = time.time()
        cold_cutoff = now - COLD_FILE_DAYS * 86400
        dead_cutoff = now - DEAD_ENTRY_DAYS * 86400
        for path in list(self._files):
            entry = self._files[path]
            if not isinstance(entry, dict):
                continue
            try:
                mtime = os.stat(path).st_mtime
            except OSError:
                last_seen = self._last_seen.get(path, 0)
                if last_seen and last_seen < dead_cutoff:
                    for scope in self._row_scopes(entry):
                        self._deleted_checkpoints.add((path, scope))
                        self._dirty_checkpoints.discard((path, scope))
                    del self._files[path]
                    self._last_seen.pop(path, None)
                continue
            if now - self._last_seen.get(path, 0) > _LAST_SEEN_REFRESH_S:
                self._last_seen[path] = int(now)
                for scope in self._row_scopes(entry):
                    self._dirty_checkpoints.add((path, scope))
            if mtime >= cold_cutoff:
                continue
            scoped: list[tuple[str, Any]] = [("", entry.get("global"))]
            scoped.extend((entry.get("workspaces") or {}).items())
            for scope, checkpoint in scoped:
                if not isinstance(checkpoint, dict) or checkpoint.get("session_id"):
                    continue
                if checkpoint.pop("recent_keys", None) is not None:
                    self._dirty_checkpoints.add((path, scope))

    def _enforce_legacy_key_bounds(self) -> bool:
        """Bound the one-time migration dedup set. Returns True if it changed.

        Keys for events that never replay would otherwise linger forever.
        Expiry is stamped when keys are first seen and checked again on every
        flush so long-running processes drain too.
        """
        if not self._legacy_event_keys:
            return False
        changed = False
        if not self._legacy_expires_at:
            self._legacy_expires_at = _days_from_now_iso(LEGACY_EVENT_KEYS_TTL_DAYS)
            changed = True
        if _now_iso() >= self._legacy_expires_at:
            log.info(
                "legacy event keys expired; dropping %d entries",
                len(self._legacy_event_keys),
            )
            self._legacy_event_keys.clear()
            return True
        if len(self._legacy_event_keys) > LEGACY_EVENT_KEYS_LIMIT:
            dropped = len(self._legacy_event_keys) - LEGACY_EVENT_KEYS_LIMIT
            log.warning(
                "legacy event keys over limit; dropping %d of %d entries",
                dropped,
                len(self._legacy_event_keys),
            )
            self._legacy_event_keys = set(
                sorted(self._legacy_event_keys)[:LEGACY_EVENT_KEYS_LIMIT]
            )
            changed = True
        return changed

    # ───────────────────── Ingestion checkpoints ────────────────────

    def get_ingestion_checkpoint(
        self,
        file_path: str,
        workspace_path: str | None = None,
    ) -> dict[str, Any]:
        """Return a copy of the compact cursor for Global or one workspace."""
        with self._lock:
            entry = self._files.get(file_path, {})
            if workspace_path:
                value = entry.get("workspaces", {}).get(workspace_path, {})
            else:
                value = entry.get("global", {})
            return deepcopy(value) if isinstance(value, dict) else {}

    def _advance_ingestion_checkpoint_locked(
        self,
        file_path: str,
        checkpoint: dict[str, Any],
        workspace_path: str | None = None,
    ) -> None:
        if not file_path or not checkpoint:
            return
        entry = self._files.setdefault(file_path, {"global": {}, "workspaces": {}})
        scope = workspace_path or ""
        if scope:
            target = entry.setdefault("workspaces", {})
            if not self._checkpoint_is_newer(target.get(scope, {}), checkpoint):
                return
            target[scope] = deepcopy(checkpoint)
        else:
            if not self._checkpoint_is_newer(entry.get("global", {}), checkpoint):
                return
            entry["global"] = deepcopy(checkpoint)
        self._last_seen[file_path] = int(time.time())
        self._dirty_checkpoints.add((file_path, scope))
        self._deleted_checkpoints.discard((file_path, scope))

    @staticmethod
    def _checkpoint_is_newer(current: dict[str, Any], candidate: dict[str, Any]) -> bool:
        """Position comparison for both the advance guard and the Global
        replay-credit decision — one comparator so the two can never drift."""
        if not current:
            return True
        if candidate.get("kind") == "sqlite" and current.get("kind") == "sqlite":
            if candidate.get("identity") != current.get("identity"):
                return True
            return int(candidate.get("row_id") or 0) > int(current.get("row_id") or 0)
        if candidate.get("kind") == "jsonl" and current.get("kind") == "jsonl":
            if candidate.get("identity") != current.get("identity"):
                return True
            return int(candidate.get("offset") or 0) > int(current.get("offset") or 0)
        if candidate.get("kind") == "activity" and current.get("kind") == "activity":
            # The activity cursor is the reader's whole dedup bag (a handful of
            # sentinel keys), not a position we can order — so "newer" is
            # "different". Without this the fallthrough below marks the row
            # dirty on every parse, which for activity is every rescan of every
            # transcript, whether or not anything moved.
            return list(candidate.get("keys") or ()) != list(current.get("keys") or ())
        return True

    def advance_ingestion_checkpoint(
        self,
        file_path: str,
        checkpoint: dict[str, Any],
        workspace_path: str | None = None,
    ) -> None:
        with self._lock:
            self._advance_ingestion_checkpoint_locked(file_path, checkpoint, workspace_path)

    def _remember_event_key_locked(self, scoped_key: str) -> None:
        if not scoped_key or scoped_key in self._recent_event_key_set:
            return
        self._recent_event_keys.append(scoped_key)
        self._recent_event_key_set.add(scoped_key)
        while len(self._recent_event_keys) > RECENT_EVENT_KEYS_LIMIT:
            old = self._recent_event_keys.popleft()
            self._recent_event_key_set.discard(old)
        self._dirty_recent_keys = True

    # ───────────────────────── Run lifecycle ────────────────────────

    def start_run(
        self,
        workspace_path: str,
        *,
        run_id: str,
        task: str,
        run_dir: str,
        pipeline_id: str = "",
    ) -> dict[str, Any]:
        """Archive any in-progress current_run, then start a fresh one."""
        with self._flush_lock, self._lock:
            doc = self._load_workspace(workspace_path)
            if doc["current_run"]:
                prev = doc["current_run"]
                prev["ended_at"] = _now_iso()
                doc["runs"].append(prev)
            doc["current_run"] = _new_run(run_id, task, run_dir)
            if pipeline_id:
                doc["current_run"]["pipeline_id"] = pipeline_id
            self._dirty_workspaces.add(workspace_path)
            result = deepcopy(doc["current_run"])
            self._flush_dirty()
            return result

    def end_run(
        self,
        workspace_path: str,
        *,
        outcome: str = "",
        node_states: dict[str, Any] | None = None,
    ) -> None:
        """outcome ('completed' / 'aborted' / 'failed') and the final per-node
        run states are recorded on the archived run when given (additive keys
        the Executions view replays)."""
        with self._flush_lock, self._lock:
            doc = self._load_workspace(workspace_path)
            if doc["current_run"]:
                doc["current_run"]["ended_at"] = _now_iso()
                if outcome:
                    doc["current_run"]["outcome"] = outcome
                if node_states:
                    doc["current_run"]["node_states"] = deepcopy(node_states)
                doc["runs"].append(doc["current_run"])
                doc["current_run"] = None
            self._dirty_workspaces.add(workspace_path)
            self._flush_dirty()

    # ───────────────────────── Recording ───────────────────────────

    def record(
        self,
        workspace_path: str | None,
        *,
        source: str,           # "analyzer" | "cli"
        vendor: str,           # "claude" | "codex" | "analyzer"
        agent_key: str | None = None,
        pane_id: str | None = None,
        session_id: str | None = None,
        stage_id: str | None = None,
        group_id: str = "",
        input_tokens: int = 0,
        output_tokens: int = 0,
        dedup_key: str = "",
        ingestion_file: str = "",
        ingestion_checkpoint: dict[str, Any] | None = None,
        replay_workspace: str = "",
        legacy_dedup_key: str = "",
        profile_id: str = UNKNOWN_PROFILE_ID,
        cli_version: str = "",
        cache_read_tokens: int = 0,
        cache_creation_tokens: int = 0,
        timestamp: str = "",
    ) -> bool:
        """Add a single token event. All numeric inputs are >= 0; zeros allowed.

        profile_id / cli_version feed the by_account / by_version buckets
        (and by_account_day + token_slices, globally). cache_read_tokens and
        cache_creation_tokens are the parts of input_tokens the vendor kept
        apart, so the per-account ledgers can show the four-way split; the
        by_vendor-shaped buckets stay folded. timestamp (ISO) places the
        event on its day / slice; empty means "now".

        workspace_path may be None (e.g. for an analyzer call made before any
        workspace was selected) — those still hit the global tally.

        dedup_key is a bounded crash/retry guard. Durable replay progress comes
        from ingestion checkpoints; legacy_dedup_key is consumed only while
        converting the retired event-key files.
        """
        # Defensive normalisation: no negative tokens, no NaN.
        input_tokens = max(0, int(input_tokens))
        output_tokens = max(0, int(output_tokens))
        if input_tokens == 0 and output_tokens == 0:
            # Don't bump `calls` either — zero-zero events are no-ops.
            return False
        delta = {
            "input": input_tokens,
            "output": output_tokens,
            "calls": 1,
        }
        profile = normalize_profile_id(profile_id)
        version_key = _version_key(vendor, cli_version)
        cache_read = min(max(0, int(cache_read_tokens)), input_tokens)
        cache_creation = min(max(0, int(cache_creation_tokens)), input_tokens - cache_read)
        detail = {
            "input": input_tokens - cache_read - cache_creation,
            "cache_read": cache_read,
            "cache_creation": cache_creation,
            "output": output_tokens,
            "calls": 1,
            "turns": 0,
        }

        with self._lock:
            scope = f"workspace:{replay_workspace}" if replay_workspace else "global"
            generation = str((ingestion_checkpoint or {}).get("identity") or "")
            scoped_key = (
                f"{scope}::{generation}::{dedup_key}" if dedup_key else ""
            )
            legacy_matches = {
                key for key in (dedup_key, legacy_dedup_key)
                if key and key in self._legacy_event_keys
            }
            legacy_duplicate = bool(legacy_matches)
            recent_duplicate = bool(scoped_key and scoped_key in self._recent_event_key_set)
            global_checkpoint = self._files.get(
                ingestion_file, {}
            ).get("global", {})
            credit_global_on_replay = bool(
                replay_workspace
                and not legacy_duplicate
                and ingestion_checkpoint
                and self._checkpoint_is_newer(global_checkpoint, ingestion_checkpoint)
            )

            if legacy_duplicate:
                self._legacy_event_keys.difference_update(legacy_matches)
                self._dirty_legacy_keys = True
            if recent_duplicate or (legacy_duplicate and not replay_workspace):
                if ingestion_checkpoint:
                    if replay_workspace:
                        self._advance_ingestion_checkpoint_locked(
                            ingestion_file, ingestion_checkpoint, replay_workspace
                        )
                    else:
                        self._advance_ingestion_checkpoint_locked(
                            ingestion_file, ingestion_checkpoint
                        )
                        if workspace_path:
                            self._advance_ingestion_checkpoint_locked(
                                ingestion_file, ingestion_checkpoint, workspace_path
                            )
                return True
            self._remember_event_key_locked(scoped_key)

            # --- workspace state ---
            if workspace_path:
                doc = self._load_workspace(workspace_path)
                # current_run (only if one is active)
                if doc["current_run"]:
                    run = doc["current_run"]
                    _add(run["totals"], delta)
                    _add(run["by_vendor"].setdefault(vendor, _empty_bucket()), delta)
                    if stage_id:
                        _add(run["by_stage"].setdefault(stage_id, _empty_bucket()), delta)
                    _add(run["by_group"].setdefault(group_id, _empty_bucket()), delta)
                    if pane_id:
                        _add(run["by_pane"].setdefault(pane_id, _empty_bucket()), delta)
                # cumulative (workspace lifetime, runs included)
                cum = doc["cumulative"]
                _add(cum["totals"], delta)
                _add(cum["by_vendor"].setdefault(vendor, _empty_bucket()), delta)
                if stage_id:
                    _add(cum["by_stage"].setdefault(stage_id, _empty_bucket()), delta)
                # Always recorded — "" is the ungrouped bucket the panel shows too.
                _add(cum["by_group"].setdefault(group_id, _empty_bucket()), delta)
                _add(cum["by_account"].setdefault(profile, _empty_bucket()), delta)
                _add(cum["by_version"].setdefault(version_key, _empty_bucket()), delta)
                # The live per-session tally is deliberately NOT fed here: it is
                # read straight from the vendor's session log (set_live_total),
                # so a missed or deduped event can never make it drift.
                self._dirty_workspaces.add(workspace_path)

            # --- global state ---
            if not replay_workspace or credit_global_on_replay:
                g = self._global_data
                _add(g["all_time"], delta)
                _add(g["by_vendor"].setdefault(vendor, _empty_bucket()), delta)
                day = _today()
                _add(g["by_day"].setdefault(day, _empty_bucket()), delta)
                _add(g["by_account"].setdefault(profile, _empty_bucket()), delta)
                _add(g["by_version"].setdefault(version_key, _empty_bucket()), delta)
                self._credit_account_detail_locked(vendor, profile, timestamp, detail)
                self._dirty_global = True

            if ingestion_checkpoint:
                if replay_workspace:
                    self._advance_ingestion_checkpoint_locked(
                        ingestion_file, ingestion_checkpoint, replay_workspace
                    )
                    if credit_global_on_replay:
                        self._advance_ingestion_checkpoint_locked(
                            ingestion_file, ingestion_checkpoint
                        )
                else:
                    self._advance_ingestion_checkpoint_locked(
                        ingestion_file, ingestion_checkpoint
                    )
                    if workspace_path:
                        self._advance_ingestion_checkpoint_locked(
                            ingestion_file, ingestion_checkpoint, workspace_path
                        )

        log.debug(
            "tokens recorded source=%s vendor=%s pane=%s stage=%s in=%d out=%d",
            source, vendor, pane_id, stage_id, input_tokens, output_tokens,
        )
        return True

    def _credit_account_detail_locked(
        self, vendor: str, profile: str, timestamp: str, detail: dict[str, int]
    ) -> None:
        """Add one detail delta to by_account_day (the event's UTC day) and to
        its 5-minute slice (skipped past retention). Caller holds _lock."""
        when = _event_time(timestamp)
        days = self._global_data.setdefault("by_account_day", {})
        bucket = (
            days.setdefault(vendor, {})
            .setdefault(profile, {})
            .setdefault(_day_of(when), _empty_detail_bucket())
        )
        _add_detail(bucket, detail)
        slice_start = int(when // SLICE_S) * SLICE_S
        if slice_start >= int(time.time()) - SLICE_RETENTION_S:
            key = (vendor, profile, slice_start)
            _add_detail(self._slices.setdefault(key, _empty_detail_bucket()), detail)
            self._dirty_slices.add(key)
            self._quota_changes.add(key)

    def record_turn(
        self, vendor: str, profile_id: str, timestamp: str = ""
    ) -> None:
        """Count one finished turn (a reader's turn_complete) for the account
        the pane was pinned to, on the event's day and slice."""
        if not vendor:
            return
        profile = normalize_profile_id(profile_id)
        with self._lock:
            self._credit_account_detail_locked(
                vendor, profile, timestamp, {"turns": 1}
            )
            self._dirty_global = True

    def account_window_totals(
        self, vendor: str, profile_id: str, start: float | None, end: float
    ) -> dict[str, Any]:
        """Sum of the account's slices with slice_start in [start, end) — the
        token side of a quota cycle. ``start`` None means "from the oldest
        retained slice"."""
        profile = normalize_profile_id(profile_id)
        totals = _empty_detail_bucket()
        wall = time.time()
        with self._lock:
            for (agent, prof, slice_start), bucket in self._slices.items():
                if agent != vendor or prof != profile:
                    continue
                if slice_start < wall - SLICE_RETENTION_S:
                    continue
                if start is not None and slice_start < start:
                    continue
                if slice_start >= end:
                    continue
                _add_detail(totals, bucket)
        totals["total"] = (
            totals["input"] + totals["cache_read"] + totals["cache_creation"] + totals["output"]
        )
        state, reason = slice_coverage(start, end, self.slices_since, wall)
        totals.update(coverage_state=state, coverage_reason=reason)
        return totals

    def take_quota_changes(self, limit: int) -> list[tuple[str, str, int]]:
        with self._lock:
            out = []
            while self._quota_changes and len(out) < limit:
                out.append(self._quota_changes.pop())
            return out

    def has_quota_changes(self) -> bool:
        with self._lock:
            return bool(self._quota_changes)

    def account_day_rows(self) -> list[tuple[str, str, str, dict[str, int]]]:
        """Every (agent, profile_id, day, detail bucket) of by_account_day."""
        with self._lock:
            days = self._global_data.get("by_account_day", {})
            return [
                (agent, profile, day, dict(bucket))
                for agent, profiles in days.items()
                for profile, by_day in profiles.items()
                for day, bucket in by_day.items()
            ]

    # ───────────────────────── Snapshot ─────────────────────────────

    def snapshot(self, workspace_path: str | None) -> dict[str, Any]:
        """Materialized copy — callers may serialize it later without racing
        the live aggregation state."""
        with self._lock:
            workspace_doc = (
                self._load_workspace(workspace_path) if workspace_path else _empty_workspace_doc()
            )
            return {
                "workspace_path": workspace_path or "",
                "workspace": {
                    "current_run": deepcopy(workspace_doc["current_run"]),
                    # last 20 only — keep payload small
                    "runs": deepcopy(workspace_doc["runs"][-20:]),
                    "cumulative": deepcopy(workspace_doc["cumulative"]),
                    "live_by_session": deepcopy(
                        self._live_by_session.get(workspace_path, {})
                        if workspace_path
                        else {}
                    ),
                },
                "global": deepcopy(self._global_data),
            }

    # ──────────────────── Live per-session tally ────────────────────
    #
    # "THIS SESSION" is not accumulated from ingested events any more: the
    # number is whatever the vendor's session log actually holds. A scanner
    # (app._scan_live_session) reads the file off the event loop and publishes
    # the result here, so this store only caches it. Nothing below touches
    # cumulative, global, or any ingestion checkpoint — the same events are
    # already accounted for there and replaying them would double-count.

    @staticmethod
    def live_session_key(session_id: str, session_file: str = "") -> str:
        """Bucket key for the live tally: the SESSION's identity, never a pane's.

        A pane id is an ephemeral UUID — a pane that is restored, resumed, or
        respawned after a reconnect comes back under a new one, which used to
        split a single CLI session across several buckets and made the panel
        report "3 pane(s)" for one open pane. The session log is the thing
        being counted, so the session names the bucket. A vendor whose reader
        cannot name a session falls back to the session file's absolute path,
        which identifies the same log just as well.
        """
        return session_id or session_file

    def set_live_total(
        self, workspace_path: str, session_key: str, total: dict[str, int]
    ) -> bool:
        """Publish a session log's scanned total as that session's live tally.

        An overwrite, not an accumulation: the scan result IS the truth, so a
        stale cached value is simply replaced. Returns True when the value
        changed, which is the caller's cue to broadcast.
        """
        if not workspace_path or not session_key:
            return False
        bucket = {
            "input": int(total.get("input", 0)),
            "output": int(total.get("output", 0)),
            "calls": int(total.get("calls", 0)),
        }
        with self._lock:
            live = self._live_by_session.setdefault(workspace_path, {})
            if live.get(session_key) == bucket:
                return False
            live[session_key] = bucket
            return True

    def drop_live_session(self, workspace_path: str, session_key: str) -> None:
        """Stop reporting a session no pane is bound to any more.

        Deliberately keyed on the session, not on a pane: a pane that is
        restored or respawned gets a fresh id while the session it resumes is
        the same one, and dropping the tally per pane made a single session
        look like several.
        """
        if not workspace_path or not session_key:
            return
        with self._lock:
            buckets = self._live_by_session.get(workspace_path)
            if buckets is None:
                return
            buckets.pop(session_key, None)
            if not buckets:
                self._live_by_session.pop(workspace_path, None)

    # ──────────────────── Per-turn split (tokens.turns) ─────────────
    #
    # Like the live tally, derived from the session log on demand and never
    # written to the store: the reader cuts the file into turns, this only
    # caches the cut. Heavy — callers run it on the live-scan executor.

    def turns_for(
        self,
        reader: LogReader,
        path: Path,
        session_id: str = "",
        *,
        include_calls: bool = False,
        profile_resolver: Callable[[str | None], str] | None = None,
    ) -> dict[str, Any]:
        """Cut one session log into turns, shaped for the tokens.turns reply
        (turns + totals). Cached on (path, mtime, size, session_id), 32 deep.

        ``profile_resolver(started_at)`` names the account a turn ran on; it
        is applied to the reply rows, never to the cached TurnUsage objects,
        because the same log answers differently for different panes."""
        turns: list[TurnUsage] | None = None
        if reader.turns_method == "unsupported":
            turns = []  # no token usage in this vendor's log: nothing to read
        else:
            st = path.stat()
            key = (str(path), st.st_mtime, st.st_size, session_id)
            with self._lock:
                turns = self._turns_cache.get(key)
                if turns is not None:
                    self._turns_cache.move_to_end(key)
        if turns is None:
            turns = reader.turns_for_session(path, session_id)
            with self._lock:
                self._turns_cache[key] = turns
                self._turns_cache.move_to_end(key)
                while len(self._turns_cache) > TURNS_CACHE_LIMIT:
                    self._turns_cache.popitem(last=False)
        totals = {"input": 0, "cache_read": 0, "cache_creation": 0, "output": 0, "total": 0, "calls": 0}
        rows: list[dict[str, Any]] = []
        accounts: list[str] = []
        for turn in turns:
            profile = (
                normalize_profile_id(profile_resolver(turn.started_at))
                if profile_resolver is not None else turn.profile_id
            )
            if profile not in accounts:
                accounts.append(profile)
            row: dict[str, Any] = {
                "turn_index": turn.turn_index,
                "started_at": turn.started_at,
                "ended_at": turn.ended_at,
                "prompt_excerpt": turn.prompt_excerpt,
                "input": turn.input,
                "cache_read": turn.cache_read,
                "cache_creation": turn.cache_creation,
                "output": turn.output,
                "total": turn.total,
                "calls": turn.call_count,
                "profile_id": profile,
                "cli_version": turn.cli_version,
            }
            if include_calls:
                row["calls_detail"] = [
                    {
                        "ts": c.ts, "model": c.model, "input": c.input,
                        "cache_read": c.cache_read, "cache_creation": c.cache_creation,
                        "output": c.output, "cli_version": c.cli_version,
                    }
                    for c in turn.calls
                ]
            rows.append(row)
            for field in ("input", "cache_read", "cache_creation", "output", "total"):
                totals[field] += row[field]
            totals["calls"] += turn.call_count
        return {
            "method": reader.turns_method, "turns": rows, "totals": totals,
            "accounts": accounts,
        }

    # ───────────────────────── Reset ────────────────────────────────

    def reset(self, scope: str, workspace_path: str | None = None) -> dict[str, Any]:
        """Reset scope = 'run' | 'workspace' | 'global'."""
        with self._flush_lock, self._lock:
            if scope == "run" and workspace_path:
                doc = self._load_workspace(workspace_path)
                # Replace current_run with a fresh blank (preserve run_id/task)
                if doc["current_run"]:
                    cur = doc["current_run"]
                    doc["current_run"] = _new_run(
                        run_id=cur["run_id"],
                        task=cur["task"],
                        run_dir=cur.get("run_dir", ""),
                    )
                else:
                    # Without a run the panel's top block shows the live
                    # per-session tally, so that is what its reset clears.
                    self._live_by_session.pop(workspace_path, None)
                self._dirty_workspaces.add(workspace_path)
            elif scope == "workspace" and workspace_path:
                self._workspace_cache[workspace_path] = _empty_workspace_doc()
                self._dirty_workspaces.add(workspace_path)
                for entry in self._files.values():
                    if isinstance(entry, dict):
                        entry.get("workspaces", {}).pop(workspace_path, None)
                self._dirty_checkpoints = {
                    pair for pair in self._dirty_checkpoints if pair[1] != workspace_path
                }
                self._deleted_scopes.add(workspace_path)
            elif scope == "global":
                self._global_data = _empty_global_doc()
                self._dirty_global = True
                self._slices.clear()
                self._dirty_slices.clear()
                self._quota_changes.clear()
                self._delete_all_slices = True
                self.slices_since = time.time()
                self._db.kv_set("tokens.slices_since", self.slices_since, now=int(self.slices_since))
                self._files.clear()
                self._last_seen.clear()
                self._dirty_checkpoints.clear()
                self._deleted_checkpoints.clear()
                self._deleted_scopes.clear()
                self._delete_all_checkpoints = True
                self._legacy_event_keys.clear()
                self._legacy_expires_at = None
                self._recent_event_keys.clear()
                self._recent_event_key_set.clear()
                self._dirty_legacy_keys = True
                self._dirty_recent_keys = True
            else:
                raise ValueError(f"unknown reset scope: {scope!r}")
            result = self.snapshot(workspace_path)
            self._flush_dirty()
            return result


def _dump_compact(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"))

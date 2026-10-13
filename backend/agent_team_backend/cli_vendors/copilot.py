"""GitHub Copilot CLI conversation log reader.

TWO storage layouts live under the root ($COPILOT_HOME, default ~/.copilot);
the reader dispatches on the file NAME:

  <root>/session-store.db                     — every version (central SQLite)
  <root>/session-state/<uuid>/events.jsonl    — 1.0.75 only (per-session JSONL)
  <root>/session-state/<uuid>/workspace.yaml  — id / cwd / timestamps

`<uuid>` (the session-state dir name, = sessions.id in the store) is the exact
id `copilot --resume=<id>` accepts, in both layouts.

They are NOT two generations that never overlap: 1.0.75 wrote BOTH. Measured
on the local data for session e6495800-dfd4-4a75-b2ab-d70980f83b89:

  events.jsonl session.start   copilotVersion 1.0.75  18:33:56.867Z
  sessions.created_at (store)                         18:33:56.866Z
  assistant_usage_events                              input 19898 / output 39
  events.jsonl session.shutdown modelMetrics          input 19898 / output 39

One run, one millisecond apart, identical totals. What 1.0.78 changed is only
that it STOPPED writing events.jsonl — so a 1.0.75 session carries two
complete, independent records of the same tokens. See "Never counted twice".

── 1.0.78+: session-store.db ────────────────────────────────────────────────
Copilot CLI 1.0.78 moved session data into one central SQLite store and stopped
writing events.jsonl at session start: the only local events.jsonl records
copilotVersion 1.0.75 in its own session.start line, while every session dir
created afterwards has none. Every read path used to take events.jsonl as its
ONLY input, so 1.0.78 sessions were silently invisible — no tokens, no
agent_active, no turn_complete (which also broke pane auto-naming, marker
binding, Agent History and inter-CLI messaging for Copilot panes).

Tables consumed (schema_version 6):
  * sessions(id, cwd, …)            — cwd, so workspace.yaml is not needed.
  * turns(id, session_id, turn_index, user_message, assistant_response,
    timestamp) — one row per completed turn. The row IS the turn boundary
    (measured: turn row 18:34:04.115 vs the 1.0.75 assistant.turn_end
    18:34:04.104), so unlike grok no idle-timeout inference is needed.
    user_message is the VERBATIM user text, so kickoff at-pane markers land
    here.
  * assistant_usage_events(id AUTOINCREMENT, session_id, model, input_tokens,
    output_tokens, cache_*_tokens, reasoning_tokens, created_at) — written per
    API call, i.e. live during a turn. This also fixes the long-standing
    events.jsonl defect where a long-running session showed 0 tokens until
    shutdown/compaction.

Token buckets (verified live against the local store, and byte-identical to
the same session's 1.0.75 events.jsonl): input_tokens ALREADY includes
cache_read_tokens + cache_write_tokens (19898 = 9 input + 0 cache_read +
19889 cache_write, cross-checked against token_details_json), and
output_tokens already includes reasoning_tokens. They therefore map STRAIGHT
onto TokenUsage's cache-folded-into-input / reasoning-folded-into-output
design — re-adding the cache columns would double-count.

Known semantic difference vs the 1.0.75 path: the turn boundary and the user
text only become visible when the turn ENDS, so pane auto-naming and marker
binding land one turn later than they used to. Since the store now serves
1.0.75 sessions too (see below), that latency applies to every Copilot pane.
cursor / opencode already have comparable latency.

── 1.0.75: events.jsonl (fallback only) ─────────────────────────────────────
Every line is `{type, data, id, timestamp, parentId}` (ISO 8601). Types:
  * user.message       — data.content is the VERBATIM user text.
  * assistant.message  — data.content / data.model (activity + turn text).
  * assistant.turn_end — explicit end-of-turn record → turn_complete.
  * session.shutdown   — data.modelMetrics.<model>.usage carries the run's
                         token buckets; compaction events carry the same shape
                         mid-run.
usage.inputTokens already folds cacheRead+cacheWrite and usage.outputTokens
already folds reasoning (same convention as the store). Totals appear only on
shutdown / compaction and are point-in-time snapshots, so they are treated as
CUMULATIVE like the Codex reader: emit the delta against the previous
snapshot, and silently reset the baseline when totals shrink (session
rotation, or a resumed run restarting its in-process counters — this never
double-counts, at worst it undercounts a resumed run).

Never counted twice: disjoint dedup_key prefixes are NOT a defence. The two
branches differ in both dedup_key (`copilot_usage::` vs `copilot_cumulative::`)
and file_path, and tokens_store dedups on dedup_key alone — so nothing
downstream can tell that a 1.0.75 session's store rows and its events.jsonl
snapshot describe the same tokens, and both would be credited. The store is
therefore the single authority: the whole events.jsonl branch (tokens AND
activity) bails out for a session id that `session-store.db` already lists in
`sessions` (`_db_owns_session`). events.jsonl is read only when the store is
missing, unreadable, or does not know the session — which also covers the
never-ruled-out case of 1.0.78 creating events.jsonl lazily, since a session
the store knows is served by the store either way.

Concurrency: the copilot process owns the store's writer, so every connection
here is read-only (`file:…?mode=ro`), short-lived and busy-tolerant — any
sqlite error is "no new data this cycle". The FIRST such error also emits one
WARNING, because this whole class of breakage went unnoticed for weeks
precisely because the reader never said anything when its input vanished.
"""

from __future__ import annotations

import json
import logging
import os
from collections.abc import Iterable
from pathlib import Path
from typing import Any

import yaml

import asyncio
import re
import sqlite3
import sys
import time

from .. import osplat
from .base import ExtensionsSource, ExtensionsSpec  # noqa: F401
from .base import (
    PlatformInstall,
    AccountSwitchSpec,
    Dep,
    McpServerConfig,
    McpValue,
    McpWiring,
    SkillsWiring,
    VendorSpec,
    command_text,
)
from ..usage_common import (
    HTTP_TIMEOUT,
    _num,
    _snapshot,
    _window,
    communicate_or_kill as _communicate_or_kill,
    parse_retry_after,
)
from ..log_readers.base import (
    ActivityEvent,
    IncrementalParseResult,
    LogReader,
    TokenUsage,
    activity_high_water,
    read_jsonl_tail,
    set_activity_high_water,
    user_prompt_text,
)

log = logging.getLogger("agent_team_backend.log_readers.copilot")

# Sentinel prefixes persisted inside the watcher-owned per-file seen_keys set
# (same trick as the Codex reader): the previous cumulative totals, and the
# latest assistant text so a turn whose assistant.message and turn_end land
# in different poll batches still delivers the text on turn_complete.
_CUM_PREFIX = "__cum__:"
_TEXT_PREFIX = "__lasttext__:"

# Store-activity watermarks, one per source table, replacing the
# `db_act:usage:<id>` / `db_act:turn:<id>` key this reader used to leave in
# seen_keys per row. Those grew without bound in a store that holds EVERY
# session, pushing the bag past the watcher's _ACTIVITY_KEYS_PERSIST_LIMIT — so
# it was never written to the durable "@activity" checkpoint and Copilot
# replayed its whole history on every backend start (GitHub #28).
#
# One mark per table is enough, and it is GLOBAL rather than per-session:
# `turns.id` and `assistant_usage_events.id` are both INTEGER PRIMARY KEY
# AUTOINCREMENT, so they ascend across every session in the store and are never
# reused after a delete. (`turn_index` is the per-session counter, and a single
# mark over THAT would swallow every row of a younger session.)
_DB_USAGE_HW_PREFIX = "db_act_hw::usage:"
_DB_TURN_HW_PREFIX = "db_act_hw::turn:"

#: 1.0.78+ central session store, directly under the root.
_DB_NAME = "session-store.db"
#: Row-fetch busy wait: long enough to ride out a copilot write transaction,
#: short enough not to stall the watcher's drain thread (grok's budget).
_BUSY_TIMEOUT_MS = 250

_USAGE_SQL = """
SELECT a.id, a.session_id, a.model, a.input_tokens, a.output_tokens,
       a.created_at, COALESCE(s.cwd, '')
FROM assistant_usage_events a
LEFT JOIN sessions s ON s.id = a.session_id
ORDER BY a.id
"""

# The watermark row's own columns, so a replacement store can be recognised
# even when it lands on the same dev:ino (Linux reuses a freed inode number
# for the very next file created).
_ANCHOR_SQL = """
SELECT session_id, model, input_tokens, output_tokens, created_at
FROM assistant_usage_events WHERE id = ?
"""


def _anchor(values: tuple) -> str:
    """Fingerprint of one usage row, columns in `_ANCHOR_SQL` order."""
    return "|".join(str(v) for v in values)

_TURNS_SQL = """
SELECT t.id, t.session_id, t.user_message, t.assistant_response, t.timestamp,
       COALESCE(s.cwd, '')
FROM turns t
LEFT JOIN sessions s ON s.id = t.session_id
ORDER BY t.id
"""

_SESSION_ROW_SQL = "SELECT 1 FROM sessions WHERE id = ? LIMIT 1"

_MARKER_SQL = """
SELECT t.session_id, t.user_message, COALESCE(s.cwd, '')
FROM turns t
LEFT JOIN sessions s ON s.id = t.session_id
WHERE t.user_message LIKE '%at-pane:%'
ORDER BY t.id
"""

#: One WARNING per process for a failed store read (see module docstring).
_db_warned = False


def _reset_db_warning() -> None:
    """Test hook: re-arm the once-per-process store warning."""
    global _db_warned
    _db_warned = False


def _warn_db_once(path: Path, err: object) -> None:
    global _db_warned
    if _db_warned:
        return
    _db_warned = True
    log.warning(
        "copilot session-store read failed (%s): %s — Copilot token/turn "
        "tracking is degraded; the store schema may have changed",
        path, err,
    )


def copilot_root() -> Path:
    """Copilot CLI's config/session root ($COPILOT_HOME, default ~/.copilot)."""
    env = os.environ.get("COPILOT_HOME")
    return Path(env) if env else Path.home() / ".copilot"


def _same_path(a: str, b: str) -> bool:
    """Path equality tolerant of symlinked roots.

    ``sessions.cwd`` records the resolved path the CLI was launched in
    (macOS: ``/private/tmp/…``) while a pane may carry the symlink form
    (``/tmp/…``), so a plain string compare drops those events.
    """
    if not a or not b:
        return False
    if a == b:
        return True
    try:
        return os.path.realpath(a) == os.path.realpath(b)
    except OSError:
        return False


def _int(v) -> int:  # noqa: ANN001
    try:
        return max(0, int(v))
    except (TypeError, ValueError):
        return 0


def _read_cumulative(seen_keys: set[str]) -> tuple[int, int]:
    """Return (prev_input, prev_output) from sentinel key, or (0, 0)."""
    for k in seen_keys:
        if k.startswith(_CUM_PREFIX):
            try:
                _, body = k.split(":", 1)
                parts = dict(p.split("=") for p in body.split(","))
                return int(parts.get("in", 0)), int(parts.get("out", 0))
            except (ValueError, KeyError):
                continue
    return 0, 0


def _write_cumulative(seen_keys: set[str], input_total: int, output_total: int) -> None:
    for k in [k for k in seen_keys if k.startswith(_CUM_PREFIX)]:
        seen_keys.discard(k)
    seen_keys.add(f"{_CUM_PREFIX}in={input_total},out={output_total}")


def _read_last_text(seen_keys: set[str]) -> str:
    for k in seen_keys:
        if k.startswith(_TEXT_PREFIX):
            return k[len(_TEXT_PREFIX):]
    return ""


def _write_last_text(seen_keys: set[str], text: str) -> None:
    for k in [k for k in seen_keys if k.startswith(_TEXT_PREFIX)]:
        seen_keys.discard(k)
    seen_keys.add(f"{_TEXT_PREFIX}{text}")


def _read_mark(seen_keys: set[str], prefix: str) -> int | None:
    """The integer sentinel stored under `prefix`, or None when never set.

    None and 0 are NOT the same: 0 is a table that has been walked and held
    nothing, None is a table no pass has looked at yet.
    """
    for k in seen_keys:
        if k.startswith(prefix):
            try:
                return int(k[len(prefix):])
            except ValueError:
                return None
    return None


def _write_mark(seen_keys: set[str], prefix: str, value: int) -> None:
    seen_keys.difference_update({k for k in seen_keys if k.startswith(prefix)})
    seen_keys.add(f"{prefix}{int(value)}")


def _metrics_totals(data: dict) -> tuple[int, int] | None:
    """Cumulative (input, output) totals from a metrics-bearing event's data.

    modelMetrics (per-model buckets, summed across models) is authoritative;
    the top-level tokenDetails buckets are the fallback for shapes that omit
    it. Returns None when the record carries no token buckets at all (e.g.
    session.usage_checkpoint only records billing units).
    """
    metrics = data.get("modelMetrics")
    if isinstance(metrics, dict) and metrics:
        total_in = total_out = 0
        usable = False
        for per_model in metrics.values():
            usage = per_model.get("usage") if isinstance(per_model, dict) else None
            if isinstance(usage, dict):
                usable = True
                total_in += _int(usage.get("inputTokens"))
                total_out += _int(usage.get("outputTokens"))
        # No per-model entry carried a usage dict — that is "no reading", not
        # a genuine zero total; fall through to the tokenDetails branch.
        if usable:
            return total_in, total_out
    details = data.get("tokenDetails")
    if isinstance(details, dict):
        def bucket(name: str) -> int:
            b = details.get(name)
            return _int(b.get("tokenCount")) if isinstance(b, dict) else 0

        input_tokens = bucket("input") + bucket("cache_read") + bucket("cache_write")
        return input_tokens, bucket("output")
    return None


class CopilotLogReader(LogReader):
    vendor: str = "copilot"

    def _sessions_root(self) -> Path:
        return copilot_root() / "session-state"

    def _db_path(self) -> Path:
        return copilot_root() / _DB_NAME

    def project_dirs(self) -> list[Path]:
        """The CLI root itself (empty list when it doesn't exist).

        NOT session-state: the 1.0.78 store sits one level above it, and
        claims_path()/watch_dirs() derive from this list — scoping to
        session-state would leave session-store.db unclaimed and unwatched.
        """
        default = copilot_root()
        return [default] if default.is_dir() else []

    def session_files(self) -> list[Path]:
        """The central store (1.0.78+) plus every events.jsonl (1.0.75)."""
        out: list[Path] = []
        db = self._db_path()
        if db.is_file():
            out.append(db)
        root = self._sessions_root()
        try:
            for f in root.glob("*/events.jsonl"):
                if f.is_file():
                    out.append(f)
        except OSError as err:
            log.debug("glob %s failed: %s", root, err)
        return out

    def _query(self, path: Path, sql: str, params: tuple = ()) -> list[tuple] | None:
        """Short-lived read-only query. None = store unreadable this cycle
        (missing / busy / locked / schema drift) — callers treat it as no
        data, and the first failure warns once."""
        try:
            con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
            try:
                con.execute(f"PRAGMA busy_timeout = {_BUSY_TIMEOUT_MS}")
                return con.execute(sql, params).fetchall()
            finally:
                con.close()
        except (sqlite3.Error, OSError) as err:
            _warn_db_once(path, err)
            log.debug("sqlite read %s failed: %s", path, err)
            return None

    def _workspace_meta(self, path: Path) -> dict:
        """The session's sibling workspace.yaml ({} when unreadable)."""
        meta = path.parent / "workspace.yaml"
        try:
            rec = yaml.safe_load(meta.read_text(encoding="utf-8"))
        except (OSError, yaml.YAMLError):
            return {}
        return rec if isinstance(rec, dict) else {}

    def cwd_from_file(self, path: Path) -> str:
        # The store spans every workspace, so no single cwd names it; per-row
        # cwd comes from the sessions JOIN instead.
        if path.name == _DB_NAME:
            return ""
        return str(self._workspace_meta(path).get("cwd") or "")

    def session_id_from_path(self, path: Path) -> str:
        """Id is the session dir name (what `copilot --resume=<id>` accepts),
        NOT the stem — every 1.0.75 session file is events.jsonl. Sibling
        files in the session dir (workspace.yaml, checkpoints/) are not
        session files → '' so the resume sink skips them instead of coining
        bogus ids like "workspace".

        The 1.0.78 store holds EVERY session, so no single id names it; it
        returns its stem purely so the session sink proceeds to marker
        binding (which resolves real ids from the db), exactly as grok's
        grok.db does. Nothing consumes this value as a resume id.
        """
        if path.name == _DB_NAME:
            return path.stem
        if path.name != "events.jsonl" or path.parent.parent.name != "session-state":
            return ""
        return path.parent.name

    def has_session(self, session_id: str) -> bool:
        """True when the id names a resumable session: a store turn (1.0.78+)
        or an events.jsonl (1.0.75). The resume preflight uses this because
        `copilot --resume=<stale-id>` would not fail — it silently starts a
        blank NEW session under that UUID."""
        session_id = session_id.strip()
        if not session_id or "/" in session_id:
            return False
        if _session_has_turns(session_id):
            return True
        return (self._sessions_root() / session_id / "events.jsonl").is_file()

    def session_files_for_workspace(self, workspace_path: str) -> list[Path]:
        """The store (it holds every workspace's sessions, so it can never be
        scoped away) plus the events.jsonl files whose workspace.yaml cwd
        matches — Copilot keys session dirs by uuid, not by cwd."""
        out: list[Path] = []
        db = self._db_path()
        if db.is_file():
            out.append(db)
        out.extend(
            p for p in self.session_files()
            if p.name == "events.jsonl"
            and _same_path(self.cwd_from_file(p), workspace_path)
        )
        return out

    # ---- 1.0.78+ store ----------------------------------------------------

    def _usage_from_row(
        self, path: Path, row: tuple, checkpoint: dict | None = None
    ) -> TokenUsage | None:
        """One assistant_usage_events row → TokenUsage (None when empty).

        input_tokens/output_tokens are used AS THEY STAND: the store already
        folds cache read+write into input and reasoning into output (see the
        module docstring's live cross-check), which is exactly TokenUsage's
        convention. Adding the cache columns here would double-count.
        """
        row_id, session_id, model, inp, outp, created_at, cwd = row
        input_tokens = _int(inp)
        output_tokens = _int(outp)
        if input_tokens == 0 and output_tokens == 0:
            return None
        return TokenUsage(
            vendor="copilot",
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            cwd=str(cwd or ""),
            session_id=str(session_id or ""),
            file_path=str(path),
            # Prefix disjoint from the events.jsonl branch's
            # "copilot_cumulative::". That is only a namespace, NOT the
            # anti-double-count guard — _db_owns_session is (see docstring).
            dedup_key=f"copilot_usage::{row_id}",
            timestamp=str(created_at or ""),
            model=str(model or ""),
            checkpoint=dict(checkpoint or {}),
        )

    def _parse_db_session_file(
        self, path: Path, seen_keys: set[str]
    ) -> list[TokenUsage]:
        rows = self._query(path, _USAGE_SQL)
        if rows is None:
            return []
        out: list[TokenUsage] = []
        for row in rows:
            key = f"copilot_usage::{row[0]}"
            if key in seen_keys:
                continue
            seen_keys.add(key)
            event = self._usage_from_row(path, row)
            if event is not None:
                out.append(event)
        return out

    def _parse_db_incremental(
        self, path: Path, checkpoint: dict
    ) -> IncrementalParseResult:
        try:
            stat = path.stat()
        except OSError:
            return IncrementalParseResult([], dict(checkpoint))
        identity = f"{stat.st_dev}:{stat.st_ino}"
        replaced = bool(
            checkpoint.get("identity") and checkpoint.get("identity") != identity
        )
        last_row_id = 0 if replaced else max(0, int(checkpoint.get("row_id") or 0))
        anchor = "" if replaced else str(checkpoint.get("anchor") or "")
        if last_row_id and anchor:
            # Same dev:ino is not proof of the same store. A row standing
            # under the watermark id that is not the row the mark was taken
            # from was never credited: re-anchor just below it, never rescan,
            # as for a dropped watermark. A missing row is left to the drop
            # check below; a checkpoint without an anchor is trusted as before.
            current = self._query(path, _ANCHOR_SQL, (last_row_id,))
            if current and _anchor(current[0]) != anchor:
                last_row_id -= 1
                anchor = ""
        rows = self._query(path, _USAGE_SQL.replace(
            "ORDER BY a.id", f"WHERE a.id > {last_row_id} ORDER BY a.id"))
        if rows is None:
            return IncrementalParseResult([], dict(checkpoint))
        if not rows and last_row_id:
            max_rows = self._query(
                path, "SELECT COALESCE(MAX(id), 0) FROM assistant_usage_events")
            if max_rows is not None:
                max_row_id = int(max_rows[0][0]) if max_rows else 0
                if max_row_id < last_row_id:
                    # Watermark dropped (store rebuilt / rotated under the same
                    # inode): RE-ANCHOR, never rescan — everything at or below
                    # the new max was already credited under the old numbering,
                    # so rescanning would credit the whole history twice.
                    last_row_id = max_row_id
                    current = self._query(path, _ANCHOR_SQL, (last_row_id,))
                    anchor = _anchor(current[0]) if current else ""

        out: list[TokenUsage] = []
        next_row_id = last_row_id
        for row in rows:
            next_row_id = max(next_row_id, int(row[0]))
            anchor = _anchor(row[1:6])
            cursor = {
                "kind": "sqlite", "row_id": next_row_id, "identity": identity, "anchor": anchor,
            }
            event = self._usage_from_row(path, row, cursor)
            if event is not None:
                out.append(event)
        return IncrementalParseResult(
            out,
            {"kind": "sqlite", "row_id": next_row_id, "identity": identity, "anchor": anchor},
        )

    def _parse_db_activity(
        self, path: Path, seen_keys: set[str]
    ) -> list[ActivityEvent]:
        """Store activity: usage rows are the in-turn heartbeat, turn rows are
        the boundary.

        A `turns` row appears only when the turn ENDS and carries both sides of
        it, so each new row yields the user's `agent_active` (pane auto-naming
        reads the first one) immediately followed by `turn_complete` carrying
        assistant_response — the text the frontend parses the inter-CLI
        messaging protocol out of. Heartbeats are emitted first so
        turn_complete always closes the batch.

        Consequence of the store's design: user text and turn boundaries are
        one turn late compared with the 1.0.75 events.jsonl path, which saw
        user.message the moment it was typed.

        Both tables are read from a watermark rather than scanned whole, so a
        restart resumes instead of replaying — see _DB_USAGE_HW_PREFIX.
        """
        out: list[ActivityEvent] = []

        usage_mark = self._db_watermark(
            path, seen_keys, _DB_USAGE_HW_PREFIX,
            "SELECT COALESCE(MAX(id), 0) FROM assistant_usage_events",
        )
        usage_rows = self._query(
            path,
            _USAGE_SQL.replace("ORDER BY a.id", "WHERE a.id > ? ORDER BY a.id"),
            (usage_mark,),
        )
        next_usage = usage_mark
        for row in usage_rows or []:
            key = f"db_act:usage:{row[0]}"
            next_usage = max(next_usage, int(row[0]))
            out.append(ActivityEvent(
                vendor="copilot", event_type="agent_active",
                cwd=str(row[6] or ""), session_id=str(row[1] or ""),
                file_path=str(path), dedup_key=key,
                timestamp=str(row[5] or ""), detail="assistant",
            ))
        if usage_rows is not None:
            _write_mark(seen_keys, _DB_USAGE_HW_PREFIX, next_usage)

        turn_mark = self._db_watermark(
            path, seen_keys, _DB_TURN_HW_PREFIX,
            "SELECT COALESCE(MAX(id), 0) FROM turns",
        )
        turn_rows = self._query(
            path,
            _TURNS_SQL.replace("ORDER BY t.id", "WHERE t.id > ? ORDER BY t.id"),
            (turn_mark,),
        )
        next_turn = turn_mark
        for row_id, session_id, user_message, assistant_response, ts, cwd in turn_rows or []:
            key = f"db_act:turn:{row_id}"
            next_turn = max(next_turn, int(row_id))
            sid = str(session_id or "")
            cwd = str(cwd or "")
            ts = str(ts or "")
            out.append(ActivityEvent(
                vendor="copilot", event_type="agent_active",
                cwd=cwd, session_id=sid, file_path=str(path), dedup_key=key,
                timestamp=ts, detail="user",
                text=user_prompt_text(str(user_message or "")),
            ))
            out.append(ActivityEvent(
                vendor="copilot", event_type="turn_complete",
                cwd=cwd, session_id=sid, file_path=str(path),
                dedup_key=f"db_turn:{row_id}", timestamp=ts, detail="turn_row",
                text=str(assistant_response or ""),
            ))
        if turn_rows is not None:
            _write_mark(seen_keys, _DB_TURN_HW_PREFIX, next_turn)
        return out

    def _db_watermark(
        self, path: Path, seen_keys: set[str], prefix: str, max_sql: str
    ) -> int:
        """The id this table has been read up to, re-anchored if it shrank.

        AUTOINCREMENT ids are never reused, so a delete cannot make the mark
        skip a row — but the store being REPLACED restarts them at 1, and the
        bag is keyed by path, so the replacement lands on the same bag with the
        old mark still standing above every id the new store will hand out.

        A shrink therefore re-anchors to 0, not to the new max: under restarted
        ids nothing in the store has been delivered yet, and re-anchoring to
        the max would skip whatever is already in it. The two errors are not
        symmetric — a duplicate is absorbed downstream, because dedup_key is a
        stable function of the row id, while a skipped row has no second
        chance.
        """
        mark = _read_mark(seen_keys, prefix)
        if mark is None:
            return 0
        mark = max(0, mark)
        if not mark:
            return 0
        top = self._query(path, max_sql)
        if top is None:
            return mark
        if int(top[0][0] or 0) < mark:
            _write_mark(seen_keys, prefix, 0)
            return 0
        return mark

    def find_sessions_by_marker(
        self, markers: Iterable[str]
    ) -> dict[str, tuple[str, str]]:
        """marker → (session_id, session cwd) for kickoff markers.

        The store's `turns.user_message` keeps the user's text verbatim, so the
        at-pane marker lands there — but only once the turn ENDS, hence the
        one-turn binding latency noted in the module docstring. Falls back to
        scanning 1.0.75 events.jsonl files, which is the only marker source on
        a CLI old enough to have no store (attribution's shared-db path
        returns before the per-file marker path can run).
        """
        wanted = [m for m in markers if m]
        if not wanted:
            return {}
        found: dict[str, tuple[str, str]] = {}
        db = self._db_path()
        if db.is_file():
            for session_id, user_message, cwd in self._query(db, _MARKER_SQL) or []:
                text = str(user_message or "")
                for marker in wanted:
                    if marker not in found and marker in text:
                        found[marker] = (str(session_id or ""), str(cwd or ""))
        if all(m in found for m in wanted):
            return found
        for events in self.session_files():
            if events.name != "events.jsonl":
                continue
            try:
                # Markers live in the first user turn; cap the read so a long
                # session doesn't cost a full scan on every watcher event.
                text = events.read_text(encoding="utf-8", errors="ignore")[:524_288]
            except OSError:
                continue
            for marker in wanted:
                if marker not in found and marker in text:
                    found[marker] = (events.parent.name, self.cwd_from_file(events))
        return found

    # ---- 1.0.75 events.jsonl ----------------------------------------------

    def _db_owns_session(self, path: Path) -> bool:
        """True when the store already covers this events.jsonl's session.

        1.0.75 wrote the store AND events.jsonl for the same run (see the
        module docstring's measurement), and the two branches' events are
        indistinguishable downstream — so whenever `sessions` lists the id,
        the store is the authority and this file is skipped entirely.
        A missing or unreadable store answers False, which keeps the
        events.jsonl branch as the fallback it is meant to be.
        """
        session_id = path.parent.name
        db = self._db_path()
        if not session_id or not db.is_file():
            return False
        rows = self._query(db, _SESSION_ROW_SQL, (session_id,))
        return bool(rows)

    def parse_session_file(
        self, path: Path, seen_keys: set[str]
    ) -> list[TokenUsage]:
        if path.name == _DB_NAME:
            return self._parse_db_session_file(path, seen_keys)
        if path.name != "events.jsonl" or self._db_owns_session(path):
            return []
        try:
            fh = path.open(encoding="utf-8")
        except OSError as err:
            log.debug("open %s failed: %s", path, err)
            return []

        prev_in, prev_out = _read_cumulative(seen_keys)
        latest_in, latest_out = prev_in, prev_out
        latest_event: dict | None = None
        model = ""
        cli_version = ""
        session_id = path.parent.name
        cwd = self.cwd_from_file(path)

        with fh:
            for line_no, raw in enumerate(fh, 1):
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    rec = json.loads(raw)
                except json.JSONDecodeError:
                    log.debug("%s:%d malformed JSON, skipping", path.name, line_no)
                    continue
                data = rec.get("data")
                if not isinstance(data, dict):
                    continue
                # session.start names the CLI build (events.jsonl only; the
                # session-store.db path has no version column).
                cli_version = str(data.get("copilotVersion") or "") or cli_version
                totals = _metrics_totals(data)
                if totals is None:
                    continue
                latest_in, latest_out = totals
                latest_event = rec
                model = str(data.get("currentModel") or "") or model

        if latest_event is None:
            return []

        delta_in = latest_in - prev_in
        delta_out = latest_out - prev_out
        # Totals shrank (rotation / a resumed run's counters restarting):
        # reset the baseline WITHOUT emitting, or we'd emit a negative delta.
        if delta_in < 0 or delta_out < 0:
            _write_cumulative(seen_keys, latest_in, latest_out)
            return []
        if delta_in == 0 and delta_out == 0:
            return []

        _write_cumulative(seen_keys, latest_in, latest_out)
        return [
            TokenUsage(
                vendor="copilot",
                input_tokens=delta_in,
                output_tokens=delta_out,
                cwd=cwd,
                session_id=session_id,
                file_path=str(path),
                dedup_key=f"copilot_cumulative::{session_id}::{latest_in}::{latest_out}",
                timestamp=str(latest_event.get("timestamp") or ""),
                model=model,
                cli_version=cli_version,
            )
        ]

    def parse_incremental(
        self,
        path: Path,
        checkpoint: dict,
    ) -> IncrementalParseResult:
        """Read only the events tail while persisting the cumulative baseline.

        Metrics snapshots land only at shutdown/compaction, so most polls
        emit nothing; when one lands, emit its delta against the persisted
        totals, which are a high-water mark: a downward blip emits nothing and
        leaves the baseline where it was.

        The 1.0.78 store takes the row-watermark branch instead; anything else
        under the root (config.json, logs) is not a session file.
        """
        if path.name == _DB_NAME:
            return self._parse_db_incremental(path, checkpoint)
        if path.name != "events.jsonl" or self._db_owns_session(path):
            return IncrementalParseResult([], dict(checkpoint))
        records, next_checkpoint, rotated = read_jsonl_tail(path, checkpoint)
        replaced = bool(
            rotated
            and checkpoint.get("identity")
            and checkpoint.get("identity") != next_checkpoint.get("identity")
        )
        prev_in = 0 if replaced else _int(checkpoint.get("input_total"))
        prev_out = 0 if replaced else _int(checkpoint.get("output_total"))
        latest_in, latest_out = prev_in, prev_out
        model = "" if replaced else str(checkpoint.get("model") or "")
        cwd = "" if replaced else str(checkpoint.get("cwd") or "")
        cli_version = "" if replaced else str(checkpoint.get("cli_version") or "")
        if not cwd:
            cwd = self.cwd_from_file(path)
        session_id = path.parent.name
        latest_event: dict | None = None
        latest_end = int(next_checkpoint.get("offset") or 0)

        for end, rec in records:
            if rec is None:
                continue
            data = rec.get("data")
            if not isinstance(data, dict):
                continue
            cli_version = str(data.get("copilotVersion") or "") or cli_version
            totals = _metrics_totals(data)
            if totals is None:
                continue
            latest_in, latest_out = totals
            latest_event = rec
            latest_end = end
            model = str(data.get("currentModel") or "") or model

        # High-water mark: a downward blip must not lower the baseline, or the
        # tokens already credited above it get credited a second time when the
        # counter climbs back.
        next_in = max(prev_in, latest_in)
        next_out = max(prev_out, latest_out)
        next_checkpoint.update({
            "input_total": next_in,
            "output_total": next_out,
            "cwd": cwd,
            "model": model,
            "cli_version": cli_version,
        })
        if latest_event is None:
            return IncrementalParseResult([], next_checkpoint)

        delta_in = latest_in - prev_in
        delta_out = latest_out - prev_out
        if delta_in < 0 or delta_out < 0 or (delta_in == 0 and delta_out == 0):
            return IncrementalParseResult([], next_checkpoint)

        event_checkpoint = dict(next_checkpoint)
        event_checkpoint["offset"] = latest_end
        event = TokenUsage(
            vendor="copilot",
            input_tokens=delta_in,
            output_tokens=delta_out,
            cwd=cwd,
            session_id=session_id,
            file_path=str(path),
            dedup_key=f"copilot_cumulative::{session_id}::{next_in}::{next_out}",
            timestamp=str(latest_event.get("timestamp") or ""),
            model=model,
            checkpoint=event_checkpoint,
            cli_version=cli_version,
        )
        return IncrementalParseResult([event], next_checkpoint)

    def parse_activity(
        self, path: Path, seen_keys: set[str]
    ) -> list[ActivityEvent]:
        """Emit `agent_active` for user/assistant messages and tool execution
        records, and `turn_complete` on assistant.turn_end — Copilot's
        explicit end-of-turn record — carrying the turn's last assistant text.

        The walk is a dense ascending scan from line 1, so its progress is one
        high-water mark rather than an `act:<line>` key per line: the per-line
        keys pushed the bag past the watcher's _ACTIVITY_KEYS_PERSIST_LIMIT,
        which meant it was never written to the durable "@activity" checkpoint
        and this file replayed in full on every backend start (GitHub #28).

        `activity_resumes_by_line` stays False all the same, so the watcher
        does not seed a first-sight file to EOF for this reader. The flag is
        per-READER and this one also serves session-store.db, whose bag is
        keyed on db row ids; flipping it would have the watcher count newlines
        in a SQLite file and drop a line number into a bag nothing consults.
        """
        if path.name == _DB_NAME:
            return self._parse_db_activity(path, seen_keys)
        if path.name != "events.jsonl" or self._db_owns_session(path):
            return []
        out: list[ActivityEvent] = []
        cwd = self.cwd_from_file(path)
        session_id = path.parent.name
        last_text = _read_last_text(seen_keys)
        text_changed = False
        try:
            fh = path.open(encoding="utf-8")
        except OSError:
            return out

        high_water = activity_high_water(seen_keys)
        last_line = high_water
        try:
            with fh:
                for line_no, raw_line in enumerate(fh, 1):
                    raw = raw_line.strip()
                    if not raw:
                        continue
                    if line_no <= high_water:
                        continue
                    key = f"act:{line_no}"
                    try:
                        rec = json.loads(raw)
                    except json.JSONDecodeError:
                        # An unterminated final line is still being written: leave
                        # the mark behind it so the completed line is parsed on a
                        # later poll. Advancing past it drops that line's events
                        # for good, and when the lost line is assistant.turn_end
                        # the pane stays "mid-turn" forever (GitHub #21).
                        if not raw_line.endswith("\n"):
                            break
                        # A terminated line that will not parse never will. Step
                        # over it rather than holding the mark behind it and
                        # re-emitting the whole rest of the file on every poll.
                        last_line = line_no
                        continue
                    last_line = line_no

                    rtype = str(rec.get("type") or "")
                    data = rec.get("data")
                    data = data if isinstance(data, dict) else {}
                    ts = str(rec.get("timestamp") or "")
                    if rtype == "user.message":
                        # data.content holds the prompt verbatim; the frontend
                        # names the pane from the first user text.
                        out.append(ActivityEvent(
                            vendor="copilot", event_type="agent_active",
                            cwd=cwd, session_id=session_id, file_path=str(path),
                            dedup_key=key, timestamp=ts, detail="user",
                            text=user_prompt_text(str(data.get("content") or "")),
                        ))
                    elif rtype == "assistant.message":
                        text = str(data.get("content") or "")
                        if text:
                            last_text = text
                            text_changed = True
                        out.append(ActivityEvent(
                            vendor="copilot", event_type="agent_active",
                            cwd=cwd, session_id=session_id, file_path=str(path),
                            dedup_key=key, timestamp=ts, detail="assistant",
                        ))
                    elif rtype.startswith("tool."):
                        out.append(ActivityEvent(
                            vendor="copilot", event_type="agent_active",
                            cwd=cwd, session_id=session_id, file_path=str(path),
                            dedup_key=key, timestamp=ts, detail=rtype,
                        ))
                    elif rtype == "assistant.turn_end":
                        out.append(ActivityEvent(
                            vendor="copilot", event_type="turn_complete",
                            cwd=cwd, session_id=session_id, file_path=str(path),
                            dedup_key=f"turn:{line_no}", timestamp=ts,
                            detail="turn_end", text=last_text,
                        ))
                        # The turn consumed the text; reset so the next turn's
                        # empty-text boundary can't reuse it.
                        last_text = ""
                        text_changed = True
        finally:
            set_activity_high_water(seen_keys, last_line)

        if text_changed:
            _write_last_text(seen_keys, last_text)
        return out


# ---- attribution/watch hooks ----------------------------------------------

def _workspace_match(self, usage, ws_path, owner_workspace=None):
    # Reader emits cwd = sessions.cwd (1.0.78+) or the workspace.yaml cwd.
    # Both are the CLI's resolved launch dir, so compare through realpath.
    return _same_path(usage.cwd, ws_path)


def _pane_cwd_match(self, usage, pane_cwd, pane_id):
    return _same_path(usage.cwd, pane_cwd)


# Marker binding is reader-driven (find_sessions_by_marker) because the 1.0.78
# store holds every session in one file — the same path grok/opencode/cursor
# take. It supersedes binds_by_marker_file, which attribution never reaches
# once binds_shared_db_by_marker is set; the events.jsonl marker scan lives in
# find_sessions_by_marker instead so 1.0.75 layouts still bind.
CopilotLogReader.binds_shared_db_by_marker = True
# Reached when the shared-db marker scan finds nothing: attribution falls
# through from binds_shared_db_by_marker to the single-candidate fallback.
# It exists because copilot's at-pane marker is TYPED into the TUI (kickoff
# dismisses the startup dialog, pastes, hits Enter) and can lose that race —
# without a fallback the pane is never bound and the next restart runs
# `copilot --resume=<unknown-id>`, which silently opens a blank new session.
# Scope: it can only ever rescue an events.jsonl pane. A store-sourced event
# carries usage.file_path = session-store.db, which already existed when the
# pane registered, so reg.baseline_files filters it out of the candidate set.
# Since _db_owns_session hands every store-known session to the store branch,
# what is left is the install with no readable store at all — the pure 1.0.75
# layout. Narrow, but the alternative is a pane that can never bind.
CopilotLogReader.binds_new_session_single_candidate = True
CopilotLogReader.emits_session_sink = True
CopilotLogReader.workspace_match = _workspace_match
CopilotLogReader.pane_cwd_match = _pane_cwd_match


# ---- usage quota -----------------------------------------------------------

# copilot (GitHub Copilot CLI). ``~/.copilot/config.json`` is metadata only —
# the CLI keeps its OAuth token in the macOS Keychain (never probed here), so
# the token is resolved read-only via ``gh auth token -u <login>`` (gh shares
# the same gho_ GitHub OAuth scope; verified to print without rotating
# anything), then the VS Code/JetBrains-style ~/.config/github-copilot files,
# then GH_TOKEN/GITHUB_TOKEN env. ``copilot_internal/user`` is the surface
# CodexBar and the JetBrains quota monitor use; the Copilot-client headers
# are required for it to answer.
COPILOT_CONFIG_FILE_REL = (".copilot", "config.json")
COPILOT_HOSTS_FILES_REL = (
    (".config", "github-copilot", "apps.json"),
    (".config", "github-copilot", "hosts.json"),
)
COPILOT_DEFAULT_HOST = "github.com"
COPILOT_ENV_KEYS = ("GH_TOKEN", "GITHUB_TOKEN")
# The Editor-Version/User-Agent set this once sent identified the app as the
# VS Code Copilot Chat extension. Measured 2026-08-05: the endpoint answers the
# same without any of it, so the read stays and the costume does not.
COPILOT_GH_TOKEN_TIMEOUT = 5.0


COPILOT_ACCOUNT_SCOPE = "github"


COPILOT_PLAINTEXT_SETTING = "storeTokenPlaintext"


def _setting_flag(path: Path, key: str) -> bool:
    """A boolean setting out of a JSONC settings/config file; False when the
    file is absent, malformed or does not set it."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return False
    body = "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("//"))
    try:
        data = json.loads(body)
    except ValueError:
        return False
    return isinstance(data, dict) and data.get(key) is True


def copilot_stores_token_plaintext(root: Path) -> bool:
    """``storeTokenPlaintext`` (1.0.81: "Store auth token in plaintext (less
    secure)", offered when no system keychain is available) — read from
    settings.json, or the legacy config.json which the CLI says takes
    precedence. In that mode the token is NOT in the keyring, and where the
    CLI keeps it and whether ``lastLoggedInUser`` selects the matching
    plaintext token could not be established from the 1.0.81 bundle (the
    storage lives in the native runtime). Flipping the pointer there could
    leave the pane on another account's token, so that mode is refused."""
    return _setting_flag(root / "settings.json", COPILOT_PLAINTEXT_SETTING) or _setting_flag(
        root / "config.json", COPILOT_PLAINTEXT_SETTING
    )


def _copilot_config_file(home: Path, env: dict | None = None) -> Path:
    env = os.environ if env is None else env
    root = Path(env["COPILOT_HOME"]) if env.get("COPILOT_HOME") else home / ".copilot"
    if copilot_stores_token_plaintext(root):
        raise ValueError(
            "copilot keeps its token in plaintext (storeTokenPlaintext); which token "
            "lastLoggedInUser selects in that mode is not established — account "
            "switching is refused for this installation"
        )
    return root / "config.json"


def _split_jsonc(document: str) -> tuple[list[str], str]:
    """The ``//`` comment lines the CLI writes above its JSON body, and the
    body. Only leading comment lines are recognised — that is the shape the
    CLI writes ("// User settings belong in settings.json. // This file is
    managed automatically.")."""
    lines = document.splitlines()
    header: list[str] = []
    for line in lines:
        if line.lstrip().startswith("//") or not line.strip():
            header.append(line)
            continue
        break
    body = "\n".join(lines[len(header):])
    return header, body


def copilot_pointer_extract(document: str | None, scope: str) -> str | None:
    """The account the CLI is using: ``lastLoggedInUser`` ({host, login}) as
    JSON text. The token itself lives in the OS keyring under
    (service "copilot-cli", account "<host>:<login>") and is never read."""
    if document is None or scope != COPILOT_ACCOUNT_SCOPE:
        return None
    _, body = _split_jsonc(document)
    try:
        data = json.loads(body)
    except ValueError:
        return None
    user = data.get("lastLoggedInUser") if isinstance(data, dict) else None
    if not isinstance(user, dict):
        return None
    login, host = user.get("login"), user.get("host")
    if not (isinstance(login, str) and login and isinstance(host, str) and host):
        return None
    return json.dumps({"host": host, "login": login}, separators=(",", ":"), sort_keys=True)


def copilot_pointer_merge(document: str | None, scope: str, portion: str | None) -> str:
    """Point the CLI at another of its logins: rewrite ``lastLoggedInUser``
    only. The comment header and every other key (``loggedInUsers``,
    ``firstLaunchAt``, ...) are carried through; the body is re-serialised
    with the CLI's two-space indent. In the CLI's own config (one carrying
    ``loggedInUsers``) a login absent from that list is refused: the CLI has
    no token for it and the pointer would dangle. A slot document — the
    vault's parked copy, which holds the pointer alone — has no list and is
    not subject to that check."""
    if scope != COPILOT_ACCOUNT_SCOPE:
        raise ValueError(f"copilot has no credential scope {scope!r}")
    header, body = _split_jsonc(document or "")
    data = json.loads(body) if body.strip() else {}
    if not isinstance(data, dict):
        raise ValueError("config.json body is not a JSON object")
    if portion is None:
        data.pop("lastLoggedInUser", None)
    else:
        user = json.loads(portion)
        if not (isinstance(user, dict) and isinstance(user.get("login"), str)
                and isinstance(user.get("host"), str)):
            raise ValueError("copilot credential portion must be {host, login}")
        known = data.get("loggedInUsers")
        if isinstance(known, list) and not any(
            isinstance(u, dict) and u.get("login") == user["login"] and u.get("host") == user["host"]
            for u in known
        ):
            raise ValueError(
                f"copilot has no stored login for {user['host']}:{user['login']}; "
                "run `copilot login` for that account first"
            )
        data["lastLoggedInUser"] = {"host": user["host"], "login": user["login"]}
    text = json.dumps(data, indent=2)
    return "\n".join([*header, text]) if header else text


def identity_from_secret(secret):
    """A parked slot holds ``{host, login}``. The GitHub login is the
    identity the accounts UI shows and groups on."""
    data = None
    if secret is not None:
        try:
            data = json.loads(secret)
        except ValueError:
            data = None
    login = data.get("login") if isinstance(data, dict) else None
    login = login if isinstance(login, str) and login else None
    return {"email": login, "signedIn": login is not None}


def read_copilot_config(home: Path) -> dict | None:
    """Parse ``~/.copilot/config.json`` (JSONC: ``//`` comment lines before the
    JSON body). Returns {host, login} for ``lastLoggedInUser`` (host reduced to
    a bare hostname, default github.com), or None when absent/malformed/logged
    out. The file is metadata only — the CLI's token lives in the Keychain."""
    path = home.joinpath(*COPILOT_CONFIG_FILE_REL)
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    body = "\n".join(line for line in text.splitlines()
                     if not line.lstrip().startswith("//"))
    try:
        data = json.loads(body)
    except ValueError:
        return None
    user = data.get("lastLoggedInUser") if isinstance(data, dict) else None
    if not isinstance(user, dict):
        return None
    login = user.get("login")
    if not isinstance(login, str) or not login:
        return None
    hostname = COPILOT_DEFAULT_HOST
    host = user.get("host")
    if isinstance(host, str) and host.strip():
        stripped = host.strip().split("://", 1)[-1].split("/", 1)[0]
        hostname = stripped or COPILOT_DEFAULT_HOST
    return {"host": hostname, "login": login}


def read_copilot_hosts_token(home: Path, host: str = COPILOT_DEFAULT_HOST) -> str | None:
    """The VS Code/JetBrains-style Copilot credential fallback:
    ``~/.config/github-copilot/apps.json`` then ``hosts.json``, each a map of
    host key (bare, or suffixed like ``github.com:Iv1.xxx``) -> {oauth_token}.
    Returns the first matching host's token, or None."""
    for rel in COPILOT_HOSTS_FILES_REL:
        try:
            data = json.loads(home.joinpath(*rel).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(data, dict):
            continue
        for key, entry in data.items():
            if not isinstance(entry, dict) or host not in str(key):
                continue
            token = entry.get("oauth_token")
            if isinstance(token, str) and token:
                return token
    return None


def copilot_env_token(env: dict) -> str | None:
    for key in COPILOT_ENV_KEYS:
        value = env.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def copilot_usage_url(host: str) -> str:
    """github.com -> api.github.com; enterprise hosts use ``api.<host>`` the
    same way (CodexBar's Copilot host mapping)."""
    return f"https://api.{host}/copilot_internal/user"


async def _copilot_gh_token(login: str, host: str) -> str | None:
    """``gh auth token -u <login>`` — gh keeps GitHub OAuth tokens in the
    Keychain and prints them read-only without prompting or rotating anything
    (verified live). None when gh is missing, fails or prints nothing; gh's
    active account may differ from Copilot's, hence the explicit ``--user``."""
    binary = osplat.paths.resolve_program("gh")
    if not binary:
        return None
    try:
        proc = await asyncio.create_subprocess_exec(
            *osplat.paths.launch_argv(
                binary, ("auth", "token", "--user", login, "--hostname", host)
            ),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        )
        out = await _communicate_or_kill(proc, timeout=COPILOT_GH_TOKEN_TIMEOUT)
    except (OSError, asyncio.TimeoutError):
        return None
    if proc.returncode != 0:
        return None
    token = out.decode("utf-8", "replace").strip()
    return token or None




_COPILOT_QUOTA_KEYS = (
    ("chat", "Chat"),
    ("completions", "Completions"),
    ("premium_interactions", "Premium requests"),
)


def normalize_copilot(data: dict) -> tuple[list[dict], str | None]:
    """``copilot_internal/user``: one monthly window per ``quota_snapshots``
    entry with has_quota=true (usedPercent = 100 - percent_remaining), all
    resetting at ``quota_reset_date_utc``; ``copilot_plan`` -> planType.
    Entitlements without quota (has_quota=false) are skipped."""
    plan = data.get("copilot_plan")
    plan = plan if isinstance(plan, str) and plan else None
    snapshots = data.get("quota_snapshots")
    if not isinstance(snapshots, dict):
        return [], plan
    resets = data.get("quota_reset_date_utc")
    resets = resets if isinstance(resets, str) and resets else None
    windows: list[dict] = []
    for key, label in _COPILOT_QUOTA_KEYS:
        entry = snapshots.get(key)
        if not isinstance(entry, dict) or not entry.get("has_quota"):
            continue
        remaining = _num(entry.get("percent_remaining"))
        if remaining is None:
            continue
        windows.append(_window("monthly", label, 100.0 - remaining, resets))
    return windows, plan




async def fetch_copilot(home: Path, env: dict | None = None) -> dict:
    env = env if env is not None else dict(os.environ)
    config = read_copilot_config(home)
    host = config["host"] if config else COPILOT_DEFAULT_HOST
    token = None
    if config is not None:
        token = await _copilot_gh_token(config["login"], host)
    if token is None:
        token = read_copilot_hosts_token(home, host)
    if token is None:
        token = copilot_env_token(env)
    if token is None:
        return _snapshot("copilot", "no-credentials")
    import httpx

    # This read was once dressed as the VS Code extension — a spoofed
    # ``GitHubCopilotChat/…`` User-Agent plus ``Editor-Version`` headers.
    # Measured 2026-08-05: the endpoint does not gate on any of it, answering
    # 200 to a plain ``User-Agent: Navide`` with the same body. The costume was
    # never load-bearing, so it is gone and the reading stays.
    headers = {
        "Authorization": f"token {token}",
        "Accept": "application/json",
        "User-Agent": "Navide",
    }
    async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as client:
        resp = await client.get(copilot_usage_url(host), headers=headers)
    if resp.status_code in (401, 403):
        return _snapshot("copilot", "expired")
    if resp.status_code == 429:
        snap = _snapshot("copilot", "rate-limited")
        snap["retryAfterSec"] = parse_retry_after(resp.headers.get("Retry-After"))
        return snap
    if resp.status_code != 200:
        return _snapshot("copilot", "error", error=f"HTTP {resp.status_code}")
    try:
        payload = resp.json()
    except ValueError:
        return _snapshot("copilot", "error", error="non-JSON response")
    windows, plan = normalize_copilot(payload if isinstance(payload, dict) else {})
    if not windows:
        return _snapshot("copilot", "error",
                         error="response had no usable quota fields")
    return _snapshot("copilot", "ok", windows=windows, plan_type=plan)




# ---- resume / session ------------------------------------------------------

# `copilot --resume=<id>` (or `--resume <id>`) resumes when the id exists and
# silently starts a blank NEW session under that UUID when it does not — so
# the id names this pane's session either way and preflight matters.
_RESUME_RE = re.compile(
    r"^copilot\s+(?:\S+\s+)*--resume(?:=(\S+)|\s+([^-\s]\S*))"
)


def _resume_id_from_command(command) -> str:
    """Session id from a `copilot ... --resume=<id>` / `--resume <id>`
    command ('' otherwise)."""
    m = _RESUME_RE.match(command_text(command).strip())
    return (m.group(1) or m.group(2)) if m else ""


def _session_path(workspace_path: str, session_id: str) -> Path:
    # Sessions live at <root>/session-state/<id>/events.jsonl, so the id
    # alone names the path. A stale id would not fail — it silently starts a
    # blank NEW session under that UUID — which is why preflight matters.
    return copilot_root() / "session-state" / session_id / "events.jsonl"


def _session_has_turns(session_id: str) -> bool:
    """True when <root>/session-store.db records a conversation turn for the id.

    Copilot CLI 1.0.78 keeps sessions in a central SQLite store
    (<root>/session-store.db: sessions / turns / checkpoints / session_files /
    session_refs / assistant_usage_events / search_index*), whose `sessions`
    rows correspond 1:1 with the <root>/session-state/<uuid>/ directories.

    We require a `turns` row rather than just a `sessions` row: `--resume=<id>`
    silently starts a blank NEW session when the id is unknown, and resuming a
    zero-turn session restores nothing — both are the same "the user thinks
    they reattached but didn't" failure this preflight exists to prevent.
    Confirmed against the local store: the throwaway zero-conversation
    sessions all have 0 `turns` rows (and a NULL `summary`), while the one
    session with a real exchange has a turn row.
    """
    if not session_id:
        return False
    db = copilot_root() / "session-store.db"
    if not db.is_file():
        return False
    try:
        # Read-only URI so preflight can never write to the CLI's own store.
        with sqlite3.connect(f"file:{db}?mode=ro", uri=True) as conn:
            row = conn.execute(
                "SELECT 1 FROM turns WHERE session_id = ? LIMIT 1", (session_id,)
            ).fetchone()
        return row is not None
    except sqlite3.Error as err:  # older/no-turns schema, locked or corrupt db
        log.debug("copilot session-store probe failed for %s: %s", session_id, err)
        return False


def _session_exists(workspace_path: str, session_id: str) -> bool:
    """Store first, events.jsonl second — same order (and same reasoning) as
    CopilotLogReader.has_session.

    The file check stays as the back-compat fallback: 1.0.75 wrote only
    events.jsonl, and read-only inspection could not rule out that 1.0.78
    creates it lazily at the first user message.
    """
    return _session_has_turns(session_id) or _session_path(
        workspace_path, session_id
    ).is_file()


# ---- vendor spec -----------------------------------------------------------

def _install_hooks(port_file: str) -> Any:
    # Copilot loads any *.json under its hooks dir, so this writes one file we
    # own outright rather than merging into the user's config. Lazy import —
    # see claude.py.
    from ..copilot_hooks import install_hooks

    return install_hooks(port_file)


# Where this CLI keeps the extensions it installed for itself (read-only
# inventory, cli_extensions). Verified 2026-10-10 against the installed
# binary's --help and the files on disk.
_EXTENSIONS = ExtensionsSpec(sources=(
    ExtensionsSource("plugin-dirs", (".copilot", "installed-plugins"), "Copilot plugin", settings=(".copilot", "settings.json")),
    ExtensionsSource("hooks-dir", (".copilot", "hooks"), "Copilot hook"),
))

SPEC = VendorSpec(
    extensions=_EXTENSIONS,
    key="copilot",
    # Enterprise hosts/model routing have no verified default CLI host set here.
    expected_hosts=(),
    # Same root as copilot_root, using the captured child environment.
    data_dirs=lambda ctx: (ctx.path(ctx.env.get("COPILOT_HOME") or ctx.home / ".copilot"),),
    data_dir_env_vars=("COPILOT_HOME",),
    supports_model=True,
    supports_effort=True,
    known_efforts=('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'),
    # Verified 2026-08-15: `copilot skill list` under a relocated COPILOT_HOME
    # lists exactly the skills below <home>/skills.
    skills_supported=True,
    skills_wiring=SkillsWiring(
        root_env="COPILOT_HOME",
        reads_shared_root=True,
        root_home=(".copilot",),
        skills_rel=("skills",),
        # Verified the hard way: with COPILOT_HOME set, copilot stops scanning
        # ~/.agents/skills, so those skills are linked into the leaf or the
        # user silently loses them.
        discovery_home=((".agents", "skills"),),
    ),
    label="GitHub Copilot CLI",
    # `copilot login` authenticates over OAuth. On a local desktop it opens
    # the browser and captures the result on a loopback callback — exactly
    # what a login pane carries; the device-code flow it falls back to for
    # SSH/headless is auto-detected, so neither --web-flow nor --device-code
    # is forced here. Verified against `copilot login --help`, 2026-09-18.
    login_command_args="login",
    # Multi-account: the CLI keeps EVERY login it has done (config.json
    # ``loggedInUsers``, one keyring item each under service "copilot-cli",
    # account "<host>:<login>") and ``lastLoggedInUser`` selects the one in
    # use — so a switch is a pointer flip in config.json and Navide never
    # touches the keyring. A second account is added with a plain `copilot
    # login` against the real home (COPILOT_HOME would relocate config.json
    # away from the loggedInUsers list, so it is not used as a login home).
    # The token is resolved at startup: restart, then ``copilot --resume``.
    live_file=COPILOT_CONFIG_FILE_REL,
    live_file_resolver=lambda home: _copilot_config_file(home),
    slot_file="account.json",
    identity_from_secret=identity_from_secret,
    account_switch=AccountSwitchSpec(
        auth_scope="copilot",
        method="restart",
        store="pointer",
        evidence="source",
        verified_version="1.0.81",
        scopes=(COPILOT_ACCOUNT_SCOPE,),
        extract=copilot_pointer_extract,
        merge=copilot_pointer_merge,
        # `sandbox.auth.gh` docs: GH_TOKEN / GITHUB_TOKEN authenticate ahead
        # of the stored login.
        shadowing_env=COPILOT_ENV_KEYS,
        resume="native",
        todo="that the CLI reads lastLoggedInUser at startup is inferred from the 1.0.81 bundle (authGetLastLoggedInUserForContext), not seen live; storeTokenPlaintext mode is refused (its token location is not readable from the bundle); no real-account round-trip recorded",
    ),
    # Same inline `mcpServers` document claude takes, under a flag documented
    # as augmenting ~/.copilot/mcp-config.json for the session and repeatable —
    # so a user's own --additional-mcp-config is augmented rather than stepped
    # aside for, and only our own entry means "already wired".
    mcp_wiring=McpWiring(
        config=McpServerConfig(
            section=("mcpServers",),
            entry=(("type", "http"), ("url", McpValue.URL)),
        ),
        flag="--additional-mcp-config",
        # Quoted: the inline JSON we inject always carries `"navide"`, while a
        # bare `navide` would also match unrelated argv such as `~/navide-web`.
        already_wired='"{name}"',
    ),
    install_hooks=_install_hooks,
    # Late-bound (module global at call time) so tests can monkeypatch.
    fetch_usage=lambda home: fetch_copilot(home),
    resume_id_from_command=_resume_id_from_command,
    session_path=_session_path,
    session_exists=_session_exists,
    home_env_vars=("COPILOT_HOME",),
    make_log_reader=CopilotLogReader,
    # Copilot CLI ships `copilot update` but no doctor subcommand;
    # COPILOT_AUTO_UPDATE=false is its autoupdate opt-out and COPILOT_HOME
    # relocates its config/session root.
    install_dep=Dep("copilot", "GitHub Copilot CLI", "GitHub Copilot coding agent CLI", "agent_cli",
        ["copilot", "--version"], r"(\d+\.\d+\.\d+)",
        install_cmd="brew install --cask copilot-cli",
        needs_terminal=True, requires_binaries=("brew",), optional=True,
        docs_url="https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-copilot-cli",
        # Windows: WinGet, per
        # https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli
        # (running it needs PowerShell 6+, which the same page states).
        install_cmds={"win32": PlatformInstall(
            "winget install GitHub.Copilot", ("winget",), needs_terminal=True)},
        update_cmd="copilot update",
        npm_package="@github/copilot",
        config_home_env="COPILOT_HOME",
        autoupdate_env="COPILOT_AUTO_UPDATE"),
)

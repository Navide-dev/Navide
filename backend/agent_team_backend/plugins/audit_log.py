"""Audit of Navide plugin activity in the global navide.db (plan B, B1-d).

Two record tables, created from the contract's ``PLUGIN_AUDIT_DDL``
(docs/en-US/plugin-agent-tools-contract.md section 5):

- ``plugin_tool_calls``: one row per agent tool call (written by the B1 call
  path). The call arguments are never stored, only the SHA-256 and UTF-8
  size of their canonical spelling (an unsalted digest: an argument with
  little entropy can be confirmed by guessing it).
- ``plugin_activity``: one row per broker or shell-broker call and per agent
  tool call (written by D-e), with ``plugin_activity_daily`` holding the
  per-day counts of detail rows once they expire.

A third table, ``plugin_agent_actions`` (``PLUGIN_AGENT_ACTIONS_DDL``, B2-c),
records who asked for, decided or carried out a change to a Navide plugin
(disable, enable, install / update / rollback / remove requests and their
decisions). It is its own schema component: an older navide.db gets it
created at start and nothing else changes, and if it cannot be created only
that record is off.

Both are write-only: they decide nothing. A record call only validates and
queues the row in memory; ``flush`` writes the queue in one short
transaction, off the call path (``run`` flushes every second). A write that
fails is logged and dropped, never raised into the call it records. If the
tables cannot be created the backend still starts, with the audit disabled
and the reason in the error ledger (ui_diagnostics).

What is kept, by field:
- times are clamped to "now", so a row can never outlive its retention;
- ``error_code`` and ``denied_reason`` are contract codes, anything else is
  "other"; ``address`` must be ``namespace.method``, otherwise "other";
- ``fs_path`` is workspace-relative with ``/``; a ``file:`` URI is read as
  the path it names; a path outside the workspace (absolute elsewhere, ``~``,
  ``..``, any other URI, or any path at all when the workspace is missing,
  relative or a filesystem root) is the fixed marker ``<outside-workspace>``;
- ``shell_command`` is the executable's basename and a plain subcommand word,
  split with shell quoting rules: leading ``NAME=value`` assignments (quoted
  values included), flags (``-pSECRET``, ``--password=``, ``--password x``),
  URLs (with or without ``user:pass@``) and every further argument are
  dropped; a command that cannot be split (an unterminated quote) is the
  fixed marker ``<unparsable>``.

Caller identity (B0 decision c): a ``pane`` caller is the pane whose MCP
token it presented. The token proves the pane, not the process that used it:
a process running as the same user that can read that pane's environment or
config file can present it too. Reads say so in ``caller_verified``
("pane-token" for a pane, "none" for an external or host caller).

Retention (contract constants): tool calls 30 days, then the newest 10,000;
activity detail 7 days, rolled up by UTC day into the daily table first;
daily rows 90 days. ``prune`` works in small batches, each its own short
transaction, so it never holds navide.db for long; it runs from ``run`` (an
hourly background task), never at import or inside a record call.

navide.db is not in WAL mode: it uses a TRUNCATE rollback journal, and the
backend shares one connection behind a lock (``db.py``). Every other store
on navide.db waits while one of these transactions is open, which is why
writes are batched off the call path and each prune batch is its own short
transaction.
"""

from __future__ import annotations

import asyncio
import logging
import ntpath
import os
import posixpath
import re
import shlex
import sqlite3
import threading
import time
from collections.abc import Callable
from typing import Any
from urllib.parse import unquote, urlsplit

from ..db import Database
from . import agent_tools_contract as contract

log = logging.getLogger(__name__)

_COMPONENT = "plugin_audit"
_ACTIONS_COMPONENT = "plugin_agent_actions"
_DAY_MS = 86_400_000
#: Rows per prune transaction (an internal batch size, not a retention cap):
#: at 500k expired rows a batch holds navide.db for ~11 ms median. Smaller
#: batches do not lower the longest hold (that is scheduling on a loaded
#: machine) and multiply the per-commit cost, which is high on Windows.
PRUNE_BATCH_ROWS = 500
FLUSH_INTERVAL_S = 1.0
PRUNE_INTERVAL_S = 3_600.0
#: The first prune waits this long after start, off the startup path.
PRUNE_START_DELAY_S = 120.0

OUTSIDE_WORKSPACE = "<outside-workspace>"
#: A shell command that cannot be split the way a shell would split it.
UNPARSABLE = "<unparsable>"
OTHER = "other"

CALLER_KINDS = ("pane", "external", "host")
TOOL_CALL_OUTCOMES = ("ok", "error")
TOOL_RISKS = ("read", "write")
ACTIVITY_SOURCES = ("broker", "shell", "agentTool")
ACTIVITY_OUTCOMES = ("allowed", "denied", "error")
#: The contract's call error codes plus the two transport codes the backend
#: produces itself (contract 4.2).
ERROR_CODES = frozenset((*contract.AGENT_TOOL_CALL_ERROR_CODES, "host_unavailable", "host_timeout"))
#: Contract reasons a call or broker request is refused for.
DENIED_REASONS = frozenset(contract.PLUGIN_ACTIVITY_DENIED_REASONS)

_ADDRESS = re.compile(r"[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)+")
_ASSIGNMENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*=.*")
_SUBCOMMAND = re.compile(r"[a-z][a-z0-9-]*")
_EXECUTABLE = re.compile(r"[A-Za-z0-9._+-]+")
# A URI scheme, but not a Windows drive ("C:\\x", "C:/x").
# A URI: "scheme://...", or any "file:" spelling. Anything else with a colon
# ("notes:1.md") is a file name; a Windows drive ("C:\\x", "C:/x") is not a scheme.
_URI_SCHEME = re.compile(r"(?i)file:|(?![A-Za-z]:[\\/])[A-Za-z][A-Za-z0-9+.-]*://")
_WINDOWS_PATH = re.compile(r"[A-Za-z]:[\\/]|\\\\")


def _create_schema(cur: sqlite3.Cursor) -> None:
    for statement in contract.PLUGIN_AUDIT_DDL:
        cur.execute(statement)


def _arguments_digest(arguments: Any) -> tuple[str, int]:
    """``args_sha256`` and ``args_bytes``: the contract's
    ``agent_tool_arguments_digest`` (section 5). Anything that is not JSON raises."""
    return contract.agent_tool_arguments_digest(arguments)


def _non_negative_int(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"expected a non-negative integer, got {value!r}")
    return value


#: ``result_bytes`` when the Host sent no valid ``meta.resultBytes``: the size
#: is unknown. The column is NOT NULL, so this stands in for NULL. Never add it
#: up: a reader that totals, averages or takes the largest size must leave
#: these rows out (``CASE WHEN result_bytes >= 0``) and count them apart.
UNKNOWN_SIZE = -1


def _result_bytes(value: Any) -> int:
    if isinstance(value, int) and not isinstance(value, bool) and value == UNKNOWN_SIZE:
        return UNKNOWN_SIZE
    return _non_negative_int(value)


def _path_flavor(workspace: str) -> Any:
    """The path module for ``workspace``: Windows spellings use ntpath."""
    return ntpath if re.match(r"[A-Za-z]:[\\/]|\\\\", workspace) else posixpath


def _uri_path(path: str) -> str | None:
    """The local path a ``file:`` URI names; None for any other URI."""
    parts = urlsplit(path)
    if parts.scheme.lower() != "file" or parts.netloc.lower() not in ("", "localhost"):
        return None
    local = unquote(parts.path)
    # file:///C:/x names the Windows path C:/x.
    if re.match(r"/[A-Za-z]:[\\/]", local):
        local = local[1:]
    return local


def _relative_path(path: str, workspace: str) -> str:
    """``path`` relative to ``workspace`` spelled with ``/``; the outside marker
    when it is not inside it; "" when there is no path."""
    if not path:
        return ""
    if _URI_SCHEME.match(path):
        local = _uri_path(path)
        if local is None:
            return OUTSIDE_WORKSPACE
        path = local
    if path.startswith("~"):
        return OUTSIDE_WORKSPACE
    flavor = _path_flavor(workspace or path)
    # A Windows spelling (drive or UNC) under a POSIX workspace: posixpath
    # would read it as a relative name.
    if flavor is posixpath and _WINDOWS_PATH.match(path):
        return OUTSIDE_WORKSPACE
    # A missing or relative workspace, or a filesystem root ("/", "C:\\"),
    # contains nothing a relative spelling could be checked against.
    if not workspace or not flavor.isabs(workspace):
        return OUTSIDE_WORKSPACE
    root = flavor.normpath(workspace)
    if flavor.dirname(root) == root:
        return OUTSIDE_WORKSPACE
    if flavor.isabs(path):
        try:
            relative = flavor.relpath(flavor.normpath(path), root)
        except ValueError:  # another drive on Windows
            return OUTSIDE_WORKSPACE
    else:
        relative = flavor.normpath(path)
    sep = flavor.sep
    # A root-relative "\\x" is not "absolute" to ntpath on Python 3.13+; it is
    # still not inside the workspace.
    if relative == ".." or relative.startswith((".." + sep, "/", "\\")) or flavor.isabs(relative):
        return OUTSIDE_WORKSPACE
    return relative.replace(sep, "/")


def _shell_words(command: str) -> list[str] | None:
    """``command`` split with POSIX shell quoting; None when it cannot be.

    Backslash is not an escape here, so a Windows path keeps its separators.
    """
    lexer = shlex.shlex(command, posix=True)
    lexer.whitespace_split = True
    lexer.escape = ""
    lexer.commenters = ""
    try:
        return list(lexer)
    except ValueError:  # an unterminated quote
        return None


def _shell_summary(command: str) -> str:
    """The executable's basename and a plain subcommand word, nothing else."""
    tokens = _shell_words(command)
    if tokens is None:
        return UNPARSABLE
    while tokens and _ASSIGNMENT.fullmatch(tokens[0]):
        # Backslash is literal here, so `PASS=a\\ b` splits after the
        # backslash; the next word is the rest of the value, not a command.
        if (len(tokens[0]) - len(tokens[0].rstrip("\\"))) % 2:
            return UNPARSABLE
        tokens.pop(0)
    if not tokens:
        return ""
    executable = ntpath.basename(posixpath.basename(tokens[0]))
    if not _EXECUTABLE.fullmatch(executable):
        return OTHER
    if len(tokens) > 1 and _SUBCOMMAND.fullmatch(tokens[1]):
        return f"{executable} {tokens[1]}"
    return executable


def _code(value: Any, allowed: frozenset[str]) -> str:
    text = str(value or "")
    if not text:
        return ""
    return text if text in allowed else OTHER


def _yield_the_lock() -> None:
    """Between prune batches: the database lock is not fair, so give a
    waiting writer the chance to take it before the next batch does."""
    time.sleep(0)


class _PruneStopped(Exception):
    """A prune asked to stop between two batches (shutdown)."""


def _report_disabled(reason: str, code: str = "PLUGIN_AUDIT_DISABLED", what: str = "Navide plugin audit") -> None:
    try:
        from .. import error_ledger

        error_ledger.record("backend", "error", code, f"{what} is off: {reason}")
    except Exception as err:  # noqa: BLE001 - diagnostics must not break start-up either
        log.warning("plugin audit: could not record the disabled state: %s", err)


def _create_actions_schema(cur: sqlite3.Cursor) -> None:
    for statement in contract.PLUGIN_AGENT_ACTIONS_DDL:
        cur.execute(statement)


_APPROVAL_ID = re.compile(r"[0-9a-f]{32}")


class PluginAuditLog:
    """Write-only recorder, flusher and pruner for the plugin audit tables."""

    def __init__(self, db: Database, *, clock: Callable[[], float] = time.time) -> None:
        self.db = db
        self._clock = clock
        self._lock = threading.Lock()
        # Set when the background task is cancelled: a prune running on its
        # worker thread stops at the next batch boundary.
        self._stopping = threading.Event()
        self._calls: list[tuple[Any, ...]] = []
        self._activity: list[tuple[Any, ...]] = []
        self._actions: list[tuple[Any, ...]] = []
        self._next_call_id: int | None = None
        self.enabled = False
        self.disabled_reason = ""
        try:
            self.db.migrate(_COMPONENT, 1, _create_schema)
            self._next_call_id = self._read_next_call_id()
            self.enabled = True
        except Exception as err:  # noqa: BLE001 - the backend starts without the audit
            self.disabled_reason = f"{type(err).__name__}: {err}"
            log.error("plugin audit disabled: the tables could not be created: %s", self.disabled_reason)
            _report_disabled(self.disabled_reason)
        self.actions_enabled = False
        self.actions_disabled_reason = ""
        try:
            self.db.migrate(_ACTIONS_COMPONENT, 1, _create_actions_schema)
            self.actions_enabled = True
        except Exception as err:  # noqa: BLE001 - the backend starts without this record
            self.actions_disabled_reason = f"{type(err).__name__}: {err}"
            log.error("plugin agent-action audit disabled: the table could not be created: %s",
                      self.actions_disabled_reason)
            _report_disabled(
                self.actions_disabled_reason, "PLUGIN_AGENT_ACTIONS_AUDIT_DISABLED", "Navide plugin agent-action audit",
            )

    def _now_ms(self) -> int:
        return int(self._clock() * 1000)

    def _at(self, at_ms: int | None) -> int:
        now = self._now_ms()
        return now if at_ms is None else min(_non_negative_int(at_ms), now)

    def status(self) -> dict[str, Any]:
        with self._lock:
            pending = len(self._calls) + len(self._activity) + len(self._actions)
        return {
            "enabled": self.enabled, "reason": self.disabled_reason, "pending": pending,
            "actions_enabled": self.actions_enabled, "actions_reason": self.actions_disabled_reason,
        }

    # ── writes (queue only) ─────────────────────────────────────────────

    def _read_next_call_id(self) -> int:
        """Read once at open, so a record call never touches the database."""
        with self.db.transaction() as cur:
            seq = cur.execute("SELECT seq FROM sqlite_sequence WHERE name = 'plugin_tool_calls'").fetchone()
            top = cur.execute("SELECT MAX(id) FROM plugin_tool_calls").fetchone()
        return max(int(seq[0]) if seq else 0, int(top[0] or 0)) + 1

    def _allocate_call_id(self) -> int:
        """The next tool-call row id. Ids are handed out here, before the row
        is written, so an activity row can name its tool call at once."""
        if self._next_call_id is None:
            self._next_call_id = self._read_next_call_id()
        call_id = self._next_call_id
        self._next_call_id += 1
        return call_id

    def record_tool_call(
        self,
        *,
        caller_kind: str,
        target_workspace: str,
        plugin_id: str,
        plugin_version: str,
        tool: str,
        risk: str,
        arguments: Any,
        outcome: str,
        duration_ms: int,
        result_bytes: int,
        pane_id: str = "",
        pane_name: str = "",
        caller_workspace: str = "",
        error_code: str = "",
        at_ms: int | None = None,
    ) -> int | None:
        """Queue one agent tool call; returns its row id, or None when it is not recorded."""
        if not self.enabled:
            return None
        try:
            if caller_kind not in CALLER_KINDS:
                raise ValueError(f"unknown caller kind {caller_kind!r}")
            if outcome not in TOOL_CALL_OUTCOMES:
                raise ValueError(f"unknown outcome {outcome!r}")
            if risk not in TOOL_RISKS:
                raise ValueError(f"unknown risk {risk!r}")
            args_sha256, args_bytes = _arguments_digest(arguments)
            at = self._at(at_ms)
            is_pane = caller_kind == "pane"
            caller_ws = str(caller_workspace) if is_pane else ""
            target_ws = str(target_workspace)
            fields = (
                at, caller_kind,
                str(pane_id) if is_pane else "", str(pane_name) if is_pane else "",
                caller_ws, target_ws, int(bool(caller_ws) and caller_ws != target_ws),
                str(plugin_id), str(plugin_version), str(tool), risk,
                args_sha256, args_bytes, outcome, "" if outcome == "ok" else (_code(error_code, ERROR_CODES) or OTHER),
                _non_negative_int(duration_ms), _result_bytes(result_bytes),
            )
            with self._lock:
                call_id = self._allocate_call_id()
                self._calls.append((call_id, *fields))
        except Exception as err:  # noqa: BLE001 - the audit never fails the call it records
            log.warning("plugin audit: tool call not recorded: %s", err)
            return None
        return call_id

    def record_activity(
        self,
        *,
        plugin_id: str,
        plugin_version: str,
        source: str,
        address: str,
        outcome: str,
        workspace: str = "",
        denied_reason: str = "",
        fs_path: str = "",
        shell_command: str = "",
        tool_call_id: int | None = None,
        at_ms: int | None = None,
    ) -> bool:
        """Queue one broker, shell or agent-tool activity row; False when it is not recorded."""
        if not self.enabled:
            return False
        try:
            if source not in ACTIVITY_SOURCES:
                raise ValueError(f"unknown source {source!r}")
            if outcome not in ACTIVITY_OUTCOMES:
                raise ValueError(f"unknown outcome {outcome!r}")
            if not isinstance(address, str) or not address:
                raise ValueError("address is required")
            if tool_call_id is not None:
                _non_negative_int(tool_call_id)
            row = (
                self._at(at_ms), str(plugin_id), str(plugin_version), str(workspace), source,
                address if _ADDRESS.fullmatch(address) else OTHER, outcome,
                (_code(denied_reason, DENIED_REASONS) or OTHER) if outcome == "denied" else "",
                _relative_path(str(fs_path), str(workspace)),
                _shell_summary(str(shell_command)),
                tool_call_id,
            )
            with self._lock:
                self._activity.append(row)
        except Exception as err:  # noqa: BLE001 - the audit never fails the call it records
            log.warning("plugin audit: activity not recorded: %s", err)
            return False
        return True

    def record_agent_action(
        self,
        *,
        plugin_id: str,
        action: str,
        caller_kind: str,
        outcome: str,
        plugin_version: str = "",
        pane_id: str = "",
        pane_name: str = "",
        caller_workspace: str = "",
        approval_id: str = "",
        error_code: str = "",
        at_ms: int | None = None,
    ) -> bool:
        """Queue one agent plugin action (B2-c); False when it is not recorded.

        Pane fields are kept only for a pane caller; ``error_code`` is a
        contract code or "other"; an ``approval_id`` that is not one is dropped.
        """
        if not self.actions_enabled:
            return False
        try:
            if action not in contract.PLUGIN_AGENT_ACTIONS:
                raise ValueError(f"unknown action {action!r}")
            if caller_kind not in contract.PLUGIN_AGENT_ACTION_CALLER_KINDS:
                raise ValueError(f"unknown caller kind {caller_kind!r}")
            if outcome not in contract.PLUGIN_AGENT_ACTION_OUTCOMES:
                raise ValueError(f"unknown outcome {outcome!r}")
            is_pane = caller_kind == "pane"
            row = (
                self._at(at_ms), str(plugin_id), str(plugin_version), action, caller_kind,
                str(pane_id) if is_pane else "", str(pane_name) if is_pane else "",
                str(caller_workspace) if is_pane else "",
                approval_id if isinstance(approval_id, str) and _APPROVAL_ID.fullmatch(approval_id) else "",
                outcome,
                "" if outcome in ("allowed", "no-op") else (
                    _code(error_code, frozenset(contract.PLUGIN_AGENT_ACTION_AUDIT_ERROR_CODES)) or OTHER
                ),
            )
            with self._lock:
                self._actions.append(row)
        except Exception as err:  # noqa: BLE001 - the audit never fails the action it records
            log.warning("plugin audit: agent action not recorded: %s", err)
            return False
        return True

    def flush(self) -> None:
        """Write every queued row in one short transaction; never raises."""
        with self._lock:
            calls, self._calls = self._calls, []
            activity, self._activity = self._activity, []
            actions, self._actions = self._actions, []
        if actions:
            try:
                with self.db.transaction() as cur:
                    cur.executemany(
                        "INSERT INTO plugin_agent_actions (at, plugin_id, plugin_version, action, caller_kind,"
                        " caller_pane_id, caller_pane_name, caller_workspace, approval_id, outcome, error_code)"
                        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                        actions,
                    )
            except Exception as err:  # noqa: BLE001 - dropped, never raised into a call
                log.warning("plugin audit: %d agent-action rows not written: %s", len(actions), err)
        if not calls and not activity:
            return
        try:
            with self.db.transaction() as cur:
                cur.executemany(
                    "INSERT INTO plugin_tool_calls (id, at, caller_kind, pane_id, pane_name, caller_workspace,"
                    " target_workspace, cross_workspace, plugin_id, plugin_version, tool, risk, args_sha256,"
                    " args_bytes, outcome, error_code, duration_ms, result_bytes)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    calls,
                )
                cur.executemany(
                    "INSERT INTO plugin_activity (at, plugin_id, plugin_version, workspace, source, address,"
                    " outcome, denied_reason, fs_path, shell_command, tool_call_id)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    activity,
                )
        except Exception as err:  # noqa: BLE001 - dropped, never raised into a call
            log.warning("plugin audit: %d rows not written: %s", len(calls) + len(activity), err)

    # ── retention ───────────────────────────────────────────────────────

    def _between_batches(self) -> None:
        _yield_the_lock()
        if self._stopping.is_set():
            raise _PruneStopped

    def _batch(self, sql: str, params: tuple[Any, ...]) -> int:
        with self.db.transaction() as cur:
            count = int(cur.execute(sql, params).rowcount or 0)
        self._between_batches()
        return count

    def prune(self, now_ms: int | None = None) -> None:
        """Apply the contract's retention in small batches; never raises."""
        if not self.enabled and not self.actions_enabled:
            return
        now = self._now_ms() if now_ms is None else now_ms
        self.flush()
        if self.enabled:
            try:
                self._prune(now)
            except _PruneStopped:
                log.info("plugin audit: pruning stopped for shutdown; it resumes on the next start")
                return
            except Exception as err:  # noqa: BLE001 - retention must not break anything
                log.warning("plugin audit: pruning failed: %s", err)
        if self.actions_enabled:
            try:
                self._prune_actions(now)
            except _PruneStopped:
                log.info("plugin audit: pruning stopped for shutdown; it resumes on the next start")
            except Exception as err:  # noqa: BLE001 - retention must not break anything
                log.warning("plugin audit: pruning agent actions failed: %s", err)

    def _prune_actions(self, now: int) -> None:
        """plugin_agent_actions keeps what plugin_tool_calls keeps: 30 days, then the newest 10,000."""
        cutoff = now - contract.PLUGIN_AGENT_ACTIONS_RETENTION_DAYS * _DAY_MS
        batch = PRUNE_BATCH_ROWS
        while self._batch(
            "DELETE FROM plugin_agent_actions WHERE id IN (SELECT id FROM plugin_agent_actions WHERE at < ? LIMIT ?)",
            (cutoff, batch),
        ):
            pass
        with self.db.transaction() as cur:
            row = cur.execute(
                "SELECT id FROM plugin_agent_actions ORDER BY id DESC LIMIT 1 OFFSET ?",
                (contract.PLUGIN_AGENT_ACTIONS_MAX_ROWS,),
            ).fetchone()
        if row is not None:
            keep_above = int(row[0])
            while self._batch(
                "DELETE FROM plugin_agent_actions WHERE id IN"
                " (SELECT id FROM plugin_agent_actions WHERE id <= ? LIMIT ?)",
                (keep_above, batch),
            ):
                pass

    def _prune(self, now: int) -> None:
        calls_cutoff = now - contract.PLUGIN_TOOL_CALLS_RETENTION_DAYS * _DAY_MS
        detail_cutoff = now - contract.PLUGIN_ACTIVITY_DETAIL_RETENTION_DAYS * _DAY_MS
        daily_cutoff = now - contract.PLUGIN_ACTIVITY_DAILY_RETENTION_DAYS * _DAY_MS
        batch = PRUNE_BATCH_ROWS
        while self._batch(
            "DELETE FROM plugin_tool_calls WHERE id IN (SELECT id FROM plugin_tool_calls WHERE at < ? LIMIT ?)",
            (calls_cutoff, batch),
        ):
            pass
        with self.db.transaction() as cur:
            row = cur.execute(
                "SELECT id FROM plugin_tool_calls ORDER BY id DESC LIMIT 1 OFFSET ?",
                (contract.PLUGIN_TOOL_CALLS_MAX_ROWS,),
            ).fetchone()
        if row is not None:
            keep_above = int(row[0])
            while self._batch(
                "DELETE FROM plugin_tool_calls WHERE id IN (SELECT id FROM plugin_tool_calls WHERE id <= ? LIMIT ?)",
                (keep_above, batch),
            ):
                pass
        # Roll expiring detail up by UTC day and delete it, the oldest batch
        # per transaction (read through the ``at`` index, so a batch costs the
        # same however much has expired), so a row is counted exactly once.
        while True:
            with self.db.transaction() as cur:
                ids = [
                    int(row[0])
                    for row in cur.execute(
                        "SELECT id FROM plugin_activity WHERE at < ? ORDER BY at, id LIMIT ?", (detail_cutoff, batch)
                    )
                ]
                if not ids:
                    break
                marks = ",".join("?" * len(ids))
                cur.execute(
                    "INSERT INTO plugin_activity_daily (day, plugin_id, workspace, source, address, outcome, count)"
                    " SELECT strftime('%Y-%m-%d', at / 1000, 'unixepoch'), plugin_id, workspace, source, address,"
                    f" outcome, COUNT(*) FROM plugin_activity WHERE id IN ({marks})"  # noqa: S608 - placeholders only
                    " GROUP BY 1, 2, 3, 4, 5, 6 ORDER BY 1"
                    " ON CONFLICT(day, plugin_id, workspace, source, address, outcome)"
                    " DO UPDATE SET count = count + excluded.count",
                    ids,
                )
                cur.execute(f"DELETE FROM plugin_activity WHERE id IN ({marks})", ids)  # noqa: S608 - placeholders only
            self._between_batches()
        day = time.strftime("%Y-%m-%d", time.gmtime(daily_cutoff / 1000))
        while self._batch(
            "DELETE FROM plugin_activity_daily WHERE rowid IN"
            " (SELECT rowid FROM plugin_activity_daily WHERE day < ? LIMIT ?)",
            (day, batch),
        ):
            pass

    async def run(self) -> None:
        """Background loop: flush every second, prune hourly (first after a delay)."""
        # A stop asked of an earlier run (a cancel) must not stop this one.
        self._stopping.clear()
        next_prune = time.monotonic() + PRUNE_START_DELAY_S
        pruning: asyncio.Future[None] | None = None
        try:
            while True:
                await asyncio.sleep(FLUSH_INTERVAL_S)
                await asyncio.to_thread(self.flush)
                if time.monotonic() >= next_prune:
                    next_prune = time.monotonic() + PRUNE_INTERVAL_S
                    pruning = asyncio.ensure_future(asyncio.to_thread(self.prune))
                    # Shielded: a cancel must not abandon the worker thread
                    # mid-prune; it is stopped and awaited below instead.
                    await asyncio.shield(pruning)
                    pruning = None
        finally:
            # Shutdown (cancel): stop a running prune at its next batch and
            # wait for it, then write what was queued.
            self._stopping.set()
            if pruning is not None:
                await asyncio.gather(pruning, return_exceptions=True)
            await asyncio.to_thread(self.flush)

    # ── reads ───────────────────────────────────────────────────────────

    def recent_tool_calls(self, *, plugin_id: str | None = None, limit: int = 100) -> list[dict[str, Any]]:
        """Newest written tool calls first, each with ``caller_verified`` (see the module docstring)."""
        if not self.enabled:
            return []
        self.flush()
        query = "SELECT * FROM plugin_tool_calls"
        params: list[Any] = []
        if plugin_id is not None:
            query += " WHERE plugin_id = ?"
            params.append(plugin_id)
        query += " ORDER BY id DESC LIMIT ?"
        params.append(max(1, min(int(limit), contract.PLUGIN_TOOL_CALLS_MAX_ROWS)))
        with self.db.transaction() as cur:
            rows = [dict(row) for row in cur.execute(query, params).fetchall()]
        for row in rows:
            row["caller_verified"] = "pane-token" if row["caller_kind"] == "pane" else "none"
        return rows

    def recent_agent_actions(self, *, plugin_id: str | None = None, limit: int = 100) -> list[dict[str, Any]]:
        """Newest written agent plugin actions first (B2-c; shown as plain text by D-f)."""
        if not self.actions_enabled:
            return []
        self.flush()
        query = "SELECT * FROM plugin_agent_actions"
        params: list[Any] = []
        if plugin_id is not None:
            query += " WHERE plugin_id = ?"
            params.append(plugin_id)
        query += " ORDER BY id DESC LIMIT ?"
        params.append(max(1, min(int(limit), contract.PLUGIN_AGENT_ACTIONS_MAX_ROWS)))
        with self.db.transaction() as cur:
            return [dict(row) for row in cur.execute(query, params).fetchall()]

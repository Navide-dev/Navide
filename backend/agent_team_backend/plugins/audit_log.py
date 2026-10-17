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

#: The activity summary's window, and how far over the 7-day daily average a
#: day's calls must be to be flagged (D3: "10x the 7-day baseline").
SUMMARY_WINDOW_DAYS = 30
SPIKE_FACTOR = 10
#: ``PluginActivityReport.schemaVersion`` (``PLUGIN_ACTIVITY_REPORT_SCHEMA_VERSION``).
ACTIVITY_REPORT_SCHEMA_VERSION = 1

OUTSIDE_WORKSPACE = "<outside-workspace>"
#: A shell command that cannot be split the way a shell would split it.
UNPARSABLE = "<unparsable>"
OTHER = "other"

CALLER_KINDS = ("pane", "external", "host")
TOOL_CALL_OUTCOMES = ("ok", "error")
TOOL_RISKS = ("read", "write")
#: ``backend``: a plugin's own frontend calling its own backend (address ``backend.<method>``).
ACTIVITY_SOURCES = ("broker", "shell", "agentTool", "backend")
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


def _utc_day(at_ms: int) -> str:
    return time.strftime("%Y-%m-%d", time.gmtime(at_ms / 1000))


def _day_start_ms(at_ms: int) -> int:
    return at_ms - at_ms % _DAY_MS


def _declared_unused(
    declared: list[dict[str, str]],
    uses: list[Any],
    rolled_uses: list[Any],
    tool_uses: dict[str, int],
    since: int,
) -> list[dict[str, Any]]:
    """The declared entries with no allowed use since ``since``, each with its last use.

    ``system`` keys are namespaces (``fs`` matches ``fs.*``), ``backendMethod``
    keys are addresses, ``agentTool`` keys are tool names, and a ``shell`` key
    is the declared mode (``allowlist`` / ``full``): any allowed shell call uses it.
    """
    out: list[dict[str, Any]] = []
    for entry in declared:
        kind, key = entry.get("kind"), entry.get("key", "")
        last: int | None = None

        def seen(at: int | None) -> None:
            nonlocal last
            if at is not None and (last is None or at > last):
                last = int(at)

        if kind == "agentTool":
            seen(tool_uses.get(key))
        else:
            for source, address, at in [*uses, *rolled_uses]:
                if _declared_match(kind, key, source, address):
                    seen(at)
        if last is None or last < since:
            out.append({"kind": kind, "key": key, "lastUsedAt": last})
    return out


def _declared_match(kind: Any, key: str, source: str, address: str) -> bool:
    if kind == "system":
        return address.startswith(f"{key}.")
    if kind == "backendMethod":
        return address == key
    if kind == "shell":
        return source == "shell"
    return False


def _undeclared_uses(refusals: list[Any]) -> list[dict[str, Any]]:
    """``undeclared`` entries from refusals grouped by source, address, workspace and reason."""
    groups: dict[tuple[str, str, str], dict[str, Any]] = {}
    for source, address, workspace, reason, n, last_at in refusals:
        group = groups.setdefault((source, address, workspace), {"reasons": {}, "count": 0, "lastAt": 0})
        group["reasons"][reason or OTHER] = group["reasons"].get(reason or OTHER, 0) + int(n)
        if reason == "undeclared":
            group["count"] += int(n)
            group["lastAt"] = max(group["lastAt"], int(last_at))
    out = [
        {
            "source": source, "address": address, "workspace": workspace, "count": group["count"],
            "lastAt": group["lastAt"],
            "reasons": [
                {"reason": reason, "count": count}
                for reason, count in sorted(group["reasons"].items(), key=lambda item: (-item[1], item[0]))
            ],
        }
        for (source, address, workspace), group in groups.items()
        if group["count"]
    ]
    out.sort(key=lambda item: (-item["lastAt"], item["source"], item["address"], item["workspace"]))
    return out


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


#: Where a queued tool-call row holds its arguments until flush digests them.
_ARGS_AT = 12


def _with_digest(row: tuple[Any, ...]) -> tuple[Any, ...] | None:
    """A queued tool-call row with its arguments replaced by their digest."""
    try:
        args_sha256, args_bytes = _arguments_digest(row[_ARGS_AT])
    except Exception as err:  # noqa: BLE001 - not JSON: the row is dropped, never raised
        log.warning("plugin audit: tool call %s not recorded: %s", row[0], err)
        return None
    return (*row[:_ARGS_AT], args_sha256, args_bytes, *row[_ARGS_AT + 2:])


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
            # Every statement is CREATE ... IF NOT EXISTS: a table the contract
            # added after this database was created appears; nothing else changes.
            with self.db.transaction() as cur:
                _create_schema(cur)
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
        """Queue one agent tool call; returns its row id, or None when it is not recorded.

        ``at_ms`` is when the call **ended** (contract section 5; the call ran
        over ``[at_ms - duration_ms, at_ms]``); without it, now. Record a call
        once it is over, never with its start time.
        """
        if not self.enabled:
            return None
        try:
            if caller_kind not in CALLER_KINDS:
                raise ValueError(f"unknown caller kind {caller_kind!r}")
            if outcome not in TOOL_CALL_OUTCOMES:
                raise ValueError(f"unknown outcome {outcome!r}")
            if risk not in TOOL_RISKS:
                raise ValueError(f"unknown risk {risk!r}")
            # Tool arguments are a JSON object. The digest walks all of it, so
            # it is computed by flush, off the event loop (#365 review N2);
            # arguments that turn out not to be JSON inside are dropped there.
            if not isinstance(arguments, dict):
                raise ValueError("arguments must be a JSON object")
            at = self._at(at_ms)
            is_pane = caller_kind == "pane"
            caller_ws = str(caller_workspace) if is_pane else ""
            target_ws = str(target_workspace)
            fields = (
                at, caller_kind,
                str(pane_id) if is_pane else "", str(pane_name) if is_pane else "",
                caller_ws, target_ws, int(bool(caller_ws) and caller_ws != target_ws),
                str(plugin_id), str(plugin_version), str(tool), risk,
                arguments, None, outcome, "" if outcome == "ok" else (_code(error_code, ERROR_CODES) or OTHER),
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
        calls = [row for row in map(_with_digest, calls) if row is not None]
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
                cur.execute(
                    "INSERT INTO plugin_activity_denied_daily"
                    " (day, plugin_id, workspace, source, address, denied_reason, count)"
                    " SELECT strftime('%Y-%m-%d', at / 1000, 'unixepoch'), plugin_id, workspace, source, address,"
                    " denied_reason, COUNT(*)"
                    f" FROM plugin_activity WHERE id IN ({marks}) AND outcome = 'denied'"  # noqa: S608 - placeholders only
                    " GROUP BY 1, 2, 3, 4, 5, 6 ORDER BY 1"
                    " ON CONFLICT(day, plugin_id, workspace, source, address, denied_reason)"
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
        while self._batch(
            "DELETE FROM plugin_activity_denied_daily WHERE rowid IN"
            " (SELECT rowid FROM plugin_activity_denied_daily WHERE day < ? LIMIT ?)",
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

    def activity_report(
        self, plugin_id: str, *, declared: list[dict[str, str]] | None = None, now_ms: int | None = None
    ) -> dict[str, Any]:
        """One plugin's ``PluginActivityReport`` (contract 5.1; ``src/shared/pluginActivity.ts``).

        Built from the audit tables, aggregation and anomaly checks included:

        - ``window`` is the 7 days of detail rows; ``totals``, ``toolCalls``,
          ``files``, ``commands`` and ``historicalPeakConcurrency`` cover it.
          The peak is historical (see :meth:`historical_peak_concurrent_calls`).
        - ``daily``: every day still kept, detail rows plus rolled-up days,
          oldest first.
        - ``declaredUnused``: the ``declared`` entries (``{kind, key}``, from
          the Host, which reads the manifest) with no allowed use in
          ``SUMMARY_WINDOW_DAYS`` days, with their last use or null.
        - ``undeclared``: per ``(source, address, workspace)`` with any
          refusal as undeclared since ``undeclaredSince`` (30 days, the
          refusal reasons outlive the detail in
          ``plugin_activity_denied_daily``): ``count`` of those refusals,
          ``lastAt``, and every refusal reason of that address, largest first.
        - ``anomalies`` (flags only): ``volumeSpike`` (today over
          ``SPIKE_FACTOR`` times the 7-day average, never without a baseline),
          ``writeToolNewWorkspace`` (first write agent-tool call in a workspace
          in the last 24 hours) and ``undeclaredDenied`` (per workspace, last
          7 days).
        - ``agentActions`` is null until B2-c's table exists.

        Sizes are passed through as stored: ``-1`` (``UNKNOWN_SIZE``) is never
        added up. Reads only, in one short transaction; run it off the event loop.
        """
        now = self._now_ms() if now_ms is None else int(now_ms)
        window_from = now - contract.PLUGIN_ACTIVITY_DETAIL_RETENTION_DAYS * _DAY_MS
        since = now - SUMMARY_WINDOW_DAYS * _DAY_MS
        report: dict[str, Any] = {
            "schemaVersion": ACTIVITY_REPORT_SCHEMA_VERSION, "pluginId": plugin_id, "generatedAt": now,
            "window": {"from": window_from, "to": now}, "totals": {"calls": 0, "denied": 0, "errors": 0},
            "historicalPeakConcurrency": 0, "undeclaredSince": since, "toolCalls": [], "files": [], "commands": [],
            "daily": [], "declaredUnused": [], "undeclared": [], "anomalies": [], "agentActions": None,
        }
        if not self.enabled:
            return report
        self.flush()
        report["historicalPeakConcurrency"] = self.historical_peak_concurrent_calls(
            plugin_id, since_ms=window_from, until_ms=now
        )["historicalPeak"]
        since_day = _utc_day(since)
        with self.db.transaction() as cur:
            totals = cur.execute(
                "SELECT COUNT(*), SUM(outcome = 'denied'), SUM(outcome = 'error') FROM plugin_activity"
                " WHERE plugin_id = ? AND at >= ?",
                (plugin_id, window_from),
            ).fetchone()
            tool_calls = cur.execute(
                "SELECT * FROM plugin_tool_calls WHERE plugin_id = ? AND at >= ? ORDER BY at DESC, id DESC",
                (plugin_id, window_from),
            ).fetchall()
            files = cur.execute(
                "SELECT fs_path, address, workspace, outcome, COUNT(*), MAX(at) FROM plugin_activity"
                " WHERE plugin_id = ? AND at >= ? AND fs_path != '' GROUP BY 1, 2, 3, 4 ORDER BY 6 DESC, 1, 2, 3, 4",
                (plugin_id, window_from),
            ).fetchall()
            commands = cur.execute(
                "SELECT shell_command, workspace, outcome, COUNT(*), MAX(at) FROM plugin_activity"
                " WHERE plugin_id = ? AND at >= ? AND shell_command != '' GROUP BY 1, 2, 3 ORDER BY 5 DESC, 1, 2, 3",
                (plugin_id, window_from),
            ).fetchall()
            daily = cur.execute(
                "SELECT day, SUM(calls), SUM(denied), SUM(errors) FROM ("
                " SELECT strftime('%Y-%m-%d', at / 1000, 'unixepoch') AS day, COUNT(*) AS calls,"
                "  SUM(outcome = 'denied') AS denied, SUM(outcome = 'error') AS errors"
                "  FROM plugin_activity WHERE plugin_id = ? GROUP BY 1"
                " UNION ALL"
                " SELECT day, SUM(count), SUM(CASE WHEN outcome = 'denied' THEN count ELSE 0 END),"
                "  SUM(CASE WHEN outcome = 'error' THEN count ELSE 0 END)"
                "  FROM plugin_activity_daily WHERE plugin_id = ? GROUP BY 1"
                ") GROUP BY 1 ORDER BY 1",
                (plugin_id, plugin_id),
            ).fetchall()
            refusals = cur.execute(
                "SELECT source, address, workspace, denied_reason, SUM(n), MAX(last_at) FROM ("
                " SELECT source, address, workspace, denied_reason, COUNT(*) AS n, MAX(at) AS last_at"
                "  FROM plugin_activity WHERE plugin_id = ? AND at >= ? AND outcome = 'denied' GROUP BY 1, 2, 3, 4"
                " UNION ALL"
                " SELECT source, address, workspace, denied_reason, SUM(count),"
                "  MAX(CAST(strftime('%s', day) AS INTEGER) * 1000)"
                "  FROM plugin_activity_denied_daily WHERE plugin_id = ? AND day >= ? GROUP BY 1, 2, 3, 4"
                ") GROUP BY 1, 2, 3, 4",
                (plugin_id, since, plugin_id, since_day),
            ).fetchall()
            uses = cur.execute(
                "SELECT source, address, MAX(at) FROM plugin_activity"
                " WHERE plugin_id = ? AND outcome = 'allowed' GROUP BY 1, 2",
                (plugin_id,),
            ).fetchall()
            rolled_uses = cur.execute(
                "SELECT source, address, MAX(CAST(strftime('%s', day) AS INTEGER) * 1000) FROM plugin_activity_daily"
                " WHERE plugin_id = ? AND outcome = 'allowed' GROUP BY 1, 2",
                (plugin_id,),
            ).fetchall()
            tool_uses = dict(cur.execute(
                "SELECT tool, MAX(at) FROM plugin_tool_calls WHERE plugin_id = ? AND outcome = 'ok' GROUP BY 1",
                (plugin_id,),
            ).fetchall())
            recent_undeclared = cur.execute(
                "SELECT workspace, COUNT(*), MAX(at) FROM plugin_activity WHERE plugin_id = ? AND at >= ?"
                " AND outcome = 'denied' AND denied_reason = 'undeclared' GROUP BY 1 ORDER BY 1",
                (plugin_id, now - 7 * _DAY_MS),
            ).fetchall()
            new_writes = cur.execute(
                "SELECT tool, target_workspace, MIN(at) FROM plugin_tool_calls"
                " WHERE plugin_id = ? AND risk = 'write' GROUP BY 1, 2 HAVING MIN(at) >= ? ORDER BY 3, 1, 2",
                (plugin_id, now - _DAY_MS),
            ).fetchall()
        report["totals"] = {"calls": int(totals[0] or 0), "denied": int(totals[1] or 0), "errors": int(totals[2] or 0)}
        report["toolCalls"] = [
            {
                "id": row["id"], "at": row["at"], "callerKind": row["caller_kind"], "paneId": row["pane_id"],
                "paneName": row["pane_name"], "callerWorkspace": row["caller_workspace"],
                "targetWorkspace": row["target_workspace"], "crossWorkspace": bool(row["cross_workspace"]),
                "pluginVersion": row["plugin_version"], "tool": row["tool"], "risk": row["risk"],
                "outcome": row["outcome"], "errorCode": row["error_code"], "durationMs": row["duration_ms"],
                "argsBytes": row["args_bytes"], "resultBytes": row["result_bytes"],
            }
            for row in tool_calls
        ]
        report["files"] = [
            {"path": path, "address": address, "workspace": ws, "outcome": outcome, "count": int(n), "lastAt": last}
            for path, address, ws, outcome, n, last in files
        ]
        report["commands"] = [
            {"command": command, "workspace": ws, "outcome": outcome, "count": int(n), "lastAt": last}
            for command, ws, outcome, n, last in commands
        ]
        report["daily"] = [
            {"day": day, "calls": int(calls), "denied": int(denied or 0), "errors": int(errors or 0)}
            for day, calls, denied, errors in daily
        ]
        report["declaredUnused"] = _declared_unused(declared or [], uses, rolled_uses, tool_uses, since)
        report["undeclared"] = _undeclared_uses(refusals)
        anomalies: list[dict[str, Any]] = []
        counts = {row["day"]: row["calls"] for row in report["daily"]}
        today = _utc_day(now)
        baseline = sum(counts.get(_utc_day(now - d * _DAY_MS), 0) for d in range(1, 8)) / 7
        if baseline > 0 and counts.get(today, 0) > SPIKE_FACTOR * baseline:
            anomalies.append({
                "kind": "volumeSpike", "at": _day_start_ms(now), "workspace": "", "tool": None,
                "count": counts[today], "baseline": baseline,
            })
        anomalies.extend(
            {"kind": "writeToolNewWorkspace", "at": first_at, "workspace": ws, "tool": tool, "count": None, "baseline": None}
            for tool, ws, first_at in new_writes
        )
        anomalies.extend(
            {"kind": "undeclaredDenied", "at": last_at, "workspace": ws, "tool": None, "count": n, "baseline": None}
            for ws, n, last_at in recent_undeclared
        )
        report["anomalies"] = anomalies
        return report

    def historical_peak_concurrent_calls(self, plugin_id: str, *, since_ms: int, until_ms: int) -> dict[str, Any]:
        """The most agent tool calls of ``plugin_id`` that ran at once in the window.

        Each written call ran over ``[at - duration_ms, at]``: ``at`` is when
        the call ended (contract section 5), and a 0 ms call counts as 1 ms. A
        call that ends as another starts does not overlap it. Historical only: calls still running are not in the
        table yet, so the current count is the Host's
        (``plugins:backendCallConcurrency``), never derived from here.
        Returns ``{historicalPeak, at}`` (``at`` is when the peak began, None
        without calls). Reads only; run it off the event loop.
        """
        if not self.enabled:
            return {"historicalPeak": 0, "at": None}
        self.flush()
        with self.db.transaction() as cur:
            spans = cur.execute(
                "SELECT at - duration_ms, at FROM plugin_tool_calls WHERE plugin_id = ? AND at >= ? AND at - duration_ms <= ?",
                (plugin_id, int(since_ms), int(until_ms)),
            ).fetchall()
        # A 0 ms call still ran: it lasts at least 1 ms (#368 review M2). Ends
        # sort before starts at the same instant, so touching spans do not overlap.
        spans = [(start, max(end, start + 1)) for start, end in spans]
        edges = sorted([(start, 1) for start, _ in spans] + [(end, -1) for _, end in spans], key=lambda e: (e[0], e[1]))
        peak, peak_at, running = 0, None, 0
        for at, step in edges:
            running += step
            if running > peak:
                peak, peak_at = running, at
        return {"historicalPeak": peak, "at": peak_at}

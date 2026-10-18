"""Audit of Navide plugin activity in the global navide.db (plan B, B1-d).

Two record tables, created from the contract's ``PLUGIN_AUDIT_DDL``
(docs/en-US/plugin-agent-tools-contract.md section 5):

- ``plugin_tool_calls``: one row per agent tool call (written by the B1 call
  path). The call arguments are never stored, only the SHA-256 and UTF-8
  size of their canonical spelling (an unsalted digest: an argument with
  little entropy can be confirmed by guessing it).
- ``plugin_activity``: one row per agent tool call recorded as activity, and
  the broker and shell-broker rows of earlier versions until they expire;
  ``plugin_activity_counts``: broker and shell-broker calls counted per key
  and minute (written by D-e), never one row per call. ``plugin_activity_daily``
  holds the per-day counts of both once they expire.

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
  "other"; ``address`` must be ``namespace.method`` (or the Host's
  ``<unknown>`` for a capability the broker does not know), otherwise "other";
- a refused or failed broker call keeps no path or command, only the fixed
  ``<denied>`` / ``<failed>``: the plugin wrote that text and the call cost
  it nothing, so it is never a key;
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
import math
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
_BACKEND_CALLS_COMPONENT = "plugin_backend_calls"
_MINUTE_MS = 60_000
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
#: ``host``: a Host setting the user changed that governs which Navide plugins
#: may run (card K4: the Developer Mode switch), filed under the Host's own
#: event identity ``host``, never a plugin id.
ACTIVITY_SOURCES = ("broker", "shell", "agentTool", "host")
ACTIVITY_OUTCOMES = ("allowed", "denied", "error")
#: The contract's call error codes plus the codes the backend produces itself:
#: two transport codes (contract 4.2), ``result_helper_failed`` (a result in
#: pieces its helper process could not handle, 4.4) and ``cancelled``, a call
#: its caller cancelled before it was answered (contract 5).
ERROR_CODES = frozenset((
    *contract.AGENT_TOOL_CALL_ERROR_CODES, "host_unavailable", "host_timeout", "result_helper_failed", "cancelled",
))
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
    backend_uses: dict[str, int] | None = None,
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
        elif kind == "backendMethod" and backend_uses is not None:
            # Called at all counts as used, whatever the outcome: "declared but
            # never called" is what the row means for a backend method.
            seen(backend_uses.get(key))
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


def _non_negative_number(value: Any) -> float:
    """A finite number >= 0 (not a bool): a resource usage or threshold."""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
        raise ValueError(f"expected a finite number >= 0, got {value!r}")
    return float(value) if isinstance(value, float) else value


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


#: SQLite's INTEGER range: a count outside it would fail the whole flush
#: transaction, and with it every other plugin's rows (a type range, not a limit).
_SQLITE_INT_MAX = 2**63 - 1


def _sqlite_count(value: Any) -> bool:
    return not isinstance(value, bool) and isinstance(value, int) and 1 <= value <= _SQLITE_INT_MAX


#: Fixed values recorded in place of a plugin's text (contract 5).
_MARKERS = frozenset((
    contract.PLUGIN_ACTIVITY_UNKNOWN_ADDRESS, contract.PLUGIN_ACTIVITY_DENIED_TARGET,
    contract.PLUGIN_ACTIVITY_FAILED_TARGET, contract.PLUGIN_ACTIVITY_MISSING_TARGET,
))


def _plain(value: str) -> str:
    """A plugin's own path or command spelled like a fixed value, as ``./<value>``."""
    return f"./{value}" if value in _MARKERS else value


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


def _create_backend_calls_schema(cur: sqlite3.Cursor) -> None:
    for statement in contract.PLUGIN_BACKEND_CALLS_DDL:
        cur.execute(statement)


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
        # Broker and shell-broker calls, added up per (plugin, version,
        # workspace, source, address, outcome, reason, path, command, minute)
        # until the next flush: [count, latest at].
        self._activity_counts: dict[tuple[Any, ...], list[int]] = {}
        self._decisions: list[tuple[Any, ...]] = []
        self._actions: list[tuple[Any, ...]] = []
        # Backend calls, added up per (plugin, version, workspace, address,
        # outcome, minute) until the next flush.
        self._backend_calls: dict[tuple[str, str, str, str, str, int], int] = {}
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
        self.backend_calls_enabled = False
        self.backend_calls_disabled_reason = ""
        try:
            self.db.migrate(_BACKEND_CALLS_COMPONENT, 1, _create_backend_calls_schema)
            self.backend_calls_enabled = True
        except Exception as err:  # noqa: BLE001 - the backend starts without this record
            self.backend_calls_disabled_reason = f"{type(err).__name__}: {err}"
            log.error("plugin backend-call record disabled: the table could not be created: %s",
                      self.backend_calls_disabled_reason)
            _report_disabled(
                self.backend_calls_disabled_reason, "PLUGIN_BACKEND_CALLS_AUDIT_DISABLED",
                "Navide plugin backend-call record",
            )

    def _now_ms(self) -> int:
        return int(self._clock() * 1000)

    def _at(self, at_ms: int | None) -> int:
        now = self._now_ms()
        return now if at_ms is None else min(_non_negative_int(at_ms), now)

    def status(self) -> dict[str, Any]:
        with self._lock:
            pending = (
                len(self._calls) + len(self._activity) + len(self._actions) + len(self._decisions)
                + len(self._backend_calls) + len(self._activity_counts)
            )
        return {
            "enabled": self.enabled, "reason": self.disabled_reason, "pending": pending,
            "actions_enabled": self.actions_enabled, "actions_reason": self.actions_disabled_reason,
            "backend_calls_enabled": self.backend_calls_enabled,
            "backend_calls_reason": self.backend_calls_disabled_reason,
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
        count: int = 1,
    ) -> bool:
        """Queue one agent-tool activity row, or count ``count`` broker or shell
        calls into their key's row for that minute; False when not recorded."""
        if not self.enabled:
            return False
        try:
            if not _sqlite_count(count):
                raise ValueError("count must be an integer from 1 to 2**63 - 1")
            if source not in ACTIVITY_SOURCES:
                raise ValueError(f"unknown source {source!r}")
            if outcome not in ACTIVITY_OUTCOMES:
                raise ValueError(f"unknown outcome {outcome!r}")
            if not isinstance(address, str) or not address:
                raise ValueError("address is required")
            if tool_call_id is not None:
                _non_negative_int(tool_call_id)
            if source != "agentTool" and tool_call_id is None:
                self._count_activity(
                    plugin_id, plugin_version, workspace, source, address, outcome, denied_reason, fs_path,
                    shell_command, self._at(at_ms), count,
                )
                return True
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

    def _count_activity(
        self, plugin_id: str, plugin_version: str, workspace: str, source: str, address: str, outcome: str,
        denied_reason: str, fs_path: str, shell_command: str, at: int, count: int,
    ) -> None:
        kept_error = (
            outcome == "error" and address not in contract.PLUGIN_ACTIVITY_READ_ONLY_ADDRESSES
            and address != contract.PLUGIN_ACTIVITY_UNKNOWN_ADDRESS and _ADDRESS.fullmatch(address) is not None
        )
        if outcome == "allowed" or kept_error:
            # A failed call that is not known to change nothing may have done
            # something: it keeps its redacted path and command, as an allowed
            # call does. The Host's own fixed value stays as it is: <missing>
            # (an allowed read that found nothing), <failed> (answered before
            # dispatch).
            host_marker = (
                contract.PLUGIN_ACTIVITY_MISSING_TARGET if outcome == "allowed" else contract.PLUGIN_ACTIVITY_FAILED_TARGET
            )
            path = fs_path if fs_path == host_marker else _plain(_relative_path(str(fs_path), str(workspace)))
            command = shell_command if shell_command == host_marker else _plain(_shell_summary(str(shell_command)))
        else:
            marker = contract.PLUGIN_ACTIVITY_DENIED_TARGET if outcome == "denied" else contract.PLUGIN_ACTIVITY_FAILED_TARGET
            path = marker if fs_path else ""
            command = marker if shell_command else ""
        known = address == contract.PLUGIN_ACTIVITY_UNKNOWN_ADDRESS or _ADDRESS.fullmatch(address)
        key = (
            str(plugin_id), str(plugin_version), str(workspace), source, address if known else OTHER, outcome,
            (_code(denied_reason, DENIED_REASONS) or OTHER) if outcome == "denied" else "",
            path, command, at - at % _MINUTE_MS,
        )
        with self._lock:
            counted = self._activity_counts.get(key)
            if counted is None:
                self._activity_counts[key] = [count, at]
            else:
                counted[0] += count
                counted[1] = max(counted[1], at)

    def record_resource_decision(
        self,
        *,
        plugin_id: str,
        plugin_version: str,
        item: str,
        usage: float,
        threshold: float,
        decision: str,
        at: int | None = None,
    ) -> bool:
        """Queue one watchdog notice or decision (section 5.2); False when it is not recorded.

        ``at`` (Unix ms, from the Host) is clamped to now. Only the item and its
        numbers are kept: there is no field for a path or a command line.
        """
        if not self.enabled:
            return False
        try:
            if not isinstance(plugin_id, str) or not plugin_id or not isinstance(plugin_version, str):
                raise ValueError("plugin_id and plugin_version are required")
            if item not in contract.PLUGIN_RESOURCE_ITEMS:
                raise ValueError(f"unknown item {item!r}")
            if decision not in contract.PLUGIN_RESOURCE_DECISIONS:
                raise ValueError(f"unknown decision {decision!r}")
            numbers = (_non_negative_number(usage), _non_negative_number(threshold))
            row = (self._at(at), plugin_id, plugin_version, item, *numbers, decision)
            with self._lock:
                self._decisions.append(row)
        except Exception as err:  # noqa: BLE001 - the audit never fails what it records
            log.warning("plugin audit: resource decision not recorded: %s", err)
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

    def record_backend_calls(
        self,
        *,
        plugin_id: str,
        plugin_version: str,
        workspace: str,
        address: str,
        outcome: str,
        count: int,
        at_ms: int | None = None,
    ) -> bool:
        """Add ``count`` calls into the current minute's row for this key; False when not recorded.

        One dictionary update per batch row, nothing written here: ``flush``
        adds the totals into ``plugin_backend_call_minutes``.
        """
        if not self.backend_calls_enabled:
            return False
        try:
            if outcome not in contract.PLUGIN_BACKEND_CALL_OUTCOMES:
                raise ValueError(f"unknown outcome {outcome!r}")
            if not isinstance(address, str) or not address.startswith(contract.PLUGIN_BACKEND_CALL_ADDRESS_PREFIX):
                raise ValueError("address must be backend.<method>")
            if not _sqlite_count(count):
                raise ValueError("count must be an integer from 1 to 2**63 - 1")
            minute = self._at(at_ms) // _MINUTE_MS * _MINUTE_MS
            key = (str(plugin_id), str(plugin_version), str(workspace), address, outcome, minute)
            with self._lock:
                self._backend_calls[key] = self._backend_calls.get(key, 0) + count
        except Exception as err:  # noqa: BLE001 - the record never fails the call it records
            log.warning("plugin audit: backend calls not recorded: %s", err)
            return False
        return True

    def flush(self) -> None:
        """Write every queued row in one short transaction; never raises."""
        with self._lock:
            calls, self._calls = self._calls, []
            activity, self._activity = self._activity, []
            actions, self._actions = self._actions, []
            backend_calls, self._backend_calls = self._backend_calls, {}
            decisions, self._decisions = self._decisions, []
            activity_counts, self._activity_counts = self._activity_counts, {}
        if backend_calls:
            try:
                with self.db.transaction() as cur:
                    cur.executemany(
                        "INSERT INTO plugin_backend_call_minutes (plugin_id, plugin_version, workspace, address,"
                        " outcome, minute, count) VALUES (?, ?, ?, ?, ?, ?, ?)"
                        " ON CONFLICT(plugin_id, plugin_version, workspace, address, outcome, minute)"
                        " DO UPDATE SET count = count + excluded.count",
                        [(*key, n) for key, n in backend_calls.items()],
                    )
                    cur.executemany(
                        "INSERT INTO plugin_backend_call_days (plugin_id, address, outcome, day, plugin_version,"
                        " workspace, count, last_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
                        " ON CONFLICT(plugin_id, address, outcome, day, plugin_version, workspace)"
                        " DO UPDATE SET count = count + excluded.count, last_at = MAX(last_at, excluded.last_at)",
                        [
                            (plugin_id, address, outcome, _utc_day(minute), version, workspace, n, minute)
                            for (plugin_id, version, workspace, address, outcome, minute), n in backend_calls.items()
                        ],
                    )
            except Exception as err:  # noqa: BLE001 - dropped, never raised into a call
                log.warning("plugin audit: %d backend-call rows not written: %s", len(backend_calls), err)
        if decisions:
            # Its own short transaction: a failure here never drops the activity rows.
            try:
                with self.db.transaction() as cur:
                    cur.executemany(
                        "INSERT INTO plugin_resource_decisions (at, plugin_id, plugin_version, item, usage, threshold,"
                        " decision) VALUES (?, ?, ?, ?, ?, ?, ?)",
                        decisions,
                    )
            except Exception as err:  # noqa: BLE001 - dropped, never raised into a decision
                log.warning("plugin audit: %d resource-decision rows not written: %s", len(decisions), err)
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
        if not calls and not activity and not activity_counts:
            return
        calls = [row for row in map(_with_digest, calls) if row is not None]
        # plugin_id, tool, target_workspace, at of each write call.
        first_seen = [(row[8], row[10], row[6], row[1]) for row in calls if row[11] == "write"]
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
                    "INSERT INTO plugin_tool_first_seen (plugin_id, tool, workspace, first_at) VALUES (?, ?, ?, ?)"
                    " ON CONFLICT(plugin_id, tool, workspace) DO UPDATE SET first_at = MIN(first_at, excluded.first_at)",
                    first_seen,
                )
                cur.executemany(
                    "INSERT INTO plugin_activity (at, plugin_id, plugin_version, workspace, source, address,"
                    " outcome, denied_reason, fs_path, shell_command, tool_call_id)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    activity,
                )
                # Broker and shell calls: added into their key's row for that minute.
                cur.executemany(
                    "INSERT INTO plugin_activity_counts (plugin_id, plugin_version, workspace, source, address,"
                    " outcome, denied_reason, fs_path, shell_command, minute, count, last_at)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
                    " ON CONFLICT(plugin_id, minute, plugin_version, workspace, source, address, outcome,"
                    " denied_reason, fs_path, shell_command)"
                    " DO UPDATE SET count = count + excluded.count, last_at = MAX(last_at, excluded.last_at)",
                    [(*key, n, last) for key, (n, last) in activity_counts.items()],
                )
        except Exception as err:  # noqa: BLE001 - dropped, never raised into a call
            log.warning(
                "plugin audit: %d rows not written: %s", len(calls) + len(activity) + len(activity_counts), err,
            )

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
        if not self.enabled and not self.actions_enabled and not self.backend_calls_enabled:
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
        if self.backend_calls_enabled:
            try:
                self._prune_backend_calls(now)
            except _PruneStopped:
                log.info("plugin audit: pruning stopped for shutdown; it resumes on the next start")
            except Exception as err:  # noqa: BLE001 - retention must not break anything
                log.warning("plugin audit: pruning backend calls failed: %s", err)

    def _prune_backend_calls(self, now: int) -> None:
        """Minute counts are kept as long as detail rows, day counts as long as the activity day counts."""
        cutoff = now - contract.PLUGIN_BACKEND_CALL_MINUTE_RETENTION_DAYS * _DAY_MS
        while self._batch(
            "DELETE FROM plugin_backend_call_minutes WHERE rowid IN"
            " (SELECT rowid FROM plugin_backend_call_minutes WHERE minute < ? LIMIT ?)",
            (cutoff, PRUNE_BATCH_ROWS),
        ):
            pass
        day = _utc_day(now - contract.PLUGIN_BACKEND_CALL_RETENTION_DAYS * _DAY_MS)
        while self._batch(
            "DELETE FROM plugin_backend_call_days WHERE (plugin_id, address, outcome, day, plugin_version, workspace)"
            " IN (SELECT plugin_id, address, outcome, day, plugin_version, workspace FROM plugin_backend_call_days"
            " WHERE day < ? LIMIT ?)",
            (day, PRUNE_BATCH_ROWS),
        ):
            pass

    def backend_call_report(self, plugin_id: str, *, window_from: int) -> dict[str, Any]:
        """``backendCalls`` of a report: per method and outcome in the window, and per day kept."""
        out: dict[str, Any] = {"methods": [], "daily": []}
        if not self.backend_calls_enabled:
            return out
        # From the day counts: a few rows per method a day, however busy.
        with self.db.transaction() as cur:
            methods = cur.execute(
                "SELECT address, outcome, SUM(count), MAX(last_at) FROM plugin_backend_call_days"
                " WHERE plugin_id = ? AND day >= ? GROUP BY 1, 2 ORDER BY 3 DESC, 1, 2",
                (plugin_id, _utc_day(window_from)),
            ).fetchall()
            daily = cur.execute(
                "SELECT day, SUM(count),"
                " SUM(CASE WHEN outcome = 'denied' THEN count ELSE 0 END),"
                " SUM(CASE WHEN outcome = 'error' THEN count ELSE 0 END),"
                " SUM(CASE WHEN outcome = 'cancelled' THEN count ELSE 0 END)"
                " FROM plugin_backend_call_days WHERE plugin_id = ? GROUP BY 1 ORDER BY 1",
                (plugin_id,),
            ).fetchall()
        out["methods"] = [
            {"address": address, "outcome": outcome, "count": int(n), "lastAt": int(last)}
            for address, outcome, n, last in methods
        ]
        out["daily"] = [
            {"day": day, "calls": int(n), "denied": int(denied or 0), "errors": int(errors or 0),
             "cancelled": int(cancelled or 0)}
            for day, n, denied, errors, cancelled in daily
        ]
        return out

    def backend_method_last_calls(self, plugin_id: str) -> dict[str, int]:
        """Per backend address, the last minute it was called with any outcome (L4: called, not just succeeded)."""
        if not self.backend_calls_enabled:
            return {}
        with self.db.transaction() as cur:
            return {
                address: int(last) for address, last in cur.execute(
                    "SELECT address, MAX(last_at) FROM plugin_backend_call_days WHERE plugin_id = ? GROUP BY 1",
                    (plugin_id,),
                ).fetchall()
            }

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
        # The counted broker rows the same way, by ``minute``: a minute never
        # spans two UTC days.
        while True:
            with self.db.transaction() as cur:
                ids = [
                    int(row[0])
                    for row in cur.execute(
                        "SELECT rowid FROM plugin_activity_counts WHERE minute < ? ORDER BY minute LIMIT ?",
                        (detail_cutoff, batch),
                    )
                ]
                if not ids:
                    break
                marks = ",".join("?" * len(ids))
                cur.execute(
                    "INSERT INTO plugin_activity_daily (day, plugin_id, workspace, source, address, outcome, count)"
                    " SELECT strftime('%Y-%m-%d', minute / 1000, 'unixepoch'), plugin_id, workspace, source, address,"
                    f" outcome, SUM(count) FROM plugin_activity_counts WHERE rowid IN ({marks})"  # noqa: S608 - placeholders only
                    " GROUP BY 1, 2, 3, 4, 5, 6 ORDER BY 1"
                    " ON CONFLICT(day, plugin_id, workspace, source, address, outcome)"
                    " DO UPDATE SET count = count + excluded.count",
                    ids,
                )
                cur.execute(
                    "INSERT INTO plugin_activity_denied_daily"
                    " (day, plugin_id, workspace, source, address, denied_reason, count)"
                    " SELECT strftime('%Y-%m-%d', minute / 1000, 'unixepoch'), plugin_id, workspace, source, address,"
                    " denied_reason, SUM(count)"
                    f" FROM plugin_activity_counts WHERE rowid IN ({marks}) AND outcome = 'denied'"  # noqa: S608
                    " GROUP BY 1, 2, 3, 4, 5, 6 ORDER BY 1"
                    " ON CONFLICT(day, plugin_id, workspace, source, address, denied_reason)"
                    " DO UPDATE SET count = count + excluded.count",
                    ids,
                )
                cur.execute(f"DELETE FROM plugin_activity_counts WHERE rowid IN ({marks})", ids)  # noqa: S608
            self._between_batches()
        day = time.strftime("%Y-%m-%d", time.gmtime(daily_cutoff / 1000))
        while self._batch(
            "DELETE FROM plugin_activity_daily WHERE rowid IN"
            " (SELECT rowid FROM plugin_activity_daily WHERE day < ? LIMIT ?)",
            (day, batch),
        ):
            pass
        while self._batch(
            "DELETE FROM plugin_resource_decisions WHERE id IN"
            " (SELECT id FROM plugin_resource_decisions WHERE at < ? LIMIT ?)",
            (daily_cutoff, batch),
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
        self,
        plugin_id: str,
        *,
        declared: list[dict[str, str]] | None = None,
        installed_at: int | None = None,
        now_ms: int | None = None,
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
          in the last 24 hours, and, given ``installed_at``, the first since
          the plugin was installed: a first-seen row from an earlier install
          counts as absent, so a reinstall is new again even when the
          ``plugin.activity.forget`` of its removal was lost) and
          ``undeclaredDenied`` (per workspace, last 7 days).
        - ``agentActions``: what agents did to the plugin in
          ``plugin_agent_actions`` over the same 30 days, newest first (a
          person's decisions are not listed); null when that table is off.
        - ``backendCalls``: calls into the plugin's own backend, from
          ``plugin_backend_call_days`` (``methods`` per address and outcome
          from the UTC day ``window`` starts in, ``daily`` for every day kept). They are not in
          ``totals``, ``daily`` or ``volumeSpike``, which mean broker, shell and
          agent-tool activity as before.

        Sizes are passed through as stored: ``-1`` (``UNKNOWN_SIZE``) is never
        added up. Reads only, in one short transaction; run it off the event loop.
        """
        now = self._now_ms() if now_ms is None else int(now_ms)
        if installed_at is not None:
            installed_at = min(int(installed_at), now)  # an install time in the future is now (#373 N4)
        window_from = now - contract.PLUGIN_ACTIVITY_DETAIL_RETENTION_DAYS * _DAY_MS
        since = now - SUMMARY_WINDOW_DAYS * _DAY_MS
        report: dict[str, Any] = {
            "schemaVersion": ACTIVITY_REPORT_SCHEMA_VERSION, "pluginId": plugin_id, "generatedAt": now,
            "window": {"from": window_from, "to": now}, "totals": {"calls": 0, "denied": 0, "errors": 0},
            "historicalPeakConcurrency": 0, "undeclaredSince": since, "toolCalls": [], "files": [], "commands": [],
            "daily": [], "declaredUnused": [], "undeclared": [], "anomalies": [], "agentActions": None,
            "backendCalls": {"methods": [], "daily": []},
        }
        if not self.enabled:
            return report
        self.flush()
        report["historicalPeakConcurrency"] = self.historical_peak_concurrent_calls(
            plugin_id, since_ms=window_from, until_ms=now
        )["historicalPeak"]
        since_day = _utc_day(since)
        # Counted rows by minute: the minute a window starts in is read whole.
        window_minute = window_from - window_from % _MINUTE_MS
        since_minute = since - since % _MINUTE_MS
        recent_minute = (now - 7 * _DAY_MS) - (now - 7 * _DAY_MS) % _MINUTE_MS
        with self.db.transaction() as cur:
            totals = cur.execute(
                "SELECT SUM(calls), SUM(denied), SUM(errors) FROM ("
                " SELECT COUNT(*) AS calls, SUM(outcome = 'denied') AS denied, SUM(outcome = 'error') AS errors"
                "  FROM plugin_activity WHERE plugin_id = ? AND at >= ?"
                " UNION ALL"
                " SELECT SUM(count), SUM(CASE WHEN outcome = 'denied' THEN count ELSE 0 END),"
                "  SUM(CASE WHEN outcome = 'error' THEN count ELSE 0 END)"
                "  FROM plugin_activity_counts WHERE plugin_id = ? AND minute >= ?)",
                (plugin_id, window_from, plugin_id, window_minute),
            ).fetchone()
            tool_calls = cur.execute(
                "SELECT * FROM plugin_tool_calls WHERE plugin_id = ? AND at >= ? ORDER BY at DESC, id DESC",
                (plugin_id, window_from),
            ).fetchall()
            files = cur.execute(
                "SELECT fs_path, address, workspace, outcome, SUM(n), MAX(last_at) FROM ("
                " SELECT fs_path, address, workspace, outcome, COUNT(*) AS n, MAX(at) AS last_at FROM plugin_activity"
                "  WHERE plugin_id = ? AND at >= ? AND fs_path != '' GROUP BY 1, 2, 3, 4"
                " UNION ALL"
                " SELECT fs_path, address, workspace, outcome, SUM(count), MAX(last_at) FROM plugin_activity_counts"
                "  WHERE plugin_id = ? AND minute >= ? AND fs_path != '' GROUP BY 1, 2, 3, 4"
                ") GROUP BY 1, 2, 3, 4 ORDER BY 6 DESC, 1, 2, 3, 4",
                (plugin_id, window_from, plugin_id, window_minute),
            ).fetchall()
            commands = cur.execute(
                "SELECT shell_command, workspace, outcome, SUM(n), MAX(last_at) FROM ("
                " SELECT shell_command, workspace, outcome, COUNT(*) AS n, MAX(at) AS last_at FROM plugin_activity"
                "  WHERE plugin_id = ? AND at >= ? AND shell_command != '' GROUP BY 1, 2, 3"
                " UNION ALL"
                " SELECT shell_command, workspace, outcome, SUM(count), MAX(last_at) FROM plugin_activity_counts"
                "  WHERE plugin_id = ? AND minute >= ? AND shell_command != '' GROUP BY 1, 2, 3"
                ") GROUP BY 1, 2, 3 ORDER BY 5 DESC, 1, 2, 3",
                (plugin_id, window_from, plugin_id, window_minute),
            ).fetchall()
            daily = cur.execute(
                "SELECT day, SUM(calls), SUM(denied), SUM(errors) FROM ("
                " SELECT strftime('%Y-%m-%d', at / 1000, 'unixepoch') AS day, COUNT(*) AS calls,"
                "  SUM(outcome = 'denied') AS denied, SUM(outcome = 'error') AS errors"
                "  FROM plugin_activity WHERE plugin_id = ? GROUP BY 1"
                " UNION ALL"
                " SELECT strftime('%Y-%m-%d', minute / 1000, 'unixepoch'), SUM(count),"
                "  SUM(CASE WHEN outcome = 'denied' THEN count ELSE 0 END),"
                "  SUM(CASE WHEN outcome = 'error' THEN count ELSE 0 END)"
                "  FROM plugin_activity_counts WHERE plugin_id = ? GROUP BY 1"
                " UNION ALL"
                " SELECT day, SUM(count), SUM(CASE WHEN outcome = 'denied' THEN count ELSE 0 END),"
                "  SUM(CASE WHEN outcome = 'error' THEN count ELSE 0 END)"
                "  FROM plugin_activity_daily WHERE plugin_id = ? GROUP BY 1"
                ") GROUP BY 1 ORDER BY 1",
                (plugin_id, plugin_id, plugin_id),
            ).fetchall()
            refusals = cur.execute(
                "SELECT source, address, workspace, denied_reason, SUM(n), MAX(last_at) FROM ("
                " SELECT source, address, workspace, denied_reason, COUNT(*) AS n, MAX(at) AS last_at"
                "  FROM plugin_activity WHERE plugin_id = ? AND at >= ? AND outcome = 'denied' GROUP BY 1, 2, 3, 4"
                " UNION ALL"
                " SELECT source, address, workspace, denied_reason, SUM(count), MAX(last_at)"
                "  FROM plugin_activity_counts WHERE plugin_id = ? AND minute >= ? AND outcome = 'denied'"
                "  GROUP BY 1, 2, 3, 4"
                " UNION ALL"
                " SELECT source, address, workspace, denied_reason, SUM(count),"
                "  MAX(CAST(strftime('%s', day) AS INTEGER) * 1000)"
                "  FROM plugin_activity_denied_daily WHERE plugin_id = ? AND day >= ? GROUP BY 1, 2, 3, 4"
                ") GROUP BY 1, 2, 3, 4",
                (plugin_id, since, plugin_id, since_minute, plugin_id, since_day),
            ).fetchall()
            uses = cur.execute(
                "SELECT source, address, MAX(last_at) FROM ("
                " SELECT source, address, MAX(at) AS last_at FROM plugin_activity"
                "  WHERE plugin_id = ? AND outcome = 'allowed' GROUP BY 1, 2"
                " UNION ALL"
                " SELECT source, address, MAX(last_at) FROM plugin_activity_counts"
                "  WHERE plugin_id = ? AND outcome = 'allowed' GROUP BY 1, 2"
                ") GROUP BY 1, 2",
                (plugin_id, plugin_id),
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
                "SELECT workspace, SUM(n), MAX(last_at) FROM ("
                " SELECT workspace, COUNT(*) AS n, MAX(at) AS last_at FROM plugin_activity WHERE plugin_id = ?"
                "  AND at >= ? AND outcome = 'denied' AND denied_reason = 'undeclared' GROUP BY 1"
                " UNION ALL"
                " SELECT workspace, SUM(count), MAX(last_at) FROM plugin_activity_counts WHERE plugin_id = ?"
                "  AND minute >= ? AND outcome = 'denied' AND denied_reason = 'undeclared' GROUP BY 1"
                ") GROUP BY 1 ORDER BY 1",
                (plugin_id, now - 7 * _DAY_MS, plugin_id, recent_minute),
            ).fetchall()
            # From plugin_tool_first_seen, which outlives the call rows (L4).
            floor = max(now - _DAY_MS, installed_at or 0)
            new_writes = cur.execute(
                "SELECT tool, workspace, first_at FROM plugin_tool_first_seen"
                " WHERE plugin_id = ? AND first_at >= ? ORDER BY 3, 1, 2",
                (plugin_id, floor),
            ).fetchall()
            if installed_at:
                # A row older than this install is an earlier install's: the
                # first write since installing is in the call rows (#373 F1).
                # One grouped pass over this plugin's calls since the install
                # (plugin_tool_calls_plugin_at), joined back: not one lookup per
                # stale row (#373 N1).
                new_writes += cur.execute(
                    "SELECT f.tool, f.workspace, since.first_at FROM plugin_tool_first_seen f JOIN ("
                    " SELECT tool, target_workspace AS workspace, MIN(at) AS first_at FROM plugin_tool_calls"
                    "  WHERE plugin_id = ? AND at >= ? AND risk = 'write' GROUP BY 1, 2"
                    ") since ON since.tool = f.tool AND since.workspace = f.workspace"
                    " WHERE f.plugin_id = ? AND f.first_at < ? AND since.first_at >= ?",
                    (plugin_id, installed_at, plugin_id, installed_at, floor),
                ).fetchall()
                new_writes.sort(key=lambda row: (row[2], row[0], row[1]))
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
        report["backendCalls"] = self.backend_call_report(plugin_id, window_from=window_from)
        report["declaredUnused"] = _declared_unused(
            declared or [], uses, rolled_uses, tool_uses, since, self.backend_method_last_calls(plugin_id),
        )
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
        report["agentActions"] = self._agent_actions(plugin_id, since)
        return report

    def _agent_actions(self, plugin_id: str, since: int) -> list[dict[str, Any]] | None:
        """What agents did to ``plugin_id`` since ``since`` (``plugin_agent_actions``),
        newest first; a person's own decisions are not agent actions. None
        when that table is off."""
        if not self.actions_enabled:
            return None
        with self.db.transaction() as cur:
            rows = cur.execute(
                "SELECT at, action, caller_kind, caller_pane_id, caller_pane_name, caller_workspace, plugin_version"
                " FROM plugin_agent_actions WHERE plugin_id = ? AND at >= ? AND caller_kind != 'user'"
                " ORDER BY at DESC, id DESC",
                (plugin_id, since),
            ).fetchall()
        return [
            {"at": at, "action": action, "callerKind": kind, "paneId": pane_id, "paneName": pane_name,
             "workspace": workspace, "version": version}
            for at, action, kind, pane_id, pane_name, workspace, version in rows
        ]

    def forget_plugin(self, plugin_id: str) -> None:
        """A removed plugin: drop its first-seen rows, so a reinstall's first
        write in a workspace is new again, its resource decisions, its counted
        broker calls and its backend-call counts. Never raises."""
        if not self.enabled and not self.backend_calls_enabled:
            return
        self.flush()
        try:
            with self.db.transaction() as cur:
                if self.enabled:
                    cur.execute("DELETE FROM plugin_tool_first_seen WHERE plugin_id = ?", (plugin_id,))
                    cur.execute("DELETE FROM plugin_resource_decisions WHERE plugin_id = ?", (plugin_id,))
                    cur.execute("DELETE FROM plugin_activity_counts WHERE plugin_id = ?", (plugin_id,))
                if self.backend_calls_enabled:
                    cur.execute("DELETE FROM plugin_backend_call_minutes WHERE plugin_id = ?", (plugin_id,))
                    cur.execute("DELETE FROM plugin_backend_call_days WHERE plugin_id = ?", (plugin_id,))
        except Exception as err:  # noqa: BLE001 - the audit never fails what it records
            log.warning("plugin audit: %s not forgotten: %s", plugin_id, err)

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

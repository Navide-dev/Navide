"""Audit of Navide plugin activity in the global navide.db (plan B, B1-d).

Two record tables, created from the contract's ``PLUGIN_AUDIT_DDL``
(docs/en-US/plugin-agent-tools-contract.md section 5):

- ``plugin_tool_calls``: one row per agent tool call (written by the B1 call
  path). The call arguments are never stored, only the SHA-256 and UTF-8
  size of their canonical spelling.
- ``plugin_activity``: one row per broker or shell-broker call and per agent
  tool call (written by D-e), with ``plugin_activity_daily`` holding the
  per-day counts of detail rows once they expire.

Both are write-only: they decide nothing, and a write that fails is logged
and dropped, never raised into the call it records.

Caller identity (B0 decision c): a ``pane`` caller is the pane whose MCP
token it presented. The token proves the pane, not the process that used it:
a process running as the same user that can read that pane's environment or
config file can present it too. Reads say so in ``caller_verified``
("pane-token" for a pane, "none" for an external or host caller).

Retention (contract constants): tool calls 30 days, then the newest 10,000;
activity detail 7 days, rolled up by UTC day into the daily table first;
daily rows 90 days. Pruning runs on open and at most hourly from a write.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import sqlite3
import time
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any

from ..db import Database
from . import agent_tools_contract as contract
from .disclosure_contract import CanonicalJsonError, canonical_contract_json

log = logging.getLogger(__name__)

_COMPONENT = "plugin_audit"
_DAY_MS = 86_400_000
_PRUNE_INTERVAL_MS = 3_600_000

CALLER_KINDS = ("pane", "external", "host")
TOOL_CALL_OUTCOMES = ("ok", "error")
TOOL_RISKS = ("read", "write")
ACTIVITY_SOURCES = ("broker", "shell", "agentTool")
ACTIVITY_OUTCOMES = ("allowed", "denied", "error")


def _create_schema(cur: sqlite3.Cursor) -> None:
    for statement in contract.PLUGIN_AUDIT_DDL:
        cur.execute(statement)


def _arguments_digest(arguments: Any) -> tuple[str, int]:
    """SHA-256 and byte size of the arguments' canonical spelling.

    Arguments with a fraction cannot be spelled canonically (safe integers
    only); they are digested in the same sorted, compact, ASCII spelling with
    the numbers as JSON writes them. Anything that is not JSON raises.
    """
    try:
        spelled = canonical_contract_json(arguments)
    except CanonicalJsonError:
        spelled = json.dumps(arguments, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False)
    data = spelled.encode("utf-8")
    return hashlib.sha256(data).hexdigest(), len(data)


def _non_negative_int(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"expected a non-negative integer, got {value!r}")
    return value


def _relative_path(path: str, workspace: str) -> str:
    """``path`` relative to ``workspace``, spelled with ``/`` on every
    platform; "" when it is not inside it."""
    if not path:
        return ""
    if not os.path.isabs(path):
        relative = os.path.normpath(path)
    elif not workspace or not os.path.isabs(workspace):
        return ""
    else:
        try:
            relative = os.path.relpath(path, workspace)
        except ValueError:  # another drive on Windows
            return ""
    if relative == ".." or relative.startswith(".." + os.sep):
        return ""
    return relative.replace(os.sep, "/")


def _executable_and_subcommand(command: str) -> str:
    return " ".join(command.split()[:2])


def _utc_day(at_ms: int) -> str:
    return datetime.fromtimestamp(at_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")


class PluginAuditLog:
    """Append-only writer and pruner for the plugin audit tables."""

    def __init__(self, db: Database, *, clock: Callable[[], float] = time.time) -> None:
        self.db = db
        self._clock = clock
        self.db.migrate(_COMPONENT, 1, _create_schema)
        self._last_prune_ms: int | None = None
        self.prune()

    def _now_ms(self) -> int:
        return int(self._clock() * 1000)

    def _maybe_prune(self, now_ms: int) -> None:
        if self._last_prune_ms is None or now_ms - self._last_prune_ms >= _PRUNE_INTERVAL_MS:
            self.prune()

    # ── writes ──────────────────────────────────────────────────────────

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
        """Append one agent tool call; returns its row id, or None when it was not recorded."""
        try:
            if caller_kind not in CALLER_KINDS:
                raise ValueError(f"unknown caller kind {caller_kind!r}")
            if outcome not in TOOL_CALL_OUTCOMES:
                raise ValueError(f"unknown outcome {outcome!r}")
            if risk not in TOOL_RISKS:
                raise ValueError(f"unknown risk {risk!r}")
            args_sha256, args_bytes = _arguments_digest(arguments)
            at = self._now_ms() if at_ms is None else _non_negative_int(at_ms)
            is_pane = caller_kind == "pane"
            caller_ws = str(caller_workspace) if is_pane else ""
            target_ws = str(target_workspace)
            row = (
                at, caller_kind,
                str(pane_id) if is_pane else "", str(pane_name) if is_pane else "",
                caller_ws, target_ws, int(bool(caller_ws) and caller_ws != target_ws),
                str(plugin_id), str(plugin_version), str(tool), risk,
                args_sha256, args_bytes, outcome, "" if outcome == "ok" else str(error_code),
                _non_negative_int(duration_ms), _non_negative_int(result_bytes),
            )
            with self.db.transaction() as cur:
                cur.execute(
                    "INSERT INTO plugin_tool_calls (at, caller_kind, pane_id, pane_name, caller_workspace,"
                    " target_workspace, cross_workspace, plugin_id, plugin_version, tool, risk, args_sha256,"
                    " args_bytes, outcome, error_code, duration_ms, result_bytes)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    row,
                )
                row_id = int(cur.lastrowid or 0)
        except Exception as err:  # noqa: BLE001 - the audit never fails the call it records
            log.warning("plugin audit: tool call not recorded: %s", err)
            return None
        self._maybe_prune(at)
        return row_id

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
    ) -> int | None:
        """Append one broker, shell or agent-tool activity row; None when it was not recorded.

        ``fs_path`` is kept relative to ``workspace`` (dropped when outside it)
        and ``shell_command`` is cut to its executable and subcommand.
        """
        try:
            if source not in ACTIVITY_SOURCES:
                raise ValueError(f"unknown source {source!r}")
            if outcome not in ACTIVITY_OUTCOMES:
                raise ValueError(f"unknown outcome {outcome!r}")
            if not isinstance(address, str) or not address:
                raise ValueError("address is required")
            if tool_call_id is not None:
                _non_negative_int(tool_call_id)
            at = self._now_ms() if at_ms is None else _non_negative_int(at_ms)
            row = (
                at, str(plugin_id), str(plugin_version), str(workspace), source, address, outcome,
                str(denied_reason) if outcome == "denied" else "",
                _relative_path(str(fs_path), str(workspace)),
                _executable_and_subcommand(str(shell_command)),
                tool_call_id,
            )
            with self.db.transaction() as cur:
                cur.execute(
                    "INSERT INTO plugin_activity (at, plugin_id, plugin_version, workspace, source, address,"
                    " outcome, denied_reason, fs_path, shell_command, tool_call_id)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    row,
                )
                row_id = int(cur.lastrowid or 0)
        except Exception as err:  # noqa: BLE001 - the audit never fails the call it records
            log.warning("plugin audit: activity not recorded: %s", err)
            return None
        self._maybe_prune(at)
        return row_id

    # ── retention ───────────────────────────────────────────────────────

    def prune(self, now_ms: int | None = None) -> None:
        """Apply the contract's retention; never raises."""
        now = self._now_ms() if now_ms is None else now_ms
        try:
            calls_cutoff = now - contract.PLUGIN_TOOL_CALLS_RETENTION_DAYS * _DAY_MS
            detail_cutoff = now - contract.PLUGIN_ACTIVITY_DETAIL_RETENTION_DAYS * _DAY_MS
            daily_cutoff = _utc_day(now - contract.PLUGIN_ACTIVITY_DAILY_RETENTION_DAYS * _DAY_MS)
            with self.db.transaction() as cur:
                cur.execute("DELETE FROM plugin_tool_calls WHERE at < ?", (calls_cutoff,))
                cur.execute(
                    "DELETE FROM plugin_tool_calls WHERE id NOT IN"
                    " (SELECT id FROM plugin_tool_calls ORDER BY id DESC LIMIT ?)",
                    (contract.PLUGIN_TOOL_CALLS_MAX_ROWS,),
                )
                expiring = cur.execute(
                    "SELECT at, plugin_id, workspace, source, address, outcome FROM plugin_activity WHERE at < ?",
                    (detail_cutoff,),
                ).fetchall()
                counts: dict[tuple[str, str, str, str, str, str], int] = {}
                for row in expiring:
                    key = (_utc_day(int(row["at"])), row["plugin_id"], row["workspace"], row["source"],
                           row["address"], row["outcome"])
                    counts[key] = counts.get(key, 0) + 1
                cur.executemany(
                    "INSERT INTO plugin_activity_daily (day, plugin_id, workspace, source, address, outcome, count)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?)"
                    " ON CONFLICT(day, plugin_id, workspace, source, address, outcome)"
                    " DO UPDATE SET count = count + excluded.count",
                    [(*key, count) for key, count in counts.items()],
                )
                cur.execute("DELETE FROM plugin_activity WHERE at < ?", (detail_cutoff,))
                cur.execute("DELETE FROM plugin_activity_daily WHERE day < ?", (daily_cutoff,))
        except Exception as err:  # noqa: BLE001 - retention must not break a write path
            log.warning("plugin audit: pruning failed: %s", err)
        self._last_prune_ms = now

    # ── reads ───────────────────────────────────────────────────────────

    def recent_tool_calls(self, *, plugin_id: str | None = None, limit: int = 100) -> list[dict[str, Any]]:
        """Newest tool calls first, each with ``caller_verified`` (see the module docstring)."""
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

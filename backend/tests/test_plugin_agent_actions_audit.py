"""B2-c: the plugin_agent_actions audit table in navide.db.

Who asked for, decided or carried out a change to a Navide plugin. Its own
schema component (contract section 5): an older navide.db gets the table at
start and nothing else changes; if it cannot be created only this record is
off and the backend still starts.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import error_ledger
from agent_team_backend.db import Database
from agent_team_backend.plugins import agent_tools_contract as contract
from agent_team_backend.plugins import audit_log
from agent_team_backend.plugins.audit_log import PluginAuditLog

DAY_MS = 86_400_000
NOW = 1_792_108_800_000  # 2026-10-16T00:00:00Z
APPROVAL = "9b1c" + "0" * 28


class Clock:
    def __init__(self, now_ms: int = NOW) -> None:
        self.now_ms = now_ms

    def __call__(self) -> float:
        return self.now_ms / 1000


def _action(audit: PluginAuditLog, **overrides: Any) -> bool:
    fields: dict[str, Any] = {
        "plugin_id": "nerdtechnic.devmap",
        "plugin_version": "0.2.0",
        "action": "disable",
        "caller_kind": "pane",
        "pane_id": "p-41",
        "pane_name": "dev",
        "caller_workspace": "/Users/me/project",
        "outcome": "allowed",
    }
    fields.update(overrides)
    return audit.record_agent_action(**fields)


def _rows(audit: PluginAuditLog) -> list[dict[str, Any]]:
    audit.flush()
    with audit.db.transaction() as cur:
        return [dict(row) for row in cur.execute("SELECT * FROM plugin_agent_actions ORDER BY id")]


def test_an_older_navide_db_gets_the_table_and_keeps_everything_else(tmp_path: Path) -> None:
    path = tmp_path / "navide.db"
    # A navide.db from before B2-c: the B1-d audit at schema version 1, with rows.
    old = PluginAuditLog(Database(path), clock=Clock())
    with old.db.transaction() as cur:
        cur.execute("DROP TABLE plugin_agent_actions")
        cur.execute("DELETE FROM schema_meta WHERE key LIKE '%plugin_agent_actions'")
    assert old.record_tool_call(
        caller_kind="pane", pane_id="p-1", pane_name="dev", caller_workspace="/w", target_workspace="/w",
        plugin_id="a.b", plugin_version="1.0.0", tool="b_read", risk="read", arguments={}, outcome="ok",
        duration_ms=1, result_bytes=2,
    ) is not None
    old.flush()
    with old.db.transaction() as cur:
        before = {
            table: [tuple(row) for row in cur.execute(f"SELECT * FROM {table} ORDER BY 1")]  # noqa: S608
            for table in ("plugin_tool_calls", "plugin_activity", "plugin_activity_daily")
        }
        assert cur.execute("SELECT name FROM sqlite_master WHERE name = 'plugin_agent_actions'").fetchone() is None
        old_version = old.db.schema_version("plugin_audit")

    reopened = PluginAuditLog(Database(path), clock=Clock())
    assert reopened.actions_enabled and reopened.enabled
    with reopened.db.transaction() as cur:
        after = {
            table: [tuple(row) for row in cur.execute(f"SELECT * FROM {table} ORDER BY 1")]  # noqa: S608
            for table in ("plugin_tool_calls", "plugin_activity", "plugin_activity_daily")
        }
        columns = [row[1] for row in cur.execute("PRAGMA table_info(plugin_agent_actions)")]
    assert after == before
    assert reopened.db.schema_version("plugin_audit") == old_version
    assert columns == [
        "id", "at", "plugin_id", "plugin_version", "action", "caller_kind", "caller_pane_id",
        "caller_pane_name", "caller_workspace", "approval_id", "outcome", "error_code",
    ]


def test_records_who_did_what_with_pane_fields_only_for_a_pane(tmp_path: Path) -> None:
    audit = PluginAuditLog(Database(tmp_path / "navide.db"), clock=Clock())
    assert _action(audit)
    assert _action(audit, caller_kind="external", pane_id="p-9", pane_name="x", caller_workspace="/x")
    assert _action(audit, action="decide-approve", caller_kind="user", approval_id=APPROVAL)
    rows = _rows(audit)
    assert [(r["action"], r["caller_kind"], r["caller_pane_id"], r["caller_pane_name"], r["caller_workspace"])
            for r in rows] == [
        ("disable", "pane", "p-41", "dev", "/Users/me/project"),
        ("disable", "external", "", "", ""),
        ("decide-approve", "user", "", "", ""),
    ]
    assert rows[2]["approval_id"] == APPROVAL and rows[0]["at"] == NOW
    assert audit.recent_agent_actions(plugin_id="nerdtechnic.devmap")[0]["action"] == "decide-approve"


def test_error_codes_are_contract_codes_and_bad_rows_are_dropped(tmp_path: Path) -> None:
    audit = PluginAuditLog(Database(tmp_path / "navide.db"), clock=Clock())
    assert _action(audit, outcome="denied", error_code="BUILTIN_PLUGIN")
    assert _action(audit, outcome="error", error_code="/Users/me/secret: boom")
    assert _action(audit, outcome="allowed", error_code="BUILTIN_PLUGIN")
    assert _action(audit, approval_id="../../etc")
    assert not _action(audit, action="drop-table")
    assert not _action(audit, caller_kind="model")
    assert not _action(audit, outcome="maybe")
    rows = _rows(audit)
    assert [r["error_code"] for r in rows] == ["BUILTIN_PLUGIN", "other", "", ""]
    assert rows[3]["approval_id"] == ""


def test_a_table_that_cannot_be_created_turns_only_this_record_off(tmp_path: Path, monkeypatch) -> None:
    recorded: list[tuple[str, ...]] = []
    monkeypatch.setattr(error_ledger, "record", lambda *args, **_: recorded.append(args))

    def broken(cur: Any) -> None:
        raise RuntimeError("disk I/O error")

    monkeypatch.setattr(audit_log, "_create_actions_schema", broken)
    audit = PluginAuditLog(Database(tmp_path / "navide.db"), clock=Clock())
    assert audit.enabled and not audit.actions_enabled
    assert "disk I/O error" in audit.status()["actions_reason"]
    assert [r[2] for r in recorded] == ["PLUGIN_AGENT_ACTIONS_AUDIT_DISABLED"]
    assert not _action(audit)
    assert audit.recent_agent_actions() == []
    # The B1-d audit still works.
    assert audit.record_tool_call(
        caller_kind="host", target_workspace="/w", plugin_id="a.b", plugin_version="1.0.0", tool="b_read",
        risk="read", arguments={}, outcome="ok", duration_ms=1, result_bytes=0,
    ) is not None
    audit.prune()


def test_retention_is_plugin_tool_calls_retention(tmp_path: Path) -> None:
    assert contract.PLUGIN_AGENT_ACTIONS_RETENTION_DAYS == contract.PLUGIN_TOOL_CALLS_RETENTION_DAYS == 30
    assert contract.PLUGIN_AGENT_ACTIONS_MAX_ROWS == contract.PLUGIN_TOOL_CALLS_MAX_ROWS == 10_000
    clock = Clock()
    audit = PluginAuditLog(Database(tmp_path / "navide.db"), clock=clock)
    assert _action(audit, at_ms=NOW - 31 * DAY_MS)
    assert _action(audit, at_ms=NOW - 29 * DAY_MS)
    audit.prune(NOW)
    assert [r["at"] for r in _rows(audit)] == [NOW - 29 * DAY_MS]
    with audit.db.transaction() as cur:
        cur.executemany(
            "INSERT INTO plugin_agent_actions (at, plugin_id, action, caller_kind, outcome) VALUES (?, ?, ?, ?, ?)",
            [(NOW, "a.b", "enable", "host", "allowed")] * 10_005,
        )
    audit.prune(NOW)
    with audit.db.transaction() as cur:
        count, top = cur.execute("SELECT COUNT(*), MAX(id) FROM plugin_agent_actions").fetchone()
    assert count == 10_000 and top == 10_007

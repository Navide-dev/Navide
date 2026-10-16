"""B1-d: the plugin_tool_calls and plugin_activity audit tables in navide.db.

The DDL and retention numbers are the contract's (agent_tools_contract.py,
docs/en-US/plugin-agent-tools-contract.md section 5). The writer is
append-only, never stores call arguments, and a failed write never reaches
the call it records.
"""

from __future__ import annotations

import hashlib
import sqlite3
from pathlib import Path
from typing import Any

import pytest

from agent_team_backend.db import Database
from agent_team_backend.plugins import agent_tools_contract as contract
from agent_team_backend.plugins.audit_log import PluginAuditLog
from agent_team_backend.plugins.disclosure_contract import canonical_contract_json

DAY_MS = 86_400_000
NOW = 1_792_108_800_000  # 2026-10-16T00:00:00Z


class Clock:
    def __init__(self, now_ms: int = NOW) -> None:
        self.now_ms = now_ms

    def __call__(self) -> float:
        return self.now_ms / 1000


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
def audit(tmp_path: Path, clock: Clock) -> PluginAuditLog:
    return PluginAuditLog(Database(tmp_path / "navide.db"), clock=clock)


def _call(audit: PluginAuditLog, **overrides: Any) -> int | None:
    fields: dict[str, Any] = {
        "caller_kind": "pane",
        "pane_id": "p-41",
        "pane_name": "dev",
        "caller_workspace": "/Users/me/project",
        "target_workspace": "/Users/me/project",
        "plugin_id": "nerdtechnic.devmap",
        "plugin_version": "0.2.0",
        "tool": "devmap_set_status",
        "risk": "write",
        "arguments": {"block_id": "b1", "status": "done"},
        "outcome": "ok",
        "duration_ms": 41,
        "result_bytes": 212,
    }
    fields.update(overrides)
    return audit.record_tool_call(**fields)


def _rows(audit: PluginAuditLog, table: str) -> list[dict[str, Any]]:
    with audit.db.transaction() as cur:
        return [dict(row) for row in cur.execute(f"SELECT * FROM {table} ORDER BY id")]  # noqa: S608


# ── schema ──────────────────────────────────────────────────────────────────


def test_the_contract_tables_exist_with_the_contract_columns(tmp_path: Path) -> None:
    db = Database(tmp_path / "navide.db")
    PluginAuditLog(db)
    reference = sqlite3.connect(":memory:")
    for statement in contract.PLUGIN_AUDIT_DDL:
        reference.execute(statement)
    with db.transaction() as cur:
        for table in ("plugin_tool_calls", "plugin_activity", "plugin_activity_daily"):
            mine = [tuple(r)[1:] for r in cur.execute(f"PRAGMA table_info({table})")]
            theirs = [tuple(r)[1:] for r in reference.execute(f"PRAGMA table_info({table})")]
            assert mine == theirs, table
        indexes = {r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type = 'index'")}
    assert {"plugin_tool_calls_at", "plugin_tool_calls_plugin_at", "plugin_activity_at", "plugin_activity_plugin_at"} <= indexes


def test_opening_twice_keeps_the_rows(tmp_path: Path, clock: Clock) -> None:
    path = tmp_path / "navide.db"
    first = PluginAuditLog(Database(path), clock=clock)
    assert _call(first) is not None
    first.db.close()
    again = PluginAuditLog(Database(path), clock=clock)
    assert len(_rows(again, "plugin_tool_calls")) == 1


# ── plugin_tool_calls ───────────────────────────────────────────────────────


def test_a_tool_call_row_stores_the_digest_and_size_of_the_arguments_never_their_content(
    audit: PluginAuditLog,
) -> None:
    secret = "do-not-store-" + "this-value"
    arguments = {"status": "done", "block_id": secret}
    row_id = _call(audit, arguments=arguments)

    [row] = _rows(audit, "plugin_tool_calls")
    canonical = canonical_contract_json(arguments).encode("utf-8")
    assert row["id"] == row_id
    assert row["args_sha256"] == hashlib.sha256(canonical).hexdigest()
    assert row["args_bytes"] == len(canonical)
    assert row["at"] == NOW
    assert (row["caller_kind"], row["pane_id"], row["pane_name"]) == ("pane", "p-41", "dev")
    assert (row["plugin_id"], row["plugin_version"], row["tool"], row["risk"]) == (
        "nerdtechnic.devmap", "0.2.0", "devmap_set_status", "write",
    )
    assert (row["outcome"], row["error_code"], row["duration_ms"], row["result_bytes"]) == ("ok", "", 41, 212)
    assert row["cross_workspace"] == 0
    dump = "\n".join(str(v) for r in _rows(audit, "plugin_tool_calls") for v in r.values())
    assert secret not in dump
    assert secret.encode() not in (audit.db.path.read_bytes())


def test_cross_workspace_is_set_when_a_pane_targets_another_workspace(audit: PluginAuditLog) -> None:
    _call(audit, target_workspace="/Users/me/other")
    assert _rows(audit, "plugin_tool_calls")[0]["cross_workspace"] == 1


@pytest.mark.parametrize("kind", ["external", "host"])
def test_a_caller_without_a_pane_is_stored_without_pane_fields(audit: PluginAuditLog, kind: str) -> None:
    _call(audit, caller_kind=kind, pane_id="p-41", pane_name="dev", caller_workspace="/x")
    [row] = _rows(audit, "plugin_tool_calls")
    assert (row["caller_kind"], row["pane_id"], row["pane_name"], row["caller_workspace"]) == (kind, "", "", "")


def test_arguments_with_fractions_are_still_digested(audit: PluginAuditLog) -> None:
    assert _call(audit, arguments={"ratio": 0.5}) is not None
    [row] = _rows(audit, "plugin_tool_calls")
    assert len(row["args_sha256"]) == 64 and row["args_bytes"] > 0


def test_reads_say_the_caller_identity_is_verified_to_the_pane_only(audit: PluginAuditLog) -> None:
    """B0 decision c: a pane caller is identified by its pane token, not by its process."""
    _call(audit)
    _call(audit, caller_kind="external")
    pane, external = audit.recent_tool_calls()[::-1]
    assert pane["caller_verified"] == "pane-token"
    assert external["caller_verified"] == "none"
    assert "arguments" not in pane


@pytest.mark.parametrize(
    "overrides",
    [
        {"caller_kind": "window"},
        {"outcome": "maybe"},
        {"risk": "admin"},
        {"duration_ms": -1},
        {"arguments": object()},
    ],
)
def test_a_bad_record_is_dropped_and_never_raises(audit: PluginAuditLog, overrides: dict[str, Any]) -> None:
    assert _call(audit, **overrides) is None
    assert _rows(audit, "plugin_tool_calls") == []


def test_a_failing_database_never_reaches_the_caller(audit: PluginAuditLog, monkeypatch: pytest.MonkeyPatch) -> None:
    def broken() -> Any:
        raise sqlite3.OperationalError("disk I/O error")

    monkeypatch.setattr(audit.db, "transaction", broken)
    assert _call(audit) is None
    assert audit.record_activity(
        plugin_id="nerdtechnic.devmap", plugin_version="0.2.0", source="broker", address="fs.readFile", outcome="allowed",
    ) is None
    audit.prune()  # does not raise either


def test_tool_calls_older_than_30_days_are_pruned_then_the_newest_10000_kept(
    audit: PluginAuditLog, clock: Clock, monkeypatch: pytest.MonkeyPatch
) -> None:
    clock.now_ms = NOW - 31 * DAY_MS
    _call(audit, tool="devmap_old")
    clock.now_ms = NOW - 29 * DAY_MS
    _call(audit, tool="devmap_recent")
    monkeypatch.setattr(contract, "PLUGIN_TOOL_CALLS_MAX_ROWS", 2)
    clock.now_ms = NOW
    _call(audit, tool="devmap_a")
    _call(audit, tool="devmap_b")

    audit.prune()

    assert [row["tool"] for row in _rows(audit, "plugin_tool_calls")] == ["devmap_a", "devmap_b"]


def test_the_retention_numbers_are_the_contracts() -> None:
    assert contract.PLUGIN_TOOL_CALLS_RETENTION_DAYS == 30
    assert contract.PLUGIN_TOOL_CALLS_MAX_ROWS == 10_000
    assert contract.PLUGIN_ACTIVITY_DETAIL_RETENTION_DAYS == 7
    assert contract.PLUGIN_ACTIVITY_DAILY_RETENTION_DAYS == 90


# ── plugin_activity ─────────────────────────────────────────────────────────


def _activity(audit: PluginAuditLog, **overrides: Any) -> int | None:
    fields: dict[str, Any] = {
        "plugin_id": "nerdtechnic.devmap",
        "plugin_version": "0.2.0",
        "workspace": "/Users/me/project",
        "source": "broker",
        "address": "fs.readFile",
        "outcome": "allowed",
    }
    fields.update(overrides)
    return audit.record_activity(**fields)


def test_an_activity_row_keeps_a_relative_path_and_only_executable_and_subcommand(audit: PluginAuditLog) -> None:
    _activity(audit, fs_path="/Users/me/project/.navide/devmap.json")
    _activity(audit, source="shell", address="shell.run", shell_command="git log --format=%H -n 5 secret-ref")
    tool_call = _call(audit)
    _activity(audit, source="agentTool", address="devmap.setStatus", tool_call_id=tool_call)
    _activity(audit, outcome="denied", denied_reason="undeclared", fs_path="/etc/passwd")

    rows = _rows(audit, "plugin_activity")
    assert rows[0]["fs_path"] == ".navide/devmap.json"
    assert rows[1]["shell_command"] == "git log"
    assert rows[2]["tool_call_id"] == tool_call and rows[2]["source"] == "agentTool"
    # Outside the workspace there is no relative path to keep.
    assert rows[3]["fs_path"] == "" and rows[3]["denied_reason"] == "undeclared"
    assert all(row["at"] == NOW for row in rows)


def test_a_relative_fs_path_is_spelled_with_forward_slashes(
    audit: PluginAuditLog, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Windows CI: os.path.relpath answers with backslashes there."""
    import ntpath

    from agent_team_backend.plugins import audit_log

    monkeypatch.setattr(audit_log, "os", type("WinOs", (), {"path": ntpath, "sep": "\\"}))
    _activity(audit, workspace="C:\\Users\\me\\project", fs_path="C:\\Users\\me\\project\\.navide\\devmap.json")
    _activity(audit, workspace="C:\\Users\\me\\project", fs_path="D:\\elsewhere\\x.json")
    assert [row["fs_path"] for row in _rows(audit, "plugin_activity")] == [".navide/devmap.json", ""]


@pytest.mark.parametrize("overrides", [{"source": "ipc"}, {"outcome": "ok"}, {"address": ""}])
def test_a_bad_activity_row_is_dropped(audit: PluginAuditLog, overrides: dict[str, Any]) -> None:
    assert _activity(audit, **overrides) is None
    assert _rows(audit, "plugin_activity") == []


def test_activity_detail_is_rolled_up_by_day_before_it_expires_after_7_days(
    audit: PluginAuditLog, clock: Clock
) -> None:
    clock.now_ms = NOW - 8 * DAY_MS
    _activity(audit)
    _activity(audit)
    _activity(audit, outcome="denied", denied_reason="undeclared")
    clock.now_ms = NOW - 6 * DAY_MS
    _activity(audit)

    clock.now_ms = NOW
    audit.prune()

    assert len(_rows(audit, "plugin_activity")) == 1
    with audit.db.transaction() as cur:
        daily = [dict(r) for r in cur.execute("SELECT * FROM plugin_activity_daily ORDER BY outcome")]
    assert daily == [
        {"day": "2026-10-08", "plugin_id": "nerdtechnic.devmap", "workspace": "/Users/me/project", "source": "broker",
         "address": "fs.readFile", "outcome": "allowed", "count": 2},
        {"day": "2026-10-08", "plugin_id": "nerdtechnic.devmap", "workspace": "/Users/me/project", "source": "broker",
         "address": "fs.readFile", "outcome": "denied", "count": 1},
    ]


def test_a_second_rollup_of_the_same_day_adds_to_its_count(audit: PluginAuditLog, clock: Clock) -> None:
    clock.now_ms = NOW - 8 * DAY_MS
    _activity(audit)
    clock.now_ms = NOW
    audit.prune()
    clock.now_ms = NOW - 8 * DAY_MS + 1000
    _activity(audit)
    clock.now_ms = NOW
    audit.prune()
    with audit.db.transaction() as cur:
        assert [r["count"] for r in cur.execute("SELECT count FROM plugin_activity_daily")] == [2]


def test_daily_rollups_older_than_90_days_are_pruned(audit: PluginAuditLog, clock: Clock) -> None:
    clock.now_ms = NOW - 91 * DAY_MS
    _activity(audit, address="fs.old")
    clock.now_ms = NOW - 89 * DAY_MS
    _activity(audit, address="fs.kept")
    clock.now_ms = NOW
    audit.prune()
    with audit.db.transaction() as cur:
        assert [r["address"] for r in cur.execute("SELECT address FROM plugin_activity_daily")] == ["fs.kept"]


def test_writes_prune_on_their_own_at_most_hourly(audit: PluginAuditLog, clock: Clock) -> None:
    clock.now_ms = NOW - 40 * DAY_MS
    _call(audit, tool="devmap_old")
    clock.now_ms = NOW + 30 * 60_000  # half an hour after the last prune: none yet
    _call(audit, tool="devmap_new")
    assert [r["tool"] for r in _rows(audit, "plugin_tool_calls")] == ["devmap_old", "devmap_new"]
    clock.now_ms = NOW + 61 * 60_000
    _call(audit, tool="devmap_newer")
    assert [r["tool"] for r in _rows(audit, "plugin_tool_calls")] == ["devmap_new", "devmap_newer"]


def test_the_backend_keeps_one_audit_log_on_the_global_navide_db() -> None:
    from agent_team_backend import app

    assert isinstance(app.plugin_audit_log, PluginAuditLog)
    assert app.plugin_audit_log.db is app.database

"""B1-d: the plugin_tool_calls and plugin_activity audit tables in navide.db.

The DDL and retention numbers are the contract's (agent_tools_contract.py,
docs/en-US/plugin-agent-tools-contract.md section 5). The writer is
append-only, never stores call arguments, and a failed write never reaches
the call it records.
"""

from __future__ import annotations

import hashlib
import sqlite3
import time
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
    audit.flush()
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
    first.flush()
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
    _call(audit)  # the id counter is read once, before the database breaks

    def broken() -> Any:
        raise sqlite3.OperationalError("disk I/O error")

    monkeypatch.setattr(audit.db, "transaction", broken)
    assert _call(audit) is not None
    assert audit.record_activity(
        plugin_id="nerdtechnic.devmap", plugin_version="0.2.0", source="broker", address="fs.readFile", outcome="allowed",
    ) is True
    audit.flush()  # the write fails: logged and dropped, not raised
    audit.prune()  # does not raise either
    assert audit.status()["pending"] == 0


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


def _activity(audit: PluginAuditLog, **overrides: Any) -> bool:
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
    assert rows[3]["fs_path"] == "<outside-workspace>" and rows[3]["denied_reason"] == "undeclared"
    assert all(row["at"] == NOW for row in rows)


def test_a_relative_fs_path_is_spelled_with_forward_slashes(audit: PluginAuditLog) -> None:
    """Windows: a workspace spelled C:\\... is handled with Windows path rules."""
    ws = "C:\\Users\\me\\project"
    _activity(audit, workspace=ws, fs_path="C:\\Users\\me\\project\\.navide\\devmap.json")
    _activity(audit, workspace=ws, fs_path="D:\\elsewhere\\x.json")
    _activity(audit, workspace=ws, fs_path="\\Users\\x")
    assert [row["fs_path"] for row in _rows(audit, "plugin_activity")] == [
        ".navide/devmap.json", "<outside-workspace>", "<outside-workspace>",
    ]


@pytest.mark.parametrize("overrides", [{"source": "ipc"}, {"outcome": "ok"}, {"address": ""}])
def test_a_bad_activity_row_is_dropped(audit: PluginAuditLog, overrides: dict[str, Any]) -> None:
    assert _activity(audit, **overrides) is False
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


def test_a_record_call_never_writes_or_prunes(audit: PluginAuditLog, monkeypatch: pytest.MonkeyPatch) -> None:
    """Review of #349: the call path only queues; one flush writes everything in one transaction."""
    _call(audit)  # reads the id counter once
    audit.flush()
    opened: list[int] = []
    real = audit.db.transaction

    def counting() -> Any:
        opened.append(1)
        return real()

    monkeypatch.setattr(audit.db, "transaction", counting)
    for _ in range(200):
        _call(audit)
        _activity(audit)
    assert opened == []
    audit.flush()
    assert opened == [1]


async def test_the_background_task_flushes_and_writes_the_queue_on_cancel(
    audit: PluginAuditLog, monkeypatch: pytest.MonkeyPatch
) -> None:
    import asyncio

    from agent_team_backend.plugins import audit_log

    monkeypatch.setattr(audit_log, "FLUSH_INTERVAL_S", 0.01)
    task = asyncio.create_task(audit.run())
    _call(audit, tool="devmap_first")
    for _ in range(200):
        if audit.status()["pending"] == 0:
            break
        await asyncio.sleep(0.01)
    assert audit.status()["pending"] == 0
    monkeypatch.setattr(audit_log, "FLUSH_INTERVAL_S", 3600)
    await asyncio.sleep(0.05)
    _call(audit, tool="devmap_last")
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    assert [r["tool"] for r in _rows(audit, "plugin_tool_calls")] == ["devmap_first", "devmap_last"]


def test_a_future_timestamp_is_clamped_to_now_and_still_expires(audit: PluginAuditLog) -> None:
    _call(audit, at_ms=NOW + 10**13)
    _activity(audit, at_ms=NOW + 10**13)
    assert _rows(audit, "plugin_tool_calls")[0]["at"] == NOW
    assert _rows(audit, "plugin_activity")[0]["at"] == NOW
    audit.prune(NOW + 31 * DAY_MS)
    assert _rows(audit, "plugin_tool_calls") == [] and _rows(audit, "plugin_activity") == []


@pytest.mark.parametrize(
    ("command", "kept"),
    [
        ("GITHUB_TOKEN=ghp_" + "x123 git push", "git push"),
        ("A=1 B=2 git log -n 3", "git log"),
        ("curl https://user:" + "s3cret@host/x", "curl"),
        ("curl -u user:" + "s3cret https://host", "curl"),
        ("mysql -p" + "Hunter2 db", "mysql"),
        ("tool --password=" + "hunter2 run", "tool"),
        ("/Users/neillu/bin/tool run", "tool run"),
        ("C:\\tools\\gh.exe pr list", "gh.exe pr"),
        ("git log --format=%H -n 5 secret-ref", "git log"),
        ("", ""),
    ],
)
def test_the_shell_summary_keeps_only_the_executable_and_a_plain_subcommand(
    audit: PluginAuditLog, command: str, kept: str
) -> None:
    _activity(audit, source="shell", address="shell.run", shell_command=command)
    assert _rows(audit, "plugin_activity")[0]["shell_command"] == kept


@pytest.mark.parametrize(
    ("fs_path", "workspace", "kept"),
    [
        ("~/.ssh/id_rsa", "/Users/me/project", "<outside-workspace>"),
        ("/Users/neillu/.ssh/id_rsa", "/", "<outside-workspace>"),
        ("/Users/neillu/.ssh/id_rsa", "/Users/me/project", "<outside-workspace>"),
        ("../../.ssh/id_rsa", "/Users/me/project", "<outside-workspace>"),
        ("src/../../x", "/Users/me/project", "<outside-workspace>"),
        ("/Users/me/project/src/a.py", "", "<outside-workspace>"),
        ("src/a.py", "/Users/me/project", "src/a.py"),
        ("/Users/me/project/src/a.py", "/Users/me/project/", "src/a.py"),
    ],
)
def test_a_path_outside_the_workspace_is_stored_as_the_marker(
    audit: PluginAuditLog, fs_path: str, workspace: str, kept: str
) -> None:
    _activity(audit, workspace=workspace, fs_path=fs_path)
    assert _rows(audit, "plugin_activity")[0]["fs_path"] == kept


def test_codes_and_addresses_are_never_free_text(audit: PluginAuditLog) -> None:
    leak = "FileNotFoundError: /Users/neillu/.ssh/id_rsa token=" + "abc"
    _call(audit, outcome="error", error_code=leak)
    _call(audit, outcome="error", error_code="PLUGIN_TOOL_TIMEOUT")
    _call(audit, outcome="error", error_code="host_timeout")
    _activity(audit, outcome="denied", denied_reason=leak)
    _activity(audit, outcome="denied", denied_reason="plugin-disabled")
    _activity(audit, address="fs.read " + leak)
    calls = _rows(audit, "plugin_tool_calls")
    activity = _rows(audit, "plugin_activity")
    assert [r["error_code"] for r in calls] == ["other", "PLUGIN_TOOL_TIMEOUT", "host_timeout"]
    assert [r["denied_reason"] for r in activity[:2]] == ["other", "plugin-disabled"]
    assert activity[2]["address"] == "other"
    assert "id_rsa" not in str(calls + activity)


def test_a_failed_table_setup_leaves_the_audit_off_and_says_why(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from agent_team_backend import error_ledger

    reported: list[tuple[Any, ...]] = []
    monkeypatch.setattr(error_ledger, "record", lambda *args, **kw: reported.append(args))
    db = Database(tmp_path / "navide.db")

    def full_disk(*_args: Any, **_kw: Any) -> bool:
        raise sqlite3.OperationalError("database or disk is full")

    monkeypatch.setattr(db, "migrate", full_disk)
    audit = PluginAuditLog(db)
    assert audit.enabled is False and "disk is full" in audit.status()["reason"]
    assert reported and reported[0][:3] == ("backend", "error", "PLUGIN_AUDIT_DISABLED")
    assert _call(audit) is None and _activity(audit) is False
    audit.flush()
    audit.prune()
    assert audit.recent_tool_calls() == []


@pytest.mark.serial
def test_pruning_500k_rows_never_holds_the_database_for_long(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Review of #349 (H1): retention runs in batches, each a short transaction."""
    import contextlib

    from agent_team_backend.plugins import audit_log

    db = Database(tmp_path / "navide.db")
    audit = PluginAuditLog(db, clock=Clock())
    old = NOW - 8 * DAY_MS
    with db.transaction() as cur:
        cur.executemany(
            "INSERT INTO plugin_activity (at, plugin_id, plugin_version, workspace, source, address, outcome)"
            " VALUES (?, 'nerdtechnic.devmap', '0.2.0', '/w', 'broker', ?, 'allowed')",
            ((old + i, f"fs.m{i % 50}") for i in range(500_000)),
        )
        cur.executemany(
            "INSERT INTO plugin_tool_calls (at, caller_kind, target_workspace, cross_workspace, plugin_id,"
            " plugin_version, tool, risk, args_sha256, args_bytes, outcome, duration_ms, result_bytes)"
            " VALUES (?, 'pane', '/w', 0, 'nerdtechnic.devmap', '0.2.0', 'devmap_read', 'read', '', 0, 'ok', 1, 1)",
            ((NOW - 31 * DAY_MS if i % 2 else NOW - DAY_MS,) for i in range(60_000)),
        )
    holds: list[float] = []
    changed: list[int] = []
    real = db.transaction

    @contextlib.contextmanager
    def timed() -> Any:
        started = time.perf_counter()
        with real() as cur:
            before = cur.connection.total_changes
            yield cur
            changed.append(cur.connection.total_changes - before)
        holds.append(time.perf_counter() - started)

    monkeypatch.setattr(db, "transaction", timed)
    audit.prune(NOW)
    monkeypatch.setattr(db, "transaction", real)

    # The guarantee: no transaction touches more than one batch of rows (a
    # rollup batch writes at most one daily row per deleted row).
    assert max(changed) <= 2 * audit_log.PRUNE_BATCH_ROWS, f"largest transaction changed {max(changed)} rows"
    # And each is short. p95 rather than max: on a loaded machine a single
    # batch of a few milliseconds can be descheduled for longer than that.
    holds.sort()
    p95 = holds[int(len(holds) * 0.95)]
    assert p95 < 0.2, f"p95 transaction {p95:.3f}s (max {holds[-1]:.3f}s) over {len(holds)}"
    assert _rows(audit, "plugin_activity") == []
    with db.transaction() as cur:
        total = cur.execute("SELECT SUM(count) FROM plugin_activity_daily").fetchone()[0]
        calls = cur.execute("SELECT COUNT(*) FROM plugin_tool_calls").fetchone()[0]
    assert total == 500_000
    assert calls == contract.PLUGIN_TOOL_CALLS_MAX_ROWS


def test_the_backend_keeps_one_audit_log_on_the_global_navide_db() -> None:
    from agent_team_backend import app

    assert isinstance(app.plugin_audit_log, PluginAuditLog)
    assert app.plugin_audit_log.db is app.database

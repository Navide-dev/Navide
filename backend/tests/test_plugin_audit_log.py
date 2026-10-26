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
        if table == "plugin_activity":
            # Broker and shell calls are counted (plugin_activity_counts); each
            # row reads as the latest call of its key and minute.
            return [
                {**dict(row), "at": row["last_at"]}
                for row in cur.execute("SELECT * FROM plugin_activity_counts ORDER BY rowid")
            ]
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
    # A refused call keeps no path at all: the plugin wrote it (final review part 2, H1).
    assert rows[2]["fs_path"] == "<denied>" and rows[2]["denied_reason"] == "undeclared"
    assert all(row["at"] == NOW for row in rows)
    # An agent tool call is still one row of its own.
    with audit.db.transaction() as cur:
        [tool_row] = cur.execute("SELECT * FROM plugin_activity").fetchall()
    assert tool_row["tool_call_id"] == tool_call and tool_row["source"] == "agentTool" and tool_row["at"] == NOW


def test_a_relative_fs_path_is_spelled_with_forward_slashes(audit: PluginAuditLog) -> None:
    """Windows: a workspace spelled C:\\... is handled with Windows path rules."""
    ws = "C:\\Users\\me\\project"
    _activity(audit, workspace=ws, fs_path="C:\\Users\\me\\project\\.navide\\devmap.json")
    _activity(audit, workspace=ws, fs_path="D:\\elsewhere\\x.json")
    _activity(audit, workspace=ws, fs_path="\\Users\\x")
    assert [(row["fs_path"], row["count"]) for row in _rows(audit, "plugin_activity")] == [
        (".navide/devmap.json", 1), ("<outside-workspace>", 2),
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


def test_backend_call_minutes_last_7_days_and_their_day_counts_90(audit: PluginAuditLog, clock: Clock) -> None:
    def record(address: str, at: int) -> None:
        audit.record_backend_calls(
            plugin_id="a.b", plugin_version="1.0.0", workspace="/w", address=address, outcome="allowed", count=2,
            at_ms=at,
        )

    record("backend.old", NOW - 91 * DAY_MS)
    record("backend.week", NOW - 8 * DAY_MS)
    record("backend.week", NOW - 8 * DAY_MS + 60_000)
    record("backend.new", NOW - 60_000)
    audit.flush()
    audit.prune()
    with audit.db.transaction() as cur:
        minutes = [r["address"] for r in cur.execute("SELECT address FROM plugin_backend_call_minutes")]
        days = {r["address"]: r["count"] for r in cur.execute("SELECT address, count FROM plugin_backend_call_days")}
    assert minutes == ["backend.new"]
    assert days == {"backend.week": 4, "backend.new": 2}
    # The report reads the day counts, so pruning the minutes loses no count.
    report = audit.backend_call_report("a.b", window_from=NOW - 30 * DAY_MS)
    assert {(m["address"], m["count"]) for m in report["methods"]} == {("backend.week", 4), ("backend.new", 2)}


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
        # Review of #349: quoting is read the way a shell reads it.
        ('PASS="correct horse battery" git push', "git push"),
        ("PASS='correct horse battery' git push", "git push"),
        ("pass=\"a b\" Token='c d' git push", "git push"),
        ("'/Users/neil lu/bin/tool' run", "tool run"),
        ('"/Users/neil lu/bin/tool" run', "tool run"),
        ("tool --password " + "hunter2", "tool"),
        ("tool --PASSWORD " + "hunter2 run", "tool"),
        ("tool -P " + "Hunter2", "tool"),
        ("tool 'run fast' x", "tool"),
        ("'C:\\Program Files\\gh\\gh.exe' pr list", "gh.exe pr"),
        ('PASS="unterminated git push', "<unparsable>"),
        ("tool 'run", "<unparsable>"),
        ("PASS=only-an-assignment", ""),
        # Re-review N2b: backslash is literal (Windows paths), so an escaped
        # space in an assignment cannot be read; it must not leak the rest.
        ("PASS=correct\\ horse git push", "<unparsable>"),
        ("A=1 PASS=correct\\ horse git push", "<unparsable>"),
        ("PASS=x\\\\ git push", "git push"),
        ("/Users/neil\\ lu/bin/tool run", "other"),
        ("C:\\tools\\gh.exe pr list", "gh.exe pr"),
        ("git log --format=%H", "git log"),
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
        # Review of #349: a file: URI is a path, and a filesystem root or a
        # missing or relative workspace makes every path "outside".
        ("file:///Users/me/.ssh/id_rsa", "/Users/me/project", "<outside-workspace>"),
        ("FILE:///Users/me/.ssh/id_rsa", "/Users/me/project", "<outside-workspace>"),
        ("file://localhost/Users/me/.ssh/id_rsa", "/Users/me/project", "<outside-workspace>"),
        ("file:/Users/me/.ssh/id_rsa", "/Users/me/project", "<outside-workspace>"),
        ("file:///Users/me/project/src/a.py", "/Users/me/project", "src/a.py"),
        ("file:///Users/me/project/src/a%20b.py", "/Users/me/project", "src/a b.py"),
        ("file:///C:/Users/me/.ssh/id_rsa", "C:\\Users\\me\\project", "<outside-workspace>"),
        ("https://user:" + "pw@host/x", "/Users/me/project", "<outside-workspace>"),
        ("etc/passwd", "/", "<outside-workspace>"),
        ("etc/passwd", "C:\\", "<outside-workspace>"),
        ("src/a.py", "", "<outside-workspace>"),
        ("src/a.py", "relative/ws", "<outside-workspace>"),
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


def _assert_prune_is_batched(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, *, activity_rows: int, call_rows: int
) -> None:
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
            ((old + i, f"fs.m{i % 50}") for i in range(activity_rows)),
        )
        # Half expired, and the other half more than the newest-rows retention.
        cur.executemany(
            "INSERT INTO plugin_tool_calls (at, caller_kind, target_workspace, cross_workspace, plugin_id,"
            " plugin_version, tool, risk, args_sha256, args_bytes, outcome, duration_ms, result_bytes)"
            " VALUES (?, 'pane', '/w', 0, 'nerdtechnic.devmap', '0.2.0', 'devmap_read', 'read', '', 0, 'ok', 1, 1)",
            ((NOW - 31 * DAY_MS if i % 2 else NOW - DAY_MS,) for i in range(call_rows)),
        )
    holds: list[float] = []
    cpu: list[float] = []
    changed: list[int] = []
    real = db.transaction

    @contextlib.contextmanager
    def timed() -> Any:
        started, started_cpu = time.perf_counter(), time.thread_time()
        with real() as cur:
            before = cur.connection.total_changes
            yield cur
            changed.append(cur.connection.total_changes - before)
        cpu.append(time.thread_time() - started_cpu)
        holds.append(time.perf_counter() - started)

    monkeypatch.setattr(db, "transaction", timed)
    audit.prune(NOW)
    monkeypatch.setattr(db, "transaction", real)

    batch = audit_log.PRUNE_BATCH_ROWS
    # The guarantee: work is split into batches, and no transaction touches
    # more than one batch of rows (a rollup batch writes at most one daily row
    # per deleted row).
    assert len(holds) >= activity_rows // batch + (call_rows - contract.PLUGIN_TOOL_CALLS_MAX_ROWS) // batch
    assert max(changed) <= 2 * batch, f"largest transaction changed {max(changed)} rows"
    # And each is short: the work done per batch (thread CPU time, ~10 ms) is
    # bounded. Wall-clock time is only reported: on a loaded runner a batch of
    # a few milliseconds can be descheduled for far longer than that.
    holds.sort()
    assert max(cpu) < 0.2, (
        f"longest batch {max(cpu):.3f}s CPU over {len(cpu)}; wall p95 {holds[int(len(holds) * 0.95)]:.3f}s"
        f" max {holds[-1]:.3f}s"
    )
    assert _rows(audit, "plugin_activity") == []
    with db.transaction() as cur:
        total = cur.execute("SELECT SUM(count) FROM plugin_activity_daily").fetchone()[0]
        calls = cur.execute("SELECT COUNT(*) FROM plugin_tool_calls").fetchone()[0]
    assert total == activity_rows
    assert calls == contract.PLUGIN_TOOL_CALLS_MAX_ROWS


@pytest.mark.serial
def test_pruning_runs_in_short_batches(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _assert_prune_is_batched(tmp_path, monkeypatch, activity_rows=50_000, call_rows=24_000)


@pytest.mark.slow
@pytest.mark.serial
def test_pruning_500k_rows_never_holds_the_database_for_long(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The review's measurement size; run with --run-slow (minutes on Windows)."""
    _assert_prune_is_batched(tmp_path, monkeypatch, activity_rows=500_000, call_rows=60_000)


def test_the_backend_keeps_one_audit_log_on_the_global_navide_db() -> None:
    from agent_team_backend import app

    assert isinstance(app.plugin_audit_log, PluginAuditLog)
    assert app.plugin_audit_log.db is app.database


# ── follow-ups to #349 (after #358) ─────────────────────────────────────────

_FIXTURES = Path(__file__).resolve().parents[2] / "docs" / "plugin-contracts" / "agent-tools-fixtures"


def test_the_arguments_digest_is_the_contracts() -> None:
    import json

    cases = json.loads((_FIXTURES / "payload-chunking.json").read_text(encoding="utf-8"))["argumentsDigest"]
    assert len(cases) >= 6
    for case in cases:
        assert contract.agent_tool_arguments_digest(case["arguments"]) == (case["sha256"], case["bytes"]), case["name"]


def test_a_stored_row_has_the_contracts_arguments_digest(audit: PluginAuditLog) -> None:
    import json

    cases = json.loads((_FIXTURES / "payload-chunking.json").read_text(encoding="utf-8"))["argumentsDigest"]
    for case in cases:
        _call(audit, arguments=case["arguments"])
    rows = _rows(audit, "plugin_tool_calls")
    assert [(r["args_sha256"], r["args_bytes"]) for r in rows] == [(c["sha256"], c["bytes"]) for c in cases]


def test_chunks_invalid_is_a_contract_error_code_kept_as_is(audit: PluginAuditLog) -> None:
    assert "PLUGIN_TOOL_CHUNKS_INVALID" in contract.AGENT_TOOL_CALL_ERROR_CODES
    _call(audit, outcome="error", error_code="PLUGIN_TOOL_CHUNKS_INVALID")
    assert _rows(audit, "plugin_tool_calls")[0]["error_code"] == "PLUGIN_TOOL_CHUNKS_INVALID"


def test_result_bytes_minus_one_means_unknown_and_other_negatives_are_refused(audit: PluginAuditLog) -> None:
    assert _call(audit, result_bytes=-1) is not None
    assert _call(audit, result_bytes=-2) is None
    assert _call(audit, result_bytes=True) is None
    assert [r["result_bytes"] for r in _rows(audit, "plugin_tool_calls")] == [-1]


def test_unknown_sizes_never_change_what_retention_rolls_up(audit: PluginAuditLog, clock: Clock) -> None:
    """Guard: nothing in the audit sums sizes; -1 rows are kept as they are."""
    _call(audit, result_bytes=-1)
    _call(audit, result_bytes=100)
    for _ in range(3):
        _activity(audit, at_ms=NOW - 8 * DAY_MS)
    audit.prune(NOW)
    assert [r["result_bytes"] for r in _rows(audit, "plugin_tool_calls")] == [-1, 100]
    with audit.db.transaction() as cur:
        assert cur.execute("SELECT SUM(count) FROM plugin_activity_daily").fetchone()[0] == 3


def test_undeclared_is_a_contract_denied_reason(audit: PluginAuditLog) -> None:
    assert "undeclared" in contract.PLUGIN_ACTIVITY_DENIED_REASONS
    _activity(audit, outcome="denied", denied_reason="undeclared")
    assert _rows(audit, "plugin_activity")[0]["denied_reason"] == "undeclared"


async def test_the_background_task_prunes_on_a_worker_thread(
    audit: PluginAuditLog, monkeypatch: pytest.MonkeyPatch
) -> None:
    import asyncio
    import threading

    from agent_team_backend.plugins import audit_log

    monkeypatch.setattr(audit_log, "FLUSH_INTERVAL_S", 0.01)
    monkeypatch.setattr(audit_log, "PRUNE_START_DELAY_S", 0.0)
    threads: list[int] = []
    real = audit.prune

    def recording(now_ms: int | None = None) -> None:
        threads.append(threading.get_ident())
        real(now_ms)

    monkeypatch.setattr(audit, "prune", recording)
    task = asyncio.create_task(audit.run())
    for _ in range(300):
        if threads:
            break
        await asyncio.sleep(0.01)
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    assert threads and threading.get_ident() not in threads


async def test_shutdown_stops_a_running_prune_before_the_final_flush(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Cancelling the task asks the prune to stop at its next batch and waits for it."""
    import asyncio

    from agent_team_backend.plugins import audit_log

    monkeypatch.setattr(audit_log, "FLUSH_INTERVAL_S", 0.01)
    monkeypatch.setattr(audit_log, "PRUNE_START_DELAY_S", 0.0)
    db = Database(tmp_path / "navide.db")
    audit = PluginAuditLog(db, clock=Clock())
    with db.transaction() as cur:
        cur.executemany(
            "INSERT INTO plugin_activity (at, plugin_id, plugin_version, workspace, source, address, outcome)"
            " VALUES (?, 'nerdtechnic.devmap', '0.2.0', '/w', 'broker', 'fs.read', 'allowed')",
            ((NOW - 8 * DAY_MS + i,) for i in range(20 * audit_log.PRUNE_BATCH_ROWS)),
        )
    batches: list[int] = []
    started = asyncio.Event()
    loop = asyncio.get_running_loop()
    real_yield = audit_log._yield_the_lock

    def slow_yield() -> None:
        batches.append(1)
        loop.call_soon_threadsafe(started.set)
        time.sleep(0.05)
        real_yield()

    monkeypatch.setattr(audit_log, "_yield_the_lock", slow_yield)
    task = asyncio.create_task(audit.run())
    await asyncio.wait_for(started.wait(), 10)
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    done = len(batches)
    await asyncio.sleep(0.3)
    assert len(batches) == done, "the prune kept running after the task ended"
    assert done < 20
    with db.transaction() as cur:
        left = cur.execute("SELECT COUNT(*) FROM plugin_activity").fetchone()[0]
        rolled = cur.execute("SELECT COALESCE(SUM(count), 0) FROM plugin_activity_daily").fetchone()[0]
    assert left + rolled == 20 * audit_log.PRUNE_BATCH_ROWS  # stopped between batches: nothing lost or doubled


@pytest.mark.parametrize(
    ("fs_path", "workspace", "kept"),
    [
        # A Windows spelling under a POSIX workspace is never "relative".
        ("C:\\Users\\me\\.ssh\\id_rsa", "/Users/me/project", "<outside-workspace>"),
        ("C:/Users/me/.ssh/id_rsa", "/Users/me/project", "<outside-workspace>"),
        ("\\\\server\\share\\x", "/Users/me/project", "<outside-workspace>"),
        # A colon in a file name is not a URI scheme.
        ("notes:1.md", "/Users/me/project", "notes:1.md"),
        ("src/a:b.txt", "/Users/me/project", "src/a:b.txt"),
        ("/Users/me/project/a:b.txt", "/Users/me/project", "a:b.txt"),
        ("https://user:" + "pw@host/x", "/Users/me/project", "<outside-workspace>"),
        ("mailto:x@y", "/Users/me/project", "mailto:x@y"),
    ],
)
def test_windows_spellings_and_colons_under_a_posix_workspace(
    audit: PluginAuditLog, fs_path: str, workspace: str, kept: str
) -> None:
    _activity(audit, workspace=workspace, fs_path=fs_path)
    assert _rows(audit, "plugin_activity")[0]["fs_path"] == kept


async def test_a_restarted_task_prunes_to_the_end_after_a_cancel(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """#365 review N1: the stop request of one run must not stop the next."""
    import asyncio

    from agent_team_backend.plugins import audit_log

    monkeypatch.setattr(audit_log, "FLUSH_INTERVAL_S", 0.01)
    monkeypatch.setattr(audit_log, "PRUNE_START_DELAY_S", 3600.0)
    db = Database(tmp_path / "navide.db")
    audit = PluginAuditLog(db, clock=Clock())
    first = asyncio.create_task(audit.run())
    await asyncio.sleep(0.05)
    first.cancel()
    await asyncio.gather(first, return_exceptions=True)

    rows = 3 * audit_log.PRUNE_BATCH_ROWS
    with db.transaction() as cur:
        cur.executemany(
            "INSERT INTO plugin_activity (at, plugin_id, plugin_version, workspace, source, address, outcome)"
            " VALUES (?, 'nerdtechnic.devmap', '0.2.0', '/w', 'broker', 'fs.read', 'allowed')",
            ((NOW - 8 * DAY_MS + i,) for i in range(rows)),
        )
    monkeypatch.setattr(audit_log, "PRUNE_START_DELAY_S", 0.0)
    second = asyncio.create_task(audit.run())
    for _ in range(500):
        with db.transaction() as cur:
            if cur.execute("SELECT COUNT(*) FROM plugin_activity").fetchone()[0] == 0:
                break
        await asyncio.sleep(0.01)
    second.cancel()
    await asyncio.gather(second, return_exceptions=True)
    with db.transaction() as cur:
        assert cur.execute("SELECT COUNT(*) FROM plugin_activity").fetchone()[0] == 0
        assert cur.execute("SELECT SUM(count) FROM plugin_activity_daily").fetchone()[0] == rows


# ── D-e: the call path never digests arguments (N2) ─────────────────────────


async def test_recording_a_10_mib_call_does_not_hold_the_event_loop(audit: PluginAuditLog) -> None:
    """The digest of large arguments is computed by flush, off the event loop."""
    import asyncio

    arguments = {"blob": "x" * (10 * 1024 * 1024)}
    late: list[float] = []

    async def ticker() -> None:
        for _ in range(20):
            started = time.perf_counter()
            await asyncio.sleep(0.005)
            late.append(time.perf_counter() - started - 0.005)

    tick = asyncio.create_task(ticker())
    await asyncio.sleep(0)
    started = time.perf_counter()
    for _ in range(5):
        assert _call(audit, arguments=arguments) is not None
    record_s = time.perf_counter() - started
    await tick
    # Digesting on the loop took 2.03 s here; 0.5 s leaves room for a loaded runner.
    assert record_s < 0.5, f"5 records of 10 MiB took {record_s:.3f}s on the loop"
    assert max(late) < 0.5, f"a 5 ms sleep came back {max(late):.3f}s late"
    await asyncio.to_thread(audit.flush)
    rows = _rows(audit, "plugin_tool_calls")
    assert [r["args_bytes"] for r in rows] == [contract.agent_tool_arguments_digest(arguments)[1]] * 5


def test_arguments_that_are_not_json_inside_are_dropped_at_flush(audit: PluginAuditLog) -> None:
    assert _call(audit, arguments={"ok": 1}) is not None
    assert _call(audit, arguments={"bad": object()}) is not None
    assert _call(audit, arguments={"ok": 2}) is not None
    assert [r["args_bytes"] for r in _rows(audit, "plugin_tool_calls")] == [
        contract.agent_tool_arguments_digest({"ok": 1})[1], contract.agent_tool_arguments_digest({"ok": 2})[1],
    ]


# ── D-e: the activity report (contract 5.1, read by D-f) ────────────────────

_PLUGIN = "nerdtechnic.devmap"
_REPORT_FIXTURES = Path(__file__).resolve().parents[2] / "docs" / "plugin-contracts" / "agent-tools-fixtures"


def _act(audit: PluginAuditLog, at_ms: int, address: str = "fs.readFile", **overrides: Any) -> None:
    fields: dict[str, Any] = {"source": "broker", "address": address, "outcome": "allowed", "at_ms": at_ms}
    fields.update(overrides)
    assert _activity(audit, **fields) is True


def test_totals_and_lists_cover_the_7_day_window_and_daily_every_day_kept(audit: PluginAuditLog) -> None:
    _act(audit, NOW - 20 * DAY_MS)  # rolled up: daily only
    for _ in range(3):
        _act(audit, NOW - 2 * DAY_MS, fs_path="/Users/me/project/src/a.py")
    _act(audit, NOW - DAY_MS, outcome="error", fs_path="src/a.py")
    _act(audit, NOW - DAY_MS, "shell.run", source="shell", shell_command='PASS="x y" /usr/bin/git push')
    _act(audit, NOW - DAY_MS, "net.fetch", outcome="denied", denied_reason="undeclared")
    audit.prune(NOW)
    report = audit.activity_report(_PLUGIN, now_ms=NOW)
    assert report["window"] == {"from": NOW - 7 * DAY_MS, "to": NOW}
    assert report["totals"] == {"calls": 6, "denied": 1, "errors": 1}
    assert report["files"] == [
        # A failed call keeps no path: the plugin wrote it (final review part 2, H1).
        {"path": "<failed>", "address": "fs.readFile", "workspace": "/Users/me/project", "outcome": "error",
         "count": 1, "lastAt": NOW - DAY_MS},
        {"path": "src/a.py", "address": "fs.readFile", "workspace": "/Users/me/project", "outcome": "allowed",
         "count": 3, "lastAt": NOW - 2 * DAY_MS},
    ]
    assert report["commands"] == [
        {"command": "git push", "workspace": "/Users/me/project", "outcome": "allowed", "count": 1, "lastAt": NOW - DAY_MS},
    ]
    assert report["daily"] == [
        {"day": "2026-09-26", "calls": 1, "denied": 0, "errors": 0},
        {"day": "2026-10-14", "calls": 3, "denied": 0, "errors": 0},
        {"day": "2026-10-15", "calls": 3, "denied": 1, "errors": 1},
    ]
    assert report["agentActions"] == [] and report["schemaVersion"] == 1  # no agent acted on it


def test_tool_calls_come_newest_first_with_unknown_sizes_as_stored(audit: PluginAuditLog, clock: Clock) -> None:
    clock.now_ms = NOW - 2 * DAY_MS
    _call(audit, result_bytes=-1)
    clock.now_ms = NOW - DAY_MS
    _call(audit, tool="devmap_read", risk="read", caller_kind="external", result_bytes=10)
    clock.now_ms = NOW - 9 * DAY_MS
    _call(audit)  # outside the window
    calls = audit.activity_report(_PLUGIN, now_ms=NOW)["toolCalls"]
    assert [(c["tool"], c["callerKind"], c["paneId"], c["resultBytes"]) for c in calls] == [
        ("devmap_read", "external", "", 10), ("devmap_set_status", "pane", "p-41", -1),
    ]
    assert calls[1]["crossWorkspace"] is False and calls[1]["argsBytes"] > 0


def test_undeclared_groups_by_address_over_30_days_with_every_reason(audit: PluginAuditLog) -> None:
    for at in (NOW - 20 * DAY_MS, NOW - 20 * DAY_MS, NOW - 2 * DAY_MS):
        _act(audit, at, "net.fetch", outcome="denied", denied_reason="undeclared")
    _act(audit, NOW - 3 * DAY_MS, "net.fetch", outcome="denied", denied_reason="plugin-disabled")
    _act(audit, NOW - DAY_MS, "fs.readFile", outcome="denied", denied_reason="plugin-disabled")  # never undeclared
    _act(audit, NOW - 40 * DAY_MS, "old.call", outcome="denied", denied_reason="undeclared")  # before the window
    audit.prune(NOW)
    report = audit.activity_report(_PLUGIN, now_ms=NOW)
    assert report["undeclaredSince"] == NOW - 30 * DAY_MS
    assert report["undeclared"] == [{
        "source": "broker", "address": "net.fetch", "workspace": "/Users/me/project", "count": 3,
        "lastAt": NOW - 2 * DAY_MS,
        "reasons": [{"reason": "undeclared", "count": 3}, {"reason": "plugin-disabled", "count": 1}],
    }]
    assert {"kind": "undeclaredDenied", "at": NOW - 2 * DAY_MS, "workspace": "/Users/me/project", "tool": None,
            "count": 1, "baseline": None} in report["anomalies"]


def test_declared_but_unused_for_each_kind(audit: PluginAuditLog, clock: Clock) -> None:
    _act(audit, NOW - DAY_MS, "fs.readFile")
    _act(audit, NOW - 40 * DAY_MS, "ui.openExternal")  # used, but 40 days ago (rolled up)
    _act(audit, NOW - DAY_MS, "shell.run", source="shell", outcome="denied", denied_reason="undeclared")
    clock.now_ms = NOW - DAY_MS
    _call(audit, tool="devmap_read", risk="read")
    audit.prune(NOW)
    declared = [
        {"kind": "system", "key": "fs"}, {"kind": "system", "key": "ui"}, {"kind": "shell", "key": "allowlist"},
        {"kind": "backendMethod", "key": "devmap.render"}, {"kind": "agentTool", "key": "devmap_read"},
        {"kind": "agentTool", "key": "devmap_set_status"},
    ]
    unused = audit.activity_report(_PLUGIN, declared=declared, now_ms=NOW)["declaredUnused"]
    assert unused == [
        {"kind": "system", "key": "ui", "lastUsedAt": _utc_day_start(NOW - 40 * DAY_MS)},
        {"kind": "shell", "key": "allowlist", "lastUsedAt": None},  # only a refused shell call
        {"kind": "backendMethod", "key": "devmap.render", "lastUsedAt": None},
        {"kind": "agentTool", "key": "devmap_set_status", "lastUsedAt": None},
    ]
    assert audit.activity_report(_PLUGIN, now_ms=NOW)["declaredUnused"] == []


def _utc_day_start(at_ms: int) -> int:
    return at_ms - at_ms % DAY_MS


def test_a_day_over_ten_times_the_7_day_baseline_is_flagged(audit: PluginAuditLog) -> None:
    for day in range(1, 8):
        _act(audit, NOW - day * DAY_MS + 1000)
    for _ in range(11):
        _act(audit, NOW)
    anomalies = audit.activity_report(_PLUGIN, now_ms=NOW + 60_000)["anomalies"]
    assert {"kind": "volumeSpike", "at": NOW, "workspace": "", "tool": None, "count": 11, "baseline": 1.0} in anomalies


@pytest.mark.parametrize("today", [10, 0])
def test_no_spike_at_ten_times_or_without_a_baseline(audit: PluginAuditLog, today: int) -> None:
    if today:
        for day in range(1, 8):
            _act(audit, NOW - day * DAY_MS + 1000)
    for _ in range(today or 50):
        _act(audit, NOW)
    kinds = [a["kind"] for a in audit.activity_report(_PLUGIN, now_ms=NOW + 60_000)["anomalies"]]
    assert "volumeSpike" not in kinds


def test_a_write_tool_first_seen_in_a_workspace_is_flagged(audit: PluginAuditLog, clock: Clock) -> None:
    clock.now_ms = NOW - 5 * DAY_MS
    _call(audit, target_workspace="/w/old", caller_workspace="/w/old")
    _call(audit, tool="devmap_read", risk="read", target_workspace="/w/new", caller_workspace="/w/new")
    clock.now_ms = NOW - 3600_000
    _call(audit, target_workspace="/w/old", caller_workspace="/w/old")
    _call(audit, target_workspace="/w/new", caller_workspace="/w/new")
    anomalies = audit.activity_report(_PLUGIN, now_ms=NOW)["anomalies"]
    assert [a for a in anomalies if a["kind"] == "writeToolNewWorkspace"] == [{
        "kind": "writeToolNewWorkspace", "at": NOW - 3600_000, "workspace": "/w/new", "tool": "devmap_set_status",
        "count": None, "baseline": None,
    }]


def test_the_report_carries_the_historical_peak_of_the_window(audit: PluginAuditLog, clock: Clock) -> None:
    _timed_call(audit, clock, NOW - DAY_MS + 1000, 1000)
    _timed_call(audit, clock, NOW - DAY_MS + 1500, 1000)
    clock.now_ms = NOW
    assert audit.activity_report(_PLUGIN, now_ms=NOW)["historicalPeakConcurrency"] == 2


def test_a_disabled_audit_reports_nothing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    db = Database(tmp_path / "navide.db")
    monkeypatch.setattr(db, "migrate", lambda *_a, **_k: (_ for _ in ()).throw(sqlite3.OperationalError("full")))
    report = PluginAuditLog(db).activity_report(_PLUGIN, now_ms=NOW)
    assert report["totals"] == {"calls": 0, "denied": 0, "errors": 0} and report["toolCalls"] == []


def _conforms(mine: Any, theirs: Any) -> bool:
    """``mine`` has the fixture's structure: the same keys, every list entry
    shaped like one of the fixture's entries, the same JSON types (null is
    accepted where the fixture has a value, as for a nullable field)."""
    if mine is None or theirs is None:
        return True
    if isinstance(theirs, dict):
        return isinstance(mine, dict) and set(mine) == set(theirs) and all(_conforms(mine[k], theirs[k]) for k in theirs)
    if isinstance(theirs, list):
        return isinstance(mine, list) and all(any(_conforms(m, t) for t in theirs) for m in mine)
    if isinstance(theirs, bool) or isinstance(mine, bool):
        return isinstance(mine, bool) and isinstance(theirs, bool)
    if isinstance(theirs, (int, float)):
        return isinstance(mine, (int, float))
    return type(mine) is type(theirs)


def _seeded_report(tmp_path: Path) -> dict[str, Any]:
    """A report with every list filled, from a seeded database (the backend fixture)."""
    clock = Clock(NOW - 2 * DAY_MS)
    audit = PluginAuditLog(Database(tmp_path / "seed.db"), clock=clock)
    _call(audit, at_ms=NOW - 2 * DAY_MS, duration_ms=1000, result_bytes=-1)
    _call(audit, at_ms=NOW - 2 * DAY_MS + 500, duration_ms=1000, tool="devmap_read", risk="read")
    clock.now_ms = NOW - 3600_000
    _call(audit, target_workspace="/Users/me/new", caller_workspace="/Users/me/new")
    clock.now_ms = NOW
    _act(audit, NOW - 2 * DAY_MS, fs_path="docs/devmap.md")
    _act(audit, NOW - 2 * DAY_MS, "shell.run", source="shell", shell_command="git status")
    _act(audit, NOW - DAY_MS, "net.fetch", outcome="denied", denied_reason="undeclared")
    clock.now_ms = NOW - DAY_MS
    audit.record_agent_action(
        plugin_id=_PLUGIN, plugin_version="0.2.0", action="disable", caller_kind="pane", outcome="allowed",
        pane_id="p-41", pane_name="dev", caller_workspace="/Users/me/project",
    )
    clock.now_ms = NOW
    for outcome, count in (("allowed", 1200), ("error", 1), ("cancelled", 2)):
        audit.record_backend_calls(
            plugin_id=_PLUGIN, plugin_version="0.2.0", workspace="/Users/me/project",
            address="backend.devmap.block.import", outcome=outcome, count=count, at_ms=NOW - DAY_MS,
        )
    audit.flush()
    return audit.activity_report(_PLUGIN, declared=[{"kind": "system", "key": "ui"}], now_ms=NOW)


def test_the_report_has_the_contract_fixtures_shape(tmp_path: Path) -> None:
    import json

    valid = json.loads((_REPORT_FIXTURES / "activity-report.json").read_text(encoding="utf-8"))["valid"]
    report = _seeded_report(tmp_path)
    assert all(isinstance(report[key], list) and report[key] for key in (
        "toolCalls", "files", "commands", "daily", "declaredUnused", "undeclared", "anomalies", "agentActions",
    )), "the seed fills every list"
    assert _conforms(report, valid)
    # The check does refuse a wrong shape.
    assert not _conforms({**report, "extra": 1}, valid)
    assert not _conforms({**report, "totals": {**report["totals"], "calls": "6"}}, valid)
    assert not _conforms({**report, "files": [{**report["files"][0], "count": True}]}, valid)


def test_the_backend_report_fixture_is_what_the_backend_builds(tmp_path: Path) -> None:
    """The TypeScript parser is held to this file (pluginActivity.test.ts)."""
    import json

    path = _REPORT_FIXTURES / "activity-report-backend.json"
    assert json.loads(path.read_text(encoding="utf-8")) == _seeded_report(tmp_path)


# ── D-e: refusal reasons by day (plugin_activity_denied_daily) ──────────────


def test_an_old_database_gets_the_denied_daily_table_and_keeps_its_rows(tmp_path: Path, clock: Clock) -> None:
    """A navide.db from before the table: opening it creates the table, nothing else changes."""
    path = tmp_path / "navide.db"
    old = PluginAuditLog(Database(path), clock=clock)
    assert _call(old) is not None
    assert _activity(old, outcome="denied", denied_reason="undeclared") is True
    old.flush()
    with old.db.transaction() as cur:
        cur.execute("DROP TABLE plugin_activity_denied_daily")  # as a database from before D-e
    old.db.close()

    again = PluginAuditLog(Database(path), clock=clock)
    assert again.enabled
    with again.db.transaction() as cur:
        cols = [r[1] for r in cur.execute("PRAGMA table_info(plugin_activity_denied_daily)")]
    assert cols == ["day", "plugin_id", "workspace", "source", "address", "denied_reason", "count"]
    assert len(_rows(again, "plugin_tool_calls")) == 1 and len(_rows(again, "plugin_activity")) == 1


def test_refusals_are_rolled_up_by_reason_and_kept_like_the_daily_counts(audit: PluginAuditLog) -> None:
    for _ in range(2):
        _activity(audit, outcome="denied", denied_reason="undeclared", at_ms=NOW - 8 * DAY_MS)
    _activity(audit, outcome="denied", denied_reason="plugin-disabled", at_ms=NOW - 8 * DAY_MS)
    _activity(audit, at_ms=NOW - 8 * DAY_MS)  # allowed: not a refusal
    _activity(audit, outcome="denied", denied_reason="undeclared", at_ms=NOW - 100 * DAY_MS)
    audit.prune(NOW)
    with audit.db.transaction() as cur:
        rows = [tuple(r) for r in cur.execute(
            "SELECT day, plugin_id, address, denied_reason, count FROM plugin_activity_denied_daily"
            " ORDER BY denied_reason"
        )]
    assert rows == [
        ("2026-10-08", "nerdtechnic.devmap", "fs.readFile", "plugin-disabled", 1),
        ("2026-10-08", "nerdtechnic.devmap", "fs.readFile", "undeclared", 2),
    ]



# ── D-e: historical peak of concurrent agent tool calls ─────────────────────


def _timed_call(audit: PluginAuditLog, clock: Clock, end_ms: int, duration_ms: int, **overrides: Any) -> None:
    clock.now_ms = end_ms
    assert _call(audit, at_ms=end_ms, duration_ms=duration_ms, **overrides) is not None


def test_the_historical_peak_counts_overlapping_calls(audit: PluginAuditLog, clock: Clock) -> None:
    base = NOW - DAY_MS
    _timed_call(audit, clock, base + 1000, 1000)   # [0, 1000]
    _timed_call(audit, clock, base + 1500, 1000)   # [500, 1500]  -> 2 at 500..1000
    _timed_call(audit, clock, base + 1800, 1000)   # [800, 1800]  -> 3 at 800..1000
    _timed_call(audit, clock, base + 5000, 100)    # alone
    _timed_call(audit, clock, base + 1700, 900, plugin_id="other.plugin")  # another plugin
    clock.now_ms = NOW
    peak = audit.historical_peak_concurrent_calls(_PLUGIN, since_ms=NOW - 2 * DAY_MS, until_ms=NOW)
    assert peak == {"historicalPeak": 3, "at": base + 800}


def test_calls_that_only_touch_end_to_start_do_not_overlap(audit: PluginAuditLog, clock: Clock) -> None:
    base = NOW - DAY_MS
    _timed_call(audit, clock, base + 1000, 1000)   # [0, 1000]
    _timed_call(audit, clock, base + 2000, 1000)   # [1000, 2000]
    clock.now_ms = NOW
    assert audit.historical_peak_concurrent_calls(_PLUGIN, since_ms=0, until_ms=NOW)["historicalPeak"] == 1


def test_the_peak_is_zero_without_calls_in_the_window(audit: PluginAuditLog, clock: Clock) -> None:
    _timed_call(audit, clock, NOW - 10 * DAY_MS, 100)
    clock.now_ms = NOW
    assert audit.historical_peak_concurrent_calls(_PLUGIN, since_ms=NOW - DAY_MS, until_ms=NOW) == {
        "historicalPeak": 0, "at": None,
    }


def test_at_is_the_end_of_the_call_and_the_peak_uses_known_starts_and_ends(audit: PluginAuditLog, clock: Clock) -> None:
    """#368 review M1: ``at`` is when the call ended (contract section 5)."""
    base = NOW - DAY_MS
    # (start, end) known: A 1000-3000, B 2500-4000, C 3500-5000 -> A+B overlap, B+C overlap, never all three.
    for start, end in ((1000, 3000), (2500, 4000), (3500, 5000)):
        _timed_call(audit, clock, base + end, end - start)
    clock.now_ms = NOW
    assert audit.historical_peak_concurrent_calls(_PLUGIN, since_ms=0, until_ms=NOW) == {
        "historicalPeak": 2, "at": base + 2500,
    }
    calls = audit.activity_report(_PLUGIN, now_ms=NOW)["toolCalls"]
    assert sorted((c["at"] - c["durationMs"], c["at"]) for c in calls) == [
        (base + 1000, base + 3000), (base + 2500, base + 4000), (base + 3500, base + 5000),
    ]


@pytest.mark.parametrize(
    ("calls", "peak"),
    [
        ([(1000, 0), (1000, 0)], 2),      # two 0 ms calls at the same instant
        ([(1000, 500), (900, 0)], 2),     # a 0 ms call inside another
    ],
)
def test_a_zero_ms_call_counts_toward_the_peak(
    audit: PluginAuditLog, clock: Clock, calls: list[tuple[int, int]], peak: int
) -> None:
    """#368 review M2: (end, duration_ms) pairs; a 0 ms call lasts at least 1 ms."""
    base = NOW - DAY_MS
    for end, duration in calls:
        _timed_call(audit, clock, base + end, duration)
    clock.now_ms = NOW
    assert audit.historical_peak_concurrent_calls(_PLUGIN, since_ms=0, until_ms=NOW)["historicalPeak"] == peak


# ── B2: agentActions from plugin_agent_actions ──────────────────────────────


def test_agent_actions_list_what_agents_did_newest_first_without_user_decisions(audit: PluginAuditLog, clock: Clock) -> None:
    clock.now_ms = NOW - 40 * DAY_MS
    assert audit.record_agent_action(plugin_id=_PLUGIN, action="disable", caller_kind="pane", outcome="allowed")
    clock.now_ms = NOW - 2 * DAY_MS
    assert audit.record_agent_action(
        plugin_id=_PLUGIN, plugin_version="0.2.0", action="request-update", caller_kind="pane", outcome="allowed",
        pane_id="p-41", pane_name="dev", caller_workspace="/Users/me/project",
    )
    clock.now_ms = NOW - DAY_MS
    assert audit.record_agent_action(plugin_id=_PLUGIN, action="decide-approve", caller_kind="user", outcome="allowed")
    assert audit.record_agent_action(plugin_id=_PLUGIN, action="enable", caller_kind="external", outcome="allowed")
    assert audit.record_agent_action(plugin_id="other.plugin", action="enable", caller_kind="host", outcome="allowed")
    audit.flush()
    assert audit.activity_report(_PLUGIN, now_ms=NOW)["agentActions"] == [
        {"at": NOW - DAY_MS, "action": "enable", "callerKind": "external", "paneId": "", "paneName": "",
         "workspace": "", "version": ""},
        {"at": NOW - 2 * DAY_MS, "action": "request-update", "callerKind": "pane", "paneId": "p-41",
         "paneName": "dev", "workspace": "/Users/me/project", "version": "0.2.0"},
    ]


# ── #368 follow-up L4: first write of a tool in a workspace (plugin_tool_first_seen) ──


def _new_workspace_flags(audit: PluginAuditLog, now: int) -> list[dict[str, Any]]:
    return [a for a in audit.activity_report(_PLUGIN, now_ms=now)["anomalies"] if a["kind"] == "writeToolNewWorkspace"]


def test_a_workspace_is_not_new_again_once_its_old_calls_are_pruned(audit: PluginAuditLog, clock: Clock) -> None:
    clock.now_ms = NOW - 40 * DAY_MS
    _call(audit, target_workspace="/w/a", caller_workspace="/w/a")
    audit.prune(NOW)  # the 40-day-old call row is gone
    assert _rows(audit, "plugin_tool_calls") == []
    clock.now_ms = NOW - 3600_000
    _call(audit, target_workspace="/w/a", caller_workspace="/w/a")
    assert _new_workspace_flags(audit, NOW) == []


def test_only_write_tools_are_remembered(audit: PluginAuditLog, clock: Clock) -> None:
    clock.now_ms = NOW - 3600_000
    _call(audit, tool="devmap_read", risk="read")
    _call(audit, tool="devmap_set_status", risk="write")
    with audit.db.transaction() as cur:
        rows = [tuple(r) for r in cur.execute("SELECT plugin_id, tool, workspace FROM plugin_tool_first_seen")]
    assert rows == []  # queued, not flushed yet
    audit.flush()
    with audit.db.transaction() as cur:
        rows = [tuple(r) for r in cur.execute(
            "SELECT plugin_id, tool, workspace, first_at FROM plugin_tool_first_seen"
        )]
    assert rows == [(_PLUGIN, "devmap_set_status", "/Users/me/project", NOW - 3600_000)]


def test_removing_a_plugin_forgets_it_so_a_reinstall_is_new_again(audit: PluginAuditLog, clock: Clock) -> None:
    clock.now_ms = NOW - 10 * DAY_MS
    _call(audit, target_workspace="/w/a", caller_workspace="/w/a")
    _call(audit, plugin_id="other.plugin", target_workspace="/w/a", caller_workspace="/w/a")
    audit.flush()
    audit.forget_plugin(_PLUGIN)
    with audit.db.transaction() as cur:
        left = [r[0] for r in cur.execute("SELECT plugin_id FROM plugin_tool_first_seen")]
    assert left == ["other.plugin"]
    clock.now_ms = NOW - 3600_000
    _call(audit, target_workspace="/w/a", caller_workspace="/w/a")
    assert [a["workspace"] for a in _new_workspace_flags(audit, NOW)] == ["/w/a"]


def test_an_old_database_gains_the_first_seen_table_and_keeps_its_rows(tmp_path: Path, clock: Clock) -> None:
    path = tmp_path / "navide.db"
    old = PluginAuditLog(Database(path), clock=clock)
    assert _call(old) is not None
    old.flush()
    with old.db.transaction() as cur:
        cur.execute("DROP TABLE plugin_tool_first_seen")  # as a database from before this table
    old.db.close()
    again = PluginAuditLog(Database(path), clock=clock)
    with again.db.transaction() as cur:
        cols = [r[1] for r in cur.execute("PRAGMA table_info(plugin_tool_first_seen)")]
    assert cols == ["plugin_id", "tool", "workspace", "first_at"]
    assert len(_rows(again, "plugin_tool_calls")) == 1


def test_a_reinstall_is_new_again_even_when_the_forget_was_lost(audit: PluginAuditLog, clock: Clock) -> None:
    """#373 review F1: the report request's installedAt, not the forget message, decides."""
    clock.now_ms = NOW - 10 * DAY_MS
    _call(audit, target_workspace="/w/a", caller_workspace="/w/a")  # the earlier install
    audit.flush()
    # Removed while the backend was away: no forget. Reinstalled 2 hours ago.
    installed_at = NOW - 2 * 3600_000
    clock.now_ms = NOW - 3600_000
    _call(audit, target_workspace="/w/a", caller_workspace="/w/a")
    flags = [a for a in audit.activity_report(_PLUGIN, installed_at=installed_at, now_ms=NOW)["anomalies"]
             if a["kind"] == "writeToolNewWorkspace"]
    assert flags == [{"kind": "writeToolNewWorkspace", "at": NOW - 3600_000, "workspace": "/w/a",
                      "tool": "devmap_set_status", "count": None, "baseline": None}]


def test_installed_at_hides_nothing_written_since_and_flags_nothing_twice(audit: PluginAuditLog, clock: Clock) -> None:
    installed_at = NOW - 3 * DAY_MS
    clock.now_ms = NOW - 2 * DAY_MS
    _call(audit, target_workspace="/w/a", caller_workspace="/w/a")  # first write since install, 2 days ago
    clock.now_ms = NOW - 3600_000
    _call(audit, target_workspace="/w/a", caller_workspace="/w/a")  # not new
    _call(audit, target_workspace="/w/b", caller_workspace="/w/b")  # new
    flags = [a["workspace"] for a in audit.activity_report(_PLUGIN, installed_at=installed_at, now_ms=NOW)["anomalies"]
             if a["kind"] == "writeToolNewWorkspace"]
    assert flags == ["/w/b"]


def test_a_future_installed_at_counts_as_now(audit: PluginAuditLog, clock: Clock) -> None:
    """#373 review N4: an install time later than now is clamped to now."""
    clock.now_ms = NOW - 10 * DAY_MS
    _call(audit, target_workspace="/w/a", caller_workspace="/w/a")
    clock.now_ms = NOW - 3600_000
    _call(audit, target_workspace="/w/b", caller_workspace="/w/b")  # before "now": not since the install
    clock.now_ms = NOW
    _call(audit, target_workspace="/w/c", caller_workspace="/w/c")  # at now: since an install clamped to now
    flags = [a["workspace"] for a in audit.activity_report(_PLUGIN, installed_at=NOW + DAY_MS, now_ms=NOW)["anomalies"]
             if a["kind"] == "writeToolNewWorkspace"]
    assert flags == ["/w/c"]


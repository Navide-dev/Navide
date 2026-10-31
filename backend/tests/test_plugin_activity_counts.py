"""Broker and shell-broker calls are counted per key and minute (final review part 2, H1).

A plugin needs no permission to make refused calls, and every address, path
or command it sends is its own free text: stored one row per call, they grew
navide.db by tens of MB and pushed the activity report past the page timeout.
Counted, with that text never a key, the same report reads a few rows.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import app, ws_handlers
from agent_team_backend.db import Database
from agent_team_backend.plugins import agent_tools_contract as contract
from agent_team_backend.plugins.audit_log import PluginAuditLog

DAY_MS = 86_400_000
NOW = 1_792_108_800_000  # 2026-10-16T00:00:00Z
PLUGIN = "nerdtechnic.devmap"
WORKSPACE = "/Users/me/project"


class Clock:
    def __init__(self, now_ms: int = NOW) -> None:
        self.now_ms = now_ms

    def __call__(self) -> float:
        return self.now_ms / 1000


def _log(path: Path) -> PluginAuditLog:
    return PluginAuditLog(Database(path), clock=Clock())


def _counts(audit: PluginAuditLog) -> list[sqlite3.Row]:
    audit.flush()
    with audit.db.transaction() as cur:
        return cur.execute("SELECT * FROM plugin_activity_counts ORDER BY rowid").fetchall()


# (at, source, address, outcome, denied_reason, stored fs_path, stored shell command)
_CALLS: list[tuple[int, str, str, str, str, str, str]] = [
    *[(NOW - 2 * DAY_MS + i * 1000, "broker", "fs.readFile", "allowed", "", "src/a.py", "") for i in range(3)],
    (NOW - DAY_MS + 5000, "broker", "fs.readFile", "allowed", "", "src/b.py", ""),
    (NOW - DAY_MS + 7000, "shell", "shell.run", "allowed", "", "", "git log"),
    (NOW - DAY_MS + 9000, "broker", "net.fetch", "denied", "undeclared", "", ""),
    (NOW - 20 * DAY_MS, "broker", "net.fetch", "denied", "undeclared", "", ""),
    (NOW - 3 * DAY_MS, "broker", "fs.readFile", "denied", "plugin-disabled", "", ""),
    (NOW - DAY_MS + 11000, "broker", "ui.openExternal", "error", "", "", ""),
    (NOW - 40 * DAY_MS, "broker", "ui.openExternal", "allowed", "", "", ""),
    # Three calls on each of the 7 days before today, then a spike today.
    *[(NOW - d * DAY_MS + 60_000, "broker", "fs.stat", "allowed", "", "", "") for d in range(1, 8) for _ in range(3)],
    *[(NOW, "broker", "fs.stat", "allowed", "", "", "") for _ in range(50)],
]


def test_the_report_is_the_same_as_from_one_row_per_call(tmp_path: Path) -> None:
    """Every report field reads the same from counted rows as from main's one row per call."""
    before = _log(tmp_path / "before.db")
    with before.db.transaction() as cur:
        cur.executemany(
            "INSERT INTO plugin_activity (at, plugin_id, plugin_version, workspace, source, address, outcome,"
            " denied_reason, fs_path, shell_command) VALUES (?, ?, '0.2.0', ?, ?, ?, ?, ?, ?, ?)",
            [(at, PLUGIN, WORKSPACE, *rest) for at, *rest in _CALLS],
        )
    after = _log(tmp_path / "after.db")
    for at, source, address, outcome, reason, path, command in _CALLS:
        assert after.record_activity(
            plugin_id=PLUGIN, plugin_version="0.2.0", workspace=WORKSPACE, source=source, address=address,
            outcome=outcome, denied_reason=reason, fs_path=path and f"{WORKSPACE}/{path}",
            shell_command=command and f"/usr/bin/{command} -n 3", at_ms=at,
        )
    declared = [{"kind": "system", "key": key} for key in ("fs", "ui", "net", "clipboard")]
    declared.append({"kind": "shell", "key": "allowlist"})
    reports = []
    for audit in (before, after):
        audit.prune(NOW)
        reports.append(audit.activity_report(PLUGIN, declared=declared, now_ms=NOW))
    assert reports[0] == reports[1]
    report = reports[1]
    assert report["totals"] == {"calls": 79, "denied": 2, "errors": 1}
    assert [a["kind"] for a in report["anomalies"]].count("volumeSpike") == 1
    assert report["undeclared"][0]["count"] == 2
    assert [(u["kind"], u["key"]) for u in report["declaredUnused"]] == [
        ("system", "ui"), ("system", "net"), ("system", "clipboard"),
    ]
    # Counted: a row per key and minute, not per call.
    assert len(_counts(after)) < len(_CALLS) // 2


def test_text_the_plugin_wrote_is_never_a_key(tmp_path: Path) -> None:
    audit = _log(tmp_path / "navide.db")
    for i in range(1000):
        audit.record_activity(
            plugin_id=PLUGIN, plugin_version="1", workspace=WORKSPACE, source="broker", address="fs.readFile",
            outcome="denied", denied_reason="undeclared", fs_path=f"/tmp/{i}/{'x' * i}", at_ms=NOW - 1000,
        )
        audit.record_activity(
            plugin_id=PLUGIN, plugin_version="1", workspace=WORKSPACE, source="broker", address="fs.readFile",
            outcome="error", fs_path=f"{WORKSPACE}/missing-{i}", at_ms=NOW - 1000,
        )
        audit.record_activity(
            plugin_id=PLUGIN, plugin_version="1", workspace=WORKSPACE, source="shell", address="shell.run",
            outcome="denied", denied_reason="undeclared", shell_command=f"tool{i} run", at_ms=NOW - 1000,
        )
        audit.record_activity(
            plugin_id=PLUGIN, plugin_version="1", workspace=WORKSPACE, source="broker",
            address=contract.PLUGIN_ACTIVITY_UNKNOWN_ADDRESS, outcome="denied", at_ms=NOW - 1000,
        )
    rows = [(r["address"], r["outcome"], r["fs_path"], r["shell_command"], r["count"]) for r in _counts(audit)]
    assert rows == [
        ("fs.readFile", "denied", "<denied>", "", 1000),
        ("fs.readFile", "error", "<failed>", "", 1000),
        ("shell.run", "denied", "", "<denied>", 1000),
        ("<unknown>", "denied", "", "", 1000),
    ]


def test_counted_rows_roll_up_by_day_once_and_a_removed_plugin_forgets_them(tmp_path: Path) -> None:
    audit = _log(tmp_path / "navide.db")
    for at in (NOW - 9 * DAY_MS, NOW - 9 * DAY_MS + 61_000, NOW - DAY_MS):
        audit.record_activity(
            plugin_id=PLUGIN, plugin_version="1", workspace=WORKSPACE, source="broker", address="net.fetch",
            outcome="denied", denied_reason="undeclared", at_ms=at, count=5,
        )
    audit.flush()
    audit.prune(NOW)
    audit.prune(NOW)  # a second prune adds nothing
    with audit.db.transaction() as cur:
        daily = cur.execute("SELECT day, count FROM plugin_activity_daily").fetchall()
        denied = cur.execute("SELECT day, denied_reason, count FROM plugin_activity_denied_daily").fetchall()
    assert [tuple(r) for r in daily] == [("2026-10-07", 10)]
    assert [tuple(r) for r in denied] == [("2026-10-07", "undeclared", 10)]
    assert [r["count"] for r in _counts(audit)] == [5]
    audit.forget_plugin(PLUGIN)
    assert _counts(audit) == []


def _session(host: bool) -> Any:
    class _Socket:
        def __init__(self) -> None:
            self.sent: list[dict[str, Any]] = []

    class _Session:
        def __init__(self) -> None:
            self.host_authenticated = host
            self.websocket = _Socket()

        async def send_json(self, message: dict[str, Any]) -> None:
            self.websocket.sent.append(message)

    return _Session()


@pytest.mark.parametrize("count", [0, -1, True, "3", 1.5])
async def test_the_host_sends_a_positive_count(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, count: Any,
) -> None:
    audit = _log(tmp_path / "navide.db")
    monkeypatch.setattr(app, "plugin_audit_log", audit)
    row = {
        "plugin_id": PLUGIN, "plugin_version": "1", "workspace": WORKSPACE, "source": "broker",
        "address": "fs.readFile", "outcome": "denied", "at": NOW - 1000,
    }
    host = _session(host=True)
    await ws_handlers.plugin_activity_record(
        host, "1", contract.PLUGIN_ACTIVITY_RECORD_MESSAGE, {"rows": [{**row, "count": count}, {**row, "count": 300}]},
    )
    assert host.websocket.sent[-1]["payload"] == {"ok": True, "accepted": 1}
    assert [r["count"] for r in _counts(audit)] == [300]


def test_the_fixed_values_are_the_hosts() -> None:
    # ACTIVITY_UNKNOWN_ADDRESS, ACTIVITY_DENIED_TARGET, ACTIVITY_FAILED_TARGET in src/main/plugins/pluginActivity.ts
    assert contract.PLUGIN_ACTIVITY_UNKNOWN_ADDRESS == "<unknown>"
    assert contract.PLUGIN_ACTIVITY_DENIED_TARGET == "<denied>"
    assert contract.PLUGIN_ACTIVITY_FAILED_TARGET == "<failed>"
    assert contract.PLUGIN_ACTIVITY_MISSING_TARGET == "<missing>"


def test_a_plugin_path_spelled_like_a_fixed_value_stays_a_path(tmp_path: Path) -> None:
    """Review of #397 (MED-1): an allowed call's own path is never read as a fixed value."""
    audit = _log(tmp_path / "navide.db")
    for marker in ("<denied>", "<failed>", "<unknown>", "<missing>"):
        for path in (f"{WORKSPACE}/{marker}", f"./{marker}"):  # as the plugin wrote it, as the Host escapes it
            audit.record_activity(
                plugin_id=PLUGIN, plugin_version="1", workspace=WORKSPACE, source="broker", address="fs.stat",
                outcome="allowed", fs_path=path, at_ms=NOW - 1000,
            )
    assert [(r["fs_path"], r["count"]) for r in _counts(audit)] == [
        ("./<denied>", 2), ("./<failed>", 2), ("./<unknown>", 2), ("./<missing>", 2),
    ]


def test_a_path_that_found_nothing_is_one_key(tmp_path: Path) -> None:
    """Review of #397 (MED-2): fs.stat answers ok for a missing path, so the Host sends <missing>."""
    audit = _log(tmp_path / "navide.db")
    for _ in range(1000):
        audit.record_activity(
            plugin_id=PLUGIN, plugin_version="1", workspace=WORKSPACE, source="broker", address="fs.stat",
            outcome="allowed", fs_path=contract.PLUGIN_ACTIVITY_MISSING_TARGET, at_ms=NOW - 1000,
        )
    assert [(r["fs_path"], r["count"]) for r in _counts(audit)] == [("<missing>", 1000)]


async def test_a_count_outside_sqlites_integers_is_skipped_and_the_batch_is_kept(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Review of #397 (LOW-1): 10**30 used to fail the flush, dropping every other plugin's rows."""
    audit = _log(tmp_path / "navide.db")
    monkeypatch.setattr(app, "plugin_audit_log", audit)
    row = {
        "plugin_id": PLUGIN, "plugin_version": "1", "workspace": WORKSPACE, "source": "broker",
        "address": "fs.readFile", "outcome": "denied", "at": NOW - 1000,
    }
    backend = {
        "plugin_id": "acme.other", "plugin_version": "1", "workspace": WORKSPACE, "source": "backend",
        "address": "backend.index", "outcome": "allowed", "count": 10**30,
    }
    host = _session(host=True)
    await ws_handlers.plugin_activity_record(host, "1", contract.PLUGIN_ACTIVITY_RECORD_MESSAGE, {"rows": [
        {**row, "count": 10**30}, {**row, "count": 2**63 - 1}, backend, {**row, "plugin_id": "acme.other", "count": 2},
    ]})
    assert host.websocket.sent[-1]["payload"] == {"ok": True, "accepted": 2}
    assert [(r["plugin_id"], r["count"]) for r in _counts(audit)] == [(PLUGIN, 2**63 - 1), ("acme.other", 2)]


def test_a_failed_call_keeps_its_text_unless_it_is_known_to_change_nothing(tmp_path: Path) -> None:
    """Review of #397: a failed call keeps its redacted text by default (it may have done something); a
    read-only one, an unknown address, or one the Host marks as answered before dispatch does not."""
    audit = _log(tmp_path / "navide.db")
    common = {"plugin_id": PLUGIN, "plugin_version": "1", "workspace": WORKSPACE, "outcome": "error", "at_ms": NOW - 1000}
    audit.record_activity(source="broker", address="fs.writeFile", fs_path=f"{WORKSPACE}/src/new.ts", **common)
    audit.record_activity(source="broker", address="fs.createFile", fs_path=f"{WORKSPACE}/src/made.ts", **common)
    audit.record_activity(source="shell", address="shell.run", shell_command="git push origin main", **common)
    audit.record_activity(source="broker", address="fs.writeFile", fs_path="<failed>", **common)  # before dispatch
    for i in range(1000):
        audit.record_activity(source="broker", address="fs.readFile", fs_path=f"{WORKSPACE}/gone/{i}", **common)
        audit.record_activity(source="broker", address="<unknown>", fs_path=f"{WORKSPACE}/x/{i}", **common)
    assert [(r["address"], r["fs_path"], r["shell_command"], r["count"]) for r in _counts(audit)] == [
        ("fs.writeFile", "src/new.ts", "", 1), ("fs.createFile", "src/made.ts", "", 1),
        ("shell.run", "", "git push", 1), ("fs.writeFile", "<failed>", "", 1),
        ("fs.readFile", "<failed>", "", 1000), ("<unknown>", "<failed>", "", 1000),
    ]
    # READ_ONLY_ADDRESSES in src/main/plugins/pluginActivity.ts
    assert contract.PLUGIN_ACTIVITY_READ_ONLY_ADDRESSES == (
        "fs.readFile", "fs.readImage", "fs.listDirectory", "fs.listFilesFlat", "fs.queryFiles", "fs.glob", "fs.stat",
        "fs.statPath", "fs.listArchive", "fs.previewResource", "fs.convertOffice",
        "fs.read_file", "fs.read_image", "fs.list_dir", "fs.list_files_flat", "fs.query_files", "fs.glob_files",
        "fs.stat_path",
        "fs.list_archive", "fs.convert_office",
    )

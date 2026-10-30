"""D-e: the Host's broker and shell-broker activity reaches the audit tables.

``plugin.activity.record`` (Host-authenticated) carries a batch of rows the
Host's capability broker recorded; ``plugins.activity.report`` answers the
activity page's read (contract 5.1). Both are write-only / read-only views of
``app.plugin_audit_log``: nothing here can fail a plugin call.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import app, ws_handlers
from agent_team_backend.db import Database
from agent_team_backend.plugins import agent_tools_contract as contract
from agent_team_backend.plugins.audit_log import PluginAuditLog


class _FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


@pytest.fixture
def audit(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> PluginAuditLog:
    log = PluginAuditLog(Database(tmp_path / "navide.db"))
    monkeypatch.setattr(app, "plugin_audit_log", log)
    return log


def _session(*, host: bool) -> Any:
    session = app.Session(_FakeWebSocket())  # type: ignore[arg-type]
    session.host_authenticated = host
    return session


def _row(**overrides: Any) -> dict[str, Any]:
    row = {
        "plugin_id": "nerdtechnic.devmap",
        "plugin_version": "0.2.0",
        "workspace": "/Users/me/project",
        "source": "broker",
        "address": "fs.readFile",
        "outcome": "allowed",
        "fs_path": "/Users/me/project/src/a.py",
    }
    row.update(overrides)
    return row


def _stored(audit: PluginAuditLog) -> list[dict[str, Any]]:
    audit.flush()
    with audit.db.transaction() as cur:
        # Broker and shell calls are counted per key and minute.
        return [dict(r) for r in cur.execute("SELECT * FROM plugin_activity_counts ORDER BY rowid")]


def test_the_wire_names_are_the_contracts() -> None:
    assert contract.PLUGIN_ACTIVITY_RECORD_MESSAGE == "plugin.activity.record"
    assert contract.PLUGIN_ACTIVITY_REPORT_MESSAGE == "plugins.activity.report"


async def test_only_the_host_can_record(audit: PluginAuditLog) -> None:
    window = _session(host=False)
    await ws_handlers.plugin_activity_record(window, "1", contract.PLUGIN_ACTIVITY_RECORD_MESSAGE, {"rows": [_row()]})
    assert window.websocket.sent[-1]["error"]["code"] == "UNAUTHORIZED"
    assert _stored(audit) == []


async def test_the_host_records_a_batch_redacted(audit: PluginAuditLog) -> None:
    host = _session(host=True)
    rows = [
        _row(),
        _row(source="shell", address="shell.run", fs_path="", shell_command='PASS="a b" /usr/bin/git push origin'),
        _row(outcome="denied", denied_reason="undeclared", address="net.fetch", fs_path="~/.ssh/id_rsa"),
    ]
    await ws_handlers.plugin_activity_record(host, "1", contract.PLUGIN_ACTIVITY_RECORD_MESSAGE, {"rows": rows})
    assert host.websocket.sent[-1]["payload"] == {"ok": True, "accepted": 3}
    stored = _stored(audit)
    # A refused call keeps no path: the plugin wrote it (final review part 2, H1).
    assert [r["fs_path"] for r in stored] == ["src/a.py", "", "<denied>"]
    assert stored[1]["shell_command"] == "git push"
    assert stored[2]["denied_reason"] == "undeclared"


@pytest.mark.parametrize(
    "bad",
    [
        {"source": "agentTool"},  # the backend's own rows (B1)
        {"source": "ipc"},
        {"outcome": "ok"},
        {"extra": "x"},
        {"plugin_version": 2},
        {"address": None},
    ],
)
async def test_a_bad_row_is_skipped_and_the_rest_are_kept(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, bad: dict[str, Any]
) -> None:
    # A fixed clock, 30 s into a minute: on the wall clock the two good rows
    # are dated one by one and can land either side of a minute boundary.
    audit = PluginAuditLog(Database(tmp_path / "navide.db"), clock=lambda: 1_792_108_830.0)
    monkeypatch.setattr(app, "plugin_audit_log", audit)
    host = _session(host=True)
    broken = _row(**bad)
    await ws_handlers.plugin_activity_record(
        host, "1", contract.PLUGIN_ACTIVITY_RECORD_MESSAGE, {"rows": [_row(), broken, "x", _row()]}
    )
    assert host.websocket.sent[-1]["payload"] == {"ok": True, "accepted": 2}
    # The two good rows share a key and minute: one row, counted twice.
    assert [r["count"] for r in _stored(audit)] == [2]


async def test_a_row_missing_a_required_field_is_skipped(audit: PluginAuditLog) -> None:
    host = _session(host=True)
    row = _row()
    del row["address"]
    await ws_handlers.plugin_activity_record(host, "1", contract.PLUGIN_ACTIVITY_RECORD_MESSAGE, {"rows": [row]})
    assert host.websocket.sent[-1]["payload"] == {"ok": True, "accepted": 0}


@pytest.mark.parametrize("payload", [{}, {"rows": "x"}, {"rows": [], "more": 1}, []])
async def test_a_malformed_batch_is_refused(audit: PluginAuditLog, payload: Any) -> None:
    host = _session(host=True)
    await ws_handlers.plugin_activity_record(host, "1", contract.PLUGIN_ACTIVITY_RECORD_MESSAGE, payload)
    assert host.websocket.sent[-1]["error"]["code"] == "BAD_REQUEST"


async def test_a_disabled_audit_accepts_nothing_and_never_fails(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    db = Database(tmp_path / "navide.db")

    def full(*_a: Any, **_k: Any) -> bool:
        raise OSError("disk full")

    monkeypatch.setattr(db, "migrate", full)
    monkeypatch.setattr(app, "plugin_audit_log", PluginAuditLog(db))
    host = _session(host=True)
    await ws_handlers.plugin_activity_record(host, "1", contract.PLUGIN_ACTIVITY_RECORD_MESSAGE, {"rows": [_row()]})
    assert host.websocket.sent[-1]["payload"] == {"ok": True, "accepted": 0}


async def test_only_the_host_can_read_a_report(audit: PluginAuditLog) -> None:
    window = _session(host=False)
    await ws_handlers.plugins_activity_report(
        window, "1", contract.PLUGIN_ACTIVITY_REPORT_MESSAGE, {"plugin_id": "nerdtechnic.devmap"}
    )
    assert window.websocket.sent[-1]["error"]["code"] == "UNAUTHORIZED"


async def test_the_host_reads_a_report_with_the_declared_items(audit: PluginAuditLog) -> None:
    host = _session(host=True)
    await ws_handlers.plugin_activity_record(host, "1", contract.PLUGIN_ACTIVITY_RECORD_MESSAGE, {"rows": [_row()]})
    await ws_handlers.plugins_activity_report(
        host, "2", contract.PLUGIN_ACTIVITY_REPORT_MESSAGE,
        {"plugin_id": "nerdtechnic.devmap", "declared": [{"kind": "system", "key": "fs"}, {"kind": "shell", "key": "allowlist"}]},
    )
    report = host.websocket.sent[-1]["payload"]
    assert report["schemaVersion"] == 1 and report["totals"]["calls"] == 1
    assert report["declaredUnused"] == [{"kind": "shell", "key": "allowlist", "lastUsedAt": None}]


async def test_without_declared_items_nothing_is_listed_unused(audit: PluginAuditLog) -> None:
    host = _session(host=True)
    await ws_handlers.plugins_activity_report(
        host, "1", contract.PLUGIN_ACTIVITY_REPORT_MESSAGE, {"plugin_id": "nerdtechnic.devmap"}
    )
    assert host.websocket.sent[-1]["payload"]["declaredUnused"] == []


@pytest.mark.parametrize(
    "payload",
    [
        {}, {"plugin_id": ""}, {"plugin_id": 3}, {"plugin_id": "a.b", "x": 1},
        {"plugin_id": "a.b", "declared": "fs"}, {"plugin_id": "a.b", "declared": ["fs"]},
        {"plugin_id": "a.b", "declared": [{"kind": "net", "key": "x"}]},
        {"plugin_id": "a.b", "declared": [{"kind": "system", "key": 1}]},
        {"plugin_id": "a.b", "declared": [{"kind": "system", "key": "fs", "extra": 1}]},
    ],
)
async def test_a_malformed_report_request_is_refused(audit: PluginAuditLog, payload: Any) -> None:
    host = _session(host=True)
    await ws_handlers.plugins_activity_report(host, "1", contract.PLUGIN_ACTIVITY_REPORT_MESSAGE, payload)
    assert host.websocket.sent[-1]["error"]["code"] == "BAD_REQUEST"


# ── calls into a plugin's own backend (source "backend", counted per minute) ─


def _backend_row(**overrides: Any) -> dict[str, Any]:
    row = {
        "plugin_id": "nerdtechnic.devmap", "plugin_version": "0.2.0", "workspace": "/Users/me/project",
        "source": "backend", "address": "backend.devmap.block.import", "outcome": "allowed", "count": 3,
    }
    row.update(overrides)
    return row


def _minutes(audit: PluginAuditLog) -> list[dict[str, Any]]:
    audit.flush()
    with audit.db.transaction() as cur:
        return [dict(r) for r in cur.execute("SELECT * FROM plugin_backend_call_minutes ORDER BY address, outcome")]


async def test_backend_calls_are_added_up_per_minute_and_count_as_use_of_the_declared_method(
    audit: PluginAuditLog,
) -> None:
    host = _session(host=True)
    rows = [
        _backend_row(), _backend_row(count=2),
        # A backend method named like a system namespace is not a use of that namespace.
        _backend_row(address="backend.fs.read", count=1),
        # Called but failing still counts as called (L4).
        _backend_row(address="backend.devmap.fail", outcome="error", count=1),
        _backend_row(address="backend.devmap.slow", outcome="cancelled", count=1),
    ]
    await ws_handlers.plugin_activity_record(host, "1", contract.PLUGIN_ACTIVITY_RECORD_MESSAGE, {"rows": rows})
    assert host.websocket.sent[-1]["payload"] == {"ok": True, "accepted": 5}
    assert _stored(audit) == []  # not in plugin_activity
    assert [(r["address"], r["outcome"], r["count"]) for r in _minutes(audit)] == [
        ("backend.devmap.block.import", "allowed", 5),
        ("backend.devmap.fail", "error", 1),
        ("backend.devmap.slow", "cancelled", 1),
        ("backend.fs.read", "allowed", 1),
    ]
    declared = [
        {"kind": "backendMethod", "key": "backend.devmap.block.import"},
        {"kind": "backendMethod", "key": "backend.devmap.fail"},
        {"kind": "backendMethod", "key": "backend.devmap.block.export"},
        {"kind": "system", "key": "fs"},
    ]
    await ws_handlers.plugins_activity_report(
        host, "2", contract.PLUGIN_ACTIVITY_REPORT_MESSAGE, {"plugin_id": "nerdtechnic.devmap", "declared": declared},
    )
    report = host.websocket.sent[-1]["payload"]
    assert [(u["kind"], u["key"]) for u in report["declaredUnused"]] == [
        ("backendMethod", "backend.devmap.block.export"), ("system", "fs"),
    ]
    # Totals, daily and spikes keep main's meaning: no backend calls in them (M3).
    assert report["totals"] == {"calls": 0, "denied": 0, "errors": 0} and report["daily"] == []
    calls = report["backendCalls"]
    assert {(m["address"], m["outcome"], m["count"]) for m in calls["methods"]} == {
        ("backend.devmap.block.import", "allowed", 5), ("backend.devmap.fail", "error", 1),
        ("backend.devmap.slow", "cancelled", 1), ("backend.fs.read", "allowed", 1),
    }
    [day] = calls["daily"]
    assert (day["calls"], day["errors"], day["cancelled"], day["denied"]) == (8, 1, 1, 0)


async def test_undeclared_backend_calls_are_one_address_and_leave_declared_unused_alone(audit: PluginAuditLog) -> None:
    # Review of #374 (H2): the Host counts every undeclared name under one address.
    host = _session(host=True)
    undeclared = contract.PLUGIN_BACKEND_CALL_UNDECLARED_ADDRESS
    assert undeclared == "backend.<undeclared>"  # BACKEND_CALL_UNDECLARED_ADDRESS in src/shared/pluginActivity.ts
    rows = [_backend_row(address=undeclared, outcome="error", count=1000), _backend_row(count=2)]
    await ws_handlers.plugin_activity_record(host, "1", contract.PLUGIN_ACTIVITY_RECORD_MESSAGE, {"rows": rows})
    assert host.websocket.sent[-1]["payload"] == {"ok": True, "accepted": 2}
    declared = [
        {"kind": "backendMethod", "key": "backend.devmap.block.import"},
        {"kind": "backendMethod", "key": "backend.devmap.block.export"},
    ]
    await ws_handlers.plugins_activity_report(
        host, "2", contract.PLUGIN_ACTIVITY_REPORT_MESSAGE, {"plugin_id": "nerdtechnic.devmap", "declared": declared},
    )
    report = host.websocket.sent[-1]["payload"]
    assert [(u["kind"], u["key"]) for u in report["declaredUnused"]] == [("backendMethod", "backend.devmap.block.export")]
    assert {(m["address"], m["outcome"], m["count"]) for m in report["backendCalls"]["methods"]} == {
        (undeclared, "error", 1000), ("backend.devmap.block.import", "allowed", 2),
    }


@pytest.mark.parametrize("row", [
    _backend_row(address="devmap.block.import"),           # backend source, no backend. prefix
    _backend_row(outcome="maybe"),
    _backend_row(count=0),
    _backend_row(count=True),
    {**_backend_row(), "extra": "x"},
    _row(source="broker", address="backend.devmap.block.import", fs_path=""),  # prefix on another source
])
async def test_a_backend_row_and_its_prefix_must_agree(audit: PluginAuditLog, row: dict[str, Any]) -> None:
    host = _session(host=True)
    await ws_handlers.plugin_activity_record(host, "1", contract.PLUGIN_ACTIVITY_RECORD_MESSAGE, {"rows": [row, _row()]})
    assert host.websocket.sent[-1]["payload"] == {"ok": True, "accepted": 1}
    assert _minutes(audit) == []


# ── #368 follow-up L3: the Host sends when the call happened ────────────────


async def test_a_row_keeps_the_hosts_time_and_a_future_one_is_clamped_to_now(audit: PluginAuditLog) -> None:
    import time

    now = int(time.time() * 1000)
    before_midnight = now - now % 86_400_000 - 1  # the last ms of yesterday (UTC)
    host = _session(host=True)
    await ws_handlers.plugin_activity_record(host, "1", contract.PLUGIN_ACTIVITY_RECORD_MESSAGE, {"rows": [
        _row(at=before_midnight), _row(at=now + 3_600_000), _row(),
    ]})
    assert host.websocket.sent[-1]["payload"] == {"ok": True, "accepted": 3}
    after = int(time.time() * 1000)
    stored = _stored(audit)
    # Yesterday's last ms stays in yesterday's last minute.
    assert (stored[0]["last_at"], stored[0]["minute"], stored[0]["count"]) == (
        before_midnight, before_midnight - before_midnight % 60_000, 1,
    )
    # A future time is clamped to now, and a row with no time is dated when it
    # arrives: both are now, counted together (unless a minute turned between).
    assert sum(r["count"] for r in stored[1:]) == 2
    assert all(now <= r["last_at"] <= after for r in stored[1:])  # never later than now


@pytest.mark.parametrize("at", ["1792108800000", True, -1, 1.5, None])
async def test_a_row_with_a_bad_time_is_skipped(audit: PluginAuditLog, at: Any) -> None:
    host = _session(host=True)
    await ws_handlers.plugin_activity_record(
        host, "1", contract.PLUGIN_ACTIVITY_RECORD_MESSAGE, {"rows": [_row(at=at), _row()]}
    )
    assert host.websocket.sent[-1]["payload"] == {"ok": True, "accepted": 1}


# ── #368 follow-up L4: a removed plugin is forgotten ────────────────────────


async def test_only_the_host_can_forget_a_plugin_and_it_forgets_that_plugin(audit: PluginAuditLog) -> None:
    calls: list[str] = []
    audit.forget_plugin = lambda plugin_id: calls.append(plugin_id)  # type: ignore[method-assign]
    window = _session(host=False)
    await ws_handlers.plugin_activity_forget(window, "1", contract.PLUGIN_ACTIVITY_FORGET_MESSAGE, {"plugin_id": "a.b"})
    assert window.websocket.sent[-1]["error"]["code"] == "UNAUTHORIZED" and calls == []
    host = _session(host=True)
    await ws_handlers.plugin_activity_forget(host, "2", contract.PLUGIN_ACTIVITY_FORGET_MESSAGE, {"plugin_id": "a.b"})
    assert host.websocket.sent[-1]["payload"] == {"ok": True} and calls == ["a.b"]


@pytest.mark.parametrize("payload", [{}, {"plugin_id": ""}, {"plugin_id": 1}, {"plugin_id": "a.b", "x": 1}, []])
async def test_a_malformed_forget_is_refused(audit: PluginAuditLog, payload: Any) -> None:
    host = _session(host=True)
    await ws_handlers.plugin_activity_forget(host, "1", contract.PLUGIN_ACTIVITY_FORGET_MESSAGE, payload)
    assert host.websocket.sent[-1]["error"]["code"] == "BAD_REQUEST"


async def test_the_report_request_carries_the_install_time(audit: PluginAuditLog) -> None:
    seen: list[Any] = []
    real = audit.activity_report
    audit.activity_report = lambda plugin_id, **kw: (seen.append(kw), real(plugin_id, **kw))[1]  # type: ignore[method-assign]
    host = _session(host=True)
    await ws_handlers.plugins_activity_report(
        host, "1", contract.PLUGIN_ACTIVITY_REPORT_MESSAGE, {"plugin_id": "a.b", "installedAt": 1_792_000_000_000}
    )
    assert host.websocket.sent[-1]["payload"]["schemaVersion"] == 1
    assert seen == [{"declared": [], "installed_at": 1_792_000_000_000}]


@pytest.mark.parametrize("installed_at", ["1", True, -1, 1.5])
async def test_a_bad_install_time_is_refused(audit: PluginAuditLog, installed_at: Any) -> None:
    host = _session(host=True)
    await ws_handlers.plugins_activity_report(
        host, "1", contract.PLUGIN_ACTIVITY_REPORT_MESSAGE, {"plugin_id": "a.b", "installedAt": installed_at}
    )
    assert host.websocket.sent[-1]["error"]["code"] == "BAD_REQUEST"


async def test_skipped_rows_are_logged_by_count_and_reason_without_their_content(
    audit: PluginAuditLog, caplog: pytest.LogCaptureFixture
) -> None:
    """#373 review F3."""
    import logging

    host = _session(host=True)
    secret = "/Users/me/.ssh/id_rsa"
    with caplog.at_level(logging.WARNING):
        await ws_handlers.plugin_activity_record(host, "1", contract.PLUGIN_ACTIVITY_RECORD_MESSAGE, {"rows": [
            _row(), _row(source="agentTool", fs_path=secret), _row(at=-1), "x", _row(outcome="ok"),
        ]})
    assert host.websocket.sent[-1]["payload"] == {"ok": True, "accepted": 1}
    messages = [r.getMessage() for r in caplog.records if "plugin activity" in r.getMessage()]
    assert messages == ["plugin activity: 4 of 5 rows skipped (malformed: 2, bad at: 1, refused: 1)"]
    assert secret not in caplog.text


async def test_backend_calls_fall_in_the_minute_the_host_names(audit: PluginAuditLog) -> None:
    import time

    now = int(time.time() * 1000)
    minute = now - now % 60_000 - 3 * 60_000
    host = _session(host=True)
    await ws_handlers.plugin_activity_record(host, "1", contract.PLUGIN_ACTIVITY_RECORD_MESSAGE, {"rows": [
        {**_backend_row(), "at": minute}, {**_backend_row(count=4), "at": minute + 59_000},
        {**_backend_row(), "at": now + 3_600_000},  # a future time is clamped to now
    ]})
    assert host.websocket.sent[-1]["payload"] == {"ok": True, "accepted": 3}
    audit.flush()
    with audit.db.transaction() as cur:
        rows = cur.execute("SELECT minute, count FROM plugin_backend_call_minutes ORDER BY minute").fetchall()
    assert rows[0][0] == minute and rows[0][1] == 7
    assert rows[1][0] <= now


async def test_bad_backend_rows_are_counted_by_reason(audit: PluginAuditLog, caplog: pytest.LogCaptureFixture) -> None:
    import logging

    host = _session(host=True)
    with caplog.at_level(logging.WARNING):
        await ws_handlers.plugin_activity_record(host, "1", contract.PLUGIN_ACTIVITY_RECORD_MESSAGE, {"rows": [
            _backend_row(), _backend_row(address="devmap.x"), {**_backend_row(), "at": -1}, _backend_row(outcome="maybe"),
        ]})
    assert host.websocket.sent[-1]["payload"] == {"ok": True, "accepted": 1}
    messages = [r.getMessage() for r in caplog.records if "plugin activity" in r.getMessage()]
    assert messages == ["plugin activity: 3 of 4 rows skipped (malformed: 1, bad at: 1, refused: 1)"]


async def test_forgetting_a_plugin_drops_its_backend_call_counts(audit: PluginAuditLog) -> None:
    host = _session(host=True)
    await ws_handlers.plugin_activity_record(host, "1", contract.PLUGIN_ACTIVITY_RECORD_MESSAGE, {"rows": [
        _backend_row(), _backend_row(plugin_id="acme.other"),
    ]})
    audit.flush()
    audit.forget_plugin("nerdtechnic.devmap")
    assert [r["plugin_id"] for r in _minutes(audit)] == ["acme.other"]
    with audit.db.transaction() as cur:
        assert [r["plugin_id"] for r in cur.execute("SELECT plugin_id FROM plugin_backend_call_days")] == ["acme.other"]


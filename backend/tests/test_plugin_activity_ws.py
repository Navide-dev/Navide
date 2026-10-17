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
        return [dict(r) for r in cur.execute("SELECT * FROM plugin_activity ORDER BY id")]


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
    assert [r["fs_path"] for r in stored] == ["src/a.py", "", "<outside-workspace>"]
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
async def test_a_bad_row_is_skipped_and_the_rest_are_kept(audit: PluginAuditLog, bad: dict[str, Any]) -> None:
    host = _session(host=True)
    broken = _row(**bad)
    await ws_handlers.plugin_activity_record(
        host, "1", contract.PLUGIN_ACTIVITY_RECORD_MESSAGE, {"rows": [_row(), broken, "x", _row()]}
    )
    assert host.websocket.sent[-1]["payload"] == {"ok": True, "accepted": 2}
    assert len(_stored(audit)) == 2


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
    stored = [r["at"] for r in _stored(audit)]
    assert stored[0] == before_midnight
    assert now <= stored[1] <= after  # never later than now
    assert now <= stored[2] <= after  # no time sent: when it arrived


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

"""Card K4: the Developer Mode switch is audited in the plugin activity log.

The Host files each change as one ``host`` row under its own event identity
``host``, which no Navide plugin can hold. Only the Host session may send it,
only in exactly that shape, and it never counts toward a plugin's report.
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


def _host_row(**overrides: Any) -> dict[str, Any]:
    row: dict[str, Any] = {
        "plugin_id": "host",
        "plugin_version": "0.2.26",
        "workspace": "",
        "source": "host",
        "address": "developerMode.on",
        "outcome": "allowed",
        "count": 1,
        "at": 1_700_000_000_000,
    }
    row.update(overrides)
    return row


def _stored(audit: PluginAuditLog) -> list[dict[str, Any]]:
    audit.flush()
    with audit.db.transaction() as cur:
        return [dict(r) for r in cur.execute("SELECT * FROM plugin_activity_counts ORDER BY rowid")]


async def _record(session: Any, rows: list[Any]) -> None:
    await ws_handlers.plugin_activity_record(session, "1", contract.PLUGIN_ACTIVITY_RECORD_MESSAGE, {"rows": rows})


async def test_the_host_records_each_switch_change(audit: PluginAuditLog) -> None:
    host = _session(host=True)
    await _record(host, [_host_row(), _host_row(address="developerMode.off", at=1_700_000_060_000)])
    assert host.websocket.sent[-1]["payload"]["accepted"] == 2
    stored = _stored(audit)
    assert [(r["plugin_id"], r["source"], r["address"], r["outcome"]) for r in stored] == [
        ("host", "host", "developerMode.on", "allowed"),
        ("host", "host", "developerMode.off", "allowed"),
    ]


async def test_a_window_session_cannot_write_a_host_row(audit: PluginAuditLog) -> None:
    window = _session(host=False)
    await _record(window, [_host_row()])
    assert window.websocket.sent[-1]["error"]["code"] == "UNAUTHORIZED"
    assert _stored(audit) == []


@pytest.mark.parametrize(
    "forged",
    [
        _host_row(plugin_id="acme.demo"),
        _host_row(workspace="/Users/me/project"),
        _host_row(address="developerMode.set"),
        _host_row(address="fs.readFile"),
        _host_row(outcome="denied"),
        _host_row(count=2),
        _host_row(count=True),
        _host_row(fs_path="/etc/passwd"),
        {key: value for key, value in _host_row().items() if key != "count"},
        _host_row(plugin_version=1),
        _host_row(at=-1),
    ],
)
async def test_anything_but_the_exact_host_event_shape_is_skipped(audit: PluginAuditLog, forged: dict[str, Any]) -> None:
    host = _session(host=True)
    await _record(host, [forged])
    assert host.websocket.sent[-1]["payload"]["accepted"] == 0
    assert _stored(audit) == []


async def test_a_plugin_row_cannot_claim_the_host_source_under_its_own_id(audit: PluginAuditLog) -> None:
    host = _session(host=True)
    broker_shaped = {
        "plugin_id": "acme.demo", "plugin_version": "1.0.0", "workspace": "/w", "source": "host",
        "address": "developerMode.on", "outcome": "allowed",
    }
    await _record(host, [broker_shaped])
    assert host.websocket.sent[-1]["payload"]["accepted"] == 0
    assert _stored(audit) == []


async def test_a_host_row_never_counts_toward_a_plugins_report(audit: PluginAuditLog) -> None:
    host = _session(host=True)
    plugin_row = {
        "plugin_id": "acme.demo", "plugin_version": "1.0.0", "workspace": "/w", "source": "broker",
        "address": "fs.readFile", "outcome": "allowed", "fs_path": "/w/a.txt",
    }
    await _record(host, [_host_row(), plugin_row])
    audit.flush()
    report = audit.activity_report("acme.demo")
    assert report["totals"]["calls"] == 1
    assert "developerMode" not in repr(report)

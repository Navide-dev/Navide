"""``plugins.activity.overview``: every plugin on one table (plan P1, plugin-comms-security).

The Settings monitor reads one row per installed plugin: agent tool calls and
capability calls in the last minute, the trailing run of failed tool calls,
and the hosts its views reached. It is a read of the audit tables, sized by
the plugins asked about and the last minute, never by the 7-day detail.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import app, ws_handlers
from agent_team_backend.db import Database
from agent_team_backend.plugins import agent_tools_contract as contract
from agent_team_backend.plugins.audit_log import PluginAuditLog

DAY_MS = 86_400_000
# 2026-10-16T00:00:30Z, 30 s into a minute.
NOW = 1_792_108_830_000
WS = "/Users/me/project"


class _FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


@pytest.fixture
def audit(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> PluginAuditLog:
    log = PluginAuditLog(Database(tmp_path / "navide.db"), clock=lambda: NOW / 1000)
    monkeypatch.setattr(app, "plugin_audit_log", log)
    return log


def _session(*, host: bool) -> Any:
    session = app.Session(_FakeWebSocket())  # type: ignore[arg-type]
    session.host_authenticated = host
    return session


def _tool(audit: PluginAuditLog, plugin: str, outcome: str, at: int) -> None:
    audit.record_tool_call(
        caller_kind="pane", target_workspace=WS, plugin_id=plugin, plugin_version="1.0.0",
        tool="t", risk="read", arguments={}, outcome=outcome, duration_ms=5, result_bytes=1,
        pane_id="p", pane_name="p", caller_workspace=WS,
        error_code="" if outcome == "ok" else "PLUGIN_ERROR", at_ms=at,
    )


def _activity(audit: PluginAuditLog, plugin: str, at: int, *, source: str = "broker", address: str = "fs.readFile",
              outcome: str = "allowed", reason: str = "") -> None:
    assert audit.record_activity(
        plugin_id=plugin, plugin_version="1.0.0", workspace=WS, source=source, address=address,
        outcome=outcome, denied_reason=reason, at_ms=at,
    )


def test_one_row_per_plugin_asked_about(audit: PluginAuditLog) -> None:
    # a: three tool calls this minute (the last two failed), one older ok call.
    _tool(audit, "acme.a", "ok", NOW - 10 * 60_000)
    _tool(audit, "acme.a", "ok", NOW - 20_000)
    _tool(audit, "acme.a", "error", NOW - 10_000)
    _tool(audit, "acme.a", "error", NOW - 5_000)
    # a: capability calls: two this minute, one 3 minutes ago, network rows apart.
    _activity(audit, "acme.a", NOW - 1_000)
    _activity(audit, "acme.a", NOW - 2_000, source="shell", address="shell.run")
    _activity(audit, "acme.a", NOW - 3 * 60_000)
    _activity(audit, "acme.a", NOW - DAY_MS, source="network", address="network.api.acme.dev")
    _activity(audit, "acme.a", NOW - 2 * DAY_MS, source="network", address="network.evil.io",
              outcome="denied", reason="undeclared")
    _activity(audit, "acme.a", NOW - 9 * DAY_MS, source="network", address="network.old.io")
    # b: someone else's rows, not asked about.
    _tool(audit, "acme.b", "ok", NOW - 1_000)

    overview = audit.activity_overview(["acme.a", "acme.c"])
    assert overview["schemaVersion"] == 1 and overview["generatedAt"] == NOW
    a, c = overview["plugins"]
    assert a == {
        "pluginId": "acme.a",
        "toolCallsLastMinute": 3,
        "capabilityCallsLastMinute": 2,
        "consecutiveFailures": 2,
        # Last 7 days, newest first; a refused host says so.
        "hosts": [
            {"host": "api.acme.dev", "refused": False, "lastAt": NOW - DAY_MS},
            {"host": "evil.io", "refused": True, "lastAt": NOW - 2 * DAY_MS},
        ],
    }
    assert c == {
        "pluginId": "acme.c", "toolCallsLastMinute": 0, "capabilityCallsLastMinute": 0,
        "consecutiveFailures": 0, "hosts": [],
    }


def test_an_ok_call_ends_the_failure_run(audit: PluginAuditLog) -> None:
    for at, outcome in [(NOW - 4_000, "error"), (NOW - 3_000, "ok"), (NOW - 2_000, "error")]:
        _tool(audit, "acme.a", outcome, at)
    assert audit.activity_overview(["acme.a"])["plugins"][0]["consecutiveFailures"] == 1


async def test_only_the_host_reads_the_overview(audit: PluginAuditLog) -> None:
    window = _session(host=False)
    await ws_handlers.plugins_activity_overview(
        window, "1", contract.PLUGIN_ACTIVITY_OVERVIEW_MESSAGE, {"plugin_ids": ["acme.a"]}
    )
    assert window.websocket.sent[-1]["error"]["code"] == "UNAUTHORIZED"


@pytest.mark.parametrize(
    "payload",
    [{}, {"plugin_ids": "acme.a"}, {"plugin_ids": [1]}, {"plugin_ids": [""]}, {"plugin_ids": [], "x": 1}],
)
async def test_a_malformed_request_is_refused(audit: PluginAuditLog, payload: dict[str, Any]) -> None:
    host = _session(host=True)
    await ws_handlers.plugins_activity_overview(host, "1", contract.PLUGIN_ACTIVITY_OVERVIEW_MESSAGE, payload)
    assert host.websocket.sent[-1]["error"]["code"] == "BAD_REQUEST"


async def test_the_host_reads_the_overview(audit: PluginAuditLog) -> None:
    _tool(audit, "acme.a", "ok", NOW - 1_000)
    host = _session(host=True)
    await ws_handlers.plugins_activity_overview(
        host, "1", contract.PLUGIN_ACTIVITY_OVERVIEW_MESSAGE, {"plugin_ids": ["acme.a"]}
    )
    payload = host.websocket.sent[-1]["payload"]
    assert [row["toolCallsLastMinute"] for row in payload["plugins"]] == [1]
    assert contract.PLUGIN_ACTIVITY_OVERVIEW_MESSAGE == "plugins.activity.overview"

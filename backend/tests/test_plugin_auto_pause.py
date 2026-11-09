"""Automatic pauses (plan P5): recorded in Activity and told to the bound chats."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import app, ws_handlers
from agent_team_backend.channels import quick_menu as qm
from agent_team_backend.db import Database
from agent_team_backend.plugins import agent_tools_contract as contract
from agent_team_backend.plugins.audit_log import PluginAuditLog

NOW = 1_792_108_830_000


class _FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


def _session(*, host: bool) -> Any:
    session = app.Session(_FakeWebSocket())  # type: ignore[arg-type]
    session.host_authenticated = host
    return session


@pytest.fixture
def audit(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> PluginAuditLog:
    log = PluginAuditLog(Database(tmp_path / "navide.db"), clock=lambda: NOW / 1000)
    monkeypatch.setattr(app, "plugin_audit_log", log)
    return log


def test_each_pause_is_kept_with_its_rule_numbers_and_time_and_shown_in_the_report(audit: PluginAuditLog) -> None:
    assert audit.record_auto_pause(plugin_id="acme.a", plugin_version="1.0.0", rule="R1", value=61, threshold=60, detail="tools")
    assert audit.record_auto_pause(plugin_id="acme.a", plugin_version="1.0.0", rule="R2", value=1, threshold=0, detail="evil.io")
    assert not audit.record_auto_pause(plugin_id="acme.a", plugin_version="1.0.0", rule="R9", value=1, threshold=0, detail="")
    report = audit.activity_report("acme.a")
    assert report["autoPauses"] == [
        {"at": NOW, "rule": "R2", "value": 1, "threshold": 0, "detail": "evil.io", "pluginVersion": "1.0.0"},
        {"at": NOW, "rule": "R1", "value": 61, "threshold": 60, "detail": "tools", "pluginVersion": "1.0.0"},
    ]
    assert audit.activity_report("acme.b")["autoPauses"] == []
    audit.forget_plugin("acme.a")
    assert audit.activity_report("acme.a")["autoPauses"] == []


async def test_the_host_reports_a_pause_which_is_recorded_and_sent_to_the_chats(
    audit: PluginAuditLog, monkeypatch: pytest.MonkeyPatch,
) -> None:
    told: list[tuple[str, str]] = []

    async def notify(plugin_id: str, rule: str) -> None:
        told.append((plugin_id, rule))

    from agent_team_backend.channels import plugin_cmds

    monkeypatch.setattr(plugin_cmds, "notify_auto_paused", notify)
    payload = {"plugin_id": "acme.a", "plugin_version": "1.0.0", "rule": "R3", "value": 10, "threshold": 10, "detail": "failures"}
    window = _session(host=False)
    await ws_handlers.plugins_auto_paused(window, "1", contract.PLUGIN_AUTO_PAUSED_MESSAGE, payload)
    assert window.websocket.sent[-1]["error"]["code"] == "UNAUTHORIZED"
    host = _session(host=True)
    await ws_handlers.plugins_auto_paused(host, "2", contract.PLUGIN_AUTO_PAUSED_MESSAGE, {**payload, "rule": "R0"})
    assert host.websocket.sent[-1]["error"]["code"] == "BAD_REQUEST"
    await ws_handlers.plugins_auto_paused(host, "3", contract.PLUGIN_AUTO_PAUSED_MESSAGE, payload)
    assert host.websocket.sent[-1]["payload"] == {"ok": True}
    assert told == [("acme.a", "R3")]
    assert [row["rule"] for row in audit.activity_report("acme.a")["autoPauses"]] == ["R3"]


def test_every_language_says_why_a_plugin_was_paused() -> None:
    for lang, strings in qm.STRINGS.items():
        assert "{id}" in strings["plugins_auto_paused"], lang
        for rule in ("R1", "R2", "R3", "R4", "R5"):
            assert strings[f"plugins_rule_{rule}"], (lang, rule)

"""Settings → CLI Agents → "ACP (experimental)" (acp_switch), both ways.

Off (the default) must be main's behaviour exactly; on adds the claude-acp
launch, its adapter's install entry and the ACP paragraphs of four MCP tool
descriptions — and turning it off takes each back out. The turn tests run a
fake adapter (tests/fake_acp_agent.py, started at run time; no real agent and
no key) through the real switch, the real launch table and acp_ws.

Known limitations of this first segment, recorded here so a test says so:
- Permission requests always go to the user (the pane's buttons in the main
  window); Navide Guard does not see them (0.2.42).
- session/new hands the agent no MCP servers (``mcpServers: []``), so an ACP
  pane cannot call Navide's tools yet (0.2.42).
- Whether Claude Code under the real claude-acp adapter runs the user's hooks
  (Navide Guard's included) is not established: the fake adapter cannot show
  it. The 0.102.0 package passes settingSources ["user", "project", "local"]
  to the SDK, which suggests it does; unverified.
- Windows has never run a real adapter (npm's .cmd shim, non-ASCII user paths).
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import acp_client, acp_mcp, acp_switch, acp_vendors, acp_ws, onboarding_deps, pty_registry
from agent_team_backend.acp_vendors import AcpLaunch
from agent_team_backend.cli_vendors.base import Dep

FAKE_AGENT = Path(__file__).with_name("fake_acp_agent.py")
MCP_BASELINE = Path(__file__).parent / "data" / "mcp_core_tools_main.json"


def _main_description(name: str) -> str:
    [main] = [t for t in json.loads(MCP_BASELINE.read_text(encoding="utf-8")) if t["name"] == name]
    return main["description"]


def _description(name: str) -> str:
    from agent_team_backend.mcp_server import server as mcp

    return mcp.server._tool_manager.get_tool(name).description  # noqa: SLF001


@pytest.fixture(autouse=True)
def _switch_off_after() -> Any:
    yield
    acp_switch.apply(False)


def test_off_is_mains_behaviour() -> None:
    acp_switch.apply(False)
    assert acp_vendors.ACP_LAUNCHES == {}
    assert acp_vendors.acp_launch("claude") is None
    assert "claude-acp" not in onboarding_deps.DEPS_BY_ID
    assert all(dep.id != "claude-acp" for dep in onboarding_deps.applicable_deps())
    for name in acp_mcp.TOOL_NOTES:
        assert _description(name) == _main_description(name)


def test_on_adds_claude_acp_its_adapter_and_the_tool_notes() -> None:
    deps_before = list(onboarding_deps.DEPS)
    acp_switch.apply(True)

    launch = acp_vendors.acp_launch("claude")
    assert launch is not None and launch.argv == ("claude-agent-acp",)
    assert launch.verified_version == "0.102.0" == acp_vendors.CLAUDE_ACP_VERSION
    assert set(acp_vendors.ACP_LAUNCHES) == {"claude"}
    adapter = onboarding_deps.DEPS_BY_ID["claude-acp"]
    assert adapter is launch.adapter
    assert adapter.install_cmd == "npm install -g @agentclientprotocol/claude-agent-acp@0.102.0"
    assert "0.102.0" in adapter.description
    assert onboarding_deps.DEPS == [*deps_before, adapter]
    for name, note in acp_mcp.TOOL_NOTES.items():
        assert _description(name) == f"{_main_description(name)}\n\n{note}"


def test_on_twice_then_off_restores_everything_word_for_word() -> None:
    deps_before = list(onboarding_deps.DEPS)
    by_id_before = dict(onboarding_deps.DEPS_BY_ID)
    acp_switch.apply(True)
    acp_switch.apply(True)
    for name, note in acp_mcp.TOOL_NOTES.items():
        assert _description(name).count(note) == 1
    acp_switch.apply(False)
    acp_switch.apply(False)
    assert acp_vendors.ACP_LAUNCHES == {}
    assert onboarding_deps.DEPS == deps_before
    assert onboarding_deps.DEPS_BY_ID == by_id_before
    for name in acp_mcp.TOOL_NOTES:
        assert _description(name) == _main_description(name)


@pytest.mark.parametrize(("settings", "on"), [
    ({}, False), (None, False), ({"acpExperimental": False}, False),
    ({"acpExperimental": "true"}, False), ({"acpExperimental": 1}, False),
    ({"acpExperimental": True}, True),
])
def test_only_a_stored_true_turns_it_on(settings: Any, on: bool) -> None:
    acp_switch.apply_settings(settings)
    assert acp_vendors.enabled() is on


async def test_a_settings_write_applies_the_switch(monkeypatch: pytest.MonkeyPatch) -> None:
    from agent_team_backend import app, ws_handlers

    stored: dict[str, Any] = {}

    def fake_set(updates: dict[str, Any]) -> dict[str, Any]:
        delta = {k: v for k, v in updates.items() if stored.get(k) != v}
        stored.update(updates)
        return delta

    async def no_broadcast(*_args: Any, **_kwargs: Any) -> None:
        return None

    monkeypatch.setattr(app, "ui_settings_store", SimpleNamespace(set=fake_set, get=lambda: stored))
    monkeypatch.setattr(app, "broadcast", no_broadcast)
    window = _Window()
    await ws_handlers.ui_settings_set(window, "m1", "ui.settings.set", {"updates": {"acpExperimental": True}})
    assert acp_vendors.enabled() is True
    await ws_handlers.ui_settings_set(window, "m2", "ui.settings.set", {"updates": {"theme": "dark"}})
    assert acp_vendors.enabled() is True  # another key leaves it alone
    await ws_handlers.ui_settings_set(window, "m3", "ui.settings.set", {"updates": {"acpExperimental": False}})
    assert acp_vendors.enabled() is False


# ── one turn through the real switch, with a fake adapter ───────────────────


class _Window:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, message: dict[str, Any]) -> None:
        self.sent.append(message)

    def result(self, msg_id: str) -> dict[str, Any]:
        return next(m for m in self.sent if m.get("id") == msg_id)

    def events(self, kind: str) -> list[dict[str, Any]]:
        return [m["payload"] for m in self.sent if m.get("type") == kind]


async def _until(pred: Any, timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while not pred():
        if time.monotonic() > deadline:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(0.01)


@pytest.fixture
def fake_adapter(monkeypatch: pytest.MonkeyPatch) -> Any:
    """The switch on, with claude's launch pointed at the fake agent. The
    adapter "binary" is this Python; the scenario is set per test."""
    monkeypatch.setattr(pty_registry, "register", lambda pid, argv: None)
    monkeypatch.setattr(pty_registry, "unregister", lambda pid: None)
    monkeypatch.setattr(acp_ws, "_SERVICE", None)
    monkeypatch.setattr(acp_ws, "_OWNERS", {})
    acp_switch.apply(True)
    adapter = Dep("fake-acp", "Fake ACP adapter", "", "agent_cli", [sys.executable, "--version"])

    def use(scenario: str) -> None:
        monkeypatch.setitem(acp_vendors.ACP_LAUNCHES, "claude", AcpLaunch(
            argv=(sys.executable, str(FAKE_AGENT), scenario), adapter=adapter, verified_version="0.102.0",
        ))

    return use


async def test_one_turn_ends_in_turn_complete_as_agent_activity(fake_adapter, monkeypatch, tmp_path) -> None:
    from agent_team_backend import app

    fake_adapter("reply")
    broadcasts: list[dict[str, Any]] = []

    async def fake_broadcast(event: dict[str, Any], **_kw: Any) -> None:
        broadcasts.append(event)

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    handed: list[Any] = []
    real_new = acp_client.AcpClient.new_session

    async def recording_new(self: Any, cwd: str, mcp_servers: Any = None) -> str:
        handed.append(mcp_servers)
        return await real_new(self, cwd, mcp_servers)

    monkeypatch.setattr(acp_client.AcpClient, "new_session", recording_new)
    window = _Window()
    try:
        await acp_ws.acp_create(window, "m1", "acp.create", {"agent_key": "claude", "pane_id": "pane-acp", "cwd": str(tmp_path)})
        sid = window.result("m1")["payload"]["session"]["session_id"]
        # Known limitation: no MCP servers handed over yet (0.2.42).
        assert handed == [None] or handed == [[]]

        # What cli_send's delivery ends in for an ACP pane (acp.deliver → acp.prompt).
        await acp_ws.acp_prompt(window, "m2", "acp.prompt", {"session_id": sid, "text": "hi"})
        assert window.result("m2")["payload"] == {"status": "sent"}
        await _until(lambda: (app.pane_activity("pane-acp") or {}).get("event_type") == "turn_complete")

        activity = [e["payload"] for e in broadcasts if e["type"] == "agent.activity"]
        assert [(a["event_type"], a["text"]) for a in activity] == [("agent_active", ""), ("turn_complete", "Hello, world")]
        assert activity[-1]["vendor"] == "claude" and activity[-1]["detail"] == "end_turn"
        # The MCP tools answer for it from the backend's own session (idle
        # follows the turn end it has just reported).
        await _until(lambda: acp_mcp.status_fields("pane-acp")["acp"]["state"] == "idle")
        assert acp_mcp.status_fields("pane-acp") == {
            "display": "acp", "acp": {"state": "idle", "queued": 0, "pending_permissions": 0},
        }
    finally:
        await acp_ws.shutdown()
        app.forget_pane_activity("pane-acp")


async def test_a_permission_request_waits_for_the_user_in_the_window(fake_adapter, tmp_path) -> None:
    fake_adapter("permission")
    window = _Window()
    try:
        await acp_ws.acp_create(window, "m1", "acp.create", {"agent_key": "claude", "pane_id": "pane-acp", "cwd": str(tmp_path)})
        sid = window.result("m1")["payload"]["session"]["session_id"]
        await acp_ws.acp_prompt(window, "m2", "acp.prompt", {"session_id": sid, "text": "write notes"})
        await _until(lambda: window.events("acp.permission"))
        [asked] = window.events("acp.permission")
        assert [o["kind"] for o in asked["options"]] == ["allow_once", "reject_once"]
        # Nothing answers it but the user: the turn stays parked.
        await asyncio.sleep(0.2)
        assert not window.events("acp.turn_end")
        assert acp_mcp.status_fields("pane-acp")["acp"]["pending_permissions"] == 1

        await acp_ws.acp_permission_answer(window, "m3", "acp.permission_answer", {
            "session_id": sid, "request_id": asked["request_id"], "option_id": "no",
        })
        await _until(lambda: window.events("acp.turn_end"))
        texts = [e["update"]["content"]["text"] for e in window.events("acp.update")
                 if e["update"]["sessionUpdate"] == "agent_message_chunk"]
        assert texts[-1] == 'outcome={"outcome": "selected", "optionId": "no"}'
    finally:
        await acp_ws.shutdown()


async def test_a_missing_adapter_is_reported_for_the_install_flow(fake_adapter, tmp_path) -> None:
    acp_switch.apply(True)  # the real claude-acp launch, whose adapter is not on this PATH
    missing = Dep("claude-acp", "Claude Code ACP adapter", "", "agent_cli", ["navide-no-such-acp-adapter", "--version"])
    launch = acp_vendors.ACP_LAUNCHES["claude"]
    acp_vendors.ACP_LAUNCHES["claude"] = AcpLaunch(argv=launch.argv, adapter=missing, verified_version=launch.verified_version)
    window = _Window()
    await acp_ws.acp_create(window, "m1", "acp.create", {"agent_key": "claude", "pane_id": "pane-acp", "cwd": str(tmp_path)})
    reply = window.result("m1")
    assert reply["ok"] is False and reply["error"]["code"] == "ACP_ADAPTER_MISSING"
    assert reply["error"]["details"]["dep_id"] == "claude-acp"
    assert acp_ws._SERVICE is None  # nothing was started


async def test_with_the_switch_off_claude_has_no_acp_mode(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(acp_ws, "_SERVICE", None)
    acp_switch.apply(False)
    window = _Window()
    await acp_ws.acp_create(window, "m1", "acp.create", {"agent_key": "claude", "pane_id": "p", "cwd": str(tmp_path)})
    assert window.result("m1")["error"]["code"] == "ACP_UNAVAILABLE"
    assert acp_ws._SERVICE is None

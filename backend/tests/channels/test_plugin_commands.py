"""/plugins status and /plugins stop <id> in a bound chat (plan P2): list and stop, never start."""

from __future__ import annotations

from typing import Any

import pytest

from agent_team_backend import app, ws_handlers
from agent_team_backend.channels import plugin_cmds
from agent_team_backend.channels import quick_menu as qm
from agent_team_backend.channels.manager import MSG_NOT_BOUND
from agent_team_backend.plugins import agent_tools_contract as contract
from agent_team_backend.plugins import plugin_stop

from .test_manager import Env, env, fast_timers  # noqa: F401 — pytest fixtures


class FakeHost:
    """The Host end of plugins.stop.request: answers each request it is sent."""

    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        self.answer: dict[str, Any] | None = {"ok": True, "plugins": []}
        self.connected = True

    async def unicast(self, event: dict[str, Any]) -> bool:
        assert event["type"] == contract.PLUGIN_STOP_REQUEST_EVENT
        payload = dict(event["payload"])
        self.requests.append(payload)
        if self.connected and self.answer is not None:
            plugin_stop.resolve(payload["request_id"], dict(self.answer))
        return self.connected


@pytest.fixture
def host(monkeypatch) -> FakeHost:
    fake = FakeHost()
    monkeypatch.setattr(app, "unicast_host", fake.unicast)
    return fake


@pytest.mark.parametrize(("body", "parsed"), [
    ("/plugins status", ("status", "")),
    ("/plugins stop acme.grok", ("stop", "acme.grok")),
    ("/plugins@navide_bot STOP acme.grok", ("stop", "acme.grok")),
    ("/plugins stop", ("stop", "")),
    ("/plugins stop all", ("stop", "all")),
    ("/plugins", None),
    ("/plugins start acme.grok", None),
    ("/plugins status now", None),
    ("/plugin stop acme.grok", None),
    ("/plugins@other_bot stop acme.grok", None),
    ("please /plugins stop acme.grok", None),
])
def test_parse_command(body: str, parsed: tuple[str, str] | None) -> None:
    assert plugin_cmds.parse_command(body, "@navide_bot") == parsed


async def test_status_lists_the_third_party_plugins(env: Env, host: FakeHost) -> None:
    host.answer = {"ok": True, "plugins": [
        {"id": "acme.grok", "version": "1.2.0", "disabled": False},
        {"id": "acme.manus", "version": "0.4.1", "disabled": True},
    ]}
    await env.inbound("/plugins status")
    assert host.requests[-1]["action"] == "status" and "plugin_id" not in host.requests[-1]
    reply = env.tg.texts()[-1]
    assert reply.startswith(qm.text("zh-TW", "plugins_head", count=2))
    assert qm.text("zh-TW", "plugins_line", id="acme.grok", version="1.2.0", state=qm.text("zh-TW", "plugins_state_running")) in reply
    assert qm.text("zh-TW", "plugins_line", id="acme.manus", version="0.4.1", state=qm.text("zh-TW", "plugins_state_stopped")) in reply
    assert env.fake.delivered == []


async def test_stop_asks_the_host_and_says_how_to_start_it_again(env: Env, host: FakeHost) -> None:
    host.answer = {"ok": True, "pluginId": "acme.grok", "changed": True}
    await env.inbound("/plugins stop acme.grok")
    assert host.requests[-1] == {"request_id": host.requests[-1]["request_id"], "action": "stop", "plugin_id": "acme.grok"}
    assert env.tg.texts()[-1] == qm.text("zh-TW", "plugins_stopped", id="acme.grok")
    host.answer = {"ok": True, "pluginId": "acme.grok", "changed": False}
    await env.inbound("/plugins stop acme.grok")
    assert env.tg.texts()[-1] == qm.text("zh-TW", "plugins_already_stopped", id="acme.grok")


async def test_stop_names_what_went_wrong(env: Env, host: FakeHost) -> None:
    host.answer = {"ok": False, "error": "acme.x is not installed", "error_code": "NOT_INSTALLED"}
    await env.inbound("/plugins stop acme.x")
    assert env.tg.texts()[-1] == qm.text("zh-TW", "plugins_stop_none", id="acme.x")
    host.answer = {"ok": False, "error": "drain failed", "error_code": "ACTION_FAILED"}
    await env.inbound("/plugins stop acme.x")
    assert env.tg.texts()[-1] == qm.text("zh-TW", "plugins_stop_failed", id="acme.x", error="drain failed")
    await env.inbound("/plugins stop")
    assert env.tg.texts()[-1] == qm.text("zh-TW", "plugins_stop_usage")
    assert len(host.requests) == 2


async def test_no_host_means_nothing_was_stopped(env: Env, host: FakeHost) -> None:
    host.connected = False
    await env.inbound("/plugins stop acme.grok")
    assert env.tg.texts()[-1] == qm.text("zh-TW", "plugins_unavailable")


async def test_an_unbound_chat_keeps_the_current_rules(env: Env, host: FakeHost) -> None:
    await env.inbound("/plugins stop acme.grok", thread="99")
    assert env.tg.texts()[-1] == MSG_NOT_BOUND
    assert host.requests == []


async def test_a_bare_plugins_command_stays_the_panes(env: Env, host: FakeHost) -> None:
    await env.inbound("/plugins")
    assert env.fake.delivered[-1][:2] == ("pane-1", "/plugins")
    assert host.requests == []


def test_every_language_has_the_plugin_strings() -> None:
    keys = {key for key in qm.STRINGS["en-US"] if key.startswith("plugins_")}
    assert len(keys) == 19
    for lang, strings in qm.STRINGS.items():
        assert keys <= set(strings), lang


class _FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


def _session(*, host: bool) -> Any:
    session = app.Session(_FakeWebSocket())  # type: ignore[arg-type]
    session.host_authenticated = host
    return session


async def test_only_the_host_answers_a_stop_request() -> None:
    window = _session(host=False)
    await ws_handlers.plugins_stop_result(window, "1", contract.PLUGIN_STOP_RESULT_MESSAGE, {"request_id": "ps:1", "ok": True})
    assert window.websocket.sent[-1]["error"]["code"] == "UNAUTHORIZED"
    host = _session(host=True)
    await ws_handlers.plugins_stop_result(host, "2", contract.PLUGIN_STOP_RESULT_MESSAGE, {"request_id": "ps:1"})
    assert host.websocket.sent[-1]["error"]["code"] == "BAD_REQUEST"
    await ws_handlers.plugins_stop_result(host, "3", contract.PLUGIN_STOP_RESULT_MESSAGE, {"request_id": "ps:unknown", "ok": True})
    assert host.websocket.sent[-1]["payload"] == {"ok": True, "delivered": False}
    assert contract.PLUGIN_STOP_REQUEST_EVENT == "plugins.stop.request"
    assert contract.PLUGIN_STOP_RESULT_MESSAGE == "plugins.stop.result"


async def test_stop_all_stops_every_third_party_plugin_as_the_user(env: Env, host: FakeHost) -> None:
    host.answer = {"ok": True, "stopped": ["acme.grok", "acme.manus"], "failed": []}
    await env.inbound("/plugins stop ALL")
    assert host.requests[-1] == {"request_id": host.requests[-1]["request_id"], "action": "stop-all"}
    assert env.tg.texts()[-1] == qm.text("zh-TW", "plugins_stopped_all", count=2)
    host.answer = {"ok": False, "error": "drain failed", "error_code": "ACTION_FAILED"}
    await env.inbound("/plugins stop all")
    assert env.tg.texts()[-1] == qm.text("zh-TW", "plugins_stop_failed", id="all", error="drain failed")


async def test_plugins_disable_all_asks_the_host_as_the_agent_and_audits_each_plugin(host: FakeHost, monkeypatch) -> None:
    from agent_team_backend.mcp_server import server as mcp

    monkeypatch.setattr(mcp, "_resolve_caller", lambda ctx: mcp._Caller(kind="external", pane_id=None))
    audited: list[dict[str, Any]] = []
    monkeypatch.setattr(mcp, "_audit_agent_action", lambda caller, requester, **row: audited.append(row))
    host.answer = {"ok": True, "stopped": ["acme.grok", "not an id", 7], "failed": ["acme.manus"]}
    answer = await mcp.plugins_disable_all(None)
    assert answer == {"ok": True, "stopped": ["acme.grok"], "failed": ["acme.manus"]}
    request = host.requests[-1]
    assert request["action"] == "stop-all" and request["requester"]["callerKind"] == "external"
    assert [(row["plugin_id"], row["outcome"]) for row in audited] == [("acme.grok", "allowed"), ("acme.manus", "error")]
    host.connected = False
    assert (await mcp.plugins_disable_all(None))["error_code"] == "HOST_UNAVAILABLE"

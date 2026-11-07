"""MCP channels_status / channels_bindings (plan mcp-bot_507912 P0).

Both only read the channel manager; neither may hand a bot credential to the
agent, whether as a key, as a config value or quoted inside an error.
"""

from __future__ import annotations

import hashlib
import json
import re

import pytest

from agent_team_backend import channels
from agent_team_backend.channels import agent_requests
from agent_team_backend.channels.manager import _bot_key
from agent_team_backend.mcp_server import channel_tools
from agent_team_backend.mcp_server import server as mcp
from agent_team_backend.plugins import agent_tools_contract as contract

from .test_manager import Env, env, fast_timers  # noqa: F401 — fixtures shared with the manager suite

TOOLS = ("channels_status", "channels_bindings")
#: Token-shaped test values, built at run time so the file holds no literal a
#: secret scanner reads as a credential. None of them is or was ever real.
REAL_TOKEN = "1" * 9 + ":" + "Fake" * 8 + "Tok"  # the shape BotFather hands out
FAKE_SLACK_BOT = "-".join(["xoxb", "1" * 10, "fake" * 3])
FAKE_SLACK_APP = "-".join(["xapp", "1", "A" + "0" * 10, "fake" * 3])
FAKE_DISCORD = ".".join(["M" + "T" * 24, "F" * 6, "fake" * 7])
TOKEN_SHAPE = re.compile(r"\d+:[A-Za-z0-9_-]{30,}")
#: sha256 of the channels_* tools' names and parameter schemas. A tool added
#: or changed on purpose updates it: print _surface()'s digest and paste it here.
CHANNEL_SURFACE_SHA256 = "e5dbf868c89ee08c48d596b61bfc7f7fee0966d6b9c0f8f4095ef55a86f23460"


def _tools() -> dict:
    return {t.name: t for t in mcp.server._tool_manager.list_tools()}  # noqa: SLF001


def _surface() -> str:
    tools = _tools()
    names = sorted(n for n in tools if n.startswith("channels_"))
    return json.dumps([[n, tools[n].parameters] for n in names], sort_keys=True, separators=(",", ":"),
                      ensure_ascii=True)


def _keys(value) -> set[str]:
    if isinstance(value, dict):
        return set(value) | {k for v in value.values() for k in _keys(v)}
    if isinstance(value, list):
        return {k for v in value for k in _keys(v)}
    return set()


@pytest.fixture
async def live(env: Env, monkeypatch):  # noqa: F811 — the env fixture imported above
    """The manager suite's env, with a second bot whose token is real-shaped and whose
    last error quotes the request URL that carries it."""
    assert (await env.m.configure("telegram", {"name": "Ops"}, {"token": REAL_TOKEN}, account="bot-x"))["ok"]
    env.adapters["telegram:bot-x"].status.last_error = (
        f"HTTP 409 from https://api.telegram.org/bot{REAL_TOKEN}/getUpdates"
    )
    monkeypatch.setattr(channels, "_manager", env.m)
    return env


def test_every_channels_tool_is_a_core_tool_with_a_pinned_surface() -> None:
    tools = _tools()
    for name in (n for n in tools if n.startswith("channels_")):
        assert name in tools and name in contract.CORE_TOOL_NAMES, name
    surface = _surface()
    for name, schema in json.loads(surface):
        for key in schema.get("properties", {}):
            assert not any(word in key.lower() for word in ("token", "secret", "approve", "confirm")), (name, key)
    assert hashlib.sha256(surface.encode()).hexdigest() == CHANNEL_SURFACE_SHA256


@pytest.mark.parametrize("name", TOOLS)
def test_each_description_says_it_is_read_only_and_where_to_change_things(name: str) -> None:
    description = _tools()[name].description
    assert "Read-only" in description
    assert "ui.settings.open" in description and '"channels"' in description


async def test_status_lists_each_bot_with_its_binding(live: Env) -> None:
    out = await channel_tools.channels_status()
    assert out["ok"] is True
    telegram = next(p for p in out["platforms"] if p["platform"] == "telegram")
    bots = {b["account"]: b for b in telegram["bots"]}
    assert set(bots) == {"default", "bot-x"}
    assert bots["bot-x"]["name"] == "Ops" and bots["bot-x"]["enabled"] is True
    assert [b["pane_id"] for b in bots["default"]["bindings"]] == ["pane-1"]
    assert "status" in bots["default"] and "last_activity_at" in bots["default"]


async def test_status_never_carries_a_token(live: Env) -> None:
    out = await channel_tools.channels_status()
    text = json.dumps(out, ensure_ascii=False)
    assert not TOKEN_SHAPE.search(text), text
    assert REAL_TOKEN not in text and "tok-A" not in text
    assert not any("token" in k.lower() or "secret" in k.lower() for k in _keys(out))
    bot_x = next(b for p in out["platforms"] for b in p["bots"] if b["account"] == "bot-x")
    assert bot_x["status"]["last_error"] == "HTTP 409 from https://api.telegram.org/bot<redacted>/getUpdates"
    assert "config" not in bot_x


async def test_bindings_lists_every_binding_without_a_token(live: Env) -> None:
    out = await channel_tools.channels_bindings()
    assert out["ok"] is True
    assert [(b["pane_id"], b["platform"], b["account"], b["chat_id"]) for b in out["bindings"]] == [
        ("pane-1", "telegram", "default", "-100"),
    ]
    text = json.dumps(out, ensure_ascii=False)
    assert not TOKEN_SHAPE.search(text)
    assert not any("token" in k.lower() or "secret" in k.lower() for k in _keys(out))


@pytest.mark.parametrize("name", TOOLS)
async def test_without_the_gateway_each_tool_says_so(name: str, monkeypatch) -> None:
    monkeypatch.setattr(channels, "_manager", None)
    out = await getattr(channel_tools, name)()
    assert out == {"ok": False, "error": "chat channels are not running", "error_code": "channels-not-running"}


@pytest.mark.parametrize("text", [
    REAL_TOKEN, FAKE_SLACK_BOT, FAKE_SLACK_APP, FAKE_DISCORD,
], ids=["telegram", "slack-bot", "slack-app", "discord"])
def test_scrub_redacts_each_platforms_credential_shape(text: str, monkeypatch) -> None:
    from agent_team_backend.channels import redact

    # Unregistered: only the shape can catch it.
    monkeypatch.setattr(redact, "_filter", redact.SecretRedactFilter())
    assert channel_tools._scrub({"e": f"failed: {text}"}) == {"e": "failed: [redacted]"}


def test_scrub_masks_a_secret_a_bot_registered_whatever_its_shape(monkeypatch) -> None:
    from agent_team_backend.channels import redact

    monkeypatch.setattr(redact, "_filter", redact.SecretRedactFilter())
    redact.add_secret("matrix-access-Qz9")
    assert channel_tools._scrub({"e": "login failed for matrix-access-Qz9"}) == {"e": "login failed for <redacted>"}


# ── P1: the other read-only tools and the direct changes ────────────────────


@pytest.fixture
def acting(live: Env, tmp_path, monkeypatch):
    """A CLI pane "lead" calling, with "dev" beside it and "far" in another workspace;
    the main windows' events and the action record are captured."""
    from agent_team_backend import agent_messaging, agent_window_actions, app

    events: list[dict] = []

    async def broadcast_main_windows(event: dict) -> None:
        events.append(event)

    agent_messaging._reset_for_test()
    own, other = tmp_path / "own", tmp_path / "other"
    own.mkdir()
    other.mkdir()
    agent_messaging.register("p-41", "lead", str(own), agent_key="claude")
    agent_messaging.register("p-42", "dev", str(own), agent_key="claude")
    agent_messaging.register("p-50", "far", str(other), agent_key="claude")
    caller = {"value": mcp._Caller(kind="pane", pane_id="p-41")}
    monkeypatch.setattr(mcp, "_resolve_caller", lambda ctx: caller["value"])
    monkeypatch.setattr(app, "broadcast_main_windows", broadcast_main_windows)
    monkeypatch.setattr(app, "has_main_window", lambda: True)
    agent_window_actions._reset_for_test(tmp_path / "actions.jsonl")
    agent_requests.registry._reset_for_test()
    # The group the suite binds is one the default bot has seen; alice (7) is let in.
    live.store.remember_chat("telegram", _bot_key(live.m._adapters[("telegram", "default")]), "-100", "api",
                             "supergroup", True, 1)
    yield live, events, caller
    agent_messaging._reset_for_test()
    agent_window_actions._reset_for_test(None)
    agent_requests.registry._reset_for_test()


def _recorded() -> list[dict]:
    from agent_team_backend import agent_window_actions

    return agent_window_actions.entries()


async def test_bind_binds_a_pane_of_the_callers_own_workspace_and_says_so(acting) -> None:
    env, events, _ = acting
    await env.m.unbind("pane-1")
    out = await channel_tools.channels_bind("telegram", "-100", None, pane="dev", thread_id="50")
    assert out["ok"] is True and out["binding"]["pane_id"] == "p-42"
    assert [b.pane_id for b in env.store.bindings()] == ["p-42"]
    record = _recorded()[-1]
    assert record["tool"] == "channels_bind" and record["ok"] is True
    assert record["caller"]["pane_id"] == "p-41" and record["target"]["pane"] == "dev"
    assert events[-1]["type"] == "channels.agent_action"
    assert events[-1]["payload"]["tool"] == "channels_bind"
    assert events[-1]["payload"]["target"]["chat_id"] == "-100"


async def test_bind_without_a_pane_binds_the_caller(acting) -> None:
    env, _, _ = acting
    await env.m.unbind("pane-1")
    out = await channel_tools.channels_bind("telegram", "-100", None, thread_id="50")
    assert out["ok"] is True and out["binding"]["pane_id"] == "p-41"


async def test_another_workspaces_pane_is_left_to_the_user(acting) -> None:
    env, events, _ = acting
    await env.m.unbind("pane-1")
    for call in (channel_tools.channels_unbind(None, pane_id="p-50"),
                 channel_tools.channels_set_verbosity("full", None, pane_id="p-50")):
        assert (await call)["error_code"] == "cross-workspace"


async def test_a_caller_with_no_pane_cannot_bind(acting) -> None:
    _, _, caller = acting
    caller["value"] = mcp._Caller(kind="external")
    out = await channel_tools.channels_bind("telegram", "-100", None, pane_id="p-42")
    assert out["error_code"] == "pane-caller-required"


async def test_unbind_and_verbosity_change_the_pane_and_are_recorded(acting) -> None:
    env, events, _ = acting
    await env.m.unbind("pane-1")
    assert (await channel_tools.channels_bind("telegram", "-100", None, pane="dev"))["ok"]
    out = await channel_tools.channels_set_verbosity("full", None, pane="dev")
    assert out["ok"] is True and out["binding"]["verbosity"] == "full"
    assert (await channel_tools.channels_unbind(None, pane="dev")) == {"ok": True, "removed": True}
    assert env.store.bindings() == []
    assert [e["payload"]["tool"] for e in events] == ["channels_bind", "channels_set_verbosity", "channels_unbind"]


async def test_a_refused_change_is_recorded_but_not_announced(acting) -> None:
    env, events, _ = acting
    out = await channel_tools.channels_set_verbosity("everything", None, pane="dev")
    assert out["ok"] is False and out["error_code"] == "channels-refused"
    assert _recorded()[-1]["ok"] is False and events == []


async def test_bot_rename_and_connection(acting) -> None:
    env, events, _ = acting
    assert await channel_tools.channels_bot_rename("telegram", "bot-x", "Night shift", None) == {"ok": True}
    assert env.store.accounts()[("telegram", "bot-x")]["config"]["name"] == "Night shift"
    assert (await channel_tools.channels_bot_set_enabled("telegram", "bot-x", False, None))["ok"] is True
    assert env.store.accounts()[("telegram", "bot-x")]["enabled"] is False
    assert events[-1]["payload"]["target"] == {"platform": "telegram", "account": "bot-x", "enabled": False}


async def test_link_code_chats_pairing_and_reject(acting) -> None:
    env, _, _ = acting
    code = await channel_tools.channels_link_code("telegram", None)
    assert code["ok"] is True and len(code["code"]) == 8 and code["target"] == "direct"
    chats = await channel_tools.channels_chats("telegram")
    assert chats["ok"] is True and chats["bots"][0]["account"] == "default"
    every = await channel_tools.channels_chats()
    assert {(b["platform"], b["account"]) for b in every["bots"]} == {("telegram", "default"), ("telegram", "bot-x")}
    assert (await channel_tools.channels_pairing_requests())["requests"] == []
    refused = await channel_tools.channels_pairing_reject("telegram", "NOPE0000", None)
    assert refused["ok"] is False and refused["error_code"] == "channels-refused"


async def test_an_unknown_platform_is_a_bad_request(acting) -> None:
    out = await channel_tools.channels_bot_rename("carrier-pigeon", "default", "x", None)
    assert out["ok"] is False and out["error_code"] == "bad-request"
    assert (await channel_tools.channels_link_code("carrier-pigeon", None))["error_code"] == "bad-request"


# ── P2: requests the user decides in the main window ────────────────────────


def _changed(events: list[dict]) -> list[dict]:
    return [e["payload"] for e in events if e["type"] == agent_requests.CHANGED_EVENT]


async def test_binding_another_workspaces_pane_goes_to_the_user(acting) -> None:
    env, events, _ = acting
    await env.m.unbind("pane-1")
    out = await channel_tools.channels_bind("telegram", "-100", None, pane_id="p-50", reason="ops room")
    assert out["ok"] is True and out["status"] == "pending" and out["why"] == "The pane is in another workspace."
    assert env.store.bindings() == []
    shown = _changed(events)[-1]
    assert shown["kind"] == "bind" and shown["target"]["pane"] == "far" and "ops room" in shown["reason"]
    assert shown["requester"]["pane_id"] == "p-41"
    decided = await agent_requests.decide(env.m, out["id"], True)
    assert decided["request"]["status"] == "completed"
    assert [b.pane_id for b in env.store.bindings()] == ["p-50"]


@pytest.mark.parametrize("chat_id, why", [
    ("-999", "The bot has not seen this chat."),
])
async def test_binding_a_chat_the_bot_does_not_know_goes_to_the_user(acting, chat_id: str, why: str) -> None:
    env, _, _ = acting
    await env.m.unbind("pane-1")
    out = await channel_tools.channels_bind("telegram", chat_id, None, pane="dev")
    assert out["status"] == "pending" and out["why"] == why
    assert env.store.bindings() == []
    assert (await agent_requests.decide(env.m, out["id"], False))["request"]["status"] == "rejected"
    assert env.store.bindings() == []


async def test_binding_a_chat_nobody_was_let_in_from_goes_to_the_user(acting) -> None:
    env, _, _ = acting
    await env.m.unbind("pane-1")
    env.store.remove_allow("telegram", "7", "default")
    out = await channel_tools.channels_bind("telegram", "-100", None, pane="dev")
    assert out["status"] == "pending" and out["why"] == "Nobody in this chat has been let in yet."


async def test_approving_a_pairing_can_bind_the_senders_chat(acting) -> None:
    env, _, _ = acting
    await env.m.unbind("pane-1")
    code = env.m.gate.request_pairing("telegram", "42", "neil", "42").request.code
    assert (await channel_tools.channels_pairing_requests())["requests"][0]["code"] == code
    out = await channel_tools.channels_pairing_approve_request("telegram", code, None, bind_pane="dev")
    assert out["ok"] is True and out["status"] == "pending"
    assert not env.m.gate.is_allowed("telegram", "42", "default")
    decided = await agent_requests.decide(env.m, out["id"], True)
    assert decided["request"]["status"] == "completed"
    assert env.m.gate.is_allowed("telegram", "42", "default")
    assert [(b.pane_id, b.chat_id) for b in env.store.bindings()] == [("p-42", "42")]
    status = await channel_tools.channels_request_status(out["id"], None)
    assert status["status"] == "completed" and status["result"]["binding"]["pane_id"] == "p-42"
    assert "requester" not in status


async def test_an_unknown_pairing_code_is_refused(acting) -> None:
    out = await channel_tools.channels_pairing_approve_request("telegram", "ZZZZZZZZ", None)
    assert out["error_code"] == "unknown-code"


async def test_removing_a_bot_goes_to_the_user(acting) -> None:
    env, _, _ = acting
    out = await channel_tools.channels_bot_remove_request("telegram", "bot-x", None, reason="unused")
    assert out["status"] == "pending" and ("telegram", "bot-x") in env.store.accounts()
    await agent_requests.decide(env.m, out["id"], True)
    assert ("telegram", "bot-x") not in env.store.accounts()
    unknown = await channel_tools.channels_bot_remove_request("telegram", "bot-zz", None)
    assert unknown["error_code"] == "unknown-bot"


async def test_a_bot_to_add_is_filled_by_the_agent_and_added_by_the_user(acting) -> None:
    env, events, caller = acting
    out = await channel_tools.channels_bot_add_fill("telegram", None, name="Support", reason="for customers")
    shown = _changed(events)[-1]
    assert shown["kind"] == "bot-add" and shown["draft"] == {"name": "Support"}
    assert (await agent_requests.decide(env.m, out["id"], True))["ok"] is False  # only the form adds it
    await agent_requests.finish(out["id"], True, "bot-new1")
    status = await channel_tools.channels_request_status(out["id"], None)
    assert status["status"] == "completed" and status["result"] == {"platform": "telegram", "account": "bot-new1"}
    caller["value"] = mcp._Caller(kind="pane", pane_id="p-42")
    assert (await channel_tools.channels_request_status(out["id"], None))["error_code"] == "unknown-request"


async def test_add_open_shows_the_form_and_files_nothing(acting) -> None:
    _, events, _ = acting
    out = await channel_tools.channels_bot_add_open("telegram", None)
    assert out["ok"] is True and events[-1]["type"] == "channels.agent_form.open"
    assert agent_requests.registry.pending() == []
    assert (await channel_tools.channels_bot_add_open("carrier-pigeon", None))["error_code"] == "bad-request"


async def test_requests_need_a_main_window_and_a_pane_caller(acting, monkeypatch) -> None:
    from agent_team_backend import app

    _, _, caller = acting
    monkeypatch.setattr(app, "has_main_window", lambda: False)
    assert (await channel_tools.channels_bot_add_fill("telegram", None))["error_code"] == "no-main-window"
    caller["value"] = mcp._Caller(kind="external")
    assert (await channel_tools.channels_bot_add_fill("telegram", None))["error_code"] == "pane-caller-required"
    assert (await channel_tools.channels_bot_rename("telegram", "bot-x", "x", None))["error_code"] == (
        "pane-caller-required")


async def test_a_managed_creation_settles_from_telegrams_answer(acting) -> None:
    env, _, _ = acting
    refused = await channel_tools.channels_managed_bot_create(None)
    assert refused["ok"] is False  # the fake bot is not in Bot Management Mode
    record = agent_requests.registry.file("managed-create", {"pane_id": "p-41"}, "", {"request_id": "r1"})
    agent_requests.on_event("channels.managed_created", {"request_id": "r1", "ok": True, "account": "bot-m1",
                                                         "name": "Made", "link": None})
    status = await channel_tools.channels_request_status(record["id"], None)
    assert status["status"] == "completed" and status["result"]["account"] == "bot-m1"


async def test_a_link_code_settles_when_the_chat_is_linked(acting) -> None:
    out = await channel_tools.channels_link_code("telegram", None)
    status = await channel_tools.channels_request_status(out["id"], None)
    assert status["kind"] == "link" and status["status"] == "pending"
    agent_requests.on_event("channels.linked", {"platform": "telegram", "code": out["code"], "chat_id": "42",
                                                "title": "neil", "kind": "direct", "confirmed": True})
    status = await channel_tools.channels_request_status(out["id"], None, wait_s=1)
    assert status["status"] == "completed" and status["result"]["chat_id"] == "42"


async def test_only_a_main_window_lists_or_decides_requests(acting) -> None:
    from types import SimpleNamespace

    from agent_team_backend.channels import ws_api

    env, _, _ = acting
    out = await channel_tools.channels_bot_remove_request("telegram", "bot-x", None)
    other = SimpleNamespace(navide_window=False, ui_bus_ready=False)
    refused = await ws_api._agent_request(other, env.m, "channels.agent_request.decide", {"id": out["id"], "approve": True})
    assert refused["ok"] is False and ("telegram", "bot-x") in env.store.accounts()
    window = SimpleNamespace(navide_window=True, ui_bus_ready=True)
    listed = await ws_api._agent_request(window, env.m, "channels.agent_request.list", {})
    assert [r["id"] for r in listed["requests"]] == [out["id"]]
    decided = await ws_api._agent_request(window, env.m, "channels.agent_request.decide", {"id": out["id"], "approve": True})
    assert decided["request"]["status"] == "completed"

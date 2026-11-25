"""System notices reach only the chats they are about (2026-11-25: a pane's MCP
disconnect notice reached every bot's direct chat, client bots included). One bot
per project, as people set them up: the main bot, a project's bot and a client's
bot, each with a direct chat. Fake adapters and seams, no real bot."""

from __future__ import annotations

from agent_team_backend.channels import account_menu as am
from agent_team_backend.channels import quick_menu
from agent_team_backend.channels.base import Location
from agent_team_backend.channels.manager import _bot_key

from .test_manager import Env, FakeAdapter, _second_bot, env, fast_timers  # noqa: F401 — fixtures

ME = "7"
WORKSPACES = {"nav-cmd": "/ws/agent-team", "token-cmd": "/ws/token", "fx": "/ws/token",
              "client-cmd": "/ws/client"}


def _direct(env: Env, adapter: FakeAdapter, pane_id: str, chat: str = ME) -> None:
    env.store.remember_chat("telegram", _bot_key(adapter), chat, "me", "direct", False, 1)
    env.store.bind(pane_id, Location("telegram", adapter.account, chat, "", "me"), verbosity="full")


async def _bots(env: Env) -> tuple[FakeAdapter, FakeAdapter]:
    token = await _second_bot(env, "bot-token", "tok-T")
    client = await _second_bot(env, "bot-client", "tok-C")
    env.store.unbind("pane-1")  # the fixture's group topic: not part of this picture
    _direct(env, env.tg, "nav-cmd")
    _direct(env, token, "token-cmd")
    _direct(env, client, "client-cmd")
    _direct(env, client, "client-cmd", chat="99")  # the client's own person, also direct
    env.m._seams.pane_workspace = lambda p: WORKSPACES.get(p, "")
    for pane in WORKSPACES:
        env.fake.agents[pane] = "claude"
    return token, client


def _told(*adapters: FakeAdapter, text: str) -> list[tuple[str, str]]:
    return [(a.account, loc.chat_id) for a in adapters for loc, t in a.sent if text in t]


async def test_a_panes_mcp_notice_reaches_only_its_workspaces_bot(env: Env) -> None:
    token, client = await _bots(env)
    await env.m.notify_mcp_disconnected("匯率設定規劃", "fx", "/ws/token")
    text = quick_menu.text("zh-TW", "mcp_disconnected", pane="匯率設定規劃")
    assert _told(env.tg, token, client, text=text) == [("bot-token", ME)]


async def test_an_auto_reconnected_notice_reaches_only_its_workspaces_bot(env: Env) -> None:
    token, client = await _bots(env)
    await env.m.notify_mcp_auto_reconnected("匯率設定規劃", "fx", "/ws/token")
    text = quick_menu.text("zh-TW", "mcp_auto_reconnected", pane="匯率設定規劃")
    assert _told(env.tg, token, client, text=text) == [("bot-token", ME)]


async def test_an_account_sign_in_notice_reaches_only_the_main_bot(env: Env) -> None:
    token, client = await _bots(env)
    await env.m.notify_account_needs_login("Work")
    text = quick_menu.text("zh-TW", "account_needs_login", account="Work")
    assert _told(env.tg, token, client, text=text) == [("default", ME)]


async def test_an_mcp_endpoint_notice_reaches_only_the_main_bot(env: Env) -> None:
    token, client = await _bots(env)
    await env.m.notify_mcp_endpoint_down()
    text = quick_menu.text("zh-TW", "mcp_endpoint_down")
    assert _told(env.tg, token, client, text=text) == [("default", ME)]


async def test_a_plugin_pause_notice_reaches_only_the_main_bot(env: Env) -> None:
    token, client = await _bots(env)
    await env.m.notify_plugin_paused("acme.tool", "R3")
    text = quick_menu.text("zh-TW", "plugins_auto_paused", id="acme.tool",
                           reason=quick_menu.text("zh-TW", "plugins_rule_R3"))
    assert _told(env.tg, token, client, text=text) == [("default", ME)]


async def test_a_shipped_digest_reaches_only_its_workspaces_bot(env: Env) -> None:
    token, client = await _bots(env)
    assert await env.m.notify_shipped_digest("digest of token", "/ws/token") == 1
    assert _told(env.tg, token, client, text="digest of token") == [("bot-token", ME)]
    assert await env.m.notify_shipped_digest("digest of nowhere", "/ws/unbound") == 0


async def test_a_quota_switch_reaches_only_the_moved_panes_chats(env: Env) -> None:
    # Every pane runs claude; only the token project's pane was moved.
    token, client = await _bots(env)
    assert await env.m.notify_failover_switch(agent_key="claude", pane_ids=["token-cmd"], from_id="p-a",
                                              from_label="Work", to_id="p-b", to_label="Home") == 1
    text = am.text("zh-TW", "failover_done", **{"from": "Work", "to": "Home"})
    assert _told(env.tg, token, client, text=text) == [("bot-token", ME)]


async def test_a_stopped_continuation_reaches_only_the_named_panes_chats(env: Env) -> None:
    token, client = await _bots(env)
    assert await env.m.notify_failover_stuck(agent_key="claude", pane_ids=[], reason="x", minutes=15,
                                             expires_in="1h", final=False) == 0
    assert client.sent == [] and token.sent == []

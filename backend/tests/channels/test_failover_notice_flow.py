"""An automatic quota switch told to the chats (plan agent-0-2-42_3f728e P3), on the fake
adapter and fake seams (no real bot, no real account switch): who is told, the masked
names, and the "switch back" button going the /account way."""

from __future__ import annotations

from typing import Any

from agent_team_backend.channels import account_menu as am
from agent_team_backend.channels.base import Location
from agent_team_backend.channels.manager import _bot_key

from .test_manager import Env, _said, env, fast_timers  # noqa: F401 — fixtures

# A Telegram direct chat: its id is its person's id.
ME = "7"


def _direct(env: Env, pane_id: str = "pane-2", chat: str = ME) -> Location:
    loc = Location("telegram", "default", chat, "", "me")
    env.store.remember_chat("telegram", _bot_key(env.tg), chat, "me", "direct", False, 1)
    env.store.bind(pane_id, loc, verbosity="full")
    return loc


async def _notify(env: Env, **kw: Any) -> int:
    args: dict[str, Any] = {"agent_key": "claude", "pane_ids": ["pane-2"], "from_id": "p-a",
                            "from_label": "Work", "to_id": "p-b", "to_label": "someone" + "@example.test"}
    args.update(kw)
    return await env.m.notify_failover_switch(**args)


class Switches:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, str, str]] = []

    async def switch(self, pane_id: str, profile_id: str, from_id: str, who: str,
                     on_settled: Any = None) -> dict[str, Any]:
        self.calls.append((pane_id, profile_id, from_id, who))
        return {"status": "switched", "from": "som…@example.test", "to": "Work"}


async def test_a_direct_chat_is_told_once_with_a_switch_back_button(env: Env) -> None:
    loc = _direct(env)
    env.fake.agents["pane-2"] = "claude"
    assert await _notify(env) == 1
    body = am.text("zh-TW", "failover_done", **{"from": "Work", "to": "som…@example.test"})
    assert _said(env, body)
    assert "someone@" not in "".join(env.tg.texts())
    sent_to = [l for l, t in env.tg.sent if t == body]
    assert [l.chat_id for l in sent_to] == [loc.chat_id]
    labels = [label for label, _ in env.tg.buttons[body]]
    assert labels == [am.text("zh-TW", "switch_back", to="Work"), am.text("zh-TW", "cancel")]


async def test_switch_back_goes_through_the_account_switch(env: Env) -> None:
    _direct(env)
    env.fake.agents["pane-2"] = "claude"
    sw = Switches()
    env.m._seams.switch_account = sw.switch
    await _notify(env)
    body = am.text("zh-TW", "failover_done", **{"from": "Work", "to": "som…@example.test"})
    data = env.tg.buttons[body][0][1]
    await env.inbound("", callback=data, sender=ME, chat=ME, thread="", direct=True)
    # Back to the account it came from, re-checked against the one it moved to.
    assert sw.calls == [("pane-2", "p-a", "p-b", "telegram:alice")]
    assert _said(env, "✅")
    await env.inbound("", callback=data, sender=ME, chat=ME, thread="", direct=True)
    assert len(sw.calls) == 1  # one press only


async def test_only_that_chat_s_person_can_press(env: Env) -> None:
    _direct(env)
    env.fake.agents["pane-2"] = "claude"
    env.store.add_allow("telegram", "8", "bob", 1)
    sw = Switches()
    env.m._seams.switch_account = sw.switch
    await _notify(env)
    body = am.text("zh-TW", "failover_done", **{"from": "Work", "to": "som…@example.test"})
    await env.inbound("", callback=env.tg.buttons[body][0][1], sender="8", chat=ME, thread="", direct=True)
    assert sw.calls == []


async def test_group_chats_and_panes_of_another_cli_are_not_told(env: Env) -> None:
    # pane-1 sits in the fixture's group topic; pane-3 is a codex pane in a direct chat.
    env.fake.agents["pane-1"] = "claude"
    _direct(env, "pane-3", chat="9")
    env.fake.agents["pane-3"] = "codex"
    assert await _notify(env) == 0
    assert env.tg.sent == []


async def test_a_moved_pane_is_told_whatever_its_agent_reads(env: Env) -> None:
    _direct(env)
    assert await _notify(env, pane_ids=["pane-2"]) == 1


async def test_no_button_when_the_new_account_cannot_sign_in(env: Env) -> None:
    _direct(env)
    env.fake.agents["pane-2"] = "claude"
    await _notify(env, needs_login=True)
    body = am.text("zh-TW", "failover_needs_login", **{"from": "Work", "to": "som…@example.test"})
    assert _said(env, body) and body not in env.tg.buttons


async def test_another_cli_gets_the_notice_without_a_button(env: Env) -> None:
    _direct(env)
    env.fake.agents["pane-2"] = "codex"
    await _notify(env, agent_key="codex")
    body = am.text("zh-TW", "failover_done", **{"from": "Work", "to": "som…@example.test"})
    assert _said(env, body) and body not in env.tg.buttons

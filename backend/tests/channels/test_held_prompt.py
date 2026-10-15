"""The 「⚠️ pane 正在等確認」 warning a chat gets when it writes to a pane that is
waiting on a prompt: it carries the prompt's options and buttons itself and
replies to the original prompt message, so a busy chat that scrolled past the
prompt can still answer, and jump back to it, from the newest message."""

from __future__ import annotations

import dataclasses
from typing import Any

from agent_team_backend.channels import manager as mgr_mod
from agent_team_backend.channels import relay

from .test_manager import (  # noqa: F401 — fixtures and helpers shared with the manager suite
    Env, _awaiting, _prompt_message, _relay_id, _until, _until_relay_prompt, env, fast_timers,
)


def _capture(env: Env, *, reply_to: bool = True) -> list[dict[str, Any]]:
    """Record each send's buttons and reply target; the fake claims reply_to support."""
    calls: list[dict[str, Any]] = []
    orig = env.tg.send_text
    if reply_to:
        env.tg.capabilities = dataclasses.replace(env.tg.capabilities, reply_to=True)

    async def send_text(loc, text, *, buttons=None, **kw):
        calls.append({"text": text, "buttons": buttons, **kw})
        return await orig(loc, text, buttons=buttons)

    env.tg.send_text = send_text
    return calls


async def _question(env: Env, options: list[str], prompt: str = "Pick one") -> str:
    env.fake.kind = "permission"  # what Claude's AskUserQuestion box reports
    env.fake.prompt = prompt
    env.fake.options = options
    await _awaiting(env)
    await _until_relay_prompt(env)
    return _relay_id(env)


def _held(calls: list[dict[str, Any]]) -> dict[str, Any]:
    return next(c for c in reversed(calls) if c["text"].startswith("⚠️ pane 正在等確認"))


async def test_the_warning_lists_the_options_with_buttons_and_quotes_the_prompt(env: Env) -> None:
    calls = _capture(env)
    rid = await _question(env, ["Keep", "Discard"])
    mid, _ = _prompt_message(env)
    await env.inbound("are you there?")
    held = _held(calls)
    assert "Pick one" in held["text"]
    assert "1. Keep" in held["text"] and "2. Discard" in held["text"]
    assert f"回覆 <選項編號> {rid}" in held["text"]
    assert held["buttons"] == [("1. Keep", f"nv1:{rid}:1"), ("2. Discard", f"nv1:{rid}:2")]
    assert held["reply_to"] == mid
    assert env.fake.delivered[-1][1] == "go"  # the held text itself was not delivered


async def test_a_permission_warning_carries_allow_and_deny(env: Env) -> None:
    calls = _capture(env)
    await _awaiting(env)
    await _until_relay_prompt(env)
    rid = _relay_id(env)
    await env.inbound("hello?")
    held = _held(calls)
    assert "Allow Bash(npm run build)?" in held["text"]
    assert held["buttons"] == [("允許", f"nv1:{rid}:y"), ("拒絕", f"nv1:{rid}:n")]


async def test_a_button_on_the_warning_answers_the_prompt(env: Env) -> None:
    _capture(env)
    rid = await _question(env, ["Keep", "Discard"])
    await env.inbound("are you there?")
    await env.inbound("", callback=f"nv1:{rid}:2")
    assert env.fake.answers == [("pane-1", {"kind": "question", "option": 2})]


async def test_the_warnings_are_settled_with_the_prompt(env: Env) -> None:
    calls = _capture(env)
    rid = await _question(env, ["Keep", "Discard"])
    await env.inbound("are you there?")
    held_id = str(len(env.tg.sent))  # the fake numbers messages in send order
    held_text = _held(calls)["text"]
    await env.inbound(f"2 {rid}")
    note = f"{mgr_mod.MSG_RELAY_ANSWERED_IN_CHAT}選項 2"
    await _until(lambda: (held_id, f"{held_text}\n\n{note}") in env.tg.edits)


async def test_an_adapter_without_reply_support_gets_no_reply_target(env: Env) -> None:
    calls = _capture(env, reply_to=False)
    await _question(env, ["Keep", "Discard"])
    await env.inbound("are you there?")
    held = _held(calls)
    assert "reply_to" not in held and held["buttons"]


async def test_a_warning_in_another_chat_keeps_the_old_hint(env: Env) -> None:
    calls = _capture(env)
    rid = await _question(env, ["Keep", "Discard"])
    # The relayed request belongs to another topic of the same group.
    req = env.m.relay.get(rid)
    req.loc = dataclasses.replace(req.loc, thread_id="99")
    await env.inbound("are you there?")
    held = _held(calls)
    assert held["text"] == mgr_mod.MSG_HELD_BY_PROMPT.format(how=f"回覆 <選項編號> {rid}")
    assert not held["buttons"] and "reply_to" not in held


def test_held_text_clips_a_long_prompt() -> None:
    from agent_team_backend.channels.base import Location

    req = relay.RelayRequest("abcde", "p", "question", ["A", "B"], Location("telegram", "default", "1"),
                             prompt="x" * 2000)
    text = relay.held_text(req)
    assert len(text) < 600 and text.endswith("回覆 <選項編號> abcde") and "1. A" in text

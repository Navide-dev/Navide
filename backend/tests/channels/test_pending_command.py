"""/pending: list this chat's prompts that are waiting for an answer, each sent
again with its buttons, so a busy chat that scrolled past them can answer from
the newest message. The re-sent message becomes the prompt's live one; the
earlier one drops its buttons."""

from __future__ import annotations

import dataclasses
from typing import Any

from agent_team_backend.channels import manager as mgr_mod
from agent_team_backend.channels import relay

from .test_manager import (  # noqa: F401 — fixtures and helpers shared with the manager suite
    Env, _awaiting, _prompt_message, _relay_id, _until, _until_relay_prompt, env, fast_timers,
)


def _capture(env: Env) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []
    orig = env.tg.send_text

    async def send_text(loc, text, *, buttons=None):
        calls.append({"text": text, "buttons": buttons, "id": str(len(env.tg.sent) + 1)})
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


async def test_pending_resends_the_waiting_prompt_with_its_buttons(env: Env) -> None:
    calls = _capture(env)
    rid = await _question(env, ["Keep", "Discard"])
    old_id, old_text = _prompt_message(env)
    await env.inbound("/pending")
    listed = calls[-1]
    assert "Pick one" in listed["text"] and "1. Keep" in listed["text"] and "2. Discard" in listed["text"]
    assert listed["buttons"] == [("1. Keep", f"nv1:{rid}:1"), ("2. Discard", f"nv1:{rid}:2")]
    assert env.m.relay.get(rid).message_id == listed["id"]
    # The earlier copy drops its buttons and points at the new one.
    await _until(lambda: (old_id, f"{old_text}\n\n{mgr_mod.MSG_PENDING_RELISTED}") in env.tg.edits)
    assert env.fake.delivered[-1][1] == "go"  # the command was not sent to the pane


async def test_a_relisted_prompt_answers_and_settles_the_new_message(env: Env) -> None:
    calls = _capture(env)
    rid = await _question(env, ["Keep", "Discard"])
    await env.inbound("/pending")
    new_id, new_text = calls[-1]["id"], calls[-1]["text"]
    await env.inbound("", callback=f"nv1:{rid}:2")
    assert env.fake.answers == [("pane-1", {"kind": "question", "option": 2})]
    note = f"{mgr_mod.MSG_RELAY_ANSWERED_IN_CHAT}選項 2"
    await _until(lambda: (new_id, f"{new_text}\n\n{note}") in env.tg.edits)


async def test_pending_with_nothing_waiting_says_so(env: Env) -> None:
    await env.inbound("/pending")
    assert env.tg.texts()[-1] == mgr_mod.MSG_PENDING_NONE
    assert env.fake.delivered == []


async def test_pending_lists_only_this_chats_prompts(env: Env) -> None:
    rid = await _question(env, ["Keep", "Discard"])
    req = env.m.relay.get(rid)
    req.loc = dataclasses.replace(req.loc, thread_id="99")  # relayed to another topic
    await env.inbound("/pending")
    assert env.tg.texts()[-1] == mgr_mod.MSG_PENDING_NONE


def test_pending_command_parsing() -> None:
    assert relay.is_pending_command("/pending")
    assert relay.is_pending_command(" /PENDING ")
    assert relay.is_pending_command("/pending@navide_bot", "@navide_bot")
    assert not relay.is_pending_command("/pending@other_bot", "@navide_bot")
    assert not relay.is_pending_command("/pending now")
    assert not relay.is_pending_command("pending")
    assert relay.is_pending_command("<@U123> /pending")  # Slack/Discord mention
    assert relay.is_pending_command("@navide_bot /pending", "@navide_bot")

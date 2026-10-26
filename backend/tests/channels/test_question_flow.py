"""A pane that stops to ask something stays answerable from the chat: retries after
a bad answer, follow-up questions, bare answers, and prompts the chat cannot answer."""

from __future__ import annotations

import asyncio

from .test_manager import (  # noqa: F401 — fixtures and helpers shared with the manager suite
    Env, _awaiting, _relay_id, _until, _until_relay_prompt, clocked, env, fast_timers,
)


def _prompts(env: Env) -> list[str]:
    return [t for t in env.tg.texts() if t.startswith("⏸")]


def _set_status(env: Env, status: str) -> None:
    env.fake.states["pane-1"] = {"exists": True, "busy": True, "display_status": status}
    env.m.mirror.on_status("pane-1")


# --- F5: a status change resets the run's own posted flag too ----------------------------


async def test_replies_level_relays_a_prompt_that_follows_a_keyboard_answer(env: Env) -> None:
    assert env.store.set_verbosity("pane-1", "replies") is not None
    await _awaiting(env)
    await _until_relay_prompt(env)
    # Answered at the keyboard, and the same prompt shows up again before the next
    # probe: at "replies" only the probe relays, so it must not think it already did.
    _set_status(env, "running")
    _set_status(env, "awaiting")
    await _until(lambda: len(_prompts(env)) == 2)
    assert len(env.m.relay._by_id) == 1


# --- F1: an answer that was not sent leaves the prompt answerable ----------------------


async def _question(env: Env, options: list[str], prompt: str = "Pick one") -> str:
    env.fake.kind = "permission"  # what Claude's AskUserQuestion box reports
    env.fake.prompt = prompt
    env.fake.options = options
    await _awaiting(env)
    await _until_relay_prompt(env)
    return _relay_id(env)


async def test_a_wrong_option_number_can_be_corrected(env: Env) -> None:
    rid = await _question(env, ["Keep", "Discard"])
    await env.inbound(f"5 {rid}")
    assert env.tg.texts()[-1] == "⚠️ 請回覆有效的選項編號" and env.fake.answers == []
    await env.inbound(f"2 {rid}")
    assert env.fake.answers == [("pane-1", {"kind": "question", "option": 2})]
    assert env.tg.texts()[-1] == "✅ 已送出：選項 2"


async def test_a_failed_send_can_be_retried(env: Env) -> None:
    rid = await _question(env, ["Keep", "Discard"])
    env.fake.answer_result = {"ok": False, "error": "the window did not answer"}
    await env.inbound(f"1 {rid}")
    assert env.tg.texts()[-1] == "⚠️ 送出失敗：the window did not answer"
    env.fake.answer_result = {"ok": True}
    await env.inbound(f"1 {rid}")
    assert env.tg.texts()[-1] == "✅ 已送出：選項 1" and len(env.fake.answers) == 2


async def test_an_answer_to_a_stale_screen_brings_the_current_prompt(env: Env) -> None:
    rid = await _question(env, ["Keep", "Discard"], prompt="Old question")
    env.fake.prompt = "New question"
    await env.inbound(f"1 {rid}")
    assert env.fake.answers == []
    await _until(lambda: any("New question" in t for t in _prompts(env)))
    new_rid = _relay_id(env)
    assert new_rid != rid and len(env.m.relay._by_id) == 1
    await env.inbound(f"1 {new_rid}")
    assert env.fake.answers == [("pane-1", {"kind": "question", "option": 1})]


async def test_a_stale_answer_relays_the_current_prompt_exactly_once(env: Env) -> None:
    # Two paths relay the current prompt after a stale answer: the answer's follow-up
    # and the run's awaiting probe. Hold the probe so the follow-up gets there first,
    # then let one probe tick land before the chat answers the prompt it was shown.
    probe = env.m._check_awaiting
    held = False

    async def check_awaiting(adapter, pane_id, pending):
        if not held:
            await probe(adapter, pane_id, pending)

    env.m._check_awaiting = check_awaiting
    rid = await _question(env, ["Keep", "Discard"], prompt="Old question")
    env.fake.prompt = "New question"
    held = True
    await env.inbound(f"1 {rid}")
    await _until(lambda: any("New question" in t for t in _prompts(env))
                 and env.m._awaiting_shown["pane-1"].prompt == "New question")
    new_rid = _relay_id(env)
    await probe(env.tg, "pane-1", env.m._pending["pane-1"])
    assert sum("New question" in t for t in _prompts(env)) == 1
    await env.inbound(f"1 {new_rid}")
    assert env.fake.answers == [("pane-1", {"kind": "question", "option": 1})]


def _capture_buttons(env: Env) -> list:
    sent: list = []
    orig = env.tg.send_text

    async def capture(loc, text, *, buttons=None):
        sent.append((text, buttons))
        return await orig(loc, text, buttons=buttons)

    env.tg.send_text = capture
    return sent


# --- F7: a plain-text question is answered by typing, not through the relay -------------


async def test_a_plain_text_question_gets_no_relay_prompt(env: Env) -> None:
    env.fake.kind = "question"
    env.fake.prompt = "Should I also update the docs?"
    env.fake.options = []
    await _awaiting(env)
    await asyncio.sleep(0.2)
    assert _prompts(env) == [] and env.m.relay._by_id == {}
    await env.inbound("yes please")
    assert env.fake.delivered[-1][1] == "yes please"


# --- F6: a vendor Navide cannot answer for is told to the chat, without buttons ---------


async def test_an_unanswerable_vendor_gets_a_notice_without_buttons(env: Env) -> None:
    sent = _capture_buttons(env)
    orig = env.fake.awaiting_info

    async def info(pane_id):
        return {**await orig(pane_id), "answerable": False}

    env.m._seams.awaiting_info = info
    await _awaiting(env)
    await _until(lambda: any("pane 在等確認，請在電腦上回答" in t for t, _ in sent))
    notice = next((t, b) for t, b in sent if "請在電腦上回答" in t)
    assert notice == ("pane 在等確認，請在電腦上回答", None)
    assert env.m.relay._by_id == {}


# --- F4: multi-select and free-text questions are answered from the chat ---------------

_CHECKS = ["[ ] Lint", "[ ] Unit tests", "[ ] Type something", "Chat about this"]


async def _multi(env: Env, options: list[str] = _CHECKS) -> str:
    return await _question(env, options, prompt="Which checks should run?")


async def test_a_multi_select_question_is_relayed_with_how_to_pick_several(env: Env) -> None:
    sent = _capture_buttons(env)
    rid = await _multi(env)
    text, buttons = next((t, b) for t, b in sent if t.startswith("⏸"))
    # Tick buttons for the boxes (not the free-text row, which needs its text), then 送出.
    assert buttons == [("☐ 1. Lint", f"nv1:{rid}:t1"), ("☐ 2. Unit tests", f"nv1:{rid}:t2"),
                       ("送出", f"nv1:{rid}:s")]
    assert "1. [ ] Lint" in text and "3. [ ] Type something" in text
    assert f"1,2 {rid}" in text and f"3 {rid} <你的文字>" in text
    assert "電腦上操作" not in text


async def _press(env: Env, data: str, *, sender: str = "7", chat: str = "-100") -> None:
    await env.inbound("", callback=data, sender=sender, chat=chat)


async def test_box_buttons_tick_untick_and_send_the_ticked_boxes(env: Env) -> None:
    rid = await _multi(env)
    await _press(env, f"nv1:{rid}:t1")
    await _press(env, f"nv1:{rid}:t2")
    await _press(env, f"nv1:{rid}:t1")  # untick
    assert env.fake.answers == []  # nothing reaches the pane before 送出
    labels = [label for label, _ in env.tg.button_edits[-1][1]]
    assert labels == ["☐ 1. Lint", "✓ 2. Unit tests", "送出"]
    await _press(env, f"nv1:{rid}:s")
    assert env.fake.answers == [("pane-1", {"kind": "multi", "options": [2]})]
    assert env.tg.texts()[-1] == "✅ 已送出：選項 2"
    assert env.m.relay.get(rid) is None  # used up


async def test_send_with_nothing_ticked_sends_nothing(env: Env) -> None:
    rid = await _multi(env)
    await _press(env, f"nv1:{rid}:s")
    assert env.fake.answers == [] and env.tg.texts()[-1] == "⚠️ 請先勾選至少一個選項，再按「送出」"
    assert env.m.relay.get(rid) is not None


async def test_boxes_ticked_on_screen_start_ticked(env: Env) -> None:
    rid = await _multi(env, ["[✔] Lint", "[ ] Unit tests", "[ ] Type something"])
    await _press(env, f"nv1:{rid}:t2")
    await _press(env, f"nv1:{rid}:s")
    assert env.fake.answers == [("pane-1", {"kind": "multi", "options": [1, 2]})]


async def test_a_permanent_or_free_text_box_cannot_be_ticked(env: Env) -> None:
    rid = await _multi(env, ["[ ] Lint", "[ ] Always run all checks", "[ ] Type something"])
    for n in (2, 3, 9):
        await _press(env, f"nv1:{rid}:t{n}")
        assert env.tg.texts()[-1].startswith("⚠️ 請回覆有效的選項編號")
    assert env.tg.button_edits == [] and env.m.relay.get(rid).ticked == set()


async def test_box_buttons_only_work_for_the_bound_user_in_the_prompt_chat(env: Env) -> None:
    rid = await _multi(env)
    await _press(env, f"nv1:{rid}:t1", sender="99")  # a stranger in the group
    await _press(env, f"nv1:{rid}:t1", chat="-200")  # the id, pressed from another chat
    assert env.m.relay.get(rid).ticked == set() and env.tg.button_edits == []
    await _press(env, "nv1:zzzzz:s")  # a forged id answers nothing
    assert env.fake.answers == []


async def test_ticks_die_with_the_request(env: Env) -> None:
    rid = await _multi(env)
    await _press(env, f"nv1:{rid}:t1")
    _set_status(env, "running")  # the prompt left the screen
    await _until(lambda: env.m.relay.get(rid) is None)
    await _press(env, f"nv1:{rid}:s")
    assert env.fake.answers == []


async def test_several_options_are_picked_with_a_comma_list(env: Env) -> None:
    rid = await _multi(env)
    await env.inbound(f"2, 1 {rid}")
    assert env.fake.answers == [("pane-1", {"kind": "multi", "options": [1, 2]})]
    assert env.tg.texts()[-1] == "✅ 已送出：選項 1、2"


async def test_a_multi_select_answer_can_carry_the_free_text(env: Env) -> None:
    rid = await _multi(env)
    await env.inbound(f"1,3 {rid} also run the docs build")
    assert env.fake.answers == [
        ("pane-1", {"kind": "multi", "options": [1, 3], "text": "also run the docs build"})]
    assert env.tg.texts()[-1] == "✅ 已送出：選項 1、3（含自由輸入）"


async def test_free_text_needs_its_own_option_in_a_multi_select(env: Env) -> None:
    rid = await _multi(env)
    await env.inbound(f"1 {rid} some text")  # text, but the free-text row is not picked
    await env.inbound(f"1,3 {rid}")  # the free-text row, but no text
    await env.inbound(f"1,4 {rid}")  # "Chat about this" is not a box
    assert env.fake.answers == []
    assert env.tg.texts()[-1].startswith("⚠️")
    assert env.m.relay.get(rid) is not None  # still answerable


async def test_a_bare_comma_list_answers_the_only_multi_select(env: Env) -> None:
    await _multi(env)
    await env.inbound("1,2")
    assert env.fake.answers == [("pane-1", {"kind": "multi", "options": [1, 2]})]


async def test_a_permanent_allow_box_is_never_picked_from_chat(env: Env) -> None:
    rid = await _multi(env, ["[ ] Lint", "[ ] Always run all checks", "[ ] Type something"])
    await env.inbound(f"1,2 {rid}")
    assert env.fake.answers == []


async def test_a_free_text_row_takes_the_text_after_the_id(env: Env) -> None:
    sent = _capture_buttons(env)
    rid = await _question(env, ["Keep", "Discard", "Type something."])
    text, buttons = next((t, b) for t, b in sent if t.startswith("⏸"))
    assert [label for label, _ in buttons] == ["1. Keep", "2. Discard"]
    assert "3. Type something." in text and f"3 {rid} <你的文字>" in text
    await env.inbound(f"3 {rid}")
    assert env.fake.answers == [] and f"3 {rid} <你的文字>" in env.tg.texts()[-1]
    await env.inbound(f"3 {rid} keep both, merge later")
    assert env.fake.answers == [
        ("pane-1", {"kind": "question", "option": 3, "text": "keep both, merge later"})]
    assert env.tg.texts()[-1] == "✅ 已送出：選項 3（自由輸入）"


async def test_a_long_free_text_reaches_the_pane_whole(env: Env) -> None:
    rid = await _question(env, ["Keep", "Discard", "Type something."])
    long = " ".join(["word"] * 1200)
    await env.inbound(f"3 {rid} {long}")
    assert env.fake.answers == [("pane-1", {"kind": "question", "option": 3, "text": long})]


async def test_invisible_characters_are_dropped_from_free_text(env: Env) -> None:
    rid = await _question(env, ["Keep", "Discard", "Type something."])
    await env.inbound(f"3 {rid} a\u202eb\u200bc\ufeff\u2066d\u2028e")
    assert env.fake.answers == [("pane-1", {"kind": "question", "option": 3, "text": "abcd e"})]


async def test_a_bare_free_text_answer_needs_the_free_text_row(env: Env) -> None:
    await _question(env, ["Keep", "Discard", "Type something."])
    await env.inbound("2 and also something")  # option 2 takes no text: not an answer
    assert env.fake.answers == []
    await env.inbound("3 keep both")
    assert env.fake.answers == [("pane-1", {"kind": "question", "option": 3, "text": "keep both"})]


async def test_text_after_yes_is_not_a_relay_answer(env: Env) -> None:
    env.fake.kind, env.fake.prompt, env.fake.options = "permission", "Run it?", ["Yes", "No"]
    await _awaiting(env)
    await _until_relay_prompt(env)
    rid = _relay_id(env)
    await env.inbound(f"yes {rid} and more")
    assert env.fake.answers == []


# --- F2: the next question, and a prompt whose id ran out, reach the chat ---------------


async def test_the_second_question_is_relayed_after_the_first_is_answered(env: Env) -> None:
    rid = await _question(env, ["Red", "Blue"], prompt="Q1: which color?")
    await env.inbound(f"1 {rid}")
    assert env.tg.texts()[-1] == "✅ 已送出：選項 1"
    env.fake.prompt, env.fake.options = "Q2: which size?", ["Small", "Large"]  # still awaiting
    await _until(lambda: any("Q2: which size?" in t for t in _prompts(env)))
    rid2 = _relay_id(env)
    assert rid2 != rid
    await env.inbound(f"2 {rid2}")
    assert env.fake.answers[-1] == ("pane-1", {"kind": "question", "option": 2})


async def test_consecutive_permission_prompts_are_each_relayed(env: Env) -> None:
    env.fake.options = ["Yes", "Yes, and don't ask again", "No"]
    env.fake.prompt = "Allow Bash(npm test)?"
    await _awaiting(env)
    await _until_relay_prompt(env)
    await env.inbound(f"yes {_relay_id(env)}")
    env.fake.prompt = "Allow Bash(npm run lint)?"
    await _until(lambda: any("npm run lint" in t for t in _prompts(env)))
    await env.inbound(f"yes {_relay_id(env)}")
    assert [a for _, a in env.fake.answers] == [{"kind": "permission", "choice": "allow"}] * 2


async def test_an_answered_prompt_still_on_screen_is_not_posted_again(env: Env) -> None:
    rid = await _question(env, ["Keep", "Discard"])
    await env.inbound(f"1 {rid}")
    await asyncio.sleep(0.2)  # the screen has not redrawn yet: same prompt, still awaiting
    assert len(_prompts(env)) == 1


async def test_a_prompt_is_relayed_again_after_its_id_expires(clocked) -> None:
    env, clock = clocked
    await _awaiting(env)
    clock.t += 1
    await _until_relay_prompt(env)
    rid = _relay_id(env)
    clock.t += 1801  # past the relay TTL and the run watch, still awaiting
    await _until(lambda: len(_prompts(env)) == 2)
    assert _relay_id(env) != rid and len(env.m.relay._by_id) == 1


# --- F3: a bare answer reaches the prompt; other text is not queued behind it ------------


async def test_a_bare_option_number_answers_the_only_live_prompt(env: Env) -> None:
    await _question(env, ["Keep", "Discard"])
    delivered = len(env.fake.delivered)
    await env.inbound("2")
    assert env.fake.answers == [("pane-1", {"kind": "question", "option": 2})]
    assert env.tg.texts()[-1] == "✅ 已送出：選項 2" and len(env.fake.delivered) == delivered


async def test_a_bare_yes_answers_a_permission_prompt(env: Env) -> None:
    await _awaiting(env)
    await _until_relay_prompt(env)
    await env.inbound("y")
    assert env.fake.answers == [("pane-1", {"kind": "permission", "choice": "allow"})]


async def test_text_to_a_pane_waiting_on_a_prompt_is_answered_not_queued(env: Env) -> None:
    rid = await _question(env, ["Keep", "Discard"])
    delivered = len(env.fake.delivered)
    await env.inbound("what do you mean?")
    assert len(env.fake.delivered) == delivered and env.fake.answers == []
    assert "沒有送出" in env.tg.texts()[-1] and rid in env.tg.texts()[-1]


async def test_a_bare_answer_with_two_live_prompts_is_not_guessed(env: Env) -> None:
    await _question(env, ["Keep", "Discard"])
    env.m.relay.create("pane-2", "question", ["A", "B"], env.m.relay.for_pane("pane-1")[0].loc)
    delivered = len(env.fake.delivered)
    await env.inbound("1")
    assert env.fake.answers == [] and len(env.fake.delivered) == delivered
    assert "沒有送出" in env.tg.texts()[-1]


async def test_a_bare_answer_with_nothing_to_answer_is_not_queued(env: Env) -> None:
    orig = env.fake.awaiting_info

    async def info(pane_id):
        return {**await orig(pane_id), "answerable": False}

    env.m._seams.awaiting_info = info
    await _awaiting(env)
    await _until(lambda: any("請在電腦上回答" in t for t in env.tg.texts()))
    delivered = len(env.fake.delivered)
    await env.inbound("1")
    assert len(env.fake.delivered) == delivered and env.fake.answers == []
    assert "請在電腦上回答" in env.tg.texts()[-1] and "沒有送出" in env.tg.texts()[-1]


async def test_a_prompt_left_by_a_status_change_is_settled_in_the_chat(env: Env) -> None:
    # The status event usually beats the run's probe to it: that path must settle
    # the chat's prompt (and drop its buttons) too.
    from agent_team_backend.channels import manager as mgr_mod

    await _awaiting(env)
    await _until_relay_prompt(env)
    i = max(n for n, t in enumerate(env.tg.texts()) if t.startswith("⏸"))
    mid, text = str(i + 1), env.tg.texts()[i]
    _set_status(env, "running")
    await _until(lambda: any(m == mid for m, _ in env.tg.edits))
    assert (mid, f"{text}\n\n{mgr_mod.MSG_RELAY_DONE_LOCALLY}") in env.tg.edits

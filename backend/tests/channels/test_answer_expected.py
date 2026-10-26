"""A chat answer is bound to the prompt and menu the chat was shown, exactly as
cli_answer_prompt binds an agent's answer: the window presses only while that
same prompt is on screen, and a prompt that changed is refused with a message
asking the chat to pick again from the new one."""

from __future__ import annotations

import time
from typing import Any

import pytest

from agent_team_backend import agent_messaging
from agent_team_backend.channels import default_seams
from agent_team_backend.channels import manager as mgr_mod
from agent_team_backend.channels.base import InboundMessage
from agent_team_backend.mcp_server import server as plan_mcp

from .test_manager import (  # noqa: F401 — fixtures and helpers shared with the manager suite
    Env, _awaiting, _prompt_message, _relay_id, _until, _until_relay_prompt, env, fast_timers,
)


async def _question(env: Env, options: list[str], prompt: str = "Pick one") -> str:
    env.fake.kind = "permission"  # what Claude's AskUserQuestion box reports
    env.fake.prompt = prompt
    env.fake.options = options
    await _awaiting(env)
    await _until_relay_prompt(env)
    return _relay_id(env)


async def _press(env: Env, data: str) -> None:
    await env.m.handle_inbound(InboundMessage(
        platform="telegram", account="default", chat_id="-100", thread_id="50", sender_id="7",
        sender_name="alice", text="", message_id="cb:1", is_direct=False, ts=time.time(),
        callback_data=data))
    await env.m.wait_idle()


async def test_a_text_answer_carries_the_prompt_and_menu_it_was_shown(env: Env) -> None:
    rid = await _question(env, ["Keep", "Discard"])
    await env.inbound(f"2 {rid}")
    assert env.fake.answers == [("pane-1", {"kind": "question", "option": 2})]
    assert env.fake.expected == [{"prompt": "Pick one", "options": ["Keep", "Discard"]}]


async def test_a_button_answer_carries_the_prompt_and_menu_it_was_shown(env: Env) -> None:
    rid = await _question(env, ["Keep", "Discard"])
    await _press(env, f"nv1:{rid}:1")
    assert env.fake.expected == [{"prompt": "Pick one", "options": ["Keep", "Discard"]}]


async def test_a_menu_that_changed_under_the_same_prompt_is_refused(env: Env) -> None:
    rid = await _question(env, ["Keep", "Discard"])
    mid, text = _prompt_message(env)
    env.fake.options = ["Discard", "Keep"]  # same question, reordered menu
    await env.inbound(f"1 {rid}")
    assert env.fake.answers == []
    # The current prompt is relayed again right after; on a slow runner it may already be in.
    assert mgr_mod.MSG_RELAY_PROMPT_CHANGED in env.tg.texts()
    assert rid not in env.m.relay._by_id  # stale: the old id cannot be retried
    await _until(lambda: (mid, f"{text}\n\n{mgr_mod.MSG_RELAY_SUPERSEDED}") in env.tg.edits)


async def test_the_window_refusing_a_changed_prompt_asks_to_pick_again(env: Env) -> None:
    rid = await _question(env, ["Keep", "Discard"])
    mid, text = _prompt_message(env)
    # The screen changed between the backend's check and the window's key press.
    env.fake.answer_result = {"ok": False, "error": "the prompt on screen changed since it was checked",
                              "error_code": "prompt-changed"}
    await _press(env, f"nv1:{rid}:2")
    # The current prompt is relayed again right after; on a slow runner it may already be in.
    assert mgr_mod.MSG_RELAY_PROMPT_CHANGED in env.tg.texts()
    assert rid not in env.m.relay._by_id
    await _until(lambda: (mid, f"{text}\n\n{mgr_mod.MSG_RELAY_SUPERSEDED}") in env.tg.edits)


async def test_another_send_failure_still_leaves_the_prompt_answerable(env: Env) -> None:
    rid = await _question(env, ["Keep", "Discard"])
    env.fake.answer_result = {"ok": False, "error": "the window did not answer"}
    await env.inbound(f"2 {rid}")
    assert env.tg.texts()[-1] == "⚠️ 送出失敗：the window did not answer"
    assert rid in env.m.relay._by_id


# --- the seam itself: what reaches ui.pane.sendKeys ----------------------------------


class _Window:
    def __init__(self, result: dict[str, Any]) -> None:
        self.sent: list[dict[str, Any]] = []
        self.result = result

    async def __call__(self, workspace_path: str, op: str, **kwargs: Any) -> dict[str, Any]:
        assert kwargs.get("action") == "ui.pane.sendKeys"
        self.sent.append(kwargs["args"])
        return {"ok": True, "result": self.result}


@pytest.fixture
def _pane() -> Any:
    agent_messaging._reset_for_test()
    agent_messaging.register("pw", "worker", "/ws/alpha", agent_key="claude")
    yield
    agent_messaging._reset_for_test()


async def test_the_seam_passes_expected_to_the_window(_pane, monkeypatch: pytest.MonkeyPatch) -> None:
    window = _Window({"ok": True, "sent": True})
    monkeypatch.setattr(plan_mcp, "_ui_request", window)
    expected = {"prompt": "Pick one", "options": ["Keep", "Discard"]}
    out = await default_seams().answer("pw", {"kind": "question", "option": 2}, expected)
    assert out == {"ok": True}
    assert window.sent == [{"paneId": "pw", "answer": {"kind": "question", "option": 2}, "expected": expected}]


async def test_the_seam_reports_the_windows_prompt_changed_code(_pane, monkeypatch: pytest.MonkeyPatch) -> None:
    window = _Window({"ok": False, "error": "the prompt on screen changed since it was checked",
                      "errorCode": "prompt-changed"})
    monkeypatch.setattr(plan_mcp, "_ui_request", window)
    out = await default_seams().answer("pw", {"kind": "permission", "choice": "allow"},
                                       {"prompt": "p", "options": []})
    assert out["ok"] is False and out["error_code"] == "prompt-changed"


async def test_the_seam_without_expected_keeps_the_old_args(_pane, monkeypatch: pytest.MonkeyPatch) -> None:
    window = _Window({"ok": True, "sent": True})
    monkeypatch.setattr(plan_mcp, "_ui_request", window)
    await default_seams().answer("pw", {"kind": "permission", "choice": "deny"})
    assert window.sent == [{"paneId": "pw", "answer": {"kind": "permission", "choice": "deny"}}]

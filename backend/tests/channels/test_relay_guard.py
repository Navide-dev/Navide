"""Phase C: Navide Guard vetoes chat approvals of dangerous prompts, and an
answer only applies to the prompt it was requested for."""

from __future__ import annotations

import time

import pytest

from agent_team_backend.channels import manager as mgr_mod
from agent_team_backend.channels.base import InboundMessage, Location
from agent_team_backend.db import Database
from agent_team_backend.guard import runtime
from agent_team_backend.guard.store import GuardStore

from .test_manager import _MIDS, Env, _awaiting, _relay_id, _until, env, fast_timers  # noqa: F401

CRITICAL = "Bash command\n\n  rm -rf ~\n  Clean up\n\nDo you want to proceed?"
HIGH = "Bash command\n\n  git push origin feature\n\nDo you want to proceed?"
NORMAL = "Bash command\n\n  npm test\n\nDo you want to proceed?"


@pytest.fixture(autouse=True)
def guard_store(tmp_path):
    store = GuardStore(Database(tmp_path / "guard.db"))
    runtime.set_store_for_test(store)
    yield store
    runtime.set_store_for_test(None)


async def _request(env: Env, prompt: str, *, kind: str = "permission", options=None) -> str:
    env.fake.prompt = prompt
    env.fake.kind = kind
    env.fake.options = options or []
    await _awaiting(env)
    await _until(lambda: env.m.relay._by_id)
    return _relay_id(env)


async def _press(env: Env, data: str) -> None:
    await env.m.handle_inbound(InboundMessage(
        platform="telegram", account="default", chat_id="-100", thread_id="50", sender_id="7",
        sender_name="alice", text="", message_id=f"cb:{next(_MIDS)}", is_direct=False,
        ts=time.time(), callback_data=data))
    await env.m.wait_idle()


@pytest.mark.parametrize("prompt", [CRITICAL, HIGH])
async def test_remote_allow_of_dangerous_prompt_is_refused(env: Env, guard_store, prompt) -> None:
    rid = await _request(env, prompt)
    await env.inbound(f"yes {rid}")
    assert env.fake.answers == []
    assert env.tg.texts()[-1] == mgr_mod.MSG_RELAY_NEEDS_LOCAL == "⚠️ 這個動作需要在電腦前確認"
    (entry,) = guard_store.audit_list()
    assert entry["source"] == "relay" and entry["action"] == "deny" and entry["pane_id"] == "pane-1"


async def test_chat_approval_is_refused_even_with_guard_switched_off(env: Env, guard_store) -> None:
    guard_store.set_enabled(False)
    rid = await _request(env, CRITICAL)
    await env.inbound(f"yes {rid}")
    assert env.fake.answers == []
    assert env.tg.texts()[-1] == mgr_mod.MSG_RELAY_NEEDS_LOCAL


async def test_remote_deny_always_goes_through(env: Env) -> None:
    rid = await _request(env, CRITICAL)
    await env.inbound(f"no {rid}")
    assert env.fake.answers == [("pane-1", {"kind": "permission", "choice": "deny"})]


async def test_remote_allow_of_normal_prompt_goes_through(env: Env) -> None:
    rid = await _request(env, NORMAL)
    await env.inbound(f"yes {rid}")
    assert env.fake.answers == [("pane-1", {"kind": "permission", "choice": "allow"})]


async def test_question_menu_on_dangerous_prompt(env: Env) -> None:
    rid = await _request(env, CRITICAL, kind="question", options=["Run it", "No, cancel"])
    await _press(env, f"nv1:{rid}:1")
    assert env.fake.answers == [] and env.tg.texts()[-1] == mgr_mod.MSG_RELAY_NEEDS_LOCAL
    rid = await _request_again(env)
    await _press(env, f"nv1:{rid}:2")
    assert env.fake.answers == [("pane-1", {"kind": "question", "option": 2})]


async def _request_again(env: Env) -> str:
    """A fresh request for the same, still-open prompt (the first was consumed)."""
    req = env.m.relay.create("pane-1", env.fake.kind, env.fake.options,
                             Location("telegram", "default", "-100", "50"), prompt=env.fake.prompt)
    return req.id


async def test_answer_is_void_when_the_prompt_changed(env: Env, monkeypatch) -> None:
    rid = await _request(env, NORMAL)

    # The run watch's probe relays the changed prompt on its own; on a loaded
    # runner that lands before or after the answer. Hold it so the answer meets
    # the changed screen through the prompt binding alone.
    async def hold(*_a) -> None:
        return None

    monkeypatch.setattr(env.m, "_check_awaiting", hold)
    env.fake.prompt = "Bash command\n\n  npm run deploy\n\nDo you want to proceed?"
    await env.inbound(f"yes {rid}")
    assert env.fake.answers == []
    assert env.tg.texts()[-1] == mgr_mod.MSG_RELAY_EXPIRED
    # A deny is bound the same way: it must not land on a different prompt.
    rid = await _request_again(env)
    env.fake.prompt = NORMAL
    await env.inbound(f"no {rid}")
    assert env.fake.answers == [] and env.tg.texts()[-1] == mgr_mod.MSG_RELAY_EXPIRED


async def test_unknown_prompt_cannot_be_approved_remotely(env: Env) -> None:
    """The probe gave no prompt text, so the guard cannot screen it: allow is
    refused (relay fails closed), deny still goes through."""
    rid = await _request(env, "")
    await env.inbound(f"yes {rid}")
    assert env.fake.answers == [] and env.tg.texts()[-1] == mgr_mod.MSG_RELAY_NEEDS_LOCAL
    rid = await _request_again(env)
    await env.inbound(f"no {rid}")
    assert env.fake.answers == [("pane-1", {"kind": "permission", "choice": "deny"})]


async def test_guard_error_fails_closed_for_relay(env: Env, monkeypatch) -> None:
    from agent_team_backend.guard import engine

    def boom(*a, **k):
        raise RuntimeError("kaput")

    monkeypatch.setattr(engine, "classify", boom)
    rid = await _request(env, NORMAL)
    await env.inbound(f"yes {rid}")
    assert env.fake.answers == [] and env.tg.texts()[-1] == mgr_mod.MSG_RELAY_NEEDS_LOCAL

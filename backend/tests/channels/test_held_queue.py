"""A chat message that reaches a pane waiting on a permission prompt is kept, not
refused: it goes in once the prompt clears, once, and is dropped (and the chat told)
after HELD_TTL_S. /status is answered by the Host meanwhile and never reaches the pane.
Nothing here can allow a prompt from the chat."""

from __future__ import annotations

import secrets

from agent_team_backend.channels import held
from agent_team_backend.channels import manager as mgr_mod
from agent_team_backend.channels import redact

from .test_manager import (  # noqa: F401 — fixtures and helpers shared with the manager suite
    Env, _awaiting, _relay_id, _until, _until_relay_prompt, clocked, env, fast_timers,
)

ASK = "回報現況"


def _texts_into_pane(env: Env) -> list[str]:
    return [text for _pane, text, _who in env.fake.delivered]


def _idle(env: Env) -> None:
    env.fake.states["pane-1"] = {"exists": True, "busy": False, "display_status": "idle"}


async def _held_one(env: Env) -> None:
    await _awaiting(env)
    await _until_relay_prompt(env)
    await env.inbound(ASK)


async def test_a_message_while_awaiting_is_kept_not_refused(env: Env) -> None:
    await _held_one(env)
    kept = [t for t in env.tg.texts() if t.startswith("📥")]
    assert len(kept) == 1
    assert "第 1 則" in kept[0] and "/status" in kept[0]
    assert "Allow Bash(npm run build)?" in kept[0]  # the prompt is still quoted
    assert not any(t.startswith("⚠️ pane 正在等確認") for t in env.tg.texts())
    assert ASK not in _texts_into_pane(env)


async def test_the_kept_message_carries_deny_but_never_a_new_allow(env: Env) -> None:
    await _awaiting(env)
    await _until_relay_prompt(env)
    rid = _relay_id(env)
    await env.inbound(ASK)
    kept = next(t for t in env.tg.texts() if t.startswith("📥"))
    buttons = env.tg.buttons[kept]
    # The relay's own buttons as they were (deny only where Guard says so), plus a withdraw.
    assert ("拒絕", f"nv1:{rid}:n") in buttons
    assert buttons[-1][1] == mgr_mod.CANCEL_CALLBACK
    assert all(cb.startswith(f"nv1:{rid}:") or cb == mgr_mod.CANCEL_CALLBACK for _label, cb in buttons)


async def test_it_goes_in_once_after_the_prompt_clears(env: Env) -> None:
    await _held_one(env)
    _idle(env)
    await _until(lambda: ASK in _texts_into_pane(env))
    await _until(lambda: any(t.startswith("↪") and ASK in t for t in env.tg.texts()))
    await env.m.wait_idle()
    for _ in range(20):  # several more watch ticks: nothing goes in a second time
        await _until(lambda: True)
    assert _texts_into_pane(env).count(ASK) == 1
    assert env.m._prompt_held.get("pane-1") in (None, [])


async def test_several_go_in_in_order(env: Env) -> None:
    await _held_one(env)
    await env.inbound("second")
    assert any("第 2 則" in t for t in env.tg.texts())
    _idle(env)
    await _until(lambda: "second" in _texts_into_pane(env))
    sent = _texts_into_pane(env)
    assert sent.index(ASK) < sent.index("second")


async def test_past_its_ttl_it_is_dropped_and_the_chat_told(clocked) -> None:
    env, clock = clocked
    # No run here: with the clock frozen its awaiting probe would never come round again.
    env.fake.states["pane-1"] = {"exists": True, "busy": True, "display_status": "awaiting"}
    await env.inbound(ASK)
    assert any(t.startswith("📥") for t in env.tg.texts())
    clock.t += held.HELD_TTL_S + 1
    await _until(lambda: any(t.startswith("⌛") and ASK in t for t in env.tg.texts()))
    _idle(env)
    await env.inbound("later")  # a fresh message still goes straight in
    await _until(lambda: "later" in _texts_into_pane(env))
    assert ASK not in _texts_into_pane(env)


async def test_a_bare_yes_with_no_live_prompt_is_not_kept(env: Env) -> None:
    env.fake.states["pane-1"] = {"exists": True, "busy": True, "display_status": "awaiting"}
    await env.inbound("yes")
    assert any(t.startswith("⚠️ pane 正在等確認") for t in env.tg.texts())
    assert not env.m._prompt_held.get("pane-1")
    _idle(env)
    await env.inbound("next")
    await _until(lambda: "next" in _texts_into_pane(env))
    assert "yes" not in _texts_into_pane(env)


async def test_cancel_withdraws_what_was_kept(env: Env) -> None:
    await _held_one(env)
    await env.inbound("/cancel")
    assert mgr_mod.MSG_CANCELLED.format(n=1) in env.tg.texts()
    _idle(env)
    await env.inbound("after")
    await _until(lambda: "after" in _texts_into_pane(env))
    assert ASK not in _texts_into_pane(env)


async def test_the_keep_is_bounded(env: Env, monkeypatch) -> None:
    monkeypatch.setattr(held, "HELD_MAX", 1)
    await _held_one(env)
    await env.inbound("one too many")
    assert any(t.startswith("⚠️") and "1 則" in t and "沒有收下" in t for t in env.tg.texts())
    _idle(env)
    await _until(lambda: ASK in _texts_into_pane(env))
    assert "one too many" not in _texts_into_pane(env)


async def test_a_pane_gone_while_awaiting_tells_the_chat(env: Env) -> None:
    await _held_one(env)
    env.fake.gone.add("pane-1")
    await _until(lambda: any(t.startswith("⚠️ pane 已不在線上") and ASK in t for t in env.tg.texts()))
    assert ASK not in _texts_into_pane(env)


async def test_status_while_awaiting_is_answered_by_the_host(env: Env) -> None:
    await _held_one(env)
    await env.inbound("/status")
    status = next(t for t in reversed(env.tg.texts()) if t.startswith("📋"))
    assert "⏸ 等確認 0 分鐘" in status
    assert "📥 待補送 1 則" in status
    assert "/status" not in _texts_into_pane(env)


async def test_status_shows_the_last_output(env: Env) -> None:
    await env.inbound("go")
    env.fake.verdicts["k1"] = {"status": "delivered"}
    await _until(lambda: mgr_mod.MSG_WORKING in env.tg.texts())
    env.turn_complete("pane-1", "Build finished: 3 warnings")
    await _until(lambda: any("Build finished" in t for t in env.tg.texts()))
    await env.inbound("/status")
    status = next(t for t in reversed(env.tg.texts()) if t.startswith("📋"))
    assert "最後輸出：Build finished: 3 warnings" in status
    assert "/status" not in _texts_into_pane(env)


async def test_status_text_follows_the_navide_language(env: Env) -> None:
    env.fake.settings = {"agent-team:language": "en-US"}
    await _held_one(env)
    await env.inbound("/status")
    status = next(t for t in reversed(env.tg.texts()) if t.startswith("📋"))
    assert "📥 1 message(s) to send after it" in status


async def test_status_never_shows_a_piece_of_a_secret_cut_at_the_limit(env: Env, monkeypatch) -> None:
    monkeypatch.setattr(redact._filter, "_secrets", set())
    secret = secrets.token_hex(16)  # built at run time, never a real credential
    redact.add_secret(secret)
    # Raw, the secret straddles the status cut: a cut before redaction would leave its head.
    head = "w" * (mgr_mod.STATUS_LAST_CHARS - 15)
    await env.inbound("go")
    env.fake.verdicts["k1"] = {"status": "delivered"}
    await _until(lambda: mgr_mod.MSG_WORKING in env.tg.texts())
    env.turn_complete("pane-1", f"{head}{secret} done")
    await _until(lambda: any(head in t for t in env.tg.texts()))
    await env.inbound("/status")
    status = next(t for t in reversed(env.tg.texts()) if t.startswith("📋"))
    assert "最後輸出：" in status
    assert not any(secret[i:i + 6] in status for i in range(len(secret) - 5))


def _revoked(env: Env) -> bool:
    return any(t.startswith("⚠️ 這個聊天室已不再連接") and ASK in t for t in env.tg.texts())


async def test_unbinding_while_kept_drops_it(env: Env) -> None:
    await _held_one(env)
    await env.m.unbind("pane-1")
    _idle(env)
    await _until(lambda: _revoked(env))
    for _ in range(20):
        await _until(lambda: True)
    await env.m.wait_idle()
    assert ASK not in _texts_into_pane(env)


async def test_rebinding_while_kept_drops_it(env: Env) -> None:
    await _held_one(env)
    await env.m.rebind("pane-1", "pane-9")
    _idle(env)
    await _until(lambda: _revoked(env))
    await env.m.wait_idle()
    assert ASK not in _texts_into_pane(env)


async def test_a_sender_taken_off_the_allowlist_while_kept_is_not_sent_for(env: Env) -> None:
    await _held_one(env)
    env.store.remove_allow("telegram", "7")
    _idle(env)
    await _until(lambda: _revoked(env))
    await env.m.wait_idle()
    assert ASK not in _texts_into_pane(env)


async def _not_sent_after_clear(env: Env) -> None:
    _idle(env)
    await _until(lambda: not env.m._prompt_held.get("pane-1"))
    for _ in range(20):  # several more watch ticks
        await _until(lambda: True)
    await env.m.wait_idle()
    assert ASK not in _texts_into_pane(env)


async def test_channels_turned_off_while_kept_is_not_sent(env: Env) -> None:
    await _held_one(env)
    await env.m.set_global_enabled(False)
    await _not_sent_after_clear(env)


async def test_the_bot_removed_while_kept_is_not_sent(env: Env) -> None:
    await _held_one(env)
    await env.m.remove("telegram", "default")
    await _not_sent_after_clear(env)


async def test_the_bot_turned_off_while_kept_is_not_sent(env: Env) -> None:
    # Its binding stays; only the bot stops.
    await _held_one(env)
    await env.m.set_enabled("telegram", False)
    await _not_sent_after_clear(env)

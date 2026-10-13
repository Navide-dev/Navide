"""``channels.quick_add``: configure, wait for the platform to accept the credential,
name the bot after its identity and hand back a link invite; any failure leaves no trace."""

from __future__ import annotations

import asyncio

import pytest

from agent_team_backend.channels import manager as mgr_mod
from agent_team_backend.channels import ws_api

from .test_manager import Env, env, fast_timers  # noqa: F401 — fixtures shared with the manager suite

ACCOUNT = "bot-q1"


@pytest.fixture(autouse=True)
def fast_quick_add(monkeypatch):
    monkeypatch.setattr(mgr_mod, "QUICK_ADD_TIMEOUT_S", 0.3)
    monkeypatch.setattr(mgr_mod, "QUICK_ADD_POLL_S", 0.01)


def _login_as(env: Env, behaviour: str, identity: str = "@quick_bot") -> None:
    """Make bots built from now on log in like ``behaviour``: ready / rejected / identified / silent."""
    original = env.m._factory_for

    def factory_for(platform: str):
        build = original(platform)

        def wrapped(config, secret, store):
            ad = build(config, secret, store)

            async def start(emit) -> None:
                ad.emit = emit
                if behaviour == "ready":
                    ad.status.identity = identity
                    ad.status.lifecycle = "ready"
                    ad.status.connected = True
                elif behaviour == "rejected":
                    ad.status.lifecycle = "blocked"
                    ad.status.last_error = "401 Unauthorized"
                elif behaviour == "identified":  # getMe answered, then polling keeps failing (409)
                    ad.identity_confirms_credential = True
                    ad.status.identity = identity
                    ad.status.lifecycle = "recovering"
                    ad.status.last_error = "409 Conflict"
                else:  # silent: connecting forever, the last attempt failed
                    ad.status.lifecycle = "recovering"
                    ad.status.last_error = "ConnectError: unreachable"

            ad.start = start
            return ad
        return wrapped

    env.m._factory_for = factory_for


def _no_trace(env: Env, platform: str = "telegram", account: str = ACCOUNT) -> None:
    assert env.fake.secrets.get(f"channel-{platform}-{account}") is None
    assert (platform, account) not in env.store.accounts()
    assert env.m.adapter_for(platform, account) is None
    assert all(holder != (platform, account) for holder in env.m._lease.values())


async def test_success_names_the_bot_and_returns_a_link(env: Env) -> None:
    _login_as(env, "ready")
    res = await env.m.quick_add("telegram", {}, {"token": "tok-Q"}, ACCOUNT, "direct")
    assert res["ok"], res
    assert res["identity"] == "@quick_bot" and res["name"] == "@quick_bot"
    assert env.store.accounts()[("telegram", ACCOUNT)]["config"]["name"] == "@quick_bot"
    assert env.fake.secrets["channel-telegram-bot-q1"] == '{"token":"tok-Q"}'
    link = res["link"]
    assert link["target"] == "direct" and link["code"] and link["expires_at"] > 0 and "ok" not in link
    # The invite is live: sending it links the chat as it would from the link guide.
    assert env.m.invites.consume("telegram", link["code"], ACCOUNT) is not None


async def test_success_keeps_a_name_the_user_gave(env: Env) -> None:
    _login_as(env, "ready")
    res = await env.m.quick_add("telegram", {"name": "Ops"}, {"token": "tok-Q"}, ACCOUNT)
    assert res["ok"] and res["name"] == "Ops" and res["link"] is None  # no target asked: no invite
    assert env.store.accounts()[("telegram", ACCOUNT)]["config"]["name"] == "Ops"


async def test_rejected_token_leaves_no_trace(env: Env) -> None:
    _login_as(env, "rejected")
    res = await env.m.quick_add("telegram", {}, {"token": "tok-bad"}, ACCOUNT)
    assert res == {"ok": False, "reason": "rejected", "error": "401 Unauthorized"}
    _no_trace(env)
    # The token is free again: the lease went with the bot.
    _login_as(env, "ready")
    assert (await env.m.quick_add("telegram", {}, {"token": "tok-bad"}, ACCOUNT))["ok"]


async def test_timeout_leaves_no_trace(env: Env) -> None:
    _login_as(env, "silent")
    res = await env.m.quick_add("telegram", {}, {"token": "tok-slow"}, ACCOUNT)
    assert not res["ok"] and res["reason"] == "timeout"
    assert "unreachable" in res["error"]
    _no_trace(env)


async def test_duplicate_token_is_refused_before_anything_is_stored(env: Env) -> None:
    # The env's default telegram bot already polls with tok-A.
    res = await env.m.quick_add("telegram", {}, {"token": "tok-A"}, ACCOUNT)
    assert not res["ok"] and res["reason"] == "invalid" and "telegram" in res["error"]
    _no_trace(env)
    assert env.m.adapter_for("telegram").status.lifecycle == "ready"


async def test_an_existing_bot_is_never_quick_added_over(env: Env) -> None:
    res = await env.m.quick_add("telegram", {}, {"token": "tok-other"}, "default")
    assert not res["ok"] and "already configured" in res["error"]
    assert env.fake.secrets["channel-telegram-default"] == '{"token":"tok-A"}'


async def test_channels_turned_off_refuse_before_storing(env: Env) -> None:
    await env.m.set_global_enabled(False)
    res = await env.m.quick_add("telegram", {}, {"token": "tok-Q"}, ACCOUNT)
    assert not res["ok"] and res["reason"] == "invalid"
    _no_trace(env)


async def test_adapter_without_a_login_signal_answers_on_save(env: Env) -> None:
    _login_as(env, "ready")
    original = env.m._factory_for

    def factory_for(platform: str):
        build = original(platform)

        def wrapped(config, secret, store):
            ad = build(config, secret, store)

            async def start(emit) -> None:  # never touches its status
                ad.emit = emit

            ad.start = start
            return ad
        return wrapped

    env.m._factory_for = factory_for
    res = await env.m.quick_add("telegram", {}, {"token": "tok-Q"}, ACCOUNT)
    assert res["ok"] and res["identity"] == "" and res["name"] == ""


async def test_ws_dispatch_routes_quick_add(env: Env) -> None:
    _login_as(env, "ready")
    res = await ws_api._dispatch(env.m, "channels.quick_add", {
        "platform": "telegram", "account": ACCOUNT, "config": {}, "secret": {"token": "tok-Q"},
        "link_target": "direct"})
    assert res["ok"] and res["link"]["code"]
    assert "channels.quick_add" in ws_api.MESSAGE_TYPES
    bad = await ws_api._dispatch(env.m, "channels.quick_add", {"platform": "telegram", "secret": "x"})
    assert bad == {"ok": False, "error": "config and secret must be objects"}


async def test_cancelled_while_waiting_leaves_no_trace(env: Env) -> None:
    # A closed window cancels its in-flight requests: the bot it was adding must go too.
    _login_as(env, "silent")
    task = asyncio.create_task(env.m.quick_add("telegram", {}, {"token": "tok-Q"}, ACCOUNT))
    for _ in range(100):
        if env.m.adapter_for("telegram", ACCOUNT) is not None:
            break
        await asyncio.sleep(0.005)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    for _ in range(100):
        if ("telegram", ACCOUNT) not in env.store.accounts():
            break
        await asyncio.sleep(0.005)
    _no_trace(env)


async def test_failed_secret_delete_still_removes_the_bot(env: Env) -> None:
    _login_as(env, "rejected")
    write = env.fake.write_secret

    async def failing_delete(name: str, secret: str | None) -> None:
        if secret is None:
            raise RuntimeError("keychain unavailable")
        await write(name, secret)

    env.m._seams.write_secret = failing_delete
    res = await env.m.quick_add("telegram", {}, {"token": "tok-bad"}, ACCOUNT)
    assert res == {"ok": False, "reason": "rejected", "error": "401 Unauthorized"}
    assert ("telegram", ACCOUNT) not in env.store.accounts()
    assert env.m.adapter_for("telegram", ACCOUNT) is None
    assert all(holder != ("telegram", ACCOUNT) for holder in env.m._lease.values())


async def test_a_second_quick_add_of_the_same_bot_does_not_break_the_first(env: Env) -> None:
    _login_as(env, "ready")
    write = env.fake.write_secret

    async def keychain_write(name: str, secret: str | None) -> None:
        await asyncio.sleep(0.01)  # the real vault runs in a thread
        await write(name, secret)

    env.m._seams.write_secret = keychain_write
    first, second = await asyncio.gather(
        env.m.quick_add("telegram", {}, {"token": "tok-Q"}, ACCOUNT),
        env.m.quick_add("telegram", {}, {"token": "tok-Q"}, ACCOUNT),
    )
    assert first["ok"], first
    assert not second["ok"] and second["reason"] == "invalid"
    assert ("telegram", ACCOUNT) in env.store.accounts()
    assert env.m.adapter_for("telegram", ACCOUNT).status.lifecycle == "ready"


async def test_an_identity_that_proves_the_credential_counts_without_ready(env: Env) -> None:
    # Telegram's getMe already proved the token; a busy getUpdates must not turn that into a timeout.
    _login_as(env, "identified")
    res = await env.m.quick_add("telegram", {}, {"token": "tok-Q"}, ACCOUNT)
    assert res["ok"], res
    assert res["identity"] == "@quick_bot" and res["name"] == "@quick_bot"


async def test_an_identity_alone_is_not_enough_for_other_adapters(env: Env) -> None:
    # Slack learns its identity from the bot token before the app token is checked.
    _login_as(env, "identified")
    original = env.m._factory_for

    def factory_for(platform: str):
        build = original(platform)

        def wrapped(config, secret, store):
            ad = build(config, secret, store)
            start = ad.start

            async def start_unproven(emit) -> None:
                await start(emit)
                ad.identity_confirms_credential = False

            ad.start = start_unproven
            return ad
        return wrapped

    env.m._factory_for = factory_for
    res = await env.m.quick_add("telegram", {}, {"token": "tok-Q"}, ACCOUNT)
    assert not res["ok"] and res["reason"] == "timeout"
    _no_trace(env)


def test_only_telegram_says_its_identity_proves_the_credential() -> None:
    from agent_team_backend.channels.discord import DiscordAdapter
    from agent_team_backend.channels.slack import SlackAdapter
    from agent_team_backend.channels.telegram import TelegramAdapter

    assert TelegramAdapter.identity_confirms_credential is True
    assert not getattr(SlackAdapter, "identity_confirms_credential", False)
    assert not getattr(DiscordAdapter, "identity_confirms_credential", False)


async def test_a_bot_that_did_not_start_is_not_reported_added(env: Env, monkeypatch) -> None:
    # Channels turned off between the check and the configure: nothing ran, nothing verified.
    _login_as(env, "ready")
    answers = iter([True])
    monkeypatch.setattr(env.store, "global_enabled", lambda: next(answers, False))
    res = await env.m.quick_add("telegram", {}, {"token": "tok-Q"}, ACCOUNT)
    assert not res["ok"] and res["reason"] == "invalid"
    _no_trace(env)


async def test_a_held_channels_lock_ends_in_a_timeout_before_the_window_gives_up(env: Env, monkeypatch) -> None:
    monkeypatch.setattr(mgr_mod, "QUICK_ADD_DEADLINE_S", 0.3)
    _login_as(env, "ready")
    await env.m._lock.acquire()  # another channels operation that never finishes
    try:
        res = await asyncio.wait_for(env.m.quick_add("telegram", {}, {"token": "tok-Q"}, ACCOUNT), 3)
    finally:
        env.m._lock.release()
    assert not res["ok"] and res["reason"] == "timeout"
    await asyncio.sleep(0.05)
    _no_trace(env)
    # Nothing is left half-added: the same bot can be added again.
    assert (await env.m.quick_add("telegram", {}, {"token": "tok-Q"}, ACCOUNT))["ok"]


async def test_a_login_past_the_deadline_is_undone(env: Env, monkeypatch) -> None:
    monkeypatch.setattr(mgr_mod, "QUICK_ADD_TIMEOUT_S", 5.0)
    monkeypatch.setattr(mgr_mod, "QUICK_ADD_DEADLINE_S", 0.3)
    _login_as(env, "silent")
    res = await asyncio.wait_for(env.m.quick_add("telegram", {}, {"token": "tok-slow"}, ACCOUNT), 3)
    assert not res["ok"] and res["reason"] == "timeout"
    for _ in range(100):
        if ("telegram", ACCOUNT) not in env.store.accounts() and env.m.adapter_for("telegram", ACCOUNT) is None:
            break
        await asyncio.sleep(0.02)
    _no_trace(env)


async def test_a_lock_held_while_the_login_waits_does_not_stretch_the_deadline(env: Env, monkeypatch) -> None:
    # The undo needs the channels lock; waiting for it inline kept quick add
    # past its deadline whenever another operation held that lock.
    monkeypatch.setattr(mgr_mod, "QUICK_ADD_TIMEOUT_S", 5.0)
    monkeypatch.setattr(mgr_mod, "QUICK_ADD_DEADLINE_S", 0.3)
    _login_as(env, "silent")
    adding = asyncio.ensure_future(env.m.quick_add("telegram", {}, {"token": "tok-slow"}, ACCOUNT))
    for _ in range(100):
        if ("telegram", ACCOUNT) in env.store.accounts():
            break
        await asyncio.sleep(0.01)
    await env.m._lock.acquire()  # another channels operation, mid-way
    try:
        done, _ = await asyncio.wait({adding}, timeout=1.0)
        assert done, "quick add waited for the lock past its deadline"
        res = adding.result()
        assert not res["ok"] and res["reason"] == "timeout"
    finally:
        env.m._lock.release()
        if not adding.done():
            await adding
    for _ in range(100):
        if ("telegram", ACCOUNT) not in env.store.accounts() and env.m.adapter_for("telegram", ACCOUNT) is None:
            break
        await asyncio.sleep(0.02)
    _no_trace(env)


async def test_a_credential_still_being_stored_at_the_deadline_is_removed_too(env: Env, monkeypatch) -> None:
    # The Keychain write runs in a thread: cancelled at the deadline, the call
    # stops waiting but the write still lands, after the undo found nothing
    # stored. That left the credential in the vault with no bot behind it.
    import time

    monkeypatch.setattr(mgr_mod, "QUICK_ADD_DEADLINE_S", 0.1)
    _login_as(env, "ready")

    async def slow_write(name: str, secret: str | None) -> None:
        def work() -> None:
            time.sleep(0.4)
            env.fake.secrets[name] = secret

        await asyncio.to_thread(work)

    monkeypatch.setattr(env.m._seams, "write_secret", slow_write)
    res = await asyncio.wait_for(env.m.quick_add("telegram", {}, {"token": "tok-K"}, ACCOUNT), 3)
    assert not res["ok"] and res["reason"] == "timeout"
    for _ in range(150):
        if env.fake.secrets.get(f"channel-telegram-{ACCOUNT}", "") is None:
            break
        await asyncio.sleep(0.02)
    _no_trace(env)

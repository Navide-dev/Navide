"""Telegram Managed Bots: ``channels.managed_create`` hands out a t.me/newbot link, and the
manager bot's ``managed_bot`` update turns the created bot into a Navide bot via quick add.

The manager bot is a real ``TelegramAdapter`` polling a fake Bot API; the bots it creates
are fake adapters, so quick add's verification is scripted per test."""

from __future__ import annotations

import asyncio
import re
import time
from typing import Any
from urllib.parse import unquote

import pytest

from agent_team_backend.channels import manager as mgr_mod
from agent_team_backend.channels import ws_api
from agent_team_backend.channels.manager import ChannelManager
from agent_team_backend.channels.store import ChannelStore
from agent_team_backend.channels.telegram import TelegramAdapter
from agent_team_backend.db import Database

from .fake_telegram import FakeBotApi
from .test_manager import FakeAdapter, FakeSeams, fast_timers  # noqa: F401 — shared autouse fixture

MANAGER_TOKEN = "12345:SECRET"
CREATOR = 7  # the Telegram user linked to the manager bot
NEW_BOT = 999


@pytest.fixture(autouse=True)
def fast_managed(monkeypatch):
    monkeypatch.setattr(mgr_mod, "QUICK_ADD_TIMEOUT_S", 0.3)
    monkeypatch.setattr(mgr_mod, "QUICK_ADD_POLL_S", 0.01)


async def _until(pred, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while not pred():
        if time.monotonic() > deadline:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(0.02)


class MEnv:
    def __init__(self, tmp_path, api: FakeBotApi) -> None:
        self.api = api
        self.db = Database(tmp_path / "navide.db")
        self.store = ChannelStore(self.db)
        self.fake = FakeSeams()
        self.created: dict[str, FakeAdapter] = {}  # token -> adapter of a created bot
        # How a created bot's quick add login goes: "ready" or "rejected".
        self.login = "ready"
        self.m = ChannelManager(self.store, self.fake.seams(), factory_for=self._factory_for)

    def _factory_for(self, platform: str):
        def build(config, secret, store):
            token = secret["token"]
            if token == self.api.token:
                return TelegramAdapter(token, account=config["account"], base_url=self.api.base_url,
                                       offset_store=store, backoff=lambda a, r: 0.05, poll_timeout_s=1)
            ad = FakeAdapter(platform, token)
            ad.account = config["account"]
            ad.bot_id = token.split(":", 1)[0]
            login = self.login

            async def start(emit) -> None:
                if login == "ready":
                    ad.status.identity = "@made_bot"
                    ad.status.lifecycle = "ready"
                    ad.status.connected = True
                else:
                    ad.status.lifecycle = "blocked"
                    ad.status.last_error = "401 Unauthorized"

            ad.start = start
            self.created[token] = ad
            return ad
        return build

    @property
    def manager_bot(self) -> TelegramAdapter:
        return self.m.adapter_for("telegram")

    def events(self, kind: str = "channels.managed_created") -> list[dict[str, Any]]:
        return [p for t, p in self.fake.events if t == kind]

    def added_accounts(self) -> list[str]:
        return [a for (p, a) in self.store.accounts() if p == "telegram" and a != "default"]


async def _env(tmp_path, *, can_manage: bool = True):
    api = FakeBotApi(MANAGER_TOKEN, username="navide_bot", can_manage_bots=can_manage)
    api.__enter__()
    api.handlers["getManagedBotToken"] = lambda params: f"{params['user_id']}:NEWSECRET"
    e = MEnv(tmp_path, api)
    await e.m.start()
    assert (await e.m.configure("telegram", {}, {"token": MANAGER_TOKEN}))["ok"]
    await _until(lambda: e.manager_bot.status.lifecycle == "ready")
    e.store.add_allow("telegram", str(CREATOR), "neil", 1)
    return e


@pytest.fixture
async def env(tmp_path):
    e = await _env(tmp_path)
    yield e
    await e.m.stop()
    e.api.__exit__(None, None, None)
    e.db.close()


# --- channels.managed_create ------------------------------------------------------


async def test_create_returns_a_prefilled_newbot_link(env: MEnv) -> None:
    res = env.m.managed_create("default", "my_helper_bot", "Ops & Co")
    assert res["ok"] and res["request_id"]
    assert res["url"] == "https://t.me/newbot/navide_bot/my_helper_bot?name=Ops%20%26%20Co"


async def test_create_defaults_to_a_random_username_and_navide_bot(env: MEnv) -> None:
    first = env.m.managed_create("default")
    second = env.m.managed_create("default")
    m = re.fullmatch(r"https://t\.me/newbot/navide_bot/(navide_bot_[a-z0-9]{4}_bot)\?name=(.+)", first["url"])
    assert m, first["url"]
    assert unquote(m.group(2)) == "Navide bot"
    assert first["request_id"] != second["request_id"]


async def test_create_keeps_the_default_username_within_32_characters(env: MEnv) -> None:
    env.manager_bot.status.identity = "@" + "a" * 32
    res = env.m.managed_create("default")
    username = res["url"].split("/")[5].split("?")[0]
    assert len(username) == 32 and username.endswith("_bot")


async def test_create_needs_bot_management_mode(tmp_path) -> None:
    e = await _env(tmp_path, can_manage=False)
    try:
        res = e.m.managed_create("default")
        assert not res["ok"] and "Bot Management Mode" in res["error"]
    finally:
        await e.m.stop()
        e.api.__exit__(None, None, None)
        e.db.close()


async def test_create_refuses_a_manager_no_user_is_linked_to(env: MEnv) -> None:
    env.store.remove_allow("telegram", str(CREATOR))
    # A user linked to another bot does not count for this one.
    env.store.add_allow("telegram", str(CREATOR), "neil", 1, "bot-other")
    res = env.m.managed_create("default")
    assert not res["ok"] and res["reason"] == "manager_not_linked"
    assert "linked" in res["error"]
    assert env.m._managed == {}  # noqa: SLF001


async def test_create_refuses_an_unknown_manager_and_a_bad_username(env: MEnv) -> None:
    assert not env.m.managed_create("bot-nope")["ok"]
    res = env.m.managed_create("default", "bad/name")
    assert not res["ok"] and "username" in res["error"]


async def test_ws_dispatch_routes_managed_create(env: MEnv) -> None:
    assert "channels.managed_create" in ws_api.MESSAGE_TYPES
    res = await ws_api._dispatch(env.m, "channels.managed_create",
                                 {"manager_account": "default", "username": "x_bot", "name": "X"})
    assert res["ok"] and res["url"] == "https://t.me/newbot/navide_bot/x_bot?name=X"


# --- the managed_bot update ------------------------------------------------------------


async def test_a_matching_update_adds_the_new_bot_through_quick_add(env: MEnv) -> None:
    req = env.m.managed_create("default", "made_bot")
    env.api.push_managed_bot(creator_id=CREATOR, bot_id=NEW_BOT, bot_username="made_bot")
    await _until(lambda: env.events())
    assert env.api.calls_of("getManagedBotToken") == [{"user_id": NEW_BOT}]
    [event] = env.events()
    [account] = env.added_accounts()
    assert event["request_id"] == req["request_id"] and event["ok"] is True
    assert event["account"] == account and event["name"] == "@made_bot"
    assert event["link"]["target"] == "direct" and event["link"]["code"]
    assert env.fake.secrets[f"channel-telegram-{account}"] == f'{{"token":"{NEW_BOT}:NEWSECRET"}}'
    assert env.store.accounts()[("telegram", account)]["config"]["name"] == "@made_bot"
    # The request is spent: a second update for it does nothing.
    env.api.push_managed_bot(creator_id=CREATOR, bot_id=NEW_BOT + 1)
    await asyncio.sleep(0.5)
    assert len(env.events()) == 1 and len(env.api.calls_of("getManagedBotToken")) == 1


async def test_a_bot_created_by_someone_not_linked_answers_the_request_at_once(env: MEnv) -> None:
    req = env.m.managed_create("default", "made_bot")
    env.api.push_managed_bot(creator_id=CREATOR + 1, bot_id=NEW_BOT, bot_username="made_bot")
    await _until(lambda: env.events())
    [event] = env.events()
    # The bot exists in Telegram, so the window must not wait out the request and retry.
    assert event["request_id"] == req["request_id"] and event["ok"] is False
    assert event["reason"] == "creator_not_linked" and event["created"] is True
    assert not env.api.calls_of("getManagedBotToken") and not env.added_accounts()
    assert req["request_id"] not in env.m._managed
    # The request is spent: a later bot for it does nothing.
    env.api.push_managed_bot(creator_id=CREATOR, bot_id=NEW_BOT + 1)
    polls = len(env.api.calls_of("getUpdates"))
    await _until(lambda: len(env.api.calls_of("getUpdates")) > polls + 3)
    assert len(env.events()) == 1 and not env.api.calls_of("getManagedBotToken")


async def test_an_update_without_a_pending_request_is_ignored(env: MEnv) -> None:
    env.api.push_managed_bot(creator_id=CREATOR, bot_id=NEW_BOT)
    polls = len(env.api.calls_of("getUpdates"))
    await _until(lambda: len(env.api.calls_of("getUpdates")) > polls + 3)
    assert not env.api.calls_of("getManagedBotToken") and not env.events() and not env.added_accounts()


async def test_an_expired_request_reports_timeout_and_ignores_a_late_bot(env: MEnv, monkeypatch) -> None:
    monkeypatch.setattr(mgr_mod, "MANAGED_REQUEST_TTL_S", 0.2)
    req = env.m.managed_create("default")
    await _until(lambda: env.events())
    [event] = env.events()
    assert event["request_id"] == req["request_id"] and event["ok"] is False and event["reason"] == "timeout"
    assert "created" not in event  # nothing exists in Telegram: unlike a quick add timing out
    env.api.push_managed_bot(creator_id=CREATOR, bot_id=NEW_BOT)
    polls = len(env.api.calls_of("getUpdates"))
    await _until(lambda: len(env.api.calls_of("getUpdates")) > polls + 3)
    assert not env.api.calls_of("getManagedBotToken") and len(env.events()) == 1 and not env.added_accounts()


async def test_a_token_that_cannot_be_read_reports_token_unavailable(env: MEnv) -> None:
    req = env.m.managed_create("default")
    env.api.fail("getManagedBotToken", 400, "Bad Request: bot is not managed")
    env.api.push_managed_bot(creator_id=CREATOR, bot_id=NEW_BOT)
    await _until(lambda: env.events())
    [event] = env.events()
    assert event["request_id"] == req["request_id"] and event["ok"] is False
    assert event["reason"] == "token_unavailable" and "not managed" in event["error"]
    assert event["created"] is True  # the bot exists in Telegram: the user is sent to BotFather
    assert not env.added_accounts()


async def test_a_failed_quick_add_reports_its_reason_and_leaves_no_trace(env: MEnv) -> None:
    env.login = "rejected"
    req = env.m.managed_create("default")
    env.api.push_managed_bot(creator_id=CREATOR, bot_id=NEW_BOT)
    await _until(lambda: env.events())
    [event] = env.events()
    assert event["request_id"] == req["request_id"] and event["ok"] is False
    assert event["reason"] == "rejected" and event["error"] == "401 Unauthorized"
    assert event["created"] is True
    assert not env.added_accounts()
    assert all(v is None for k, v in env.fake.secrets.items() if k != "channel-telegram-default")
    assert all(holder[1] == "default" for holder in env.m._lease.values())


async def test_a_token_change_of_a_known_bot_is_not_added_again(env: MEnv) -> None:
    env.m.managed_create("default")
    env.api.push_managed_bot(creator_id=CREATOR, bot_id=NEW_BOT)
    await _until(lambda: env.events())
    # Telegram sends managed_bot again when the token or owner changes; a request is open meanwhile.
    env.m.managed_create("default")
    env.api.push_managed_bot(creator_id=CREATOR, bot_id=NEW_BOT)
    polls = len(env.api.calls_of("getUpdates"))
    await _until(lambda: len(env.api.calls_of("getUpdates")) > polls + 3)
    assert len(env.api.calls_of("getManagedBotToken")) == 1 and len(env.events()) == 1
    assert len(env.added_accounts()) == 1


async def test_an_unexpected_quick_add_error_still_answers_the_request(env: MEnv, monkeypatch) -> None:
    async def broken_quick_add(*args, **kwargs):
        raise RuntimeError("database is locked")

    monkeypatch.setattr(env.m, "quick_add", broken_quick_add)
    req = env.m.managed_create("default")
    env.api.push_managed_bot(creator_id=CREATOR, bot_id=NEW_BOT)
    await _until(lambda: env.events())
    [event] = env.events()
    assert event["request_id"] == req["request_id"] and event["ok"] is False and event["created"] is True
    assert event["reason"] == "invalid" and "database is locked" in event["error"]

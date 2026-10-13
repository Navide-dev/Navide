from __future__ import annotations

import asyncio
import dataclasses
import time

import pytest

from agent_team_backend.channels.base import ChannelSendError, InboundMessage, Location
from agent_team_backend.channels.telegram import CONFLICT_MIN_ATTEMPT, TelegramAdapter

from .fake_telegram import FakeBotApi

TOKEN = "12345:SECRET"


class MemOffsets:
    def __init__(self) -> None:
        self.rows: dict[tuple[str, str], tuple[str, int]] = {}

    def get_offset(self, platform: str, account: str, bot_id: str) -> int | None:
        row = self.rows.get((platform, account))
        return row[1] if row and row[0] == bot_id else None

    def set_offset(self, platform: str, account: str, bot_id: str, offset: int) -> None:
        self.rows[(platform, account)] = (bot_id, offset)


async def _until(pred, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while not pred():
        if time.monotonic() > deadline:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(0.02)


def _adapter(api: FakeBotApi, offsets: MemOffsets | None = None, token: str = TOKEN) -> TelegramAdapter:
    return TelegramAdapter(token, base_url=api.base_url, offset_store=offsets,
                           backoff=lambda attempt, r: 0.05, poll_timeout_s=1)


@pytest.fixture
def api():
    with FakeBotApi(TOKEN) as fake:
        yield fake


async def test_poll_delivers_messages_and_persists_offset(api: FakeBotApi) -> None:
    offsets = MemOffsets()
    got: list[InboundMessage] = []

    async def emit(msg: InboundMessage) -> None:
        got.append(msg)

    ad = _adapter(api, offsets)
    uid = api.push_message(chat_id=42, text="hello")
    await ad.start(emit)
    try:
        await _until(lambda: got)
        assert ad.status.lifecycle == "ready" and ad.status.identity == "@navide_bot"
        m = got[0]
        assert (m.chat_id, m.sender_id, m.text, m.is_direct, m.thread_id) == ("42", "7", "hello", True, "")
        assert api.calls_of("deleteWebhook") == [{"drop_pending_updates": False}]
        await _until(lambda: offsets.rows.get(("telegram", "default")) == ("12345", uid + 1))
    finally:
        await ad.stop()
    assert ad.status.lifecycle == "stopped"


async def test_offset_resumes_for_same_bot_and_is_discarded_for_other_bot(api: FakeBotApi) -> None:
    offsets = MemOffsets()
    offsets.set_offset("telegram", "default", "12345", 777)
    ad = _adapter(api, offsets)

    async def emit(msg: InboundMessage) -> None:
        pass

    await ad.start(emit)
    await _until(lambda: api.calls_of("getUpdates"))
    await ad.stop()
    assert api.calls_of("getUpdates")[0]["offset"] == 777

    # Stored offset belongs to another bot id: the new bot starts without one.
    api.calls.clear()
    offsets.rows[("telegram", "default")] = ("99999", 555)
    ad2 = _adapter(api, offsets)
    await ad2.start(emit)
    await _until(lambda: api.calls_of("getUpdates"))
    await ad2.stop()
    assert "offset" not in api.calls_of("getUpdates")[0]


async def test_409_reports_another_consumer_and_recovers(api: FakeBotApi) -> None:
    api.fail("getUpdates", 409, "Conflict: terminated by other getUpdates request", times=2)
    got: list[InboundMessage] = []

    async def emit(msg: InboundMessage) -> None:
        got.append(msg)

    ad = TelegramAdapter(TOKEN, base_url=api.base_url, backoff=lambda a, r: 0.3, poll_timeout_s=1)
    await ad.start(emit)
    try:
        await _until(lambda: ad.status.lifecycle == "recovering")
        assert "409" in ad.status.last_error and "另一個程式" in ad.status.last_error
        assert TOKEN not in ad.status.last_error
        api.push_message(chat_id=1, text="after")
        await _until(lambda: got)
        assert ad.status.lifecycle == "ready" and ad.status.last_error == ""
    finally:
        await ad.stop()


async def test_backoff_restarts_after_a_successful_poll(api: FakeBotApi) -> None:
    # Three failures, then polling works, then one more failure: that one is a
    # fresh drop and must wait the first-step delay, not the fourth.
    attempts: list[int] = []

    def backoff(attempt: int, _r: float) -> float:
        attempts.append(attempt)
        return 0.01

    async def emit(_msg: InboundMessage) -> None:
        pass

    api.fail("getUpdates", 500, "Internal Server Error", times=3)
    ad = TelegramAdapter(TOKEN, base_url=api.base_url, backoff=backoff, poll_timeout_s=1, stable_s=0.0)
    await ad.start(emit)
    try:
        await _until(lambda: len(attempts) == 3 and ad.status.lifecycle == "ready"
                     and len(api.calls_of("getUpdates")) >= 5)
        api.fail("getUpdates", 500, "Internal Server Error")
        await _until(lambda: len(attempts) == 4)
        assert attempts == [1, 2, 3, 1]
    finally:
        await ad.stop()


async def test_a_session_that_answers_then_drops_at_once_keeps_backing_off(api: FakeBotApi) -> None:
    # Same rule as ReceiveLoop: only a session that stayed up READY_STABLE_S
    # restarts the series, or a server that answers once and fails would be
    # retried at the first-step delay forever.
    attempts: list[int] = []

    def backoff(attempt: int, _r: float) -> float:
        attempts.append(attempt)
        return 0.01

    async def emit(_msg: InboundMessage) -> None:
        pass

    api.fail("getUpdates", 500, "Internal Server Error", times=3)
    ad = TelegramAdapter(TOKEN, base_url=api.base_url, backoff=backoff, poll_timeout_s=1, stable_s=10.0)
    await ad.start(emit)
    try:
        await _until(lambda: len(attempts) == 3 and ad.status.lifecycle == "ready"
                     and len(api.calls_of("getUpdates")) >= 5)
        assert ad.status.reconnect_attempts == 0  # the status still shows a live session
        api.fail("getUpdates", 500, "Internal Server Error")
        await _until(lambda: len(attempts) == 4)
        assert attempts == [1, 2, 3, 4]
    finally:
        await ad.stop()


async def test_409_starts_backoff_at_the_conflict_floor(api: FakeBotApi) -> None:
    # Another getUpdates consumer holds the bot: retrying fast only fights it
    # for messages, so a conflict never starts at the first-step delay.
    attempts: list[int] = []

    def backoff(attempt: int, _r: float) -> float:
        attempts.append(attempt)
        return 0.01

    async def emit(_msg: InboundMessage) -> None:
        pass

    api.fail("getUpdates", 409, "Conflict: terminated by other getUpdates request")
    ad = TelegramAdapter(TOKEN, base_url=api.base_url, backoff=backoff, poll_timeout_s=1)
    await ad.start(emit)
    try:
        await _until(lambda: attempts)
        assert attempts[0] == CONFLICT_MIN_ATTEMPT
    finally:
        await ad.stop()


@pytest.mark.parametrize("code", [401, 404])
async def test_auth_failure_blocks_and_stops(api: FakeBotApi, code: int) -> None:
    api.fail("getMe", code, "Unauthorized" if code == 401 else "Not Found")

    async def emit(msg: InboundMessage) -> None:
        pass

    ad = _adapter(api)
    await ad.start(emit)
    await _until(lambda: ad.status.lifecycle == "blocked")
    await asyncio.sleep(0.2)
    assert len(api.calls_of("getMe")) == 1  # no retry after a dead token
    await ad.stop()


async def test_429_on_send_honours_retry_after(api: FakeBotApi) -> None:
    api.fail("sendMessage", 429, "Too Many Requests: retry after 1", retry_after=1)
    ad = _adapter(api)
    t0 = time.monotonic()
    ids = await ad.send_text(Location("telegram", "default", "42"), "hi")
    assert time.monotonic() - t0 >= 0.9
    assert len(ids) == 1 and len(api.calls_of("sendMessage")) == 2


async def test_non_429_send_error_is_not_retried(api: FakeBotApi) -> None:
    api.fail("sendMessage", 400, "Bad Request: chat not found")
    ad = _adapter(api)
    with pytest.raises(ChannelSendError):
        await ad.send_text(Location("telegram", "default", "42"), "hi")
    assert len(api.calls_of("sendMessage")) == 1


async def test_send_html_falls_back_to_plain_on_parse_error(api: FakeBotApi) -> None:
    api.fail("sendMessage", 400, "Bad Request: can't parse entities: unexpected end tag")
    ad = _adapter(api)
    await ad.send_text(Location("telegram", "default", "42"), "**bold** <x>")
    first, second = api.calls_of("sendMessage")
    assert first["parse_mode"] == "HTML" and first["text"] == "<b>bold</b> &lt;x&gt;"
    assert "parse_mode" not in second and second["text"] == "**bold** <x>"


async def test_long_text_is_chunked_at_4000(api: FakeBotApi) -> None:
    ad = _adapter(api)
    ids = await ad.send_text(Location("telegram", "default", "42"), ("word " * 2000).strip())
    sent = api.calls_of("sendMessage")
    assert len(ids) == len(sent) == 3
    assert all(len(p["text"]) <= 4000 for p in sent)


async def test_topics_create_and_general_topic_omits_thread(api: FakeBotApi) -> None:
    ad = _adapter(api)
    loc = await ad.create_location("-100", "api-refactor")
    assert loc.thread_id == "50" and loc.title == "api-refactor"
    assert api.calls_of("createForumTopic") == [{"chat_id": "-100", "name": "api-refactor"}]
    await ad.send_text(loc, "in topic")
    await ad.send_text(Location("telegram", "default", "-100", "1"), "in general")
    await ad.send_typing(loc)
    topic_send, general_send = api.calls_of("sendMessage")
    assert topic_send["message_thread_id"] == 50
    assert "message_thread_id" not in general_send
    assert api.calls_of("sendChatAction") == [{"chat_id": "-100", "message_thread_id": 50, "action": "typing"}]


async def test_create_topic_without_rights_gives_clear_error(api: FakeBotApi) -> None:
    api.fail("createForumTopic", 400, "Bad Request: not enough rights to create a topic")
    ad = _adapter(api)
    with pytest.raises(ChannelSendError, match="管理主題"):
        await ad.create_location("-100", "x")


async def test_inbound_topic_vs_general_thread_ids(api: FakeBotApi) -> None:
    got: list[InboundMessage] = []

    async def emit(msg: InboundMessage) -> None:
        got.append(msg)

    ad = _adapter(api)
    api.push_message(chat_id=-100, text="topic", chat_type="supergroup", thread_id=50, topic=True, forum=True)
    api.push_message(chat_id=-100, text="general", chat_type="supergroup", forum=True)
    await ad.start(emit)
    try:
        await _until(lambda: len(got) == 2)
    finally:
        await ad.stop()
    assert [(m.thread_id, m.is_direct) for m in got] == [("50", False), ("", False)]
    assert ad.known_locations() == [
        {"chat_id": "-100", "title": "chat-100", "kind": "supergroup", "supports_topics": True}
    ]


async def test_edit_buttons_and_callback(api: FakeBotApi) -> None:
    got: list[InboundMessage] = []

    async def emit(msg: InboundMessage) -> None:
        got.append(msg)

    ad = _adapter(api)
    loc = Location("telegram", "default", "42")
    await ad.send_text(loc, "approve?", buttons=[("Yes", "nv1:abcde:y"), ("No", "nv1:abcde:n")])
    markup = api.calls_of("sendMessage")[0]["reply_markup"]
    assert markup["inline_keyboard"][0][1] == {"text": "No", "callback_data": "nv1:abcde:n"}
    await ad.edit_text(loc, "9", "working…")
    assert api.calls_of("editMessageText")[0]["message_id"] == 9
    # No reply_markup: Telegram drops the inline keyboard, as a settled prompt needs.
    assert "reply_markup" not in api.calls_of("editMessageText")[0]

    api.push_callback(chat_id=42, data="nv1:abcde:y")
    await ad.start(emit)
    try:
        await _until(lambda: got)
    finally:
        await ad.stop()
    assert got[0].callback_data == "nv1:abcde:y" and got[0].text == ""
    assert api.calls_of("answerCallbackQuery")


async def test_edit_not_modified_is_ignored(api: FakeBotApi) -> None:
    api.fail("editMessageText", 400, "Bad Request: message is not modified")
    ad = _adapter(api)
    await ad.edit_text(Location("telegram", "default", "42"), "3", "same")


def test_fingerprint_is_sha256_of_token() -> None:
    import hashlib

    ad = TelegramAdapter(TOKEN)
    assert ad.token_fingerprint() == hashlib.sha256(TOKEN.encode()).hexdigest()


async def test_create_adapter_uses_self_hosted_api_base(api: FakeBotApi) -> None:
    from agent_team_backend.channels.telegram import create_adapter

    ad = create_adapter({"api_base": api.base_url + "/"}, {"token": TOKEN})
    me = await ad._call("getMe")
    assert me["username"] == "navide_bot"
    assert api.calls_of("getMe")


def test_create_adapter_defaults_to_public_api() -> None:
    from agent_team_backend.channels.telegram import DEFAULT_BASE_URL, create_adapter

    ad = create_adapter({}, {"token": TOKEN})
    assert ad._base == f"{DEFAULT_BASE_URL}/bot{TOKEN}"


@pytest.mark.parametrize("base", ["file:///etc/passwd", "ftp://example.com", "api.telegram.org", "http://"])
def test_create_adapter_rejects_non_http_api_base(base: str) -> None:
    from agent_team_backend.channels.telegram import create_adapter

    with pytest.raises(ValueError, match="api_base"):
        create_adapter({"api_base": base}, {"token": TOKEN})


async def test_stop_ends_polling_even_if_a_cancel_is_swallowed(api: FakeBotApi, monkeypatch) -> None:
    # anyio's connect_tcp (under httpx) uncancels its host task when a cancel lands
    # while its happy-eyeballs task group winds down: the poll loop carries on.
    ad = _adapter(api)
    real_call = ad._call
    swallowed: list[str] = []

    async def call(method, params=None):
        if method == "getUpdates" and not swallowed:
            try:
                await asyncio.sleep(3600)
            except asyncio.CancelledError:
                asyncio.current_task().uncancel()
                swallowed.append(method)
                return []
        return await real_call(method, params)

    monkeypatch.setattr(ad, "_call", call)

    async def emit(msg: InboundMessage) -> None:
        pass

    await ad.start(emit)
    await _until(lambda: api.calls_of("deleteWebhook"))
    await asyncio.sleep(0.05)
    started = time.monotonic()
    # Not wait_for: a stop that swallows wait_for's own cancel returns normally.
    done, _ = await asyncio.wait({asyncio.ensure_future(ad.stop())}, timeout=3)
    assert done, "stop() did not return"
    assert time.monotonic() - started < 2
    assert swallowed and ad.status.lifecycle == "stopped"


# --- Managed Bots (Bot API 9.6) ------------------------------------------------


def _collect() -> tuple[list[InboundMessage], object]:
    got: list[InboundMessage] = []

    async def emit(msg: InboundMessage) -> None:
        got.append(msg)

    return got, emit


async def test_messages_and_button_presses_are_delivered_as_before(api: FakeBotApi) -> None:
    """Locks the message and callback_query paths: exactly these inbound values, in order."""
    got, emit = _collect()
    api.push_message(chat_id=42, text="hello", sender_id=7, username="alice")
    api.push_callback(chat_id=42, data="nv1:abcde:y", sender_id=7)
    api.push_message(chat_id=42, text="", sender_id=7)  # no text: skipped
    ad = _adapter(api)
    await ad.start(emit)
    try:
        await _until(lambda: len(got) >= 2)
        await _until(lambda: api.calls_of("answerCallbackQuery"))
    finally:
        await ad.stop()
    msg, cb = got
    assert (msg.platform, msg.account, msg.chat_id, msg.thread_id, msg.sender_id, msg.sender_name,
            msg.text, msg.message_id, msg.is_direct, msg.callback_data, msg.reply_to_id) == (
        "telegram", "default", "42", "", "7", "alice", "hello", "42:1", True, "", "")
    assert (cb.chat_id, cb.sender_id, cb.text, cb.callback_data, cb.message_id.startswith("cb:q")) == (
        "42", "7", "", "nv1:abcde:y", True)
    assert len(got) == 2


async def test_polling_asks_for_managed_bot_updates_too(api: FakeBotApi) -> None:
    got, emit = _collect()
    ad = _adapter(api)
    await ad.start(emit)
    try:
        await _until(lambda: api.calls_of("getUpdates"))
    finally:
        await ad.stop()
    assert api.calls_of("getUpdates")[0]["allowed_updates"] == ["message", "callback_query", "managed_bot"]


@pytest.mark.parametrize("flag, expected", [(True, True), (False, False), (None, False)])
async def test_get_me_says_whether_the_bot_can_manage_bots(flag, expected) -> None:
    with FakeBotApi(TOKEN, can_manage_bots=flag) as fake:
        got, emit = _collect()
        ad = _adapter(fake)
        await ad.start(emit)
        try:
            await _until(lambda: ad.status.lifecycle == "ready")
        finally:
            await ad.stop()
    assert ad.status.can_manage_bots is expected
    assert dataclasses.asdict(ad.status)["can_manage_bots"] is expected


async def test_a_managed_bot_update_goes_to_the_handler_and_not_to_chats(api: FakeBotApi) -> None:
    got, emit = _collect()
    handled: list[dict] = []

    async def on_managed_bot(update: dict) -> None:
        handled.append(update)

    ad = _adapter(api)
    ad.on_managed_bot = on_managed_bot
    api.push_managed_bot(creator_id=7, bot_id=999, bot_username="made_bot")
    api.push_message(chat_id=42, text="after")
    await ad.start(emit)
    try:
        await _until(lambda: handled and got)
    finally:
        await ad.stop()
    assert handled == [{
        "user": {"id": 7, "is_bot": False, "first_name": "neil"},
        "bot": {"id": 999, "is_bot": True, "first_name": "Navide bot", "username": "made_bot"},
    }]
    assert [m.text for m in got] == ["after"]


async def test_a_managed_bot_update_without_a_handler_is_skipped(api: FakeBotApi) -> None:
    got, emit = _collect()
    offsets = MemOffsets()
    ad = _adapter(api, offsets)
    uid = api.push_managed_bot(creator_id=7, bot_id=999)
    api.push_message(chat_id=42, text="after")
    await ad.start(emit)
    try:
        await _until(lambda: got)
    finally:
        await ad.stop()
    assert [m.text for m in got] == ["after"]
    assert offsets.rows[("telegram", "default")][1] > uid


async def test_managed_bot_token_asks_for_the_new_bots_user_id(api: FakeBotApi) -> None:
    api.handlers["getManagedBotToken"] = lambda params: f"{params['user_id']}:NEWSECRET"
    ad = _adapter(api)
    assert await ad.managed_bot_token(999) == "999:NEWSECRET"
    assert api.calls_of("getManagedBotToken") == [{"user_id": 999}]
    api.fail("getManagedBotToken", 400, "Bad Request: bot not found")
    with pytest.raises(Exception, match="bot not found"):
        await ad.managed_bot_token(1000)


async def test_menu_sends_and_edits_several_button_rows(api: FakeBotApi) -> None:
    ad = _adapter(api)
    loc = Location("telegram", "default", "42", "50")
    rows = [[("💬 A", "nv2:p:aaaaaaaa"), ("💬 B", "nv2:p:bbbbbbbb")], [("Next ▶", "nv2:g:cccccccc")]]
    message_id = await ad.send_menu(loc, "menu", rows)
    sent = api.calls_of("sendMessage")[0]
    assert sent["message_thread_id"] == 50 and message_id.isdigit()
    assert sent["reply_markup"]["inline_keyboard"] == [
        [{"text": "💬 A", "callback_data": "nv2:p:aaaaaaaa"}, {"text": "💬 B", "callback_data": "nv2:p:bbbbbbbb"}],
        [{"text": "Next ▶", "callback_data": "nv2:g:cccccccc"}],
    ]
    await ad.edit_menu(loc, "9", "page 2", rows[1:])
    edit = api.calls_of("editMessageText")[0]
    assert edit["message_id"] == 9
    assert edit["reply_markup"]["inline_keyboard"] == [[{"text": "Next ▶", "callback_data": "nv2:g:cccccccc"}]]

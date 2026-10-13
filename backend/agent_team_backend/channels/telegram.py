"""Telegram adapter: Bot API ``getUpdates`` long polling (reference implementation).

Receive loop (OpenClaw polling-session.ts):
- ``deleteWebhook`` first (``drop_pending_updates=false``) — getUpdates is refused
  while a webhook is set.
- The update offset is persisted per bot id; a stored offset for a different bot
  id (token changed) is discarded.
- 409 means another consumer is polling the same bot (e.g. Claude Code
  ``--channels``): report it and back off, never crash.
- 401/404 mean the token is dead: lifecycle ``blocked``, stop retrying.
- 429 honours ``retry_after`` capped at 60s.
- A getUpdates call that does not finish within the stall watchdog restarts.

Sends are not idempotent: they are retried only on 429 or when the connection
provably never carried the request (connect errors).

Forum topics are pane locations. The General topic (id 1) must be addressed
without ``message_thread_id``, and its inbound messages carry no topic flag, so
it maps to ``thread_id == ""``.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import random
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, BinaryIO, Callable, Protocol
from urllib.parse import urlsplit

import httpx

from .base import (
    RETRY_AFTER_CAP_S,
    STALL_WATCHDOG_S,
    AdapterStatus,
    Capabilities,
    ChannelAuthError,
    ChannelSendError,
    Emit,
    InboundAttachment,
    InboundMessage,
    Location,
    MediaTooLarge,
    backoff_delay,
)
from . import redact
from .adapter_runtime import READY_STABLE_S, cancel_and_wait, download_to, media_client
from .report import Caption
from .text import TEXT_LIMITS, chunk_text, is_telegram_parse_error, markdown_to_telegram_html

log = logging.getLogger(__name__)
# httpx logs every request URL at INFO, and the Bot API puts the token in the URL.
redact.install()

DEFAULT_BASE_URL = "https://api.telegram.org"
# https://core.telegram.org/bots/api#sending-files: "Post the file using multipart/form-data
# ... 10 MB max size for photos, 50 MB for other files." Everything goes as a document.
UPLOAD_MAX_BYTES = 50 * 1024 * 1024
CAPTION_LIMIT = 1024  # sendDocument caption, characters
# The file kinds a Message may carry that are taken as attachments (stickers are not).
# An animation also fills ``document`` "for backward compatibility", so it comes first.
_FILE_KINDS = ("animation", "document", "video", "audio", "voice", "video_note")
POLL_TIMEOUT_S = 30
GENERAL_TOPIC_ID = "1"
SEND_CONNECT_RETRIES = 2
# A 409 means another getUpdates consumer holds the bot; retrying at the first
# step would only fight it for messages. Attempt 4 is base x 8 (~40s).
CONFLICT_MIN_ATTEMPT = 4


class OffsetStore(Protocol):
    def get_offset(self, platform: str, account: str, bot_id: str) -> int | None: ...

    def set_offset(self, platform: str, account: str, bot_id: str, offset: int) -> None: ...


@dataclass
class TelegramStatus(AdapterStatus):
    # getMe's User.can_manage_bots (Bot API 9.6): Bot Management Mode is on in BotFather,
    # so this bot can create bots through t.me/newbot links. False until getMe answered.
    can_manage_bots: bool = False


class TelegramApiError(Exception):
    def __init__(self, code: int, description: str, retry_after: float | None = None) -> None:
        super().__init__(f"{code}: {description}")
        self.code = code
        self.description = description
        self.retry_after = retry_after


class TelegramAdapter:
    # getMe answering sets the identity: the token is accepted even while getUpdates
    # still fails (another poller holds it, 409), so quick add need not wait for ready.
    identity_confirms_credential = True
    platform = "telegram"
    capabilities = Capabilities(
        threads=True, create_location=True, edit=True, typing=True, buttons=True,
        text_limit=TEXT_LIMITS["telegram"],
    )
    # Groups allow about 20 messages a minute; the mirror outbox paces to this.
    rate_per_min = 20.0

    def __init__(
        self,
        token: str,
        *,
        account: str = "default",
        base_url: str = DEFAULT_BASE_URL,
        offset_store: OffsetStore | None = None,
        backoff: Callable[[int, float], float] = backoff_delay,
        stall_timeout_s: float = STALL_WATCHDOG_S,
        poll_timeout_s: int = POLL_TIMEOUT_S,
        stable_s: float = READY_STABLE_S,
    ) -> None:
        self._token = token.strip()
        redact.add_secret(self._token)
        self.account = account
        self._base = f"{base_url.rstrip('/')}/bot{self._token}"
        # getFile hands back a path to fetch from <base>/file/bot<token>/<file_path>.
        self._file_base = f"{base_url.rstrip('/')}/file/bot{self._token}"
        self.upload_max_bytes = UPLOAD_MAX_BYTES
        self._media_transport: httpx.AsyncBaseTransport | None = None  # tests swap in a mock
        self._offsets = offset_store
        self._backoff = backoff
        self._attempt = 0
        self._stall_timeout_s = stall_timeout_s
        self._poll_timeout_s = poll_timeout_s
        self._stable_s = stable_s
        self.status = TelegramStatus()
        # Receives each ManagedBotUpdated (a bot this one manages was created, re-tokened
        # or changed owner); the manager decides what it means. None: such updates are skipped.
        self.on_managed_bot: Callable[[dict[str, Any]], Awaitable[None]] | None = None
        self.bot_id = self._token.split(":", 1)[0]
        self._client: httpx.AsyncClient | None = None
        self._task: asyncio.Task[None] | None = None
        self._emit: Emit | None = None
        self._offset: int | None = None
        # chat_id -> {chat_id, title, kind, supports_topics}; feeds the "existing chat" picker.
        self._known_chats: dict[str, dict[str, Any]] = {}

    # --- lifecycle ------------------------------------------------------------

    def token_fingerprint(self) -> str:
        return hashlib.sha256(self._token.encode()).hexdigest()

    async def start(self, emit: Emit) -> None:
        if self._task and not self._task.done():
            return
        self._emit = emit
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(20.0, read=self._poll_timeout_s + 15.0))
        self.status.lifecycle = "starting"
        self.status.last_error = ""
        self._task = asyncio.create_task(self._run(), name="channels-telegram")

    async def stop(self) -> None:
        task, self._task = self._task, None
        if task:
            await cancel_and_wait(task)
        if self._client:
            await self._client.aclose()
            self._client = None
        self.status.lifecycle = "stopped"
        self.status.connected = False

    async def _run(self) -> None:
        self._attempt = 0
        while True:
            try:
                await self._session()
                return
            except asyncio.CancelledError:
                raise
            except ChannelAuthError as exc:
                self.status.lifecycle = "blocked"
                self.status.connected = False
                self.status.last_error = str(exc)
                log.warning("telegram: token rejected, polling stopped: %s", exc)
                return
            except Exception as exc:  # noqa: BLE001 — every other failure is transient
                self._attempt += 1
                if isinstance(exc, TelegramApiError) and exc.code == 409:
                    self._attempt = max(self._attempt, CONFLICT_MIN_ATTEMPT)
                self.status.lifecycle = "recovering"
                self.status.connected = False
                self.status.reconnect_attempts = self._attempt
                self.status.last_error = self._redact(_describe_failure(exc))
                delay = self._backoff(self._attempt, random.random())
                log.info("telegram: poll failed (%s); retry in %.1fs", self.status.last_error, delay)
                await asyncio.sleep(delay)

    async def _session(self) -> None:
        me = await self._call("getMe")
        username = me.get("username") or ""
        self.status.identity = f"@{username}" if username else str(me.get("id", ""))
        self.status.can_manage_bots = me.get("can_manage_bots") is True
        if me.get("id"):
            self.bot_id = str(me["id"])
        await self._call("deleteWebhook", {"drop_pending_updates": False})
        if self._offsets is not None:
            self._offset = self._offsets.get_offset(self.platform, self.account, self.bot_id)
        self.status.lifecycle = "ready"
        self.status.connected = True
        self.status.last_connected_at = time.time()
        ready_at = time.monotonic()
        while True:
            params: dict[str, Any] = {
                "timeout": self._poll_timeout_s,
                # managed_bot only ever arrives for a bot in Bot Management Mode.
                "allowed_updates": ["message", "callback_query", "managed_bot"],
            }
            if self._offset is not None:
                params["offset"] = self._offset
            try:
                updates = await asyncio.wait_for(
                    self._call("getUpdates", params), timeout=self._stall_timeout_s
                )
            except asyncio.TimeoutError as exc:
                raise RuntimeError("getUpdates stalled; restarting") from exc
            # A session that stayed up (ReceiveLoop's rule): the next failure is a fresh
            # drop, not one more in a series. A shorter one keeps backing off.
            if time.monotonic() - ready_at >= self._stable_s:
                self._attempt = 0
            self.status.lifecycle = "ready"
            self.status.connected = True
            self.status.reconnect_attempts = 0
            self.status.last_error = ""
            for update in updates or []:
                uid = int(update.get("update_id", 0))
                try:
                    await self._handle_update(update)
                except Exception:  # noqa: BLE001 — one bad update must not stop polling
                    log.exception("telegram: update %s failed", uid)
                self._offset = uid + 1
                if self._offsets is not None:
                    self._offsets.set_offset(self.platform, self.account, self.bot_id, self._offset)

    # --- inbound --------------------------------------------------------------

    async def _handle_update(self, update: dict[str, Any]) -> None:
        managed = update.get("managed_bot")
        if managed:
            if self.on_managed_bot is not None:
                await self.on_managed_bot(managed)
            return
        cb = update.get("callback_query")
        if cb:
            msg = cb.get("message") or {}
            chat = msg.get("chat") or {}
            self._remember_chat(chat)
            try:
                await self._call("answerCallbackQuery", {"callback_query_id": cb.get("id")})
            except Exception:  # noqa: BLE001 — cosmetic (stops the button spinner)
                pass
            await self._deliver(
                chat=chat, sender=cb.get("from") or {}, text="", thread=_thread_of(msg),
                message_id=f"cb:{cb.get('id')}", ts=time.time(),
                callback_data=str(cb.get("data") or ""),
            )
            return
        msg = update.get("message")
        if not msg:
            return
        chat = msg.get("chat") or {}
        self._remember_chat(chat)
        text = msg.get("text") or msg.get("caption") or ""
        attachments = _attachments(msg)
        if not (text or attachments) or (msg.get("from") or {}).get("is_bot"):
            return
        await self._deliver(
            chat=chat, sender=msg.get("from") or {}, text=text, thread=_thread_of(msg),
            message_id=f"{chat.get('id')}:{msg.get('message_id')}",
            ts=float(msg.get("date") or time.time()),
            reply_to_id=str((msg.get("reply_to_message") or {}).get("message_id") or ""),
            reply_quote=_reply_quote(msg, self.bot_id), attachments=attachments,
        )

    async def _deliver(
        self, *, chat: dict[str, Any], sender: dict[str, Any], text: str, thread: str,
        message_id: str, ts: float, callback_data: str = "", reply_to_id: str = "",
        reply_quote: tuple[str, str, str, bool] = ("", "", "", False),
        attachments: list[InboundAttachment] | None = None,
    ) -> None:
        self.status.last_inbound_at = time.time()
        if self._emit is None:
            return
        await self._emit(InboundMessage(
            platform=self.platform, account=self.account, chat_id=str(chat.get("id", "")),
            thread_id=thread, sender_id=str(sender.get("id", "")), sender_name=_display_name(sender),
            text=text, message_id=message_id, is_direct=chat.get("type") == "private", ts=ts,
            callback_data=callback_data, reply_to_id=reply_to_id,
            reply_to_text=reply_quote[0], reply_to_sender=reply_quote[1],
            reply_to_sender_id=reply_quote[2], reply_to_self=reply_quote[3],
            attachments=attachments or [],
        ))

    def _remember_chat(self, chat: dict[str, Any]) -> None:
        cid = chat.get("id")
        if cid is None:
            return
        title = chat.get("title") or chat.get("username") or chat.get("first_name") or str(cid)
        self._known_chats[str(cid)] = {
            "chat_id": str(cid), "title": title, "kind": chat.get("type") or "",
            "supports_topics": bool(chat.get("is_forum")),
        }

    def known_locations(self) -> list[dict[str, Any]]:
        return list(self._known_chats.values())

    def link_url(self, code: str, target: str) -> str:
        """Deep link that sends ``/start <code>`` (https://core.telegram.org/bots/features#deep-linking)."""
        username = self.status.identity[1:] if self.status.identity.startswith("@") else ""
        if not username:
            return ""
        return f"https://t.me/{username}?{'startgroup' if target == 'group' else 'start'}={code}"

    async def managed_bot_token(self, bot_user_id: int) -> str:
        """The token of bot ``bot_user_id``, which this bot manages (getManagedBotToken)."""
        token = str(await self._call("getManagedBotToken", {"user_id": bot_user_id}) or "")
        if not token:
            raise TelegramApiError(0, "getManagedBotToken returned no token")
        redact.add_secret(token)
        return token

    # --- outbound -------------------------------------------------------------

    def _target(self, loc: Location) -> dict[str, Any]:
        params: dict[str, Any] = {"chat_id": loc.chat_id}
        if loc.thread_id and loc.thread_id != GENERAL_TOPIC_ID:
            params["message_thread_id"] = int(loc.thread_id)
        return params

    async def send_text(
        self, loc: Location, text: str, *, buttons: list[tuple[str, str]] | None = None
    ) -> list[str]:
        ids: list[str] = []
        chunks = chunk_text(text, self.capabilities.text_limit) or [text or "…"]
        for i, chunk in enumerate(chunks):
            params = self._target(loc)
            if buttons and i == len(chunks) - 1:
                params["reply_markup"] = {
                    "inline_keyboard": [[{"text": label, "callback_data": data} for label, data in buttons]]
                }
            result = await self._send_rich("sendMessage", params, chunk)
            ids.append(str(result.get("message_id", "")))
        return ids

    async def edit_text(self, loc: Location, message_id: str, text: str) -> None:
        params = {"chat_id": loc.chat_id, "message_id": int(message_id)}
        text = text[: self.capabilities.text_limit]
        try:
            await self._send_rich("editMessageText", params, text)
        except ChannelSendError as exc:
            if "message is not modified" in str(exc).lower():
                return
            raise

    @staticmethod
    def _keyboard(rows: list[list[tuple[str, str]]]) -> dict[str, Any]:
        return {"inline_keyboard": [[{"text": label, "callback_data": data} for label, data in row] for row in rows]}

    async def send_menu(self, loc: Location, text: str, rows: list[list[tuple[str, str]]]) -> str:
        """One message carrying ``rows`` of buttons (the quick menu); its id."""
        params = {**self._target(loc), "reply_markup": self._keyboard(rows)}
        result = await self._send_rich("sendMessage", params, text[: self.capabilities.text_limit])
        return str(result.get("message_id", ""))

    async def edit_menu(self, loc: Location, message_id: str, text: str, rows: list[list[tuple[str, str]]]) -> None:
        params = {"chat_id": loc.chat_id, "message_id": int(message_id), "reply_markup": self._keyboard(rows)}
        try:
            await self._send_rich("editMessageText", params, text[: self.capabilities.text_limit])
        except ChannelSendError as exc:
            if "message is not modified" in str(exc).lower():
                return
            raise

    async def send_typing(self, loc: Location) -> None:
        await self._send_call("sendChatAction", {**self._target(loc), "action": "typing"})

    async def create_location(self, chat_id: str, title: str) -> Location:
        try:
            result = await self._send_call(
                "createForumTopic", {"chat_id": chat_id, "name": (title or "Navide")[:128]}
            )
        except ChannelSendError as exc:
            low = str(exc).lower()
            if "not enough rights" in low or "not_enough_rights" in low:
                raise ChannelSendError(
                    "bot 需要是群組管理員並有「管理主題」權限 (not enough rights to create a topic)"
                ) from exc
            if "not a forum" in low:
                raise ChannelSendError("這個群組沒有開啟主題功能 (the chat is not a forum)") from exc
            raise
        thread = str(result.get("message_thread_id", ""))
        return Location(self.platform, self.account, str(chat_id), thread, result.get("name") or title)

    async def _send_rich(self, method: str, params: dict[str, Any], markdown: str) -> dict[str, Any]:
        """Send as HTML; on a markup parse error resend the plain text."""
        try:
            return await self._send_call(
                method, {**params, "text": markdown_to_telegram_html(markdown), "parse_mode": "HTML"}
            )
        except ChannelSendError as exc:
            if not is_telegram_parse_error(str(exc)):
                raise
            return await self._send_call(method, {**params, "text": markdown})

    async def _send_call(self, method: str, params: dict[str, Any]) -> Any:
        connect_failures = 0
        while True:
            try:
                return await self._call(method, params)
            except TelegramApiError as exc:
                if exc.code == 429:
                    await asyncio.sleep(min(exc.retry_after or 1.0, RETRY_AFTER_CAP_S))
                    continue
                raise ChannelSendError(exc.description, retryable=False) from exc
            except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
                # The request never left: safe to retry.
                connect_failures += 1
                if connect_failures > SEND_CONNECT_RETRIES:
                    raise ChannelSendError(self._redact(f"connect failed: {exc}"), retryable=True) from exc
                await asyncio.sleep(0.5 * connect_failures)
            except ChannelAuthError as exc:
                raise ChannelSendError(str(exc)) from exc
            except httpx.HTTPError as exc:
                raise ChannelSendError(self._redact(f"{type(exc).__name__}: {exc}")) from exc

    # --- media ----------------------------------------------------------------

    async def download(self, att: InboundAttachment, dest: Path, max_bytes: int) -> int:
        """getFile, then fetch the path it names. The Bot API serves at most 20 MB this way."""
        try:
            info = await self._call("getFile", {"file_id": att.ref}) or {}
        except TelegramApiError as exc:
            raise ChannelSendError(exc.description) from exc
        # getFile reports the size: refuse before fetching anything.
        if isinstance(info.get("file_size"), int) and info["file_size"] > max_bytes:
            raise MediaTooLarge(f"{info['file_size']} bytes")
        file_path = str(info.get("file_path") or "")
        # A local-mode Bot API server answers with a path on its own disk: never fetched.
        if not file_path or file_path.startswith("/") or ".." in file_path.split("/"):
            raise ChannelSendError(f"unusable file_path {file_path!r}")
        async with media_client(self._media_transport) as client:
            return await download_to(client, f"{self._file_base}/{file_path}", dest, max_bytes)

    async def send_file(self, loc: Location, fh: BinaryIO, filename: str,
                        caption: Caption | None = None) -> list[str]:
        data = {key: str(value) for key, value in self._target(loc).items()}
        if caption is not None:
            # Plain text: no parse_mode, so nothing in a title can fail to parse.
            data["caption"] = caption.plain()[:CAPTION_LIMIT]
        content = await asyncio.to_thread(fh.read)
        async with media_client(self._media_transport) as client:
            for _attempt in range(3):
                try:
                    resp = await client.post(f"{self._base}/sendDocument", data=data,
                                             files={"document": (filename, content)})
                except httpx.HTTPError as exc:
                    raise ChannelSendError(self._redact(str(exc))) from exc
                try:
                    body = resp.json()
                except ValueError:
                    body = {"ok": False, "description": f"HTTP {resp.status_code}"}
                if body.get("ok"):
                    return [str((body.get("result") or {}).get("message_id", ""))]
                retry_after = (body.get("parameters") or {}).get("retry_after")
                if body.get("error_code") == 429 and retry_after is not None:
                    await asyncio.sleep(min(float(retry_after), RETRY_AFTER_CAP_S))
                    continue
                break
        raise ChannelSendError(str(body.get("description") or f"HTTP {resp.status_code}"))

    # --- transport ------------------------------------------------------------

    def _redact(self, text: str) -> str:
        # The token is part of every request URL; keep it out of status and logs.
        return text.replace(self._token, "***") if self._token else text

    async def _call(self, method: str, params: dict[str, Any] | None = None) -> Any:
        client = self._client
        own = client is None
        if own:
            client = httpx.AsyncClient(timeout=20.0)
        try:
            resp = await client.post(f"{self._base}/{method}", json=params or {})
        finally:
            if own:
                await client.aclose()
        try:
            body = resp.json()
        except ValueError:
            body = {"ok": False, "error_code": resp.status_code, "description": resp.text[:200]}
        if body.get("ok"):
            return body.get("result")
        code = int(body.get("error_code") or resp.status_code)
        desc = str(body.get("description") or f"HTTP {resp.status_code}")
        if code in (401, 404) or (code == 403 and method in ("getMe", "getUpdates")):
            raise ChannelAuthError(f"Telegram rejected the bot token ({code}: {desc})")
        retry_after = (body.get("parameters") or {}).get("retry_after")
        err = TelegramApiError(code, desc, float(retry_after) if retry_after is not None else None)
        if code == 429 and method == "getUpdates":
            await asyncio.sleep(min(err.retry_after or 1.0, RETRY_AFTER_CAP_S))
            return []
        raise err


def create_adapter(config: dict[str, Any], secret: dict[str, Any], *, store: OffsetStore | None = None) -> TelegramAdapter:
    token = str(secret.get("token") or "").strip()
    if not token:
        raise ValueError("missing bot token")
    # A self-hosted Bot API server (https://github.com/tdlib/telegram-bot-api) may replace the public one.
    base_url = str(config.get("api_base") or "").strip() or DEFAULT_BASE_URL
    parsed = urlsplit(base_url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError(f"api_base must be an http(s) URL, got {base_url!r}")
    return TelegramAdapter(
        token, account=str(config.get("account") or "default"), base_url=base_url, offset_store=store
    )


def _thread_of(msg: dict[str, Any]) -> str:
    # Only forum topic messages carry a meaningful thread; General (id 1) has no flag.
    if msg.get("is_topic_message") and msg.get("message_thread_id") is not None:
        return str(msg["message_thread_id"])
    return ""


def _attachments(msg: dict[str, Any]) -> list[InboundAttachment]:
    """The files a Message carries: the largest size of a photo, plus one file kind."""
    found: list[InboundAttachment] = []
    sizes = msg.get("photo") or []
    if sizes:
        best = sizes[-1]  # PhotoSize array, smallest first
        found.append(InboundAttachment("photo", "", best.get("file_size"), "image/jpeg", str(best.get("file_id", ""))))
    for kind in _FILE_KINDS:
        obj = msg.get(kind)
        if isinstance(obj, dict) and obj.get("file_id"):
            found.append(InboundAttachment(kind, str(obj.get("file_name") or ""), obj.get("file_size"),
                                           str(obj.get("mime_type") or ""), str(obj["file_id"])))
            break
    return found


def _display_name(user: dict[str, Any]) -> str:
    return user.get("username") or " ".join(
        p for p in (user.get("first_name"), user.get("last_name")) if p
    ) or str(user.get("id", ""))


def _reply_quote(msg: dict[str, Any], bot_id: str) -> tuple[str, str, str, bool]:
    """(quoted text, its sender's name, id, written by this bot) for a native reply; the
    part the user selected wins."""
    reply = msg.get("reply_to_message") or {}
    # A forum topic's messages all "reply" to the topic's creation message.
    if not reply or reply.get("forum_topic_created") or (
            msg.get("is_topic_message") and reply.get("message_id") == msg.get("message_thread_id")):
        return "", "", "", False
    text = (msg.get("quote") or {}).get("text") or reply.get("text") or reply.get("caption") or ""
    if not text:
        return "", "", "", False
    author, own = _content_author(reply)
    author_id = str(author.get("id") or "")
    is_self = own and bool(author_id) and author_id == bot_id
    return str(text), _display_name(author) if author else "", author_id, is_self


# ``from`` ids that stand for many people: anonymous group admins, channel posts and
# Telegram's service account. They identify no one, so they are never a quote's author.
SHARED_SENDER_IDS = {1087968824, 136817688, 777000}


def _content_author(reply: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    """(who wrote the replied-to message's words, whether it is ``from`` itself).

    A forward's ``from`` is whoever forwarded it, so the origin user is the author, and an
    origin with no user id (hidden user, chat, channel) has none. A message sent on behalf
    of a chat (``sender_chat``) or by a shared id has none either. No author means the
    manager will not quote it.
    """
    origin = reply.get("forward_origin")
    if origin is not None:
        return (origin.get("sender_user") or {}) if origin.get("type") == "user" else {}, False
    if reply.get("forward_from") is not None:
        return reply.get("forward_from") or {}, False
    if reply.get("forward_date") is not None or reply.get("sender_chat"):
        return {}, False
    author = reply.get("from") or {}
    if author.get("id") in SHARED_SENDER_IDS:
        return {}, False
    return author, True


def _describe_failure(exc: Exception) -> str:
    if isinstance(exc, TelegramApiError) and exc.code == 409:
        return "另一個程式也在用這個 bot（409 Conflict: another getUpdates consumer）"
    return f"{type(exc).__name__}: {exc}"

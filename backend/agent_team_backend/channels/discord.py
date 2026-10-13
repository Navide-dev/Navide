"""Discord adapter: Gateway WebSocket for inbound, REST for outbound.

Verified facts (docs.discord.com, read 2026-09-24):
- Gateway: GET /gateway/bot (Bot auth) -> url; connect with ?v=10&encoding=json.
  Hello (op 10) carries heartbeat_interval ms; first beat after interval*jitter,
  then every interval with the last seq; no ACK (op 11) between beats = zombie,
  close and resume. Identify op 2 {token, intents, properties{os,browser,device}};
  READY gives user, session_id, resume_gateway_url; Resume op 6 {token,
  session_id, seq} goes to resume_gateway_url. Op 7 = reconnect+resume; op 9 d=false
  = identify again. Close 4004 = auth failed; 4010-4014 must not reconnect
  (4014 = privileged intent, i.e. Message Content Intent not enabled).
  https://docs.discord.com/developers/events/gateway
- Intents: GUILDS 1<<0, GUILD_MESSAGES 1<<9, DIRECT_MESSAGES 1<<12,
  MESSAGE_CONTENT 1<<15 (privileged; without it content is empty except DMs/mentions).
- A thread is a channel: POST /channels/{id}/threads {name<=100, type 11
  PUBLIC_THREAD, auto_archive_duration 60|1440|4320|10080}; send with
  POST /channels/{thread_id}/messages; POST /channels/{id}/typing lasts 10 s.
  https://docs.discord.com/developers/resources/channel
- Content max 2000 chars; edit = PATCH /channels/{cid}/messages/{mid}; buttons =
  action row (type 1) of buttons (type 2) with custom_id <= 100 chars.
  https://docs.discord.com/developers/resources/message
- 429 body {retry_after (s, float), global}; Retry-After header mirrors it; 50 req/s
  global. https://docs.discord.com/developers/topics/rate-limits
Gaps: MESSAGE_CREATE has no parent id for thread messages; parents come from
THREAD_CREATE/UPDATE/LIST_SYNC, GUILD_CREATE.threads, else GET /channels/{id}.
Not verified against a live bot account (tests use a local fake gateway).
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import random
import re
import time
from pathlib import Path
from typing import Any, BinaryIO, Callable
from urllib.parse import urlsplit

import httpx
from websockets.asyncio.client import connect as ws_connect
from websockets.exceptions import ConnectionClosed

from .adapter_runtime import ReceiveLoop, ReconnectNow, download_to, error_text, media_client, send_request
from .base import (
    STALL_WATCHDOG_S,
    AdapterStatus,
    Capabilities,
    ChannelAuthError,
    ChannelSendError,
    Emit,
    InboundAttachment,
    InboundMessage,
    Location,
    backoff_delay,
)
from .report import Caption
from .text import TEXT_LIMITS, chunk_discord

# Characters that would start Discord markdown inside a card title.
_MARKDOWN_RE = re.compile(r"[\\*_~`|]")

log = logging.getLogger(__name__)

DEFAULT_BASE_URL = "https://discord.com/api/v10"
GATEWAY_QUERY = "v=10&encoding=json"
INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15)
# VIEW_CHANNEL, SEND_MESSAGES, READ_MESSAGE_HISTORY, CREATE_PUBLIC_THREADS, SEND_MESSAGES_IN_THREADS
# (https://docs.discord.com/developers/topics/permissions).
INSTALL_PERMISSIONS = (1 << 10) | (1 << 11) | (1 << 16) | (1 << 35) | (1 << 38)
THREAD_TYPES = {10, 11, 12}
# Message types that carry user text: DEFAULT and REPLY.
TEXT_MESSAGE_TYPES = {0, 19}
# https://docs.discord.com/developers/reference#uploading-files: "The default limit is 20 MiB
# for all users, but may be higher ... by the server's Boost Tier"; one message request is
# capped at 25 MiB. The default is what every server allows.
UPLOAD_MAX_BYTES = 20 * 1024 * 1024
# Attachment URLs are signed CDN links; nothing else is fetched, and never with the bot token.
CDN_HOSTS = {"cdn.discordapp.com", "media.discordapp.net"}
FATAL_CLOSE_CODES = {
    4004: "Discord rejected the bot token (4004)",
    4010: "invalid shard (4010)",
    4011: "sharding required (4011)",
    4012: "invalid gateway API version (4012)",
    4013: "invalid intents (4013)",
    4014: "Message Content Intent is not enabled for this bot (4014)",
}


class DiscordAdapter:
    platform = "discord"
    capabilities = Capabilities(
        threads=True, create_location=True, edit=True, typing=True, buttons=True,
        text_limit=TEXT_LIMITS["discord"],
    )

    def __init__(
        self,
        token: str,
        *,
        account: str = "default",
        base_url: str = DEFAULT_BASE_URL,
        backoff: Callable[[int, float], float] = backoff_delay,
        stall_timeout_s: float = STALL_WATCHDOG_S,
        invalid_session_wait_s: float = 2.0,
    ) -> None:
        self._token = token.strip()
        self.account = account
        self._base = base_url.rstrip("/")
        self.status = AdapterStatus()
        self._emit: Emit | None = None
        self._client: httpx.AsyncClient | None = None
        self._loop = ReceiveLoop(
            "discord", self.status, self._connect_once,
            stall_s=stall_timeout_s, delay=lambda n: backoff(n, random.random()),
        )
        self._invalid_session_wait_s = invalid_session_wait_s
        self._bot_id = ""
        self._app_id = ""
        self.upload_max_bytes = UPLOAD_MAX_BYTES
        self._media_transport: httpx.AsyncBaseTransport | None = None  # tests swap in a mock
        self._session_id = ""
        self._resume_url = ""
        self._seq: int | None = None
        # channel id -> parent channel id for threads, "" for non-threads.
        self._parents: dict[str, str] = {}
        self._known: dict[str, dict[str, Any]] = {}
        self._ws_lock = asyncio.Lock()

    # --- lifecycle ------------------------------------------------------------

    def token_fingerprint(self) -> str:
        return hashlib.sha256(self._token.encode()).hexdigest()

    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                base_url=self._base,
                headers={"Authorization": f"Bot {self._token}", "User-Agent": "DiscordBot (navide, 1)"},
                timeout=httpx.Timeout(20.0, connect=10.0),
            )
        return self._client

    async def start(self, emit: Emit) -> None:
        self._emit = emit
        self._loop.start()

    async def stop(self) -> None:
        await self._loop.stop()
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    # --- gateway ----------------------------------------------------------------

    async def _gateway_url(self) -> str:
        if self._session_id and self._resume_url:
            base = self._resume_url
        else:
            resp = await send_request(self._http(), "GET", "/gateway/bot", auth_statuses=(401, 403))
            if resp.status_code != 200:
                raise ConnectionError(error_text(resp))
            base = str(resp.json().get("url") or "")
            if not base:
                raise ConnectionError("gateway url missing")
        return f"{base}&{GATEWAY_QUERY}" if "?" in base else f"{base.rstrip('/')}/?{GATEWAY_QUERY}"

    async def _connect_once(self) -> None:
        url = await self._gateway_url()
        async with ws_connect(url, max_size=None, ping_interval=None) as ws:
            hello = json.loads(await ws.recv())
            if hello.get("op") != 10:
                raise ConnectionError(f"expected Hello, got op {hello.get('op')}")
            self._loop.touch()
            interval = float(hello["d"]["heartbeat_interval"]) / 1000.0
            if self._session_id:
                await self._ws_send(ws, {"op": 6, "d": {
                    "token": self._token, "session_id": self._session_id, "seq": self._seq,
                }})
            else:
                await self._identify(ws)
            acked = asyncio.Event()
            acked.set()
            beat = asyncio.create_task(self._heartbeat(ws, interval, acked))
            try:
                await self._read(ws, acked)
            except ConnectionClosed as exc:
                code = exc.rcvd.code if exc.rcvd else None
                if code in FATAL_CLOSE_CODES:
                    raise ChannelAuthError(FATAL_CLOSE_CODES[code]) from exc
                raise ConnectionError(f"gateway closed ({code})") from exc
            finally:
                beat.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await beat

    async def _ws_send(self, ws: Any, payload: dict[str, Any]) -> None:
        """The only websocket writer: every frame goes through one lock."""
        async with self._ws_lock:
            await ws.send(json.dumps(payload))

    async def _identify(self, ws: Any) -> None:
        await self._ws_send(ws, {"op": 2, "d": {
            "token": self._token,
            "intents": INTENTS,
            "properties": {"os": "navide", "browser": "navide", "device": "navide"},
        }})

    async def _heartbeat(self, ws: Any, interval: float, acked: asyncio.Event) -> None:
        await asyncio.sleep(interval * random.random())
        while True:
            if not acked.is_set():
                # Zombie connection: close with a non-1000 code so the session can resume.
                await ws.close(code=4000, reason="heartbeat not acknowledged")
                return
            acked.clear()
            await self._ws_send(ws, {"op": 1, "d": self._seq})
            await asyncio.sleep(interval)

    async def _read(self, ws: Any, acked: asyncio.Event) -> None:
        async for raw in ws:
            msg = json.loads(raw)
            op = msg.get("op")
            if msg.get("s") is not None:
                self._seq = msg["s"]
            if op == 11:
                acked.set()
                self._loop.touch()
            elif op == 1:
                await self._ws_send(ws, {"op": 1, "d": self._seq})
            elif op == 7:
                raise ReconnectNow("server requested reconnect")
            elif op == 9:
                if not msg.get("d"):
                    self._session_id = ""
                    self._resume_url = ""
                    self._seq = None
                await asyncio.sleep(self._invalid_session_wait_s)
                raise ReconnectNow("invalid session")
            elif op == 0:
                self._loop.touch()
                await self._dispatch(msg.get("t") or "", msg.get("d") or {})

    async def _dispatch(self, event: str, d: dict[str, Any]) -> None:
        if event == "READY":
            user = d.get("user") or {}
            self._bot_id = str(user.get("id") or "")
            self._app_id = str((d.get("application") or {}).get("id") or "")
            self._session_id = str(d.get("session_id") or "")
            self._resume_url = str(d.get("resume_gateway_url") or "")
            self._loop.mark_ready(f"@{user.get('username', '')}" if user.get("username") else "")
        elif event == "RESUMED":
            self._loop.mark_ready()
        elif event == "GUILD_CREATE":
            for ch in d.get("threads") or []:
                self._remember_channel(ch)
            for ch in d.get("channels") or []:
                if ch.get("type") in (0, 5):  # GUILD_TEXT, GUILD_ANNOUNCEMENT: threads allowed
                    self._known[str(ch["id"])] = {
                        "chat_id": str(ch["id"]), "title": f"#{ch.get('name', '')}",
                        "kind": "channel", "supports_topics": True,
                    }
        elif event in ("THREAD_CREATE", "THREAD_UPDATE"):
            self._remember_channel(d)
        elif event == "THREAD_LIST_SYNC":
            for ch in d.get("threads") or []:
                self._remember_channel(ch)
        elif event == "MESSAGE_CREATE":
            await self._on_message(d)
        elif event == "INTERACTION_CREATE":
            await self._on_interaction(d)

    def _remember_channel(self, ch: dict[str, Any]) -> None:
        cid = str(ch.get("id") or "")
        if not cid:
            return
        self._parents[cid] = str(ch.get("parent_id") or "") if ch.get("type") in THREAD_TYPES else ""

    async def _parent_of(self, channel_id: str) -> str:
        if channel_id in self._parents:
            return self._parents[channel_id]
        try:
            resp = await self._http().get(f"/channels/{channel_id}")
        except httpx.HTTPError:
            return ""
        if resp.status_code == 200:
            self._remember_channel(resp.json())
            return self._parents.get(channel_id, "")
        return ""

    async def _location_of(self, channel_id: str) -> tuple[str, str]:
        parent = await self._parent_of(channel_id)
        return (parent, channel_id) if parent else (channel_id, "")

    async def _on_message(self, d: dict[str, Any]) -> None:
        author = d.get("author") or {}
        if author.get("bot") or str(author.get("id") or "") == self._bot_id:
            return
        if d.get("type", 0) not in TEXT_MESSAGE_TYPES or self._emit is None:
            return
        channel_id = str(d.get("channel_id") or "")
        chat_id, thread_id = await self._location_of(channel_id)
        if not d.get("guild_id"):
            self._known[chat_id] = {"chat_id": chat_id, "title": str(author.get("username") or chat_id),
                                    "kind": "dm", "supports_topics": False}
        self.status.last_inbound_at = time.time()
        # A reply's gateway payload carries the message it answers. A forward (reference
        # type 1) is not a reply, and a webhook's author is whatever the webhook says.
        reference = d.get("message_reference") or {}
        quoted = (d.get("referenced_message") or {}) if (reference.get("type") or 0) == 0 else {}
        quoted_author = {} if quoted.get("webhook_id") else (quoted.get("author") or {})
        await self._emit(InboundMessage(
            platform=self.platform, account=self.account, chat_id=chat_id, thread_id=thread_id,
            sender_id=str(author.get("id") or ""),
            sender_name=str(author.get("global_name") or author.get("username") or ""),
            text=str(d.get("content") or ""), message_id=str(d.get("id") or ""),
            is_direct=not d.get("guild_id"), ts=time.time(),
            reply_to_id=str((d.get("message_reference") or {}).get("message_id") or ""),
            reply_to_text=str(quoted.get("content") or ""),
            reply_to_sender=str(quoted_author.get("global_name") or quoted_author.get("username") or ""),
            reply_to_sender_id=str(quoted_author.get("id") or ""),
            reply_to_self=bool(self._bot_id) and str(quoted_author.get("id") or "") == self._bot_id,
            attachments=[_attachment(a) for a in d.get("attachments") or [] if a.get("url")],
        ))

    async def _on_interaction(self, d: dict[str, Any]) -> None:
        if d.get("type") != 3:  # MESSAGE_COMPONENT
            return
        user = (d.get("member") or {}).get("user") or d.get("user") or {}
        # Acknowledge within 3 s (DEFERRED_UPDATE_MESSAGE) so the button does not error.
        with contextlib.suppress(httpx.HTTPError, ChannelSendError, ChannelAuthError):
            await send_request(
                self._http(), "POST", f"/interactions/{d.get('id')}/{d.get('token')}/callback",
                json={"type": 6},
            )
        if self._emit is None:
            return
        channel_id = str(d.get("channel_id") or "")
        chat_id, thread_id = await self._location_of(channel_id)
        self.status.last_inbound_at = time.time()
        await self._emit(InboundMessage(
            platform=self.platform, account=self.account, chat_id=chat_id, thread_id=thread_id,
            sender_id=str(user.get("id") or ""),
            sender_name=str(user.get("global_name") or user.get("username") or ""),
            text="", message_id=f"interaction:{d.get('id')}",
            is_direct=not d.get("guild_id"), ts=time.time(),
            callback_data=str((d.get("data") or {}).get("custom_id") or ""),
        ))

    def link_url(self, code: str, target: str) -> str:
        """Bot install URL for a server (https://docs.discord.com/developers/topics/oauth2#bot-authorization-flow);
        the code is then sent in a channel with an @mention, or in a DM."""
        if target != "group" or not self._app_id:
            return ""
        return f"https://discord.com/oauth2/authorize?client_id={self._app_id}&scope=bot&permissions={INSTALL_PERMISSIONS}"

    def known_locations(self) -> list[dict[str, Any]]:
        """Chats seen so far, for the "use existing" picker."""
        return list(self._known.values())

    # --- outbound -------------------------------------------------------------

    @staticmethod
    def _target(loc: Location) -> str:
        return loc.thread_id or loc.chat_id

    async def _write(self, method: str, path: str, body: dict[str, Any] | None = None) -> httpx.Response:
        try:
            resp = await send_request(self._http(), method, path, json=body)
        except ChannelAuthError as exc:
            raise ChannelSendError(str(exc)) from exc
        if resp.status_code >= 400:
            raise ChannelSendError(error_text(resp))
        return resp

    async def send_text(
        self, loc: Location, text: str, *, buttons: list[tuple[str, str]] | None = None
    ) -> list[str]:
        chunks = chunk_discord(text) or [text or "…"]
        ids: list[str] = []
        for i, chunk in enumerate(chunks):
            body: dict[str, Any] = {"content": chunk, "allowed_mentions": {"parse": []}}
            if buttons and i == len(chunks) - 1:
                body["components"] = [{"type": 1, "components": [
                    {"type": 2, "style": 1 if n == 0 else 2, "label": label[:80], "custom_id": data[:100]}
                    for n, (label, data) in enumerate(buttons[:5])
                ]}]
            resp = await self._write("POST", f"/channels/{self._target(loc)}/messages", body)
            ids.append(str(resp.json().get("id") or ""))
        return ids

    async def download(self, att: InboundAttachment, dest: Path, max_bytes: int) -> int:
        parts = urlsplit(att.ref)
        if parts.scheme != "https" or parts.hostname not in CDN_HOSTS:
            raise ChannelSendError(f"not a Discord CDN URL: {parts.scheme}://{parts.hostname}")
        async with media_client(self._media_transport) as client:  # no Authorization header
            return await download_to(client, att.ref, dest, max_bytes)

    async def send_file(self, loc: Location, fh: BinaryIO, filename: str,
                        caption: Caption | None = None) -> list[str]:
        payload: dict[str, Any] = {"attachments": [{"id": 0, "filename": filename}], "allowed_mentions": {"parse": []}}
        if caption is not None:
            title = _MARKDOWN_RE.sub(r"\\\g<0>", caption.title)
            lines = (f"📄 **{title}**", caption.summary, caption.info)
            payload["content"] = "\n".join(line for line in lines if line)[: self.capabilities.text_limit]
        content = await asyncio.to_thread(fh.read)
        try:
            resp = await send_request(self._http(), "POST", f"/channels/{self._target(loc)}/messages",
                                      data={"payload_json": json.dumps(payload)},
                                      files={"files[0]": (filename, content)})
        except ChannelAuthError as exc:
            raise ChannelSendError(str(exc)) from exc
        if resp.status_code >= 400:
            raise ChannelSendError(error_text(resp))
        return [str(resp.json().get("id") or "")]

    async def edit_text(self, loc: Location, message_id: str, text: str) -> None:
        # An edit replaces the message, buttons included (Telegram drops them too).
        body = {"content": text[: self.capabilities.text_limit], "allowed_mentions": {"parse": []},
                "components": []}
        await self._write("PATCH", f"/channels/{self._target(loc)}/messages/{message_id}", body)

    @staticmethod
    def _action_rows(rows: list[list[tuple[str, str]]]) -> list[dict[str, Any]]:
        # Five buttons an action row, five rows a message.
        return [{"type": 1, "components": [
            {"type": 2, "style": 2, "label": label[:38], "custom_id": data[:100]} for label, data in row[:5]
        ]} for row in rows[:5]]

    async def send_menu(self, loc: Location, text: str, rows: list[list[tuple[str, str]]]) -> str:
        """One message carrying ``rows`` of buttons (the quick menu); its id."""
        body = {"content": text[: self.capabilities.text_limit], "allowed_mentions": {"parse": []},
                "components": self._action_rows(rows)}
        resp = await self._write("POST", f"/channels/{self._target(loc)}/messages", body)
        return str(resp.json().get("id") or "")

    async def edit_menu(self, loc: Location, message_id: str, text: str, rows: list[list[tuple[str, str]]]) -> None:
        body = {"content": text[: self.capabilities.text_limit], "allowed_mentions": {"parse": []},
                "components": self._action_rows(rows)}
        await self._write("PATCH", f"/channels/{self._target(loc)}/messages/{message_id}", body)

    async def send_typing(self, loc: Location) -> None:
        await self._write("POST", f"/channels/{self._target(loc)}/typing")

    async def create_location(self, chat_id: str, title: str) -> Location:
        name = (title or "navide").strip()[:100] or "navide"
        resp = await self._write("POST", f"/channels/{chat_id}/threads", {
            "name": name, "type": 11, "auto_archive_duration": 10080,
        })
        thread_id = str(resp.json().get("id") or "")
        self._parents[thread_id] = chat_id
        return Location(self.platform, self.account, chat_id, thread_id, name)


def create_adapter(config: dict[str, Any], secret: dict[str, Any], *, store: Any = None) -> DiscordAdapter:
    token = str(secret.get("token") or "").strip()
    if not token:
        raise ValueError("missing bot token")
    return DiscordAdapter(token, account=str(config.get("account") or "default"))


def _attachment(a: dict[str, Any]) -> InboundAttachment:
    mime = str(a.get("content_type") or "")
    kind = {"image": "photo", "video": "video", "audio": "audio"}.get(mime.split("/", 1)[0], "document")
    return InboundAttachment(kind, str(a.get("filename") or ""), a.get("size"), mime, str(a["url"]))

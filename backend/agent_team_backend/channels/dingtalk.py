"""DingTalk adapter: Stream mode (outbound WebSocket) for inbound, robot OpenAPI for outbound.

Verified facts (read 2026-09-24; open.dingtalk.com pages are JS-rendered, so the
protocol was read from the official SDK, github.com/open-dingtalk/dingtalk-stream-sdk-python):
- Open a connection: POST https://api.dingtalk.com/v1.0/gateway/connections/open
  {clientId, clientSecret, subscriptions:[{type:"CALLBACK", topic}], ua, localIp}
  -> {endpoint, ticket}; then connect a websocket to f"{endpoint}?ticket={ticket}".
- Frames are JSON {specVersion, type: SYSTEM|EVENT|CALLBACK, headers{messageId, topic,
  contentType, ...}, data: <JSON string>}. SYSTEM topic "ping" must be acked (echo data);
  SYSTEM topic "disconnect" means reconnect. Every frame is acked with
  {code: 200, headers{messageId, contentType}, message, data: <JSON string>}.
- Robot messages arrive as CALLBACK topic "/v1.0/im/bot/messages/get"; data carries
  msgId, conversationId, conversationType ("1" single chat, "2" group), senderStaffId,
  senderId, senderNick, conversationTitle, createAt (ms), msgtype text -> text.content.
- Access token: POST /v1.0/oauth2/accessToken {appKey, appSecret} -> {accessToken, expireIn}.
- Group send: POST /v1.0/robot/groupMessages/send {robotCode, openConversationId, msgKey,
  msgParam (JSON string)}; single chat: POST /v1.0/robot/oToMessages/batchSend
  {robotCode, userIds, msgKey, msgParam}; header x-acs-dingtalk-access-token. robotCode is
  the app's client id for self-built apps (as the SDK uses it). Returns processQueryKey.
  (search result summary of open.dingtalk.com "机器人发送群聊消息")
Gaps: no threads (a pane is a whole group); bots cannot create groups, edit plain robot
messages, show typing, or send callback buttons (ActionCard buttons are URLs), so those
capabilities are off. Rejected credentials on connections/open are assumed to be 400/401/403
(error bodies not documented in the SDK). Rate limits and 429 behaviour are not verified.
Not verified against a live DingTalk app (tests use a local fake server).
Replies (InboundMessage.reply_to_id): not mappable. The robot send API returns
processQueryKey, never the msgId a quoted reply would name, so a reply cannot be tied
to a bot message; reply_to_id stays empty (``@name`` still routes to a child).
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import random
import time
from typing import Any, Callable
from urllib.parse import quote_plus

import httpx
from websockets.asyncio.client import connect as ws_connect
from websockets.exceptions import ConnectionClosed

from .adapter_runtime import ReceiveLoop, ReconnectNow, error_text, send_request, ws_keepalive
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
from .text import TEXT_LIMITS, chunk_text

log = logging.getLogger(__name__)

DEFAULT_BASE_URL = "https://api.dingtalk.com"
BOT_MESSAGE_TOPIC = "/v1.0/im/bot/messages/get"
# chat_id prefix for single chats: they are addressed by the user's staff id, not
# the conversation id, so a Location survives restarts without a lookup.
DM_PREFIX = "user:"
AUTH_STATUSES = (400, 401, 403)
TOKEN_REFRESH_MARGIN_S = 300


class DingTalkAdapter:
    platform = "dingtalk"
    capabilities = Capabilities(
        threads=False, create_location=False, edit=False, typing=False, buttons=False,
        text_limit=TEXT_LIMITS["dingtalk"],
    )
    # A custom robot may send 20 messages a minute; the mirror outbox paces to this.
    rate_per_min = 20.0

    def __init__(
        self,
        client_id: str,
        client_secret: str,
        *,
        account: str = "default",
        robot_code: str = "",
        base_url: str = DEFAULT_BASE_URL,
        backoff: Callable[[int, float], float] = backoff_delay,
        stall_timeout_s: float = STALL_WATCHDOG_S,
        ping_interval_s: float = 30.0,
    ) -> None:
        self._client_id = client_id.strip()
        self._client_secret = client_secret.strip()
        self._robot_code = robot_code.strip() or self._client_id
        self.account = account
        self._base = base_url.rstrip("/")
        self._ping_interval_s = ping_interval_s
        self.status = AdapterStatus()
        self._emit: Emit | None = None
        self._client: httpx.AsyncClient | None = None
        self._loop = ReceiveLoop(
            "dingtalk", self.status, self._connect_once,
            stall_s=stall_timeout_s, delay=lambda n: backoff(n, random.random()),
        )
        self._token = ""
        self._token_expires_at = 0.0
        self._known_chats: dict[str, dict[str, Any]] = {}
        self._send_lock = asyncio.Lock()

    # --- lifecycle ------------------------------------------------------------

    def token_fingerprint(self) -> str:
        return hashlib.sha256(f"{self._client_id}:{self._client_secret}".encode()).hexdigest()

    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(base_url=self._base, timeout=httpx.Timeout(20.0, connect=10.0))
        return self._client

    async def start(self, emit: Emit) -> None:
        self._emit = emit
        self._loop.start()

    async def stop(self) -> None:
        await self._loop.stop()
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    def known_locations(self) -> list[dict[str, Any]]:
        return list(self._known_chats.values())

    # --- stream connection ----------------------------------------------------

    async def _open_connection(self) -> str:
        body = {
            "clientId": self._client_id,
            "clientSecret": self._client_secret,
            "subscriptions": [{"type": "CALLBACK", "topic": BOT_MESSAGE_TOPIC}],
            "ua": "navide-channels",
            "localIp": "",
        }
        resp = await send_request(self._http(), "POST", "/v1.0/gateway/connections/open",
                                  json=body, auth_statuses=AUTH_STATUSES)
        if resp.status_code != 200:
            raise ConnectionError(error_text(resp))
        data = resp.json()
        endpoint, ticket = str(data.get("endpoint") or ""), str(data.get("ticket") or "")
        if not endpoint or not ticket:
            raise ConnectionError("connections/open returned no endpoint")
        return f"{endpoint}?ticket={quote_plus(ticket)}"

    async def _connect_once(self) -> None:
        url = await self._open_connection()
        async with ws_connect(url, max_size=None, ping_interval=None) as ws:
            self._loop.mark_ready()
            keepalive = asyncio.create_task(ws_keepalive(ws, self._loop.touch, self._ping_interval_s))
            try:
                async for raw in ws:
                    self._loop.touch()
                    try:
                        frame = json.loads(raw)
                    except (TypeError, ValueError):
                        continue
                    await self._handle_frame(ws, frame)
            except ConnectionClosed as exc:
                code = exc.rcvd.code if exc.rcvd else None
                raise ConnectionError(f"stream closed ({code})") from exc
            finally:
                keepalive.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await keepalive

    async def _handle_frame(self, ws: Any, frame: dict[str, Any]) -> None:
        headers = frame.get("headers") or {}
        kind = frame.get("type")
        topic = headers.get("topic")
        if kind == "SYSTEM":
            await self._ack(ws, headers, frame.get("data") or "{}")
            if topic == "disconnect":
                raise ReconnectNow("server requested disconnect")
            return
        if kind == "CALLBACK" and topic == BOT_MESSAGE_TOPIC:
            try:
                data = json.loads(frame.get("data") or "{}")
            except ValueError:
                data = {}
            await self._on_bot_message(data)
            await self._ack(ws, headers, json.dumps({"response": None}))
            return
        await self._ack(ws, headers, "{}", code=404, message="not implement")

    async def _ws_send(self, ws: Any, data: str) -> None:
        """The only raw websocket write (single-writer invariant, test_ws_single_writer)."""
        async with self._send_lock:
            await ws.send(data)

    async def _ack(self, ws: Any, headers: dict[str, Any], data: str, *, code: int = 200,
                   message: str = "OK") -> None:
        await self._ws_send(ws, json.dumps({
            "code": code,
            "headers": {"messageId": headers.get("messageId", ""), "contentType": "application/json"},
            "message": message,
            "data": data,
        }))

    async def _on_bot_message(self, d: dict[str, Any]) -> None:
        text = _message_text(d)
        # A file is reported, not fetched: this adapter has no media support yet.
        kind = MEDIA_MSGTYPES.get(str(d.get("msgtype") or ""))
        files = [InboundAttachment(kind, "", None, "", "")] if kind else []
        if not (text or files) or self._emit is None:
            return
        is_direct = str(d.get("conversationType") or "") == "1"
        sender_id = str(d.get("senderStaffId") or d.get("senderId") or "")
        sender_name = str(d.get("senderNick") or sender_id)
        if is_direct:
            chat_id = f"{DM_PREFIX}{sender_id}"
            title = sender_name
        else:
            chat_id = str(d.get("conversationId") or "")
            title = str(d.get("conversationTitle") or chat_id)
        if not chat_id or not sender_id:
            return
        self._known_chats[chat_id] = {
            "chat_id": chat_id, "title": title, "kind": "direct" if is_direct else "group",
            "supports_topics": False,
        }
        created = d.get("createAt")
        self.status.last_inbound_at = time.time()
        await self._emit(InboundMessage(
            platform=self.platform, account=self.account, chat_id=chat_id, thread_id="",
            sender_id=sender_id, sender_name=sender_name, text=text,
            message_id=str(d.get("msgId") or ""), is_direct=is_direct,
            ts=float(created) / 1000.0 if isinstance(created, (int, float)) else time.time(),
            attachments=files,
        ))

    # --- outbound -------------------------------------------------------------

    async def _access_token(self, *, force: bool = False) -> str:
        if not force and self._token and time.monotonic() < self._token_expires_at:
            return self._token
        try:
            resp = await send_request(self._http(), "POST", "/v1.0/oauth2/accessToken", json={
                "appKey": self._client_id, "appSecret": self._client_secret,
            }, auth_statuses=AUTH_STATUSES)
        except ChannelAuthError as exc:
            raise ChannelSendError(f"credential rejected: {exc}") from exc
        if resp.status_code != 200:
            raise ChannelSendError(error_text(resp), retryable=True)
        data = resp.json()
        self._token = str(data.get("accessToken") or "")
        expire_in = float(data.get("expireIn") or 7200)
        self._token_expires_at = time.monotonic() + max(60.0, expire_in - TOKEN_REFRESH_MARGIN_S)
        return self._token

    async def _post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        for refreshed in (False, True):
            token = await self._access_token(force=refreshed)
            resp = await send_request(self._http(), "POST", path, json=body, auth_statuses=(),
                                      headers={"x-acs-dingtalk-access-token": token})
            # 401 = expired token: the request was rejected, so one retry is safe.
            if resp.status_code == 401 and not refreshed:
                continue
            if resp.status_code >= 400:
                raise ChannelSendError(error_text(resp))
            return resp.json()
        raise ChannelSendError("access token rejected")

    async def send_text(
        self, loc: Location, text: str, *, buttons: list[tuple[str, str]] | None = None
    ) -> list[str]:
        ids: list[str] = []
        for chunk in chunk_text(text, self.capabilities.text_limit) or [text or "…"]:
            title = chunk.strip().split("\n", 1)[0][:40] or "Navide"
            msg = {"msgKey": "sampleMarkdown", "msgParam": json.dumps({"title": title, "text": chunk},
                                                                        ensure_ascii=False)}
            if loc.chat_id.startswith(DM_PREFIX):
                result = await self._post("/v1.0/robot/oToMessages/batchSend", {
                    "robotCode": self._robot_code, "userIds": [loc.chat_id[len(DM_PREFIX):]], **msg,
                })
            else:
                result = await self._post("/v1.0/robot/groupMessages/send", {
                    "robotCode": self._robot_code, "openConversationId": loc.chat_id, **msg,
                })
            ids.append(str(result.get("processQueryKey") or ""))
        return ids

    async def edit_text(self, loc: Location, message_id: str, text: str) -> None:
        raise NotImplementedError("DingTalk robot messages cannot be edited")

    async def send_typing(self, loc: Location) -> None:
        return None

    async def create_location(self, chat_id: str, title: str) -> Location:
        raise NotImplementedError("DingTalk bots cannot create groups; bind an existing group")


MEDIA_MSGTYPES = {"picture": "photo", "file": "document", "video": "video", "audio": "audio"}


def _message_text(d: dict[str, Any]) -> str:
    kind = d.get("msgtype")
    if kind == "text":
        return str((d.get("text") or {}).get("content") or "").strip()
    if kind == "richText":
        parts = ((d.get("content") or {}).get("richText")) or []
        return "".join(str(p.get("text") or "") for p in parts if isinstance(p, dict)).strip()
    return ""


def create_adapter(config: dict[str, Any], secret: dict[str, Any], *, store: Any = None) -> DingTalkAdapter:
    """Manager entry point: secret = {client_id, client_secret}; config may set robot_code."""
    return DingTalkAdapter(
        str(secret.get("client_id") or ""), str(secret.get("client_secret") or ""),
        account=str(config.get("account") or "default"),
        robot_code=str(config.get("robot_code") or ""),
    )

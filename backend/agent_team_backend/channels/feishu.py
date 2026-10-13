"""Feishu / Lark adapter: long-connection WebSocket for inbound, IM v1 REST for outbound.

Verified facts (read 2026-09-24):
- Long connection (official SDK, github.com/larksuite/oapi-sdk-python lark_oapi/ws): POST
  {domain}/callback/ws/endpoint {"AppID","AppSecret"} -> {code, msg, data{URL, ClientConfig
  {PingInterval, ReconnectCount, ReconnectInterval, ReconnectNonce}}}; the URL query carries
  device_id and service_id. code 1 / 1000040343 = server busy; other non-zero codes are
  client errors (403 forbidden, 514 auth failed, 1000040350 connection limit). A rejected
  websocket handshake carries handshake-status / handshake-msg headers.
- Frames are protobuf (pbbp2.proto, proto2): Header{key=1,value=2}; Frame{SeqID=1 uint64,
  LogID=2 uint64, service=3 int32, method=4 int32, headers=5, payload_encoding=6,
  payload_type=7, payload=8 bytes, LogIDNew=9}. method 0 = control (headers type ping/pong;
  a pong payload may carry a new ClientConfig JSON), 1 = data (headers type event|card,
  message_id, sum, seq, trace_id; sum>1 = split payload). A data frame is answered by
  sending the same frame back with payload {"code":200}. Encoded here by hand (varint +
  length-delimited only); tests check it against bytes produced by the SDK's protobuf.
- im.message.receive_v1 (open.feishu.cn/document/server-docs/im-v1/message/events/receive):
  event.sender{sender_id{open_id,...}, sender_type}, event.message{message_id, root_id,
  parent_id, thread_id, chat_id, chat_type p2p|group, message_type, content (JSON string)}.
- tenant_access_token: POST /open-apis/auth/v3/tenant_access_token/internal {app_id,
  app_secret} -> {code, msg, tenant_access_token, expire (s, <= 2h)}.
- Send: POST /open-apis/im/v1/messages?receive_id_type=chat_id {receive_id, msg_type,
  content, uuid}; reply: POST /open-apis/im/v1/messages/{id}/reply {content, msg_type,
  reply_in_thread, uuid} (open.feishu.cn/document/server-docs/im-v1/message/reply); uuid
  de-duplicates repeats for 1 h, so retries are safe. 5 QPS per chat; 230020 = rate
  limited; 230071 = chat does not support thread replies; 230019 = thread gone.
- Edit: PUT /open-apis/im/v1/messages/{id} (text/post only, max 20 edits, admin time window
  230075) (open.feishu.cn/document/server-docs/im-v1/message/update).
Gaps: a pane is a thread rooted at a bot message (create_location posts the title and the
thread materialises on the first reply). Group messages reach the bot only when it is
@mentioned unless the app has the "read all group messages" scope. No typing indicator or
card buttons (card callbacks are not handled). sender_name falls back to open_id when the
app lacks contact read scope. Not verified against a live Feishu app.
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
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable
from urllib.parse import parse_qs, urlsplit

import httpx
from websockets.asyncio.client import connect as ws_connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

from .adapter_runtime import ReceiveLoop, error_text, send_request
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

FEISHU_BASE_URL = "https://open.feishu.cn"
LARK_BASE_URL = "https://open.larksuite.com"
BUSY_CODES = {1, 1000040343}
CONN_LIMIT_CODE = 1000040350
TOKEN_INVALID_CODES = {99991661, 99991663, 99991668}
RATE_LIMIT_CODES = {230020, 99991400}
SEND_RATE_RETRIES = 3
TOKEN_REFRESH_MARGIN_S = 300
_MENTION_RE = re.compile(r"@_user_\d+\s?")


# --- pbbp2 frame codec ---------------------------------------------------------


@dataclass
class Frame:
    seq_id: int = 0
    log_id: int = 0
    service: int = 0
    method: int = 0
    headers: list[tuple[str, str]] = field(default_factory=list)
    payload_encoding: str = ""
    payload_type: str = ""
    payload: bytes | None = None
    log_id_new: str = ""

    def header(self, key: str) -> str:
        for k, v in self.headers:
            if k == key:
                return v
        return ""


def _varint(n: int) -> bytes:
    n &= (1 << 64) - 1
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def _read_varint(buf: bytes, i: int) -> tuple[int, int]:
    shift = result = 0
    while True:
        if i >= len(buf) or shift > 63:
            raise ValueError("truncated varint")
        b = buf[i]
        i += 1
        result |= (b & 0x7F) << shift
        if not b & 0x80:
            return result, i
        shift += 7


def _bytes_field(num: int, data: bytes) -> bytes:
    return _varint(num << 3 | 2) + _varint(len(data)) + data


def _int_field(num: int, value: int) -> bytes:
    return _varint(num << 3) + _varint(value)


def encode_frame(f: Frame) -> bytes:
    out = bytearray()
    # Fields 1-4 are proto2 `required`: always written.
    out += _int_field(1, f.seq_id)
    out += _int_field(2, f.log_id)
    out += _int_field(3, f.service)
    out += _int_field(4, f.method)
    for k, v in f.headers:
        out += _bytes_field(5, _bytes_field(1, k.encode()) + _bytes_field(2, v.encode()))
    if f.payload_encoding:
        out += _bytes_field(6, f.payload_encoding.encode())
    if f.payload_type:
        out += _bytes_field(7, f.payload_type.encode())
    if f.payload is not None:
        out += _bytes_field(8, f.payload)
    if f.log_id_new:
        out += _bytes_field(9, f.log_id_new.encode())
    return bytes(out)


def _fields(buf: bytes):
    i = 0
    while i < len(buf):
        key, i = _read_varint(buf, i)
        num, wire = key >> 3, key & 7
        if wire == 0:
            value, i = _read_varint(buf, i)
            yield num, value
        elif wire == 2:
            size, i = _read_varint(buf, i)
            if i + size > len(buf):
                raise ValueError("truncated field")
            yield num, buf[i:i + size]
            i += size
        elif wire == 1:
            i += 8
        elif wire == 5:
            i += 4
        else:
            raise ValueError(f"unsupported wire type {wire}")


def _signed32(n: int) -> int:
    n &= 0xFFFFFFFF
    return n - (1 << 32) if n & 0x80000000 else n


def decode_frame(buf: bytes) -> Frame:
    f = Frame()
    for num, value in _fields(buf):
        if num == 1:
            f.seq_id = value
        elif num == 2:
            f.log_id = value
        elif num == 3:
            f.service = _signed32(value)
        elif num == 4:
            f.method = _signed32(value)
        elif num == 5:
            k = v = ""
            for hnum, hval in _fields(value):
                if hnum == 1:
                    k = hval.decode()
                elif hnum == 2:
                    v = hval.decode()
            f.headers.append((k, v))
        elif num == 6:
            f.payload_encoding = value.decode()
        elif num == 7:
            f.payload_type = value.decode()
        elif num == 8:
            f.payload = bytes(value)
        elif num == 9:
            f.log_id_new = value.decode()
    return f


METHOD_CONTROL = 0
METHOD_DATA = 1


# --- adapter ---------------------------------------------------------------------


class FeishuAdapter:
    platform = "feishu"
    capabilities = Capabilities(
        threads=True, create_location=True, edit=True, typing=False, buttons=False,
        text_limit=TEXT_LIMITS["feishu"],
    )

    def __init__(
        self,
        app_id: str,
        app_secret: str,
        *,
        account: str = "default",
        base_url: str = FEISHU_BASE_URL,
        backoff: Callable[[int, float], float] = backoff_delay,
        stall_timeout_s: float = STALL_WATCHDOG_S,
        rate_limit_wait_s: float = 1.0,
    ) -> None:
        self._app_id = app_id.strip()
        self._app_secret = app_secret.strip()
        self.account = account
        self._base = base_url.rstrip("/")
        self._stall_s = stall_timeout_s
        self._rate_limit_wait_s = rate_limit_wait_s
        self.status = AdapterStatus()
        self._emit: Emit | None = None
        self._client: httpx.AsyncClient | None = None
        self._loop = ReceiveLoop(
            "feishu", self.status, self._connect_once,
            stall_s=stall_timeout_s, delay=lambda n: backoff(n, random.random()),
        )
        self._token = ""
        self._token_expires_at = 0.0
        self._ping_interval_s = 120.0
        self._parts: dict[str, list[bytes | None]] = {}
        self._names: dict[str, str] = {}
        self._known_chats: dict[str, dict[str, Any]] = {}
        self._send_lock = asyncio.Lock()

    # --- lifecycle ------------------------------------------------------------

    def token_fingerprint(self) -> str:
        return hashlib.sha256(f"{self._app_id}:{self._app_secret}".encode()).hexdigest()

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

    # --- long connection --------------------------------------------------------

    async def _endpoint(self) -> tuple[str, int]:
        resp = await send_request(self._http(), "POST", "/callback/ws/endpoint",
                                  json={"AppID": self._app_id, "AppSecret": self._app_secret},
                                  headers={"locale": "zh"}, auth_statuses=(401, 403))
        if resp.status_code != 200:
            raise ConnectionError(error_text(resp))
        body = resp.json()
        code = int(body.get("code") or 0)
        if code in BUSY_CODES or code == CONN_LIMIT_CODE:
            raise ConnectionError(f"endpoint {code}: {body.get('msg')}")
        if code != 0:
            raise ChannelAuthError(f"Feishu rejected the app credentials ({code}: {body.get('msg')})")
        data = body.get("data") or {}
        conf = data.get("ClientConfig") or {}
        if conf.get("PingInterval"):
            self._ping_interval_s = float(conf["PingInterval"])
        url = str(data.get("URL") or "")
        query = parse_qs(urlsplit(url).query)
        service_id = int((query.get("service_id") or ["0"])[0])
        if not url:
            raise ConnectionError("endpoint returned no URL")
        return url, service_id

    async def _connect_once(self) -> None:
        # A token proves the secret before we hold a connection; it also names the bot.
        await self._access_token(force=True)
        url, service_id = await self._endpoint()
        try:
            async with ws_connect(url, max_size=None, ping_interval=None) as ws:
                self._loop.mark_ready(await self._bot_name())
                pinger = asyncio.create_task(self._ping(ws, service_id))
                try:
                    async for raw in ws:
                        if isinstance(raw, bytes):
                            await self._handle_frame(ws, decode_frame(raw))
                finally:
                    pinger.cancel()
                    with contextlib.suppress(asyncio.CancelledError, Exception):
                        await pinger
        except InvalidStatus as exc:
            headers = exc.response.headers
            status = headers.get("handshake-status")
            if status in ("403", "514") and headers.get("handshake-autherrcode") != str(CONN_LIMIT_CODE):
                raise ChannelAuthError(f"handshake {status}: {headers.get('handshake-msg')}") from exc
            raise ConnectionError(f"handshake failed: {exc}") from exc
        except ConnectionClosed as exc:
            code = exc.rcvd.code if exc.rcvd else None
            raise ConnectionError(f"long connection closed ({code})") from exc

    async def _ws_send(self, ws: Any, data: bytes) -> None:
        """The only raw websocket write: the ping task and frame acks share this lock."""
        async with self._send_lock:
            await ws.send(data)

    async def _ping(self, ws: Any, service_id: int) -> None:
        while True:
            await self._ws_send(ws, encode_frame(Frame(service=service_id, method=METHOD_CONTROL,
                                             headers=[("type", "ping")])))
            # Ping well inside the stall watchdog so a healthy idle link is never restarted.
            await asyncio.sleep(max(1.0, min(self._ping_interval_s, self._stall_s / 4)))

    async def _handle_frame(self, ws: Any, frame: Frame) -> None:
        kind = frame.header("type")
        if frame.method == METHOD_CONTROL:
            if kind == "pong":
                self._loop.touch()
                if frame.payload:
                    with contextlib.suppress(ValueError, TypeError):
                        conf = json.loads(frame.payload)
                        if conf.get("PingInterval"):
                            self._ping_interval_s = float(conf["PingInterval"])
            return
        if frame.method != METHOD_DATA:
            return
        self._loop.touch()
        payload = self._combine(frame)
        started = time.monotonic()
        if payload is not None and kind == "event":
            with contextlib.suppress(ValueError):
                await self._on_event(json.loads(payload))
        if payload is None and int(frame.header("sum") or "1") > 1:
            return  # wait for the remaining parts
        frame.headers.append(("biz_rt", str(int((time.monotonic() - started) * 1000))))
        frame.payload = json.dumps({"code": 200}).encode()
        await self._ws_send(ws, encode_frame(frame))

    def _combine(self, frame: Frame) -> bytes | None:
        total = int(frame.header("sum") or "1")
        if total <= 1:
            return frame.payload or b""
        msg_id, seq = frame.header("message_id"), int(frame.header("seq") or "0")
        parts = self._parts.setdefault(msg_id, [None] * total)
        if 0 <= seq < total:
            parts[seq] = frame.payload or b""
        if any(p is None for p in parts):
            return None
        del self._parts[msg_id]
        return b"".join(p or b"" for p in parts)

    async def _on_event(self, body: dict[str, Any]) -> None:
        header = body.get("header") or {}
        if header.get("event_type") != "im.message.receive_v1" or self._emit is None:
            return
        event = body.get("event") or {}
        sender = event.get("sender") or {}
        if sender.get("sender_type") != "user":
            return
        msg = event.get("message") or {}
        text = _message_text(msg)
        # A file is reported, not fetched: this adapter has no media support yet.
        kind = MEDIA_MESSAGE_TYPES.get(str(msg.get("message_type") or ""))
        files = [InboundAttachment(kind, "", None, "", "")] if kind else []
        open_id = str((sender.get("sender_id") or {}).get("open_id") or "")
        chat_id = str(msg.get("chat_id") or "")
        if not (text or files) or not open_id or not chat_id:
            return
        is_direct = msg.get("chat_type") == "p2p"
        # Replies inside a thread are addressed by the thread's root message.
        thread_id = str(msg.get("root_id") or "") if msg.get("thread_id") else ""
        name = await self._sender_name(open_id)
        self._known_chats.setdefault(chat_id, {
            "chat_id": chat_id, "title": name if is_direct else chat_id,
            "kind": "direct" if is_direct else "group", "supports_topics": not is_direct,
        })
        created = msg.get("create_time")
        self.status.last_inbound_at = time.time()
        await self._emit(InboundMessage(
            platform=self.platform, account=self.account, chat_id=chat_id, thread_id=thread_id,
            sender_id=open_id, sender_name=name, text=text,
            message_id=str(msg.get("message_id") or ""), is_direct=is_direct,
            ts=int(created) / 1000.0 if str(created or "").isdigit() else time.time(),
            reply_to_id=str(msg.get("parent_id") or ""), attachments=files,
        ))

    async def _sender_name(self, open_id: str) -> str:
        if open_id in self._names:
            return self._names[open_id]
        name = open_id
        with contextlib.suppress(Exception):
            data = await self._api("GET", f"/open-apis/contact/v3/users/{open_id}",
                                   params={"user_id_type": "open_id"})
            name = str(((data.get("user") or {}).get("name")) or open_id)
        self._names[open_id] = name
        return name

    async def _bot_name(self) -> str:
        with contextlib.suppress(Exception):
            resp = await self._http().get("/open-apis/bot/v3/info", headers=await self._auth())
            bot = resp.json().get("bot") or {}
            return str(bot.get("app_name") or "")
        return ""

    # --- REST -----------------------------------------------------------------

    async def _access_token(self, *, force: bool = False) -> str:
        if not force and self._token and time.monotonic() < self._token_expires_at:
            return self._token
        resp = await send_request(self._http(), "POST", "/open-apis/auth/v3/tenant_access_token/internal",
                                  json={"app_id": self._app_id, "app_secret": self._app_secret},
                                  auth_statuses=(401, 403))
        try:
            body = resp.json()
        except ValueError:
            body = {}
        code = body.get("code") if isinstance(body, dict) else None
        if code not in (0, None):
            raise ChannelAuthError(f"Feishu rejected the app credentials ({code}: {body.get('msg')})")
        if resp.status_code != 200:
            raise ConnectionError(error_text(resp))
        self._token = str(body.get("tenant_access_token") or "")
        expire = float(body.get("expire") or 7200)
        self._token_expires_at = time.monotonic() + max(60.0, expire - TOKEN_REFRESH_MARGIN_S)
        return self._token

    async def _auth(self, *, force: bool = False) -> dict[str, str]:
        return {"Authorization": f"Bearer {await self._access_token(force=force)}"}

    async def _api(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        """One API call; ``uuid`` in the body makes sends idempotent, so retries are safe."""
        refreshed = False
        rate_retries = 0
        while True:
            try:
                headers = await self._auth(force=refreshed)
            except ChannelAuthError as exc:
                raise ChannelSendError(str(exc)) from exc
            except ConnectionError as exc:
                raise ChannelSendError(str(exc), retryable=True) from exc
            resp = await send_request(self._http(), method, path, headers=headers, auth_statuses=(),
                                      idempotent=True, **kwargs)
            try:
                body = resp.json()
            except ValueError:
                body = {}
            code = body.get("code") if isinstance(body, dict) else None
            if code in TOKEN_INVALID_CODES and not refreshed:
                refreshed = True
                continue
            if code in RATE_LIMIT_CODES and rate_retries < SEND_RATE_RETRIES:
                rate_retries += 1
                await asyncio.sleep(self._rate_limit_wait_s * rate_retries)
                continue
            if resp.status_code >= 400 or code not in (0, None):
                raise ChannelSendError(f"HTTP {resp.status_code} code {code}: {body.get('msg', '')}")
            return body.get("data") or {}

    async def _send_one(self, loc: Location, text: str) -> str:
        content = json.dumps({"text": text}, ensure_ascii=False)
        msg_uuid = uuid.uuid4().hex
        if loc.thread_id:
            data = await self._api("POST", f"/open-apis/im/v1/messages/{loc.thread_id}/reply", json={
                "msg_type": "text", "content": content, "reply_in_thread": True, "uuid": msg_uuid,
            })
        else:
            data = await self._api("POST", "/open-apis/im/v1/messages", params={"receive_id_type": "chat_id"},
                                   json={"receive_id": loc.chat_id, "msg_type": "text", "content": content,
                                         "uuid": msg_uuid})
        return str(data.get("message_id") or "")

    async def send_text(
        self, loc: Location, text: str, *, buttons: list[tuple[str, str]] | None = None
    ) -> list[str]:
        return [await self._send_one(loc, chunk)
                for chunk in chunk_text(text, self.capabilities.text_limit) or [text or "…"]]

    async def edit_text(self, loc: Location, message_id: str, text: str) -> None:
        await self._api("PUT", f"/open-apis/im/v1/messages/{message_id}", json={
            "msg_type": "text",
            "content": json.dumps({"text": text[: self.capabilities.text_limit]}, ensure_ascii=False),
        })

    async def send_typing(self, loc: Location) -> None:
        return None

    async def create_location(self, chat_id: str, title: str) -> Location:
        name = (title or "Navide").strip()[:100] or "Navide"
        root = await self._send_one(Location(self.platform, self.account, chat_id), f"🧵 {name}")
        return Location(self.platform, self.account, chat_id, root, name)


MEDIA_MESSAGE_TYPES = {"image": "photo", "file": "document", "media": "video", "audio": "audio"}


def _message_text(msg: dict[str, Any]) -> str:
    try:
        content = json.loads(msg.get("content") or "{}")
    except ValueError:
        return ""
    kind = msg.get("message_type")
    if kind == "text":
        text = str(content.get("text") or "")
    elif kind == "post":
        body = content.get("content") or next(
            (v.get("content") for v in content.values() if isinstance(v, dict) and "content" in v), [])
        lines = []
        for para in body or []:
            lines.append("".join(str(el.get("text") or "") for el in para if isinstance(el, dict)))
        text = "\n".join(lines)
    else:
        return ""
    return _MENTION_RE.sub("", text).strip()


def create_adapter(config: dict[str, Any], secret: dict[str, Any], *, store: Any = None) -> FeishuAdapter:
    """Manager entry point: secret = {app_id, app_secret}; config domain "feishu" (default) or "lark"."""
    base = LARK_BASE_URL if str(config.get("domain") or "").lower() == "lark" else FEISHU_BASE_URL
    return FeishuAdapter(
        str(secret.get("app_id") or ""), str(secret.get("app_secret") or ""),
        account=str(config.get("account") or "default"), base_url=base,
    )

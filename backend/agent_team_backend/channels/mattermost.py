"""Mattermost adapter: WebSocket API for inbound, REST API v4 for outbound.

Verified facts (mattermost/mattermost api/v4/source/*.yaml and server source, read 2026-09-24):
- Auth: "Authorization: Bearer <token>" (bot / personal access token); GET
  /api/v4/users/me returns the bot user. Errors are JSON {id, message, status_code}.
- WebSocket: standard handshake to /api/v4/websocket, authenticated by the same
  Authorization header; the server then sends a "hello" event. Events are
  {event, data, broadcast, seq}. Client actions are {action, seq, data}; typing is
  action "user_typing" with data {channel_id, parent_id}.
  https://github.com/mattermost/mattermost/blob/master/api/v4/source/introduction.yaml
- "posted" event data: post (JSON string), channel_type ("D" direct, "G" group,
  "O"/"P" channels), channel_name, channel_display_name, sender_name ("@user"),
  team_id (server/channels/app/notification.go).
- Posts: POST /api/v4/posts {channel_id, message, root_id} (root_id = thread);
  PUT /api/v4/posts/{id}/patch {message}; max post 16383 runes (PostMessageMaxRunesV2).
- Rate limit: 429 "limit exceeded" with X-Ratelimit-Reset (seconds until reset).
Gaps: interactive buttons need an integration URL the server can call back, which a
local desktop app does not have -> buttons=False. Missed events while disconnected are
not replayed (no connection_id/sequence_number resume). Not verified against a live server.
Replies (InboundMessage.reply_to_id): a Mattermost reply is a thread reply, so it is
the post's root_id (the id send_text returned). The reply also lands in that thread's
own location (thread_id), which is a different binding than the channel's.
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

import httpx
from websockets.asyncio.client import connect as ws_connect
from websockets.exceptions import InvalidStatus

from .adapter_runtime import ReceiveLoop, error_text, send_request, ws_keepalive
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


class MattermostAdapter:
    platform = "mattermost"
    capabilities = Capabilities(
        threads=True, create_location=True, edit=True, typing=True, buttons=False,
        text_limit=TEXT_LIMITS["mattermost"],
    )

    def __init__(
        self,
        server_url: str,
        token: str,
        *,
        account: str = "default",
        backoff: Callable[[int, float], float] = backoff_delay,
        stall_timeout_s: float = STALL_WATCHDOG_S,
        ping_interval_s: float = 30.0,
    ) -> None:
        self._server = server_url.strip().rstrip("/")
        self._token = token.strip()
        self.account = account
        self.status = AdapterStatus()
        self._emit: Emit | None = None
        self._client: httpx.AsyncClient | None = None
        self._loop = ReceiveLoop(
            "mattermost", self.status, self._connect_once,
            stall_s=stall_timeout_s, delay=lambda n: backoff(n, random.random()),
        )
        self._ping_interval_s = ping_interval_s
        self._user_id = ""
        self._ws: Any = None
        self._seq = 0
        self._known: dict[str, dict[str, Any]] = {}
        self._ws_lock = asyncio.Lock()

    # --- lifecycle ------------------------------------------------------------

    def token_fingerprint(self) -> str:
        return hashlib.sha256(self._token.encode()).hexdigest()

    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                base_url=f"{self._server}/api/v4",
                headers={"Authorization": f"Bearer {self._token}"},
                timeout=httpx.Timeout(20.0, connect=10.0),
            )
        return self._client

    async def start(self, emit: Emit) -> None:
        self._emit = emit
        self._loop.start()

    async def stop(self) -> None:
        await self._loop.stop()
        self._ws = None
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    # --- websocket --------------------------------------------------------------

    def _ws_url(self) -> str:
        if self._server.startswith("https://"):
            base = "wss://" + self._server[len("https://"):]
        elif self._server.startswith("http://"):
            base = "ws://" + self._server[len("http://"):]
        else:
            base = self._server
        return f"{base}/api/v4/websocket"

    async def _connect_once(self) -> None:
        resp = await send_request(self._http(), "GET", "/users/me")
        if resp.status_code != 200:
            raise ConnectionError(error_text(resp))
        me = resp.json()
        self._user_id = str(me.get("id") or "")
        identity = f"@{me.get('username')}" if me.get("username") else ""
        try:
            conn = ws_connect(
                self._ws_url(), max_size=None, ping_interval=None,
                additional_headers={"Authorization": f"Bearer {self._token}"},
            )
            ws = await conn
        except InvalidStatus as exc:
            if exc.response.status_code == 401:
                raise ChannelAuthError("Mattermost rejected the token (websocket 401)") from exc
            raise
        self._ws = ws
        keepalive = asyncio.create_task(ws_keepalive(ws, self._loop.touch, self._ping_interval_s))
        try:
            async for raw in ws:
                self._loop.touch()
                event = json.loads(raw)
                if event.get("event") == "hello":
                    self._loop.mark_ready(identity)
                elif event.get("event") == "posted":
                    await self._on_posted(event.get("data") or {})
        finally:
            self._ws = None
            keepalive.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await keepalive
            await ws.close()

    async def _ws_send(self, ws: Any, payload: dict[str, Any]) -> None:
        """The only websocket writer: every frame goes through one lock."""
        async with self._ws_lock:
            await ws.send(json.dumps(payload))

    async def _on_posted(self, data: dict[str, Any]) -> None:
        try:
            post = json.loads(data.get("post") or "{}")
        except ValueError:
            return
        user_id = str(post.get("user_id") or "")
        # Non-empty type = system message (join/leave/header change...).
        if not user_id or user_id == self._user_id or post.get("type") or self._emit is None:
            return
        if str((post.get("props") or {}).get("from_bot") or "") == "true":
            return
        channel_id = str(post.get("channel_id") or "")
        self._known[channel_id] = {
            "chat_id": channel_id,
            "title": str(data.get("channel_display_name") or data.get("channel_name") or channel_id),
            "kind": str(data.get("channel_type") or ""), "supports_topics": True,
        }
        self.status.last_inbound_at = time.time()
        await self._emit(InboundMessage(
            platform=self.platform, account=self.account,
            chat_id=channel_id, thread_id=str(post.get("root_id") or ""),
            sender_id=user_id, sender_name=str(data.get("sender_name") or user_id).lstrip("@"),
            text=str(post.get("message") or ""), message_id=str(post.get("id") or ""),
            is_direct=data.get("channel_type") == "D", ts=time.time(),
            # A Mattermost reply is a thread reply: its parent is the thread root.
            reply_to_id=str(post.get("root_id") or ""),
            # Files are reported, not fetched: this adapter has no media support yet.
            attachments=[InboundAttachment("file", "", None, "", "") for _ in post.get("file_ids") or []],
        ))

    def known_locations(self) -> list[dict[str, Any]]:
        """Chats seen so far, for the "use existing" picker."""
        return list(self._known.values())

    # --- outbound -------------------------------------------------------------

    async def _write(self, method: str, path: str, body: dict[str, Any]) -> httpx.Response:
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
        ids: list[str] = []
        for chunk in chunk_text(text, self.capabilities.text_limit) or [text or "…"]:
            body = {"channel_id": loc.chat_id, "message": chunk}
            if loc.thread_id:
                body["root_id"] = loc.thread_id
            ids.append(str((await self._write("POST", "/posts", body)).json().get("id") or ""))
        return ids

    async def edit_text(self, loc: Location, message_id: str, text: str) -> None:
        await self._write("PUT", f"/posts/{message_id}/patch", {"message": text[: self.capabilities.text_limit]})

    async def send_typing(self, loc: Location) -> None:
        ws = self._ws
        if ws is None:
            return
        self._seq += 1
        with contextlib.suppress(Exception):
            await self._ws_send(ws, {"action": "user_typing", "seq": self._seq, "data": {
                "channel_id": loc.chat_id, "parent_id": loc.thread_id,
            }})

    async def create_location(self, chat_id: str, title: str) -> Location:
        name = (title or "navide").strip() or "navide"
        resp = await self._write("POST", "/posts", {"channel_id": chat_id, "message": f"🧵 {name}"})
        return Location(self.platform, self.account, chat_id, str(resp.json().get("id") or ""), name)


def create_adapter(config: dict[str, Any], secret: dict[str, Any], *, store: Any = None) -> MattermostAdapter:
    server_url = str(config.get("server_url") or "").strip()
    token = str(secret.get("token") or "").strip()
    if not server_url.startswith(("https://", "http://")):
        raise ValueError("missing server_url (https://...)")
    if not token:
        raise ValueError("missing bot token")
    return MattermostAdapter(server_url, token, account=str(config.get("account") or "default"))

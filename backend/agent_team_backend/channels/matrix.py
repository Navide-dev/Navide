"""Matrix adapter: Client-Server API /sync long-poll for inbound, REST for outbound.

Verified facts (spec.matrix.org/v1.11/client-server-api, read 2026-09-24):
- GET /_matrix/client/v3/sync?since=&timeout=<ms>&filter= -> next_batch,
  rooms.join.{roomId}.timeline.events, rooms.invite, rooms.join.{id}.summary.
  timeout defaults to 0 (returns immediately).
- PUT /rooms/{roomId}/send/{eventType}/{txnId} -> event_id; reusing a txnId returns the
  original response, so a send may be retried safely with the same txnId.
- PUT /rooms/{roomId}/typing/{userId} {typing, timeout ms}; GET /account/whoami -> user_id.
- Errors: M_UNKNOWN_TOKEN (401, optional soft_logout), M_FORBIDDEN (403),
  M_LIMIT_EXCEEDED (429, retry_after_ms deprecated + Retry-After header).
- Threads: content m.relates_to {rel_type "m.thread", event_id <root>, is_falling_back
  true, m.in_reply_to {event_id}}; edits: rel_type "m.replace" + m.new_content,
  fallback body prefixed "* ".
- Direct chats: is_direct on createRoom / m.direct account data; here a joined room
  with exactly two members (summary m.joined_member_count == 2) counts as direct.
Gaps: plain-text bodies only (no org.matrix.custom.html); encrypted rooms (m.room.encrypted)
are not readable without an E2EE stack -> ignored; no buttons in Matrix. Invites are
auto-joined (sender gating still happens in the manager). Not verified against a live server.
"""

from __future__ import annotations

import hashlib
import json
import logging
import random
import secrets
import time
from typing import Any, Callable
from urllib.parse import quote

import httpx

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

SYNC_TIMEOUT_MS = 30000
# Only timeline messages are needed; keep the initial sync small.
SYNC_FILTER = json.dumps({
    "presence": {"types": []},
    "account_data": {"types": []},
    "room": {"timeline": {"types": ["m.room.message"], "limit": 50},
             "state": {"types": []}, "ephemeral": {"types": []}, "account_data": {"types": []}},
})


def _q(value: str) -> str:
    return quote(value, safe="")


def _reply_target(rel: dict[str, Any]) -> str:
    """The event a message replies to. A thread message always carries an
    ``m.in_reply_to`` fallback (``is_falling_back``) that is not a real reply."""
    if rel.get("is_falling_back"):
        return ""
    return str((rel.get("m.in_reply_to") or {}).get("event_id") or "")


class MatrixAdapter:
    platform = "matrix"
    capabilities = Capabilities(
        threads=True, create_location=True, edit=True, typing=True, buttons=False,
        text_limit=TEXT_LIMITS["matrix"],
    )

    def __init__(
        self,
        homeserver: str,
        access_token: str,
        *,
        account: str = "default",
        backoff: Callable[[int, float], float] = backoff_delay,
        stall_timeout_s: float = STALL_WATCHDOG_S,
        sync_timeout_ms: int = SYNC_TIMEOUT_MS,
        auto_join: bool = True,
    ) -> None:
        self._hs = homeserver.strip().rstrip("/")
        self._token = access_token.strip()
        self.account = account
        self.status = AdapterStatus()
        self._emit: Emit | None = None
        self._client: httpx.AsyncClient | None = None
        self._loop = ReceiveLoop(
            "matrix", self.status, self._connect_once,
            stall_s=stall_timeout_s, delay=lambda n: backoff(n, random.random()),
        )
        self._sync_timeout_ms = sync_timeout_ms
        self._auto_join = auto_join
        self._user_id = ""
        self._since = ""
        self._member_counts: dict[str, int] = {}
        self._names: dict[str, str] = {}
        self._known: dict[str, dict[str, Any]] = {}
        self._txn_prefix = secrets.token_hex(4)
        self._txn = 0

    # --- lifecycle ------------------------------------------------------------

    def token_fingerprint(self) -> str:
        return hashlib.sha256(self._token.encode()).hexdigest()

    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                base_url=f"{self._hs}/_matrix/client/v3",
                headers={"Authorization": f"Bearer {self._token}"},
                # The long-poll holds the connection for sync_timeout; read must outlast it.
                timeout=httpx.Timeout(self._sync_timeout_ms / 1000.0 + 30.0, connect=10.0),
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

    # --- sync loop --------------------------------------------------------------

    async def _get(self, path: str, **params: Any) -> dict[str, Any]:
        resp = await send_request(self._http(), "GET", path, params=params, idempotent=True)
        body = resp.json() if resp.content else {}
        if resp.status_code != 200:
            if body.get("errcode") == "M_UNKNOWN_TOKEN":
                raise ChannelAuthError(f"Matrix rejected the access token ({body.get('error', '')})")
            raise ConnectionError(error_text(resp))
        return body

    async def _connect_once(self) -> None:
        if not self._user_id:
            me = await self._get("/account/whoami")
            self._user_id = str(me.get("user_id") or "")
        if not self._since:
            # Initial sync: take the position only; history is not replayed into panes.
            first = await self._get("/sync", timeout=0, filter=SYNC_FILTER)
            self._since = str(first.get("next_batch") or "")
            await self._absorb(first, emit=False)
        self._loop.mark_ready(self._user_id)
        while True:
            batch = await self._get("/sync", since=self._since, timeout=self._sync_timeout_ms, filter=SYNC_FILTER)
            self._loop.touch()
            await self._absorb(batch, emit=True)
            self._since = str(batch.get("next_batch") or self._since)

    async def _absorb(self, batch: dict[str, Any], *, emit: bool) -> None:
        rooms = batch.get("rooms") or {}
        if self._auto_join:
            for room_id in (rooms.get("invite") or {}):
                try:
                    await send_request(self._http(), "POST", f"/rooms/{_q(room_id)}/join", json={})
                except Exception as exc:  # noqa: BLE001 - a failed join must not kill the sync loop
                    log.info("matrix join %s failed: %s", room_id, exc)
        for room_id, room in (rooms.get("join") or {}).items():
            count = (room.get("summary") or {}).get("m.joined_member_count")
            if isinstance(count, int):
                self._member_counts[room_id] = count
            self._known[room_id] = {
                "chat_id": room_id, "title": room_id,
                "kind": "direct" if self._member_counts.get(room_id) == 2 else "room",
                "supports_topics": True,
            }
            if not emit:
                continue
            for event in (room.get("timeline") or {}).get("events") or []:
                await self._on_event(room_id, event)

    async def _display_name(self, user_id: str) -> str:
        if user_id in self._names:
            return self._names[user_id]
        name = user_id.split(":", 1)[0].lstrip("@")
        try:
            resp = await self._http().get(f"/profile/{_q(user_id)}/displayname")
            if resp.status_code == 200:
                name = str(resp.json().get("displayname") or name)
        except httpx.HTTPError:
            pass
        self._names[user_id] = name
        return name

    async def _on_event(self, room_id: str, event: dict[str, Any]) -> None:
        if event.get("type") != "m.room.message" or self._emit is None:
            return
        sender = str(event.get("sender") or "")
        content = event.get("content") or {}
        msgtype = content.get("msgtype")
        # A file is reported, not fetched: this adapter has no media support yet.
        files = [_media_placeholder(content)] if msgtype in MEDIA_MSGTYPES else []
        if not sender or sender == self._user_id or (msgtype != "m.text" and not files):
            return
        rel = content.get("m.relates_to") or {}
        if rel.get("rel_type") == "m.replace":
            return  # edits of earlier messages are not new input
        thread_id = str(rel.get("event_id") or "") if rel.get("rel_type") == "m.thread" else ""
        self.status.last_inbound_at = time.time()
        await self._emit(InboundMessage(
            platform=self.platform, account=self.account, chat_id=room_id, thread_id=thread_id,
            sender_id=sender, sender_name=await self._display_name(sender),
            # A media event's body is its file name, not something the sender wrote.
            text="" if files else str(content.get("body") or ""), message_id=str(event.get("event_id") or ""),
            is_direct=self._member_counts.get(room_id) == 2, ts=time.time(),
            reply_to_id=_reply_target(rel), attachments=files,
        ))

    def known_locations(self) -> list[dict[str, Any]]:
        """Chats seen so far, for the "use existing" picker."""
        return list(self._known.values())

    # --- outbound -------------------------------------------------------------

    def _next_txn(self) -> str:
        self._txn += 1
        return f"navide-{self._txn_prefix}-{int(time.time() * 1000)}-{self._txn}"

    async def _send_event(self, room_id: str, content: dict[str, Any]) -> str:
        path = f"/rooms/{_q(room_id)}/send/m.room.message/{_q(self._next_txn())}"
        try:
            # Same txnId on every retry -> the homeserver deduplicates, so ambiguous
            # transport failures are safe to retry here.
            resp = await send_request(self._http(), "PUT", path, json=content, idempotent=True)
        except ChannelAuthError as exc:
            raise ChannelSendError(str(exc)) from exc
        if resp.status_code != 200:
            raise ChannelSendError(error_text(resp))
        return str(resp.json().get("event_id") or "")

    async def send_text(
        self, loc: Location, text: str, *, buttons: list[tuple[str, str]] | None = None
    ) -> list[str]:
        ids: list[str] = []
        for chunk in chunk_text(text, self.capabilities.text_limit) or [text or "…"]:
            content: dict[str, Any] = {"msgtype": "m.text", "body": chunk}
            if loc.thread_id:
                content["m.relates_to"] = {
                    "rel_type": "m.thread", "event_id": loc.thread_id,
                    "is_falling_back": True, "m.in_reply_to": {"event_id": loc.thread_id},
                }
            ids.append(await self._send_event(loc.chat_id, content))
        return ids

    async def edit_text(self, loc: Location, message_id: str, text: str) -> None:
        body = text[: self.capabilities.text_limit]
        await self._send_event(loc.chat_id, {
            "msgtype": "m.text", "body": f"* {body}",
            "m.new_content": {"msgtype": "m.text", "body": body},
            "m.relates_to": {"rel_type": "m.replace", "event_id": message_id},
        })

    async def send_typing(self, loc: Location) -> None:
        if not self._user_id:
            return
        try:
            await send_request(
                self._http(), "PUT", f"/rooms/{_q(loc.chat_id)}/typing/{_q(self._user_id)}",
                json={"typing": True, "timeout": 10000},
            )
        except ChannelAuthError as exc:
            raise ChannelSendError(str(exc)) from exc

    async def create_location(self, chat_id: str, title: str) -> Location:
        """A pane becomes a thread in room ``chat_id``, rooted at a title message."""
        name = (title or "navide").strip() or "navide"
        root = await self._send_event(chat_id, {"msgtype": "m.text", "body": f"🧵 {name}"})
        return Location(self.platform, self.account, chat_id, root, name)


def create_adapter(config: dict[str, Any], secret: dict[str, Any], *, store: Any = None) -> MatrixAdapter:
    homeserver = str(config.get("homeserver") or "").strip()
    token = str(secret.get("access_token") or secret.get("token") or "").strip()
    if not homeserver.startswith(("https://", "http://")):
        raise ValueError("missing homeserver (https://...)")
    if not token:
        raise ValueError("missing access token")
    return MatrixAdapter(homeserver, token, account=str(config.get("account") or "default"),
                         auto_join=bool(config.get("auto_join", True)))


MEDIA_MSGTYPES = {"m.image": "photo", "m.file": "document", "m.video": "video", "m.audio": "audio"}


def _media_placeholder(content: dict[str, Any]) -> InboundAttachment:
    info = content.get("info") or {}
    return InboundAttachment(MEDIA_MSGTYPES[str(content.get("msgtype"))], str(content.get("body") or ""),
                             info.get("size"), str(info.get("mimetype") or ""), "")

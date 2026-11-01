"""The loopback listener behind webhook triggers.

Apart from the backend's own server on purpose. That port carries /ws, /fs and
the hooks and must never sit behind a tunnel, and a flood here must not reach
the event loop the PTYs run on. So this is a second uvicorn server, on its own
port, in its own thread with its own loop, and it exists only while webhooks
are on: stopping it ends the thread and closes the socket. uvicorn leaves
signal handling alone outside the main thread, so the backend's shutdown is
unaffected.

The address is a constant. Reaching this from outside is a tunnel the user runs
themselves, and then every client is 127.0.0.1, so nothing here trusts the
source address or an ``X-Forwarded-*`` header: limits are per trigger and
global, never per client.

Everything before ``accept`` runs here, on this thread, from an in-memory
snapshot; the database and the window stay on the main loop.
"""

from __future__ import annotations

import asyncio
import collections
import hashlib
import logging
import os
import re
import secrets
import socket
import threading
import time
from collections.abc import Awaitable, Callable
from typing import Any
from urllib.parse import urlparse

import uvicorn
from uvicorn.protocols.http.h11_impl import H11Protocol

from . import webhook_form, webhook_github, webhook_payload, webhook_triggers

log = logging.getLogger(__name__)

LOOPBACK = "127.0.0.1"
THREAD_NAME = "webhook-listener"

MAX_BODY = 64 * 1024
#: GitHub's own events run larger, and only its deliveries get this far unsigned.
MAX_GITHUB_BODY = 1024 * 1024
MAX_HEADERS = 16 * 1024
MAX_CONNECTIONS = 32
HEADER_TIMEOUT_S = 10.0
BODY_TIMEOUT_S = 10.0
ACCEPT_TIMEOUT_S = 20.0
START_TIMEOUT_S = 10.0
STOP_TIMEOUT_S = 5.0
GLOBAL_PER_MINUTE = 120
FAILED_PER_MINUTE = 60
AUDIT_FLUSH_S = 60.0

_LOCAL_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})
_WEBHOOK_PATH = re.compile(r"^/webhook/([0-9a-f]{32})$")
_FORM_PATH = re.compile(r"^/form/([A-Za-z0-9_-]{20,80})$")
_PAGE_HEADERS = [
    (b"content-type", b"text/html; charset=utf-8"),
    (b"content-security-policy", webhook_form.CONTENT_SECURITY_POLICY.encode()),
    # Not no-referrer: a browser then sends Origin: null with the page's own POST.
    # The page links to nothing and loads nothing, so the token still stays here.
    (b"referrer-policy", b"same-origin"),
    (b"x-frame-options", b"DENY"),
]
_SECURITY_HEADERS = [
    (b"cache-control", b"no-store"),
    (b"x-content-type-options", b"nosniff"),
    (b"connection", b"close"),
]

Accept = Callable[[dict[str, Any], str, str], Awaitable[tuple[int, int, str]]]


class ListenerError(RuntimeError):
    """The listener could not start, such as a port already in use."""


class RateLimiter:
    """At most `limit` events per `window` seconds. allow() answers 0, or how
    many seconds until the next event would fit."""

    def __init__(self, limit: int, window: float, clock: Callable[[], float] = time.monotonic) -> None:
        self.limit, self.window, self.clock = limit, window, clock
        self.times: collections.deque[float] = collections.deque()

    def allow(self) -> int:
        now = self.clock()
        while self.times and now - self.times[0] >= self.window:
            self.times.popleft()
        if len(self.times) >= self.limit:
            return max(1, int(self.times[0] + self.window - now + 0.999))
        self.times.append(now)
        return 0


class _Protocol(H11Protocol):
    """h11, with what uvicorn leaves out: no limit on open connections and no
    deadline for finishing the request head."""

    def connection_made(self, transport: asyncio.Transport) -> None:  # type: ignore[override]
        super().connection_made(transport)
        if len(self.connections) > MAX_CONNECTIONS:
            transport.abort()
            return
        self._head_timer = self.loop.call_later(HEADER_TIMEOUT_S, self._head_expired)

    def _head_expired(self) -> None:
        if self.cycle is None and self.transport is not None:
            self.transport.close()

    def connection_lost(self, exc: Exception | None) -> None:
        timer = getattr(self, "_head_timer", None)
        if timer is not None:
            timer.cancel()
        super().connection_lost(exc)


class _Audit:
    """Audit rows on their way to the main loop. An outcome a flood can repeat
    becomes one row with a count, flushed once a minute."""

    #: Outcomes that are folded, because anyone can produce them at will.
    FOLDED = frozenset({"rate-limited", "bad-key", "bad-signature", "bad-csrf", "cross-site", "unknown", "foreign-host", "web-origin", "headers-too-large"})

    def __init__(self, emit: Callable[[list[dict[str, Any]]], None]) -> None:
        self.emit = emit
        self.folded: dict[tuple[str, str, int], int] = {}
        self.flushed_at = time.monotonic()

    def add(self, trigger_id: str, outcome: str, status: int, **fields: Any) -> None:
        if outcome in self.FOLDED:
            key = (trigger_id, outcome, status)
            self.folded[key] = self.folded.get(key, 0) + 1
            if time.monotonic() - self.flushed_at >= AUDIT_FLUSH_S:
                self.flush()
            return
        self.emit([{"trigger_id": trigger_id, "ts": int(time.time()), "outcome": outcome, "status": status, **fields}])

    def flush(self) -> None:
        self.flushed_at = time.monotonic()
        rows = [
            {"trigger_id": trigger_id, "ts": int(time.time()), "outcome": outcome, "status": status, "count": count}
            for (trigger_id, outcome, status), count in self.folded.items()
        ]
        self.folded.clear()
        if rows:
            self.emit(rows)


class _Page(bytes):
    """An answer a browser reads. Everything else stays application/json."""


class _Refused(Exception):
    def __init__(self, status: int, outcome: str, retry_after: int = 0, trigger_id: str = "") -> None:
        super().__init__(outcome)
        self.status, self.outcome, self.retry_after, self.trigger_id = status, outcome, retry_after, trigger_id


class WebhookListener:
    """start() and stop() come from the main loop's side; update() may be
    called at any time and replaces the trigger snapshot in one assignment."""

    def __init__(
        self,
        *,
        port: int,
        public_host: str,
        accept: Accept,
        on_audit: Callable[[list[dict[str, Any]]], None],
        loop: asyncio.AbstractEventLoop,
        guard_enabled: Callable[[], bool],
    ) -> None:
        self._wanted_port = port
        self.port = 0
        self.address: tuple[str, int] = (LOOPBACK, 0)
        self._public_host = public_host.lower()
        self._accept = accept
        self._main_loop = loop
        self._guard_enabled = guard_enabled
        self._triggers: dict[str, dict[str, Any]] = {}
        self._forms: dict[str, dict[str, Any]] = {}
        self._form_secret = secrets.token_bytes(32)
        self._audit = _Audit(on_audit)
        self._global = RateLimiter(GLOBAL_PER_MINUTE, 60.0)
        self._failed = RateLimiter(FAILED_PER_MINUTE, 60.0)
        self._per_trigger: dict[str, RateLimiter] = {}
        self._server: uvicorn.Server | None = None
        self._thread: threading.Thread | None = None

    def update(self, triggers: dict[str, dict[str, Any]]) -> None:
        self._triggers = dict(triggers)
        self._forms = {t["token_hash"]: t for t in triggers.values() if t["kind"] == "form" and t["token_hash"]}

    def _bind(self) -> socket.socket:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            # On POSIX this only skips TIME_WAIT after a restart. On Windows it
            # would let another process take the port over.
            if os.name != "nt":
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind((LOOPBACK, self._wanted_port))
            sock.listen(MAX_CONNECTIONS)
        except OSError as err:
            sock.close()
            raise ListenerError(f"cannot listen on {LOOPBACK}:{self._wanted_port}: {err.strerror}") from err
        sock.setblocking(False)
        return sock

    def start(self) -> None:
        # Bound here rather than by uvicorn, which ends the process on a failed
        # bind; a taken port has to reach the user as an error.
        sock = self._bind()
        self.address = sock.getsockname()[:2]
        self.port = self.address[1]
        config = uvicorn.Config(
            self,
            http=_Protocol,
            loop="asyncio",
            lifespan="off",
            ws="none",
            # None keeps uvicorn from replacing the logging setup, redaction included.
            log_config=None,
            access_log=False,
            server_header=False,
            date_header=False,
            h11_max_incomplete_event_size=MAX_HEADERS,
            timeout_keep_alive=1,
            timeout_graceful_shutdown=int(STOP_TIMEOUT_S),
        )
        server = uvicorn.Server(config)
        thread = threading.Thread(target=server.run, kwargs={"sockets": [sock]}, name=THREAD_NAME, daemon=True)
        self._server, self._thread = server, thread
        thread.start()
        deadline = time.monotonic() + START_TIMEOUT_S
        while not server.started:
            if not thread.is_alive() or time.monotonic() > deadline:
                self.stop()
                raise ListenerError("the webhook listener did not start")
            time.sleep(0.01)

    def stop(self) -> None:
        server, thread = self._server, self._thread
        if server is not None and thread is not None:
            server.should_exit = True
            thread.join(STOP_TIMEOUT_S + 2)
        self._server = self._thread = None
        self._audit.flush()

    # ── ASGI ─────────────────────────────────────────────────────────────

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            return
        try:
            status, retry_after, body = await self._handle(scope, receive)
        except _Refused as refused:
            self._audit.add(refused.trigger_id, refused.outcome, refused.status)
            status, retry_after, body = refused.status, refused.retry_after, b""
        except Exception:  # noqa: BLE001 - the answer stays empty whatever went wrong
            log.exception("webhook: request failed")
            status, retry_after, body = 500, 0, b""
        headers = [*_SECURITY_HEADERS, (b"content-length", str(len(body)).encode())]
        if retry_after:
            headers.append((b"retry-after", str(retry_after).encode()))
        if isinstance(body, _Page):
            headers.extend(_PAGE_HEADERS)
        elif body:
            headers.append((b"content-type", b"application/json"))
        await send({"type": "http.response.start", "status": status, "headers": headers})
        await send({"type": "http.response.body", "body": body})

    def _host_allowed(self, host_header: str) -> bool:
        hostname = urlparse(f"//{host_header}").hostname
        return hostname in _LOCAL_HOSTS or (bool(self._public_host) and hostname == self._public_host)

    def _limit(self, limiter: RateLimiter, trigger_id: str = "") -> None:
        retry_after = limiter.allow()
        if retry_after:
            raise _Refused(429, "rate-limited", retry_after, trigger_id)

    def _trigger_limiter(self, trigger: dict[str, Any]) -> RateLimiter:
        limiter = self._per_trigger.get(trigger["id"])
        if limiter is None or limiter.limit != trigger["per_minute"]:
            limiter = self._per_trigger[trigger["id"]] = RateLimiter(trigger["per_minute"], 60.0)
        return limiter

    @staticmethod
    def _bearer(value: str) -> str:
        scheme, _, token = value.partition(" ")
        return token.strip() if scheme.lower() == "bearer" else ""

    async def _handle(self, scope: dict[str, Any], receive: Any) -> tuple[int, int, bytes]:
        self._limit(self._global)
        # h11's own limit only covers a head still incomplete after a read.
        if sum(len(k) + len(v) for k, v in scope["headers"]) > MAX_HEADERS:
            raise _Refused(431, "headers-too-large")
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope["headers"]}
        if not self._host_allowed(headers.get("host", "")):
            raise _Refused(404, "foreign-host")
        form = _FORM_PATH.match(scope["path"])
        if form is not None:
            return await self._handle_form(form.group(1), scope, headers, receive)
        if "origin" in headers:
            raise _Refused(404, "web-origin")
        match = _WEBHOOK_PATH.match(scope["path"])
        trigger = self._triggers.get(match.group(1)) if match and scope["method"] == "POST" else None
        if trigger is None or trigger["kind"] == "form":
            raise _Refused(404, "unknown")
        trigger_id = trigger["id"]
        if trigger["kind"] == "github":
            return await self._handle_github(trigger, headers, receive)
        # Before the body: a request without the key costs no memory.
        if not webhook_triggers.key_matches(trigger, self._bearer(headers.get("authorization", ""))):
            self._limit(self._failed, trigger_id)
            raise _Refused(404, "bad-key", trigger_id=trigger_id)
        if not self._guard_enabled():
            raise _Refused(503, "guard-off", trigger_id=trigger_id)
        self._limit(self._trigger_limiter(trigger), trigger_id)
        length = headers.get("content-length", "")
        if length.isdigit() and int(length) > MAX_BODY:
            raise _Refused(413, "too-large", trigger_id=trigger_id)
        raw = await self._read_body(receive, trigger_id, MAX_BODY)
        try:
            text = webhook_payload.read_body(raw, headers.get("content-type", ""))
        except webhook_payload.PayloadError as err:
            raise _Refused(err.status, err.reason, trigger_id=trigger_id) from None
        return await self._run(trigger, text, raw)

    async def _run(self, trigger: dict[str, Any], text: str, raw: bytes) -> tuple[int, int, bytes]:
        body_sha256 = hashlib.sha256(raw).hexdigest()
        status, retry_after, outcome = await self._hand_over(trigger, text, body_sha256)
        self._audit.add(trigger["id"], outcome, status, size=len(raw), body_sha256=body_sha256)
        return status, retry_after, b'{"ok":true}' if status == 202 else b""

    def _is_local(self, headers: dict[str, str]) -> bool:
        return urlparse(f"//{headers.get('host', '')}").hostname in _LOCAL_HOSTS

    async def _handle_form(
        self, token: str, scope: dict[str, Any], headers: dict[str, str], receive: Any,
    ) -> tuple[int, int, bytes]:
        """The URL's token is the permission, so an unknown one looks like no
        page at all. A form that is not public answers on loopback only."""
        trigger = self._forms.get(webhook_triggers.hash_token(token))
        if trigger is None or (not trigger["form_public"] and not self._is_local(headers)):
            raise _Refused(404, "unknown")
        trigger_id, name, fields = trigger["id"], trigger["name"], trigger["form_fields"]
        now = int(time.time())
        if scope["method"] == "GET":
            csrf = webhook_form.mint_csrf(self._form_secret, trigger_id, now)
            return 200, 0, _Page(webhook_form.render_page(name, fields, csrf))
        if scope["method"] != "POST":
            raise _Refused(404, "unknown")
        origin = urlparse(headers.get("origin", ""))
        if origin.netloc.lower() != headers.get("host", "").lower():
            raise _Refused(403, "cross-site", trigger_id=trigger_id)
        if not self._guard_enabled():
            raise _Refused(503, "guard-off", trigger_id=trigger_id)
        self._limit(self._trigger_limiter(trigger), trigger_id)
        length = headers.get("content-length", "")
        if length.isdigit() and int(length) > MAX_BODY:
            raise _Refused(413, "too-large", trigger_id=trigger_id)
        raw = await self._read_body(receive, trigger_id, MAX_BODY)
        if headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/x-www-form-urlencoded":
            raise _Refused(415, "unsupported-type", trigger_id=trigger_id)
        try:
            values = webhook_form.parse_body(webhook_payload.read_body(raw, "application/x-www-form-urlencoded"))
            if not webhook_form.csrf_valid(self._form_secret, trigger_id, values.get("_csrf", ""), now):
                raise _Refused(403, "bad-csrf", trigger_id=trigger_id)
            text = webhook_form.submission_text(fields, values)
        except webhook_payload.PayloadError as err:
            raise _Refused(err.status, err.reason, trigger_id=trigger_id) from None
        except webhook_form.SubmissionInvalid as err:
            self._audit.add(trigger_id, "form-invalid", 400)
            csrf = webhook_form.mint_csrf(self._form_secret, trigger_id, now)
            return 400, 0, _Page(webhook_form.render_page(name, fields, csrf, error=str(err)))
        status, retry_after, _ = await self._run(trigger, text, raw)
        if status == 202:
            return 200, 0, _Page(webhook_form.render_message(name, "Thanks. Your response was received."))
        return status, retry_after, _Page(webhook_form.render_message(name, "This form cannot take a response right now."))

    async def _handle_github(
        self, trigger: dict[str, Any], headers: dict[str, str], receive: Any,
    ) -> tuple[int, int, bytes]:
        """The signature covers the body, so the body comes first: size and
        rate, then the signature, and only then is a byte of it parsed."""
        trigger_id = trigger["id"]
        self._limit(self._trigger_limiter(trigger), trigger_id)
        length = headers.get("content-length", "")
        if length.isdigit() and int(length) > MAX_GITHUB_BODY:
            raise _Refused(413, "too-large", trigger_id=trigger_id)
        raw = await self._read_body(receive, trigger_id, MAX_GITHUB_BODY)
        secret = trigger.get("secret")
        if secret is None:
            raise _Refused(503, "key-unavailable", trigger_id=trigger_id)
        if not webhook_github.signature_valid(secret, raw, headers.get(webhook_github.SIGNATURE_HEADER, "")):
            self._limit(self._failed, trigger_id)
            raise _Refused(404, "bad-signature", trigger_id=trigger_id)
        if not self._guard_enabled():
            raise _Refused(503, "guard-off", trigger_id=trigger_id)
        if headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
            raise _Refused(415, "unsupported-type", trigger_id=trigger_id)
        try:
            text = webhook_payload.read_body(raw, "application/json")
        except webhook_payload.PayloadError as err:
            raise _Refused(err.status, err.reason, trigger_id=trigger_id) from None
        event = headers.get(webhook_github.EVENT_HEADER, "")
        if event == webhook_github.PING:
            self._audit.add(trigger_id, "ping", 200)
            return 200, 0, b""
        if event not in trigger["github_events"]:
            self._audit.add(trigger_id, "event-ignored", 204, detail=event[:40])
            return 204, 0, b""
        return await self._run(trigger, webhook_github.summary(event, text), raw)

    async def _read_body(self, receive: Any, trigger_id: str, limit: int) -> bytes:
        async def read() -> bytes:
            chunks: list[bytes] = []
            size = 0
            while True:
                message = await receive()
                if message["type"] != "http.request":
                    raise _Refused(400, "disconnected", trigger_id=trigger_id)
                chunk = message.get("body", b"")
                size += len(chunk)
                if size > limit:
                    raise _Refused(413, "too-large", trigger_id=trigger_id)
                chunks.append(chunk)
                if not message.get("more_body"):
                    return b"".join(chunks)

        try:
            return await asyncio.wait_for(read(), BODY_TIMEOUT_S)
        except TimeoutError:
            raise _Refused(408, "body-timeout", trigger_id=trigger_id) from None

    async def _hand_over(self, trigger: dict[str, Any], text: str, body_sha256: str) -> tuple[int, int, str]:
        """Run `accept` on the main loop, where the store and the window live."""
        future = asyncio.run_coroutine_threadsafe(self._accept(trigger, text, body_sha256), self._main_loop)
        try:
            return await asyncio.wait_for(asyncio.wrap_future(future), ACCEPT_TIMEOUT_S)
        except TimeoutError:
            return 503, 0, "accept-timeout"

"""Shared plumbing for the Discord / Slack / Mattermost / Matrix adapters.

``ReceiveLoop`` owns an adapter's receive task: lifecycle transitions, the
reconnect backoff (``base.backoff_delay``), the stall watchdog and the
"blocked" terminal state on credential rejection. ``send_request`` is the
non-idempotent send policy: retry only when the request provably did not go
out (connect failure) or on 429 (honouring the server's retry-after, capped).
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import random
import time
from pathlib import Path
from typing import Any, Awaitable, Callable

import httpx

from .base import (
    RETRY_AFTER_CAP_S,
    STALL_WATCHDOG_S,
    AdapterStatus,
    ChannelAuthError,
    ChannelSendError,
    MediaTooLarge,
    backoff_delay,
)

log = logging.getLogger(__name__)

# Seconds between keepalive pings on websocket transports that have no
# application-level heartbeat, and how long a pong may take.
WS_PING_INTERVAL_S = 30.0
WS_PING_TIMEOUT_S = 20.0

# Max number of 429 / connect-failure retries for one request.
SEND_MAX_RETRIES = 3

# How long a connection must stay ready before its drop restarts the backoff
# series. Shorter-lived sessions (connect, then dropped at once) keep backing
# off, or a server that accepts and closes would be retried at the first step
# forever.
READY_STABLE_S = 60.0

# How long a reconnect the server asked for waits when the previous one also
# ended in such a request without a stable session in between.
RECONNECT_NOW_MIN_S = 1.0

# How long a stop waits for a cancelled receive task before cancelling it again.
CANCEL_RETRY_S = 0.5


async def cancel_and_wait(task: asyncio.Task[Any]) -> None:
    """Cancel ``task`` and wait until it has ended, cancelling again while it runs on.

    A single cancel can be lost: anyio's connect_tcp (under httpx) uncancels its
    host task when the cancel lands while its own happy-eyeballs task group is
    winding down, and a poll loop then carries on as if never asked to stop.
    """
    while not task.done():
        task.cancel()
        await asyncio.wait({task}, timeout=CANCEL_RETRY_S)
    if not task.cancelled():
        task.exception()  # retrieved: an error on the way out is not worth a warning


class StallError(Exception):
    """No activity for longer than the stall watchdog allows."""


class ReconnectNow(Exception):
    """The server asked for a fresh connection; reconnect without backoff."""


class ReceiveLoop:
    """Run ``connect_once`` forever with backoff until stopped or blocked.

    ``connect_once`` connects, calls ``mark_ready()`` once the platform
    confirmed the session, calls ``touch()`` on every sign of life, and
    returns or raises when the connection ends. ``ChannelAuthError`` ends the
    loop in the ``blocked`` state; ``ReconnectNow`` reconnects immediately;
    anything else reconnects after ``backoff_delay``.
    """

    def __init__(
        self,
        name: str,
        status: AdapterStatus,
        connect_once: Callable[[], Awaitable[None]],
        *,
        stall_s: float = STALL_WATCHDOG_S,
        delay: Callable[[int], float] | None = None,
        stable_s: float = READY_STABLE_S,
    ) -> None:
        self.name = name
        self.status = status
        self._connect_once = connect_once
        self.stall_s = stall_s
        self._delay = delay or (lambda attempt: backoff_delay(attempt, random.random()))
        self._task: asyncio.Task[None] | None = None
        self._stopping = False
        self.stable_s = stable_s
        self._ready_at: float | None = None
        self._last_activity = time.monotonic()

    def touch(self) -> None:
        self._last_activity = time.monotonic()

    def mark_ready(self, identity: str = "") -> None:
        if self._ready_at is None:
            self._ready_at = time.monotonic()
        self.status.lifecycle = "ready"
        self.status.connected = True
        self.status.reconnect_attempts = 0
        self.status.last_error = ""
        self.status.last_connected_at = time.time()
        if identity:
            self.status.identity = identity
        self.touch()

    def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._stopping = False
        self.status.lifecycle = "starting"
        self.status.connected = False
        self._task = asyncio.get_running_loop().create_task(self._run(), name=f"channel-{self.name}")

    async def stop(self) -> None:
        self._stopping = True
        task, self._task = self._task, None
        if task and not task.done():
            await cancel_and_wait(task)
        self.status.lifecycle = "stopped"
        self.status.connected = False

    async def _run_watched(self) -> None:
        self.touch()
        inner = asyncio.ensure_future(self._connect_once())
        try:
            while True:
                idle = time.monotonic() - self._last_activity
                remaining = self.stall_s - idle
                if remaining <= 0:
                    raise StallError(f"no activity for {int(self.stall_s)}s")
                done, _ = await asyncio.wait({inner}, timeout=remaining)
                if done:
                    inner.result()
                    return
        finally:
            if not inner.done():
                inner.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await inner

    def _was_stable(self) -> bool:
        return self._ready_at is not None and time.monotonic() - self._ready_at >= self.stable_s

    async def _run(self) -> None:
        attempt = 0
        reconnects_in_row = 0
        while not self._stopping:
            self._ready_at = None
            try:
                await self._run_watched()
                if self._stopping:
                    break
                raise ConnectionError("connection closed")
            except asyncio.CancelledError:
                raise
            except ChannelAuthError as exc:
                self.status.lifecycle = "blocked"
                self.status.connected = False
                self.status.last_error = str(exc) or "credential rejected"
                log.warning("channel %s blocked: %s", self.name, self.status.last_error)
                return
            except ReconnectNow as exc:
                # A stable session ends any backoff series, as a drop after one would.
                if self._was_stable():
                    attempt = 0
                    reconnects_in_row = 0
                reconnects_in_row += 1
                self.status.connected = False
                self.status.lifecycle = "recovering"
                log.info("channel %s reconnecting: %s", self.name, exc)
                if reconnects_in_row > 1:
                    await asyncio.sleep(RECONNECT_NOW_MIN_S)
                continue
            except Exception as exc:  # noqa: BLE001 - every drop reconnects
                if self._stopping:
                    break
                reconnects_in_row = 0
                # Only a connection that stayed ready starts a fresh backoff series.
                attempt = 1 if self._was_stable() else attempt + 1
                self.status.connected = False
                self.status.lifecycle = "recovering"
                self.status.reconnect_attempts = attempt
                self.status.last_error = f"{type(exc).__name__}: {exc}"[:500]
                wait = self._delay(attempt)
                log.info("channel %s dropped (%s); retry in %.1fs", self.name, self.status.last_error, wait)
                await asyncio.sleep(wait)


async def ws_keepalive(ws: Any, touch: Callable[[], None], interval: float = WS_PING_INTERVAL_S) -> None:
    """Ping ``ws`` every ``interval`` seconds; every pong counts as activity.

    A missing pong raises, which ends the connection and lets the receive
    loop reconnect (the stall watchdog is the backstop).
    """
    while True:
        await asyncio.sleep(interval)
        pong = await ws.ping()
        await asyncio.wait_for(pong, WS_PING_TIMEOUT_S)
        touch()


def parse_retry_after(resp: httpx.Response, body: Any = None) -> float:
    """Seconds to wait from a 429 response (body fields first, then headers)."""
    candidates: list[Any] = []
    if isinstance(body, dict):
        candidates.append(body.get("retry_after"))  # Discord (seconds, float)
        if body.get("retry_after_ms") is not None:  # Matrix (ms, deprecated)
            with contextlib.suppress(TypeError, ValueError):
                candidates.append(float(body["retry_after_ms"]) / 1000.0)
    candidates.append(resp.headers.get("retry-after"))
    candidates.append(resp.headers.get("x-ratelimit-reset-after"))
    # Mattermost: seconds until the window resets (Discord's same-named header is an
    # epoch timestamp, but Discord always sends retry_after in the body first).
    candidates.append(resp.headers.get("x-ratelimit-reset"))
    for value in candidates:
        if value is None:
            continue
        with contextlib.suppress(TypeError, ValueError):
            return max(0.0, min(float(value), RETRY_AFTER_CAP_S))
    return 1.0


def _json_or_none(resp: httpx.Response) -> Any:
    try:
        return resp.json()
    except ValueError:
        return None


async def send_request(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    *,
    idempotent: bool = False,
    auth_statuses: tuple[int, ...] = (401,),
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    **kwargs: Any,
) -> httpx.Response:
    """Perform one platform write with the shared retry policy.

    Retries on 429 (retry-after capped at ``RETRY_AFTER_CAP_S``) and on
    connect failures (the request never left). Any other transport error is
    ambiguous and raises ``ChannelSendError(retryable=False)`` unless the
    call is ``idempotent`` (e.g. Matrix txnId), which may retry it too.
    Statuses in ``auth_statuses`` raise ``ChannelAuthError``. Other non-2xx
    responses are returned for the caller to interpret.
    """
    attempt = 0
    while True:
        try:
            resp = await client.request(method, url, **kwargs)
        except (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout) as exc:
            if attempt >= SEND_MAX_RETRIES:
                raise ChannelSendError(f"connect failed: {exc}", retryable=True) from exc
            attempt += 1
            await sleep(min(2.0 * attempt, RETRY_AFTER_CAP_S))
            continue
        except httpx.TransportError as exc:
            if idempotent and attempt < SEND_MAX_RETRIES:
                attempt += 1
                await sleep(min(2.0 * attempt, RETRY_AFTER_CAP_S))
                continue
            raise ChannelSendError(f"request may have gone out: {exc}", retryable=False) from exc
        if resp.status_code == 429:
            if attempt >= SEND_MAX_RETRIES:
                raise ChannelSendError("rate limited", retryable=True)
            attempt += 1
            await sleep(parse_retry_after(resp, _json_or_none(resp)))
            continue
        if resp.status_code in auth_statuses:
            body = _json_or_none(resp)
            detail = ""
            if isinstance(body, dict):
                detail = str(body.get("message") or body.get("error") or body.get("errcode") or "")
            raise ChannelAuthError(f"HTTP {resp.status_code} {detail}".strip())
        return resp


def error_text(resp: httpx.Response) -> str:
    body = _json_or_none(resp)
    if isinstance(body, dict):
        for key in ("message", "error", "errcode"):
            if body.get(key):
                return f"HTTP {resp.status_code}: {body[key]}"
    return f"HTTP {resp.status_code}: {resp.text[:200]}"


# A whole download, not one read: a server dripping bytes under the read timeout would
# otherwise hold the chat's worker for as long as it likes.
DOWNLOAD_TOTAL_S = 300.0
# How much of a failed download's error body is read to explain it.
ERROR_BODY_MAX_BYTES = 4096


async def download_to(
    client: httpx.AsyncClient, url: str, dest: Path, max_bytes: int, *,
    headers: dict[str, str] | None = None,
) -> int:
    """Stream ``url`` into ``dest`` and return its size. Past ``max_bytes`` (declared or
    counted) raise ``MediaTooLarge``; any status but 200, or the whole transfer taking
    past ``DOWNLOAD_TOTAL_S``, raises ``ChannelSendError``. A redirect is not followed (it
    could carry a credential header to another host). ``dest`` is removed whenever no
    complete file was written."""
    try:
        return await asyncio.wait_for(_download(client, url, dest, max_bytes, headers),
                                      DOWNLOAD_TOTAL_S)
    except TimeoutError as exc:
        dest.unlink(missing_ok=True)
        raise ChannelSendError(f"download timed out after {DOWNLOAD_TOTAL_S:g}s") from exc


async def _error_head(resp: httpx.Response) -> httpx.Response:
    """``resp`` with only the first ``ERROR_BODY_MAX_BYTES`` of its body, for error_text."""
    head = b""
    async for chunk in resp.aiter_bytes():
        head += chunk
        if len(head) >= ERROR_BODY_MAX_BYTES:
            break
    return httpx.Response(resp.status_code, headers=resp.headers, content=head[:ERROR_BODY_MAX_BYTES])


async def _download(
    client: httpx.AsyncClient, url: str, dest: Path, max_bytes: int, headers: dict[str, str] | None,
) -> int:
    try:
        async with client.stream("GET", url, headers=headers, follow_redirects=False) as resp:
            if resp.status_code != 200:
                raise ChannelSendError(error_text(await _error_head(resp)))
            declared = resp.headers.get("content-length", "")
            if declared.isdigit() and int(declared) > max_bytes:
                raise MediaTooLarge(f"{declared} bytes")
            size = 0
            fh = await asyncio.to_thread(open, dest, "wb")
            try:
                async for chunk in resp.aiter_bytes():
                    size += len(chunk)
                    if size > max_bytes:
                        raise MediaTooLarge(f"over {max_bytes} bytes")
                    await asyncio.to_thread(fh.write, chunk)
            finally:
                await asyncio.to_thread(fh.close)
        return size
    except httpx.HTTPError as exc:
        dest.unlink(missing_ok=True)
        raise ChannelSendError(f"download failed: {exc}") from exc
    except BaseException:
        dest.unlink(missing_ok=True)
        raise


def media_client(transport: httpx.AsyncBaseTransport | None = None) -> httpx.AsyncClient:
    """A bare client for file transfers: no platform auth header, long read timeout."""
    return httpx.AsyncClient(transport=transport, timeout=httpx.Timeout(120.0, connect=10.0))

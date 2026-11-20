"""The proxy a chat channel's connection takes when the system proxy is a PAC file.

httpx and websockets take the proxy from ``urllib.request.getproxies()``, which reads
fixed proxies only: ``HTTP(S)_PROXY``, the macOS Web and Secure Web Proxy (``_scproxy``)
and the Windows manual proxy server (registry). A proxy auto-configuration (PAC) file or
automatic discovery (WPAD) is a JavaScript program Python cannot run, so on a network
that only works through one every channel connected directly and failed as unreachable.

Chromium can run it. When ``getproxies()`` has nothing for a URL (and ``NO_PROXY`` does
not exempt its host), the backend asks the Electron Host on its socket
(``channels.proxy_resolve.request``); main answers with what
``session.resolveProxy(url)`` says (``"PROXY host:port; DIRECT"``), and the first entry
this side can use decides: ``DIRECT`` connects directly, ``PROXY``/``HTTPS`` go through
that proxy. SOCKS entries are skipped (no SOCKS client is bundled). Answers are kept per
scheme, host and port for ``CACHE_TTL_S``, so a network change is picked up within a
minute and a reconnect after it asks again. No Host, no answer in time, or a fixed proxy
already configured: the libraries' own system-proxy handling, exactly as before.

A PAC answer carries no credentials; only scheme, host and port are ever logged.
"""
from __future__ import annotations

import asyncio
import logging
import secrets
import time
import urllib.request
from typing import TYPE_CHECKING, Any
from urllib.parse import urlsplit

import httpx

from ..ipc import make_error, make_event, make_response
from ..pending_registry import TIMEOUT, PendingRegistry

if TYPE_CHECKING:
    from ..app import Session

log = logging.getLogger(__name__)

REQUEST_TYPE = "channels.proxy_resolve.request"
RESULT_TYPE = "channels.proxy_resolve.result"

#: How long one answer is reused for the same scheme, host and port.
CACHE_TTL_S = 60.0
#: How long a request waits for the Host before falling back to the default.
ANSWER_TIMEOUT_S = 3.0


class _Default:
    """Leave the proxy to the library (its own reading of the system settings)."""

    def __repr__(self) -> str:
        return "DEFAULT"


#: The library decides, as before this module existed.
DEFAULT: Any = _Default()

_pending: PendingRegistry[dict[str, Any]] = PendingRegistry()
# (scheme, host, port) -> (expires at, decision): DEFAULT, None (direct) or a proxy URL.
_cache: dict[tuple[str, str, int], tuple[float, Any]] = {}
_inflight: dict[tuple[str, str, int], asyncio.Future[Any]] = {}

_HTTP_SCHEME = {"http": "http", "https": "https", "ws": "http", "wss": "https"}
_DEFAULT_PORT = {"http": 80, "https": 443}


def _key(url: str) -> tuple[str, str, int] | None:
    parts = urlsplit(url)
    scheme = _HTTP_SCHEME.get(parts.scheme.lower())
    host = (parts.hostname or "").lower()
    if scheme is None or not host:
        return None
    try:
        port = parts.port or _DEFAULT_PORT[scheme]
    except ValueError:
        return None
    return scheme, host, port


def fixed_proxy_applies(scheme: str, host: str) -> bool:
    """Whether the libraries already have a say for this URL: a fixed proxy for its
    scheme (or a catch-all), or a ``NO_PROXY``/bypass entry for its host. The PAC path
    then stays out of the way, so ``HTTPS_PROXY`` keeps its priority."""
    proxies = urllib.request.getproxies()
    if proxies.get(scheme) or proxies.get("all"):
        return True
    try:
        return bool(urllib.request.proxy_bypass(host))
    except Exception:  # noqa: BLE001 — an unreadable bypass list is no bypass
        return False


def parse_pac_result(rules: str) -> Any:
    """Chromium's answer to the proxy URL used: ``None`` for a direct connection,
    ``http://host:port`` / ``https://host:port``, or DEFAULT when no entry is usable."""
    for entry in (rules or "").split(";"):
        words = entry.split()
        if not words:
            continue
        kind = words[0].upper()
        if kind == "DIRECT":
            return None
        if kind in ("PROXY", "HTTPS") and len(words) == 2 and "@" not in words[1]:
            return f"{'http' if kind == 'PROXY' else 'https'}://{words[1]}"
        # SOCKS / SOCKS4 / SOCKS5 or anything unknown: try the next entry.
    return DEFAULT


def _describe(decision: Any) -> str:
    if decision is DEFAULT:
        return "system default"
    if decision is None:
        return "direct"
    parts = urlsplit(decision)
    return f"{parts.scheme}://{parts.hostname}:{parts.port}"


async def _unicast_host(event: dict[str, Any]) -> bool:
    from .. import app

    return await app.unicast_host(event)


async def _ask_host(url: str) -> Any:
    request_id = f"proxy:{secrets.token_hex(16)}"
    future = _pending.register(request_id)
    try:
        if not await _unicast_host(make_event(REQUEST_TYPE, {"request_id": request_id, "url": url})):
            return DEFAULT
        answer = await _pending.wait(request_id, future, timeout=ANSWER_TIMEOUT_S)
    finally:
        _pending.discard(request_id)
    if answer is TIMEOUT or not isinstance(answer, dict) or not answer.get("ok"):
        return DEFAULT
    rules = answer.get("rules")
    return parse_pac_result(rules) if isinstance(rules, str) else DEFAULT


async def resolve(url: str) -> Any:
    """The proxy decision for ``url``: DEFAULT, ``None`` (direct) or a proxy URL."""
    key = _key(url)
    if key is None:
        return DEFAULT
    scheme, host, port = key
    if fixed_proxy_applies(scheme, host):
        return DEFAULT
    now = time.monotonic()
    cached = _cache.get(key)
    if cached is not None and cached[0] > now:
        return cached[1]
    running = _inflight.get(key)
    if running is not None:
        return await asyncio.shield(running)
    future: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
    _inflight[key] = future
    try:
        # Asked with the http(s) form: that is what the PAC file is written for.
        decision = await _ask_host(f"{scheme}://{host}:{port}/")
        previous = cached[1] if cached is not None else DEFAULT
        if decision is not DEFAULT and (cached is None or previous != decision):
            log.info("channels: proxy for %s://%s:%d is %s (system PAC)", scheme, host, port, _describe(decision))
        _cache[key] = (time.monotonic() + CACHE_TTL_S, decision)
        future.set_result(decision)
        return decision
    except BaseException:
        # Whoever else waits on this lookup falls back to the default; the
        # failure (a cancellation, mostly) stays with the task that hit it.
        future.set_result(DEFAULT)
        raise
    finally:
        _inflight.pop(key, None)


async def ws_proxy(url: str) -> Any:
    """The ``proxy`` argument for ``websockets``' ``connect``: ``True`` keeps its own
    system-proxy handling, ``None`` connects directly, a URL goes through it."""
    decision = await resolve(url)
    return True if decision is DEFAULT else decision


class PacTransport(httpx.AsyncBaseTransport):
    """Mounted at ``all://`` on a channel's httpx client (``client_options``). A fixed
    proxy is mounted by httpx itself (``trust_env``) and never reaches this; what does is
    sent directly or through the proxy the PAC file picked, one pooled transport per proxy."""

    def __init__(self) -> None:
        self._direct = httpx.AsyncHTTPTransport()
        self._proxied: dict[str, httpx.AsyncHTTPTransport] = {}

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        decision = await resolve(str(request.url))
        if decision is DEFAULT or decision is None:
            return await self._direct.handle_async_request(request)
        transport = self._proxied.get(decision)
        if transport is None:
            transport = self._proxied[decision] = httpx.AsyncHTTPTransport(proxy=decision)
        return await transport.handle_async_request(request)

    async def aclose(self) -> None:
        transports = [self._direct, *self._proxied.values()]
        self._proxied.clear()
        for transport in transports:
            await transport.aclose()


def client_options(transport: httpx.AsyncBaseTransport | None = None) -> dict[str, Any]:
    """Keyword arguments for a channel's ``httpx.AsyncClient``. An explicit transport (a
    test's) is passed as is. Otherwise the PAC transport is mounted at ``all://`` rather
    than passed as ``transport``, which would turn off httpx's own system proxies: its
    ``HTTP(S)_PROXY`` and ``NO_PROXY`` mounts are more specific and still match first.
    ``ALL_PROXY`` is mounted at ``all://`` itself, so then nothing is added."""
    if transport is not None:
        return {"transport": transport}
    if urllib.request.getproxies().get("all"):
        return {}
    return {"mounts": {"all://": PacTransport()}}


def clear_cache() -> None:
    _cache.clear()


async def handle_result(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """``channels.proxy_resolve.result`` from the Host: wake the request waiting on it."""
    if not getattr(session, "host_authenticated", False):
        await session.send_json(make_error(msg_id, msg_type, "UNAUTHORIZED", "Host session is not authenticated"))
        return
    request_id = payload.get("request_id") if isinstance(payload, dict) else None
    response = payload.get("response") if isinstance(payload, dict) else None
    if not isinstance(request_id, str) or not isinstance(response, dict):
        await session.send_json(make_error(msg_id, msg_type, "BAD_REQUEST", f"{msg_type} is malformed"))
        return
    await session.send_json(make_response(msg_id, msg_type, {"delivered": _pending.resolve(request_id, response)}))

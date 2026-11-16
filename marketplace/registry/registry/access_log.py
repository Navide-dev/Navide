"""One access log line per HTTP request: duration and sizes.

Uvicorn's access line carries neither how long a request took nor how
large it was, so a memory or latency peak cannot be tied to a request.
This line records only the method, the matched route template (never the
request path: path parameters can name a member or a token), the status,
the duration and the request's Content-Length and response body size. It
never records the query string, headers, client address or any body.

``AccessLogMiddleware`` is added outermost, so the duration covers every
middleware; ``RouteTemplateMiddleware`` is added innermost, where the
router's scope is visible, and hands the template out through a holder the
outer one put in the scope (middlewares between them may copy the scope).
"""

from __future__ import annotations

import logging
import sys
import time

from starlette.types import ASGIApp, Message, Receive, Scope, Send

_HOLDER = "registry.access"
_logger = logging.getLogger("registry.access")


def access_logger() -> logging.Logger:
    """The access logger, writing to stdout like uvicorn's access log
    (uvicorn configures only its own loggers)."""
    if not _logger.handlers:
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(logging.Formatter("%(name)s %(message)s"))
        _logger.addHandler(handler)
        _logger.setLevel(logging.INFO)
        _logger.propagate = False
    return _logger


class RouteTemplateMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            await self.app(scope, receive, send)
        finally:
            holder = scope.get(_HOLDER)
            route = scope.get("route")
            if holder is not None and isinstance(getattr(route, "path", None), str):
                holder["route"] = route.path


class AccessLogMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app
        self.logger = access_logger()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        holder: dict[str, str] = {}
        scope = {**scope, _HOLDER: holder}
        started = time.perf_counter()
        status = 0
        sent = 0

        async def counting_send(message: Message) -> None:
            nonlocal status, sent
            if message["type"] == "http.response.start":
                status = message["status"]
            elif message["type"] == "http.response.body":
                sent += len(message.get("body", b""))
            await send(message)

        try:
            await self.app(scope, receive, counting_send)
        finally:
            length = dict(scope.get("headers") or []).get(b"content-length", b"-")
            self.logger.info(
                "method=%s route=%s status=%s duration_ms=%.1f request_bytes=%s response_bytes=%d",
                scope["method"],
                holder.get("route", "-"),
                status or "-",
                (time.perf_counter() - started) * 1000,
                length.decode() if length.isdigit() else "-",
                sent,
            )

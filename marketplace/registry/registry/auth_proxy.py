"""navide-auth's registry sign-in page, served on the storefront's and the
developer console's own host.

With REGISTRY_AUTH_UPSTREAM set, /login on marketplace.navide.dev or
developers.navide.dev sends the browser to /navide-auth/registry/sso on that
same host, and this module relays exactly those two paths (the page and its
form post) to navide-auth. Nothing else under /navide-auth is relayed: the
forum's own sign-in stays on the forum's host.

What crosses the relay is kept to what the sign-in needs:
- Request: only the navide_auth_registry cookie (never the registry's own
  session or login-state cookie), no Authorization, and X-Forwarded-For set
  to the one address the load balancer appended, so navide-auth's per-IP
  throttle (TRUST_PROXY=1) keys on the visitor exactly as it does today.
- Response: only Set-Cookie for navide_auth_registry, and a Location only when
  it is this host's own /auth/callback.
"""

from __future__ import annotations

import http.client
import logging
import urllib.parse

from fastapi import APIRouter, Request, Response
from fastapi.concurrency import run_in_threadpool
from starlette.responses import PlainTextResponse

from . import host_routing
from .config import AUTH_PROXY_PREFIX, Settings

_log = logging.getLogger(__name__)

PAGE_PATH = f"{AUTH_PROXY_PREFIX}/registry/sso"
FORM_PATH = f"{AUTH_PROXY_PREFIX}/registry/sso/login"
UPSTREAM_COOKIE = "navide_auth_registry"
MAX_BODY_BYTES = 16 * 1024  # navide-auth's own form body limit
MAX_RESPONSE_BYTES = 256 * 1024  # the sign-in page is a few KiB
TIMEOUT_SECONDS = 10

_FORWARD_REQUEST_HEADERS = ("content-type", "accept", "accept-language", "user-agent")
_FORWARD_RESPONSE_HEADERS = (
    "content-type",
    "cache-control",
    "content-security-policy",
    "x-content-type-options",
    "x-frame-options",
    "referrer-policy",
    "retry-after",
)


def visitor_address(request: Request) -> str:
    """The address the load balancer appended (the right-most
    X-Forwarded-For entry), which a visitor cannot choose; the socket peer
    when there is no proxy in front."""
    header = request.headers.get("x-forwarded-for", "")
    entries = [item.strip() for item in header.split(",") if item.strip()]
    if entries:
        return entries[-1]
    return request.client.host if request.client else ""


def upstream_cookie(request: Request) -> str | None:
    value = request.cookies.get(UPSTREAM_COOKIE)
    return f"{UPSTREAM_COOKIE}={value}" if value else None


def allowed_set_cookie(value: str) -> bool:
    return value.split("=", 1)[0].strip() == UPSTREAM_COOKIE


def allowed_location(settings: Settings, role: str, location: str) -> bool:
    """Only this host's own sign-in callback, with a query."""
    callback = host_routing.origin_for(settings, role) + "/auth/callback"
    parts = urllib.parse.urlsplit(location)
    return f"{parts.scheme}://{parts.netloc}{parts.path}" == callback and not parts.fragment


def _relay(settings: Settings, method: str, target: str, headers: dict[str, str], body: bytes):
    parts = urllib.parse.urlsplit(settings.auth_upstream)
    connection_class = (
        http.client.HTTPSConnection if parts.scheme == "https" else http.client.HTTPConnection
    )
    connection = connection_class(parts.netloc, timeout=TIMEOUT_SECONDS)
    try:
        connection.request(method, target, body=body or None, headers=headers)
        response = connection.getresponse()
        content = response.read(MAX_RESPONSE_BYTES + 1)
        if len(content) > MAX_RESPONSE_BYTES:
            raise http.client.HTTPException("navide-auth response too large")
        return response.status, response.getheaders(), content
    finally:
        connection.close()


def create_auth_proxy_router() -> APIRouter:
    router = APIRouter()

    async def relay(request: Request) -> Response:
        settings: Settings = request.app.state.registry.settings
        role = host_routing.request_role(request)
        if settings.auth_upstream is None or role not in (host_routing.STORE, host_routing.DEVELOPER):
            return PlainTextResponse("Not Found", status_code=404)
        body = b""
        if request.method == "POST":
            declared = request.headers.get("content-length", "")
            if declared.isdigit() and int(declared) > MAX_BODY_BYTES:
                return PlainTextResponse("Request too large", status_code=413)
            body = await request.body()
            if len(body) > MAX_BODY_BYTES:
                return PlainTextResponse("Request too large", status_code=413)
        headers = {
            name: request.headers[name] for name in _FORWARD_REQUEST_HEADERS if name in request.headers
        }
        cookie = upstream_cookie(request)
        if cookie is not None:
            headers["cookie"] = cookie
        address = visitor_address(request)
        if address:
            headers["x-forwarded-for"] = address
        target = request.url.path
        if request.url.query:
            target += "?" + request.url.query
        try:
            status, upstream_headers, content = await run_in_threadpool(
                _relay, settings, request.method, target, headers, body
            )
        except (OSError, http.client.HTTPException) as exc:
            _log.warning("navide-auth relay failed: %s", type(exc).__name__)
            return PlainTextResponse("Sign-in is unavailable. Please try again.", status_code=502)

        response = Response(content=content, status_code=status)
        for name, value in upstream_headers:
            lower = name.lower()
            if lower in _FORWARD_RESPONSE_HEADERS:
                response.headers.append(name, value)
            elif lower == "set-cookie" and allowed_set_cookie(value):
                response.headers.append("set-cookie", value)
            elif lower == "location":
                if not allowed_location(settings, role, value):
                    _log.warning("navide-auth relay refused a redirect off this host")
                    return PlainTextResponse("Sign-in is unavailable. Please try again.", status_code=502)
                response.headers["location"] = value
        return response

    router.add_api_route(PAGE_PATH, relay, methods=["GET"], include_in_schema=False)
    router.add_api_route(FORM_PATH, relay, methods=["POST"], include_in_schema=False)
    return router

"""Serve one registry under three host names.

- The storefront (store_origin, e.g. marketplace.navide.dev) serves the
  browse, detail, report and removed-extensions pages at the root path.
- The developer console (developer_origin, e.g. developers.navide.dev) serves
  sign-in-gated publisher, developer, CLI-login, admin and Testplace pages.
- A legacy host (legacy_hosts, e.g. server.navide.dev) keeps serving the API,
  downloads and sign-in callbacks under root_path for Apps and CLIs that have
  the old URL built in; its website pages redirect to legacy_redirect_to.

Neither the storefront nor the console serves the API. A page asked for on
the wrong one of the two is redirected to the right one, same path. Every
response that is not the storefront's carries X-Robots-Tag: noindex.

Any other host (a health check by IP, the container's own healthcheck, a
local run) keeps the single-host behavior: everything is served, under
root_path or at the root.
"""

from __future__ import annotations

import re
import urllib.parse

from starlette.responses import PlainTextResponse, RedirectResponse, Response
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .config import Settings

STORE = "store"
DEVELOPER = "developer"
LEGACY = "legacy"
OTHER = "other"
SHARED = "shared"
ROLE_STATE_KEY = "registry_host_role"
NOINDEX = b"noindex, nofollow"

# Website pages, by the host that owns them. Only GET/HEAD of these paths is
# ever redirected; everything else on the legacy host (API, downloads,
# /auth/*, health) is served unchanged.
_STORE_PAGE = re.compile(r"^/(?:extensions/[^/]+/[^/]+(?:/report)?|removed)?$")
_DEVELOPER_PAGE = re.compile(
    r"^/(?:publish|publisher(?:/[^/]+)?|developer(?:/apply)?"
    r"|cli/authorize|admin/[a-z-]+)$"
)
# Non-page routes each host serves for its own pages' forms and images.
_STORE_FORM = re.compile(r"^/extensions/[^/]+/[^/]+/(?:rating|rating/delete|report)$")
_STORE_ASSET = re.compile(r"^/extensions/[^/]+/[^/]+/[^/]+/assets/.+$")
_DEVELOPER_FORM = re.compile(r"^/(?:publisher|developer|cli|admin)/.+$")
_SHARED = re.compile(r"^/(?:login|logout|robots\.txt|auth/.+|static/.+)$")
# On the legacy host /login is a page too (it starts a sign-in there); its
# /auth/* stays served so a sign-in begun before the move can finish.
# The old CLI opens this page on the legacy host to sign in; it moves to the
# console instead of the legacy redirect target so that sign-in keeps working.
_CLI_LOGIN_PAGE = "/cli/authorize"


def page_owner(path: str) -> str | None:
    if _STORE_PAGE.match(path):
        return STORE
    if _DEVELOPER_PAGE.match(path):
        return DEVELOPER
    return None


def route_owner(path: str, method: str) -> str | None:
    """Which host serves `path` (relative to the site root), or None."""
    if _SHARED.match(path):
        return SHARED
    if method in ("GET", "HEAD"):
        owner = page_owner(path)
        if owner is not None:
            return owner
        if _STORE_ASSET.match(path):
            return STORE
        if path.startswith("/admin/review/") and path.endswith("/package"):
            return DEVELOPER
        return None
    if _STORE_FORM.match(path):
        return STORE
    if _DEVELOPER_FORM.match(path):
        return DEVELOPER
    return None


def _host(scope: Scope) -> str:
    for name, value in scope.get("headers", []):
        if name == b"host":
            return value.decode("latin-1").strip().lower()
    return ""


def _netloc(origin: str) -> str:
    return urllib.parse.urlsplit(origin).netloc.lower()


def host_role(settings: Settings, scope: Scope) -> str:
    host = _host(scope)
    if host == _netloc(settings.store_origin):
        return STORE
    if host == _netloc(settings.developer_origin):
        return DEVELOPER
    if host.rsplit(":", 1)[0] in settings.legacy_hosts:
        return LEGACY
    return OTHER


def request_role(request) -> str | None:
    """The host role of a request, or None when host routing is off."""
    return request.scope.get("state", {}).get(ROLE_STATE_KEY)


def origin_for(settings: Settings, role: str) -> str:
    return settings.store_origin if role == STORE else settings.developer_origin


def api_base(settings: Settings) -> str:
    """Where the API lives: the first legacy host under root_path."""
    scheme = urllib.parse.urlsplit(settings.store_origin).scheme
    return f"{scheme}://{settings.legacy_hosts[0]}{settings.root_path}"


def robots_txt(settings: Settings, role: str | None) -> str:
    allow = role in (None, STORE) or (role == LEGACY and not settings.legacy_robots_disallow)
    return "User-agent: *\n" + ("Allow: /\n" if allow else "Disallow: /\n")


def _with_query(location: str, scope: Scope) -> str:
    query = scope.get("query_string", b"").decode("latin-1")
    return f"{location}?{query}" if query else location


class HostRoutingMiddleware:
    def __init__(self, app: ASGIApp, settings: Settings) -> None:
        self.app = app
        self.settings = settings

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        settings = self.settings
        role = host_role(settings, scope)
        scope = dict(scope)
        scope["state"] = {**scope.get("state", {}), ROLE_STATE_KEY: role}
        root = settings.root_path
        method = scope["method"]
        response: Response | None = None
        if role in (STORE, DEVELOPER):
            scope["root_path"] = ""
            path = scope["path"]
            owner = route_owner(path, method)
            if role == DEVELOPER and path == "/" and method in ("GET", "HEAD"):
                response = RedirectResponse("/publisher", status_code=301)
            elif owner in (role, SHARED):
                pass
            elif owner is not None and method in ("GET", "HEAD"):
                response = RedirectResponse(
                    _with_query(origin_for(settings, owner) + path, scope), status_code=301
                )
            else:
                response = PlainTextResponse("Not Found", status_code=404)
        else:
            if root:
                scope["root_path"] = root
                path = scope["path"]
                if path != root and not path.startswith(root + "/"):
                    scope["path"] = root + path
                    if scope.get("raw_path") is not None:
                        scope["raw_path"] = root.encode() + scope["raw_path"]
            relative = scope["path"][len(root):] or "/"
            if role == LEGACY and method in ("GET", "HEAD") and (
                page_owner(relative) or relative == "/login"
            ):
                if relative == _CLI_LOGIN_PAGE:
                    location = _with_query(settings.developer_origin + relative, scope)
                else:
                    location = settings.legacy_redirect_to
                response = RedirectResponse(location, status_code=301)

        noindex = role != STORE

        async def send_with_robots(message: Message) -> None:
            if noindex and message["type"] == "http.response.start":
                message = {**message, "headers": [*message.get("headers", []), (b"x-robots-tag", NOINDEX)]}
            await send(message)

        if response is not None:
            await response(scope, receive, send_with_robots)
            return
        await self.app(scope, receive, send_with_robots)

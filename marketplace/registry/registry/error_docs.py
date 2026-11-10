"""Every 4xx error body names the page that explains it.

The handler keeps FastAPI's body (`detail`, status code and headers are
unchanged) and adds one field, `doc`: the URL of the documentation section for
that refusal, or the developer overview page when no section is more specific.
A refusal that is about a capability the manifest did not declare also carries
`code: "CAPABILITY_DENIED"`, the code the Host broker uses for the same thing.
"""

from __future__ import annotations

from fastapi import FastAPI, HTTPException, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exception_handlers import (
    http_exception_handler,
    request_validation_exception_handler,
)
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .web import SITE_LINKS

CAPABILITY_DENIED = "CAPABILITY_DENIED"

_DOCS = f"{SITE_LINKS['repo_url']}/blob/main/docs/en-US"
OVERVIEW_DOC = SITE_LINKS["guide_url"]
PUBLISHING_DOC = f"{_DOCS}/marketplace-publishing.md"
CAPABILITY_DENIED_DOC = f"{_DOCS}/plugin-development-v2.md#capability_denied"

# (text found in the detail, doc): checked first, in order.
_DETAIL_DOCS: tuple[tuple[str, str], ...] = (
    ("invalid package signature", f"{OVERVIEW_DOC}#4-publishing-is-the-business-process"),
    ("QUALIFICATION_REQUIRED", f"{PUBLISHING_DOC}#apply-for-developer-qualification"),
    ("% similar to", f"{PUBLISHING_DOC}#5-review"),
)

# (path prefix, doc): the first matching prefix wins.
_PATH_DOCS: tuple[tuple[str, str], ...] = (
    ("/api/testplace", f"{PUBLISHING_DOC}#testplace"),
    ("/api/admin/testplace", f"{PUBLISHING_DOC}#testplace"),
    ("/api/publish", f"{PUBLISHING_DOC}#sign-and-publish"),
    ("/api/developer", f"{PUBLISHING_DOC}#apply-for-developer-qualification"),
    ("/api/publisher", f"{PUBLISHING_DOC}#4-publish-to-the-marketplace"),
    ("/api/publishers", f"{PUBLISHING_DOC}#sign-in-and-claim-a-namespace"),
    ("/api/cli", f"{PUBLISHING_DOC}#log-in-from-the-cli"),
)


class DocumentedHTTPException(HTTPException):
    """An HTTPException whose body also carries a stable `code` (and, when
    given, a specific `doc`)."""

    def __init__(self, status_code: int, detail: object, *, code: str, doc: str | None = None) -> None:
        super().__init__(status_code=status_code, detail=detail)
        self.code = code
        self.doc = doc


def _route_path(request: Request) -> str:
    path = request.url.path
    root = request.scope.get("root_path") or ""
    if root and path.startswith(root):
        path = path[len(root):] or "/"
    return path


def doc_for(path: str, detail: object, code: str | None = None) -> str:
    """The documentation URL for a refusal of `path` with `detail`."""
    if code == CAPABILITY_DENIED:
        return CAPABILITY_DENIED_DOC
    text = detail if isinstance(detail, str) else repr(detail)
    for needle, doc in _DETAIL_DOCS:
        if needle in text:
            return doc
    if path.startswith("/api/extensions/") and path.endswith("/yank"):
        return f"{PUBLISHING_DOC}#8-yank-a-version"
    for prefix, doc in _PATH_DOCS:
        if path == prefix or path.startswith(prefix + "/") or path.startswith(prefix + "?"):
            return doc
    return OVERVIEW_DOC


def register_error_docs(app: FastAPI) -> None:
    @app.exception_handler(StarletteHTTPException)
    async def _http_error(request: Request, exc: StarletteHTTPException):
        if not 400 <= exc.status_code < 500:
            return await http_exception_handler(request, exc)
        code = getattr(exc, "code", None)
        body: dict[str, object] = {"detail": exc.detail}
        if code:
            body["code"] = code
        body["doc"] = getattr(exc, "doc", None) or doc_for(_route_path(request), exc.detail, code)
        return JSONResponse(jsonable_encoder(body), status_code=exc.status_code, headers=exc.headers)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(request: Request, exc: RequestValidationError):
        response = await request_validation_exception_handler(request, exc)
        body = {"detail": jsonable_encoder(exc.errors()), "doc": doc_for(_route_path(request), "")}
        return JSONResponse(body, status_code=response.status_code)

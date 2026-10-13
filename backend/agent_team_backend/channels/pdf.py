"""HTML attachments go to a chat as A4 PDFs, printed by the Electron Host.

The backend writes a print copy of the page into a fresh folder under
``<app data>/channels-pdf/`` and asks the Host (``channels.pdf_render.request``)
to load it in a hidden, script-less window whose session refuses every request but
that one file, and to print it to ``out.pdf`` beside it. The folder is removed when
the caller is done with the PDF, whatever happened; the whole root is cleared when
the backend starts. Nothing is cached: the same report sent twice is printed twice.

The print copy carries the policy Navide's own Plan preview runs under (no scripts,
no network, ``data:`` images and fonts only), disables the page's own
``http-equiv`` metas (a refresh to file://, a looser CSP) and forces the light theme.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re
import secrets
import shutil
import weakref
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, AsyncIterator, Awaitable, Callable

from ..ipc import make_error, make_event, make_response
from ..pending_registry import TIMEOUT, PendingRegistry
from . import media

if TYPE_CHECKING:
    from ..app import Session

log = logging.getLogger(__name__)

PDF_DIRNAME = "channels-pdf"
REQUEST_TYPE = "channels.pdf_render.request"
RESULT_TYPE = "channels.pdf_render.result"
TIMEOUT_S = 60.0
REPLY_BUDGET_S = 180.0  # all the conversions of one reply together
SOURCE_MAX_BYTES = media.INBOUND_MAX_BYTES
HTML_NAME = "print.html"
PDF_NAME = "out.pdf"
# The Host answers within its own timeout; a little grace lets that answer arrive.
_ANSWER_GRACE_S = 5.0

POLICY = "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'"
PRINT_STYLE = ("@page { size: A4; } "
               "html, body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } "
               ":root { color-scheme: light; }")
_PREAMBLE = (f'<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="{POLICY}">'
             f"<style>{PRINT_STYLE}</style>")
_DOCTYPE_RE = re.compile(r"^﻿?\s*<!doctype[^>]*>", re.IGNORECASE)
_HTTP_EQUIV_RE = re.compile(r"(<meta\b[^>]*?)\bhttp-equiv(\s*=)", re.IGNORECASE)
_HTML_TAG_RE = re.compile(r"<html(?=[\s>/])", re.IGNORECASE)
_PAGE_RE = re.compile(rb"/Type\s*/Page(?![A-Za-z])")

# A conversion at a time, for the whole backend: each one is a renderer process.
# One lock per event loop: a lock that once waited is bound to the loop it waited on.
_locks: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Lock]" = weakref.WeakKeyDictionary()
_pending: PendingRegistry[dict[str, Any]] = PendingRegistry()

RenderHost = Callable[[Path, Path, int], Awaitable[dict[str, Any]]]


def pdf_root(data_dir: Path) -> Path:
    return data_dir / PDF_DIRNAME


def clear(root: Path) -> None:
    """Remove every conversion folder (backend start: none of them is in use)."""
    shutil.rmtree(root, ignore_errors=True)


def print_copy(html: str) -> str:
    """``html`` as the page the Host prints: policy and print style first, the page's
    own ``http-equiv`` metas disabled, the light theme forced."""
    html = _HTTP_EQUIV_RE.sub(r"\1data-blocked-http-equiv\2", html)
    # Ahead of any data-theme the page set: the first of two equal attributes wins.
    html = _HTML_TAG_RE.sub('<html data-theme="light"', html, count=1)
    m = _DOCTYPE_RE.match(html)
    if m:
        return html[: m.end()] + _PREAMBLE + html[m.end():]
    return _PREAMBLE + html


def count_pages(data: bytes) -> int:
    return len(_PAGE_RE.findall(data))


@dataclass
class Converted:
    path: Path | None  # the PDF while the context is open, None on failure
    failure: str = ""  # one of report.FAILURES
    pages: int = 0
    size: int = 0


_FAILURE_BY_CODE = {"host_unavailable": "no_host", "host_timeout": "timeout", "timeout": "timeout"}


@contextlib.asynccontextmanager
async def converted(data: bytes, root: Path, host: RenderHost,
                    timeout_s: float = TIMEOUT_S) -> AsyncIterator[Converted]:
    """Print the HTML ``data``; yields the outcome and removes every file it made on exit."""
    if len(data) > SOURCE_MAX_BYTES:
        yield Converted(None, "source_too_large")
        return
    try:
        html = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        yield Converted(None, "error")
        return
    work: Path | None = None
    try:
        async with _locks.setdefault(asyncio.get_running_loop(), asyncio.Lock()):
            work = await asyncio.to_thread(_new_work_dir, root)
            html_path, pdf_path = work / HTML_NAME, work / PDF_NAME
            await asyncio.to_thread(html_path.write_text, print_copy(html), "utf-8")
            try:
                answer = await asyncio.wait_for(host(html_path, pdf_path, int(timeout_s * 1000)),
                                                timeout_s + _ANSWER_GRACE_S)
            except asyncio.TimeoutError:
                answer = {"ok": False, "error_code": "timeout"}
            except Exception as exc:  # noqa: BLE001 — any failure sends the original instead
                answer = {"ok": False, "error_code": "error", "error": str(exc)}
            result = await asyncio.to_thread(_judge, answer, pdf_path)
        yield result
    finally:
        if work is not None:
            await asyncio.to_thread(shutil.rmtree, work, True)


def _new_work_dir(root: Path) -> Path:
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    work = root / secrets.token_hex(8)
    work.mkdir(mode=0o700)
    return work


def _judge(answer: dict[str, Any], pdf_path: Path) -> Converted:
    if not answer.get("ok"):
        code = str(answer.get("error_code") or "")
        if code not in _FAILURE_BY_CODE:
            log.warning("channels: PDF conversion failed: %s", answer.get("error") or code or "unknown")
        return Converted(None, _FAILURE_BY_CODE.get(code, "error"))
    try:
        if pdf_path.is_symlink() or not pdf_path.is_file():
            return Converted(None, "not_pdf")
        data = pdf_path.read_bytes()
    except OSError:
        return Converted(None, "not_pdf")
    if not data.startswith(b"%PDF-"):
        return Converted(None, "not_pdf")
    return Converted(pdf_path, "", count_pages(data), len(data))


# --- the Host round trip ----------------------------------------------------------------


async def _unicast_host(event: dict[str, Any]) -> bool:
    from .. import app

    return await app.unicast_host(event)


async def request_host(html_path: Path, pdf_path: Path, timeout_ms: int) -> dict[str, Any]:
    """Ask the Electron Host to print ``html_path`` to ``pdf_path``: {ok, error_code?, error?}."""
    request_id = f"pdf:{secrets.token_hex(16)}"
    future = _pending.register(request_id)
    try:
        sent = await _unicast_host(make_event(REQUEST_TYPE, {
            "request_id": request_id, "html_path": str(html_path), "pdf_path": str(pdf_path),
            "timeout_ms": timeout_ms,
        }))
        if not sent:
            return {"ok": False, "error_code": "host_unavailable"}
        answer = await _pending.wait(request_id, future, timeout=timeout_ms / 1000 + _ANSWER_GRACE_S)
        if answer is TIMEOUT:
            return {"ok": False, "error_code": "host_timeout"}
        return answer if isinstance(answer, dict) else {"ok": False, "error_code": "error"}
    finally:
        _pending.discard(request_id)


def resolve_result(request_id: str, response: dict[str, Any]) -> bool:
    return _pending.resolve(request_id, response)


async def handle_result(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """``channels.pdf_render.result`` from the Host: wake the conversion waiting on it."""
    if not getattr(session, "host_authenticated", False):
        await session.send_json(make_error(msg_id, msg_type, "UNAUTHORIZED", "Host session is not authenticated"))
        return
    request_id = payload.get("request_id") if isinstance(payload, dict) else None
    response = payload.get("response") if isinstance(payload, dict) else None
    if not isinstance(request_id, str) or not isinstance(response, dict):
        await session.send_json(make_error(msg_id, msg_type, "BAD_REQUEST", f"{msg_type} is malformed"))
        return
    await session.send_json(make_response(msg_id, msg_type, {"delivered": resolve_result(request_id, response)}))

"""Sync records as objects: every synced item's sealed body lives in object storage.

``skill_blobs`` moved only large skill files this way; this module carries the
same idea to every record of the synced scopes (prompts, skills, mcp — memory
and credentials never sync). The server keeps metadata only, and the bodies go
straight to object storage over presigned URLs.

A record object is small — a prompt, an MCP entry — so it is sealed in memory
and sent with one PUT; only one past ``MULTIPART_THRESHOLD`` goes through the
multipart path ``skill_blobs`` already has. Many small objects in a row make
the TLS handshake the dominant cost, so they travel over ``HttpPool``, which
keeps connections open between requests.
"""

from __future__ import annotations

import hashlib
import hmac
import http.client
import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable
from urllib.parse import urlsplit

log = logging.getLogger("agent_team_backend.sync_objects")

#: Per-request socket timeout, as for skill blobs.
_HTTP_TIMEOUT_S = 60
#: Connections kept per host. Matches the parallel GETs of a pull.
POOL_PER_HOST = 8


class HttpPool:
    """Keep-alive HTTP(S) connections, reused across requests and threads.

    ``request`` borrows an idle connection for its host or opens one, reads the
    whole response, and gives the connection back unless the server said it
    would close it. A reused connection the server has since dropped fails on
    its first write or read; that request is retried once on a fresh one, which
    is safe because every request here is a PUT of a whole object or a GET.
    """

    def __init__(self, per_host: int = POOL_PER_HOST, timeout: float = _HTTP_TIMEOUT_S) -> None:
        self._per_host = per_host
        self._timeout = timeout
        self._idle: dict[tuple[str, str, int], list[http.client.HTTPConnection]] = {}
        self._lock = threading.Lock()

    def _open(self, key: tuple[str, str, int]) -> http.client.HTTPConnection:
        scheme, host, port = key
        cls = http.client.HTTPSConnection if scheme == "https" else http.client.HTTPConnection
        return cls(host, port, timeout=self._timeout)

    def _take(self, key: tuple[str, str, int]) -> http.client.HTTPConnection | None:
        with self._lock:
            idle = self._idle.get(key)
            return idle.pop() if idle else None

    def _give(self, key: tuple[str, str, int], conn: http.client.HTTPConnection) -> None:
        with self._lock:
            idle = self._idle.setdefault(key, [])
            if len(idle) < self._per_host:
                idle.append(conn)
                return
        conn.close()

    def request(
        self, method: str, url: str, body: bytes | None = None, headers: dict[str, str] | None = None
    ) -> tuple[int, bytes]:
        """Send one request; returns ``(status, body)``. Raises ``OSError`` or
        ``http.client.HTTPException`` when no response could be had at all."""
        parts = urlsplit(url)
        scheme = parts.scheme or "http"
        key = (scheme, parts.hostname or "", parts.port or (443 if scheme == "https" else 80))
        target = parts.path or "/"
        if parts.query:
            target += "?" + parts.query
        hdrs = dict(headers or {})
        if body is not None:
            hdrs.setdefault("Content-Type", "application/octet-stream")
        for attempt in range(2):
            conn = self._take(key)
            reused = conn is not None
            if conn is None:
                conn = self._open(key)
            try:
                conn.request(method, target, body=body, headers=hdrs)
                res = conn.getresponse()
                data = res.read()
            except (OSError, http.client.HTTPException):
                conn.close()
                if reused and attempt == 0:
                    continue
                raise
            if res.will_close:
                conn.close()
            else:
                self._give(key, conn)
            return res.status, data
        raise AssertionError("unreachable")

    def close(self) -> None:
        with self._lock:
            idle, self._idle = self._idle, {}
        for conns in idle.values():
            for conn in conns:
                conn.close()


# ── record objects ──────────────────────────────────────────────────────────

#: Transfers of one batch that run at once.
PARALLEL = 8

_POOL = HttpPool()


class ObjectError(Exception):
    """An object could not be stored or fetched. The text is fixed, safe to
    show: it never quotes a URL (which carries a signature) or a body."""


def shared_pool() -> HttpPool:
    """The one pool every record transfer goes through."""
    return _POOL


def object_id(data: bytes) -> str:
    """The blob id of a sealed record's bytes: the keyed hash of
    ``sync_keyring.blob_hasher`` under the key the envelope names (the
    active one for an envelope that names none)."""
    from . import sync_keyring

    kid = sync_keyring.envelope_kid(data.decode("utf-8"))
    _, hasher = sync_keyring.blob_hasher(kid)
    hasher.update(data)
    return hasher.hexdigest()


def object_matches(blob_id: str, data: bytes) -> bool:
    """Whether *data* is the object *blob_id* names.

    Two namings are valid: this account's keyed hash, and a plain SHA-256,
    which is what the server names an object by when it writes one itself
    (for a client that still sends bodies). A body under a key this machine
    does not hold cannot be checked here; it passes, and opening it is what
    holds it back (``UnknownKeyId``).
    """
    from . import sync_keyring

    if hashlib.sha256(data).hexdigest() == blob_id:
        return True
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return False
    kid = sync_keyring.envelope_kid(text)
    held = sync_keyring.ring() or {}
    if kid is not None and kid not in (held.get("keys") or {}):
        return True
    _, hasher = sync_keyring.blob_hasher(kid)
    hasher.update(data)
    return hmac.compare_digest(hasher.hexdigest(), blob_id)


def _run_all(fn: Callable[[Any], Any], jobs: list[Any]) -> list[Any]:
    if not jobs:
        return []
    with ThreadPoolExecutor(max_workers=min(PARALLEL, len(jobs))) as pool:
        return list(pool.map(fn, jobs))


def put_all(uploads: list[tuple[str, bytes]]) -> None:
    """PUT each ``(url, bytes)``, PARALLEL at a time. Blocking; raises
    ``ObjectError`` unless every one was answered 2xx."""

    def one(job: tuple[str, bytes]) -> None:
        url, data = job
        try:
            status, _ = _POOL.request("PUT", url, body=data)
        except (OSError, http.client.HTTPException) as err:
            raise ObjectError(f"an object upload failed ({type(err).__name__})") from err
        if not 200 <= status < 300:
            raise ObjectError(f"an object upload was answered {status}")

    _run_all(one, uploads)


def get_all(downloads: list[tuple[str, str]]) -> dict[str, bytes]:
    """GET each ``(blob id, url)``, PARALLEL at a time. Blocking; raises
    ``ObjectError`` unless every one was answered 200."""

    def one(job: tuple[str, str]) -> tuple[str, bytes]:
        blob_id, url = job
        try:
            status, data = _POOL.request("GET", url)
        except (OSError, http.client.HTTPException) as err:
            raise ObjectError(f"an object download failed ({type(err).__name__})") from err
        if status != 200:
            raise ObjectError(f"an object download was answered {status}")
        return blob_id, data

    return dict(_run_all(one, downloads))

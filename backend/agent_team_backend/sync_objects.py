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

import http.client
import logging
import threading
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

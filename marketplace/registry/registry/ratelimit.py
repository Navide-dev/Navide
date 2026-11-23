"""Per-member sliding-window rate limits for website writes.

In memory: the registry runs as one uvicorn worker (deploy/entrypoint.sh), and
a restart only forgives a burst. Durable per-member caps (one rating per
extension, one open report per extension) are enforced by the database.
"""

from __future__ import annotations

import threading
from collections import deque


class SlidingWindowLimiter:
    def __init__(self, limit: int, window_seconds: float) -> None:
        self.limit = limit
        self.window_seconds = window_seconds
        self._hits: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def exceeded(self, key: str, now: float) -> bool:
        """Whether `key` is at the limit, without recording a hit (for limits
        that count only failures but refuse every request once reached)."""
        with self._lock:
            hits = self._hits.get(key)
            if hits is None:
                return False
            while hits and hits[0] <= now - self.window_seconds:
                hits.popleft()
            return len(hits) >= self.limit

    def allow(self, key: str, now: float) -> bool:
        """Record a hit for `key` and return True, or False when over the limit."""
        with self._lock:
            hits = self._hits.setdefault(key, deque())
            while hits and hits[0] <= now - self.window_seconds:
                hits.popleft()
            if len(hits) >= self.limit:
                return False
            hits.append(now)
            return True

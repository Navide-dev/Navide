"""Work bounds shared by the scanners (contract 3.8, DS2, review of #355).

`Deadline` is checked inside every scanning loop, not only between files, so
no single hostile file can run past the per-artifact time budget. A loop
that reaches a structural ceiling raises `TooComplex`; the report then
records the file under `coverage.skipped` as `tooComplex` and the scan is
incomplete.
"""

from __future__ import annotations

import time
from collections.abc import Callable


class ScanTimeout(Exception):
    """The per-artifact time budget ran out."""


class TooComplex(Exception):
    """A file hit a structural ceiling (nesting, section, import or symbol counts)."""


class Deadline:
    """A monotonic deadline that is cheap to poll from tight loops."""

    __slots__ = ("_at", "_clock", "_countdown")
    _EVERY = 512

    def __init__(self, at: float | None, clock: Callable[[], float] = time.monotonic) -> None:
        self._at = at
        self._clock = clock
        self._countdown = self._EVERY

    def tick(self) -> None:
        """Count one unit of work; look at the clock every few hundred."""
        self._countdown -= 1
        if self._countdown <= 0:
            self._countdown = self._EVERY
            self.check()

    def check(self) -> None:
        if self._at is not None and self._clock() > self._at:
            raise ScanTimeout()


NO_DEADLINE = Deadline(None)

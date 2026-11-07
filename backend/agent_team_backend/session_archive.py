"""Which CLI session logs may be archived (compressed, then uploaded).

Archiving is opt-in and off by default; nothing here changes a file. This
module only decides which logs qualify: a jsonl transcript nobody has written
to for ``idle_days``, that is not a session a pane is still bound to, and that
has not been archived already. Compressing and uploading build on this list.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

#: A log idle this long is finished: a CLI resuming it would write to it.
DEFAULT_IDLE_DAYS = 7

ARCHIVE_SUFFIX = ".zst"


@dataclass(frozen=True)
class Candidate:
    path: Path
    size: int
    mtime: float


def archive_candidates(
    roots: Iterable[Path],
    *,
    idle_days: int = DEFAULT_IDLE_DAYS,
    open_sessions: frozenset[str] = frozenset(),
    now: float | None = None,
) -> list[Candidate]:
    """jsonl logs under ``roots`` (any depth) idle for ``idle_days`` or more.

    A log whose stem is in ``open_sessions`` (a session a pane is bound to) is
    skipped however old it is, and so is one with an archive next to it.
    Unreadable entries are skipped, never raised. Oldest first.
    """
    cutoff = (time.time() if now is None else now) - idle_days * 86_400
    out: list[Candidate] = []
    for root in roots:
        try:
            paths = list(root.rglob("*.jsonl"))
        except OSError:
            continue
        for path in paths:
            if path.stem in open_sessions:
                continue
            if path.with_name(path.name + ARCHIVE_SUFFIX).exists():
                continue
            try:
                st = path.stat()
            except OSError:
                continue
            if st.st_mtime <= cutoff:
                out.append(Candidate(path, st.st_size, st.st_mtime))
    return sorted(out, key=lambda c: c.mtime)

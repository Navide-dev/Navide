"""Shared check for line readers that resume parse_activity (log_readers.base.ActivityLines).

Each vendor's own tests call ``assert_resumes`` with transcript lines in its own
format. The truncation, replacement and half-line fallbacks are the helper's and
are tested once, in test_activity_lines.py.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path

import pytest

# A record no reader acts on, to make the transcript large enough that reading
# it whole is unmistakable next to reading what was appended.
PAD = json.dumps({"type": "navide.test.padding", "pad": "x" * 1000}) + "\n"
PAD_LINES = 1000


def _events(events: list) -> list[tuple]:  # noqa: ANN001
    return [(e.event_type, e.dedup_key, e.detail, e.text, e.session_id, e.cwd) for e in events]


def assert_resumes(
    make_reader: Callable[[], object],
    path: Path,
    appended: list[dict],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``path`` already holds the vendor's transcript. After padding it and a first
    walk, ``appended`` is written: the reader that walked it before must emit
    exactly what a fresh reader with the same bag emits, reading only a fraction
    of the file."""
    with path.open("a", encoding="utf-8", newline="") as fh:
        fh.write(PAD * PAD_LINES)
    reader = make_reader()
    seen: set[str] = set()
    reader.parse_activity(path, seen)

    with path.open("a", encoding="utf-8", newline="") as fh:
        for rec in appended:
            fh.write(json.dumps(rec) + "\n")
    expected = _events(make_reader().parse_activity(path, set(seen)))
    assert expected, "the appended records produced no event: the parity check would be empty"

    read = [0]
    real_open = Path.open

    class _Counting:
        def __init__(self, fh) -> None:  # noqa: ANN001
            self._fh = fh

        def __enter__(self):  # noqa: ANN204
            return self

        def __exit__(self, *exc) -> None:  # noqa: ANN002
            self._fh.close()

        def __iter__(self):  # noqa: ANN204
            for chunk in self._fh:
                read[0] += len(chunk)
                yield chunk

        def read(self, n: int = -1):  # noqa: ANN201
            data = self._fh.read(n)
            read[0] += len(data)
            return data

        def readline(self, *a):  # noqa: ANN002, ANN201
            data = self._fh.readline(*a)
            read[0] += len(data)
            return data

        def __getattr__(self, name: str):  # noqa: ANN204
            return getattr(self._fh, name)

    def counting_open(p: Path, *args, **kwargs):  # noqa: ANN002, ANN003, ANN202
        return _Counting(real_open(p, *args, **kwargs))

    monkeypatch.setattr(Path, "open", counting_open)
    got = _events(reader.parse_activity(path, seen))

    assert got == expected
    size = path.stat().st_size
    assert read[0] < size // 10, f"read {read[0]} of {size} bytes to parse an append"

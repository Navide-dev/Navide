"""ActivityLines: a line walk that resumes at the byte after its high-water line.

The line readers' high-water mark skipped parsing, not reading: every walk read
the transcript from byte 0, so each append to a long conversation cost a read
of the whole file and the serial log reader fell behind (2026-11-03: turn ends
up to 733 s late). The vendor parity tests live with each vendor's own tests;
these pin the helper's fallbacks.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from agent_team_backend.log_readers.base import ActivityLines, set_activity_high_water


class _Reader:
    """Stands in for a LogReader: the helper keeps its resume points on it."""


class _ReadMeter:
    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.bytes = 0
        meter = self
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
                    meter.bytes += len(chunk)
                    yield chunk

            def read(self, n: int = -1):  # noqa: ANN201
                data = self._fh.read(n)
                meter.bytes += len(data)
                return data

            def __getattr__(self, name: str):  # noqa: ANN204
                return getattr(self._fh, name)

        def counting_open(path: Path, *args, **kwargs):  # noqa: ANN002, ANN003, ANN202
            return _Counting(real_open(path, *args, **kwargs))

        monkeypatch.setattr(Path, "open", counting_open)


def _walk(reader: _Reader, path: Path, seen: set[str]) -> list[tuple[int, str]]:
    """A minimal line reader: every terminated line past the mark is an event."""
    from agent_team_backend.log_readers.base import activity_high_water

    high_water = activity_high_water(seen)
    last_line = high_water
    out: list[tuple[int, str]] = []
    lines = ActivityLines(reader, path, seen)
    try:
        with lines:
            for line_no, raw_line in lines:
                if line_no <= high_water or not raw_line.strip():
                    continue
                if not raw_line.endswith("\n"):
                    break
                last_line = line_no
                out.append((line_no, raw_line.strip()))
    finally:
        set_activity_high_water(seen, last_line)
        lines.save(last_line)
    return out


def _fresh(path: Path, seen: set[str]) -> list[tuple[int, str]]:
    return _walk(_Reader(), path, set(seen))


@pytest.fixture
def path(tmp_path: Path) -> Path:
    p = tmp_path / "log.jsonl"
    p.write_text("".join(f"line {i} {'x' * 100}\n" for i in range(1, 501)), encoding="utf-8", newline="")
    return p


def test_an_append_is_read_from_where_the_walk_stopped(path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    reader, seen = _Reader(), set()
    _walk(reader, path, seen)
    added = "new 501\n\nnew 503\n"
    with path.open("a", encoding="utf-8", newline="") as fh:
        fh.write(added)
    expected = _fresh(path, seen)
    meter = _ReadMeter(monkeypatch)
    assert _walk(reader, path, seen) == expected == [(501, "new 501"), (503, "new 503")]
    assert meter.bytes <= len(added.encode()) + 1


def test_a_truncated_file_is_read_from_the_head(path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    reader, seen = _Reader(), set()
    _walk(reader, path, seen)
    short = "".join(f"short {i}\n" for i in range(1, 11))
    with path.open("r+", encoding="utf-8", newline="") as fh:
        fh.truncate(0)
        fh.write(short)
    expected = _fresh(path, seen)
    meter = _ReadMeter(monkeypatch)
    assert _walk(reader, path, seen) == expected
    assert meter.bytes == len(short.encode())


def test_a_replaced_file_is_read_from_the_head(path: Path) -> None:
    reader, seen = _Reader(), set()
    _walk(reader, path, seen)
    other = path.with_suffix(".tmp")
    other.write_text("".join(f"other {i} {'y' * 120}\n" for i in range(1, 520)), encoding="utf-8", newline="")
    os.replace(other, path)
    expected = _fresh(path, seen)
    assert _walk(reader, path, seen) == expected


def test_a_half_written_line_is_finished_next_time(path: Path) -> None:
    reader, seen = _Reader(), set()
    _walk(reader, path, seen)
    with path.open("a", encoding="utf-8", newline="") as fh:
        fh.write("half")
    assert _walk(reader, path, seen) == []
    with path.open("a", encoding="utf-8", newline="") as fh:
        fh.write(" done\n")
    expected = _fresh(path, seen)
    assert _walk(reader, path, seen) == expected == [(501, "half done")]


def test_a_different_mark_is_read_from_the_head(path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    reader = _Reader()
    _walk(reader, path, set())
    meter = _ReadMeter(monkeypatch)
    assert len(_walk(reader, path, set())) == 500
    assert meter.bytes == path.stat().st_size


def test_resume_points_are_per_reader(path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    seen: set[str] = set()
    _walk(_Reader(), path, seen)
    meter = _ReadMeter(monkeypatch)
    _walk(_Reader(), path, set(seen))
    assert meter.bytes == path.stat().st_size

"""Claude parse_activity resumes from the byte after its high-water line.

The line high-water mark only skipped *parsing*: every walk still read the
transcript from byte 0. A busy pane's transcript is appended to many times a
minute and the commander's had grown to 315 MB (~1.3 s a walk), which is how
the log reader fell minutes behind the Stop hook (2026-11-03: turn ends up to
733 s late, the chat told "回合已結束，但還沒讀到回覆文字", MSG blocks dropped).

Every case also checks equivalence with a reader that has no resume point
(a fresh instance), so the byte offset can never change which events come out.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from agent_team_backend.cli_vendors.claude import ClaudeLogReader
from agent_team_backend.log_readers.base import activity_high_water


def _line(i: int, *, end: bool = False) -> str:
    msg = {"stop_reason": "end_turn" if end else "tool_use",
           "content": [{"type": "text", "text": f"line {i} " + "x" * 200}]}
    return json.dumps({"type": "assistant", "timestamp": f"2026-11-03T10:00:{i % 60:02d}Z",
                       "message": msg}) + "\n"


class _ReadMeter:
    """Counts the bytes a parse pulls out of the file it opens."""

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


def _keys(events) -> list[tuple[str, str]]:  # noqa: ANN001
    return [(e.event_type, e.dedup_key) for e in events]


def _fresh(path: Path, seen: set[str]) -> list[tuple[str, str]]:
    """What a reader with no resume point emits for the same bag."""
    return _keys(ClaudeLogReader().parse_activity(path, set(seen)))


@pytest.fixture
def transcript(tmp_path: Path) -> Path:
    project = tmp_path / "-ws"
    project.mkdir()
    path = project / "session.jsonl"
    path.write_text("".join(_line(i) for i in range(1, 2001)), encoding="utf-8", newline="")
    return path


def test_append_reads_only_the_new_bytes(transcript: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    reader = ClaudeLogReader()
    seen: set[str] = set()
    reader.parse_activity(transcript, seen)
    assert activity_high_water(seen) == 2000

    added = _line(2001) + _line(2002) + _line(2003, end=True)
    with transcript.open("a", encoding="utf-8", newline="") as fh:
        fh.write(added)
    expected = _fresh(transcript, seen)
    meter = _ReadMeter(monkeypatch)
    events = reader.parse_activity(transcript, seen)

    assert _keys(events) == expected
    assert ("turn_complete", "turn:2003") in _keys(events)
    # The new lines, plus the one byte that checks the resume point is a line end.
    assert meter.bytes <= len(added.encode()) + 1
    assert activity_high_water(seen) == 2003


def test_truncated_file_is_read_from_the_head(transcript: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    reader = ClaudeLogReader()
    seen: set[str] = set()
    reader.parse_activity(transcript, seen)

    short = "".join(_line(i) for i in range(1, 11))
    with transcript.open("r+", encoding="utf-8", newline="") as fh:  # same inode, smaller
        fh.truncate(0)
        fh.write(short)
    expected = _fresh(transcript, seen)
    meter = _ReadMeter(monkeypatch)
    events = reader.parse_activity(transcript, seen)

    assert _keys(events) == expected
    assert meter.bytes == len(short.encode())


def test_replaced_file_is_read_from_the_head(transcript: Path) -> None:
    reader = ClaudeLogReader()
    seen: set[str] = set()
    reader.parse_activity(transcript, seen)

    # A different file (new inode), bigger than the old one, at the same path.
    other = transcript.with_suffix(".tmp")
    other.write_text("".join(_line(i) for i in range(1, 2003)) + _line(2003, end=True),
                     encoding="utf-8", newline="")
    os.replace(other, transcript)
    expected = _fresh(transcript, seen)
    assert _keys(reader.parse_activity(transcript, seen)) == expected


def test_half_written_line_is_finished_next_time(transcript: Path) -> None:
    reader = ClaudeLogReader()
    seen: set[str] = set()
    reader.parse_activity(transcript, seen)

    whole = _line(2001, end=True)
    with transcript.open("a", encoding="utf-8", newline="") as fh:
        fh.write(whole[:50])
    assert reader.parse_activity(transcript, seen) == []
    assert activity_high_water(seen) == 2000

    with transcript.open("a", encoding="utf-8", newline="") as fh:
        fh.write(whole[50:])
    expected = _fresh(transcript, seen)
    events = reader.parse_activity(transcript, seen)
    assert _keys(events) == expected
    assert ("turn_complete", "turn:2001") in _keys(events)


def test_changed_mark_is_read_from_the_head(transcript: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A bag the watcher rewound (or a fresh one) does not match the resume point."""
    reader = ClaudeLogReader()
    reader.parse_activity(transcript, set())
    meter = _ReadMeter(monkeypatch)
    events = reader.parse_activity(transcript, set())
    assert len(events) == 2000
    assert meter.bytes == transcript.stat().st_size

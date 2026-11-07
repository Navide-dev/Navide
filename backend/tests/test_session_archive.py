"""archive_candidates only selects; it never changes a file."""

from __future__ import annotations

import os
from pathlib import Path

from agent_team_backend.session_archive import archive_candidates

NOW = 2_000_000_000.0
DAY = 86_400


def _log(path: Path, age_days: float, body: str = "{}\n") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(body, encoding="utf-8")
    os.utime(path, (NOW - age_days * DAY, NOW - age_days * DAY))
    return path


def _snapshot(root: Path) -> dict[str, tuple[int, float, str]]:
    return {
        str(p): (p.stat().st_size, p.stat().st_mtime, p.read_text(encoding="utf-8"))
        for p in sorted(root.rglob("*")) if p.is_file()
    }


def test_only_logs_idle_long_enough_qualify_oldest_first(tmp_path: Path) -> None:
    old = _log(tmp_path / "-Users-me-a" / "old.jsonl", 30)
    week = _log(tmp_path / "-Users-me-a" / "week.jsonl", 7)
    _log(tmp_path / "-Users-me-a" / "fresh.jsonl", 6.9)
    _log(tmp_path / "-Users-me-a" / "notes.txt", 30)
    sub = _log(tmp_path / "-Users-me-b" / "s" / "subagents" / "agent-1.jsonl", 10)
    found = [c.path for c in archive_candidates([tmp_path], now=NOW)]
    assert found == [old, sub, week]


def test_open_and_already_archived_sessions_are_skipped(tmp_path: Path) -> None:
    _log(tmp_path / "p" / "bound.jsonl", 30)
    done = _log(tmp_path / "p" / "done.jsonl", 30)
    done.with_name("done.jsonl.zst").write_bytes(b"x")
    keep = _log(tmp_path / "p" / "keep.jsonl", 30)
    found = archive_candidates([tmp_path], now=NOW, open_sessions=frozenset({"bound"}))
    assert [c.path for c in found] == [keep]
    assert found[0].size == 3


def test_selecting_changes_nothing_and_a_missing_root_is_empty(tmp_path: Path) -> None:
    _log(tmp_path / "p" / "a.jsonl", 30)
    before = _snapshot(tmp_path)
    archive_candidates([tmp_path, tmp_path / "missing"], now=NOW)
    assert _snapshot(tmp_path) == before
    assert archive_candidates([tmp_path / "missing"], now=NOW) == []

"""Routing a codex transcript must not enumerate every pane home.

codex's project_dirs() lists ~/.codex-panes and resolves each home's
`sessions` dir. The log watcher asked it for every file it routed and for
every Stop hook, on the event loop; during the 2026-11-12 mass restore that
walk showed up in ~80 loop-stall stacks while /plan-mcp answers took 20-57s.
Whether a resolved path is codex's is a question about the path's own
components, so it is answered from them.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from agent_team_backend.cli_vendors.codex import CodexLogReader
from agent_team_backend.log_readers.watcher import LogWatcher


@pytest.fixture
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    default = tmp_path / ".codex" / "sessions" / "2026" / "11" / "12"
    default.mkdir(parents=True)
    (default / "rollout-a.jsonl").write_text("{}\n", encoding="utf-8")
    pane = tmp_path / ".codex-panes" / "p1" / "sessions" / "2026"
    pane.mkdir(parents=True)
    (pane / "rollout-b.jsonl").write_text("{}\n", encoding="utf-8")
    # A pane home from before 9ab9e87c: `sessions` links back to the default tree.
    legacy = tmp_path / ".codex-panes" / "p2"
    legacy.mkdir()
    (legacy / "sessions").symlink_to(tmp_path / ".codex" / "sessions")
    (legacy / "notes.jsonl").write_text("{}\n", encoding="utf-8")
    (tmp_path / "elsewhere.jsonl").write_text("{}\n", encoding="utf-8")
    return tmp_path


def _no_enumeration(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(self: CodexLogReader) -> list[Path]:
        raise AssertionError("project_dirs() enumerated the pane homes")
    monkeypatch.setattr(CodexLogReader, "project_dirs", boom)


def test_claims_match_the_enumerated_roots(home: Path) -> None:
    reader = CodexLogReader()
    paths = [
        home / ".codex" / "sessions" / "2026" / "11" / "12" / "rollout-a.jsonl",
        home / ".codex-panes" / "p1" / "sessions" / "2026" / "rollout-b.jsonl",
        home / ".codex-panes" / "p2" / "notes.jsonl",
        home / "elsewhere.jsonl",
        home / ".codex-panes" / "p1",
        home / ".codex-panes" / "p1" / "sessions",
    ]
    expected = {
        p: any(p.resolve().is_relative_to(d.resolve()) for d in reader.project_dirs())
        for p in paths
    }
    assert [expected[p] for p in paths] == [True, True, False, False, False, True]
    for p in paths:
        assert reader.claims_path(p.resolve()) is expected[p], p


def test_claims_do_not_enumerate_pane_homes(home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    reader = CodexLogReader()
    _no_enumeration(monkeypatch)
    assert reader.claims_path(
        (home / ".codex-panes" / "p1" / "sessions" / "2026" / "rollout-b.jsonl").resolve()
    )
    assert not reader.claims_path((home / "elsewhere.jsonl").resolve())


@pytest.mark.asyncio
async def test_a_stop_hook_does_not_enumerate_pane_homes(home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    async def _sink(_x: object) -> None:
        return None

    reader = CodexLogReader()
    watcher = LogWatcher(sink=_sink, activity_sink=_sink)  # type: ignore[arg-type]
    watcher.add_reader(reader)
    watcher._loop = asyncio.get_running_loop()  # noqa: SLF001
    _no_enumeration(monkeypatch)
    target = home / ".codex-panes" / "p1" / "sessions" / "2026" / "rollout-b.jsonl"

    watcher.prioritize(target)

    assert target.resolve() in watcher._priority  # noqa: SLF001

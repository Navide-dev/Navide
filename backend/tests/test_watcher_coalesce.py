"""LogWatcher: a file already waiting in the realtime queue is not queued again.

Claude Code appends one transcript line per message block, tool call and tool
result, and watchdog reports every append. Each queued path costs a
parse_activity walk of the whole file (the line high-water mark skips parsing,
not reading: a 300 MB conversation is about 1.3 s per walk on an idle
machine). The drain is serial, so with thirty busy panes the queue held the
same few files hundreds of times over and a turn's end reached the backend
minutes after the CLI wrote it — 2026-11-03 logged 27 log turn ends over 120 s
behind their Stop hook (733 s at most). Past 120 s the chat is told "回合已結束，
但還沒讀到回覆文字"; past the renderer's 60 s replay tolerance the turn's MSG
blocks to other panes were dropped as a replay.

One pending entry per file is enough: the walk reads up to the end of the file
as it is when it runs, so later appends are covered by the entry already
waiting. An append that lands while the file is being walked queues it again.
"""

from __future__ import annotations

import asyncio
import threading
from pathlib import Path

import pytest

from agent_team_backend.log_readers.base import ActivityEvent, LogReader
from agent_team_backend.log_readers.watcher import LogWatcher


class _CountingReader(LogReader):
    vendor = "claude"

    def __init__(self, root: Path) -> None:
        self.root = root
        self.parse_calls = 0
        self.first_started = threading.Event()
        self.release = threading.Event()

    def project_dirs(self) -> list[Path]:
        return [self.root]

    def session_files(self) -> list[Path]:
        return sorted(self.root.glob("*.jsonl"))

    def parse_session_file(self, path: Path, seen_keys: set[str]) -> list:
        return []

    def claims_path(self, path: Path) -> bool:
        return str(path).startswith(str(self.root))

    def parse_activity(self, path: Path, seen_keys: set[str]) -> list[ActivityEvent]:
        self.parse_calls += 1
        if self.parse_calls == 1:
            self.first_started.set()
            self.release.wait(5)
        return []


async def _activity(_event: ActivityEvent) -> None:
    return None


async def _tokens(_usage: object) -> None:
    return None


@pytest.mark.asyncio
async def test_appends_while_a_file_waits_are_walked_once(tmp_path: Path) -> None:
    root = tmp_path / "claude"
    root.mkdir()
    busy = root / "busy.jsonl"
    busy.write_text("{}\n", encoding="utf-8")
    other = root / "other.jsonl"
    other.write_text("{}\n", encoding="utf-8")
    reader = _CountingReader(root)
    watcher = LogWatcher(sink=_tokens, activity_sink=_activity)  # type: ignore[arg-type]
    watcher.add_reader(reader)
    watcher._loop = asyncio.get_running_loop()  # noqa: SLF001
    drain = asyncio.create_task(watcher._drain_loop())  # noqa: SLF001
    try:
        watcher._enqueue_realtime(other)  # noqa: SLF001
        await asyncio.to_thread(reader.first_started.wait, 5)
        # `other` is being walked; `busy` is appended to fifty times meanwhile.
        for _ in range(50):
            watcher._enqueue_realtime(busy)  # noqa: SLF001
        # An append to the file being walked must still queue it again.
        watcher._enqueue_realtime(other)  # noqa: SLF001
        reader.release.set()
        deadline = asyncio.get_running_loop().time() + 5
        while watcher._queue.qsize() and asyncio.get_running_loop().time() < deadline:  # noqa: SLF001
            await asyncio.sleep(0.01)
        await asyncio.sleep(0.05)
        # other (first walk), busy once, other again.
        assert reader.parse_calls == 3
    finally:
        reader.release.set()
        drain.cancel()

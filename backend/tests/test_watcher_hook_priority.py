"""A Stop hook moves its transcript to the head of the realtime queue.

The realtime drain is one FIFO for every watched transcript. When it falls
behind (2026-11-03 evening: forty-odd busy files, a turn end read up to six
minutes after its Stop hook), the file someone is waiting on for a reply sat
behind every other file's walk. The Stop hook says exactly which file that is,
so it is walked next, before the background walks, and still only once.

The path comes from the hook's payload, and any local process can post one: it
is only followed when, symlinks resolved, it is a transcript under a root the
watcher already reads.
"""

from __future__ import annotations

import asyncio
import threading
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from agent_team_backend import app as app_module
from agent_team_backend import hook_auth
from agent_team_backend.app import app
from agent_team_backend.log_readers.base import ActivityEvent, LogReader
from agent_team_backend.log_readers.watcher import LogWatcher


class _OrderReader(LogReader):
    vendor = "claude"

    def __init__(self, root: Path) -> None:
        self.root = root
        self.walked: list[str] = []
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
        self.walked.append(path.name)
        if len(self.walked) == 1:
            self.first_started.set()
            self.release.wait(5)
        return []


async def _activity(_event: ActivityEvent) -> None:
    return None


async def _tokens(_usage: object) -> None:
    return None


def _files(root: Path, names: list[str]) -> list[Path]:
    out = []
    for name in names:
        p = root / name
        p.write_text("{}\n", encoding="utf-8")
        out.append(p)
    return out


def _start(root: Path) -> tuple[_OrderReader, LogWatcher, asyncio.Task]:
    reader = _OrderReader(root)
    watcher = LogWatcher(sink=_tokens, activity_sink=_activity)  # type: ignore[arg-type]
    watcher.add_reader(reader)
    watcher._loop = asyncio.get_running_loop()  # noqa: SLF001
    drain = asyncio.create_task(watcher._drain_loop())  # noqa: SLF001
    return reader, watcher, drain


async def _drain_until_empty(watcher: LogWatcher) -> None:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + 5
    while watcher._queue.qsize() and loop.time() < deadline:  # noqa: SLF001
        await asyncio.sleep(0.01)
    await asyncio.sleep(0.05)


async def _run(tmp_path: Path, hooked_already_queued: bool) -> list[str]:
    root = tmp_path / "claude"
    root.mkdir()
    blocker, hooked = _files(root, ["blocker.jsonl", "hooked.jsonl"])
    others = _files(root, [f"other{i:02d}.jsonl" for i in range(40)])
    reader, watcher, drain = _start(root)
    try:
        watcher._enqueue_realtime(blocker)  # noqa: SLF001
        await asyncio.to_thread(reader.first_started.wait, 5)
        # `blocker` is being walked; forty other files queue up behind it.
        for p in others[:20]:
            watcher._enqueue_realtime(p)  # noqa: SLF001
        if hooked_already_queued:
            watcher._enqueue_realtime(hooked)  # noqa: SLF001
        for p in others[20:]:
            watcher._enqueue_realtime(p)  # noqa: SLF001
        watcher.prioritize(hooked)
        watcher.prioritize(hooked)  # a second Stop before the walk: still one walk
        reader.release.set()
        await _drain_until_empty(watcher)
        return reader.walked
    finally:
        reader.release.set()
        drain.cancel()


@pytest.mark.asyncio
async def test_the_hooked_transcript_is_walked_before_forty_queued_files(tmp_path: Path) -> None:
    walked = await _run(tmp_path, hooked_already_queued=False)
    assert walked[:2] == ["blocker.jsonl", "hooked.jsonl"]
    assert walked.count("hooked.jsonl") == 1
    assert len(walked) == 42


@pytest.mark.asyncio
async def test_a_hooked_transcript_already_queued_jumps_ahead_and_is_walked_once(tmp_path: Path) -> None:
    walked = await _run(tmp_path, hooked_already_queued=True)
    assert walked[:2] == ["blocker.jsonl", "hooked.jsonl"]
    assert walked.count("hooked.jsonl") == 1
    assert len(walked) == 42


@pytest.mark.asyncio
async def test_an_append_after_the_priority_walk_queues_the_file_again(tmp_path: Path) -> None:
    root = tmp_path / "claude"
    root.mkdir()
    blocker, hooked, other = _files(root, ["blocker.jsonl", "hooked.jsonl", "other.jsonl"])
    reader, watcher, drain = _start(root)
    try:
        watcher._enqueue_realtime(blocker)  # noqa: SLF001
        await asyncio.to_thread(reader.first_started.wait, 5)
        watcher._enqueue_realtime(hooked)  # noqa: SLF001
        watcher._enqueue_realtime(other)  # noqa: SLF001
        watcher.prioritize(hooked)
        reader.release.set()
        await _drain_until_empty(watcher)
        watcher._enqueue_realtime(hooked)  # noqa: SLF001
        await _drain_until_empty(watcher)
        assert reader.walked == ["blocker.jsonl", "hooked.jsonl", "other.jsonl", "hooked.jsonl"]
    finally:
        reader.release.set()
        drain.cancel()


@pytest.mark.asyncio
async def test_a_path_outside_the_roots_is_never_read(tmp_path: Path) -> None:
    root = (tmp_path / "claude").resolve()
    root.mkdir()
    (blocker,) = _files(root, ["blocker.jsonl"])
    outside = tmp_path / "secret.jsonl"
    outside.write_text("{}\n", encoding="utf-8")
    escape = root / "escape.jsonl"  # inside the root by name, outside once resolved
    escape.symlink_to(outside)
    (root / "notes.txt").write_text("x\n", encoding="utf-8")
    reader, watcher, drain = _start(root)
    try:
        watcher._enqueue_realtime(blocker)  # noqa: SLF001
        await asyncio.to_thread(reader.first_started.wait, 5)
        for p in (outside, escape, root / "notes.txt", root / "missing.jsonl", root / ".." / "secret.jsonl"):
            watcher.prioritize(p)
        reader.release.set()
        await _drain_until_empty(watcher)
        assert reader.walked == ["blocker.jsonl"]
    finally:
        reader.release.set()
        drain.cancel()


@pytest.mark.asyncio
async def test_a_symlink_spelling_inside_the_roots_is_walked_once(tmp_path: Path) -> None:
    root = (tmp_path / "claude").resolve()
    root.mkdir()
    blocker, real, other = _files(root, ["blocker.jsonl", "real.jsonl", "other.jsonl"])
    alias = root / "alias.jsonl"
    alias.symlink_to(real)
    reader, watcher, drain = _start(root)
    try:
        watcher._enqueue_realtime(blocker)  # noqa: SLF001
        await asyncio.to_thread(reader.first_started.wait, 5)
        watcher._enqueue_realtime(other)  # noqa: SLF001
        watcher._enqueue_realtime(real)  # noqa: SLF001
        watcher.prioritize(alias)
        reader.release.set()
        await _drain_until_empty(watcher)
        assert reader.walked == ["blocker.jsonl", "real.jsonl", "other.jsonl"]
    finally:
        reader.release.set()
        drain.cancel()


class _Spy:
    def __init__(self) -> None:
        self.prioritized: list[Path] = []

    def prioritize(self, path: Path) -> None:
        self.prioritized.append(path)


@pytest.fixture()
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    async def fake_broadcast(_event, **_kwargs) -> None:  # noqa: ANN001
        return None

    monkeypatch.setattr(app_module, "broadcast", fake_broadcast)
    c = TestClient(app, base_url="http://127.0.0.1")
    c.headers[hook_auth.HEADER] = hook_auth.token()
    return c


def test_a_stop_hook_prioritizes_its_transcript(client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    spy = _Spy()
    monkeypatch.setattr(app_module, "_log_watcher", spy)
    transcript = tmp_path / "s.jsonl"
    r = client.post(
        "/hooks/claude",
        json={"session_id": "s-unclaimed", "transcript_path": str(transcript)},
        headers={"X-Agent-Team-Event": "stop"},
    )
    assert r.status_code == 200
    assert spy.prioritized == [transcript]


def test_other_hooks_and_a_missing_path_prioritize_nothing(client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    spy = _Spy()
    monkeypatch.setattr(app_module, "_log_watcher", spy)
    client.post(
        "/hooks/claude",
        json={"session_id": "s-unclaimed", "transcript_path": str(tmp_path / "s.jsonl")},
        headers={"X-Agent-Team-Event": "pre_tool_use"},
    )
    client.post("/hooks/claude", json={"session_id": "s-unclaimed"}, headers={"X-Agent-Team-Event": "stop"})
    client.post(
        "/hooks/claude",
        json={"session_id": "s-unclaimed", "transcript_path": 7},
        headers={"X-Agent-Team-Event": "stop"},
    )
    assert spy.prioritized == []

"""LogWatcher: seen_keys persistence between backend restarts.

This is the fix for the "Global keeps jumping after restart" bug. Without
persistence, every restart re-emits all events from every existing log file
because seen_keys starts empty.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from agent_team_backend.log_readers.base import (
    ActivityEvent,
    IncrementalParseResult,
    LogReader,
    TokenSinkResult,
    TokenUsage,
)
from agent_team_backend.log_readers.watcher import LogWatcher
from agent_team_backend.tokens_store import TokensStore


class _StaticReader(LogReader):
    """Deterministic stub: returns the same events every parse, but uses
    seen_keys to dedup (so behaviour matches real readers)."""

    def __init__(self, root: Path) -> None:
        self.vendor = "claude"

        # Mirror the real reader's capability hooks so flag-gated watcher
        # paths behave as in production for this vendor.
        from agent_team_backend.cli_vendors.registry import vendor as _v
        _spec = _v(self.vendor)
        if _spec is not None and _spec.make_log_reader is not None:
            _real = _spec.make_log_reader()
            self.emits_session_sink = _real.emits_session_sink
            self.binds_by_marker_file = _real.binds_by_marker_file
            self.workspace_match = _real.workspace_match
            self.pane_cwd_match = _real.pane_cwd_match
        self.root = root
        self.call_count = 0

    def project_dirs(self) -> list[Path]:
        return [self.root] if self.root.is_dir() else []

    def session_files(self) -> list[Path]:
        if not self.root.is_dir():
            return []
        return list(self.root.rglob("*.jsonl"))

    def parse_session_file(self, path: Path, seen_keys: set[str]) -> list[TokenUsage]:
        self.call_count += 1
        # One canonical event per file.
        key = f"event-for-{path.name}"
        if key in seen_keys:
            return []
        seen_keys.add(key)
        return [
            TokenUsage(
                vendor="claude",
                input_tokens=10,
                output_tokens=5,
                cwd="/x",
                session_id=path.stem,
                file_path=str(path),
                dedup_key=key,
            )
        ]


class _SharedReader(_StaticReader):
    """One source file containing events for two different workspaces."""

    def parse_incremental(self, path: Path, checkpoint: dict) -> IncrementalParseResult:
        if checkpoint:
            return IncrementalParseResult([], checkpoint)
        events = [
            TokenUsage(
                vendor="grok", input_tokens=10, output_tokens=1, cwd="/ws/other",
                session_id="s1", file_path=str(path), dedup_key="usage:1",
                checkpoint={"kind": "sqlite", "row_id": 1, "identity": "1:1"},
            ),
            TokenUsage(
                vendor="grok", input_tokens=20, output_tokens=2, cwd="/ws/target",
                session_id="s2", file_path=str(path), dedup_key="usage:2",
                checkpoint={"kind": "sqlite", "row_id": 2, "identity": "1:1"},
            ),
        ]
        return IncrementalParseResult(
            events, {"kind": "sqlite", "row_id": 2, "identity": "1:1"}
        )


async def _drain_briefly(watcher: LogWatcher, ms: int = 1500) -> None:
    """Let the watcher's drain loop + save loop process whatever is queued.

    Must exceed (initial 0.5s rescan delay + save_interval_s) so the first
    scan completes AND a save flush happens before stop(). Bumped to 1500ms
    so the test isn't flaky when the full suite competes for CPU.
    """
    await asyncio.sleep(ms / 1000)


def _checkpoint_store(tmp_path: Path) -> TokensStore:
    return TokensStore(
        global_path=tmp_path / "tokens.json",
        workspace_base_dir=tmp_path / "workspaces",
        ingestion_state_path=tmp_path / "token-ingestion-state.json",
    )


def _watcher(store: TokensStore, sink, **kwargs) -> LogWatcher:
    return LogWatcher(
        sink=sink,
        checkpoint_provider=store.get_ingestion_checkpoint,
        checkpoint_sink=store.advance_ingestion_checkpoint,
        **kwargs,
    )


@pytest.mark.asyncio
async def test_seen_keys_persist_between_watcher_starts(tmp_path: Path) -> None:
    root = tmp_path / "logs"
    root.mkdir()
    f1 = root / "a.jsonl"; f1.write_text("")

    received: list[TokenUsage] = []

    async def sink(u: TokenUsage) -> TokenSinkResult:
        received.append(u)
        return TokenSinkResult(True, "/x")

    # ── First watcher run: should emit 1 event ────────────────────────────
    reader1 = _StaticReader(root)
    store1 = _checkpoint_store(tmp_path)
    w1 = _watcher(store1, sink, rescan_interval_s=0.1)
    w1.add_reader(reader1)
    w1.start()
    await _drain_briefly(w1, 1500)
    w1.stop()
    store1.flush()
    assert len(received) == 1, f"expected 1 event from initial backfill, got {len(received)}"

    # The unified checkpoint (with the reader's seen-keys window) must have
    # been persisted — a fresh store reads it back.
    probe = _checkpoint_store(tmp_path)
    assert any(
        "event-for-a.jsonl" in (entry.get("global") or {}).get("legacy_seen", [])
        for entry in probe._files.values()
    ), "TokensStore should persist the unified checkpoint"
    probe.flush()

    # ── Second watcher run with same files: should emit 0 events ──────────
    received.clear()
    reader2 = _StaticReader(root)
    store2 = _checkpoint_store(tmp_path)
    w2 = _watcher(store2, sink, rescan_interval_s=0.1)
    w2.add_reader(reader2)
    w2.start()
    await _drain_briefly(w2, 1500)
    w2.stop()
    store2.flush()
    assert received == [], (
        f"after restart, watcher must NOT re-emit historic events. "
        f"got {len(received)} (this is the 'Global keeps jumping' bug)"
    )


@pytest.mark.asyncio
async def test_new_file_after_restart_still_fires(tmp_path: Path) -> None:
    root = tmp_path / "logs"
    root.mkdir()
    (root / "a.jsonl").write_text("")

    received: list[TokenUsage] = []

    async def sink(u: TokenUsage) -> TokenSinkResult:
        received.append(u)
        return TokenSinkResult(True, "/x")

    # Run 1: process the existing file
    store1 = _checkpoint_store(tmp_path)
    w1 = _watcher(store1, sink, rescan_interval_s=0.1)
    w1.add_reader(_StaticReader(root))
    w1.start(); await _drain_briefly(w1, 1500); w1.stop(); store1.flush()
    assert len(received) == 1

    # Run 2: new file appears between runs
    (root / "b.jsonl").write_text("")
    received.clear()
    store2 = _checkpoint_store(tmp_path)
    w2 = _watcher(store2, sink, rescan_interval_s=0.1)
    w2.add_reader(_StaticReader(root))
    w2.start(); await _drain_briefly(w2, 1500); w2.stop(); store2.flush()
    # Old file: no re-emit. New file: 1 event.
    assert len(received) == 1
    assert received[0].file_path.endswith("b.jsonl")


@pytest.mark.asyncio
async def test_corrupt_seen_file_starts_empty(tmp_path: Path) -> None:
    """Garbage in seen.json shouldn't crash startup."""
    root = tmp_path / "logs"; root.mkdir()
    (root / "x.jsonl").write_text("")
    state_path = tmp_path / "token-ingestion-state.json"
    state_path.write_text("{ not json", encoding="utf-8")

    received: list[TokenUsage] = []
    async def sink(u: TokenUsage) -> TokenSinkResult:
        received.append(u)
        return TokenSinkResult(True, "/x")

    store = _checkpoint_store(tmp_path)
    w = _watcher(store, sink, rescan_interval_s=0.1)
    w.add_reader(_StaticReader(root))
    w.start(); await _drain_briefly(w, 1500); w.stop()
    # Fallback: start empty → emit once.
    assert len(received) == 1


@pytest.mark.asyncio
async def test_workspace_replay_continues_past_foreign_shared_source_rows(
    tmp_path: Path,
) -> None:
    root = tmp_path / "logs"
    root.mkdir()
    source = root / "grok.db"
    source.write_text("")
    handled: list[str] = []

    async def sink(usage: TokenUsage) -> TokenSinkResult:
        handled.append(usage.cwd)
        if usage.cwd != usage.replay_workspace:
            return TokenSinkResult(True)  # safely skipped for this replay scope
        return TokenSinkResult(True, usage.replay_workspace)

    watcher = LogWatcher(sink=sink)
    watcher.add_reader(_SharedReader(root))
    await watcher._process_path(source, "/ws/target")

    assert handled == ["/ws/other", "/ws/target"]
    checkpoint = watcher._local_checkpoint(str(source.resolve()), "/ws/target")
    assert checkpoint["row_id"] == 2


@pytest.mark.asyncio
async def test_only_tokens_wait_for_ingestion_interval(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "logs"
    root.mkdir()
    source = root / "a.jsonl"
    source.write_text("")

    class _Observer:
        def schedule(self, *args, **kwargs) -> None:
            pass

        def start(self) -> None:
            pass

        def stop(self) -> None:
            pass

        def join(self, timeout: float) -> None:
            pass

    monkeypatch.setattr("agent_team_backend.log_readers.watcher.Observer", _Observer)

    token_events: list[str] = []
    activity_events: list[str] = []
    session_events: list[str] = []
    checkpoints: list[tuple[str | None, int]] = []
    checkpoint_state: dict[str, dict] = {}

    async def sink(usage: TokenUsage) -> TokenSinkResult:
        token_events.append(usage.dedup_key)
        return TokenSinkResult(True, "/x")

    async def activity_sink(event: ActivityEvent) -> None:
        activity_events.append(event.dedup_key)

    async def session_sink(_vendor: str, path: Path) -> None:
        session_events.append(str(path))

    class _LiveReader(_StaticReader):
        def __init__(self, root: Path) -> None:
            super().__init__(root)
            self.vendor = "codex"

            # Mirror the real reader's capability hooks so flag-gated watcher
            # paths behave as in production for this vendor.
            from agent_team_backend.cli_vendors.registry import vendor as _v
            _spec = _v(self.vendor)
            if _spec is not None and _spec.make_log_reader is not None:
                _real = _spec.make_log_reader()
                self.emits_session_sink = _real.emits_session_sink
                self.binds_by_marker_file = _real.binds_by_marker_file
                self.workspace_match = _real.workspace_match
                self.pane_cwd_match = _real.pane_cwd_match

        def parse_incremental(
            self, path: Path, checkpoint: dict
        ) -> IncrementalParseResult:
            self.call_count += 1
            offset = int(checkpoint.get("offset") or 0) + 1
            event = TokenUsage(
                vendor="codex", input_tokens=10, output_tokens=1, cwd="/x",
                session_id="s1", file_path=str(path), dedup_key=f"event-{offset}",
                checkpoint={"kind": "jsonl", "offset": offset, "identity": "1:1"},
            )
            return IncrementalParseResult([event], event.checkpoint)

        def parse_activity(
            self, path: Path, seen_keys: set[str]
        ) -> list[ActivityEvent]:
            key = f"activity-{self.call_count}"
            return [ActivityEvent(
                vendor="codex", event_type="agent_active", cwd="/x",
                session_id="s1", file_path=str(path), dedup_key=key,
            )]

    def checkpoint_sink(_path: str, checkpoint: dict, workspace: str | None) -> None:
        checkpoint_state[workspace or ""] = dict(checkpoint)
        checkpoints.append((workspace, int(checkpoint["offset"])))

    def checkpoint_provider(_path: str, workspace: str | None) -> dict:
        return dict(checkpoint_state.get(workspace or "", {}))

    reader = _LiveReader(root)
    watcher = LogWatcher(
        sink=sink,
        activity_sink=activity_sink,
        session_sink=session_sink,
        rescan_interval_s=60,
        token_interval_s=60,
        checkpoint_provider=checkpoint_provider,
        checkpoint_sink=checkpoint_sink,
    )
    watcher.add_reader(reader)
    watcher.start()
    try:
        for _ in range(500):
            if token_events == ["event-1"]:
                break
            await asyncio.sleep(0.002)
        assert token_events == ["event-1"]  # startup token catch-up is immediate

        assert watcher._handler is not None
        watcher._handler._on_path(source)
        # Two appends in a row are one walk (_enqueue_realtime coalesces a
        # file already queued): the second comes after the first was walked.
        for _ in range(500):
            if len(session_events) == 2 and len(activity_events) == 2:
                break
            await asyncio.sleep(0.002)
        watcher._handler._on_path(source)
        for _ in range(500):
            if len(session_events) == 3 and len(activity_events) == 3:
                break
            await asyncio.sleep(0.002)
        assert reader.call_count == 1
        assert len(session_events) == 3
        assert len(activity_events) == 3
        assert token_events == ["event-1"]
        assert checkpoints == [(None, 1), ("/x", 1)]

        await watcher._flush_pending_tokens()
        assert token_events == ["event-1", "event-2"]
        assert checkpoints == [
            (None, 1), ("/x", 1),
            (None, 2), ("/x", 2),
        ]
    finally:
        watcher.stop()


@pytest.mark.asyncio
async def test_shutdown_before_token_window_replays_on_next_start(
    tmp_path: Path,
) -> None:
    root = tmp_path / "logs"
    root.mkdir()
    first = root / "a.jsonl"
    first.write_text("")
    received: list[str] = []

    async def sink(usage: TokenUsage) -> TokenSinkResult:
        received.append(Path(usage.file_path).name)
        return TokenSinkResult(True, "/x")

    store1 = _checkpoint_store(tmp_path)
    watcher1 = _watcher(
        store1, sink, rescan_interval_s=60, token_interval_s=60
    )
    watcher1.add_reader(_StaticReader(root))
    watcher1.start()
    for _ in range(500):
        if received == ["a.jsonl"]:
            break
        await asyncio.sleep(0.002)
    assert received == ["a.jsonl"]

    second = root / "b.jsonl"
    second.write_text("")
    await watcher1._queue.put((second, ""))
    for _ in range(500):
        if (str(second.resolve()), "") in watcher1._pending_token_paths:
            break
        await asyncio.sleep(0.002)
    assert received == ["a.jsonl"]
    watcher1.stop()
    store1.flush()

    store2 = _checkpoint_store(tmp_path)
    watcher2 = _watcher(
        store2, sink, rescan_interval_s=60, token_interval_s=60
    )
    watcher2.add_reader(_StaticReader(root))
    watcher2.start()
    try:
        for _ in range(500):
            if received == ["a.jsonl", "b.jsonl"]:
                break
            await asyncio.sleep(0.002)
        assert received == ["a.jsonl", "b.jsonl"]
    finally:
        watcher2.stop()
        store2.flush()

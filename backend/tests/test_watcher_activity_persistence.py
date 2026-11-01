"""LogWatcher: activity dedup survives a restart, and old files never replay.

Before this, `_activity_seen` was in-memory only, so `activity_high_water`
returned 0 on every process start and each reader re-parsed its transcript from
line 1 — broadcasting one `agent.activity` per historical entry. A cold start
measured ~148,000 of them in 60 seconds (GitHub #28).

Two mechanisms are pinned here, and they cover different starts:

  * the durable checkpoint (scope "@activity") makes the *second* and later
    starts free — the mark is restored, so nothing replays;
  * seeding a first-sight file to EOF makes the *first* start free too (fresh
    install, first start after upgrade), by counting lines instead of parsing
    them.

Seeding is gated on the file's mtime predating this process. Without that gate
a session file a live pane created seconds ago would be skipped to EOF on first
sight and its first round of activity lost for good. The gate has a known,
accepted cost at the other end: a turn written in the last moments before a
crash has an mtime older than the restarted process, so its activity — MSG
blocks included — is seeded past rather than delivered. That trade is
deliberate (see the plan's Risks); `test_file_touched_after_process_start_is_
parsed_not_seeded` is what stops it widening to live panes.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent_team_backend.cli_vendors.registry import VENDORS
from agent_team_backend.log_readers import base
from agent_team_backend.log_readers import watcher as watcher_module
from agent_team_backend.log_readers.base import (
    ActivityEvent,
    LogReader,
    activity_high_water,
    set_activity_high_water,
)
from agent_team_backend.log_readers.watcher import LogWatcher
from agent_team_backend.tokens_store import TokensStore

# The eight readers whose parse_activity walks a dense ascending line counter
# and resumes from one high-water sentinel. Only these can be seeded by
# counting lines; the rest key their dedup bag on db row ids or per-session
# sequence numbers, where a line number means nothing.
_LINE_HIGH_WATER_VENDORS = {
    "aider", "claude", "codex", "droid", "kimi", "muse", "pi", "qwen",
}


class _LineReader(LogReader):
    """Stub with the real line-high-water contract of the eight vendors."""

    vendor = "claude"
    activity_resumes_by_line = True

    def __init__(self, root: Path) -> None:
        self.root = root
        self.parse_calls = 0

    def project_dirs(self) -> list[Path]:
        return [self.root]

    def session_files(self) -> list[Path]:
        return sorted(self.root.rglob("*.jsonl"))

    def parse_session_file(self, path: Path, seen_keys: set[str]) -> list:
        return []

    def claims_path(self, path: Path) -> bool:
        return str(path).startswith(str(self.root))

    def parse_activity(self, path: Path, seen_keys: set[str]) -> list[ActivityEvent]:
        self.parse_calls += 1
        out: list[ActivityEvent] = []
        high_water = activity_high_water(seen_keys)
        last_line = high_water
        with path.open(encoding="utf-8") as fh:
            for line_no, raw_line in enumerate(fh, 1):
                raw = raw_line.strip()
                if not raw:
                    continue
                if line_no <= high_water:
                    continue
                if not raw_line.endswith("\n"):
                    break
                last_line = line_no
                rec = json.loads(raw)
                out.append(ActivityEvent(
                    vendor=self.vendor,
                    event_type="agent_active",
                    cwd="/ws",
                    session_id=path.stem,
                    file_path=str(path),
                    dedup_key=f"act:{line_no}",
                    timestamp=str(rec.get("timestamp") or ""),
                ))
        set_activity_high_water(seen_keys, last_line)
        return out


def _transcript(root: Path, name: str, lines: int) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    path = root / name
    path.write_text(
        "".join(
            json.dumps({"type": "assistant", "timestamp": f"t{i}"}) + "\n"
            for i in range(1, lines + 1)
        ),
        encoding="utf-8",
    )
    return path


def _store(tmp_path: Path) -> TokensStore:
    return TokensStore(
        global_path=tmp_path / "tokens.json",
        workspace_base_dir=tmp_path / "workspaces",
        ingestion_state_path=tmp_path / "token-ingestion-state.json",
    )


def _watcher(store: TokensStore, sink) -> LogWatcher:
    async def _tokens(_usage: object) -> None:
        return None

    return LogWatcher(
        sink=_tokens,  # type: ignore[arg-type]
        activity_sink=sink,
        checkpoint_provider=store.get_ingestion_checkpoint,
        checkpoint_sink=store.advance_ingestion_checkpoint,
    )


@pytest.mark.asyncio
async def test_restart_replays_no_historic_activity(tmp_path: Path) -> None:
    """Two watcher cycles, memory discarded but the checkpoint store kept: the
    second must broadcast nothing. This is the #28 regression."""
    root = tmp_path / "logs"
    path = _transcript(root, "a.jsonl", 12)
    store = _store(tmp_path)

    first: list[str] = []

    async def sink_a(event: ActivityEvent) -> None:
        first.append(event.dedup_key)

    # First cycle: the file is newer than this process, so it is parsed in full.
    watcher_a = _watcher(store, sink_a)
    watcher_a.add_reader(_LineReader(root))
    await watcher_a._process_realtime_path(path)
    assert len(first) == 12

    second: list[str] = []

    async def sink_b(event: ActivityEvent) -> None:
        second.append(event.dedup_key)

    # Second cycle: a brand-new watcher (empty _activity_seen), same store.
    watcher_b = _watcher(store, sink_b)
    watcher_b.add_reader(_LineReader(root))
    await watcher_b._process_realtime_path(path)

    assert second == [], "a restart replayed historic activity"


@pytest.mark.asyncio
async def test_first_sight_pre_start_file_is_seeded_without_parsing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Fresh install / first start after upgrade: no checkpoint exists yet, so
    the mark is pushed to EOF by counting lines — no events, no parse."""
    root = tmp_path / "logs"
    path = _transcript(root, "a.jsonl", 40)
    monkeypatch.setattr(
        base, "PROCESS_START_S", path.stat().st_mtime + base.SEED_TAIL_GRACE_S + 60
    )

    seen: list[str] = []

    async def sink(event: ActivityEvent) -> None:
        seen.append(event.dedup_key)

    store = _store(tmp_path)
    watcher = _watcher(store, sink)
    watcher.add_reader(_LineReader(root))
    await watcher._process_realtime_path(path)

    assert seen == [], "an old transcript replayed on first sight"
    assert activity_high_water(watcher._activity_seen[str(path.resolve())]) == 40
    # And it is durable: the next process must not seed (or replay) again.
    checkpoint = store.get_ingestion_checkpoint(str(path.resolve()), "@activity")
    assert checkpoint.get("kind") == "activity"
    assert "act_hw::40" in checkpoint.get("keys", [])


@pytest.mark.asyncio
async def test_file_touched_after_process_start_is_parsed_not_seeded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The mtime gate. A live pane's session file is younger than the backend
    process, and its first round of activity must still be delivered — seeding
    it would drop those events permanently, with no second chance."""
    root = tmp_path / "logs"
    path = _transcript(root, "live.jsonl", 5)
    monkeypatch.setattr(base, "PROCESS_START_S", path.stat().st_mtime - 60)

    seen: list[str] = []

    async def sink(event: ActivityEvent) -> None:
        seen.append(event.dedup_key)

    store = _store(tmp_path)
    watcher = _watcher(store, sink)
    watcher.add_reader(_LineReader(root))
    await watcher._process_realtime_path(path)

    assert seen == [f"act:{i}" for i in range(1, 6)]


def test_identical_activity_cursor_does_not_mark_the_store_dirty(
    tmp_path: Path,
) -> None:
    """The store's own guard. _checkpoint_is_newer has no ordering to apply to
    an activity cursor, so without a branch for it the comparison falls through
    to `return True` and every advance rewrites the row — for activity that is
    one write per transcript per rescan, forever."""
    store = _store(tmp_path)
    key = "/logs/a.jsonl"
    store.advance_ingestion_checkpoint(key, {"kind": "activity", "keys": ["act_hw::12"]}, "@activity")
    store._dirty_checkpoints.clear()

    store.advance_ingestion_checkpoint(key, {"kind": "activity", "keys": ["act_hw::12"]}, "@activity")
    assert (key, "@activity") not in store._dirty_checkpoints

    # A cursor that actually moved must still get through.
    store.advance_ingestion_checkpoint(key, {"kind": "activity", "keys": ["act_hw::13"]}, "@activity")
    assert (key, "@activity") in store._dirty_checkpoints


@pytest.mark.asyncio
async def test_unchanged_reparse_does_not_reach_the_checkpoint_sink(
    tmp_path: Path,
) -> None:
    """The watcher's own filter, in front of the store's.

    Asserted on sink calls rather than on the store's dirty set, because the
    store would reject an identical cursor anyway — that guard would mask this
    one. What this pins is that a rescan finding nothing new does not serialize
    a bag per transcript and hand it over just to have it thrown away.
    """
    root = tmp_path / "logs"
    path = _transcript(root, "a.jsonl", 3)
    store = _store(tmp_path)
    writes: list[tuple[str, str | None]] = []

    def counting_sink(file_path: str, checkpoint: dict, scope: str | None) -> None:
        writes.append((file_path, scope))
        store.advance_ingestion_checkpoint(file_path, checkpoint, scope)

    async def _tokens(_usage: object) -> None:
        return None

    async def sink(_event: ActivityEvent) -> None:
        return None

    watcher = LogWatcher(
        sink=_tokens,  # type: ignore[arg-type]
        activity_sink=sink,
        checkpoint_provider=store.get_ingestion_checkpoint,
        checkpoint_sink=counting_sink,
    )
    watcher.add_reader(_LineReader(root))
    await watcher._process_realtime_path(path)
    assert writes == [(str(path.resolve()), "@activity")]

    # Same file, same content, dedup bag restored from the store.
    watcher._activity_seen.clear()
    await watcher._process_realtime_path(path)

    assert len(writes) == 1


@pytest.mark.asyncio
async def test_appended_lines_after_a_seed_still_fire(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Seeding is a starting point, not a mute: the next append is delivered."""
    root = tmp_path / "logs"
    path = _transcript(root, "a.jsonl", 6)
    monkeypatch.setattr(
        base, "PROCESS_START_S", path.stat().st_mtime + base.SEED_TAIL_GRACE_S + 60
    )

    seen: list[str] = []

    async def sink(event: ActivityEvent) -> None:
        seen.append(event.dedup_key)

    store = _store(tmp_path)
    watcher = _watcher(store, sink)
    watcher.add_reader(_LineReader(root))
    await watcher._process_realtime_path(path)
    assert seen == []

    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps({"type": "assistant", "timestamp": "t7"}) + "\n")
    await watcher._process_realtime_path(path)

    assert seen == ["act:7"]


@pytest.mark.asyncio
async def test_partial_final_line_is_not_seeded_past(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A line still being written must stay unread, exactly as parse_activity
    leaves it — otherwise the seeder loses the turn's end record (GitHub #21)."""
    root = tmp_path / "logs"
    path = _transcript(root, "a.jsonl", 3)
    with path.open("a", encoding="utf-8") as fh:
        fh.write('{"type": "assist')
    monkeypatch.setattr(
        base, "PROCESS_START_S", path.stat().st_mtime + base.SEED_TAIL_GRACE_S + 60
    )

    seen: list[str] = []

    async def sink(event: ActivityEvent) -> None:
        seen.append(event.dedup_key)

    store = _store(tmp_path)
    watcher = _watcher(store, sink)
    watcher.add_reader(_LineReader(root))
    await watcher._process_realtime_path(path)

    assert activity_high_water(watcher._activity_seen[str(path.resolve())]) == 3

    # Completing the line delivers it.
    with path.open("a", encoding="utf-8") as fh:
        fh.write('ant", "timestamp": "t4"}\n')
    await watcher._process_realtime_path(path)
    assert seen == ["act:4"]


@pytest.mark.asyncio
async def test_oversized_dedup_bag_is_not_persisted(tmp_path: Path) -> None:
    """The bag is stored whole, so it is only stored while it stays small. A
    reader that leaves per-item keys falls back to the old in-memory-only
    behaviour instead of writing an unbounded blob per transcript."""
    root = tmp_path / "logs"
    path = _transcript(root, "a.jsonl", 3)

    class _NoisyReader(_LineReader):
        def parse_activity(self, path: Path, seen_keys: set[str]) -> list:
            seen_keys.update(f"act:{i}" for i in range(50))
            return []

    async def sink(_event: ActivityEvent) -> None:
        return None

    store = _store(tmp_path)
    watcher = _watcher(store, sink)
    watcher.add_reader(_NoisyReader(root))
    await watcher._process_realtime_path(path)

    assert store.get_ingestion_checkpoint(str(path.resolve()), "@activity") == {}


def test_line_high_water_vendors_declare_the_seeding_hook() -> None:
    """Pin which readers may be seeded. A vendor keyed on row ids or sequence
    numbers that flipped this flag on would have its dedup bag filled with a
    line number it never consults — replaying its whole history anyway."""
    flags = {}
    for key, spec in VENDORS.items():
        if spec.make_log_reader is None:
            continue
        flags[key] = bool(spec.make_log_reader().activity_resumes_by_line)

    assert {k for k, v in flags.items() if v} == _LINE_HIGH_WATER_VENDORS & set(flags)
    assert _LINE_HIGH_WATER_VENDORS <= set(flags)


def _big_transcript(root: Path, name: str, lines: int, pad: int = 4096) -> Path:
    """A transcript whose lines are wide enough that SEED_TAIL_BYTES lands
    mid-file, so the tail boundary is exercised rather than swallowing it."""
    root.mkdir(parents=True, exist_ok=True)
    path = root / name
    path.write_text(
        "".join(
            json.dumps({"type": "assistant", "timestamp": f"t{i}", "pad": "x" * pad})
            + "\n"
            for i in range(1, lines + 1)
        ),
        encoding="utf-8",
    )
    return path


@pytest.mark.asyncio
async def test_a_recently_written_file_replays_only_its_tail(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Phase 2D. A busy transcript used to be refused a mark entirely — the
    mtime gate protected its unread turns by leaving the reader to walk it from
    line 1, so the largest, busiest files were the ones that still replayed in
    full. Now the mark stops SEED_TAIL_BYTES from the end: recent turns are
    still delivered, everything older is skipped, and the work is bounded.
    """
    root = tmp_path / "logs"
    path = _big_transcript(root, "busy.jsonl", 200)
    # Written a moment before the process started: inside the grace window.
    monkeypatch.setattr(base, "PROCESS_START_S", path.stat().st_mtime + 5)

    seen: list[str] = []

    async def sink(event: ActivityEvent) -> None:
        seen.append(event.dedup_key)

    store = _store(tmp_path)
    watcher = _watcher(store, sink)
    watcher.add_reader(_LineReader(root))
    await watcher._process_realtime_path(path)

    assert seen, "the tail must still be delivered"
    assert len(seen) < 200, "the whole file replayed — the tail bound did nothing"
    # The tail is expressed in bytes, so the line count it covers is
    # SEED_TAIL_BYTES / average line width, give or take the boundary line.
    avg_line = path.stat().st_size / 200
    expected = base.SEED_TAIL_BYTES / avg_line
    assert len(seen) <= expected + 2, (
        f"{len(seen)} lines parsed; the {base.SEED_TAIL_BYTES}-byte tail covers "
        f"about {expected:.0f}"
    )
    # Every delivered line is from the END of the file, not the start.
    assert seen[-1] == "act:200"
    assert "act:1" not in seen


@pytest.mark.asyncio
async def test_a_file_older_than_the_grace_window_replays_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The other side of the same branch: history stays free. Without this the
    tail rule would broadcast the last turns of every transcript on the disk."""
    root = tmp_path / "logs"
    path = _big_transcript(root, "history.jsonl", 200)
    monkeypatch.setattr(
        base, "PROCESS_START_S", path.stat().st_mtime + base.SEED_TAIL_GRACE_S + 60
    )

    seen: list[str] = []

    async def sink(event: ActivityEvent) -> None:
        seen.append(event.dedup_key)

    store = _store(tmp_path)
    watcher = _watcher(store, sink)
    watcher.add_reader(_LineReader(root))
    await watcher._process_realtime_path(path)

    assert seen == [], "an out-of-grace transcript delivered its tail"
    assert activity_high_water(watcher._activity_seen[str(path.resolve())]) == 200


@pytest.mark.asyncio
async def test_the_turn_written_just_before_a_crash_is_not_lost(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The trade the old gate accepted, now closed.

    A turn lands in the transcript, the backend dies before its cursor is
    persisted, and the restart sees a file whose mtime predates the new
    process. Under the old rule that file was marked to EOF and the turn — with
    its MSG block — was gone for good. Inside the grace window its tail is read.
    """
    root = tmp_path / "logs"
    path = _transcript(root, "crashed.jsonl", 3)
    # Died seconds ago; restarted now.
    monkeypatch.setattr(base, "PROCESS_START_S", path.stat().st_mtime + 10)

    seen: list[str] = []

    async def sink(event: ActivityEvent) -> None:
        seen.append(event.dedup_key)

    store = _store(tmp_path)
    watcher = _watcher(store, sink)
    watcher.add_reader(_LineReader(root))
    await watcher._process_realtime_path(path)

    assert seen == ["act:1", "act:2", "act:3"], "the pre-crash turn was skipped"


# A session id can come back as a NEW file at the same path: the transcript of
# an old session is gone, the resume preflight misses, and the pane starts fresh
# under the same id. The durable mark then counts the OLD file's lines, so every
# line of the new one reads as already seen and the pane's turn ends never reach
# the window or its chat.


def _append(path: Path, first: int, lines: int) -> None:
    with path.open("a", encoding="utf-8") as fh:
        for i in range(first, first + lines):
            fh.write(json.dumps({"type": "assistant", "timestamp": f"t{i}"}) + "\n")


def _stale_checkpoint(store: TokensStore, path: Path, mark: int) -> None:
    store.advance_ingestion_checkpoint(
        str(path.resolve()), {"kind": "activity", "keys": [f"act_hw::{mark}"]}, "@activity"
    )


@pytest.mark.asyncio
async def test_replaced_file_with_a_stale_durable_mark_delivers_new_lines(
    tmp_path: Path,
) -> None:
    """The file already holds 5 lines the old mark (6864) would hide. Those are
    history and stay undelivered; what is appended from here on arrives."""
    root = tmp_path / "logs"
    path = _transcript(root, "reused.jsonl", 5)
    store = _store(tmp_path)
    _stale_checkpoint(store, path, 6864)

    seen: list[str] = []

    async def sink(event: ActivityEvent) -> None:
        seen.append(event.dedup_key)

    watcher = _watcher(store, sink)
    watcher.add_reader(_LineReader(root))
    await watcher._process_realtime_path(path)
    assert seen == [], "a replaced file replayed its turns to the pane and its chat"

    _append(path, 6, 2)
    await watcher._process_realtime_path(path)
    assert seen == ["act:6", "act:7"], "the replaced file stayed muted"

    # Durable too: the next process neither replays nor re-mutes the file.
    assert "act_hw::7" in store.get_ingestion_checkpoint(
        str(path.resolve()), "@activity"
    ).get("keys", [])
    restarted: list[str] = []

    async def sink_b(event: ActivityEvent) -> None:
        restarted.append(event.dedup_key)

    watcher_b = _watcher(store, sink_b)
    watcher_b.add_reader(_LineReader(root))
    await watcher_b._process_realtime_path(path)
    assert restarted == []


@pytest.mark.asyncio
async def test_rewrite_under_a_running_watcher_is_not_replayed(tmp_path: Path) -> None:
    """The same with the mark still in memory: a shorter file at the same path."""
    root = tmp_path / "logs"
    path = _transcript(root, "rewritten.jsonl", 12)
    store = _store(tmp_path)

    seen: list[str] = []

    async def sink(event: ActivityEvent) -> None:
        seen.append(event.dedup_key)

    watcher = _watcher(store, sink)
    watcher.add_reader(_LineReader(root))
    await watcher._process_realtime_path(path)
    assert len(seen) == 12
    seen.clear()

    _transcript(root, "rewritten.jsonl", 3)
    await watcher._process_realtime_path(path)
    assert seen == []

    _append(path, 4, 1)
    await watcher._process_realtime_path(path)
    assert seen == ["act:4"]


@pytest.mark.asyncio
async def test_mark_equal_to_the_line_count_and_plain_growth_change_nothing(
    tmp_path: Path,
) -> None:
    """A mark at exactly the last line is the normal resting state, not a
    replaced file: it stays, and the next line is delivered once."""
    root = tmp_path / "logs"
    path = _transcript(root, "steady.jsonl", 4)
    store = _store(tmp_path)
    _stale_checkpoint(store, path, 4)

    seen: list[str] = []

    async def sink(event: ActivityEvent) -> None:
        seen.append(event.dedup_key)

    watcher = _watcher(store, sink)
    watcher.add_reader(_LineReader(root))
    await watcher._process_realtime_path(path)
    assert seen == []
    assert activity_high_water(watcher._activity_seen[str(path.resolve())]) == 4

    _append(path, 5, 1)
    await watcher._process_realtime_path(path)
    assert seen == ["act:5"]


@pytest.mark.asyncio
async def test_a_half_written_last_line_does_not_read_as_a_replaced_file(
    tmp_path: Path,
) -> None:
    root = tmp_path / "logs"
    path = _transcript(root, "partial.jsonl", 2)
    with path.open("a", encoding="utf-8") as fh:
        fh.write('{"type": "assist')
    store = _store(tmp_path)
    _stale_checkpoint(store, path, 2)

    seen: list[str] = []

    async def sink(event: ActivityEvent) -> None:
        seen.append(event.dedup_key)

    watcher = _watcher(store, sink)
    watcher.add_reader(_LineReader(root))
    await watcher._process_realtime_path(path)
    assert seen == []
    assert activity_high_water(watcher._activity_seen[str(path.resolve())]) == 2


@pytest.mark.asyncio
async def test_appends_never_recount_the_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Counting lines is once per file per process, plus once if it shrinks: a
    long transcript must not pay a whole-file walk on every append."""
    root = tmp_path / "logs"
    path = _transcript(root, "long.jsonl", 3)
    store = _store(tmp_path)
    _stale_checkpoint(store, path, 3)

    calls: list[Path] = []
    real = watcher_module.rewind_past_eof_mark

    def counting(p: Path, seen_keys: set[str]) -> bool:
        calls.append(p)
        return real(p, seen_keys)

    monkeypatch.setattr(watcher_module, "rewind_past_eof_mark", counting)

    async def sink(event: ActivityEvent) -> None:
        pass

    watcher = _watcher(store, sink)
    watcher.add_reader(_LineReader(root))
    await watcher._process_realtime_path(path)
    for i in range(4, 24):
        _append(path, i, 1)
        await watcher._process_realtime_path(path)
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_a_reader_not_keyed_on_lines_keeps_its_mark(tmp_path: Path) -> None:
    """copilot's and grok's sentinels are not line numbers: never compared."""
    root = tmp_path / "logs"
    path = _transcript(root, "rows.jsonl", 2)
    store = _store(tmp_path)
    _stale_checkpoint(store, path, 900)

    class _RowReader(_LineReader):
        activity_resumes_by_line = False

    async def sink(event: ActivityEvent) -> None:
        pass

    watcher = _watcher(store, sink)
    watcher.add_reader(_RowReader(root))
    await watcher._process_realtime_path(path)
    assert activity_high_water(watcher._activity_seen[str(path.resolve())]) == 900


def test_the_real_claude_reader_resumes_from_the_rewound_mark(tmp_path: Path) -> None:
    """End to end through the real parser: the turn end after the rewind carries
    its text, which is what the chat is waiting on."""
    def turn(text: str) -> str:
        return json.dumps({
            "type": "assistant",
            "timestamp": "2026-11-01T07:48:45.000Z",
            "message": {
                "stop_reason": "end_turn",
                "content": [{"type": "text", "text": text}],
            },
        }) + "\n"

    path = tmp_path / "abc.jsonl"
    path.write_text(turn("old"), encoding="utf-8")
    reader = VENDORS["claude"].make_log_reader()

    muted = {"act_hw::6864"}
    assert reader.parse_activity(path, muted) == []

    seen = {"act_hw::6864"}
    assert base.rewind_past_eof_mark(path, seen) is True
    assert reader.parse_activity(path, seen) == []

    with path.open("a", encoding="utf-8") as fh:
        fh.write(turn("new"))
    ends = [e for e in reader.parse_activity(path, seen) if e.event_type == "turn_complete"]
    assert [e.text for e in ends] == ["new"]

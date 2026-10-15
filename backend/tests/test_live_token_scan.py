"""The live "THIS SESSION" tally, read straight from the vendor's session log.

The number is not accumulated from ingested events any more — it IS whatever
the session log holds. A scan on a dedicated worker thread derives it, reading
only the bytes appended since the last pass, and publishes the result into
tokens_store as a cache. Nothing here records, checkpoints, or credits
cumulative/global: those events are already accounted for there.
"""

from __future__ import annotations

import asyncio
import json
import threading
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

from agent_team_backend import app
from agent_team_backend.cli_vendors.claude import ClaudeLogReader
from agent_team_backend.log_readers.base import LogReader, TokenUsage
from agent_team_backend.tokens_store import TokensStore


@pytest.fixture
def store(tmp_path: Path) -> TokensStore:
    return TokensStore(
        global_path=tmp_path / "global-tokens.json",
        workspace_base_dir=tmp_path / "workspaces",
    )


@pytest.fixture
def workspace(tmp_path: Path) -> str:
    ws = tmp_path / "ws"
    ws.mkdir()
    return str(ws)


def _claude_line(msg_id: str, req: str, inp: int, out: int, cache: int = 0) -> str:
    return json.dumps({
        "type": "assistant",
        "requestId": req,
        "message": {
            "id": msg_id,
            "model": "claude-opus-5",
            "usage": {"input_tokens": inp, "output_tokens": out,
                      "cache_read_input_tokens": cache,
                      "cache_creation_input_tokens": 0},
        },
    })


def _write_session(path: Path, lines: list[str]) -> None:
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _append_session(path: Path, lines: list[str]) -> None:
    with path.open("a", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")


# ── LogReader.usage_since_for_session ────────────────────────────────────


def test_totals_equal_what_the_session_file_actually_holds(tmp_path: Path) -> None:
    """Digit for digit: the scanned total is the file's own arithmetic, with
    cache reads folded into `input` exactly as the CLI's own footer does."""
    path = tmp_path / "sess-abc.jsonl"
    _write_session(path, [
        _claude_line("m1", "r1", 100, 10, cache=5),
        "not json at all",
        _claude_line("m2", "r2", 200, 20),
        json.dumps({"type": "user", "message": {"content": "hi"}}),
        _claude_line("m3", "r3", 300, 30, cache=7),
    ])
    reader = ClaudeLogReader()

    totals, cursor = reader.usage_since_for_session(path, "sess-abc", {})
    assert totals == {"input": 100 + 5 + 200 + 300 + 7, "output": 60, "calls": 3}
    # The reference whole-file primitive agrees with the incremental one.
    assert totals == reader.total_usage_for_session(path, "sess-abc")
    assert cursor["offset"] == path.stat().st_size


def test_a_grown_file_adds_only_the_new_events(tmp_path: Path) -> None:
    path = tmp_path / "sess-abc.jsonl"
    _write_session(path, [_claude_line("m1", "r1", 100, 10)])
    reader = ClaudeLogReader()

    first, cursor = reader.usage_since_for_session(path, "sess-abc", {})
    assert first == {"input": 100, "output": 10, "calls": 1}

    _append_session(path, [_claude_line("m2", "r2", 200, 20)])
    delta, cursor = reader.usage_since_for_session(path, "sess-abc", cursor)
    # Only the appended turn — the first one is NOT re-counted.
    assert delta == {"input": 200, "output": 20, "calls": 1}
    assert reader.total_usage_for_session(path, "sess-abc") == {
        "input": 300, "output": 30, "calls": 2,
    }


def test_a_partial_trailing_line_is_left_for_the_next_pass(tmp_path: Path) -> None:
    """A turn still being written must be read once, not zero times."""
    path = tmp_path / "sess-abc.jsonl"
    _write_session(path, [_claude_line("m1", "r1", 100, 10)])
    reader = ClaudeLogReader()
    _, cursor = reader.usage_since_for_session(path, "sess-abc", {})

    with path.open("a", encoding="utf-8") as fh:
        fh.write(_claude_line("m2", "r2", 200, 20)[:40])  # no newline yet
    delta, cursor = reader.usage_since_for_session(path, "sess-abc", cursor)
    assert delta == {"input": 0, "output": 0, "calls": 0}

    with path.open("a", encoding="utf-8") as fh:
        fh.write(_claude_line("m2", "r2", 200, 20)[40:] + "\n")
    delta, _ = reader.usage_since_for_session(path, "sess-abc", cursor)
    assert delta == {"input": 200, "output": 20, "calls": 1}


class _SharedSourceReader(LogReader):
    """Stands in for the vendors whose sessions share one source file/DB, and
    whose parse_incremental is the base class's legacy fallback."""

    vendor = "shared"

    def project_dirs(self) -> list[Path]:
        return []

    def session_files(self) -> list[Path]:
        return []

    def parse_session_file(self, path: Path, seen_keys: set[str]) -> list[TokenUsage]:
        out = []
        for n, sid in enumerate(["s1", "s2", "s1"], start=1):
            key = f"k{n}"
            if key in seen_keys:
                continue
            seen_keys.add(key)
            out.append(TokenUsage(
                vendor="shared", input_tokens=n * 10, output_tokens=n,
                cwd="", session_id=sid, file_path=str(path), dedup_key=key,
            ))
        return out


def test_a_shared_source_is_filtered_by_session(tmp_path: Path) -> None:
    reader = _SharedSourceReader()
    path = tmp_path / "shared.db"
    assert reader.usage_since_for_session(path, "s1", {})[0] == {
        "input": 40, "output": 4, "calls": 2,
    }
    assert reader.usage_since_for_session(path, "s2", {})[0] == {
        "input": 20, "output": 2, "calls": 1,
    }
    # No filter: everything.
    assert reader.usage_since_for_session(path, "", {})[0]["calls"] == 3


def test_the_unbounded_legacy_cursor_is_never_cached(tmp_path: Path) -> None:
    """parse_incremental's fallback hands back an unbounded key set. Dropping
    it costs a full re-read next time, which is the cheap half of the trade."""
    totals, cursor = _SharedSourceReader().usage_since_for_session(
        tmp_path / "shared.db", "s1", {}
    )
    assert totals["calls"] == 2
    assert cursor == {}


# ── TokensStore is a cache, not an accumulator ───────────────────────────


def test_record_leaves_the_live_tally_alone_but_still_feeds_the_rest(
    store: TokensStore, workspace: str
) -> None:
    store.record(
        workspace, source="cli", vendor="claude",
        pane_id="pane-a", session_id="sess-1",
        input_tokens=10, output_tokens=20, dedup_key="e1",
    )
    snap = store.snapshot(workspace)
    assert snap["workspace"]["live_by_session"] == {}
    assert snap["workspace"]["cumulative"]["totals"] == {"input": 10, "output": 20, "calls": 1}
    assert snap["global"]["all_time"] == {"input": 10, "output": 20, "calls": 1}


def test_set_live_total_overwrites_rather_than_accumulating(
    store: TokensStore, workspace: str
) -> None:
    """The scan result IS the truth, so a stale cached value is replaced."""
    assert store.set_live_total(workspace, "sess-1", {"input": 900, "output": 90, "calls": 9})
    assert store.set_live_total(workspace, "sess-1", {"input": 950, "output": 95, "calls": 10})
    # Unchanged value: no write, and the caller is told not to broadcast.
    assert not store.set_live_total(workspace, "sess-1", {"input": 950, "output": 95, "calls": 10})
    assert store.snapshot(workspace)["workspace"]["live_by_session"] == {
        "sess-1": {"input": 950, "output": 95, "calls": 10},
    }


# ── app scan scheduling ──────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _isolated_scan_state(monkeypatch: pytest.MonkeyPatch):
    def clear() -> None:
        app._pending_tokens_broadcast.clear()
        app._live_scans.clear()
        app._live_scan_inflight.clear()
        # The scanner publishes into the process-global store; a bucket left
        # behind would make the next test's "did the value change?" broadcast
        # gate see its own leftovers.
        app.tokens_store._live_by_session.clear()

    monkeypatch.setattr(app, "_TOKENS_BROADCAST_DEBOUNCE_SEC", 0.01)
    clear()
    yield
    clear()


@pytest.fixture
def claude_session(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A Claude session log the scanner can locate by id, with no file hint."""
    path = tmp_path / "sess-abc.jsonl"
    _write_session(path, [_claude_line("m1", "r1", 100, 10)])
    reader = ClaudeLogReader()
    monkeypatch.setattr(reader, "session_files_for_workspace", lambda ws: [path])
    monkeypatch.setattr(app, "_readers", [reader])
    return path


async def _settle() -> None:
    for _ in range(50):
        await asyncio.sleep(0.01)
        if not app._live_scan_inflight:
            return


@pytest.mark.asyncio
async def test_the_tally_matches_the_file_and_grows_with_it(
    claude_session: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    published: list[tuple] = []
    monkeypatch.setattr(
        app.tokens_store, "set_live_total",
        lambda ws, key, total: published.append((ws, key, total)) or True,
    )
    monkeypatch.setattr(app.tokens_store, "snapshot", lambda ws: {"ws": ws})

    with patch.object(app, "broadcast", new_callable=AsyncMock):
        app.track_live_session(
            workspace_path="/ws/a", pane_id="pane-a",
            vendor="claude", session_id="sess-abc",
        )
        await _settle()
        assert published[-1] == ("/ws/a", "sess-abc", {"input": 100, "output": 10, "calls": 1})

        _append_session(claude_session, [_claude_line("m2", "r2", 200, 20)])
        app.refresh_live_scans("/ws/a")
        await _settle()

    # Grew by exactly the appended turn — the first one was not re-counted.
    assert published[-1] == ("/ws/a", "sess-abc", {"input": 300, "output": 30, "calls": 2})


@pytest.mark.asyncio
async def test_an_unchanged_file_is_never_re_parsed(
    claude_session: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    parses: list[Path] = []
    reader = app._readers[0]
    real = reader.usage_since_for_session

    def counting(path, session_id, checkpoint, **kwargs):
        parses.append(path)
        return real(path, session_id, checkpoint, **kwargs)

    monkeypatch.setattr(reader, "usage_since_for_session", counting)
    monkeypatch.setattr(app.tokens_store, "snapshot", lambda ws: {"ws": ws})

    with patch.object(app, "broadcast", new_callable=AsyncMock):
        app.track_live_session(
            workspace_path="/ws/a", pane_id="pane-a",
            vendor="claude", session_id="sess-abc",
        )
        await _settle()
        assert len(parses) == 1

        for _ in range(5):
            app.refresh_live_scans("/ws/a")
        await _settle()

    assert len(parses) == 1, "an untouched log must not be parsed again"


@pytest.mark.asyncio
async def test_a_rotated_file_is_re_read_in_full(
    claude_session: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    published: list[dict] = []
    monkeypatch.setattr(
        app.tokens_store, "set_live_total",
        lambda ws, key, total: published.append(total) or True,
    )
    monkeypatch.setattr(app.tokens_store, "snapshot", lambda ws: {"ws": ws})

    with patch.object(app, "broadcast", new_callable=AsyncMock):
        app.track_live_session(
            workspace_path="/ws/a", pane_id="pane-a",
            vendor="claude", session_id="sess-abc",
        )
        await _settle()
        assert published[-1] == {"input": 100, "output": 10, "calls": 1}

        # Replaced by a shorter generation under the same name: a new inode
        # and a smaller size, so the stored cursor cannot be trusted.
        claude_session.unlink()
        _write_session(claude_session, [_claude_line("n1", "q1", 7, 3)])
        app.refresh_live_scans("/ws/a")
        await _settle()

    assert published[-1] == {"input": 7, "output": 3, "calls": 1}


@pytest.mark.asyncio
async def test_the_scan_runs_on_the_dedicated_pool_not_the_loop(
    claude_session: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    threads: list[str] = []
    reader = app._readers[0]
    real = reader.usage_since_for_session

    def naming(path, session_id, checkpoint, **kwargs):
        threads.append(threading.current_thread().name)
        return real(path, session_id, checkpoint, **kwargs)

    monkeypatch.setattr(reader, "usage_since_for_session", naming)
    monkeypatch.setattr(app.tokens_store, "snapshot", lambda ws: {"ws": ws})

    with patch.object(app, "broadcast", new_callable=AsyncMock) as mock_broadcast:
        app.track_live_session(
            workspace_path="/ws/a", pane_id="pane-a",
            vendor="claude", session_id="sess-abc",
        )
        # The call returns immediately — the scan has not even started.
        assert threads == []
        await _settle()
        await asyncio.sleep(0.05)

    assert threads and all(n.startswith("tokens-live-scan") for n in threads)
    mock_broadcast.assert_called_once()
    assert mock_broadcast.call_args.args[0]["type"] == "tokens.changed"


@pytest.mark.asyncio
async def test_the_scan_never_touches_ingestion_checkpoints(
    claude_session: Path, store: TokensStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(app, "tokens_store", store)
    store.record(
        "/ws/a", source="cli", vendor="claude", pane_id="pane-a",
        session_id="sess-abc", input_tokens=10, output_tokens=20, dedup_key="e1",
        ingestion_file=str(claude_session),
        ingestion_checkpoint={"kind": "jsonl", "offset": 100, "identity": "1:2"},
    )
    before = store.snapshot("/ws/a")
    ckpt_before = store.get_ingestion_checkpoint(str(claude_session), "/ws/a")

    with patch.object(app, "broadcast", new_callable=AsyncMock):
        app.track_live_session(
            workspace_path="/ws/a", pane_id="pane-a",
            vendor="claude", session_id="sess-abc",
        )
        await _settle()

    after = store.snapshot("/ws/a")
    assert after["workspace"]["live_by_session"] == {
        "sess-abc": {"input": 100, "output": 10, "calls": 1},
    }
    assert after["workspace"]["cumulative"] == before["workspace"]["cumulative"]
    assert after["global"] == before["global"]
    assert store.get_ingestion_checkpoint(str(claude_session), "/ws/a") == ckpt_before


@pytest.mark.asyncio
async def test_tracking_needs_a_workspace_a_pane_and_a_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(app, "_readers", [])
    for kwargs in (
        {"workspace_path": "/ws/a", "pane_id": "pane-a", "session_id": ""},
        {"workspace_path": "", "pane_id": "pane-a", "session_id": "s1"},
        {"workspace_path": "/ws/a", "pane_id": "", "session_id": "s1"},
    ):
        app.track_live_session(vendor="claude", **kwargs)
    await asyncio.sleep(0.05)
    assert app._live_scans == {}


@pytest.mark.asyncio
async def test_a_session_whose_log_does_not_exist_yet_publishes_nothing(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    reader = ClaudeLogReader()
    monkeypatch.setattr(reader, "session_files_for_workspace", lambda ws: [])
    monkeypatch.setattr(app, "_readers", [reader])
    published: list = []
    monkeypatch.setattr(
        app.tokens_store, "set_live_total",
        lambda ws, key, total: published.append(total) or True,
    )

    app.track_live_session(
        workspace_path=str(tmp_path), pane_id="pane-a",
        vendor="claude", session_id="sess-nope",
    )
    await _settle()
    assert published == []
    # Still tracked, so the scan retries once the CLI writes its log.
    assert (str(tmp_path), "sess-nope") in app._live_scans


@pytest.mark.asyncio
async def test_a_scan_failure_is_swallowed(
    claude_session: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom(*_a, **_kw):
        raise OSError("log unreadable")

    monkeypatch.setattr(app._readers[0], "usage_since_for_session", boom)
    with patch.object(app, "broadcast", new_callable=AsyncMock) as mock_broadcast:
        app.track_live_session(
            workspace_path="/ws/a", pane_id="pane-a",
            vendor="claude", session_id="sess-abc",
        )
        await _settle()
        await asyncio.sleep(0.05)
    mock_broadcast.assert_not_called()
    assert app._live_scan_inflight == set()


# ── session lifecycle ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_a_session_survives_one_of_its_panes_closing(
    claude_session: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    dropped: list[tuple] = []
    monkeypatch.setattr(app.tokens_store, "set_live_total", lambda *a: False)
    monkeypatch.setattr(
        app.tokens_store, "drop_live_session",
        lambda ws, key: dropped.append((ws, key)),
    )

    for pane in ("pane-a", "pane-b"):
        app.track_live_session(
            workspace_path="/ws/a", pane_id=pane,
            vendor="claude", session_id="sess-abc",
        )
    await _settle()
    assert list(app._live_scans) == [("/ws/a", "sess-abc")]

    app.forget_pane_live_sessions("pane-a")
    assert dropped == []
    assert ("/ws/a", "sess-abc") in app._live_scans

    app.forget_pane_live_sessions("pane-b")
    assert dropped == [("/ws/a", "sess-abc")]
    assert app._live_scans == {}

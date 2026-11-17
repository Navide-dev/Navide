"""Token parsing must not hold a transcript's whole unread tail at once (0.2.44).

Claude transcripts run to hundreds of MB (531 MB measured on the user's
machine). ``parse_incremental`` read every complete record after the
checkpoint into one list of parsed dicts before looking at any of them, so a
backend restart with stale or missing checkpoints held a whole transcript as
Python objects at the same time: the field backend peaked at 2.09 GB right
after a restart and kept ~700 pymalloc arenas (half of them waste) for good.
Only assistant records with usage are needed, so the tail is now streamed;
these tests bound the peak and pin the result.
"""

from __future__ import annotations

import json
import tracemalloc
from pathlib import Path

from agent_team_backend.cli_vendors.claude import ClaudeLogReader
from agent_team_backend.log_readers.base import read_jsonl_tail

TRANSCRIPT_SIZE = 6 * 1024 * 1024


def _transcript(path: Path, size: int) -> int:
    """Object-dense records shaped like Claude Code's; returns the usage-record count."""
    usage_records = 0
    with path.open("w", encoding="utf-8") as fh:
        i = 0
        while fh.tell() < size:
            i += 1
            fh.write(json.dumps({
                "type": "user", "uuid": f"u{i}", "sessionId": "s",
                "message": {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": f"t{i}",
                     "content": [{"type": "text", "text": f"line {n} of tool output"} for n in range(40)]},
                ]},
            }) + "\n")
            fh.write(json.dumps({
                "type": "assistant", "uuid": f"a{i}", "requestId": f"req{i}",
                "timestamp": "2026-11-15T23:46:13Z", "version": "2.1.0",
                "message": {
                    "id": f"msg{i}", "model": "claude-opus-5-5",
                    "content": [{"type": "text", "text": "ok"}, {"type": "tool_use", "id": f"t{i}", "input": {"a": 1}}],
                    "usage": {"input_tokens": 10, "output_tokens": 20, "cache_read_input_tokens": 5,
                              "cache_creation_input_tokens": 1, "cache_creation": {"ephemeral_1h_input_tokens": 1}},
                },
            }) + "\n")
            usage_records += 1
    return usage_records


def test_parse_incremental_peak_stays_below_the_transcript_size(tmp_path: Path) -> None:
    path = tmp_path / "s.jsonl"
    _transcript(path, TRANSCRIPT_SIZE)
    reader = ClaudeLogReader()
    tracemalloc.start()
    try:
        result = reader.parse_incremental(path, {})
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert result.events
    # The list form peaked at several times the file size here.
    assert peak < path.stat().st_size, f"peak {peak / 2**20:.1f} MiB"


def test_parse_incremental_result_matches_the_list_form(tmp_path: Path) -> None:
    path = tmp_path / "s.jsonl"
    expected_events = _transcript(path, 256 * 1024)
    # A half-written final line stays unread.
    with path.open("a", encoding="utf-8") as fh:
        fh.write('{"type": "assistant", "message": {"usage"')
    _records, list_checkpoint, _rotated = read_jsonl_tail(path, {})

    result = ClaudeLogReader().parse_incremental(path, {})

    assert len(result.events) == expected_events
    final = result.checkpoint
    assert {k: final[k] for k in ("kind", "offset", "identity", "anchor")} == {
        k: list_checkpoint[k] for k in ("kind", "offset", "identity", "anchor")
    }
    assert final["recent_keys"] == [ev.dedup_key for ev in result.events][-64:]
    previous_end = 0
    for n, ev in enumerate(result.events):
        cp = ev.checkpoint
        assert list(cp) == ["kind", "offset", "identity", "anchor", "recent_keys"]
        assert cp["kind"] == "jsonl" and cp["identity"] == final["identity"] and cp["anchor"] == final["anchor"]
        assert previous_end < cp["offset"] <= final["offset"]
        previous_end = cp["offset"]
        assert cp["recent_keys"] == [e.dedup_key for e in result.events[: n + 1]][-64:]

    # Resuming from the final checkpoint finds nothing new.
    assert ClaudeLogReader().parse_incremental(path, final).events == []

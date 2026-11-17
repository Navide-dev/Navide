"""Codex token parsing must not hold a rollout's whole unread tail at once (0.2.44).

Same defect as Claude's (test_claude_incremental_memory.py): parse_incremental
read every complete record after the checkpoint into one list of parsed dicts,
while it only needs the session metadata and the latest token_count. Rollouts
are mostly tool output (27 MB measured on the user's machine), so the tail is
now streamed; these tests bound the peak and pin the result.
"""

from __future__ import annotations

import json
import tracemalloc
from pathlib import Path

from agent_team_backend.cli_vendors.codex import CodexLogReader
from agent_team_backend.log_readers.base import read_jsonl_tail

ROLLOUT_SIZE = 6 * 1024 * 1024


def _write(fh, rec: dict) -> None:
    fh.write(json.dumps(rec) + "\n")


def _rollout(path: Path, size: int, *, start: int = 0) -> tuple[int, int]:
    """Object-dense records shaped like a Codex rollout; returns the last (input, output) totals."""
    totals = (0, 0)
    with path.open("a", encoding="utf-8") as fh:
        if start == 0:
            _write(fh, {"timestamp": "t0", "type": "session_meta", "payload": {
                "id": "sess-1", "cwd": "/w", "model_provider": "openai", "cli_version": "0.163.0"}})
            _write(fh, {"timestamp": "t0", "type": "turn_context", "payload": {"model": "gpt-5.4"}})
        i = start
        while fh.tell() < size:
            i += 1
            _write(fh, {"timestamp": f"t{i}", "type": "response_item", "payload": {
                "type": "custom_tool_call_output", "call_id": f"c{i}",
                "output": [{"type": "text", "text": f"row {n}"} for n in range(40)]}})
            totals = (100 * i, 10 * i)
            _write(fh, {"timestamp": f"t{i}", "type": "event_msg", "payload": {
                "type": "token_count", "info": {"total_token_usage": {
                    "input_tokens": totals[0], "cached_input_tokens": 40 * i,
                    "output_tokens": totals[1], "total_tokens": sum(totals)}}}})
    return totals


def test_parse_incremental_peak_stays_below_the_rollout_size(tmp_path: Path) -> None:
    path = tmp_path / "rollout.jsonl"
    _rollout(path, ROLLOUT_SIZE)
    tracemalloc.start()
    try:
        result = CodexLogReader().parse_incremental(path, {})
        _, peak = tracemalloc.get_traced_memory()
    finally:
        tracemalloc.stop()
    assert len(result.events) == 1
    # The list form peaked at several times the file size here.
    assert peak < path.stat().st_size, f"peak {peak / 2**20:.1f} MiB"


def test_parse_incremental_result_and_resume(tmp_path: Path) -> None:
    path = tmp_path / "rollout.jsonl"
    first = _rollout(path, 128 * 1024)
    last_token_end = path.stat().st_size
    with path.open("a", encoding="utf-8") as fh:
        _write(fh, {"timestamp": "tx", "type": "response_item", "payload": {"type": "message"}})
        fh.write('{"type": "event_msg", "payload": {"type": "token_c')  # still being written
    _records, list_checkpoint, _rotated = read_jsonl_tail(path, {})
    reader = CodexLogReader()

    result = reader.parse_incremental(path, {})

    (event,) = result.events
    assert (event.input_tokens, event.output_tokens) == first
    assert (event.session_id, event.cwd, event.model, event.cli_version) == ("sess-1", "/w", "openai", "0.163.0")
    assert event.raw["ledger_session_totals"]["model"] == "gpt-5.4"
    final = result.checkpoint
    assert {k: final[k] for k in ("kind", "offset", "identity", "anchor")} == {
        k: list_checkpoint[k] for k in ("kind", "offset", "identity", "anchor")
    }
    assert list(final) == [
        "kind", "offset", "identity", "anchor", "input_total", "output_total", "cwd", "model",
        "session_id", "cli_version", "meta_seen", "ledger_model", "basis",
    ]
    assert (final["input_total"], final["output_total"], final["meta_seen"]) == (*first, True)
    assert event.checkpoint == {**final, "offset": last_token_end}

    # Nothing new: no event, same checkpoint.
    again = reader.parse_incremental(path, final)
    assert again.events == [] and again.checkpoint == final

    # Finish the partial line, append more turns: only the delta is reported.
    with path.open("a", encoding="utf-8") as fh:
        fh.write('ount", "info": null}}\n')
    second = _rollout(path, path.stat().st_size + 64 * 1024, start=10_000)
    resumed = reader.parse_incremental(path, final)
    (delta,) = resumed.events
    assert (delta.input_tokens, delta.output_tokens) == (second[0] - first[0], second[1] - first[1])
    assert delta.checkpoint["offset"] == resumed.checkpoint["offset"] == path.stat().st_size

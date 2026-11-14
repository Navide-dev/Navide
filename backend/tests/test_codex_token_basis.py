"""Codex token totals: input_tokens already holds cached_input_tokens and
output_tokens already holds reasoning_output_tokens (total_tokens is their sum),
so neither may be added a second time — and checkpoints written with the old,
double-counting basis must carry on without dropping or repeating a delta."""

from __future__ import annotations

import json
from pathlib import Path

from agent_team_backend.cli_vendors.codex import CodexLogReader


def _meta() -> str:
    return json.dumps({"type": "session_meta", "payload": {
        "id": "cx1", "cwd": "/Users/me/proj", "model_provider": "openai"}}) + "\n"


def _count(inp: int, cached: int, out: int, reasoning: int) -> str:
    return json.dumps({"type": "event_msg", "timestamp": "2026-11-05T02:00:00Z", "payload": {
        "type": "token_count", "info": {"total_token_usage": {
            "input_tokens": inp, "cached_input_tokens": cached, "output_tokens": out,
            "reasoning_output_tokens": reasoning, "total_tokens": inp + out}}}}) + "\n"


def _rollout(tmp_path: Path) -> Path:
    return tmp_path / "rollout-2026-11-05T02-00-00-cx1.jsonl"


def test_incremental_counts_each_token_once(tmp_path: Path) -> None:
    path = _rollout(tmp_path)
    path.write_text(_meta() + _count(1000, 600, 50, 20))
    [ev] = CodexLogReader().parse_incremental(path, {}).events
    assert (ev.input_tokens, ev.output_tokens) == (1000, 50)


def test_session_file_counts_each_token_once(tmp_path: Path) -> None:
    path = _rollout(tmp_path)
    path.write_text(_meta() + _count(1000, 600, 50, 20))
    [ev] = CodexLogReader().parse_session_file(path, set())
    assert (ev.input_tokens, ev.output_tokens) == (1000, 50)


def test_old_basis_checkpoint_resumes_without_loss_or_repeat(tmp_path: Path) -> None:
    path = _rollout(tmp_path)
    path.write_text(_meta() + _count(1000, 600, 50, 20))
    reader = CodexLogReader()
    first = reader.parse_incremental(path, {})
    # The checkpoint an older Navide left: same cursor, totals in the old
    # input+cached / output+reasoning basis, no basis marker.
    old = {k: v for k, v in first.checkpoint.items() if k != "basis"}
    old.update({"input_total": 1600, "output_total": 70})

    with path.open("a") as fh:
        fh.write(_count(2500, 1800, 90, 30))
    result = reader.parse_incremental(path, old)
    [ev] = result.events
    assert (ev.input_tokens, ev.output_tokens) == (1500, 40)
    assert (result.checkpoint["input_total"], result.checkpoint["output_total"]) == (2500, 90)

    # The migrated checkpoint carries on in the new basis.
    with path.open("a") as fh:
        fh.write(_count(3000, 2000, 100, 30))
    [ev] = reader.parse_incremental(path, result.checkpoint).events
    assert (ev.input_tokens, ev.output_tokens) == (500, 10)


def test_old_checkpoint_with_nothing_counted_yet_starts_from_zero(tmp_path: Path) -> None:
    path = _rollout(tmp_path)
    path.write_text(_meta())
    reader = CodexLogReader()
    old = {k: v for k, v in reader.parse_incremental(path, {}).checkpoint.items() if k != "basis"}
    with path.open("a") as fh:
        fh.write(_count(1000, 600, 50, 20))
    [ev] = reader.parse_incremental(path, old).events
    assert (ev.input_tokens, ev.output_tokens) == (1000, 50)

"""The direct read a held chat reply falls back on before it is given up."""

from __future__ import annotations

import json
from pathlib import Path

from agent_team_backend.channels import _last_turn_text
from agent_team_backend.cli_vendors.registry import VENDORS


def _turn(stamp: str, *blocks: str) -> str:
    return "".join(
        json.dumps({
            "type": "assistant",
            "timestamp": stamp,
            "message": {"stop_reason": "end_turn", "content": [{"type": "text", "text": b}] if b else []},
        }) + "\n"
        for b in blocks
    )


def _epoch(stamp: str) -> float:
    from agent_team_backend.pane_account_history import parse_event_time

    value = parse_event_time(stamp)
    assert value is not None
    return value


T1, T2 = "2026-11-01T07:43:31.000Z", "2026-11-01T07:48:45.000Z"


def test_the_last_text_since_the_message_went_in(tmp_path: Path) -> None:
    path = tmp_path / "s.jsonl"
    path.write_text(_turn(T1, "old") + _turn(T2, "", "the reply"), encoding="utf-8")
    reader = VENDORS["claude"].make_log_reader()
    assert _last_turn_text(reader, path, _epoch(T2) - 1) == "the reply"


def test_an_earlier_turn_is_not_passed_off_as_this_ones(tmp_path: Path) -> None:
    path = tmp_path / "s.jsonl"
    path.write_text(_turn(T1, "old"), encoding="utf-8")
    reader = VENDORS["claude"].make_log_reader()
    assert _last_turn_text(reader, path, _epoch(T2)) == ""


def test_nothing_written_reads_as_empty(tmp_path: Path) -> None:
    path = tmp_path / "s.jsonl"
    path.write_text("", encoding="utf-8")
    reader = VENDORS["claude"].make_log_reader()
    assert _last_turn_text(reader, path, 0.0) == ""

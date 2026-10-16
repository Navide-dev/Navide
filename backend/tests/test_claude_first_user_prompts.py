"""ClaudeLogReader.first_user_prompts — human-prompt preview extraction.

Locks the rules the reconnect picker relies on: only ``type=="user"`` records
whose content is a plain human string count; tool_result lists, injected-text
lists, and slash-command / system wrappers ("<...>") are skipped; malformed
lines are tolerated; each prompt is truncated to ~80 chars.
"""

from __future__ import annotations

import json
from pathlib import Path

from agent_team_backend.log_readers.claude import first_user_prompts


def _line(rec: dict) -> str:
    return json.dumps(rec, ensure_ascii=False) + "\n"


def _user(content) -> dict:  # noqa: ANN001
    return {"type": "user", "message": {"role": "user", "content": content}}


def _write(path: Path, lines: list[str]) -> None:
    path.write_text("".join(lines), encoding="utf-8")


def test_extracts_first_n_real_prompts_skipping_noise(tmp_path: Path) -> None:
    f = tmp_path / "s.jsonl"
    _write(f, [
        "{ this is not valid json\n",                       # malformed → tolerated
        _line(_user("幫我分析專案")),                          # real #1
        _line(_user([{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}])),  # tool result → skip
        _line(_user("<task-notification>\n<task-id>a1</task-id>")),  # wrapper → skip
        _line(_user([{"type": "text", "text": "Continue from where you left off."}])),  # injected list → skip
        _line({"type": "assistant", "message": {"content": []}}),   # not user → skip
        _line(_user("第二個問題")),                            # real #2
        _line(_user("第三個問題")),                            # beyond limit
    ])

    assert first_user_prompts(f, limit=2) == ["幫我分析專案", "第二個問題"]


def test_truncates_to_80_chars(tmp_path: Path) -> None:
    f = tmp_path / "s.jsonl"
    long = "x" * 200
    _write(f, [_line(_user(long))])

    out = first_user_prompts(f, limit=2)
    assert len(out) == 1
    assert out[0] == "x" * 80


def test_missing_file_returns_empty(tmp_path: Path) -> None:
    assert first_user_prompts(tmp_path / "nope.jsonl", limit=2) == []


def test_skips_hidden_image_notes(tmp_path: Path) -> None:
    f = tmp_path / "s.jsonl"
    note = "[Image: original 780x3746, displayed at 416x2000. Multiply coordinates by 1.88 to map to original image.]"
    _write(f, [
        _line({**_user(note), "isMeta": True, "turnCompanion": True}),  # the agent read an image
        _line(_user("真正的問題")),
    ])

    assert first_user_prompts(f, limit=2) == ["真正的問題"]

"""The text a Claude Stop hook carries (``last_assistant_message``) is the turn's
final assistant message — and so is the text the log reader's turn_complete
carries: `_assistant_text` of the end_turn line alone. Checked against Claude
Code 2.1.318 on 2026-11-04: a turn whose lines were text ALPHA-FIRST (tool_use)
/ tool_use Bash / end_turn BETA-LAST gave the Stop payload 'BETA-LAST'. So a
chat answered from the hook's text gets exactly the reply the log would have
brought, MSG blocks included — and neither carries a block written before the
turn's last tool call.
"""

from __future__ import annotations

import json
from pathlib import Path

from agent_team_backend.cli_vendors.claude import ClaudeLogReader


def _line(stop_reason: str, *blocks: dict) -> str:
    return json.dumps({
        "type": "assistant", "timestamp": "2026-11-04T08:49:00Z", "cwd": "/ws", "sessionId": "s",
        "message": {"role": "assistant", "stop_reason": stop_reason, "content": list(blocks)},
    }) + "\n"


def test_the_logs_turn_text_is_the_final_message_as_the_stop_hook_carries_it(tmp_path: Path) -> None:
    path = tmp_path / "s.jsonl"
    path.write_text(
        _line("tool_use", {"type": "text", "text": "---MSG-START--- to: telegram:alice\nALPHA-FIRST\n---MSG-END---"})
        + _line("tool_use", {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "echo probe-mid"}})
        + _line("end_turn", {"type": "text", "text": "BETA-LAST"}),
        encoding="utf-8",
    )
    ends = [e for e in ClaudeLogReader().parse_activity(path, set()) if e.event_type == "turn_complete"]
    assert [e.text for e in ends] == ["BETA-LAST"]

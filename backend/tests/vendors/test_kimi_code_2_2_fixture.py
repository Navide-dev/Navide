"""KimiLogReader against a Kimi Code 2.2.0 session.

Recorded 2026-10-21 from @moonshot-ai/kimi-code 2.2.0 (npm tarball sha256
b7c21c0e4d17b480be9f2c890f14d769244003bf35c80d67f8139d74f5e4d960) in a
scratch HOME/KIMI_CODE_HOME with KIMI_CODE_NO_AUTO_UPDATE=1, driven over a
PTY against a loopback mock OpenAI endpoint through the KIMI_MODEL_* env
provider: no account, no login, no provider call. The records keep the
recorded types and field names; prompts, ids, times and token counts are
fixture values, and the bulky profile.bind / llm.tools_snapshot /
llm.request records are left out (the reader ignores them).

Two things the reader had assumed no longer hold — 0.39.0 recorded the
same way writes them too:

  state.json      {"version": 2, "cwd": …}; there is no `workDir` key.
  turn.ended      an explicit end record per turn ({reason: "completed"} or
                  "cancelled"), after agent.turn.ended and before
                  prompt.completed / prompt.aborted.
"""

from __future__ import annotations

import json
import re
import time
from pathlib import Path

import pytest

from agent_team_backend.cli_vendors import kimi
from agent_team_backend.cli_vendors.kimi import KimiLogReader

_SID = "session_1c45769d-43e6-4fad-b36c-94ce2aa8b9aa"
_CWD = "/Users/me/proj"
_REPLY = "Regression reply: café 完成\n---MSG-END---"


def _records(t0: int) -> list[dict]:
    """One completed turn, then one the user cancelled (Esc), as recorded."""
    loop = lambda turn, event, dt: {  # noqa: E731
        "type": "context.append_loop_event", "agentId": "main",
        "event": {"turnId": str(turn), **event}, "time": t0 + dt,
    }
    return [
        {"type": "metadata", "protocol_version": "1.5", "created_at": t0},
        {"type": "runtime.set_binding", "workspaceId": "wd_proj_c41def6fd06b",
         "runtimeId": "local", "agentId": "main", "time": t0 + 1},
        {"type": "permission.set_mode", "agentId": "main", "mode": "manual", "time": t0 + 2},
        {"type": "turn.prompt", "agentId": "main",
         "input": [{"type": "text", "text": "at-pane:fixture say hello"}],
         "origin": {"kind": "user"}, "promptId": "msg_fixture_1", "turnId": 0, "time": t0 + 3},
        {"type": "agent.turn.started", "turnId": 0, "queueItemId": "msg_fixture_1",
         "time": t0 + 4, "kind": "event"},
        loop(0, {"type": "step.begin", "uuid": "s1", "step": 1}, 5),
        {"type": "usage.record", "agentId": "main", "model": "__kimi_env_model__",
         "usage": {"inputOther": 8, "output": 3, "inputCacheRead": 4, "inputCacheCreation": 0},
         "usageScope": "turn", "time": t0 + 6},
        loop(0, {"type": "content.part", "uuid": "p1", "step": 1, "stepUuid": "s1",
                 "part": {"type": "text", "text": _REPLY}}, 7),
        loop(0, {"type": "step.end", "uuid": "s1", "step": 1, "finishReason": "end_turn"}, 8),
        {"type": "agent.turn.ended", "turnId": 0, "outcome": "done", "time": t0 + 9, "kind": "event"},
        {"type": "turn.ended", "agentId": "main", "turnId": 0, "reason": "completed",
         "durationMs": 6, "time": t0 + 10},
        {"type": "prompt.completed", "agentId": "main", "promptId": "msg_fixture_1",
         "reason": "completed", "time": t0 + 11},
        {"type": "turn.prompt", "agentId": "main",
         "input": [{"type": "text", "text": "slow one"}],
         "origin": {"kind": "user"}, "promptId": "msg_fixture_2", "turnId": 1, "time": t0 + 20},
        loop(1, {"type": "step.begin", "uuid": "s2", "step": 1}, 21),
        {"type": "turn.cancel", "agentId": "main", "turnId": 1, "target": "active",
         "reason": "user_cancelled", "time": t0 + 22},
        loop(1, {"type": "step.end", "uuid": "s2", "step": 1, "finishReason": "interrupted"}, 23),
        {"type": "turn.step.interrupted", "agentId": "main", "turnId": 1, "step": 1,
         "reason": "aborted", "time": t0 + 24},
        {"type": "agent.turn.ended", "turnId": 1, "outcome": "aborted", "time": t0 + 25, "kind": "event"},
        {"type": "turn.ended", "agentId": "main", "turnId": 1, "reason": "cancelled",
         "durationMs": 5, "time": t0 + 26},
        {"type": "prompt.aborted", "agentId": "main", "promptId": "msg_fixture_2", "time": t0 + 27},
    ]


def _state() -> dict:
    return {
        "id": _SID, "version": 2, "cwd": _CWD, "createdAt": 1, "updatedAt": 2,
        "archived": False, "agents": {"main": {"homedir": "<session>/agents/main", "type": "main"}},
        "custom": {}, "lastPrompt": "slow one", "title": "say hello",
        "titleKind": "replaceable", "lastTurnReason": "cancelled", "isCustomTitle": False,
    }


@pytest.fixture
def wire(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    home = tmp_path / ".kimi-code"
    monkeypatch.setenv("KIMI_CODE_HOME", str(home))
    sdir = home / "sessions" / "wd_proj_c41def6fd06b" / _SID
    (sdir / "agents" / "main").mkdir(parents=True)
    (sdir / "state.json").write_text(json.dumps(_state()), encoding="utf-8")
    return sdir / "agents" / "main" / "wire.jsonl"


def _write(path: Path, records: list[dict]) -> None:
    path.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in records), encoding="utf-8")


def test_cwd_comes_from_the_2x_state_file(wire: Path) -> None:
    _write(wire, _records(1_000))
    reader = KimiLogReader()
    assert reader.cwd_from_file(wire) == _CWD
    assert reader.session_files_for_workspace(_CWD) == [wire]
    [usage] = reader.parse_session_file(wire, set())
    assert (usage.cwd, usage.session_id, usage.input_tokens, usage.output_tokens) == (_CWD, _SID, 12, 3)


def test_legacy_workdir_state_still_reads(wire: Path) -> None:
    wire.parent.parent.parent.joinpath("state.json").write_text(
        json.dumps({"workDir": "/legacy", "title": "New Session"}), encoding="utf-8")
    assert KimiLogReader().cwd_from_file(wire) == "/legacy"


def test_turn_ended_closes_the_turn_without_waiting_for_silence(wire: Path) -> None:
    # Times are "now", so the quiet-window fallback cannot be what closes it.
    now = int(time.time() * 1000)
    _write(wire, _records(now)[:12])
    events = KimiLogReader().parse_activity(wire, set())
    done = [e for e in events if e.event_type == "turn_complete"]
    assert [(e.dedup_key, e.text, e.cwd) for e in done] == [("turn:0", _REPLY, _CWD)]
    prompts = [e.text for e in events if e.detail == "prompt"]
    assert prompts == ["at-pane:fixture say hello"]


def test_a_cancelled_turn_completes_once(wire: Path) -> None:
    now = int(time.time() * 1000)
    seen: set[str] = set()
    reader = KimiLogReader()
    _write(wire, _records(now))
    done = [e for e in reader.parse_activity(wire, seen) if e.event_type == "turn_complete"]
    assert [(e.dedup_key, e.detail) for e in done] == [("turn:0", "turn-ended"), ("turn:1", "cancel")]
    assert done[1].text == ""
    # Nothing is replayed, and no idle flush follows a turn that has ended.
    assert reader.parse_activity(wire, seen) == []


def test_official_version_shape_tells_kimi_code_from_the_archived_kimi_cli() -> None:
    dep = kimi.SPEC.install_dep
    assert dep.official_regex
    for kimi_code in ("2.2.0", "0.39.0"):  # both recorded from the npm package
        assert re.search(dep.official_regex, kimi_code)
    # MoonshotAI/kimi-cli 1.52.0, src/kimi_cli/cli/__init__.py:73
    assert not re.search(dep.official_regex, "kimi, version 1.52.0")

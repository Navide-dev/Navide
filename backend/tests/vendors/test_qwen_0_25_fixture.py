"""QwenLogReader against a Qwen Code 0.25.x chat log.

The fixture below is hand-written, minimal and content-free. Its shape follows
QwenLM/qwen-code at tag v0.25.3, packages/core/src/services/
chatRecordingService.ts, not a recorded session:

  ChatRecord             uuid/parentUuid/sessionId/timestamp/type/cwd/version
                         as before; new optional provenance, promptId,
                         executionContext {modelId, authType, approvalMode},
                         backgroundTurn, deliveredTurn
  recordUserMessage      type "user", no subtype, message {role, parts}
  recordAssistantTurn    type "assistant", model, usageMetadata (unchanged
                         field names), message role "model"
  createBaseRecord       version = config.getCliVersion()
  new system subtypes    session_approval_mode, session_execution_engine,
                         turn_attempt, background_task_completed
  recordExternalAgentRecordStrict
                         NEW in 0.25: subtypes `agent_mention` and
                         `agent_message`, written as type "user" so the model
                         reads them, but per the ChatRecord.subtype comment
                         "never a real user prompt, a turn boundary, a title
                         source, or a cold notification"; rebuildTurnBoundaries
                         excludes both from turn boundaries.

The chat file still lives at <projectDir>/chats/<sessionId>.jsonl.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent_team_backend.log_readers.claude import encode_claude_cwd
from agent_team_backend.log_readers.qwen import QwenLogReader

_SID = "2a0c9d5e-2f4a-4c0e-9b7d-3a5c8e9f0a25"
_CWD = "/Users/me/proj"
_VERSION = "0.25.3"
# Not a credential, but built by concatenation like every other fake secret.
_FAKE_AGENT = "agent-" + "fixture"


def _rec(rtype: str, uuid: str, parent: str | None, second: int, **extra) -> dict:
    rec = {
        "uuid": uuid,
        "parentUuid": parent,
        "sessionId": _SID,
        "timestamp": f"2026-10-20T10:00:{second:02d}.000Z",
        "type": rtype,
        "provenance": {
            "user": "real_user", "assistant": "assistant_output",
            "tool_result": "tool_result",
        }.get(rtype, "system"),
        "cwd": _CWD,
        "version": _VERSION,
        "gitBranch": "main",
    }
    rec.update(extra)
    return rec


def _prompt(uuid: str, parent: str | None, second: int, text: str) -> dict:
    return _rec(
        "user", uuid, parent, second,
        promptId=f"p-{uuid}",
        executionContext={"modelId": "qwen3-coder-plus", "approvalMode": "default"},
        message={"role": "user", "parts": [{"text": text}]},
        systemPayload={"displayText": text},
    )


def _reply(uuid: str, parent: str, second: int, text: str,
           prompt: int, candidates: int, cached: int, thoughts: int) -> dict:
    return _rec(
        "assistant", uuid, parent, second,
        model="qwen3-coder-plus",
        message={"role": "model", "parts": [{"text": text}]},
        usageMetadata={
            "promptTokenCount": prompt,
            "candidatesTokenCount": candidates,
            "cachedContentTokenCount": cached,
            "thoughtsTokenCount": thoughts,
            "totalTokenCount": prompt + candidates + thoughts,
        },
        contextWindowSize=1000000,
    )


def _external_agent(subtype: str, uuid: str, parent: str, second: int) -> dict:
    rec = _rec(
        "user", uuid, parent, second,
        subtype=subtype, provenance="external_agent",
        message={"role": "user", "parts": [{"text": "note from another agent"}]},
        systemPayload={"author": {"agentId": _FAKE_AGENT, "name": "worker"}},
        externalRecordKey=f"k-{uuid}",
    )
    if subtype == "agent_message":
        rec.update(agentId=_FAKE_AGENT, agentName="worker")
    return rec


def _chat_0_25() -> list[dict]:
    return [
        _rec("system", "s1", None, 0, subtype="session_approval_mode",
             systemPayload={"mode": "default"}),
        _prompt("u1", "s1", 1, "first prompt"),
        _rec("system", "s2", "u1", 2, subtype="turn_attempt", systemPayload={}),
        _reply("a1", "s2", 3, "working on it", 1000, 40, 600, 10),
        _rec("tool_result", "t1", "a1", 4,
             message={"role": "user", "parts": [{"functionResponse": {"name": "x"}}]}),
        # Another session agent writes into the transcript mid-turn.
        _external_agent("agent_message", "m1", "t1", 5),
        _external_agent("agent_mention", "m2", "m1", 6),
        _reply("a2", "m2", 7, "first reply", 1200, 60, 1000, 0),
    ]


@pytest.fixture
def chat(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / ".qwen"
    monkeypatch.setenv("QWEN_RUNTIME_DIR", str(root))
    path = root / "projects" / encode_claude_cwd(_CWD) / "chats" / f"{_SID}.jsonl"
    path.parent.mkdir(parents=True)
    with path.open("w", encoding="utf-8") as f:
        for r in _chat_0_25():
            f.write(json.dumps(r) + "\n")
    return path


def _go_quiet(path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import agent_team_backend.cli_vendors.qwen as qwen_mod

    monkeypatch.setattr(
        qwen_mod.time, "time",
        lambda: path.stat().st_mtime + qwen_mod._TURN_IDLE_SECONDS + 1,
    )


def test_tokens_from_0_25_assistant_records(chat: Path) -> None:
    events = QwenLogReader().parse_session_file(chat, set())
    assert [(e.input_tokens, e.output_tokens, e.cache_read_tokens) for e in events] == [
        (1000, 50, 600),
        (1200, 60, 1000),
    ]
    assert all(e.cli_version == _VERSION and e.cwd == _CWD for e in events)
    assert {e.session_id for e in events} == {_SID}


def test_incremental_parse_reads_0_25_records(chat: Path) -> None:
    result = QwenLogReader().parse_incremental(chat, {})
    assert [e.dedup_key for e in result.events] == ["a1", "a2"]


def test_session_agent_records_do_not_open_or_close_a_turn(
    chat: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """agent_message / agent_mention are type "user" but, upstream, never a
    real prompt or a turn boundary: the turn opened by "first prompt" must end
    once, with the reply written after them."""
    _go_quiet(chat, monkeypatch)
    events = QwenLogReader().parse_activity(chat, set())
    done = [e for e in events if e.event_type == "turn_complete"]
    assert [(e.detail, e.text) for e in done] == [("idle", "first reply")]
    user_texts = [e.text for e in events if e.detail == "user"]
    assert user_texts == ["first prompt"]

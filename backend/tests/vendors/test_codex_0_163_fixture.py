"""CodexLogReader against a codex-cli 0.163.0 rollout.

The fixture below is hand-written, minimal and content-free. Its shape follows
openai/codex at tag rust-v0.163.0 (129b8ec7ee6f), not a recorded rollout:

  codex-rs/history/src/rollout_payload.rs  RolloutItemWire: `type` tag plus
      `payload`; response_item may carry `metadata`
  codex-rs/history/src/lib.rs              RolloutLine: `timestamp`, optional
      `ordinal`, flattened item; RolloutItem adds token_usage_record,
      world_state, inter_agent_communication_metadata, retained_context
  codex-rs/rollout/src/policy.rs           what is persisted: token_count,
      task_started/task_complete, turn_aborted, thread_settings_applied always;
      user_message/agent_message only in `legacy` history mode — `paginated`
      persists item_completed TurnItems instead
  codex-rs/protocol/src/protocol.rs        SessionMeta (session_id + id,
      history_mode, context_window, runtime_workspace_roots); TurnContextItem
      without the fields #51492 dropped, `summary` written as "none";
      TurnCompleteEvent/TokenCountEvent; TokenUsage gains
      cache_write_input_tokens; TokenUsageRecord
  codex-rs/protocol/src/models.rs          ResponseItem::AdditionalTools (#50435)
      and ResponseItem::AgentMessage (inter-agent, author/recipient)
  codex-rs/protocol/src/items.rs           TurnItem tag `type` = "UserMessage",
      content = UserInput {type: "text", text, text_elements}

Record-type mix cross-checked against the key structure (record and payload
type names only, no content) of local 0.162.1 rollouts, which are already
`history_mode: "paginated"` and carry every type used here.

Release-note items that do not reach the reader: #50360 removed initial
messages from the SessionConfigured event (not persisted); #50446 bundles
rollouts into a gzip tar only for feedback uploads; #53150 changes how cold
resume restores permissions (thread_settings_applied, already persisted).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent_team_backend.cli_vendors.codex import CodexLogReader

_THREAD = "01a20000-0000-7000-8000-00000000c0de"
_CWD = "/Users/me/proj"
_VERSION = "0.163.0"
# Not a credential, but built by concatenation like every other fake secret.
_FAKE_TURN = "turn-" + "fixture"


def _line(ordinal: int, rtype: str, payload: dict, ts: str, **extra) -> dict:
    rec = {"timestamp": ts, "ordinal": ordinal, "type": rtype, "payload": payload}
    rec.update(extra)
    return rec


def _usage(inp: int, cached: int, out: int, reasoning: int) -> dict:
    return {
        "input_tokens": inp,
        "cached_input_tokens": cached,
        "cache_write_input_tokens": 0,
        "output_tokens": out,
        "reasoning_output_tokens": reasoning,
        "total_tokens": inp + out,
    }


def _turn(n: int, prompt: str, reply: str, totals: tuple[int, int, int, int],
          last: tuple[int, int, int, int], start: int) -> list[dict]:
    """One 0.163 paginated turn: started → prompt item → reasoning → reply →
    token_count + token_usage_record → task_complete."""
    tid = f"{_FAKE_TURN}-{n}"
    ts = lambda s: f"2026-10-20T10:{n:02d}:{s:02d}.000Z"  # noqa: E731
    return [
        _line(start, "event_msg", {
            "type": "task_started", "turn_id": tid, "root_turn_id": tid,
            "started_at": 1792490000 + n, "model_context_window": 258400,
        }, ts(0)),
        _line(start + 1, "turn_context", {
            "turn_id": tid, "root_turn_id": tid, "cwd": _CWD,
            "approval_policy": "on-request",
            "sandbox_policy": {"type": "workspace-write"},
            "model": "gpt-5.5-codex", "effort": "medium", "summary": "none",
        }, ts(1)),
        _line(start + 2, "event_msg", {
            "type": "item_completed", "thread_id": _THREAD, "turn_id": tid,
            "item": {
                "type": "UserMessage", "id": f"u{n}",
                "content": [{"type": "text", "text": prompt, "text_elements": []}],
            },
            "completed_at_ms": 1792490000000 + n,
        }, ts(2)),
        _line(start + 3, "response_item", {
            "type": "reasoning", "summary": [], "encrypted_content": "x",
        }, ts(3)),
        _line(start + 4, "response_item", {
            "type": "message", "role": "assistant", "phase": "final_answer",
            "content": [{"type": "output_text", "text": reply}],
        }, ts(4), metadata={"turn_id": tid}),
        _line(start + 5, "event_msg", {
            "type": "token_count",
            "info": {
                "total_token_usage": _usage(*totals),
                "last_token_usage": _usage(*last),
                "model_context_window": 258400,
            },
            "rate_limits": None,
        }, ts(5)),
        # 0.163 writes a per-response usage record next to token_count. The
        # reader must not count it a second time.
        _line(start + 6, "token_usage_record", {
            "thread_id": _THREAD, "turn_id": tid, "session_id": _THREAD,
            "root_turn_id": tid, "response_id": f"resp-{n}",
            "usage": _usage(*last), "turn_token_usage": _usage(*last),
            "thread_token_usage": _usage(*totals),
        }, ts(6)),
        _line(start + 7, "event_msg", {
            "type": "task_complete", "turn_id": tid, "root_turn_id": tid,
            "last_agent_message": reply, "started_at": 1792490000 + n,
        }, ts(7)),
    ]


def _rollout_0163() -> list[dict]:
    head = [
        _line(0, "session_meta", {
            "session_id": _THREAD, "id": _THREAD,
            "timestamp": "2026-10-20T10:00:00.000Z", "cwd": _CWD,
            "runtime_workspace_roots": [_CWD], "originator": "codex_cli_rs",
            "cli_version": _VERSION, "source": "cli", "thread_source": "user",
            "model_provider": "openai", "history_mode": "paginated",
            "context_window": {"window_id": "01a20000-0000-7000-8000-0000000000aa"},
        }, "2026-10-20T10:00:00.000Z"),
        _line(1, "response_item", {
            "type": "additional_tools", "role": "developer",
            "tools": [{"type": "function", "name": "fixture_tool"}],
        }, "2026-10-20T10:00:00.100Z"),
        _line(2, "world_state", {}, "2026-10-20T10:00:00.200Z"),
        _line(3, "event_msg", {"type": "thread_settings_applied"},
              "2026-10-20T10:00:00.300Z"),
    ]
    turn1 = _turn(1, "first prompt", "first reply",
                  totals=(1000, 400, 50, 10), last=(1000, 400, 50, 10), start=4)
    middle = [
        # Inter-agent traffic is not the assistant's reply.
        _line(12, "response_item", {
            "type": "agent_message", "author": "worker", "recipient": "root",
            "content": [{"type": "input_text", "text": "inter-agent note"}],
        }, "2026-10-20T10:01:59.000Z"),
        _line(13, "inter_agent_communication_metadata", {"trigger_turn": False},
              "2026-10-20T10:01:59.500Z"),
    ]
    turn2 = _turn(2, "second prompt", "second reply",
                  totals=(2500, 1400, 120, 30), last=(1500, 1000, 70, 20), start=14)
    return head + turn1 + middle + turn2


def _write_jsonl(path: Path, records: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")


@pytest.fixture
def rollout(tmp_path: Path, set_home) -> Path:
    home = tmp_path / "home"
    home.mkdir()
    set_home(home)
    path = (home / ".codex" / "sessions" / "2026" / "10" / "20"
            / f"rollout-2026-10-20T10-00-00-{_THREAD}.jsonl")
    _write_jsonl(path, _rollout_0163())
    return path


def test_token_totals_come_from_token_count_only(rollout: Path) -> None:
    events = CodexLogReader().parse_session_file(rollout, set())
    assert len(events) == 1
    ev = events[0]
    # Last token_count: input 2500 + cached 1400, output 120 + reasoning 30.
    # token_usage_record repeats these numbers and must not add to them.
    assert (ev.input_tokens, ev.output_tokens) == (3900, 150)
    assert ev.cwd == _CWD
    assert ev.cli_version == _VERSION
    assert ev.model == "openai"


def test_incremental_parse_reads_the_0163_header(rollout: Path) -> None:
    result = CodexLogReader().parse_incremental(rollout, {})
    assert len(result.events) == 1
    ev = result.events[0]
    assert (ev.input_tokens, ev.output_tokens) == (3900, 150)
    assert ev.session_id == _THREAD
    assert ev.cwd == _CWD
    assert ev.cli_version == _VERSION


def test_turns_open_at_each_user_message_item(rollout: Path) -> None:
    turns = CodexLogReader().turns_for_session(rollout, _THREAD)
    assert [t.prompt_excerpt for t in turns] == ["first prompt", "second prompt"]
    assert [len(t.calls) for t in turns] == [1, 1]
    first, second = turns[0].calls[0], turns[1].calls[0]
    # input is the uncached remainder; output already holds reasoning.
    assert (first.input, first.cache_read, first.output) == (600, 400, 50)
    assert (second.input, second.cache_read, second.output) == (500, 1000, 70)


def test_activity_ends_each_turn_at_task_complete_with_the_reply(
    rollout: Path,
) -> None:
    events = CodexLogReader().parse_activity(rollout, set())
    done = [e for e in events if e.event_type == "turn_complete"]
    assert [(e.detail, e.text) for e in done] == [
        ("task_complete", "first reply"),
        ("task_complete", "second reply"),
    ]
    prompts = [e.text for e in events if e.detail == "user_message"]
    assert prompts == ["first prompt", "second prompt"]
    assert all(e.cwd == _CWD for e in events)

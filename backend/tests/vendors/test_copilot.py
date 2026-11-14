"""CopilotLogReader across BOTH storage generations.

1.0.78+: the central ``<root>/session-store.db`` — usage-row token watermark,
turn-row activity, marker binding, store failure tolerance.
1.0.75:  per-session ``events.jsonl`` — cumulative modelMetrics deltas,
workspace.yaml cwd, dir-name session id, incremental offsets.
Plus the shared surface: has_session, path claiming, attribution binding.

Fixture event shapes were captured live against copilot-cli 1.0.75; the store
schema and its token-column semantics against 1.0.78 (schema_version 6).
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
from pathlib import Path

import pytest

from agent_team_backend.log_readers.attribution import Attribution
from agent_team_backend.log_readers.base import TokenUsage
from agent_team_backend.cli_vendors.copilot import (
    CopilotLogReader,
    _metrics_totals,
    _reset_db_warning,
    copilot_root,
)

_SID = "e6495800-dfd4-4a75-b2ab-d70980f83b89"
_CWD = "/Users/me/proj"
_TS = "2026-07-27T18:34:04.138Z"


def _event(etype: str, data: dict, eid: str = "ev-1", ts: str = _TS) -> dict:
    """One events.jsonl line: {type, data, id, timestamp, parentId}."""
    return {"type": etype, "data": data, "id": eid, "timestamp": ts,
            "parentId": None}


def _session_start(cwd: str = _CWD, sid: str = _SID) -> dict:
    return _event("session.start", {
        "sessionId": sid, "version": 1, "copilotVersion": "1.0.75",
        "context": {"cwd": cwd},
    }, eid="ev-start")


def _user(content: str = "hi", eid: str = "ev-user") -> dict:
    return _event("user.message", {
        "content": content,
        "transformedContent": f"<current_datetime>t</current_datetime>\n\n{content}",
        "attachments": [],
    }, eid=eid)


def _assistant(content: str = "ok", eid: str = "ev-asst") -> dict:
    return _event("assistant.message", {
        "messageId": "m-1", "model": "claude-haiku-4.5", "content": content,
        "toolRequests": [], "outputTokens": 39,
    }, eid=eid)


def _buckets(input: int, cache_read: int, cache_write: int, output: int) -> dict:  # noqa: A002
    return {
        "input": {"tokenCount": input},
        "cache_read": {"tokenCount": cache_read},
        "cache_write": {"tokenCount": cache_write},
        "output": {"tokenCount": output},
    }


def _shutdown(*, model: str = "claude-haiku-4.5", input: int = 9,  # noqa: A002
              cache_read: int = 0, cache_write: int = 19889, output: int = 39,
              reasoning: int = 20, extra_models: dict | None = None,
              eid: str = "ev-shutdown") -> dict:
    """session.shutdown as captured: modelMetrics.<model>.usage.inputTokens
    ALREADY includes cache read+write; outputTokens already includes
    reasoning; top-level tokenDetails carries the same split buckets."""
    metrics = {
        model: {
            "requests": {"count": 1, "cost": 0.33},
            "usage": {
                "inputTokens": input + cache_read + cache_write,
                "outputTokens": output,
                "cacheReadTokens": cache_read,
                "cacheWriteTokens": cache_write,
                "reasoningTokens": reasoning,
            },
            "tokenDetails": _buckets(input, cache_read, cache_write, output),
        },
    }
    metrics.update(extra_models or {})
    return _event("session.shutdown", {
        "shutdownType": "routine",
        "tokenDetails": _buckets(input, cache_read, cache_write, output),
        "modelMetrics": metrics,
        "currentModel": model,
    }, eid=eid)


def _write_session(root: Path, sid: str = _SID, cwd: str = _CWD,
                   events: list[dict] | None = None) -> Path:
    d = root / "session-state" / sid
    d.mkdir(parents=True, exist_ok=True)
    (d / "workspace.yaml").write_text(
        f"id: {sid}\ncwd: {cwd}\nclient_name: github/cli\n"
        "name: 'Reply with the single word: ok'\nuser_named: false\n",
        encoding="utf-8",
    )
    f = d / "events.jsonl"
    with f.open("w", encoding="utf-8") as fh:
        for rec in events or []:
            fh.write(json.dumps(rec) + "\n")
    return f


def _append(path: Path, records: list[dict]) -> None:
    with path.open("a", encoding="utf-8") as fh:
        for rec in records:
            fh.write(json.dumps(rec) + "\n")


@pytest.fixture
def fake_copilot_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "copilot-home"
    monkeypatch.setenv("COPILOT_HOME", str(root))
    return root


@pytest.fixture(autouse=True)
def _rearm_store_warning() -> None:
    """The store-read WARNING fires once per PROCESS; re-arm it per test."""
    _reset_db_warning()


# ─────────────────────────── 1.0.78 store fixtures ───────────────────────────

# Only the columns the reader touches, in the live column order (schema_version
# 6) so a positional SELECT mistake would surface here too.
_STORE_SCHEMA = """
CREATE TABLE sessions (
    id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, host_type TEXT,
    branch TEXT, summary TEXT, created_at TEXT, updated_at TEXT);
CREATE TABLE turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
    turn_index INTEGER NOT NULL, user_message TEXT, assistant_response TEXT,
    timestamp TEXT, UNIQUE(session_id, turn_index));
CREATE TABLE assistant_usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
    turn_index INTEGER, agent_id TEXT, parent_tool_call_id TEXT,
    model TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER,
    cache_read_tokens INTEGER, cache_write_tokens INTEGER,
    reasoning_tokens INTEGER, total_nano_aiu INTEGER, request_multiplier REAL,
    duration_ms INTEGER, time_to_first_token_ms INTEGER,
    inter_token_latency_ms INTEGER, initiator TEXT, api_endpoint TEXT,
    reasoning_effort TEXT, finish_reason TEXT, content_filter_triggered INTEGER,
    token_details_json TEXT, created_at TEXT);
"""


def _store(root: Path) -> Path:
    """Create (once) and return <root>/session-store.db."""
    root.mkdir(parents=True, exist_ok=True)
    db = root / "session-store.db"
    if not db.exists():
        con = sqlite3.connect(db)
        con.executescript(_STORE_SCHEMA)
        con.commit()
        con.close()
    return db


def _exec(db: Path, sql: str, params: tuple = ()) -> None:
    con = sqlite3.connect(db)
    con.execute(sql, params)
    con.commit()
    con.close()


def _add_session(db: Path, sid: str = _SID, cwd: str = _CWD) -> None:
    _exec(db, "INSERT INTO sessions (id, cwd, created_at) VALUES (?, ?, ?)",
          (sid, cwd, _TS))


def _add_turn(db: Path, sid: str = _SID, index: int = 0, user: str = "hi",
              assistant: str = "ok", ts: str = _TS) -> None:
    _exec(db, "INSERT INTO turns (session_id, turn_index, user_message, "
              "assistant_response, timestamp) VALUES (?, ?, ?, ?, ?)",
          (sid, index, user, assistant, ts))


def _add_usage(db: Path, sid: str = _SID, *, input_tokens: int = 19898,
               output_tokens: int = 39, cache_read: int = 0,
               cache_write: int = 19889, reasoning: int = 20,
               model: str = "claude-haiku-4.5", ts: str = _TS) -> None:
    """One assistant_usage_events row.

    Defaults reproduce the live row measured against 1.0.78: input_tokens
    19898 ALREADY equals 9 raw input + 0 cache_read + 19889 cache_write, and
    output_tokens 39 already includes the 20 reasoning tokens.
    """
    _exec(db, "INSERT INTO assistant_usage_events (session_id, turn_index, "
              "model, input_tokens, output_tokens, cache_read_tokens, "
              "cache_write_tokens, reasoning_tokens, created_at) "
              "VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?)",
          (sid, model, input_tokens, output_tokens, cache_read, cache_write,
           reasoning, ts))


# ─────────────────────────── root / layout ───────────────────────────────────

def test_root_env_precedence(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("COPILOT_HOME", "/tmp/cop")
    assert copilot_root() == Path("/tmp/cop")
    monkeypatch.delenv("COPILOT_HOME")
    assert copilot_root() == Path.home() / ".copilot"


def test_missing_root_and_files_are_tolerated(fake_copilot_root: Path) -> None:
    reader = CopilotLogReader()
    ghost = fake_copilot_root / "session-state" / "ghost" / "events.jsonl"
    assert reader.project_dirs() == []
    assert reader.session_files() == []
    assert reader.session_files_for_workspace(_CWD) == []
    assert reader.has_session("ghost") is False
    assert reader.parse_session_file(ghost, set()) == []
    assert reader.parse_activity(ghost, set()) == []
    assert reader.cwd_from_file(ghost) == ""


def test_session_files_and_workspace_scoping(fake_copilot_root: Path) -> None:
    reader = CopilotLogReader()
    f_a = _write_session(fake_copilot_root, sid="sid-a", cwd="/proj/a")
    f_b = _write_session(fake_copilot_root, sid="sid-b", cwd="/proj/b")
    found = reader.session_files()
    assert f_a in found and f_b in found
    only_a = reader.session_files_for_workspace("/proj/a")
    assert f_a in only_a
    assert f_b not in only_a


def test_session_id_is_dir_name_and_siblings_are_ignored(
    fake_copilot_root: Path,
) -> None:
    """Id = the session dir name (`copilot --resume=<id>`); sibling files
    (session.db, workspace.yaml) must never coin bogus resume ids."""
    reader = CopilotLogReader()
    f = _write_session(fake_copilot_root)
    assert reader.session_id_from_path(f) == _SID
    assert reader.session_id_from_path(f.parent / "session.db") == ""
    assert reader.session_id_from_path(f.parent / "workspace.yaml") == ""
    stray = fake_copilot_root / "session-state" / "events.jsonl"
    assert reader.session_id_from_path(stray) == ""


def test_cwd_from_workspace_yaml(fake_copilot_root: Path) -> None:
    reader = CopilotLogReader()
    f = _write_session(fake_copilot_root, cwd="/Users/x/my proj")
    assert reader.cwd_from_file(f) == "/Users/x/my proj"


def test_has_session_checks_events_file(fake_copilot_root: Path) -> None:
    reader = CopilotLogReader()
    _write_session(fake_copilot_root, sid="sid-live")
    assert reader.has_session("sid-live") is True
    assert reader.has_session("missing") is False
    assert reader.has_session("") is False
    assert reader.has_session("../session-state") is False


# ─────────────────────────── token parsing ───────────────────────────────────

def test_token_mapping_from_model_metrics(fake_copilot_root: Path) -> None:
    """inputTokens already folds cache read+write, outputTokens already folds
    reasoning — the buckets pass straight through into TokenUsage."""
    reader = CopilotLogReader()
    f = _write_session(fake_copilot_root, events=[
        _session_start(), _user(), _assistant(),
        _shutdown(input=9, cache_read=0, cache_write=19889, output=39),
    ])
    events = reader.parse_session_file(f, set())
    assert len(events) == 1
    ev = events[0]
    assert ev.vendor == "copilot"
    assert ev.input_tokens == 9 + 19889
    assert ev.output_tokens == 39
    assert ev.cwd == _CWD
    assert ev.session_id == _SID
    assert ev.model == "claude-haiku-4.5"
    assert ev.timestamp == _TS


def test_token_totals_sum_across_models(fake_copilot_root: Path) -> None:
    reader = CopilotLogReader()
    extra = {
        "gpt-5": {
            "usage": {"inputTokens": 100, "outputTokens": 10,
                      "cacheReadTokens": 0, "cacheWriteTokens": 0,
                      "reasoningTokens": 0},
        },
    }
    f = _write_session(fake_copilot_root, events=[
        _shutdown(input=9, cache_read=0, cache_write=19889, output=39,
                  extra_models=extra),
    ])
    events = reader.parse_session_file(f, set())
    assert len(events) == 1
    assert events[0].input_tokens == 9 + 19889 + 100
    assert events[0].output_tokens == 39 + 10


def test_cumulative_deltas_and_shrink_reset(fake_copilot_root: Path) -> None:
    """Totals are snapshots: a later, larger snapshot emits only the delta;
    a shrinking snapshot (resumed run restarting its counters) resets the
    baseline silently — never a negative or double count."""
    reader = CopilotLogReader()
    seen: set[str] = set()
    f = _write_session(fake_copilot_root, events=[
        _shutdown(input=100, cache_read=0, cache_write=0, output=10,
                  eid="ev-s1"),
    ])
    first = reader.parse_session_file(f, seen)
    assert [(e.input_tokens, e.output_tokens) for e in first] == [(100, 10)]
    # Same file again: no new snapshot → nothing.
    assert reader.parse_session_file(f, seen) == []
    # Larger snapshot → delta only.
    _append(f, [_shutdown(input=160, cache_read=0, cache_write=0, output=25,
                          eid="ev-s2")])
    second = reader.parse_session_file(f, seen)
    assert [(e.input_tokens, e.output_tokens) for e in second] == [(60, 15)]
    # Shrunk snapshot → baseline reset, no event.
    _append(f, [_shutdown(input=30, cache_read=0, cache_write=0, output=5,
                          eid="ev-s3")])
    assert reader.parse_session_file(f, seen) == []
    # Growth from the new baseline emits again.
    _append(f, [_shutdown(input=50, cache_read=0, cache_write=0, output=9,
                          eid="ev-s4")])
    third = reader.parse_session_file(f, seen)
    assert [(e.input_tokens, e.output_tokens) for e in third] == [(20, 4)]


def test_token_details_fallback_without_model_metrics(
    fake_copilot_root: Path,
) -> None:
    """A metrics event without modelMetrics still counts via its top-level
    tokenDetails buckets (cache read+write folded into input)."""
    reader = CopilotLogReader()
    rec = _event("session.compaction_complete", {
        "tokenDetails": _buckets(50, 200, 30, 7),
    }, eid="ev-comp")
    f = _write_session(fake_copilot_root, events=[rec])
    events = reader.parse_session_file(f, set())
    assert [(e.input_tokens, e.output_tokens) for e in events] == [
        (50 + 200 + 30, 7),
    ]


def test_usageless_model_buckets_are_not_zero_totals() -> None:
    """modelMetrics entries carrying no usage dict are not a "totals are zero"
    reading — fall through to tokenDetails, else report no totals at all."""
    assert _metrics_totals({"modelMetrics": {"gpt-x": {}}}) is None
    assert _metrics_totals({
        "modelMetrics": {"gpt-x": {}},
        "tokenDetails": _buckets(50, 200, 30, 7),
    }) == (50 + 200 + 30, 7)


def test_malformed_and_metricless_lines_skipped(fake_copilot_root: Path) -> None:
    reader = CopilotLogReader()
    f = _write_session(fake_copilot_root)
    with f.open("w", encoding="utf-8") as fh:
        fh.write("{not valid json\n")
        fh.write(json.dumps(_event("session.usage_checkpoint", {
            "totalNanoAiu": 2506525000, "totalPremiumRequests": 0.33,
        }, eid="ev-cp")) + "\n")
        fh.write(json.dumps(_shutdown(input=7, cache_read=0, cache_write=0,
                                      output=3)) + "\n")
    events = reader.parse_session_file(f, set())
    assert [(e.input_tokens, e.output_tokens) for e in events] == [(7, 3)]


# ─────────────────────────── incremental parsing ─────────────────────────────

def test_incremental_parse_offset_advances(fake_copilot_root: Path) -> None:
    reader = CopilotLogReader()
    f = _write_session(fake_copilot_root, events=[
        _session_start(), _user(), _assistant(),
        _shutdown(input=100, cache_read=0, cache_write=0, output=50,
                  eid="ev-s1"),
    ])
    parsed1 = reader.parse_incremental(f, {})
    assert [(e.input_tokens, e.output_tokens) for e in parsed1.events] == [(100, 50)]
    assert parsed1.events[0].session_id == _SID
    assert parsed1.events[0].cwd == _CWD
    first_offset = parsed1.checkpoint["offset"]

    _append(f, [_shutdown(input=140, cache_read=0, cache_write=0, output=65,
                          eid="ev-s2")])
    parsed2 = reader.parse_incremental(f, parsed1.checkpoint)
    assert [(e.input_tokens, e.output_tokens) for e in parsed2.events] == [(40, 15)]
    assert parsed2.checkpoint["offset"] > first_offset
    # Tail-only: nothing new → nothing emitted.
    assert reader.parse_incremental(f, parsed2.checkpoint).events == []


def test_incremental_replacement_resets_baseline(fake_copilot_root: Path) -> None:
    """A replaced file (new inode) is a new generation — the persisted totals
    baseline resets so the re-read never produces a bogus delta."""
    reader = CopilotLogReader()
    f = _write_session(fake_copilot_root, events=[
        _shutdown(input=100, cache_read=0, cache_write=0, output=50,
                  eid="ev-s1"),
    ])
    parsed1 = reader.parse_incremental(f, {})
    assert len(parsed1.events) == 1

    tmp = f.with_suffix(".jsonl.tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        fh.write(json.dumps(_shutdown(input=100, cache_read=0, cache_write=0,
                                      output=50, eid="ev-s1")) + "\n")
        fh.write(json.dumps(_shutdown(input=130, cache_read=0, cache_write=0,
                                      output=58, eid="ev-s2")) + "\n")
    os.replace(tmp, f)
    parsed2 = reader.parse_incremental(f, parsed1.checkpoint)
    assert [(e.input_tokens, e.output_tokens) for e in parsed2.events] == [(130, 58)]


def test_incremental_dip_never_lowers_the_baseline(
    fake_copilot_root: Path,
) -> None:
    """Cumulative snapshots can blip downward; the persisted baseline is a
    high-water mark, so the dip emits nothing AND the following rise emits
    only what is genuinely new (total credited == the true total)."""
    reader = CopilotLogReader()
    f = _write_session(fake_copilot_root, events=[
        _shutdown(input=100000, cache_read=0, cache_write=0, output=10000,
                  eid="ev-s1"),
    ])
    p1 = reader.parse_incremental(f, {})
    _append(f, [_shutdown(input=30000, cache_read=0, cache_write=0,
                          output=3000, eid="ev-s2")])
    p2 = reader.parse_incremental(f, p1.checkpoint)
    _append(f, [_shutdown(input=250000, cache_read=0, cache_write=0,
                          output=25000, eid="ev-s3")])
    p3 = reader.parse_incremental(f, p2.checkpoint)

    emitted = p1.events + p2.events + p3.events
    assert sum(e.input_tokens for e in emitted) == 250000
    assert sum(e.output_tokens for e in emitted) == 25000


# ─────────────────────────── activity ────────────────────────────────────────

def test_parse_activity_messages_tools_and_turn_end(
    fake_copilot_root: Path,
) -> None:
    """user/assistant messages and tool executions are agent_active;
    assistant.turn_end is the explicit turn_complete boundary and carries
    the turn's last assistant text."""
    reader = CopilotLogReader()
    f = _write_session(fake_copilot_root, events=[
        _session_start(),
        _user("do the thing"),
        _event("tool.execution_start", {"toolName": "bash"}, eid="ev-t1"),
        _event("tool.execution_complete", {"toolName": "bash"}, eid="ev-t2"),
        _assistant("all done"),
        _event("assistant.turn_end", {"turnId": "0"}, eid="ev-te"),
    ])
    events = reader.parse_activity(f, set())
    assert [(e.event_type, e.detail) for e in events] == [
        ("agent_active", "user"),
        ("agent_active", "tool.execution_start"),
        ("agent_active", "tool.execution_complete"),
        ("agent_active", "assistant"),
        ("turn_complete", "turn_end"),
    ]
    assert events[-1].text == "all done"
    assert all(e.session_id == _SID and e.cwd == _CWD for e in events)


def test_parse_activity_user_message_carries_prompt_text(
    fake_copilot_root: Path,
) -> None:
    """user.message events carry data.content (truncated to 500 chars) so
    the frontend can name the pane from the first user text; the injected
    "<...>"-prefixed session-marker bootstrap stays text-less."""
    reader = CopilotLogReader()
    f = _write_session(fake_copilot_root, events=[
        _user("<!-- agent-team-session: at-pane:p1 -->", eid="ev-user-0"),
        _user("fix the login bug"),
        _user("p" * 600, eid="ev-user-2"),
    ])
    events = reader.parse_activity(f, set())
    assert [(e.detail, e.text) for e in events] == [
        ("user", ""),
        ("user", "fix the login bug"),
        ("user", "p" * 500),
    ]


def test_parse_activity_reparse_does_not_reemit(fake_copilot_root: Path) -> None:
    reader = CopilotLogReader()
    seen: set[str] = set()
    f = _write_session(fake_copilot_root, events=[
        _user(), _assistant(),
        _event("assistant.turn_end", {"turnId": "0"}, eid="ev-te"),
    ])
    assert len(reader.parse_activity(f, seen)) == 3
    assert reader.parse_activity(f, seen) == []


def test_turn_text_survives_split_poll_batches(fake_copilot_root: Path) -> None:
    """An assistant.message and its turn_end can land in different polls —
    the text is stashed in seen_keys so turn_complete still carries it."""
    reader = CopilotLogReader()
    seen: set[str] = set()
    f = _write_session(fake_copilot_root, events=[_assistant("answer text")])
    reader.parse_activity(f, seen)
    _append(f, [_event("assistant.turn_end", {"turnId": "0"}, eid="ev-te")])
    events = reader.parse_activity(f, seen)
    assert [(e.event_type, e.text) for e in events] == [
        ("turn_complete", "answer text"),
    ]


def test_truncated_trailing_line_is_retried_once_complete(
    fake_copilot_root: Path,
) -> None:
    """Text iteration yields a still-being-written trailing line; marking it
    seen would drop the assistant.turn_end forever and stall /loop."""
    reader = CopilotLogReader()
    seen: set[str] = set()
    f = _write_session(fake_copilot_root, events=[])
    raw = json.dumps(_event("assistant.turn_end", {"turnId": "0"}, eid="ev-te"))
    f.write_text(raw[:20], encoding="utf-8")
    assert reader.parse_activity(f, seen) == []

    f.write_text(raw + "\n", encoding="utf-8")
    events = reader.parse_activity(f, seen)
    assert [(e.event_type, e.detail) for e in events] == [
        ("turn_complete", "turn_end"),
    ]


# ─────────────────────────── attribution binding ─────────────────────────────

def _usage(session_id: str, file_path: Path, cwd: str = "/ws") -> TokenUsage:
    """Shape of the session-sink probe usage (_on_session_file)."""
    return TokenUsage(
        vendor="copilot", input_tokens=0, output_tokens=0, cwd=cwd,
        session_id=session_id, file_path=str(file_path), dedup_key="",
    )


@pytest.fixture
def copilot_attr(fake_copilot_root: Path, tmp_path: Path) -> tuple[Attribution, Path]:
    attr = Attribution([CopilotLogReader()], workspaces_path=tmp_path / "ws.json")
    return attr, fake_copilot_root


def test_marker_in_user_message_binds_pane(
    copilot_attr: tuple[Attribution, Path],
) -> None:
    """Copilot preserves user text verbatim in user.message data.content, so
    the kickoff's at-pane marker lands in events.jsonl; marker matching
    resolves the pane even with multiple candidates, and the resume id is
    the session dir name `copilot --resume=<id>` accepts."""
    attr, root = copilot_attr
    attr.register_pane("p1", vendor="copilot", cwd="/ws", workspace_path="/ws",
                       session_marker="at-pane:p1")
    attr.register_pane("p2", vendor="copilot", cwd="/ws", workspace_path="/ws",
                       session_marker="at-pane:p2")
    f = _write_session(root, sid="sess-two", cwd="/ws", events=[
        _session_start(cwd="/ws", sid="sess-two"),
        _user("hi <!-- agent-team-session: at-pane:p2 -->"),
    ])

    binding = attr.maybe_announce_session(_usage("sess-two", f))
    assert binding is not None
    assert binding.pane_id == "p2"
    assert binding.resume_id == "sess-two"
    assert binding.workspace_path == "/ws"


def test_single_candidate_fallback_still_binds_a_markerless_session(
    copilot_attr: tuple[Attribution, Path],
) -> None:
    """Copilot binds through the shared-store path, but attribution must FALL
    THROUGH when that scan finds nothing.

    Copilot's at-pane marker is typed into the TUI, so injection can lose the
    startup race and leave no marker anywhere. Returning unconditionally from
    the shared-db path stranded such a pane forever — and an unbound pane
    resumes with an unknown id, which copilot answers by silently opening a
    blank new session.
    """
    attr, root = copilot_attr
    assert CopilotLogReader.binds_new_session_single_candidate is True
    attr.register_pane("p1", vendor="copilot", cwd="/ws", workspace_path="/ws",
                       session_marker="at-pane:p1")
    f = _write_session(root, sid="sess-new", cwd="/ws", events=[
        _session_start(cwd="/ws", sid="sess-new"), _user("no marker"),
    ])

    binding = attr.maybe_announce_session(_usage("sess-new", f))
    assert binding is not None
    assert binding.pane_id == "p1"
    assert binding.resume_id == "sess-new"


def test_single_candidate_fallback_does_not_override_marker_binding(
    copilot_attr: tuple[Attribution, Path],
) -> None:
    """The fallback is a last resort: with two candidate panes it must stay
    out of the way so marker matching can resolve them later."""
    attr, root = copilot_attr
    attr.register_pane("p1", vendor="copilot", cwd="/ws", workspace_path="/ws",
                       session_marker="at-pane:p1")
    attr.register_pane("p2", vendor="copilot", cwd="/ws", workspace_path="/ws",
                       session_marker="at-pane:p2")
    f = _write_session(root, sid="sess-ambiguous", cwd="/ws", events=[
        _session_start(cwd="/ws", sid="sess-ambiguous"), _user("no marker"),
    ])

    assert attr.maybe_announce_session(_usage("sess-ambiguous", f)) is None


def test_marker_never_cross_binds_another_workspace(
    copilot_attr: tuple[Attribution, Path],
) -> None:
    """A marker echoed by a session running in a different project must not
    bind this pane — neither through the marker scan (Attribution's workspace
    gate over the reader's cwd) nor through the single-candidate fallback the
    marker scan now falls through to, which gates on the same cwd.

    The probe carries cwd="/other" because that is what the session sink
    builds: _on_session_file fills usage.cwd from reader.cwd_from_file(path),
    i.e. this session's workspace.yaml — not the pane's.
    """
    attr, root = copilot_attr
    attr.register_pane("p1", vendor="copilot", cwd="/ws", workspace_path="/ws",
                       session_marker="at-pane:p1")
    f = _write_session(root, sid="sess-elsewhere", cwd="/other", events=[
        _session_start(cwd="/other", sid="sess-elsewhere"),
        _user("hi <!-- agent-team-session: at-pane:p1 -->"),
    ])
    assert attr.maybe_announce_session(
        _usage("sess-elsewhere", f, cwd="/other")) is None


def test_workspace_attribution_via_workspace_yaml_cwd(
    copilot_attr: tuple[Attribution, Path],
) -> None:
    """Token events attribute to the registered workspace by usage.cwd
    equality (the reader emits the workspace.yaml cwd)."""
    attr, root = copilot_attr
    attr.register_workspace("/ws")
    reader = CopilotLogReader()
    f = _write_session(root, sid="sess-x", cwd="/ws", events=[
        _shutdown(input=5, cache_read=0, cache_write=0, output=2),
    ])
    usage = reader.parse_session_file(f, set())[0]
    assert attr.attribute(usage).workspace_path == "/ws"
    # An event from an unregistered cwd is dropped by the sink layer.
    f2 = _write_session(root, sid="sess-y", cwd="/elsewhere", events=[
        _shutdown(input=5, cache_read=0, cache_write=0, output=2),
    ])
    usage2 = reader.parse_session_file(f2, set())[0]
    assert attr.attribute(usage2).workspace_path is None


# ══════════════════════ 1.0.78+ central session store ════════════════════════

# ─────────────────────────── claiming / layout ───────────────────────────────

def test_root_is_claimed_so_the_store_is_seen(fake_copilot_root: Path) -> None:
    """project_dirs() must be the ROOT, not session-state: claims_path() and
    watch_dirs() derive from it, and session-store.db sits one level above
    session-state. Scoping to session-state is exactly what left 1.0.78
    sessions unread."""
    reader = CopilotLogReader()
    db = _store(fake_copilot_root)
    events = _write_session(fake_copilot_root, sid="sid-old")

    assert reader.project_dirs() == [fake_copilot_root]
    assert reader.claims_path(db.resolve()) is True
    assert reader.claims_path(events.resolve()) is True
    assert set(reader.session_files()) == {db, events}
    # The store spans every workspace, so it can never be scoped away.
    assert db in reader.session_files_for_workspace("/nowhere")


def test_store_session_id_from_path_and_unrelated_root_files(
    fake_copilot_root: Path,
) -> None:
    """The store gets a non-empty pseudo id purely so the session sink
    proceeds to marker binding (grok.db does the same); everything else under
    the root stays '' so no bogus resume id is ever coined."""
    reader = CopilotLogReader()
    db = _store(fake_copilot_root)
    assert reader.session_id_from_path(db) == "session-store"
    assert reader.cwd_from_file(db) == ""
    for name in ("config.json", "settings.json", "vscode.session.metadata.cache.json"):
        assert reader.session_id_from_path(fake_copilot_root / name) == ""


def test_unrelated_root_files_parse_to_nothing(fake_copilot_root: Path) -> None:
    """Widening project_dirs() routes ~/.copilot/config.json here too; every
    parse path must no-op on it rather than treat it as a session file."""
    reader = CopilotLogReader()
    fake_copilot_root.mkdir(parents=True, exist_ok=True)
    cfg = fake_copilot_root / "config.json"
    cfg.write_text('{"lastLoggedInUser": {"login": "me"}}', encoding="utf-8")
    assert reader.parse_session_file(cfg, set()) == []
    assert reader.parse_activity(cfg, set()) == []
    parsed = reader.parse_incremental(cfg, {})
    assert parsed.events == []
    assert parsed.checkpoint == {}


# ─────────────────────────── store token parsing ─────────────────────────────

def test_store_token_columns_are_already_folded(fake_copilot_root: Path) -> None:
    """input_tokens ALREADY includes cache read+write and output_tokens
    already includes reasoning (measured: 19898 == 9 + 0 + 19889, matching
    that session's 1.0.75 events.jsonl byte for byte). Re-adding the cache
    columns here would double-count, so they pass straight through."""
    reader = CopilotLogReader()
    db = _store(fake_copilot_root)
    _add_session(db)
    _add_usage(db)

    events = reader.parse_session_file(db, set())
    assert len(events) == 1
    ev = events[0]
    assert ev.vendor == "copilot"
    assert ev.input_tokens == 19898
    assert ev.output_tokens == 39
    assert ev.cwd == _CWD
    assert ev.session_id == _SID
    assert ev.model == "claude-haiku-4.5"
    assert ev.timestamp == _TS
    assert ev.dedup_key == "copilot_usage::1"


def test_store_wins_over_the_same_sessions_events_jsonl(
    fake_copilot_root: Path,
) -> None:
    """One run recorded twice must be credited once.

    1.0.75 wrote BOTH the store and events.jsonl for the same session
    (measured: sessions.created_at 1ms before the events.jsonl session.start,
    identical totals). The two branches' dedup_keys AND file_paths differ, so
    no downstream dedup can tell they describe the same tokens — the store is
    the authority and the events.jsonl file yields nothing at all, tokens and
    activity alike.
    """
    reader = CopilotLogReader()
    db = _store(fake_copilot_root)
    _add_session(db)
    _add_usage(db, input_tokens=100, output_tokens=10)
    _add_turn(db)
    f = _write_session(fake_copilot_root, events=[
        _session_start(), _user("hi"), _assistant("ok"),
        _event("assistant.turn_end", {}),
        _shutdown(input=100, cache_read=0, cache_write=0, output=10),
    ])

    store_events = reader.parse_session_file(db, set())
    assert [(e.input_tokens, e.output_tokens) for e in store_events] == [(100, 10)]
    assert reader.parse_session_file(f, set()) == []
    assert reader.parse_incremental(f, {}).events == []
    assert reader.parse_activity(f, set()) == []


def test_events_jsonl_still_read_when_the_store_lacks_the_session(
    fake_copilot_root: Path,
) -> None:
    """The store only owns the sessions it actually lists: one holding a
    different session leaves the events.jsonl fallback in charge."""
    reader = CopilotLogReader()
    db = _store(fake_copilot_root)
    _add_session(db, sid="a-different-session")
    f = _write_session(fake_copilot_root, events=[
        _shutdown(input=100, cache_read=0, cache_write=0, output=10),
    ])

    events = reader.parse_session_file(f, set())
    assert [(e.input_tokens, e.output_tokens) for e in events] == [(100, 10)]


def test_store_zero_token_rows_are_skipped(fake_copilot_root: Path) -> None:
    reader = CopilotLogReader()
    db = _store(fake_copilot_root)
    _add_session(db)
    _add_usage(db, input_tokens=0, output_tokens=0, cache_read=0,
               cache_write=0, reasoning=0)
    assert reader.parse_session_file(db, set()) == []


def test_store_incremental_watermark_never_recounts(
    fake_copilot_root: Path,
) -> None:
    """Live per-API-call rows: each poll credits only rows above the row-id
    watermark, so a long-running session accrues tokens without ever
    re-counting what it already reported."""
    reader = CopilotLogReader()
    db = _store(fake_copilot_root)
    _add_session(db)
    _add_usage(db, input_tokens=100, output_tokens=10)

    p1 = reader.parse_incremental(db, {})
    assert [(e.input_tokens, e.output_tokens) for e in p1.events] == [(100, 10)]
    assert p1.checkpoint["kind"] == "sqlite"
    assert p1.checkpoint["row_id"] == 1
    # Same store again: nothing new.
    assert reader.parse_incremental(db, p1.checkpoint).events == []

    _add_usage(db, input_tokens=40, output_tokens=5)
    p2 = reader.parse_incremental(db, p1.checkpoint)
    assert [(e.input_tokens, e.output_tokens) for e in p2.events] == [(40, 5)]
    assert p2.checkpoint["row_id"] == 2
    assert reader.parse_incremental(db, p2.checkpoint).events == []
    # Totals credited == totals written, exactly once.
    assert sum(e.input_tokens for e in p1.events + p2.events) == 140


def test_store_watermark_rollback_reanchors_without_rescan(
    fake_copilot_root: Path,
) -> None:
    """If the store is rebuilt/truncated under the same inode the watermark
    outruns MAX(id). Re-anchor to the new max — rescanning from 0 would credit
    the surviving history a second time."""
    reader = CopilotLogReader()
    db = _store(fake_copilot_root)
    _add_session(db)
    for _ in range(3):
        _add_usage(db, input_tokens=100, output_tokens=10)
    p1 = reader.parse_incremental(db, {})
    assert len(p1.events) == 3
    assert p1.checkpoint["row_id"] == 3

    _exec(db, "DELETE FROM assistant_usage_events WHERE id > 1")
    p2 = reader.parse_incremental(db, p1.checkpoint)
    assert p2.events == []
    assert p2.checkpoint["row_id"] == 1  # re-anchored, not reset to 0

    _add_usage(db, input_tokens=7, output_tokens=3)  # reuses id 2
    p3 = reader.parse_incremental(db, p2.checkpoint)
    assert [(e.input_tokens, e.output_tokens) for e in p3.events] == [(7, 3)]


def test_store_replacement_resets_the_watermark(fake_copilot_root: Path) -> None:
    """A different inode is a different store — start from the beginning."""
    reader = CopilotLogReader()
    db = _store(fake_copilot_root)
    _add_session(db)
    _add_usage(db, input_tokens=100, output_tokens=10)
    p1 = reader.parse_incremental(db, {})
    assert len(p1.events) == 1

    replacement = fake_copilot_root / "replacement.db"
    con = sqlite3.connect(replacement)
    con.executescript(_STORE_SCHEMA)
    con.commit()
    con.close()
    _add_session(replacement, sid="sid-fresh", cwd=_CWD)
    _add_usage(replacement, sid="sid-fresh", input_tokens=55, output_tokens=6)
    os.replace(replacement, db)

    p2 = reader.parse_incremental(db, p1.checkpoint)
    assert [(e.input_tokens, e.output_tokens) for e in p2.events] == [(55, 6)]


def test_store_replacement_on_a_reused_inode_resets_the_watermark(
    fake_copilot_root: Path,
) -> None:
    """Linux hands a freed inode number to the next file created in its place,
    so the replacement can carry the very identity the checkpoint recorded."""
    reader = CopilotLogReader()
    db = _store(fake_copilot_root)
    _add_session(db)
    _add_usage(db, input_tokens=100, output_tokens=10)
    p1 = reader.parse_incremental(db, {})
    assert len(p1.events) == 1

    replacement = fake_copilot_root / "replacement.db"
    con = sqlite3.connect(replacement)
    con.executescript(_STORE_SCHEMA)
    con.commit()
    con.close()
    _add_session(replacement, sid="sid-fresh", cwd=_CWD)
    _add_usage(replacement, sid="sid-fresh", input_tokens=55, output_tokens=6)
    os.replace(replacement, db)
    stat = db.stat()
    same_inode = {**p1.checkpoint, "identity": f"{stat.st_dev}:{stat.st_ino}"}

    p2 = reader.parse_incremental(db, same_inode)
    assert [(e.input_tokens, e.output_tokens) for e in p2.events] == [(55, 6)]
    # The new store is now the tracked one: nothing is credited twice.
    assert reader.parse_incremental(db, p2.checkpoint).events == []


# ─────────────────────────── store activity ──────────────────────────────────

def test_store_turn_row_emits_user_active_then_turn_complete(
    fake_copilot_root: Path,
) -> None:
    """A `turns` row IS the turn boundary and carries both sides of it, so it
    yields the user's agent_active (pane auto-naming) followed by
    turn_complete carrying assistant_response (inter-CLI messaging)."""
    reader = CopilotLogReader()
    db = _store(fake_copilot_root)
    _add_session(db)
    _add_turn(db, user="fix the login bug", assistant="all done")

    events = reader.parse_activity(db, set())
    assert [(e.event_type, e.detail) for e in events] == [
        ("agent_active", "user"),
        ("turn_complete", "turn_row"),
    ]
    assert events[0].text == "fix the login bug"
    assert events[1].text == "all done"
    # A real, parseable timestamp: the frontend dedups messaging turns by it
    # and treats an unparseable one as always-fresh (resend + replay).
    assert all(e.timestamp == _TS for e in events)
    assert all(e.session_id == _SID and e.cwd == _CWD for e in events)


def test_store_usage_rows_are_in_turn_heartbeats(fake_copilot_root: Path) -> None:
    """assistant_usage_events land DURING a turn, so they keep the pane marked
    active before any turn row exists — and turn_complete still closes the
    batch when both arrive in one poll."""
    reader = CopilotLogReader()
    seen: set[str] = set()
    db = _store(fake_copilot_root)
    _add_session(db)
    _add_usage(db)

    mid_turn = reader.parse_activity(db, seen)
    assert [(e.event_type, e.detail) for e in mid_turn] == [
        ("agent_active", "assistant"),
    ]
    _add_usage(db)
    _add_turn(db)
    closing = reader.parse_activity(db, seen)
    assert [(e.event_type, e.detail) for e in closing] == [
        ("agent_active", "assistant"),
        ("agent_active", "user"),
        ("turn_complete", "turn_row"),
    ]
    # Re-polling an unchanged store emits nothing.
    assert reader.parse_activity(db, seen) == []


def test_store_marker_bootstrap_turn_carries_no_pane_name(
    fake_copilot_root: Path,
) -> None:
    """The injected "<...>"-prefixed marker bootstrap must not become the
    pane's auto-name (shared user_prompt_text filter)."""
    reader = CopilotLogReader()
    db = _store(fake_copilot_root)
    _add_session(db)
    _add_turn(db, index=0, user="<!-- agent-team-session: at-pane:p1 -->")
    _add_turn(db, index=1, user="p" * 600)

    texts = [e.text for e in reader.parse_activity(db, set())
             if e.detail == "user"]
    assert texts == ["", "p" * 500]


# ─────────────────────────── store marker binding ────────────────────────────

def test_find_sessions_by_marker_reads_turn_user_messages(
    fake_copilot_root: Path,
) -> None:
    reader = CopilotLogReader()
    db = _store(fake_copilot_root)
    _add_session(db, sid="sess-a", cwd="/proj/a")
    _add_session(db, sid="sess-b", cwd="/proj/b")
    _add_turn(db, sid="sess-a", user="hi <!-- agent-team-session: at-pane:p1 -->")
    _add_turn(db, sid="sess-b", user="hi <!-- agent-team-session: at-pane:p2 -->")

    found = reader.find_sessions_by_marker(["at-pane:p2", "at-pane:p9"])
    assert found == {"at-pane:p2": ("sess-b", "/proj/b")}
    assert reader.find_sessions_by_marker([]) == {}


def test_find_sessions_by_marker_falls_back_to_events_jsonl(
    fake_copilot_root: Path,
) -> None:
    """1.0.75 layouts have no store at all, and Attribution's shared-db path
    returns before the per-file marker path can run — so the events.jsonl scan
    has to live here or old sessions stop binding entirely."""
    reader = CopilotLogReader()
    _write_session(fake_copilot_root, sid="sess-old", cwd="/proj/old", events=[
        _session_start(cwd="/proj/old", sid="sess-old"),
        _user("hi <!-- agent-team-session: at-pane:p1 -->"),
    ])
    assert not (fake_copilot_root / "session-store.db").exists()
    assert reader.find_sessions_by_marker(["at-pane:p1"]) == {
        "at-pane:p1": ("sess-old", "/proj/old"),
    }


def test_store_marker_binds_pane_end_to_end(
    copilot_attr: tuple[Attribution, Path],
) -> None:
    """Attribution's shared-store path resolves the marker to the session id
    `copilot --resume=<id>` accepts."""
    attr, root = copilot_attr
    db = _store(root)
    attr.register_pane("p1", vendor="copilot", cwd="/ws", workspace_path="/ws",
                       session_marker="at-pane:p1")
    attr.register_pane("p2", vendor="copilot", cwd="/ws", workspace_path="/ws",
                       session_marker="at-pane:p2")
    _add_session(db, sid="sess-two", cwd="/ws")
    _add_turn(db, sid="sess-two",
              user="hi <!-- agent-team-session: at-pane:p2 -->")

    binding = attr.maybe_announce_session(_usage("session-store", db, cwd=""))
    assert binding is not None
    assert binding.pane_id == "p2"
    assert binding.resume_id == "sess-two"
    assert binding.workspace_path == "/ws"


def test_store_marker_confirms_a_usage_claim_by_the_same_pane(
    copilot_attr: tuple[Attribution, Path],
) -> None:
    """A store created after the pane registered is outside its baseline, so
    the in-turn usage row claims the session silently before the turn row
    carrying the marker lands. The marker must still announce that binding
    once, or the pane never learns its resume id."""
    attr, root = copilot_attr
    attr.register_pane("p1", vendor="copilot", cwd="/ws", workspace_path="/ws",
                       session_marker="at-pane:p1")
    db = _store(root)
    _add_session(db, sid="sess-one", cwd="/ws")
    _add_usage(db, sid="sess-one")
    for usage in CopilotLogReader().parse_session_file(db, set()):
        attr.attribute(usage)
    assert attr.pane_for_session("sess-one")[0] == "p1"

    _add_turn(db, sid="sess-one", user="hi <!-- agent-team-session: at-pane:p1 -->")
    binding = attr.maybe_announce_session(_usage("session-store", db, cwd=""))
    assert binding is not None
    assert (binding.pane_id, binding.resume_id) == ("p1", "sess-one")
    assert attr.maybe_announce_session(_usage("session-store", db, cwd="")) is None


# ─────────────────────────── failure tolerance ───────────────────────────────

def test_store_failures_never_raise_and_fall_back_to_events_jsonl(
    fake_copilot_root: Path,
) -> None:
    """A corrupt/locked/schema-drifted store is "no new data this cycle": the
    reader stays silent-safe AND the events.jsonl branch keeps working."""
    reader = CopilotLogReader()
    fake_copilot_root.mkdir(parents=True, exist_ok=True)
    db = fake_copilot_root / "session-store.db"
    db.write_bytes(b"this is not a sqlite database at all")
    f = _write_session(fake_copilot_root, events=[
        _shutdown(input=7, cache_read=0, cache_write=0, output=3),
    ])

    assert reader.parse_session_file(db, set()) == []
    assert reader.parse_activity(db, set()) == []
    assert reader.parse_incremental(db, {}).events == []
    assert reader.find_sessions_by_marker(["at-pane:p1"]) == {}
    # The old path is untouched by the store's failure.
    assert [(e.input_tokens, e.output_tokens)
            for e in reader.parse_session_file(f, set())] == [(7, 3)]


def test_store_failure_warns_exactly_once(
    fake_copilot_root: Path, caplog: pytest.LogCaptureFixture,
) -> None:
    """The 1.0.78 move went unnoticed for weeks because this reader never said
    anything when its input vanished. A store read that fails must leave one
    WARNING in the app log — and only one, so a locked store can't spam it."""
    reader = CopilotLogReader()
    fake_copilot_root.mkdir(parents=True, exist_ok=True)
    db = fake_copilot_root / "session-store.db"
    db.write_bytes(b"not sqlite")

    with caplog.at_level(logging.WARNING,
                         logger="agent_team_backend.log_readers.copilot"):
        for _ in range(3):
            reader.parse_session_file(db, set())
            reader.parse_activity(db, set())
    warnings = [r for r in caplog.records if r.levelno >= logging.WARNING]
    assert len(warnings) == 1
    assert "session-store" in warnings[0].getMessage()


def test_missing_store_is_not_a_failure(
    fake_copilot_root: Path, caplog: pytest.LogCaptureFixture,
) -> None:
    """No store = an older CLI (or none installed), which is normal and must
    not warn."""
    reader = CopilotLogReader()
    _write_session(fake_copilot_root, sid="sid-old")
    with caplog.at_level(logging.WARNING,
                         logger="agent_team_backend.log_readers.copilot"):
        assert reader.find_sessions_by_marker(["at-pane:p1"]) == {}
        assert reader.session_files() == [
            fake_copilot_root / "session-state" / "sid-old" / "events.jsonl",
        ]
    assert [r for r in caplog.records if r.levelno >= logging.WARNING] == []


# ─────────────────────────── shared surface ──────────────────────────────────

def test_has_session_prefers_store_turns(fake_copilot_root: Path) -> None:
    """A store session only counts once it has a turn: resuming a zero-turn
    session restores nothing, the same failure `--resume=<stale-id>` silently
    produces. events.jsonl stays the 1.0.75 fallback."""
    reader = CopilotLogReader()
    db = _store(fake_copilot_root)
    _add_session(db, sid="sid-empty")
    _add_session(db, sid="sid-real")
    _add_turn(db, sid="sid-real")

    assert reader.has_session("sid-real") is True
    assert reader.has_session("sid-empty") is False
    assert reader.has_session("sid-unknown") is False
    _write_session(fake_copilot_root, sid="sid-legacy")
    assert reader.has_session("sid-legacy") is True


def test_workspace_and_pane_match_normalize_symlinked_roots(
    fake_copilot_root: Path, tmp_path: Path,
) -> None:
    """sessions.cwd records the CLI's RESOLVED launch dir (macOS: /private/tmp/…)
    while a pane may carry the symlink form (/tmp/…); a plain string compare
    would drop every such event."""
    reader = CopilotLogReader()
    real = tmp_path / "real-workspace"
    real.mkdir()
    link = tmp_path / "linked-workspace"
    link.symlink_to(real)

    db = _store(fake_copilot_root)
    _add_session(db, sid="sid-link", cwd=str(real))
    _add_usage(db, sid="sid-link", input_tokens=11, output_tokens=2)
    usage = reader.parse_session_file(db, set())[0]

    assert reader.workspace_match(usage, str(link)) is True
    assert reader.workspace_match(usage, str(real)) is True
    assert reader.workspace_match(usage, str(tmp_path / "elsewhere")) is False
    assert reader.workspace_match(usage, "") is False
    assert reader.pane_cwd_match(usage, str(link), "p1") is True
    assert reader.pane_cwd_match(usage, str(tmp_path / "elsewhere"), "p1") is False


def test_parse_activity_resumes_after_an_append(fake_copilot_root: Path, monkeypatch) -> None:
    from tests.activity_resume_support import assert_resumes

    f = _write_session(fake_copilot_root, events=[
        _session_start(), _user("first"), _assistant("one"),
        _event("assistant.turn_end", {"turnId": "0"}, eid="ev-te"),
    ])
    assert_resumes(CopilotLogReader, f, [
        _user("second", eid="ev-u2"), _assistant("two", eid="ev-a2"),
        _event("assistant.turn_end", {"turnId": "1"}, eid="ev-te2"),
    ], monkeypatch)

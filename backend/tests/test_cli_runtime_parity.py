"""The Rust CLI runtime (native/navide-cli-runtime) against main's Python readers.

Each scenario below is built from the record builders of main's own vendor
tests, written step by step into a fake CLI home, and read the way the log
watcher reads it: ``parse_incremental`` with the previous checkpoint,
``parse_activity`` with one persistent seen-keys bag and one reader, and
finally ``turns_for_session``.

* The Python results are the parity fixtures the Rust crate replays
  (``native/navide-cli-runtime/tests/parity/*.json``). Run with
  ``NAVIDE_PARITY_WRITE=1`` to rewrite them; otherwise this test fails when
  main's readers no longer produce what the fixtures record.
* With the ``rustCliRuntime`` switch off, a wrapped reader is main's reader.
* With it on (and a built ``navide-cli-runtime``), the wrapped reader answers
  through the Rust process and must match Python result for result.
"""

from __future__ import annotations

import base64
import dataclasses
import sqlite3
import json
import os
import re
import sys
import time
import unicodedata
from pathlib import Path
from typing import Any, Callable

import pytest

from agent_team_backend import cli_runtime, osplat
from agent_team_backend.cli_vendors import opencode as opencode_vendor
from agent_team_backend.cli_vendors.pi import encode_pi_cwd
from agent_team_backend.cli_vendors.registry import vendor as cli_vendor
from agent_team_backend.log_readers.claude import encode_claude_cwd
from tests import cli_runtime_build
from tests.vendors import test_aider as aider_t
from tests.vendors import test_antigravity_activity as agy_t
from tests.vendors import test_claude as claude_t
from tests.vendors import test_cursor as cursor_t
from tests.vendors import test_codex_0_163_fixture as codex_t
from tests.vendors import test_codex_subagent as sub_t
from tests.vendors import test_copilot as cop_t
from tests.vendors import test_droid as droid_t
from tests.vendors import test_goose as goose_t
from tests.vendors import test_grok as grok_t
from tests.vendors import test_hermes as hermes_t
from tests.vendors import test_kimi_code_2_2_fixture as kimi_t
from tests.vendors import test_muse as muse_t
from tests.vendors import test_openclaw as oc_t
from tests.vendors import test_opencode as opc_t
from tests.vendors import test_opencode_v2 as opc2_t
from tests.vendors import test_pi as pi_t
from tests.vendors import test_qwen_0_25_fixture as qwen_t

FIXTURES = Path(__file__).resolve().parents[2] / "native" / "navide-cli-runtime" / "tests" / "parity"
#: Fixed clock base (seconds); every step's mtime and "now" are offsets from it.
B = 1_792_000_000

USAGE_FIELDS = ("vendor", "input_tokens", "output_tokens", "cwd", "session_id", "file_path", "dedup_key",
                "timestamp", "model", "checkpoint", "raw", "cache_read_tokens", "cache_creation_tokens",
                "cli_version")
ACTIVITY_FIELDS = ("vendor", "event_type", "cwd", "session_id", "file_path", "dedup_key", "timestamp",
                   "detail", "text")
TURN_FIELDS = ("turn_index", "session_id", "started_at", "ended_at", "prompt_excerpt", "input", "cache_read",
               "cache_creation", "output", "calls", "model_calls", "cli_version")


def _lines(records: list[dict]) -> str:
    return "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in records)


def _step(mode: str, records: list[dict] | None, mtime: float, now: float, sidecars: dict[str, str] | None = None,
          **extra: Any) -> dict:
    """One watcher poll; `sidecars` are files (re)written beside the transcript first.

    `mode` is "write" (truncate and write), "append", or "replace" (a new file
    renamed over the old one, so its identity changes). `extra`: `tail` (raw
    text after the records), `b64` (raw bytes after that), `checkpoint_drop`
    (keys removed from the usage checkpoint before the read, as an older build
    left it) and `bag_add` (keys already in the seen-keys bag)."""
    step = {"mode": mode, "text": _lines(records or []) + extra.pop("tail", ""), "mtime": B + mtime, "now": B + now}
    if sidecars:
        step["sidecars"] = sidecars
    step.update(extra)
    return step


def _text_step(mode: str, text: str, mtime: float, now: float) -> dict:
    """One poll of a plain-text transcript (aider's Markdown history)."""
    return {"mode": mode, "text": text, "mtime": B + mtime, "now": B + now}


def _db_step(statements: list[tuple[str, tuple] | str], mtime: float, now: float, **extra: Any) -> dict:
    """One poll of a SQLite CLI: the statements run (a bare string is a script), then the readers read.
    The fixture records the database file's bytes after the step, which the Rust test writes back.
    `extra`: as for `_step` (`checkpoint_drop`, `bag_add`)."""
    sql = [[s, None] if isinstance(s, str) else [s[0], list(s[1])] for s in statements]
    return {"mode": "db", "sql": sql, "mtime": B + mtime, "now": B + now, **extra}


def _scenarios() -> dict[str, dict]:
    qwen = qwen_t._chat_0_25()
    kimi = kimi_t._records(B * 1000)
    codex = codex_t._rollout_0163()
    pi_head = [pi_t._header(), pi_t._user("u1", "fix the parser"), pi_t._assistant("a1", "u1", input=120, cache_read=30)]
    pi_more = [pi_t._compaction("c1", "a1"), pi_t._user("u2", [{"type": "text", "text": "and the tests"}], "c1"),
               pi_t._assistant_saying("a2", "all green", "u2")]
    sub_day = "home/.codex-panes/pane-1/sessions/2026/09/05"
    sub_parent = [
        sub_t._parent_meta(),
        sub_t._ev("2026-09-05T01:10:40Z", "task_started", turn_id="p1"),
        sub_t._prompt("2026-09-05T01:10:40Z", "Refactor the parser"),
        sub_t._tokens("2026-09-05T01:10:50Z", 1000, 100),
        sub_t._ev("2026-09-05T01:12:00Z", "agent_message", message="Parent's answer"),
        sub_t._tokens("2026-09-05T01:12:00Z", 3000, 300),
        sub_t._ev("2026-09-05T01:12:01Z", "task_complete", turn_id="p1", last_agent_message="Parent's answer"),
    ]
    sub_child = [
        sub_t._child_meta(),
        sub_t._parent_meta(),
        sub_t._ev("2026-09-05T01:10:58Z", "task_started", turn_id="c1"),
        sub_t._prompt("2026-09-05T01:10:58Z", "Explore the cloud folder"),
        sub_t._tokens("2026-09-05T01:11:10Z", 24796, 50),
        sub_t._ev("2026-09-05T01:11:20Z", "agent_message", message="Child's findings"),
        sub_t._ev("2026-09-05T01:11:21Z", "task_complete", turn_id="c1", last_agent_message="Child's findings"),
        sub_t._ev("2026-09-05T01:13:00Z", "task_started", turn_id="c2"),
        sub_t._ev("2026-09-05T01:13:05Z", "turn_aborted", turn_id="c2", reason="interrupted"),
    ]
    claude = [
        claude_t._prompt_line("p1", "幫我修 login bug", "2026-09-16T00:00:00Z"),
        claude_t._assistant_line("m1", "r1", "2026-09-16T00:00:01Z", inp=2, cr=100, cc=40, out=10),
        claude_t._assistant_line("m1", "r1", "2026-09-16T00:00:02Z", inp=2, cr=100, cc=40, out=10),
        claude_t._tool_result_line("p1", "2026-09-16T00:00:03Z"),
        claude_t._assistant_line("m2", "r2", "2026-09-16T00:00:05Z", inp=3, cr=200, cc=0, out=20, stop="end_turn"),
        claude_t._prompt_line("p2", [{"type": "text", "text": "再來一次"}, {"type": "image"}], "2026-09-16T00:01:00Z"),
        {"type": "user", "promptId": "p2", "timestamp": "2026-09-16T00:01:02Z",
         "message": {"role": "user", "content": [{"type": "text", "text": "[Request interrupted by user]"}]}},
        {"type": "summary", "summary": "resumed"},
        claude_t._prompt_line("p3", "after resume", "2026-09-16T01:00:00Z"),
        claude_t._assistant_line("m3", "r3", "2026-09-16T01:00:04Z", inp=1, cr=300, cc=5, out=7, stop="end_turn"),
    ]
    # A workspace path with decomposed characters ("é" as e + U+0301): main
    # NFC-normalises the cwd it reads from the transcript.
    nfd_cwd = "/tmp/café"

    def claude_tool_result(ts: str, result: dict) -> dict:
        return {"type": "user", "promptId": "p1", "timestamp": ts, "toolUseResult": result,
                "message": {"role": "user", "content": [{"type": "tool_result", "content": "ok"}]}}

    def claude_tools(msg_id: str, ts: str, *tools: tuple[str, dict], text: str = "") -> dict:
        content = ([{"type": "text", "text": text}] if text else []) + [
            {"type": "tool_use", "name": name, "input": tool_input} for name, tool_input in tools]
        return {"type": "assistant", "requestId": f"req-{msg_id}", "timestamp": ts,
                "message": {"id": msg_id, "model": "claude-opus-4-7", "stop_reason": "tool_use", "content": content,
                            "usage": {"input_tokens": 5, "cache_read_input_tokens": 0,
                                      "cache_creation_input_tokens": 0, "output_tokens": 2,
                                      "cache_creation": {"ephemeral_1h_input_tokens": 3}}}}

    notification = "<task-notification><task-id>ag-1</task-id><status>completed</status></task-notification>"
    claude_rules = [
        dict(claude_t._prompt_line("p1", "start the work", "2026-09-17T00:00:00Z"), cwd=nfd_cwd, version="2.1.304"),
        claude_tools("q1", "2026-09-17T00:00:01Z", ("AskUserQuestion", {"questions": []}), text="asking"),
        claude_tool_result("2026-09-17T00:00:02Z", {"backgroundTaskId": "bg-1"}),
        claude_tool_result("2026-09-17T00:00:03Z", {"status": "async_launched", "agentId": "ag-1"}),
        claude_tool_result("2026-09-17T00:00:04Z", {"status": "forked", "background": True, "agentId": "ag-2"}),
        claude_tool_result("2026-09-17T00:00:05Z", {"status": "forked", "agentId": "ag-3"}),
        claude_tools("s1", "2026-09-17T00:00:06Z", ("TaskStop", {"task_id": "bg-1"}), ("KillShell", {"shell_id": "sh-9"}),
                     ("KillBash", {}), ("Read", {"file_path": "a.py"})),
        {"type": "queue-operation", "operation": "enqueue", "timestamp": "2026-09-17T00:00:07Z", "content": notification},
        {"type": "queue-operation", "operation": "dequeue", "timestamp": "2026-09-17T00:00:08Z"},
        {"type": "queue-operation", "operation": "enqueue", "timestamp": "2026-09-17T00:00:08Z",
         "content": "<task-notification><task-id>ag-2</task-id></task-notification>"},
        {"type": "user", "isCompactSummary": True, "timestamp": "2026-09-17T00:00:09Z",
         "message": {"role": "user", "content": "This session is being continued from a previous conversation."}},
        {"type": "user", "isMeta": True, "timestamp": "2026-09-17T00:00:10Z",
         "message": {"role": "user", "content": "<local-command-caveat>caveat</local-command-caveat>"}},
        {"type": "tool_use", "timestamp": "2026-09-17T00:00:11Z"},
        {"type": "user", "timestamp": "2026-09-17T00:00:12Z", "message": "not an object"},
        claude_t._assistant_line("e1", "r9", "2026-09-17T00:00:13Z", inp=1, cr=2, cc=3, out=4, stop="end_turn"),
    ]
    claude_bad = [
        claude_t._prompt_line("p1", "before the bad line", "2026-09-18T00:00:00Z"),
        claude_t._assistant_line("m1", "r1", "2026-09-18T00:00:01Z", inp=4, cr=0, cc=0, out=2, stop="end_turn"),
    ]
    # A line that is not UTF-8, then a good one.
    claude_bad_bytes = base64.b64encode(
        b'{"type":"assistant","timestamp":"2026-09-18T00:00:02Z","message":{"content":"\xff\xfe"}}\n'
        + _lines([claude_t._assistant_line("m2", "r2", "2026-09-18T00:00:03Z", inp=7, cr=0, cc=0, out=1,
                                           stop="end_turn")]).encode()).decode("ascii")
    def probe_line(record: dict, value: str) -> str:
        """One transcript line whose JSON text main's ``json.loads`` accepts and the
        runtime's parser does not: ``value`` is raw JSON text, put in a field no
        reader looks at, so the line is a complete record with its tokens and events."""
        return json.dumps(record, ensure_ascii=False)[:-1] + ', "navide_probe": ' + value + "}\n"

    #: What the runtime's parser rejects and Python accepts: a lone UTF-16
    #: surrogate escape (Node writes one when it cuts a string inside a pair),
    #: the non-finite literals, and nesting past 128 levels.
    python_only = {
        "surrogate": '"cut \\ud83d"',
        "nan": "[NaN, Infinity, -Infinity]",
        "deep": "[" * 200 + "]" * 200,
    }
    claude_probe = [
        # With its cwd: the header slot is found on line 1, so a later line is not part of that read.
        dict(claude_t._prompt_line("p1", "before the probe line", "2026-09-19T00:00:00Z"), cwd="/tmp/demo"),
        claude_t._assistant_line("m1", "r1", "2026-09-19T00:00:01Z", inp=4, cr=0, cc=0, out=2, stop="end_turn"),
    ]
    claude_probe_line = claude_t._assistant_line("m2", "r2", "2026-09-19T00:00:03Z", inp=10, cr=5, cc=0, out=5,
                                                 stop="end_turn")
    claude_probe_after = [
        claude_t._prompt_line("p2", "after the probe line", "2026-09-19T00:01:00Z"),
        claude_t._assistant_line("m3", "r3", "2026-09-19T00:01:04Z", inp=7, cr=1, cc=0, out=1, stop="end_turn"),
    ]
    # The line is a record Python reads, in the middle of a transcript that
    # goes on after it: with the switch on the call that meets it is Python's,
    # the next one is the runtime's again, and the results are Python's.
    claude_python_only = {
        f"claude_probe_{kind}": {
            "vendor": "claude", "env": {"CLAUDE_CONFIG_DIR": "claude"},
            "file": f"claude/projects/-tmp-demo/probe-{kind}.jsonl",
            "python_reads": ["usage@1", "activity@1", "turns"],
            "steps": [_step("write", claude_probe, 0, 1),
                      _step("append", [], 1, 2, tail=probe_line(claude_probe_line, value)),
                      _step("append", claude_probe_after, 2, 3)],
        }
        for kind, value in python_only.items()
    }
    # A line that is not JSON to anyone: Python rejects it too and so skips it,
    # and so does the runtime, which hands nothing over (the control for the
    # cases above: it must not cost a Python read).
    claude_python_only["claude_probe_corrupt"] = {
        "vendor": "claude", "env": {"CLAUDE_CONFIG_DIR": "claude"},
        "file": "claude/projects/-tmp-demo/probe-corrupt.jsonl",
        "steps": [_step("write", claude_probe, 0, 1),
                  _step("append", [], 1, 2, tail="{not json}\n" + _lines([claude_probe_line])),
                  _step("append", claude_probe_after, 2, 3)],
    }
    # The same for a rollout (a byte-offset cursor for activity as well).
    codex_python_only = {
        "codex_probe_surrogate": {
            "vendor": "codex", "env": {},
            "file": f"home/.codex/sessions/2026/10/22/rollout-2026-10-22T10-00-00-{codex_t._THREAD}.jsonl",
            "python_reads": ["usage@1", "activity@1", "turns"],
            "steps": [_step("write", codex[:5], 0, 1),
                      _step("append", [], 1, 2, tail=probe_line(codex[5], python_only["surrogate"])),
                      _step("append", codex[6:12], 2, 3)],
        },
    }
    droid_dir = "droid/sessions/-tmp-demo"
    droid_sid = "d0c1e2f3-0000-4000-8000-000000000001"
    droid_settings = f"{droid_dir}/{droid_sid}.settings.json"

    def droid_totals(inp: int, out: int, cache_read: int = 0) -> dict[str, str]:
        usage = {"inputTokens": inp, "outputTokens": out, "cacheReadTokens": cache_read,
                 "cacheCreationTokens": 0, "thinkingTokens": 9}
        return {droid_settings: json.dumps({"model": "glm-4.6", "tokenUsage": usage})}

    droid = [
        droid_t._session_start(droid_sid, "/tmp/filed", lastCwd="/tmp/demo"),
        droid_t._msg("user", [{"type": "text", "text": "fix the build"}]),
        droid_t._msg("assistant", [{"type": "text", "text": "looking"}, {"type": "tool_use", "id": "t1"}]),
        droid_t._msg("user", [{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]),
        droid_t._msg("user", "echo hook", hookEventName="Stop"),
        {"type": "agent_turn_outcome", "reason": "completed", "timestamp": "2026-08-26T17:59:00.000Z"},
        droid_t._msg("user", "and the docs"),
        droid_t._msg("assistant", [{"type": "text", "text": "done"}]),
        {"type": "agent_turn_outcome", "reason": "cancelled", "timestamp": "2026-08-26T18:00:00.000Z"},
    ]
    muse_meta = muse_t._metadata()
    muse_meta["payload"]["record"]["build"] = {"semver": "0.9.1"}
    muse = [
        muse_meta, muse_t._diagnostic(2), muse_t._intake("refactor the cache", 3),
        muse_t._run({"kind": "started"}, 4), muse_t._assistant("  cache is now LRU  ", 5),
        muse_t._usage_row("u-1", 6, input_tokens=900, output_tokens=40),
        muse_t._usage_row("u-sub", 7, requester_kind="subagent"),
        muse_t._usage_row("u-0", 8, input_tokens=0, output_tokens=0),
        muse_t._terminal(9),
        muse_t._intake("/compact", 10), muse_t._usage_row("u-1", 11),
        muse_t._usage_row("u-2", 12, input_tokens=50, output_tokens=5),
        muse_t._assistant("second", 13), muse_t._terminal(14, "failed"),
    ]
    muse_dir = "share/muse/sessions/2026/08/12/" + muse_t._SID
    def goose_msg(sid: str, role: str, content: Any, meta: dict | None = None, ts: int = 1792513596) -> tuple:
        return ("INSERT INTO messages (message_id, session_id, role, content_json, created_timestamp, metadata_json)"
                " VALUES ('m', ?, ?, ?, ?, ?)",
                (sid, role, json.dumps(content), ts, json.dumps(meta or {"userVisible": True, "agentVisible": True})))

    def goose_session(sid: str, parent: str | None = None, kind: str = "user") -> tuple:
        return ("INSERT INTO sessions (id, name, session_type, working_dir, parent_session_id) VALUES (?, '', ?, ?, ?)",
                (sid, kind, goose_t.CWD, parent))

    def goose_usage(sid: str, inp: int | None, out: int | None, cache_read: int | None = None) -> tuple:
        return ("INSERT INTO usage_ledger (session_id, created_timestamp, model, input_tokens, output_tokens,"
                " cache_read_tokens, cache_write_tokens) VALUES (?, 1792513603, 'm1', ?, ?, ?, 7)",
                (sid, inp, out, cache_read))

    goose_steps = [
        _db_step([goose_t.SCHEMA, goose_session("s1"), goose_msg("s1", "user", goose_t._text("old history"))], 0, 1),
        _db_step([
            goose_msg("s1", "user", goose_t._text("fix the build"), ts=1792513600),
            goose_msg("s1", "assistant", goose_t._tool("developer__shell")),
            goose_msg("s1", "user", [{"type": "toolResponse", "id": "c"}]),
            goose_msg("s1", "assistant", [{"type": "actionRequired"}]),
            goose_msg("s1", "user", goose_t._text("injected"), meta={"turnContext": True}),
            goose_msg("s1", "assistant", goose_t._text("  built  ") + goose_t._text("and tested"), ts=1792513610),
            goose_usage("s1", 120, 30, cache_read=40), goose_usage("s1", 0, 0), goose_usage("s1", None, 5),
            goose_session("s2", parent="s1", kind="sub_agent"),
            goose_msg("s2", "assistant", goose_t._text("child done")),
            goose_msg("s1", "assistant", goose_t._text("hidden"), meta={"agentVisible": False}),
            goose_msg("s1", "system", goose_t._text("note")),
        ], 1, 2),
        _db_step([goose_msg("s1", "user", goose_t._text("again"), ts=1792513700), goose_usage("s1", 50, 5),
                  goose_msg("s1", "user", [{"type": "actionRequired"}])], 2, 3),
    ]
    def cop_usage(sid: str, inp: int | None, out: int | None, model: str = "claude-haiku-4.5",
                  ts: str | None = cop_t._TS) -> tuple:
        return ("INSERT INTO assistant_usage_events (session_id, turn_index, model, input_tokens, output_tokens,"
                " created_at) VALUES (?, 0, ?, ?, ?, ?)", (sid, model, inp, out, ts))

    def cop_turn(sid: str, index: int, user: str | None, assistant: str | None, ts: str = cop_t._TS) -> tuple:
        return ("INSERT INTO turns (session_id, turn_index, user_message, assistant_response, timestamp)"
                " VALUES (?, ?, ?, ?, ?)", (sid, index, user, assistant, ts))

    cop_steps = [
        # First sight: the store's whole history is read (usage and activity).
        _db_step([cop_t._STORE_SCHEMA,
                  ("INSERT INTO sessions (id, cwd, created_at) VALUES (?, ?, ?)", (cop_t._SID, cop_t._CWD, cop_t._TS)),
                  cop_usage(cop_t._SID, 19898, 39), cop_turn(cop_t._SID, 0, "  fix the build  ", "built")], 0, 1),
        # Rows with no tokens, with a NULL count and stamp, and of a session
        # the store does not list; a turn with a wrapper prompt and no reply.
        _db_step([cop_usage(cop_t._SID, 0, 0), cop_usage(cop_t._SID, None, 5, ts=None),
                  cop_usage("unlisted", 7, 3, model="gpt-5"),
                  cop_turn(cop_t._SID, 1, "<system-reminder>x</system-reminder>", None, ts="2026-07-27T18:40:00.000Z"),
                  cop_turn("unlisted", 0, None, "p" * 9000)], 1, 2),
        _db_step([], 2, 3),
        # The store was rebuilt and its ids restarted below the watermarks:
        # usage re-anchors at the newest id (credited under the old numbering),
        # activity starts over at the first row.
        _db_step(["DELETE FROM assistant_usage_events; DELETE FROM turns; DELETE FROM sqlite_sequence;",
                  cop_usage(cop_t._SID, 11, 2), cop_turn(cop_t._SID, 0, "again", "ok")], 3, 4),
        # Another row stands under the watermark id: it was never credited.
        _db_step(["DELETE FROM assistant_usage_events; DELETE FROM sqlite_sequence WHERE name = 'assistant_usage_events';",
                  cop_usage(cop_t._SID, 500, 50, model="gpt-5"), cop_turn(cop_t._SID, 1, "more", "done")], 4, 5),
        _db_step([cop_usage(cop_t._SID, 60, 6)], 5, 6),
    ]

    oc_now, oc_assistant = opc_t._NOW_MS, opc_t._assistant_data

    def oc_session(sid: str, parent: str | None = None, table: str = "session", version: str | None = "1.15.12") -> tuple:
        return (f"INSERT INTO {table} (id, project_id, parent_id, slug, directory, title, version, time_created,"
                " time_updated) VALUES (?, 'proj1', ?, 'slug', '/work/oc', 'title', ?, ?, ?)",
                (sid, parent, version, oc_now, oc_now))

    def oc_message(mid: str, sid: str, data: Any, updated: int = oc_now) -> tuple:
        return ("INSERT INTO message VALUES (?, ?, ?, ?, ?)",
                (mid, sid, oc_now, updated, data if isinstance(data, str) else json.dumps(data)))

    def oc_update(mid: str, data: dict) -> tuple:
        return ("UPDATE message SET data = ?, time_updated = ? WHERE id = ?", (json.dumps(data), oc_now + 20_000, mid))

    def oc_part(pid: str, mid: str, sid: str, data: Any, created: int = oc_now + 1234) -> tuple:
        return ("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)",
                (pid, mid, sid, created, created, data if isinstance(data, str) else json.dumps(data)))

    oc_tokens = {"input": 100, "output": 20, "reasoning": 5, "cache": {"read": 1000, "write": 50}}
    opencode_steps = [
        # First sight: usage credits what is complete; the parts are history.
        _db_step([opc_t._SCHEMA, oc_session("ses_a"), oc_session("ses_child", parent="ses_a", version=None),
                  oc_message("m0", "ses_a", {"role": "user"}), oc_part("p0", "m0", "ses_a", {"type": "text", "text": "old"}),
                  oc_message("m1", "ses_a", oc_assistant(oc_tokens))], 0, 1),
        # A prompt, and a reply still streaming: its parts are activity, its tokens are not credited yet.
        _db_step([oc_message("m2", "ses_a", {"role": "user"}),
                  oc_part("p1", "m2", "ses_a", {"type": "text", "text": "  fix the parser  "}),
                  oc_message("m3", "ses_a", oc_assistant({"input": 7}, completed=None)),
                  oc_part("p2", "m3", "ses_a", {"type": "reasoning", "text": "hm"}),
                  oc_part("p3", "m3", "ses_a", {"type": "tool", "tool": "bash"}),
                  oc_part("p4", "m3", "ses_a", {"type": "tool"}),
                  oc_part("p5", "m3", "ses_a", {"type": "text", "text": "working on it"}),
                  oc_part("p6", "m3", "ses_a", {"type": "step-finish", "reason": "tool-calls"}),
                  oc_part("p7", "m3", "ses_a", {"type": "step-finish"})], 1, 2),
        # It completes and the turn ends with its text; a subagent's end is
        # not the pane's; rows that are not JSON, not assistant, or empty.
        _db_step([oc_update("m3", oc_assistant({"input": 40, "output": 9, "cache": "none"}, model="")),
                  oc_part("p8", "m3", "ses_a", {"type": "text", "text": "  All done.  "}),
                  oc_part("p9", "m3", "ses_a", {"type": "text", "text": "   "}),
                  oc_part("p10", "m3", "ses_a", "not json"), oc_part("p11", "m3", "ses_a", {"type": "patch"}),
                  oc_part("p12", "m3", "ses_a", {}, created=0), oc_part("p13", "m3", "ses_a", [1]),
                  oc_part("p14", "m3", "ses_a", {"type": "step-finish", "reason": "stop"}),
                  oc_message("c1", "ses_child", oc_assistant({})),
                  oc_part("p15", "c1", "ses_child", {"type": "step-finish", "reason": "stop"}),
                  oc_message("m4", "ses_a", "not json"), oc_message("m5", "ses_a", {"role": "system"}),
                  oc_message("m6", "ses_a", oc_assistant({"input": 3, "output": 1}))], 2, 3),
        _db_step([], 3, 4),
        # The newest message was deleted and its rowid handed out again:
        # another row stands under the watermark, and it was never credited.
        _db_step([("DELETE FROM message WHERE id = ?", ("m6",)),
                  oc_message("m7", "ses_a", oc_assistant({"input": 11, "output": 2}))], 4, 5),
        # The newest rows are gone: re-anchor at the new top, credit nothing again.
        _db_step([("DELETE FROM message WHERE id IN (?, ?)", ("m7", "m5"))], 5, 6),
        _db_step([oc_message("m8", "ses_a", oc_assistant({"input": 60, "output": 6}, completed=None)),
                  oc_message("m9", "ses_a", oc_assistant({"input": 5, "output": 5}))], 6, 7),
        _db_step([oc_update("m8", oc_assistant({"input": 60, "output": 6}))], 7, 8),
    ]

    # A message and a part whose JSON text only Python reads (SQLite hands the
    # same text to both readers); the poll after them is the runtime's again.
    probe = '"cut \\ud83d"'
    opencode_probe_steps = opencode_steps[:2] + [
        _db_step([oc_message("mP", "ses_a", json.dumps(oc_assistant({"input": 9, "output": 2}))[:-1]
                             + ", \"navide_probe\": " + probe + "}"),
                  oc_part("pP", "mP", "ses_a", '{"type": "step-finish", "reason": "stop", "navide_probe": ' + probe + "}")],
                 2, 3),
        _db_step([oc_message("mQ", "ses_a", oc_assistant({"input": 4, "output": 1}))], 3, 4),
    ]

    oc2_now = opc2_t._NOW_MS

    def oc2_message(mid: str, sid: str, kind: str | None, seq: int, data: Any, at: int = 0) -> tuple:
        return ("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)",
                (mid, sid, kind, seq, oc2_now + at, oc2_now + at, data if isinstance(data, str) else json.dumps(data)))

    def oc2_assistant(text: str = "", tokens: dict | None = None, completed: bool = True) -> dict:
        data: dict = {"agent": "build", "model": {"id": "claude-sonnet-5-5", "providerID": "anthropic"},
                      "content": [{"type": "reasoning", "text": "hm"}, {"type": "text", "text": text}, "x"] if text else [],
                      "time": {"created": oc2_now}}
        if tokens is not None:
            data["tokens"] = tokens
        if completed:
            data["time"]["completed"] = oc2_now + 15_000
        return data

    def oc2_update(mid: str, data: dict, at: int) -> tuple:
        return ("UPDATE session_message SET data = ?, time_updated = ? WHERE id = ?", (json.dumps(data), oc2_now + at, mid))

    oc2_steps = [
        # An upgraded database: both schemas, the 1.x tables left behind.
        _db_step([opc2_t._V2_SCHEMA, opc2_t._V1_LEFTOVER_SCHEMA, oc_session("ses_b", table="session_v2", version="2.0.32"),
                  oc_session("ses_kid", parent="ses_b", table="session_v2", version="2.0.32"),
                  oc2_message("n0", "ses_b", "user", 0, {"text": "old prompt"}), oc2_message("n1", "ses_b", "idle", 1, {})], 0, 1),
        _db_step([oc2_message("n2", "ses_b", "user", 2, {"text": "  run the tests  "}, 1),
                  oc2_message("n3", "ses_b", "assistant", 3, oc2_assistant("Running them."), 2),
                  oc2_message("n4", "ses_b", "assistant", 4, oc2_assistant("  All 12 tests pass.  ", oc_tokens, completed=False), 3)],
                 1, 2),
        _db_step([oc2_update("n4", oc2_assistant("  All 12 tests pass.  ", oc_tokens), 4),
                  oc2_message("n5", "ses_b", "idle", 5, {"outcome": "succeeded"}, 5),
                  oc2_message("k0", "ses_kid", "assistant", 0, oc2_assistant("child"), 6),
                  oc2_message("k1", "ses_kid", "idle", 1, {}, 7),
                  oc2_message("n6", "ses_b", "compaction", 6, [1], 8), oc2_message("n7", "ses_b", "", 7, {}, 9),
                  oc2_message("n8", "ses_b", "idle", 8, {}, 10)], 2, 3),
        # A mark taken on 1.x's `message` table: the copies are not credited again.
        _db_step([oc2_message("n9", "ses_b", "assistant", 9, oc2_assistant("more", oc_tokens), 11)], 3, 4,
                 checkpoint_drop=["schema"]),
        _db_step([oc2_message("n10", "ses_b", "assistant", 10, oc2_assistant("again", {"input": 8, "output": 2}), 12)], 4, 5),
        # A 1.x binary writes to the shared database last: read as 1.x, and disclosed.
        _db_step([oc_session("ses_v1"),
                  oc_message("v1m", "ses_v1", oc_assistant(oc_tokens), updated=oc2_now + 500_000)], 5, 6),
        # OpenCode 2 writes again: its side is the newer one, all clear.
        _db_step([oc2_message("n11", "ses_b", "user", 11, {"text": "back"}, 900_000)], 6, 7),
    ]
    odd_steps = [
        _db_step(["CREATE TABLE conversation_v3 (id TEXT);"], 0, 1),
        # `session_v2` without `session_message` is not OpenCode 2's schema.
        _db_step([opc2_t._V1_LEFTOVER_SCHEMA + "CREATE TABLE session_v2 (id TEXT);", oc_session("ses_a"),
                  oc_message("m1", "ses_a", oc_assistant(oc_tokens))], 1, 2),
        _db_step(["DROP TABLE session_v2;", oc_message("m2", "ses_a", oc_assistant({"input": 1, "output": 1}))], 2, 3),
    ]

    def hermes_session(sid: str, title: str | None, parent: str | None = None, cwd: str = "/work") -> tuple:
        return ("INSERT INTO sessions(id, source, title, parent_session_id, cwd, started_at, last_activity_at) "
                "VALUES (?, 'cli', ?, ?, ?, 1000, 1000.25)", (sid, title, parent, cwd))

    def hermes_msg(sid: str, role: str, content: str | None = "", finish: str | None = None,
                   tool_calls: str | None = None, ts: float = 1000.5) -> tuple:
        return ("INSERT INTO messages(session_id, role, content, tool_calls, timestamp, finish_reason) "
                "VALUES (?, ?, ?, ?, ?, ?)", (sid, role, content, tool_calls, ts, finish))

    def hermes_tokens(sid: str, inp: int, out: int, cread: int, cwrite: int, at: float) -> tuple:
        return ("UPDATE sessions SET input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, "
                "cache_write_tokens = ?, last_activity_at = ? WHERE id = ?", (inp, out, cread, cwrite, at, sid))

    hermes_steps = [
        _db_step([hermes_t._SCHEMA, hermes_session("root", hermes_t.NAME),
                  hermes_session("cont", "compacted", parent="root", cwd="/work/sub"),
                  hermes_session("other", "my own chat"), hermes_msg("root", "user", "old")], 0, 1),
        _db_step([
            hermes_msg("cont", "user", "fix the parser at-pane:abc", ts=1001.123456),
            hermes_msg("cont", "assistant", "", finish="tool_calls", tool_calls='[{"id": "t"}]'),
            hermes_msg("cont", "tool", "ok"),
            hermes_msg("cont", "assistant", json.dumps([{"type": "text", "text": "fixed"}]), finish="stop"),
            hermes_msg("other", "user", "   "),
            hermes_msg("other", "assistant", "streaming"),
            hermes_tokens("cont", 1200, 80, 300, 20, 1001.75), hermes_tokens("other", 10, 1, 0, 0, 1002),
        ], 1, 2),
        _db_step([
            "UPDATE messages SET content = 'done streaming', finish_reason = 'stop' WHERE role = 'assistant' "
            "AND finish_reason IS NULL",
            hermes_tokens("cont", 1500, 90, 300, 20, 1003.5),
        ], 2, 3),
    ]
    def oc_row(sid: str, seq: int, event: dict | None, role: str | None = None) -> tuple:
        return ("INSERT INTO transcript_events(session_id, seq, event_json, message_role) VALUES (?, ?, ?, ?)",
                (sid, seq, None if event is None else json.dumps(event), role))

    oc_windows, oc_header, oc_nodes, oc_unkeyed = (f"{n}0000000-0000-4000-8000-000000000000" for n in "abcd")
    oc_key2 = "agent:main:navide-22222222-2222-4333-8444-555555555555"
    oc_key3 = "agent:main:navide-33333333-2222-4333-8444-555555555555"
    oc_steps = [
        _db_step([oc_t._SCHEMA, oc_t._SESSION_TABLES, oc_row(oc_t.KEY, 0, {"type": "session"}),
                  oc_row(oc_t.KEY, 1, oc_t._msg("user", "old"), "user"),
                  oc_row(oc_t.KEY, 2, oc_t._msg("assistant", "a", stopReason="stop", model="m1",
                                                usage={"input": 10, "output": 3, "cacheRead": 4, "cacheWrite": 1}),
                         "assistant")], 0, 1),
        _db_step([
            oc_row(oc_t.KEY, 3, oc_t._msg("user", [{"type": "text", "text": "do it"}]), "user"),
            oc_row(oc_t.KEY, 4, {"type": "custom_message", "customType": "openclaw.runtime-context"}),
            oc_row(oc_t.KEY, 5, None),
            oc_row(oc_t.KEY, 6, {"type": "message", "timestamp": 1792000000123,
                                 "message": {"role": "assistant", "content": [{"type": "toolCall"}], "stopReason": "toolUse",
                                             "usage": {"input": "7", "output": 2.9, "cacheRead": None}}}, "assistant"),
            oc_row(oc_t.KEY, 7, oc_t._msg("toolResult", []), "toolResult"),
            oc_row(oc_t.KEY, 8, {"type": "message", "message": {
                "role": "assistant", "timestamp": 1792000001, "stopReason": "stop",
                "content": [{"type": "thinking", "thinking": "x"}, {"type": "text", "text": "done"}]}}, "assistant"),
            oc_row(oc_t.KEY, 9, oc_t._msg("user", "<system-reminder>x</system-reminder>"), "user"),
            ("INSERT INTO session_windows(session_id, session_key) VALUES (?, ?)", (oc_windows, oc_t.KEY)),
            oc_row(oc_windows, 0, dict(oc_t._VM_HEADER, id=oc_windows)),
            oc_row(oc_windows, 1, oc_t._msg("user", "hello"), "user"),
            oc_row(oc_windows, 2, oc_t._msg("assistant", "STUB-REPLY-OK", stopReason="stop"), "assistant"),
            oc_row(oc_header, 0, {"type": "session", "sessionKey": oc_key2}),
            oc_row(oc_header, 1, oc_t._msg("assistant", "part", usage={"input": 5, "output": 1}), "assistant"),
        ], 1, 2),
        _db_step([
            ("UPDATE transcript_events SET event_json = ? WHERE session_id = ? AND seq = 1",
             (json.dumps(oc_t._msg("assistant", "whole", stopReason="stop", usage={"input": 5, "output": 1})), oc_header)),
            oc_row(oc_t.KEY, 10, {"type": "message", "message": {"content": "x"}}, "tool"),
        ], 2, 3),
        # A rewritten session (its newest seq fell below the mark) and one mapped by session_nodes.
        _db_step([
            ("DELETE FROM transcript_events WHERE session_id = ? AND seq >= 5", (oc_t.KEY,)),
            ("INSERT INTO session_nodes(session_key, current_session_id) VALUES (?, ?)", (oc_key2, oc_nodes)),
            oc_row(oc_nodes, 0, {"type": "session"}),
            oc_row(oc_nodes, 1, oc_t._msg("user", "late"), "user"),
        ], 3, 4),
        # A session that no table and no header gives a key: its events carry
        # the raw id (main logs it once), and the keyed session beside it is
        # read as before.
        _db_step([
            oc_row(oc_unkeyed, 0, {"type": "session"}),
            oc_row(oc_unkeyed, 1, oc_t._msg("user", "who am I"), "user"),
            oc_row(oc_unkeyed, 2, oc_t._msg("assistant", "nobody", stopReason="stop",
                                            usage={"input": 3, "output": 2}), "assistant"),
            oc_row(oc_nodes, 2, oc_t._msg("assistant", "keyed still", stopReason="stop",
                                          usage={"input": 8, "output": 1}), "assistant"),
        ], 4, 5),
        # Its mapping is written later: from then on its rows carry the key.
        _db_step([
            ("INSERT INTO session_windows(session_id, session_key) VALUES (?, ?)", (oc_unkeyed, oc_key3)),
            oc_row(oc_unkeyed, 3, oc_t._msg("user", "now known"), "user"),
        ], 5, 6),
    ]
    def cursor_blob(blob_id: str, message: dict | None = None) -> tuple | str:
        """A JSON message blob, or (no message) a protobuf structure node."""
        if message is None:
            return f"INSERT INTO blobs VALUES ('{blob_id}', X'{cursor_t._PROTOBUF_BLOB.hex()}')"
        return ("INSERT INTO blobs VALUES (?, CAST(? AS BLOB))", (blob_id, json.dumps(message)))

    def cursor_query(text: str) -> dict:
        return cursor_t._user(f"<timestamp>Sunday, Aug 16, 2026</timestamp>\n<user_query>\n{text}\n</user_query>")

    marker = "at-pane:0198f6a2-71aa-4d02-9c11-2233445566aa"
    cursor_dir = f"home/.cursor/chats/{'d' * 32}/{cursor_t._SID}"
    cursor_steps = [
        _db_step(["PRAGMA journal_mode=WAL; CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); "
                  "CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB);",
                  cursor_blob("b0"), cursor_blob("b1", cursor_t._user("<user_info>rules</user_info>"))], 0, 1),
        _db_step([
            cursor_blob("q1", cursor_query("  fix the parser  ")), cursor_blob("p1"),
            cursor_blob("a1", cursor_t._assistant("done", reasoning="thinking")),
            cursor_blob("m1", cursor_query(marker)), cursor_blob("m2", cursor_query(f"<!-- agent-team-session: {marker} -->")),
            cursor_blob("q2", cursor_query(f"forward {marker} to them")),
            cursor_blob("s1", {"role": "system", "content": "preamble"}),
            cursor_blob("q3", cursor_t._user("<user_query></user_query>")),
            cursor_blob("q4", cursor_query("<b>bold</b>")),
        ], 1, 2),
        _db_step([cursor_blob("a2", cursor_t._assistant("one")), cursor_blob("a3", cursor_t._assistant("two"))], 2, 3),
        # The store was recreated: re-anchor at its newest row, replay nothing.
        _db_step(["DELETE FROM blobs", cursor_blob("n1", cursor_t._assistant("old"))], 3, 4),
        # A cell of UTF-8 JSON with a byte-order mark: `json.loads(bytes)` reads it, so
        # the runtime hands the call to Python (it is not "no message").
        _db_step([("INSERT INTO blobs VALUES (?, CAST(? AS BLOB))",
                   ("bom", "﻿" + json.dumps(cursor_t._assistant("read despite the mark"))))], 4, 5),
    ]
    cursor_steps[2]["sidecars"] = {f"{cursor_dir}/meta.json": json.dumps({"updatedAtMs": 1786844146562, "cwd": "/work"})}
    def agy_step(idx: int, step_type: int, status: int, metadata: bytes | None, payload: bytes | None) -> str:
        cell = lambda b: "NULL" if b is None else f"X'{b.hex()}'"  # noqa: E731
        return f"INSERT INTO steps VALUES ({idx}, {step_type}, {status}, {cell(metadata)}, {cell(payload)})"

    agy_uri = b"file:///usr"  # a directory on every test machine
    agy_meta = b"\x12\x30" + agy_uri + b"\x00\x22\x41$9bc6-uuid:/" + agy_uri + b"z\xc2\x88"
    agy_at = agy_t._metadata(1_770_000_100)
    agy_steps = [
        _db_step([
            "CREATE TABLE `steps` (`idx` integer, `step_type` integer NOT NULL DEFAULT 0, `status` integer NOT NULL "
            "DEFAULT 0, `metadata` blob, `step_payload` blob, PRIMARY KEY (`idx`)); "
            "CREATE TABLE `trajectory_metadata_blob` (`id` text DEFAULT 'main', `data` blob, PRIMARY KEY (`id`));"
            f"INSERT INTO trajectory_metadata_blob VALUES ('main', X'{agy_meta.hex()}');",
            agy_step(0, 14, 3, b"", agy_t._user("hi")),
            agy_step(1, 15, 3, agy_t._metadata(1_770_000_000), agy_t._assistant(reply="done")),
        ], 0, 1),
        _db_step([
            agy_step(2, 14, 3, agy_at, agy_t._user("fix the build")),
            agy_step(3, 15, 3, agy_at, agy_t._assistant(thinking="**Considering the deploy**")),
            agy_step(4, 21, 3, None, None),
            agy_step(5, 15, 3, agy_at, agy_t._assistant(reply="mid-turn narration")),
            agy_step(6, 15, 5, b"", agy_t._assistant(reply="partial")),
            agy_step(7, 15, 5, b"", agy_t._assistant(reply="partial too")),
        ], 1, 2),
        # Nothing new: the two streaming steps are read again and stay quiet.
        _db_step([], 2, 3),
        _db_step([f"UPDATE steps SET status = 3, step_payload = X'{agy_t._assistant(reply='final reply').hex()}' "
                  "WHERE idx = 7"], 3, 4),
        _db_step([f"UPDATE steps SET status = 3, step_payload = X'{agy_t._assistant(reply='late').hex()}' WHERE idx = 6",
                  agy_step(8, 138, 3, agy_t._metadata(1_770_000_200), b"")], 4, 5),
    ]
    grok = [grok_t._user(1, "hello grok"), grok_t._agent(2, "hi "), grok_t._agent(3, "there"), grok_t._turn(4),
            grok_t._user(5, "again"), grok_t._agent(6, "ok"), grok_t._turn(7, inp=50, out=5, stop="cancelled")]
    def qwen_note(uuid: str, parent: str, second: int, task: str, status: str) -> dict:
        text = f"<task-notification>\n<task-id>{task}</task-id>\n<status>{status}</status>\n</task-notification>"
        return qwen_t._rec("user", uuid, parent, second, subtype="notification",
                           message={"role": "user", "parts": [{"text": text}]})

    return {
        **claude_python_only,
        **codex_python_only,
        "opencode_probe_surrogate": {
            "vendor": "opencode", "env": {"XDG_DATA_HOME": "share"},
            "file": "share/opencode/opencode.db",
            "python_reads": ["usage@2", "activity@2", "turns"],
            "steps": opencode_probe_steps,
        },
        "qwen_0_25": {
            "vendor": "qwen", "env": {"QWEN_RUNTIME_DIR": "qwen"},
            "file": f"qwen/projects/{encode_claude_cwd(qwen_t._CWD)}/chats/{qwen_t._SID}.jsonl",
            "steps": [
                _step("write", qwen[:4], 0, 1),
                _step("append", qwen[4:], 2, 3),
                # The CLI records a background task's end (and a Monitor event, whose task goes on).
                _step("append", [qwen_t._prompt("u2", "a2", 8, "second prompt"),
                                 qwen_t._reply("a3", "u2", 9, "second reply", 1500, 30, 1200, 5),
                                 qwen_note("n1", "a3", 10, "bg-7", "completed"),
                                 qwen_note("n2", "n1", 11, "bg-8", "running")], 4, 5),
                _step("append", [], 4, 14),
            ],
        },
        "kimi_2_2": {
            "vendor": "kimi", "env": {"KIMI_CODE_HOME": "kimi"},
            "file": f"kimi/sessions/wd_proj_c41def6fd06b/{kimi_t._SID}/agents/main/wire.jsonl",
            "sidecars": {f"kimi/sessions/wd_proj_c41def6fd06b/{kimi_t._SID}/state.json": json.dumps(kimi_t._state())},
            "steps": [_step("write", kimi[:12], 1, 1), _step("append", kimi[12:], 2, 2), _step("append", [], 2, 100)],
        },
        "codex_0_163": {
            "vendor": "codex", "env": {},
            "file": f"home/.codex/sessions/2026/10/20/rollout-2026-10-20T10-00-00-{codex_t._THREAD}.jsonl",
            "steps": [_step("write", codex[:12], 0, 1), _step("append", codex[12:], 1, 2)],
        },
        # The rewrites a rollout can go through: an empty reply key left in the
        # bag by an earlier build, a truncation, a replacement (new identity),
        # and a checkpoint from before `basis` (its baseline is re-derived).
        "codex_rewrites": {
            "vendor": "codex", "env": {},
            "file": f"home/.codex/sessions/2026/10/21/rollout-2026-10-21T10-00-00-{codex_t._THREAD}.jsonl",
            "steps": [
                _step("write", codex[:5], 0, 1, bag_add=["__lasttext__:"]),
                _step("append", codex[5:], 1, 2),
                _step("write", codex[:12], 2, 3),
                _step("replace", codex, 3, 4),
                _step("append", [], 3, 5, checkpoint_drop=["basis"]),
                # ... and a record in the format of rollouts older than `response_item`.
                _step("append", codex_t._turn(3, "third prompt", "third reply", totals=(4000, 2000, 200, 40),
                                              last=(1500, 600, 80, 10), start=22)
                      + [{"type": "assistant", "timestamp": "2026-10-21T02:00:40.000Z"}], 5, 6,
                      checkpoint_drop=["basis"]),
            ],
        },
        "codex_subagent_parent": {
            "vendor": "codex", "env": {},
            "file": f"{sub_day}/rollout-2026-09-05T09-10-06-{sub_t.PARENT_ID}.jsonl",
            "steps": [_step("write", sub_parent[:4], 0, 1), _step("append", sub_parent[4:], 1, 2)],
        },
        "codex_subagent_child": {
            "vendor": "codex", "env": {},
            "file": f"{sub_day}/rollout-2026-09-05T09-10-57-{sub_t.CHILD_ID}.jsonl",
            "steps": [_step("write", sub_child[:5], 0, 1), _step("append", sub_child[5:], 1, 2)],
        },
        "claude_turns": {
            "vendor": "claude", "env": {"CLAUDE_CONFIG_DIR": "claude"},
            "file": "claude/projects/-tmp-demo/turns-1.jsonl",
            "steps": [_step("write", claude[:4], 0, 1), _step("append", claude[4:7], 1, 2),
                      _step("append", claude[7:], 2, 3)],
        },
        # One record (at least) for every declared rule: questions, background
        # tasks started and stopped, queued notifications, compaction and meta
        # prompts, a bare tool_use record, a malformed line and a blank one. The
        # transcript's cwd is written decomposed.
        "claude_rules": {
            "vendor": "claude", "env": {"CLAUDE_CONFIG_DIR": "claude"},
            "file": "claude/projects/-tmp-caf-/rules-1.jsonl",
            "as_written": [[unicodedata.normalize("NFC", nfd_cwd), nfd_cwd]],
            "steps": [_step("write", claude_rules[:3], 0, 1),
                      _step("append", claude_rules[3:8], 1, 2, tail="{not json}\n\n"),
                      _step("append", claude_rules[8:], 2, 3)],
        },
        # No cwd in the transcript: the folder name is read back.
        "claude_dash_dir": {
            "vendor": "claude", "env": {"CLAUDE_CONFIG_DIR": "claude"},
            "file": "claude/projects/-tmp-demo-app/dash-1.jsonl",
            "steps": [_step("write", claude_bad, 0, 1)],
        },
        # A line that is not UTF-8 ends main's walk with an error, every poll.
        "claude_bad_bytes": {
            "vendor": "claude", "env": {"CLAUDE_CONFIG_DIR": "claude"},
            "file": "claude/projects/-tmp-demo/bad-1.jsonl",
            "steps": [_step("write", claude_bad, 0, 1), _step("append", [], 1, 2, b64=claude_bad_bytes),
                      _step("append", [], 1, 3)],
        },
        "pi_rewrite": {
            "vendor": "pi", "env": {"PI_CODING_AGENT_SESSION_DIR": "pi"},
            "file": f"pi/{encode_pi_cwd(pi_t._CWD)}/{pi_t._TS_PREFIX}_{pi_t._SID}.jsonl",
            "steps": [
                _step("write", pi_head, 0, 1),
                _step("append", pi_more, 1, 2),
                _step("append", [], 1, 20),
                # pi rewrites its file in place (a branch switch): same records, new layout.
                _step("write", [pi_head[0], pi_head[1], pi_t._assistant("a1", "u1", input=120, cache_read=30), *pi_more,
                                pi_t._user("u3", "one more", "a2")], 30, 31),
            ],
        },
        "droid_sidecar": {
            "vendor": "droid", "env": {"FACTORY_HOME_OVERRIDE": "droid"},
            "file": f"{droid_dir}/{droid_sid}.jsonl",
            "steps": [
                _step("write", droid[:3], 0, 1),
                _step("append", droid[3:6], 1, 2, droid_totals(100, 20, cache_read=50)),
                _step("append", droid[6:], 2, 3, droid_totals(400, 60, cache_read=50)),
                # The sidecar was replaced (a fork): re-baseline, no event; then growth again.
                _step("append", [], 3, 4, droid_totals(30, 5)),
                _step("append", [], 4, 5, droid_totals(70, 9)),
            ],
        },
        "muse_session": {
            "vendor": "muse", "env": {"XDG_DATA_HOME": "share"},
            "file": f"{muse_dir}/session.jsonl",
            "steps": [_step("write", muse[:6], 0, 1), _step("append", muse[6:10], 1, 2),
                      _step("append", muse[10:], 2, 3)],
        },
        # A subagent's log: not a transcript for usage or activity (its tokens
        # are the parent's). main's turns_for_session does not apply that rule
        # (parse_session_file credits the child's own usage), and neither does
        # the runtime.
        "muse_subagent": {
            "vendor": "muse", "env": {"XDG_DATA_HOME": "share"},
            "file": f"{muse_dir}/subagent/child-1/session.jsonl",
            "steps": [_step("write", muse[:9], 0, 1)],
        },
        "goose_db": {
            "vendor": "goose", "env": {"GOOSE_PATH_ROOT": "goose"},
            "file": "goose/data/sessions/sessions.db",
            "steps": goose_steps,
        },
        # The 1.0.78+ central store (the 1.0.75 events.jsonl stays main's reader's).
        "copilot_store": {
            "vendor": "copilot", "env": {"COPILOT_HOME": "copilot"},
            "file": "copilot/session-store.db",
            "steps": cop_steps,
        },
        # One database in one of two schemas, told apart on every read; what
        # that check finds is the reader's read problem (`problems`: recorded).
        "opencode_v1": {
            "vendor": "opencode", "env": {"XDG_DATA_HOME": "share"}, "problems": True,
            "file": "share/opencode/opencode.db",
            "steps": opencode_steps,
        },
        "opencode_v2": {
            "vendor": "opencode", "env": {"XDG_DATA_HOME": "share"}, "problems": True,
            "file": "share/opencode/opencode.db",
            "steps": oc2_steps,
        },
        "opencode_odd_schema": {
            "vendor": "opencode", "env": {"XDG_DATA_HOME": "share"}, "problems": True,
            "file": "share/opencode/opencode.db",
            "steps": odd_steps,
        },
        # The fork: the same store under its own name, its problems its own.
        "kilo_store": {
            "vendor": "kilo", "env": {"XDG_DATA_HOME": "share"}, "problems": True,
            "file": "share/kilo/kilo.db",
            "steps": opencode_steps[:3] + [_db_step(["CREATE TABLE session_v2 (id TEXT);"], 3, 4)],
        },
        "kilo_v2": {
            "vendor": "kilo", "env": {"XDG_DATA_HOME": "share"}, "problems": True,
            "file": "share/kilo/kilo.db",
            "steps": oc2_steps[:3],
        },
        "hermes_db": {
            "vendor": "hermes", "env": {"HERMES_HOME": "hermes"},
            "file": "hermes/state.db",
            "steps": hermes_steps,
        },
        "antigravity_db": {
            "vendor": "antigravity", "env": {},
            "file": "home/.gemini/antigravity-cli/conversations/aa11bb22.db",
            "steps": agy_steps,
        },
        "cursor_db": {
            "vendor": "cursor", "env": {},
            "file": f"{cursor_dir}/store.db",
            "python_reads": ["activity@4"],
            "steps": cursor_steps,
        },
        "openclaw_db": {
            "vendor": "openclaw", "env": {"OPENCLAW_STATE_DIR": "openclaw"},
            "file": "openclaw/agents/main/agent/openclaw-agent.sqlite",
            "steps": oc_steps,
        },
        # A pane's own history file (its namespace is the pane token, not a
        # hash of the scenario's temporary path).
        "aider_history": {
            "vendor": "aider", "env": {},
            "file": "ws/.aider.chat.history.0a1b2c3d.md",
            "steps": [
                # The last line is still being written.
                _text_step("write", aider_t._SECTION_1 + "\n#### go on\n\nfirst part.\nHalf ", 0, 1),
                _text_step("append", "an answer.\n\n> Tokens: 100 sent, 50 received.\n" + aider_t._SECTION_2
                           + "> Tokens: 1,000 sent", 1, 2),
                # The usage line completes; a long prompt, a marker prompt, tool
                # output, and lines ended by `\r\n` and a lone `\r`.
                _text_step("append", ", 2k received.\n\n#### " + "p" * 600 + "\n#### more\n\n"
                           "#### <!-- agent-team-session: at-pane:p1 -->\n\n> Applied edit to a.py\nwindows\r\n"
                           "old\rmac\n" + "x" * 40_000 + "\n> TOKENS: 8.5K SENT, 0 received\n", 2, 3),
                # Rewritten shorter: usage restarts from the top; activity's
                # mark stays, so the rewritten lines count as walked.
                _text_step("write", "# aider chat started at 2026-07-29 08:00:00\n#### again\n"
                           "> Tokens: 5 sent, 6 received.\n", 3, 4),
                # Past the old mark, lines are new again; the reply text is kept for the next walk.
                _text_step("append", "> Tokens: 0 sent, 0 received.\n> Tokens: 7 sent, 8 received.\n" * 18
                           + "#### next\nstill going\n", 4, 5),
                # A usage line ended by a lone `\r` and one still unterminated:
                # the whole-file pass behind turns_for_session counts both.
                _text_step("append", "> Tokens: 3 sent, 4 received.\r> Tokens: 9 sent, 1 received.", 5, 6),
            ],
        },
        "grok_turns": {
            "vendor": "grok", "env": {"GROK_HOME": "grok"},
            "file": f"grok/sessions/{grok_t.GROUP}/{grok_t.SID}/updates.jsonl",
            "steps": [_step("write", grok[:2], 0, 1), _step("append", grok[2:4], 1, 2), _step("append", grok[4:], 2, 3)],
        },
    }


def _norm(value: Any, root: str) -> Any:
    """Paths relative to the scenario root; checkpoint `identity` (dev:inode) dropped."""
    if isinstance(value, dict):
        return {k: _norm(v, root) for k, v in value.items() if k != "identity"}
    if isinstance(value, list):
        return [_norm(v, root) for v in value]
    if isinstance(value, str):
        # A byte cursor serialised into a seen-keys bag key carries its identity too.
        return re.sub(r'"identity": "[^"]*", ', "", value.replace(root, "<root>"), count=1)
    return value


def _pick(obj: Any, fields: tuple[str, ...]) -> dict:
    data = dataclasses.asdict(obj)
    return {k: data[k] for k in fields}


def _activity_dict(event: Any) -> dict:
    data = _pick(event, ACTIVITY_FIELDS)
    full = getattr(event.text, "full", "")
    if full:
        data["full"] = full
    return data


def _turn_dict(turn: Any) -> dict:
    data = _pick(turn, TURN_FIELDS)
    data["calls"] = [dict(c) for c in data["calls"]]
    return data


def _run(scenario: dict, root: Path, make_reader: Callable[[], Any], monkeypatch: pytest.MonkeyPatch,
         before_read: Callable[[int], None] | None = None) -> dict:
    """Read the scenario the watcher's way; return every result, normalised.

    `before_read(n)` runs before the n-th read (the usage and activity calls of
    step n; `n == len(steps)` is the final turns call)."""
    home = root / "home"
    home.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv(osplat.paths.home_env_var(), str(home))
    for key, rel in scenario["env"].items():
        monkeypatch.setenv(key, str(root / rel))
    for rel, text in (scenario.get("sidecars") or {}).items():
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_text(text, encoding="utf-8")
    path = root / scenario["file"]
    path.parent.mkdir(parents=True, exist_ok=True)
    clock = [0.0]
    monkeypatch.setattr(time, "time", lambda: clock[0])
    reader = make_reader()
    opencode_vendor._READ_PROBLEMS.clear()
    checkpoint: dict = {}
    seen: set[str] = set()
    steps = []
    files: list[str] = []
    for n, step in enumerate(scenario["steps"]):
        for rel, text in (step.get("sidecars") or {}).items():
            (root / rel).parent.mkdir(parents=True, exist_ok=True)
            (root / rel).write_text(text, encoding="utf-8")
        if step["mode"] == "db":
            con = sqlite3.connect(path)
            for sql, params in step["sql"]:
                if params is None:
                    con.executescript(sql)
                else:
                    con.execute(sql, params)
            con.commit()
            con.close()
            files.append(base64.b64encode(path.read_bytes()).decode("ascii"))
        elif step["mode"] == "replace":
            fresh = path.with_name(path.name + ".new")
            with fresh.open("w", encoding="utf-8", newline="") as fh:
                fh.write(step["text"])
            os.replace(fresh, path)
        else:
            with path.open("w" if step["mode"] == "write" else "a", encoding="utf-8", newline="") as fh:
                fh.write(step["text"])
        if step.get("b64"):
            with path.open("ab") as fh:
                fh.write(base64.b64decode(step["b64"]))
        os.utime(path, (step["mtime"], step["mtime"]))
        clock[0] = step["now"]
        checkpoint = {k: v for k, v in checkpoint.items() if k not in (step.get("checkpoint_drop") or ())}
        seen.update(step.get("bag_add") or ())
        if before_read is not None:
            before_read(n)
        parsed = reader.parse_incremental(path, checkpoint)
        checkpoint = parsed.checkpoint
        got = {"usage": {"events": [_pick(e, USAGE_FIELDS) for e in parsed.events], "checkpoint": parsed.checkpoint}}
        try:
            got["activity"] = [_activity_dict(e) for e in reader.parse_activity(path, seen)]
        except UnicodeDecodeError:
            # main's walk raises on a line that is not UTF-8, after saving its state.
            got["activity"], got["activity_error"] = [], "decode"
        got["bag"] = sorted(seen)
        if scenario.get("problems"):
            # What the CLI's status would say of the store now (`since` is the wall clock).
            problem = opencode_vendor.read_problem(scenario["vendor"])
            got["problem"] = problem and {k: v for k, v in problem.items() if k != "since"}
        steps.append(got)
    if before_read is not None:
        before_read(len(scenario["steps"]))
    try:
        turns: Any = [_turn_dict(t) for t in reader.turns_for_session(path, "")]
    except UnicodeDecodeError:
        turns = {"error": "decode"}
    result = _norm({"steps": steps, "turns": turns}, str(root))
    if files:
        result["files"] = files
    return result


def _compared(result: dict) -> str:
    """A run's results without the database bytes (two runs' files differ in nothing a reader sees)."""
    return json.dumps({k: v for k, v in result.items() if k != "files"})


def _python_reader(vendor: str) -> Callable[[], Any]:
    return lambda: cli_vendor(vendor).make_log_reader()


# The fixtures record what main's readers return on Unix, the only place the
# runtime that replays them is built. On Windows the same readers return the
# same paths with its separators (`<root>\share\...`, a cwd of `\usr`).
@pytest.mark.skipif(sys.platform == "win32", reason="the parity fixtures record Unix paths; the runtime is Unix only")
@pytest.mark.parametrize("name", sorted(_scenarios()))
def test_python_readers_match_the_parity_fixtures(name: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    scenario = _scenarios()[name]
    result = _run(scenario, tmp_path, _python_reader(scenario["vendor"]), monkeypatch)
    fixture = {
        "vendor": scenario["vendor"],
        "file": scenario["file"],
        "sidecars": scenario.get("sidecars") or {},
        # `[normalised, as written]` pairs: the runtime hands a cwd on as
        # written and the seam normalises it (the declaration says which form).
        "as_written": scenario.get("as_written") or [],
        # The calls (`<op>@<step>`, or `turns`) the runtime hands to the Python
        # reader because a record is JSON only Python parses; the replay must
        # get exactly that answer there, and take Python's state on from it.
        "python_reads": scenario.get("python_reads") or [],
        "steps": [
            {**step, **({"db": result["files"][i]} if step["mode"] == "db" else {}), "expect": got}
            for i, (step, got) in enumerate(zip(scenario["steps"], result["steps"]))
        ],
        "turns": result["turns"],
    }
    target = FIXTURES / f"{name}.json"
    if os.environ.get("NAVIDE_PARITY_WRITE") == "1":
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(fixture, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    def without_bytes(doc: dict) -> dict:
        # The recorded database differs run to run (CURRENT_TIMESTAMP defaults); what is read from it does not.
        return {**doc, "steps": [{k: v for k, v in s.items() if k != "db"} for s in doc["steps"]]}

    recorded = json.loads(target.read_text(encoding="utf-8"))
    assert without_bytes(recorded) == without_bytes(json.loads(json.dumps(fixture, ensure_ascii=False)))


@pytest.fixture
def runtime_switch():
    before = cli_runtime.enabled()
    yield cli_runtime
    cli_runtime.apply(before)


def _tally(vendor: str) -> dict[str, int]:
    """The process-wide outcome counts of one CLI now (a copy)."""
    return dict(cli_runtime.status()["calls"].get(vendor, {}))


def _since(before: dict[str, int], vendor: str) -> dict[str, int]:
    """What was counted for ``vendor`` after ``before`` was taken. A test never
    resets the global counts: ``tests.cli_runtime_on`` reads them at the end of
    the session to gate on every fault fallback."""
    now = _tally(vendor)
    return {key: now.get(key, 0) - before.get(key, 0) for key in set(now) | set(before)}


@pytest.mark.parametrize("name", ["qwen_0_25", "claude_turns"])
def test_switch_off_is_mains_reader(name: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, runtime_switch) -> None:
    scenario = _scenarios()[name]
    runtime_switch.apply(False)
    started: list[Any] = []
    monkeypatch.setattr(cli_runtime, "_Client", lambda exe: started.append(exe))
    expected = _run(scenario, tmp_path / "py", _python_reader(scenario["vendor"]), monkeypatch)
    wrapped = _run(scenario, tmp_path / "rt", lambda: cli_runtime.wrap(cli_vendor(scenario["vendor"]).make_log_reader()),
                   monkeypatch)
    assert _compared(wrapped).replace("/rt", "/py") == _compared(expected)
    assert started == []


def test_settings_turn_the_switch_on_and_off(runtime_switch) -> None:
    runtime_switch.apply_settings({})
    assert not runtime_switch.enabled()
    runtime_switch.apply_settings({cli_runtime.SETTING_KEY: True})
    assert runtime_switch.enabled()
    runtime_switch.apply_settings({cli_runtime.SETTING_KEY: "yes"})
    assert not runtime_switch.enabled()


def test_switch_on_without_a_binary_falls_back_to_python(tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
                                                         runtime_switch) -> None:
    scenario = _scenarios()["qwen_0_25"]
    monkeypatch.setenv(cli_runtime.BINARY_ENV, str(tmp_path / "missing"))
    runtime_switch.apply(True)
    expected = _run(scenario, tmp_path / "py", _python_reader("qwen"), monkeypatch)
    wrapped = _run(scenario, tmp_path / "rt", lambda: cli_runtime.wrap(cli_vendor("qwen").make_log_reader()), monkeypatch)
    assert json.dumps(wrapped).replace("/rt", "/py") == json.dumps(expected)


#: One scenario per route family: a JSONL store that is appended to (Claude), one
#: that is rewritten under the reader (Codex), and a database that grows (OpenCode).
FLIPPED = ["claude_turns", "codex_rewrites", "opencode_v1"]


@pytest.mark.parametrize("name", FLIPPED)
def test_flipping_the_switch_mid_session_changes_no_checkpoint_bag_or_event(
        name: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, runtime_switch) -> None:
    """The two readers share their state: a session read by Rust, then by
    Python, then by Rust again over the same growing store gives exactly the
    events, checkpoints and seen-keys bag of an all-Python run."""
    cli_runtime_build.binary()
    scenario = _scenarios()[name]
    vendor = scenario["vendor"]
    reads = len(scenario["steps"]) + 1  # the steps, then the turns call
    assert reads >= 4, "enough reads to flip twice"
    first, second = max(1, reads // 3), max(2, 2 * reads // 3)
    on = [not first <= n < second for n in range(reads)]  # Rust, Python, Rust
    runtime_switch.apply(False)
    expected = _run(scenario, tmp_path / "py", _python_reader(vendor), monkeypatch)

    answered: list[int] = []

    def flip(n: int) -> None:
        runtime_switch.apply(on[n])
        answered.append(cli_runtime.status()["calls"].get(vendor, {}).get("rust", 0))

    before = _tally(vendor)
    wrapped = _run(scenario, tmp_path / "rt", lambda: cli_runtime.wrap(cli_vendor(vendor).make_log_reader()),
                   monkeypatch, before_read=flip)
    assert json.loads(_compared(wrapped).replace("/rt", "/py")) == json.loads(_compared(expected))
    final = _tally(vendor)
    # Each phase was read by who it should be: Rust answered before and after
    # the Python phase, and nothing during it.
    assert answered[first] > answered[0], "Rust read the start of the session"
    assert answered[second] == answered[first], "Python read the middle of the session"
    assert final["rust"] > answered[second], "Rust read the end of it"
    gained = _since(before, vendor)
    assert gained["fallback"] == gained["unreadable"] == 0


@pytest.mark.parametrize("name", sorted(_scenarios()))
def test_switch_on_matches_python(name: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, runtime_switch,
                                  pytestconfig: pytest.Config) -> None:
    cli_runtime_build.binary()
    scenario = _scenarios()[name]
    # The expected run is Python's even when a plugin routes every reader class.
    runtime_switch.apply(False)
    expected = _run(scenario, tmp_path / "py", _python_reader(scenario["vendor"]), monkeypatch)
    runtime_switch.apply(True)
    before = _tally(scenario["vendor"])
    calls: list[str] = []
    real_call = cli_runtime._call

    def counting(vendor: str, op: str, **fields: Any):  # noqa: ANN202
        answer = real_call(vendor, op, **fields)
        if answer is not None:
            calls.append(op)
        return answer

    monkeypatch.setattr(cli_runtime, "_call", counting)
    wrapped = _run(scenario, tmp_path / "rt",
                   lambda: cli_runtime.wrap(cli_vendor(scenario["vendor"]).make_log_reader()), monkeypatch)
    assert json.loads(_compared(wrapped).replace("/rt", "/py")) == json.loads(_compared(expected))
    # The Rust process answered every routed call but the ones the scenario
    # names (a record only Python parses): those were Python's, and no call
    # fell back for a fault.
    handed_over = scenario.get("python_reads") or []
    steps = len(scenario["steps"])
    # OpenCode's own `turns_for_session` calls `parse_activity` on the wrapped
    # reader: when the turns call is Python's, that nested activity call is
    # the runtime's, once.
    nested = ["activity"] if "turns" in handed_over and scenario["vendor"] == "opencode" else []
    assert sorted(calls) == sorted(
        ["usage"] * (steps - sum(r.startswith("usage@") for r in handed_over))
        + ["activity"] * (steps - sum(r.startswith("activity@") for r in handed_over))
        + ["turns"] * ("turns" not in handed_over)
        + nested)
    counts = _since(before, scenario["vendor"])
    # Under the plugin the reader class is routed as well as the wrapped
    # instance, so each hand-over meets two routes and is counted by both.
    routes = 2 if pytestconfig.pluginmanager.has_plugin("tests.cli_runtime_on") else 1
    assert counts["python"] == len(handed_over) * routes
    assert counts["fallback"] == counts["unreadable"] == counts["unsupported"] == 0

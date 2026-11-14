"""Grok CLI (xAI grok-build) reader — one directory per session under
``$GROK_HOME/sessions/<url-encoded-cwd>/<session-id>/updates.jsonl``.

Replaces the suite written against the community grok-cli, whose sessions all
lived in one ``~/.grok/grok.db`` SQLite store. Guarantees that survived the
move are re-stated here in the new shape; the ones that were about the shared
store (row-id watermarks, per-session idle flushing, busy/locked handling) are
gone with it.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent_team_backend import app as app_module
from agent_team_backend.cli_vendors.grok import GrokLogReader, _iso
from agent_team_backend.log_readers.watcher import _ACTIVITY_KEYS_PERSIST_LIMIT

WS = "/Users/dev/proj"
#: What grok names the group directory for WS.
GROUP = "%2FUsers%2Fdev%2Fproj"
SID = "01a09f53-9ed8-7303-9e16-e4907f948d93"


@pytest.fixture(autouse=True)
def _grok_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("GROK_HOME", str(tmp_path / ".grok"))
    return tmp_path / ".grok"


def _record(kind: str, n: int, session_id: str = SID, **update) -> dict:
    """One updates.jsonl notification, shaped like the real ones."""
    return {
        "method": "session/update",
        "timestamp": 1789379453,
        "params": {
            "sessionId": session_id,
            "_meta": {
                "eventId": f"{session_id}-{n}",
                "agentTimestampMs": 1789379453711 + n,
            },
            "update": {"sessionUpdate": kind, **update},
        },
    }


def _user(n: int, text: str, session_id: str = SID) -> dict:
    return _record("user_message_chunk", n, session_id,
                   content={"type": "text", "text": text})


def _agent(n: int, text: str, session_id: str = SID) -> dict:
    return _record("agent_message_chunk", n, session_id,
                   content={"type": "text", "text": text})


def _turn(n: int, inp: int = 100, out: int = 10, model: str = "grok-4.6",
          session_id: str = SID, stop: str = "end_turn") -> dict:
    return _record(
        "turn_completed", n, session_id, stop_reason=stop,
        usage={"inputTokens": inp, "outputTokens": out,
               "modelUsage": {model: {"inputTokens": inp, "outputTokens": out}}},
    )


def _write(home: Path, records: list[dict], *, group: str = GROUP,
           session: str = SID) -> Path:
    path = home / "sessions" / group / session / "updates.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        for r in records:
            fh.write(json.dumps(r) + "\n")
    return path


def _append(path: Path, records: list[dict]) -> None:
    with path.open("a", encoding="utf-8") as fh:
        for r in records:
            fh.write(json.dumps(r) + "\n")


def _persisted(bag: set[str]) -> set[str]:
    """The bag as it comes back out of the watcher's checkpoint store.

    _persist_activity_seen refuses an over-limit bag outright rather than
    truncating it, so a reader that exceeds the limit gets an EMPTY bag on the
    next start — the full replay of GitHub #28. Round-tripping through JSON
    also catches a cursor that cannot survive serialization.
    """
    assert len(bag) <= _ACTIVITY_KEYS_PERSIST_LIMIT, (
        f"bag of {len(bag)} keys exceeds the persist limit "
        f"({_ACTIVITY_KEYS_PERSIST_LIMIT}); it would be dropped whole"
    )
    return {str(k) for k in json.loads(json.dumps(sorted(bag)))}


# ── layout ──────────────────────────────────────────────────────────────────

def test_no_sessions_dir_is_empty(_grok_home: Path) -> None:
    reader = GrokLogReader()
    assert reader.project_dirs() == []
    assert reader.session_files() == []


def test_session_id_comes_from_the_directory_not_the_filename(
    _grok_home: Path,
) -> None:
    # Every session names its transcript updates.jsonl, so the inherited
    # filename-stem default would call them all "updates".
    path = _write(_grok_home, [_user(1, "hi")])
    assert GrokLogReader().session_id_from_path(path) == SID


def test_cwd_is_decoded_from_the_group_directory(_grok_home: Path) -> None:
    path = _write(_grok_home, [_user(1, "hi")])
    assert GrokLogReader().cwd_from_file(path) == WS


def test_a_shortened_group_reads_its_cwd_file(_grok_home: Path) -> None:
    """Grok shortens a group name that would exceed 255 bytes and records the
    real path in .cwd — the name cannot be decoded back then."""
    path = _write(_grok_home, [_user(1, "hi")], group="proj-a1b2c3d4")
    (path.parent.parent / ".cwd").write_text("/very/long/original/path\n")
    assert GrokLogReader().cwd_from_file(path) == "/very/long/original/path"


def test_only_the_transcript_is_parsed(_grok_home: Path) -> None:
    """A session directory holds a dozen siblings that change every turn
    (chat_history, signals, tool_definitions, lock files)."""
    path = _write(_grok_home, [_user(1, "hi"), _turn(2)])
    reader = GrokLogReader()
    sibling = path.parent / "chat_history.jsonl"
    sibling.write_text(json.dumps(_turn(9)) + "\n")

    assert reader.session_files() == [path]
    assert reader.accepts_watch_path(str(path)) is True
    assert reader.accepts_watch_path(str(sibling)) is False
    assert reader.parse_session_file(sibling, set()) == []
    assert reader.parse_activity(sibling, set()) == []


def test_workspace_scoping_uses_the_group_directory(_grok_home: Path) -> None:
    _write(_grok_home, [_turn(1)])
    _write(_grok_home, [_turn(1)], group="%2Fother%2Fproj", session="other-sid")
    reader = GrokLogReader()

    assert len(reader.session_files()) == 2
    assert [p.parent.name for p in reader.session_files_for_workspace(WS) or []] == [SID]
    assert reader.session_files_for_workspace("/nope") == []


def test_workspace_scoping_gives_up_when_a_group_was_shortened(
    _grok_home: Path,
) -> None:
    """One-way mapping: scoping must say "scan everything" rather than answer
    "no sessions" for a workspace whose group name is a hash."""
    path = _write(_grok_home, [_turn(1)], group="proj-a1b2c3d4")
    (path.parent.parent / ".cwd").write_text(WS)

    assert GrokLogReader().session_files_for_workspace("/some/other") is None


#: A deep CJK workspace: 9 encoded bytes per character puts its group name far
#: past the 255-byte NAME_MAX, so grok stores it under a slug plus hash.
DEEP_WS = "/Users/dev/" + "很深的專案目錄/" * 6 + "proj"


def test_a_deep_workspace_is_scoped_by_its_cwd_marker(_grok_home: Path) -> None:
    """Building the encoded name for DEEP_WS raised ENAMETOOLONG from is_dir()."""
    path = _write(_grok_home, [_turn(1)], group="proj-a1b2c3d4")
    (path.parent.parent / ".cwd").write_text(DEEP_WS + "\n", encoding="utf-8")
    _write(_grok_home, [_turn(1)], session="short-sid")  # an ordinary group beside it
    reader = GrokLogReader()

    assert reader.session_files_for_workspace(DEEP_WS) == [path]
    assert reader.session_files_for_workspace(DEEP_WS + "/sub") == []
    # A short name keeps its group, untouched by the shortened one.
    assert [p.parent.name for p in reader.session_files_for_workspace(WS) or []] == ["short-sid"]


def test_a_deep_workspace_with_no_sessions_yet_is_empty(_grok_home: Path) -> None:
    (_grok_home / "sessions").mkdir(parents=True)
    assert GrokLogReader().session_files_for_workspace(DEEP_WS) == []


def test_resume_preflight_names_a_deep_workspace_transcript(_grok_home: Path) -> None:
    from agent_team_backend.cli_vendors.grok import _session_path

    assert _session_path(DEEP_WS, SID) is None  # no group yet: assume resumable
    path = _write(_grok_home, [_turn(1)], group="proj-a1b2c3d4")
    (path.parent.parent / ".cwd").write_text(DEEP_WS, encoding="utf-8")
    assert _session_path(DEEP_WS, SID) == path
    assert _session_path(DEEP_WS, "missing-sid").is_file() is False
    # Short names behave as before.
    assert _session_path(WS, SID) is None


# ── token usage ─────────────────────────────────────────────────────────────

def test_usage_comes_from_the_turn_completed_record(_grok_home: Path) -> None:
    path = _write(_grok_home, [_user(1, "hi"), _agent(2, "yo"), _turn(3, 120, 8)])

    events = GrokLogReader().parse_session_file(path, set())

    assert len(events) == 1
    usage = events[0]
    assert (usage.input_tokens, usage.output_tokens) == (120, 8)
    assert usage.model == "grok-4.6"
    assert usage.session_id == SID
    assert usage.cwd == WS
    # A real timestamp: the frontend treats an unparseable one as always-fresh
    # and would resend a delivered turn.
    assert usage.timestamp.startswith("2026-") and usage.timestamp.endswith("Z")


def test_usage_dedups_across_calls(_grok_home: Path) -> None:
    path = _write(_grok_home, [_turn(1), _turn(2)])
    reader = GrokLogReader()
    seen: set[str] = set()

    assert len(reader.parse_session_file(path, seen)) == 2
    assert reader.parse_session_file(path, seen) == []


def test_a_zero_token_turn_is_skipped(_grok_home: Path) -> None:
    path = _write(_grok_home, [_turn(1, 0, 0), _turn(2, 5, 5)])

    events = GrokLogReader().parse_session_file(path, set())

    assert [(e.input_tokens, e.output_tokens) for e in events] == [(5, 5)]


def test_incremental_reads_only_what_was_appended(_grok_home: Path) -> None:
    path = _write(_grok_home, [_turn(1)])
    reader = GrokLogReader()

    first = reader.parse_incremental(path, {})
    assert len(first.events) == 1
    assert reader.parse_incremental(path, first.checkpoint).events == []

    _append(path, [_turn(2, 7, 3)])
    second = reader.parse_incremental(path, first.checkpoint)
    assert [(e.input_tokens, e.output_tokens) for e in second.events] == [(7, 3)]


def test_incremental_rescans_a_replaced_transcript(_grok_home: Path) -> None:
    """A shorter replacement must not be read from the middle of a line."""
    path = _write(_grok_home, [_turn(1), _turn(2), _turn(3)])
    reader = GrokLogReader()
    checkpoint = reader.parse_incremental(path, {}).checkpoint

    _write(_grok_home, [_turn(9, 42, 4)])
    again = reader.parse_incremental(path, checkpoint)

    assert [(e.input_tokens, e.output_tokens) for e in again.events] == [(42, 4)]


# ── activity ────────────────────────────────────────────────────────────────

def test_turn_complete_is_read_not_inferred(_grok_home: Path) -> None:
    """The official CLI writes the boundary. The community CLI did not, which
    is why the old reader waited 8 seconds of silence — and why a grok pane
    took 8 seconds to hand a message to another CLI."""
    path = _write(_grok_home, [_user(1, "say hi"), _agent(2, "Hi"), _turn(3)])

    events = GrokLogReader().parse_activity(path, set())

    kinds = [(e.event_type, e.detail) for e in events]
    assert kinds == [
        ("agent_active", "user"),
        ("agent_active", "assistant"),
        ("turn_complete", "end_turn"),
    ]
    # The reply text is what carries an inter-CLI message.
    assert events[-1].text == "Hi"
    assert events[0].text == "say hi"


def test_a_reply_split_across_chunks_arrives_whole(_grok_home: Path) -> None:
    path = _write(_grok_home, [_agent(1, "Hel"), _agent(2, "lo"), _turn(3)])

    events = GrokLogReader().parse_activity(path, set())

    assert [e for e in events if e.event_type == "turn_complete"][0].text == "Hello"


def test_a_reply_split_across_passes_arrives_whole(_grok_home: Path) -> None:
    """The chunks and the turn_completed can land in different polls, so the
    partial text has to survive in the bag between them."""
    path = _write(_grok_home, [_agent(1, "Par")])
    reader = GrokLogReader()
    seen: set[str] = set()
    reader.parse_activity(path, seen)

    _append(path, [_agent(2, "tial"), _turn(3)])
    events = reader.parse_activity(path, seen)

    assert [e for e in events if e.event_type == "turn_complete"][0].text == "Partial"


def test_out_of_order_event_ids_are_not_swallowed(_grok_home: Path) -> None:
    """eventId is allocated when a record is queued, not when it is written, so
    a real transcript runs …4, 3, 50, 55, 51, 56. A high-water mark over that
    sequence would drop every record that arrives out of order — which is why
    the cursor is a byte offset instead.
    """
    path = _write(_grok_home, [
        _record("hook_execution", 4, event_name="pre"),
        _user(3, "out of order"),
        _record("hook_execution", 55, event_name="post"),
        _agent(51, "still delivered"),
        _turn(56),
    ])

    events = GrokLogReader().parse_activity(path, set())

    assert [e.detail for e in events] == ["user", "assistant", "end_turn"]
    assert events[-1].text == "still delivered"


def test_the_bag_stays_one_key_however_long_the_conversation(
    _grok_home: Path,
) -> None:
    """GitHub #28: one key per record grew the bag past the watcher's
    persistence limit, so it was never written and the whole history replayed
    on every backend start."""
    records: list[dict] = []
    for i in range(300):
        records += [_user(i * 3, f"q{i}"), _agent(i * 3 + 1, f"a{i}"), _turn(i * 3 + 2)]
    path = _write(_grok_home, records)
    seen: set[str] = set()

    events = GrokLogReader().parse_activity(path, seen)

    assert len(events) == 900
    assert len(seen) == 1


def test_a_restart_from_the_persisted_bag_replays_nothing(
    _grok_home: Path,
) -> None:
    """Through the real round-trip, not a copied set: a cursor that cannot
    survive JSON would look fine in-process and replay everything on restart."""
    records: list[dict] = []
    for i in range(200):
        records += [_user(i * 3, f"q{i}"), _agent(i * 3 + 1, f"a{i}"), _turn(i * 3 + 2)]
    path = _write(_grok_home, records)
    seen: set[str] = set()
    assert len(GrokLogReader().parse_activity(path, seen)) == 600

    # A fresh reader holding only what the checkpoint store could keep.
    assert GrokLogReader().parse_activity(path, _persisted(seen)) == []


def test_appended_records_are_delivered_exactly_once(_grok_home: Path) -> None:
    path = _write(_grok_home, [_user(1, "one"), _turn(2)])
    reader = GrokLogReader()
    seen: set[str] = set()
    reader.parse_activity(path, seen)

    _append(path, [_user(3, "two"), _turn(4)])
    second = reader.parse_activity(path, seen)

    assert [e.detail for e in second] == ["user", "end_turn"]
    assert reader.parse_activity(path, seen) == []


def test_a_half_written_line_is_left_for_the_next_poll(_grok_home: Path) -> None:
    path = _write(_grok_home, [_user(1, "complete"), _turn(2)])
    reader = GrokLogReader()
    seen: set[str] = set()
    reader.parse_activity(path, seen)

    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(_user(3, "half"))[:40])
    assert reader.parse_activity(path, seen) == []

    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(_user(3, "half"))[40:] + "\n")
    assert [e.detail for e in reader.parse_activity(path, seen)] == ["user"]


def test_a_replaced_transcript_drops_a_half_built_reply(_grok_home: Path) -> None:
    """Rescanning from zero must not splice the previous generation's partial
    reply onto a turn it never belonged to."""
    path = _write(_grok_home, [_agent(1, "stale half")])
    reader = GrokLogReader()
    seen: set[str] = set()
    reader.parse_activity(path, seen)

    _write(_grok_home, [_agent(1, "fresh"), _turn(2)])
    events = reader.parse_activity(path, seen)

    assert [e for e in events if e.event_type == "turn_complete"][0].text == "fresh"


def test_an_unreadable_transcript_is_not_fatal(_grok_home: Path) -> None:
    path = _write(_grok_home, [_turn(1)])
    path.unlink()
    reader = GrokLogReader()

    assert reader.parse_session_file(path, set()) == []
    assert reader.parse_activity(path, set()) == []
    assert reader.parse_incremental(path, {}).events == []


def test_a_malformed_line_does_not_stop_the_scan(_grok_home: Path) -> None:
    path = _write(_grok_home, [_user(1, "before")])
    with path.open("a", encoding="utf-8") as fh:
        fh.write("{not json\n")
        fh.write(json.dumps(_turn(3)) + "\n")

    events = GrokLogReader().parse_activity(path, set())

    assert [e.detail for e in events] == ["user", "end_turn"]


# ── marker binding ──────────────────────────────────────────────────────────

def test_a_kickoff_marker_binds_its_session(_grok_home: Path) -> None:
    _write(_grok_home, [_user(1, "at-pane:pane-7 do the thing")])

    found = GrokLogReader().find_sessions_by_marker(["at-pane:pane-7"])

    assert found == {"at-pane:pane-7": (SID, WS)}


def test_a_marker_in_another_workspace_reports_that_workspace(
    _grok_home: Path,
) -> None:
    """Binding carries the session's own cwd, so attribution's workspace gate
    can reject a marker echoed in a different project."""
    _write(_grok_home, [_user(1, "at-pane:pane-7 hi")],
           group="%2Fother%2Fproj", session="other-sid")

    found = GrokLogReader().find_sessions_by_marker(["at-pane:pane-7"])

    assert found == {"at-pane:pane-7": ("other-sid", "/other/proj")}


def test_two_panes_bind_their_own_markers(_grok_home: Path) -> None:
    _write(_grok_home, [_user(1, "at-pane:pane-a hi")], session="sid-a")
    _write(_grok_home, [_user(1, "at-pane:pane-b hi")], session="sid-b")

    found = GrokLogReader().find_sessions_by_marker(["at-pane:pane-a", "at-pane:pane-b"])

    assert found["at-pane:pane-a"][0] == "sid-a"
    assert found["at-pane:pane-b"][0] == "sid-b"


def test_no_markers_wanted_scans_nothing(_grok_home: Path) -> None:
    assert GrokLogReader().find_sessions_by_marker([]) == {}


# ── resume preflight ────────────────────────────────────────────────────────

def test_resume_command_claims_ids_but_not_titles_or_new_session_ids() -> None:
    from agent_team_backend.cli_vendors.grok import SPEC

    parse = SPEC.resume_id_from_command
    assert parse is not None
    for command in (
        f"grok -r {SID}",
        f"grok --model test --resume='{SID}'",
        f"'grok' '--resume' '{SID}'",
        ["/bin/sh", "-lc", f"grok --resume {SID}"],
    ):
        assert parse(command) == SID
        assert app_module._resume_id_for_agent("grok", command) == SID
    for command in (
        "grok", "grok --continue", "grok --resume --model test",
        "grok --resume 'my session title'", f"grok --session-id {SID}",
    ):
        assert parse(command) == ""


def test_resume_command_does_not_claim_shell_or_positional_text() -> None:
    from agent_team_backend.cli_vendors.grok import SPEC

    for separator in ("&&", "||", ";", "|", "\n", "#"):
        assert SPEC.resume_id_from_command(
            f"grok --help {separator} echo --resume {SID}"
        ) == ""
    assert SPEC.resume_id_from_command(f"grok -- --resume {SID}") == ""
    assert SPEC.resume_id_from_command(f"echo --resume {SID}") == ""
    assert SPEC.resume_id_from_command(["/bin/sh", "-lc", f"printf --resume {SID}"]) == ""
    assert SPEC.resume_id_from_command(["echo", f"grok --resume {SID}"]) == ""


def test_resume_preflight_can_now_check_a_session(_grok_home: Path) -> None:
    """Newly answerable: the community CLI's single shared store had no
    per-id path, so the preflight could only assume "resumable"."""
    _write(_grok_home, [_turn(1)])

    assert app_module._session_exists("grok", WS, SID) is True
    assert app_module._session_exists("grok", WS, "not-a-session") is False
    # The tail is spelled with the host's own separator: the lookup returns a
    # native path, so a hard-coded "/" only matches away from Windows.
    assert app_module._session_lookup_path("grok", WS, SID).endswith(
        str(Path(GROUP) / SID / "updates.jsonl")
    )


def test_resume_preflight_assumes_resumable_when_a_group_was_shortened(
    _grok_home: Path,
) -> None:
    path = _write(_grok_home, [_turn(1)], group="proj-a1b2c3d4")
    (path.parent.parent / ".cwd").write_text(WS)

    assert app_module._session_lookup_path("grok", WS, SID) == ""
    assert app_module._session_exists("grok", WS, SID) is True


# ── turns_for_session (tokens.turns) ────────────────────────────────────────

def test_turns_come_from_the_turn_completed_usage(_grok_home: Path) -> None:
    """One turn per turn_completed. inputTokens is the whole input with the
    cache counters reported as parts of it (totalTokens = input + output), so
    input is the uncached remainder and the turn total equals totalTokens.
    modelCalls is the call count; modelUsage (per model) is the breakdown."""
    reader = GrokLogReader()
    path = _write(_grok_home, [
        _user(1, "<!-- agent-team-session: at-pane:x -->"),
        _user(2, "幫我看一下"),
        _agent(3, "好"),
        _record(
            "turn_completed", 4, stop_reason="end_turn",
            usage={"inputTokens": 99708, "outputTokens": 1064, "totalTokens": 100772,
                   "cachedReadTokens": 61952, "cacheCreationTokens": 100,
                   "reasoningTokens": 813, "modelCalls": 3,
                   "modelUsage": {"grok-4.6": {
                       "inputTokens": 99708, "outputTokens": 1064,
                       "cachedReadTokens": 61952, "cacheCreationTokens": 100}}},
        ),
        _user(5, "再一次"),
        _turn(6, inp=50, out=5),
    ])
    assert reader.turns_method == "exact"
    turns = reader.turns_for_session(path)
    assert [(t.turn_index, t.prompt_excerpt, t.call_count) for t in turns] == [
        (1, "幫我看一下", 3), (2, "再一次", 1),
    ]
    first = turns[0]
    assert (first.input, first.cache_read, first.cache_creation, first.output) == (
        99708 - 61952 - 100, 61952, 100, 1064,
    )
    assert first.total == 100772
    assert len(first.calls) == 1 and first.calls[0].model == "grok-4.6"
    # started_at is the first user chunk (event 1), ended_at the turn_completed (event 4).
    assert first.started_at == _iso(_user(1, "")["params"], _user(1, ""))
    assert first.ended_at == _iso(_turn(4)["params"], _turn(4))
    assert first.started_at.endswith(".711Z") and first.ended_at.endswith(".714Z")
    assert first.session_id == SID
    assert turns[1].total == 55


def test_turns_filter_on_session_id(_grok_home: Path) -> None:
    reader = GrokLogReader()
    path = _write(_grok_home, [
        _user(1, "mine"), _turn(2, inp=10, out=1),
        _user(1, "other", session_id="other-session"),
        _turn(2, inp=99, out=9, session_id="other-session"),
    ])
    assert [t.total for t in reader.turns_for_session(path, SID)] == [11]
    assert [t.total for t in reader.turns_for_session(path, "other-session")] == [108]

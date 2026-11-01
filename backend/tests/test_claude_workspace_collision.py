"""Workspaces whose names encode alike share one Claude project folder.

Claude turns every non-alphanumeric character of a cwd into "-", so two folders
with Chinese names of the same length land in the same project folder. Only the
cwd inside a transcript says which of them a session ran in.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent_team_backend.cli_vendors.claude import ClaudeLogReader
from agent_team_backend.log_readers.attribution import Attribution
from agent_team_backend.log_readers.base import TokenUsage, encode_claude_cwd
from agent_team_backend.tokens_store import TokensStore

FIRST = "/Users/x/Desktop/約瑟夫整合行銷"
SECOND = "/Users/x/Desktop/自動化影片生成"
LONE = "/Users/x/Desktop/lone"


class _Reader(ClaudeLogReader):
    def __init__(self, root: Path) -> None:
        super().__init__()
        self.root = root
        self.opened: list[str] = []

    def _default_root(self) -> Path | None:
        return self.root

    def _read_session_cwd(self, path: Path) -> str:  # counted: "never opened" is pinned
        self.opened.append(str(path))
        return super()._read_session_cwd(path)


@pytest.fixture()
def reader(tmp_path: Path) -> _Reader:
    root = tmp_path / "projects"
    root.mkdir()
    return _Reader(root)


@pytest.fixture()
def attribution(tmp_path: Path, reader: _Reader) -> Attribution:
    attr = Attribution([reader], workspaces_path=tmp_path / "workspaces.json")
    for ws in (FIRST, SECOND, LONE):
        attr.register_workspace(ws)
    return attr


def _session(reader: _Reader, ws: str, sid: str, cwd: str | None = None, lines: int = 1) -> Path:
    folder = reader.root / encode_claude_cwd(ws)
    folder.mkdir(exist_ok=True)
    path = folder / f"{sid}.jsonl"
    record = {"type": "user", "sessionId": sid}
    if cwd != "":
        record["cwd"] = cwd or ws
    path.write_text((json.dumps(record, ensure_ascii=False) + "\n") * lines, encoding="utf-8")
    return path


def _usage(path: Path, key: str = "k") -> TokenUsage:
    return TokenUsage(
        vendor="claude", input_tokens=10, output_tokens=5, cwd="", session_id=path.stem,
        file_path=str(path), dedup_key=key, timestamp="2026-11-01T07:00:00Z",
    )


def test_the_folders_really_collide() -> None:
    assert encode_claude_cwd(FIRST) == encode_claude_cwd(SECOND)


@pytest.mark.parametrize("ws", [FIRST, SECOND])
def test_a_session_goes_to_the_workspace_it_ran_in(attribution, reader, ws) -> None:
    path = _session(reader, ws, f"s-{ws[-2:]}")
    assert attribution.attribute(_usage(path)).workspace_path == ws


def test_a_session_started_below_the_workspace_still_counts_as_it(attribution, reader) -> None:
    path = _session(reader, SECOND, "below", cwd=SECOND + "/.agent-team/plans")
    assert attribution.attribute(_usage(path)).workspace_path == SECOND


def test_subagent_transcripts_follow_their_own_cwd(attribution, reader) -> None:
    parent = _session(reader, SECOND, "parent")
    sub = parent.parent / "parent" / "subagents"
    sub.mkdir(parents=True)
    path = sub / "agent-1.jsonl"
    path.write_text(json.dumps({"type": "user", "cwd": SECOND}) + "\n", encoding="utf-8")
    assert attribution.attribute(_usage(path)).workspace_path == SECOND


def test_a_session_of_neither_workspace_is_still_counted(attribution, reader) -> None:
    """A third folder of the same length that was never opened: dropping it would
    take the usage out of the account totals too, so it stays where it went."""
    path = _session(reader, FIRST, "third", cwd="/Users/x/Desktop/另一個七字資料夾")
    assert attribution.attribute(_usage(path)).workspace_path == FIRST


def test_a_transcript_with_no_cwd_is_still_counted(attribution, reader) -> None:
    path = _session(reader, SECOND, "bare", cwd="")
    assert attribution.attribute(_usage(path)).workspace_path == FIRST


def test_the_owning_panes_workspace_wins(attribution, reader) -> None:
    path = _session(reader, SECOND, "owned", cwd="/Users/x/Desktop/另一個七字資料夾")
    attribution.register_pane("p1", vendor="claude", cwd=SECOND, workspace_path=SECOND,
                              explicit_session_id="owned")
    assert attribution.attribute(_usage(path)).workspace_path == SECOND


def test_a_path_with_one_workspace_never_opens_the_file(attribution, reader) -> None:
    path = _session(reader, LONE, "lone")
    for i in range(5):
        assert attribution.attribute(_usage(path, str(i))).workspace_path == LONE
    assert reader.opened == []


def test_a_colliding_file_is_opened_once(attribution, reader) -> None:
    path = _session(reader, SECOND, "once")
    for i in range(5):
        assert attribution.attribute(_usage(path, str(i))).workspace_path == SECOND
    assert len(reader.opened) == 1


def test_an_outside_session_stays_outside(attribution, reader) -> None:
    path = _session(reader, "/Users/x/Desktop/elsewhere", "out")
    assert attribution.attribute(_usage(path)).workspace_path is None


def test_totals_and_accounts_only_move_between_workspaces(tmp_path, attribution, reader) -> None:
    """The fix moves usage to the right workspace. Nothing is lost or counted twice."""
    store = TokensStore(
        global_path=tmp_path / "tokens.json",
        workspace_base_dir=tmp_path / "workspaces",
        ingestion_state_path=tmp_path / "token-ingestion-state.json",
    )
    for i, ws in enumerate([FIRST, SECOND, SECOND]):
        path = _session(reader, ws, f"t{i}")
        usage = _usage(path, f"k{i}")
        attributed = attribution.attribute(usage)
        store.record(
            attributed.workspace_path, source="cli", vendor="claude", agent_key="claude",
            pane_id="", session_id=usage.session_id, stage_id=None,
            input_tokens=10, output_tokens=5, dedup_key=f"claude::{path}::k{i}",
            profile_id="acct", timestamp=usage.timestamp,
        )
    first = store.snapshot(FIRST)
    second = store.snapshot(SECOND)
    assert first["workspace"]["cumulative"]["totals"]["input"] == 10
    assert second["workspace"]["cumulative"]["totals"]["input"] == 20
    assert first["global"]["all_time"]["input"] == 30
    assert first["global"]["all_time"]["output"] == 15
    assert first["global"]["by_account"]["acct"]["input"] == 30


def test_own_session_files_leave_out_the_neighbour(reader) -> None:
    mine = _session(reader, SECOND, "mine")
    below = _session(reader, SECOND, "below", cwd=SECOND + "/sub")
    bare = _session(reader, SECOND, "bare", cwd="")
    _session(reader, FIRST, "theirs")
    assert set(reader.own_session_files(SECOND)) == {mine, below, bare}
    # The folder-wide listing keeps everything: pane baselines depend on it.
    assert len(reader.session_files_for_workspace(SECOND)) == 4


# ── who claims a session no id has tied to a pane yet ──────────────────────


def _pane(attribution: Attribution, pane_id: str, ws: str, **kwargs) -> None:
    attribution.register_pane(pane_id, vendor="claude", cwd=ws, workspace_path=ws, **kwargs)


def test_a_new_session_is_not_claimed_by_the_pane_next_door(attribution, reader) -> None:
    _pane(attribution, "next-door", FIRST)
    path = _session(reader, SECOND, "new")
    assert attribution.attribute(_usage(path)).pane_id is None


def test_a_new_session_goes_to_the_pane_it_ran_in(attribution, reader) -> None:
    """With a pane in each folder the old match saw two candidates and gave up."""
    _pane(attribution, "next-door", FIRST)
    _pane(attribution, "mine", SECOND)
    path = _session(reader, SECOND, "new")
    assert attribution.attribute(_usage(path)).pane_id == "mine"


def test_a_session_already_tied_to_a_pane_stays_with_it(attribution, reader) -> None:
    path = _session(reader, SECOND, "owned", cwd=FIRST)
    _pane(attribution, "owner", SECOND, explicit_session_id="owned")
    assert attribution.attribute(_usage(path)).pane_id == "owner"


def test_a_path_with_no_neighbour_claims_as_before_and_reads_once(attribution, reader) -> None:
    _pane(attribution, "lone-pane", LONE)
    path = _session(reader, LONE, "fresh")
    for i in range(5):
        assert attribution.attribute(_usage(path, str(i))).pane_id == "lone-pane"
    assert len(reader.opened) == 1


def test_a_transcript_with_no_cwd_yet_claims_as_before(attribution, reader) -> None:
    _pane(attribution, "only", SECOND)
    path = _session(reader, SECOND, "bare", cwd="")
    assert attribution.attribute(_usage(path)).pane_id == "only"


def test_the_pane_claim_keeps_totals_and_accounts(tmp_path, attribution, reader) -> None:
    """A claim decides which pane an event names, and through it the account. The
    number of events that are counted, and their sum, must not move."""
    store = TokensStore(
        global_path=tmp_path / "tokens.json",
        workspace_base_dir=tmp_path / "workspaces",
        ingestion_state_path=tmp_path / "token-ingestion-state.json",
    )
    _pane(attribution, "next-door", FIRST)
    for i, ws in enumerate([FIRST, SECOND]):
        path = _session(reader, ws, f"c{i}")
        usage = _usage(path, f"k{i}")
        attributed = attribution.attribute(usage)
        store.record(
            attributed.workspace_path, source="cli", vendor="claude", agent_key="claude",
            pane_id=attributed.pane_id or "", session_id=usage.session_id, stage_id=None,
            input_tokens=10, output_tokens=5, dedup_key=f"claude::{path}::k{i}",
            profile_id="acct", timestamp=usage.timestamp,
        )
    world = store.snapshot(FIRST)["global"]
    assert world["all_time"]["input"] == 20
    assert world["by_account"]["acct"]["input"] == 20

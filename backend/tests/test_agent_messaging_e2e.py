"""End-to-end cross-workspace messaging over two simulated renderer windows.

Exercises the real broadcast fan-out (not a monkeypatched one) so the full loop
is covered: window A registers a pane, window B registers a pane in another
workspace, A routes a message, both windows see the deliver event, B reports the
outcome, and only A sees the delivery result.

The second half of the file does the same for the MCP tools, which is where the
layers actually meet: cli_send broadcasts through app.broadcast, a simulated
window answers over the real ws handler, the handler hands the verdict back to
the MCP server, and cli_check_message / cli_send_and_wait read it. Nothing in
between is stubbed except the one boundary that needs a real CLI on disk
(attribution's log-file → pane lookup, in the `log_activity` fixture).
"""

from __future__ import annotations

import asyncio
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging, app
from agent_team_backend.log_readers import ActivityEvent
from agent_team_backend.mcp_server import server as plan_mcp, wiring as plan_mcp_wiring


@pytest.fixture(autouse=True)
def _clean_state() -> Any:
    agent_messaging._reset_for_test()
    app._SESSIONS.clear()
    plan_mcp._mcp_message_status.clear()
    yield
    agent_messaging._reset_for_test()
    app._SESSIONS.clear()
    plan_mcp._mcp_message_status.clear()


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


def _window() -> app.Session:
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    app._SESSIONS.add(session)
    return session


def _events(session: app.Session, event_type: str) -> list[dict[str, Any]]:
    sent: list[dict[str, Any]] = session.websocket.sent  # type: ignore[attr-defined]
    return [m for m in sent if m.get("type") == event_type]


@pytest.mark.asyncio
async def test_full_cross_workspace_round_trip() -> None:
    window_a = _window()
    window_b = _window()

    await app.handle_message(window_a, {
        "id": "1",
        "type": "agent_msg.register",
        "payload": {
            "pane_id": "pa",
            "name": "sender",
            "workspace_path": "/ws/alpha",
            "agent_key": "claude",
        },
    })
    await app.handle_message(window_b, {
        "id": "2",
        "type": "agent_msg.register",
        "payload": {
            "pane_id": "pb",
            "name": "reviewer",
            "workspace_path": "/ws/beta",
            "agent_key": "codex",
        },
    })

    await app.handle_message(window_a, {
        "id": "3",
        "type": "agent_msg.route",
        "payload": {
            "from_pane_id": "pa",
            "to": "beta/reviewer",
            "content": "please run pnpm test:run",
            "msg_key": "pa:1",
        },
    })
    await asyncio.sleep(0)

    # Every window receives the broadcast; the frontend filters on target_pane_id.
    for window in (window_a, window_b):
        delivered = _events(window, "agent_msg.deliver")
        assert len(delivered) == 1
        payload = delivered[0]["payload"]
        assert payload["target_pane_id"] == "pb"
        assert payload["from_display"] == "alpha/sender"
        assert payload["cross_workspace"] is True
        assert payload["content"] == "please run pnpm test:run"

    # Window B injected it and reports back.
    await app.handle_message(window_b, {
        "id": "4",
        "type": "agent_msg.delivered",
        "payload": {"msg_key": "pa:1", "ok": True},
    })
    await asyncio.sleep(0)

    assert len(_events(window_a, "agent_msg.delivery_result")) == 1
    assert _events(window_a, "agent_msg.delivery_result")[0]["payload"]["ok"] is True


@pytest.mark.asyncio
async def test_closing_a_window_removes_its_targets() -> None:
    window_a = _window()
    window_b = _window()

    await app.handle_message(window_b, {
        "id": "1",
        "type": "agent_msg.register",
        "payload": {"pane_id": "pb", "name": "reviewer", "workspace_path": "/ws/beta"},
    })
    await app.handle_message(window_a, {
        "id": "2",
        "type": "agent_msg.register",
        "payload": {"pane_id": "pa", "name": "sender", "workspace_path": "/ws/alpha"},
    })

    # Window B goes away (what the /ws finally block does on disconnect).
    agent_messaging.drop_owner(window_b)

    await app.handle_message(window_a, {
        "id": "3",
        "type": "agent_msg.route",
        "payload": {
            "from_pane_id": "pa",
            "to": "beta/reviewer",
            "content": "hi",
            "msg_key": "pa:1",
        },
    })
    await asyncio.sleep(0)

    resp = [m for m in window_a.websocket.sent if m.get("id") == "3"][0]  # type: ignore[attr-defined]
    assert resp["payload"]["ok"] is False
    # Offline, not gone: the window is expected back, and the sender is told to
    # wait rather than that it addressed something that does not exist.
    assert resp["payload"]["code"] == "target-offline"
    assert "offline" in resp["payload"]["error"]
    assert _events(window_a, "agent_msg.deliver") == []

    # Once the grace period lapses without the window returning, the target
    # really is gone and resolution says so.
    agent_messaging.get("pb").offline_since -= agent_messaging.OFFLINE_GRACE_S + 1
    await app.handle_message(window_a, {
        "id": "4",
        "type": "agent_msg.route",
        "payload": {
            "from_pane_id": "pa",
            "to": "beta/reviewer",
            "content": "hi",
            "msg_key": "pa:2",
        },
    })
    await asyncio.sleep(0)
    expired = [m for m in window_a.websocket.sent if m.get("id") == "4"][0]  # type: ignore[attr-defined]
    assert expired["payload"]["code"] == "unknown-workspace"


@pytest.mark.asyncio
async def test_same_workspace_target_is_not_flagged_cross_workspace() -> None:
    window = _window()
    for pane_id, name in (("p1", "a"), ("p2", "b")):
        await app.handle_message(window, {
            "id": f"reg-{pane_id}",
            "type": "agent_msg.register",
            "payload": {"pane_id": pane_id, "name": name, "workspace_path": "/ws/alpha"},
        })

    await app.handle_message(window, {
        "id": "r",
        "type": "agent_msg.route",
        "payload": {"from_pane_id": "p1", "to": "alpha/b", "content": "hi", "msg_key": "k"},
    })
    await asyncio.sleep(0)

    payload = _events(window, "agent_msg.deliver")[0]["payload"]
    assert payload["cross_workspace"] is False
    assert payload["target_pane_id"] == "p2"


@pytest.mark.asyncio
async def test_single_window_qualified_target_gets_its_own_delivery_result() -> None:
    """A `<own folder>/<pane>` address resolves inside the sending window, so the
    reporter and the sender are the same connection."""
    window = _window()
    for pane_id, name in (("p1", "a"), ("p2", "b")):
        await app.handle_message(window, {
            "id": f"reg-{pane_id}",
            "type": "agent_msg.register",
            "payload": {"pane_id": pane_id, "name": name, "workspace_path": "/ws/alpha"},
        })

    await app.handle_message(window, {
        "id": "r",
        "type": "agent_msg.route",
        "payload": {"from_pane_id": "p1", "to": "alpha/b", "content": "hi", "msg_key": "p1:1"},
    })
    await asyncio.sleep(0)
    await app.handle_message(window, {
        "id": "d",
        "type": "agent_msg.delivered",
        "payload": {"msg_key": "p1:1", "ok": True},
    })
    await asyncio.sleep(0)

    results = _events(window, "agent_msg.delivery_result")
    assert len(results) == 1
    assert results[0]["payload"] == {"msg_key": "p1:1", "ok": True, "reason": ""}


@pytest.mark.asyncio
async def test_detach_race_keeps_the_pane_addressable() -> None:
    """Detaching a pane to another window re-registers it there before the parent
    window unregisters it; the late unregister must not delete the new claim."""
    parent = _window()
    child = _window()

    await app.handle_message(parent, {
        "id": "1",
        "type": "agent_msg.register",
        "payload": {"pane_id": "pd", "name": "worker", "workspace_path": "/ws/alpha"},
    })
    # Child window claims the same pane id (detach handoff).
    await app.handle_message(child, {
        "id": "2",
        "type": "agent_msg.register",
        "payload": {"pane_id": "pd", "name": "worker", "workspace_path": "/ws/alpha"},
    })
    # Parent's unregister arrives afterwards.
    await app.handle_message(parent, {
        "id": "3",
        "type": "agent_msg.unregister",
        "payload": {"pane_id": "pd"},
    })

    resp = [m for m in parent.websocket.sent if m.get("id") == "3"][0]  # type: ignore[attr-defined]
    assert resp["payload"]["removed"] is False
    assert agent_messaging.get("pd") is not None


@pytest.mark.asyncio
async def test_registry_survives_a_rename_and_readdresses() -> None:
    window = _window()
    await app.handle_message(window, {
        "id": "1",
        "type": "agent_msg.register",
        "payload": {"pane_id": "pb", "name": "reviewer", "workspace_path": "/ws/beta"},
    })
    await app.handle_message(window, {
        "id": "2",
        "type": "agent_msg.register",
        "payload": {"pane_id": "pb", "name": "qa", "workspace_path": "/ws/beta"},
    })
    await app.handle_message(window, {
        "id": "3",
        "type": "agent_msg.register",
        "payload": {"pane_id": "pa", "name": "sender", "workspace_path": "/ws/alpha"},
    })

    stale = agent_messaging.resolve("pa", "beta/reviewer")
    fresh = agent_messaging.resolve("pa", "beta/qa")
    assert stale.pane is None
    assert fresh.pane is not None and fresh.pane.pane_id == "pb"


# ── MCP tools against the same live wiring ─────────────────────────────────
# Everything above drives the ws handlers only. These drive an agent's actual
# tools — cli_send / cli_check_message / cli_send_and_wait / cli_read_log —
# against the same sessions, so a break anywhere along the chain shows up here
# even when each layer's own unit tests still pass.


def _ctx(pane_id: str) -> Any:
    """A Context carrying the query string the pane's MCP client sends."""
    params = {"pane": pane_id, "t": plan_mcp_wiring.caller_token(pane_id)}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


@pytest.fixture
def log_activity(monkeypatch: pytest.MonkeyPatch) -> Any:
    """Emit an activity event the way a CLI's log reader does.

    Only attribution is stubbed — mapping a log file back to a pane needs a
    real CLI session file on disk. `app._on_log_activity` itself runs for real,
    so what lands in `_pane_activity` (and in the `agent.activity` broadcast
    every window sees) is what a live pane would produce.
    """
    bindings: dict[str, tuple[str, str]] = {}

    def fake_attribute(usage: Any) -> Any:
        pane_id, workspace_path = bindings.get(usage.session_id, ("", ""))
        return SimpleNamespace(
            pane_id=pane_id or None,
            workspace_path=workspace_path or None,
            stage_id=None,
        )

    monkeypatch.setattr(app.attribution, "attribute", fake_attribute)

    async def emit(pane_id: str, workspace: str, event_type: str, text: str = "") -> None:
        session_id = f"sess-{pane_id}"
        bindings[session_id] = (pane_id, workspace)
        await app._on_log_activity(ActivityEvent(
            vendor="claude",
            event_type=event_type,
            cwd=workspace,
            session_id=session_id,
            file_path=f"/logs/{pane_id}.jsonl",
            dedup_key=f"{pane_id}:{event_type}:{time.monotonic_ns()}",
            text=text,
        ))

    return emit


async def _register(session: app.Session, pane_id: str, name: str, workspace: str) -> None:
    await app.handle_message(session, {
        "id": f"reg-{pane_id}",
        "type": "agent_msg.register",
        "payload": {
            "pane_id": pane_id,
            "name": name,
            "workspace_path": workspace,
            "agent_key": "claude",
        },
    })


async def _report_delivered(
    session: app.Session, msg_key: str, ok: bool, reason: str = ""
) -> None:
    """What a receiving window sends once it has tried to inject the message."""
    await app.handle_message(session, {
        "id": f"delivered-{msg_key}",
        "type": "agent_msg.delivered",
        "payload": {"msg_key": msg_key, "ok": ok, "reason": reason},
    })
    await asyncio.sleep(0)


async def _await_delivery(session: app.Session) -> dict[str, Any]:
    """Wait for the receiving window to see the deliver broadcast."""
    for _ in range(400):
        events = _events(session, "agent_msg.deliver")
        if events:
            return events[0]["payload"]
        await asyncio.sleep(0.005)
    raise AssertionError("the deliver event never reached the window")


@pytest.mark.asyncio
async def test_cli_send_delivery_is_reported_all_the_way_back_to_cli_check_message() -> None:
    """The full delivery loop: the tool broadcasts, the receiving window sees
    it and answers over the ws handler, and the sending agent reads the verdict
    back out of the tool it started from."""
    window_a = _window()
    window_b = _window()
    await _register(window_a, "pa", "sender", "/ws/alpha")
    await _register(window_b, "pb", "reviewer", "/ws/beta")

    sent = await plan_mcp.cli_send("beta/reviewer", "run the tests", _ctx("pa"))
    assert sent["ok"] is True

    payload = await _await_delivery(window_b)
    assert payload["msg_key"] == sent["msg_key"]
    assert payload["target_pane_id"] == "pb"
    assert payload["content"] == "run the tests"
    # cli_send never passed through the frontend's per-pair throttle, so the
    # receiving window has to apply it.
    assert payload["rate_limit"] is True

    pending = await plan_mcp.cli_check_message(sent["msg_key"], _ctx("pa"))
    assert pending["status"] == "queued"

    await _report_delivered(window_b, sent["msg_key"], ok=True)

    settled = await plan_mcp.cli_check_message(sent["msg_key"], _ctx("pa"))
    assert settled["status"] == "delivered"
    assert settled["target"] == "beta/reviewer"
    assert "reason" not in settled
    assert isinstance(settled["settled_after_s"], float)


@pytest.mark.asyncio
async def test_cli_send_failure_is_reported_all_the_way_back_to_cli_check_message() -> None:
    """A refused delivery has to reach the sender as a refusal with its reason;
    silently staying "queued" would read as "still on its way"."""
    window_a = _window()
    window_b = _window()
    await _register(window_a, "pa", "sender", "/ws/alpha")
    await _register(window_b, "pb", "reviewer", "/ws/beta")

    sent = await plan_mcp.cli_send("beta/reviewer", "run the tests", _ctx("pa"))
    await _await_delivery(window_b)
    await _report_delivered(
        window_b,
        sent["msg_key"],
        ok=False,
        reason='{"key":"rate-limit","params":{"seconds":30}}',
    )

    settled = await plan_mcp.cli_check_message(sent["msg_key"], _ctx("pa"))
    assert settled["status"] == "failed"
    assert settled["reason"] == "rate-limit"
    # The rebroadcast every window relies on still happens alongside it.
    results = _events(window_a, "agent_msg.delivery_result")
    assert len(results) == 1
    assert results[0]["payload"]["ok"] is False


@pytest.mark.asyncio
async def test_cli_send_and_wait_returns_the_turn_the_target_produced(
    monkeypatch: pytest.MonkeyPatch, log_activity: Any
) -> None:
    """A → B → A end to end: the tool sends, window B delivers it, B's agent
    works and its log reader reports the finished turn, and the tool hands the
    caller what B said."""
    monkeypatch.setattr(plan_mcp, "_WAIT_IDLE_POLL_S", 0.005)
    window_a = _window()
    window_b = _window()
    await _register(window_a, "pa", "sender", "/ws/alpha")
    await _register(window_b, "pw", "worker", "/ws/beta")
    # B answered something else before this exchange started.
    await log_activity("pw", "/ws/beta", "turn_complete", "the answer to the PREVIOUS question")
    # The tool tells B's new turn from this one by ts_monotonic; on Windows
    # (Python 3.12) time.monotonic() ticks every ~15.6 ms, so a delivery that
    # lands in the same tick would look like no activity at all.
    await asyncio.sleep(0.05)

    async def window_b_behaviour() -> None:
        payload = await _await_delivery(window_b)
        await _report_delivered(window_b, payload["msg_key"], ok=True)
        await log_activity("pw", "/ws/beta", "agent_active", "")
        await asyncio.sleep(0.01)
        await log_activity("pw", "/ws/beta", "turn_complete", "all green, 2460 passed")

    task = asyncio.create_task(window_b_behaviour())
    result = await plan_mcp.cli_send_and_wait(
        "beta/worker", "run the tests", _ctx("pa"), timeout_s=5.0
    )
    await task

    assert result["ok"] is True
    assert result["idle"] is True
    assert result["source"] == "turn_complete"
    assert result["target"] == "beta/worker"
    assert result["last_activity"]["text"] == "all green, 2460 passed"
    # The key it returns is the one that threads the whole exchange together.
    check = await plan_mcp.cli_check_message(result["msg_key"], _ctx("pa"))
    assert check["status"] == "delivered"


@pytest.mark.asyncio
async def test_cli_send_and_wait_never_passes_off_the_previous_turn_as_the_reply(
    monkeypatch: pytest.MonkeyPatch, log_activity: Any
) -> None:
    """The reason this tool exists. The message is genuinely delivered, but the
    target agent never picks it up — so the only turn on record is the one from
    before the send, and returning that would be a false "it answered you"."""
    monkeypatch.setattr(plan_mcp, "_WAIT_IDLE_POLL_S", 0.005)
    monkeypatch.setattr(plan_mcp, "_SEND_AND_WAIT_START_GRACE_S", 0.02)
    window_a = _window()
    window_b = _window()
    await _register(window_a, "pa", "sender", "/ws/alpha")
    await _register(window_b, "pw", "worker", "/ws/beta")
    await log_activity("pw", "/ws/beta", "turn_complete", "the answer to the PREVIOUS question")

    async def window_b_delivers_but_the_agent_stays_silent() -> None:
        payload = await _await_delivery(window_b)
        await _report_delivered(window_b, payload["msg_key"], ok=True)

    task = asyncio.create_task(window_b_delivers_but_the_agent_stays_silent())
    result = await plan_mcp.cli_send_and_wait(
        "beta/worker", "run the tests", _ctx("pa"), timeout_s=0.3
    )
    await task

    assert result["idle"] is False
    assert result["source"] == "timeout"
    assert result["reason"] == "never_started"
    assert "last_activity" not in result
    # Delivery itself was fine; the silence is the agent's, and the two have to
    # stay tellable apart.
    check = await plan_mcp.cli_check_message(result["msg_key"], _ctx("pa"))
    assert check["status"] == "delivered"


@pytest.mark.asyncio
async def test_cli_send_and_wait_reports_a_target_that_vanishes_mid_wait(
    monkeypatch: pytest.MonkeyPatch, log_activity: Any
) -> None:
    """The send lands, then the target's window closes while we wait for it.
    The wait can no longer resolve the address, but the message did go out —
    so this has to stay ok:true with a source that says the finish is
    unconfirmed. Answering ok:false would read as "never sent" and get the
    work dispatched twice."""
    monkeypatch.setattr(plan_mcp, "_WAIT_IDLE_POLL_S", 0.005)
    monkeypatch.setattr(plan_mcp, "_SEND_AND_WAIT_START_GRACE_S", 0.02)
    window_a = _window()
    window_b = _window()
    await _register(window_a, "pa", "sender", "/ws/alpha")
    await _register(window_b, "pw", "worker", "/ws/beta")
    await log_activity("pw", "/ws/beta", "turn_complete", "the answer to the PREVIOUS question")

    async def window_b_delivers_then_disappears() -> None:
        payload = await _await_delivery(window_b)
        await _report_delivered(window_b, payload["msg_key"], ok=True)
        agent_messaging.unregister("pw")

    task = asyncio.create_task(window_b_delivers_then_disappears())
    result = await plan_mcp.cli_send_and_wait(
        "beta/worker", "run the tests", _ctx("pa"), timeout_s=1.0
    )
    await task

    assert result["ok"] is True
    assert result["idle"] is False
    assert result["source"] == "target_lost"
    assert result["error"]
    # `reason` belongs to "timeout" alone; this is not one.
    assert "reason" not in result
    # The send is still on record under the key it returned.
    assert result["target"] == "beta/worker"
    check = await plan_mcp.cli_check_message(result["msg_key"], _ctx("pa"))
    assert check["status"] == "delivered"


@pytest.mark.asyncio
async def test_reading_a_worker_log_incrementally_across_an_exchange(
    tmp_path: Path, log_activity: Any
) -> None:
    """Read the log, send work, and read again with the cursor: the second read
    is the reply alone, not the whole conversation over again."""
    workspace = str(tmp_path)
    window = _window()
    await _register(window, "pa", "sender", workspace)
    await _register(window, "pw", "worker", workspace)
    log = tmp_path / "worker.log"
    log.write_text("$ boot\nready\n", encoding="utf-8")
    app.project_store.record_manual_pane_spawn(
        workspace, pane_id="pw", agent="claude", output_log_file=str(log)
    )

    first = await plan_mcp.cli_read_log("worker", _ctx("pa"))
    assert first["ok"] is True
    assert first["text"] == "$ boot\nready"

    sent = await plan_mcp.cli_send("worker", "run the tests", _ctx("pa"))
    payload = await _await_delivery(window)
    assert payload["cross_workspace"] is False
    await _report_delivered(window, sent["msg_key"], ok=True)
    with log.open("a", encoding="utf-8") as f:
        f.write("> run the tests\nall green\n")
    await log_activity("pw", workspace, "turn_complete", "all green")

    second = await plan_mcp.cli_read_log("worker", _ctx("pa"), since=first["next_cursor"])

    assert second["text"] == "> run the tests\nall green"
    assert second["rotated"] is False
    assert second["next_cursor"] == log.stat().st_size
    # And a third read with the new cursor adds nothing.
    third = await plan_mcp.cli_read_log("worker", _ctx("pa"), since=second["next_cursor"])
    assert third["text"] == ""


@pytest.mark.asyncio
async def test_a_reply_carries_the_correlation_id_of_the_cli_send_it_answers() -> None:
    """The receiving agent echoes the msg_key it was handed; the route handler
    passes it through untouched, so the window that made the cli_send can link
    the answer to the message it sent."""
    window_a = _window()
    window_b = _window()
    await _register(window_a, "pa", "sender", "/ws/alpha")
    await _register(window_b, "pb", "reviewer", "/ws/beta")

    sent = await plan_mcp.cli_send("beta/reviewer", "run the tests", _ctx("pa"))
    delivered = await _await_delivery(window_b)
    await _report_delivered(window_b, sent["msg_key"], ok=True)

    # B's agent answers, echoing the correlation id it was delivered with.
    await app.handle_message(window_b, {
        "id": "reply",
        "type": "agent_msg.route",
        "payload": {
            "from_pane_id": "pb",
            "to": "alpha/sender",
            "content": "all green",
            "msg_key": "pb:1",
            "reply_to": delivered["msg_key"],
        },
    })
    await asyncio.sleep(0)

    # Window A saw both halves of the exchange: its own outbound message (every
    # window sees every deliver) and the answer addressed back to it.
    outbound, back = (e["payload"] for e in _events(window_a, "agent_msg.deliver"))
    assert outbound["msg_key"] == sent["msg_key"] and "reply_to" not in outbound
    assert back["target_pane_id"] == "pa"
    assert back["reply_to"] == sent["msg_key"]
    assert back["content"] == "all green"
    assert back["cross_workspace"] is True

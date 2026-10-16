"""Waiting was one-way: the pane being waited on could not tell.

cli_wait_idle (and cli_send_and_wait, which is built on it) parks a caller on
another pane's turn and left no trace anywhere. So the pane being waited on had
no way to learn that somebody was sitting on a two-minute budget — and an agent
that judges it has another twenty minutes of digging in it makes that judgement
very differently once it knows. A waits, times out, B keeps digging: two wrong
decisions from one missing fact.

These cover the registry that closes it, what cli_whoami does with it, and the
three ways a wait can end without unwinding — timeout, cancellation, exception
— because a registry that leaks is worse than none: it reports waiters who
stopped waiting long ago.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging, app
from agent_team_backend.mcp_server import (
    server as plan_mcp,
    auth as plan_mcp_auth,
    wiring as plan_mcp_wiring,
)


@pytest.fixture(autouse=True)
def _clean_registry() -> Any:
    agent_messaging._reset_for_test()
    app._SESSIONS.clear()
    plan_mcp._idle_waiters.clear()
    plan_mcp._mcp_message_status.clear()
    yield
    agent_messaging._reset_for_test()
    app._SESSIONS.clear()
    plan_mcp._idle_waiters.clear()
    plan_mcp._mcp_message_status.clear()


@pytest.fixture(autouse=True)
def _fast_poll(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(plan_mcp, "_WAIT_IDLE_POLL_S", 0.005)


def _ctx(pane_id: str = "pa") -> Any:
    params = {"pane": pane_id, "t": plan_mcp_wiring.caller_token(pane_id)}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


def _external_ctx() -> Any:
    plan_mcp_auth.set_external_enabled(True)
    params = {"client": "external", "t": plan_mcp_auth.external_token()}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


@pytest.fixture
def unreachable_window(monkeypatch: pytest.MonkeyPatch) -> None:
    """No window answers the status probe, so a wait on a busy pane keeps going.

    The point of these tests is the wait itself, not how it ends.
    """

    async def fake_ui_request(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        return {"ok": False}

    monkeypatch.setattr(plan_mcp, "_ui_request", fake_ui_request)


def _seed_pair() -> None:
    agent_messaging.register("pa", "lead", "/ws/alpha", agent_key="claude")
    agent_messaging.register("pb", "worker", "/ws/alpha", agent_key="codex")


async def _until_registered(pane_id: str) -> None:
    for _ in range(400):
        if plan_mcp._idle_waiters.get(pane_id):
            return
        await asyncio.sleep(0.005)
    raise AssertionError(f"nobody was ever registered as waiting on {pane_id}")


# ── A. the pane being waited on can see the wait ───────────────────────────
@pytest.mark.asyncio
async def test_the_pane_being_waited_on_learns_who_is_waiting(
    unreachable_window: None,
) -> None:
    """The whole gap in one assertion: while A is parked on B, B's own
    cli_whoami used to look exactly as it does when nobody is waiting."""
    _seed_pair()
    agent_messaging.set_busy("pb", True)

    wait = asyncio.create_task(
        plan_mcp.cli_wait_idle("worker", _ctx("pa"), timeout_s=5.0)
    )
    try:
        await _until_registered("pb")
        me = await plan_mcp.cli_whoami(_ctx("pb"))
    finally:
        wait.cancel()
        await asyncio.gather(wait, return_exceptions=True)

    assert me["waiting_on_me"] == [
        {
            "waiting_s": me["waiting_on_me"][0]["waiting_s"],
            "pane_id": "pa",
            "name": "lead",
            "address": "alpha/lead",
        }
    ]
    assert me["waiting_on_me"][0]["waiting_s"] >= 0


@pytest.mark.asyncio
async def test_nobody_waiting_leaves_the_key_out_entirely() -> None:
    """Absent, not empty — the convention every optional key here follows, and
    the guarantee that a pane nobody waits on answers as it always did."""
    _seed_pair()
    me = await plan_mcp.cli_whoami(_ctx("pb"))
    assert "waiting_on_me" not in me
    assert set(me) == {
        "ok", "caller", "name", "address", "pane_id", "workspace_path",
        "same_workspace", "busy", "offline", "realized", "agent_key", "delegation_hint",
    }


@pytest.mark.asyncio
async def test_a_waiter_is_reported_under_the_identity_it_answers_to_today() -> None:
    """Names are resolved on read, not stamped at registration: a waiter whose
    pane was rebuilt around its running CLI answers to a new id, and the wait it
    started under the retired one is still its wait."""
    agent_messaging.register("pa2", "lead", "/ws/alpha", agent_key="claude")
    agent_messaging.add_aliases("pa2", ["pa"], "/ws/alpha")
    agent_messaging.register("pb", "worker", "/ws/alpha", agent_key="codex")

    with plan_mcp._waiting_on("pb", plan_mcp._Caller(kind="pane", pane_id="pa")):
        me = await plan_mcp.cli_whoami(_ctx("pb"))

    row = me["waiting_on_me"][0]
    assert row["pane_id"] == "pa2"
    assert row["name"] == "lead"


@pytest.mark.asyncio
async def test_a_waiter_whose_pane_is_gone_is_still_reported_as_waiting() -> None:
    """The wait is real even when the waiter can no longer be named — reporting
    nobody would be the same lie the whole feature exists to stop."""
    agent_messaging.register("pb", "worker", "/ws/alpha", agent_key="codex")

    with plan_mcp._waiting_on("pb", plan_mcp._Caller(kind="pane", pane_id="ghost")):
        me = await plan_mcp.cli_whoami(_ctx("pb"))

    row = me["waiting_on_me"][0]
    assert row["pane_id"] == "ghost"
    assert "name" not in row


@pytest.mark.asyncio
async def test_a_waiter_with_no_pane_identity_is_named_by_its_credential(
    unreachable_window: None,
) -> None:
    """A host or external caller has no pane and therefore no name. It must not
    borrow the target's, and it must not be silently dropped."""
    agent_messaging.register("pb", "worker", "/ws/alpha", agent_key="codex")
    agent_messaging.set_busy("pb", True)

    wait = asyncio.create_task(
        plan_mcp.cli_wait_idle("alpha/worker", _external_ctx(), timeout_s=5.0)
    )
    try:
        await _until_registered("pb")
        me = await plan_mcp.cli_whoami(_ctx("pb"))
    finally:
        wait.cancel()
        await asyncio.gather(wait, return_exceptions=True)

    row = me["waiting_on_me"][0]
    assert row["caller"] == "external"
    assert "pane_id" not in row and "name" not in row


def test_two_waits_from_one_caller_are_one_waiter() -> None:
    """cli_send_and_wait nests cli_wait_idle inside its own registration. Two
    rows for one waiting call would overstate the queue, and unwinding the inner
    one must not cancel the outer wait that is still parked."""
    outer = plan_mcp._waiting_on("pb", plan_mcp._Caller(kind="pane", pane_id="pa"))
    outer.__enter__()
    since = plan_mcp._idle_waiters["pb"]["pa"]["since"]
    with plan_mcp._waiting_on("pb", plan_mcp._Caller(kind="pane", pane_id="pa")):
        assert len(plan_mcp._idle_waiters["pb"]) == 1
    # Inner gone, outer still waiting — and dated from when the outer started.
    assert plan_mcp._idle_waiters["pb"]["pa"]["since"] == since
    outer.__exit__(None, None, None)
    assert plan_mcp._idle_waiters == {}


@pytest.mark.asyncio
async def test_waiters_are_reported_longest_wait_first() -> None:
    """The one about to time out is the one worth reading first."""
    agent_messaging.register("pa", "lead", "/ws/alpha", agent_key="claude")
    agent_messaging.register("pc", "auditor", "/ws/alpha", agent_key="claude")
    agent_messaging.register("pb", "worker", "/ws/alpha", agent_key="codex")

    with plan_mcp._waiting_on("pb", plan_mcp._Caller(kind="pane", pane_id="pc")):
        with plan_mcp._waiting_on("pb", plan_mcp._Caller(kind="pane", pane_id="pa")):
            plan_mcp._idle_waiters["pb"]["pc"]["since"] -= 30.0
            me = await plan_mcp.cli_whoami(_ctx("pb"))

    assert [row["name"] for row in me["waiting_on_me"]] == ["auditor", "lead"]
    assert me["waiting_on_me"][0]["waiting_s"] >= 30.0


# ── B. the registry must not outlive the wait ──────────────────────────────
@pytest.mark.asyncio
async def test_a_wait_that_returns_leaves_nothing_behind() -> None:
    _seed_pair()
    result = await plan_mcp.cli_wait_idle("worker", _ctx("pa"), timeout_s=5.0)
    assert result["idle"] is True
    assert plan_mcp._idle_waiters == {}


@pytest.mark.asyncio
async def test_a_wait_that_times_out_leaves_nothing_behind(
    unreachable_window: None,
) -> None:
    """The most common way a wait ends is the timeout, so a leak here would be
    the normal case: a permanent waiter for every wait that ran out."""
    _seed_pair()
    agent_messaging.set_busy("pb", True)

    result = await plan_mcp.cli_wait_idle("worker", _ctx("pa"), timeout_s=0.0)
    assert result["idle"] is False and result["source"] == "timeout"
    assert plan_mcp._idle_waiters == {}


@pytest.mark.asyncio
async def test_a_cancelled_wait_leaves_nothing_behind(
    unreachable_window: None,
) -> None:
    """A disconnecting MCP client cancels the task rather than returning from
    it, which is the one path a plain `del` after the loop would never reach."""
    _seed_pair()
    agent_messaging.set_busy("pb", True)

    wait = asyncio.create_task(
        plan_mcp.cli_wait_idle("worker", _ctx("pa"), timeout_s=60.0)
    )
    await _until_registered("pb")
    wait.cancel()
    await asyncio.gather(wait, return_exceptions=True)

    assert plan_mcp._idle_waiters == {}


@pytest.mark.asyncio
async def test_a_wait_that_raises_leaves_nothing_behind(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed_pair()
    agent_messaging.set_busy("pb", True)

    async def boom(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        raise RuntimeError("the window blew up mid-probe")

    monkeypatch.setattr(plan_mcp, "_ui_request", boom)

    with pytest.raises(RuntimeError):
        await plan_mcp.cli_wait_idle("worker", _ctx("pa"), timeout_s=5.0)
    assert plan_mcp._idle_waiters == {}


@pytest.mark.asyncio
async def test_a_refused_target_never_registers_a_waiter() -> None:
    """Registration happens after the target resolves, so a wait that never
    started must not leave a waiter on a pane it could not even name."""
    agent_messaging.register("pa", "lead", "/ws/alpha", agent_key="claude")
    result = await plan_mcp.cli_wait_idle("nobody", _ctx("pa"), timeout_s=5.0)
    assert result["ok"] is False
    assert plan_mcp._idle_waiters == {}


# ── C. the wait's own answer is untouched ──────────────────────────────────
@pytest.mark.asyncio
async def test_cli_wait_idle_answers_exactly_as_it_did() -> None:
    """The waiter registry is for the pane being waited on. The caller's own
    result must not have grown a key."""
    _seed_pair()
    result = await plan_mcp.cli_wait_idle("worker", _ctx("pa"), timeout_s=5.0)
    assert set(result) == {"idle", "source", "waited_s"}
    assert result["source"] == "quiet_period"


# ── D. cli_send_and_wait, where the bite actually happens ──────────────────
class _FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


def _window() -> app.Session:
    session = app.Session(_FakeWebSocket())  # type: ignore[arg-type]
    app._SESSIONS.add(session)
    return session


async def _await_deliver(session: app.Session) -> dict[str, Any]:
    for _ in range(400):
        for frame in list(session.websocket.sent):  # type: ignore[attr-defined]
            if frame.get("type") == "agent_msg.deliver":
                return frame["payload"]
        await asyncio.sleep(0.005)
    raise AssertionError("the deliver event never reached the window")


@pytest.mark.asyncio
async def test_send_and_wait_is_visible_while_the_message_is_still_held() -> None:
    """The exact scenario: A calls cli_send_and_wait with a two-minute budget,
    the message is queued behind whatever B is mid-way through, and B — deciding
    it has another twenty minutes of digging in it — is the one who needs to
    know somebody is already parked on the answer. Registering only once the
    message lands would leave that whole window blind.
    """
    session_a = _window()
    session_b = _window()
    for session, pane_id, name, workspace in (
        (session_a, "pa", "lead", "/ws/alpha"),
        (session_b, "pw", "worker", "/ws/beta"),
    ):
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

    task = asyncio.create_task(
        plan_mcp.cli_send_and_wait("beta/worker", "run the tests", _ctx("pa"), timeout_s=2.0)
    )
    try:
        # The send went out; nobody has reported it delivered, so it is exactly
        # as held as a message queued behind a busy pane.
        await _await_deliver(session_b)
        await _until_registered("pw")
        me = await plan_mcp.cli_whoami(_ctx("pw"))
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    assert me["waiting_on_me"][0]["address"] == "alpha/lead"
    assert plan_mcp._idle_waiters == {}


@pytest.mark.asyncio
async def test_send_and_wait_stays_visible_while_the_target_picks_the_message_up(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The message has landed and the turn has not started: cli_send_and_wait
    spends up to ten seconds here watching for the target to pick it up. That
    is the likeliest moment of all for a freshly-messaged agent to call
    cli_whoami and decide what to do next, and it sits between the delivery
    wait and the idle wait — so without its own registration it is a hole in
    the middle of the very wait it belongs to.

    cli_wait_idle is stubbed out precisely because it registers too: left in,
    it would answer for the window under test.
    """
    session_a = _window()
    session_b = _window()
    for session, pane_id, name, workspace in (
        (session_a, "pa", "lead", "/ws/alpha"),
        (session_b, "pw", "worker", "/ws/beta"),
    ):
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

    async def never_idle(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        await asyncio.sleep(5.0)
        raise AssertionError("the grace window should still have been running")

    monkeypatch.setattr(plan_mcp, "cli_wait_idle", never_idle)

    task = asyncio.create_task(
        plan_mcp.cli_send_and_wait("beta/worker", "run the tests", _ctx("pa"), timeout_s=6.0)
    )
    try:
        payload = await _await_deliver(session_b)
        await app.handle_message(session_b, {
            "id": "delivered",
            "type": "agent_msg.delivered",
            "payload": {"msg_key": payload["msg_key"], "ok": True, "reason": ""},
        })
        # Long enough for the delivery wait to have returned and the grace loop
        # to be the only thing left running.
        await asyncio.sleep(0.2)
        me = await plan_mcp.cli_whoami(_ctx("pw"))
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    assert me["waiting_on_me"][0]["address"] == "alpha/lead"
    assert plan_mcp._idle_waiters == {}

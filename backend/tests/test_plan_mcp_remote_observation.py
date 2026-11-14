"""cli_get_status / cli_wait_idle / cli_send_and_wait against a pane on ANOTHER
machine.

The data was already here: every window uploads its panes' badge words to
Navide-Server, the directory lands in `remote_roster`, and cli_list_targets has
been handing `busy` / `offline` / `host_online` / `status` back for remote panes
all along. Only the three observing tools refused the address, one line before
anything was consulted.

What these tests are really pinning is the HONESTY of the remote answers. The
roster is one word per pane, debounced on its way here, with no turn_complete
and no `awaitingKind` behind it — so a remote "finished" is worth strictly less
than a local one, and the result has to say so rather than reusing the local
vocabulary. Hence: `source` is never "turn_complete" for a remote pane, an
"awaiting" timeout is named for the distinction that could not be made, and
"offline" is its own answer instead of a flavour of busy.
"""

from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging, app, remote_roster
from agent_team_backend.mcp_server import server as plan_mcp, wiring as plan_mcp_wiring


@pytest.fixture(autouse=True)
def _clean_state(monkeypatch: pytest.MonkeyPatch) -> Any:
    agent_messaging._reset_for_test()
    remote_roster._reset_for_test()
    app._pane_activity.clear()
    plan_mcp._mcp_message_status.clear()
    plan_mcp._status_waiters.clear()
    # cli_get_status's ui lookup waits for a reply nobody sends in these tests;
    # keep the wait short so the LOCAL regression pins do not eat 15s each.
    monkeypatch.setattr(plan_mcp, "_UI_INVOKE_TIMEOUT_S", 0.02)
    monkeypatch.setattr(plan_mcp, "_WAIT_IDLE_POLL_S", 0.01)
    # In production the pick-up grace (10s) is a small slice of the budget
    # (60s), so the idle wait after it is where a send_and_wait spends its
    # time. At test timeouts the grace would swallow the whole budget and that
    # loop would never run at all — shrink the grace, not the realism.
    monkeypatch.setattr(plan_mcp, "_SEND_AND_WAIT_START_GRACE_S", 0.02)
    yield
    agent_messaging._reset_for_test()
    remote_roster._reset_for_test()
    app._pane_activity.clear()
    plan_mcp._mcp_message_status.clear()
    plan_mcp._status_waiters.clear()


def _ctx(pane_id: str = "pa") -> Any:
    params = {"pane": pane_id, "t": plan_mcp_wiring.caller_token(pane_id)}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


def _remote_row(**overrides: Any) -> dict[str, Any]:
    row = {
        "sessionId": "sess-1",
        "deviceId": "far-device-id",
        "workspace": "gamma",
        "workspacePath": "/home/other/gamma",
        "title": "builder",
        "paneId": "p-far",
        "agentKey": "codex",
        "status": "idle",
        "hostOnline": True,
    }
    row.update(overrides)
    return row


REMOTE = "far-device-id/gamma/builder"


def _seed_local() -> None:
    """The calling pane, plus a local pane to prove the local path is untouched."""
    agent_messaging.register("pa", "caller", "/ws/alpha", agent_key="claude")
    agent_messaging.register("pw", "worker", "/ws/alpha", agent_key="codex")


def _seed_remote(**overrides: Any) -> None:
    remote_roster.replace([_remote_row(**overrides)], local_device_id="this-device")


class _ScriptedRoster:
    """The roster's status word, advanced one step per read.

    `remote_roster.replace` seeds the real cache (address resolution reads it
    directly), and this replaces only `list_panes`, which is what the polling
    loops go through. Driving the transition off reads rather than off the wall
    clock keeps the tests deterministic: a status change happens because the
    code looked, not because enough time passed.
    """

    def __init__(self, statuses: list[str | None], **row: Any) -> None:
        self.statuses = statuses
        self.row = row
        self.reads = 0

    def list_panes(self) -> list[Any]:
        status = self.statuses[min(self.reads, len(self.statuses) - 1)]
        self.reads += 1
        if status is None:
            return []
        return [remote_roster._pane_from_row(_remote_row(status=status, **self.row))]


def _script(
    monkeypatch: pytest.MonkeyPatch, statuses: list[str | None], **row: Any
) -> _ScriptedRoster:
    _seed_remote(**row)
    scripted = _ScriptedRoster(statuses, **row)
    monkeypatch.setattr(remote_roster, "list_panes", scripted.list_panes)
    return scripted


def _link(
    monkeypatch: pytest.MonkeyPatch, *, ack: str | None = "delivered", reason: str = ""
) -> list[dict[str, Any]]:
    """A server link that accepts the relay and acks it the way `ack` says.

    `ack=None` leaves the message unacked, which is what a far device that never
    answers looks like from here.
    """
    from agent_team_backend import server_link

    sent: list[dict[str, Any]] = []

    async def fake_send_message(**kwargs: Any) -> dict[str, Any]:
        sent.append(kwargs)
        if ack is not None:

            async def settle() -> None:
                # Runs at the first await after _record_message_sent, which is
                # the delivery wait itself — an ack recorded before that would
                # find no entry to settle.
                await asyncio.sleep(0)
                plan_mcp.record_remote_ack(kwargs["msg_key"], ack, reason)

            asyncio.get_running_loop().create_task(settle())
        return {"ok": True, "payload": {"state": "pending"}}

    monkeypatch.setattr(server_link, "send_message", fake_send_message)
    return sent


# ── cli_get_status ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_get_status_answers_a_remote_pane_from_the_roster() -> None:
    _seed_local()
    _seed_remote(status="running")

    result = await plan_mcp.cli_get_status(REMOTE, _ctx())

    assert result == {
        "ok": True,
        "remote": True,
        "source": "roster_status",
        "name": "builder",
        "address": REMOTE,
        "device": "far-device-id",
        "workspace": "gamma",
        "workspace_path": "/home/other/gamma",
        "agent_key": "codex",
        "busy": True,
        "offline": False,
        "host_online": True,
        "status": "running",
    }


@pytest.mark.asyncio
async def test_get_status_never_claims_a_local_reading_for_a_remote_pane() -> None:
    """The keys that would be a lie: `last_activity` comes from an activity
    log this machine does not keep for a pane it does not own, `ui` from a
    window it cannot reach, and `usage` from a quota cache for the wrong
    machine's accounts."""
    _seed_local()
    _seed_remote()

    result = await plan_mcp.cli_get_status(REMOTE, _ctx())

    assert "last_activity" not in result
    assert "ui" not in result
    # And `usage`: this machine's quota cache is about this machine's logins.
    assert "usage" not in result
    assert result["source"] == "roster_status"


@pytest.mark.asyncio
async def test_get_status_separates_offline_from_busy() -> None:
    """A machine that is away is neither working nor free: `offline` says so,
    and `busy` must not swallow it."""
    _seed_local()
    _seed_remote(hostOnline=False, status="idle")

    result = await plan_mcp.cli_get_status(REMOTE, _ctx())

    assert result["offline"] is True
    assert result["host_online"] is False
    assert result["busy"] is False


@pytest.mark.asyncio
async def test_get_status_refuses_a_remote_address_the_roster_does_not_list() -> None:
    """A device segment this machine has no directory for. Refused with a code
    of its own — it is not a typo in a local address."""
    _seed_local()
    _seed_remote(title="somebody-else")

    result = await plan_mcp.cli_get_status(REMOTE, _ctx())

    assert result["ok"] is False
    assert result["error_code"] == "unknown-remote-pane"
    assert "session directory" in result["error"]


@pytest.mark.asyncio
async def test_a_device_id_with_no_server_configured_answers_as_before() -> None:
    """The zero-regression line for a machine that never had a link. An
    id-shaped device segment still comes back "unknown-device" with the same
    sentence: the roster is empty, so consulting it adds nothing to say."""
    _seed_local()

    result = await plan_mcp.cli_get_status(
        "11111111-2222-3333-4444-555555555555/gamma/builder", _ctx()
    )

    assert result["ok"] is False
    assert result["error_code"] == "unknown-device"
    assert "not linked to a Navide-Server" in result["error"]


@pytest.mark.asyncio
async def test_get_status_keeps_the_local_answer_byte_for_byte(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The regression pin: a local pane's shape may not gain a key because
    remote targets now resolve."""
    _seed_local()
    _seed_remote()
    agent_messaging.set_busy("pw", True)
    app._record_pane_activity("pw", "turn_complete", "all done")

    async def _no_window(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        return {"ok": False, "result": None, "error": "timed out"}

    monkeypatch.setattr(plan_mcp, "_ui_request", _no_window)

    result = await plan_mcp.cli_get_status("worker", _ctx())

    # `account` is 0.2.34 P2's addition for every local pane of a vendor with
    # accounts (codex is one), not something the remote roster brought in.
    assert set(result) == {"ok", "name", "agent_key", "busy", "last_activity", "account"}
    assert result["busy"] is True
    assert result["last_activity"]["text"] == "all done"


@pytest.mark.asyncio
async def test_a_local_workspace_still_beats_a_device_of_the_same_name() -> None:
    """The protection cli_send already has, now that these tools consult the
    roster too: `two/proj/target` is a local address and a machine called `two`
    cannot take it."""
    agent_messaging.register("pa", "caller", "/ws/alpha")
    agent_messaging.register("pt", "target", "/two/proj", agent_key="claude")
    remote_roster.replace(
        [_remote_row(deviceName="two", workspace="proj", title="target")],
        local_device_id="this-device",
    )

    result = await plan_mcp.cli_get_status("two/proj/target", _ctx())

    assert "remote" not in result
    assert result["agent_key"] == "claude"


# ── cli_wait_idle ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_wait_idle_settles_a_remote_pane_as_roster_status() -> None:
    _seed_local()
    _seed_remote(status="idle")

    result = await plan_mcp.cli_wait_idle(REMOTE, _ctx(), timeout_s=5.0)

    assert result["idle"] is True
    # The whole point: a remote finish is NOT a turn_complete, and must never
    # borrow the word for one.
    assert result["source"] == "roster_status"
    assert result["remote"] is True
    assert result["status"] == "idle"
    assert "last_activity" not in result
    assert "ui_status" not in result


@pytest.mark.asyncio
async def test_wait_idle_settles_on_a_remote_session_that_ended() -> None:
    """exited / stopped / error end the wait, exactly as the local path settles
    on them — a dead pane must not run the caller's budget out."""
    _seed_local()
    for status in ("exited", "stopped", "error"):
        _seed_remote(status=status)
        result = await plan_mcp.cli_wait_idle(REMOTE, _ctx(), timeout_s=5.0)
        assert result["idle"] is True, status
        assert result["source"] == "roster_status", status
        assert result["status"] == status, status


@pytest.mark.asyncio
async def test_wait_idle_reports_an_away_machine_as_its_own_answer() -> None:
    """offline is the third answer. Not busy (nothing is working) and not idle
    (nothing can be handed over), and returned at once rather than waited out."""
    _seed_local()
    _seed_remote(hostOnline=False, status="running")

    result = await plan_mcp.cli_wait_idle(REMOTE, _ctx(), timeout_s=30.0)

    assert result["idle"] is False
    assert result["source"] == "roster_offline"
    assert result["reason"] == "offline"
    assert result["host_online"] is False
    assert result["waited_s"] < 1.0


@pytest.mark.asyncio
async def test_wait_idle_reports_a_disconnected_window_as_offline_too() -> None:
    """The other half of `offline`: the machine is up, the window that owns the
    pane is not. Same answer, because nothing on the far side can report a turn
    ending either way."""
    _seed_local()
    _seed_remote(status="disconnected")

    result = await plan_mcp.cli_wait_idle(REMOTE, _ctx(), timeout_s=30.0)

    assert result["source"] == "roster_offline"
    assert result["reason"] == "offline"
    assert result["host_online"] is True


@pytest.mark.asyncio
async def test_wait_idle_times_out_on_a_working_remote_pane() -> None:
    _seed_local()
    _seed_remote(status="running")

    result = await plan_mcp.cli_wait_idle(REMOTE, _ctx(), timeout_s=0.05)

    assert result["idle"] is False
    assert result["source"] == "timeout"
    assert result["reason"] == "busy"


@pytest.mark.asyncio
async def test_wait_idle_names_the_awaiting_ambiguity_it_cannot_resolve() -> None:
    """Locally `awaitingKind` splits a permission prompt (waiting on a HUMAN)
    from an open question (which counts as idle). The roster carries one word
    for both, so the wait runs out and the reason says which distinction was
    missing — reporting plain "awaiting", the local word, would claim the split
    had been made."""
    _seed_local()
    _seed_remote(status="awaiting")

    result = await plan_mcp.cli_wait_idle(REMOTE, _ctx(), timeout_s=0.05)

    assert result["idle"] is False
    assert result["source"] == "timeout"
    assert result["reason"] == "awaiting_unclassified"
    assert result["status"] == "awaiting"


@pytest.mark.asyncio
async def test_wait_idle_treats_an_unknown_status_word_as_still_working() -> None:
    """A word this build never heard of, and the legacy "waiting" that an
    un-upgraded peer sends for every pane whatever it is doing. Neither may end
    a wait: "I do not recognise this" is not "it finished"."""
    _seed_local()
    for status in ("waiting", "some-future-word"):
        _seed_remote(status=status)
        result = await plan_mcp.cli_wait_idle(REMOTE, _ctx(), timeout_s=0.05)
        assert result["idle"] is False, status
        assert result["source"] == "timeout", status
        assert result["reason"] == "busy", status


@pytest.mark.asyncio
async def test_wait_idle_returns_when_the_remote_pane_leaves_the_roster(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Mid-wait the far pane disappears from the directory. There is nothing
    left to watch, so this refuses rather than reporting a made-up idle —
    cli_send_and_wait turns it into `target_lost`."""
    _seed_local()
    _script(monkeypatch, ["running", "running", None])

    result = await plan_mcp.cli_wait_idle(REMOTE, _ctx(), timeout_s=5.0)

    assert result["ok"] is False
    assert result["error_code"] == "unknown-remote-pane"


@pytest.mark.asyncio
async def test_wait_idle_waits_out_a_remote_pane_that_becomes_idle(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed_local()
    _script(monkeypatch, ["running", "running", "running", "idle"])

    result = await plan_mcp.cli_wait_idle(REMOTE, _ctx(), timeout_s=5.0)

    assert result["idle"] is True
    assert result["source"] == "roster_status"


@pytest.mark.asyncio
async def test_wait_idle_keeps_the_local_answer_byte_for_byte() -> None:
    """The regression pin for the local path: same source vocabulary, same
    keys, and no `remote` marker leaking into it."""
    _seed_local()
    _seed_remote()
    app._record_pane_activity("pw", "turn_complete", "done")

    result = await plan_mcp.cli_wait_idle("worker", _ctx(), timeout_s=5.0)

    assert set(result) == {"idle", "source", "waited_s", "last_activity"}
    assert result["source"] == "turn_complete"
    assert result["last_activity"]["text"] == "done"


# ── cli_send_and_wait ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_send_and_wait_reaches_a_remote_pane_end_to_end(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The send half already crossed devices; only the resolve in front of it
    said no. With that gone: relay, remote ack, then the roster shows the pane
    working and going quiet."""
    _seed_local()
    sent = _link(monkeypatch)
    _script(monkeypatch, ["running"] * 5 + ["idle"])

    result = await plan_mcp.cli_send_and_wait(REMOTE, "please review", _ctx(), timeout_s=5.0)

    assert sent[0]["to"] == {
        "deviceId": "far-device-id",
        "workspace": "gamma",
        "paneName": "builder",
    }
    assert result["ok"] is True
    assert result["target"] == REMOTE
    assert result["idle"] is True
    assert result["source"] == "roster_status"
    assert result["msg_key"]


@pytest.mark.asyncio
async def test_send_and_wait_gates_on_the_far_devices_ack(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The delivery gate is the far device's messages.ack, not a local hold: no
    ack inside the budget means the message is still in flight, and there is no
    turn to wait for yet."""
    _seed_local()
    _link(monkeypatch, ack=None)
    _seed_remote(status="idle")

    result = await plan_mcp.cli_send_and_wait(REMOTE, "go", _ctx(), timeout_s=0.2)

    assert result["ok"] is True
    assert result["idle"] is False
    assert result["source"] == "not_delivered"
    assert result["delivery_status"] == "queued"


@pytest.mark.asyncio
async def test_send_and_wait_keeps_a_policy_refusal_distinct_from_a_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """"rejected" is the far device's pane policy saying no, and resending will
    be refused again. Collapsing it into "failed" would invite exactly that
    retry loop."""
    _seed_local()
    _link(monkeypatch, ack="rejected", reason="pane-policy")
    _seed_remote(status="idle")

    result = await plan_mcp.cli_send_and_wait(REMOTE, "go", _ctx(), timeout_s=0.4)

    assert result["source"] == "not_delivered"
    assert result["delivery_status"] == "rejected"
    assert result["reason"] == "pane-policy"


@pytest.mark.asyncio
async def test_send_and_wait_will_not_pass_a_pane_that_never_stirred_off_as_done(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The local tool exists to stop "it was idle when I sent" being reported as
    "it finished your work". Remotely the only evidence of a turn is the badge
    going busy, so a pane that never does gets the same never_started answer
    rather than the idle it was already in."""
    _seed_local()
    _link(monkeypatch)
    _seed_remote(status="idle")

    result = await plan_mcp.cli_send_and_wait(REMOTE, "go", _ctx(), timeout_s=0.3)

    assert result["ok"] is True
    assert result["idle"] is False
    assert result["source"] == "timeout"
    assert result["reason"] == "never_started"


@pytest.mark.asyncio
async def test_send_and_wait_does_not_call_a_remote_turn_seen_at_the_deadline_never_started(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With timeout_s under the grace cap the grace window IS the budget, so a
    pane the roster first shows working on the poll that crosses the deadline is
    latched as started with no budget left. That pane has picked the message up;
    answering "never_started" tells the caller it did not — an invitation to
    send it twice.

    The tool runs on a virtual clock that only its own sleeps advance, so where
    the badge flips relative to the deadline is scripted, not raced."""
    budget = 0.5
    clock = SimpleNamespace(now=0.0)
    real_sleep = asyncio.sleep

    async def virtual_sleep(delay: float) -> None:
        clock.now += delay
        await real_sleep(0)

    monkeypatch.setattr(
        plan_mcp, "time", SimpleNamespace(monotonic=lambda: clock.now, time=time.time)
    )

    class VirtualAsyncio:
        sleep = staticmethod(virtual_sleep)

        def __getattr__(self, name: str) -> Any:
            return getattr(asyncio, name)

    monkeypatch.setattr(plan_mcp, "asyncio", VirtualAsyncio())
    # The production grace (10s) outlasts this budget, which is what makes the
    # grace window run all the way to the deadline.
    monkeypatch.setattr(plan_mcp, "_SEND_AND_WAIT_START_GRACE_S", 10.0)
    _seed_local()
    _link(monkeypatch)
    _seed_remote(status="idle")

    def list_panes() -> list[Any]:
        # Working from the deadline on: first seen by the grace poll that
        # crosses it.
        status = "running" if clock.now >= budget else "idle"
        return [remote_roster._pane_from_row(_remote_row(status=status))]

    monkeypatch.setattr(remote_roster, "list_panes", list_panes)

    result = await plan_mcp.cli_send_and_wait(REMOTE, "go", _ctx(), timeout_s=budget)

    assert clock.now >= budget
    assert result["ok"] is True
    assert result["idle"] is False
    assert result["source"] == "timeout"
    assert result["reason"] == "busy"


@pytest.mark.asyncio
async def test_send_and_wait_returns_promptly_on_a_zero_remote_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Looking once before giving up must not turn a spent budget into a loop:
    with timeout_s=0 the tool checks the pane once and answers."""
    _seed_local()
    _link(monkeypatch)
    _seed_remote(status="idle")

    result = await asyncio.wait_for(
        plan_mcp.cli_send_and_wait(REMOTE, "go", _ctx(), timeout_s=0.0), timeout=5.0
    )

    assert result["ok"] is True
    assert result["idle"] is False
    assert result["reason"] == "never_started"


@pytest.mark.asyncio
async def test_send_and_wait_reports_a_remote_pane_that_stays_busy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed_local()
    _link(monkeypatch)
    _seed_remote(status="running")

    result = await plan_mcp.cli_send_and_wait(REMOTE, "go", _ctx(), timeout_s=0.3)

    assert result["idle"] is False
    assert result["source"] == "timeout"
    assert result["reason"] == "busy"


@pytest.mark.asyncio
async def test_send_and_wait_reports_a_refused_relay_unchanged(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A send the link refuses is still cli_send's answer, untouched — the wait
    never starts."""
    from agent_team_backend import server_link

    _seed_local()
    _seed_remote(status="idle")

    async def refuse(**_kwargs: Any) -> dict[str, Any]:
        return {"ok": False, "error": {"code": "DEVICE_OFFLINE", "message": "away"}}

    monkeypatch.setattr(server_link, "send_message", refuse)

    result = await plan_mcp.cli_send_and_wait(REMOTE, "go", _ctx(), timeout_s=0.3)

    assert result["ok"] is False
    assert result["error_code"] == "device-offline"


@pytest.mark.asyncio
async def test_send_and_wait_still_refuses_a_broadcast_with_a_roster_loaded() -> None:
    """The group gate sits in front of the resolve and must stay there: a
    broadcast has no one turn to wait for, remote roster or not."""
    _seed_local()
    _seed_remote()

    result = await plan_mcp.cli_send_and_wait("group", "go", _ctx(), timeout_s=0.1)

    assert result["ok"] is False
    assert result["error_code"] == "broadcast-unsupported"


# ── The tools deliberately left local-only ─────────────────────────────────


@pytest.mark.asyncio
async def test_read_log_still_refuses_a_remote_pane() -> None:
    """No handler on the far side can answer a log read — the return channel is
    a one-word ack — so this stays refused rather than half-working."""
    _seed_local()
    _seed_remote()

    result = await plan_mcp.cli_read_log(REMOTE, _ctx())

    assert result["ok"] is False
    # Unchanged, including the unhelpful part: a device *name* never reached
    # the roster from here, so it comes back as a workspace that does not
    # exist. Widening cli_read_log is out of scope, and so is repainting the
    # error it has always given.
    assert result["error_code"] == "unknown-workspace"


@pytest.mark.asyncio
async def test_interrupt_still_refuses_a_remote_pane() -> None:
    """An interrupt is a byte written into a local PTY; the roster being
    readable does not make one relayable."""
    _seed_local()
    _seed_remote()

    result = await plan_mcp.cli_interrupt(REMOTE, _ctx())

    assert result["ok"] is False
    assert result["error_code"] == "interrupt-local-only"

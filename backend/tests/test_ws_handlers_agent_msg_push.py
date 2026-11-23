"""agent_msg.push handler: the transport half of push delivery.

The window that owns a pane decides whether to push — it holds the queue, the
rate limit and the idle gate — so this handler only performs the transport and
reports whether it landed. Two things it must get right: a refusal has to come
back as a plain `ok: false` (the window then types the message in, and a raised
error would strand it), and a push that DID land has to say the pane is now
working, or the window keeps calling it idle and types the next message into a
pane already acting on this one.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import app, claude_hooks, push_delivery, ws_handlers
from agent_team_backend.cli_vendors.base import PushChannel


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


def _session() -> app.Session:
    return app.Session(FakeWebSocket())  # type: ignore[arg-type]


@pytest.fixture()
def broadcasts(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    captured: list[dict] = []

    async def fake_broadcast(event, **_kwargs):
        captured.append(event)

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    return captured


@pytest.fixture(autouse=True)
def clean_state():
    push_delivery._reset_for_test()
    app._pane_activity.clear()
    ws_handlers._PUSHES.clear()
    yield
    push_delivery._reset_for_test()
    app._pane_activity.clear()
    ws_handlers._PUSHES.clear()


async def _push(session: app.Session, **payload: Any) -> dict[str, Any]:
    await app.handle_message(session, {
        "id": "m1", "type": "agent_msg.push", "payload": payload,
    })
    return session.websocket.sent[-1]  # type: ignore[attr-defined]


def _arm_hook_pane(pane_id: str = "pane-1") -> None:
    push_delivery._panes[pane_id] = push_delivery.PaneChannel(
        pane_id=pane_id,
        agent_key="claude",
        kind=push_delivery.KIND_HOOK,
        channel=PushChannel(holds_input_box=False, hook_wait=True),
    )


@pytest.mark.asyncio
async def test_a_landed_push_is_reported_with_its_channel(broadcasts) -> None:
    _arm_hook_pane()
    armed = push_delivery.arm_hook("pane-1")
    assert armed is not None
    session = _session()
    response = await _push(session, pane_id="pane-1", text="hello")
    assert response["payload"] == {
        "ok": True, "kind": "rewake", "reason": "", "unclear": False,
    }


@pytest.mark.asyncio
async def test_a_landed_push_says_the_pane_is_now_working(broadcasts) -> None:
    _arm_hook_pane()
    push_delivery.arm_hook("pane-1")
    await _push(_session(), pane_id="pane-1", text="hello")
    activity = [e["payload"] for e in broadcasts if e["type"] == "agent.activity"]
    assert activity and activity[-1]["event_type"] == "agent_active"
    assert activity[-1]["pane_id"] == "pane-1"
    assert activity[-1]["detail"] == "push:rewake"
    # The same record cli_wait_idle reads, so it cannot call the pane idle.
    assert app._pane_activity["pane-1"]["event_type"] == "agent_active"


@pytest.mark.asyncio
async def test_a_refused_push_reports_ok_false_and_says_nothing_about_activity(
    broadcasts,
) -> None:
    _arm_hook_pane()  # registered, but no waiter parked
    session = _session()
    response = await _push(session, pane_id="pane-1", text="hello")
    assert response["payload"]["ok"] is False
    assert response["payload"]["reason"] == "not-armed"
    assert [e for e in broadcasts if e["type"] == "agent.activity"] == []


@pytest.mark.asyncio
async def test_a_pane_with_no_channel_is_refused_rather_than_erroring(broadcasts) -> None:
    session = _session()
    response = await _push(session, pane_id="unknown", text="hello")
    assert response["payload"] == {
        "ok": False, "kind": "", "reason": "no-channel", "unclear": False,
    }


@pytest.mark.asyncio
async def test_a_failure_that_may_have_left_text_behind_says_so(broadcasts) -> None:
    """`unclear` is what stops the window typing the same envelope in on top of
    a composer that is still holding it."""
    push_delivery._panes["pane-1"] = push_delivery.PaneChannel(
        pane_id="pane-1",
        agent_key="opencode",
        kind=push_delivery.KIND_HTTP,
        channel=PushChannel(
            holds_input_box=True,
            port_flag="--port",
            append_path="/tui/append-prompt",
            submit_path="/tui/submit-prompt",
            clear_path="/tui/clear-prompt",
        ),
        port=1,  # nothing is listening; the append fails before any text lands
    )
    response = await _push(_session(), pane_id="pane-1", text="hello")
    assert response["payload"]["ok"] is False
    assert response["payload"]["reason"] == "not-listening"
    assert response["payload"]["unclear"] is False


@pytest.mark.asyncio
async def test_a_malformed_request_is_an_error(broadcasts) -> None:
    session = _session()
    response = await _push(session, pane_id="", text="hello")
    assert response.get("error", {}).get("code") == "BAD_REQUEST"


@pytest.mark.asyncio
async def test_registering_tells_a_reloaded_window_the_channel_is_still_there(
    broadcasts,
) -> None:
    """A window that reloaded, or reattached to a PTY it did not spawn, never
    saw the announcement made at spawn — and would keep typing into a pane it
    could push to for as long as it lives."""
    from agent_team_backend import agent_messaging

    agent_messaging._reset_for_test()
    _arm_hook_pane()
    push_delivery.arm_hook("pane-1")
    session = _session()
    await app.handle_message(session, {
        "id": "m1",
        "type": "agent_msg.register",
        "payload": {
            "pane_id": "pane-1",
            "name": "worker",
            "workspace_path": "/ws/alpha",
            "agent_key": "claude",
        },
    })
    events = [
        f for f in session.websocket.sent  # type: ignore[attr-defined]
        if f.get("type") == "agent_msg.push_state"
    ]
    assert events and events[0]["payload"] == {
        "pane_id": "pane-1", "kind": "rewake", "ready": True,
    }
    agent_messaging._reset_for_test()


@pytest.mark.asyncio
async def test_switching_a_channel_off_and_on_is_announced_both_ways(
    broadcasts,
) -> None:
    """The switch lives in the generic settings store, so nothing about writing
    it would reach a running pane on its own. Both directions have to be
    announced: a window told to stop offering a channel would otherwise never
    start again when the switch goes back on."""
    # Wired exactly as the app wires it at startup, so the setting the handler
    # writes is the one push_delivery reads back.
    push_delivery.set_disabled_reader(
        lambda: set(app.ui_settings_store.get().get(push_delivery.DISABLED_SETTING_KEY) or [])
    )
    _, state = push_delivery.wire_spawn("qwen", "qwen", "pane-1", {})
    assert state is not None
    session = _session()

    async def write(disabled: list[str]) -> list[dict]:
        broadcasts.clear()
        await app.handle_message(session, {
            "id": "m1", "type": "ui.settings.set",
            "payload": {"updates": {push_delivery.DISABLED_SETTING_KEY: disabled}},
        })
        return [e["payload"] for e in broadcasts if e["type"] == "agent_msg.push_state"]

    try:
        assert await write(["qwen"]) == [
            {"pane_id": "pane-1", "kind": "input-file", "ready": False}
        ]
        assert await write([]) == [
            {"pane_id": "pane-1", "kind": "input-file", "ready": True}
        ]
    finally:
        push_delivery.set_disabled_reader(None)
        app.ui_settings_store.set({push_delivery.DISABLED_SETTING_KEY: []})


@pytest.fixture()
def claude_settings(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point the real hook installer at a throwaway settings file.

    The file not existing is itself an assertion these tests make — it is how
    they tell that the installer never ran.
    """
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path))
    return tmp_path / "settings.json"


@pytest.fixture()
def switches():
    """The disabled-channel setting, wired exactly as the app wires it."""
    push_delivery.set_disabled_reader(
        lambda: set(app.ui_settings_store.get().get(push_delivery.DISABLED_SETTING_KEY) or [])
    )
    try:
        yield
    finally:
        push_delivery.set_disabled_reader(None)
        app.ui_settings_store.set({push_delivery.DISABLED_SETTING_KEY: []})


async def _write_switches(session: app.Session, disabled: list[str]) -> dict[str, Any]:
    await app.handle_message(session, {
        "id": "m1", "type": "ui.settings.set",
        "payload": {"updates": {push_delivery.DISABLED_SETTING_KEY: disabled}},
    })
    return session.websocket.sent[-1]  # type: ignore[attr-defined]


def _rewake_entries(settings_file: Path) -> int:
    if not settings_file.is_file():
        return 0
    hooks = json.loads(settings_file.read_text(encoding="utf-8")).get("hooks", {})
    return sum(
        1
        for entries in hooks.values()
        for entry in entries
        for hook in entry.get("hooks", [])
        if hook.get("asyncRewake")
    )


@pytest.mark.asyncio
async def test_switching_claudes_channel_on_reinstalls_its_hook_at_once(
    broadcasts, switches, claude_settings,
) -> None:
    """Claude's channel is a hook in the user's own settings file, so switching
    it back on has to put the entry there. Waiting for the next backend restart
    would leave nothing for the pane's next turn end to arm."""
    app.ui_settings_store.set({push_delivery.DISABLED_SETTING_KEY: ["claude"]})
    response = await _write_switches(_session(), [])
    assert response["payload"] == {"ok": True}
    assert _rewake_entries(claude_settings) > 0


@pytest.mark.asyncio
async def test_switching_claudes_channel_off_takes_its_hook_out_at_once(
    broadcasts, switches, claude_settings,
) -> None:
    claude_hooks.install_hooks("/tmp/port")
    assert _rewake_entries(claude_settings) > 0
    await _write_switches(_session(), ["claude"])
    assert _rewake_entries(claude_settings) == 0


@pytest.mark.asyncio
async def test_another_vendors_switch_leaves_claudes_settings_file_alone(
    broadcasts, switches, claude_settings,
) -> None:
    """Only claude's channel lives outside Navide, so only claude's switch is
    worth rewriting a settings file for."""
    _, state = push_delivery.wire_spawn("qwen", "qwen", "pane-1", {})
    assert state is not None
    await _write_switches(_session(), ["opencode"])
    assert [e["payload"] for e in broadcasts if e["type"] == "agent_msg.push_state"] == [
        {"pane_id": "pane-1", "kind": "input-file", "ready": True}
    ]
    assert not claude_settings.exists()


@pytest.mark.asyncio
async def test_a_failing_hook_installer_does_not_take_the_settings_write_with_it(
    broadcasts, switches, claude_settings, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The setting is already written by the time the installer runs, and a
    failure only puts the hook back where it used to settle — at the next
    backend restart."""
    def boom(*_args: Any, **_kwargs: Any) -> dict:
        raise OSError("settings.json is read-only")

    monkeypatch.setattr(claude_hooks, "install_hooks", boom)
    _, state = push_delivery.wire_spawn("qwen", "qwen", "pane-1", {})
    assert state is not None
    response = await _write_switches(_session(), ["claude"])
    assert response["payload"] == {"ok": True}
    assert [e["payload"] for e in broadcasts if e["type"] == "agent_msg.push_state"] == [
        {"pane_id": "pane-1", "kind": "input-file", "ready": True}
    ]


@pytest.mark.asyncio
async def test_a_settings_write_that_touches_no_channel_announces_nothing(
    broadcasts,
) -> None:
    _arm_hook_pane()
    session = _session()
    await app.handle_message(session, {
        "id": "m1", "type": "ui.settings.set",
        "payload": {"updates": {"someUnrelatedSetting": "x"}},
    })
    assert [e for e in broadcasts if e["type"] == "agent_msg.push_state"] == []


@pytest.mark.asyncio
async def test_registering_says_nothing_for_a_pane_with_no_live_channel(
    broadcasts,
) -> None:
    from agent_team_backend import agent_messaging

    agent_messaging._reset_for_test()
    _arm_hook_pane()  # registered, but nothing parked on it
    session = _session()
    await app.handle_message(session, {
        "id": "m1",
        "type": "agent_msg.register",
        "payload": {
            "pane_id": "pane-1",
            "name": "worker",
            "workspace_path": "/ws/alpha",
            "agent_key": "claude",
        },
    })
    assert not [
        f for f in session.websocket.sent  # type: ignore[attr-defined]
        if f.get("type") == "agent_msg.push_state"
    ]
    agent_messaging._reset_for_test()


def _slow_deliver(monkeypatch: pytest.MonkeyPatch, outcome: tuple[bool, str] = (True, "")):
    """Replace deliver with one that takes a while and counts its calls."""
    import asyncio

    calls: list[str] = []
    started = asyncio.Event()

    async def deliver(pane_id: str, text: str) -> tuple[bool, str]:
        calls.append(text)
        started.set()
        await asyncio.sleep(0.1)
        return outcome

    monkeypatch.setattr(push_delivery, "deliver", deliver)
    return calls, started


@pytest.mark.asyncio
async def test_a_push_the_requester_hung_up_on_still_announces_the_pane_active(
    broadcasts, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """ws_endpoint cancels a closed connection's handler tasks; a push already
    on its way to the CLI must still tell the windows the pane is working."""
    import asyncio

    _arm_hook_pane()
    _calls, started = _slow_deliver(monkeypatch)
    session = _session()
    task = asyncio.create_task(app.handle_message(session, {
        "id": "m1", "type": "agent_msg.push",
        "payload": {"pane_id": "pane-1", "text": "hello", "push_id": "msg-1"},
    }))
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    for _ in range(100):
        if broadcasts:
            break
        await asyncio.sleep(0.01)
    assert [e["type"] for e in broadcasts] == ["agent.activity"]


@pytest.mark.asyncio
async def test_asking_again_about_a_push_the_requester_lost_does_not_push_twice(
    broadcasts, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The window that lost its answer (socket closed, or its request timed
    out) asks again with the same push_id: it must hear how the first push went
    rather than set off a second one — or type the message in on top."""
    import asyncio

    _arm_hook_pane()
    calls, started = _slow_deliver(monkeypatch)
    first = asyncio.create_task(app.handle_message(_session(), {
        "id": "m1", "type": "agent_msg.push",
        "payload": {"pane_id": "pane-1", "text": "hello", "push_id": "msg-1"},
    }))
    await started.wait()
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first

    retry = _session()
    response = await _push(retry, pane_id="pane-1", text="hello", push_id="msg-1")
    assert calls == ["hello"]
    assert response["payload"]["ok"] is True
    assert [e["type"] for e in broadcasts] == ["agent.activity"]


@pytest.mark.asyncio
async def test_a_push_asked_about_while_still_in_flight_waits_for_that_one(
    broadcasts, monkeypatch: pytest.MonkeyPatch,
) -> None:
    import asyncio

    _arm_hook_pane()
    calls, started = _slow_deliver(monkeypatch, (False, "not-listening"))
    first, second = _session(), _session()
    one = asyncio.create_task(_push(first, pane_id="pane-1", text="hi", push_id="msg-2"))
    await started.wait()
    two = await _push(second, pane_id="pane-1", text="hi", push_id="msg-2")
    await one
    assert calls == ["hi"]
    assert two["payload"]["ok"] is False
    assert two["payload"]["reason"] == "not-listening"


@pytest.mark.asyncio
async def test_pushes_without_a_push_id_are_each_delivered(
    broadcasts, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An older window sends no push_id; every request is then its own push."""
    _arm_hook_pane()
    calls, _started = _slow_deliver(monkeypatch)
    await _push(_session(), pane_id="pane-1", text="a")
    await _push(_session(), pane_id="pane-1", text="a")
    assert calls == ["a", "a"]

"""ui_invoke / ui_snapshot / ui_list_actions: the MCP face of routing UI
requests to the Navide renderer window that owns a workspace_path, via the
ui.invoke.request / ui.invoke.result WS event pair.
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
    """The timeout messages read the pane registry to say which workspaces have
    a connected window, so it must not carry over between tests.

    Nor may the pending-request table: a test that stubs out
    `_ui_invoke_pending.wait` skips the `finally` that pops the key, and
    `_answer` resolves `keys[0]` — so one leaked entry silently absorbs the
    next test's reply and leaves its real request to time out.
    """
    agent_messaging._reset_for_test()
    plan_mcp._ui_invoke_pending.pending.clear()
    yield
    agent_messaging._reset_for_test()
    plan_mcp._ui_invoke_pending.pending.clear()


def _ctx() -> Any:
    """A Context carrying a valid host credential — ui_* tools only need *a*
    valid /plan-mcp credential, not a specific pane identity."""
    params = {"client": "host", "t": plan_mcp_auth.internal_token()}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


@pytest.fixture
def broadcasts(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []

    async def fake_broadcast(event: dict[str, Any], **_kwargs: Any) -> None:
        events.append(event)

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    return events


class _Window:
    """Stands in for a renderer window's WS session (what owner() hands back)."""

    def __init__(self, dead: bool = False) -> None:
        self.dead = dead


def _pane_ctx(pane_id: str = "pa") -> Any:
    """A Context carrying a CLI pane's credential, so the caller has an own
    window for the request to be addressed to."""
    params = {"pane": pane_id, "t": plan_mcp_wiring.caller_token()}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


@pytest.fixture
def addressed(monkeypatch: pytest.MonkeyPatch) -> list[tuple[Any, dict[str, Any]]]:
    """Captures point-to-point sends to one known window."""
    sends: list[tuple[Any, dict[str, Any]]] = []

    async def fake_unicast_to(session: Any, event: dict[str, Any]) -> bool:
        if session is None or getattr(session, "dead", False):
            return False
        sends.append((session, event))
        return True

    monkeypatch.setattr(app, "unicast_to", fake_unicast_to)
    return sends


@pytest.fixture
def unicasts(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []

    async def fake_unicast_any(event: dict[str, Any]) -> bool:
        events.append(event)
        return True

    monkeypatch.setattr(app, "unicast_any", fake_unicast_any)
    return events


async def _answer(tag: str) -> None:
    """Stand in for the renderer window replying with a ui.invoke.result."""
    for _ in range(200):
        keys = list(plan_mcp._ui_invoke_pending.pending)
        if keys:
            plan_mcp.resolve_ui_invoke(
                keys[0], {"ok": True, "result": {"echo": tag}, "error": None}
            )
            return
        await asyncio.sleep(0.005)
    raise AssertionError("no pending ui.invoke request appeared")


@pytest.mark.asyncio
async def test_ui_invoke_broadcasts_and_returns_the_result(
    broadcasts: list[dict[str, Any]], unicasts: list[dict[str, Any]]
) -> None:
    task = asyncio.create_task(_answer("invoke"))
    result = await plan_mcp.ui_invoke("/ws/alpha", "editor.save", _ctx(), {"path": "a.py"})
    await task

    assert result == {"ok": True, "result": {"echo": "invoke"}, "error": None}
    assert len(broadcasts) == 1
    assert unicasts == []
    payload = broadcasts[0]["payload"]
    assert broadcasts[0]["type"] == "ui.invoke.request"
    assert payload["workspace_path"] == "/ws/alpha"
    assert payload["op"] == "invoke"
    assert payload["action"] == "editor.save"
    assert payload["args"] == {"path": "a.py"}
    assert payload["global"] is False
    assert isinstance(payload["request_id"], str) and payload["request_id"]


@pytest.mark.asyncio
async def test_ui_invoke_workspace_open_unicasts_instead_of_broadcasting(
    broadcasts: list[dict[str, Any]], unicasts: list[dict[str, Any]]
) -> None:
    task = asyncio.create_task(_answer("invoke"))
    result = await plan_mcp.ui_invoke("/ws/beta", "ui.workspace.open", _ctx(), {"path": "/ws/beta"})
    await task

    assert result["ok"] is True
    assert broadcasts == []
    assert len(unicasts) == 1
    payload = unicasts[0]["payload"]
    assert unicasts[0]["type"] == "ui.invoke.request"
    assert payload["op"] == "invoke"
    assert payload["action"] == "ui.workspace.open"
    assert payload["global"] is True


@pytest.mark.asyncio
async def test_ui_invoke_global_reports_when_no_window_is_open(
    monkeypatch: pytest.MonkeyPatch, broadcasts: list[dict[str, Any]]
) -> None:
    async def fake_unicast_any(_event: dict[str, Any]) -> bool:
        return False

    monkeypatch.setattr(app, "unicast_any", fake_unicast_any)
    result = await plan_mcp.ui_invoke("/ws/delta", "ui.workspace.open", _ctx(), None)

    assert result == {
        "ok": False,
        "result": None,
        "error": "no Navide window is open to handle this request",
        "error_code": "ui_no_window",
    }
    assert broadcasts == []
    assert plan_mcp._ui_invoke_pending.pending == {}


@pytest.mark.asyncio
async def test_timeout_with_no_known_window_names_that_failure_and_lists_what_it_sees(
    monkeypatch: pytest.MonkeyPatch, broadcasts: list[dict[str, Any]]
) -> None:
    """The two failures behind a silent deadline need opposite fixes, so they
    can no longer come back as one blended sentence."""
    monkeypatch.setattr(plan_mcp, "_UI_INVOKE_TIMEOUT_S", 0.05)
    agent_messaging._reset_for_test()
    agent_messaging.register("p1", "worker", "/ws/alpha", owner=object())

    result = await plan_mcp.ui_invoke("/ws/gamma", "editor.save", _ctx(), None)

    assert result["ok"] is False
    assert result["error_code"] == "ui_no_window_known"
    # Actionable: the caller can compare its path against what the backend sees.
    assert "/ws/alpha" in result["error"]
    assert "connected but did not answer" not in result["error"]
    # The pending entry must not leak once the wait gives up.
    assert plan_mcp._ui_invoke_pending.pending == {}


@pytest.mark.asyncio
async def test_timeout_with_a_connected_window_is_reported_as_an_action_timeout(
    monkeypatch: pytest.MonkeyPatch, broadcasts: list[dict[str, Any]]
) -> None:
    monkeypatch.setattr(plan_mcp, "_UI_INVOKE_TIMEOUT_S", 0.05)
    agent_messaging._reset_for_test()
    agent_messaging.register("p1", "worker", "/ws/gamma", owner=object())

    result = await plan_mcp.ui_invoke("/ws/gamma", "editor.save", _ctx(), None)

    assert result["ok"] is False
    assert result["error_code"] == "ui_action_timeout"
    # The pane registry proves a window exists, not that any window still has
    # this workspace open — so the message points at that check instead of
    # clearing workspace_path of blame.
    assert "currently open" in result["error"]
    assert "/ws/gamma" in result["error"]


@pytest.mark.asyncio
async def test_a_workspace_whose_only_window_is_offline_is_not_counted_as_connected(
    monkeypatch: pytest.MonkeyPatch, broadcasts: list[dict[str, Any]]
) -> None:
    monkeypatch.setattr(plan_mcp, "_UI_INVOKE_TIMEOUT_S", 0.05)
    agent_messaging._reset_for_test()
    window = object()
    agent_messaging.register("p1", "worker", "/ws/gamma", owner=window)
    agent_messaging.drop_owner(window)

    result = await plan_mcp.ui_invoke("/ws/gamma", "editor.save", _ctx(), None)

    assert result["error_code"] == "ui_no_window_known"
    assert "/ws/gamma" not in result["error"].split("window for: ")[1]


@pytest.mark.asyncio
async def test_ui_list_actions_uses_the_list_actions_op(
    broadcasts: list[dict[str, Any]],
) -> None:
    task = asyncio.create_task(_answer("list_actions"))
    result = await plan_mcp.ui_list_actions("/ws/alpha", _ctx())
    await task

    assert result["ok"] is True
    payload = broadcasts[0]["payload"]
    assert payload["op"] == "list_actions"
    assert payload["action"] is None
    assert payload["args"] is None
    assert payload["global"] is False


@pytest.mark.asyncio
async def test_ui_snapshot_uses_the_snapshot_op(broadcasts: list[dict[str, Any]]) -> None:
    task = asyncio.create_task(_answer("snapshot"))
    result = await plan_mcp.ui_snapshot("/ws/alpha", _ctx())
    await task

    assert result["ok"] is True
    payload = broadcasts[0]["payload"]
    assert payload["op"] == "snapshot"
    assert payload["action"] is None
    assert payload["global"] is False


def test_resolve_ui_invoke_ignores_an_unknown_request_id() -> None:
    assert plan_mcp.resolve_ui_invoke("nope", {"ok": True, "result": None, "error": None}) is False


@pytest.mark.asyncio
async def test_ui_diagnostics_invokes_the_diagnostics_read_action_with_its_args(
    broadcasts: list[dict[str, Any]],
) -> None:
    task = asyncio.create_task(_answer("diagnostics"))
    result = await plan_mcp.ui_diagnostics(
        "/ws/alpha", _ctx(), since_seq=7, pane_id="pane-1", limit=25
    )
    await task

    assert result["ok"] is True
    payload = broadcasts[0]["payload"]
    assert payload["op"] == "invoke"
    assert payload["action"] == "ui.diagnostics.read"
    assert payload["args"] == {"sinceSeq": 7, "paneId": "pane-1", "limit": 25}
    assert payload["global"] is False


@pytest.mark.asyncio
async def test_ui_diagnostics_uses_its_documented_defaults(
    broadcasts: list[dict[str, Any]],
) -> None:
    task = asyncio.create_task(_answer("diagnostics-defaults"))
    await plan_mcp.ui_diagnostics("/ws/alpha", _ctx())
    await task

    payload = broadcasts[0]["payload"]
    assert payload["args"] == {"sinceSeq": 0, "paneId": "", "limit": 50}


@pytest.mark.asyncio
async def test_ui_invoke_result_carries_warnings_through_unchanged_when_present() -> None:
    """_ui_request returns whatever resolve_ui_invoke was handed — including an
    optional `warnings` list the renderer attached to flag an in-window
    anomaly (e.g. injectText resending) even though the action still ok'd."""

    async def _answer_with_warnings() -> None:
        for _ in range(200):
            keys = list(plan_mcp._ui_invoke_pending.pending)
            if keys:
                plan_mcp.resolve_ui_invoke(
                    keys[0],
                    {
                        "ok": True,
                        "result": "pane-1",
                        "error": None,
                        "warnings": ["[inject.resend] content not echoed — resending"],
                    },
                )
                return
            await asyncio.sleep(0.005)
        raise AssertionError("no pending ui.invoke request appeared")

    task = asyncio.create_task(_answer_with_warnings())
    result = await plan_mcp._ui_request("/ws", "invoke", action="ui.pane.create")
    await task

    assert result["warnings"] == ["[inject.resend] content not echoed — resending"]


@pytest.mark.asyncio
async def test_ui_invoke_result_has_no_warnings_key_when_the_renderer_sent_none(
    broadcasts: list[dict[str, Any]],
) -> None:
    task = asyncio.create_task(_answer("no-warnings"))
    result = await plan_mcp._ui_request("/ws", "invoke", action="ui.settings.close")
    await task

    assert "warnings" not in result


@pytest.mark.asyncio
async def test_pane_create_gets_a_longer_deadline_than_a_plain_action(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Spawning a pane waits out the CLI's startup before injecting the task,
    # which alone reaches the default timeout — reporting failure there would
    # deny work that actually succeeded.
    seen: list[float] = []

    async def _capture(request_id: str, fut: Any, *, timeout: float) -> Any:
        seen.append(timeout)
        return {"ok": True, "result": None, "error": None}

    monkeypatch.setattr(plan_mcp._ui_invoke_pending, "wait", _capture)

    await plan_mcp._ui_request("/ws", "invoke", action="ui.settings.close")
    await plan_mcp._ui_request("/ws", "invoke", action="ui.pane.create")

    assert seen[0] == plan_mcp._UI_INVOKE_TIMEOUT_S
    assert seen[1] == plan_mcp._UI_INVOKE_SLOW_TIMEOUT_S
    assert seen[1] > seen[0]


# ── Addressing a pane caller's own window ───────────────────────────────────
# A broadcast request is answered only by the window whose *currently open*
# workspace matches, so a window that had switched project (or is merely in the
# background with another workspace open) let every request from its own pane
# run into the deadline. A pane's window is known, so it is asked directly.


@pytest.mark.asyncio
async def test_a_pane_callers_request_goes_to_its_own_window(
    addressed: list[tuple[Any, dict[str, Any]]], broadcasts: list[dict[str, Any]]
) -> None:
    window = _Window()
    agent_messaging.register("pa", "worker", "/ws/alpha", agent_key="claude", owner=window)

    task = asyncio.create_task(_answer("addressed"))
    result = await plan_mcp.ui_invoke("/ws/alpha", "ui.pane.create", _pane_ctx(), {"agent": "claude"})
    await task

    assert result["ok"] is True
    assert broadcasts == []
    assert len(addressed) == 1
    session, event = addressed[0]
    assert session is window
    assert event["payload"]["addressed"] is True


@pytest.mark.asyncio
async def test_a_pane_naming_another_workspace_still_broadcasts(
    addressed: list[tuple[Any, dict[str, Any]]], broadcasts: list[dict[str, Any]]
) -> None:
    """Asking about someone else's window is a deliberate cross-window call —
    it must reach that window, not be quietly redirected home."""
    agent_messaging.register("pa", "worker", "/ws/alpha", agent_key="claude", owner=_Window())

    task = asyncio.create_task(_answer("cross"))
    result = await plan_mcp.ui_invoke("/ws/somewhere-else", "editor.save", _pane_ctx(), None)
    await task

    assert result["ok"] is True
    assert addressed == []
    assert len(broadcasts) == 1
    assert broadcasts[0]["payload"]["addressed"] is False


@pytest.mark.asyncio
async def test_a_trailing_slash_does_not_cost_a_pane_its_own_window(
    addressed: list[tuple[Any, dict[str, Any]]], broadcasts: list[dict[str, Any]]
) -> None:
    window = _Window()
    agent_messaging.register("pa", "worker", "/ws/alpha", agent_key="claude", owner=window)

    task = asyncio.create_task(_answer("slash"))
    result = await plan_mcp.ui_invoke("/ws/alpha/", "editor.save", _pane_ctx(), None)
    await task

    assert result["ok"] is True
    assert broadcasts == []
    assert addressed[0][0] is window


@pytest.mark.asyncio
async def test_a_pane_whose_window_is_gone_falls_back_to_broadcast(
    addressed: list[tuple[Any, dict[str, Any]]], broadcasts: list[dict[str, Any]]
) -> None:
    agent_messaging.register("pa", "worker", "/ws/alpha", agent_key="claude")

    task = asyncio.create_task(_answer("fallback"))
    result = await plan_mcp.ui_invoke("/ws/alpha", "editor.save", _pane_ctx(), None)
    await task

    assert result["ok"] is True
    assert addressed == []
    assert len(broadcasts) == 1
    # The claim has to match what actually went out, or the timeout message
    # would blame the wrong thing.
    assert broadcasts[0]["payload"]["addressed"] is False


@pytest.mark.asyncio
async def test_a_dead_window_falls_back_to_broadcast(
    addressed: list[tuple[Any, dict[str, Any]]], broadcasts: list[dict[str, Any]]
) -> None:
    agent_messaging.register("pa", "worker", "/ws/alpha", agent_key="claude", owner=_Window(dead=True))

    task = asyncio.create_task(_answer("dead"))
    result = await plan_mcp.ui_invoke("/ws/alpha", "editor.save", _pane_ctx(), None)
    await task

    assert result["ok"] is True
    assert addressed == []
    assert broadcasts[0]["payload"]["addressed"] is False


@pytest.mark.asyncio
async def test_a_global_action_is_never_addressed_to_the_callers_window(
    addressed: list[tuple[Any, dict[str, Any]]],
    unicasts: list[dict[str, Any]],
    broadcasts: list[dict[str, Any]],
) -> None:
    """ui.workspace.open has no owner by definition — the workspace may have no
    window yet — so a pane caller must not pin it to its own."""
    # Registered under the very workspace being opened, so only the global rule
    # can keep this off the caller's own window.
    agent_messaging.register("pa", "worker", "/ws/beta", agent_key="claude", owner=_Window())

    task = asyncio.create_task(_answer("global"))
    result = await plan_mcp.ui_invoke("/ws/beta", "ui.workspace.open", _pane_ctx(), {"path": "/ws/beta"})
    await task

    assert result["ok"] is True
    assert addressed == []
    assert broadcasts == []
    assert len(unicasts) == 1
    assert unicasts[0]["payload"]["addressed"] is False


async def _answer_result(result: Any) -> None:
    """_answer, but with the reply body the caller actually parses."""
    for _ in range(200):
        keys = list(plan_mcp._ui_invoke_pending.pending)
        if keys:
            plan_mcp.resolve_ui_invoke(keys[0], {"ok": True, "result": result, "error": None})
            return
        await asyncio.sleep(0.005)
    raise AssertionError("no pending ui.invoke request appeared")


@pytest.mark.asyncio
async def test_wait_idle_probes_the_window_that_hosts_the_pane(
    addressed: list[tuple[Any, dict[str, Any]]], broadcasts: list[dict[str, Any]]
) -> None:
    """The UI probe is the one signal that is always current, and it was still
    broadcast — so for the very case this addressing exists for (the window
    switched project) each probe ran into the 15s deadline inside a 1s poll
    loop, three times over, before it gave up on the window."""
    asker_window, subject_window = _Window(), _Window()
    agent_messaging.register("pa", "asker", "/ws/alpha", agent_key="claude", owner=asker_window)
    agent_messaging.register("pb", "worker", "/ws/alpha", agent_key="claude", owner=subject_window)
    agent_messaging.set_busy("pb", True)

    task = asyncio.create_task(_answer_result({"status": "idle"}))
    result = await plan_mcp.cli_wait_idle("worker", _pane_ctx(), 5.0, "")
    await task

    assert result["idle"] is True
    assert broadcasts == []
    assert len(addressed) == 1
    session, event = addressed[0]
    assert session is subject_window
    assert event["payload"]["action"] == "ui.pane.getStatus"
    assert event["payload"]["addressed"] is True


@pytest.mark.asyncio
async def test_get_status_asks_the_window_that_hosts_the_pane_it_is_about(
    addressed: list[tuple[Any, dict[str, Any]]], broadcasts: list[dict[str, Any]]
) -> None:
    """ui.pane.getStatus is about the SUBJECT pane, so it goes to the window
    that has that pane — not the asker's, which may not host it at all, and not
    a broadcast, which a window that has switched project never answers."""
    asker_window, subject_window = _Window(), _Window()
    agent_messaging.register("pa", "asker", "/ws/alpha", agent_key="claude", owner=asker_window)
    agent_messaging.register("pb", "worker", "/ws/alpha", agent_key="claude", owner=subject_window)

    task = asyncio.create_task(_answer("status"))
    result = await plan_mcp.cli_get_status("worker", _pane_ctx(), "")
    await task

    assert result["ok"] is True
    assert broadcasts == []
    assert len(addressed) == 1
    session, event = addressed[0]
    assert session is subject_window
    assert event["payload"]["action"] == "ui.pane.getStatus"
    assert event["payload"]["addressed"] is True


class _DyingWindow:
    """A session that goes away DURING the send, with Session.send_json's real
    contract: it never raises on a dead peer — it marks itself dead, discards
    itself and returns normally.

    The `addressed` fixture above fakes the contract unicast_to *wants*, so it
    cannot see a unicast_to that decides delivery from the absence of an
    exception. This one can.
    """

    def __init__(self) -> None:
        self.dead = False
        self.seen: list[dict[str, Any]] = []

    async def send_json(self, data: dict[str, Any]) -> None:
        if self.dead:
            return
        self.dead = True


class _LiveWindow(_DyingWindow):
    async def send_json(self, data: dict[str, Any]) -> None:
        self.seen.append(data)


@pytest.mark.asyncio
async def test_unicast_to_reports_a_peer_that_died_during_the_send() -> None:
    """The real app.unicast_to, not the fixture: send_json swallows the failure,
    so 'did it land' has to be read off `dead` afterwards. Returning True here
    suppressed the broadcast fallback and cost the caller a full timeout with a
    message blaming a window that was not even there."""
    window = _DyingWindow()

    assert await app.unicast_to(window, {"type": "ui.invoke.request"}) is False


@pytest.mark.asyncio
async def test_unicast_to_reports_a_live_peer_as_delivered() -> None:
    window = _LiveWindow()

    assert await app.unicast_to(window, {"type": "ui.invoke.request"}) is True
    assert window.seen == [{"type": "ui.invoke.request"}]


@pytest.mark.asyncio
async def test_a_window_that_dies_during_the_send_still_falls_back_to_broadcast(
    broadcasts: list[dict[str, Any]],
) -> None:
    """End to end over the REAL unicast_to: the owner was alive at lookup and
    gone by the send."""
    agent_messaging.register("pa", "worker", "/ws/alpha", agent_key="claude", owner=_DyingWindow())

    task = asyncio.create_task(_answer("died-mid-send"))
    result = await plan_mcp.ui_invoke("/ws/alpha", "editor.save", _pane_ctx(), None)
    await task

    assert result["ok"] is True
    assert len(broadcasts) == 1
    # And the broadcast must not still claim to be addressed: every window
    # answers an addressed request without checking workspace_path, so one
    # request id would collect N racing replies.
    assert broadcasts[0]["payload"]["addressed"] is False


@pytest.mark.asyncio
async def test_an_addressed_timeout_blames_the_window_not_the_path(
    monkeypatch: pytest.MonkeyPatch, addressed: list[tuple[Any, dict[str, Any]]]
) -> None:
    monkeypatch.setattr(plan_mcp, "_UI_INVOKE_TIMEOUT_S", 0.05)
    agent_messaging.register("pa", "worker", "/ws/alpha", agent_key="claude", owner=_Window())

    result = await plan_mcp.ui_invoke("/ws/alpha", "editor.save", _pane_ctx(), None)

    assert result["ok"] is False
    assert result["error_code"] == "ui_action_timeout"
    assert "your own Navide window" in result["error"]
    assert "workspace_path is not involved" in result["error"]
    assert plan_mcp._ui_invoke_pending.pending == {}


# ---------------------------------------------------------------- pane-private actions
#
# ui_invoke forwards action and args verbatim, and the two ui.messaging.*
# commands take the pane whose inbox to read from args.paneId. So the caller's
# identity has to travel with the request and be matched against that id —
# here, and again in the window. These pin both halves.


def _no_window_reached(monkeypatch: pytest.MonkeyPatch) -> None:
    """Make a refusal test fail closed: a request that should have been refused
    must go red the moment it reaches a window, not after the 15 s reply
    timeout. Both send paths raise, so nothing waits on a reply that never comes."""

    async def reached(*_args: Any, **_kwargs: Any) -> bool:
        raise AssertionError("the refusal is missing: the request reached a window")

    monkeypatch.setattr(app, "unicast_to", reached)
    monkeypatch.setattr(app, "broadcast", reached)
    monkeypatch.setattr(app, "unicast_any", reached)



@pytest.mark.asyncio
async def test_a_pane_cannot_read_another_panes_inbox_through_ui_invoke(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _no_window_reached(monkeypatch)
    agent_messaging.register("pa", "worker", "/ws/alpha", agent_key="claude", owner=_Window())
    agent_messaging.register("pb", "victim", "/ws/alpha", agent_key="claude", owner=_Window())

    for action in ("ui.messaging.readIncoming", "ui.messaging.settleRead"):
        result = await plan_mcp.ui_invoke("/ws/alpha", action, _pane_ctx("pa"), {"paneId": "pb"})
        assert result["ok"] is False, action
        assert result["error_code"] == "ui_pane_private", action


@pytest.mark.asyncio
async def test_a_host_caller_has_no_inbox_to_read(monkeypatch: pytest.MonkeyPatch) -> None:
    """Same rule as cli_read_incoming: only a Navide CLI pane has an inbox."""
    _no_window_reached(monkeypatch)
    agent_messaging.register("pb", "victim", "/ws/alpha", agent_key="claude", owner=_Window())
    for action in ("ui.messaging.readIncoming", "ui.messaging.settleRead"):
        result = await plan_mcp.ui_invoke("/ws/alpha", action, _ctx(), {"paneId": "pb"})
        assert result["ok"] is False, action
        assert result["error_code"] == "ui_pane_private", action


@pytest.mark.asyncio
async def test_a_pane_reading_its_own_inbox_passes_and_carries_its_identity(
    addressed: list[tuple[Any, dict[str, Any]]], broadcasts: list[dict[str, Any]]
) -> None:
    """The one legitimate shape — what cli_read_incoming emits — still goes
    through, and the request names the caller from the credential so the
    window can make the same check."""
    window = _Window()
    agent_messaging.register("pa", "worker", "/ws/alpha", agent_key="claude", owner=window)

    task = asyncio.create_task(_answer("own"))
    result = await plan_mcp.ui_invoke(
        "/ws/alpha", "ui.messaging.readIncoming", _pane_ctx("pa"), {"paneId": "pa", "limit": 5}
    )
    await task

    assert result["ok"] is True
    assert broadcasts == []
    _session, event = addressed[0]
    assert event["payload"]["caller_pane_id"] == "pa"
    assert event["payload"]["args"] == {"paneId": "pa", "limit": 5}


@pytest.mark.asyncio
async def test_a_host_request_carries_an_empty_caller_pane_id(
    broadcasts: list[dict[str, Any]],
) -> None:
    task = asyncio.create_task(_answer("host"))
    result = await plan_mcp.ui_invoke("/ws/alpha", "editor.save", _ctx(), None)
    await task
    assert result["ok"] is True
    assert broadcasts[0]["payload"]["caller_pane_id"] == ""


# ── workspace_open / workspace_switch ────────────────────────────────────────
# The two workspace actions as tools of their own: open keeps ui.workspace.open's
# global routing (no window owns a workspace that is not open yet), switch is
# addressed to the caller's own window — the only window "switch" can mean.


@pytest.fixture
def _no_window_comes_up(monkeypatch: pytest.MonkeyPatch) -> None:
    """workspace_open waits for the new window; none ever answers here."""
    monkeypatch.setattr(plan_mcp, "_WINDOW_READY_TIMEOUT_S", 0.05)
    monkeypatch.setattr(plan_mcp, "_WINDOW_PROBE_TIMEOUT_S", 0.01)
    monkeypatch.setattr(plan_mcp, "_mcp_opened_workspaces", {})


async def _answer_with(result: dict[str, Any]) -> None:
    for _ in range(200):
        keys = list(plan_mcp._ui_invoke_pending.pending)
        if keys:
            plan_mcp.resolve_ui_invoke(keys[0], {"ok": True, "result": result, "error": None})
            return
        await asyncio.sleep(0.005)
    raise AssertionError("no pending ui.invoke request appeared")


@pytest.mark.asyncio
async def test_workspace_open_sends_ui_workspace_open_to_any_window(
    broadcasts: list[dict[str, Any]],
    addressed: list[tuple[Any, dict[str, Any]]],
    unicasts: list[dict[str, Any]],
    _no_window_comes_up: None,
) -> None:
    task = asyncio.create_task(_answer("open"))
    result = await plan_mcp.workspace_open("/ws/beta", _ctx())
    await task

    assert result["ok"] is True
    assert result["path"] == "/ws/beta"
    # Only the readiness probes are broadcast — never the open itself.
    assert broadcasts
    assert all(e["payload"]["op"] == "list_actions" for e in broadcasts)
    assert addressed == []
    assert len(unicasts) == 1
    payload = unicasts[0]["payload"]
    assert unicasts[0]["type"] == "ui.invoke.request"
    assert payload["op"] == "invoke"
    assert payload["action"] == "ui.workspace.open"
    assert payload["args"] == {"path": "/ws/beta"}
    assert payload["global"] is True
    assert payload["addressed"] is False


@pytest.mark.asyncio
async def test_workspace_open_from_a_pane_is_still_global_not_addressed_home(
    addressed: list[tuple[Any, dict[str, Any]]],
    unicasts: list[dict[str, Any]],
    _no_window_comes_up: None,
) -> None:
    """The pane's own window is not the one being asked for: the target
    workspace may belong to no window yet."""
    agent_messaging.register("pa", "worker", "/ws/alpha", agent_key="claude", owner=_Window())

    task = asyncio.create_task(_answer("open"))
    result = await plan_mcp.workspace_open("/ws/beta", _pane_ctx("pa"))
    await task

    assert result["ok"] is True
    assert addressed == []
    assert len(unicasts) == 1
    assert unicasts[0]["payload"]["global"] is True


@pytest.mark.asyncio
async def test_workspace_open_refuses_an_empty_path_without_asking_a_window(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _no_window_reached(monkeypatch)
    result = await plan_mcp.workspace_open("", _ctx())
    assert result["ok"] is False
    assert "path" in result["error"]
    assert plan_mcp._ui_invoke_pending.pending == {}


@pytest.mark.asyncio
async def test_workspace_open_passes_the_routing_error_through(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_unicast_any(_event: dict[str, Any]) -> bool:
        return False

    monkeypatch.setattr(app, "unicast_any", fake_unicast_any)
    result = await plan_mcp.workspace_open("/ws/delta", _ctx())
    assert result["ok"] is False
    assert result["error_code"] == "ui_no_window"


@pytest.mark.asyncio
async def test_workspace_switch_from_a_pane_asks_its_own_window(
    addressed: list[tuple[Any, dict[str, Any]]],
    broadcasts: list[dict[str, Any]],
    unicasts: list[dict[str, Any]],
) -> None:
    window = _Window()
    agent_messaging.register("pa", "worker", "/ws/alpha", agent_key="claude", owner=window)

    task = asyncio.create_task(_answer_with({"path": "/ws/beta"}))
    result = await plan_mcp.workspace_switch("/ws/beta", _pane_ctx("pa"))
    await task

    assert result == {"ok": True, "path": "/ws/beta"}
    assert broadcasts == []
    assert unicasts == []
    assert len(addressed) == 1
    session, event = addressed[0]
    assert session is window
    payload = event["payload"]
    assert payload["op"] == "invoke"
    assert payload["action"] == "ui.workspace.switch"
    assert payload["args"] == {"path": "/ws/beta"}
    assert payload["workspace_path"] == "/ws/alpha"
    assert payload["global"] is False
    assert payload["addressed"] is True
    assert payload["caller_pane_id"] == "pa"


@pytest.mark.asyncio
async def test_workspace_switch_passes_the_windows_refusal_through(
    addressed: list[tuple[Any, dict[str, Any]]],
) -> None:
    agent_messaging.register("pa", "worker", "/ws/alpha", agent_key="claude", owner=_Window())

    async def refuse() -> None:
        for _ in range(200):
            keys = list(plan_mcp._ui_invoke_pending.pending)
            if keys:
                plan_mcp.resolve_ui_invoke(
                    keys[0],
                    {
                        "ok": False,
                        "result": None,
                        "error": "this window does not hold /ws/gamma; use ui.workspace.open",
                    },
                )
                return
            await asyncio.sleep(0.005)
        raise AssertionError("no pending ui.invoke request appeared")

    task = asyncio.create_task(refuse())
    result = await plan_mcp.workspace_switch("/ws/gamma", _pane_ctx("pa"))
    await task

    assert result["ok"] is False
    assert "ui.workspace.open" in result["error"]
    assert len(addressed) == 1


@pytest.mark.asyncio
async def test_workspace_switch_refuses_a_host_caller_without_asking_a_window(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _no_window_reached(monkeypatch)
    result = await plan_mcp.workspace_switch("/ws/beta", _ctx())
    assert result["ok"] is False
    assert "pane caller" in result["error"]
    assert "ui_invoke" in result["error"]
    assert plan_mcp._ui_invoke_pending.pending == {}


@pytest.mark.asyncio
async def test_workspace_switch_refuses_an_empty_path_without_asking_a_window(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    agent_messaging.register("pa", "worker", "/ws/alpha", agent_key="claude", owner=_Window())
    _no_window_reached(monkeypatch)
    result = await plan_mcp.workspace_switch("", _pane_ctx("pa"))
    assert result["ok"] is False
    assert "path" in result["error"]
    assert plan_mcp._ui_invoke_pending.pending == {}


# ── human-only actions ──────────────────────────────────────────────────────
# An agent must not answer a pane's permission prompt (its own or another's) or
# switch the permission bypass on through ui_invoke. The chat relay presses keys
# through _ui_request directly, which is not this tool and keeps working.


@pytest.mark.parametrize("ctx_factory", [_pane_ctx, _ctx])
@pytest.mark.parametrize(
    ("action", "args"),
    [
        ("ui.pane.sendKeys", {"paneId": "pa", "answer": {"kind": "permission", "choice": "allow"}}),
        ("ui.pane.sendKeys", {"paneId": "pb", "answer": {"kind": "question", "option": 2}}),
        ("ui.settings.yolo", {"yolo": True}),
    ],
)
@pytest.mark.asyncio
async def test_an_agent_cannot_press_prompt_keys_or_enable_yolo_through_ui_invoke(
    monkeypatch: pytest.MonkeyPatch, ctx_factory: Any, action: str, args: dict[str, Any]
) -> None:
    _no_window_reached(monkeypatch)
    agent_messaging.register("pa", "worker", "/ws/alpha", agent_key="claude", owner=_Window())
    agent_messaging.register("pb", "victim", "/ws/alpha", agent_key="claude", owner=_Window())

    result = await plan_mcp.ui_invoke("/ws/alpha", action, ctx_factory(), args)

    assert result["ok"] is False
    assert result["error_code"] == "ui_human_only"


@pytest.mark.parametrize(
    ("action", "args"),
    [("ui.settings.yolo", None), ("ui.settings.yolo", {"yolo": False}), ("ui.settings.open", {"tab": "general"})],
)
@pytest.mark.asyncio
async def test_reading_or_turning_yolo_off_still_passes_through_ui_invoke(
    broadcasts: list[dict[str, Any]], action: str, args: dict[str, Any] | None
) -> None:
    task = asyncio.create_task(_answer("ok"))
    result = await plan_mcp.ui_invoke("/ws/alpha", action, _ctx(), args)
    await task
    assert result["ok"] is True
    assert broadcasts[0]["payload"]["action"] == action


@pytest.mark.asyncio
async def test_the_chat_relay_still_presses_keys_through_its_internal_path(
    addressed: list[tuple[Any, dict[str, Any]]],
) -> None:
    from agent_team_backend.channels import default_seams

    agent_messaging.register("pa", "worker", "/ws/alpha", agent_key="claude", owner=_Window())

    async def window_sends() -> None:
        for _ in range(200):
            keys = list(plan_mcp._ui_invoke_pending.pending)
            if keys:
                plan_mcp.resolve_ui_invoke(keys[0], {"ok": True, "result": {"ok": True, "sent": True}, "error": None})
                return
            await asyncio.sleep(0.005)
        raise AssertionError("the relay's ui.pane.sendKeys never reached the window")

    task = asyncio.create_task(window_sends())
    result = await default_seams().answer("pa", {"kind": "permission", "choice": "allow"})
    await task

    assert result == {"ok": True}
    _session, event = addressed[0]
    assert event["payload"]["action"] == "ui.pane.sendKeys"

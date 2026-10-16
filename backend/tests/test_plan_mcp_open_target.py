"""Waking a cold-restore placeholder from MCP.

A pane the window restored but never opened is registered (so it stays
addressable) with ``realized=False``: no PTY, busy forever, and a message for
it parks until someone clicks it. These tests pin the three MCP faces of that:
cli_list_targets says so, cli_send can open it first (``open_target``) or warn
that it did not, and cli_open_agent(pane_id=...) reopens it without spawning a
``<name>-2``. The renderer answers ``ui.pane.open`` over the ui.invoke pair,
which the tests stand in for.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging, app
from agent_team_backend.mcp_server import (
    server as plan_mcp,
    wiring as plan_mcp_wiring,
)

REMOTE_DEVICE = "11111111-2222-3333-4444-555555555555"


@pytest.fixture(autouse=True)
def _clean_registry() -> Any:
    agent_messaging._reset_for_test()
    plan_mcp._ui_invoke_pending.pending.clear()
    plan_mcp._mcp_message_status.clear()
    yield
    agent_messaging._reset_for_test()
    plan_mcp._ui_invoke_pending.pending.clear()
    plan_mcp._mcp_message_status.clear()


class _Window:
    def __init__(self) -> None:
        self.dead = False


def _pane_ctx(pane_id: str = "pa") -> Any:
    params = {"pane": pane_id, "t": plan_mcp_wiring.caller_token(pane_id)}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


#: The one window every seeded pane is mirrored by.
_window = _Window()


def _seed() -> _Window:
    """A sender, a live pane and a placeholder, all in one window."""
    window = _window
    agent_messaging.register("pa", "sender", "/ws/alpha", agent_key="claude", owner=window)
    agent_messaging.register("pb", "live", "/ws/alpha", agent_key="codex", owner=window)
    agent_messaging.register(
        "pc", "sleeper", "/ws/alpha", agent_key="claude", owner=window, realized=False
    )
    return window


#: ui.invoke.request events addressed at a window.
asked: list[dict[str, Any]] = []


@pytest.fixture
def delivered(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []

    async def fake_broadcast(event: dict[str, Any], **_kwargs: Any) -> None:
        if event.get("type") == "agent_msg.deliver":
            events.append(event)
        elif event.get("type") == "ui.invoke.request":
            asked.append(event)

    async def fake_unicast_to(session: Any, event: dict[str, Any]) -> bool:
        if session is None or getattr(session, "dead", False):
            return False
        asked.append(event)
        return True

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    monkeypatch.setattr(app, "unicast_to", fake_unicast_to)
    return events


@pytest.fixture(autouse=True)
def _clear_asked() -> Any:
    asked.clear()
    yield
    asked.clear()


async def _answer_open(result: dict[str, Any], *, register_as: str = "") -> None:
    """Stand in for the window replying to ui.pane.open.

    ``register_as`` mimics what the renderer does on a successful restore
    before it answers: the pane is rebuilt under a fresh id and mirrored back
    with the old id as a former id.
    """
    for _ in range(400):
        keys = list(plan_mcp._ui_invoke_pending.pending)
        if keys:
            if register_as:
                agent_messaging.register(
                    register_as, "sleeper", "/ws/alpha", agent_key="claude", owner=_window
                )
                agent_messaging.add_aliases(register_as, ["pc"], "/ws/alpha")
            plan_mcp.resolve_ui_invoke(keys[0], {"ok": True, "result": result, "error": None})
            return
        await asyncio.sleep(0.005)
    raise AssertionError("no pending ui.pane.open request appeared")


def _open_requests() -> list[dict[str, Any]]:
    return [e["payload"] for e in asked if e["payload"].get("action") == "ui.pane.open"]


# ── cli_list_targets ───────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_list_targets_reports_whether_a_pane_is_opened() -> None:
    _seed()
    result = await plan_mcp.cli_list_targets(_pane_ctx())
    by_name = {t["name"]: t for t in result["targets"]}
    assert by_name["live"]["realized"] is True
    assert by_name["sleeper"]["realized"] is False


# ── cli_send ───────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_send_to_a_placeholder_warns_but_still_parks_the_message(
    delivered: list[dict[str, Any]],
) -> None:
    _seed()
    result = await plan_mcp.cli_send("sleeper", "wake up", _pane_ctx())

    assert result["ok"] is True
    assert result["target_state"] == "not-opened"
    assert "opens it" in result["warning"]
    assert _open_requests() == []
    assert [e["payload"]["target_pane_id"] for e in delivered] == ["pc"]


@pytest.mark.asyncio
async def test_open_target_opens_the_placeholder_before_delivering(
    delivered: list[dict[str, Any]],
) -> None:
    _seed()
    task = asyncio.create_task(
        _answer_open({"realized": True, "reason": "opened", "paneId": "pc2"}, register_as="pc2")
    )
    result = await plan_mcp.cli_send("sleeper", "wake up", _pane_ctx(), open_target=True)
    await task

    assert result["ok"] is True
    assert result["opened"] == {"realized": True, "reason": "opened"}
    assert "target_state" not in result
    assert "warning" not in result
    (request,) = _open_requests()
    assert request["args"] == {"paneId": "pc"}
    # Delivered to the pane the restore rebuilt, not to the id it replaced —
    # the receiving window no longer has a handle under that one.
    assert [e["payload"]["target_pane_id"] for e in delivered] == ["pc2"]


@pytest.mark.asyncio
async def test_open_target_reports_a_fresh_session(
    delivered: list[dict[str, Any]],
) -> None:
    """resumeBehavior=never opens a new session; the sender must learn that the
    agent does not remember anything."""
    _seed()
    task = asyncio.create_task(
        _answer_open({"realized": True, "reason": "fresh", "paneId": "pc2"}, register_as="pc2")
    )
    result = await plan_mcp.cli_send("sleeper", "wake up", _pane_ctx(), open_target=True)
    await task

    assert result["ok"] is True
    assert result["opened"] == {"realized": True, "reason": "fresh"}
    assert len(delivered) == 1


@pytest.mark.asyncio
async def test_a_failed_open_refuses_the_send_without_dispatching(
    delivered: list[dict[str, Any]],
) -> None:
    _seed()
    task = asyncio.create_task(_answer_open({"realized": False, "reason": "cancelled"}))
    result = await plan_mcp.cli_send("sleeper", "wake up", _pane_ctx(), open_target=True)
    await task

    assert result["ok"] is False
    assert result["error_code"] == "open-failed"
    assert result["open"] == {"realized": False, "reason": "cancelled"}
    assert "cancelled" in result["error"]
    assert delivered == []


@pytest.mark.asyncio
async def test_a_window_that_does_not_answer_the_open_refuses_the_send(
    monkeypatch: pytest.MonkeyPatch, delivered: list[dict[str, Any]]
) -> None:
    _seed()

    async def fake_ui_request(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        return {"ok": False, "error": "did not answer within 60s", "error_code": "ui_action_timeout"}

    monkeypatch.setattr(plan_mcp, "_ui_request", fake_ui_request)
    result = await plan_mcp.cli_send("sleeper", "wake up", _pane_ctx(), open_target=True)

    assert result["ok"] is False
    assert result["error_code"] == "open-failed"
    assert result["open"] == {"realized": False, "reason": "ui_action_timeout"}
    assert delivered == []


@pytest.mark.asyncio
async def test_open_target_is_a_no_op_for_a_pane_that_is_open(
    delivered: list[dict[str, Any]],
) -> None:
    _seed()
    plain = await plan_mcp.cli_send("live", "hi", _pane_ctx())
    flagged = await plan_mcp.cli_send("live", "hi", _pane_ctx(), open_target=True)

    assert _open_requests() == []
    assert flagged["ok"] is True
    # Same answer shape as a send without the flag — nothing extra to read.
    assert set(flagged) == set(plain)
    assert "opened" not in flagged
    assert "target_state" not in flagged
    assert [e["payload"]["target_pane_id"] for e in delivered] == ["pb", "pb"]


@pytest.mark.asyncio
async def test_open_target_never_reaches_a_group_broadcast(
    delivered: list[dict[str, Any]],
) -> None:
    """One broadcast must not be able to pull a batch of reclaimed panes up."""
    _seed()

    async def answer_peers() -> None:
        for _ in range(400):
            keys = list(plan_mcp._ui_invoke_pending.pending)
            if keys:
                plan_mcp.resolve_ui_invoke(
                    keys[0],
                    {
                        "ok": True,
                        "result": {
                            "group_id": "rg-1",
                            "peers": [
                                {"pane_id": "pb", "name": "live"},
                                {"pane_id": "pc", "name": "sleeper"},
                            ],
                        },
                        "error": None,
                    },
                )
                return
            await asyncio.sleep(0.005)
        raise AssertionError("no pending ui.groupPeers request appeared")

    task = asyncio.create_task(answer_peers())
    result = await plan_mcp.cli_send("group", "stand up", _pane_ctx(), open_target=True)
    await task

    assert result["ok"] is True
    assert result["delivered_to"] == 2
    assert _open_requests() == []
    assert [p["action"] for p in (e["payload"] for e in asked)] == ["ui.groupPeers"]
    assert [e["payload"]["target_pane_id"] for e in delivered] == ["pb", "pc"]


@pytest.mark.asyncio
async def test_open_target_never_crosses_devices(
    monkeypatch: pytest.MonkeyPatch, delivered: list[dict[str, Any]]
) -> None:
    """Another machine's placeholders are that machine's to open."""
    from agent_team_backend import server_link

    sent: list[dict[str, Any]] = []

    async def fake_send_message(**kwargs: Any) -> dict[str, Any]:
        sent.append(kwargs)
        return {"ok": True, "payload": {"msgKey": kwargs["msg_key"], "state": "pending"}}

    monkeypatch.setattr(server_link, "send_message", fake_send_message)
    _seed()

    result = await plan_mcp.cli_send(
        f"{REMOTE_DEVICE}/beta/reviewer", "hi", _pane_ctx(), open_target=True
    )

    assert result["ok"] is True
    assert result["cross_workspace"] is True
    assert "opened" not in result
    assert _open_requests() == []
    assert sent[0]["text"] == "hi"
    assert delivered == []


# ── cli_open_agent(pane_id=...) ────────────────────────────────────────────
@pytest.mark.asyncio
async def test_open_agent_by_pane_id_reopens_a_placeholder(
    delivered: list[dict[str, Any]],
) -> None:
    _seed()
    task = asyncio.create_task(
        _answer_open({"realized": True, "reason": "opened", "paneId": "pc2"}, register_as="pc2")
    )
    result = await plan_mcp.cli_open_agent("", "", "", _pane_ctx(), pane_id="pc")
    await task

    assert result == {
        "ok": True,
        "pane_id": "pc2",
        "name": "sleeper",
        "address": "alpha/sleeper",
        "realized": True,
        "reason": "opened",
        "reopened": True,
    }
    (request,) = _open_requests()
    assert request["args"] == {"paneId": "pc"}
    # No spawn request went out: the placeholder was opened, not duplicated.
    assert all(e["type"] != "agent_spawn.request" for e in asked)
    assert delivered == []


@pytest.mark.asyncio
async def test_open_agent_by_pane_id_leaves_an_open_pane_alone(
    delivered: list[dict[str, Any]],
) -> None:
    _seed()
    result = await plan_mcp.cli_open_agent("", "", "", _pane_ctx(), pane_id="pb")

    assert result["ok"] is True
    assert result["reopened"] is False
    assert result["reason"] == "already-open"
    assert result["pane_id"] == "pb"
    assert _open_requests() == []


@pytest.mark.asyncio
async def test_open_agent_by_pane_id_reports_a_failed_open(
    delivered: list[dict[str, Any]],
) -> None:
    _seed()
    task = asyncio.create_task(_answer_open({"realized": False, "reason": "session-unavailable"}))
    result = await plan_mcp.cli_open_agent("", "", "", _pane_ctx(), pane_id="pc")
    await task

    assert result["ok"] is False
    assert result["error_code"] == "open-failed"
    assert result["reason"] == "session-unavailable"


@pytest.mark.asyncio
async def test_open_agent_by_unknown_pane_id_is_refused(
    delivered: list[dict[str, Any]],
) -> None:
    _seed()
    result = await plan_mcp.cli_open_agent("", "", "", _pane_ctx(), pane_id="nope")

    assert result["ok"] is False
    assert result["error_code"] == "unknown-pane-id"
    assert _open_requests() == []

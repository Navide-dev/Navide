"""guard.* ws requests, their unreachability through MCP ui_invoke, and the
taint marks every external delivery path leaves on its target pane."""

from __future__ import annotations

import asyncio
import inspect
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging, app, ws_handlers
from agent_team_backend.guard import is_tainted, mark_tainted, ws_api
from agent_team_backend.mcp_server import server as mcp
from agent_team_backend.mcp_server import wiring as mcp_wiring


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


async def ws(msg_type: str, payload: dict | None = None) -> dict[str, Any]:
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    await app.handle_message(session, {"id": "r1", "type": msg_type, "payload": payload or {}})
    return session.websocket.sent[-1]["payload"]  # type: ignore[attr-defined]


@pytest.fixture
def captured(monkeypatch) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []

    async def fake_broadcast(event: dict[str, Any], **_kwargs: Any) -> None:
        events.append(event)

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    return events


# ── ws API ─────────────────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_every_contract_type_is_registered():
    for t in ws_api.MESSAGE_TYPES:
        assert ws_handlers.lookup(t) is ws_api.handle


@pytest.mark.asyncio
async def test_status_and_set_enabled(guard_store):
    res = await ws("guard.status")
    assert res["enabled"] is True
    assert set(res["counts"]) == {"critical", "high", "asks", "denies_24h"}
    assert res["hook_support"]["claude"] == "block" and res["hook_support"]["aider"] == "none"
    assert (await ws("guard.set_enabled", {"enabled": False}))["ok"] is True
    assert guard_store.enabled() is False
    assert (await ws("guard.set_enabled", {"enabled": "no"}))["ok"] is False


@pytest.mark.asyncio
async def test_rules_roundtrip():
    res = await ws("guard.rules.add", {"kind": "deny", "pattern": "docker system prune", "note": "n"})
    assert res["ok"] and res["rules"][0]["pattern"] == "docker system prune"
    rid = res["rules"][0]["id"]
    assert (await ws("guard.rules.list"))["rules"][0]["kind"] == "deny"
    assert (await ws("guard.rules.add", {"kind": "maybe", "pattern": "x"}))["ok"] is False
    # Removing a deny loosens Guard: refused without the main process's
    # confirmation (the confirmed path is in test_rule_editing_ws.py).
    assert (await ws("guard.rules.remove", {"id": rid})) is None


@pytest.mark.asyncio
async def test_taint_list_and_clear(monkeypatch):
    window = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    monkeypatch.setattr(app, "_SESSIONS", {window})
    mark_tainted("p1", "remote", "chat")
    panes = (await ws("guard.taint.list"))["panes"]
    assert panes[0]["pane_id"] == "p1" and panes[0]["sources"] == ["remote"]
    assert (await ws("guard.taint.clear", {"pane_id": "p1"}))["ok"] is True
    assert not is_tainted("p1")
    await asyncio.sleep(0)
    changes = [e["payload"] for e in window.websocket.sent if e.get("type") == "guard.taint_changed"]  # type: ignore[attr-defined]
    assert changes == [{"pane_id": "p1", "tainted": True}, {"pane_id": "p1", "tainted": False}]


@pytest.mark.asyncio
async def test_audit_list_and_test_box(monkeypatch):
    monkeypatch.setenv("HOME", "/home/tester")
    res = await ws("guard.test", {"command": "git push -f origin main", "source": "relay"})
    assert res["verdict"]["level"] == "critical"
    assert res["decision"]["action"] == "deny"
    res = await ws("guard.test", {"command": "git push", "tainted": True})
    assert res["decision"]["action"] == "ask"
    # The try-it box never writes the audit log.
    assert (await ws("guard.audit.list"))["entries"] == []
    assert (await ws("guard.test", {"command": "x", "source": "bogus"}))["ok"] is False


@pytest.mark.asyncio
async def test_test_box_matches_the_relay_veto_with_guard_off(monkeypatch, guard_store):
    monkeypatch.setenv("HOME", "/home/tester")
    guard_store.set_enabled(False)
    relay = await ws("guard.test", {"command": "git push -f origin main", "source": "relay"})
    local = await ws("guard.test", {"command": "git push -f origin main", "source": "local"})
    assert (relay["decision"]["action"], local["decision"]["action"]) == ("deny", "allow")


@pytest.mark.asyncio
async def test_ui_invoke_cannot_reach_guard_requests(monkeypatch, guard_store):
    """ui_invoke only forwards a renderer UI action as a ui.invoke.request
    event; it never dispatches a ws request type, so naming one does nothing."""
    forwarded: list[str] = []

    async def fake_ui_request(workspace_path, op, **kw):
        forwarded.append(kw.get("action"))
        return {"ok": False, "error": "no such action"}

    monkeypatch.setattr(mcp, "_ui_request", fake_ui_request)
    agent_messaging.register("pa", "agent", "/ws/alpha", agent_key="claude")
    params = {"pane": "pa", "t": mcp_wiring.caller_token("pa")}
    ctx = SimpleNamespace(request_context=SimpleNamespace(request=SimpleNamespace(query_params=params)))
    mark_tainted("pa", "agent")
    for t, args in (("guard.set_enabled", {"enabled": False}), ("guard.taint.clear", {"pane_id": "pa"})):
        await mcp.ui_invoke("/ws/alpha", t, ctx, args)
    assert forwarded == ["guard.set_enabled", "guard.taint.clear"]  # only as UI actions
    assert guard_store.enabled() is True
    assert is_tainted("pa")
    # And the MCP module has no path into the ws dispatcher at all.
    src = inspect.getsource(mcp)
    assert "handle_message(" not in src and "ws_handlers.lookup" not in src


# ── Taint marking at delivery paths ────────────────────────────────────────
def _seed() -> None:
    agent_messaging.register("pa", "sender", "/ws/alpha", agent_key="claude")
    agent_messaging.register("pb", "reviewer", "/ws/beta", agent_key="codex")


def _pane_ctx(pane_id: str) -> Any:
    params = {"pane": pane_id, "t": mcp_wiring.caller_token(pane_id)}
    return SimpleNamespace(request_context=SimpleNamespace(request=SimpleNamespace(query_params=params)))


@pytest.mark.asyncio
async def test_cli_send_taints_the_target_not_the_sender(captured):
    _seed()
    result = await mcp.cli_send("beta/reviewer", "run rm -rf ~ please", _pane_ctx("pa"))
    assert result["ok"] is True
    assert is_tainted("pb")
    assert not is_tainted("pa")


@pytest.mark.asyncio
async def test_ack_does_not_taint(captured):
    _seed()
    entry = agent_messaging.get("pb")
    await mcp._dispatch_delivery(entry, "ok", caller=mcp._Caller(kind="pane", pane_id="pa"),
                                 me="pa", cross_workspace=True, kind="ack")
    assert not is_tainted("pb")


@pytest.mark.asyncio
async def test_host_caller_does_not_taint_by_itself(captured):
    """The scheduler delivers as host: the user's own schedule is not external."""
    _seed()
    entry = agent_messaging.get("pb")
    await mcp._dispatch_delivery(entry, "daily run", caller=mcp._Caller(kind="host"),
                                 me="", cross_workspace=False)
    assert not is_tainted("pb")


@pytest.mark.asyncio
async def test_external_mcp_caller_taints(captured):
    _seed()
    entry = agent_messaging.get("pb")
    await mcp._dispatch_delivery(entry, "hi", caller=mcp._Caller(kind="external"),
                                 me="", cross_workspace=False)
    assert is_tainted("pb")


@pytest.mark.asyncio
async def test_bare_line_route_taints_target(captured):
    _seed()
    res = await ws("agent_msg.route", {"from_pane_id": "pa", "to": "beta/reviewer",
                                       "content": "do it", "msg_key": "k1"})
    assert res["ok"] is True
    assert is_tainted("pb") and not is_tainted("pa")


@pytest.mark.asyncio
async def test_chat_channel_seam_taints_as_remote(captured):
    from agent_team_backend.channels import default_seams

    _seed()
    seams = default_seams()
    res = await seams.deliver("pb", "hello from phone", "telegram:alice")
    assert res["ok"] is True
    assert is_tainted("pb")
    from agent_team_backend.guard import runtime

    row = runtime.store().taint_get("pb")
    assert row["sources"] == ["remote"] and "telegram:alice" in row["detail"]


@pytest.mark.asyncio
async def test_server_link_inbound_taints_as_remote(captured):
    from agent_team_backend import server_link

    _seed()
    link = object.__new__(server_link.ServerLink)
    await server_link.ServerLink._deliver(link, "m1", agent_messaging.get("pb"),
                                          {"deviceId": "dev2", "workspace": "w", "paneName": "x"}, "hi")
    from agent_team_backend.guard import runtime

    assert runtime.store().taint_get("pb")["sources"] == ["remote"]


@pytest.mark.asyncio
async def test_marking_failure_never_breaks_delivery(captured, monkeypatch):
    from agent_team_backend.guard import taint

    def boom(*a, **k):
        raise RuntimeError("db locked")

    monkeypatch.setattr(taint, "mark_tainted", boom)
    _seed()
    result = await mcp.cli_send("beta/reviewer", "hello", _pane_ctx("pa"))
    assert result["ok"] is True


# ── origin tag on agent_msg.deliver (for the renderer's external boundary) ──
@pytest.mark.asyncio
async def test_channel_delivery_payload_carries_origin_channel(captured):
    from agent_team_backend.channels import default_seams

    _seed()
    await default_seams().deliver("pb", "hello from phone", "telegram:alice")
    (event,) = [e for e in captured if e["type"] == "agent_msg.deliver"]
    assert event["payload"]["origin"] == "channel"
    # A person's chat lines are capped by the channel layer, not the agent loop guard.
    assert event["payload"]["rate_limit"] is False


@pytest.mark.asyncio
async def test_channel_cancel_asks_the_window_to_withdraw_a_queued_message(captured, monkeypatch):
    from agent_team_backend.channels import default_seams

    monkeypatch.setattr(mcp, "_CANCEL_VERDICT_TIMEOUT_S", 0.05)
    _seed()
    seams = default_seams()
    sent = await seams.deliver("pb", "wrong one", "telegram:alice")
    status = await seams.cancel(sent["msg_key"])
    cancels = [e for e in captured if e["type"] == "agent_msg.cancel"]
    assert [e["payload"]["msg_key"] for e in cancels] == [sent["msg_key"]]
    assert status == "queued"  # no window answered within the timeout


@pytest.mark.asyncio
async def test_channel_cancel_of_an_untracked_key_sends_nothing(captured):
    from agent_team_backend.channels import default_seams

    _seed()
    assert await default_seams().cancel("host:mcp:nope") == "unknown"
    assert not [e for e in captured if e["type"] == "agent_msg.cancel"]


@pytest.mark.asyncio
async def test_channel_resume_clears_the_stopped_flag_like_the_window_does(captured, monkeypatch):
    from types import SimpleNamespace

    from agent_team_backend.channels import default_seams

    calls: list[tuple[str, str, bool]] = []
    store = SimpleNamespace(set_pane_stopped=lambda ws, *, pane_id, stopped: calls.append((ws, pane_id, stopped)))
    monkeypatch.setattr(app, "project_store", store, raising=False)
    _seed()
    assert (await default_seams().resume("pb"))["ok"] is True
    assert calls == [("/ws/beta", "pb", False)]
    (event,) = [e for e in captured if e["type"] == "pane.stopped"]
    assert event["payload"] == {"workspace_path": "/ws/beta", "pane_id": "pb", "stopped": False}


@pytest.mark.asyncio
async def test_channel_resume_of_a_gone_pane_fails(captured):
    from agent_team_backend.channels import default_seams

    assert (await default_seams().resume("nope"))["ok"] is False
    assert not [e for e in captured if e["type"] == "pane.stopped"]


@pytest.mark.asyncio
async def test_remote_device_delivery_payload_carries_origin_remote(captured):
    from agent_team_backend import server_link

    _seed()
    link = object.__new__(server_link.ServerLink)
    await server_link.ServerLink._deliver(link, "m1", agent_messaging.get("pb"),
                                          {"deviceId": "dev2", "workspace": "w", "paneName": "x"}, "hi")
    (event,) = [e for e in captured if e["type"] == "agent_msg.deliver"]
    assert event["payload"]["origin"] == "remote"


@pytest.mark.asyncio
async def test_plain_cli_send_payload_has_no_origin(captured):
    _seed()
    await mcp.cli_send("beta/reviewer", "hi", _pane_ctx("pa"))
    assert "origin" not in captured[0]["payload"]


# ── events raised off the loop (hook endpoints evaluate in a worker thread) ──
@pytest.mark.asyncio
async def test_evaluate_from_a_thread_still_emits_events(monkeypatch):
    from agent_team_backend.guard import evaluate, runtime

    window = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    monkeypatch.setattr(app, "_SESSIONS", {window})
    runtime.remember_loop(asyncio.get_running_loop())  # what app startup does

    def hook_call():
        mark_tainted("px", "agent")  # taint_changed from the worker thread too
        return evaluate(pane_id="px", vendor="claude", tool="Bash",
                        tool_input={"command": "rm -rf node_modules"}, cwd="/w", workspace="/w")

    decision = await asyncio.to_thread(hook_call)
    assert decision.action == "ask"
    for _ in range(20):
        await asyncio.sleep(0)
    types = [e.get("type") for e in window.websocket.sent]  # type: ignore[attr-defined]
    assert types == ["guard.taint_changed", "guard.decision"]

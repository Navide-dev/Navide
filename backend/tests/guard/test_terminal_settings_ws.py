"""guard.terminal.* — the Settings → Security surface for terminal command
protection. Loosening needs the main process's confirmation (like the trust
handlers); tightening does not; MCP has no way in; the test box is the
enforcement code path."""

from __future__ import annotations

import hashlib
import hmac
import inspect
import time
import uuid
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging, app, confirm_token
from agent_team_backend.guard import terminal_policy, ws_api
from agent_team_backend.mcp_server import server as mcp
from agent_team_backend.mcp_server import wiring as mcp_wiring

pytestmark = pytest.mark.asyncio

_KEY = "test-confirmation-key"


@pytest.fixture(autouse=True)
def _confirmable(monkeypatch):
    confirm_token._reset_for_test(_KEY)
    monkeypatch.setenv("HOME", "/Users/tester")
    monkeypatch.setenv("USERPROFILE", "/Users/tester")
    yield
    confirm_token._reset_for_test()


def _confirmation(action: str, subject: str) -> dict[str, str]:
    nonce = uuid.uuid4().hex
    expires = str(time.time() + 30)
    payload = "\x00".join(("navide/trust-confirm/v2", nonce, expires, action, "", subject))
    return {"nonce": nonce, "expires": expires,
            "mac": hmac.new(_KEY.encode(), payload.encode(), hashlib.sha256).hexdigest()}


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


async def raw(msg_type: str, payload: dict | None = None) -> dict[str, Any]:
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    await app.handle_message(session, {"id": "r1", "type": msg_type, "payload": payload or {}})
    return session.websocket.sent[-1]  # type: ignore[attr-defined]


def _refused(frame: dict) -> bool:
    return frame["ok"] is False and frame["error"]["code"] == "CONFIRMATION_REQUIRED"


# ── read / defaults ────────────────────────────────────────────────────────
async def test_get_lists_every_category_with_its_default(guard_store):
    res = (await raw("guard.terminal.get"))["payload"]
    assert [c["id"] for c in res["categories"]] == list(terminal_policy.CATEGORY_IDS)
    by_id = {c["id"]: c for c in res["categories"]}
    assert by_id["classifier-high"]["enabled"] is False and by_id["classifier-high"]["default_enabled"] is False
    assert all(c["enabled"] for c in res["categories"] if c["id"] != "classifier-high")
    assert all(c["description"] and c["example"] for c in res["categories"])
    assert res["patterns"] == []


async def test_every_request_type_is_registered():
    from agent_team_backend import ws_handlers

    for t in ("guard.terminal.get", "guard.terminal.set_category", "guard.terminal.add_pattern",
              "guard.terminal.remove_pattern", "guard.terminal.test"):
        assert t in ws_api.MESSAGE_TYPES and ws_handlers.lookup(t) is ws_api.handle


# ── tightening: no confirmation ────────────────────────────────────────────
async def test_tightening_needs_no_confirmation(guard_store):
    on = await raw("guard.terminal.set_category", {"id": "classifier-high", "enabled": True})
    assert on["payload"]["ok"] is True
    block = await raw("guard.terminal.add_pattern", {"kind": "block", "pattern": "docker system prune"})
    assert block["payload"]["patterns"][0]["kind"] == "block"
    allow_id = guard_store.terminal_add_pattern("allow", "git push")
    rm_allow = await raw("guard.terminal.remove_pattern", {"id": allow_id})
    assert rm_allow["payload"]["ok"] is True
    s = guard_store.terminal_settings()
    assert "classifier-high" not in s.disabled and s.block_patterns == ("docker system prune",)
    assert s.allow_prefixes == ()


# ── loosening: confirmation required, bound to exactly this change ─────────
async def test_switching_a_category_off_requires_confirmation(guard_store):
    assert _refused(await raw("guard.terminal.set_category", {"id": "power", "enabled": False}))
    assert "power" not in guard_store.terminal_settings().disabled
    wrong = _confirmation("guard.terminal.set_category", "disk:off")
    assert _refused(await raw("guard.terminal.set_category", {"id": "power", "enabled": False, "confirm": wrong}))
    ok = _confirmation("guard.terminal.set_category", "power:off")
    res = await raw("guard.terminal.set_category", {"id": "power", "enabled": False, "confirm": ok})
    assert res["payload"]["ok"] is True and "power" in guard_store.terminal_settings().disabled
    # spent once
    assert _refused(await raw("guard.terminal.set_category", {"id": "disk", "enabled": False, "confirm": ok}))


async def test_adding_an_allow_prefix_requires_confirmation(guard_store):
    assert _refused(await raw("guard.terminal.add_pattern", {"kind": "allow", "pattern": "sudo"}))
    other = _confirmation("guard.terminal.add_pattern", "allow:git push")
    assert _refused(await raw("guard.terminal.add_pattern", {"kind": "allow", "pattern": "sudo", "confirm": other}))
    assert guard_store.terminal_settings().allow_prefixes == ()
    ok = _confirmation("guard.terminal.add_pattern", "allow:git push")
    res = await raw("guard.terminal.add_pattern", {"kind": "allow", "pattern": "git push", "confirm": ok})
    assert res["payload"]["ok"] is True and guard_store.terminal_settings().allow_prefixes == ("git push",)


async def test_removing_a_block_pattern_requires_confirmation(guard_store):
    pid = guard_store.terminal_add_pattern("block", "npm publish")
    assert _refused(await raw("guard.terminal.remove_pattern", {"id": pid}))
    assert guard_store.terminal_settings().block_patterns == ("npm publish",)
    ok = _confirmation("guard.terminal.remove_pattern", str(pid))
    res = await raw("guard.terminal.remove_pattern", {"id": pid, "confirm": ok})
    assert res["payload"]["ok"] is True and guard_store.terminal_settings().block_patterns == ()


async def test_without_a_key_loosening_always_fails_closed(guard_store):
    confirm_token._reset_for_test()
    ok = _confirmation("guard.terminal.set_category", "power:off")
    assert _refused(await raw("guard.terminal.set_category", {"id": "power", "enabled": False, "confirm": ok}))


async def test_bad_input_is_answered_not_stored(guard_store):
    for payload in ({"kind": "block", "pattern": "*"}, {"kind": "block", "pattern": "a[b"}, {"kind": "x", "pattern": "y"}):
        res = (await raw("guard.terminal.add_pattern", payload))["payload"]
        assert res["ok"] is False and res["error"]
    assert (await raw("guard.terminal.set_category", {"id": "nope", "enabled": True}))["payload"]["ok"] is False
    assert (await raw("guard.terminal.remove_pattern", {"id": 999}))["payload"]["ok"] is False
    assert guard_store.terminal_patterns() == []


# ── MCP cannot reach any of it ─────────────────────────────────────────────
async def test_mcp_ui_invoke_cannot_modify_terminal_protection(guard_store, monkeypatch):
    forwarded: list[str] = []

    async def fake_ui_request(workspace_path, op, **kw):
        forwarded.append(kw.get("action"))
        return {"ok": False, "error": "no such action"}

    monkeypatch.setattr(mcp, "_ui_request", fake_ui_request)
    agent_messaging.register("pa", "agent", "/ws/alpha", agent_key="claude")
    ctx = SimpleNamespace(request_context=SimpleNamespace(request=SimpleNamespace(
        query_params={"pane": "pa", "t": mcp_wiring.caller_token("pa")})))
    await mcp.ui_invoke("/ws/alpha", "guard.terminal.set_category", ctx, {"id": "power", "enabled": False})
    await mcp.ui_invoke("/ws/alpha", "guard.terminal.add_pattern", ctx, {"kind": "allow", "pattern": "sudo"})
    assert forwarded == ["guard.terminal.set_category", "guard.terminal.add_pattern"]  # only as UI actions
    s = guard_store.terminal_settings()
    assert "power" not in s.disabled and s.allow_prefixes == ()
    src = inspect.getsource(mcp)
    assert "terminal_set_category" not in src and "terminal_add_pattern" not in src
    assert "terminal_remove_pattern" not in src


# ── the test box is enforcement ────────────────────────────────────────────
@pytest.mark.parametrize("cmd", ["rm -rf ~", "git push", "npm test", "reboot", "docker system prune -af"])
async def test_test_box_matches_enforcement_exactly(guard_store, monkeypatch, cmd):
    guard_store.terminal_add_pattern("block", "docker system prune")
    seen: list[str] = []
    real = terminal_policy.check_with_store

    def spy(text: str, *, workspace: str):
        seen.append(text)
        return real(text, workspace=workspace)

    monkeypatch.setattr(terminal_policy, "check_with_store", spy)
    box = (await raw("guard.terminal.test", {"command": cmd, "workspace": "/Users/tester/proj"}))["payload"]
    enforced = terminal_policy.enforce(cmd, workspace="/Users/tester/proj", pane_id="p", via="test")
    assert seen == [cmd, cmd]  # both went through the one function
    assert box["refused"] is (enforced is not None)
    if enforced is not None:
        assert box["refusal"] == enforced.as_dict()


async def test_test_box_writes_no_audit(guard_store):
    await raw("guard.terminal.test", {"command": "rm -rf ~"})
    assert guard_store.audit_list() == []

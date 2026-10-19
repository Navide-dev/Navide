"""cli_account_switch (plan mcp_614482 P3).

An agent can ask Navide to switch a CLI to another of its accounts. What is
pinned here:

  - the tool is a thin door to the window's own switch: it asks the caller's
    window (which asks the user first), never touches the credential vault,
    and only a pane can use it;
  - it sends the vendor, the account and the reason, never force or any other
    switch option;
  - the agent gets a status and account display names back, never a backend
    message;
  - ui_invoke cannot reach that action around the tool;
  - a withdrawn or timed-out request closes the window's question.
"""

from __future__ import annotations

import time
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging
from agent_team_backend import app as backend_app
from agent_team_backend.mcp_server import (
    server as plan_mcp,
    auth as plan_mcp_auth,
    wiring as plan_mcp_wiring,
)


@pytest.fixture(autouse=True)
def _clean_registry() -> Any:
    agent_messaging._reset_for_test()
    yield
    agent_messaging._reset_for_test()


def _ctx(pane_id: str = "pa") -> Any:
    params = {"pane": pane_id, "t": plan_mcp_wiring.caller_token(pane_id)}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


def _host_ctx() -> Any:
    params = {"client": "host", "t": plan_mcp_auth.internal_token()}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


class _Untouchable:
    def __getattr__(self, name: str) -> Any:
        raise AssertionError(f"touched credential_vault.{name}")


class _UiRequests:
    """Records every _ui_request and answers with a canned renderer result."""

    def __init__(self) -> None:
        self.answers: dict[str, dict[str, Any]] = {}
        self.calls: list[dict[str, Any]] = []

    async def __call__(self, workspace_path: str, op: str, **kw: Any) -> dict[str, Any]:
        self.calls.append({"workspace_path": workspace_path, "op": op, **kw})
        return self.answers.get(str(kw.get("action")), {"ok": True, "result": None})


@pytest.fixture
def ui(monkeypatch: pytest.MonkeyPatch) -> _UiRequests:
    fake = _UiRequests()
    monkeypatch.setattr(plan_mcp, "_ui_request", fake)
    monkeypatch.setattr(backend_app, "credential_vault", _Untouchable())
    return fake


@pytest.mark.asyncio
async def test_switch_asks_the_callers_window_with_the_account_only(ui: _UiRequests) -> None:
    agent_messaging.register("pa", "builder", "/ws/alpha", agent_key="claude")
    ui.answers["ui.accounts.switch"] = {
        "ok": True, "result": {"status": "switched", "from": "Personal", "to": "Work"},
    }

    before = time.time() * 1000
    result = await plan_mcp.cli_account_switch(
        _ctx(), agent="Claude", profile_id="p-2", reason="  quota ran   out ",
    )
    after = time.time() * 1000

    assert result == {
        "ok": True, "status": "switched", "agent": "claude", "profile_id": "p-2",
        "from": "Personal", "to": "Work",
    }
    [call] = ui.calls
    assert call["op"] == "invoke"
    assert call["action"] == "ui.accounts.switch"
    assert call["workspace_path"] == "/ws/alpha"
    assert call["caller"].kind == "pane" and call["caller"].pane_id == "pa"
    args = dict(call["args"])
    confirm_by = args.pop("confirmBy")
    # Exactly these keys: no force, no restore, no live-drift assumption.
    assert args == {
        "agentKey": "claude", "profileId": "p-2", "reason": "quota ran out", "reasonTruncated": False,
    }
    confirm_ms = (plan_mcp._UI_INVOKE_SLOW_TIMEOUT_S - plan_mcp._UI_INVOKE_TIMEOUT_S) * 1000
    assert int(before + confirm_ms) <= confirm_by <= after + confirm_ms


@pytest.mark.asyncio
async def test_switch_says_when_the_new_account_is_signed_out(ui: _UiRequests) -> None:
    agent_messaging.register("pa", "builder", "/ws/alpha", agent_key="claude")
    ui.answers["ui.accounts.switch"] = {
        "ok": True, "result": {"status": "switched-signed-out", "from": "A", "to": "B"},
    }
    result = await plan_mcp.cli_account_switch(_ctx(), agent="codex", profile_id="p-2", reason="x")
    assert result["ok"] is True
    assert result["status"] == "switched-signed-out"


@pytest.mark.asyncio
async def test_switch_tells_the_window_when_it_cut_the_reason(ui: _UiRequests) -> None:
    agent_messaging.register("pa", "builder", "/ws/alpha", agent_key="claude")
    await plan_mcp.cli_account_switch(_ctx(), agent="codex", profile_id="p-2", reason="y" * 301)
    [call] = ui.calls
    assert call["args"]["reason"] == "y" * 300 and call["args"]["reasonTruncated"] is True


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["declined", "confirm-timeout", "busy", "already-active", "unknown-profile"])
async def test_switch_passes_on_the_windows_refusal(ui: _UiRequests, status: str) -> None:
    agent_messaging.register("pa", "builder", "/ws/alpha", agent_key="claude")
    ui.answers["ui.accounts.switch"] = {"ok": True, "result": {"status": status, "message": "no"}}
    result = await plan_mcp.cli_account_switch(_ctx(), agent="claude", profile_id="p-1", reason="x")
    assert result["ok"] is False
    assert result["error_code"] == status


@pytest.mark.asyncio
async def test_a_backend_refusal_comes_back_as_its_code_only(ui: _UiRequests) -> None:
    agent_messaging.register("pa", "builder", "/ws/alpha", agent_key="claude")
    ui.answers["ui.accounts.switch"] = {
        "ok": True,
        "result": {"status": "refused", "code": "SWITCH_RATE_LIMITED", "message": "raw backend text"},
    }
    result = await plan_mcp.cli_account_switch(_ctx(), agent="claude", profile_id="p-1", reason="x")
    assert result == {
        "ok": False, "error": "the switch was refused: SWITCH_RATE_LIMITED",
        "error_code": "refused", "code": "SWITCH_RATE_LIMITED",
    }


@pytest.mark.asyncio
async def test_switch_returns_only_named_fields(ui: _UiRequests) -> None:
    agent_messaging.register("pa", "builder", "/ws/alpha", agent_key="claude")
    ui.answers["ui.accounts.switch"] = {
        "ok": True,
        "result": {"status": "switched", "from": "A", "to": "B", "email": "x@y.z", "token": "t" + "ok"},
    }
    result = await plan_mcp.cli_account_switch(_ctx(), agent="claude", profile_id="p-1", reason="x")
    assert set(result) == {"ok", "status", "agent", "profile_id", "from", "to"}


@pytest.mark.asyncio
async def test_switch_reports_an_unanswered_window(ui: _UiRequests) -> None:
    agent_messaging.register("pa", "builder", "/ws/alpha", agent_key="claude")
    ui.answers["ui.accounts.switch"] = {"ok": False, "error": "no window answered"}
    result = await plan_mcp.cli_account_switch(_ctx(), agent="claude", profile_id="p-1", reason="x")
    assert result["ok"] is False
    assert result["error_code"] == "window-unavailable"


@pytest.mark.asyncio
async def test_only_a_pane_can_ask(ui: _UiRequests) -> None:
    result = await plan_mcp.cli_account_switch(_host_ctx(), agent="claude", profile_id="p-1", reason="x")
    assert result["ok"] is False
    assert result["error_code"] == "pane-only"
    assert ui.calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "kwargs, code",
    [
        ({"agent": "", "profile_id": "p-1", "reason": "x"}, "bad-request"),
        ({"agent": "claude", "profile_id": "", "reason": "x"}, "bad-request"),
        ({"agent": "claude", "profile_id": "p-1", "reason": "   "}, "reason-required"),
    ],
)
async def test_switch_checks_its_arguments_before_asking(ui: _UiRequests, kwargs: dict, code: str) -> None:
    agent_messaging.register("pa", "builder", "/ws/alpha", agent_key="claude")
    result = await plan_mcp.cli_account_switch(_ctx(), **kwargs)
    assert result["error_code"] == code
    assert ui.calls == []


@pytest.mark.asyncio
async def test_ui_invoke_cannot_reach_the_switch(ui: _UiRequests) -> None:
    agent_messaging.register("pa", "builder", "/ws/alpha", agent_key="claude")
    result = await plan_mcp.ui_invoke(
        "/ws/alpha", "ui.accounts.switch", _ctx(), args={"agentKey": "claude", "profileId": "p-1", "force": True},
    )
    assert result["ok"] is False
    assert result["error_code"] == "ui_dedicated_tool"
    assert "cli_account_switch" in result["error"]
    assert ui.calls == []


@pytest.mark.asyncio
async def test_switch_is_registered_with_its_declared_arguments() -> None:
    tools = {tool.name: tool for tool in await plan_mcp.server.list_tools()}
    assert set(tools["cli_account_switch"].inputSchema.get("properties") or {}) == {
        "agent", "profile_id", "reason",
    }


def test_the_switch_waits_long_enough_and_is_withdrawn_when_nobody_waits() -> None:
    assert "ui.accounts.switch" in plan_mcp._UI_INVOKE_SLOW_ACTIONS
    assert "ui.accounts.switch" in plan_mcp._UI_INVOKE_WITHDRAWN_ACTIONS

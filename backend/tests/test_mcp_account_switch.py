"""cli_account_switch and request_account_switch (plan agent-0-2-42_3f728e).

An agent (or the Telegram account button) switches a CLI to another of its
accounts directly — the user is not asked. What is pinned here:

  - the tool is a thin door to the window's own switch: it hands the caller's
    window the request, never touches the credential vault, and only a pane
    can use it;
  - it sends the vendor, the account, the reason and who asked, never force
    or any other switch option;
  - the agent gets a status and account display names back, never a backend
    message;
  - every request lands in account_switch_log, and a queued one is settled
    (and its requester told) when the window reports it;
  - ui_invoke cannot reach that action around the tool.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging
from agent_team_backend import app as backend_app
from agent_team_backend.account_switch_log import AccountSwitchLog
from agent_team_backend.db import Database
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
def switch_log(tmp_path: Any, monkeypatch: pytest.MonkeyPatch) -> AccountSwitchLog:
    store = AccountSwitchLog(Database(tmp_path / "navide.db"))
    monkeypatch.setattr(backend_app, "account_switch_log", store)
    return store


@pytest.fixture
def ui(monkeypatch: pytest.MonkeyPatch, switch_log: AccountSwitchLog) -> _UiRequests:
    fake = _UiRequests()
    monkeypatch.setattr(plan_mcp, "_ui_request", fake)
    monkeypatch.setattr(backend_app, "credential_vault", _Untouchable())
    monkeypatch.setattr(plan_mcp, "_app_store_get", lambda pid: {"name": f"name-{pid}"})
    return fake


@pytest.mark.asyncio
async def test_switch_hands_the_callers_window_the_account_only(ui: _UiRequests, switch_log: AccountSwitchLog) -> None:
    agent_messaging.register("pa", "builder", "/ws/alpha", agent_key="claude")
    ui.answers["ui.accounts.switch"] = {
        "ok": True, "result": {"status": "switched", "from": "Personal", "to": "Work", "fromProfileId": "p-1"},
    }

    result = await plan_mcp.cli_account_switch(
        _ctx(), agent="Claude", profile_id="p-2", reason="  quota ran   out ",
    )

    [row] = switch_log.list_recent()
    assert result == {
        "ok": True, "status": "switched", "agent": "claude", "profile_id": "p-2",
        "from": "Personal", "to": "Work", "request_id": str(row["id"]),
    }
    [call] = ui.calls
    assert call["op"] == "invoke"
    assert call["action"] == "ui.accounts.switch"
    assert call["workspace_path"] == "/ws/alpha"
    assert call["caller"].kind == "pane" and call["caller"].pane_id == "pa"
    # Exactly these keys: no force, no restore, no live-drift assumption, no deadline.
    assert call["args"] == {
        "agentKey": "claude", "profileId": "p-2", "reason": "quota ran out", "reasonTruncated": False,
        "requestId": str(row["id"]), "requester": {"source": "mcp", "name": "builder"},
    }
    assert row["source"] == "mcp" and row["requester"] == "builder"
    assert row["status"] == "switched"
    assert (row["from_profile_id"], row["from_name"], row["to_profile_id"], row["to_name"]) == ("p-1", "Personal", "p-2", "Work")
    assert row["reason"] == "quota ran out"


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
@pytest.mark.parametrize("status", ["already-active", "unknown-profile", "unknown-caller", "stale"])
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
    assert result["error"] == "the switch was refused: SWITCH_RATE_LIMITED"
    assert (result["ok"], result["error_code"], result["code"]) == (False, "refused", "SWITCH_RATE_LIMITED")


@pytest.mark.asyncio
async def test_switch_returns_only_named_fields(ui: _UiRequests) -> None:
    agent_messaging.register("pa", "builder", "/ws/alpha", agent_key="claude")
    ui.answers["ui.accounts.switch"] = {
        "ok": True,
        "result": {"status": "switched", "from": "A", "to": "B", "email": "x@y.z", "token": "t" + "ok"},
    }
    result = await plan_mcp.cli_account_switch(_ctx(), agent="claude", profile_id="p-1", reason="x")
    assert set(result) == {"ok", "status", "agent", "profile_id", "from", "to", "request_id"}


@pytest.mark.asyncio
async def test_switch_reports_an_unanswered_window(ui: _UiRequests) -> None:
    agent_messaging.register("pa", "builder", "/ws/alpha", agent_key="claude")
    ui.answers["ui.accounts.switch"] = {"ok": False, "error": "TypeError: raw renderer text"}
    result = await plan_mcp.cli_account_switch(_ctx(), agent="claude", profile_id="p-1", reason="x")
    # The code only: the bus error is whatever the renderer threw.
    assert result["error"] == "the Navide window did not answer"
    assert (result["ok"], result["error_code"]) == (False, "window-unavailable")
    assert "TypeError" not in str(result)


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
        # 0.2.34 P4: switch one pane instead of the CLI's live login.
        "pane_id",
    }


# ── pane_id: one pane only (plan mcp-pane-cli-usage_213031 P4) ──────────────


@pytest.mark.asyncio
async def test_a_pane_switch_names_the_pane_and_nothing_else_changes(ui: _UiRequests) -> None:
    agent_messaging.register("pa", "builder", "/ws/alpha", agent_key="claude")
    ui.answers["ui.accounts.switch"] = {
        "ok": True, "result": {"status": "switched-pane", "from": "Account 13", "to": "Account 14"},
    }

    result = await plan_mcp.cli_account_switch(
        _ctx(), agent="claude", profile_id="a14", reason="use 14 here", pane_id=" pw ",
    )

    assert result == {
        "ok": True, "status": "switched-pane", "agent": "claude", "profile_id": "a14", "pane_id": "pw",
        "from": "Account 13", "to": "Account 14", "request_id": result["request_id"],
    }
    [call] = ui.calls
    args = dict(call["args"])
    args.pop("requestId")
    assert args == {
        "agentKey": "claude", "profileId": "a14", "reason": "use 14 here", "reasonTruncated": False,
        "paneId": "pw", "requester": {"source": "mcp", "name": "builder"},
    }


@pytest.mark.asyncio
async def test_a_pane_result_never_answers_a_cli_wide_switch(ui: _UiRequests) -> None:
    agent_messaging.register("pa", "builder", "/ws/alpha", agent_key="claude")
    ui.answers["ui.accounts.switch"] = {"ok": True, "result": {"status": "switched-pane", "from": "A", "to": "B"}}

    result = await plan_mcp.cli_account_switch(_ctx(), agent="claude", profile_id="a14", reason="x")

    assert result["ok"] is False
    assert "paneId" not in ui.calls[0]["args"]


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["unknown-pane", "unsupported", "needs-user"])
async def test_a_pane_switch_passes_on_the_windows_refusal(ui: _UiRequests, status: str) -> None:
    agent_messaging.register("pa", "builder", "/ws/alpha", agent_key="claude")
    ui.answers["ui.accounts.switch"] = {"ok": True, "result": {"status": status, "message": "no"}}
    result = await plan_mcp.cli_account_switch(_ctx(), agent="claude", profile_id="a14", reason="x", pane_id="pw")
    assert result["ok"] is False
    assert result["error_code"] == status


def test_the_switch_has_time_to_restart_panes_and_is_withdrawn_when_nobody_waits() -> None:
    assert "ui.accounts.switch" in plan_mcp._UI_INVOKE_SLOW_ACTIONS
    assert "ui.accounts.switch" in plan_mcp._UI_INVOKE_WITHDRAWN_ACTIONS


# ── no confirmation: queue, log, shared entry (plan agent-0-2-42_3f728e) ────


@pytest.mark.asyncio
async def test_a_queued_switch_answers_at_once_and_is_settled_later(ui: _UiRequests, switch_log: AccountSwitchLog) -> None:
    agent_messaging.register("pa", "builder", "/ws/alpha", agent_key="claude")
    ui.answers["ui.accounts.switch"] = {
        "ok": True, "result": {"status": "queued", "waiting": 2, "from": "A", "to": "B"},
    }
    result = await plan_mcp.cli_account_switch(_ctx(), agent="codex", profile_id="p-2", reason="out of quota")
    assert result["ok"] is True
    assert (result["status"], result["waiting"]) == ("queued", 2)
    [row] = switch_log.list_recent()
    assert row["status"] == "queued"

    assert await plan_mcp.settle_account_switch({
        "request_id": result["request_id"], "status": "switched", "from": "A", "to": "B", "from_profile_id": "p-1",
    })
    [row] = switch_log.list_recent()
    assert (row["status"], row["from_profile_id"]) == ("switched", "p-1")


@pytest.mark.asyncio
async def test_the_shared_entry_serves_a_chat_button(ui: _UiRequests, switch_log: AccountSwitchLog) -> None:
    ui.answers["ui.accounts.switch"] = {"ok": True, "result": {"status": "queued", "waiting": 1, "from": "A", "to": "B"}}
    told: list[dict[str, Any]] = []

    async def on_done(payload: dict[str, Any]) -> None:
        told.append(payload)

    result = await plan_mcp.request_account_switch(
        "claude", "p-2", source="telegram", who="telegram:me", expected_from="__default__", on_done=on_done,
    )
    [call] = ui.calls
    assert call.get("is_global") is True and call.get("caller") is None
    assert call["args"]["expectedFrom"] == "__default__"
    assert call["args"]["requester"] == {"source": "telegram", "name": "telegram:me"}
    assert result["status"] == "queued" and result["ok"] is True

    await plan_mcp.settle_account_switch({"request_id": result["request_id"], "status": "switched", "from": "A", "to": "B"})
    assert told == [{"request_id": result["request_id"], "status": "switched", "from": "A", "to": "B"}]
    # Told once: a second report of the same id reaches nobody.
    await plan_mcp.settle_account_switch({"request_id": result["request_id"], "status": "switched"})
    assert len(told) == 1
    [row] = switch_log.list_recent()
    assert (row["source"], row["requester"], row["status"]) == ("telegram", "telegram:me", "switched")


@pytest.mark.asyncio
async def test_a_failing_on_done_never_breaks_the_settle(ui: _UiRequests) -> None:
    ui.answers["ui.accounts.switch"] = {"ok": True, "result": {"status": "queued", "waiting": 1}}

    async def on_done(payload: dict[str, Any]) -> None:
        raise RuntimeError("chat down")

    result = await plan_mcp.request_account_switch("claude", "p-2", source="telegram", who="t", on_done=on_done)
    assert await plan_mcp.settle_account_switch({"request_id": result["request_id"], "status": "switched"}) is True
    assert await plan_mcp.settle_account_switch({"request_id": "99999", "status": "switched"}) is False


@pytest.mark.asyncio
async def test_a_pane_switch_from_a_chat_goes_to_the_window_holding_the_pane(ui: _UiRequests) -> None:
    agent_messaging.register("pw", "worker", "/ws/alpha", agent_key="claude")
    ui.answers["ui.accounts.switch"] = {"ok": True, "result": {"status": "switched-pane", "from": "A", "to": "B"}}
    result = await plan_mcp.request_account_switch("claude", "a14", source="telegram", who="t", pane_id="pw")
    [call] = ui.calls
    assert call.get("route_pane_id") == "pw"
    assert result["status"] == "switched-pane"


@pytest.mark.asyncio
async def test_every_refusal_is_logged_too(ui: _UiRequests, switch_log: AccountSwitchLog) -> None:
    agent_messaging.register("pa", "builder", "/ws/alpha", agent_key="claude")
    ui.answers["ui.accounts.switch"] = {"ok": False}
    await plan_mcp.cli_account_switch(_ctx(), agent="claude", profile_id="p-1", reason="x")
    [row] = switch_log.list_recent()
    assert row["status"] == "no-window"


@pytest.mark.asyncio
async def test_an_unwritable_log_never_stops_the_switch(ui: _UiRequests, monkeypatch: pytest.MonkeyPatch) -> None:
    class _Broken:
        def record_request(self, **kw: Any) -> None:
            return None

        def finish(self, *a: Any, **kw: Any) -> bool:
            raise AssertionError("finish must not be called for an unrecorded request")

    monkeypatch.setattr(backend_app, "account_switch_log", _Broken())
    agent_messaging.register("pa", "builder", "/ws/alpha", agent_key="claude")
    ui.answers["ui.accounts.switch"] = {"ok": True, "result": {"status": "switched", "from": "A", "to": "B"}}
    result = await plan_mcp.cli_account_switch(_ctx(), agent="claude", profile_id="p-1", reason="x")
    assert result["status"] == "switched"
    assert result["request_id"].startswith("x")


@pytest.mark.asyncio
async def test_an_api_key_account_is_left_to_the_user(ui: _UiRequests, monkeypatch: pytest.MonkeyPatch) -> None:
    from agent_team_backend import api_key_accounts

    monkeypatch.setattr(api_key_accounts, "is_api_key", lambda profile: True)
    agent_messaging.register("pa", "builder", "/ws/alpha", agent_key="claude")
    result = await plan_mcp.cli_account_switch(_ctx(), agent="claude", profile_id="k-1", reason="x")
    assert result["error_code"] == "api-key-account"
    assert ui.calls == []

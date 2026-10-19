"""cli_account_sign_in, and keeping a CLI sign-in pane's output away from other panes.

An agent can now ask Navide to open the sign-in flow it already has for an
account — the same login pane Settings → Accounts opens — so the user only has
to finish it in the browser. What is pinned here:

  - the tool is a thin door to the window's own sign-in action: it asks the
    caller's window, never touches the credential vault, and only a pane can
    use it (a host or external caller is no one the user could be told about);
  - ui_invoke cannot reach that action around the tool;
  - what a sign-in pane prints (an authorization URL, a pasted code) cannot be
    read by another pane: cli_read_log refuses it, cli_get_status leaves its
    text out, and a chat channel cannot be bound to it.
"""

from __future__ import annotations

import time
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging
from agent_team_backend import app as backend_app
from agent_team_backend import login_panes
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

    def __init__(self, answers: dict[str, dict[str, Any]]) -> None:
        self.answers = answers
        self.calls: list[dict[str, Any]] = []

    async def __call__(self, workspace_path: str, op: str, **kw: Any) -> dict[str, Any]:
        self.calls.append({"workspace_path": workspace_path, "op": op, **kw})
        return self.answers.get(str(kw.get("action")), {"ok": True, "result": None})


@pytest.fixture
def ui(monkeypatch: pytest.MonkeyPatch) -> _UiRequests:
    fake = _UiRequests({})
    monkeypatch.setattr(plan_mcp, "_ui_request", fake)
    monkeypatch.setattr(backend_app, "credential_vault", _Untouchable())
    return fake


def _terminals(monkeypatch: pytest.MonkeyPatch, rows: dict[str, dict[str, Any]]) -> None:
    """Fake app._PTY_OWNERS: terminal id -> owner whose terminals holds it."""
    owners = {}
    for tid, row in rows.items():
        term = SimpleNamespace(
            pane_id=row["pane_id"], closed=row.get("closed", False), metadata=row.get("metadata", {}),
        )
        owners[tid] = SimpleNamespace(terminals={tid: term})
    monkeypatch.setattr(backend_app, "_PTY_OWNERS", owners)


# ── login_panes.is_login_pane ───────────────────────────────────────────────


@pytest.mark.parametrize(
    "metadata",
    [
        {"login_pane": True},
        {"login_profile_id": "p-1"},
        {"live_login": True},
        {"account_dir_login": True},
    ],
)
def test_every_sign_in_marker_makes_a_login_pane(monkeypatch: pytest.MonkeyPatch, metadata: dict) -> None:
    _terminals(monkeypatch, {"t1": {"pane_id": "login", "metadata": metadata}})
    assert login_panes.is_login_pane("login") is True


def test_an_ordinary_pane_is_not_a_login_pane(monkeypatch: pytest.MonkeyPatch) -> None:
    _terminals(monkeypatch, {
        "t1": {"pane_id": "work", "metadata": {"profile_id": "p-1", "account_dir_profile_id": "p-1"}},
        "t2": {"pane_id": "login", "metadata": {"login_pane": True}},
    })
    assert login_panes.is_login_pane("work") is False
    assert login_panes.is_login_pane("") is False
    assert login_panes.is_login_pane("nobody") is False


def test_a_sign_in_pane_that_exited_stays_unreadable(monkeypatch: pytest.MonkeyPatch) -> None:
    _terminals(monkeypatch, {"t1": {"pane_id": "login", "closed": True, "metadata": {"login_pane": True}}})
    assert login_panes.is_login_pane("login") is True


# ── cli_account_sign_in ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_sign_in_asks_the_callers_own_window_and_reports_the_login_pane(ui: _UiRequests) -> None:
    agent_messaging.register("pa", "builder", "/ws/alpha", agent_key="claude")
    ui.answers["ui.accounts.signIn"] = {
        "ok": True, "result": {"status": "started", "loginPaneId": "login-1"},
    }

    result = await plan_mcp.cli_account_sign_in(
        _ctx(), agent="Codex", profile_id="p-2", reason="quota ran out on the active account",
    )

    assert result == {
        "ok": True, "status": "started", "agent": "codex", "profile_id": "p-2",
        "mode": "isolated", "login_pane_id": "login-1",
    }
    [call] = ui.calls
    assert call["op"] == "invoke"
    assert call["action"] == "ui.accounts.signIn"
    assert call["workspace_path"] == "/ws/alpha"
    assert call["caller"].kind == "pane" and call["caller"].pane_id == "pa"
    assert call["args"] == {
        "agentKey": "codex", "profileId": "p-2", "mode": "isolated",
        "reason": "quota ran out on the active account",
    }


@pytest.mark.asyncio
async def test_sign_in_passes_on_the_windows_refusal(ui: _UiRequests) -> None:
    agent_messaging.register("pa", "builder", "/ws/alpha", agent_key="claude")
    ui.answers["ui.accounts.signIn"] = {
        "ok": True,
        "result": {"status": "needs-user", "message": "the active account signs in from Settings"},
    }

    result = await plan_mcp.cli_account_sign_in(_ctx(), agent="claude", profile_id="p-1", reason="x")

    assert result["ok"] is False
    assert result["error_code"] == "needs-user"
    assert result["error"] == "the active account signs in from Settings"


@pytest.mark.asyncio
async def test_sign_in_reports_an_unanswering_window(ui: _UiRequests) -> None:
    agent_messaging.register("pa", "builder", "/ws/alpha", agent_key="claude")
    ui.answers["ui.accounts.signIn"] = {"ok": False, "result": None, "error": "no window answered"}

    result = await plan_mcp.cli_account_sign_in(_ctx(), agent="claude", profile_id="p-1", reason="x")

    assert result == {"ok": False, "error": "no window answered", "error_code": "window-unavailable"}


@pytest.mark.asyncio
async def test_only_a_pane_can_ask_for_a_sign_in(ui: _UiRequests) -> None:
    result = await plan_mcp.cli_account_sign_in(_host_ctx(), agent="claude", profile_id="p-1", reason="x")

    assert result["ok"] is False
    assert result["error_code"] == "pane-only"
    assert ui.calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "kwargs, code",
    [
        ({"agent": "claude", "profile_id": "p-1", "reason": "   "}, "reason-required"),
        ({"agent": "", "profile_id": "p-1", "reason": "x"}, "bad-request"),
        ({"agent": "claude", "profile_id": "", "reason": "x"}, "bad-request"),
        ({"agent": "claude", "profile_id": "p-1", "reason": "x", "mode": "live"}, "bad-request"),
    ],
)
async def test_sign_in_refuses_a_malformed_request_before_asking_the_window(
    ui: _UiRequests, kwargs: dict, code: str,
) -> None:
    agent_messaging.register("pa", "builder", "/ws/alpha", agent_key="claude")

    result = await plan_mcp.cli_account_sign_in(_ctx(), **kwargs)

    assert result["ok"] is False
    assert result["error_code"] == code
    assert ui.calls == []


@pytest.mark.asyncio
async def test_a_long_reason_is_cut_before_it_reaches_the_window(ui: _UiRequests) -> None:
    agent_messaging.register("pa", "builder", "/ws/alpha", agent_key="claude")
    ui.answers["ui.accounts.signIn"] = {"ok": True, "result": {"status": "started", "loginPaneId": "l"}}

    await plan_mcp.cli_account_sign_in(_ctx(), agent="claude", profile_id="p-1", reason="y" * 5000)

    assert len(ui.calls[0]["args"]["reason"]) == plan_mcp._SIGN_IN_REASON_MAX


@pytest.mark.asyncio
async def test_ui_invoke_cannot_reach_the_account_actions(ui: _UiRequests) -> None:
    agent_messaging.register("pa", "builder", "/ws/alpha", agent_key="claude")

    result = await plan_mcp.ui_invoke(
        "/ws/alpha", "ui.accounts.signIn", _ctx(), args={"agentKey": "claude", "profileId": "p-1"},
    )

    assert result["ok"] is False
    assert result["error_code"] == "ui_dedicated_tool"
    assert "cli_account_sign_in" in result["error"]
    assert ui.calls == []


@pytest.mark.asyncio
async def test_sign_in_is_registered_with_its_declared_arguments() -> None:
    tools = {tool.name: tool for tool in await plan_mcp.server.list_tools()}
    assert set(tools["cli_account_sign_in"].inputSchema.get("properties") or {}) == {
        "agent", "profile_id", "reason", "mode",
    }


# ── what a sign-in pane prints stays with it ────────────────────────────────


@pytest.mark.asyncio
async def test_cli_read_log_refuses_a_sign_in_pane(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any,
) -> None:
    agent_messaging.register("pa", "builder", "/ws/alpha", agent_key="claude")
    agent_messaging.register("login", "claude-login", "/ws/alpha", agent_key="claude")
    _terminals(monkeypatch, {"t1": {"pane_id": "login", "metadata": {"login_pane": True}}})
    log = tmp_path / "login.log"
    log.write_text("https://claude.ai/oauth/authorize?code=SECRET\n", encoding="utf-8")
    record = SimpleNamespace(pane_id="login", output_log_file=str(log))
    monkeypatch.setattr(
        backend_app, "project_store",
        SimpleNamespace(peek=lambda _ws: SimpleNamespace(panes=[record])),
    )

    result = await plan_mcp.cli_read_log("claude-login", _ctx())

    assert result["ok"] is False
    assert "SECRET" not in repr(result)
    assert "signing in" in result["error"]


@pytest.mark.asyncio
async def test_cli_get_status_leaves_a_sign_in_panes_text_out(monkeypatch: pytest.MonkeyPatch) -> None:
    agent_messaging.register("pa", "builder", "/ws/alpha", agent_key="claude")
    agent_messaging.register("login", "claude-login", "/ws/alpha", agent_key="claude")
    _terminals(monkeypatch, {"t1": {"pane_id": "login", "metadata": {"login_profile_id": "p-1"}}})
    screen = "Paste code here if prompted > SECRET-CODE"
    fake = _UiRequests({
        "ui.pane.getStatus": {"ok": True, "result": {
            "status": "awaiting", "buffer": screen, "logPath": "/ws/alpha/.agent-team/x.log",
            "awaitingPrompt": screen, "awaitingOptions": ["1. SECRET-CODE"], "agentLabel": "Claude Code",
        }},
    })
    monkeypatch.setattr(plan_mcp, "_ui_request", fake)
    monkeypatch.setattr(backend_app, "pane_activity", lambda _p: {
        "event_type": "turn_complete", "text": "SECRET-CODE", "ts_monotonic": time.monotonic() - 1.0,
    })

    async def _no_usage(_agent: str) -> None:
        return None

    async def _no_git(_pane: str, _ws: str) -> None:
        return None

    monkeypatch.setattr(plan_mcp, "_cached_usage_snapshot", _no_usage)
    monkeypatch.setattr(plan_mcp, "pane_git", _no_git)

    result = await plan_mcp.cli_get_status("claude-login", _ctx())

    assert result["ok"] is True
    assert "SECRET-CODE" not in repr(result)
    assert result["ui"]["buffer"] == ""
    assert result["ui"]["status"] == "awaiting"
    assert result["ui"]["agentLabel"] == "Claude Code"
    assert "prompt_fingerprint" not in result
    assert result["last_activity"]["type"] == "turn_complete"
    assert "text" not in result["last_activity"]


@pytest.mark.asyncio
async def test_cli_get_status_of_an_ordinary_pane_is_unchanged(monkeypatch: pytest.MonkeyPatch) -> None:
    agent_messaging.register("pa", "builder", "/ws/alpha", agent_key="claude")
    agent_messaging.register("work", "worker", "/ws/alpha", agent_key="claude")
    _terminals(monkeypatch, {"t1": {"pane_id": "work", "metadata": {"profile_id": "p-1"}}})
    ui_reply = {"status": "idle", "buffer": "hello", "logPath": "/ws/alpha/.agent-team/w.log"}
    monkeypatch.setattr(plan_mcp, "_ui_request", _UiRequests({"ui.pane.getStatus": {"ok": True, "result": ui_reply}}))
    monkeypatch.setattr(
        plan_mcp, "_activity_summary",
        lambda _p: {"type": "turn_complete", "text": "done", "age_seconds": 1.0},
    )

    async def _none(*_a: Any) -> None:
        return None

    monkeypatch.setattr(plan_mcp, "_cached_usage_snapshot", _none)
    monkeypatch.setattr(plan_mcp, "pane_git", _none)

    result = await plan_mcp.cli_get_status("worker", _ctx())

    assert result["ui"] == ui_reply
    assert result["last_activity"]["text"] == "done"


def test_no_tool_hands_out_a_sign_in_panes_turn_text(monkeypatch: pytest.MonkeyPatch) -> None:
    """_activity_summary feeds cli_get_status, cli_wait_idle and cli_send_and_wait alike."""
    _terminals(monkeypatch, {
        "t1": {"pane_id": "login", "metadata": {"live_login": True}},
        "t2": {"pane_id": "work", "metadata": {}},
    })
    monkeypatch.setattr(backend_app, "pane_activity", lambda _p: {
        "event_type": "turn_complete", "text": "SECRET-CODE", "ts_monotonic": 0.0,
    })

    assert "text" not in plan_mcp._activity_summary("login")
    assert plan_mcp._activity_summary("work")["text"] == "SECRET-CODE"

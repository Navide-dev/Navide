"""Which account each pane runs on: cli_get_status' `account` and cli_accounts_list's `panes`.

Plan mcp-pane-cli-usage_213031 P2. Both are additions: every key the tools
answered before keeps its value, and nothing reads a credential, asks a window
to switch anything, or touches the vault. The facts are existing backend state
only: the terminal's account-dir metadata (set by the spawn), the pane's
bookkeeping pin and the account store's active row.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging
from agent_team_backend import app as backend_app
from agent_team_backend.mcp_server import pane_accounts
from agent_team_backend.mcp_server import server as plan_mcp
from agent_team_backend.mcp_server import wiring as plan_mcp_wiring
from agent_team_backend.ws_handlers import ACCOUNT_DIR_METADATA_KEY


def _ctx(pane_id: str = "pa") -> Any:
    params = {"pane": pane_id, "t": plan_mcp_wiring.caller_token(pane_id)}
    return SimpleNamespace(request_context=SimpleNamespace(request=SimpleNamespace(query_params=params)))


class _Untouchable:
    """Fails the test the moment anything reads it."""

    def __getattr__(self, name: str) -> Any:
        raise AssertionError(f"touched credential_vault.{name}")


class _FakeProfilesStore:
    def __init__(self) -> None:
        self.calls = 0

    def list(self) -> dict[str, Any]:
        self.calls += 1
        return {
            "profiles": [
                {"id": "a13", "agentKey": "claude", "name": "Account 13", "createdAt": "2026-10-01T00:00:00Z"},
                {"id": "a14", "agentKey": "claude", "name": "Account 14", "createdAt": "2026-10-02T00:00:00Z"},
                {"id": "c1", "agentKey": "codex", "name": "Account 2", "createdAt": "2026-10-03T00:00:00Z"},
            ],
            "defaults": {"claude": "a13", "codex": None},
            "defaultNames": {},
            "paneDefaults": {},
        }


class _FakeHistory:
    def __init__(self, pins: dict[str, str]) -> None:
        self._pins = pins

    def current_profile(self, pane_id: str) -> str:
        return self._pins.get(pane_id, "unknown")


def _owner(**terms: SimpleNamespace) -> SimpleNamespace:
    return SimpleNamespace(terminals=dict(terms))


@pytest.fixture(autouse=True)
def world(monkeypatch: pytest.MonkeyPatch) -> _FakeProfilesStore:
    agent_messaging._reset_for_test()
    store = _FakeProfilesStore()
    monkeypatch.setattr(backend_app, "cli_profiles_store", store, raising=False)
    monkeypatch.setattr(backend_app, "credential_vault", _Untouchable(), raising=False)
    # "pf" follows the live login but is still filed under a14 from before a
    # switch; "pd" runs in a14's own folder; "pc" is codex; "pt" a plain terminal.
    monkeypatch.setattr(backend_app, "pane_account_history",
                        _FakeHistory({"pf": "a14", "pd": "a14", "pc": "c1"}), raising=False)
    live_term = SimpleNamespace(pane_id="pf", closed=False, metadata={"profile_id": "a14"})
    dir_term = SimpleNamespace(pane_id="pd", closed=False, metadata={ACCOUNT_DIR_METADATA_KEY: "a14"})
    closed_dir_term = SimpleNamespace(pane_id="pc", closed=True, metadata={ACCOUNT_DIR_METADATA_KEY: "a14"})
    owner = _owner(t1=live_term, t2=dir_term, t3=closed_dir_term)
    monkeypatch.setattr(backend_app, "_PTY_OWNERS", {"t1": owner, "t2": owner, "t3": owner})
    agent_messaging.register("pa", "caller", "/ws/alpha", agent_key="claude")
    agent_messaging.register("pf", "follower", "/ws/alpha", agent_key="claude")
    agent_messaging.register("pd", "fixed", "/ws/alpha", agent_key="claude")
    agent_messaging.register("pc", "coder", "/ws/alpha", agent_key="codex")
    agent_messaging.register("pt", "shell", "/ws/alpha", agent_key="terminal")
    yield store
    agent_messaging._reset_for_test()


def test_a_pane_on_the_live_login_runs_on_the_active_account_whatever_its_pin_says(
    world: _FakeProfilesStore,
) -> None:
    assert pane_accounts.pane_status_account("pf", "claude") == {
        "profile_id": "a13", "runs_on": "live", "live_profile_id": "a13", "pin": "a14",
    }


def test_a_pane_in_an_account_folder_runs_on_that_account(world: _FakeProfilesStore) -> None:
    assert pane_accounts.pane_status_account("pd", "claude") == {
        "profile_id": "a14", "runs_on": "account-dir", "live_profile_id": "a13", "pin": "a14",
    }


def test_a_closed_terminal_and_no_active_account_fall_back_to_the_default(world: _FakeProfilesStore) -> None:
    assert pane_accounts.pane_status_account("pc", "codex") == {
        "profile_id": "__default__", "runs_on": "live", "live_profile_id": "__default__", "pin": "c1",
    }


def test_a_vendor_without_accounts_has_no_account(world: _FakeProfilesStore) -> None:
    assert pane_accounts.pane_status_account("pt", "terminal") is None
    assert world.calls == 0


@pytest.mark.asyncio
async def test_get_status_adds_account_and_keeps_every_other_key(
    world: _FakeProfilesStore, monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def _no_window(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        return {"ok": False, "result": None, "error": "no window"}

    monkeypatch.setattr(plan_mcp, "_ui_request", _no_window)
    result = await plan_mcp.cli_get_status("fixed", _ctx())

    assert result["account"] == {
        "profile_id": "a14", "runs_on": "account-dir", "live_profile_id": "a13", "pin": "a14",
    }
    assert {"ok", "name", "agent_key", "busy"} <= set(result)
    assert (result["ok"], result["name"], result["agent_key"]) == (True, "fixed", "claude")

    shell = await plan_mcp.cli_get_status("shell", _ctx())
    assert "account" not in shell


@pytest.mark.asyncio
async def test_accounts_list_adds_panes_and_reads_the_store_once(world: _FakeProfilesStore) -> None:
    result = await plan_mcp.cli_accounts_list(_ctx())

    assert result["active"] == {"claude": "a13", "codex": "__default__"}
    assert sorted(result["panes"], key=lambda row: row["address"]) == [
        {"paneId": "pa", "name": "caller", "address": "alpha/caller", "agentKey": "claude",
         "profileId": "a13", "runsOn": "live"},
        {"paneId": "pc", "name": "coder", "address": "alpha/coder", "agentKey": "codex",
         "profileId": "__default__", "runsOn": "live"},
        {"paneId": "pd", "name": "fixed", "address": "alpha/fixed", "agentKey": "claude",
         "profileId": "a14", "runsOn": "account-dir"},
        {"paneId": "pf", "name": "follower", "address": "alpha/follower", "agentKey": "claude",
         "profileId": "a13", "runsOn": "live"},
    ]
    assert world.calls == 1

    narrowed = await plan_mcp.cli_accounts_list(_ctx(), agent="codex")
    assert [row["paneId"] for row in narrowed["panes"]] == ["pc"]

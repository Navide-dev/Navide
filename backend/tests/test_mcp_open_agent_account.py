"""cli_open_agent's `account`: which account the new pane runs on.

Plan mcp-pane-cli-usage_213031 P3. The default is the caller's own account,
and it reuses the one per-pane mechanism that exists: an explicit pin in the
spawn request, which for claude runs the pane in that account's own folder.
Pinned here:

  - a caller on the live login, a caller with no pane, a caller of another
    vendor and account "active" all send exactly main's spawn request and get
    main's answer back (no `profile_id`, no `account` key);
  - a caller inside an account folder hands that account down;
  - an explicit account is checked before anything is broadcast, each wrong
    one refused with its own error_code;
  - nothing switches the live login: the vault only ever answers whether an
    account signed in inside its own folder.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging, app
from agent_team_backend.mcp_server import auth as plan_mcp_auth
from agent_team_backend.mcp_server import server as plan_mcp
from agent_team_backend.mcp_server import wiring as plan_mcp_wiring
from agent_team_backend.ws_handlers import ACCOUNT_DIR_METADATA_KEY


def _ctx(pane_id: str = "pa") -> Any:
    params = {"pane": pane_id, "t": plan_mcp_wiring.caller_token(pane_id)}
    return SimpleNamespace(request_context=SimpleNamespace(request=SimpleNamespace(query_params=params)))


def _host_ctx() -> Any:
    params = {"client": "host", "t": plan_mcp_auth.internal_token()}
    return SimpleNamespace(request_context=SimpleNamespace(request=SimpleNamespace(query_params=params)))


class _Vault:
    """Answers the folder sign-in presence check; anything else fails the test."""

    def __init__(self, signed_in: set[str]) -> None:
        self.signed_in = signed_in

    def account_dir_signed_in(self, slot_id: str) -> bool:
        return slot_id in self.signed_in

    def __getattr__(self, name: str) -> Any:
        raise AssertionError(f"cli_open_agent touched credential_vault.{name}")


class _Store:
    def __init__(self) -> None:
        self.doc = {
            "profiles": [
                {"id": "a13", "agentKey": "claude", "name": "Account 13"},
                {"id": "a14", "agentKey": "claude", "name": "Account 14"},
                {"id": "a15", "agentKey": "claude", "name": "Account 15"},
                {"id": "c1", "agentKey": "codex", "name": "Codex 2"},
            ],
            "defaults": {"claude": "a13"},
            "defaultNames": {},
            "paneDefaults": {},
        }

    def list(self) -> dict[str, Any]:
        return self.doc

    def get_default_profile(self, agent_key: str) -> dict[str, Any] | None:
        active = self.doc["defaults"].get(agent_key)
        return next((p for p in self.doc["profiles"] if p["id"] == active), None)

    def __getattr__(self, name: str) -> Any:
        raise AssertionError(f"cli_open_agent touched cli_profiles_store.{name}")


class _Terminals:
    """app._PTY_OWNERS stand-in: pane id -> account-dir metadata of its terminal."""

    def __init__(self) -> None:
        self.owner = SimpleNamespace(terminals={})
        self.owners: dict[str, Any] = {}

    def add(self, pane_id: str, account_dir: str = "") -> None:
        tid = f"t-{pane_id}"
        metadata = {ACCOUNT_DIR_METADATA_KEY: account_dir} if account_dir else {}
        self.owner.terminals[tid] = SimpleNamespace(pane_id=pane_id, closed=False, metadata=metadata)
        self.owners[tid] = self.owner


@pytest.fixture
def world(monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    agent_messaging._reset_for_test()
    events: list[dict[str, Any]] = []

    async def fake_broadcast(event: dict[str, Any], **_kwargs: Any) -> None:
        events.append(event)

    async def ready(_path: str) -> bool:
        return True

    terminals = _Terminals()
    vault = _Vault({"a14", "a15"})
    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    monkeypatch.setattr(app, "credential_vault", vault, raising=False)
    monkeypatch.setattr(app, "cli_profiles_store", _Store(), raising=False)
    monkeypatch.setattr(app, "_PTY_OWNERS", terminals.owners)
    monkeypatch.setattr(plan_mcp, "_wait_window_ready", ready)
    agent_messaging.register("pa", "follower", "/ws/alpha", agent_key="claude")
    agent_messaging.register("pd", "fixed", "/ws/alpha", agent_key="claude")
    agent_messaging.register("pc", "coder", "/ws/alpha", agent_key="codex")
    terminals.add("pa")
    terminals.add("pd", "a14")
    terminals.add("pc")
    yield SimpleNamespace(events=events, terminals=terminals, vault=vault)
    agent_messaging._reset_for_test()


async def _open(world: SimpleNamespace, ctx: Any, agent: str = "claude", **kwargs: Any) -> dict[str, Any]:
    """cli_open_agent with a window that opens the pane as asked: the new
    terminal runs in the account folder exactly when the request pinned one."""

    async def answer() -> None:
        for _ in range(400):
            keys = list(plan_mcp._pending_spawns)
            if keys:
                payload = world.events[-1]["payload"]
                world.terminals.add("new-pane", payload.get("profile_id", ""))
                agent_messaging.register("new-pane", "child", "/ws/alpha", agent_key=agent)
                plan_mcp.resolve_spawn(keys[0], {"ok": True, "pane_id": "new-pane", "name": "child"})
                plan_mcp.resolve_kickoff(keys[0], {"pane_id": "new-pane", "kickoff": "sent"})
                return
            await asyncio.sleep(0.005)

    task = asyncio.create_task(answer())
    if "workspace_path" not in kwargs and ctx is not None and "client" in ctx.request_context.request.query_params:
        kwargs["workspace_path"] = "/ws/alpha"
    result = await plan_mcp.cli_open_agent(agent, "child", "do it", ctx, **kwargs)
    await task
    return result


_MAINS_ANSWER = {"ok": True, "name": "child", "address": "alpha/child", "pane_id": "new-pane", "kickoff": "sent"}


@pytest.mark.asyncio
async def test_same_account_a_caller_on_the_live_login_opens_exactly_as_before(world: SimpleNamespace) -> None:
    result = await _open(world, _ctx("pa"))

    assert result == _MAINS_ANSWER
    assert "profile_id" not in world.events[-1]["payload"]


@pytest.mark.asyncio
async def test_different_account_a_caller_in_an_account_folder_hands_it_down(world: SimpleNamespace) -> None:
    result = await _open(world, _ctx("pd"))

    assert world.events[-1]["payload"]["profile_id"] == "a14"
    assert result["account"] == {"mode": "inherit", "profile_id": "a14", "runs_on": "account-dir", "fixed": True}
    assert "advisories" not in result


@pytest.mark.asyncio
async def test_no_parent_a_host_caller_opens_on_the_live_login(world: SimpleNamespace) -> None:
    result = await _open(world, _host_ctx())

    assert result == _MAINS_ANSWER
    assert "profile_id" not in world.events[-1]["payload"]


@pytest.mark.asyncio
async def test_another_vendor_never_inherits_a_claude_folder(world: SimpleNamespace) -> None:
    result = await _open(world, _ctx("pd"), agent="codex")

    assert "profile_id" not in world.events[-1]["payload"]
    assert "account" not in result


@pytest.mark.asyncio
async def test_active_asks_for_the_old_behaviour_from_inside_a_folder(world: SimpleNamespace) -> None:
    result = await _open(world, _ctx("pd"), account="active")

    assert "profile_id" not in world.events[-1]["payload"]
    assert result["account"] == {"mode": "active", "profile_id": "a13", "runs_on": "live", "fixed": False}


@pytest.mark.asyncio
async def test_a_signed_out_parent_folder_falls_back_to_the_live_login_and_says_so(world: SimpleNamespace) -> None:
    world.vault.signed_in.discard("a14")

    result = await _open(world, _ctx("pd"))

    assert "profile_id" not in world.events[-1]["payload"]
    assert any(a.startswith("inherit-account-dir-signed-out") for a in result["advisories"])


@pytest.mark.asyncio
async def test_explicit_account_opens_the_pane_in_that_folder(world: SimpleNamespace) -> None:
    result = await _open(world, _ctx("pa"), account="a15")

    assert world.events[-1]["payload"]["profile_id"] == "a15"
    assert result["account"] == {"mode": "a15", "profile_id": "a15", "runs_on": "account-dir", "fixed": True}


@pytest.mark.asyncio
async def test_explicit_live_account_is_the_same_as_active(world: SimpleNamespace) -> None:
    result = await _open(world, _ctx("pd"), account="a13")

    assert "profile_id" not in world.events[-1]["payload"]
    assert result["account"] == {"mode": "a13", "profile_id": "a13", "runs_on": "live", "fixed": False}


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("agent", "account", "error_code"),
    [
        ("claude", "nope", "unknown-profile"),
        ("claude", "c1", "vendor-mismatch"),
        ("codex", "a14", "vendor-mismatch"),
        ("codex", "c1", "unsupported"),
        ("claude", "__default__", "unsupported"),
        ("claude", "a16", "unknown-profile"),
    ],
)
async def test_invalid_account_is_refused_before_anything_opens(
    world: SimpleNamespace, agent: str, account: str, error_code: str,
) -> None:
    result = await plan_mcp.cli_open_agent(agent, "child", "do it", _ctx("pa"), account=account)

    assert result["ok"] is False
    assert result["error_code"] == error_code
    assert world.events == []
    assert plan_mcp._pending_spawns == {}


@pytest.mark.asyncio
async def test_an_account_not_signed_in_inside_its_folder_needs_the_user(world: SimpleNamespace) -> None:
    world.vault.signed_in.discard("a15")

    result = await plan_mcp.cli_open_agent("claude", "child", "do it", _ctx("pa"), account="a15")

    assert result["ok"] is False
    assert result["error_code"] == "needs-user"
    assert "cli_account_sign_in" in result["error"]
    assert world.events == []

"""The user's Disabled switch for the built-in Navide plugin Plans.

The Electron Host reports the switch on its ``host.register`` (only while a
built-in is disabled). While Plans is disabled its plan_* tools are hidden
from tools/list, a CLI that cached the list is refused with the agent-tools
contract's PLUGIN_TOOL_UNAVAILABLE, nothing serves the call locally, and no
plan assets are provisioned. With nothing disabled every one of these is
exactly main's behaviour.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
import pytest_asyncio

from agent_team_backend import app
from agent_team_backend.fs_service import FsError
from agent_team_backend.mcp_server import server as plan_mcp
from agent_team_backend.plugins import wiring
from agent_team_backend.plugins.activation_catalog import (
    ACTIVATION_CATALOG_DIGEST_ENV,
    ACTIVATION_CATALOG_PATH_ENV,
)
from agent_team_backend.plugins.builtin.navide_plans import plan_tools
from agent_team_backend.plugins.host import PluginHost

PLAN_TOOL_NAMES = [tool.__name__ for tool in plan_tools.PLAN_TOOLS]


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


@pytest_asyncio.fixture
async def host_session(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(app, "_HOST_SESSION_TOKEN", "host-secret")
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    app._SESSIONS.add(session)  # noqa: SLF001
    yield session
    app._SESSIONS.discard(session)  # noqa: SLF001


async def _register(session: app.Session, features: dict[str, Any]) -> dict[str, Any]:
    await app.handle_message(session, {
        "id": "host", "type": "host.register", "payload": {"token": "host-secret", "features": features},
    })
    return session.websocket.sent[-1]  # type: ignore[attr-defined]


@pytest.fixture
def plan_tools_installed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(ACTIVATION_CATALOG_PATH_ENV, raising=False)
    monkeypatch.delenv(ACTIVATION_CATALOG_DIGEST_ENV, raising=False)
    plugin_host = PluginHost()
    wiring.startup(plugin_host)
    wiring.apply_mcp_tools(plugin_host, plan_mcp.server)
    yield
    wiring.shutdown(plugin_host)


async def test_host_register_carries_the_disabled_built_ins(host_session) -> None:
    reply = await _register(host_session, {"plans_backend_v2": True, "disabled_plugins": ["navide.plans"]})
    assert reply["payload"] == {"registered": True}
    assert app.host_disabled_plugins() == frozenset({"navide.plans"})
    assert app.plans_plugin_disabled() is True

    # Re-registering without the key (nothing disabled any more) clears it.
    await _register(host_session, {"plans_backend_v2": True})
    assert app.host_disabled_plugins() == frozenset()
    assert app.plans_plugin_disabled() is False


@pytest.mark.parametrize("value", [["acme.demo"], "navide.plans", [1], ["navide.plans"] * 4])
async def test_host_register_refuses_anything_but_built_in_ids(host_session, value) -> None:
    reply = await _register(host_session, {"plans_backend_v2": False, "disabled_plugins": value})
    assert reply["error"]["code"] == "UNAUTHORIZED"
    assert host_session.host_authenticated is False
    assert app.host_disabled_plugins() == frozenset()


async def test_no_host_means_nothing_is_disabled() -> None:
    assert app.host_disabled_plugins() == frozenset()


async def test_tools_list_is_unchanged_while_nothing_is_disabled(plan_tools_installed) -> None:
    fastmcp_list = await plan_mcp.server.list_tools()
    visible = await plan_mcp.list_visible_tools()
    assert [tool.model_dump() for tool in visible] == [tool.model_dump() for tool in fastmcp_list]
    names = [tool.name for tool in visible]
    for name in PLAN_TOOL_NAMES:
        assert names.count(name) == 1


async def test_tools_list_hides_only_the_plan_tools_while_plans_is_disabled(
    plan_tools_installed, monkeypatch: pytest.MonkeyPatch,
) -> None:
    every = [tool.name for tool in await plan_mcp.server.list_tools()]
    monkeypatch.setattr(app, "host_disabled_plugins", lambda: frozenset({"navide.plans"}))
    visible = [tool.name for tool in await plan_mcp.list_visible_tools()]
    assert not set(PLAN_TOOL_NAMES) & set(visible)
    assert visible == [name for name in every if name not in PLAN_TOOL_NAMES]
    # The low-level handler the HTTP endpoint serves is the filtered one.
    import mcp.types as types

    result = await plan_mcp.server._mcp_server.request_handlers[types.ListToolsRequest](  # noqa: SLF001
        types.ListToolsRequest(method="tools/list")
    )
    assert [tool.name for tool in result.root.tools] == visible


async def test_a_cached_plan_call_is_refused_and_never_served_locally(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(app, "host_disabled_plugins", lambda: frozenset({"navide.plans"}))

    async def no_host(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("a disabled Plans call must not reach the Host route")

    monkeypatch.setattr(plan_mcp, "request_host_agent_workspace_backend", no_host)
    caller = plan_mcp._Caller(kind="external")  # noqa: SLF001
    with pytest.raises(FsError) as refused:
        await plan_tools._host_agent_plan_call(  # noqa: SLF001
            caller, str(tmp_path), "plans.create", {"name": "x"},
        )
    assert refused.value.code == "PLUGIN_TOOL_UNAVAILABLE"
    assert "plugin-disabled" in str(refused.value)
    assert "Settings → Extensions" in str(refused.value)
    assert not (tmp_path / ".agent-team").exists()


async def test_the_hosts_disabled_refusal_is_not_a_fallback_verdict(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Even when this process has not heard of the switch yet, the Host's
    refusal (no recovery disposition) is raised, not served from disk."""

    async def host_refuses(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        return {
            "reqId": "r", "ok": False, "reason": "plugin-disabled",
            "error": {
                "code": "PLUGIN_TOOL_UNAVAILABLE",
                "message": "Navide plugin Plans is disabled. Enable it in Settings → Extensions.",
            },
        }

    monkeypatch.setattr(plan_mcp, "request_host_agent_workspace_backend", host_refuses)
    caller = plan_mcp._Caller(kind="external")  # noqa: SLF001
    with pytest.raises(FsError) as refused:
        await plan_tools._host_agent_plan_call(caller, str(tmp_path), "plans.list", {})  # noqa: SLF001
    assert refused.value.code == "PLUGIN_TOOL_UNAVAILABLE"
    assert not (tmp_path / ".agent-team").exists()


def test_no_plan_assets_are_provisioned_while_plans_is_disabled(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    provisioned: list[str] = []
    monkeypatch.setattr(app, "ensure_plan_assets", provisioned.append)
    monkeypatch.setattr(app.attribution, "register_workspace", lambda _ws: None)
    monkeypatch.setattr(app.attribution, "known_workspaces", lambda: {str(tmp_path)})
    monkeypatch.setattr(app, "_git_watcher", None)

    monkeypatch.setattr(app, "host_disabled_plugins", lambda: frozenset({"navide.plans"}))
    app._register_workspace_and_backfill(str(tmp_path))  # noqa: SLF001
    assert provisioned == []

    monkeypatch.setattr(app, "host_disabled_plugins", lambda: frozenset())
    app._register_workspace_and_backfill(str(tmp_path))  # noqa: SLF001
    assert provisioned == [str(tmp_path)]

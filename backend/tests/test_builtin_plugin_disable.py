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


@pytest.fixture(autouse=True)
def no_host_report(monkeypatch: pytest.MonkeyPatch) -> None:
    # Every test starts as a fresh backend: no Host has registered yet and no
    # disabled built-ins were passed at spawn.
    monkeypatch.setattr(app, "_host_reported_disabled", None)
    monkeypatch.delenv(app.DISABLED_BUILTIN_PLUGINS_ENV, raising=False)


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


@pytest.mark.parametrize("value", [["acme.demo"], ["navide.browser"], "navide.plans", [1], ["navide.plans"] * 4])
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


async def test_before_any_host_the_spawn_env_says_what_is_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(app.DISABLED_BUILTIN_PLUGINS_ENV, "navide.plans,acme.not-builtin,")
    assert app.host_disabled_plugins() == frozenset({"navide.plans"})
    assert app.plans_plugin_disabled() is True


async def test_a_registered_host_wins_and_its_answer_survives_a_reconnect(
    host_session, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(app.DISABLED_BUILTIN_PLUGINS_ENV, "navide.plans")
    await _register(host_session, {"plans_backend_v2": True})
    assert app.plans_plugin_disabled() is False
    await _register(host_session, {"plans_backend_v2": True, "disabled_plugins": ["navide.git"]})
    host_session.dead = True  # the Host went away; it has not registered again yet
    assert app.host_disabled_plugins() == frozenset({"navide.git"})


def test_no_plan_assets_before_the_host_registers_when_spawned_disabled(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    provisioned: list[str] = []
    monkeypatch.setattr(app, "ensure_plan_assets", provisioned.append)
    monkeypatch.setattr(app.attribution, "register_workspace", lambda _ws: None)
    monkeypatch.setattr(app.attribution, "known_workspaces", lambda: {str(tmp_path)})
    monkeypatch.setattr(app, "_git_watcher", None)
    monkeypatch.setenv(app.DISABLED_BUILTIN_PLUGINS_ENV, "navide.plans")
    app._register_workspace_and_backfill(str(tmp_path))  # noqa: SLF001
    assert provisioned == []


def test_host_register_and_app_agree_on_the_built_in_ids() -> None:
    from agent_team_backend import ws_handlers

    assert ws_handlers._DISABLEABLE_BUILTIN_PLUGINS == app.DISABLEABLE_BUILTIN_PLUGINS  # noqa: SLF001


def _plan_file(root: Path) -> Path:
    plans = root / ".agent-team" / "plans"
    plans.mkdir(parents=True, exist_ok=True)
    path = plans / "x_abc123.html"
    path.write_text("<html><head><title>x</title></head><body>plan</body></html>", encoding="utf-8")
    return path


def test_no_plan_document_is_published_while_plans_is_disabled(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from agent_team_backend import share_links

    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(tmp_path / "data"))
    path = _plan_file(tmp_path / "ws")
    assert share_links.prepare(str(path), "plan").kind == "plan"
    monkeypatch.setattr(app, "host_disabled_plugins", lambda: frozenset({"navide.plans"}))
    with pytest.raises(share_links.ShareRefused) as refused:
        share_links.prepare(str(path), "plan")
    assert refused.value.code == "plugin-disabled"


async def test_share_create_answers_the_contract_refusal(monkeypatch: pytest.MonkeyPatch) -> None:
    from agent_team_backend import share_links

    monkeypatch.setattr(plan_mcp, "_share_cloud_ready", lambda: True)

    async def refused(_client: Any) -> dict:
        raise share_links.ShareRefused(share_links.PLANS_DISABLED_CODE, share_links.PLANS_DISABLED_MESSAGE)

    assert await plan_mcp._share_run(refused) == {  # noqa: SLF001
        "ok": False,
        "error": share_links.PLANS_DISABLED_MESSAGE,
        "code": "PLUGIN_TOOL_UNAVAILABLE",
        "reason": "plugin-disabled",
    }


@pytest.mark.parametrize("msg_type", ["plans.list_docs", "plans.cache_put"])
async def test_the_plans_ws_handlers_refuse_while_plans_is_disabled(
    host_session, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, msg_type: str,
) -> None:
    monkeypatch.setattr(app, "host_disabled_plugins", lambda: frozenset({"navide.plans"}))
    await app.handle_message(host_session, {
        "id": "p", "type": msg_type, "payload": {"workspace_path": str(tmp_path), "entries": []},
    })
    reply = host_session.websocket.sent[-1]  # type: ignore[attr-defined]
    assert reply["error"]["code"] == "PLUGIN_TOOL_UNAVAILABLE"


@pytest.mark.parametrize("disabled", [True, False])
async def test_plan_history_snapshots_only_while_plans_is_enabled(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, disabled: bool,
) -> None:
    snapshots: list[str] = []
    events: list[dict[str, Any]] = []

    async def broadcast(event: dict[str, Any]) -> None:
        events.append(event)

    monkeypatch.setattr(app.plan_history, "snapshot_plans", snapshots.append)
    monkeypatch.setattr(app, "broadcast", broadcast)
    monkeypatch.setattr(app, "host_disabled_plugins", lambda: frozenset({"navide.plans"}) if disabled else frozenset())
    await app._broadcast_plans_changed(str(tmp_path))  # noqa: SLF001
    assert snapshots == ([] if disabled else [str(tmp_path)])
    # The change itself is still announced either way.
    assert events and events[-1]["type"] == "plans.changed"

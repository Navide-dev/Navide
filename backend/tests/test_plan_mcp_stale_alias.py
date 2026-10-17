"""A CLI keeps the pane id its /plan-mcp URL was built with, forever.

The URL is written once, when the pane spawns. Rebuilding the pane around the
same running CLI — a window reload, a detach, a run group coming back from a
detached window — mints a new pane id and leaves that URL pointing at the old
one, which used to fail every tool on the endpoint (plan_create included, since
a pane's own workspace is what those default to).

The window now tells the backend where the old id went, so these tests are about
one thing: the caller is resolved to the pane its process is attached to, and
every check downstream is made against that pane's current identity.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging, app
from agent_team_backend.mcp_server import server as plan_mcp, wiring as plan_mcp_wiring


@pytest.fixture(autouse=True)
def _clean_registry() -> Any:
    agent_messaging._reset_for_test()
    plan_mcp._mcp_message_status.clear()
    plan_mcp._status_waiters.clear()
    yield
    agent_messaging._reset_for_test()
    plan_mcp._mcp_message_status.clear()
    plan_mcp._status_waiters.clear()


def _ctx(pane_id: str) -> Any:
    params = {"pane": pane_id, "t": plan_mcp_wiring.caller_token(pane_id)}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


@pytest.fixture
def captured(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []

    async def fake_broadcast(event: dict[str, Any], **_kwargs: Any) -> None:
        events.append(event)

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    return events


def _reloaded_pane() -> None:
    """A pane that came back under a new id, plus a neighbour to address."""
    agent_messaging.register("pa2", "sender", "/ws/alpha", agent_key="claude")
    agent_messaging.add_aliases("pa2", ["pa"], "/ws/alpha")
    agent_messaging.register("pc", "helper", "/ws/alpha", agent_key="claude")


def test_the_caller_is_resolved_to_the_pane_its_process_is_attached_to() -> None:
    _reloaded_pane()
    caller = plan_mcp._resolve_caller(_ctx("pa"))
    assert caller.kind == "pane"
    assert caller.pane_id == "pa2"


def test_an_id_that_names_nothing_at_all_is_still_refused() -> None:
    _reloaded_pane()
    with pytest.raises(plan_mcp.CallerUnknown) as err:
        plan_mcp._resolve_caller(_ctx("never-existed"))
    assert "stale" in str(err.value)


def test_plan_tools_default_to_the_current_panes_workspace() -> None:
    """The whole endpoint went down with the pane id, plan_create included: it
    resolves the plan root from the calling pane's own workspace."""
    _reloaded_pane()
    caller = plan_mcp._resolve_caller(_ctx("pa"))
    assert plan_mcp._caller_workspace(caller) == "/ws/alpha"


@pytest.mark.asyncio
async def test_list_targets_answers_with_the_panes_current_identity() -> None:
    _reloaded_pane()
    result = await plan_mcp.cli_list_targets(_ctx("pa"))
    assert result["you"] == "alpha/sender"
    assert [t["name"] for t in result["targets"]] == ["helper"]


@pytest.mark.asyncio
async def test_a_bare_name_still_resolves_inside_the_callers_own_workspace(
    captured: list[dict[str, Any]],
) -> None:
    """The failure this replaces: with no sender to resolve against, every
    same-workspace name came back as "unknown target"."""
    _reloaded_pane()
    result = await plan_mcp.cli_send("helper", "run the tests", _ctx("pa"))
    assert result["ok"] is True
    assert result["cross_workspace"] is False
    assert captured[0]["payload"]["target_pane_id"] == "pc"
    assert captured[0]["payload"]["from_pane_id"] == "pa2"


@pytest.mark.asyncio
async def test_self_send_is_judged_against_the_current_identity(
    captured: list[dict[str, Any]],
) -> None:
    """Without this the pane fails its own self-send check and can message
    itself in a loop."""
    _reloaded_pane()
    result = await plan_mcp.cli_send("sender", "hello me", _ctx("pa"))
    assert result["ok"] is False
    assert "your own pane" in result["error"]
    assert captured == []

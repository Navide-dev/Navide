"""cli_place_pane — moving a pane between tab groups and re-parenting it.

The write half of the lineage that cli_list_targets and cli_list_sessions
report. The tool itself does no writing: the window that owns the pane does,
through ui.pane.place, along the same paths the sidebar's drag uses — so the
record and the screen agree. What is pinned here is the tool's own contract:
which window is asked, what it is asked, and that "" survives as a value.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging
from agent_team_backend.mcp_server import server as plan_mcp, wiring as plan_mcp_wiring


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


def _seed() -> None:
    agent_messaging.register("pa", "caller", "/ws/alpha")
    agent_messaging.register("pw", "worker", "/ws/alpha", agent_key="codex")
    agent_messaging.register("pp", "parent", "/ws/alpha", agent_key="claude")


def _fake_ui(monkeypatch: pytest.MonkeyPatch, reply: dict[str, Any]) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []

    async def fake(workspace_path: str, op: str, **kwargs: Any) -> dict[str, Any]:
        calls.append({"workspace_path": workspace_path, "op": op, **kwargs})
        return reply

    monkeypatch.setattr(plan_mcp, "_ui_request", fake)
    return calls


_OK = {"ok": True, "result": {"applied": {"spawnedBy": "pp"}, "runGroupId": "rg-1", "spawnedBy": "pp"}}


@pytest.mark.asyncio
async def test_place_asks_the_window_holding_the_target(monkeypatch: pytest.MonkeyPatch) -> None:
    """The move is about another pane, so the window that has THAT pane is
    asked, as its own caller — never the requesting pane's window."""
    _seed()
    calls = _fake_ui(monkeypatch, _OK)

    result = await plan_mcp.cli_place_pane("worker", _ctx(), spawned_by="pp")

    assert result["ok"] is True
    assert len(calls) == 1
    assert calls[0]["workspace_path"] == "/ws/alpha"
    assert calls[0]["action"] == "ui.pane.place"
    assert calls[0]["caller"].pane_id == "pw"
    assert calls[0]["args"] == {"paneId": "pw", "spawnedBy": "pp"}


@pytest.mark.asyncio
async def test_a_half_not_passed_is_not_sent(monkeypatch: pytest.MonkeyPatch) -> None:
    """None means "leave it alone"; the window must not see a key it would
    read as "set to empty"."""
    _seed()
    calls = _fake_ui(monkeypatch, _OK)

    await plan_mcp.cli_place_pane("worker", _ctx(), run_group_id="rg-2")

    assert calls[0]["args"] == {"paneId": "pw", "runGroupId": "rg-2"}
    assert "spawnedBy" not in calls[0]["args"]


@pytest.mark.asyncio
async def test_empty_string_is_sent_as_a_value(monkeypatch: pytest.MonkeyPatch) -> None:
    """'' is the root (for spawned_by) and the ungrouped tab (for run_group_id)
    — real destinations, distinct from "not passed"."""
    _seed()
    calls = _fake_ui(monkeypatch, _OK)

    await plan_mcp.cli_place_pane("worker", _ctx(), spawned_by="", run_group_id="")

    assert calls[0]["args"] == {"paneId": "pw", "spawnedBy": "", "runGroupId": ""}


@pytest.mark.asyncio
async def test_nothing_to_change_is_refused_without_asking_any_window(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed()
    calls = _fake_ui(monkeypatch, _OK)

    result = await plan_mcp.cli_place_pane("worker", _ctx())

    assert result["ok"] is False
    assert result["error_code"] == "nothing-to-change"
    assert calls == []


@pytest.mark.asyncio
async def test_a_stale_parent_id_is_resolved_through_the_alias_table(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Pane ids change across rebuilds. A caller holding the parent's old id
    should still land on the parent, not on nothing."""
    _seed()
    agent_messaging.add_aliases("pp", ["pp-old"], "/ws/alpha")
    calls = _fake_ui(monkeypatch, _OK)

    await plan_mcp.cli_place_pane("worker", _ctx(), spawned_by="pp-old")

    assert calls[0]["args"]["spawnedBy"] == "pp"


@pytest.mark.asyncio
async def test_the_window_s_refusal_comes_back_as_the_reason(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A cycle or an unknown group is decided by the window; the caller must
    read why, not just `ok: false`."""
    _seed()
    _fake_ui(monkeypatch, {"ok": False, "error": "that parent is the pane itself or one of its descendants", "error_code": "ui_action_failed"})

    result = await plan_mcp.cli_place_pane("worker", _ctx(), spawned_by="pw")

    assert result["ok"] is False
    assert "descendants" in result["error"]


@pytest.mark.asyncio
async def test_the_answer_reports_the_position_afterwards(monkeypatch: pytest.MonkeyPatch) -> None:
    _seed()
    _fake_ui(monkeypatch, _OK)

    result = await plan_mcp.cli_place_pane("worker", _ctx(), spawned_by="pp")

    assert result == {
        "ok": True,
        "target": "alpha/worker",
        "name": "worker",
        "pane_id": "pw",
        "applied": {"spawnedBy": "pp"},
        "run_group_id": "rg-1",
        "spawned_by": "pp",
    }


@pytest.mark.asyncio
async def test_by_pane_id_addresses_one_exact_pane(monkeypatch: pytest.MonkeyPatch) -> None:
    _seed()
    calls = _fake_ui(monkeypatch, _OK)

    result = await plan_mcp.cli_place_pane("", _ctx(), pane_id="pw", run_group_id="rg-9")

    assert result["ok"] is True
    assert calls[0]["args"]["paneId"] == "pw"


@pytest.mark.asyncio
async def test_a_remote_address_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    """Another machine's tree is that machine's to arrange."""
    _seed()
    calls = _fake_ui(monkeypatch, _OK)

    result = await plan_mcp.cli_place_pane(
        "11111111-2222-3333-4444-555555555555/alpha/worker", _ctx(), spawned_by=""
    )

    assert result["ok"] is False
    assert calls == []

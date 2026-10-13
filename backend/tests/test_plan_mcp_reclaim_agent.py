"""cli_reclaim_agent: ui.pane.reclaim with cli_close_agent's addressing.

Reclaiming was reachable only through ui_invoke, by pane id, and only in the
caller's own window. This tool resolves a target exactly as cli_close_agent
does and asks the window holding that pane. What these pin is what it must not
become: a reclaim reported as done when the window refused it, a refusal whose
reason is buried in a batch-shaped answer, and an older window's "unknown
command" passed through as if the caller had made a mistake.
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
    params = {"pane": pane_id, "t": plan_mcp_wiring.caller_token()}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


def _seed() -> None:
    agent_messaging.register("pa", "caller", "/ws/alpha")
    agent_messaging.register("pw", "worker", "/ws/beta", agent_key="codex")


def _fake_ui(monkeypatch: pytest.MonkeyPatch, reply: dict[str, Any]) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []

    async def fake(workspace_path: str, op: str, **kwargs: Any) -> dict[str, Any]:
        calls.append({"workspace_path": workspace_path, "op": op, **kwargs})
        return reply

    monkeypatch.setattr(plan_mcp, "_ui_request", fake)
    return calls


@pytest.mark.asyncio
async def test_reclaim_asks_the_window_holding_the_target_pane(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Routed like cli_close_agent: to the window that has the pane, even in
    another workspace — not to the caller's own window, where the id would
    come back as not-found."""
    _seed()
    calls = _fake_ui(monkeypatch, {"ok": True, "result": {"reclaimed": ["pw"], "refused": []}})

    result = await plan_mcp.cli_reclaim_agent("beta/worker", _ctx())

    assert result == {"ok": True, "target": "beta/worker", "name": "worker", "reclaimed": True}
    assert len(calls) == 1
    assert calls[0]["workspace_path"] == "/ws/beta"
    assert calls[0]["op"] == "invoke"
    assert calls[0]["action"] == "ui.pane.reclaim"
    assert calls[0]["args"] == {"paneId": "pw"}
    assert calls[0]["caller"].pane_id == "pw"


@pytest.mark.asyncio
async def test_a_refusal_is_flattened_into_the_answer(monkeypatch: pytest.MonkeyPatch) -> None:
    """The window answers ok with a refused list; for one target that is a
    reclaim that did not happen, and the caller needs the reason up front."""
    _seed()
    _fake_ui(
        monkeypatch,
        {
            "ok": True,
            "result": {
                "reclaimed": [],
                "refused": [
                    {"paneId": "pw", "reason": "focused", "detail": "the user has it focused"}
                ],
            },
        },
    )

    result = await plan_mcp.cli_reclaim_agent("", _ctx(), pane_id="pw")

    assert result["ok"] is False
    assert result["reclaimed"] is False
    assert result["reason"] == "focused"
    assert result["error"] == "the user has it focused"
    assert result["error_code"] == "reclaim-refused"
    assert result["target"] == "beta/worker"


@pytest.mark.asyncio
async def test_an_older_window_says_reclaim_is_unsupported(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A window before v0.2.16 has no ui.pane.reclaim. Its "unknown command"
    reads like a typo; the caller must learn it is the app's version, and must
    not be sent to cli_close_agent as a stand-in, which ends the session."""
    _seed()
    _fake_ui(
        monkeypatch,
        {"ok": False, "result": None, "error": "unknown command: ui.pane.reclaim"},
    )

    result = await plan_mcp.cli_reclaim_agent("beta/worker", _ctx())

    assert result["ok"] is False
    assert result["error_code"] == "reclaim-unsupported"
    assert "v0.2.16" in result["error"]
    assert "reclaimed" not in result


@pytest.mark.asyncio
async def test_a_window_that_does_not_answer_is_not_reported_as_reclaimed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed()
    _fake_ui(
        monkeypatch,
        {"ok": False, "result": None, "error": "timed out", "error_code": "ui_action_timeout"},
    )

    result = await plan_mcp.cli_reclaim_agent("beta/worker", _ctx())

    assert result["ok"] is False
    assert result["error_code"] == "ui_action_timeout"
    assert "reclaimed" not in result


@pytest.mark.asyncio
async def test_a_pane_cannot_reclaim_itself(monkeypatch: pytest.MonkeyPatch) -> None:
    _seed()
    calls = _fake_ui(monkeypatch, {"ok": True, "result": {"reclaimed": ["pa"], "refused": []}})

    result = await plan_mcp.cli_reclaim_agent("caller", _ctx())

    assert result["ok"] is False
    assert result["error_code"] == "self-reclaim"
    assert calls == []


_DEVICE_UUID = "3f2a1b4c-5d6e-7f80-9a1b-2c3d4e5f6071"


@pytest.mark.asyncio
async def test_a_pane_on_another_device_is_local_only(monkeypatch: pytest.MonkeyPatch) -> None:
    _seed()
    calls = _fake_ui(monkeypatch, {"ok": True, "result": {"reclaimed": [], "refused": []}})

    result = await plan_mcp.cli_reclaim_agent(f"{_DEVICE_UUID}/beta/worker", _ctx())

    assert result["ok"] is False
    assert result["error_code"] == "reclaim-local-only"
    assert calls == []


@pytest.mark.asyncio
async def test_an_unknown_target_never_reaches_a_window(monkeypatch: pytest.MonkeyPatch) -> None:
    _seed()
    calls = _fake_ui(monkeypatch, {"ok": True, "result": {"reclaimed": [], "refused": []}})

    by_id = await plan_mcp.cli_reclaim_agent("", _ctx(), pane_id="nope")
    by_name = await plan_mcp.cli_reclaim_agent("nobody", _ctx())

    assert by_id["error_code"] == "unknown-pane-id"
    assert by_name["ok"] is False
    assert calls == []


@pytest.mark.asyncio
async def test_reclaim_is_registered_with_the_same_arguments_as_close() -> None:
    tools = {tool.name: tool for tool in await plan_mcp.server.list_tools()}
    assert set(tools["cli_reclaim_agent"].inputSchema.get("properties") or {}) == {
        "target",
        "pane_id",
    }
    text = tools["cli_reclaim_agent"].description or ""
    assert "click-to-resume" in text
    assert "reclaim-unsupported" in text
    assert "cli_close_agent" in text

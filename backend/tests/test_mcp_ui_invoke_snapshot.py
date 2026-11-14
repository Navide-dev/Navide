"""ui_invoke snapshot=true: the action's answer, with ui_snapshot's beside it
(plan agent-desktop_f10dcb). The snapshot never turns the action into a failure.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging
from agent_team_backend.mcp_server import auth as plan_mcp_auth
from agent_team_backend.mcp_server import server as plan_mcp

ACTION_OK = {"ok": True, "result": {"done": True}, "error": None}
SNAPSHOT = {"workspace": "/w", "panes": [], "activeTab": "", "settingsOpen": False, "openWorkspaces": []}


@pytest.fixture(autouse=True)
def _clean_registry() -> Any:
    agent_messaging._reset_for_test()
    yield
    agent_messaging._reset_for_test()


def _ctx() -> Any:
    params = {"client": "host", "t": plan_mcp_auth.internal_token()}
    return SimpleNamespace(request_context=SimpleNamespace(request=SimpleNamespace(query_params=params)))


def _fake(monkeypatch: pytest.MonkeyPatch, action: Any, snapshot: Any) -> list[str]:
    ops: list[str] = []

    async def fake(workspace_path: str, op: str, **_kwargs: Any) -> dict[str, Any]:
        ops.append(op)
        answer = action if op == "invoke" else snapshot
        if isinstance(answer, Exception):
            raise answer
        return dict(answer)

    monkeypatch.setattr(plan_mcp, "_ui_request", fake)
    return ops


async def test_without_snapshot_the_answer_is_the_actions_alone(monkeypatch: pytest.MonkeyPatch) -> None:
    ops = _fake(monkeypatch, ACTION_OK, {"ok": True, "result": SNAPSHOT, "error": None})
    assert await plan_mcp.ui_invoke("/w", "ui.tab.agents", _ctx()) == ACTION_OK
    assert ops == ["invoke"]


async def test_snapshot_true_adds_ui_snapshot_beside_the_action(monkeypatch: pytest.MonkeyPatch) -> None:
    ops = _fake(monkeypatch, ACTION_OK, {"ok": True, "result": SNAPSHOT, "error": None})
    answer = await plan_mcp.ui_invoke("/w", "ui.tab.agents", _ctx(), snapshot=True)
    assert answer == {**ACTION_OK, "snapshot": SNAPSHOT}
    assert ops == ["invoke", "snapshot"]


async def test_a_refused_action_takes_no_snapshot(monkeypatch: pytest.MonkeyPatch) -> None:
    refused = {"ok": False, "result": None, "error": "no such action", "error_code": "ui_unknown_action"}
    ops = _fake(monkeypatch, refused, {"ok": True, "result": SNAPSHOT, "error": None})
    assert await plan_mcp.ui_invoke("/w", "ui.nope", _ctx(), snapshot=True) == refused
    assert ops == ["invoke"]


async def test_a_snapshot_that_fails_leaves_the_action_ok(monkeypatch: pytest.MonkeyPatch) -> None:
    failed = {"ok": False, "result": None, "error": "no reply within 15s", "error_code": "ui_timeout"}
    _fake(monkeypatch, ACTION_OK, failed)
    answer = await plan_mcp.ui_invoke("/w", "ui.tab.agents", _ctx(), snapshot=True)
    assert answer == {**ACTION_OK, "snapshot_error": {"error": "no reply within 15s", "error_code": "ui_timeout"}}


async def test_a_snapshot_that_raises_leaves_the_action_ok(monkeypatch: pytest.MonkeyPatch) -> None:
    _fake(monkeypatch, ACTION_OK, RuntimeError("window went away"))
    answer = await plan_mcp.ui_invoke("/w", "ui.tab.agents", _ctx(), snapshot=True)
    assert answer["ok"] is True and answer["result"] == {"done": True}
    assert answer["snapshot_error"] == {"error": "window went away", "error_code": "ui_snapshot_failed"}

"""cli_send to a web pane focuses it and delivers nothing.

A web pane (agent key ``web:<site>``) shows an agent website the user is signed
in to. Nothing is typed into it: cli_send asks the window to focus the pane
(``ui.pane.focus``) and answers without a msg_key, and no ``agent_msg.deliver``
event is ever produced for it.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging, app
from agent_team_backend.mcp_server import (
    server as plan_mcp,
    wiring as plan_mcp_wiring,
)


@pytest.fixture(autouse=True)
def _clean_registry() -> Any:
    agent_messaging._reset_for_test()
    plan_mcp._mcp_message_status.clear()
    yield
    agent_messaging._reset_for_test()
    plan_mcp._mcp_message_status.clear()


def _pane_ctx(pane_id: str = "pa") -> Any:
    params = {"pane": pane_id, "t": plan_mcp_wiring.caller_token(pane_id)}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


@pytest.fixture
def window(monkeypatch: pytest.MonkeyPatch) -> dict[str, list[Any]]:
    seen: dict[str, list[Any]] = {"ui": [], "deliver": []}

    async def fake_ui_request(workspace: str, op: str, **kwargs: Any) -> dict[str, Any]:
        seen["ui"].append({"workspace": workspace, "op": op, **kwargs})
        return {"ok": True, "result": None}

    async def fake_broadcast(event: dict[str, Any], **_kwargs: Any) -> None:
        if event.get("type") == "agent_msg.deliver":
            seen["deliver"].append(event)

    monkeypatch.setattr(plan_mcp, "_ui_request", fake_ui_request)
    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    agent_messaging.register("pa", "lead", "/ws/alpha", agent_key="claude")
    agent_messaging.register("pw", "Grok Bot", "/ws/alpha", agent_key="web:grok")
    return seen


@pytest.mark.asyncio
async def test_send_to_a_web_pane_focuses_it_and_delivers_nothing(window: dict[str, list[Any]]) -> None:
    result = await plan_mcp.cli_send("Grok Bot", "summarise the inbox", _pane_ctx())

    assert result["ok"] is True
    assert result["web_pane"] is True
    assert result["focused"] is True
    assert result["delivered"] is False
    assert "msg_key" not in result
    assert window["deliver"] == []
    assert [(u["op"], u["action"], u["args"]) for u in window["ui"]] == [
        ("invoke", "ui.pane.focus", {"paneId": "pw"})
    ]


@pytest.mark.asyncio
async def test_a_window_that_does_not_answer_is_reported(
    window: dict[str, list[Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    async def silent(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        return {"ok": False, "error_code": "ui_action_timeout"}

    monkeypatch.setattr(plan_mcp, "_ui_request", silent)
    result = await plan_mcp.cli_send("Grok Bot", "hello", _pane_ctx())

    assert result["ok"] is False
    assert result["error_code"] == "ui_action_timeout"
    assert window["deliver"] == []

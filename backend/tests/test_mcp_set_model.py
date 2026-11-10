"""cli_set_model: switch a running pane's model through its window.

What these pin: the window is asked with the trimmed model and effort, a
switch it reports is persisted onto the pane id it answers with (the new id
after a restart) and audited, the window's refusal (a busy pane) comes back
with its code and hold, and the cases refused before the window is asked —
no model, the caller's own pane, a terminal, a CLI that takes no model.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging, app
from agent_team_backend.mcp_server import pane_model_tool, server as core, wiring


@pytest.fixture(autouse=True)
def _clean_registry() -> Any:
    agent_messaging._reset_for_test()
    agent_messaging.register("pa", "commander", "/ws/alpha", agent_key="claude")
    agent_messaging.register("pc", "child", "/ws/alpha", agent_key="claude")
    agent_messaging.register("px", "codex-child", "/ws/alpha", agent_key="codex")
    agent_messaging.register("pt", "shell", "/ws/alpha", agent_key="terminal")
    agent_messaging.register("pd", "devin-child", "/ws/alpha", agent_key="devin")
    yield
    agent_messaging._reset_for_test()


@pytest.fixture(autouse=True)
def recorded(monkeypatch: pytest.MonkeyPatch) -> dict[str, list[Any]]:
    """What the tool persisted and audited."""
    out: dict[str, list[Any]] = {"saved": [], "audited": []}

    def set_pane_model(workspace_path: str, **kwargs: Any) -> None:
        out["saved"].append({"workspace_path": workspace_path, **kwargs})

    monkeypatch.setattr(app, "project_store", SimpleNamespace(set_pane_model=set_pane_model), raising=False)
    monkeypatch.setattr(pane_model_tool, "_audit", lambda *a: out["audited"].append(a))
    return out


def _ctx(pane_id: str = "pa") -> Any:
    params = {"pane": pane_id, "t": wiring.caller_token(pane_id)}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


def _window(monkeypatch: pytest.MonkeyPatch, result: dict[str, Any]) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []

    async def fake(workspace_path: str, op: str, **kwargs: Any) -> dict[str, Any]:
        calls.append({"workspace_path": workspace_path, "op": op, **kwargs})
        return {"ok": True, "result": result}

    monkeypatch.setattr(core, "_ui_request", fake)
    return calls


@pytest.mark.asyncio
async def test_slash_switch_asks_the_window_then_persists_and_audits(
    monkeypatch: pytest.MonkeyPatch, recorded: dict[str, list[Any]],
) -> None:
    calls = _window(monkeypatch, {"ok": True, "method": "slash", "paneId": "pc"})

    result = await pane_model_tool.cli_set_model("child", "  opus ", _ctx())

    assert result == {"ok": True, "target": "alpha/child", "pane_id": "pc", "model": "opus", "method": "slash"}
    assert calls[0]["action"] == "ui.pane.setModel"
    assert calls[0]["route_pane_id"] == "pc"
    assert calls[0]["args"] == {"paneId": "pc", "model": "opus", "effort": ""}
    assert recorded["saved"] == [{"workspace_path": "/ws/alpha", "pane_id": "pc", "model": "opus", "effort": ""}]
    assert recorded["audited"][0][2:] == ("opus", "", "slash")


@pytest.mark.asyncio
async def test_restart_persists_onto_the_replacement_pane_id(
    monkeypatch: pytest.MonkeyPatch, recorded: dict[str, list[Any]],
) -> None:
    _window(monkeypatch, {"ok": True, "method": "restart", "paneId": "pc-new"})

    result = await pane_model_tool.cli_set_model("child", "opus", _ctx(), effort="high")

    assert result["pane_id"] == "pc-new"
    assert result["method"] == "restart"
    assert result["effort"] == "high"
    assert recorded["saved"][0]["pane_id"] == "pc-new"
    assert recorded["saved"][0]["effort"] == "high"


@pytest.mark.asyncio
async def test_a_busy_pane_is_refused_with_the_windows_code_and_hold(
    monkeypatch: pytest.MonkeyPatch, recorded: dict[str, list[Any]],
) -> None:
    _window(monkeypatch, {"ok": False, "error_code": "pane-busy", "error": "not idle", "hold": "mid-turn"})

    result = await pane_model_tool.cli_set_model("codex-child", "gpt-6", _ctx())

    assert result["ok"] is False
    assert result["error_code"] == "pane-busy"
    assert result["hold"] == "mid-turn"
    assert recorded["saved"] == [] and recorded["audited"] == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("target", "model", "caller", "code"),
    [
        ("child", "  ", "pa", "model-required"),
        ("commander", "opus", "pa", "self-set-model"),
        ("shell", "opus", "pa", "not-agent-pane"),
        ("devin-child", "opus", "pa", "model-unsupported"),
        ("child", "opus --dangerous", "pa", "model-unsupported"),
    ],
)
async def test_refused_before_the_window_is_asked(
    monkeypatch: pytest.MonkeyPatch, target: str, model: str, caller: str, code: str,
) -> None:
    calls = _window(monkeypatch, {"ok": True, "method": "slash", "paneId": "x"})

    result = await pane_model_tool.cli_set_model(target, model, _ctx(caller))

    assert result["ok"] is False
    assert result["error_code"] == code
    assert calls == []

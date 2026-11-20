"""agent_spawn.result handler: forwards a window's spawn verdict — including
its optional `advisories` field — to the waiting cli_open_agent MCP call via
plan_mcp.resolve_spawn.
"""

from __future__ import annotations

from typing import Any

import pytest

from agent_team_backend import app
from agent_team_backend.mcp_server import server as plan_mcp


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


def _session() -> app.Session:
    return app.Session(FakeWebSocket())  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_forwards_advisories_when_the_renderer_included_them(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    def fake_resolve(request_id: str, verdict: dict[str, Any]) -> bool:
        captured["request_id"] = request_id
        captured["verdict"] = verdict
        return True

    monkeypatch.setattr(plan_mcp, "resolve_spawn", fake_resolve)
    session = _session()

    await app.handle_message(session, {
        "id": "m1",
        "type": "agent_spawn.result",
        "payload": {
            "request_id": "req-1",
            "ok": True,
            "pane_id": "new-pane",
            "name": "reviewer2",
            "advisories": ["此工作區已有 8 個 CLI pane（建議值 8）"],
        },
    })

    assert captured["verdict"]["advisories"] == ["此工作區已有 8 個 CLI pane（建議值 8）"]


@pytest.mark.asyncio
async def test_omits_advisories_key_when_the_renderer_sent_none(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    def fake_resolve(request_id: str, verdict: dict[str, Any]) -> bool:
        captured["verdict"] = verdict
        return True

    monkeypatch.setattr(plan_mcp, "resolve_spawn", fake_resolve)
    session = _session()

    await app.handle_message(session, {
        "id": "m2",
        "type": "agent_spawn.result",
        "payload": {"request_id": "req-2", "ok": True, "pane_id": "new-pane", "name": "worker"},
    })

    assert "advisories" not in captured["verdict"]


@pytest.mark.asyncio
async def test_omits_advisories_key_when_the_renderer_sent_an_empty_list(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    def fake_resolve(request_id: str, verdict: dict[str, Any]) -> bool:
        captured["verdict"] = verdict
        return True

    monkeypatch.setattr(plan_mcp, "resolve_spawn", fake_resolve)
    session = _session()

    await app.handle_message(session, {
        "id": "m3",
        "type": "agent_spawn.result",
        "payload": {
            "request_id": "req-3",
            "ok": True,
            "pane_id": "new-pane",
            "name": "worker",
            "advisories": [],
        },
    })

    assert "advisories" not in captured["verdict"]


# ── agent_spawn.kickoff ────────────────────────────────────────────────────
@pytest.mark.asyncio
async def test_kickoff_handler_forwards_the_verdict_to_resolve_kickoff(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    def fake_resolve(request_id: str, verdict: dict[str, Any]) -> bool:
        captured["request_id"] = request_id
        captured["verdict"] = verdict
        return True

    monkeypatch.setattr(plan_mcp, "resolve_kickoff", fake_resolve)
    session = _session()

    await app.handle_message(session, {
        "id": "k1",
        "type": "agent_spawn.kickoff",
        "payload": {
            "request_id": "req-9",
            "pane_id": "new-pane",
            "kickoff": "failed",
            "reason": "typed 2× and never verified",
        },
    })

    assert captured["request_id"] == "req-9"
    assert captured["verdict"] == {
        "pane_id": "new-pane",
        "kickoff": "failed",
        "reason": "typed 2× and never verified",
    }
    assert session.websocket.sent[-1]["payload"] == {"ok": True, "delivered": True}  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_kickoff_handler_rejects_a_missing_request_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    called: list[str] = []
    monkeypatch.setattr(plan_mcp, "resolve_kickoff", lambda rid, v: called.append(rid) or True)
    session = _session()

    await app.handle_message(session, {
        "id": "k2",
        "type": "agent_spawn.kickoff",
        "payload": {"pane_id": "new-pane", "kickoff": "sent"},
    })

    assert called == []
    assert session.websocket.sent[-1]["ok"] is False  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_kickoff_verdict_carries_the_launch_prompt_it_is_blocked_on(monkeypatch: pytest.MonkeyPatch) -> None:
    from agent_team_backend import ws_handlers
    from agent_team_backend.mcp_server import server as plan_mcp

    seen: list[dict] = []
    monkeypatch.setattr(plan_mcp, "resolve_kickoff", lambda request_id, verdict: seen.append(verdict) or True)

    class _Session:
        async def send_json(self, _msg: dict) -> None:
            return None

    await ws_handlers.agent_spawn_kickoff(_Session(), "m1", "agent_spawn.kickoff", {
        "request_id": "r1", "pane_id": "p1", "kickoff": "blocked-by-prompt", "reason": "why",
        "prompt": "Adding a new directory: /x", "options": ["No, exit", "Yes, add it"],
    })

    assert seen == [{
        "pane_id": "p1", "kickoff": "blocked-by-prompt", "reason": "why",
        "prompt": "Adding a new directory: /x", "options": ["No, exit", "Yes, add it"],
    }]

"""Plain terminal panes (agent_key "terminal") on the backend side: external
content is refused before it is broadcast or taints anything, writes that ask
for the shell's prompt are refused while a program is in front, and a platform
that cannot tell says so in every answer."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging, app
from agent_team_backend.guard import is_tainted
from agent_team_backend.mcp_server import server as mcp
from agent_team_backend.mcp_server import wiring as mcp_wiring


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


class FakeTerminals:
    def __init__(self, at_prompt: bool | None) -> None:
        self.at_prompt = at_prompt
        self.written: list[str] = []

    def shell_in_foreground(self, session_id: str) -> bool | None:
        return self.at_prompt

    def write(self, session_id: str, data: str) -> int:
        self.written.append(data)
        return 0

    def get(self, session_id: str) -> None:
        return None


async def ws(msg_type: str, payload: dict, terminals: FakeTerminals) -> dict[str, Any]:
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    session.terminals = terminals  # type: ignore[assignment]
    await app.handle_message(session, {"id": "r1", "type": msg_type, "payload": payload})
    return session.websocket.sent[-1]["payload"]  # type: ignore[attr-defined]


@pytest.fixture
def captured(monkeypatch) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []

    async def fake_broadcast(event: dict[str, Any], **_kwargs: Any) -> None:
        events.append(event)

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    return events


def _seed() -> None:
    agent_messaging.register("pa", "sender", "/ws/alpha", agent_key="claude")
    agent_messaging.register("pt", "shell", "/ws/alpha", agent_key="terminal")


def _pane_ctx(pane_id: str) -> Any:
    params = {"pane": pane_id, "t": mcp_wiring.caller_token(pane_id)}
    return SimpleNamespace(request_context=SimpleNamespace(request=SimpleNamespace(query_params=params)))


# ── external content never reaches a terminal ─────────────────────────────
@pytest.mark.asyncio
async def test_chat_channel_to_terminal_is_refused_before_broadcast_or_taint(captured):
    from agent_team_backend.channels import default_seams

    _seed()
    res = await default_seams().deliver("pt", "rm -rf ~", "telegram:alice")
    assert res["ok"] is False and "terminal" in res["error"]
    assert captured == []
    assert not is_tainted("pt")


@pytest.mark.asyncio
async def test_dispatch_delivery_refuses_remote_origin_for_a_terminal(captured):
    _seed()
    with pytest.raises(mcp.TerminalExternalRefused):
        await mcp._dispatch_delivery(agent_messaging.get("pt"), "ls", caller=mcp._Caller(kind="host"),
                                     me="", cross_workspace=False, origin="remote")
    assert captured == [] and not is_tainted("pt")


@pytest.mark.asyncio
async def test_another_device_to_terminal_is_rejected_and_acked(captured):
    from agent_team_backend import server_link

    _seed()
    acks: list[tuple[str, str, str]] = []
    link = object.__new__(server_link.ServerLink)

    async def fake_ack(msg_key: str, state: str, *, reason: str = "", pane_id: str = "") -> None:
        acks.append((msg_key, state, reason))

    link._ack = fake_ack  # type: ignore[method-assign]
    await server_link.ServerLink._deliver(link, "m1", agent_messaging.get("pt"),
                                          {"deviceId": "dev2", "workspace": "w", "paneName": "x"}, "ls")
    assert acks == [("m1", "rejected", "terminal-external")]
    assert captured == [] and not is_tainted("pt")


@pytest.mark.asyncio
async def test_local_cli_send_to_terminal_still_goes_through(captured):
    _seed()
    res = await mcp.cli_send("shell", "ls", _pane_ctx("pa"))
    assert res["ok"] is True
    assert [e["type"] for e in captured] == ["agent_msg.deliver"]


# ── a platform that cannot see the shell's prompt says so ─────────────────
@pytest.mark.asyncio
async def test_cli_send_to_terminal_warns_where_the_prompt_cannot_be_checked(captured, monkeypatch):
    _seed()
    monkeypatch.setattr(mcp, "_TERMINAL_PROMPT_CHECK", False)
    res = await mcp.cli_send("shell", "ls", _pane_ctx("pa"))
    assert res["ok"] is True
    assert res["prompt_check"] == "unavailable"
    assert "cannot tell whether the terminal's shell is at its prompt" in res["warning"]


@pytest.mark.asyncio
async def test_cli_send_to_terminal_has_no_warning_where_it_can(captured, monkeypatch):
    _seed()
    monkeypatch.setattr(mcp, "_TERMINAL_PROMPT_CHECK", True)
    res = await mcp.cli_send("shell", "ls", _pane_ctx("pa"))
    assert "prompt_check" not in res and "warning" not in res


def test_prompt_check_is_off_exactly_on_windows():
    import os

    assert mcp._TERMINAL_PROMPT_CHECK is (os.name != "nt")


# ── terminal.input require_shell_prompt / terminal.shell_at_prompt ─────────
@pytest.mark.asyncio
async def test_guarded_write_is_refused_while_a_program_is_in_front():
    terms = FakeTerminals(at_prompt=False)
    res = await ws("terminal.input", {"terminal_session_id": "s", "data": "ls", "require_shell_prompt": True}, terms)
    assert res == {"ok": False, "error": "foreground-busy"}
    assert terms.written == []


@pytest.mark.asyncio
@pytest.mark.parametrize("state", [True, None])
async def test_guarded_write_goes_through_at_the_prompt_or_when_unknown(state):
    terms = FakeTerminals(at_prompt=state)
    res = await ws("terminal.input", {"terminal_session_id": "s", "data": "ls", "require_shell_prompt": True}, terms)
    assert res["ok"] is True and terms.written == ["ls"]


@pytest.mark.asyncio
async def test_unguarded_write_is_never_checked():
    terms = FakeTerminals(at_prompt=False)
    res = await ws("terminal.input", {"terminal_session_id": "s", "data": "q"}, terms)
    assert res["ok"] is True and terms.written == ["q"]


@pytest.mark.asyncio
async def test_shell_at_prompt_reports_each_session():
    res = await ws("terminal.shell_at_prompt", {"terminal_session_ids": ["a", "b"]}, FakeTerminals(False))
    assert res == {"ok": True, "states": {"a": False, "b": False}}

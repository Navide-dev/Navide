"""A pane's MCP connection notice goes only to the chats of that pane's workspace
(2026-11-23: one pane stuck on the folder-trust prompt in Navide-Org told every
bound Telegram bot, every client's included). Fake manager, no adapters."""

from __future__ import annotations

from types import MethodType, SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging
from agent_team_backend.channels.manager import ChannelManager

PANES = {"org-cmd": "/ws/navide-org", "org-dev": "/ws/navide-org", "client": "/ws/client"}


def _binding(chat: str, pane_id: str, kind: str = "direct") -> Any:
    loc = SimpleNamespace(key=lambda: chat, name=chat)
    return SimpleNamespace(location=lambda: loc, platform="telegram", pane_id=pane_id, kind=kind)


def _manager(bindings: list[Any], sent: list[tuple[str, str]]) -> Any:
    async def send(location: Any, text: str) -> None:
        sent.append((location.name, text))

    async def ui_settings() -> dict[str, Any]:
        return {}

    fake = SimpleNamespace(
        store=SimpleNamespace(bindings=lambda: bindings),
        _chat_kind=lambda b: b.kind,
        _ui_settings=ui_settings,
        _seams=SimpleNamespace(resolve_pane=lambda p: p if p in PANES else "",
                               pane_workspace=lambda p: PANES.get(p, "")),
        mirror=SimpleNamespace(send=send),
    )
    for name in ("notify_mcp_never_connected", "notify_mcp_disconnected", "_notify_mcp_connection"):
        setattr(fake, name, MethodType(getattr(ChannelManager, name), fake))
    return fake


@pytest.fixture
def wired(monkeypatch: pytest.MonkeyPatch):
    from agent_team_backend import app, channels

    sent: list[tuple[str, str]] = []
    events: list[dict[str, Any]] = []

    async def broadcast(event: dict[str, Any]) -> None:
        events.append(event)

    bindings = [_binding("org-chat", "org-dev"), _binding("client-chat", "client"),
                _binding("gone-chat", "closed-pane")]
    monkeypatch.setattr(app, "broadcast", broadcast)
    monkeypatch.setattr(channels, "get_manager", lambda: _manager(bindings, sent))
    return app, sent, events


def _entry(pane_id: str) -> agent_messaging.RegisteredPane:
    return agent_messaging.RegisteredPane(pane_id=pane_id, name="Org指揮", workspace_path=PANES[pane_id],
                                          agent_key="claude")


async def test_never_connected_reaches_only_the_panes_workspace(wired) -> None:
    app, sent, events = wired
    await app._notify_mcp_never_connected(_entry("org-cmd"))

    assert [chat for chat, _ in sent] == ["org-chat"]
    assert "Org指揮" in sent[0][1]
    # The window still badges and toasts the pane, chat or no chat.
    assert events[0]["type"] == "mcp.never_connected"


async def test_disconnected_reaches_only_the_panes_workspace(wired) -> None:
    app, sent, _ = wired
    await app._notify_mcp_disconnected(_entry("client"))

    assert [chat for chat, _ in sent] == ["client-chat"]
    assert "/mcp reconnect navide" in sent[0][1]


async def test_no_chat_in_the_workspace_means_no_chat_notice(wired, monkeypatch) -> None:
    app, sent, events = wired
    entry = agent_messaging.RegisteredPane(pane_id="lonely", name="x", workspace_path="/ws/nobody",
                                           agent_key="claude")
    await app._notify_mcp_never_connected(entry)

    assert sent == []
    assert events[0]["type"] == "mcp.never_connected"

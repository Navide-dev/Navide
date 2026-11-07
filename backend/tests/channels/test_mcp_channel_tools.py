"""MCP channels_status / channels_bindings (plan mcp-bot_507912 P0).

Both only read the channel manager; neither may hand a bot credential to the
agent, whether as a key, as a config value or quoted inside an error.
"""

from __future__ import annotations

import hashlib
import json
import re

import pytest

from agent_team_backend import channels
from agent_team_backend.mcp_server import channel_tools
from agent_team_backend.mcp_server import server as mcp
from agent_team_backend.plugins import agent_tools_contract as contract

from .test_manager import Env, env, fast_timers  # noqa: F401 — fixtures shared with the manager suite

TOOLS = ("channels_status", "channels_bindings")
#: A Telegram bot token as BotFather hands it out.
REAL_TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ"
TOKEN_SHAPE = re.compile(r"\d+:[A-Za-z0-9_-]{30,}")
#: sha256 of the channels_* tools' names and parameter schemas. A tool added
#: or changed on purpose updates it: print _surface()'s digest and paste it here.
CHANNEL_SURFACE_SHA256 = "4a33b3da8c88d6f29a7f9f4736f52f48294ac7f3cc83eb9ead855f56b6fa999f"


def _tools() -> dict:
    return {t.name: t for t in mcp.server._tool_manager.list_tools()}  # noqa: SLF001


def _surface() -> str:
    tools = _tools()
    names = sorted(n for n in tools if n.startswith("channels_"))
    return json.dumps([[n, tools[n].parameters] for n in names], sort_keys=True, separators=(",", ":"),
                      ensure_ascii=True)


def _keys(value) -> set[str]:
    if isinstance(value, dict):
        return set(value) | {k for v in value.values() for k in _keys(v)}
    if isinstance(value, list):
        return {k for v in value for k in _keys(v)}
    return set()


@pytest.fixture
async def live(env: Env, monkeypatch):  # noqa: F811 — the env fixture imported above
    """The manager suite's env, with a second bot whose token is real-shaped and whose
    last error quotes the request URL that carries it."""
    assert (await env.m.configure("telegram", {"name": "Ops"}, {"token": REAL_TOKEN}, account="bot-x"))["ok"]
    env.adapters["telegram:bot-x"].status.last_error = (
        f"HTTP 409 from https://api.telegram.org/bot{REAL_TOKEN}/getUpdates"
    )
    monkeypatch.setattr(channels, "_manager", env.m)
    return env


def test_both_tools_are_registered_core_tools_with_a_pinned_surface() -> None:
    tools = _tools()
    for name in TOOLS:
        assert name in tools and name in contract.CORE_TOOL_NAMES, name
    surface = _surface()
    for name, schema in json.loads(surface):
        for key in schema.get("properties", {}):
            assert not any(word in key.lower() for word in ("token", "secret", "approve", "confirm")), (name, key)
    assert hashlib.sha256(surface.encode()).hexdigest() == CHANNEL_SURFACE_SHA256


@pytest.mark.parametrize("name", TOOLS)
def test_each_description_says_it_is_read_only_and_where_to_change_things(name: str) -> None:
    description = _tools()[name].description
    assert "Read-only" in description
    assert "ui.settings.open" in description and '"channels"' in description


async def test_status_lists_each_bot_with_its_binding(live: Env) -> None:
    out = await channel_tools.channels_status()
    assert out["ok"] is True
    telegram = next(p for p in out["platforms"] if p["platform"] == "telegram")
    bots = {b["account"]: b for b in telegram["bots"]}
    assert set(bots) == {"default", "bot-x"}
    assert bots["bot-x"]["name"] == "Ops" and bots["bot-x"]["enabled"] is True
    assert [b["pane_id"] for b in bots["default"]["bindings"]] == ["pane-1"]
    assert "status" in bots["default"] and "last_activity_at" in bots["default"]


async def test_status_never_carries_a_token(live: Env) -> None:
    out = await channel_tools.channels_status()
    text = json.dumps(out, ensure_ascii=False)
    assert not TOKEN_SHAPE.search(text), text
    assert REAL_TOKEN not in text and "tok-A" not in text
    assert not any("token" in k.lower() or "secret" in k.lower() for k in _keys(out))
    bot_x = next(b for p in out["platforms"] for b in p["bots"] if b["account"] == "bot-x")
    assert bot_x["status"]["last_error"] == "HTTP 409 from https://api.telegram.org/bot<redacted>/getUpdates"
    assert "config" not in bot_x


async def test_bindings_lists_every_binding_without_a_token(live: Env) -> None:
    out = await channel_tools.channels_bindings()
    assert out["ok"] is True
    assert [(b["pane_id"], b["platform"], b["account"], b["chat_id"]) for b in out["bindings"]] == [
        ("pane-1", "telegram", "default", "-100"),
    ]
    text = json.dumps(out, ensure_ascii=False)
    assert not TOKEN_SHAPE.search(text)
    assert not any("token" in k.lower() or "secret" in k.lower() for k in _keys(out))


@pytest.mark.parametrize("name", TOOLS)
async def test_without_the_gateway_each_tool_says_so(name: str, monkeypatch) -> None:
    monkeypatch.setattr(channels, "_manager", None)
    out = await getattr(channel_tools, name)()
    assert out == {"ok": False, "error": "chat channels are not running", "error_code": "channels-not-running"}


@pytest.mark.parametrize("text", [
    REAL_TOKEN,
    "xoxb-1234567890-abcdefghij",
    "xapp-1-A0123456789-abcdef",
    "MTA1234567890123456789012.GaBcDe.abcdefghijklmnopqrstuvwxyz0123",
])
def test_scrub_redacts_each_platforms_credential_shape(text: str, monkeypatch) -> None:
    from agent_team_backend.channels import redact

    # Unregistered: only the shape can catch it.
    monkeypatch.setattr(redact, "_filter", redact.SecretRedactFilter())
    assert channel_tools._scrub({"e": f"failed: {text}"}) == {"e": "failed: [redacted]"}


def test_scrub_masks_a_secret_a_bot_registered_whatever_its_shape(monkeypatch) -> None:
    from agent_team_backend.channels import redact

    monkeypatch.setattr(redact, "_filter", redact.SecretRedactFilter())
    redact.add_secret("matrix-access-Qz9")
    assert channel_tools._scrub({"e": "login failed for matrix-access-Qz9"}) == {"e": "login failed for <redacted>"}

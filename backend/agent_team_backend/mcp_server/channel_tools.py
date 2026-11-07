"""MCP tools for Navide's chat channels (plan mcp-bot_507912).

Read-only so far: channels_status lists the bots and how each is connected,
channels_bindings lists which pane each chat drives. Both are thin wrappers
over the channel manager's own list() and bindings(), the same answers the
Settings → Channels page reads over channels.list / channels.bindings.

A bot credential never leaves the Host: each bot's ``config`` (where its
secret hint lives) is left out, any key named like a credential is dropped,
and credential-shaped text (a status ``last_error`` that quotes a request URL,
say) is redacted before it is returned.

Registered on the core server by the import at the end of server.py.
"""

from __future__ import annotations

import re
from typing import Any

from . import server as core
from .marketplace_forms import _without_secrets

#: Platform credentials as they look in text: a Telegram bot token, Slack
#: bot/app tokens, a Discord bot token.
_CHANNEL_SECRET_TEXT = re.compile(
    r"\d{5,}:[A-Za-z0-9_-]{30,}"
    r"|\bxox[a-z]-[A-Za-z0-9-]{10,}|\bxapp-[A-Za-z0-9-]{10,}"
    r"|\b[MNO][A-Za-z0-9_-]{23,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}"
)
_READ_ONLY_NOTE = (
    "Read-only. To add a bot, link a chat or bind and unbind panes, open the Channels settings "
    'page with ui_invoke ui.settings.open {tab: "channels", platform, account} (it opens with '
    "that bot selected) and let the user do it there."
)


def _redact(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _redact(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_redact(v) for v in value]
    if isinstance(value, str):
        return _CHANNEL_SECRET_TEXT.sub("[redacted]", value)
    return value


def _scrub(value: Any) -> Any:
    """``value`` with credential-named keys dropped and credential-shaped text redacted."""
    return _redact(_without_secrets(value))


def _manager() -> Any:
    from agent_team_backend import channels

    return channels.get_manager()


_NOT_RUNNING = {"ok": False, "error": "chat channels are not running", "error_code": "channels-not-running"}


def _bot_view(platform: str, bot: dict[str, Any]) -> dict[str, Any]:
    return {
        "platform": platform,
        "account": bot.get("account"),
        "name": bot.get("name"),
        "configured": bot.get("configured"),
        "enabled": bot.get("enabled"),
        "status": bot.get("status"),
        "bot_id": bot.get("bot_id"),
        "bindings": bot.get("bindings"),
        "last_activity_at": bot.get("last_activity_at"),
    }


@core.server.tool()
async def channels_status() -> dict[str, Any]:
    """List Navide's chat-channel bots (Telegram, Discord, Slack, ...) and how each is doing.

    Read-only; any caller may use it. To add a bot, link a chat or bind and
    unbind panes, open the Channels settings page with ui_invoke
    ui.settings.open {tab: "channels", platform, account} — it opens with that
    bot selected — and let the user do it there.

    Returns {ok, enabled, platforms: [{platform, configured, enabled, bots}],
    note}. `enabled` is the global channels switch. Each bot: {platform,
    account, name, configured, enabled, status: {lifecycle, connected,
    reconnect_attempts, last_error, last_connected_at, last_inbound_at,
    identity, ...}, bot_id (Telegram only), bindings: [{pane_id, pane_name,
    pane_exists, workspace_path, workspace_name, chat_title, created_at}],
    last_activity_at}. A platform with no bot set up lists none. No bot token
    or other credential is ever part of the answer; credential-shaped text in
    an error is shown as [redacted]. {ok: false, error_code:
    "channels-not-running"} when the channel gateway is not running.
    """
    manager = _manager()
    if manager is None:
        return dict(_NOT_RUNNING)
    listed = manager.list()
    platforms = [
        {
            "platform": p["platform"],
            "configured": p.get("configured"),
            "enabled": p.get("enabled"),
            "bots": [_bot_view(p["platform"], bot) for bot in p.get("accounts") or []],
        }
        for p in listed.get("platforms") or []
    ]
    return _scrub({"ok": True, "enabled": listed.get("enabled"), "platforms": platforms, "note": _READ_ONLY_NOTE})


@core.server.tool()
async def channels_bindings() -> dict[str, Any]:
    """List which Navide pane each chat-channel chat is bound to.

    Read-only; any caller may use it. To bind or unbind a pane, open the
    Channels settings page with ui_invoke ui.settings.open {tab: "channels",
    platform, account} and let the user do it there.

    Returns {ok, bindings: [{pane_id, platform, account, chat_id, thread_id,
    title, verbosity, parent_pane_id, auto}], note}. A chat drives one pane at
    a time; `auto` marks a child pane's topic created for it; `verbosity` is
    how much of the pane's activity the chat receives. No credential is part
    of the answer. {ok: false, error_code: "channels-not-running"} when the
    channel gateway is not running.
    """
    manager = _manager()
    if manager is None:
        return dict(_NOT_RUNNING)
    listed = manager.bindings()
    return _scrub({"ok": True, "bindings": listed.get("bindings") or [], "note": _READ_ONLY_NOTE})

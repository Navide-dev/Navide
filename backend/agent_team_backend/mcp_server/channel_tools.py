"""MCP tools for Navide's chat channels (plan mcp-bot_507912).

Thin wrappers over the channel manager, the same calls the Settings →
Channels page makes over channels.*. Read-only: channels_status (bots and how
each is connected), channels_bindings, channels_chats,
channels_pairing_requests. Direct changes (P1): a link code, binding,
unbinding and verbosity for a pane in the caller's own workspace, renaming and
connecting a bot, turning down a pairing request. Every change is recorded in
agent_window_actions with the caller and announced to the main windows
(channels.agent_action). Approving a person, adding or removing a bot and
binding another workspace's pane stay the user's, in the main window.

A bot credential never leaves the Host: each bot's ``config`` (where its
secret hint lives) is left out, any key named like a credential is dropped,
and text is redacted before it is returned: every secret a running bot has
registered with channels.redact (whatever its platform or shape), a bot-token
URL segment, and anything shaped like a Telegram, Slack or Discord token.

Registered on the core server by the import at the end of server.py.
"""

from __future__ import annotations

import re
from typing import Any

from mcp.server.fastmcp import Context

from ..channels import redact
from ..channels.store import DEFAULT_ACCOUNT
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
    "Read-only. channels_link_code, channels_bind and channels_unbind link chats and bind panes in "
    "your own workspace; for the rest open the Channels settings page with ui_invoke "
    'ui.settings.open {tab: "channels", platform, account} (it opens with that bot selected).'
)


def _redact(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _redact(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_redact(v) for v in value]
    if isinstance(value, str):
        return _CHANNEL_SECRET_TEXT.sub("[redacted]", redact.redact_text(value))
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

    Read-only; any caller may use it. channels_link_code, channels_bind and
    channels_unbind link chats and bind panes in your own workspace; for the
    rest open the Channels settings page with ui_invoke ui.settings.open
    {tab: "channels", platform, account} — it opens with that bot selected.

    Returns {ok, enabled, platforms: [{platform, configured, enabled, bots}],
    note}. `enabled` is the global channels switch. Each bot: {platform,
    account, name, configured, enabled, status: {lifecycle, connected,
    reconnect_attempts, last_error, last_connected_at, last_inbound_at,
    identity, ...}, bot_id (Telegram only), bindings: [{pane_id, pane_name,
    pane_exists, workspace_path, workspace_name, chat_title, created_at}],
    last_activity_at}. A platform with no bot set up lists none. No bot token
    or other credential is ever part of the answer; a secret quoted in an
    error is shown as <redacted> or [redacted]. {ok: false, error_code:
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

    Read-only; any caller may use it. channels_bind and channels_unbind
    change a pane in your own workspace; another workspace's pane is the
    user's, in the Channels settings page (ui_invoke ui.settings.open
    {tab: "channels", platform, account}).

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


@core.server.tool()
async def channels_chats(platform: str = "", account: str = "") -> dict[str, Any]:
    """List the chats a running bot knows, to pick one for channels_bind.

    Read-only; any caller may use it. With `platform` (and `account`, the bot's
    id from channels_status, "default" when omitted) it lists that bot's chats;
    with no platform, every running bot's. A bot that is not running knows no
    chats. Returns {ok, bots: [{platform, account, chats: [{chat_id, title,
    kind, supports_topics, ...}]}]}. A bot learns a chat when someone writes to
    it there or redeems a link code (channels_link_code).
    """
    manager = _manager()
    if manager is None:
        return dict(_NOT_RUNNING)
    try:
        if not platform:
            listed = manager.all_locations()
            bots = [{"platform": b["platform"], "account": b["account"], "chats": b["locations"]}
                    for b in listed.get("bots") or []]
        else:
            account = account or DEFAULT_ACCOUNT
            bots = [{"platform": platform, "account": account,
                     "chats": manager.locations(platform, account).get("locations") or []}]
    except ValueError as err:
        return _bad_request(err)
    return _scrub({"ok": True, "bots": bots})


@core.server.tool()
async def channels_pairing_requests(platform: str = "") -> dict[str, Any]:
    """List the people waiting for the user to let them talk to a bot.

    Read-only; any caller may use it. Someone who writes to a bot, or redeems
    a link code, while not yet allowed leaves a request with an 8-character
    code. Approving one is the user's alone, in the Channels settings page;
    channels_pairing_reject turns one down. Returns {ok, requests: [{platform,
    account, code, sender_id, sender_name, created_at, source}]}, `source`
    being "invite" for a redeemed link code and "pairing" otherwise.
    """
    manager = _manager()
    if manager is None:
        return dict(_NOT_RUNNING)
    return _scrub(manager.pairing_list(platform or None))


@core.server.tool()
async def channels_link_code(platform: str, ctx: Context, account: str = "", target: str = "direct") -> dict[str, Any]:
    """Make a one-time code that links a chat to a bot.

    `account` is the bot's id from channels_status ("default" when omitted);
    `target` is "direct" (a private chat) or "group". Hand the code or `url`
    to the person who should link: when they send it to the bot their chat
    becomes known, and their request waits in channels_pairing_requests for
    the user to approve in the Channels settings page — the code alone lets
    nobody in. A code lasts 10 minutes; a bot keeps at most 5. Recorded with
    the caller and shown in Navide. Returns {ok, platform, code, target,
    expires_at, url} or {ok: false, error, error_code}.
    """
    return await _act(ctx, "channels_link_code", {"platform": platform, "account": account or DEFAULT_ACCOUNT},
                      lambda m: _sync(m.link_create(platform, target, account or DEFAULT_ACCOUNT)))


@core.server.tool()
async def channels_bind(
    platform: str,
    chat_id: str,
    ctx: Context,
    pane: str = "",
    pane_id: str = "",
    account: str = "",
    mode: str = "existing",
    thread_id: str = "",
    title: str = "",
    verbosity: str = "",
) -> dict[str, Any]:
    """Bind a chat to a pane in your own workspace, so its messages reach that pane.

    Only a CLI pane may call this. `pane` (a name, addressed as in cli_send)
    or `pane_id` picks the pane; with neither it is you. The pane must be in
    your own workspace — another workspace's pane is the user's to bind, in
    the Channels settings page ("cross-workspace"). `chat_id` comes from
    channels_chats; `account` is the bot ("default" when omitted). `mode`
    "existing" uses the chat (and `thread_id`'s topic) as it is; "new" makes a
    new topic titled `title` where the platform can. `verbosity` is how much
    of the pane's activity the chat gets: replies, minimal, standard or full
    (a new binding defaults to replies, a re-bind keeps the pane's level).

    A chat drives one pane at a time: one bound elsewhere is refused. A pane
    holds one chat: binding it to another moves it. The chat is told which
    pane it now drives. If nobody there is allowed yet the answer carries
    `needs_approval: true` and the chat is told how to ask; approving is the
    user's. Recorded with the caller and shown in Navide. Returns {ok,
    binding, needs_approval?} or {ok: false, error, error_code}.
    """
    caller, target, failure = _own_pane(ctx, pane, pane_id)
    if failure is not None:
        return failure
    return await _act(ctx, "channels_bind",
                      {"platform": platform, "account": account or DEFAULT_ACCOUNT, "chat_id": chat_id,
                       "pane_id": target.pane_id, "pane": target.name},
                      lambda m: m.bind(target.pane_id, target.name, platform, mode, chat_id, thread_id, title,
                                       verbosity=verbosity, account=account or DEFAULT_ACCOUNT),
                      caller=caller)


@core.server.tool()
async def channels_unbind(ctx: Context, pane: str = "", pane_id: str = "") -> dict[str, Any]:
    """Unbind a pane in your own workspace from its chat.

    Only a CLI pane may call this. `pane` or `pane_id` picks the pane as in
    channels_bind; with neither it is you. Another workspace's pane is the
    user's to unbind ("cross-workspace"). The chat is told it is no longer
    connected. Recorded with the caller and shown in Navide. Returns {ok,
    removed} — `removed` false when the pane had no chat.
    """
    caller, target, failure = _own_pane(ctx, pane, pane_id)
    if failure is not None:
        return failure
    return await _act(ctx, "channels_unbind", {"pane_id": target.pane_id, "pane": target.name},
                      lambda m: m.unbind(target.pane_id, pane_name=target.name), caller=caller)


@core.server.tool()
async def channels_set_verbosity(verbosity: str, ctx: Context, pane: str = "", pane_id: str = "") -> dict[str, Any]:
    """Set how much of a pane's activity its chat receives.

    Only a CLI pane may call this, for a pane in its own workspace (`pane` or
    `pane_id` as in channels_bind; with neither it is you). `verbosity` is
    replies, minimal, standard or full; child panes' automatic topics follow.
    A higher level lets the chat's members read more of the pane, so every
    change is recorded with the caller and shown in Navide. Returns {ok,
    binding} or {ok: false, error, error_code}.
    """
    caller, target, failure = _own_pane(ctx, pane, pane_id)
    if failure is not None:
        return failure
    return await _act(ctx, "channels_set_verbosity",
                      {"pane_id": target.pane_id, "pane": target.name, "verbosity": verbosity},
                      lambda m: m.set_binding_options(target.pane_id, verbosity), caller=caller)


@core.server.tool()
async def channels_bot_rename(platform: str, account: str, name: str, ctx: Context) -> dict[str, Any]:
    """Change a bot's display name in Navide (an empty name clears it).

    Only the label the Channels page shows: the bot's id, credential and
    connection stay as they are, and the platform's own bot name is not
    touched. Recorded with the caller and shown in Navide. Returns {ok} or
    {ok: false, error, error_code}.
    """
    return await _act(ctx, "channels_bot_rename", {"platform": platform, "account": account, "name": name},
                      lambda m: m.rename_account(platform, account, name))


@core.server.tool()
async def channels_bot_set_enabled(platform: str, account: str, enabled: bool, ctx: Context) -> dict[str, Any]:
    """Connect or disconnect one bot.

    Disconnecting stops that bot only: its chats stop reaching their panes
    until it is connected again, and nothing is deleted. The switch for every
    bot at once stays with the user. Recorded with the caller and shown in
    Navide. Returns {ok} or {ok: false, error, error_code} — connecting can
    fail when the platform refuses the bot.
    """
    return await _act(ctx, "channels_bot_set_enabled", {"platform": platform, "account": account, "enabled": enabled},
                      lambda m: m.set_enabled(platform, bool(enabled), account))


@core.server.tool()
async def channels_pairing_reject(platform: str, code: str, ctx: Context) -> dict[str, Any]:
    """Turn down a pairing request (a code from channels_pairing_requests).

    The sender stays unable to talk to the bot; a link code they redeemed
    fails. Approving is the user's alone, in the Channels settings page.
    Recorded with the caller and shown in Navide. Returns {ok} or {ok: false,
    error, error_code}.
    """
    return await _act(ctx, "channels_pairing_reject", {"platform": platform, "code": code},
                      lambda m: m.pairing_reject(platform, code))


# ── helpers for the tools that change something ─────────────────────────────


def _bad_request(err: Exception) -> dict[str, Any]:
    return {"ok": False, "error": str(err), "error_code": "bad-request"}


async def _sync(value: dict[str, Any]) -> dict[str, Any]:
    return value


def _own_pane(ctx: Context, pane: str, pane_id: str) -> tuple[Any, Any, dict[str, Any] | None]:
    """(caller, target pane, failure): a pane in the caller's own workspace."""
    try:
        caller = core._resolve_caller(ctx)
    except core.CallerUnknown as err:
        return None, None, {"ok": False, "error": str(err), "error_code": "caller-unknown"}
    if caller.kind != "pane":
        return caller, None, {
            "ok": False,
            "error": "only a CLI pane can bind or unbind, and only panes in its own workspace; "
                     "ask the user to do it in Settings → Channels",
            "error_code": "pane-caller-required",
        }
    if not pane and not pane_id:
        pane_id = caller.pane_id
    result, failure = core._resolve_pane_target(caller, caller.pane_id, pane, pane_id)
    if failure is not None:
        return caller, None, failure
    if result.cross_workspace:
        return caller, None, {
            "ok": False,
            "error": "that pane is in another workspace; binding it to a chat is the user's call — "
                     'open the Channels page with ui_invoke ui.settings.open {tab: "channels"} and ask them',
            "error_code": "cross-workspace",
        }
    return caller, result.pane, None


async def _act(ctx: Context, tool: str, target: dict[str, Any], run: Any, *, caller: Any = None) -> dict[str, Any]:
    """Run one change on the manager, record it with the caller and show it in Navide."""
    from agent_team_backend import agent_window_actions, app
    from agent_team_backend.ipc import make_event

    if caller is None:
        try:
            caller = core._resolve_caller(ctx)
        except core.CallerUnknown as err:
            return {"ok": False, "error": str(err), "error_code": "caller-unknown"}
    manager = _manager()
    if manager is None:
        return dict(_NOT_RUNNING)
    try:
        answer = await run(manager)
    except ValueError as err:
        answer = _bad_request(err)
    answer = _scrub(answer)
    if not answer.get("ok") and "error_code" not in answer:
        answer["error_code"] = "channels-refused"
    who = core._caller_view(caller)
    agent_window_actions.record(tool, who, target, ok=bool(answer.get("ok")), error=str(answer.get("error") or ""))
    if answer.get("ok"):
        await app.broadcast_main_windows(make_event("channels.agent_action", {
            "tool": tool, "caller": who.get("address") or who.get("kind", ""), "target": target,
        }))
    return answer

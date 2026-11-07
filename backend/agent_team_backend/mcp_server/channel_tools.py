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
import time
from typing import Any

from mcp.server.fastmcp import Context

from ..channels import agent_requests, redact
from ..channels.pairing import normalize_code
from ..channels.registry import PLATFORMS
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
    expires_at, url, id} or {ok: false, error, error_code}; pass `id` to
    channels_request_status to learn when the chat is linked (`result`
    {chat_id, title, kind}) or waits for the user (`pairing_code`).
    """
    answer = await _act(ctx, "channels_link_code", {"platform": platform, "account": account or DEFAULT_ACCOUNT},
                        lambda m: _sync(m.link_create(platform, target, account or DEFAULT_ACCOUNT)))
    if answer.get("ok"):
        caller = core._resolve_caller(ctx)
        record = agent_requests.registry.file(
            "link", core._caller_view(caller), "", {"platform": platform, "code": answer["code"]},
            ttl_s=max(0.0, float(answer.get("expires_at") or 0) - time.time()),
        )
        answer["id"] = record["id"]
    return answer


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
    reason: str = "",
) -> dict[str, Any]:
    """Bind a chat to a pane, so its messages reach that pane and it hears the pane.

    Only a CLI pane may call this. `pane` (a name, addressed as in cli_send)
    or `pane_id` picks the pane; with neither it is you. A pane in your own
    workspace, on a chat the bot knows and someone was let in from, is bound
    at once. Otherwise — another workspace's pane, a chat the bot has not
    seen, or one nobody there was let in from yet — the bind goes to the
    user: Navide shows it in the main window with `reason`, and the answer is
    {ok, id, status: "pending", why, expires_at, note}; follow it with
    channels_request_status. `chat_id` comes from
    channels_chats; `account` is the bot ("default" when omitted). `mode`
    "existing" uses the chat (and `thread_id`'s topic) as it is; "new" makes a
    new topic titled `title` where the platform can. `verbosity` is how much
    of the pane's activity the chat gets: replies, minimal, standard or full
    (a new binding defaults to replies, a re-bind keeps the pane's level).

    A chat drives one pane at a time: one bound elsewhere is refused. A pane
    holds one chat: binding it to another moves it. The chat is told which
    pane it now drives. Recorded with the caller and shown in Navide.
    Returns {ok, binding} when bound, or {ok: false, error, error_code}.
    """
    caller, target, failure = _own_pane(ctx, pane, pane_id, allow_other_workspace=True)
    if failure is not None:
        return failure
    account = account or DEFAULT_ACCOUNT
    manager = _manager()
    if manager is None:
        return dict(_NOT_RUNNING)
    why = _bind_needs_user(manager, platform, account, chat_id, target.cross_workspace)
    if why:
        return await _file_request(caller, "bind", reason=f"{why} {reason}".strip(), target={
            "platform": platform, "account": account, "chat_id": chat_id, "thread_id": thread_id,
            "mode": mode, "title": title, "verbosity": verbosity, "pane_id": target.pane.pane_id,
            "pane": target.pane.name, "workspace_path": target.pane.workspace_path, "why": why,
        })
    pane_entry = target.pane
    return await _act(ctx, "channels_bind",
                      {"platform": platform, "account": account, "chat_id": chat_id,
                       "pane_id": pane_entry.pane_id, "pane": pane_entry.name},
                      lambda m: m.bind(pane_entry.pane_id, pane_entry.name, platform, mode, chat_id, thread_id, title,
                                       verbosity=verbosity, account=account),
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


# ── P2: what the user decides in the main window ────────────────────────────

_REQUEST_NOTE = (
    "Navide shows this request in the main window with who asked and why; nothing happens until "
    "the user decides there. Follow it with channels_request_status(id, wait_s)."
)


@core.server.tool()
async def channels_bot_add_open(platform: str, ctx: Context) -> dict[str, Any]:
    """Open the add-a-bot form for `platform` in Navide, empty, for the user.

    Use it when the user wants to add the bot themselves: call it, then stop
    and wait. The bot's credential (a token from BotFather, say) is typed
    only into that form — never pass it to any tool, and if the user pastes
    one into this conversation, tell them to paste it into the form instead.
    Returns {ok, opened: true, platform, note} or {ok: false, error,
    error_code} ("no-main-window", "bad-request").
    """
    from agent_team_backend import app
    from agent_team_backend.ipc import make_event

    caller, failure = _pane_caller(ctx)
    if failure is not None:
        return failure
    if platform not in PLATFORMS:
        return _bad_request(ValueError(f"unknown platform {platform!r}"))
    if not app.has_main_window():
        return {"ok": False, "error": "no Navide main window is open", "error_code": "no-main-window"}
    await app.broadcast_main_windows(make_event("channels.agent_form.open", {
        "platform": platform, "requester": core._caller_view(caller)}))
    return {"ok": True, "opened": True, "platform": platform,
            "note": "The form is open in Navide; nothing is added until the user presses Add there."}


@core.server.tool()
async def channels_bot_add_fill(platform: str, ctx: Context, name: str = "", reason: str = "") -> dict[str, Any]:
    """Ask the user to add a bot, with its form filled in as far as you can.

    Navide opens the add-a-bot form for `platform` with `name` written in
    and marked as yours, and shows `reason`. The bot's credential is the one
    field you cannot fill: the user types it there and presses Add, and it
    never reaches you. (A Telegram bot can also be made with no credential
    handled by anyone: channels_managed_bot_create.) Returns {ok, id, status:
    "pending", expires_at, note}; channels_request_status(id) reports
    `result` {platform, account} once the bot is added.
    """
    caller, failure = _pane_caller(ctx)
    if failure is not None:
        return failure
    if platform not in PLATFORMS:
        return _bad_request(ValueError(f"unknown platform {platform!r}"))
    return await _file_request(caller, "bot-add", reason=reason, target={"platform": platform},
                               draft={"name": name.strip()[:80]})


@core.server.tool()
async def channels_managed_bot_create(
    ctx: Context, manager_account: str = "", username: str = "", name: str = "",
) -> dict[str, Any]:
    """Make a new Telegram bot through a bot in Telegram's Bot Management Mode.

    `manager_account` is the managing bot's id from channels_status
    ("default" when omitted); it must be connected, in Bot Management Mode
    (BotFather) and have someone linked to it. Returns {ok, id, url,
    expires_at, note}: give `url` (t.me/newbot/…) to that linked person; when
    they press Create in Telegram, Navide fetches the new bot's credential
    from Telegram itself and adds the bot — no one, you included, handles
    the credential. channels_request_status(id) reports `result` {account,
    name, link} once added (10 minutes at most). Navide cannot delete a bot
    from Telegram afterwards. Recorded with the caller and shown in Navide.
    """
    caller, failure = _pane_caller(ctx)
    if failure is not None:
        return failure
    manager_account = manager_account or DEFAULT_ACCOUNT
    answer = await _act(ctx, "channels_managed_bot_create", {"platform": "telegram", "account": manager_account},
                        lambda m: _sync(m.managed_create(manager_account, username, name)), caller=caller)
    if not answer.get("ok"):
        return answer
    from agent_team_backend.channels.manager import MANAGED_REQUEST_TTL_S

    record = agent_requests.registry.file(
        "managed-create", core._caller_view(caller), "",
        {"request_id": answer["request_id"], "manager_account": manager_account}, ttl_s=MANAGED_REQUEST_TTL_S,
    )
    return {"ok": True, "id": record["id"], "url": answer["url"], "expires_at": record["expires_at"],
            "note": "Give the url to the person linked to the managing bot; they press Create in Telegram."}


@core.server.tool()
async def channels_pairing_approve_request(
    platform: str, code: str, ctx: Context, bind_pane: str = "", bind_pane_id: str = "", reason: str = "",
) -> dict[str, Any]:
    """Ask the user to let a person in (a code from channels_pairing_requests).

    Letting someone in lets them drive a pane, so the user decides it in the
    main window; you cannot. Name `bind_pane` (as in cli_send) or
    `bind_pane_id` to have the user's approval also bind that person's chat
    to the pane, in one press. Returns {ok, id, status: "pending",
    expires_at, note}; channels_request_status(id) reports `result`
    {sender_id, binding?, bind_error?} once approved.
    """
    caller, failure = _pane_caller(ctx)
    if failure is not None:
        return failure
    manager = _manager()
    if manager is None:
        return dict(_NOT_RUNNING)
    wanted = normalize_code(code)
    req = next((r for r in manager.store.list_pairing(platform or None) if r.code == wanted), None)
    if req is None:
        return {"ok": False, "error": "no pairing request has that code (it may have expired)",
                "error_code": "unknown-code"}
    target: dict[str, Any] = {
        "platform": req.platform, "account": req.account, "code": req.code, "sender_id": req.sender_id,
        "sender_name": req.sender_name, "chat_id": req.chat_id, "bind_pane_id": "", "bind_pane": "",
        "workspace_path": "",
    }
    if bind_pane or bind_pane_id:
        result, failure = core._resolve_pane_target(caller, caller.pane_id, bind_pane, bind_pane_id)
        if failure is not None:
            return failure
        target.update(bind_pane_id=result.pane.pane_id, bind_pane=result.pane.name,
                      workspace_path=result.pane.workspace_path)
    return await _file_request(caller, "pairing-approve", reason=reason, target=target)


@core.server.tool()
async def channels_bot_remove_request(platform: str, account: str, ctx: Context, reason: str = "") -> dict[str, Any]:
    """Ask the user to remove a bot from Navide.

    Removing deletes the bot's stored credential, the people let in and its
    bindings, so the user decides it in the main window. Returns {ok, id,
    status: "pending", expires_at, note}; channels_request_status(id) follows
    it.
    """
    caller, failure = _pane_caller(ctx)
    if failure is not None:
        return failure
    manager = _manager()
    if manager is None:
        return dict(_NOT_RUNNING)
    if (platform, account) not in manager.store.accounts():
        return {"ok": False, "error": f"no bot {platform}/{account} is set up", "error_code": "unknown-bot"}
    return await _file_request(caller, "bot-remove", reason=reason, target={"platform": platform, "account": account})


@core.server.tool()
async def channels_request_status(id: str, ctx: Context, wait_s: float = 0) -> dict[str, Any]:  # noqa: A002
    """Where a channels request you made stands.

    `id` is what channels_bind, channels_bot_add_fill,
    channels_pairing_approve_request, channels_bot_remove_request,
    channels_managed_bot_create or channels_link_code answered. `wait_s` (at
    most 60) waits for it to settle. Returns {ok, id, kind, status, result,
    error, reason, target, created_at, expires_at}: status is pending,
    applying, completed, failed, rejected (the user said no) or expired. A
    link code still waiting on the user adds `pairing_code`. Only the pane
    that made a request can read it; a backend restart forgets every request
    ({ok: false, error_code: "unknown-request"}).
    """
    caller, failure = _pane_caller(ctx)
    if failure is not None:
        return failure
    record = await agent_requests.wait(id, wait_s)
    if record is None or record["requester"].get("pane_id") != caller.pane_id:
        return {"ok": False, "error": "no request with that id is yours (a restart forgets them)",
                "error_code": "unknown-request"}
    view = {"ok": True, **_scrub(agent_requests.public(record))}
    view.pop("requester", None)
    manager = _manager()
    if record["kind"] == "link" and record["status"] == "pending" and manager is not None:
        pairing_code = agent_requests.link_stage(manager, record["target"]["code"])
        if pairing_code:
            view["pairing_code"] = pairing_code
    return view


def _bind_needs_user(manager: Any, platform: str, account: str, chat_id: str, cross_workspace: bool) -> str:
    """Why a bind is the user's to allow, or "" when an agent may make it."""
    if cross_workspace:
        return "The pane is in another workspace."
    try:
        chats = manager.locations(platform, account).get("locations") or []
    except ValueError:
        return ""  # the bind itself answers the bad id
    chat = next((c for c in chats if str(c.get("chat_id")) == str(chat_id)), None)
    if chat is None:
        return "The bot has not seen this chat."
    if not manager._chat_usable(platform, account, str(chat_id), str(chat.get("kind") or "")):  # noqa: SLF001
        return "Nobody in this chat has been let in yet."
    return ""


async def _file_request(caller: Any, kind: str, *, reason: str, target: dict[str, Any],
                        draft: dict[str, Any] | None = None) -> dict[str, Any]:
    """File a request for the main window, record it, show it, answer the agent."""
    from agent_team_backend import agent_window_actions, app

    who = core._caller_view(caller)
    if not app.has_main_window():
        agent_window_actions.record(f"channels_request:{kind}", who, target, ok=False, error="no main window")
        return {"ok": False, "error": "no Navide main window is open to decide it", "error_code": "no-main-window"}
    record = agent_requests.registry.file(kind, who, reason, target, draft=draft)
    agent_window_actions.record(f"channels_request:{kind}", who, {**target, "request_id": record["id"]}, ok=True)
    await agent_requests.announce(record)
    answer = {"ok": True, "id": record["id"], "status": record["status"], "expires_at": record["expires_at"],
              "note": _REQUEST_NOTE}
    if target.get("why"):
        answer["why"] = target["why"]
    return answer


def _pane_caller(ctx: Context) -> tuple[Any, dict[str, Any] | None]:
    try:
        caller = core._resolve_caller(ctx)
    except core.CallerUnknown as err:
        return None, {"ok": False, "error": str(err), "error_code": "caller-unknown"}
    if caller.kind != "pane":
        return caller, dict(_PANE_CALLER_REQUIRED)
    return caller, None


# ── helpers for the tools that change something ─────────────────────────────


_PANE_CALLER_REQUIRED = {
    "ok": False,
    "error": "only a CLI pane can change chat channels, so the record can say which pane did it; "
             "ask the user to do it in Settings → Channels",
    "error_code": "pane-caller-required",
}


def _bad_request(err: Exception) -> dict[str, Any]:
    return {"ok": False, "error": str(err), "error_code": "bad-request"}


async def _sync(value: dict[str, Any]) -> dict[str, Any]:
    return value


def _own_pane(ctx: Context, pane: str, pane_id: str, *,
              allow_other_workspace: bool = False) -> tuple[Any, Any, dict[str, Any] | None]:
    """(caller, target, failure): a pane in the caller's own workspace. With
    ``allow_other_workspace`` any pane resolves and the target is the whole
    resolution (``.pane``, ``.cross_workspace``) for the caller to judge."""
    try:
        caller = core._resolve_caller(ctx)
    except core.CallerUnknown as err:
        return None, None, {"ok": False, "error": str(err), "error_code": "caller-unknown"}
    if caller.kind != "pane":
        return caller, None, dict(_PANE_CALLER_REQUIRED)
    if not pane and not pane_id:
        pane_id = caller.pane_id
    result, failure = core._resolve_pane_target(caller, caller.pane_id, pane, pane_id)
    if failure is not None:
        return caller, None, failure
    if allow_other_workspace:
        return caller, result, None
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
    if caller.kind != "pane":
        # The record names the pane that made each change; a host or external
        # client has none, so its changes are the user's, in Settings → Channels.
        return dict(_PANE_CALLER_REQUIRED)
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

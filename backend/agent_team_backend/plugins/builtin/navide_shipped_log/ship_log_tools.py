"""The ``ship_log_*`` MCP tools: the ``navide.shipped-log`` plugin's contribution."""

from __future__ import annotations

import asyncio
from typing import Any

from mcp.server.fastmcp import Context
from mcp.types import ToolAnnotations

from agent_team_backend.mcp_server.toolkit import caller_workspace, resolve_caller
from agent_team_backend.plugins.builtin.navide_shipped_log import report as ship_report
from agent_team_backend.plugins.builtin.navide_shipped_log.ledger import LedgerError, ledger

PLUGIN_ID = "navide.shipped-log"


def _pane_label(caller: Any) -> str:
    from agent_team_backend import agent_messaging

    pane_id = getattr(caller, "pane_id", "") or ""
    pane = agent_messaging.current(pane_id) if pane_id else None
    return str(getattr(pane, "name", "") or pane_id)


def _language() -> str:
    from agent_team_backend import app, prompt_skills

    try:
        return prompt_skills.language(app.ui_settings_store.get())
    except Exception:  # noqa: BLE001 - the default language still reads
        return prompt_skills.DEFAULT_LANGUAGE


async def ship_log_record(
    summary: str,
    source_kind: str,
    ctx: Context,
    ref: str = "",
    at: str = "",
    sensitive: bool | None = None,
    workspace_path: str = "",
) -> dict[str, Any]:
    """Record one change that just went live in production, for the Shipped Log.

    Call it after a deploy, a migration or a production setting change has
    actually taken effect — not when it was merged or started.

    summary: one plain-language line saying what changed for the user, e.g.
    "Sender address moved to the new domain". Never a value: no keys,
    passwords, tokens, connection strings or setting values. An entry that
    looks like it carries a secret is refused, not masked.
    source_kind: commit | config | migration | other. config is for a
    production setting outside git; it is sensitive unless you say otherwise.
    ref: optional pointer — the commit hash for a commit (one entry per hash),
    for config the setting's key from ship_log_config_register, a migration
    name, a ticket id. One token, never a value.
    at: optional ISO 8601 time it went live; default now.
    sensitive: shown only as a count when the log is pushed to a chat.

    The ledger lives in the workspace's local .agent-team/navide.db, which
    never leaves the machine. workspace_path defaults to your own pane's
    workspace. Returns {ok, recorded, duplicate, at, source_kind, sensitive}
    or {ok: false, error}.
    """
    caller = resolve_caller(ctx)
    workspace_path = await caller_workspace(caller, workspace_path)
    try:
        when = int(ship_report.parse_moment(at).timestamp()) if (at or "").strip() else None
    except ship_report.WindowError as err:
        return {"ok": False, "error": str(err)}
    try:
        result = await asyncio.to_thread(
            ledger.record, workspace_path, summary=summary, source_kind=source_kind, ref=ref,
            at=when, sensitive=sensitive, pane=_pane_label(caller),
        )
    except LedgerError as err:
        return {"ok": False, "error": str(err)}
    if result.get("disabled"):
        return {"ok": False, "error": f"the ship log ledger is disabled in this workspace: {result['disabled']}"}
    if source_kind == "config" and ref.strip():
        known = await asyncio.to_thread(ledger.configs, workspace_path)
        if ref.strip() not in {c["key"] for c in known["configs"]}:
            result["warning"] = (f"{ref.strip()!r} is not a registered production setting; "
                                 "ship_log_config_register adds it by name and location")
    return result


def _public(item: dict[str, Any]) -> dict[str, Any]:
    out = dict(item)
    if out.get("sensitive"):
        out.pop("ref", None)
    return out


async def ship_log_report(
    since: str,
    ctx: Context,
    until: str = "",
    format: str = "text",  # noqa: A002 - the tool's documented parameter name
    branch: str = "",
    workspace_path: str = "",
) -> dict[str, Any]:
    """What went live in this workspace in a time window, as one list.

    Merges the Shipped Log ledger (ship_log_record entries) with the deploy
    branch's first-parent commits and the tags created in the window. Each
    item names its basis: agent (recorded), branch (a commit on the deploy
    branch — merged there, which is not proof it was deployed), tag, or hook
    (a deploy command a CLI hook saw run, not yet confirmed — record it with
    ship_log_record once it is live); a commit from several sources is one
    item, deduplicated by hash.

    since: 今天/today, 昨天/yesterday, 7d, 12h, or an ISO 8601 date/time.
    until: optional ISO 8601 end; default now.
    format: text (one line per item) or json (the items).
    branch: the deploy branch; default main, else master.

    A sensitive item keeps its summary here but never its ref. Returns
    {ok, since, until, branch, count, pending_detections, text | items,
    warnings}.
    """
    if format not in ship_report.FORMATS:
        return {"ok": False, "error": f"format must be one of {', '.join(ship_report.FORMATS)}"}
    caller = resolve_caller(ctx)
    workspace_path = await caller_workspace(caller, workspace_path)
    try:
        start, end = ship_report.parse_window(since, until)
    except ship_report.WindowError as err:
        return {"ok": False, "error": str(err)}
    built = await ship_report.build_report(workspace_path, start, end, branch=branch)
    head = {k: built[k] for k in ("since", "until", "branch", "count", "omitted", "pending_detections", "warnings")}
    if format == "json":
        return {"ok": True, **head, "items": [_public(i) for i in built["items"]]}
    return {"ok": True, **head, "text": ship_report.render_text(built, _language(), for_chat=False)}


async def ship_log_config_register(
    key: str,
    ctx: Context,
    location: str = "",
    label: str = "",
    environment: str = "",
    note: str = "",
    remove: bool = False,
    workspace_path: str = "",
) -> dict[str, Any]:
    """Register one production setting by its name and where it lives — never its value.

    The register answers "which production settings does this project have,
    and where would I change them" without holding a single value. Register a
    setting when you create or first touch it, then record each change with
    ship_log_record(source_kind="config", ref=<key>).

    key: one token naming the setting, e.g. mail.sender or stripe.webhook.
    location: where it lives — a console page, a parameter-store path, an env
    file on a host ("SSM /app/prod/mail_from", "ECS task def api-prod, env").
    label: what it is in words; default the key. environment: default
    production. note: optional.
    remove: unregister the key (its history stays).

    A field that looks like a value — KEY=value, a URL with a login, a token,
    key or password — is refused, not masked. Kept in the workspace's local
    .agent-team/navide.db only. Returns {ok, key, created | updated | removed}
    or {ok: false, error}.
    """
    caller = resolve_caller(ctx)
    workspace_path = await caller_workspace(caller, workspace_path)
    try:
        return await asyncio.to_thread(
            ledger.register_config, workspace_path, key=key, label=label, location=location,
            environment=environment, note=note, remove=remove,
        )
    except LedgerError as err:
        return {"ok": False, "error": str(err)}


async def ship_log_config_list(ctx: Context, include_removed: bool = False, workspace_path: str = "") -> dict[str, Any]:
    """The production settings registered in this workspace: key, label, where it lives, environment.

    Names and places only — the register never holds a value. Returns
    {ok, configs: [{key, label, location, environment, note, updated_at,
    removed_at}]}.
    """
    caller = resolve_caller(ctx)
    workspace_path = await caller_workspace(caller, workspace_path)
    answer = await asyncio.to_thread(ledger.configs, workspace_path, include_removed=include_removed)
    if answer.get("disabled"):
        return {"ok": False, "error": f"the ship log ledger is disabled in this workspace: {answer['disabled']}"}
    return answer


SHIP_LOG_TOOLS = (ship_log_record, ship_log_report, ship_log_config_register, ship_log_config_list)


def install(server: Any) -> None:
    """Add the ship log tools to the core MCP server (see PluginContext.register_mcp_tools)."""
    from agent_team_backend.mcp_server.server import hide_tools_while_plugin_disabled

    for tool, read_only in ((ship_log_record, False), (ship_log_report, True),
                            (ship_log_config_register, False), (ship_log_config_list, True)):
        server.tool(annotations=ToolAnnotations(
            readOnlyHint=read_only, destructiveHint=False, idempotentHint=True, openWorldHint=False,
        ))(tool)
    hide_tools_while_plugin_disabled(PLUGIN_ID, [tool.__name__ for tool in SHIP_LOG_TOOLS])

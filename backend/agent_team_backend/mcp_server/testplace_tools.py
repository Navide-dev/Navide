"""Testplace invitation tools (W5): open and fill the main window's invite form.

Same pair as the W3 developer forms (marketplace_forms.py): ``_open`` opens
the form, ``_fill`` files the agent's invitee list as a draft. Only the
user's Submit creates invitations; the join tokens the Registry returns are
shown to the user in that form and never reach the agent.
"""

from __future__ import annotations

from typing import Any

from mcp.server.fastmcp import Context

# The module, not its names: server.py imports both modules at its end, so
# when marketplace_forms is imported first it is still loading here.
from agent_team_backend.mcp_server import marketplace_forms as _forms
from agent_team_backend.mcp_server.server import _marketplace_error, _package_id, server

MAX_INVITEES = 100
"""Live invitations per Navide plugin (the Registry's own cap)."""
MAX_LABEL_LENGTH = 120


def _plugin_target(namespace: Any, name: Any) -> tuple[dict[str, Any] | None, str | None]:
    plugin_id = _package_id(namespace, name)
    if plugin_id is None:
        return None, "namespace and name must be a Navide plugin id <namespace>.<name>"
    return {"id": plugin_id, "namespace": namespace, "name": name}, None


@server.tool()
async def marketplace_testplace_invite_open(
    ctx: Context, namespace: str = "", name: str = "",
) -> dict[str, Any]:
    """Open the Testplace invitation form in Navide for one of the user's Navide plugins.

    Use this when the user wants to invite testers themselves: call it, then
    stop and wait for them. The id is optional; the user picks the Navide
    plugin, writes who to invite and presses Send. Testers get an invite
    link from the user, sign in to Navide Cloud and install the test build;
    nobody else can see or download it.

    Returns {ok, opened: true, form: "testplace-invite", note}.
    """
    prefill: dict[str, str] = {}
    if namespace or name:
        target, error = _plugin_target(namespace, name)
        if error:
            return _marketplace_error("BAD_REQUEST", error)
        prefill = {"id": target["id"]}
    return await _forms._open_form(ctx, "testplace-invite", prefill)


@server.tool()
async def marketplace_testplace_invite_fill(
    ctx: Context, namespace: str, name: str, invitees: list[str], reason: str = "",
) -> dict[str, Any]:
    """Prepare Testplace invitations for one of the user's Navide plugins, as a draft.

    Use this when the user asked you to invite testers for them; you need not
    call marketplace_testplace_invite_open first. `invitees` names each
    tester for the user (an email address or a short note, up to 120
    characters each, at most 100). Navide opens the invitation form with
    your list, each entry marked as written by an agent; the user reviews it
    and presses Send themselves. This tool invites nobody, and the invite
    links Navide creates are shown only to the user, never returned here.

    Returns {ok, approval_id, status: "pending", expires_at, note}; follow it
    with marketplace_request_status.
    """
    target, error = _plugin_target(namespace, name)
    if error:
        return _marketplace_error("BAD_REQUEST", error)
    if (
        not isinstance(invitees, list)
        or not 1 <= len(invitees) <= MAX_INVITEES
        or any(not isinstance(item, str) or not item.strip() or len(item) > MAX_LABEL_LENGTH for item in invitees)
    ):
        return _marketplace_error(
            "BAD_REQUEST",
            f"invitees must be 1-{MAX_INVITEES} non-empty strings of up to {MAX_LABEL_LENGTH} characters",
        )
    fields = {"invitees": [item.strip() for item in invitees]}
    return await _forms._file_form_draft(ctx, "testplace-invite", target, fields, reason)

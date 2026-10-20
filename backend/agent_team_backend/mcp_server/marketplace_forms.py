"""Navide Marketplace developer tools: open and fill the main window's forms (W3).

Design principles P1-P5 of plan mcp-navide-0-2-27:

- Every form has a pair of tools. ``*_open`` opens the form in a Navide main
  window, empty or with locating data only (a package path, an id and
  version); nothing is filed. ``*_fill`` files the agent's field values as a
  draft (``skills_approvals.registry.request_form``): the window opens the
  same form with every agent-written field marked, the user reads and edits
  it, and only the user's Submit sends anything (``plugins.agent_request.decide``
  with a confirmation only a main window can mint, then
  ``plugins.agent_request.finish``). No tool here can submit.
- The publisher token and the signing key stay in the Navide Host (main
  process, safeStorage). They are never an argument or part of an answer:
  the status tools ask the Host, which calls the Registry itself and answers
  with states, reasons and the user's own application, and
  :func:`_without_secrets` drops anything shaped like a credential on the way
  out as a second line of defence.
- Nothing here logs a field value: the draft holds the user's identity data.

``_open_form`` and ``_file_form_draft`` are shared with the Testplace
invitation tools (W5).
"""

from __future__ import annotations

import os
import re
import secrets
from typing import Any

from mcp.server.fastmcp import Context

from agent_team_backend.mcp_server import server as _core
from agent_team_backend.mcp_server.server import (
    CallerUnknown,
    _approval_requester,
    _audit_agent_action,
    _marketplace_error,
    _package_id,
    _MQ_SEMVER,
    server,
)
from agent_team_backend.pending_registry import TIMEOUT, PendingRegistry

_DEVELOPER_QUERY_TIMEOUT_S = 30.0
_developer_query_pending: PendingRegistry[dict[str, Any]] = PendingRegistry()
_TARGET = re.compile(r"[a-z0-9][a-z0-9-]{0,63}")
#: Registry publisher tokens (``nva_``/``nvp_``...), PEM blocks and anything a
#: key or token field would carry: never part of an answer to an agent.
_SECRET_TEXT = re.compile(
    r"\bnv[a-z]_[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*KEY-----[\s\S]*?(?:-----END [A-Z ]*KEY-----|\Z)"
)
#: A key whose normalised name contains one of these is dropped whatever its value.
_SECRET_KEY_PARTS = ("token", "secret", "privatekey", "apikey", "password")
_OPEN_NOTE = (
    "The form is open in Navide for the user to fill in. If the user wants to fill it in "
    "themselves, stop here and wait for them; nothing is sent until they press Submit."
)
_FILL_NOTE = (
    "Your draft is open in Navide's form, each field marked as written by an agent. The user "
    "reviews and edits it and presses Submit themselves; poll marketplace_request_status."
)


def _secret_key(key: Any) -> bool:
    normalised = re.sub(r"[^a-z]", "", str(key).lower())
    return any(part in normalised for part in _SECRET_KEY_PARTS)


def _without_secrets(value: Any) -> Any:
    """``value`` with credential-shaped keys dropped and credential-shaped text redacted."""
    if isinstance(value, dict):
        return {k: _without_secrets(v) for k, v in value.items() if not _secret_key(k)}
    if isinstance(value, list):
        return [_without_secrets(v) for v in value]
    if isinstance(value, str) and _SECRET_TEXT.search(value):
        return _SECRET_TEXT.sub("[redacted]", value)
    return value


def resolve_developer_query(request_id: str, response: dict[str, Any]) -> bool:
    """Resolve one ``marketplace.developer.request`` with the Host's answer."""
    return _developer_query_pending.resolve(request_id, response)


async def _request_host_developer(query: dict[str, Any]) -> dict[str, Any]:
    """Ask the authenticated Host one developer query; ``{ok, result}`` or an error."""
    from agent_team_backend import app
    from agent_team_backend.ipc import make_event
    from agent_team_backend.plugins import agent_tools_contract as contract

    request_id = f"md:{secrets.token_hex(16)}"
    future = _developer_query_pending.register(request_id)
    try:
        sent = await app.unicast_host(
            make_event(contract.MARKETPLACE_DEVELOPER_REQUEST_EVENT, {"request_id": request_id, "query": query})
        )
        if not sent:
            return _marketplace_error("HOST_UNAVAILABLE", "Navide Host is not connected")
        result = await _developer_query_pending.wait(request_id, future, timeout=_DEVELOPER_QUERY_TIMEOUT_S)
        if result is TIMEOUT:
            return _marketplace_error("HOST_UNAVAILABLE", "Navide Host did not answer the developer query")
        return result
    finally:
        _developer_query_pending.discard(request_id)


async def _open_form(ctx: Context, form: str, prefill: dict[str, str]) -> dict[str, Any]:
    """Open ``form`` in the main windows with ``prefill`` (locating data only)."""
    from agent_team_backend import app
    from agent_team_backend.ipc import make_event
    from agent_team_backend.plugins import agent_tools_contract as contract

    try:
        caller = _core._resolve_caller(ctx)
    except CallerUnknown as err:
        return {"ok": False, "error": str(err)}
    if form not in contract.MARKETPLACE_FORMS:
        return _marketplace_error("BAD_REQUEST", f"unknown form {form!r}")
    if not app.has_main_window():
        return _marketplace_error("HOST_UNAVAILABLE", "no Navide main window is open")
    requester = _approval_requester(caller)
    await app.broadcast_main_windows(make_event(
        contract.MARKETPLACE_FORM_OPEN_EVENT, {"form": form, "prefill": prefill, "requester": requester},
    ))
    return {"ok": True, "opened": True, "form": form, "note": _OPEN_NOTE}


async def _file_form_draft(
    ctx: Context, kind: str, target: dict[str, Any], fields: dict[str, Any], reason: Any,
) -> dict[str, Any]:
    """File the agent's draft for a form; the window opens it, the user submits it."""
    from agent_team_backend import app, skills_approvals
    from agent_team_backend.ipc import make_event
    from agent_team_backend.plugins import agent_tools_contract as contract

    try:
        caller = _core._resolve_caller(ctx)
    except CallerUnknown as err:
        return {"ok": False, "error": str(err)}
    requester = _approval_requester(caller)
    action = f"request-{kind}"
    plugin_id = str(target.get("id") or "")

    def refuse(code: str, error: str) -> dict[str, Any]:
        _audit_agent_action(caller, requester, plugin_id=plugin_id, action=action,
                            outcome="error" if code == "HOST_UNAVAILABLE" else "denied", error_code=code)
        return _marketplace_error(code, error)

    if not isinstance(reason, str):
        return refuse("BAD_REQUEST", "reason must be a string")
    if not app.has_main_window():
        return refuse("HOST_UNAVAILABLE", "no Navide main window is open")
    draft = {"fields": fields, "field_sources": {key: "agent-draft" for key in fields}}
    try:
        record = skills_approvals.registry.request_form(
            kind=kind, requester=requester, reason=reason, target=target, draft=draft,
        )
    except skills_approvals.SkillApprovalError as err:
        return refuse(err.code, str(err))
    _audit_agent_action(caller, requester, plugin_id=plugin_id, plugin_version=str(target.get("version") or ""),
                        action=action, outcome="allowed", approval_id=record["approval_id"])
    await app.broadcast_main_windows(make_event(contract.PLUGIN_APPROVAL_REQUEST_EVENT, record))
    return {
        "ok": True,
        "approval_id": record["approval_id"],
        "status": record["status"],
        "expires_at": record["expires_at"],
        "note": _FILL_NOTE,
    }


def _package_path_error(path: Any) -> str | None:
    if not isinstance(path, str) or not os.path.isabs(path) or len(path) > 1024:
        return "path must be an absolute path to a .vsix package"
    if not path.lower().endswith(".vsix") or "\x00" in path:
        return "path must be an absolute path to a .vsix package"
    return None


def _version_target(namespace: Any, name: Any, version: Any) -> tuple[dict[str, Any] | None, str | None]:
    plugin_id = _package_id(namespace, name)
    if plugin_id is None:
        return None, "namespace and name must be a Navide plugin id <namespace>.<name>"
    if not (isinstance(version, str) and _MQ_SEMVER.fullmatch(version)):
        return None, "version must be a SemVer version such as 1.2.0"
    return {"id": plugin_id, "namespace": namespace, "name": name, "version": version}, None


# ── developer application (S0, S3c) ─────────────────────────────────────────


@server.tool()
async def marketplace_developer_application_open(ctx: Context) -> dict[str, Any]:
    """Open the Navide Marketplace developer application form in Navide for the user.

    Use this when the user wants to fill the application in themselves: call
    it, then stop and wait for them. Navide brings in what it already has (the
    user's earlier application, if any); everything else is left blank, and
    nothing is sent until the user presses Submit.

    Returns {ok, opened: true, form: "developer-application", note}.
    """
    return await _open_form(ctx, "developer-application", {})


@server.tool()
async def marketplace_developer_application_fill(
    ctx: Context, fields: dict[str, Any], reason: str = "",
) -> dict[str, Any]:
    """Fill in the Navide Marketplace developer application for the user, as a draft.

    Use this when the user asked you to fill it in for them; you need not call
    marketplace_developer_application_open first. Any field may be filled,
    identity included: applicant_type ("individual" or "organization"),
    legal_name, display_name, contact_email, country (ISO 3166-1 alpha-2),
    intended_namespace, description (up to 1000 characters), agreed_terms
    (true only if the user agreed), organization_name and organization_id
    (organizations), website, source_url, needs_native_backend (true/false),
    domain. Navide opens the form with your values, each marked as written
    by an agent, and says the application goes to Navide Cloud's developer
    review. The user reviews, edits and presses Submit themselves; this tool
    sends nothing.

    Returns {ok, approval_id, status: "pending", expires_at, note}; follow it
    with marketplace_request_status, and marketplace_developer_status for
    the review.
    """
    from agent_team_backend.plugins import agent_tools_contract as contract

    if not isinstance(fields, dict) or not fields:
        return _marketplace_error("BAD_REQUEST", "fields must be an object of application fields")
    unknown = sorted(str(key) for key in fields if key not in contract.DEVELOPER_APPLICATION_FIELDS)
    if unknown:
        return _marketplace_error(
            "BAD_REQUEST",
            f"unknown application fields: {', '.join(unknown)}; the fields are "
            + ", ".join(contract.DEVELOPER_APPLICATION_FIELDS),
        )
    if any(not isinstance(value, (str, bool)) for value in fields.values()):
        return _marketplace_error("BAD_REQUEST", "every field value must be a string or true/false")
    target = {"id": "", "namespace": "", "name": ""}
    return await _file_form_draft(ctx, "developer-application", target, dict(fields), reason)


@server.tool()
async def marketplace_developer_status(ctx: Context) -> dict[str, Any]:
    """The user's Navide Marketplace developer standing, read through Navide.

    Read-only. Returns {ok, signed_in: {account, publisher}, namespace,
    key_registered, application: {status, fields, field_sources, source,
    reason, submitted_at, decided_at} | null}. status is none, pending,
    approved, rejected or revoked; reason is the reviewer's when rejected or
    revoked. Never carries a token or key. NOT_SIGNED_IN means the user has
    not signed in under Settings > Navide Marketplace > Developer.
    """
    try:
        _core._resolve_caller(ctx)
    except CallerUnknown as err:
        return {"ok": False, "error": str(err)}
    return await _developer_answer({"kind": "developer-status"})


# ── publish (S0, S5, S6) ─────────────────────────────────────────────────────


@server.tool()
async def marketplace_publish_open(ctx: Context, path: str = "") -> dict[str, Any]:
    """Open the Navide Marketplace publish form in Navide for the user.

    Use this when the user wants to publish themselves: call it, then
    stop and wait for them. `path` optionally brings in a .vsix package (an
    absolute path); the user chooses the rest and presses Submit. When the user has
    not signed in as a developer, Navide shows the sign-in first.

    Returns {ok, opened: true, form: "publish", note}.
    """
    if path:
        error = _package_path_error(path)
        if error:
            return _marketplace_error("BAD_REQUEST", error)
    return await _open_form(ctx, "publish", {"path": path} if path else {})


@server.tool()
async def marketplace_publish_fill(
    ctx: Context, path: str, target: str = "", reason: str = "",
) -> dict[str, Any]:
    """Prepare a Navide plugin version for publishing to the Navide Marketplace, as a draft.

    Use this when the user asked you to publish for them; you need not call
    marketplace_publish_open first. `path` is the absolute path of the .vsix
    package, `target` the platform target (empty: from the package). Release
    notes belong in the package's CHANGELOG.md, which the Navide Marketplace
    shows and which is signed with the package. Navide reads the package once and shows the user its
    validation, disclosure and the permission changes from the last version;
    when the user presses Submit, Navide signs it with the key it keeps and
    uploads it for review. You get only the approval_id: no token or key.

    Returns {ok, approval_id, status: "pending", expires_at, note}; follow it
    with marketplace_request_status, then marketplace_publish_status. One
    exception: when Navide itself is set to a Registry on this computer (a
    developer test Registry), it signs and uploads at once and returns
    {ok, loopback: true, published, id, version, digest, status, note}.
    """
    error = _package_path_error(path)
    if error:
        return _marketplace_error("BAD_REQUEST", error)
    if target and not (isinstance(target, str) and _TARGET.fullmatch(target)):
        return _marketplace_error("BAD_REQUEST", "target must be a platform target such as darwin-arm64")
    direct = await _publish_to_loopback(ctx, path, target)
    if direct is not None:
        return direct
    fields = {"path": path, "target": target}
    return await _file_form_draft(ctx, "plugin-publish", {"id": "", "namespace": "", "name": ""}, fields, reason)


async def _publish_to_loopback(ctx: Context, path: str, target: str) -> dict[str, Any] | None:
    """O3: when the Host says its Registry is on this computer, publish at once.

    Only the Host decides that, from the Registry URL Navide is configured
    with; nothing the agent sends can claim it. Any other answer, and any
    failure to get one, is None: the draft goes to the user (fail closed).
    """
    try:
        caller = _core._resolve_caller(ctx)
    except CallerUnknown:
        return None
    answer = await _request_host_developer({"kind": "publish-direct", "path": path, "target": target})
    result = answer.get("result") if answer.get("ok") is True else None
    if not isinstance(result, dict) or result.get("kind") != "publish-direct" or result.get("loopback") is not True:
        return None
    published = result.get("published") is True
    plugin_id = result.get("id") if isinstance(result.get("id"), str) else ""
    version = result.get("version") if isinstance(result.get("version"), str) else ""
    _audit_agent_action(caller, _approval_requester(caller), plugin_id=plugin_id, plugin_version=version,
                        action="publish-loopback", outcome="allowed" if published else "error",
                        error_code="" if published else str(result.get("error_code") or "PUBLISH_FAILED"))
    body = {key: result.get(key) for key in ("id", "version", "digest", "status", "error_code", "error") if key in result}
    return {
        "ok": published,
        "loopback": True,
        "published": published,
        **_without_secrets(body),
        "note": (
            "Navide's Registry is on this computer (a developer test Registry), so the package was signed and "
            "uploaded without the user's Submit. Check it with marketplace_publish_status."
        ),
    }


@server.tool()
async def marketplace_publish_status(ctx: Context, id: str = "") -> dict[str, Any]:  # noqa: A002
    """The review state of the user's own Navide plugin versions in the Navide Marketplace.

    Read-only. `id` (<namespace>.<name>) narrows it to one plugin. Returns
    {ok, namespace, items: [{namespace, name, version, channel, targets,
    status, yanked, reason, submitted_at, reviewed_at}]}; status is pending,
    approved or rejected, reason the reviewer's, and a yanked version says
    yanked: true. NOT_SIGNED_IN means the user has not signed in as a
    developer in Navide.
    """
    try:
        _core._resolve_caller(ctx)
    except CallerUnknown as err:
        return {"ok": False, "error": str(err)}
    namespace, _, name = id.partition(".")
    if id and _package_id(namespace, name) is None:
        return _marketplace_error("BAD_REQUEST", "id must be a Navide plugin id <namespace>.<name>")
    return await _developer_answer({"kind": "publish-status", "id": id})


@server.tool()
async def marketplace_publish_yank_open(
    ctx: Context, namespace: str = "", name: str = "", version: str = "",
) -> dict[str, Any]:
    """Open the yank form for one of the user's published Navide plugin versions.

    Use this when the user wants to yank (withdraw) a version themselves: call
    it, then stop and wait for them. The id and version are optional; the user
    picks and confirms in Navide.

    Returns {ok, opened: true, form: "publish-yank", note}.
    """
    prefill: dict[str, str] = {}
    if namespace or name or version:
        target, error = _version_target(namespace, name, version)
        if error:
            return _marketplace_error("BAD_REQUEST", error)
        prefill = {"id": target["id"], "version": target["version"]}
    return await _open_form(ctx, "publish-yank", prefill)


@server.tool()
async def marketplace_publish_yank_fill(
    ctx: Context, namespace: str, name: str, version: str, reason: str = "",
) -> dict[str, Any]:
    """Ask the user to yank one of their published Navide plugin versions, as a draft.

    Use this when the user asked you to yank a version for them; you need not
    call marketplace_publish_yank_open first. Navide opens the yank form with
    this version chosen; the user confirms it there themselves.
    Yanking withdraws the version from new installs on every target.

    Returns {ok, approval_id, status: "pending", expires_at, note}; follow it
    with marketplace_request_status.
    """
    target, error = _version_target(namespace, name, version)
    if error:
        return _marketplace_error("BAD_REQUEST", error)
    return await _file_form_draft(ctx, "plugin-yank", target, {}, reason)


async def _developer_answer(query: dict[str, Any]) -> dict[str, Any]:
    from agent_team_backend.plugins import agent_tools_contract as contract

    answer = await _request_host_developer(query)
    if answer.get("ok") is not True:
        code = answer.get("error_code")
        codes = (*contract.MARKETPLACE_QUERY_ERROR_CODES, *contract.DEVELOPER_ERROR_CODES)
        code = code if code in codes else "HOST_UNAVAILABLE"
        error = answer.get("error")
        return _marketplace_error(code, _without_secrets(error) if isinstance(error, str) and error else "failed")
    result = answer.get("result")
    if not isinstance(result, dict) or result.get("kind") != query["kind"]:
        return _marketplace_error("HOST_UNAVAILABLE", "Navide Host answered the developer query malformed")
    body = {key: value for key, value in result.items() if key != "kind"}
    return {"ok": True, **_without_secrets(body)}


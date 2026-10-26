"""MCP tools for installing Navide plugins from a local file or folder (plan W1).

Two kinds of tool, both usable on their own (design principles P4, P5):

- ``*_open`` only shows a page in a Navide window — the Navide Marketplace,
  Settings → Navide plugins with "Install from file", or the Developer Mode
  switch — so the user acts there. When the user wants to do it themselves,
  an agent calls the ``_open`` tool and stops.
- ``plugins_install_file_fill`` is for when the user wants the agent to do
  it: the Host reads the named ``.vsix`` once, checks it and holds that copy,
  and the user sees the request (who asked, the reason, the digest, "not
  reviewed by Navide") in a Navide window. Nothing is installed until the user
  approves there and confirms the same consent dialog "Install from file"
  shows. The tool has no consent argument and cannot submit anything.

``plugins_validate_package`` (read-only) and ``plugins_package`` (writes a new
``.vsix`` beside the folder, nothing else) run the same checks in the Host.
What a package says about itself (its id, version, errors quoting its
manifest, its disclosure) reaches the agent fenced as third-party text, and
the reading pane is tainted, as with the Marketplace tools.

Developer Mode, the plugin frame and environment variables still cannot
install anything: a folder request needs the user's own Developer Mode switch,
and only a Navide window can turn a staged copy into an install.

Registered on the core server by the import at the end of server.py.
"""

from __future__ import annotations

import os
import re
from typing import Any

from mcp.server.fastmcp import Context

from . import server as core

_TARGET = re.compile(r"universal|(?:darwin|linux|win32)-(?:x64|arm64)")
_DIGEST = re.compile(r"[0-9a-f]{64}")
_LOCAL_DETAIL = "local package, not reviewed by Navide"


def _fence(value: Any, label: str, fenced: list[int]) -> str:
    from agent_team_backend.plugins.external_content import wrap_external_text

    fenced[0] += 1
    return wrap_external_text(str(value), label=label)


def _local_report(caller: Any, report: Any, *, tool: str) -> dict[str, Any]:
    """The Host's report with every package-chosen string fenced."""
    from agent_team_backend.plugins.external_content import third_party_label

    report = report if isinstance(report, dict) else {}
    plugin_id = report.get("id") if isinstance(report.get("id"), str) else None
    version = report.get("version") if isinstance(report.get("version"), str) else None
    label = third_party_label(
        plugin_id if plugin_id and core._MQ_PACKAGE_ID.fullmatch(plugin_id) else "unknown",  # noqa: SLF001
        version if version and core._MQ_SEMVER.fullmatch(version) else "",  # noqa: SLF001
        _LOCAL_DETAIL,
    )
    fenced = [0]
    target = report.get("target")
    digest = report.get("digest")
    out: dict[str, Any] = {
        "ok": True,
        # The path is the agent's own (or the Host's resolution of it).
        "path": report.get("path") if isinstance(report.get("path"), str) else None,
        "packageKind": report.get("packageKind") if report.get("packageKind") in ("file", "folder") else None,
        "valid": report.get("valid") is True,
        "errors": [_fence(error, label, fenced) for error in report.get("errors") or [] if isinstance(error, str)],
        "id": _fence(plugin_id, label, fenced) if plugin_id else None,
        "version": _fence(version, label, fenced) if version else None,
        "target": target if isinstance(target, str) and _TARGET.fullmatch(target) else None,
        "digest": digest if isinstance(digest, str) and _DIGEST.fullmatch(digest) else None,
        "signature": report.get("signature")
        if report.get("signature") in ("none", "verified", "revoked", "unverifiable") else "none",
        "risk": report.get("risk") if report.get("risk") in ("low", "medium", "high", "highest") else None,
        "disclosure": core._fence_untrusted(report["disclosure"], label, fenced)  # noqa: SLF001
        if isinstance(report.get("disclosure"), dict) else None,
        "scan": core._fence_untrusted(report["scan"], label, fenced)  # noqa: SLF001
        if isinstance(report.get("scan"), dict) else None,
        "reviewedByNavide": False,
    }
    if fenced[0]:
        core._taint_marketplace_reader(caller, tool)  # noqa: SLF001
    return out


async def _local_query(ctx: Context, query: dict[str, Any]) -> tuple[Any, dict[str, Any]]:
    """Ask the Host for a local package kind; (caller, report answer or error)."""
    try:
        caller = core._resolve_caller(ctx)  # noqa: SLF001
    except core.CallerUnknown as err:
        return None, {"ok": False, "error": str(err)}
    path = query.get("path")
    if not isinstance(path, str) or not os.path.isabs(path):
        return caller, core._marketplace_error("BAD_REQUEST", "path must be an absolute path")  # noqa: SLF001
    answer = await core.request_host_marketplace_query(query, caller=caller)
    if answer.get("ok") is not True:
        return caller, core._host_marketplace_error(caller, answer, query["kind"])  # noqa: SLF001
    result = answer.get("result")
    if not isinstance(result, dict) or result.get("kind") != query["kind"] or not isinstance(result.get("report"), dict):
        return caller, core._marketplace_error(  # noqa: SLF001
            "HOST_UNAVAILABLE", "Navide Host answered the local package query malformed",
        )
    return caller, {"ok": True, "report": result["report"]}


async def _open(ctx: Context, action: str, args: dict[str, Any] | None) -> dict[str, Any]:
    """Show a page in the caller's Navide window (any window for a non-pane caller)."""
    from agent_team_backend import agent_messaging

    try:
        caller = core._resolve_caller(ctx)  # noqa: SLF001
    except core.CallerUnknown as err:
        return {"ok": False, "error": str(err)}
    pane = agent_messaging.get(caller.pane_id) if caller.kind == "pane" and caller.pane_id else None
    workspace = pane.workspace_path if pane is not None and pane.workspace_path else ""
    reply = await core._ui_request(  # noqa: SLF001
        workspace, "invoke", caller=caller, action=action, args=args, is_global=not workspace,
    )
    if not reply.get("ok"):
        return {
            "ok": False,
            "error": str(reply.get("error") or "no Navide window showed the page"),
            "error_code": str(reply.get("error_code") or "ui_action_failed"),
        }
    return {"ok": True, "opened": (reply.get("result") or {}).get("opened"), "note": _OPEN_NOTE}


_OPEN_NOTE = "Shown in Navide. The user acts there; stop and wait for them."


@core.server.tool()
async def marketplace_open(ctx: Context, id: str = "") -> dict[str, Any]:  # noqa: A002
    """Show the Navide Marketplace, or one Navide plugin's page in it, in a Navide window.

    Use this when the user wants to look or install themselves: call it, then
    stop and wait for the user. It installs nothing. `id` is a plugin id
    `<namespace>.<name>`; empty shows the Marketplace's front page. To install
    for the user instead, use marketplace_request_install.

    Returns {ok, opened, note} or {ok: false, error, error_code}.
    """
    return await _open(ctx, "ui.plugins.openMarketplace", {"id": id} if id else None)


@core.server.tool()
async def plugins_install_file_open(ctx: Context) -> dict[str, Any]:
    """Show Settings → Navide plugins, where the user installs a .vsix with "Install from file".

    Use this when the user wants to choose and install the file themselves:
    call it, then stop and wait for the user. It picks no file and installs
    nothing. When the user asks you to install a file for them, call
    plugins_install_file_fill instead (you do not need to call this first).

    Returns {ok, opened, note} or {ok: false, error, error_code}.
    """
    return await _open(ctx, "ui.plugins.openInstallFromFile", None)


@core.server.tool()
async def plugins_developer_mode_open(ctx: Context) -> dict[str, Any]:
    """Show the Developer Mode switch in Settings → Navide plugins.

    Developer Mode loads Navide plugins from folders, unreviewed and in
    place; only the user can turn it on. Call this when a folder needs it (or
    the user wants to manage developer folders), then stop and wait for the
    user. It changes nothing by itself.

    Returns {ok, opened, note} or {ok: false, error, error_code}.
    """
    return await _open(ctx, "ui.plugins.openDeveloperMode", None)


@core.server.tool()
async def plugins_validate_package(ctx: Context, path: str) -> dict[str, Any]:
    """Check a Navide plugin package (.vsix) or plugin folder without installing it (read-only).

    `path` is absolute. A folder is checked with `navide-plugin package` rules
    (its artifact-files.json) and then, like a file, with the rules a local
    install applies: archive and manifest, the reserved `navide.` namespace,
    Navide's takedown and blocked-file lists, and the `<file>.sig` signature
    (signature: none, verified = a vetted publisher's active key, revoked, or
    unverifiable). Nothing is written. To learn how to write a plugin, install
    the skill skills_prepare_install(source="navide:plugin-authoring").

    Returns {ok, path, packageKind, valid, errors, id, version, target,
    digest, signature, risk, disclosure, scan, reviewedByNavide: false}; id,
    version, errors and the disclosure are the package's own text, fenced.
    """
    caller, answer = await _local_query(ctx, {"kind": "localValidate", "path": path})
    if answer.get("ok") is not True:
        return answer
    return _local_report(caller, answer["report"], tool="plugins_validate_package")


@core.server.tool()
async def plugins_package(ctx: Context, dir: str, target: str = "", out: str = "") -> dict[str, Any]:  # noqa: A002
    """Build a Navide plugin package (.vsix) from a plugin folder on this machine.

    The same bytes `navide-plugin package` builds, from the folder `dir`
    (absolute) and its artifact-files.json. `target` is "universal" for a package without a
    native backend, or this machine's `<platform>-<arch>` (the default) for one
    with it. The .vsix is written to `out` (absolute, ending in .vsix) or as
    `<id>-<version>-<target>.vsix` beside the folder; an existing file is
    never replaced and Navide's own data folder is refused. Nothing is signed
    or installed: install it with plugins_install_file_fill.

    Returns the checked report of the written file (see
    plugins_validate_package); when `valid` is false nothing was written.
    """
    query: dict[str, Any] = {"kind": "localPackage", "path": dir}
    if target:
        query["target"] = target
    if out:
        query["out"] = out
    caller, answer = await _local_query(ctx, query)
    if answer.get("ok") is not True:
        return answer
    return _local_report(caller, answer["report"], tool="plugins_package")


@core.server.tool()
async def plugins_install_file_fill(ctx: Context, path: str, reason: str = "") -> dict[str, Any]:
    """Ask the user to install a Navide plugin from a .vsix file (or, with Developer Mode on, a folder).

    Call this when the user wants you to do it; you do not need to call
    plugins_install_file_open first. Navide reads the file once, checks it and
    holds that copy; the user then sees in a Navide window who asked, your
    `reason` (shown as written by an agent), the path, the file's SHA-256, its
    disclosure and signature, and that it is not reviewed by Navide. Nothing
    is installed until the user approves there and confirms the install
    dialog; you cannot submit it. What gets installed is the held copy, whose
    digest matches the one shown. A folder needs Developer Mode, which only
    the user turns on (plugins_developer_mode_open shows the switch).

    Returns {ok, approval_id, status: "pending", expires_at, id, version,
    digest, note}, or {ok: false, error_code: PACKAGE_INVALID, errors, ...}
    when a local install would refuse the package. Requests expire after 15
    minutes. Follow it with marketplace_request_status.
    """
    from agent_team_backend import app, skills_approvals
    from agent_team_backend.ipc import make_event
    from agent_team_backend.plugins import agent_tools_contract as contract

    caller, answer = await _local_query(ctx, {"kind": "localStage", "path": path})
    if caller is None:
        return answer
    requester = core._approval_requester(caller)  # noqa: SLF001

    def refuse(code: str, error: str, audited_id: str = "", **extra: Any) -> dict[str, Any]:
        core._audit_agent_action(  # noqa: SLF001
            caller, requester, plugin_id=audited_id, action="request-install-file",
            outcome="error" if code in {"HOST_UNAVAILABLE"} else "denied", error_code=code,
        )
        return {**core._marketplace_error(code, error), **extra}  # noqa: SLF001

    if not isinstance(reason, str):
        return refuse("BAD_REQUEST", "reason must be a string")
    if answer.get("ok") is not True:
        return refuse(str(answer.get("error_code") or "HOST_UNAVAILABLE"), str(answer.get("error")))
    raw = answer["report"]
    shown = _local_report(caller, raw, tool="plugins_install_file_fill")
    plugin_id = raw.get("id") if isinstance(raw.get("id"), str) else ""
    version = raw.get("version") if isinstance(raw.get("version"), str) else ""
    staging_id = raw.get("stagingId")
    if not shown["valid"] or not isinstance(staging_id, str):
        return refuse("PACKAGE_INVALID", "a local install would refuse this package", errors=shown["errors"])
    if not core._MQ_PACKAGE_ID.fullmatch(plugin_id) or not core._MQ_SEMVER.fullmatch(version):  # noqa: SLF001
        return refuse("PACKAGE_INVALID", "the package names no valid id and version")
    if core._is_builtin_id(plugin_id):  # noqa: SLF001
        return refuse("BUILTIN_PLUGIN", "the bundled Navide plugins are managed by the user in Extensions", plugin_id)
    installed, error = await core._installed_item(caller, plugin_id)  # noqa: SLF001
    if error is not None:
        return refuse(str(error.get("error_code") or "HOST_UNAVAILABLE"), str(error.get("error")), plugin_id)
    namespace, name = plugin_id.split(".", 1)
    target = {
        "id": plugin_id, "namespace": namespace, "name": name, "version": version,
        "fromVersion": installed["version"] if installed else None,
        "path": shown["path"] or path, "digest": shown["digest"], "stagingId": staging_id,
        "packageKind": shown["packageKind"], "signature": shown["signature"],
    }
    card = {"manifest": raw["disclosure"], "scan": raw.get("scan"), "registry": None} \
        if isinstance(raw.get("disclosure"), dict) else None
    try:
        record = skills_approvals.registry.request_plugin(
            kind="plugin-install-file", requester=requester, reason=reason, target=target, card=card, diff=None,
        )
    except skills_approvals.SkillApprovalError as err:
        return refuse(err.code, str(err), plugin_id)
    core._audit_agent_action(  # noqa: SLF001
        caller, requester, plugin_id=plugin_id, plugin_version=version, action="request-install-file",
        outcome="allowed", approval_id=record["approval_id"],
    )
    await app.broadcast_main_windows(make_event(contract.PLUGIN_APPROVAL_REQUEST_EVENT, record))
    return {
        "ok": True,
        "approval_id": record["approval_id"],
        "status": record["status"],
        "expires_at": record["expires_at"],
        "id": shown["id"],
        "version": shown["version"],
        "digest": shown["digest"],
        "packageKind": shown["packageKind"],
        "signature": shown["signature"],
        "reviewedByNavide": False,
        "note": "Filed for the user's decision in Navide; nothing is installed until they approve. "
                "Poll marketplace_request_status.",
    }

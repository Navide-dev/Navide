"""plugins_developer_backend_call: call a method of a Navide plugin's own
backend while developing it (0.2.40).

Only for a plugin loaded from a folder with Developer Mode on; the Host
refuses every other plugin, so an installed plugin behaves exactly as
before. Registered on the core server from its own module, after
cli_rename_pane, so it is the last core tool and the tools/list before it
stays main's (the P3 precedent: a tool added after the digest).

Every call is recorded as a tool-call row of the plugin's activity, the
rows the Navide plugin activity view lists and the automatic-pause rules
count (calls per minute, consecutive failures).
"""

from __future__ import annotations

import json
import logging
import secrets
import time
from typing import Any

from mcp.server.fastmcp import Context

# Through the module, not imported names, so a test's monkeypatch of the
# core helpers reaches this tool too.
from . import server as core
from .plugin_agent_tools import _caller_object

_log = logging.getLogger(__name__)

TOOL_NAME = "plugins_developer_backend_call"
#: The agent.capability.request operation the Host answers for this tool.
OPERATION = "developerBackend"
_DEFAULT_TIMEOUT_MS = 30_000


def _refusal(error: str, error_code: str) -> dict[str, Any]:
    return {"ok": False, "error": error, "error_code": error_code}


async def _ask_host(request: dict[str, Any]) -> dict[str, Any]:
    """Send one developerBackend request and wait for the Host's answer."""
    from agent_team_backend import app
    from agent_team_backend.ipc import make_event

    request_id = request["request_id"]
    future = core._agent_capability_pending.register(request_id)  # noqa: SLF001
    try:
        if not await app.unicast_host(make_event("agent.capability.request", request)):
            return _refusal("Navide Host is not connected", "HOST_UNAVAILABLE")
        result = await core._agent_capability_pending.wait(  # noqa: SLF001
            request_id, future, timeout=core._host_answer_timeout_s(request["payload"]),  # noqa: SLF001
        )
        if result is core.TIMEOUT:
            return _refusal("Navide Host did not answer the backend request", "HOST_TIMEOUT")
        return result if isinstance(result, dict) else _refusal("Navide Host answered malformed", "HOST_UNAVAILABLE")
    finally:
        core._agent_capability_pending.discard(request_id)  # noqa: SLF001


def _record(caller: Any, audit: dict[str, Any], started: float) -> None:
    """Queue the call's activity row. A failed write is logged, never raised."""
    try:
        from agent_team_backend import agent_messaging, app

        pane = agent_messaging.get(caller.pane_id) if caller.kind == "pane" else None
        app.plugin_audit_log.record_tool_call(
            caller_kind=caller.kind,
            target_workspace=audit["workspace"],
            plugin_id=audit["plugin_id"],
            plugin_version=audit["plugin_version"],
            tool=TOOL_NAME,
            # The Host cannot tell what a backend method does: counted as a write.
            risk="write",
            arguments={"method": audit["method"], "arguments": audit["arguments"]},
            outcome=audit["outcome"],
            duration_ms=int((time.monotonic() - started) * 1000),
            result_bytes=audit["result_bytes"],
            pane_id=caller.pane_id or "",
            pane_name=getattr(pane, "name", "") or "",
            caller_workspace=core._caller_workspace(caller),  # noqa: SLF001
            error_code=audit["error_code"],
        )
    except Exception as err:  # noqa: BLE001 - the audit never fails the call it records
        _log.warning("%s: activity row not recorded: %s", TOOL_NAME, err)


@core.server.tool()
async def plugins_developer_backend_call(
    plugin_id: str,
    method: str,
    ctx: Context,
    arguments: dict[str, Any] | None = None,
    workspace_path: str = "",
    timeout_ms: int = _DEFAULT_TIMEOUT_MS,
) -> dict[str, Any]:
    """Call a backend method of a Navide plugin you are developing.

    For a plugin loaded from a folder (Settings → Navide Plugins → Developer
    Mode → Load from folder, or plugins_install_file_open on a folder) while
    Developer Mode is on: Navide starts the plugin's own backend for the
    workspace if it is not running and calls `method` (one of the methods
    its manifest's `backend.methods` declares) with `arguments` (a JSON
    object, default {}), as the plugin's agent tools would, but without
    declaring an agent tool first. Any other plugin is refused
    (error_code NOT_DEVELOPER_PLUGIN), and so is every call while Developer
    Mode is off (DEVELOPER_MODE_OFF) or while the plugin, or every
    third-party plugin, is stopped (PLUGIN_STOPPED).

    The call runs with the plugin's own permissions and the workspace's
    agent execution policy, like any agent call of the plugin. It is
    recorded in the plugin's activity (Settings → Navide Plugins →
    Activity) and counts toward the automatic-pause rules.

    `workspace_path` defaults to your pane's workspace; a caller with no pane
    must pass the absolute path of an open Navide workspace. `timeout_ms` is
    1 to 120000 (default 30000).

    Returns {ok: true, pluginId, pluginVersion, method, result} or {ok:
    false, error, error_code}.
    """
    try:
        caller = core._resolve_caller(ctx)  # noqa: SLF001
    except core.CallerUnknown as err:
        return _refusal(str(err), "BAD_REQUEST")
    workspace = workspace_path or core._caller_workspace(caller)  # noqa: SLF001
    args = {} if arguments is None else arguments
    if not isinstance(plugin_id, str) or not plugin_id or not isinstance(method, str) or not method:
        return _refusal("plugin_id and method are required", "BAD_REQUEST")
    if not workspace:
        return _refusal(core._WORKSPACE_REQUIRED, "BAD_REQUEST")  # noqa: SLF001
    if not isinstance(args, dict):
        return _refusal("arguments must be a JSON object", "BAD_REQUEST")
    if isinstance(timeout_ms, bool) or not isinstance(timeout_ms, int) or not 0 < timeout_ms <= 120_000:
        return _refusal("timeout_ms must be an integer from 1 to 120000", "BAD_REQUEST")
    audit: dict[str, Any] = {
        "workspace": workspace, "plugin_id": plugin_id, "plugin_version": "", "method": method,
        "arguments": args, "outcome": "error", "error_code": "cancelled", "result_bytes": 0,
    }
    started = time.monotonic()
    try:
        request_id = f"mcp:{secrets.token_hex(16)}"
        answer = await _ask_host({
            "request_id": request_id,
            "target": {"plugin_id": plugin_id, "workspace_path": workspace},
            "operation": OPERATION,
            "caller": _caller_object(caller),
            "payload": {"reqId": request_id, "name": method, "args": args, "timeoutMs": timeout_ms},
        })
        version = answer.get("packageVersion")
        audit["plugin_version"] = version if isinstance(version, str) else ""
        if answer.get("ok") is True:
            result = answer.get("result")
            audit["outcome"] = "ok"
            audit["error_code"] = ""
            audit["result_bytes"] = len(json.dumps(result, ensure_ascii=False).encode("utf-8"))
            return {"ok": True, "pluginId": plugin_id, "pluginVersion": audit["plugin_version"],
                    "method": method, "result": result}
        error = answer.get("error")
        code = error.get("code") if isinstance(error, dict) else answer.get("error_code")
        message = error.get("message") if isinstance(error, dict) else answer.get("error")
        audit["error_code"] = code if isinstance(code, str) else "BACKEND_ERROR"
        return _refusal(message if isinstance(message, str) and message else "The backend call failed",
                        audit["error_code"])
    finally:
        _record(caller, audit, started)

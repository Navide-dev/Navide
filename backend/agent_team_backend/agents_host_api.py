"""Read-only plugin Host API over Navide's own agent data (`agents.*`).

Backs the public `agents.*` capabilities and the `agents` /
`agent-message-bodies` Bridge ports. The Electron Host has already checked the
Manifest, the user Grant and the agent Execution Policy, and it supplies the
workspace from the plugin's runtime binding; nothing here trusts a plugin for
the workspace.

Every answer is a fixed allowlist projection: a field is returned only when it
is named below. Account, profile, usage, credential, device and log-file
fields never appear, and this module must not import the account, quota or
credential modules (a guard test enforces both). Message text is returned only
by `read_message`, which the Host gates on the separate `agentMessages` grant.
Session transcripts are not readable through this API at all.
"""

from __future__ import annotations

from typing import Any

#: Most rows one listing returns.
MAX_LIMIT = 200
DEFAULT_LIMIT = 50

OPERATIONS = frozenset(
    {"list_panes", "lineage", "list_messages", "read_message", "list_sessions"}
)

#: Fields each projection may contain. Pinned by tests: adding one is a
#: contract change (capabilities-v1.json and plugin-development-v2.md).
PANE_FIELDS = (
    "paneId", "name", "agentKey", "displayStatus", "busy", "realized", "offline",
    "spawnedBy", "runGroupId", "origin", "reportTo", "spawnedAt",
)
LINEAGE_FIELDS = (
    "paneId", "name", "parentId", "runGroupId", "origin", "spawnStatus",
    "spawnedAt", "removedAt", "reportTo", "live",
)
MESSAGE_FIELDS = (
    "id", "createdAt", "status", "sender", "recipient", "kind", "reason",
    "deliveredAt", "correlationId", "replyTo", "bodyLength",
)
SESSION_FIELDS = (
    "sessionId", "agentKey", "paneId", "paneName", "spawnedAt", "removedAt",
    "starred", "spawnedBy", "runGroupId", "live", "resumable",
)


class AgentsApiError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _text(value: Any) -> str:
    return value if isinstance(value, str) else ""


def _limit(arguments: dict[str, Any]) -> int:
    value = arguments.get("limit", DEFAULT_LIMIT)
    if not isinstance(value, int) or isinstance(value, bool) or not 1 <= value <= MAX_LIMIT:
        raise AgentsApiError("INVALID_ARGUMENT", f"limit must be an integer 1..{MAX_LIMIT}")
    return value


def _check_keys(arguments: dict[str, Any], allowed: tuple[str, ...]) -> None:
    extra = set(arguments) - set(allowed)
    if extra:
        raise AgentsApiError("INVALID_ARGUMENT", f"unknown argument(s): {', '.join(sorted(extra))}")


def _is_login_pane(pane_id: str) -> bool:
    from . import login_panes

    return login_panes.is_login_pane(pane_id)


def _workspace_panes(workspace_path: str) -> list[Any]:
    """Registered panes of one workspace on this machine, sign-in panes left out."""
    from . import agent_messaging

    return [
        pane for pane in agent_messaging.list_panes(workspace_path)
        if not _is_login_pane(pane.pane_id)
    ]


def _pane_records(workspace_path: str) -> dict[str, Any]:
    """pane_id -> the workspace's persisted pane record (last one wins)."""
    from . import app

    # peek, never load_or_create: a read must not create a project document.
    project = app.project_store.peek(workspace_path)
    if project is None:
        return {}
    return {pane.pane_id: pane for pane in project.panes if _text(pane.pane_id)}


def _record_name(record: Any) -> str:
    return _text(record.custom_name) or _text(record.auto_name)


def list_panes(workspace_path: str, arguments: dict[str, Any]) -> dict[str, Any]:
    _check_keys(arguments, ())
    records = _pane_records(workspace_path)
    panes: list[dict[str, Any]] = []
    for pane in _workspace_panes(workspace_path):
        record = records.get(pane.pane_id)
        panes.append({
            "paneId": pane.pane_id,
            "name": pane.name,
            "agentKey": pane.agent_key,
            "displayStatus": pane.display_status,
            "busy": bool(pane.busy),
            "realized": bool(pane.realized),
            "offline": bool(pane.offline),
            "spawnedBy": pane.spawned_by or (_text(record.spawned_by) if record else ""),
            "runGroupId": _text(record.run_group_id) if record else "",
            "origin": _text(record.origin) if record else "",
            "reportTo": _text(record.report_to) if record else "",
            "spawnedAt": _text(record.spawned_at) if record else "",
        })
    return {"panes": panes}


def lineage(workspace_path: str, arguments: dict[str, Any]) -> dict[str, Any]:
    _check_keys(arguments, ("includeRemoved",))
    include_removed = arguments.get("includeRemoved", False)
    if not isinstance(include_removed, bool):
        raise AgentsApiError("INVALID_ARGUMENT", "includeRemoved must be a boolean")
    live = {pane.pane_id: pane for pane in _workspace_panes(workspace_path)}
    nodes: list[dict[str, Any]] = []
    for pane_id, record in _pane_records(workspace_path).items():
        status = _text(record.spawn_status)
        if status == "removed" and not include_removed:
            continue
        if _is_login_pane(pane_id):
            continue
        registered = live.get(pane_id)
        nodes.append({
            "paneId": pane_id,
            "name": registered.name if registered else _record_name(record),
            "parentId": _text(record.spawned_by),
            "runGroupId": _text(record.run_group_id),
            "origin": _text(record.origin),
            "spawnStatus": status,
            "spawnedAt": _text(record.spawned_at),
            "removedAt": _text(record.removed_at),
            "reportTo": _text(record.report_to),
            "live": registered is not None and bool(registered.realized) and not registered.offline,
        })
    return {"nodes": nodes}


def _message_names(workspace_path: str, pane_id: str) -> set[str]:
    """Messaging names that belong to this workspace (or to one pane in it).

    The log records sender and recipient by name, bare inside one window and
    qualified across workspaces, so both forms count. Matching by name is best
    effort: a pane renamed since a message was logged no longer matches it."""
    names: set[str] = set()
    found = False
    for pane in _workspace_panes(workspace_path):
        if pane_id and pane.pane_id != pane_id:
            continue
        found = True
        names.update({pane.name, pane.qualified_name})
    if pane_id and not found:
        raise AgentsApiError("INVALID_ARGUMENT", "no such pane in this workspace")
    names.discard("")
    return names


def _workspace_messages(workspace_path: str, pane_id: str = "") -> tuple[list[dict[str, Any]], int]:
    from . import app

    names = _message_names(workspace_path, pane_id)
    rows = app.agent_message_log.tail()
    mine = [
        row for row in rows
        # Local traffic only: a relayed row belongs to another machine's pane.
        if not row.get("remote")
        and (_text(row.get("sender")) in names or _text(row.get("recipient")) in names)
    ]
    return mine, len(rows)


def _message(row: dict[str, Any]) -> dict[str, Any]:
    delivered = row.get("delivered_at")
    return {
        "id": _text(row.get("uid")),
        "createdAt": int(row.get("created_at") or 0),
        "status": _text(row.get("status")),
        "sender": _text(row.get("sender")),
        "recipient": _text(row.get("recipient")),
        "kind": _text(row.get("kind")),
        "reason": _text(row.get("reason")),
        "deliveredAt": int(delivered) if isinstance(delivered, int) else None,
        "correlationId": _text(row.get("correlation_id")),
        "replyTo": _text(row.get("reply_to")),
        "bodyLength": len(_text(row.get("content"))),
    }


def list_messages(workspace_path: str, arguments: dict[str, Any]) -> dict[str, Any]:
    _check_keys(arguments, ("paneId", "since", "limit"))
    pane_id = arguments.get("paneId", "")
    since = arguments.get("since", 0)
    if not isinstance(pane_id, str):
        raise AgentsApiError("INVALID_ARGUMENT", "paneId must be a string")
    if not isinstance(since, int) or isinstance(since, bool) or since < 0:
        raise AgentsApiError("INVALID_ARGUMENT", "since must be a non-negative integer")
    limit = _limit(arguments)
    rows, scanned = _workspace_messages(workspace_path, pane_id)
    # The log keeps a bounded window of recent rows; oldestCreatedAt tells a
    # caller polling with `since` whether rows it never saw were pruned.
    oldest = int(rows[0].get("created_at") or 0) if rows else None
    newer = [row for row in rows if int(row.get("created_at") or 0) > since]
    return {
        "messages": [_message(row) for row in newer[-limit:]],
        "oldestCreatedAt": oldest,
        "scanned": scanned,
        "truncated": len(newer) > limit,
    }


def read_message(workspace_path: str, arguments: dict[str, Any]) -> dict[str, Any]:
    _check_keys(arguments, ("id",))
    message_id = arguments.get("id")
    if not isinstance(message_id, str) or not message_id:
        raise AgentsApiError("INVALID_ARGUMENT", "id must be a non-empty string")
    rows, _scanned = _workspace_messages(workspace_path)
    for row in rows:
        if row.get("uid") == message_id:
            return {"message": {**_message(row), "body": _text(row.get("content"))}}
    raise AgentsApiError("INVALID_ARGUMENT", "no such message in this workspace")


def list_sessions(workspace_path: str, arguments: dict[str, Any]) -> dict[str, Any]:
    _check_keys(arguments, ("limit",))
    limit = _limit(arguments)
    # The same rows cli_list_sessions answers with; only metadata, never the
    # conversation. Imported lazily: the MCP server module is heavy.
    from .mcp_server import server as mcp_server

    rows, _scanned = mcp_server._session_rows(workspace_path, "", limit, True)
    login = {row["pane_id"] for row in rows if row.get("pane_id") and _is_login_pane(row["pane_id"])}
    return {
        "sessions": [
            {
                "sessionId": _text(row.get("session_id")),
                "agentKey": _text(row.get("agent_key")),
                "paneId": _text(row.get("pane_id")),
                "paneName": _text(row.get("pane_name")),
                "spawnedAt": _text(row.get("spawned_at")),
                "removedAt": _text(row.get("removed_at")),
                "starred": bool(row.get("starred")),
                "spawnedBy": _text(row.get("spawned_by")),
                "runGroupId": _text(row.get("run_group_id")),
                "live": bool(row.get("live")),
                "resumable": bool(row.get("resumable")),
            }
            for row in rows
            if row.get("pane_id") not in login
        ]
    }


_DISPATCH = {
    "list_panes": list_panes,
    "lineage": lineage,
    "list_messages": list_messages,
    "read_message": read_message,
    "list_sessions": list_sessions,
}


def run(workspace_path: str, operation: str, arguments: dict[str, Any]) -> dict[str, Any]:
    """Run one operation. Synchronous (sqlite and project reads): call it from
    a worker thread."""
    fn = _DISPATCH.get(operation)
    if fn is None:
        raise AgentsApiError("METHOD_NOT_FOUND", f"unknown agents operation {operation!r}")
    return fn(workspace_path, arguments)

"""Step-0 contract for Navide plugin agent tools (plan B, B1 and B2).

Types, constants and pure functions only. Since B1-a the Registry validates
``backend.agentTools`` with ``validate_agent_tools`` through its byte-identical
copy (marketplace/registry/registry/agent_tools_contract.py, held by
marketplace/registry/tests/test_agent_tools_contract_copy.py). The normative text is
docs/en-US/plugin-agent-tools-contract.md; the TypeScript twin is
src/shared/pluginAgentTools.ts, and both are held to
docs/plugin-contracts/agent-tools-fixtures/ by their tests.
"""
from __future__ import annotations

import hashlib
import json
import re
from typing import Any, Literal, TypedDict

# ── manifest: backend.agentTools[] ──────────────────────────────────────────

AgentToolRisk = Literal["read", "write"]

AGENT_TOOL_NAME_PATTERN = re.compile(r"[a-z][a-z0-9]{1,15}_[a-z0-9_]{1,40}")
_PREFIX_PATTERN = re.compile(r"[a-z][a-z0-9]{1,15}")

AGENT_TOOL_DEFAULT_TIMEOUT_MS = 30_000
#: Same bound as the Host's backend calls (pluginBackendLimits.MAX_BACKEND_TIMEOUT_MS).
AGENT_TOOL_MAX_TIMEOUT_MS = 120_000
#: DB9: the technical cap on one description and one canonical input schema, in UTF-8 bytes.
#: Results and arguments have no cap (DB9 decision a): they travel in pieces
#: (section 4.4) and their sizes are disclosed as ``resultBytes`` and ``args_bytes``.
AGENT_TOOL_STABILITY_CAP_BYTES = 1_048_576
#: The largest integer both languages print the same way.
MAX_SAFE_INTEGER = 2**53 - 1

AGENT_TOOL_REQUIRED_FIELDS = ("name", "method", "risk", "title", "description", "inputSchema")
_AGENT_TOOL_FIELDS = frozenset((*AGENT_TOOL_REQUIRED_FIELDS, "timeoutMs"))

#: Prefixes no plugin may derive. ``navide_`` is reserved on top of the design list (impersonation), and so
#: are the prefixes the built-in packages derive (``git_``, ``plans_``, ``miniide_``).
RESERVED_TOOL_PREFIXES = (
    "cli_", "credentials_", "evolve_", "git_", "marketplace_", "mcp_", "memory_", "miniide_", "navide_", "pipeline_",
    "plan_", "plans_", "plugins_", "preview_", "prompt_", "role_", "scheduler_", "share_", "skills_", "stage_", "ui_",
    "workspace_",
)

#: tools/list of the core navide MCP server on origin/main 72c4c2e33, pinned.
CORE_TOOL_NAMES = (
    "cli_answer_prompt", "cli_cancel_message", "cli_check_message", "cli_close_agent", "cli_extensions_list",
    "cli_get_status", "cli_inbox_summary", "cli_interrupt", "cli_list_sessions", "cli_list_targets",
    "cli_message_log", "cli_open_agent", "cli_pending_incoming", "cli_permission_settings", "cli_place_pane",
    "cli_read_incoming", "cli_read_log", "cli_reclaim_agent", "cli_send", "cli_send_and_wait", "cli_token_stats",
    "cli_usage", "cli_wait_idle", "cli_whoami", "credentials_findings", "credentials_list", "evolve_report",
    "marketplace_detail", "marketplace_search", "mcp_list", "memory_list", "pipeline_abort",
    "pipeline_define", "pipeline_gate", "pipeline_graph",
    "pipeline_list", "pipeline_next", "pipeline_reset", "pipeline_restart", "pipeline_restart_from",
    "pipeline_resume", "pipeline_start", "pipeline_status", "plan_add_note", "plan_add_todo", "plan_create",
    "plan_list", "plan_read", "plan_update_stage", "plan_update_todo", "plugins_list_installed",
    "preview_clear", "preview_list",
    "preview_record", "preview_show", "prompt_list", "role_define", "scheduler_list", "scheduler_remove",
    "scheduler_run_now", "scheduler_runs", "scheduler_set_enabled", "scheduler_upsert", "share_create",
    "share_list", "share_revoke", "skills_inspect", "skills_install", "skills_install_status", "skills_list",
    "skills_prepare_install", "skills_set_delivery", "stage_define", "ui_diagnostics", "ui_invoke",
    "ui_list_actions", "ui_snapshot", "workspace_list", "workspace_open", "workspace_switch",
)


class AgentToolDeclaration(TypedDict, total=False):
    """One entry of ``backend.agentTools`` as a package declares it (all but timeoutMs required)."""

    name: str
    method: str
    risk: AgentToolRisk
    title: str
    description: str
    inputSchema: dict[str, Any]
    timeoutMs: int


class AgentToolValidationError(TypedDict):
    index: int | None
    field: str | None
    code: str


def derive_agent_tool_prefix(plugin_id: Any) -> str | None:
    """The last dot segment of the id without hyphens, when it matches ``^[a-z][a-z0-9]{1,15}$``."""
    if not isinstance(plugin_id, str):
        return None
    candidate = plugin_id.split(".")[-1].replace("-", "")
    return candidate if _PREFIX_PATTERN.fullmatch(candidate) else None


def validate_agent_tool_name(name: Any, plugin_id: Any) -> str | None:
    """First failing rule for one tool name, or None when it is accepted."""
    prefix = derive_agent_tool_prefix(plugin_id)
    if prefix is None:
        return "AGENT_TOOL_PREFIX_UNDERIVABLE"
    # fullmatch, not match + $: Python's $ also matches before a trailing newline.
    if not isinstance(name, str) or not AGENT_TOOL_NAME_PATTERN.fullmatch(name):
        return "AGENT_TOOL_NAME_INVALID"
    if name.split("_", 1)[0] != prefix:
        return "AGENT_TOOL_PREFIX_MISMATCH"
    if f"{prefix}_" in RESERVED_TOOL_PREFIXES:
        return "AGENT_TOOL_PREFIX_RESERVED"
    if name in CORE_TOOL_NAMES:
        return "AGENT_TOOL_NAME_RESERVED"
    return None


# ── text rules ──────────────────────────────────────────────────────────────

# Cc (C0, DEL, C1), the two Unicode line/paragraph separators, markup, and the
# characters that reorder or hide text: bidi controls, zero-width and other
# invisible format characters (U+00AD, U+034F, U+180E), variation selectors
# and tag characters.
_FORBIDDEN_TEXT = re.compile(
    "[\u0000-\u001f\u007f-\u009f\u2028\u2029<>\u00ad\u034f\u061c\u180e\u200b-\u200f\u202a-\u202e"
    "\u2060-\u2069\ufe00-\ufe0f\ufeff\U000e0000-\U000e007f]"
)
# Cc except tab and line feed.
_RESULT_CONTROL = re.compile("[\u0000-\u0008\u000b-\u001f\u007f-\u009f]")


def is_valid_agent_tool_text(value: Any) -> bool:
    """Title and description: a non-empty single line with no control characters and no ``<`` ``>``."""
    return isinstance(value, str) and value != "" and _FORBIDDEN_TEXT.search(value) is None


def sanitize_agent_tool_result_text(value: str) -> str:
    """Tool result text as the agent will see it: every Cc character except tab and LF removed."""
    return _RESULT_CONTROL.sub("", value)


def utf8_byte_length(value: str) -> int:
    """UTF-8 length; a lone surrogate counts 3 bytes, matching the TypeScript twin."""
    return len(value.encode("utf-8", "surrogatepass"))


# ── manifest validation ─────────────────────────────────────────────────────


def _is_safe_integer(value: Any) -> bool:
    if isinstance(value, bool):
        return True  # not a number in JSON terms
    if isinstance(value, int):
        return abs(value) <= MAX_SAFE_INTEGER
    if isinstance(value, float):
        return value.is_integer() and abs(value) <= MAX_SAFE_INTEGER
    return True


def _has_non_integer_number(value: Any) -> bool:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return not _is_safe_integer(value)
    if isinstance(value, list):
        return any(_has_non_integer_number(item) for item in value)
    if isinstance(value, dict):
        return any(_has_non_integer_number(item) for item in value.values())
    return False


#: Schema keywords whose values are data, not schema: never refused for their
#: text (the core neutralizes every schema string in tools/list instead).
_SCHEMA_DATA_KEYWORDS = frozenset(("const", "default", "enum", "examples"))
#: Keywords whose value maps names (property names, definition names) to
#: subschemas: a name such as ``enum`` there is a name, not a keyword.
_SCHEMA_MAP_KEYWORDS = frozenset(("properties", "patternProperties", "$defs", "definitions", "dependentSchemas"))


def _has_invalid_schema_text(value: Any) -> bool:
    """Every ``description`` / ``title`` string anywhere in a schema follows the text rules too."""
    if isinstance(value, list):
        return any(_has_invalid_schema_text(item) for item in value)
    if not isinstance(value, dict):
        return False
    return any(
        False
        if key in _SCHEMA_DATA_KEYWORDS
        else any(_has_invalid_schema_text(sub) for sub in item.values())
        if key in _SCHEMA_MAP_KEYWORDS and isinstance(item, dict)
        else (not is_valid_agent_tool_text(item))
        if key in ("description", "title") and isinstance(item, str)
        else _has_invalid_schema_text(item)
        for key, item in value.items()
    )


def _is_valid_timeout(value: Any) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, float):
        if not value.is_integer():
            return False
    elif not isinstance(value, int):
        return False
    return 1 <= value <= AGENT_TOOL_MAX_TIMEOUT_MS


def _schema_bytes(schema: dict[str, Any]) -> int:
    # Integers only at this point, so this is the canonical contract spelling.
    return utf8_byte_length(json.dumps(schema, sort_keys=True, separators=(",", ":"), ensure_ascii=True))


def validate_agent_tools(manifest: dict[str, Any]) -> list[AgentToolValidationError]:
    """Every rule of contract section 2.5; reads only ``id`` and ``backend``.

    Returns all errors ordered by entry index, then check order.
    """
    backend = manifest.get("backend")
    if not isinstance(backend, dict) or "agentTools" not in backend:
        return []
    declared = backend["agentTools"]
    if not isinstance(declared, list):
        return [{"index": None, "field": "agentTools", "code": "AGENT_TOOLS_NOT_ARRAY"}]
    methods = backend.get("methods") if isinstance(backend.get("methods"), list) else []
    errors: list[AgentToolValidationError] = []
    seen: set[str] = set()
    for index, tool in enumerate(declared):
        def fail(field: str | None, code: str, index: int = index) -> None:
            errors.append({"index": index, "field": field, "code": code})

        if not isinstance(tool, dict):
            fail(None, "AGENT_TOOL_NOT_OBJECT")
            continue
        for field in sorted(tool):
            if field not in _AGENT_TOOL_FIELDS:
                fail(field, "AGENT_TOOL_FIELD_UNKNOWN")
        for field in AGENT_TOOL_REQUIRED_FIELDS:
            if field not in tool:
                fail(field, "AGENT_TOOL_FIELD_MISSING")
        if "name" in tool:
            name_error = validate_agent_tool_name(tool["name"], manifest.get("id"))
            if name_error:
                fail("name", name_error)
            elif tool["name"] in seen:
                fail("name", "AGENT_TOOL_NAME_DUPLICATE")
            else:
                seen.add(tool["name"])
        if "method" in tool and tool["method"] not in methods:
            fail("method", "AGENT_TOOL_METHOD_UNDECLARED")
        if "risk" in tool and tool["risk"] not in ("read", "write"):
            fail("risk", "AGENT_TOOL_RISK_INVALID")
        if "title" in tool and not is_valid_agent_tool_text(tool["title"]):
            fail("title", "AGENT_TOOL_TEXT_INVALID")
        if "description" in tool:
            if not is_valid_agent_tool_text(tool["description"]):
                fail("description", "AGENT_TOOL_TEXT_INVALID")
            elif utf8_byte_length(tool["description"]) > AGENT_TOOL_STABILITY_CAP_BYTES:
                fail("description", "AGENT_TOOL_TOO_LARGE")
        if "inputSchema" in tool:
            schema = tool["inputSchema"]
            if not isinstance(schema, dict) or schema.get("type") != "object":
                fail("inputSchema", "AGENT_TOOL_SCHEMA_INVALID")
            elif _has_non_integer_number(schema):
                fail("inputSchema", "AGENT_TOOL_NON_INTEGER_NUMBER")
            elif _has_invalid_schema_text(schema):
                fail("inputSchema", "AGENT_TOOL_TEXT_INVALID")
            elif _schema_bytes(schema) > AGENT_TOOL_STABILITY_CAP_BYTES:
                fail("inputSchema", "AGENT_TOOL_TOO_LARGE")
        if "timeoutMs" in tool and not _is_valid_timeout(tool["timeoutMs"]):
            fail("timeoutMs", "AGENT_TOOL_TIMEOUT_INVALID")
    return errors


# ── Host → backend: plugins.agentTools.sync ─────────────────────────────────

AGENT_TOOLS_SYNC_EVENT = "plugins.agentTools.sync"

AgentToolState = Literal[
    "available", "consent-required", "plugin-disabled", "plugin-quarantined", "plugin-revoked", "name-collision",
]


class AgentToolSyncEntry(TypedDict):
    pluginId: str
    pluginVersion: str
    name: str
    title: str
    description: str
    risk: AgentToolRisk
    method: str
    timeoutMs: int
    inputSchema: dict[str, Any]
    state: AgentToolState
    #: The disclosure ``permissions`` object of the package version (feeds the D4 label).
    permissions: dict[str, Any]


class AgentToolsSyncPayload(TypedDict):
    """A full snapshot that replaces the previous one."""

    revision: int
    enabled: bool
    externalCallers: bool
    tools: list[AgentToolSyncEntry]


# ── backend → Host: the generalized agent call ──────────────────────────────


class AgentToolCaller(TypedDict):
    kind: Literal["pane", "external", "host"]
    paneId: str | None
    workspace: str | None


class AgentToolCallTarget(TypedDict):
    plugin_id: str
    workspace_path: str


class AgentToolCallTool(TypedDict):
    name: str
    plugin_version: str
    sync_revision: int


class AgentToolCallRequest(TypedDict):
    """Payload of the existing ``agent.capability.request`` event with operation "agentTool"."""

    request_id: str
    operation: Literal["agentTool"]
    target: AgentToolCallTarget
    tool: AgentToolCallTool
    caller: AgentToolCaller
    payload: dict[str, Any]


AGENT_TOOL_CALL_ERROR_CODES = (
    "BAD_REQUEST",
    "PLUGIN_TOOL_UNAVAILABLE",
    "WORKSPACE_NOT_AUTHORIZED",
    "WORKSPACE_WRITE_DECLINED",
    "EXECUTION_POLICY_DENIED",
    "PLUGIN_TOOL_INVALID_ARGUMENTS",
    "PLUGIN_TOOL_TIMEOUT",
    "PLUGIN_TOOL_FAILED",
    # No longer produced: results have no size cap (DB9 decision a). Kept for older readers.
    "PLUGIN_TOOL_RESULT_TOO_LARGE",
    "PLUGIN_TOOL_CHUNKS_INVALID",
)

#: ``reason`` of PLUGIN_TOOL_UNAVAILABLE, in Host check order.
AGENT_TOOL_UNAVAILABLE_REASONS = (
    "master-switch-off",
    "external-callers-off",
    "plugin-not-installed",
    "plugin-disabled",
    "plugin-quarantined",
    "plugin-revoked",
    "plugin-stopping",
    "consent-required",
    "tool-not-consented",
    "name-collision",
)


class AgentToolCallMeta(TypedDict):
    durationMs: int
    #: UTF-8 bytes of the result's compact JSON text as the Host received it; 0 without a result.
    resultBytes: int
    crossWorkspace: bool


# ── chunked transfer of results and arguments (section 4.4) ────────────────

#: UTF-8 bytes of the ``data`` of one piece, in both directions. A transport
#: unit, not a cap: a value of any size is sent as as many pieces as it needs.
#: Even fully escaped (6 bytes per byte) a piece stays under 1 MiB, the frame
#: size child readers use (Plans backend MAX_FRAME_BYTES).
AGENT_TOOL_CHUNK_BYTES = 131_072
#: Backend Wire notification, child -> Host, one per result piece.
BACKEND_WIRE_RESULT_CHUNK_METHOD = "notifications/navide/resultChunk"
#: Host client capability in ``navide/call`` ``_meta`` and summary key in the final response ``_meta``.
BACKEND_WIRE_RESULT_CHUNKS_KEY = "io.navide/resultChunks"
#: Backend Wire notification, Host -> child, one per argument piece.
BACKEND_WIRE_ARGUMENT_CHUNK_METHOD = "notifications/navide/argumentChunk"
#: Child capability in the ``navide/health`` success ``_meta`` and summary key in ``navide/call`` ``_meta``.
BACKEND_WIRE_ARGUMENT_CHUNKS_KEY = "io.navide/argumentChunks"
#: WebSocket request, Host -> backend, one per result piece; answered like any request.
AGENT_CAPABILITY_RESULT_CHUNK_MESSAGE = "agent.capability.result_chunk"
#: WebSocket event, backend -> Host, one per argument piece, sent before ``agent.capability.request``.
AGENT_CAPABILITY_REQUEST_CHUNK_EVENT = "agent.capability.request_chunk"
#: WebSocket request, Host -> backend: the call is alive (keeps the backend's wait running).
AGENT_CAPABILITY_PROGRESS_MESSAGE = "agent.capability.progress"
#: Idle timer of a transfer of pieces, restarted by every piece. It detects a
#: stalled peer; it is not a size limit (section 4.4, Timing).
AGENT_TOOL_CHUNK_IDLE_MS = 30_000
#: ``reason`` of PLUGIN_TOOL_TIMEOUT: the plugin's own work, or a stalled transfer.
AGENT_TOOL_TIMEOUT_REASONS = ("execution", "transfer-idle")
#: ``phase`` of ``agent.capability.progress``.
AGENT_TOOL_PROGRESS_PHASES = ("arguments", "execution", "result")
AGENT_TOOL_CHUNKS_INVALID = "PLUGIN_TOOL_CHUNKS_INVALID"


class AgentToolChunkMessage(TypedDict):
    """Payload of ``agent.capability.result_chunk`` and ``agent.capability.request_chunk``."""

    request_id: str
    seq: int
    data: str


class AgentToolChunksSummary(TypedDict):
    chunks: int
    bytes: int


def agent_tool_payload_text(value: Any) -> str:
    """The compact JSON spelling a value is cut from (``JSON.stringify`` in TypeScript)."""
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def split_agent_tool_payload_text(text: str, max_bytes: int = AGENT_TOOL_CHUNK_BYTES) -> list[str]:
    """Cut ``text`` into pieces of at most ``max_bytes`` UTF-8 bytes, never inside a code point."""
    if isinstance(max_bytes, bool) or not isinstance(max_bytes, int) or max_bytes < 4:
        raise ValueError("max_bytes must be an integer >= 4")
    pieces: list[str] = []
    start = 0
    size = 0
    for index, char in enumerate(text):
        point = ord(char)
        width = 1 if point < 0x80 else 2 if point < 0x800 else 4 if point > 0xFFFF else 3
        if size + width > max_bytes:
            pieces.append(text[start:index])
            start = index
            size = 0
        size += width
    pieces.append(text[start:])
    return pieces


def agent_tool_chunk_arrival(short_seen: bool, data: Any, chunk_bytes: int = AGENT_TOOL_CHUNK_BYTES) -> dict[str, Any]:
    """Check one piece on arrival (section 4.4).

    Senders send pieces in ``seq`` order and only the last may be short (under
    ``chunk_bytes - 3`` UTF-8 bytes), so any piece after a short one is
    ``short``. A short piece does not restart the idle timer (``short: True``);
    a full one does. A format rule, not a limit. Returns ``{"ok": True,
    "short": bool}`` or ``{"ok": False, "code": "PLUGIN_TOOL_CHUNKS_INVALID",
    "reason": "seq" | "short"}``.
    """
    if not isinstance(data, str):
        return {"ok": False, "code": AGENT_TOOL_CHUNKS_INVALID, "reason": "seq"}
    if short_seen:
        return {"ok": False, "code": AGENT_TOOL_CHUNKS_INVALID, "reason": "short"}
    return {"ok": True, "short": utf8_byte_length(data) < chunk_bytes - 3}


def _is_count(value: Any, minimum: int) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and minimum <= value <= MAX_SAFE_INTEGER


def reassemble_agent_tool_payload_text(
    chunks: list[dict[str, Any]], summary: Any, chunk_bytes: int = AGENT_TOOL_CHUNK_BYTES
) -> dict[str, Any]:
    """Join the pieces received for one request (any arrival order) and check them against the summary.

    Returns ``{"ok": True, "text": ...}`` or ``{"ok": False, "code":
    "PLUGIN_TOOL_CHUNKS_INVALID", "reason": "summary" | "seq" | "count" | "short" | "bytes"}``.
    Every piece but the last must be full, at least ``chunk_bytes - 3`` UTF-8
    bytes (what ``split_agent_tool_payload_text`` always produces): a format
    rule, so a sender cannot drip a value to stretch the transfer. No size
    limit beyond memory. A joined text that does not parse as JSON is reported
    by the caller with reason ``"json"``.
    """

    def invalid(reason: str) -> dict[str, Any]:
        return {"ok": False, "code": AGENT_TOOL_CHUNKS_INVALID, "reason": reason}

    if not isinstance(summary, dict) or not _is_count(summary.get("chunks"), 1) or not _is_count(summary.get("bytes"), 0):
        return invalid("summary")
    if any(not _is_count(c.get("seq"), 0) or not isinstance(c.get("data"), str) for c in chunks):
        return invalid("seq")
    count = summary["chunks"]
    if len(chunks) != count:
        return invalid("count")
    ordered: list[str | None] = [None] * count
    for chunk in chunks:
        seq = chunk["seq"]
        if seq >= count or ordered[seq] is not None:
            return invalid("seq")
        ordered[seq] = chunk["data"]
    if any(utf8_byte_length(piece or "") < chunk_bytes - 3 for piece in ordered[:-1]):
        return invalid("short")
    text = "".join(piece for piece in ordered if piece is not None)
    if utf8_byte_length(text) != summary["bytes"]:
        return invalid("bytes")
    return {"ok": True, "text": text}


def agent_tool_arguments_digest(arguments: Any) -> tuple[str, int]:
    """``args_sha256`` and ``args_bytes`` of the audit row (section 5): the only arguments-size field.

    ``args_bytes`` is measured like ``resultBytes``: the UTF-8 byte length of
    the compact spelling the arguments travel in (``agent_tool_payload_text``).
    ``args_sha256`` hashes the canonical spelling, so equal arguments hash
    equally whatever their key order. Arguments with a fraction cannot be
    spelled canonically (safe integers only); they are hashed in the same
    sorted, compact, ASCII spelling with the numbers as JSON writes them.
    Anything that is not JSON raises.
    """
    # Imported here: disclosure_contract imports this module.
    from .disclosure_contract import CanonicalJsonError, canonical_contract_json

    try:
        spelled = canonical_contract_json(arguments)
    except CanonicalJsonError:
        spelled = json.dumps(arguments, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False)
    return hashlib.sha256(spelled.encode("utf-8")).hexdigest(), utf8_byte_length(agent_tool_payload_text(arguments))


# ── backend → Host: marketplace.query (B2 read-only tools) ──────────────────

MARKETPLACE_QUERY_REQUEST_EVENT = "marketplace.query.request"
MARKETPLACE_QUERY_RESULT_MESSAGE = "marketplace.query.result"
MARKETPLACE_QUERY_KINDS = ("search", "detail", "installed")
MARKETPLACE_QUERY_ERROR_CODES = ("BAD_REQUEST", "NOT_FOUND", "REGISTRY_UNAVAILABLE", "HOST_UNAVAILABLE")


class MarketplaceQueryRequest(TypedDict):
    request_id: str
    query: dict[str, Any]


# ── approval registry (B2) ──────────────────────────────────────────────────

APPROVAL_KINDS = ("skill", "plugin-install", "plugin-update", "plugin-rollback", "plugin-remove")
PLUGIN_APPROVAL_STATUSES = ("pending", "applying", "completed", "rejected", "failed", "expired")
PLUGIN_APPROVAL_DECIDE_ACTION = "plugins.agent_request.decide"
PLUGIN_APPROVAL_TTL_S = 15 * 60


class PluginApprovalRequester(TypedDict):
    paneId: str | None
    paneName: str | None
    workspace: str | None
    callerKind: Literal["pane", "external", "host"]


class PluginApprovalTarget(TypedDict):
    id: str
    namespace: str
    name: str
    version: str | None
    fromVersion: str | None


class PluginApprovalRequest(TypedDict):
    approval_id: str
    kind: Literal["plugin-install", "plugin-update", "plugin-rollback", "plugin-remove"]
    owner: str
    requester: PluginApprovalRequester
    reason: str
    target: PluginApprovalTarget
    card: dict[str, Any] | None
    diff: dict[str, Any] | None
    status: str
    error: str | None
    created_at: float
    expires_at: float


class PluginApprovalDecision(TypedDict):
    approval_id: str
    approve: bool
    confirmation: str


# ── navide.db: audit and activity (B1-d, D-e) ───────────────────────────────

PLUGIN_TOOL_CALLS_RETENTION_DAYS = 30
PLUGIN_TOOL_CALLS_MAX_ROWS = 10_000
PLUGIN_ACTIVITY_DETAIL_RETENTION_DAYS = 7
PLUGIN_ACTIVITY_DAILY_RETENTION_DAYS = 90

#: Executed by B1-d / D-e inside navide.db's existing schema setup; not executed anywhere yet.
PLUGIN_AUDIT_DDL = (
    "CREATE TABLE IF NOT EXISTS plugin_tool_calls ("
    " id INTEGER PRIMARY KEY AUTOINCREMENT,"
    " at INTEGER NOT NULL,"
    " caller_kind TEXT NOT NULL,"
    " pane_id TEXT NOT NULL DEFAULT '',"
    " pane_name TEXT NOT NULL DEFAULT '',"
    " caller_workspace TEXT NOT NULL DEFAULT '',"
    " target_workspace TEXT NOT NULL,"
    " cross_workspace INTEGER NOT NULL,"
    " plugin_id TEXT NOT NULL,"
    " plugin_version TEXT NOT NULL,"
    " tool TEXT NOT NULL,"
    " risk TEXT NOT NULL,"
    " args_sha256 TEXT NOT NULL,"
    " args_bytes INTEGER NOT NULL,"
    " outcome TEXT NOT NULL,"
    " error_code TEXT NOT NULL DEFAULT '',"
    " duration_ms INTEGER NOT NULL,"
    " result_bytes INTEGER NOT NULL)",
    "CREATE INDEX IF NOT EXISTS plugin_tool_calls_at ON plugin_tool_calls (at)",
    "CREATE INDEX IF NOT EXISTS plugin_tool_calls_plugin_at ON plugin_tool_calls (plugin_id, at)",
    "CREATE TABLE IF NOT EXISTS plugin_activity ("
    " id INTEGER PRIMARY KEY AUTOINCREMENT,"
    " at INTEGER NOT NULL,"
    " plugin_id TEXT NOT NULL,"
    " plugin_version TEXT NOT NULL,"
    " workspace TEXT NOT NULL DEFAULT '',"
    " source TEXT NOT NULL,"
    " address TEXT NOT NULL,"
    " outcome TEXT NOT NULL,"
    " denied_reason TEXT NOT NULL DEFAULT '',"
    " fs_path TEXT NOT NULL DEFAULT '',"
    " shell_command TEXT NOT NULL DEFAULT '',"
    " tool_call_id INTEGER)",
    "CREATE INDEX IF NOT EXISTS plugin_activity_at ON plugin_activity (at)",
    "CREATE INDEX IF NOT EXISTS plugin_activity_plugin_at ON plugin_activity (plugin_id, at)",
    "CREATE TABLE IF NOT EXISTS plugin_activity_daily ("
    " day TEXT NOT NULL,"
    " plugin_id TEXT NOT NULL,"
    " workspace TEXT NOT NULL,"
    " source TEXT NOT NULL,"
    " address TEXT NOT NULL,"
    " outcome TEXT NOT NULL,"
    " count INTEGER NOT NULL,"
    " PRIMARY KEY (day, plugin_id, workspace, source, address, outcome))",
)

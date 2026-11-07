"""Production ``navide.browser`` Backend Wire v1 child.

The executable is self-contained and uses the standard library only. It serves
the ``browser_*`` agent tools: every page effect is a Host-private
``navide/host/call`` on the ``web`` bridge port (``list``, ``create``,
``close``, ``cdp``, ``setState``). The Host owns every view and enforces the
human/agent boundary; this child only drives the views it is allowed to.
stdout is reserved for compact protocol frames; diagnostics belong on stderr.
"""

from __future__ import annotations

import difflib
import json
import math
import os
import queue
import re
import sys
import threading
import time
import uuid
from typing import Any, Callable

PROTOCOL_REVISION = "2026-07-28"
SERVER_INFO_KEY = "io.modelcontextprotocol/serverInfo"
SUBSCRIPTION_ID_KEY = "io.modelcontextprotocol/subscriptionId"
EVENT_FILTER_KEY = "dev.navide/pluginEvents"
MAX_FRAME_BYTES = 1_048_576
METHOD_PATTERN = re.compile(r"^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$")
SERVER_INFO = {"name": "navide.browser", "version": "0.1.0"}

# A snapshot's text is bounded so its response always fits one frame.
SNAPSHOT_MAX_CHARS = 400_000
# A screenshot's base64 is bounded the same way; quality steps down until it fits.
SCREENSHOT_MAX_BASE64 = 700_000
SCREENSHOT_QUALITIES = (70, 50, 35, 20)
# A view on no window may paint no frame (Linux/Windows without a compositor,
# software rendering). The Host gives up after ~4s with NO_FRAME_PREFIX; this
# is the backstop so the tool never runs into the 30s plugin timeout.
SCREENSHOT_WAIT_S = 5.0
NO_FRAME_PREFIX = "no-frame"
WAIT_FOR_CONTROL_MAX_MS = 50_000
WAIT_FOR_CONTROL_POLL_S = 1.0
# browser_wait polls the page for a URL, selector or text up to this long.
WAIT_MAX_MS = 30_000
WAIT_DEFAULT_MS = 10_000
WAIT_POLL_S = 0.25
# browser_evaluate: a result's JSON text longer than this is cut and flagged.
EVALUATE_MAX_CHARS = 100_000
EVALUATE_MAX_TIMEOUT_MS = 30_000
EVALUATE_DEFAULT_TIMEOUT_MS = 10_000
# browser_cdp: a raw result's JSON text is bounded the same way as a snapshot.
CDP_RESULT_MAX_CHARS = 400_000
# browser_upload: the Host takes 1 to 16 files per call.
UPLOAD_MAX_FILES = 16
TAKE_OVER_NOTE = "Agent asks to continue"
TABS_ACTIONS = ("list", "new", "select", "close")
DIALOG_ACTIONS = ("accept", "dismiss")
# The CDP methods the Host lets this plugin send (CDP_ALLOWED_METHODS in
# src/main/plugins/pluginWebViews.ts). The Host decides; this copy only
# explains a refusal to the agent.
HOST_CDP_METHODS = (
    "Accessibility.getFullAXTree",
    "DOM.focus",
    "DOM.getBoxModel",
    "DOM.resolveNode",
    "DOM.scrollIntoViewIfNeeded",
    "DOM.setFileInputFiles",
    "DOMSnapshot.captureSnapshot",
    "Input.dispatchKeyEvent",
    "Input.dispatchMouseEvent",
    "Input.insertText",
    "Page.captureScreenshot",
    "Page.getNavigationHistory",
    "Page.handleJavaScriptDialog",
    "Page.navigate",
    "Page.navigateToHistoryEntry",
    "Runtime.callFunctionOn",
    "Runtime.evaluate",
)
LOAD_WAIT_MAX_S = 15.0
LOAD_WAIT_POLL_S = 0.2
ACT_ACTIONS = ("click", "fill", "press", "select", "hover", "scroll", "goto", "back")
REF_RE = re.compile(r"^@([1-9][0-9]{0,15})$")
# AX roles that only wrap content; a nameless one is flattened into its parent.
_STRUCTURAL_ROLES = frozenset({"generic", "none", "presentation", "InlineTextBox", "LineBreak"})
# filter "interactive": landmarks and containers worth expanding (their lines
# say how much they hide), then the controls and headings an agent acts on.
_LANDMARK_ROLES = frozenset({
    "banner", "navigation", "main", "complementary", "contentinfo", "region", "form", "search", "dialog",
    "alertdialog", "listbox", "menu", "menubar", "tablist", "tree",
})
_INTERACTIVE_ROLES = _LANDMARK_ROLES | frozenset({
    "button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "slider", "spinbutton",
    "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "treeitem", "heading",
})
SNAPSHOT_FILTERS = ("all", "interactive")

_MISSING = object()
_write_lock = threading.Lock()
_state_lock = threading.Lock()
_closing = False
_subscriptions: dict[str, dict[str, Any]] = {}
_bridge_pending: dict[str, queue.Queue[tuple[str, Any]]] = {}
_bridge_origin_ids: dict[str, set[str]] = {}
# The tab each Space's tools act on (Space name -> viewId), set by
# browser_tabs new/select. Lost on restart: a Space then acts on its first
# agent tab again, as it did before Spaces had tabs.
_active_tabs: dict[str, str] = {}
# The last viewport snapshot each pane saw of each view ((pane, viewId) ->
# (document URL, text, None when it was cut)), the base browser_act diff compares against. Keyed by
# pane so two panes sharing a Space never diff against each other's reads.
_snapshot_bases: dict[tuple[str | None, str], tuple[str, str | None]] = {}
# The pane whose browser_handoff a view is waiting on (viewId -> pane). On a
# Space any pane may use, another pane's take_over or finish leaves that
# handoff's need-action state and note in place while the user holds control.
_handoffs: dict[str, str | None] = {}


class DuplicateKeyError(ValueError):
    pass


class BridgeFailure(RuntimeError):
    def __init__(self, code: str, reason: str | None = None, message: str | None = None):
        super().__init__(code)
        self.code = code
        self.reason = reason
        self.message = message


class FrameTooLarge(ValueError):
    """A frame would exceed MAX_FRAME_BYTES; the Host kills a child that sends one."""


class ToolError(RuntimeError):
    """A failure the agent should read: returned as an ``ok: false`` result."""

    def __init__(self, code: str, message: str, reason: str | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.reason = reason


Bridge = Callable[[str, dict[str, Any]], Any]


# ---------------------------------------------------------------------------
# Wire v1 framing (same rules as navide.plans)
# ---------------------------------------------------------------------------


def _object_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise DuplicateKeyError(key)
        result[key] = value
    return result


def _reject_constant(value: str) -> None:
    raise ValueError(value)


def _is_record(value: Any) -> bool:
    return isinstance(value, dict)


def _exact_keys(value: Any, keys: tuple[str, ...]) -> bool:
    return _is_record(value) and set(value) == set(keys) and len(value) == len(keys)


def _is_request_id(value: Any) -> bool:
    return (isinstance(value, str) and bool(value)) or (
        isinstance(value, int) and not isinstance(value, bool)
    )


def _is_bridge_id(value: Any) -> bool:
    return isinstance(value, str) and value.startswith("bridge:") and len(value) > 7


def _is_json_value(value: Any) -> bool:
    if value is None or isinstance(value, (bool, str, int)):
        return True
    if isinstance(value, float):
        return math.isfinite(value)
    if isinstance(value, list):
        return all(_is_json_value(item) for item in value)
    if isinstance(value, dict):
        return all(isinstance(key, str) and _is_json_value(item) for key, item in value.items())
    return False


def _is_method_name(value: Any) -> bool:
    return isinstance(value, str) and METHOD_PATTERN.fullmatch(value) is not None


def _is_client_meta(value: Any) -> bool:
    if not _is_record(value):
        return False
    allowed = {
        "io.modelcontextprotocol/protocolVersion",
        "io.modelcontextprotocol/clientCapabilities",
        "io.modelcontextprotocol/clientInfo",
        "progressToken",
    }
    if any(key not in allowed for key in value):
        return False
    if value.get("io.modelcontextprotocol/protocolVersion") != PROTOCOL_REVISION:
        return False
    if not _is_record(value.get("io.modelcontextprotocol/clientCapabilities")):
        return False
    if "io.modelcontextprotocol/clientInfo" in value:
        client_info = value["io.modelcontextprotocol/clientInfo"]
        if not (
            _exact_keys(client_info, ("name", "version"))
            and isinstance(client_info["name"], str)
            and bool(client_info["name"])
            and isinstance(client_info["version"], str)
            and bool(client_info["version"])
        ):
            return False
    return "progressToken" not in value or _is_request_id(value["progressToken"])


def _is_initiator(value: Any) -> bool:
    if not _is_record(value):
        return False
    if value.get("kind") == "user":
        return _exact_keys(value, ("kind", "id")) and isinstance(value["id"], str) and bool(value["id"])
    # An agent initiator may carry the calling pane as `caller`.
    keys = ("kind", "source", "id", "caller") if "caller" in value else ("kind", "source", "id")
    return (
        value.get("kind") == "agent"
        and value.get("source") == "mcp"
        and _exact_keys(value, keys)
        and isinstance(value["id"], str)
        and bool(value["id"])
        and ("caller" not in value or _is_record(value["caller"]))
    )


def _is_runtime(value: Any) -> bool:
    return (
        _exact_keys(
            value,
            (
                "pluginId",
                "packageVersion",
                "workspaceId",
                "instanceId",
                "contributionKey",
                "hostWindowId",
                "initiator",
            ),
        )
        and isinstance(value["pluginId"], str)
        and bool(value["pluginId"])
        and isinstance(value["packageVersion"], str)
        and bool(value["packageVersion"])
        and all(
            value[key] is None or isinstance(value[key], str)
            for key in ("workspaceId", "instanceId", "contributionKey", "hostWindowId")
        )
        and _is_initiator(value["initiator"])
    )


def _is_compact_json(text: str) -> bool:
    in_string = False
    escaped = False
    for character in text:
        if in_string:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
            continue
        if character == '"':
            in_string = True
        elif character in " \t\r\n":
            return False
    return not in_string and not escaped


def _parse_strict(line: bytes) -> Any:
    if not line or len(line) > MAX_FRAME_BYTES:
        raise ValueError("invalid frame size")
    text = line.decode("utf-8", errors="strict")
    if text.startswith("﻿") or not _is_compact_json(text):
        raise ValueError("invalid compact frame")
    return json.loads(text, object_pairs_hook=_object_pairs, parse_constant=_reject_constant)


def _write_frame(frame: Any) -> None:
    # The Host refuses a frame holding a raw U+FEFF anywhere
    # (parseBackendWireFrame), and page text may carry one, so it is written
    # as the escape `﻿`: the same value, read back.
    encoded = (
        json.dumps(frame, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
        .replace("﻿", "\\ufeff")
        .encode("utf-8")
    )
    if b"\n" in encoded or b"\r" in encoded:
        raise ValueError("frame contains a line break")
    if len(encoded) > MAX_FRAME_BYTES:
        raise FrameTooLarge("frame exceeds MAX_FRAME_BYTES")
    with _write_lock:
        sys.stdout.buffer.write(encoded + b"\n")
        sys.stdout.buffer.flush()


def _log(message: str) -> None:
    """Diagnostics go to stderr; stdout is reserved for protocol frames."""
    try:
        sys.stderr.write(f"[navide.browser] {message}\n")
        sys.stderr.flush()
    except (OSError, ValueError):
        pass


def _protocol_error(request_id: Any = _MISSING) -> None:
    frame: dict[str, Any] = {"jsonrpc": "2.0", "error": {"code": -32600, "message": "Invalid request"}}
    if request_id is not _MISSING and _is_request_id(request_id):
        frame["id"] = request_id
    _write_frame(frame)


def _plugin_error(request_id: Any, code: str) -> None:
    _write_frame(
        {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {"code": 1000, "message": "Plugin request failed.", "data": {"code": code}},
        }
    )


def _response(request_id: Any, value: Any = _MISSING, subscription_id: Any = _MISSING) -> None:
    result: dict[str, Any] = {"resultType": "complete"}
    if value is not _MISSING:
        result["value"] = value
    metadata: dict[str, Any] = {SERVER_INFO_KEY: SERVER_INFO}
    if subscription_id is not _MISSING:
        metadata[SUBSCRIPTION_ID_KEY] = subscription_id
    result["_meta"] = metadata
    try:
        _write_frame({"jsonrpc": "2.0", "id": request_id, "result": result})
    except FrameTooLarge:
        _log(f"response for request {request_id!r} exceeded the frame limit")
        _plugin_error(request_id, "RESULT_TOO_LARGE")


def _origin_key(origin: dict[str, Any]) -> str:
    return f"{origin['kind']}:{type(origin['requestId']).__name__}:{origin['requestId']}"


def _deliver_bridge_result(response_queue: queue.Queue[tuple[str, Any]], kind: str, value: Any) -> None:
    try:
        response_queue.put_nowait((kind, value))
    except queue.Full:
        # Cancellation and a Host response may cross in flight; the first wins.
        pass


def _bridge_result(frame: Any) -> bool:
    if not _is_record(frame) or not _is_bridge_id(frame.get("id")):
        return False
    with _state_lock:
        response_queue = _bridge_pending.get(frame["id"])
    if response_queue is None:
        return True
    if (
        _exact_keys(frame, ("jsonrpc", "id", "result"))
        and frame["jsonrpc"] == "2.0"
        and _is_record(frame["result"])
        and frame["result"].get("resultType") == "complete"
        and _is_record(frame["result"].get("_meta"))
        and _is_record(frame["result"]["_meta"].get(SERVER_INFO_KEY))
    ):
        _deliver_bridge_result(response_queue, "result", frame["result"].get("value", _MISSING))
        return True
    if _is_record(frame.get("error")) and frame.get("jsonrpc") == "2.0":
        data = frame["error"].get("data")
        data = data if _is_record(data) else {}
        code = data.get("code")
        reason = data.get("reason")
        message = data.get("message")
        _deliver_bridge_result(
            response_queue,
            "error",
            (
                code if isinstance(code, str) else "BACKEND_UNAVAILABLE",
                reason if isinstance(reason, str) else None,
                message if isinstance(message, str) else None,
            ),
        )
        return True
    _deliver_bridge_result(response_queue, "error", ("PROTOCOL_ERROR", None, None))
    return True


def _bridge_call(origin: dict[str, Any], port: str, operation: str, arguments: Any) -> Any:
    bridge_id = f"bridge:{uuid.uuid4().hex}"
    response_queue: queue.Queue[tuple[str, Any]] = queue.Queue(maxsize=1)
    key = _origin_key(origin)
    with _state_lock:
        _bridge_pending[bridge_id] = response_queue
        _bridge_origin_ids.setdefault(key, set()).add(bridge_id)
    try:
        try:
            _write_frame(
                {
                    "jsonrpc": "2.0",
                    "id": bridge_id,
                    "method": "navide/host/call",
                    "params": {
                        "origin": {"kind": origin["kind"], "requestId": origin["requestId"]},
                        "port": port,
                        "operation": operation,
                        "arguments": arguments,
                    },
                }
            )
        except FrameTooLarge:
            raise BridgeFailure("RESOURCE_LIMIT") from None
        while True:
            try:
                kind, value = response_queue.get(timeout=0.25)
            except queue.Empty:
                with _state_lock:
                    if _closing:
                        raise BridgeFailure("BACKEND_UNAVAILABLE")
                continue
            if kind == "error":
                if isinstance(value, tuple):
                    raise BridgeFailure(*value)
                raise BridgeFailure(str(value))
            return None if value is _MISSING else value
    finally:
        with _state_lock:
            _bridge_pending.pop(bridge_id, None)
            ids = _bridge_origin_ids.get(key)
            if ids is not None:
                ids.discard(bridge_id)
                if not ids:
                    _bridge_origin_ids.pop(key, None)


def _cancel(request_id: Any) -> None:
    if isinstance(request_id, str) and request_id.startswith("bridge:"):
        with _state_lock:
            response_queue = _bridge_pending.get(request_id)
        if response_queue is not None:
            _deliver_bridge_result(response_queue, "error", ("USER_CANCELLED", None, None))
        return
    with _state_lock:
        _subscriptions.pop(_origin_key({"kind": "subscription", "requestId": request_id}), None)
        bridge_ids = list(_bridge_origin_ids.get(f"call:{type(request_id).__name__}:{request_id}", set()))
    for bridge_id in bridge_ids:
        with _state_lock:
            response_queue = _bridge_pending.get(bridge_id)
        if response_queue is not None:
            _deliver_bridge_result(response_queue, "error", ("USER_CANCELLED", None, None))
        try:
            _write_frame(
                {
                    "jsonrpc": "2.0",
                    "method": "notifications/cancelled",
                    "params": {"requestId": bridge_id, "reason": "cancelled"},
                }
            )
        except BrokenPipeError:
            return


# ---------------------------------------------------------------------------
# Page API over the web bridge port
# ---------------------------------------------------------------------------

_USER_IN_CONTROL_MESSAGES = {
    "user-owned": "This Space belongs to the user. Ask the user to choose \"Let the agent use this Space\" first.",
    "manual_takeover": "The user took over this Space. Call browser_wait_for_control and continue once it returns control.",
    "agent_handoff": "An agent handed this Space to the user with browser_handoff. Call browser_wait_for_control and continue once the user returns control.",
    "permission": "The page asked for a permission only the user can grant. Call browser_wait_for_control.",
}


def _user_in_control(reason: str | None) -> ToolError:
    key = reason if reason in _USER_IN_CONTROL_MESSAGES else None
    message = _USER_IN_CONTROL_MESSAGES.get(key or "", "The user is in control of this Space. Call browser_wait_for_control.")
    return ToolError("USER_IN_CONTROL", message, key or reason or "unknown")


def _call(bridge: Bridge, operation: str, arguments: dict[str, Any]) -> Any:
    try:
        return bridge(operation, arguments)
    except BridgeFailure as failure:
        if failure.code == "USER_IN_CONTROL":
            raise _user_in_control(failure.reason) from None
        raise


def _cdp(bridge: Bridge, view_id: str, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    arguments: dict[str, Any] = {"viewId": view_id, "method": method}
    if params:
        arguments["params"] = params
    value = _call(bridge, "cdp", arguments)
    result = value.get("result") if _is_record(value) else None
    return result if _is_record(result) else {}


def _list_views(bridge: Bridge) -> list[dict[str, Any]]:
    value = _call(bridge, "list", {})
    views = value.get("views") if _is_record(value) else None
    return [view for view in views if _is_record(view)] if isinstance(views, list) else []


def _find_view(bridge: Bridge, view_id: str) -> dict[str, Any] | None:
    return next((view for view in _list_views(bridge) if view.get("viewId") == view_id), None)


def _view_summary(view: dict[str, Any]) -> dict[str, Any]:
    keys = ("viewId", "space", "owner", "control", "state", "note", "url", "title", "loading", "openerViewId", "dialog")
    if view.get("owner") == "user":
        keys = ("viewId", "space", "owner", "control", "state", "loading")
    return {key: view[key] for key in keys if key in view}


def pane_space_name(pane: str) -> str:
    return f"pane-{pane[:8]}"


def _other_pane_space(name: Any, pane: str | None) -> bool:
    """A `pane-*` Space that is not the caller's: another pane's own Space."""
    return isinstance(name, str) and name.startswith("pane-") and (pane is None or name != pane_space_name(pane))


def _usable_views(bridge: Bridge, pane: str | None) -> list[dict[str, Any]]:
    """The Host's list without other panes' Spaces (the Host refuses them too)."""
    return [view for view in _list_views(bridge) if not _other_pane_space(view.get("space"), pane)]


def _space_name(arguments: dict[str, Any], pane: str | None) -> str | None:
    """The Space a call means: the `space` it names, else its pane's default."""
    space = arguments.get("space")
    if space is not None:
        if not isinstance(space, str) or not space.strip():
            raise ToolError("INVALID_ARGUMENT", "space must be a non-empty string.")
        if _other_pane_space(space.strip(), pane):
            raise ToolError("OTHER_PANE_SPACE", "That Space belongs to another pane. Use your own Space or one the user handed to agents.")
        return space.strip()
    return pane_space_name(pane) if pane else None


def _space_tabs(views: list[dict[str, Any]], name: str | None) -> list[dict[str, Any]]:
    """Every view (tab) of one Space, in the Host's order."""
    if not name:
        return []
    return [view for view in views if view.get("space") == name and isinstance(view.get("viewId"), str)]


def _named_view(views: list[dict[str, Any]], name: str | None) -> str | None:
    """A Space found by its name in the Host's list: its active tab.

    The active tab is the one browser_tabs last opened or selected, else the
    first tab the agent owns, else the first tab. Nothing but that choice is
    kept in this process, so a restarted backend finds the Space again.
    """
    tabs = _space_tabs(views, name)
    if not tabs:
        return None
    with _state_lock:
        active = _active_tabs.get(name or "")
    if active is not None and any(view["viewId"] == active for view in tabs):
        return active
    agent = next((view for view in tabs if view.get("owner") == "agent"), None)
    return (agent or tabs[0])["viewId"]


def _resolve_view(bridge: Bridge, arguments: dict[str, Any], pane: str | None) -> str:
    """The view an agent tool acts on: an explicit viewId, else the pane's Space."""
    explicit = arguments.get("viewId")
    if explicit is not None:
        if not isinstance(explicit, str) or not explicit:
            raise ToolError("INVALID_ARGUMENT", "viewId must be a non-empty string.")
        # A view the list does not show is left to the Host, which refuses
        # another pane's view whatever it is called.
        if any(view.get("viewId") == explicit and _other_pane_space(view.get("space"), pane) for view in _list_views(bridge)):
            raise ToolError("OTHER_PANE_SPACE", "That Space belongs to another pane. Use your own Space or one the user handed to agents.")
        return explicit
    name = _space_name(arguments, pane)
    if name is None:
        raise ToolError("SPACE_REQUIRED", "This call does not come from a Navide pane; pass viewId or space.")
    view_id = _named_view(_list_views(bridge), name)
    if view_id is None:
        raise ToolError("NO_SPACE", "This Space does not exist yet. Call browser_open first.")
    return view_id


def _evaluate(bridge: Bridge, view_id: str, expression: str) -> Any:
    result = _cdp(bridge, view_id, "Runtime.evaluate", {"expression": expression, "returnByValue": True})
    remote = result.get("result")
    return remote.get("value") if _is_record(remote) else None


def wait_for_load(bridge: Bridge, view_id: str, *, max_s: float = LOAD_WAIT_MAX_S, sleep: Callable[[float], None] = time.sleep) -> bool:
    """Poll document.readyState until it is complete; False when the page never settled."""
    deadline = time.monotonic() + max_s
    while True:
        try:
            if _evaluate(bridge, view_id, "document.readyState") == "complete":
                return True
        except BridgeFailure:
            # The execution context is torn down mid-navigation; try again.
            pass
        if time.monotonic() >= deadline:
            return False
        sleep(LOAD_WAIT_POLL_S)


def _ax_text(field: Any) -> str:
    if _is_record(field):
        value = field.get("value")
        if isinstance(value, (str, int, float)) and not isinstance(value, bool):
            return str(value)
    return ""


def _viewport_nodes(bridge: Bridge, view_id: str) -> tuple[set[int], str]:
    """backendNodeIds whose layout box intersects the visible viewport, and the document URL."""
    metrics = _evaluate(
        bridge,
        view_id,
        "JSON.stringify([scrollX, scrollY, innerWidth, innerHeight])",
    )
    try:
        left, top, width, height = (float(item) for item in json.loads(metrics))
    except (TypeError, ValueError):
        return set(), ""
    if width <= 0 or height <= 0:
        raise _not_rendered()
    captured = _cdp(bridge, view_id, "DOMSnapshot.captureSnapshot", {"computedStyles": []})
    documents = captured.get("documents")
    if not isinstance(documents, list) or not documents or not _is_record(documents[0]):
        return set(), ""
    document = documents[0]
    strings = captured.get("strings")
    url_index = document.get("documentURL")
    url = strings[url_index] if isinstance(strings, list) and isinstance(url_index, int) and 0 <= url_index < len(strings) else ""
    backend_ids = (document.get("nodes") or {}).get("backendNodeId") or []
    layout = document.get("layout") or {}
    visible: set[int] = set()
    for index, bounds in zip(layout.get("nodeIndex") or [], layout.get("bounds") or []):
        if not isinstance(bounds, list) or len(bounds) < 4 or not isinstance(index, int):
            continue
        x, y, w, h = bounds[:4]
        if w <= 0 and h <= 0:
            continue
        if x < left + width and x + w > left and y < top + height and y + h > top and 0 <= index < len(backend_ids):
            visible.add(backend_ids[index])
    return visible, url if isinstance(url, str) else ""


def _not_rendered() -> ToolError:
    return ToolError(
        "VIEW_NOT_RENDERED",
        "The page has no viewport (0x0): it is not laid out, so it cannot be read or captured.",
    )


def snapshot(
    bridge: Bridge, view_id: str, scope: str = "viewport", filter: str = "all", root: Any = None
) -> dict[str, Any]:
    """A compact role/name tree; every element carries a ref ``@<backendDOMNodeId>``.

    Refs are valid only until the page changes; take a new snapshot after any action.
    `filter` "interactive" keeps controls, headings and landmarks only; `root`
    (a ref) renders that element's subtree only. Neither changes a ref.
    """
    return _snapshot(bridge, view_id, scope, filter, root)[0]


def _snapshot(bridge: Bridge, view_id: str, scope: str, filter: str, root: Any) -> tuple[dict[str, Any], str]:
    """snapshot() and, for scope viewport, the document URL it was taken of."""
    if scope not in ("viewport", "full"):
        raise ToolError("INVALID_ARGUMENT", "scope must be viewport or full.")
    if filter not in SNAPSHOT_FILTERS:
        raise ToolError("INVALID_ARGUMENT", "filter must be all or interactive.")
    root_id = _backend_node(root) if root is not None else None
    tree = _cdp(bridge, view_id, "Accessibility.getFullAXTree")
    nodes = [node for node in tree.get("nodes") or [] if _is_record(node)]
    by_id = {node.get("nodeId"): node for node in nodes}
    child_ids = {child for node in nodes for child in node.get("childIds") or []}
    if root_id is None:
        roots = [node for node in nodes if node.get("nodeId") not in child_ids]
    else:
        roots = [node for node in nodes if node.get("backendDOMNodeId") == root_id][:1]
        if not roots:
            raise ToolError("STALE_REF", "The element is gone; take a new browser_snapshot.")
    visible, url = _viewport_nodes(bridge, view_id) if scope == "viewport" else (None, "")
    interactive = filter == "interactive"

    lines: list[str] = []
    truncated = False
    size = 0
    omitted = 0

    def listed(node: dict[str, Any]) -> bool:
        """The node has a line of its own under filter all."""
        role = _ax_text(node.get("role"))
        name = _ax_text(node.get("name")).strip()
        own = not node.get("ignored") and role not in ("", "RootWebArea") and not (
            role in _STRUCTURAL_ROLES and not name
        )
        return own and not (role == "StaticText" and not name)

    def in_viewport(node: dict[str, Any]) -> bool:
        backend_id = node.get("backendDOMNodeId")
        return visible is None or (isinstance(backend_id, int) and backend_id in visible)

    def hidden_below(node: dict[str, Any]) -> int:
        """Lines filter interactive drops under `node`, down to the next kept node."""
        count = 0
        for child_id in node.get("childIds") or []:
            child = by_id.get(child_id)
            if child is None:
                continue
            if listed(child) and _ax_text(child.get("role")) in _INTERACTIVE_ROLES:
                continue
            if listed(child) and in_viewport(child):
                count += 1
            count += hidden_below(child)
        return count

    def render(node: dict[str, Any], depth: int) -> bool:
        """Append the node's subtree; True when anything in it was emitted."""
        nonlocal truncated, size, omitted
        if truncated:
            return False
        role = _ax_text(node.get("role"))
        name = _ax_text(node.get("name")).strip()
        backend_id = node.get("backendDOMNodeId")
        own = listed(node)
        in_view = in_viewport(node)
        if interactive and own and role not in _INTERACTIVE_ROLES:
            own = False
            if in_view:
                omitted += 1
        line_index = len(lines)
        if own and in_view:
            parts = [f"{'  ' * depth}- {role}"]
            if name:
                parts.append(json.dumps(name[:200], ensure_ascii=False))
            value = _ax_text(node.get("value"))
            if value and role != "StaticText":
                parts.append(f"value={json.dumps(value[:200], ensure_ascii=False)}")
            for prop in node.get("properties") or []:
                if _is_record(prop) and prop.get("name") in ("checked", "selected", "expanded", "disabled", "focused"):
                    raw = prop["value"].get("value") if _is_record(prop.get("value")) else None
                    flag = ("true" if raw else "false") if isinstance(raw, bool) else _ax_text(prop.get("value"))
                    if flag and flag != "false":
                        parts.append(f"[{prop['name']}]" if flag == "true" else f"[{prop['name']}={flag}]")
            if isinstance(backend_id, int) and role != "StaticText":
                parts.append(f"@{backend_id}")
            if interactive and role in _LANDMARK_ROLES:
                hidden = hidden_below(node)
                if hidden:
                    parts.append(f"(+{hidden} hidden)")
            line = " ".join(parts)
            if size + len(line) + 1 > SNAPSHOT_MAX_CHARS:
                truncated = True
                return False
            lines.append(line)
            size += len(line) + 1
        emitted_child = False
        for child_id in node.get("childIds") or []:
            child = by_id.get(child_id)
            if child is not None and render(child, depth + 1 if own else depth):
                emitted_child = True
        if own and not in_view and emitted_child:
            # A container off screen whose children are visible keeps its line.
            container = f"{'  ' * depth}- {role}" + (f" {json.dumps(name[:200], ensure_ascii=False)}" if name else "")
            lines.insert(line_index, container)
            size += len(container) + 1
        return (own and in_view) or emitted_child

    for node in roots:
        render(node, 0)
    result: dict[str, Any] = {"scope": scope, "snapshot": "\n".join(lines), "truncated": truncated}
    if interactive:
        result.update(filter=filter, omitted=omitted)
    if root_id is not None:
        result["root"] = f"@{root_id}"
    return result, url


def _backend_node(ref: Any) -> int:
    match = REF_RE.fullmatch(ref) if isinstance(ref, str) else None
    if match is None:
        raise ToolError("INVALID_ARGUMENT", "ref must look like @123, taken from the latest browser_snapshot.")
    return int(match.group(1))


def _center(bridge: Bridge, view_id: str, node: int) -> tuple[float, float]:
    try:
        _cdp(bridge, view_id, "DOM.scrollIntoViewIfNeeded", {"backendNodeId": node})
        box = _cdp(bridge, view_id, "DOM.getBoxModel", {"backendNodeId": node})
    except BridgeFailure as failure:
        raise ToolError("STALE_REF", "The element is gone or not rendered; take a new browser_snapshot.") from failure
    quad = (box.get("model") or {}).get("content") if _is_record(box.get("model")) else None
    if not isinstance(quad, list) or len(quad) < 8:
        raise ToolError("STALE_REF", "The element has no box; take a new browser_snapshot.")
    xs, ys = quad[0::2][:4], quad[1::2][:4]
    return sum(xs) / 4, sum(ys) / 4


def _mouse(bridge: Bridge, view_id: str, kind: str, x: float, y: float, **extra: Any) -> None:
    _cdp(bridge, view_id, "Input.dispatchMouseEvent", {"type": kind, "x": x, "y": y, **extra})


def _call_on(bridge: Bridge, view_id: str, node: int, function: str, arguments: list[Any] | None = None) -> Any:
    try:
        resolved = _cdp(bridge, view_id, "DOM.resolveNode", {"backendNodeId": node})
    except BridgeFailure as failure:
        raise ToolError("STALE_REF", "The element is gone; take a new browser_snapshot.") from failure
    object_id = (resolved.get("object") or {}).get("objectId") if _is_record(resolved.get("object")) else None
    if not isinstance(object_id, str):
        raise ToolError("STALE_REF", "The element is gone; take a new browser_snapshot.")
    params: dict[str, Any] = {"objectId": object_id, "functionDeclaration": function, "returnByValue": True}
    if arguments:
        params["arguments"] = [{"value": item} for item in arguments]
    result = _cdp(bridge, view_id, "Runtime.callFunctionOn", params)
    remote = result.get("result")
    return remote.get("value") if _is_record(remote) else None


_SELECT_CONTENTS = """function () {
  this.focus();
  if (typeof this.select === 'function') { this.select(); return; }
  const range = document.createRange();
  range.selectNodeContents(this);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}"""

_DISPATCH_CHANGE = """function () {
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
}"""

_SELECT_OPTION = """function (wanted) {
  if (!(this instanceof HTMLSelectElement)) return { ok: false, error: 'not-a-select' };
  const option = Array.from(this.options).find(o => o.value === wanted)
    || Array.from(this.options).find(o => o.label.trim() === wanted || o.text.trim() === wanted);
  if (!option) return { ok: false, error: 'no-option', options: Array.from(this.options).slice(0, 50).map(o => o.value) };
  this.value = option.value;
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, value: option.value };
}"""

# key -> (code, windowsVirtualKeyCode, text)
_KEYS: dict[str, tuple[str, int, str]] = {
    "Enter": ("Enter", 13, "\r"),
    "Tab": ("Tab", 9, ""),
    "Escape": ("Escape", 27, ""),
    "Backspace": ("Backspace", 8, ""),
    "Delete": ("Delete", 46, ""),
    "Space": ("Space", 32, " "),
    "ArrowUp": ("ArrowUp", 38, ""),
    "ArrowDown": ("ArrowDown", 40, ""),
    "ArrowLeft": ("ArrowLeft", 37, ""),
    "ArrowRight": ("ArrowRight", 39, ""),
    "Home": ("Home", 36, ""),
    "End": ("End", 35, ""),
    "PageUp": ("PageUp", 33, ""),
    "PageDown": ("PageDown", 34, ""),
}
_MODIFIERS = {"Alt": 1, "Control": 2, "Ctrl": 2, "Meta": 4, "Cmd": 4, "Shift": 8}


def _press(bridge: Bridge, view_id: str, combo: str) -> None:
    parts = combo.split("+") if combo != "+" else ["+"]
    *modifier_names, key = parts
    modifiers = 0
    for name in modifier_names:
        if name not in _MODIFIERS:
            raise ToolError("INVALID_ARGUMENT", f"Unknown modifier {name!r}; use Alt, Control, Meta or Shift.")
        modifiers |= _MODIFIERS[name]
    if key == " ":
        key = "Space"
    if key in _KEYS:
        code, key_code, text = _KEYS[key]
        dom_key = " " if key == "Space" else key
    elif len(key) == 1:
        dom_key, text = key, key
        code = f"Key{key.upper()}" if key.isalpha() else ""
        key_code = ord(key.upper())
    else:
        raise ToolError("INVALID_ARGUMENT", f"Unknown key {key!r}.")
    if modifiers & (2 | 4 | 1):
        # A shortcut types nothing.
        text = ""
    down: dict[str, Any] = {
        "type": "keyDown" if text else "rawKeyDown",
        "key": dom_key,
        "code": code,
        "windowsVirtualKeyCode": key_code,
        "modifiers": modifiers,
    }
    if text:
        down["text"] = text
    _cdp(bridge, view_id, "Input.dispatchKeyEvent", down)
    _cdp(
        bridge,
        view_id,
        "Input.dispatchKeyEvent",
        {"type": "keyUp", "key": dom_key, "code": code, "windowsVirtualKeyCode": key_code, "modifiers": modifiers},
    )


def _http_url(value: Any) -> str:
    if not isinstance(value, str) or not re.match(r"^https?://", value, re.IGNORECASE):
        raise ToolError("INVALID_ARGUMENT", "url must start with http:// or https://.")
    return value


def act(
    bridge: Bridge,
    view_id: str,
    arguments: dict[str, Any],
    *,
    sleep: Callable[[float], None] = time.sleep,
    pane: str | None = None,
) -> dict[str, Any]:
    action = arguments.get("action")
    if action not in ACT_ACTIONS:
        raise ToolError("INVALID_ARGUMENT", f"action must be one of {', '.join(ACT_ACTIONS)}.")
    diff = arguments.get("diff", False)
    if not isinstance(diff, bool):
        raise ToolError("INVALID_ARGUMENT", "diff must be a boolean.")
    result: dict[str, Any] = {"action": action}
    navigates = False
    if action in ("click", "hover"):
        node = _backend_node(arguments.get("ref"))
        x, y = _center(bridge, view_id, node)
        _mouse(bridge, view_id, "mouseMoved", x, y)
        if action == "click":
            _mouse(bridge, view_id, "mousePressed", x, y, button="left", clickCount=1)
            _mouse(bridge, view_id, "mouseReleased", x, y, button="left", clickCount=1)
            navigates = True
    elif action == "fill":
        node = _backend_node(arguments.get("ref"))
        text = arguments.get("value")
        if not isinstance(text, str):
            raise ToolError("INVALID_ARGUMENT", "fill needs value (a string; empty clears the field).")
        _cdp(bridge, view_id, "DOM.scrollIntoViewIfNeeded", {"backendNodeId": node})
        _call_on(bridge, view_id, node, _SELECT_CONTENTS)
        if text:
            _cdp(bridge, view_id, "Input.insertText", {"text": text})
        else:
            _press(bridge, view_id, "Backspace")
        _call_on(bridge, view_id, node, _DISPATCH_CHANGE)
    elif action == "press":
        key = arguments.get("key")
        if not isinstance(key, str) or not key:
            raise ToolError("INVALID_ARGUMENT", "press needs key, such as Enter or Control+a.")
        if arguments.get("ref") is not None:
            node = _backend_node(arguments.get("ref"))
            _cdp(bridge, view_id, "DOM.focus", {"backendNodeId": node})
        _press(bridge, view_id, key)
        navigates = key.endswith("Enter")
    elif action == "select":
        node = _backend_node(arguments.get("ref"))
        wanted = arguments.get("value")
        if not isinstance(wanted, str):
            raise ToolError("INVALID_ARGUMENT", "select needs value (the option's value or label).")
        outcome = _call_on(bridge, view_id, node, _SELECT_OPTION, [wanted])
        if not _is_record(outcome) or outcome.get("ok") is not True:
            error = outcome.get("error") if _is_record(outcome) else None
            raise ToolError("INVALID_ARGUMENT", f"select failed: {error or 'unknown'}.")
        result["value"] = outcome.get("value")
    elif action == "scroll":
        delta_y = arguments.get("deltaY", 600)
        delta_x = arguments.get("deltaX", 0)
        if not all(isinstance(item, int) and not isinstance(item, bool) for item in (delta_x, delta_y)):
            raise ToolError("INVALID_ARGUMENT", "deltaX and deltaY must be integers.")
        if arguments.get("ref") is not None:
            x, y = _center(bridge, view_id, _backend_node(arguments.get("ref")))
        else:
            size = _evaluate(bridge, view_id, "JSON.stringify([innerWidth, innerHeight])")
            try:
                width, height = json.loads(size)
                x, y = float(width) / 2, float(height) / 2
            except (TypeError, ValueError):
                x, y = 100.0, 100.0
        _mouse(bridge, view_id, "mouseWheel", x, y, deltaX=delta_x, deltaY=delta_y)
    elif action == "goto":
        url = _http_url(arguments.get("url"))
        navigated = _cdp(bridge, view_id, "Page.navigate", {"url": url})
        if isinstance(navigated.get("errorText"), str) and navigated["errorText"]:
            raise ToolError("NAVIGATION_FAILED", navigated["errorText"])
        navigates = True
    elif action == "back":
        history = _cdp(bridge, view_id, "Page.getNavigationHistory")
        index = history.get("currentIndex")
        entries = history.get("entries") or []
        if not isinstance(index, int) or index <= 0 or index > len(entries) - 1:
            raise ToolError("NO_HISTORY", "There is no previous page.")
        _cdp(bridge, view_id, "Page.navigateToHistoryEntry", {"entryId": entries[index - 1]["id"]})
        navigates = True
    if navigates:
        # A click or Enter may or may not navigate; give it a moment to start.
        sleep(0.3)
        result["loaded"] = wait_for_load(bridge, view_id, sleep=sleep)
    if diff:
        result.update(_diff_snapshot(bridge, view_id, pane))
    elif arguments.get("snapshot") is True:
        taken, url = _snapshot(bridge, view_id, "viewport", "all", None)
        remember_snapshot(pane, view_id, url, taken)
        result.update(taken)
    return result


def remember_snapshot(pane: str | None, view_id: str, url: str, taken: dict[str, Any]) -> None:
    """Keep a full viewport snapshot as the base of this pane's next diff."""
    with _state_lock:
        _snapshot_bases[(pane, view_id)] = (url, None if taken["truncated"] else taken["snapshot"])


def _forget_snapshots(view_id: str) -> None:
    with _state_lock:
        for key in [key for key in _snapshot_bases if key[1] == view_id]:
            del _snapshot_bases[key]


def _refs(text: str) -> set[str]:
    return set(re.findall(r" (@[0-9]+)(?= |$)", text, re.MULTILINE))


def _diff_snapshot(bridge: Bridge, view_id: str, pane: str | None) -> dict[str, Any]:
    """The viewport after an action as the lines that changed since this pane's last
    snapshot of the view, or the whole of it when a diff would not be the cheaper or
    the truthful answer; `mode` says which one came back."""
    taken, url = _snapshot(bridge, view_id, "viewport", "all", None)
    with _state_lock:
        base = _snapshot_bases.get((pane, view_id))
    remember_snapshot(pane, view_id, url, taken)
    text = taken["snapshot"]
    reason = None
    if base is None:
        reason = "no-base"
    elif taken["truncated"] or base[1] is None:
        reason = "truncated"
    elif base[0] != url:
        reason = "navigated"
    elif _refs(base[1]) and not _refs(base[1]) & _refs(text):
        reason = "stale"
    if reason is None:
        changed = [
            f"{line[0]} {line[1:]}"
            for line in difflib.unified_diff(base[1].splitlines(), text.splitlines(), n=0, lineterm="")
            if line[:1] in "+-" and not line.startswith(("+++", "---"))
        ]
        patch = "\n".join(changed)
        if len(patch) < len(text):
            return {
                "scope": "viewport",
                "snapshot": patch,
                "truncated": False,
                "mode": "diff",
                "added": sum(1 for line in changed if line[0] == "+"),
                "removed": sum(1 for line in changed if line[0] == "-"),
            }
        reason = "larger"
    return {**taken, "mode": "full", "fullReason": reason}


def _no_frame(detail: str) -> ToolError:
    return ToolError(
        "VIEW_NOT_RENDERED",
        f"The page painted no frame to capture ({detail}). A Space that is not shown in the Browser "
        "window may not paint on this system; open it in the Browser window, or use browser_snapshot.",
        reason="no-frame",
    )


def _capture_screenshot(bridge: Bridge, view_id: str, quality: int) -> dict[str, Any]:
    answer: queue.Queue[tuple[bool, Any]] = queue.Queue(maxsize=1)

    def run() -> None:
        try:
            answer.put((True, _cdp(bridge, view_id, "Page.captureScreenshot", {"format": "jpeg", "quality": quality})))
        except BaseException as error:  # noqa: BLE001 - handed to the caller's thread
            answer.put((False, error))

    threading.Thread(target=run, name="navide-browser-screenshot", daemon=True).start()
    try:
        ok, value = answer.get(timeout=SCREENSHOT_WAIT_S)
    except queue.Empty:
        raise _no_frame(f"no answer in {SCREENSHOT_WAIT_S:g}s") from None
    if ok:
        return value
    if isinstance(value, BridgeFailure) and value.code == "CDP_ERROR" and (value.message or "").startswith(NO_FRAME_PREFIX):
        raise _no_frame("the Host found no frame") from None
    raise value


def screenshot(bridge: Bridge, view_id: str) -> dict[str, Any]:
    # A 0x0 page never paints, and Page.captureScreenshot then never answers.
    try:
        metrics = _evaluate(bridge, view_id, "JSON.stringify([scrollX, scrollY, innerWidth, innerHeight])")
        _, _, width, height = (float(item) for item in json.loads(metrics))
    except (TypeError, ValueError):
        width = height = 1.0
    if width <= 0 or height <= 0:
        raise _not_rendered()
    for quality in SCREENSHOT_QUALITIES:
        shot = _capture_screenshot(bridge, view_id, quality)
        data = shot.get("data")
        if not isinstance(data, str):
            raise ToolError("SCREENSHOT_FAILED", "The page returned no image.")
        if len(data) <= SCREENSHOT_MAX_BASE64:
            return {"mimeType": "image/jpeg", "data": data, "quality": quality}
    raise ToolError("SCREENSHOT_TOO_LARGE", "The screenshot is too large even at the lowest quality.")


def wait_for_control(
    bridge: Bridge,
    view_id: str,
    timeout_ms: int,
    *,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> dict[str, Any]:
    """Read-only poll: returns once the user hands control back. Never takes it."""
    deadline = clock() + timeout_ms / 1000
    while True:
        view = _find_view(bridge, view_id)
        if view is None:
            raise ToolError("SPACE_CLOSED", "The Space was closed.")
        if view.get("owner") == "agent" and view.get("control") == "agent":
            return {"control": "agent", "timedOut": False, "view": _view_summary(view)}
        if clock() >= deadline:
            return {"control": view.get("control"), "timedOut": True, "view": _view_summary(view)}
        sleep(WAIT_FOR_CONTROL_POLL_S)


def open_space(bridge: Bridge, arguments: dict[str, Any], pane: str | None) -> dict[str, Any]:
    url = arguments.get("url")
    if url is not None:
        url = _http_url(url)
    explicit = arguments.get("viewId")
    views = _usable_views(bridge, pane)
    if isinstance(explicit, str) and explicit:
        if not any(view.get("viewId") == explicit for view in views):
            raise ToolError("SPACE_CLOSED", "No Space has that viewId.")
        view_id: str | None = explicit
    else:
        name = _space_name(arguments, pane)
        if name is None:
            raise ToolError("SPACE_REQUIRED", "This call does not come from a Navide pane; pass space to name the Space.")
        view_id = _named_view(views, name)
        # A tab the user restored in this pane's Space is the user's; the
        # agent gets a tab of its own instead of being refused.
        if view_id is not None and pane and name == pane_space_name(pane) and any(
            view.get("viewId") == view_id and view.get("owner") == "user" for view in views
        ):
            view_id = None
    if view_id is None:
        created_arguments: dict[str, Any] = {"space": name}
        if url is not None:
            created_arguments["url"] = url
        created = _call(bridge, "create", created_arguments)
        view_id = created.get("viewId") if _is_record(created) else None
        if not isinstance(view_id, str):
            raise BridgeFailure("PROTOCOL_ERROR")
    elif url is not None:
        navigated = _cdp(bridge, view_id, "Page.navigate", {"url": url})
        if isinstance(navigated.get("errorText"), str) and navigated["errorText"]:
            raise ToolError("NAVIGATION_FAILED", navigated["errorText"])
    loaded = wait_for_load(bridge, view_id) if url is not None else True
    view = _find_view(bridge, view_id) or {"viewId": view_id}
    return {"loaded": loaded, "view": _view_summary(view)}


def _set_state(bridge: Bridge, view_id: str, state: str, note: Any) -> None:
    arguments: dict[str, Any] = {"viewId": view_id, "state": state}
    if note is not None:
        if not isinstance(note, str):
            raise ToolError("INVALID_ARGUMENT", "note must be a string.")
        arguments["note"] = note[:500]
    _call(bridge, "setState", arguments)


def _resolve_tab(bridge: Bridge, arguments: dict[str, Any], pane: str | None) -> str:
    """The tab a call acts on: `tab` (a viewId in the Space), else the Space's active tab."""
    tab = arguments.get("tab")
    if tab is None:
        return _resolve_view(bridge, arguments, pane)
    if not isinstance(tab, str) or not tab:
        raise ToolError("INVALID_ARGUMENT", "tab must be a viewId from browser_tabs.")
    view_id = _resolve_view(bridge, {**{k: v for k, v in arguments.items() if k != "space"}, "viewId": tab}, pane)
    if arguments.get("space") is not None:
        name = _space_name(arguments, pane)
        view = _find_view(bridge, view_id)
        if view is not None and view.get("space") != name:
            raise ToolError("INVALID_ARGUMENT", "That tab is not in this Space; call browser_tabs to list its tabs.")
    return view_id


def _target_space(bridge: Bridge, arguments: dict[str, Any], pane: str | None) -> tuple[str, list[dict[str, Any]]]:
    """The Space a tab call means (by viewId's Space, space, or the pane's own) and its usable views."""
    views = _usable_views(bridge, pane)
    explicit = arguments.get("viewId")
    if explicit is not None:
        if not isinstance(explicit, str) or not explicit:
            raise ToolError("INVALID_ARGUMENT", "viewId must be a non-empty string.")
        view = next((view for view in views if view.get("viewId") == explicit), None)
        if view is None or not isinstance(view.get("space"), str):
            raise ToolError("SPACE_CLOSED", "No Space has that viewId.")
        return view["space"], views
    name = _space_name(arguments, pane)
    if name is None:
        raise ToolError("SPACE_REQUIRED", "This call does not come from a Navide pane; pass viewId or space.")
    return name, views


def _tab_summary(view: dict[str, Any], active: str | None) -> dict[str, Any]:
    tab: dict[str, Any] = {
        "viewId": view.get("viewId"),
        "url": view.get("url", "") if view.get("owner") != "user" else "",
        "title": view.get("title", "") if view.get("owner") != "user" else "",
        "active": view.get("viewId") == active,
    }
    if isinstance(view.get("openerViewId"), str):
        tab["openerViewId"] = view["openerViewId"]
    return tab


def _tabs_value(name: str, views: list[dict[str, Any]]) -> dict[str, Any]:
    active = _named_view(views, name)
    return {"space": name, "tabs": [_tab_summary(view, active) for view in _space_tabs(views, name)]}


def tabs(bridge: Bridge, arguments: dict[str, Any], pane: str | None, *, sleep: Callable[[float], None] = time.sleep) -> dict[str, Any]:
    action = arguments.get("action", "list")
    if action not in TABS_ACTIONS:
        raise ToolError("INVALID_ARGUMENT", f"action must be one of {', '.join(TABS_ACTIONS)}.")
    name, views = _target_space(bridge, arguments, pane)
    if action == "list":
        return _tabs_value(name, views)
    if action == "new":
        url = arguments.get("url")
        created_arguments: dict[str, Any] = {"space": name}
        if url is not None:
            created_arguments["url"] = _http_url(url)
        created = _call(bridge, "create", created_arguments)
        view_id = created.get("viewId") if _is_record(created) else None
        if not isinstance(view_id, str):
            raise BridgeFailure("PROTOCOL_ERROR")
        with _state_lock:
            _active_tabs[name] = view_id
        loaded = wait_for_load(bridge, view_id, sleep=sleep) if url is not None else True
        return {"viewId": view_id, "loaded": loaded, **_tabs_value(name, _usable_views(bridge, pane))}
    tab = arguments.get("tab")
    if tab is None and action == "close":
        tab = _named_view(views, name)
    if not isinstance(tab, str) or not any(view["viewId"] == tab for view in _space_tabs(views, name)):
        raise ToolError("NO_TAB", "That tab is not in this Space; call browser_tabs with action list.")
    if action == "select":
        with _state_lock:
            _active_tabs[name] = tab
        return {"viewId": tab, **_tabs_value(name, views)}
    _call(bridge, "close", {"viewId": tab})
    _forget_snapshots(tab)
    with _state_lock:
        _handoffs.pop(tab, None)
    with _state_lock:
        if _active_tabs.get(name) == tab:
            del _active_tabs[name]
    return {"closed": [tab], **_tabs_value(name, _usable_views(bridge, pane))}


def close(bridge: Bridge, arguments: dict[str, Any], pane: str | None) -> dict[str, Any]:
    """Close one tab, or with all every tab the agent owns in the Space."""
    whole = arguments.get("all", False)
    if not isinstance(whole, bool):
        raise ToolError("INVALID_ARGUMENT", "all must be a boolean.")
    if not whole:
        view_id = _resolve_tab(bridge, arguments, pane)
        _call(bridge, "close", {"viewId": view_id})
        _forget_snapshots(view_id)
        with _state_lock:
            _handoffs.pop(view_id, None)
        with _state_lock:
            for name, active in list(_active_tabs.items()):
                if active == view_id:
                    del _active_tabs[name]
        return {"closed": [view_id], "skipped": []}
    name, views = _target_space(bridge, arguments, pane)
    tabs_in_space = _space_tabs(views, name)
    if not tabs_in_space:
        raise ToolError("NO_SPACE", "This Space does not exist.")
    closed: list[str] = []
    skipped: list[str] = []
    for view in tabs_in_space:
        if view.get("owner") != "agent":
            skipped.append(view["viewId"])
            continue
        _call(bridge, "close", {"viewId": view["viewId"]})
        _forget_snapshots(view["viewId"])
        with _state_lock:
            _handoffs.pop(view["viewId"], None)
        closed.append(view["viewId"])
    with _state_lock:
        _active_tabs.pop(name, None)
    return {"closed": closed, "skipped": skipped}


def _bounded_timeout(arguments: dict[str, Any], default: int, maximum: int) -> int:
    timeout = arguments.get("timeoutMs", default)
    if not isinstance(timeout, int) or isinstance(timeout, bool) or timeout < 0:
        raise ToolError("INVALID_ARGUMENT", "timeoutMs must be a non-negative integer.")
    return min(timeout, maximum)


def _bounded_json(value: Any, max_chars: int) -> dict[str, Any]:
    """`value` as is when its JSON fits, else its JSON text cut to max_chars."""
    text = json.dumps(value, ensure_ascii=False)
    if len(text) <= max_chars:
        return {"value": value, "truncated": False}
    return {"valueJson": text[:max_chars], "truncated": True}


def evaluate(bridge: Bridge, view_id: str, arguments: dict[str, Any]) -> dict[str, Any]:
    expression = arguments.get("expression")
    if not isinstance(expression, str) or not expression.strip():
        raise ToolError("INVALID_ARGUMENT", "expression must be a non-empty string.")
    timeout = _bounded_timeout(arguments, EVALUATE_DEFAULT_TIMEOUT_MS, EVALUATE_MAX_TIMEOUT_MS)
    await_promise = arguments.get("awaitPromise", True)
    if not isinstance(await_promise, bool):
        raise ToolError("INVALID_ARGUMENT", "awaitPromise must be a boolean.")
    try:
        params: dict[str, Any] = {"expression": expression, "returnByValue": True, "awaitPromise": await_promise}
        if timeout > 0:
            params["timeout"] = timeout
        result = _cdp(bridge, view_id, "Runtime.evaluate", params)
    except BridgeFailure as failure:
        if failure.code == "CDP_ERROR":
            raise ToolError("EVALUATE_FAILED", failure.message or "The page refused the script.") from None
        raise
    details = result.get("exceptionDetails")
    if _is_record(details):
        exception = details.get("exception")
        text = exception.get("description") if _is_record(exception) else None
        raise ToolError("EVALUATE_FAILED", str(text or details.get("text") or "The script threw.")[:2000])
    remote = result.get("result") if _is_record(result.get("result")) else {}
    return {"type": remote.get("type", "undefined"), **_bounded_json(remote.get("value"), EVALUATE_MAX_CHARS)}


_WAIT_PROBE = """(function (selector, text) {
  var found = true;
  if (selector !== null) {
    try { found = document.querySelector(selector) !== null; } catch (e) { return 'invalid-selector'; }
  }
  if (found && text !== null) found = !!document.body && document.body.innerText.indexOf(text) !== -1;
  return found;
})(%s, %s)"""


def wait(
    bridge: Bridge,
    view_id: str,
    arguments: dict[str, Any],
    *,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> dict[str, Any]:
    """Poll until every given condition holds (URL, selector, text), up to timeoutMs."""
    url = arguments.get("url")
    url_regex = arguments.get("urlRegex")
    selector = arguments.get("selector")
    text = arguments.get("text")
    for key, value in (("url", url), ("urlRegex", url_regex), ("selector", selector), ("text", text)):
        if value is not None and (not isinstance(value, str) or not value):
            raise ToolError("INVALID_ARGUMENT", f"{key} must be a non-empty string.")
    if url is None and url_regex is None and selector is None and text is None:
        raise ToolError("INVALID_ARGUMENT", "Pass at least one of url, urlRegex, selector or text.")
    pattern = None
    if url_regex is not None:
        try:
            pattern = re.compile(url_regex)
        except re.error as error:
            raise ToolError("INVALID_ARGUMENT", f"urlRegex is not a valid regular expression: {error}.") from None
    timeout = _bounded_timeout(arguments, WAIT_DEFAULT_MS, WAIT_MAX_MS)
    started = clock()
    deadline = started + timeout / 1000
    probe = _WAIT_PROBE % (json.dumps(selector), json.dumps(text)) if selector is not None or text is not None else None
    while True:
        view = _find_view(bridge, view_id)
        if view is None:
            raise ToolError("SPACE_CLOSED", "The Space was closed.")
        current = view.get("url") if isinstance(view.get("url"), str) else ""
        matched = (url is None or url in current) and (pattern is None or pattern.search(current) is not None)
        if matched and probe is not None:
            try:
                outcome = _evaluate(bridge, view_id, probe)
            except BridgeFailure as failure:
                if failure.code != "CDP_ERROR":
                    raise
                # The document is being replaced mid-navigation; poll again.
                outcome = False
            if outcome == "invalid-selector":
                raise ToolError("INVALID_ARGUMENT", "selector is not a valid CSS selector.")
            matched = outcome is True
        waited = int(round((clock() - started) * 1000))
        if matched:
            return {"matched": True, "timedOut": False, "waitedMs": waited, "url": current}
        if clock() >= deadline:
            return {"matched": False, "timedOut": True, "waitedMs": waited, "url": current}
        sleep(WAIT_POLL_S)


def dialog(bridge: Bridge, view_id: str, arguments: dict[str, Any]) -> dict[str, Any]:
    action = arguments.get("action")
    if action not in DIALOG_ACTIONS:
        raise ToolError("INVALID_ARGUMENT", "action must be accept or dismiss.")
    prompt_text = arguments.get("promptText")
    if prompt_text is not None and not isinstance(prompt_text, str):
        raise ToolError("INVALID_ARGUMENT", "promptText must be a string.")
    view = _find_view(bridge, view_id)
    if view is None:
        raise ToolError("SPACE_CLOSED", "The Space was closed.")
    opened = view.get("dialog")
    if not _is_record(opened):
        raise ToolError("NO_DIALOG", "No dialog is open in this tab.")
    params: dict[str, Any] = {"accept": action == "accept"}
    if prompt_text is not None:
        params["promptText"] = prompt_text
    _cdp(bridge, view_id, "Page.handleJavaScriptDialog", params)
    return {"handled": action, "dialog": {key: opened[key] for key in ("type", "message") if key in opened}}


def upload(bridge: Bridge, view_id: str, arguments: dict[str, Any], workspace: str | None) -> dict[str, Any]:
    node = _backend_node(arguments.get("ref"))
    files = arguments.get("files")
    if not isinstance(files, list) or not 1 <= len(files) <= UPLOAD_MAX_FILES or not all(
        isinstance(item, str) and item for item in files
    ):
        raise ToolError("INVALID_ARGUMENT", f"files must list 1 to {UPLOAD_MAX_FILES} paths inside this pane's workspace.")
    absolute: list[str] = []
    for item in files:
        if os.path.isabs(item):
            absolute.append(item)
        elif workspace:
            # The Host checks every resolved path is inside this workspace.
            # normpath: one separator style on Windows (`a/b` joined to `C:\w`).
            absolute.append(os.path.normpath(os.path.join(workspace, item)))
        else:
            raise ToolError("INVALID_ARGUMENT", "Relative paths need a call from a Navide pane; pass absolute paths.")
    try:
        result = _cdp(bridge, view_id, "DOM.setFileInputFiles", {"files": absolute, "backendNodeId": node})
    except BridgeFailure as failure:
        if failure.code == "CAPABILITY_DENIED":
            raise ToolError(
                "UPLOAD_DENIED",
                "Every file must be an existing regular file inside this pane's workspace (1 to 16 files).",
            ) from None
        if failure.code == "CDP_ERROR":
            raise ToolError("STALE_REF", failure.message or "The element is not a file input; take a new browser_snapshot.") from None
        raise
    value: dict[str, Any] = {"uploaded": result.get("uploaded", [])}
    if "warning" in result:
        value["warning"] = result["warning"]
    return value


def _others_handoff_pending(view: dict[str, Any] | None, pane: str | None) -> bool:
    """The user still holds a view this backend saw another pane hand off.

    A need-action of unknown origin (one set before a restart, or not through
    browser_handoff) is not protected: take_over and finish act on it as they
    always did.
    """
    if view is None or view.get("control") != "user" or view.get("state") != "need-action":
        return False
    with _state_lock:
        return view.get("viewId") in _handoffs and _handoffs[view["viewId"]] != pane


def take_over(
    bridge: Bridge,
    view_id: str,
    arguments: dict[str, Any],
    *,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
    pane: str | None = None,
) -> dict[str, Any]:
    """Ask the user for control back, then wait. Never takes control itself."""
    view = _find_view(bridge, view_id)
    if view is None:
        raise ToolError("SPACE_CLOSED", "The Space was closed.")
    if view.get("owner") != "agent":
        raise _user_in_control("user-owned")
    if view.get("control") == "agent":
        return {"asked": False, "control": "agent", "timedOut": False, "view": _view_summary(view)}
    note = arguments.get("note")
    if note is not None and not isinstance(note, str):
        raise ToolError("INVALID_ARGUMENT", "note must be a string.")
    timeout = _bounded_timeout(arguments, WAIT_FOR_CONTROL_MAX_MS, WAIT_FOR_CONTROL_MAX_MS)
    # running, not need-action: entering need-action reloads a page the agent
    # ran script in, which would throw away what the user is doing there.
    # Another pane's handoff the user has not finished keeps its own request.
    if not _others_handoff_pending(view, pane):
        _set_state(bridge, view_id, "running", f"{TAKE_OVER_NOTE}: {note}" if note else TAKE_OVER_NOTE)
    return {"asked": True, **wait_for_control(bridge, view_id, timeout, sleep=sleep, clock=clock)}


def raw_cdp(bridge: Bridge, view_id: str, arguments: dict[str, Any]) -> dict[str, Any]:
    method = arguments.get("method")
    params = arguments.get("params")
    if not isinstance(method, str) or not re.fullmatch(r"[A-Z][A-Za-z]*\.[a-zA-Z]+", method):
        raise ToolError("INVALID_ARGUMENT", "method must look like Domain.method, such as DOM.getBoxModel.")
    if params is not None and not _is_record(params):
        raise ToolError("INVALID_ARGUMENT", "params must be an object.")
    try:
        result = _cdp(bridge, view_id, method, params)
    except BridgeFailure as failure:
        if failure.code == "CAPABILITY_DENIED":
            raise ToolError(
                "METHOD_NOT_ALLOWED",
                f"Navide allows only these CDP methods: {', '.join(HOST_CDP_METHODS)}.",
            ) from None
        if failure.code == "CDP_ERROR":
            raise ToolError("CDP_ERROR", failure.message or "The page refused the command.") from None
        raise
    return {"method": method, **_bounded_json(result, CDP_RESULT_MAX_CHARS)}


def run_tool(
    name: str,
    arguments: dict[str, Any],
    bridge: Bridge,
    pane: str | None,
    workspace: str | None = None,
) -> dict[str, Any]:
    """One agent tool call; failures the agent can act on come back as ok: false."""
    try:
        if name == "browser.list":
            views = _usable_views(bridge, pane)
            value: dict[str, Any] = {
                "views": [_view_summary(view) for view in views],
                "yourSpace": _named_view(views, pane_space_name(pane) if pane else None),
            }
        elif name == "browser.open":
            value = open_space(bridge, arguments, pane)
        elif name == "browser.snapshot":
            view_id = _resolve_view(bridge, arguments, pane)
            scope = arguments.get("scope", "viewport")
            filter_ = arguments.get("filter", "all")
            taken, url = _snapshot(bridge, view_id, scope, filter_, arguments.get("root"))
            if scope == "viewport" and filter_ == "all" and arguments.get("root") is None:
                remember_snapshot(pane, view_id, url, taken)
            value = {"viewId": view_id, **taken}
        elif name == "browser.act":
            view_id = _resolve_view(bridge, arguments, pane)
            value = {"viewId": view_id, **act(bridge, view_id, arguments, pane=pane)}
        elif name == "browser.screenshot":
            view_id = _resolve_view(bridge, arguments, pane)
            value = {"viewId": view_id, **screenshot(bridge, view_id)}
        elif name == "browser.handoff":
            view_id = _resolve_view(bridge, arguments, pane)
            _set_state(bridge, view_id, "need-action", arguments.get("note"))
            with _state_lock:
                _handoffs[view_id] = pane
            value = {"viewId": view_id, "state": "need-action", "control": "user"}
        elif name == "browser.control.wait":
            view_id = _resolve_view(bridge, arguments, pane)
            timeout = arguments.get("timeoutMs", WAIT_FOR_CONTROL_MAX_MS)
            if not isinstance(timeout, int) or isinstance(timeout, bool) or timeout < 0:
                raise ToolError("INVALID_ARGUMENT", "timeoutMs must be a non-negative integer.")
            value = {"viewId": view_id, **wait_for_control(bridge, view_id, min(timeout, WAIT_FOR_CONTROL_MAX_MS))}
        elif name == "browser.finish":
            view_id = _resolve_view(bridge, arguments, pane)
            if _others_handoff_pending(_find_view(bridge, view_id), pane):
                value = {"viewId": view_id, "state": "need-action", "handoffPending": True}
            else:
                _set_state(bridge, view_id, "done", arguments.get("note"))
                value = {"viewId": view_id, "state": "done"}
        elif name == "browser.close":
            value = close(bridge, arguments, pane)
        elif name == "browser.tabs":
            value = tabs(bridge, arguments, pane)
        elif name == "browser.evaluate":
            view_id = _resolve_tab(bridge, arguments, pane)
            value = {"viewId": view_id, **evaluate(bridge, view_id, arguments)}
        elif name == "browser.wait":
            view_id = _resolve_tab(bridge, arguments, pane)
            value = {"viewId": view_id, **wait(bridge, view_id, arguments)}
        elif name == "browser.dialog":
            view_id = _resolve_tab(bridge, arguments, pane)
            value = {"viewId": view_id, **dialog(bridge, view_id, arguments)}
        elif name == "browser.upload":
            view_id = _resolve_tab(bridge, arguments, pane)
            value = {"viewId": view_id, **upload(bridge, view_id, arguments, workspace)}
        elif name == "browser.takeover":
            view_id = _resolve_tab(bridge, arguments, pane)
            value = {"viewId": view_id, **take_over(bridge, view_id, arguments, pane=pane)}
        elif name == "browser.cdp":
            view_id = _resolve_tab(bridge, arguments, pane)
            value = {"viewId": view_id, **raw_cdp(bridge, view_id, arguments)}
        else:
            raise ToolError("UNKNOWN_METHOD", name)
    except ToolError as error:
        failure: dict[str, Any] = {"ok": False, "error": error.code, "message": error.message}
        if error.reason is not None:
            failure["reason"] = error.reason
        return failure
    return {"ok": True, **value}


TOOL_METHODS = frozenset(
    {
        "browser.list",
        "browser.open",
        "browser.snapshot",
        "browser.act",
        "browser.screenshot",
        "browser.handoff",
        "browser.control.wait",
        "browser.finish",
        "browser.close",
        "browser.tabs",
        "browser.evaluate",
        "browser.wait",
        "browser.dialog",
        "browser.upload",
        "browser.takeover",
        "browser.cdp",
    }
)


# ---------------------------------------------------------------------------
# Request handling
# ---------------------------------------------------------------------------


def _valid_request(frame: Any, method: str, keys: tuple[str, ...]) -> bool:
    return (
        _exact_keys(frame, ("jsonrpc", "id", "method", "params"))
        and frame["jsonrpc"] == "2.0"
        and _is_request_id(frame["id"])
        and frame["method"] == method
        and _exact_keys(frame["params"], keys)
        and _is_client_meta(frame["params"].get("_meta"))
    )


def _handle(frame: Any) -> None:
    if _bridge_result(frame):
        return
    if _is_record(frame) and frame.get("method") == "navide/host/event":
        # This child subscribes to no Host events.
        return
    if _is_record(frame) and frame.get("method") == "notifications/cancelled":
        params = frame.get("params")
        if (
            not _exact_keys(frame, ("jsonrpc", "method", "params"))
            or frame["jsonrpc"] != "2.0"
            or not _is_record(params)
            or "requestId" not in params
            or any(key not in {"requestId", "reason"} for key in params)
            or not _is_request_id(params["requestId"])
        ):
            _protocol_error()
            return
        _cancel(params["requestId"])
        return

    if _valid_request(frame, "navide/health", ("_meta",)):
        metadata = frame["params"]["_meta"]
        _response(
            frame["id"],
            {
                "method": "navide/health",
                "protocolVersion": metadata["io.modelcontextprotocol/protocolVersion"],
                "requestIdIsNonNull": frame["id"] is not None,
                "clientCapabilities": metadata["io.modelcontextprotocol/clientCapabilities"],
            },
        )
        return

    if _valid_request(frame, "subscriptions/listen", ("_meta", "notifications", "runtime")):
        notifications = frame["params"]["notifications"]
        events = notifications.get(EVENT_FILTER_KEY) if _is_record(notifications) else None
        if (
            not _is_record(notifications)
            or set(notifications) != {EVENT_FILTER_KEY}
            or not isinstance(events, list)
            or not events
            or len(set(events)) != len(events)
            or not all(_is_method_name(event) for event in events)
            or not _is_runtime(frame["params"]["runtime"])
        ):
            _protocol_error(frame["id"])
            return
        subscription = {"id": frame["id"], "events": events}
        with _state_lock:
            _subscriptions[_origin_key({"kind": "subscription", "requestId": frame["id"]})] = subscription
        _write_frame(
            {
                "jsonrpc": "2.0",
                "method": "notifications/subscriptions/acknowledged",
                "params": {
                    "_meta": {SUBSCRIPTION_ID_KEY: frame["id"]},
                    "notifications": {EVENT_FILTER_KEY: events},
                },
            }
        )
        return

    if not _valid_request(frame, "navide/call", ("_meta", "name", "arguments", "runtime")):
        _protocol_error(frame.get("id", _MISSING) if _is_record(frame) else _MISSING)
        return
    name = frame["params"]["name"]
    arguments = frame["params"]["arguments"]
    runtime = frame["params"]["runtime"]
    if not _is_method_name(name) or not _is_runtime(runtime) or not _is_json_value(arguments) or not _is_record(arguments):
        _protocol_error(frame["id"])
        return
    if name not in TOOL_METHODS:
        _write_frame({"jsonrpc": "2.0", "id": frame["id"], "error": {"code": -32601, "message": "Method not found"}})
        return
    origin = {"kind": "call", "requestId": frame["id"]}
    # Each agent pane gets its own Space. initiator.id is new on every call;
    # the pane is caller.paneId, present only for a pane caller.
    caller = runtime["initiator"].get("caller")
    pane_id = caller.get("paneId") if _is_record(caller) and caller.get("kind") == "pane" else None
    pane = pane_id if isinstance(pane_id, str) and pane_id else None
    caller_workspace = caller.get("workspace") if pane is not None and _is_record(caller) else None
    workspace = caller_workspace if isinstance(caller_workspace, str) and caller_workspace else None

    def bridge(operation: str, bridge_arguments: dict[str, Any]) -> Any:
        return _bridge_call(origin, "web", operation, bridge_arguments)

    try:
        result = run_tool(name, arguments, bridge, pane, workspace)
    except BridgeFailure as error:
        _plugin_error(frame["id"], error.code)
        return
    except Exception as error:
        # Any other failure would kill this request thread with no reply.
        _log(f"{name} failed: {type(error).__name__}: {error}")
        _plugin_error(frame["id"], "BACKEND_ERROR")
        return
    _response(frame["id"], result)


def _fail_closed() -> None:
    global _closing
    with _state_lock:
        _closing = True
        _subscriptions.clear()
        pending = list(_bridge_pending.values())
    for response_queue in pending:
        try:
            response_queue.put_nowait(("error", ("BACKEND_UNAVAILABLE", None, None)))
        except queue.Full:
            pass
    raise SystemExit(2)


def main() -> int:
    try:
        for raw in sys.stdin.buffer:
            if not raw.endswith(b"\n"):
                _fail_closed()
            frame = _parse_strict(raw[:-1])
            if _is_record(frame) and frame.get("method") in {"navide/call", "subscriptions/listen"}:
                threading.Thread(target=_handle, args=(frame,), daemon=True).start()
            else:
                _handle(frame)
    except (UnicodeDecodeError, DuplicateKeyError, ValueError, json.JSONDecodeError):
        _fail_closed()
    except BrokenPipeError:
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

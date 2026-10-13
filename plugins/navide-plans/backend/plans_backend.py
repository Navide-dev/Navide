"""Production ``navide.plans`` Backend Wire v1 child.

The executable is intentionally self-contained.  It owns plan-domain parsing
and mutation and reads plan files itself, under the plan root the Host
authorizes through the authenticated filesystem bridge (``resolve_root``); the
remaining workspace effects are Host-private ``navide/host/call`` requests.
stdout is reserved for compact protocol frames; diagnostics belong on stderr.
"""

from __future__ import annotations

import base64
import codecs
import json
import math
import os
import queue
import re
import stat
import sys
import threading
import uuid
from datetime import date, datetime, timezone
from html import escape as html_escape
from pathlib import Path
from typing import Any

import yaml
from agent_team_backend.fs_write import (
    _WRITE_PART_MAX_BYTES,
    _resolve_mutation_safe,
    write_abort,
    write_commit,
    write_file,
    write_part,
)
from agent_team_backend.path_guard import FsError, _resolve_safe

PROTOCOL_REVISION = "2026-07-28"
SERVER_INFO_KEY = "io.modelcontextprotocol/serverInfo"
SUBSCRIPTION_ID_KEY = "io.modelcontextprotocol/subscriptionId"
EVENT_FILTER_KEY = "dev.navide/pluginEvents"
MAX_FRAME_BYTES = 1_048_576
# One part of a renderer's chunked document write (it travels base64-encoded
# inside one request frame), and one step of a plan-meta head scan.
RANGE_CHUNK_BYTES = 96 * 1024
# File bytes returned by one plans.read / plans.read_document call. The caller
# pages with next_offset; this only bounds one response, never the document.
TEXT_CHUNK_BYTES = 256 * 1024
# JSON-encoded size a single chunk's text may take inside one response frame.
FRAME_TEXT_BUDGET_BYTES = 900_000
# Content up to this many UTF-8 bytes is written in one write_file call (the
# common case: a plan is a few dozen KB); a larger one is staged part by part
# and swapped in atomically, so a document of any size can be updated.
SINGLE_WRITE_MAX_BYTES = 256 * 1024
# One plans.list page, and the size past which an un-paged plans.list drops
# each entry's full meta so its single frame can never exceed MAX_FRAME_BYTES.
LIST_PAGE_BUDGET_BYTES = 640 * 1024
LIST_INLINE_BUDGET_BYTES = 700_000
METHOD_PATTERN = re.compile(r"^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$")
PLAN_META_RE = re.compile(
    r"<script\b[^>]*\s(?:id=\"plan-meta\"|id='plan-meta')[^>]*>([\s\S]*?)</script>",
    re.IGNORECASE,
)
STAGE_PILL_RE = re.compile(
    r"(<span\b[^>]*\bclass=[\"'][^\"']*\bpill\b)([^\"']*)([\"'][^>]*>)[^<]*(</span>)",
    re.IGNORECASE,
)
TODO_STATUS_SPAN_RE = re.compile(
    r"(<span\b[^>]*\bclass=[\"'][^\"']*\bst\b[^\"']*[\"'][^>]*>)[^<]*(</span>)",
    re.IGNORECASE,
)
TODO_ID_RE = re.compile(r"[a-z0-9][a-z0-9-]*$")
NOTE_ID_RE = re.compile(r"^n(\d+)$")
PLAN_STAGES = {"draft", "in-review", "approved", "in-progress", "done", "abandoned"}
TODO_STATUSES = {"pending", "in-progress", "done", "skipped"}
TODO_OWNERS = {"user", "agent"}
PLAN_REL_DIR = ".agent-team/plans"
PLAN_DOC_DIRS: tuple[str, ...] = (
    ".agent-team/plans",
    ".agent-team/reports",
    ".claude/loop-reports",
    ".claude/plans",
    ".cursor/plans",
    "docs/plans",
    "docs/reports",
)
DOC_SUFFIXES = (".html", ".plan.md", ".md")
_MAX_ROOT_DEPTH = 2
_MAX_NESTED_ROOTS = 50
_MAX_DIRECTORY_ENTRIES = 2000
_MAX_NESTED_CANDIDATES = 2000
_NOISE_SEGMENTS = frozenset({
    "node_modules", ".venv", "venv", "__pycache__", "dist", "build", "out",
    "target", ".next", ".nuxt", ".turbo", ".cache", ".mypy_cache",
    ".pytest_cache", ".ruff_cache", ".idea", ".gradle",
})


def is_plan_doc_name(name: str) -> bool:
    if not isinstance(name, str) or name.startswith(("_", ".")):
        return False
    lowered = name.lower()
    return any(lowered.endswith(suffix) for suffix in DOC_SUFFIXES)

_MISSING = object()
_write_lock = threading.Lock()
_state_lock = threading.Lock()
_closing = False
_subscriptions: dict[str, dict[str, Any]] = {}
_bridge_pending: dict[str, queue.Queue[tuple[str, Any]]] = {}
_bridge_origin_ids: dict[str, set[str]] = {}
_bridge_watch_origins: set[str] = set()
# In-flight plans.list scan per view instance (each has its own plan root):
# {"done": threading.Event, "generation": int, "result": list | None,
# "error": BaseException | None}. Callers that arrive while it runs wait for
# it, then share the one scan started after them.
# The generation counts scans, not time: a clock coarse enough to read the
# same value twice a millisecond apart (Windows ticks every ~15.6 ms) cannot
# order a caller against a scan that started beside it.
_list_flights: dict[Any, dict[str, Any]] = {}
_list_generation = 0

SERVER_INFO = {"name": "navide.plans", "version": "0.1.0"}


class DuplicateKeyError(ValueError):
    pass


class BridgeFailure(RuntimeError):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class FrameTooLarge(ValueError):
    """A frame would exceed MAX_FRAME_BYTES; the Host kills a child that sends one."""


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
    return (
        value.get("kind") == "agent"
        and value.get("source") == "mcp"
        and _exact_keys(value, ("kind", "source", "id"))
        and isinstance(value["id"], str)
        and bool(value["id"])
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
    if text.startswith("\ufeff") or not _is_compact_json(text):
        raise ValueError("invalid compact frame")
    return json.loads(
        text,
        object_pairs_hook=_object_pairs,
        parse_constant=_reject_constant,
    )


def _write_frame(frame: Any) -> None:
    encoded = json.dumps(frame, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
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
        sys.stderr.write(f"[navide.plans] {message}\n")
        sys.stderr.flush()
    except (OSError, ValueError):
        pass


def _protocol_error(request_id: Any = _MISSING) -> None:
    frame: dict[str, Any] = {"jsonrpc": "2.0", "error": {"code": -32600, "message": "Invalid request"}}
    if request_id is not _MISSING and _is_request_id(request_id):
        frame["id"] = request_id
    _write_frame(frame)


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
        # An oversized frame is a protocol violation the Host answers by
        # killing this process; an error reply keeps the child alive.
        _log(f"response for request {request_id!r} exceeded the frame limit")
        _plugin_error(request_id, "RESULT_TOO_LARGE")


def _plugin_error(request_id: Any, code: str) -> None:
    _write_frame(
        {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {
                "code": 1000,
                "message": "Plugin request failed.",
                "data": {"code": code},
            },
        }
    )


def _origin_key(origin: dict[str, Any]) -> str:
    return f"{origin['kind']}:{type(origin['requestId']).__name__}:{origin['requestId']}"


def _subscription_key(request_id: Any) -> str:
    return _origin_key({"kind": "subscription", "requestId": request_id})


def _deliver_bridge_result(response_queue: queue.Queue[tuple[str, Any]], kind: str, value: Any) -> None:
    try:
        response_queue.put_nowait((kind, value))
    except queue.Full:
        # Cancellation and a Host response may cross in flight. The first
        # terminal result wins; a duplicate must not crash the child.
        pass


def _bridge_result(frame: Any) -> bool:
    if not _is_record(frame) or not _is_bridge_id(frame.get("id")):
        return False
    bridge_id = frame["id"]
    with _state_lock:
        response_queue = _bridge_pending.get(bridge_id)
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
        code = data.get("code") if _is_record(data) else None
        _deliver_bridge_result(
            response_queue,
            "error",
            code if isinstance(code, str) else "BACKEND_UNAVAILABLE",
        )
        return True
    _deliver_bridge_result(response_queue, "error", "PROTOCOL_ERROR")
    return True


def _bridge_event(frame: Any) -> bool:
    if not _is_record(frame) or frame.get("method") != "navide/host/event":
        return False
    params = frame.get("params")
    if (
        not _exact_keys(frame, ("jsonrpc", "method", "params"))
        or frame["jsonrpc"] != "2.0"
        or not _exact_keys(params, ("origin", "event", "payload"))
        or not _is_record(params["origin"])
        or not _exact_keys(params["origin"], ("kind", "requestId"))
        or params["origin"].get("kind") not in {"call", "subscription"}
        or not _is_request_id(params["origin"].get("requestId"))
        or not _is_method_name(params["event"])
        or not _is_json_value(params["payload"])
    ):
        raise ValueError("invalid Host Bridge event")
    if params["origin"]["kind"] == "subscription" and params["event"] == "filesystem.changed":
        _emit("plans.changed", params["payload"], params["origin"]["requestId"])
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


def _emit(event: str, payload: Any, target_subscription_id: Any = _MISSING) -> None:
    with _state_lock:
        subscriptions = [
            dict(subscription)
            for subscription in _subscriptions.values()
            if event in subscription["events"]
            and subscription["acknowledged"]
            and (target_subscription_id is _MISSING or subscription["id"] == target_subscription_id)
        ]
    for subscription in subscriptions:
        _write_frame(
            {
                "jsonrpc": "2.0",
                "method": "notifications/navide/event",
                "params": {
                    "_meta": {SUBSCRIPTION_ID_KEY: subscription["id"]},
                    "event": event,
                    "payload": payload,
                },
            }
        )


def _cancel(request_id: Any) -> None:
    if isinstance(request_id, str) and request_id.startswith("bridge:"):
        with _state_lock:
            response_queue = _bridge_pending.get(request_id)
        if response_queue is not None:
            _deliver_bridge_result(response_queue, "error", "USER_CANCELLED")
        return
    key = _subscription_key(request_id)
    with _state_lock:
        subscription = _subscriptions.pop(key, None)
        bridge_ids = list(_bridge_origin_ids.get(f"call:{type(request_id).__name__}:{request_id}", set()))
        bridge_ids += list(_bridge_origin_ids.get(f"subscription:{type(request_id).__name__}:{request_id}", set()))
    if subscription is not None:
        _bridge_watch_origins.discard(_origin_key({"kind": "subscription", "requestId": request_id}))
    for bridge_id in bridge_ids:
        with _state_lock:
            response_queue = _bridge_pending.get(bridge_id)
        if response_queue is not None:
            _deliver_bridge_result(response_queue, "error", "USER_CANCELLED")
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


def _acknowledge(subscription: dict[str, Any]) -> None:
    _write_frame(
        {
            "jsonrpc": "2.0",
            "method": "notifications/subscriptions/acknowledged",
            "params": {
                "_meta": {SUBSCRIPTION_ID_KEY: subscription["id"]},
                "notifications": {EVENT_FILTER_KEY: subscription["events"]},
            },
        }
    )


def _start_watch(subscription: dict[str, Any]) -> None:
    # Deliberately left on the Host bridge: the watcher is a Host primitive.
    origin = {"kind": "subscription", "requestId": subscription["id"]}
    origin_key = _origin_key(origin)
    with _state_lock:
        if origin_key in _bridge_watch_origins:
            return
        _bridge_watch_origins.add(origin_key)

    def watch() -> None:
        try:
            _bridge_call(origin, "filesystem", "watch", {"rel_path": ""})
        except (BridgeFailure, BrokenPipeError):
            with _state_lock:
                current = _subscriptions.pop(_subscription_key(subscription["id"]), None)
            if current is not None:
                try:
                    _response(subscription["id"], subscription_id=subscription["id"])
                except BrokenPipeError:
                    pass
        finally:
            _bridge_watch_origins.discard(origin_key)

    threading.Thread(target=watch, daemon=True).start()


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _plan_root(origin: dict[str, Any]) -> str:
    """The plan root the Host authorizes for this request.

    Asked of the Host through ``resolve_root`` once per request and never
    reused across requests: answering it is where the Host applies the Plans
    Grant and an agent's Execution Policy to the file access this child then
    does itself. The Host answers from its own binding of the request's
    origin, never from a payload.
    """
    root = origin.get("root")
    if root is None:
        result = _bridge_call(origin, "filesystem", "resolve_root", {})
        if not _is_record(result) or not isinstance(result.get("root"), str) or not os.path.isabs(result["root"]):
            raise BridgeFailure("PROTOCOL_ERROR")
        root = origin["root"] = result["root"]
    return root


def _guarded_path(origin: dict[str, Any], rel_path: str, **options: bool) -> Path:
    """``rel_path`` under the authorized root, through the core path guard.

    A refused path fails the way the Host's filesystem service failed it.
    """
    try:
        return _resolve_safe(_plan_root(origin), rel_path, **options)
    except FsError as exc:
        _log(f"path {rel_path} refused: {exc}")
        raise BridgeFailure("WORKSPACE_SCOPE_VIOLATION") from None


def _read_bytes(
    origin: dict[str, Any], rel_path: str, start: int, want: int | None
) -> tuple[bytes, int, float | None, bool]:
    """Read up to ``want`` bytes (all the rest when None) from ``start``.

    Returns (bytes, file size, mtime, reached end of file), all from one open
    descriptor, so a read never splices two versions of a file together.
    """
    target = _guarded_path(origin, rel_path, allow_mockups=True)
    try:
        if not target.is_file():
            raise BridgeFailure("BACKEND_UNAVAILABLE")
        with target.open("rb") as handle:
            st = os.fstat(handle.fileno())
            handle.seek(start)
            data = handle.read() if want is None else handle.read(want)
    except OSError as exc:
        _log(f"read {rel_path}: {exc}")
        raise BridgeFailure("BACKEND_UNAVAILABLE") from None
    return data, st.st_size, st.st_mtime, start + len(data) >= st.st_size


def _read_text(origin: dict[str, Any], rel_path: str) -> tuple[str, float | None]:
    """Whole document and its mtime, whatever its size."""
    data, _size, mtime, _eof = _read_bytes(origin, rel_path, 0, None)
    try:
        return data.decode("utf-8"), mtime
    except UnicodeDecodeError as exc:
        _log(f"read {rel_path}: {exc}")
        raise BridgeFailure("BACKEND_UNAVAILABLE") from None


def _stat(origin: dict[str, Any], rel_path: str) -> tuple[bool, bool]:
    """(exists, is a directory); a path the guard refuses does not exist."""
    try:
        target = _resolve_safe(_plan_root(origin), rel_path, allow_internal_root=True, allow_mockups=True)
        return target.exists(), target.is_dir()
    except (FsError, OSError):
        return False, False


def _list_names(origin: dict[str, Any], rel_path: str, *, discovery: bool = False) -> list[str]:
    """Entry names of one directory level, as the Host's ``list_dir`` gave them.

    Hidden entries are left out. ``discovery`` lists only directories that
    are not noise, sorted by UTF-8 bytes; otherwise directories come first,
    then files, each case-insensitively. At most _MAX_DIRECTORY_ENTRIES.
    """
    target = _guarded_path(origin, rel_path, allow_internal_root=True, allow_mockups=True)
    try:
        if not target.is_dir():
            raise BridgeFailure("BACKEND_UNAVAILABLE")
        with os.scandir(target) as it:
            if discovery:
                entries = sorted(
                    (e for e in it if e.is_dir() and not e.name.startswith(".") and e.name not in _NOISE_SEGMENTS),
                    key=lambda e: e.name.encode("utf-8"),
                )
            else:
                entries = sorted(it, key=lambda e: (not e.is_dir(), e.name.lower()))
    except OSError as exc:
        _log(f"list {rel_path}: {exc}")
        raise BridgeFailure("BACKEND_UNAVAILABLE") from None
    names = [e.name for e in entries if not e.name.startswith(".")]
    if len(names) > _MAX_DIRECTORY_ENTRIES:
        _log(f"list {rel_path}: {len(names)} entries, only the first {_MAX_DIRECTORY_ENTRIES} are used")
    return names[:_MAX_DIRECTORY_ENTRIES]


def _decode_chunk(data: bytes, final: bool) -> tuple[str, int]:
    """Decode a byte range, holding back a multi-byte character cut by its end.

    Returns (text, bytes consumed) so the next range can start on a character
    boundary.
    """
    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    text = decoder.decode(data, final)
    return text, len(data) - len(decoder.getstate()[0])


def _read_text_chunk(origin: dict[str, Any], rel_path: str, offset: int) -> dict[str, Any]:
    """One page of a document's text, sized to fit a single response frame."""
    data, size, mtime, reached_end = _read_bytes(origin, rel_path, offset, TEXT_CHUNK_BYTES)
    text, consumed = _decode_chunk(data, reached_end)
    # JSON escaping can inflate a chunk (control characters cost six bytes);
    # halve it until it fits rather than send a frame the Host would reject.
    while consumed > 4096 and len(json.dumps(text, ensure_ascii=False).encode("utf-8")) > FRAME_TEXT_BUDGET_BYTES:
        data = data[: consumed // 2]
        text, consumed = _decode_chunk(data, False)
        reached_end = False
    next_offset = offset + consumed
    return {
        "text": text,
        "offset": offset,
        "next_offset": next_offset,
        "size": size,
        "mtime": mtime,
        "eof": reached_end and next_offset >= size,
    }


def _write_failure(result: Any, *, rel_path: str | None = None) -> BridgeFailure:
    """The failure the Host's filesystem service reported for a write.

    Classified from the write itself, never from the wording of its message.
    """
    if _is_record(result) and result.get("conflict") is True:
        return BridgeFailure("CONFLICT")
    reason = result.get("error") if _is_record(result) else None
    _log(f"write {rel_path}: {reason if isinstance(reason, str) else 'malformed write result'}")
    return BridgeFailure("BACKEND_UNAVAILABLE")


def _write(origin: dict[str, Any], rel_path: str, content: str, expected_mtime: float | None = None) -> float | None:
    """Write a document under the authorized root through the core write path.

    The same calls the Host's filesystem service made: the mutation guard, an
    atomic replace, and the ``expected_mtime`` conflict check. A document past
    SINGLE_WRITE_MAX_BYTES is staged in parts and swapped in, as before.
    """
    # Plans writes deliberately have no size cap (user decision 2026-09-29:
    # plans are never skipped or capped), which is why a large document goes
    # through the staged path, and why no failure here is a size limit.
    root = _plan_root(origin)
    try:
        _resolve_mutation_safe(root, rel_path)
    except FsError as exc:
        _log(f"write {rel_path} refused: {exc}")
        raise BridgeFailure("WORKSPACE_SCOPE_VIOLATION") from None
    data = content.encode("utf-8")
    if len(data) > SINGLE_WRITE_MAX_BYTES:
        result = _write_staged(root, rel_path, data, expected_mtime)
    else:
        result = write_file(root, rel_path, content, expected_mtime=expected_mtime)
    if not _is_record(result) or result.get("ok") is not True:
        raise _write_failure(result, rel_path=rel_path)
    mtime = result.get("mtime")
    return float(mtime) if isinstance(mtime, (int, float)) and not isinstance(mtime, bool) else None


def _write_staged(root: str, rel_path: str, data: bytes, expected_mtime: float | None) -> Any:
    """Stage ``data`` part by part, then swap it in atomically.

    Same contract as one write_file call: the commit is refused with a
    conflict if the file changed since it was read, and the replace is a
    single rename. A failure part-way discards the staged bytes.
    """
    upload_id = uuid.uuid4().hex
    offset = 0
    while True:
        part = data[offset : offset + _WRITE_PART_MAX_BYTES]
        result = write_part(root, rel_path, upload_id, offset, base64.b64encode(part).decode("ascii"))
        if not _is_record(result) or result.get("ok") is not True:
            write_abort(root, rel_path, upload_id)
            return result
        offset += len(part)
        if offset >= len(data):
            break
    return write_commit(root, rel_path, upload_id, len(data), expected_mtime)


def _plan_path(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise BridgeFailure("INVALID_ARGUMENT")
    cleaned = value.strip().replace("\\", "/")
    if cleaned.startswith("/") or (len(cleaned) >= 3 and cleaned[1:3] == ":/"):
        raise BridgeFailure("WORKSPACE_SCOPE_VIOLATION")
    segments = cleaned.split("/")
    if any(seg in ("", ".", "..") for seg in segments):
        raise BridgeFailure("WORKSPACE_SCOPE_VIOLATION")

    if len(segments) == 1:
        filename = segments[0]
        if not is_plan_doc_name(filename):
            raise BridgeFailure("INVALID_ARGUMENT")
        return f"{PLAN_REL_DIR}/{filename}"

    filename = segments[-1]
    parent = "/".join(segments[:-1])
    if not is_plan_doc_name(filename):
        raise BridgeFailure("INVALID_ARGUMENT")

    matched = False
    for plan_dir in PLAN_DOC_DIRS:
        if parent == plan_dir or parent.endswith("/" + plan_dir):
            matched = True
            break
    if not matched:
        raise BridgeFailure("WORKSPACE_SCOPE_VIOLATION")

    return cleaned


def _parse_plan_meta(content: str) -> dict[str, Any] | None:
    match = PLAN_META_RE.search(content)
    if not match:
        return _parse_markdown_meta(content)
    try:
        meta = json.loads(match.group(1).strip())
    except (ValueError, TypeError):
        return None
    if not _is_record(meta) or meta.get("schemaVersion") != 1 or not isinstance(meta.get("name"), str) or not meta["name"].strip():
        return None
    normalized = dict(meta)
    if normalized.get("stage") not in PLAN_STAGES:
        normalized["stage"] = "draft"
    todos = normalized.get("todos")
    normalized["todos"] = todos if isinstance(todos, list) else []
    notes = normalized.get("reviewNotes")
    normalized["reviewNotes"] = notes if isinstance(notes, list) else []
    return normalized


_PLAN_META_ID_RE = re.compile(r"""id\s*=\s*["']plan-meta["']""", re.IGNORECASE)


def _meta_problem(content: str) -> str | None:
    """Why a document that tries to carry plan-meta has none usable, else None.

    A document with no plan-meta at all is a plain document, not a problem;
    one whose island or front matter is present but broken is listed with this
    reason so it never silently drops out of the Plans list.
    """
    match = PLAN_META_RE.search(content)
    if match:
        try:
            meta = json.loads(match.group(1).strip())
        except (ValueError, TypeError):
            return "plan-meta is not valid JSON"
        if not _is_record(meta) or meta.get("schemaVersion") != 1:
            return "plan-meta schemaVersion must be 1"
        if not isinstance(meta.get("name"), str) or not meta["name"].strip():
            return "plan-meta has no name"
        return None
    if _PLAN_META_ID_RE.search(content):
        return "plan-meta script is not closed"
    if content.startswith("---"):
        end = content.find("\n---", 3)
        if end < 0:
            return "front matter is not closed"
        try:
            parsed = yaml.safe_load(content[3:end])
        except yaml.YAMLError:
            return "front matter is not valid YAML"
        if isinstance(parsed, dict) and _parse_markdown_meta(content) is None:
            return "front matter has no name or title"
    return None


# Byte-level twins of PLAN_META_RE's two halves, so the head scan can search only
# the newly read tail (with an overlap for a tag cut by a chunk boundary).
_PLAN_META_OPEN_BYTES_RE = re.compile(
    rb"<script\b[^>]*\s(?:id=\"plan-meta\"|id='plan-meta')[^>]*>", re.IGNORECASE
)
_SCRIPT_CLOSE_BYTES_RE = re.compile(rb"</script>", re.IGNORECASE)
_SCAN_OVERLAP = 4096


def _head_info(origin: dict[str, Any], rel_path: str) -> dict[str, Any]:
    """plan-meta and file facts from the head of a document.

    Reads ranges from the start only until the plan-meta island (or front
    matter) is complete, so listing hundreds of plans never pulls a multi-MB
    report into memory (the island sits at the top: one range). A file whose
    island is further down is scanned on, chunk by chunk, until it closes or
    the file ends, so no plan is mistaken for a plain document.
    """
    data = bytearray()
    size: int | None = None
    mtime: float | None = None
    scanned = 0  # bytes already searched; each chunk is scanned once
    island_from: int | None = None  # where to look for </script> once the tag opened
    front_matter = False
    while True:
        chunk, size, chunk_mtime, eof = _read_bytes(origin, rel_path, len(data), RANGE_CHUNK_BYTES)
        if mtime is None:
            mtime = chunk_mtime
        data += chunk
        if len(data) == len(chunk):
            front_matter = data.startswith(b"---")
        done = eof or not chunk
        if island_from is None:
            opened = _PLAN_META_OPEN_BYTES_RE.search(data, max(0, scanned - _SCAN_OVERLAP))
            if opened:
                island_from = opened.end()
        if island_from is not None:
            closed = _SCRIPT_CLOSE_BYTES_RE.search(data, max(island_from, scanned - _SCAN_OVERLAP))
            if closed:
                done = True
        elif front_matter and data.find(b"\n---", max(3, scanned - _SCAN_OVERLAP)) >= 0:
            done = True
        scanned = len(data)
        if done:
            break
    text = bytes(data).decode("utf-8", "replace")
    return {"meta": _parse_plan_meta(text), "reason": _meta_problem(text), "size": size, "mtime": mtime}


def _normalize_todo_status(value: Any) -> str:
    if not isinstance(value, str):
        return "pending"
    v = value.strip().lower().replace("_", "-")
    if v in ("done", "completed", "complete", "finished"):
        return "done"
    if v in ("in-progress", "inprogress", "active"):
        return "in-progress"
    if v in ("skipped", "skip"):
        return "skipped"
    return "pending"


def _json_safe(value: Any) -> Any:
    """YAML loads dates as date/datetime; the wire only carries JSON."""
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json_safe(item) for item in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


def _parse_markdown_meta(content: str) -> dict[str, Any] | None:
    if not content.startswith("---"):
        return None
    end = content.find("\n---", 3)
    if end < 0:
        return None
    try:
        parsed = yaml.safe_load(content[3:end])
    except yaml.YAMLError:
        return None
    if not isinstance(parsed, dict):
        return None
    name = parsed.get("name") if isinstance(parsed.get("name"), str) else parsed.get("title")
    if not isinstance(name, str) or not name.strip():
        return None

    raw_todos = parsed.get("todos")
    todos: list[dict[str, Any]] = []
    if isinstance(raw_todos, list):
        for idx, item in enumerate(raw_todos):
            if isinstance(item, str):
                todos.append({"id": f"t{idx + 1}", "content": item, "status": "pending"})
            elif isinstance(item, dict):
                todo_id = str(item.get("id") or f"t{idx + 1}")
                content_str = str(item.get("content") or "")
                status_str = _normalize_todo_status(item.get("status"))
                entry = dict(item)
                entry["id"] = todo_id
                entry["content"] = content_str
                entry["status"] = status_str
                todos.append(entry)

    raw_stage = parsed.get("stage")
    if isinstance(raw_stage, str) and raw_stage in PLAN_STAGES:
        stage = raw_stage
    else:
        stage = "done" if (todos and all(t.get("status") == "done" for t in todos)) else "draft"

    fields = dict(parsed)
    fields["schemaVersion"] = 1
    fields["name"] = name.strip()
    fields["stage"] = stage
    fields["overview"] = parsed.get("overview") if isinstance(parsed.get("overview"), str) else (
        parsed.get("description") if isinstance(parsed.get("description"), str) else ""
    )
    fields["approvedAt"] = parsed.get("approvedAt") if isinstance(parsed.get("approvedAt"), str) else None
    fields["archivedAt"] = parsed.get("archivedAt") if isinstance(parsed.get("archivedAt"), str) else None
    fields["todos"] = todos
    fields["reviewNotes"] = parsed.get("reviewNotes") if isinstance(parsed.get("reviewNotes"), list) else []
    return _json_safe(fields)


def _write_plan_meta(content: str, meta: dict[str, Any]) -> str:
    match = PLAN_META_RE.search(content)
    block = json.dumps(meta, ensure_ascii=False, indent=2).replace("<", "\\u003c")
    if match is None:
        return f'<script type="application/json" id="plan-meta">\n{block}\n</script>\n{content}'
    return f"{content[:match.start(1)]}\n{block}\n{content[match.end(1):]}"


def _write_markdown_meta(content: str, meta: dict[str, Any]) -> str:
    """Replace or prepend YAML frontmatter while preserving the markdown body."""
    end = content.find("\n---", 3) if content.startswith("---") else -1
    body = content[end + 4 :] if end >= 0 else content
    frontmatter = yaml.safe_dump(
        meta,
        allow_unicode=True,
        default_flow_style=False,
        sort_keys=False,
    ).rstrip("\n")
    separator = "" if body.startswith("\n") else "\n"
    return f"---\n{frontmatter}\n---{separator}{body}"


def _write_meta_for_path(
    rel_path: str,
    content: str,
    meta: dict[str, Any],
    *,
    stage: str | None = None,
    todo_id: str | None = None,
    todo_status: str | None = None,
) -> str:
    if not rel_path.endswith(".html"):
        return _write_markdown_meta(content, meta)
    updated = _write_plan_meta(content, meta)
    if stage is not None:
        updated = _sync_stage_markup(updated, stage)
    if todo_id is not None and todo_status is not None:
        updated = _sync_todo_markup(updated, todo_id, todo_status)
    return updated


def _todo_summary(meta: dict[str, Any]) -> dict[str, Any]:
    counts: dict[str, int] = {}
    total = 0
    for todo in meta.get("todos", []):
        if not _is_record(todo):
            continue
        total += 1
        status = todo.get("status") if isinstance(todo.get("status"), str) else "unknown"
        counts[status or "unknown"] = counts.get(status or "unknown", 0) + 1
    return {"total": total, "by_status": counts}


def _slug(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")[:60].rstrip("-") or "plan"


def _normalize_todos(value: Any, status: str = "pending") -> list[dict[str, str]]:
    if not isinstance(value, list):
        raise BridgeFailure("INVALID_ARGUMENT")
    result: list[dict[str, str]] = []
    seen: set[str] = set()
    for index, item in enumerate(value):
        owner = ""
        if isinstance(item, str):
            todo_id, text = "", item
        elif _is_record(item):
            todo_id, text = str(item.get("id") or ""), str(item.get("content") or "")
            owner = str(item.get("owner") or "")
        else:
            raise BridgeFailure("INVALID_ARGUMENT")
        text = text.strip()
        todo_id = todo_id.strip() or f"t{index + 1}"
        if (
            not text
            or TODO_ID_RE.fullmatch(todo_id) is None
            or todo_id in seen
            or (owner and owner not in TODO_OWNERS)
        ):
            raise BridgeFailure("INVALID_ARGUMENT")
        seen.add(todo_id)
        entry = {"id": todo_id, "content": text, "status": status}
        if owner == "user":
            entry["owner"] = owner
        result.append(entry)
    return result


def _sync_stage_markup(content: str, stage: str) -> str:
    def replace(match: re.Match[str]) -> str:
        classes = match.group(2)
        classes = re.sub(r"\b(?:draft|in-review|approved|in-progress|done|abandoned)\b", stage, classes)
        return f"{match.group(1)}{classes}{match.group(3)}{stage}{match.group(4)}"

    return STAGE_PILL_RE.sub(replace, content, count=1)


def _sync_todo_markup(content: str, todo_id: str, status: str) -> str:
    id_attr = re.compile(rf"\bdata-todo-id=[\"']{re.escape(todo_id)}[\"']", re.IGNORECASE)
    status_attr = re.compile(r"(\bdata-status=[\"'])[^\"']+([\"'])", re.IGNORECASE)

    def replace(match: re.Match[str]) -> str:
        tag = match.group(0)
        if id_attr.search(tag) is None:
            return tag
        return status_attr.sub(lambda attr: f"{attr.group(1)}{status}{attr.group(2)}", tag, count=1)

    updated = re.sub(r"<li\b[^>]*>", replace, content, flags=re.IGNORECASE)
    row_re = re.compile(
        rf"(<li\b[^>]*\bdata-todo-id=[\"']{re.escape(todo_id)}[\"'][^>]*>)([\s\S]*?)(</li>)",
        re.IGNORECASE,
    )

    def replace_status_span(match: re.Match[str]) -> str:
        return f"{match.group(1)}{status}{match.group(2)}"

    return row_re.sub(
        lambda match: (
            f"{match.group(1)}"
            f"{TODO_STATUS_SPAN_RE.sub(replace_status_span, match.group(2), count=1)}"
            f"{match.group(3)}"
        ),
        updated,
        count=1,
    )


def _find_nested_plan_roots(origin: dict[str, Any]) -> list[str]:
    found: list[str] = []
    frontier: list[tuple[str, int]] = [("", 0)]
    visited = 0
    while frontier and len(found) < _MAX_NESTED_ROOTS and visited < _MAX_NESTED_CANDIDATES:
        current_rel, depth = frontier.pop(0)
        if depth >= _MAX_ROOT_DEPTH:
            continue
        try:
            entries = _list_names(origin, current_rel, discovery=True)
        except BridgeFailure:
            continue
        # If truncated is True, the listing was capped by Host at _MAX_DIRECTORY_ENTRIES (2000).
        # We also enforce candidates[:_MAX_DIRECTORY_ENTRIES] defensively.
        candidates = sorted(
            (
                name
                for name in entries
                if isinstance(name, str)
                and not name.startswith(".")
                and name not in _NOISE_SEGMENTS
            ),
            key=lambda s: s.encode("utf-8"),
        )[:_MAX_DIRECTORY_ENTRIES]
        for name in candidates:
            if len(found) >= _MAX_NESTED_ROOTS or visited >= _MAX_NESTED_CANDIDATES:
                break
            visited += 1
            child_rel = f"{current_rel}/{name}" if current_rel else name
            if _stat(origin, child_rel) != (True, True):
                continue
            if _stat(origin, f"{child_rel}/.git") == (True, True):
                found.append(child_rel)
            else:
                frontier.append((child_rel, depth + 1))
    return found


def _unreadable_reason(code: str) -> str:
    if code == "RESULT_TOO_LARGE":
        return "too large for this version of Navide to read (RESULT_TOO_LARGE); update Navide to open large plans"
    return f"could not be read ({code})"


def _list_plans(origin: dict[str, Any]) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    seen: set[str] = set()

    def _unreadable_dir(rel_dir: str, code: str, detail: Any) -> None:
        # Listed in the shape of an unreadable document, so a plan directory
        # the user cannot see into is not silently missing from the list.
        _log(f"plan directory {rel_dir} could not be read: {detail}")
        entries.append(
            {
                "rel_path": rel_dir,
                "name": rel_dir.rsplit("/", 1)[-1],
                "stage": None,
                "overview": "",
                "todos": {"total": 0, "by_status": {}},
                "mtime": None,
                "kind": "unreadable",
                "meta": None,
                "reason": f"plan directory could not be read ({code})",
            }
        )

    def _scan_dir(rel_dir: str) -> None:
        # Only a directory that does not exist is skipped quietly.
        try:
            target = _guarded_path(origin, rel_dir, allow_internal_root=True, allow_mockups=True)
        except BridgeFailure as error:
            # A path the guard refuses does not exist for us; the guard logged it.
            if error.code == "WORKSPACE_SCOPE_VIOLATION":
                return
            raise
        try:
            mode = target.stat().st_mode
        except (FileNotFoundError, NotADirectoryError):
            return
        except OSError as exc:
            _unreadable_dir(rel_dir, "BACKEND_UNAVAILABLE", exc)
            return
        if not stat.S_ISDIR(mode):
            return
        try:
            names = _list_names(origin, rel_dir)
        except BridgeFailure as error:
            if error.code == "USER_CANCELLED" or _closing:
                raise
            _unreadable_dir(rel_dir, error.code, error.code)
            return
        for name in sorted((n for n in names if isinstance(n, str)), key=lambda s: s.lower()):
            if not is_plan_doc_name(name):
                continue
            rel_path = f"{rel_dir}/{name}"
            if rel_path in seen:
                continue
            seen.add(rel_path)
            try:
                info = _head_info(origin, rel_path)
            except BridgeFailure as error:
                if error.code == "USER_CANCELLED" or _closing:
                    raise
                # A document that cannot be read is still a document the user
                # owns: list it with the reason instead of dropping it.
                _log(f"plan document {rel_path} could not be read: {error.code}")
                entries.append(
                    {
                        "rel_path": rel_path,
                        "name": name,
                        "stage": None,
                        "overview": "",
                        "todos": {"total": 0, "by_status": {}},
                        "mtime": None,
                        "kind": "unreadable",
                        "meta": None,
                        "reason": _unreadable_reason(error.code),
                    }
                )
                continue
            meta = info["meta"]
            entry = {
                "rel_path": rel_path,
                "name": meta.get("name") if meta is not None else name,
                "stage": meta.get("stage") if meta is not None else None,
                "overview": meta.get("overview", "") if meta is not None else "",
                "todos": _todo_summary(meta) if meta is not None else {"total": 0, "by_status": {}},
                "mtime": info["mtime"],
                "kind": "plan" if meta is not None else "document",
                "meta": meta,
            }
            if info["reason"] is not None:
                _log(f"plan document {rel_path} has unusable metadata: {info['reason']}")
                entry["reason"] = info["reason"]
                entry["size"] = info["size"]
            entries.append(entry)

    for rel_dir in PLAN_DOC_DIRS:
        _scan_dir(rel_dir)

    for nested_root in _find_nested_plan_roots(origin):
        for plan_dir in PLAN_DOC_DIRS:
            _scan_dir(f"{nested_root}/{plan_dir}")

    return entries


def _list_plans_single_flight(origin: dict[str, Any]) -> list[dict[str, Any]]:
    """Run one full scan at a time; callers that overlap it share one follow-up.

    A burst of plans.changed notifications used to start one scan per caller,
    and every scan's Host Bridge traffic landed in the same output queue that
    the notifications were already filling. A caller only takes the result of
    a scan started after it arrived: a scan already past some directory when
    the caller's write landed would hand it a pre-write snapshot.
    """
    global _list_generation
    # Every caller is authorized by the Host before it may share a scan, and
    # a refusal fails the call rather than reading as "no such directory".
    _plan_root(origin)
    key = origin["instance"]
    with _state_lock:
        arrived_after = _list_generation
    while True:
        with _state_lock:
            flight = _list_flights.get(key)
            leader = flight is None
            if leader:
                _list_generation += 1
                flight = _list_flights[key] = {
                    "done": threading.Event(),
                    "generation": _list_generation,
                    "result": None,
                    "error": None,
                }
        assert flight is not None
        if not leader:
            flight["done"].wait()
            if flight["generation"] <= arrived_after:
                continue
            error = flight["error"]
            # A leader cancelled by its own caller says nothing about ours:
            # take the next flight instead of reporting its cancellation.
            if isinstance(error, BridgeFailure) and error.code == "USER_CANCELLED":
                continue
            if error is not None:
                raise error
            return flight["result"]
        try:
            flight["result"] = _list_plans(origin)
        except BaseException as error:
            flight["error"] = error
            raise
        finally:
            with _state_lock:
                _list_flights.pop(key, None)
            flight["done"].set()
        return flight["result"]


def _encoded_size(value: Any) -> int:
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


_PAGED_META_KEYS = ("name", "stage", "overview", "archivedAt")
_PAGED_TODO_KEYS = ("id", "content", "status", "owner")


def _paged_meta(meta: Any) -> Any:
    """The part of a plan's meta the Plans view reads from a list entry.

    reviewNotes stays an empty list: the view appends to and filters the
    listed meta's notes, while it shows the notes of the document it reads.
    """
    if not _is_record(meta):
        return meta
    slim: dict[str, Any] = {key: meta[key] for key in _PAGED_META_KEYS if key in meta}
    slim["todos"] = [
        {key: todo[key] for key in _PAGED_TODO_KEYS if key in todo} if _is_record(todo) else todo
        for todo in meta.get("todos", [])
    ]
    slim["reviewNotes"] = []
    return slim


def _list_result(entries: list[dict[str, Any]], arguments: dict[str, Any]) -> Any:
    """Shape a scan into a response that always fits one frame.

    Without arguments the plain array is returned (the original contract); if
    it would not fit a frame each entry's full meta is dropped rather than the
    entry. ``{"offset": n}`` pages instead: entries from n on that fit one
    frame, plus ``next_offset`` (null after the last one), so no plan is ever
    left out however many there are. Paging is the Plans view's form, so a
    paged entry carries only the meta the view reads (see _paged_meta); the
    plain array agents receive keeps the full meta.
    """
    if not arguments:
        if _encoded_size(entries) <= LIST_INLINE_BUDGET_BYTES:
            return entries
        _log("plan list exceeds one frame; returning entries without full meta")
        return [{**entry, "meta": None} for entry in entries]
    offset = arguments.get("offset")
    if set(arguments) != {"offset"} or not _is_int(offset) or offset < 0:
        raise BridgeFailure("INVALID_ARGUMENT")
    page: list[dict[str, Any]] = []
    used = 0
    index = offset
    while index < len(entries):
        entry = {**entries[index], "meta": _paged_meta(entries[index]["meta"])}
        cost = _encoded_size(entry) + 1
        if page and used + cost > LIST_PAGE_BUDGET_BYTES:
            break
        if not page and cost > LIST_PAGE_BUDGET_BYTES:
            # The view still needs to know an archived plan is archived.
            archived_at = entry["meta"].get("archivedAt") if _is_record(entry["meta"]) else None
            entry = {**entry, "meta": None}
            if archived_at is not None:
                entry["archivedAt"] = archived_at
            cost = _encoded_size(entry) + 1
        page.append(entry)
        used += cost
        index += 1
    return {"entries": page, "next_offset": index if index < len(entries) else None, "total": len(entries)}


def _read_offset(arguments: dict[str, Any]) -> int:
    offset = arguments.get("offset", 0)
    if not _is_int(offset) or offset < 0:
        raise BridgeFailure("INVALID_ARGUMENT")
    return offset


def _read_plan(origin: dict[str, Any], rel_path: Any, offset: int = 0) -> dict[str, Any]:
    """One page of a plan document.

    A document that fits one page comes back exactly as before. A larger one
    carries ``eof: false`` and ``next_offset``; the caller asks again from
    there and concatenates ``html``. ``meta`` is only sent with the first page.
    """
    normalized = _plan_path(rel_path)
    chunk = _read_text_chunk(origin, normalized, offset)
    result: dict[str, Any] = {"rel_path": normalized, "html": chunk["text"], "mtime": chunk["mtime"]}
    if offset == 0:
        head = chunk["text"]
        if chunk["eof"] or PLAN_META_RE.search(head) or head.startswith("---"):
            result["meta"] = _parse_plan_meta(head)
        else:
            result["meta"] = _head_info(origin, normalized)["meta"]
    if offset > 0 or not chunk["eof"]:
        result["size"] = chunk["size"]
        result["offset"] = offset
        result["eof"] = chunk["eof"]
        if not chunk["eof"]:
            result["next_offset"] = chunk["next_offset"]
    return result


def _load_for_write(origin: dict[str, Any], rel_path: Any) -> tuple[str, str, dict[str, Any], float]:
    normalized = _plan_path(rel_path)
    content, mtime = _read_text(origin, normalized)
    meta = _parse_plan_meta(content)
    if meta is None or mtime is None:
        raise BridgeFailure("INVALID_ARGUMENT")
    return normalized, content, meta, mtime


def _create_plan(origin: dict[str, Any], arguments: dict[str, Any]) -> dict[str, Any]:
    name = arguments.get("name")
    overview = arguments.get("overview", "")
    stage = arguments.get("stage", "draft")
    if (
        not isinstance(name, str)
        or not name.strip()
        or not isinstance(overview, str)
        or stage not in PLAN_STAGES
    ):
        raise BridgeFailure("INVALID_ARGUMENT")
    todos = _normalize_todos(arguments.get("todos"), "done" if stage == "done" else "pending")
    slug = _slug(name.strip())
    # A random suffix keeps concurrent agent creates independent without an
    # existence probe that could become a side channel across workspaces.
    for _ in range(16):
        filename = f"{slug}_{uuid.uuid4().hex[:6]}.html"
        rel_path = f"{PLAN_REL_DIR}/{filename}"
        try:
            _read_text(origin, rel_path)
        except BridgeFailure as error:
            if error.code == "BACKEND_UNAVAILABLE":
                break
            raise
    else:
        raise BridgeFailure("RESOURCE_LIMIT")
    template, _ = _read_text(origin, f"{PLAN_REL_DIR}/_template.html")
    content = template
    replacements = {
        "{{PLAN_NAME}}": html_escape(name.strip()),
        "{{ONE_SENTENCE_OVERVIEW}}": html_escape(overview.strip()),
        "{{PHASE_A_TITLE}}": "Todos",
    }
    # One pass, function replacement: fill the known placeholders and sweep the
    # rest to TBD together. A second sweep over already-substituted content
    # would rewrite a user's own "{{...}}" to TBD, leaving the visible markup
    # disagreeing with plan-meta. re.sub never rescans what a callback returns.
    content = re.sub(
        r"\{\{[^{}]*\}\}",
        lambda match: replacements.get(match.group(0), "TBD"),
        content,
    )
    if "data-todo-id=" in content:
        rows = "\n".join(
            f'<li data-status="{todo["status"]}" data-todo-id="{html_escape(todo["id"])}">'
            f'<span class="st">{todo["status"]}</span> <span>{html_escape(todo["content"])}</span></li>'
            for todo in todos
        )
        # A function replacement, never a template string: user todo text is
        # HTML-escaped but still carries raw backslashes, and re.sub would read
        # those as group references (\1) or escapes (\t, \U) — raising
        # re.error, or silently rewriting the text.
        content = re.sub(
            r"<li\b[^>]*data-todo-id=[\"']phase-a[\"'][^>]*>[\s\S]*?</li>",
            lambda _match: rows,
            content,
            count=1,
        )
    meta = {
        "schemaVersion": 1,
        "name": name.strip(),
        "overview": overview.strip(),
        "stage": stage,
        "approvedAt": (
            datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            if stage in {"approved", "in-progress", "done"}
            else None
        ),
        "todos": todos,
        "reviewNotes": [],
    }
    _write(origin, rel_path, _write_meta_for_path(rel_path, content, meta, stage=stage))
    return {"rel_path": rel_path, "name": name.strip(), "stage": stage}


def _update_stage(origin: dict[str, Any], arguments: dict[str, Any]) -> dict[str, Any]:
    stage = arguments.get("stage")
    if stage not in PLAN_STAGES:
        raise BridgeFailure("INVALID_ARGUMENT")
    rel_path, content, meta, mtime = _load_for_write(origin, arguments.get("rel_path"))
    meta["stage"] = stage
    if stage == "approved":
        meta["approvedAt"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    _write(origin, rel_path, _write_meta_for_path(rel_path, content, meta, stage=stage), mtime)
    return {"stage": stage, "approvedAt": meta.get("approvedAt")}


def _update_todo(origin: dict[str, Any], arguments: dict[str, Any]) -> dict[str, Any]:
    status = arguments.get("status")
    todo_id = arguments.get("todo_id")
    owner = arguments.get("owner", "")
    if (
        status not in TODO_STATUSES
        or not isinstance(todo_id, str)
        or not todo_id
        or owner not in {"", *TODO_OWNERS}
    ):
        raise BridgeFailure("INVALID_ARGUMENT")
    rel_path, content, meta, mtime = _load_for_write(origin, arguments.get("rel_path"))
    target = next((todo for todo in meta["todos"] if _is_record(todo) and todo.get("id") == todo_id), None)
    if target is None:
        raise BridgeFailure("INVALID_ARGUMENT")
    target["status"] = status
    if owner == "user":
        target["owner"] = owner
    elif owner == "agent":
        target.pop("owner", None)
    updated = _write_meta_for_path(
        rel_path,
        content,
        meta,
        todo_id=todo_id,
        todo_status=status,
    )
    _write(origin, rel_path, updated, mtime)
    return dict(target)


def _add_note(origin: dict[str, Any], arguments: dict[str, Any]) -> dict[str, Any]:
    text = arguments.get("text")
    author = arguments.get("author", "ai")
    if not isinstance(text, str) or not text.strip() or author not in {"user", "ai"}:
        raise BridgeFailure("INVALID_ARGUMENT")
    rel_path, content, meta, mtime = _load_for_write(origin, arguments.get("rel_path"))
    notes = meta["reviewNotes"]
    max_num = 0
    for note in notes:
        if _is_record(note):
            match = NOTE_ID_RE.fullmatch(str(note.get("id") or ""))
            if match:
                max_num = max(max_num, int(match.group(1)))
    note = {"id": f"n{max_num + 1}", "author": author, "text": text.strip(), "resolved": False, "reply": ""}
    notes.append(note)
    _write(origin, rel_path, _write_meta_for_path(rel_path, content, meta), mtime)
    return note


def _manual_review_note(origin: dict[str, Any], arguments: dict[str, Any], action: str) -> dict[str, Any]:
    # Retained PlanStore retries one optimistic-lock conflict against fresh
    # bytes. The mutation (including a new note id) must be recomputed too.
    for attempt in range(2):
        try:
            return _manual_review_note_once(origin, arguments, action)
        except BridgeFailure as error:
            if error.code != "CONFLICT" or attempt == 1:
                raise
    raise AssertionError("unreachable")


def _manual_review_note_once(origin: dict[str, Any], arguments: dict[str, Any], action: str) -> dict[str, Any]:
    required = {
        "add": {"rel_path", "text", "anchor"}, "edit": {"rel_path", "note_id", "text"},
        "resolve": {"rel_path", "note_id"}, "delete": {"rel_path", "note_id"},
    }[action]
    if set(arguments) != required:
        raise BridgeFailure("INVALID_ARGUMENT")
    rel_path, content, meta, mtime = _load_for_write(origin, arguments.get("rel_path"))
    notes = meta["reviewNotes"]
    if action == "add":
        text = arguments.get("text")
        if not isinstance(text, str) or not text.strip():
            raise BridgeFailure("INVALID_ARGUMENT")
        max_num = max((int(match.group(1)) for note in notes if _is_record(note) and (match := NOTE_ID_RE.fullmatch(str(note.get("id") or "")))), default=0)
        anchor = arguments.get("anchor")
        if not isinstance(anchor, str):
            raise BridgeFailure("INVALID_ARGUMENT")
        note = {"id": f"n{max_num + 1}", "author": "user", "text": text.strip(), "resolved": False, "reply": "", "anchor": anchor}
        notes.append(note)
    else:
        note_id = arguments.get("note_id")
        if not isinstance(note_id, str) or not note_id:
            raise BridgeFailure("INVALID_ARGUMENT")
        note = next((item for item in notes if _is_record(item) and item.get("id") == note_id), None)
        if note is None:
            raise BridgeFailure("INVALID_ARGUMENT")
        if action == "edit":
            text = arguments.get("text")
            if note.get("author") != "user" or not isinstance(text, str) or not text.strip():
                raise BridgeFailure("INVALID_ARGUMENT")
            note["text"] = text.strip()
        elif action == "resolve":
            note["resolved"] = True
        else:
            notes.remove(note)
    updated = _write_meta_for_path(rel_path, content, meta)
    # Match retained setNoteTextMarkup/removeNoteMarkup: synchronize a row
    # only when the document already contains it. Never materialize notes.
    if rel_path.endswith(".html") and action == "edit":
        row = re.compile(
            rf"(<li\b[^>]*data-note-id=[\"']{re.escape(note['id'])}[\"'][^>]*>"
            r"[\s\S]*?<span\b[^>]*\bclass=[\"']who[\"'][^>]*>[\s\S]*?</span>)"
            r"([\s\S]*?)(<div\b[^>]*\bclass=[\"']reply|</li>)", re.IGNORECASE,
        )
        updated = row.sub(lambda match: match[1] + html_escape(note["text"], quote=False) + match[3], updated, count=1)
    elif rel_path.endswith(".html") and action == "delete":
        row = re.compile(
            rf"[^\S\n]*<li\b[^>]*data-note-id=[\"']{re.escape(note['id'])}[\"'][\s\S]*?</li>[^\S\n]*\n?",
            re.IGNORECASE,
        )
        updated = row.sub("", updated, count=1)
    _write(origin, rel_path, updated, mtime)
    return dict(note)


def _manual_document(origin: dict[str, Any], arguments: dict[str, Any], action: str) -> dict[str, Any]:
    """Transport the retained PlanStore's bytes and optimistic-lock result.

    Only the manual Host allowlist exposes these adapters. Paths remain
    relative to the Host-bound plan root; history is read-only, and Git
    sharing is limited to the retained .plans/<document> destination.
    """
    required = {"rel_path", "content"} if action == "write" else {"rel_path"}
    optional = {"expected_mtime"} if action == "write" else {"offset"} if action == "read" else set()
    if not required <= set(arguments) or set(arguments) - required - optional:
        raise BridgeFailure("INVALID_ARGUMENT")
    path = arguments["rel_path"]
    if not isinstance(path, str) or not path or "\\" in path:
        raise BridgeFailure("INVALID_ARGUMENT")
    segments = path.split("/")
    if any(part in {"", ".", ".."} for part in segments) or ":" in path:
        raise BridgeFailure("WORKSPACE_SCOPE_VIOLATION")
    if "/.history/" in path:
        parent, remainder = path.split("/.history/", 1)
        parts = remainder.split("/")
        _plan_path(f"{parent}/{parts[0]}.html")
        if action == "write" or len(parts) != (1 if action == "list" else 2):
            raise BridgeFailure("WORKSPACE_SCOPE_VIOLATION")
        if action == "read" and not is_plan_doc_name(parts[-1]):
            raise BridgeFailure("INVALID_ARGUMENT")
    elif action == "list":
        raise BridgeFailure("WORKSPACE_SCOPE_VIOLATION")
    elif len(segments) == 2 and segments[0] == ".plans" and is_plan_doc_name(segments[1]):
        pass
    else:
        path = _plan_path(path)

    if action == "read":
        offset = _read_offset(arguments)
        chunk = _read_text_chunk(origin, path, offset)
        result: dict[str, Any] = {"ok": True, "content": chunk["text"]}
        if chunk["mtime"] is not None:
            result["mtime"] = chunk["mtime"]
        if offset > 0 or not chunk["eof"]:
            result["size"] = chunk["size"]
            result["offset"] = offset
            result["eof"] = chunk["eof"]
            if not chunk["eof"]:
                result["next_offset"] = chunk["next_offset"]
        return result
    if action == "list":
        entries = []
        for name in _list_names(origin, path):
            exists, is_dir = _stat(origin, f"{path}/{name}")
            if exists:
                entries.append({"name": name, "is_dir": is_dir})
        return {"ok": True, "entries": entries}
    content = arguments["content"]
    mtime = arguments.get("expected_mtime")
    if not isinstance(content, str) or (
        mtime is not None and (isinstance(mtime, bool) or not isinstance(mtime, (int, float)) or not math.isfinite(mtime))
    ):
        raise BridgeFailure("INVALID_ARGUMENT")
    try:
        _write(origin, path, content, mtime)
    except BridgeFailure as error:
        if error.code == "CONFLICT":
            return {"ok": False, "conflict": True}
        raise
    return {"ok": True}


_UPLOAD_ID_RE = re.compile(r"[0-9a-f]{32}$")
# Base64 of one range: the most a single write-part call may carry, which keeps
# the Host's request frame well inside the child's input queue.
_MAX_PART_BASE64_CHARS = ((RANGE_CHUNK_BYTES + 2) // 3) * 4


def _manual_write_path(value: Any) -> str:
    """Path rules of a manual document write (shared with the chunked variant)."""
    if not isinstance(value, str) or not value or "\\" in value:
        raise BridgeFailure("INVALID_ARGUMENT")
    segments = value.split("/")
    if any(part in {"", ".", ".."} for part in segments) or ":" in value:
        raise BridgeFailure("WORKSPACE_SCOPE_VIOLATION")
    if "/.history/" in value:
        raise BridgeFailure("WORKSPACE_SCOPE_VIOLATION")
    if len(segments) == 2 and segments[0] == ".plans" and is_plan_doc_name(segments[1]):
        return value
    return _plan_path(value)


def _manual_upload(origin: dict[str, Any], arguments: dict[str, Any], action: str) -> dict[str, Any]:
    """Chunked variant of a manual document write.

    A renderer cannot send a large document in one call (the Host bounds a
    request frame), so it stages the bytes part by part, then commits. The
    commit is the ordinary write: atomic swap, same ``expected_mtime`` conflict
    check. Paths follow the same rules as :func:`_manual_document`'s write.
    """
    allowed = {
        "part": {"rel_path", "upload_id", "offset", "data_base64"},
        "commit": {"rel_path", "upload_id", "total_size", "expected_mtime"},
        "abort": {"rel_path", "upload_id"},
    }[action]
    required = allowed - {"expected_mtime"}
    if not required <= set(arguments) or set(arguments) - allowed:
        raise BridgeFailure("INVALID_ARGUMENT")
    upload_id = arguments["upload_id"]
    if not isinstance(upload_id, str) or _UPLOAD_ID_RE.match(upload_id) is None:
        raise BridgeFailure("INVALID_ARGUMENT")
    path = _manual_write_path(arguments["rel_path"])
    if action == "part":
        offset, data = arguments["offset"], arguments["data_base64"]
        if not _is_int(offset) or offset < 0 or not isinstance(data, str) or len(data) > _MAX_PART_BASE64_CHARS:
            raise BridgeFailure("INVALID_ARGUMENT")
        result = write_part(_plan_root(origin), path, upload_id, offset, data)
        if not _is_record(result) or result.get("ok") is not True:
            raise _write_failure(result)
        return {"ok": True, "size": result.get("size", offset)}
    if action == "abort":
        result = write_abort(_plan_root(origin), path, upload_id)
        if not _is_record(result) or result.get("ok") is not True:
            raise _write_failure(result)
        return {"ok": True}
    total = arguments["total_size"]
    expected = arguments.get("expected_mtime")
    if not _is_int(total) or total < 0 or (
        expected is not None
        and (isinstance(expected, bool) or not isinstance(expected, (int, float)) or not math.isfinite(expected))
    ):
        raise BridgeFailure("INVALID_ARGUMENT")
    result = write_commit(_plan_root(origin), path, upload_id, total, expected)
    if _is_record(result) and result.get("conflict") is True:
        return {"ok": False, "conflict": True}
    if not _is_record(result) or result.get("ok") is not True:
        raise _write_failure(result)
    mtime = result.get("mtime")
    return {"ok": True, **({"mtime": float(mtime)} if isinstance(mtime, (int, float)) and not isinstance(mtime, bool) else {})}


def _document_title(rel_path: str, content: str) -> str:
    filename = rel_path.rsplit("/", 1)[-1]
    if rel_path.endswith(".html"):
        match = re.search(r"<title\b[^>]*>([\s\S]*?)</title>", content, re.IGNORECASE)
        if match:
            title = re.sub(r"<[^>]+>", "", match.group(1)).strip()
            if title:
                return title
        return re.sub(r"\.html$", "", filename, flags=re.IGNORECASE) or "Untitled plan"
    heading = re.search(r"^#\s+(.+?)\s*$", content, re.MULTILINE)
    if heading and heading.group(1).strip():
        return heading.group(1).strip()
    return re.sub(r"\.(?:plan\.md|md)$", "", filename, flags=re.IGNORECASE) or "Untitled plan"


def _document_overview(content: str) -> str:
    for block in re.split(r"\n\s*\n", content):
        text = block.strip()
        if text and not text.startswith("#") and not text.startswith("---"):
            return re.sub(r"\s+", " ", text)
    return ""


def _promote(origin: dict[str, Any], arguments: dict[str, Any]) -> dict[str, Any]:
    normalized = _plan_path(arguments.get("rel_path"))
    content, mtime = _read_text(origin, normalized)
    existing = _parse_plan_meta(content)
    if existing is not None:
        return {"ok": True, "promoted": False, "rel_path": normalized, "meta": existing}
    name = _document_title(normalized, content)
    meta: dict[str, Any] = {
        "schemaVersion": 1,
        "name": name,
        "overview": "" if normalized.endswith(".html") else _document_overview(content),
        "stage": "draft",
        "approvedAt": None,
        "archivedAt": None,
        "todos": [],
        "reviewNotes": [],
    }
    updated = _write_plan_meta(content, meta) if normalized.endswith(".html") else _write_markdown_meta(content, meta)
    _write(origin, normalized, updated, mtime)
    return {"ok": True, "promoted": True, "rel_path": normalized, "meta": meta}


def _update_archive(origin: dict[str, Any], arguments: dict[str, Any]) -> dict[str, Any]:
    archived_at = arguments.get("archived_at")
    if archived_at is not None and (not isinstance(archived_at, str) or not archived_at.strip()):
        raise BridgeFailure("INVALID_ARGUMENT")
    rel_path, content, meta, mtime = _load_for_write(origin, arguments.get("rel_path"))
    meta["archivedAt"] = archived_at
    _write(origin, rel_path, _write_meta_for_path(rel_path, content, meta), mtime)
    return {"archivedAt": archived_at}


def _rename(origin: dict[str, Any], arguments: dict[str, Any]) -> dict[str, Any]:
    source = _plan_path(arguments.get("from"))
    target = _plan_path(arguments.get("to"))
    # Deliberately left on the Host bridge for now (a follow-up item).
    _bridge_call(origin, "filesystem", "rename", {"from": source, "to": target})
    return {"ok": True, "from": source, "to": target}


def _delete(origin: dict[str, Any], arguments: dict[str, Any]) -> dict[str, Any]:
    rel_path = _plan_path(arguments.get("rel_path"))
    # Deliberately left on the Host bridge: deleting moves the file to the OS
    # Trash (send2trash, not the standard library). A follow-up item.
    _bridge_call(origin, "filesystem", "delete", {"rel_path": rel_path})
    return {"ok": True, "rel_path": rel_path}


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
    if _bridge_result(frame) or _bridge_event(frame):
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
        runtime = frame["params"]["runtime"]
        events = notifications.get(EVENT_FILTER_KEY) if _is_record(notifications) else None
        if (
            not _is_record(notifications)
            or set(notifications) != {EVENT_FILTER_KEY}
            or not isinstance(events, list)
            or not events
            or len(set(events)) != len(events)
            or not all(_is_method_name(event) for event in events)
            or not _is_runtime(runtime)
        ):
            _protocol_error(frame["id"])
            return
        subscription = {"id": frame["id"], "events": events, "acknowledged": True}
        with _state_lock:
            _subscriptions[_subscription_key(frame["id"])] = subscription
        _acknowledge(subscription)
        if "plans.changed" in events:
            _start_watch(subscription)
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
    origin = {"kind": "call", "requestId": frame["id"], "instance": runtime["instanceId"]}
    try:
        if name == "plans.resolve_root":
            if set(arguments) - {"workspace_path"}:
                raise BridgeFailure("INVALID_ARGUMENT")
            root = _bridge_call(origin, "filesystem", "resolve_root", {})
            if not _is_record(root) or not isinstance(root.get("root"), str):
                raise BridgeFailure("PROTOCOL_ERROR")
            result = {"ok": True, "root": root["root"]}
        elif name in {"plans.list", "plans.list_docs"}:
            if arguments and set(arguments) != {"offset"}:
                raise BridgeFailure("INVALID_ARGUMENT")
            result = _list_result(_list_plans_single_flight(origin), arguments)
        elif name == "plans.read":
            if set(arguments) - {"rel_path", "offset"}:
                raise BridgeFailure("INVALID_ARGUMENT")
            result = _read_plan(origin, arguments.get("rel_path"), _read_offset(arguments))
        elif name == "plans.read_document":
            result = _manual_document(origin, arguments, "read")
        elif name == "plans.write_document":
            result = _manual_document(origin, arguments, "write")
        elif name == "plans.write_document_part":
            result = _manual_upload(origin, arguments, "part")
        elif name == "plans.write_document_commit":
            result = _manual_upload(origin, arguments, "commit")
        elif name == "plans.write_document_abort":
            result = _manual_upload(origin, arguments, "abort")
        elif name == "plans.list_directory":
            result = _manual_document(origin, arguments, "list")
        elif name == "plans.cache_put":
            result = {"ok": True}
        elif name == "plans.create":
            result = _create_plan(origin, arguments)
        elif name == "plans.update_stage":
            result = _update_stage(origin, arguments)
        elif name == "plans.update_todo":
            result = _update_todo(origin, arguments)
        elif name == "plans.add_note":
            result = _add_note(origin, arguments)
        elif name == "plans.review_note_add":
            result = _manual_review_note(origin, arguments, "add")
        elif name == "plans.review_note_edit":
            result = _manual_review_note(origin, arguments, "edit")
        elif name == "plans.review_note_resolve":
            result = _manual_review_note(origin, arguments, "resolve")
        elif name == "plans.review_note_delete":
            result = _manual_review_note(origin, arguments, "delete")
        elif name == "plans.update_archive":
            result = _update_archive(origin, arguments)
        elif name == "plans.promote":
            result = _promote(origin, arguments)
        elif name == "plans.rename":
            result = _rename(origin, arguments)
        elif name == "plans.delete":
            result = _delete(origin, arguments)
        else:
            _write_frame({"jsonrpc": "2.0", "id": frame["id"], "error": {"code": -32601, "message": "Method not found"}})
            return
    except BridgeFailure as error:
        _plugin_error(frame["id"], error.code)
        return
    except Exception as error:
        # Any other failure would kill this request thread with no reply, and the
        # Host would wait out its call timeout and withdraw Plans for the session.
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
            response_queue.put_nowait(("error", "BACKEND_UNAVAILABLE"))
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

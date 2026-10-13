from __future__ import annotations

import base64
import hashlib
import importlib.util
import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
from html import escape as html_escape
from pathlib import Path
from typing import Any

import pytest


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ENTRY = REPOSITORY_ROOT / "plugins" / "navide-plans" / "backend" / "plans_backend.py"
PROTOCOL_REVISION = "2026-07-28"
SERVER_INFO_KEY = "io.modelcontextprotocol/serverInfo"
SUBSCRIPTION_ID_KEY = "io.modelcontextprotocol/subscriptionId"
EVENT_FILTER_KEY = "dev.navide/pluginEvents"

CLIENT_META = {
    "io.modelcontextprotocol/protocolVersion": PROTOCOL_REVISION,
    "io.modelcontextprotocol/clientCapabilities": {},
    "io.modelcontextprotocol/clientInfo": {"name": "navide-plans-test", "version": "1"},
}
RUNTIME = {
    "pluginId": "navide.plans",
    "packageVersion": "0.1.0",
    "workspaceId": "workspace-hash",
    "instanceId": "instance-1",
    "contributionKey": "navide.plans.mcp",
    "hostWindowId": None,
    "initiator": {"kind": "agent", "source": "mcp", "id": "agent-1"},
}


def _send(process: subprocess.Popen[bytes], frame: dict[str, Any]) -> None:
    assert process.stdin is not None
    process.stdin.write(json.dumps(frame, separators=(",", ":")).encode() + b"\n")
    process.stdin.flush()


def _frames_of(process: subprocess.Popen[bytes]) -> queue.Queue[bytes]:
    """One reader thread per child, started on first read.

    A blocking readline is the only pipe wait that works everywhere:
    `select` only accepts sockets on Windows. EOF is queued as b"".
    """
    frames = getattr(process, "_frames", None)
    if frames is None:
        frames = process._frames = queue.Queue()  # type: ignore[attr-defined]

        def pump() -> None:
            assert process.stdout is not None
            for line in iter(process.stdout.readline, b""):
                frames.put(line)
            frames.put(b"")

        threading.Thread(target=pump, daemon=True).start()
    return frames


def _read(process: subprocess.Popen[bytes], timeout: float = 2.0) -> dict[str, Any]:
    assert process.stdout is not None
    try:
        line = _frames_of(process).get(timeout=timeout)
    except queue.Empty:
        raise AssertionError(
            f"Backend Wire child produced no frame within {timeout}s"
        ) from None
    if not line:
        stderr = process.stderr.read().decode(errors="replace") if process.stderr else ""
        raise AssertionError(f"Backend Wire child exited without a frame: {stderr}")
    return json.loads(line)


def _reply_bridge(process: subprocess.Popen[bytes], request: dict[str, Any], value: Any) -> None:
    _send(
        process,
        {
            "jsonrpc": "2.0",
            "id": request["id"],
            "result": {
                "resultType": "complete",
                "value": value,
                "_meta": {SERVER_INFO_KEY: {"name": "host-test", "version": "1"}},
            },
        },
    )


def _serve_workspace(
    process: subprocess.Popen[bytes],
    root: Path,
    request_id: str,
    operations: list[str] | None = None,
) -> dict[str, Any]:
    """Play the Host for one call over a real workspace until it is answered.

    The child reads and writes plan files itself under the root the Host
    resolves, so the only bridge call it may make is resolve_root, on behalf
    of the request in flight.
    """
    while True:
        frame = _read(process)
        if frame.get("id") == request_id:
            return frame
        assert frame.get("method") == "navide/host/call"
        params = frame["params"]
        assert params["port"] == "filesystem"
        assert params["origin"] == {"kind": "call", "requestId": request_id}
        operation = params["operation"]
        arguments = params["arguments"]
        assert "workspace_path" not in arguments
        if operations is not None:
            operations.append(operation)
        if operation == "resolve_root":
            assert arguments == {}
            _reply_bridge(process, frame, {"root": str(root.resolve())})
        else:
            raise AssertionError(f"unexpected filesystem operation: {operation}")


class _WorkspaceFiles:
    """The workspace's files by relative path, read from disk."""

    def __init__(self, root: Path) -> None:
        self.root = root

    def __contains__(self, rel_path: str) -> bool:
        return (self.root / rel_path).is_file()

    def __getitem__(self, rel_path: str) -> str:
        return (self.root / rel_path).read_text(encoding="utf-8")


def _template_workspace(root: Path) -> Path:
    """A workspace with the Host-provisioned plan template in place."""
    template = root / ".agent-team" / "plans" / "_template.html"
    template.parent.mkdir(parents=True)
    template.write_text(
        (REPOSITORY_ROOT / "backend" / "agent_team_backend" / "plan_assets" / "_template.html").read_text(encoding="utf-8"),
        encoding="utf-8",
        newline="",
    )
    return root


@pytest.fixture
def backend_process() -> subprocess.Popen[bytes]:
    process = subprocess.Popen(
        [sys.executable, str(BACKEND_ENTRY)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    try:
        yield process
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)


def test_health_and_agent_create_update_read_round_trip(
    backend_process: subprocess.Popen[bytes], tmp_path: Path,
) -> None:
    _send(
        backend_process,
        {
            "jsonrpc": "2.0",
            "id": "health-1",
            "method": "navide/health",
            "params": {"_meta": CLIENT_META},
        },
    )
    health = _read(backend_process)
    assert health["result"]["value"] == {
        "method": "navide/health",
        "protocolVersion": PROTOCOL_REVISION,
        "requestIdIsNonNull": True,
        "clientCapabilities": {},
    }

    root = _template_workspace(tmp_path)
    stored = _WorkspaceFiles(root)

    def service_until_response(request_id: str) -> dict[str, Any]:
        return _serve_workspace(backend_process, root, request_id)

    _send(
        backend_process,
        {
            "jsonrpc": "2.0",
            "id": "create-1",
            "method": "navide/call",
            "params": {
                "_meta": CLIENT_META,
                "name": "plans.create",
                "arguments": {"name": "Agent plan", "overview": "Round trip", "todos": ["Verify"]},
                "runtime": RUNTIME,
            },
        },
    )
    created = service_until_response("create-1")
    assert created["result"]["value"] == {
        "rel_path": created["result"]["value"]["rel_path"],
        "name": "Agent plan",
        "stage": "draft",
    }
    rel_path = created["result"]["value"]["rel_path"]
    assert rel_path.startswith(".agent-team/plans/agent-plan_")
    assert stored[rel_path].find('"name": "Agent plan"') >= 0
    assert "--bg:" in stored[rel_path]
    assert "{{PLAN_NAME}}" not in stored[rel_path]

    _send(
        backend_process,
        {
            "jsonrpc": "2.0",
            "id": "create-done-1",
            "method": "navide/call",
            "params": {
                "_meta": CLIENT_META,
                "name": "plans.create",
                "arguments": {
                    "name": "Completed report",
                    "overview": "Already finished",
                    "stage": "done",
                    "todos": [{"id": "verify", "content": "Verify", "owner": "user"}],
                },
                "runtime": RUNTIME,
            },
        },
    )
    completed = service_until_response("create-done-1")
    assert completed["result"]["value"]["stage"] == "done"
    completed_path = completed["result"]["value"]["rel_path"]
    assert '"stage": "done"' in stored[completed_path]
    assert '"status": "done"' in stored[completed_path]
    assert '"owner": "user"' in stored[completed_path]

    _send(
        backend_process,
        {
            "jsonrpc": "2.0",
            "id": "update-1",
            "method": "navide/call",
            "params": {
                "_meta": CLIENT_META,
                "name": "plans.update_stage",
                "arguments": {"rel_path": rel_path, "stage": "in-progress"},
                "runtime": RUNTIME,
            },
        },
    )
    updated = service_until_response("update-1")
    assert updated["result"]["value"]["stage"] == "in-progress"
    assert '"stage": "in-progress"' in stored[rel_path]

    _send(
        backend_process,
        {
            "jsonrpc": "2.0",
            "id": "update-todo-1",
            "method": "navide/call",
            "params": {
                "_meta": CLIENT_META,
                "name": "plans.update_todo",
                "arguments": {
                    "rel_path": rel_path,
                    "todo_id": "t1",
                    "status": "in-progress",
                    "owner": "user",
                },
                "runtime": RUNTIME,
            },
        },
    )
    updated_todo = service_until_response("update-todo-1")
    assert updated_todo["result"]["value"]["status"] == "in-progress"
    assert updated_todo["result"]["value"]["owner"] == "user"
    assert 'data-status="pending" data-todo-id="t1"' not in stored[rel_path]
    assert '<span class="st">in-progress</span>' in stored[rel_path]

    _send(
        backend_process,
        {
            "jsonrpc": "2.0",
            "id": "update-todo-owner-1",
            "method": "navide/call",
            "params": {
                "_meta": CLIENT_META,
                "name": "plans.update_todo",
                "arguments": {
                    "rel_path": rel_path,
                    "todo_id": "t1",
                    "status": "done",
                    "owner": "agent",
                },
                "runtime": RUNTIME,
            },
        },
    )
    reassigned_todo = service_until_response("update-todo-owner-1")
    assert reassigned_todo["result"]["value"]["status"] == "done"
    assert "owner" not in reassigned_todo["result"]["value"]

    # Manual Review Notes are metadata-only transport adapters: an anchored
    # write preserves the rendered body and does not synthesize iframe markup.
    body_before_manual_note = stored[rel_path].split("</script>", 1)[1]
    _send(
        backend_process,
        {
            "jsonrpc": "2.0",
            "id": "manual-note-add-1",
            "method": "navide/call",
            "params": {
                "_meta": CLIENT_META,
                "name": "plans.review_note_add",
                "arguments": {"rel_path": rel_path, "text": "Anchor this", "anchor": "Todos"},
                "runtime": RUNTIME,
            },
        },
    )
    added_note = service_until_response("manual-note-add-1")
    assert added_note["result"]["value"] == {
        "id": "n1", "author": "user", "text": "Anchor this", "resolved": False,
        "reply": "", "anchor": "Todos",
    }
    assert '"anchor": "Todos"' in stored[rel_path]
    assert stored[rel_path].split("</script>", 1)[1] == body_before_manual_note
    assert "--bg:" in stored[rel_path]

    _send(
        backend_process,
        {
            "jsonrpc": "2.0",
            "id": "manual-note-resolve-1",
            "method": "navide/call",
            "params": {
                "_meta": CLIENT_META,
                "name": "plans.review_note_resolve",
                "arguments": {"rel_path": rel_path, "note_id": "n1"},
                "runtime": RUNTIME,
            },
        },
    )
    resolved_note = service_until_response("manual-note-resolve-1")
    assert resolved_note["result"]["value"]["resolved"] is True

    _send(
        backend_process,
        {
            "jsonrpc": "2.0",
            "id": "read-1",
            "method": "navide/call",
            "params": {
                "_meta": CLIENT_META,
                "name": "plans.read",
                "arguments": {"rel_path": rel_path},
                "runtime": RUNTIME,
            },
        },
    )
    read = service_until_response("read-1")
    assert read["result"]["value"]["rel_path"] == rel_path
    assert read["result"]["value"]["meta"]["stage"] == "in-progress"


def test_create_rejects_a_missing_host_provisioned_template(
    backend_process: subprocess.Popen[bytes], tmp_path: Path,
) -> None:
    (tmp_path / ".agent-team" / "plans").mkdir(parents=True)
    _send(
        backend_process,
        {
            "jsonrpc": "2.0",
            "id": "create-missing-template-1",
            "method": "navide/call",
            "params": {
                "_meta": CLIENT_META,
                "name": "plans.create",
                "arguments": {"name": "No template", "overview": "", "todos": []},
                "runtime": RUNTIME,
            },
        },
    )

    operations: list[str] = []
    response = _serve_workspace(backend_process, tmp_path, "create-missing-template-1", operations)

    assert response["error"]["data"] == {"code": "BACKEND_UNAVAILABLE"}
    # The name probe and the template read happen in the child against the
    # authorized root; nothing is written when the template is missing.
    assert operations == ["resolve_root"]
    assert sorted(path.name for path in (tmp_path / ".agent-team" / "plans").iterdir()) == []


def test_filesystem_bridge_event_becomes_plans_changed(
    backend_process: subprocess.Popen[bytes],
) -> None:
    _send(
        backend_process,
        {
            "jsonrpc": "2.0",
            "id": "subscription-1",
            "method": "subscriptions/listen",
            "params": {
                "_meta": CLIENT_META,
                "notifications": {EVENT_FILTER_KEY: ["plans.changed"]},
                "runtime": RUNTIME,
            },
        },
    )

    watch_request: dict[str, Any] | None = None
    acknowledged = False
    deadline = time.monotonic() + 2
    while not acknowledged or watch_request is None:
        assert time.monotonic() < deadline
        frame = _read(backend_process, max(0.01, deadline - time.monotonic()))
        if frame.get("method") == "notifications/subscriptions/acknowledged":
            acknowledged = frame["params"]["_meta"][SUBSCRIPTION_ID_KEY] == "subscription-1"
        elif frame.get("method") == "navide/host/call":
            watch_request = frame
            assert frame["params"] == {
                "origin": {"kind": "subscription", "requestId": "subscription-1"},
                "port": "filesystem",
                "operation": "watch",
                "arguments": {"rel_path": ""},
            }
        else:
            raise AssertionError(f"unexpected subscription frame: {frame}")

    _send(
        backend_process,
        {
            "jsonrpc": "2.0",
            "method": "navide/host/event",
            "params": {
                "origin": {"kind": "subscription", "requestId": "subscription-1"},
                "event": "filesystem.changed",
                "payload": {"changes": [{"path": ".agent-team/plans/new.html", "kind": "created"}]},
            },
        },
    )
    event = _read(backend_process)
    assert event == {
        "jsonrpc": "2.0",
        "method": "notifications/navide/event",
        "params": {
            "_meta": {SUBSCRIPTION_ID_KEY: "subscription-1"},
            "event": "plans.changed",
            "payload": {"changes": [{"path": ".agent-team/plans/new.html", "kind": "created"}]},
        },
    }


def test_rejects_absolute_plan_path_before_host_bridge(
    backend_process: subprocess.Popen[bytes],
) -> None:
    _send(
        backend_process,
        {
            "jsonrpc": "2.0",
            "id": "scope-1",
            "method": "navide/call",
            "params": {
                "_meta": CLIENT_META,
                "name": "plans.read",
                "arguments": {"rel_path": "/private/tmp/outside.html"},
                "runtime": RUNTIME,
            },
        },
    )
    response = _read(backend_process)
    assert response["error"]["data"] == {"code": "WORKSPACE_SCOPE_VIOLATION"}


def test_lists_metadata_less_documents_and_promotes_markdown_without_corrupting_body(
    backend_process: subprocess.Popen[bytes], tmp_path: Path,
) -> None:
    document_path = ".agent-team/plans/README.md"
    document = tmp_path / document_path
    document.parent.mkdir(parents=True)
    document.write_text("# README\n\nA workspace document.\n", encoding="utf-8", newline="")
    os.utime(document, (100.0, 100.0))
    stored = _WorkspaceFiles(tmp_path)
    operations: list[str] = []

    def service_until_response(request_id: str) -> dict[str, Any]:
        return _serve_workspace(backend_process, tmp_path, request_id, operations)

    _send(
        backend_process,
        {
            "jsonrpc": "2.0",
            "id": "list-documents-1",
            "method": "navide/call",
            "params": {
                "_meta": CLIENT_META,
                "name": "plans.list",
                "arguments": {},
                "runtime": RUNTIME,
            },
        },
    )
    listed = service_until_response("list-documents-1")
    # One resolve_root for the whole scan, and no bridge reads.
    assert operations == ["resolve_root"]
    assert listed["result"]["value"] == [
        {
            "rel_path": document_path,
            "name": "README.md",
            "stage": None,
            "overview": "",
            "todos": {"total": 0, "by_status": {}},
            "mtime": 100.0,
            "kind": "document",
            "meta": None,
        }
    ]

    _send(
        backend_process,
        {
            "jsonrpc": "2.0",
            "id": "promote-document-1",
            "method": "navide/call",
            "params": {
                "_meta": CLIENT_META,
                "name": "plans.promote",
                "arguments": {"rel_path": document_path},
                "runtime": RUNTIME,
            },
        },
    )
    promoted = service_until_response("promote-document-1")
    assert promoted["result"]["value"]["promoted"] is True
    # The promotion asked for its own root and wrote the file itself; a write
    # against a stale mtime would have been refused as a conflict.
    assert operations == ["resolve_root", "resolve_root"]
    assert stored[document_path].startswith("---\n")
    assert "\n---\n# README\n" in stored[document_path]
    assert "---# README" not in stored[document_path]


def test_overlapping_list_calls_share_one_follow_up_scan(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Every caller asks the Host for its root before it joins a flight, and a
    # scan makes no bridge call after that, so the wire has no point inside a
    # scan to hold the leader at, and a follow-up scan is invisible on it.
    # Drive the child's single-flight in process and count scans.
    backend = _load_backend("plans_backend_overlap")
    scans: list[str] = []
    leader_scanning = threading.Event()
    release_leader = threading.Event()
    real_list_plans = backend._list_plans

    def list_plans(origin: dict[str, Any]) -> list[dict[str, Any]]:
        scans.append(origin["requestId"])
        if origin["requestId"] == "list-leader":
            leader_scanning.set()
            assert release_leader.wait(5)
        return real_list_plans(origin)

    monkeypatch.setattr(backend, "_list_plans", list_plans)
    results: dict[str, Any] = {}

    def call(request_id: str) -> None:
        origin = {"kind": "call", "requestId": request_id, "instance": "instance-1", "root": str(tmp_path.resolve())}
        results[request_id] = backend._list_plans_single_flight(origin)

    # The first call becomes the scan leader and is held mid-scan.
    leader = threading.Thread(target=call, args=("list-leader",), daemon=True)
    leader.start()
    assert leader_scanning.wait(5)
    flight = backend._list_flights["instance-1"]
    done = flight["done"]
    waiting: list[str] = []
    both_waiting = threading.Event()

    class _ObservedDone:
        """The leader's flight event, reporting each follower that waits on it."""

        def wait(self, timeout: float | None = None) -> bool:
            waiting.append(threading.current_thread().name)
            if len(waiting) == 2:
                both_waiting.set()
            return done.wait(timeout)

        def set(self) -> None:
            done.set()

    flight["done"] = _ObservedDone()
    followers = [
        threading.Thread(target=call, args=(name,), name=name, daemon=True)
        for name in ("list-follower-1", "list-follower-2")
    ]
    for follower in followers:
        follower.start()
    assert both_waiting.wait(5)
    release_leader.set()
    for thread in (leader, *followers):
        thread.join(5)
        assert not thread.is_alive()

    # Both followers arrived while the leader's scan was running, so neither
    # may take its snapshot; they share exactly one scan started after them.
    assert scans[0] == "list-leader"
    assert len(scans) == 2, scans
    assert scans[1] in {"list-follower-1", "list-follower-2"}
    assert sorted(results) == ["list-follower-1", "list-follower-2", "list-leader"]
    assert all(value == [] for value in results.values())


def _load_backend(name: str) -> Any:
    spec = importlib.util.spec_from_file_location(name, BACKEND_ENTRY)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_list_caller_arriving_mid_scan_sees_the_write_the_scan_missed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A scan makes no bridge call after its caller's resolve_root, so the wire
    # has no point mid-scan to hold it at. Drive the child's single-flight in
    # process instead and hold the leader right after it has consumed
    # `.agent-team/plans`.
    backend = _load_backend("plans_backend_mid_scan")
    plans = _plans_dir(tmp_path)
    plan_html = (
        '<script id="plan-meta" type="application/json">'
        '{"name":"new","stage":"draft","todos":[]}</script>'
    )
    consumed = threading.Event()
    resume = threading.Event()
    real_list_names = backend._list_names

    def list_names(origin: dict[str, Any], rel_path: str, *, discovery: bool = False) -> list[str]:
        names = real_list_names(origin, rel_path, discovery=discovery)
        if origin["requestId"] == "list-leader" and rel_path == ".agent-team/plans":
            consumed.set()
            assert resume.wait(5)
        return names

    monkeypatch.setattr(backend, "_list_names", list_names)
    results: dict[str, Any] = {}

    def call(request_id: str) -> None:
        origin = {"kind": "call", "requestId": request_id, "instance": "instance-1", "root": str(tmp_path.resolve())}
        results[request_id] = backend._list_plans_single_flight(origin)

    leader = threading.Thread(target=call, args=("list-leader",), daemon=True)
    leader.start()
    assert consumed.wait(5)
    # The leader has consumed `.agent-team/plans` as empty; a document is
    # written right after, and a caller arriving from here on must see it.
    (plans / "new.html").write_text(plan_html, encoding="utf-8", newline="")
    flight = backend._list_flights["instance-1"]
    done = flight["done"]
    follower_waiting = threading.Event()

    class _ObservedDone:
        """The leader's flight event, reporting when a follower waits on it."""

        def wait(self, timeout: float | None = None) -> bool:
            follower_waiting.set()
            return done.wait(timeout)

        def set(self) -> None:
            done.set()

    flight["done"] = _ObservedDone()
    follower = threading.Thread(target=call, args=("list-follower",), daemon=True)
    follower.start()
    assert follower_waiting.wait(5)
    resume.set()
    leader.join(5)
    follower.join(5)
    assert not leader.is_alive() and not follower.is_alive()

    assert [entry["rel_path"] for entry in results["list-leader"]] == []
    assert [entry["rel_path"] for entry in results["list-follower"]] == [".agent-team/plans/new.html"]


def test_cancelled_leader_does_not_cancel_the_followers_list_call(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    # A cancellation reaches a scan through a bridge call it is waiting on.
    # Over the wire a list's only bridge call is resolve_root, made before the
    # caller joins a flight, so a leader can no longer be cancelled mid-scan
    # there. Cancel the leader's scan in process, the way a cancelled bridge
    # call surfaces inside it (BridgeFailure USER_CANCELLED), while a
    # follower is waiting on its flight.
    backend = _load_backend("plans_backend_cancelled_leader")
    _plans_dir(tmp_path)
    leader_scanning = threading.Event()
    cancel_leader = threading.Event()
    scans: list[str] = []
    real_list_names = backend._list_names

    def list_names(origin: dict[str, Any], rel_path: str, *, discovery: bool = False) -> list[str]:
        if origin["requestId"] == "list-leader" and rel_path == ".agent-team/plans":
            leader_scanning.set()
            assert cancel_leader.wait(5)
            raise backend.BridgeFailure("USER_CANCELLED")
        return real_list_names(origin, rel_path, discovery=discovery)

    real_list_plans = backend._list_plans

    def list_plans(origin: dict[str, Any]) -> list[dict[str, Any]]:
        scans.append(origin["requestId"])
        return real_list_plans(origin)

    monkeypatch.setattr(backend, "_list_names", list_names)
    monkeypatch.setattr(backend, "_list_plans", list_plans)
    outcomes: dict[str, Any] = {}

    def call(request_id: str) -> None:
        origin = {"kind": "call", "requestId": request_id, "instance": "instance-1", "root": str(tmp_path.resolve())}
        try:
            outcomes[request_id] = ("result", backend._list_plans_single_flight(origin))
        except backend.BridgeFailure as error:
            outcomes[request_id] = ("error", error.code)

    leader = threading.Thread(target=call, args=("list-leader",), daemon=True)
    leader.start()
    assert leader_scanning.wait(5)
    flight = backend._list_flights["instance-1"]
    done = flight["done"]
    follower_waiting = threading.Event()

    class _ObservedDone:
        """The leader's flight event, reporting when a follower waits on it."""

        def wait(self, timeout: float | None = None) -> bool:
            follower_waiting.set()
            return done.wait(timeout)

        def set(self) -> None:
            done.set()

    flight["done"] = _ObservedDone()
    follower = threading.Thread(target=call, args=("list-follower",), daemon=True)
    follower.start()
    assert follower_waiting.wait(5)
    cancel_leader.set()
    for thread in (leader, follower):
        thread.join(5)
        assert not thread.is_alive()

    assert outcomes["list-leader"] == ("error", "USER_CANCELLED")
    # The follower takes the next flight instead of inheriting the cancellation.
    assert outcomes["list-follower"] == ("result", [])
    assert scans == ["list-leader", "list-follower"]


def test_host_bridge_cancellation_settles_the_child_call(
    backend_process: subprocess.Popen[bytes],
) -> None:
    _send(
        backend_process,
        {
            "jsonrpc": "2.0",
            "id": "read-cancel-1",
            "method": "navide/call",
            "params": {
                "_meta": CLIENT_META,
                "name": "plans.read",
                "arguments": {"rel_path": ".agent-team/plans/cancel.html"},
                "runtime": RUNTIME,
            },
        },
    )
    bridge_request = _read(backend_process)
    assert bridge_request["method"] == "navide/host/call"

    _send(
        backend_process,
        {
            "jsonrpc": "2.0",
            "method": "notifications/cancelled",
            "params": {"requestId": bridge_request["id"], "reason": "timeout"},
        },
    )
    response = _read(backend_process)
    assert response["id"] == "read-cancel-1"
    assert response["error"]["data"] == {"code": "USER_CANCELLED"}


def test_manual_history_listing_uses_host_bridge_name_entries(
    backend_process: subprocess.Popen[bytes], tmp_path: Path,
) -> None:
    history_path = ".agent-team/plans/.history/example"
    directory = tmp_path / history_path
    directory.mkdir(parents=True)
    (directory / "2026-09-08.html").write_text("<h2>Previous version</h2>")
    (directory / "nested").mkdir()
    _send(backend_process, {
        "jsonrpc": "2.0", "id": "history-list", "method": "navide/call",
        "params": {
            "_meta": CLIENT_META, "name": "plans.list_directory",
            "arguments": {"rel_path": history_path},
            "runtime": {**RUNTIME, "initiator": {"kind": "user", "id": "window-1"}},
        },
    })
    operations: list[str] = []
    while True:
        frame = _read(backend_process)
        if frame.get("id") == "history-list":
            break
        assert frame["method"] == "navide/host/call"
        operations.append(frame["params"]["operation"])
        assert frame["params"]["operation"] == "resolve_root"
        _reply_bridge(backend_process, frame, {"root": str(tmp_path.resolve())})
    # The child lists the directory itself; the Host only authorizes the root.
    assert operations == ["resolve_root"]
    assert "result" in frame, frame
    # Directories first, then files: the order the Host's own list_dir gives.
    assert frame["result"]["value"] == {"ok": True, "entries": [
        {"name": "nested", "is_dir": True},
        {"name": "2026-09-08.html", "is_dir": False},
    ]}


def test_lists_and_reads_legacy_plans_across_doc_dirs(
    backend_process: subprocess.Popen[bytes], tmp_path: Path,
) -> None:
    legacy_path = ".cursor/plans/feature.plan.md"
    legacy_content = (
        "---\n"
        "title: Legacy Cursor Feature\n"
        "overview: A legacy feature plan\n"
        "todos:\n"
        "  - id: t1\n"
        "    content: Step 1\n"
        "    status: completed\n"
        "---\n"
        "# Legacy Cursor Feature\n\n"
        "Details here.\n"
    )
    legacy = tmp_path / legacy_path
    legacy.parent.mkdir(parents=True)
    legacy.write_text(legacy_content, encoding="utf-8", newline="")
    os.utime(legacy, (200.0, 200.0))

    def service_until_response(request_id: str) -> dict[str, Any]:
        return _serve_workspace(backend_process, tmp_path, request_id)

    _send(
        backend_process,
        {
            "jsonrpc": "2.0",
            "id": "list-legacy-1",
            "method": "navide/call",
            "params": {
                "_meta": CLIENT_META,
                "name": "plans.list",
                "arguments": {},
                "runtime": RUNTIME,
            },
        },
    )
    listed = service_until_response("list-legacy-1")
    assert listed["result"]["value"] == [
        {
            "rel_path": legacy_path,
            "name": "Legacy Cursor Feature",
            "stage": "done",
            "overview": "A legacy feature plan",
            "todos": {"total": 1, "by_status": {"done": 1}},
            "mtime": 200.0,
            "kind": "plan",
            "meta": {
                "schemaVersion": 1,
                "title": "Legacy Cursor Feature",
                "name": "Legacy Cursor Feature",
                "stage": "done",
                "overview": "A legacy feature plan",
                "approvedAt": None,
                "archivedAt": None,
                "todos": [{"id": "t1", "content": "Step 1", "status": "done"}],
                "reviewNotes": [],
            },
        }
    ]

    # Reading the legacy plan directly by its relative path
    _send(
        backend_process,
        {
            "jsonrpc": "2.0",
            "id": "read-legacy-1",
            "method": "navide/call",
            "params": {
                "_meta": CLIENT_META,
                "name": "plans.read",
                "arguments": {"rel_path": legacy_path},
                "runtime": RUNTIME,
            },
        },
    )
    read_resp = service_until_response("read-legacy-1")
    assert read_resp["result"]["value"]["rel_path"] == legacy_path
    assert read_resp["result"]["value"]["meta"]["name"] == "Legacy Cursor Feature"
    assert read_resp["result"]["value"]["meta"]["stage"] == "done"


def test_lists_nested_plan_roots_accepts_git_directory_and_rejects_git_file(
    backend_process: subprocess.Popen[bytes], tmp_path: Path,
) -> None:
    stored = {
        ".agent-team/plans/top.html": "<html><head><script id='plan-meta' type='application/json'>{\"schemaVersion\":1,\"name\":\"Top Plan\",\"overview\":\"Top\",\"stage\":\"draft\",\"approvedAt\":null,\"todos\":[],\"reviewNotes\":[]}</script></head><body></body></html>",
        "nested_repo/.agent-team/plans/nested.html": "<html><head><script id='plan-meta' type='application/json'>{\"schemaVersion\":1,\"name\":\"Nested Plan\",\"overview\":\"Nested\",\"stage\":\"approved\",\"approvedAt\":\"2026-09-04T00:00:00Z\",\"todos\":[],\"reviewNotes\":[]}</script></head><body></body></html>",
        "submodule_dir/.agent-team/plans/sub.html": "<html><head><script id='plan-meta' type='application/json'>{\"schemaVersion\":1,\"name\":\"Sub Plan\",\"overview\":\"Sub\",\"stage\":\"draft\",\"approvedAt\":null,\"todos\":[],\"reviewNotes\":[]}</script></head><body></body></html>",
        "submodule_dir/inner_repo/.agent-team/plans/inner.html": "<html><head><script id='plan-meta' type='application/json'>{\"schemaVersion\":1,\"name\":\"Inner Plan\",\"overview\":\"Inner\",\"stage\":\"done\",\"approvedAt\":\"2026-09-04T00:00:00Z\",\"todos\":[],\"reviewNotes\":[]}</script></head><body></body></html>",
    }
    for rel, content in stored.items():
        target = tmp_path / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8", newline="")
    # nested_repo and submodule_dir/inner_repo are repositories (a .git
    # directory); submodule_dir is a submodule checkout (a .git file).
    (tmp_path / "nested_repo" / ".git").mkdir()
    (tmp_path / "submodule_dir" / "inner_repo" / ".git").mkdir()
    (tmp_path / "submodule_dir" / ".git").write_text("gitdir: ../.git/modules/submodule_dir\n", encoding="utf-8")

    def service_until_response(request_id: str) -> dict[str, Any]:
        return _serve_workspace(backend_process, tmp_path, request_id)

    _send(
        backend_process,
        {
            "jsonrpc": "2.0",
            "id": "list-nested-1",
            "method": "navide/call",
            "params": {
                "_meta": CLIENT_META,
                "name": "plans.list",
                "arguments": {},
                "runtime": RUNTIME,
            },
        },
    )
    listed = service_until_response("list-nested-1")
    rel_paths = [doc["rel_path"] for doc in listed["result"]["value"]]
    assert ".agent-team/plans/top.html" in rel_paths
    assert "nested_repo/.agent-team/plans/nested.html" in rel_paths
    assert "submodule_dir/inner_repo/.agent-team/plans/inner.html" in rel_paths
    assert "submodule_dir/.agent-team/plans/sub.html" not in rel_paths


def test_plans_backend_fixture_triple_parity() -> None:
    """Triple-parity: packaged plans_backend.py, legacy plan_index.py, and pure data fixture."""
    fixture_path = REPOSITORY_ROOT / "docs" / "plugin-contracts" / "plan-document-locations-v1.json"
    assert fixture_path.exists(), f"Missing fixture at {fixture_path}"
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))

    # Load packaged plans_backend.py
    spec = importlib.util.spec_from_file_location("plans_backend_parity_check", BACKEND_ENTRY)
    assert spec is not None and spec.loader is not None
    backend_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(backend_module)

    # Load legacy plan_index.py
    from agent_team_backend import plan_index

    # 1. Directory inventory
    assert list(backend_module.PLAN_DOC_DIRS) == list(plan_index.PLAN_DOC_DIRS) == fixture["directoryInventory"]
    assert len(backend_module.PLAN_DOC_DIRS) == 7
    assert len(set(backend_module.PLAN_DOC_DIRS)) == len(backend_module.PLAN_DOC_DIRS)

    # 2. Supported extensions
    assert list(backend_module.DOC_SUFFIXES) == list(plan_index._DOC_SUFFIXES) == fixture["supportedExtensions"]
    assert len(backend_module.DOC_SUFFIXES) == 3

    # 3. Discovery limits
    assert backend_module._MAX_ROOT_DEPTH == plan_index._MAX_ROOT_DEPTH == fixture["maxNestedDepth"] == 2
    assert backend_module._MAX_NESTED_ROOTS == plan_index._MAX_NESTED_ROOTS == fixture["maxNestedRoots"] == 50
    assert backend_module._MAX_NESTED_CANDIDATES == plan_index._MAX_NESTED_CANDIDATES == fixture["maxNestedCandidates"] == 2000

    # 4. Noise segments
    assert sorted(backend_module._NOISE_SEGMENTS) == sorted(plan_index._NOISE_SEGMENTS) == sorted(fixture["noiseSegments"])
    assert len(backend_module._NOISE_SEGMENTS) == 17

    # 5. Traversal sort order
    assert fixture["traversalSortOrder"] == "utf8_bytes_ascending"

    # 6. Max directory entries cap
    assert (
        backend_module._MAX_DIRECTORY_ENTRIES
        == plan_index._MAX_DIRECTORY_ENTRIES
        == fixture["maxDirectoryEntries"]
        == 2000
    )


def test_packaged_plans_backend_nested_roots_deterministic_50_cap(monkeypatch: pytest.MonkeyPatch) -> None:
    """Packaged plans_backend._find_nested_plan_roots enforces deterministic 50-root limit in UTF-8 byte order."""
    spec = importlib.util.spec_from_file_location("plans_backend_test_roots", BACKEND_ENTRY)
    assert spec is not None and spec.loader is not None
    backend_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(backend_module)

    # 49 repos R00..R48 + Repo-Alpha + repo-alpha = 51 entries
    entries = [f"R{i:02d}" for i in range(49)] + ["Repo-Alpha", "repo-alpha"]
    shuffled_entries = list(reversed(entries))

    def fake_list_names(origin: dict, rel_path: str, *, discovery: bool = False) -> list[str]:
        return shuffled_entries if rel_path == "" else []

    monkeypatch.setattr(backend_module, "_list_names", fake_list_names)
    monkeypatch.setattr(backend_module, "_stat", lambda origin, rel_path: (True, True))
    roots = backend_module._find_nested_plan_roots({"token": "fake"})
    assert len(roots) == 50
    assert "Repo-Alpha" in roots
    assert "repo-alpha" not in roots


def test_packaged_nested_roots_have_a_global_candidate_budget(monkeypatch: pytest.MonkeyPatch) -> None:
    spec = importlib.util.spec_from_file_location("plans_backend_global_budget", BACKEND_ENTRY)
    assert spec is not None and spec.loader is not None
    backend_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(backend_module)
    probes = 0

    def list_names(origin: dict, rel_path: str, *, discovery: bool = False) -> list[str]:
        return [f"directory-{i}" for i in range(50)]

    def stat(origin: dict, rel_path: str) -> tuple[bool, bool]:
        nonlocal probes
        if rel_path.endswith("/.git"):
            probes += 1
            return False, False
        return True, True

    monkeypatch.setattr(backend_module, "_list_names", list_names)
    monkeypatch.setattr(backend_module, "_stat", stat)
    assert backend_module._find_nested_plan_roots({}) == []
    assert 50 < probes <= 2000


def test_packaged_plans_backend_nested_roots_2000_entry_wire_truncation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Production-shaped test: a discovery listing returns 2,000 entries (already capped)."""
    spec = importlib.util.spec_from_file_location("plans_backend_test_cap_wire", BACKEND_ENTRY)
    assert spec is not None and spec.loader is not None
    backend_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(backend_module)

    requested_modes: list[bool] = []
    # 1,999 non-repo directories + 1 repo at 2,000th slot
    entries = [f"d{i:04d}" for i in range(1999)] + ["r0000-within"]
    shuffled_entries = list(reversed(entries))

    def fake_list_names(origin: dict, rel_path: str, *, discovery: bool = False) -> list[str]:
        requested_modes.append(discovery)
        # A listing already at the 2,000-entry cap.
        return shuffled_entries if rel_path == "" else []

    def fake_stat(origin: dict, rel: str) -> tuple[bool, bool]:
        if rel in ("r0000-within", "r0000-within/.git"):
            return True, True
        if rel.endswith("/.git"):
            return False, False
        return True, True

    monkeypatch.setattr(backend_module, "_list_names", fake_list_names)
    monkeypatch.setattr(backend_module, "_stat", fake_stat)
    roots = backend_module._find_nested_plan_roots({"token": "fake"})
    assert roots == ["r0000-within"]
    assert len(requested_modes) == 1  # The root listing exhausts the global candidate budget.
    assert all(requested_modes)  # every listing is a discovery listing


def test_packaged_plans_backend_nested_roots_defensive_2000_cap(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Defensive fallback test: an abnormal listing returns 2,001 entries; the scan caps internally."""
    spec = importlib.util.spec_from_file_location("plans_backend_test_defensive_cap", BACKEND_ENTRY)
    assert spec is not None and spec.loader is not None
    backend_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(backend_module)

    requested_modes: list[bool] = []
    # 1,999 non-repo + r0000-within + z0000-beyond = 2,001 entries
    entries = [f"d{i:04d}" for i in range(1999)] + ["r0000-within", "z0000-beyond"]
    shuffled_entries = list(reversed(entries))

    def fake_list_names(origin: dict, rel_path: str, *, discovery: bool = False) -> list[str]:
        requested_modes.append(discovery)
        # An abnormal listing past the 2,000-entry cap.
        return shuffled_entries if rel_path == "" else []

    def fake_stat(origin: dict, rel: str) -> tuple[bool, bool]:
        if rel in ("r0000-within", "r0000-within/.git", "z0000-beyond", "z0000-beyond/.git"):
            return True, True
        if rel.endswith("/.git"):
            return False, False
        return True, True

    monkeypatch.setattr(backend_module, "_list_names", fake_list_names)
    monkeypatch.setattr(backend_module, "_stat", fake_stat)
    roots = backend_module._find_nested_plan_roots({"token": "fake"})
    assert roots == ["r0000-within"]
    assert len(requested_modes) == 1  # The root listing exhausts the global candidate budget.
    assert all(requested_modes)  # every listing is a discovery listing


# Regression: plans.create must not treat user todo text as an re.sub
# replacement template. A backslash in a todo either raised re.error inside the
# worker thread (killing it, so the Host saw no frame at all and timed out) or
# silently rewrote the text (`C:\temp` became a literal TAB).
HOSTILE_TODOS = [
    r"fix regex s/(a)/\1/",       # group reference -> re.error: invalid group reference 1
    r"C:\Users\new\test",         # bad escape \U -> re.error
    r"C:\temp",                   # valid escape -> silently rewritten to a TAB
    r"match \d+ digits",          # bad escape \d -> re.error
    r"use \g<0> here",            # group name -> re.error: missing <
]


def _create_plan_over_wire(
    backend_process: subprocess.Popen[bytes],
    workspace: Path,
    request_id: str,
    todos: list[str],
    name: str = "Backslash plan",
    overview: str = "Backslashes survive",
) -> tuple[str, str]:
    """Drive one plans.create through the real child, returning (rel_path, document)."""
    root = _template_workspace(workspace)
    stored = _WorkspaceFiles(root)

    def service_until_response(request_id: str) -> dict[str, Any]:
        # A dead worker thread writes no frame at all; _read raises here.
        return _serve_workspace(backend_process, root, request_id)

    _send(
        backend_process,
        {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "navide/call",
            "params": {
                "_meta": CLIENT_META,
                "name": "plans.create",
                "arguments": {"name": name, "overview": overview, "todos": todos},
                "runtime": RUNTIME,
            },
        },
    )
    created = service_until_response(request_id)
    assert "error" not in created, created.get("error")
    rel_path = created["result"]["value"]["rel_path"]
    # The plan file really exists, not just "no exception was raised".
    assert rel_path in stored
    return rel_path, stored[rel_path]


def test_agent_create_preserves_backslashes_in_todo_text(
    backend_process: subprocess.Popen[bytes], tmp_path: Path,
) -> None:
    _, document = _create_plan_over_wire(backend_process, tmp_path, "create-backslash", HOSTILE_TODOS)

    # Visible markup keeps every todo verbatim (HTML-escaped, backslashes intact).
    for todo in HOSTILE_TODOS:
        assert f"<span>{html_escape(todo)}</span></li>" in document, todo
    # And so does the plan-meta island the Plan view reads back.
    island = re.search(r'<script[^>]*\bid="plan-meta"[^>]*>([\s\S]*?)</script>', document)
    assert island is not None
    meta = json.loads(island.group(1))
    assert [todo["content"] for todo in meta["todos"]] == HOSTILE_TODOS
    # The replaced template row is gone, and the TAB that `C:\temp` used to
    # decay into never reaches the rendered rows.
    assert 'data-todo-id="phase-a"' not in document
    rows = re.findall(r"<span>([^<]*)</span></li>", document)
    assert rows == [html_escape(todo) for todo in HOSTILE_TODOS]
    assert not any("\t" in row for row in rows)


def test_agent_create_does_not_silently_rewrite_a_valid_escape(
    backend_process: subprocess.Popen[bytes], tmp_path: Path,
) -> None:
    """The quiet half of the same bug: `C:\temp` is a *valid* re template, so the
    old code raised nothing and wrote a literal TAB into the plan instead."""
    _, document = _create_plan_over_wire(backend_process, tmp_path, "create-tab", [r"C:\temp"])

    rows = re.findall(r"<span>([^<]*)</span></li>", document)
    assert rows == [r"C:\temp"]
    assert "C:" + "\t" + "emp" not in document
    island = re.search(r'<script[^>]*\bid="plan-meta"[^>]*>([\s\S]*?)</script>', document)
    assert island is not None
    assert [todo["content"] for todo in json.loads(island.group(1))["todos"]] == [r"C:\temp"]


def _visible_plan_text(document: str) -> tuple[str, str, list[str]]:
    """The three user-authored strings as the Plan view actually renders them."""
    heading = re.search(r"<h1[^>]*>([\s\S]*?)<span", document)
    overview = re.search(r'\bclass="overview"[^>]*>([\s\S]*?)</', document)
    assert heading is not None and overview is not None
    rows = re.findall(r"<span>([^<]*)</span></li>", document)
    return heading.group(1).strip(), overview.group(1).strip(), rows


def _plan_meta_of(document: str) -> dict[str, Any]:
    island = re.search(r'<script[^>]*\bid="plan-meta"[^>]*>([\s\S]*?)</script>', document)
    assert island is not None
    return json.loads(island.group(1))


# Regression: the {{…}} sweep must not run over already-substituted user text.
# It used to, so a name/overview containing "{{…}}" was silently rewritten to
# TBD in the visible markup while plan-meta kept the real string — the document
# disagreed with itself.
@pytest.mark.parametrize("field,name,overview,todos", [
    ("name", r"Migrate {{legacy}} config", "Plain overview", ["Plain todo"]),
    ("overview", "Plain name", r"Replace {{TOKEN}} in files", ["Plain todo"]),
    # Todo text was already safe (it is inserted after the sweep). Pin it so
    # merging the fill and the sweep into one pass cannot regress it.
    ("todo", "Plain name", "Plain overview", [r"Replace {{TOKEN}} in files"]),
    ("all-three", r"Fix {{a}}", r"Sweep {{b}}", [r"Todo {{c}}", r"Todo {{d}} and \1"]),
])
def test_agent_create_preserves_double_braces_in_user_text(
    backend_process: subprocess.Popen[bytes],
    tmp_path: Path,
    field: str,
    name: str,
    overview: str,
    todos: list[str],
) -> None:
    _, document = _create_plan_over_wire(
        backend_process, tmp_path, f"create-braces-{field}", todos, name=name, overview=overview
    )

    # Visible markup keeps all three verbatim (HTML-escaped, braces intact)...
    assert _visible_plan_text(document) == (
        html_escape(name),
        html_escape(overview),
        [html_escape(todo) for todo in todos],
    )
    # ...and plan-meta agrees with it rather than diverging.
    meta = _plan_meta_of(document)
    assert meta["name"] == name
    assert meta["overview"] == overview
    assert [todo["content"] for todo in meta["todos"]] == todos
    # The unsupplied template scaffolding is still swept.
    assert "{{PLAN_NAME}}" not in document
    assert "{{PHASE_A_TITLE}}" not in document
    assert "TBD" in document


# ── documents of any size ───────────────────────────────────────────────────

HOST_RANGE_LIMIT = 96 * 1024


class _DiskHost:
    """A Host Bridge that authorizes a real directory the way the Host does.

    The child reads and writes plan files itself under the root this Host
    resolves, so any bridge read or write (read_file, read_range, list_dir,
    stat_path, write_file, write_part, write_commit, write_abort) fails the
    test.
    """

    def __init__(self, root: Path) -> None:
        self.root = root
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def __call__(self, process: subprocess.Popen[bytes], frame: dict[str, Any]) -> None:
        params = frame["params"]
        assert params["port"] == "filesystem"
        operation = params["operation"]
        arguments = params["arguments"]
        self.calls.append((operation, dict(arguments)))
        if operation == "resolve_root":
            _reply_bridge(process, frame, {"root": str(self.root.resolve())})
        else:
            raise AssertionError(f"unexpected filesystem operation: {operation}")

    def staging_files(self) -> list[Path]:
        return sorted(self.root.rglob("*.upload"))


_call_counter = 0


def _call_backend(
    process: subprocess.Popen[bytes], host: _DiskHost, name: str, arguments: dict[str, Any]
) -> dict[str, Any]:
    global _call_counter
    _call_counter += 1
    request_id = f"large-{_call_counter}"
    _send(
        process,
        {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "navide/call",
            "params": {"_meta": CLIENT_META, "name": name, "arguments": arguments, "runtime": RUNTIME},
        },
    )
    while True:
        frame = _read(process, timeout=30)
        if frame.get("id") == request_id:
            return frame
        assert frame.get("method") == "navide/host/call"
        host(process, frame)


def _plan_html(name: str, padding: int = 0, stage: str = "draft", extra: str = "") -> str:
    meta = {"schemaVersion": 1, "name": name, "overview": f"{name} overview", "stage": stage, "todos": [], "reviewNotes": []}
    body = "<p>" + ("x" * padding) + "</p>" if padding else ""
    return (
        f'<!doctype html><html><head><title>{name}</title></head><body>\n'
        f'<script type="application/json" id="plan-meta">\n{json.dumps(meta)}\n</script>\n'
        f"{body}{extra}</body></html>\n"
    )


def _read_all_pages(process: subprocess.Popen[bytes], host: _DiskHost, rel_path: str) -> str:
    parts: list[str] = []
    offset = 0
    while True:
        args: dict[str, Any] = {"rel_path": rel_path}
        if offset:
            args["offset"] = offset
        frame = _call_backend(process, host, "plans.read", args)
        value = frame["result"]["value"]
        parts.append(value["html"])
        if value.get("eof") is not False:
            return "".join(parts)
        assert value["next_offset"] > offset
        offset = value["next_offset"]


def _assert_same_text(actual: str, expected: str) -> None:
    """Compare documents of any size without pytest printing a multi-MB diff."""
    if actual == expected:
        return
    at = next((i for i, (x, y) in enumerate(zip(actual, expected)) if x != y), min(len(actual), len(expected)))
    pytest.fail(
        f"texts differ at index {at} (lengths {len(actual)} vs {len(expected)}): "
        f"{actual[at : at + 40]!r} != {expected[at : at + 40]!r}"
    )


def _plans_dir(tmp_path: Path) -> Path:
    plans = tmp_path / ".agent-team" / "plans"
    plans.mkdir(parents=True)
    return plans


def _head_reads(root: Path, name: str) -> list[int]:
    """Bytes of each read one plans.list scan makes of the document `name`.

    The child reads plan files in its own process, so the Bridge no longer
    shows how much of a file a listing pulls. Run the same scan in process
    over the same workspace and count what `_read_bytes` returns.
    """
    backend = _load_backend("plans_backend_head_reads")
    real_read_bytes = backend._read_bytes
    reads: list[int] = []

    def read_bytes(origin: dict[str, Any], rel_path: str, *args: Any) -> Any:
        result = real_read_bytes(origin, rel_path, *args)
        if rel_path.endswith(f"/{name}"):
            reads.append(len(result[0]))
        return result

    backend._read_bytes = read_bytes
    backend._list_plans(
        {"kind": "call", "requestId": "head-scan", "instance": "instance-1", "root": str(root.resolve())}
    )
    return reads


def test_plans_larger_than_every_bridge_limit_are_listed_and_read_in_full(
    backend_process: subprocess.Popen[bytes], tmp_path: Path
) -> None:
    plans = _plans_dir(tmp_path)
    (plans / "small_aaaaaa.html").write_text(_plan_html("Small"), encoding="utf-8", newline="")
    (plans / "medium_bbbbbb.html").write_text(_plan_html("Medium", padding=300 * 1024), encoding="utf-8", newline="")
    # Over the 5 MB editor read limit as well as the 192 KiB Bridge result cap.
    huge = _plan_html("Huge report", padding=6 * 1024 * 1024, extra="<p>tail marker ✓</p>")
    (plans / "huge_cccccc.html").write_text(huge, encoding="utf-8", newline="")
    huge_bytes = huge.encode("utf-8")
    assert len(huge_bytes) > 5 * 1024 * 1024
    host = _DiskHost(tmp_path)

    listed = _call_backend(backend_process, host, "plans.list", {})["result"]["value"]
    by_path = {entry["rel_path"]: entry for entry in listed}
    assert sorted(by_path) == [
        ".agent-team/plans/huge_cccccc.html",
        ".agent-team/plans/medium_bbbbbb.html",
        ".agent-team/plans/small_aaaaaa.html",
    ]
    assert by_path[".agent-team/plans/huge_cccccc.html"]["name"] == "Huge report"
    assert by_path[".agent-team/plans/huge_cccccc.html"]["kind"] == "plan"
    assert "reason" not in by_path[".agent-team/plans/huge_cccccc.html"]
    # The child read every file itself; the Host only authorized the root.
    assert [operation for operation, _ in host.calls] == ["resolve_root"]
    # Listing reads the head only: one range for the multi-MB file, no full read.
    assert _head_reads(tmp_path, "huge_cccccc.html") == [HOST_RANGE_LIMIT]

    for name, expected in (("medium_bbbbbb.html", None), ("huge_cccccc.html", huge)):
        rel = f".agent-team/plans/{name}"
        text = _read_all_pages(backend_process, host, rel)
        source = (plans / name).read_bytes()
        assert len(text.encode("utf-8")) == len(source)
        assert hashlib.sha256(text.encode("utf-8")).hexdigest() == hashlib.sha256(source).hexdigest()
        if expected is not None:
            _assert_same_text(text, expected)
    first = _call_backend(backend_process, host, "plans.read", {"rel_path": ".agent-team/plans/huge_cccccc.html"})
    value = first["result"]["value"]
    assert value["meta"]["name"] == "Huge report"
    assert value["eof"] is False and value["size"] == len(huge_bytes)
    assert len(value["html"].encode("utf-8")) <= 256 * 1024


def test_plan_pages_never_split_a_multibyte_character(
    backend_process: subprocess.Popen[bytes], tmp_path: Path
) -> None:
    plans = _plans_dir(tmp_path)
    document = _plan_html("中文計畫", extra="<p>" + "計畫文件✓😀" * 90_000 + "</p>")
    (plans / "cjk_dddddd.html").write_text(document, encoding="utf-8", newline="")
    host = _DiskHost(tmp_path)
    text = _read_all_pages(backend_process, host, ".agent-team/plans/cjk_dddddd.html")
    _assert_same_text(text, document)


@pytest.mark.parametrize(
    ("body", "reason"),
    [
        ('<script type="application/json" id="plan-meta">{not json</script>', "plan-meta is not valid JSON"),
        ('<script type="application/json" id="plan-meta">{"schemaVersion": 2, "name": "x"}</script>', "plan-meta schemaVersion must be 1"),
        ('<script type="application/json" id="plan-meta">{"schemaVersion": 1}</script>', "plan-meta has no name"),
        ('<script type="application/json" id="plan-meta">{"schemaVersion": 1, "name": "x"}', "plan-meta script is not closed"),
    ],
)
def test_a_document_with_broken_plan_meta_is_listed_with_the_reason(
    backend_process: subprocess.Popen[bytes], tmp_path: Path, body: str, reason: str
) -> None:
    plans = _plans_dir(tmp_path)
    (plans / "broken_eeeeee.html").write_text(f"<html><body>{body}<p>content</p></body></html>", encoding="utf-8", newline="")
    (plans / "fine_ffffff.html").write_text(_plan_html("Fine"), encoding="utf-8", newline="")
    host = _DiskHost(tmp_path)

    listed = _call_backend(backend_process, host, "plans.list", {})["result"]["value"]
    by_path = {entry["rel_path"]: entry for entry in listed}
    broken = by_path[".agent-team/plans/broken_eeeeee.html"]
    assert broken["kind"] == "document"
    assert broken["meta"] is None
    assert broken["reason"] == reason
    assert broken["size"] > 0
    assert by_path[".agent-team/plans/fine_ffffff.html"]["kind"] == "plan"
    # The plain document (no plan-meta at all) is not a "problem".
    (plans / "plain_000000.html").write_text("<html><body>hello</body></html>", encoding="utf-8", newline="")
    listed = _call_backend(backend_process, host, "plans.list", {})["result"]["value"]
    plain = next(entry for entry in listed if entry["rel_path"].endswith("plain_000000.html"))
    assert plain["kind"] == "document" and "reason" not in plain


def test_an_unreadable_document_is_listed_not_dropped(
    backend_process: subprocess.Popen[bytes], tmp_path: Path
) -> None:
    workspace = tmp_path / "workspace"
    plans = _plans_dir(workspace)
    # A symlink out of the workspace: the core path guard refuses to read it.
    outside = tmp_path / "outside.html"
    outside.write_text(_plan_html("Locked"), encoding="utf-8", newline="")
    (plans / "locked_111111.html").symlink_to(outside)
    (plans / "open_222222.html").write_text(_plan_html("Open"), encoding="utf-8", newline="")
    host = _DiskHost(workspace)

    listed = _call_backend(backend_process, host, "plans.list", {})["result"]["value"]
    by_path = {entry["rel_path"]: entry for entry in listed}
    assert sorted(by_path) == [".agent-team/plans/locked_111111.html", ".agent-team/plans/open_222222.html"]
    locked = by_path[".agent-team/plans/locked_111111.html"]
    assert locked["kind"] == "unreadable"
    assert locked["reason"] == "could not be read (WORKSPACE_SCOPE_VIOLATION)"
    assert locked["meta"] is None and locked["name"] == "locked_111111.html"
    assert by_path[".agent-team/plans/open_222222.html"]["kind"] == "plan"


def test_an_oversized_list_is_paged_and_never_kills_the_child(
    backend_process: subprocess.Popen[bytes], tmp_path: Path
) -> None:
    plans = _plans_dir(tmp_path)
    count = 220
    notes = [{"id": f"n{i}", "author": "user", "text": "note " * 80, "resolved": False, "reply": ""} for i in range(10)]
    for index in range(count):
        meta = {
            "schemaVersion": 1, "name": f"Plan {index:04d}", "overview": "o", "stage": "draft",
            # A todo the paged list keeps, so paging still needs several pages
            # once review notes are left out of it.
            "todos": [{"id": "t1", "content": "todo " * 800, "status": "pending"}], "reviewNotes": notes,
        }
        html = f'<script type="application/json" id="plan-meta">{json.dumps(meta)}</script>'
        (plans / f"plan-{index:04d}_abcdef.html").write_text(html, encoding="utf-8", newline="")
    (plans / "broken-list_abcdef.html").write_text('<script id="plan-meta" type="application/json">{oops</script>', encoding="utf-8", newline="")
    count += 1
    host = _DiskHost(tmp_path)

    # Un-paged: one frame that would exceed 1 MiB with full meta. The child
    # answers with every entry, meta trimmed, instead of dying on a protocol error.
    plain = _call_backend(backend_process, host, "plans.list", {})
    assert "error" not in plain
    trimmed = plain["result"]["value"]
    assert len(trimmed) == count
    assert backend_process.poll() is None
    # What an agent's plan_list needs survives the trim, for every entry.
    for entry in trimmed:
        assert {"rel_path", "name", "stage", "overview", "todos", "kind", "mtime"} <= set(entry)
        assert set(entry["todos"]) >= {"total", "by_status"}
    by_path = {entry["rel_path"]: entry for entry in trimmed}
    assert by_path[".agent-team/plans/plan-0007_abcdef.html"]["name"] == "Plan 0007"
    assert by_path[".agent-team/plans/broken-list_abcdef.html"]["reason"] == "plan-meta is not valid JSON"

    # Paged: every plan arrives, each page fits well inside one frame.
    seen: list[str] = []
    offset = 0
    pages = 0
    while offset is not None:
        frame = _call_backend(backend_process, host, "plans.list", {"offset": offset})
        value = frame["result"]["value"]
        assert value["total"] == count
        seen.extend(entry["rel_path"] for entry in value["entries"])
        assert len(json.dumps(value).encode("utf-8")) < 700 * 1024
        assert all(entry["meta"] is not None for entry in value["entries"] if entry["kind"] == "plan")
        offset = value["next_offset"]
        pages += 1
    assert pages > 1
    assert len(seen) == count == len(set(seen))
    assert _call_backend(backend_process, host, "plans.list", {"offset": -1})["error"]["data"]["code"] == "INVALID_ARGUMENT"


def _big_plan(name: str, padding: int) -> str:
    """A plan whose header (pill + island) sits above a body of `padding` bytes."""
    meta = {
        "schemaVersion": 1, "name": name, "overview": "big", "stage": "draft",
        "todos": [{"id": "t1", "content": "Task", "status": "pending"}], "reviewNotes": [],
    }
    return (
        f'<!doctype html><html><head><title>{name}</title></head><body>\n'
        f'<header><h1>{name}</h1><span class="pill draft">draft</span></header>\n'
        f'<script type="application/json" id="plan-meta">\n{json.dumps(meta, indent=2)}\n</script>\n'
        f'<ul><li data-status="pending" data-todo-id="t1"><span class="st">pending</span> <span>Task</span></li></ul>\n'
        f'<main><p>{"x" * padding}</p><p>tail marker ✓</p></main></body></html>\n'
    )


def _body_of(html: str) -> str:
    return html[html.index("<main>") :]


def test_a_multi_hundred_kilobyte_plan_can_be_updated_and_only_its_header_changes(
    backend_process: subprocess.Popen[bytes], tmp_path: Path
) -> None:
    plans = _plans_dir(tmp_path)
    path = plans / "huge_666666.html"
    original = _big_plan("Huge", 1_500_000)  # well past one frame; the >5 MB case is covered by the read/list test
    path.write_text(original, encoding="utf-8", newline="")
    rel = ".agent-team/plans/huge_666666.html"
    host = _DiskHost(tmp_path)

    stage = _call_backend(backend_process, host, "plans.update_stage", {"rel_path": rel, "stage": "in-review"})
    assert stage["result"]["value"]["stage"] == "in-review"
    note = _call_backend(
        backend_process, host, "plans.add_note", {"rel_path": rel, "author": "user", "text": "check this ✓"}
    )
    assert "error" not in note
    todo = _call_backend(
        backend_process, host, "plans.update_todo", {"rel_path": rel, "todo_id": "t1", "status": "done"}
    )
    assert "error" not in todo

    updated = path.read_bytes().decode("utf-8")
    # The child wrote all three updates itself (one resolve_root per request,
    # no bridge writes) and left no staged upload behind. That a document this
    # size takes the staged path is pinned by
    # test_a_small_write_still_uses_the_single_call_path.
    assert [name for name, _ in host.calls] == ["resolve_root"] * 3
    assert host.staging_files() == []
    # Meta and visible markup were both updated ...
    read = _call_backend(backend_process, host, "plans.read", {"rel_path": rel})["result"]["value"]
    meta = read["meta"]
    assert meta["stage"] == "in-review"
    assert [n["text"] for n in meta["reviewNotes"]] == ["check this ✓"]
    assert meta["todos"][0]["status"] == "done"
    assert 'class="pill in-review">in-review<' in updated or ">in-review<" in updated
    assert '<li data-status="done" data-todo-id="t1"><span class="st">done</span>' in updated
    # ... and the rest of the 6 MB file is byte-identical.
    _assert_same_text(_body_of(updated), _body_of(original))
    assert len(updated.encode()) > 1_500_000
    assert hashlib.sha256(_body_of(updated).encode()).hexdigest() == hashlib.sha256(_body_of(original).encode()).hexdigest()
    _assert_same_text(_read_all_pages(backend_process, host, rel), updated)


def _workspace_origin(root: Path) -> dict[str, Any]:
    """An in-process origin whose request the Host authorized for `root`."""
    return {"kind": "call", "requestId": "in-process", "instance": "instance-1", "root": str(root.resolve())}


def test_a_chunked_write_keeps_the_changed_on_disk_conflict_and_leaves_the_file_untouched(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The child writes in its own process, so the moment between staging and
    # the swap is only reachable in process.
    backend = _load_backend("plans_backend_chunked_conflict")
    plans = _plans_dir(tmp_path)
    path = plans / "race_777777.html"
    original = _big_plan("Race", 700 * 1024)
    path.write_text(original, encoding="utf-8", newline="")
    assert len(original.encode("utf-8")) > backend.SINGLE_WRITE_MAX_BYTES
    real_write_commit = backend.write_commit
    commits: list[str] = []

    def another_writer_then_commit(*args: Any) -> Any:
        # Someone else saves the file after we read it but before we commit.
        commits.append(args[1])
        stat = path.stat()
        os.utime(path, (stat.st_atime + 10, stat.st_mtime + 10))
        return real_write_commit(*args)

    monkeypatch.setattr(backend, "write_commit", another_writer_then_commit)
    with pytest.raises(backend.BridgeFailure) as failure:
        backend._update_stage(
            _workspace_origin(tmp_path), {"rel_path": ".agent-team/plans/race_777777.html", "stage": "approved"}
        )
    assert failure.value.code == "CONFLICT"
    assert commits == [".agent-team/plans/race_777777.html"]
    _assert_same_text(path.read_bytes().decode("utf-8"), original)
    assert sorted(tmp_path.rglob("*.upload")) == []


def test_a_failed_part_discards_the_staged_upload(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    backend = _load_backend("plans_backend_failed_part")
    plans = _plans_dir(tmp_path)
    path = plans / "fail_888888.html"
    # Three parts, so two are staged before the third fails.
    original = _big_plan("Fail", 2 * backend._WRITE_PART_MAX_BYTES + 100 * 1024)
    path.write_text(original, encoding="utf-8", newline="")
    real_write_part = backend.write_part
    real_write_abort = backend.write_abort
    parts: list[int] = []
    aborts: list[str] = []
    staged_before_abort: list[list[Path]] = []

    def write_part(*args: Any) -> Any:
        parts.append(args[3])
        if len(parts) == 3:
            return {"ok": False, "error": "disk full"}
        return real_write_part(*args)

    def write_abort(*args: Any) -> Any:
        aborts.append(args[2])
        staged_before_abort.append(sorted(tmp_path.rglob("*.upload")))
        return real_write_abort(*args)

    monkeypatch.setattr(backend, "write_part", write_part)
    monkeypatch.setattr(backend, "write_abort", write_abort)
    with pytest.raises(backend.BridgeFailure) as failure:
        backend._update_stage(
            _workspace_origin(tmp_path), {"rel_path": ".agent-team/plans/fail_888888.html", "stage": "approved"}
        )
    assert failure.value.code == "BACKEND_UNAVAILABLE"
    assert len(parts) == 3 and len(aborts) == 1
    # The upload really was staged, and the abort discarded it.
    assert len(staged_before_abort[0]) == 1
    _assert_same_text(path.read_bytes().decode("utf-8"), original)
    assert sorted(tmp_path.rglob("*.upload")) == []


def test_a_small_write_still_uses_the_single_call_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    backend = _load_backend("plans_backend_write_paths")
    plans = _plans_dir(tmp_path)
    (plans / "tiny_aaaaab.html").write_text(_big_plan("Tiny", 100), encoding="utf-8", newline="")
    (plans / "huge_aaaaac.html").write_text(_big_plan("Huge", 1_500_000), encoding="utf-8", newline="")
    calls: list[tuple[str, Any]] = []

    def spy(name: str) -> Any:
        real = getattr(backend, name)

        def wrapper(*args: Any, **kwargs: Any) -> Any:
            calls.append((name, args))
            return real(*args, **kwargs)

        return wrapper

    for name in ("write_file", "write_part", "write_commit", "write_abort"):
        monkeypatch.setattr(backend, name, spy(name))

    backend._update_stage(_workspace_origin(tmp_path), {"rel_path": ".agent-team/plans/tiny_aaaaab.html", "stage": "approved"})
    names = [name for name, _ in calls]
    assert "write_file" in names and "write_part" not in names
    assert '"stage": "approved"' in (plans / "tiny_aaaaab.html").read_text(encoding="utf-8")

    # Past the single-write threshold the same update is staged in parts.
    calls.clear()
    backend._update_stage(_workspace_origin(tmp_path), {"rel_path": ".agent-team/plans/huge_aaaaac.html", "stage": "approved"})
    names = [name for name, _ in calls]
    assert "write_file" not in names and names.count("write_commit") == 1 and "write_abort" not in names
    parts = [base64.b64decode(args[4]) for name, args in calls if name == "write_part"]
    assert len(parts) >= 2 and all(len(part) <= backend._WRITE_PART_MAX_BYTES for part in parts)
    assert '"stage": "approved"' in (plans / "huge_aaaaac.html").read_text(encoding="utf-8")
    assert sorted(tmp_path.rglob("*.upload")) == []


def test_plan_meta_far_down_a_huge_file_is_still_found(
    backend_process: subprocess.Popen[bytes], tmp_path: Path
) -> None:
    plans = _plans_dir(tmp_path)
    meta = {"schemaVersion": 1, "name": "Island last", "stage": "approved", "todos": [], "reviewNotes": []}
    late = f'<html><body><p>{"x" * (1_400_000)}</p><script type="application/json" id="plan-meta">{json.dumps(meta)}</script></body></html>'
    (plans / "late_bbbbbb.html").write_text(late, encoding="utf-8", newline="")
    host = _DiskHost(tmp_path)
    listed = _call_backend(backend_process, host, "plans.list", {})["result"]["value"]
    entry = next(e for e in listed if e["rel_path"].endswith("late_bbbbbb.html"))
    assert entry["kind"] == "plan" and entry["name"] == "Island last" and entry["stage"] == "approved"
    # The common case is unchanged: an island at the top costs one range read.
    (plans / "top_cccccd.html").write_text(_plan_html("Top", padding=2_000_000), encoding="utf-8", newline="")
    host.calls.clear()
    listed = _call_backend(backend_process, host, "plans.list", {})["result"]["value"]
    assert next(e for e in listed if e["rel_path"].endswith("top_cccccd.html"))["name"] == "Top"
    # Every request asks for its root once; the child reads the file itself.
    assert [operation for operation, _ in host.calls] == ["resolve_root"]
    assert _head_reads(tmp_path, "top_cccccd.html") == [HOST_RANGE_LIMIT]


def _upload(process: subprocess.Popen[bytes], host: _DiskHost, rel: str, data: bytes, upload_id: str) -> None:
    offset = 0
    while True:
        part = data[offset : offset + 96 * 1024]
        frame = _call_backend(
            process, host, "plans.write_document_part",
            {"rel_path": rel, "upload_id": upload_id, "offset": offset, "data_base64": base64.b64encode(part).decode()},
        )
        assert frame["result"]["value"] == {"ok": True, "size": offset + len(part)}
        offset += len(part)
        if offset >= len(data):
            return


def test_the_renderer_can_write_a_document_of_any_size_in_parts(
    backend_process: subprocess.Popen[bytes], tmp_path: Path
) -> None:
    plans = _plans_dir(tmp_path)
    path = plans / "ui_dddddd.html"
    path.write_text("old", encoding="utf-8", newline="")
    rel = ".agent-team/plans/ui_dddddd.html"
    payload = _big_plan("Written from the UI", 1_000_000).encode("utf-8")
    upload_id = "d" * 32
    host = _DiskHost(tmp_path)

    _upload(backend_process, host, rel, payload, upload_id)
    assert path.read_text(encoding="utf-8") == "old"
    stale = _call_backend(
        backend_process, host, "plans.write_document_commit",
        {"rel_path": rel, "upload_id": upload_id, "total_size": len(payload), "expected_mtime": 1.0},
    )
    assert stale["result"]["value"] == {"ok": False, "conflict": True}
    assert path.read_text(encoding="utf-8") == "old" and host.staging_files() == []

    _upload(backend_process, host, rel, payload, upload_id)
    committed = _call_backend(
        backend_process, host, "plans.write_document_commit",
        {"rel_path": rel, "upload_id": upload_id, "total_size": len(payload), "expected_mtime": path.stat().st_mtime},
    )["result"]["value"]
    assert committed["ok"] is True and isinstance(committed["mtime"], float)
    assert hashlib.sha256(path.read_bytes()).hexdigest() == hashlib.sha256(payload).hexdigest()
    assert host.staging_files() == []


@pytest.mark.parametrize(
    ("name", "arguments", "code"),
    [
        ("plans.write_document_part", {"rel_path": ".agent-team/plans/a.html", "upload_id": "short", "offset": 0, "data_base64": ""}, "INVALID_ARGUMENT"),
        ("plans.write_document_part", {"rel_path": ".agent-team/plans/a.html", "upload_id": "e" * 32, "offset": -1, "data_base64": ""}, "INVALID_ARGUMENT"),
        ("plans.write_document_part", {"rel_path": ".agent-team/plans/a.html", "upload_id": "e" * 32, "offset": 0, "data_base64": "A" * 140_000}, "INVALID_ARGUMENT"),
        ("plans.write_document_part", {"rel_path": ".agent-team/plans/a.html", "upload_id": "e" * 32, "offset": 0}, "INVALID_ARGUMENT"),
        ("plans.write_document_part", {"rel_path": "../escape.html", "upload_id": "e" * 32, "offset": 0, "data_base64": ""}, "WORKSPACE_SCOPE_VIOLATION"),
        ("plans.write_document_part", {"rel_path": "src/a.ts", "upload_id": "e" * 32, "offset": 0, "data_base64": ""}, "INVALID_ARGUMENT"),
        ("plans.write_document_part", {"rel_path": ".agent-team/plans/.history/a/x.html", "upload_id": "e" * 32, "offset": 0, "data_base64": ""}, "WORKSPACE_SCOPE_VIOLATION"),
        ("plans.write_document_commit", {"rel_path": ".agent-team/plans/a.html", "upload_id": "e" * 32}, "INVALID_ARGUMENT"),
        ("plans.write_document_commit", {"rel_path": ".agent-team/plans/a.html", "upload_id": "e" * 32, "total_size": 1, "expected_mtime": "x"}, "INVALID_ARGUMENT"),
        ("plans.write_document_abort", {"rel_path": ".agent-team/plans/a.html"}, "INVALID_ARGUMENT"),
    ],
)
def test_chunked_document_writes_validate_before_touching_the_host(
    backend_process: subprocess.Popen[bytes], tmp_path: Path, name: str, arguments: dict[str, Any], code: str
) -> None:
    host = _DiskHost(tmp_path)
    frame = _call_backend(backend_process, host, name, arguments)
    assert frame["error"]["data"]["code"] == code
    assert host.calls == []


def test_a_huge_file_without_plan_meta_is_scanned_in_linear_time(
    backend_process: subprocess.Popen[bytes], tmp_path: Path
) -> None:
    import time

    plans = _plans_dir(tmp_path)
    size = 6 * 1024 * 1024
    path = plans / "noisy_eeeeef.html"
    path.write_text("<html><body>" + "<p>é</p>" * (size // 8) + "</body></html>", encoding="utf-8", newline="")
    actual = path.stat().st_size
    host = _DiskHost(tmp_path)

    started = time.monotonic()
    listed = _call_backend(backend_process, host, "plans.list", {})["result"]["value"]
    elapsed = time.monotonic() - started

    entry = next(e for e in listed if e["rel_path"].endswith("noisy_eeeeef.html"))
    assert entry["kind"] == "document" and "reason" not in entry  # never skipped, not a problem
    assert [op for op, _ in host.calls] == ["resolve_root"]
    # Scanned once, range by range, to the end: never re-read from the start.
    reads = _head_reads(tmp_path, "noisy_eeeeef.html")
    expected = -(-actual // (96 * 1024))
    assert expected <= len(reads) <= expected + 1
    assert sum(reads) == actual and all(length <= 96 * 1024 for length in reads)
    assert elapsed < 30  # 20 MB took ~23 s (quadratic) before the incremental scan

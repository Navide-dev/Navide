"""The Host's Backend Wire contract with the navide.plans backend it ships.

navide.plans is built in Navide-dev/navide-plans, whose suite tests its backend
sources in full. These tests play the Host against the pinned, staged backend
executable (tests/staged_plugin_backend.py): the Wire frames, the filesystem
bridge (only resolve_root), the Host-provisioned template, plans.changed.
"""
from __future__ import annotations

import base64
import hashlib
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

from tests.staged_plugin_backend import staged_backend_command


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
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
        staged_backend_command("navide.plans", "navide-plans"),
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
            "todos": {"total": 0, "by_status": {}, "awaiting_user": 0},
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
            "todos": {"total": 1, "by_status": {"done": 1}, "awaiting_user": 0},
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
        assert set(entry["todos"]) >= {"total", "by_status", "awaiting_user"}
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


"""The packaged Plans backend reads its own plan files.

The Host hands the child only one thing: the Host-authorized plan root, through
the authenticated ``filesystem.resolve_root`` bridge call. Every other read is
the child's own ``open()``, so the path checks the Host's filesystem service
used to apply (root containment, symlink escape, ``..``) must hold in the child
itself. The fake Host here answers ``resolve_root`` and fails the test on any
other filesystem bridge read.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import subprocess
import threading
from pathlib import Path
from typing import Any

import pytest
from agent_team_backend import osplat

from tests.test_navide_plans_backend_wire import (  # noqa: F401 - backend_process is a fixture
    CLIENT_META,
    RUNTIME,
    _assert_same_text,
    _plan_html,
    _read,
    _reply_bridge,
    _send,
    backend_process,
)

def _error_bridge(process: subprocess.Popen[bytes], request: dict[str, Any], code: str) -> None:
    _send(
        process,
        {
            "jsonrpc": "2.0",
            "id": request["id"],
            "error": {"code": 1000, "message": "Host bridge test error", "data": {"code": code}},
        },
    )


BRIDGE_READS = {"read_file", "read_range", "list_dir", "stat_path"}


class _RootOnlyHost:
    """Answers resolve_root with a fixed root per instance; refuses reads."""

    def __init__(self, roots: dict[str | None, Path], *, fail_root: str | None = None) -> None:
        self.roots = roots
        self.fail_root = fail_root
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.pending_roots: list[dict[str, Any]] = []

    def __call__(self, process: subprocess.Popen[bytes], frame: dict[str, Any], instance: str | None) -> None:
        params = frame["params"]
        assert params["port"] == "filesystem"
        operation = params["operation"]
        self.calls.append((operation, dict(params["arguments"])))
        if operation in BRIDGE_READS:
            raise AssertionError(f"the child read through the Host bridge: {operation} {params['arguments']}")
        if operation != "resolve_root":
            raise AssertionError(f"unexpected filesystem operation: {operation}")
        if self.fail_root is not None:
            _error_bridge(process, frame, self.fail_root)
            return
        _reply_bridge(process, frame, {"root": str(self.roots[instance].resolve())})

    def root_calls(self) -> int:
        return sum(1 for operation, _ in self.calls if operation == "resolve_root")


_counter = 0


def _runtime(instance: str | None) -> dict[str, Any]:
    return {**RUNTIME, "instanceId": instance}


def _request(process: subprocess.Popen[bytes], name: str, arguments: dict[str, Any], instance: str | None) -> str:
    global _counter
    _counter += 1
    request_id = f"direct-{_counter}"
    _send(
        process,
        {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "navide/call",
            "params": {"_meta": CLIENT_META, "name": name, "arguments": arguments, "runtime": _runtime(instance)},
        },
    )
    return request_id


def _call(
    process: subprocess.Popen[bytes],
    host: _RootOnlyHost,
    name: str,
    arguments: dict[str, Any],
    instance: str | None = "instance-1",
) -> dict[str, Any]:
    request_id = _request(process, name, arguments, instance)
    while True:
        frame = _read(process, timeout=30)
        if frame.get("id") == request_id:
            return frame
        assert frame.get("method") == "navide/host/call", frame
        host(process, frame, instance)


def _value(frame: dict[str, Any]) -> Any:
    assert "result" in frame, frame
    return frame["result"]["value"]


def _error_code(frame: dict[str, Any]) -> str:
    assert "error" in frame, frame
    return frame["error"]["data"]["code"]


def _workspace(base: Path, name: str) -> Path:
    root = base / name
    (root / ".agent-team" / "plans").mkdir(parents=True)
    return root


# ── G1–G3: reads stay inside the Host-authorized root ────────────────────────


def test_path_outside_plans_root_is_refused(backend_process: subprocess.Popen[bytes], tmp_path: Path) -> None:
    mine = _workspace(tmp_path, "mine")
    other = _workspace(tmp_path, "other")
    (mine / ".agent-team" / "plans" / "own_aaaaaa.html").write_text(_plan_html("Own plan"), encoding="utf-8")
    (other / "docs" / "plans").mkdir(parents=True)
    secret = _plan_html("Other workspace secret")
    (other / "docs" / "plans" / "secret_bbbbbb.html").write_text(secret, encoding="utf-8")
    # A plan directory of this workspace that is really the other workspace's.
    (mine / "docs").mkdir()
    os.symlink(other / "docs" / "plans", mine / "docs" / "plans")
    host = _RootOnlyHost({"instance-1": mine})

    listed = _value(_call(backend_process, host, "plans.list", {}))
    assert [entry["rel_path"] for entry in listed] == [".agent-team/plans/own_aaaaaa.html"]
    for rel_path in ("docs/plans/secret_bbbbbb.html", str(other / "docs" / "plans" / "secret_bbbbbb.html")):
        response = _call(backend_process, host, "plans.read", {"rel_path": rel_path})
        assert "error" in response, response
        assert "Other workspace secret" not in repr(response)
    response = _call(backend_process, host, "plans.read_document", {"rel_path": "docs/plans/secret_bbbbbb.html"})
    assert "error" in response and "Other workspace secret" not in repr(response)


def test_symlink_escaping_plans_is_refused(backend_process: subprocess.Popen[bytes], tmp_path: Path) -> None:
    mine = _workspace(tmp_path, "mine")
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.html").write_text(_plan_html("Outside secret"), encoding="utf-8")
    plans = mine / ".agent-team" / "plans"
    os.symlink(outside / "secret.html", plans / "leak_cccccc.html")
    # A link that stays inside the workspace is an ordinary document, as before.
    (mine / "docs").mkdir()
    (mine / "docs" / "kept.html").write_text(_plan_html("Inside target"), encoding="utf-8")
    os.symlink(mine / "docs" / "kept.html", plans / "inside_dddddd.html")
    host = _RootOnlyHost({"instance-1": mine})

    listed = {entry["rel_path"]: entry for entry in _value(_call(backend_process, host, "plans.list", {}))}
    assert listed[".agent-team/plans/leak_cccccc.html"]["kind"] == "unreadable"
    assert listed[".agent-team/plans/inside_dddddd.html"]["name"] == "Inside target"
    assert "Outside secret" not in repr(listed)
    response = _call(backend_process, host, "plans.read", {"rel_path": ".agent-team/plans/leak_cccccc.html"})
    assert "error" in response and "Outside secret" not in repr(response)
    inside = _value(_call(backend_process, host, "plans.read", {"rel_path": ".agent-team/plans/inside_dddddd.html"}))
    assert inside["meta"]["name"] == "Inside target"
    # A history entry that links out of the workspace does not exist for us.
    history = plans / ".history" / "own_eeeeee"
    history.mkdir(parents=True)
    (history / "v1.html").write_text(_plan_html("Version one"), encoding="utf-8")
    os.symlink(outside / "secret.html", history / "v2.html")
    listing = _value(_call(backend_process, host, "plans.list_directory", {"rel_path": ".agent-team/plans/.history/own_eeeeee"}))
    assert listing == {"ok": True, "entries": [{"name": "v1.html", "is_dir": False}]}


@pytest.mark.parametrize(
    ("name", "rel_path"),
    [
        ("plans.read", ".agent-team/plans/../../outside/secret.html"),
        ("plans.read", "docs/plans/../../../outside/secret.html"),
        ("plans.read_document", ".agent-team/plans/../../outside/secret.html"),
        ("plans.read_document", ".agent-team/plans/x/.history/../../../../outside/secret.html"),
        # Ends in a plan directory, so only the ".." rule stands between it and
        # a document outside the root.
        ("plans.read", "../outside/docs/plans/secret.html"),
    ],
)
def test_dotdot_traversal_is_refused(
    backend_process: subprocess.Popen[bytes], tmp_path: Path, name: str, rel_path: str
) -> None:
    mine = _workspace(tmp_path, "mine")
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.html").write_text(_plan_html("Outside secret"), encoding="utf-8")
    (outside / "docs" / "plans").mkdir(parents=True)
    (outside / "docs" / "plans" / "secret.html").write_text(_plan_html("Outside secret"), encoding="utf-8")
    host = _RootOnlyHost({"instance-1": mine})

    response = _call(backend_process, host, name, {"rel_path": rel_path})
    assert _error_code(response) == "WORKSPACE_SCOPE_VIOLATION"
    assert "Outside secret" not in repr(response)


# ── the Host-authorized root: asked per request, never the payload ──────────


def test_plan_root_is_asked_of_the_host_for_every_request_and_never_shared(
    backend_process: subprocess.Popen[bytes], tmp_path: Path
) -> None:
    first = _workspace(tmp_path, "first")
    second = _workspace(tmp_path, "second")
    (first / ".agent-team" / "plans" / "first_aaaaaa.html").write_text(_plan_html("First"), encoding="utf-8")
    (second / ".agent-team" / "plans" / "second_bbbbbb.html").write_text(_plan_html("Second"), encoding="utf-8")
    host = _RootOnlyHost({"instance-1": first, "instance-2": second})

    for round_ in range(2):
        one = _value(_call(backend_process, host, "plans.list", {}, "instance-1"))
        two = _value(_call(backend_process, host, "plans.list", {}, "instance-2"))
        assert [entry["name"] for entry in one] == ["First"]
        assert [entry["name"] for entry in two] == ["Second"]
        # One Host authorization per request, however many files it touches.
        assert host.root_calls() == 2 * (round_ + 1)


def test_plan_root_failure_fails_the_request_and_never_uses_the_payload(
    backend_process: subprocess.Popen[bytes], tmp_path: Path
) -> None:
    mine = _workspace(tmp_path, "mine")
    hostile = _workspace(tmp_path, "hostile")
    (hostile / ".agent-team" / "plans" / "bait_eeeeee.html").write_text(_plan_html("Hostile bait"), encoding="utf-8")
    host = _RootOnlyHost({"instance-1": mine}, fail_root="BACKEND_UNAVAILABLE")

    for name, arguments in (
        ("plans.list", {}),
        ("plans.read", {"rel_path": ".agent-team/plans/bait_eeeeee.html"}),
        ("plans.read_document", {"rel_path": ".agent-team/plans/bait_eeeeee.html"}),
        ("plans.resolve_root", {"workspace_path": str(hostile)}),
    ):
        response = _call(backend_process, host, name, arguments)
        assert _error_code(response) == "BACKEND_UNAVAILABLE", (name, response)
        assert "Hostile bait" not in repr(response) and str(hostile) not in repr(response)
    # A failure is not remembered: the next request asks the Host again.
    calls_before = host.root_calls()
    host.fail_root = None
    host.roots["instance-1"] = mine
    assert _value(_call(backend_process, host, "plans.list", {})) == []
    assert host.root_calls() == calls_before + 1


def test_concurrent_requests_each_ask_the_host_for_their_own_root(
    backend_process: subprocess.Popen[bytes], tmp_path: Path
) -> None:
    mine = _workspace(tmp_path, "mine")
    (mine / ".agent-team" / "plans" / "only_ffffff.html").write_text(_plan_html("Only"), encoding="utf-8")
    host = _RootOnlyHost({"instance-1": mine})
    ids = {
        _request(backend_process, "plans.read", {"rel_path": ".agent-team/plans/only_ffffff.html"}, "instance-1")
        for _ in range(2)
    }
    # Neither borrows the other's authorization: both ask, on their own behalf,
    # before either is answered.
    root_requests = [_read(backend_process, timeout=10) for _ in range(2)]
    assert [frame["params"]["operation"] for frame in root_requests] == ["resolve_root", "resolve_root"]
    assert {frame["params"]["origin"]["requestId"] for frame in root_requests} == ids
    for frame in root_requests:
        host(backend_process, frame, "instance-1")
    answered: dict[str, dict[str, Any]] = {}
    while len(answered) < 2:
        frame = _read(backend_process, timeout=10)
        assert frame.get("method") != "navide/host/call", frame
        answered[frame["id"]] = frame
    assert set(answered) == ids
    assert all(_value(frame)["meta"]["name"] == "Only" for frame in answered.values())
    assert host.root_calls() == 2


# ── t6: large documents list and page back byte for byte ─────────────────────


def test_large_plans_are_listed_and_paged_back_byte_identical(
    backend_process: subprocess.Popen[bytes], tmp_path: Path
) -> None:
    mine = _workspace(tmp_path, "mine")
    plans = mine / ".agent-team" / "plans"
    documents = {
        "medium_aaaaaa.html": _plan_html("About 197 KB", padding=197 * 1000, extra="<p>é ✓ 計畫</p>"),
        "huge_bbbbbb.html": _plan_html("About 5.8 MB", padding=5_800_000, extra="<p>tail ✓ 😀</p>"),
    }
    for name, text in documents.items():
        (plans / name).write_text(text, encoding="utf-8", newline="")
    host = _RootOnlyHost({"instance-1": mine})

    listed = {entry["rel_path"]: entry for entry in _value(_call(backend_process, host, "plans.list", {}))}
    assert listed[".agent-team/plans/medium_aaaaaa.html"]["name"] == "About 197 KB"
    assert listed[".agent-team/plans/huge_bbbbbb.html"]["name"] == "About 5.8 MB"
    # The Plans view's paged list shows them as plans too.
    page = _value(_call(backend_process, host, "plans.list", {"offset": 0}))
    assert page["next_offset"] is None
    paged = {entry["rel_path"]: entry for entry in page["entries"]}
    assert {path: (entry["kind"], entry["meta"]["name"]) for path, entry in paged.items()} == {
        ".agent-team/plans/huge_bbbbbb.html": ("plan", "About 5.8 MB"),
        ".agent-team/plans/medium_aaaaaa.html": ("plan", "About 197 KB"),
    }
    for name, text in documents.items():
        rel_path = f".agent-team/plans/{name}"
        pages: list[str] = []
        offset = 0
        while True:
            arguments: dict[str, Any] = {"rel_path": rel_path}
            if offset:
                arguments["offset"] = offset
            value = _value(_call(backend_process, host, "plans.read", arguments))
            pages.append(value["html"])
            if value.get("eof") is not False:
                break
            assert value["next_offset"] > offset
            offset = value["next_offset"]
        joined = "".join(pages).encode("utf-8")
        source = (plans / name).read_bytes()
        assert hashlib.sha256(joined).hexdigest() == hashlib.sha256(source).hexdigest()
        _assert_same_text("".join(pages), text)
    assert {operation for operation, _ in host.calls} == {"resolve_root"}


def test_list_scans_of_different_views_never_share_a_result(tmp_path: Path) -> None:
    """A view's plans.list never waits on, or takes, another view's scan."""
    from tests.test_navide_plans_backend_wire import _load_backend

    backend = _load_backend("plans_backend_view_isolation")
    first = _workspace(tmp_path, "first")
    second = _workspace(tmp_path, "second")
    release_first = threading.Event()
    first_started = threading.Event()

    def scan(origin: dict[str, Any]) -> list[dict[str, Any]]:
        if origin["instance"] == "instance-1":
            first_started.set()
            release_first.wait(timeout=3)
        return [{"root": backend._plan_root(origin)}]

    backend._list_plans = scan
    results: dict[str, Any] = {}
    leader = threading.Thread(
        target=lambda: results.setdefault("first", backend._list_plans_single_flight(
            {"kind": "call", "requestId": "a", "instance": "instance-1", "root": str(first)})),
    )
    leader.start()
    assert first_started.wait(timeout=5)
    try:
        other = backend._list_plans_single_flight(
            {"kind": "call", "requestId": "b", "instance": "instance-2", "root": str(second)})
        # Answered while the first view's scan is still held: it never waited.
        assert leader.is_alive()
        assert other == [{"root": str(second)}]
    finally:
        release_first.set()
        leader.join(timeout=10)
    assert results["first"] == [{"root": str(first)}]


def test_a_list_caller_the_host_refuses_never_shares_another_callers_scan(tmp_path: Path) -> None:
    """Joining an in-flight scan needs the caller's own Host authorization."""
    from tests.test_navide_plans_backend_wire import _load_backend

    backend = _load_backend("plans_backend_follower_authorization")
    mine = _workspace(tmp_path, "mine")
    release_leader = threading.Event()
    leader_started = threading.Event()

    def bridge_call(origin: dict[str, Any], port: str, operation: str, arguments: Any) -> Any:
        assert (port, operation) == ("filesystem", "resolve_root")
        if origin["requestId"] == "agent":
            raise backend.BridgeFailure("CAPABILITY_DENIED")
        return {"root": str(mine)}

    def scan(origin: dict[str, Any]) -> list[dict[str, Any]]:
        leader_started.set()
        release_leader.wait(timeout=10)
        return [{"secret": "scanned for the user"}]

    backend._bridge_call = bridge_call
    backend._list_plans = scan
    results: dict[str, Any] = {}
    leader = threading.Thread(
        target=lambda: results.setdefault("user", backend._list_plans_single_flight(
            {"kind": "call", "requestId": "user", "instance": "instance-1"})),
    )
    leader.start()
    assert leader_started.wait(timeout=5)
    outcome: dict[str, Any] = {}

    def follow() -> None:
        try:
            outcome["value"] = backend._list_plans_single_flight(
                {"kind": "call", "requestId": "agent", "instance": "instance-1"})
        except backend.BridgeFailure as error:
            outcome["error"] = error.code

    follower = threading.Thread(target=follow)
    follower.start()
    follower.join(timeout=2)
    release_leader.set()
    follower.join(timeout=10)
    leader.join(timeout=10)
    assert outcome == {"error": "CAPABILITY_DENIED"}
    assert results["user"] == [{"secret": "scanned for the user"}]


# ── G4–G6: writes stay inside the plan documents and are atomic ──────────────


def _write(process: subprocess.Popen[bytes], host: _RootOnlyHost, rel_path: str, content: str, **extra: Any) -> dict[str, Any]:
    return _call(process, host, "plans.write_document", {"rel_path": rel_path, "content": content, **extra})


@pytest.mark.parametrize(
    "rel_path",
    [
        # Each ends in a plan directory, so only the core guard stands between
        # it and the protected directory.
        ".agent-team/state/docs/plans/a.html",
        "pkg/.git/docs/plans/a.html",
        ".git/docs/plans/a.html",
    ],
)
def test_write_to_other_agent_team_dirs_is_refused(
    backend_process: subprocess.Popen[bytes], tmp_path: Path, rel_path: str
) -> None:
    mine = _workspace(tmp_path, "mine")
    (mine / ".git").mkdir()
    host = _RootOnlyHost({"instance-1": mine})

    response = _write(backend_process, host, rel_path, _plan_html("Smuggled"))
    assert _error_code(response) == "WORKSPACE_SCOPE_VIOLATION"
    assert not (mine / rel_path).exists()
    # The user-facing subtrees stay writable, as before.
    assert _value(_write(backend_process, host, ".agent-team/reports/kept.md", "# Kept\n")) == {"ok": True}
    assert (mine / ".agent-team" / "reports" / "kept.md").read_text(encoding="utf-8") == "# Kept\n"


@pytest.mark.parametrize(
    "rel_path",
    [
        ".agent-team/plans/payload.js",
        ".agent-team/plans/data.json",
        ".agent-team/plans/image.svg",
        ".agent-team/plans/notes.txt",
        ".agent-team/plans/assets/image.png",
        ".agent-team/plans/_template.html",
        ".agent-team/plans/.hidden.html",
    ],
)
def test_non_html_non_assets_extension_is_refused(
    backend_process: subprocess.Popen[bytes], tmp_path: Path, rel_path: str
) -> None:
    mine = _workspace(tmp_path, "mine")
    host = _RootOnlyHost({"instance-1": mine})

    response = _write(backend_process, host, rel_path, "<p>not a plan</p>")
    assert _error_code(response) in {"INVALID_ARGUMENT", "WORKSPACE_SCOPE_VIOLATION"}
    assert not (mine / rel_path).exists()
    # Every document kind writable today still is.
    for allowed in (".agent-team/plans/new.html", "docs/plans/n.plan.md", ".cursor/plans/n.md", ".plans/shared.html"):
        assert _value(_write(backend_process, host, allowed, "plan ✓\n")) == {"ok": True}, allowed
        assert (mine / allowed).read_bytes() == "plan ✓\n".encode("utf-8")


def test_write_is_atomic_and_rejects_stale_mtime(backend_process: subprocess.Popen[bytes], tmp_path: Path) -> None:
    mine = _workspace(tmp_path, "mine")
    plans = mine / ".agent-team" / "plans"
    target = plans / "doc_aaaaaa.html"
    target.write_text(_plan_html("Original"), encoding="utf-8")
    if osplat.paths.enforces_posix_modes():
        target.chmod(0o640)
    os.utime(target, (1_000.0, 1_000.0))
    before = target.stat()
    host = _RootOnlyHost({"instance-1": mine})
    rel_path = ".agent-team/plans/doc_aaaaaa.html"

    stale = _value(_write(backend_process, host, rel_path, _plan_html("Lost update"), expected_mtime=999.0))
    assert stale == {"ok": False, "conflict": True}
    assert "Original" in target.read_text(encoding="utf-8")

    fresh = _value(_write(backend_process, host, rel_path, _plan_html("Updated"), expected_mtime=1_000.0))
    assert fresh == {"ok": True}
    after = target.stat()
    assert target.read_text(encoding="utf-8") == _plan_html("Updated")
    # Replaced by rename, never rewritten in place, and the mode survives it.
    assert after.st_ino != before.st_ino
    if osplat.paths.enforces_posix_modes():
        assert after.st_mode & 0o777 == 0o640
    assert sorted(path.name for path in plans.iterdir()) == ["doc_aaaaaa.html"]

    # A document sent in parts swaps in the same way, with the same check.
    data = _plan_html("Chunked", padding=300 * 1024).encode("utf-8")
    upload_id = "0123456789abcdef0123456789abcdef"

    def upload(expected_mtime: float) -> dict[str, Any]:
        offset = 0
        while offset < len(data):
            part = data[offset : offset + 96 * 1024]
            assert _value(_call(backend_process, host, "plans.write_document_part", {
                "rel_path": rel_path, "upload_id": upload_id, "offset": offset,
                "data_base64": base64.b64encode(part).decode("ascii"),
            }))["ok"] is True
            offset += len(part)
        return _value(_call(backend_process, host, "plans.write_document_commit", {
            "rel_path": rel_path, "upload_id": upload_id, "total_size": len(data), "expected_mtime": expected_mtime,
        }))

    assert upload(expected_mtime=1.0) == {"ok": False, "conflict": True}
    assert target.read_text(encoding="utf-8") == _plan_html("Updated")
    assert sorted(path.name for path in plans.iterdir()) == ["doc_aaaaaa.html"]
    committed = upload(expected_mtime=target.stat().st_mtime)
    assert committed["ok"] is True
    assert target.read_bytes() == data
    assert sorted(path.name for path in plans.iterdir()) == ["doc_aaaaaa.html"]


def test_agent_changes_refuse_a_document_without_valid_plan_meta_and_leave_it_untouched(
    backend_process: subprocess.Popen[bytes], tmp_path: Path
) -> None:
    """Locks today's rule; there is no write-time "unsynced plan-meta" refusal."""
    mine = _workspace(tmp_path, "mine")
    plans = mine / ".agent-team" / "plans"
    broken = '<html><body><script type="application/json" id="plan-meta">{not json</script></body></html>\n'
    (plans / "broken_aaaaaa.html").write_text(broken, encoding="utf-8")
    (plans / "plain_bbbbbb.html").write_text("<html><body><p>No meta</p></body></html>\n", encoding="utf-8")
    host = _RootOnlyHost({"instance-1": mine})

    for name in ("broken_aaaaaa.html", "plain_bbbbbb.html"):
        before = (plans / name).read_bytes()
        for method, arguments in (
            ("plans.update_stage", {"stage": "approved"}),
            ("plans.add_note", {"text": "note"}),
            ("plans.update_archive", {"archived_at": "2026-10-04"}),
        ):
            response = _call(backend_process, host, method, {"rel_path": f".agent-team/plans/{name}", **arguments})
            assert _error_code(response) == "INVALID_ARGUMENT", (name, method, response)
            assert (plans / name).read_bytes() == before


def test_agent_changes_keep_plan_meta_and_visible_markup_in_step(
    backend_process: subprocess.Popen[bytes], tmp_path: Path
) -> None:
    mine = _workspace(tmp_path, "mine")
    meta = {"schemaVersion": 1, "name": "Synced", "overview": "", "stage": "draft",
            "todos": [{"id": "t1", "content": "First", "status": "pending"}], "reviewNotes": []}
    document = (
        "<!doctype html><html><body>\n"
        f'<script type="application/json" id="plan-meta">\n{json.dumps(meta)}\n</script>\n'
        '<span class="pill draft">draft</span>\n'
        '<ul><li data-status="pending" data-todo-id="t1"><span class="st">pending</span> First</li></ul>\n'
        "</body></html>\n"
    )
    target = mine / ".agent-team" / "plans" / "synced_cccccc.html"
    target.write_text(document, encoding="utf-8")
    host = _RootOnlyHost({"instance-1": mine})
    rel_path = ".agent-team/plans/synced_cccccc.html"

    assert _value(_call(backend_process, host, "plans.update_stage", {"rel_path": rel_path, "stage": "in-progress"}))["stage"] == "in-progress"
    assert _value(_call(backend_process, host, "plans.update_todo", {"rel_path": rel_path, "todo_id": "t1", "status": "done"}))["status"] == "done"
    text = target.read_text(encoding="utf-8")
    island = json.loads(re.search(r'id="plan-meta">([\s\S]*?)</script>', text).group(1))
    assert island["stage"] == "in-progress" and island["todos"][0]["status"] == "done"
    assert '<span class="pill in-progress">in-progress</span>' in text
    assert '<li data-status="done" data-todo-id="t1"><span class="st">done</span>' in text


# ── the Host's per-request gates still decide every plan file access ─────────
#
# The Host re-checks each filesystem request against the requesting runtime:
# an agent initiator needs the workspace Execution Policy to allow `fs`
# (pluginBackendSupervisor's bridge gate and plansAgentFilesystemPolicyAllows),
# and every request must still match the selected Plans package grant
# (plansFilesystemGrantAllows). This fake Host applies that gate to every
# filesystem bridge call, so a child that skips asking the Host skips the gate.

USER = {"kind": "user", "id": "user-1"}
AGENT = {"kind": "agent", "source": "mcp", "id": "agent-1"}


class _GatedHost:
    def __init__(self, root: Path, allows: Any) -> None:
        self.root = root
        self.allows = allows

    def __call__(self, process: subprocess.Popen[bytes], frame: dict[str, Any], runtime: dict[str, Any]) -> None:
        params = frame["params"]
        assert params["port"] == "filesystem"
        if not self.allows(runtime):
            _error_bridge(process, frame, "CAPABILITY_DENIED")
            return
        operation, arguments = params["operation"], params["arguments"]
        target = self.root / arguments.get("rel_path", "")
        # Bridge reads are served too, so the gate holds for a child that
        # still reads through the Host (the behaviour before direct reads).
        if operation == "resolve_root":
            _reply_bridge(process, frame, {"root": str(self.root.resolve())})
        elif operation == "stat_path":
            _reply_bridge(process, frame, {"exists": target.exists(), "isDirectory": target.is_dir()})
        elif operation == "list_dir":
            _reply_bridge(process, frame, {"entries": sorted(p.name for p in target.iterdir()) if target.is_dir() else []})
        elif operation == "read_range":
            raw = target.read_bytes()
            piece = raw[arguments["offset"] : arguments["offset"] + arguments["length"]]
            _reply_bridge(process, frame, {
                "data_base64": base64.b64encode(piece).decode("ascii"), "size": len(raw),
                "mtime": target.stat().st_mtime, "eof": arguments["offset"] + len(piece) >= len(raw),
            })
        else:
            raise AssertionError(f"unexpected filesystem operation: {operation}")


def _call_as(
    process: subprocess.Popen[bytes], host: _GatedHost, name: str, arguments: dict[str, Any], runtime: dict[str, Any]
) -> dict[str, Any]:
    global _counter
    _counter += 1
    request_id = f"gated-{_counter}"
    _send(process, {
        "jsonrpc": "2.0", "id": request_id, "method": "navide/call",
        "params": {"_meta": CLIENT_META, "name": name, "arguments": arguments, "runtime": runtime},
    })
    while True:
        frame = _read(process, timeout=30)
        if frame.get("id") == request_id:
            return frame
        assert frame.get("method") == "navide/host/call", frame
        host(process, frame, runtime)


def test_agent_plan_reads_are_refused_when_the_execution_policy_denies_fs(
    backend_process: subprocess.Popen[bytes], tmp_path: Path
) -> None:
    mine = _workspace(tmp_path, "mine")
    (mine / ".agent-team" / "plans" / "kept_aaaaaa.html").write_text(_plan_html("Policy guarded"), encoding="utf-8")
    host = _GatedHost(mine, allows=lambda runtime: runtime["initiator"]["kind"] != "agent")
    as_user = {**RUNTIME, "initiator": USER}
    as_agent = {**RUNTIME, "initiator": AGENT}

    # The user's own view opens the plans first, as it does in the app.
    assert [entry["name"] for entry in _value(_call_as(backend_process, host, "plans.list", {}, as_user))] == ["Policy guarded"]
    for name, arguments in (
        ("plans.list", {}),
        ("plans.read", {"rel_path": ".agent-team/plans/kept_aaaaaa.html"}),
    ):
        response = _call_as(backend_process, host, name, arguments, as_agent)
        assert _error_code(response) == "CAPABILITY_DENIED", (name, response)
        assert "Policy guarded" not in repr(response)


def test_agent_plan_reads_succeed_when_the_execution_policy_allows_fs(
    backend_process: subprocess.Popen[bytes], tmp_path: Path
) -> None:
    mine = _workspace(tmp_path, "mine")
    (mine / ".agent-team" / "plans" / "open_cccccc.html").write_text(_plan_html("Agent readable"), encoding="utf-8")
    host = _GatedHost(mine, allows=lambda runtime: True)
    as_agent = {**RUNTIME, "initiator": AGENT}

    assert [entry["name"] for entry in _value(_call_as(backend_process, host, "plans.list", {}, as_agent))] == ["Agent readable"]
    read = _value(_call_as(backend_process, host, "plans.read", {"rel_path": ".agent-team/plans/open_cccccc.html"}, as_agent))
    assert read["meta"]["name"] == "Agent readable"


def test_agent_plan_writes_are_refused_when_the_execution_policy_denies_fs(
    backend_process: subprocess.Popen[bytes], tmp_path: Path
) -> None:
    mine = _workspace(tmp_path, "mine")
    target = mine / ".agent-team" / "plans" / "kept_dddddd.html"
    target.write_text(_plan_html("Write guarded"), encoding="utf-8")
    before = target.read_bytes()
    host = _GatedHost(mine, allows=lambda runtime: runtime["initiator"]["kind"] != "agent")
    as_user = {**RUNTIME, "initiator": USER}
    as_agent = {**RUNTIME, "initiator": AGENT}
    rel_path = ".agent-team/plans/kept_dddddd.html"

    assert _value(_call_as(backend_process, host, "plans.read", {"rel_path": rel_path}, as_user))
    for name, arguments in (
        ("plans.update_stage", {"rel_path": rel_path, "stage": "approved"}),
        ("plans.write_document", {"rel_path": rel_path, "content": "replaced"}),
        ("plans.create", {"name": "Smuggled plan", "overview": "", "todos": []}),
    ):
        response = _call_as(backend_process, host, name, arguments, as_agent)
        assert _error_code(response) == "CAPABILITY_DENIED", (name, response)
    assert target.read_bytes() == before
    assert sorted(p.name for p in target.parent.iterdir()) == ["kept_dddddd.html"]


def test_plan_reads_are_refused_once_the_package_grant_no_longer_matches(
    backend_process: subprocess.Popen[bytes], tmp_path: Path
) -> None:
    mine = _workspace(tmp_path, "mine")
    (mine / ".agent-team" / "plans" / "kept_bbbbbb.html").write_text(_plan_html("Grant guarded"), encoding="utf-8")
    selected = {"packageVersion": RUNTIME["packageVersion"]}
    host = _GatedHost(mine, allows=lambda runtime: runtime["packageVersion"] == selected["packageVersion"])

    assert _value(_call_as(backend_process, host, "plans.read", {"rel_path": ".agent-team/plans/kept_bbbbbb.html"}, RUNTIME))
    # The Host switches the selected Plans package; this runtime's grant is gone.
    selected["packageVersion"] = "0.2.0"
    for name, arguments in (
        ("plans.list", {}),
        ("plans.read", {"rel_path": ".agent-team/plans/kept_bbbbbb.html"}),
    ):
        response = _call_as(backend_process, host, name, arguments, RUNTIME)
        assert _error_code(response) == "CAPABILITY_DENIED", (name, response)
        assert "Grant guarded" not in repr(response)


# ── t7: the paged list (the Plans view's) carries only the meta it reads ─────

_RICH_META = {
    "schemaVersion": 1,
    "name": "Rich plan",
    "title": "Rich title",
    "overview": "Rich overview",
    "stage": "approved",
    "approvedAt": "2026-10-04T00:00:00Z",
    "archivedAt": "2026-10-05T00:00:00Z",
    "isProject": True,
    "executions": [{"id": "e1", "status": "done"}],
    "todos": [
        {"id": "t1", "content": "Mine", "status": "pending", "owner": "user", "note": "extra"},
        {"id": "t2", "content": "Agent's", "status": "done"},
    ],
    "reviewNotes": [{"id": "n1", "author": "user", "text": "Long review text", "resolved": False, "reply": ""}],
}


def _rich_workspace(tmp_path: Path) -> Path:
    mine = _workspace(tmp_path, "mine")
    document = (
        '<!doctype html><html><body>\n<script type="application/json" id="plan-meta">\n'
        f"{json.dumps(_RICH_META)}\n</script>\n</body></html>\n"
    )
    (mine / ".agent-team" / "plans" / "rich_aaaaaa.html").write_text(document, encoding="utf-8")
    return mine


def test_paged_list_entries_carry_only_the_meta_the_plans_view_reads(
    backend_process: subprocess.Popen[bytes], tmp_path: Path
) -> None:
    host = _RootOnlyHost({"instance-1": _rich_workspace(tmp_path)})

    page = _value(_call(backend_process, host, "plans.list", {"offset": 0}))
    [entry] = page["entries"]
    assert entry["meta"] == {
        "name": "Rich plan",
        "stage": "approved",
        "overview": "Rich overview",
        "archivedAt": "2026-10-05T00:00:00Z",
        "todos": [
            {"id": "t1", "content": "Mine", "status": "pending", "owner": "user"},
            {"id": "t2", "content": "Agent's", "status": "done"},
        ],
        "reviewNotes": [],
    }
    # The entry's own fields are untouched.
    assert entry["name"] == "Rich plan" and entry["kind"] == "plan" and entry["stage"] == "approved"
    assert entry["todos"] == {"total": 2, "by_status": {"pending": 1, "done": 1}}


def test_paged_list_meta_keeps_an_empty_review_notes_list(
    backend_process: subprocess.Popen[bytes], tmp_path: Path
) -> None:
    mine = _rich_workspace(tmp_path)
    (mine / ".agent-team" / "plans" / "bare_bbbbbb.html").write_text(_plan_html("Bare plan"), encoding="utf-8")
    host = _RootOnlyHost({"instance-1": mine})

    entries = _value(_call(backend_process, host, "plans.list", {"offset": 0}))["entries"]
    assert [entry["meta"]["reviewNotes"] for entry in entries] == [[], []]


def test_unpaged_list_keeps_the_full_meta_agents_receive(
    backend_process: subprocess.Popen[bytes], tmp_path: Path
) -> None:
    host = _RootOnlyHost({"instance-1": _rich_workspace(tmp_path)})

    [entry] = _value(_call(backend_process, host, "plans.list", {}))
    assert entry["meta"] == _RICH_META


# ── t17: a page entry whose meta had to be dropped still says if it is archived

def _oversized_plan(name: str, archived_at: str | None) -> str:
    meta: dict[str, Any] = {
        "schemaVersion": 1, "name": name, "overview": "", "stage": "done",
        # Past one page even after the page leaves out review notes.
        "todos": [{"id": "t1", "content": "x" * 700_000, "status": "done"}],
        "reviewNotes": [],
    }
    if archived_at is not None:
        meta["archivedAt"] = archived_at
    return f'<script type="application/json" id="plan-meta">{json.dumps(meta)}</script>\n'


def test_a_paged_entry_without_its_meta_still_carries_its_archived_at(
    backend_process: subprocess.Popen[bytes], tmp_path: Path
) -> None:
    mine = _workspace(tmp_path, "mine")
    plans = mine / ".agent-team" / "plans"
    (plans / "archived_aaaaaa.html").write_text(_oversized_plan("Archived big", "2026-10-01T00:00:00Z"), encoding="utf-8")
    (plans / "active_bbbbbb.html").write_text(_oversized_plan("Active big", None), encoding="utf-8")
    host = _RootOnlyHost({"instance-1": mine})

    paged: dict[str, dict[str, Any]] = {}
    offset: int | None = 0
    while offset is not None:
        page = _value(_call(backend_process, host, "plans.list", {"offset": offset}))
        paged.update({entry["rel_path"]: entry for entry in page["entries"]})
        offset = page["next_offset"]
    archived = paged[".agent-team/plans/archived_aaaaaa.html"]
    active = paged[".agent-team/plans/active_bbbbbb.html"]
    assert archived["meta"] is None and archived["kind"] == "plan"
    assert archived["archivedAt"] == "2026-10-01T00:00:00Z"
    assert active["meta"] is None and active["kind"] == "plan"
    assert "archivedAt" not in active

    # Agents' un-paged list is unchanged: no such key on any entry.
    for entry in _value(_call(backend_process, host, "plans.list", {})):
        assert "archivedAt" not in entry

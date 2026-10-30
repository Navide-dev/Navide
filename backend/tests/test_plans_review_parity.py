"""Exercise manual Plans mutations at the packaged child's real write seam."""

import hashlib
import importlib.util
import json
import os
from pathlib import Path

import pytest


@pytest.fixture
def child():
    source = Path(__file__).resolve().parents[2] / "plugins/navide-plans/backend/plans_backend.py"
    spec = importlib.util.spec_from_file_location("plans_parity_child", source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def plan(notes):
    meta = {"schemaVersion": 1, "name": "Review", "stage": "in-review", "todos": [], "reviewNotes": notes}
    return '<script id="plan-meta" type="application/json">' + json.dumps(meta) + '</script><h2>Goals</h2>'


def test_manual_edit_preserves_v1_note_identity_and_other_fields(child, monkeypatch):
    note = {"id": "existing-note", "author": "user", "text": "Before", "resolved": True,
            "reply": "Keep reply", "anchor": "Goals", "extension": {"keep": True}}
    writes = []
    monkeypatch.setattr(child, "_read_text", lambda *args, **kwargs: (plan([note]), 10.0))
    monkeypatch.setattr(child, "_write", lambda *args: writes.append(args))
    result = child._manual_review_note({}, {"rel_path": ".agent-team/plans/a.html", "note_id": note["id"], "text": "After"}, "edit")
    assert result == {**note, "text": "After"}
    assert len(writes) == 1
    assert writes[0][1] == ".agent-team/plans/a.html"
    assert writes[0][3] == 10.0


def test_manual_note_retries_conflict_against_fresh_external_updates(child, monkeypatch):
    first = {"id": "n1", "author": "user", "text": "First", "resolved": False, "reply": "", "anchor": "Goals"}
    external = {"id": "n2", "author": "ai", "text": "External", "resolved": False, "reply": "Agent reply", "anchor": "Scope"}
    reads = iter([(plan([first]), 1.0), (plan([first, external]), 2.0)])
    writes = []
    monkeypatch.setattr(child, "_read_text", lambda *args, **kwargs: next(reads))

    def write(origin, path, content, mtime):
        writes.append((path, content, mtime))
        if len(writes) == 1:
            raise child.BridgeFailure("CONFLICT")

    monkeypatch.setattr(child, "_write", write)
    result = child._manual_review_note({}, {"rel_path": ".agent-team/plans/a.html", "text": "New", "anchor": "Goals"}, "add")
    assert result["id"] == "n3"
    assert result["anchor"] == "Goals"
    assert len(writes) == 2
    assert writes[1][2] == 2.0
    assert child._parse_plan_meta(writes[1][1])["reviewNotes"] == [first, external, result]


def test_manual_note_second_conflict_is_reported_without_unbounded_retry(child, monkeypatch):
    writes = []
    monkeypatch.setattr(child, "_read_text", lambda *args, **kwargs: (plan([]), 1.0))

    def write(*args):
        writes.append(args)
        raise child.BridgeFailure("CONFLICT")

    monkeypatch.setattr(child, "_write", write)
    with pytest.raises(child.BridgeFailure, match="CONFLICT"):
        child._manual_review_note({}, {"rel_path": ".agent-team/plans/a.html", "text": "New", "anchor": "Goals"}, "add")
    assert len(writes) == 2


def _workspace(child, root):
    """An origin whose request the Host already authorized for `root`."""
    return {"kind": "call", "requestId": "r1", "instance": "instance-1", "root": str(root.resolve())}


def test_document_transport_preserves_read_mtime_and_write_conflict(child, monkeypatch, tmp_path):
    path = ".agent-team/plans/a.html"
    document = tmp_path / path
    document.parent.mkdir(parents=True)
    document.write_text(plan([]), encoding="utf-8", newline="")
    os.utime(document, (12.0, 12.0))
    origin = _workspace(child, tmp_path)
    calls = []
    monkeypatch.setattr(child, "_bridge_call", lambda *args: calls.append(args))
    read = child._manual_document(origin, {"rel_path": path}, "read")
    # The whole file's sha256 rides along for the writer's expected_sha256.
    assert read == {
        "ok": True, "content": plan([]), "mtime": 12.0,
        "sha256": hashlib.sha256(plan([]).encode("utf-8")).hexdigest(),
    }
    # Someone else saves the document after it was read.
    os.utime(document, (13.0, 13.0))
    result = child._manual_document(origin, {"rel_path": path, "content": "changed", "expected_mtime": 12.0}, "write")
    assert result == {"ok": False, "conflict": True}
    assert document.read_text(encoding="utf-8") == plan([])
    # Against the mtime on disk the same write lands.
    assert child._manual_document(origin, {"rel_path": path, "content": "changed", "expected_mtime": 13.0}, "write") == {"ok": True}
    assert document.read_text(encoding="utf-8") == "changed"
    # The child reads and writes the document itself; nothing crossed the Bridge.
    assert calls == []


@pytest.mark.parametrize("path", ["../escape.html", "/tmp/a.html", "src/a.ts", ".agent-team/plans/../a.html", ".plans/../../a.html"])
def test_document_transport_rejects_non_plan_paths_before_bridge(child, monkeypatch, path):
    calls = []
    monkeypatch.setattr(child, "_bridge_call", lambda *args: calls.append(args))
    with pytest.raises(child.BridgeFailure):
        child._manual_document({}, {"rel_path": path, "content": "bad"}, "write")
    assert calls == []


def test_document_transport_lists_history_in_retained_shape(child, monkeypatch, tmp_path):
    history = tmp_path / ".agent-team/plans/.history/a"
    history.mkdir(parents=True)
    (history / "20260901T100000_approved.html").write_text("<h2>Before</h2>", encoding="utf-8")
    origin = _workspace(child, tmp_path)
    calls = []
    monkeypatch.setattr(child, "_bridge_call", lambda *args: calls.append(args))
    result = child._manual_document(origin, {"rel_path": ".agent-team/plans/.history/a"}, "list")
    assert result == {"ok": True, "entries": [{"name": "20260901T100000_approved.html", "is_dir": False}]}
    # Listing is local to the child; it no longer asks the Host for list_dir/stat_path.
    assert calls == []


@pytest.mark.parametrize("action", ["edit", "delete"])
def test_manual_notes_synchronize_existing_v1_body_markup_only(child, monkeypatch, action):
    note = {"id": "n1", "author": "user", "text": "Old body text", "resolved": False, "reply": "Keep reply", "anchor": "Goals"}
    markup = '<ul class="notes">\n  <li data-note-id="n1"><span class="who">user</span>Old body text<div class="reply">Keep reply</div></li>\n</ul>'
    content = plan([note]) + markup + '<p>Unrelated body</p>'
    writes = []
    monkeypatch.setattr(child, "_read_text", lambda *args, **kwargs: (content, 1.0))
    monkeypatch.setattr(child, "_write", lambda *args: writes.append(args[2]))
    args = {"rel_path": ".agent-team/plans/a.html", "note_id": "n1"}
    if action == "edit":
        args["text"] = "New <safe> & text"
    child._manual_review_note({}, args, action)
    assert len(writes) == 1
    body = writes[0].split('</script>', 1)[1]
    assert 'Old body text' not in body
    assert '<p>Unrelated body</p>' in body
    if action == "edit":
        assert '<span class="who">user</span>New &lt;safe&gt; &amp; text<div class="reply">Keep reply</div>' in body
    else:
        assert 'data-note-id="n1"' not in body

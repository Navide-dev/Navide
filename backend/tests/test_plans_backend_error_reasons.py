"""The Plans child keeps the reason a filesystem operation failed.

A refused path, an OS error and a missing file used to collapse into one
BACKEND_UNAVAILABLE with nothing on stderr, so neither the user nor a log
could tell them apart.
"""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
from typing import Any

import pytest

ENTRY = Path(__file__).resolve().parents[2] / "plugins" / "navide-plans" / "backend" / "plans_backend.py"
_spec = importlib.util.spec_from_file_location("plans_backend_error_reasons", ENTRY)
assert _spec and _spec.loader
plans_backend = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(plans_backend)


def _workspace(tmp_path: Path) -> Path:
    root = tmp_path / "ws"
    (root / ".agent-team" / "plans").mkdir(parents=True)
    return root


def _origin(root: Path) -> dict[str, Any]:
    return {"root": str(root.resolve())}


def _code(call: Any) -> str:
    with pytest.raises(plans_backend.BridgeFailure) as raised:
        call()
    return raised.value.code


# ── M2: refused paths, OS errors and oversized writes keep their reason ─────


def test_a_refused_path_is_not_reported_as_a_missing_file(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    root = _workspace(tmp_path)
    outside = tmp_path / "outside.html"
    outside.write_text("secret", encoding="utf-8")
    os.symlink(outside, root / ".agent-team" / "plans" / "leak_aaaaaa.html")
    origin = _origin(root)

    missing = _code(lambda: plans_backend._read_text(origin, ".agent-team/plans/missing_bbbbbb.html"))
    refused = _code(lambda: plans_backend._read_text(origin, ".agent-team/plans/leak_aaaaaa.html"))

    assert missing == "BACKEND_UNAVAILABLE"
    assert refused == "WORKSPACE_SCOPE_VIOLATION"
    err = capsys.readouterr().err
    assert ".agent-team/plans/leak_aaaaaa.html" in err and "escapes workspace" in err


def test_an_os_error_on_read_is_logged_with_its_reason(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    root = _workspace(tmp_path)
    target = root / ".agent-team" / "plans" / "locked_cccccc.html"
    target.write_text("x", encoding="utf-8")
    target.chmod(0)
    try:
        if os.access(target, os.R_OK):
            pytest.skip("running with privileges that ignore file modes")
        code = _code(lambda: plans_backend._read_text(_origin(root), ".agent-team/plans/locked_cccccc.html"))
    finally:
        target.chmod(0o644)
    assert code == "BACKEND_UNAVAILABLE"
    err = capsys.readouterr().err
    assert ".agent-team/plans/locked_cccccc.html" in err and "Permission denied" in err


def test_a_document_that_is_not_utf8_is_logged(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    root = _workspace(tmp_path)
    (root / ".agent-team" / "plans" / "latin_dddddd.html").write_bytes(b"\xff\xfe broken")
    code = _code(lambda: plans_backend._read_text(_origin(root), ".agent-team/plans/latin_dddddd.html"))
    assert code == "BACKEND_UNAVAILABLE"
    err = capsys.readouterr().err
    assert ".agent-team/plans/latin_dddddd.html" in err and "utf-8" in err.lower()


def test_a_missing_file_stays_quiet(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    # plans.create probes for a free name this way; every miss must not log.
    root = _workspace(tmp_path)
    _code(lambda: plans_backend._read_text(_origin(root), ".agent-team/plans/missing_eeeeee.html"))
    assert capsys.readouterr().err == ""


@pytest.mark.parametrize("rel_path", [".git/docs/plans/a.html", ".agent-team/state/docs/plans/a.html"])
def test_a_write_the_guard_refuses_is_a_scope_violation(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], rel_path: str
) -> None:
    root = _workspace(tmp_path)
    (root / ".git").mkdir()
    code = _code(lambda: plans_backend._write(_origin(root), rel_path, "<html></html>"))
    assert code == "WORKSPACE_SCOPE_VIOLATION"
    assert not (root / rel_path).exists()
    assert rel_path in capsys.readouterr().err


def test_a_write_failure_is_classified_without_matching_its_message(capsys: pytest.CaptureFixture[str]) -> None:
    # Neither a message that says "too large" nor the size of the content
    # makes a failure a resource limit: Plans writes have no size cap.
    for error in ("part too large", "content too large (51200 KB; limit 50 MB)"):
        failure = plans_backend._write_failure({"ok": False, "error": error}, rel_path=".agent-team/plans/a.html")
        assert failure.code == "BACKEND_UNAVAILABLE"
    conflict = plans_backend._write_failure({"ok": False, "conflict": True}, rel_path="x")
    assert conflict.code == "CONFLICT"
    err = capsys.readouterr().err
    assert "part too large" in err and "content too large" in err


def _cap_write_limit(monkeypatch: pytest.MonkeyPatch, limit: int) -> None:
    # Stand in for a document past the 50 MB write limit without writing one.
    from agent_team_backend import fs_write

    monkeypatch.setattr(fs_write, "_WRITE_SIZE_LIMIT", limit)
    monkeypatch.setattr(plans_backend, "_WRITE_SIZE_LIMIT", limit, raising=False)


def test_a_staged_write_past_the_size_limit_that_fails_is_not_a_resource_limit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    root = _workspace(tmp_path)
    _cap_write_limit(monkeypatch, 1024)
    monkeypatch.setattr(
        plans_backend, "write_part", lambda *args, **kwargs: {"ok": False, "error": "[Errno 28] No space left on device"}
    )
    monkeypatch.setattr(plans_backend, "write_abort", lambda *args, **kwargs: {"ok": True})
    content = "x" * (plans_backend.SINGLE_WRITE_MAX_BYTES + 1)
    code = _code(lambda: plans_backend._write(_origin(root), ".agent-team/plans/big_aaaaaa.html", content))
    assert code == "BACKEND_UNAVAILABLE"
    assert "No space left on device" in capsys.readouterr().err


def test_a_write_past_the_size_limit_is_staged_not_refused(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = _workspace(tmp_path)
    _cap_write_limit(monkeypatch, 1024)
    content = "y" * (plans_backend.SINGLE_WRITE_MAX_BYTES + 1)
    plans_backend._write(_origin(root), ".agent-team/plans/big_bbbbbb.html", content)
    assert (root / ".agent-team" / "plans" / "big_bbbbbb.html").read_text(encoding="utf-8") == content


# ── M3: a plan directory that cannot be read is reported, not dropped ───────


def _listed(root: Path) -> dict[str, dict[str, Any]]:
    return {entry["rel_path"]: entry for entry in plans_backend._list_plans(_origin(root))}


def _skip_if_modes_ignored(path: Path) -> None:
    if os.access(path, os.R_OK):
        pytest.skip("running with privileges that ignore file modes")


def test_a_plan_directory_that_cannot_be_listed_is_reported(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    root = _workspace(tmp_path)
    plans = root / ".agent-team" / "plans"
    (plans / "hidden_aaaaaa.html").write_text("<html></html>", encoding="utf-8")
    (root / "docs" / "plans").mkdir(parents=True)
    (root / "docs" / "plans" / "kept_bbbbbb.html").write_text("<html></html>", encoding="utf-8")
    plans.chmod(0)
    try:
        _skip_if_modes_ignored(plans)
        listed = _listed(root)
    finally:
        plans.chmod(0o755)
    entry = listed[".agent-team/plans"]
    assert entry["kind"] == "unreadable"
    assert entry["meta"] is None and entry["stage"] is None
    assert "BACKEND_UNAVAILABLE" in entry["reason"]
    assert listed["docs/plans/kept_bbbbbb.html"]["kind"] == "document"
    err = capsys.readouterr().err
    assert ".agent-team/plans" in err and "Permission denied" in err


def test_a_plan_directory_that_cannot_be_stat_is_reported(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    root = _workspace(tmp_path)
    parent = root / ".agent-team"
    parent.chmod(0)
    try:
        _skip_if_modes_ignored(parent)
        listed = _listed(root)
    finally:
        parent.chmod(0o755)
    assert listed[".agent-team/plans"]["kind"] == "unreadable"
    err = capsys.readouterr().err
    assert ".agent-team/plans" in err and "Permission denied" in err


def test_a_missing_plan_directory_stays_quiet(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    root = _workspace(tmp_path)
    assert _listed(root) == {}
    assert capsys.readouterr().err == ""


def test_a_plan_directory_the_guard_refuses_is_logged_not_listed(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    root = _workspace(tmp_path)
    outside = tmp_path / "outside-plans"
    outside.mkdir()
    (outside / "secret_cccccc.html").write_text("<html></html>", encoding="utf-8")
    (root / "docs").mkdir()
    os.symlink(outside, root / "docs" / "plans")
    assert _listed(root) == {}
    assert "docs/plans" in capsys.readouterr().err


def test_hidden_entries_do_not_use_up_the_listing_cap(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = _workspace(tmp_path)
    plans = root / ".agent-team" / "plans"
    for name in (".a", ".b", ".c", "x_111111.html", "y_222222.html"):
        (plans / name).write_text("", encoding="utf-8")
    monkeypatch.setattr(plans_backend, "_MAX_DIRECTORY_ENTRIES", 3)
    assert plans_backend._list_names(_origin(root), ".agent-team/plans") == ["x_111111.html", "y_222222.html"]


def test_a_truncated_listing_is_logged(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    root = _workspace(tmp_path)
    plans = root / ".agent-team" / "plans"
    for index in range(5):
        (plans / f"p{index}_aaaaaa.html").write_text("", encoding="utf-8")
    monkeypatch.setattr(plans_backend, "_MAX_DIRECTORY_ENTRIES", 3)
    assert len(plans_backend._list_names(_origin(root), ".agent-team/plans")) == 3
    err = capsys.readouterr().err
    assert ".agent-team/plans" in err and "5" in err and "3" in err

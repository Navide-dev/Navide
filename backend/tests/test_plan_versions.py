"""Plan versions: recording, merging, attribution, the tolerant index and retention."""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

import pytest

from agent_team_backend import plan_versions

BACKEND_ROOT = Path(__file__).resolve().parents[1]
T0 = datetime(2026, 10, 30, 12, 0, 0).astimezone()
USER = {"kind": "user"}
AGENT = {"kind": "agent"}
EXTERNAL = {"kind": "external"}


def _plan(tmp_path: Path, name: str = "p_aaaaaa.html") -> Path:
    plans = tmp_path / ".agent-team" / "plans"
    plans.mkdir(parents=True, exist_ok=True)
    plan = plans / name
    plan.write_text("current", encoding="utf-8")
    return plan


def _record(plan: Path, data: bytes, *, at: datetime, author=USER, reason="save", stage="draft", **extra):
    return plan_versions.record_version(plan, data, stage=stage, author=author, reason=reason, now=at, **extra)


def _versions(plan: Path) -> list[dict]:
    return plan_versions.list_versions(plan_versions.history_dir_for(plan))


def test_the_write_path_bundle_stays_standard_library_only() -> None:
    script = (
        "import sys\n"
        "before = set(sys.modules)\n"
        "import agent_team_backend.plan_versions\n"
        "added = set(sys.modules) - before\n"
        "print(sorted(m for m in added if m.startswith('agent_team_backend')))\n"
        "print(sorted({m.split('.')[0] for m in added} - set(sys.stdlib_module_names) - {'agent_team_backend'}))\n"
    )
    result = subprocess.run([sys.executable, "-c", script], cwd=BACKEND_ROOT, capture_output=True, text=True, check=True)
    loaded, third = result.stdout.splitlines()
    assert loaded == str([
        "agent_team_backend", "agent_team_backend.fs_write", "agent_team_backend.git_security",
        "agent_team_backend.path_guard", "agent_team_backend.plan_versions",
    ])
    assert third == "[]"


def test_the_first_version_is_a_baseline_and_same_bytes_are_stored_once(tmp_path: Path) -> None:
    plan = _plan(tmp_path)
    first = _record(plan, b"v1", at=T0)
    assert first == "20261030T120000_draft.html"
    assert _record(plan, b"v1", at=T0 + timedelta(minutes=1)) is None
    [version] = _versions(plan)
    assert version["entry"]["reason"] == "stage"
    assert version["entry"]["sha256"] == hashlib.sha256(b"v1").hexdigest()
    assert (plan_versions.history_dir_for(plan) / first).read_bytes() == b"v1"


def test_saves_of_one_author_within_ten_minutes_fold_into_one_version(tmp_path: Path) -> None:
    plan = _plan(tmp_path)
    _record(plan, b"base", at=T0)
    second = _record(plan, b"a", at=T0 + timedelta(minutes=1))
    assert _record(plan, b"ab", at=T0 + timedelta(minutes=5)) == second
    assert (plan_versions.history_dir_for(plan) / second).read_bytes() == b"ab"
    # Another author, or past the window, starts a new version.
    agent = _record(plan, b"abc", at=T0 + timedelta(minutes=6), author=AGENT)
    assert agent not in {second, None}
    late = _record(plan, b"abcd", at=T0 + timedelta(minutes=20), author=AGENT)
    assert late not in {agent, None}
    assert len(_versions(plan)) == 4


def test_a_stage_change_is_its_own_permanent_version(tmp_path: Path) -> None:
    plan = _plan(tmp_path)
    _record(plan, b"base", at=T0)
    save = _record(plan, b"edit", at=T0 + timedelta(minutes=1))
    approved = _record(plan, b"approved", at=T0 + timedelta(minutes=2), stage="approved")
    assert approved not in {save, None} and approved.endswith("_approved.html")
    assert _versions(plan)[0]["entry"]["reason"] == "stage"


def test_consecutive_outside_changes_fold_into_one_version(tmp_path: Path) -> None:
    plan = _plan(tmp_path)
    _record(plan, b"base", at=T0)
    first = _record(plan, b"edit 1", at=T0 + timedelta(minutes=1), author=EXTERNAL, reason="external")
    assert _record(plan, b"edit 2", at=T0 + timedelta(minutes=4), author=EXTERNAL, reason="external") == first
    assert _record(plan, b"edit 3", at=T0 + timedelta(minutes=9), author=EXTERNAL, reason="external") == first
    assert (plan_versions.history_dir_for(plan) / first).read_bytes() == b"edit 3"
    # Past the window from the version's last change, a new one starts.
    later = _record(plan, b"edit 4", at=T0 + timedelta(minutes=20), author=EXTERNAL, reason="external")
    assert later not in {first, None}
    assert len(_versions(plan)) == 3


def test_a_named_write_between_outside_changes_keeps_both_sides(tmp_path: Path) -> None:
    plan = _plan(tmp_path)
    _record(plan, b"base", at=T0)
    before = _record(plan, b"agent edit", at=T0 + timedelta(minutes=1), author=EXTERNAL, reason="external")
    mine = _record(plan, b"user save", at=T0 + timedelta(minutes=2))
    after = _record(plan, b"agent edit 2", at=T0 + timedelta(minutes=3), author=EXTERNAL, reason="external")
    assert len({before, mine, after}) == 3
    history = plan_versions.history_dir_for(plan)
    assert (history / before).read_bytes() == b"agent edit"
    assert (history / mine).read_bytes() == b"user save"
    assert (history / after).read_bytes() == b"agent edit 2"


def test_an_announced_write_the_watcher_sees_first_is_recorded_as_its_author(tmp_path: Path) -> None:
    plan = _plan(tmp_path)
    _record(plan, b"base", at=T0)
    outside = _record(plan, b"agent edit", at=T0 + timedelta(minutes=1), author=EXTERNAL, reason="external")
    # The Plans backend announces the user's save, then the watcher wins the
    # race and records it: it must not fold it into the outside version.
    plan_versions.announce_write(plan, b"user save", author=USER, reason="save", now=T0 + timedelta(minutes=2))
    seen = _record(plan, b"user save", at=T0 + timedelta(minutes=2, seconds=1), author=EXTERNAL, reason="external")
    assert seen != outside
    history = plan_versions.history_dir_for(plan)
    assert (history / outside).read_bytes() == b"agent edit"
    entry = plan_versions.read_index(history)[seen]
    assert entry["author"] == USER and entry["reason"] == "save"
    # The writer's own record afterwards adds nothing.
    assert _record(plan, b"user save", at=T0 + timedelta(minutes=2, seconds=2)) is None
    # An announcement older than a minute no longer applies.
    plan_versions.announce_write(plan, b"stale", author=AGENT, reason="save", now=T0 + timedelta(minutes=3))
    late = _record(plan, b"stale", at=T0 + timedelta(minutes=5), author=EXTERNAL, reason="external")
    assert plan_versions.read_index(history)[late]["author"] == EXTERNAL


def test_outside_changes_never_fold_into_a_stage_or_pinned_version(tmp_path: Path) -> None:
    plan = _plan(tmp_path)
    baseline = _record(plan, b"base", at=T0, author=EXTERNAL, reason="external")
    assert plan_versions.read_index(plan_versions.history_dir_for(plan))[baseline]["reason"] == "stage"
    edit = _record(plan, b"edit", at=T0 + timedelta(minutes=1), author=EXTERNAL, reason="external")
    assert edit != baseline
    assert _record(plan, b"edit", at=T0 + timedelta(minutes=2), reason="conflict") == edit
    after = _record(plan, b"edit 2", at=T0 + timedelta(minutes=3), author=EXTERNAL, reason="external")
    assert after != edit
    assert (plan_versions.history_dir_for(plan) / edit).read_bytes() == b"edit"


def test_a_pinned_conflict_side_is_never_folded_into(tmp_path: Path) -> None:
    plan = _plan(tmp_path)
    _record(plan, b"base", at=T0)
    theirs = _record(plan, b"theirs", at=T0 + timedelta(minutes=1), author=AGENT)
    assert _record(plan, b"theirs", at=T0 + timedelta(minutes=2), reason="conflict") == theirs
    after = _record(plan, b"theirs+more", at=T0 + timedelta(minutes=3), author=AGENT)
    assert after != theirs
    assert (plan_versions.history_dir_for(plan) / theirs).read_bytes() == b"theirs"


def test_a_detached_version_is_kept_but_never_compared_against(tmp_path: Path) -> None:
    plan = _plan(tmp_path)
    _record(plan, b"disk", at=T0)
    mine = _record(plan, b"mine", at=T0 + timedelta(minutes=1), reason="conflict", detached=True)
    assert mine is not None
    # The disk bytes are still the newest attached version: no duplicate.
    assert _record(plan, b"disk", at=T0 + timedelta(minutes=2), author=EXTERNAL, reason="external") is None
    entries = {v["file"]: v["entry"] for v in _versions(plan)}
    assert entries[mine]["detached"] is True and entries[mine]["reason"] == "conflict"


def test_a_broken_index_line_is_skipped_and_reported_not_fatal(tmp_path: Path) -> None:
    plan = _plan(tmp_path)
    _record(plan, b"base", at=T0)
    second = _record(plan, b"two", at=T0 + timedelta(minutes=11))
    index = plan_versions.history_dir_for(plan) / plan_versions.INDEX_NAME
    with index.open("ab") as handle:
        handle.write(b"{not json\n")
        handle.write(json.dumps({"file": "../../p_aaaaaa.html", "reason": "save"}).encode() + b"\n")
        handle.write(b"\xff\xfe\n")
    warnings: list[str] = []
    entries = plan_versions.read_index(index.parent, warnings.append)
    assert second in entries and len(entries) == 2
    assert len(warnings) == 3
    assert [v["file"] for v in plan_versions.list_versions(index.parent)][0] == second
    # Recording still works on top of the broken lines.
    assert _record(plan, b"three", at=T0 + timedelta(minutes=30)) is not None


def test_retention_keeps_30_days_then_50_and_stage_snapshots_forever(tmp_path: Path) -> None:
    plan = _plan(tmp_path)
    history = plan_versions.history_dir_for(plan)
    history.mkdir(parents=True)
    old = T0 - timedelta(days=100)
    lines = []
    for i in range(70):  # 70 old saves, a minute apart
        when = old + timedelta(minutes=i)
        name = f"{when.strftime('%Y%m%dT%H%M%S')}_draft.html"
        (history / name).write_bytes(b"old")
        lines.append({"file": name, "ts": when.isoformat(), "sha256": "x", "stage": "draft",
                      "author": USER, "reason": "save"})
    stage_snapshot = f"{(old - timedelta(days=1)).strftime('%Y%m%dT%H%M%S')}_approved.html"
    (history / stage_snapshot).write_bytes(b"approved")
    legacy = "20000101T000000_draft.html"  # an older snapshot with no entry
    (history / legacy).write_bytes(b"legacy")
    (history / plan_versions.INDEX_NAME).write_text(
        "\n".join(json.dumps(line) for line in lines) + "\n"
        + json.dumps({"file": stage_snapshot, "ts": (old - timedelta(days=1)).isoformat(), "sha256": "y",
                      "stage": "approved", "author": USER, "reason": "stage"}) + "\n",
        encoding="utf-8",
    )
    recent = [_record(plan, f"recent {i}".encode(), at=T0 - timedelta(days=29) + timedelta(minutes=11 * i)) for i in range(3)]
    names = {v["file"] for v in _versions(plan)}
    assert stage_snapshot in names and legacy in names
    assert all(name in names for name in recent)
    kept_old = sorted(name for name in names if name.startswith(old.strftime("%Y%m%d")))
    assert len(kept_old) == 50
    # The newest 50 of the old saves survive.
    assert kept_old == sorted(line["file"] for line in lines)[-50:]
    # The plan itself is never touched.
    assert plan.read_text(encoding="utf-8") == "current"


@pytest.mark.skipif(sys.platform == "win32", reason="creating symbolic links needs a privilege on Windows")
def test_a_history_directory_leaving_the_plans_dir_is_refused(tmp_path: Path) -> None:
    plan = _plan(tmp_path)
    outside = tmp_path / "outside"
    outside.mkdir()
    (plan.parent / plan_versions.HISTORY_DIR_NAME).symlink_to(outside, target_is_directory=True)
    warnings: list[str] = []
    assert _record(plan, b"v1", at=T0, warn=warnings.append) is None
    assert list(outside.iterdir()) == []
    assert warnings


@pytest.mark.skipif(sys.platform == "win32", reason="creating symbolic links needs a privilege on Windows")
def test_retention_never_follows_a_symlinked_snapshot(tmp_path: Path) -> None:
    plan = _plan(tmp_path)
    _record(plan, b"base", at=T0)
    history = plan_versions.history_dir_for(plan)
    victim = tmp_path / "victim.html"
    victim.write_text("keep me", encoding="utf-8")
    (history / "19990101T000000_draft.html").symlink_to(victim)
    plan_versions.prune_history(history, now=T0 + timedelta(days=400))
    assert victim.read_text(encoding="utf-8") == "keep me"

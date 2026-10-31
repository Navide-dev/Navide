"""Plan versions: recording, merging, attribution, the tolerant index and retention."""

from __future__ import annotations

import gzip
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
    assert first == "20261030T120000_draft.html.gz"
    assert _record(plan, b"v1", at=T0 + timedelta(minutes=1)) is None
    [version] = _versions(plan)
    assert version["entry"]["reason"] == "stage"
    assert version["entry"]["sha256"] == hashlib.sha256(b"v1").hexdigest()
    assert plan_versions.read_version(plan_versions.history_dir_for(plan), first) == b"v1"


def test_saves_of_one_author_within_ten_minutes_fold_into_one_version(tmp_path: Path) -> None:
    plan = _plan(tmp_path)
    _record(plan, b"base", at=T0)
    second = _record(plan, b"a", at=T0 + timedelta(minutes=1))
    assert _record(plan, b"ab", at=T0 + timedelta(minutes=5)) == second
    assert plan_versions.read_version(plan_versions.history_dir_for(plan), second) == b"ab"
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
    assert approved not in {save, None} and approved.endswith("_approved.html.gz")
    assert _versions(plan)[0]["entry"]["reason"] == "stage"


def test_consecutive_outside_changes_fold_into_one_version(tmp_path: Path) -> None:
    plan = _plan(tmp_path)
    _record(plan, b"base", at=T0)
    first = _record(plan, b"edit 1", at=T0 + timedelta(minutes=1), author=EXTERNAL, reason="external")
    assert _record(plan, b"edit 2", at=T0 + timedelta(minutes=4), author=EXTERNAL, reason="external") == first
    assert _record(plan, b"edit 3", at=T0 + timedelta(minutes=9), author=EXTERNAL, reason="external") == first
    assert plan_versions.read_version(plan_versions.history_dir_for(plan), first) == b"edit 3"
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
    assert plan_versions.read_version(history, before) == b"agent edit"
    assert plan_versions.read_version(history, mine) == b"user save"
    assert plan_versions.read_version(history, after) == b"agent edit 2"


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
    assert plan_versions.read_version(history, outside) == b"agent edit"
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
    assert plan_versions.read_version(plan_versions.history_dir_for(plan), edit) == b"edit"


def test_a_pinned_conflict_side_is_never_folded_into(tmp_path: Path) -> None:
    plan = _plan(tmp_path)
    _record(plan, b"base", at=T0)
    theirs = _record(plan, b"theirs", at=T0 + timedelta(minutes=1), author=AGENT)
    assert _record(plan, b"theirs", at=T0 + timedelta(minutes=2), reason="conflict") == theirs
    after = _record(plan, b"theirs+more", at=T0 + timedelta(minutes=3), author=AGENT)
    assert after != theirs
    assert plan_versions.read_version(plan_versions.history_dir_for(plan), theirs) == b"theirs"


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


def test_a_compressed_version_round_trips_byte_for_byte(tmp_path: Path) -> None:
    plan = _plan(tmp_path)
    data = ("<p>Plan ✓ 計畫</p>\r\n" * 2000).encode("utf-8") + bytes(range(256))
    name = _record(plan, data, at=T0)
    history = plan_versions.history_dir_for(plan)
    stored = (history / name).read_bytes()
    assert name.endswith(".html.gz") and stored[:2] == b"\x1f\x8b" and len(stored) < len(data)
    assert gzip.decompress(stored) == data
    assert plan_versions.read_version(history, name) == data
    # The hash is of the plan bytes, never of the compressed file.
    assert plan_versions.read_index(history)[name]["sha256"] == hashlib.sha256(data).hexdigest()
    assert _record(plan, data, at=T0 + timedelta(minutes=1)) is None


def test_older_uncompressed_snapshots_mix_with_compressed_versions(tmp_path: Path) -> None:
    plan = _plan(tmp_path)
    history = plan_versions.history_dir_for(plan)
    history.mkdir(parents=True)
    legacy = "20261001T090000_approved.html"
    (history / legacy).write_bytes(b"approved before")
    legacy_bytes = (history / legacy).read_bytes()
    # Same bytes as the older snapshot: recognised by the uncompressed hash.
    assert _record(plan, b"approved before", at=T0, stage="approved") is None
    newer = _record(plan, b"edit", at=T0 + timedelta(minutes=1), stage="approved")
    assert newer.endswith(".html.gz")
    names = [v["file"] for v in plan_versions.list_versions(history)]
    assert names == [newer, legacy]
    assert plan_versions.read_version(history, legacy) == b"approved before"
    assert plan_versions.read_version(history, newer) == b"edit"
    # A same-second name never collides across the two forms.
    (history / "20261030T120500_approved.html").write_bytes(b"old same second")
    other = _record(plan, b"later", at=T0 + timedelta(minutes=5), stage="approved", author=AGENT)
    assert other == "20261030T120501_approved.html.gz"
    # Retention keeps the older snapshot (a stage snapshot) and never rewrites it.
    plan_versions.prune_history(history, now=T0 + timedelta(days=400))
    assert (history / legacy).read_bytes() == legacy_bytes
    assert legacy in {v["file"] for v in plan_versions.list_versions(history)}
    # An older uncompressed save is never folded into: a new compressed one is written.
    with (history / plan_versions.INDEX_NAME).open("a", encoding="utf-8") as handle:
        handle.write(json.dumps({"file": "20261030T120600_approved.html", "ts": (T0 + timedelta(minutes=6)).isoformat(),
                                 "sha256": "x", "stage": "approved", "author": USER, "reason": "save"}) + "\n")
    (history / "20261030T120600_approved.html").write_bytes(b"plain save")
    folded = _record(plan, b"plain save 2", at=T0 + timedelta(minutes=7), stage="approved")
    assert folded.endswith(".gz")
    assert (history / "20261030T120600_approved.html").read_bytes() == b"plain save"


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


# Embedded images (PR6): large base64 data: URIs are stored once, as blobs.

def _png(seed: int, size: int = 3000) -> bytes:
    return bytes((seed * 31 + i * 7) % 256 for i in range(size))


def _img(payload: bytes, mime: bytes = b"image/png") -> bytes:
    return b'<img src="data:' + mime + b";base64," + payload + b'">'


def _with_images(text: bytes, *images: bytes, raw: bytes = b"") -> bytes:
    """A plan embedding each of ``images`` base64-encoded, then ``raw`` as is."""
    import base64

    embedded = b"".join(_img(base64.b64encode(image)) for image in images) + raw
    return b"<!doctype html><html><body><p>" + text + b"</p>" + embedded + b"</body></html>\n"


def _blobs(plan: Path) -> set[str]:
    blobs = plan_versions.history_dir_for(plan) / plan_versions.BLOBS_DIR_NAME
    return {child.name for child in blobs.iterdir()} if blobs.is_dir() else set()


def test_embedded_images_round_trip_byte_for_byte_from_blobs(tmp_path: Path) -> None:
    import base64

    plan = _plan(tmp_path)
    icon = base64.b64encode(b"tiny")  # shorter than BLOB_MIN_LENGTH: stays in the text
    # Not valid base64 (bad padding): kept as its text, still restored exactly.
    unpadded = _img(b"A" * 1501)
    data = _with_images(b"Text", _png(1), _png(2), raw=_img(icon) + unpadded)
    name = _record(plan, data, at=T0)
    assert name is not None and name.endswith(".html.parts.gz")
    history = plan_versions.history_dir_for(plan)
    assert plan_versions.read_version(history, name) == data
    assert len(_blobs(plan)) == 3
    # The version file itself holds the text, not the images.
    assert len((history / name).read_bytes()) < 1000
    stored = {(history / "blobs" / blob).read_bytes() for blob in _blobs(plan)}
    assert _png(1) in stored and _png(2) in stored and b"A" * 1501 in stored
    entry = _versions(plan)[0]["entry"]
    assert entry["sha256"] == hashlib.sha256(data).hexdigest()


def test_an_image_unchanged_across_versions_is_stored_once(tmp_path: Path) -> None:
    plan = _plan(tmp_path)
    for minute, text in enumerate((b"one", b"two", b"three")):
        stage = ("draft", "in-review", "approved")[minute]
        _record(plan, _with_images(text, _png(1)), at=T0 + timedelta(minutes=minute), stage=stage, reason="stage")
    assert len(_versions(plan)) == 3
    assert len(_blobs(plan)) == 1
    history = plan_versions.history_dir_for(plan)
    assert [plan_versions.read_version(history, v["file"]) for v in _versions(plan)] == [
        _with_images(text, _png(1)) for text in (b"three", b"two", b"one")
    ]


def test_a_plan_without_large_images_stays_a_plain_compressed_version(tmp_path: Path) -> None:
    plan = _plan(tmp_path)
    name = _record(plan, b"<p>no images</p>" + _img(b"aGk="), at=T0)
    assert name is not None and name.endswith(".html.gz") and not name.endswith(".parts.gz")
    assert _blobs(plan) == set()


def test_a_folded_save_drops_the_image_it_replaced_and_changes_form_when_needed(tmp_path: Path) -> None:
    plan = _plan(tmp_path)
    _record(plan, b"base", at=T0)
    first = _record(plan, _with_images(b"a", _png(1)), at=T0 + timedelta(minutes=1))
    second = _record(plan, _with_images(b"b", _png(2)), at=T0 + timedelta(minutes=2))
    assert first == second  # folded into the same version
    history = plan_versions.history_dir_for(plan)
    assert plan_versions.read_version(history, second) == _with_images(b"b", _png(2))
    assert _blobs(plan) == {hashlib.sha256(_png(2)).hexdigest()}
    # The image removed: the folded version becomes a plain one and the blob goes.
    third = _record(plan, b"no image", at=T0 + timedelta(minutes=3))
    assert third == second.removesuffix(".parts.gz") + ".gz"
    assert not (history / second).exists()
    assert plan_versions.read_version(history, third) == b"no image"
    assert _blobs(plan) == set()


def test_retention_removes_only_blobs_no_remaining_version_refers_to(tmp_path: Path) -> None:
    plan = _plan(tmp_path)
    history = plan_versions.history_dir_for(plan)
    old = T0 - timedelta(days=200)
    _record(plan, _with_images(b"keep", _png(9)), at=old, stage="draft", reason="stage")
    # 51 old saves alternate authors so none fold; the oldest one has its own image.
    for i in range(51):
        payloads = (_png(9),) if i else (_png(9), _png(5))
        _record(plan, _with_images(b"save %d" % i, *payloads), at=old + timedelta(minutes=i + 1),
                author=(USER, AGENT)[i % 2])
    assert hashlib.sha256(_png(5)).hexdigest() in _blobs(plan)
    _record(plan, _with_images(b"now", _png(9)), at=T0, author=AGENT)
    assert _blobs(plan) == {hashlib.sha256(_png(9)).hexdigest()}
    for version in _versions(plan):
        plan_versions.read_version(history, version["file"])  # every kept version still reads


def test_all_three_forms_list_read_and_prune_together(tmp_path: Path) -> None:
    plan = _plan(tmp_path)
    history = plan_versions.history_dir_for(plan)
    history.mkdir(parents=True)
    (history / "20260101T000000_draft.html").write_bytes(b"legacy")
    _record(plan, b"plain", at=T0, stage="in-review", reason="stage")
    _record(plan, _with_images(b"parts", _png(3)), at=T0 + timedelta(minutes=1), stage="approved", reason="stage")
    names = [version["file"] for version in _versions(plan)]
    assert [name.split("_", 1)[1] for name in names] == ["approved.html.parts.gz", "in-review.html.gz", "draft.html"]
    assert [plan_versions.read_version(history, name) for name in names] == [
        _with_images(b"parts", _png(3)), b"plain", b"legacy",
    ]
    # A blob a crash left behind is cleared by the full sweep; used ones stay.
    orphan = hashlib.sha256(b"orphan").hexdigest()
    (history / "blobs" / orphan).write_bytes(b"orphan")
    plan_versions.prune_history(history, now=T0 + timedelta(minutes=2))
    assert _blobs(plan) == {hashlib.sha256(_png(3)).hexdigest()}
    assert [plan_versions.read_version(history, name) for name in names][0] == _with_images(b"parts", _png(3))


def test_a_damaged_or_missing_blob_fails_the_read_and_an_unreadable_version_keeps_all_blobs(tmp_path: Path) -> None:
    plan = _plan(tmp_path)
    history = plan_versions.history_dir_for(plan)
    name = _record(plan, _with_images(b"x", _png(4)), at=T0, stage="draft", reason="stage")
    blob = history / "blobs" / hashlib.sha256(_png(4)).hexdigest()
    blob.write_bytes(b"tampered")
    with pytest.raises(ValueError):
        plan_versions.read_version(history, name)
    blob.unlink()
    with pytest.raises(OSError):
        plan_versions.read_version(history, name)
    # A later save stores the image again; a corrupt parts file then stops any sweep.
    _record(plan, _with_images(b"y", _png(4)), at=T0 + timedelta(minutes=1), stage="in-review", reason="stage")
    (history / name).write_bytes(gzip.compress(b"navide-plan-parts 1\nZbroken\n"))
    orphan = hashlib.sha256(b"orphan").hexdigest()
    (history / "blobs" / orphan).write_bytes(b"orphan")
    warnings: list[str] = []
    plan_versions.prune_history(history, now=T0 + timedelta(minutes=2), warn=warnings.append)
    assert orphan in _blobs(plan) and any("no image blob removed" in w for w in warnings)


@pytest.mark.skipif(sys.platform == "win32", reason="creating symbolic links needs a privilege on Windows")
def test_a_symlinked_blobs_directory_is_never_written_through(tmp_path: Path) -> None:
    plan = _plan(tmp_path)
    history = plan_versions.history_dir_for(plan)
    history.mkdir(parents=True)
    outside = tmp_path / "outside"
    outside.mkdir()
    (history / "blobs").symlink_to(outside, target_is_directory=True)
    data = _with_images(b"x", _png(6))
    name = _record(plan, data, at=T0)
    assert name is not None and name.endswith(".html.gz") and not name.endswith(".parts.gz")
    assert list(outside.iterdir()) == []
    assert plan_versions.read_version(history, name) == data


def test_decoding_is_bounded_and_never_returns_a_cut_version() -> None:
    packed = gzip.compress(b"a" * 5_000, mtime=0)
    name = "20261030T120000_draft.html.gz"
    assert plan_versions.decode_version(Path("."), name, packed, limit=5_000) == b"a" * 5_000
    with pytest.raises(plan_versions.VersionTooLarge):
        plan_versions.decode_version(Path("."), name, packed, limit=4_999)
    # Several gzip members read as one, as gzip.decompress does.
    two = gzip.compress(b"one ", mtime=0) + gzip.compress(b"two", mtime=0)
    assert plan_versions.decode_version(Path("."), name, two, limit=100) == b"one two"
    with pytest.raises(EOFError):
        plan_versions.decode_version(Path("."), name, packed[:-12], limit=10_000)
    # An uncompressed snapshot is returned as it is.
    assert plan_versions.decode_version(Path("."), "20261030T120000_draft.html", b"raw", limit=1) == b"raw"


def test_a_version_with_image_blobs_is_bounded_as_a_whole(tmp_path: Path) -> None:
    plan = _plan(tmp_path)
    data = _with_images(b"x", _png(7))
    name = _record(plan, data, at=T0)
    history = plan_versions.history_dir_for(plan)
    raw = (history / name).read_bytes()
    assert plan_versions.decode_version(history, name, raw, limit=len(data)) == data
    with pytest.raises(plan_versions.VersionTooLarge):
        plan_versions.decode_version(history, name, raw, limit=len(data) - 1)


def test_a_stored_blob_is_trusted_by_its_name_and_not_reread_on_save(tmp_path: Path) -> None:
    # Blobs are named by their hash and every read verifies it, so a save
    # only checks that the name exists.
    plan = _plan(tmp_path)
    _record(plan, _with_images(b"one", _png(8)), at=T0, stage="draft", reason="stage")
    blob = plan_versions.history_dir_for(plan) / "blobs" / hashlib.sha256(_png(8)).hexdigest()
    blob.write_bytes(b"tampered")
    inode = blob.stat().st_ino
    _record(plan, _with_images(b"two", _png(8)), at=T0 + timedelta(minutes=1), stage="in-review", reason="stage")
    assert blob.stat().st_ino == inode and blob.read_bytes() == b"tampered"


@pytest.mark.skipif(sys.platform == "win32", reason="creating symbolic links needs a privilege on Windows")
def test_the_sweep_never_follows_a_blobs_directory_swapped_for_a_link(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    plan = _plan(tmp_path)
    history = plan_versions.history_dir_for(plan)
    _record(plan, _with_images(b"x", _png(10)), at=T0, stage="draft", reason="stage")
    outside = tmp_path / "outside"
    outside.mkdir()
    victim = outside / hashlib.sha256(b"victim").hexdigest()
    victim.write_bytes(b"victim")
    # The directory is swapped for a link after any check by name has passed.
    real = history / "blobs"
    real.rename(history / "blobs-real")
    real.symlink_to(outside, target_is_directory=True)
    original = Path.is_symlink
    monkeypatch.setattr(Path, "is_symlink", lambda self: False if self.name == "blobs" else original(self))
    plan_versions.prune_history(history, now=T0 + timedelta(minutes=1))
    assert victim.exists()

"""plan_history: stage parsing + stage-transition snapshots + retention cap."""

from __future__ import annotations

import json
from pathlib import Path

from agent_team_backend import plan_history, plan_versions


def _meta_island(stage: str) -> str:
    meta = {
        "schemaVersion": 1,
        "name": "Test Plan",
        "overview": "",
        "stage": stage,
        "approvedAt": None,
        "todos": [],
        "reviewNotes": [],
    }
    return f'<script type="application/json" id="plan-meta">{json.dumps(meta)}</script>'


def _plan_html(stage: str) -> str:
    return f"<!doctype html><html><head>{_meta_island(stage)}</head><body>x</body></html>"


def _plan_md(stage: str | None) -> str:
    lines = ["---", "name: Test Plan", "overview: ''"]
    if stage is not None:
        lines.append(f"stage: {stage}")
    lines += ["todos: []", "reviewNotes: []", "---", "", "# Body", "x", ""]
    return "\n".join(lines)


def _plans_dir(ws: Path) -> Path:
    d = ws / ".agent-team" / "plans"
    d.mkdir(parents=True, exist_ok=True)
    return d


# ── parse_plan_stage ─────────────────────────────────────────────────────


def test_parse_stage_valid() -> None:
    assert plan_history.parse_plan_stage(_plan_html("approved")) == "approved"


def test_parse_stage_single_quoted_id() -> None:
    html = _plan_html("draft").replace('id="plan-meta"', "id='plan-meta'")
    assert plan_history.parse_plan_stage(html) == "draft"


def test_parse_stage_missing_island() -> None:
    assert plan_history.parse_plan_stage("<html><body>doc</body></html>") is None


def test_parse_stage_malformed_json() -> None:
    html = '<script type="application/json" id="plan-meta">{nope</script>'
    assert plan_history.parse_plan_stage(html) is None


def test_parse_stage_unknown_stage_value() -> None:
    assert plan_history.parse_plan_stage(_plan_html("shipped")) is None


# ── snapshot_plans ───────────────────────────────────────────────────────


def test_first_sight_creates_baseline_snapshot(tmp_path: Path) -> None:
    plans = _plans_dir(tmp_path)
    (plans / "my-plan_ab12cd.html").write_text(_plan_html("in-review"), encoding="utf-8")

    created = plan_history.snapshot_plans(str(tmp_path))

    assert len(created) == 1
    assert created[0].startswith(".agent-team/plans/.history/my-plan_ab12cd/")
    assert created[0].endswith("_in-review.html.gz")
    snap = tmp_path / created[0]
    assert plan_versions.read_version(snap.parent, snap.name).decode("utf-8") == _plan_html("in-review")


def test_unchanged_bytes_create_no_new_version(tmp_path: Path) -> None:
    plans = _plans_dir(tmp_path)
    (plans / "my-plan_ab12cd.html").write_text(_plan_html("draft"), encoding="utf-8")
    assert len(plan_history.snapshot_plans(str(tmp_path))) == 1
    assert plan_history.snapshot_plans(str(tmp_path)) == []


def test_a_content_edit_without_a_stage_change_is_an_external_version(tmp_path: Path) -> None:
    plans = _plans_dir(tmp_path)
    plan = plans / "my-plan_ab12cd.html"
    plan.write_text(_plan_html("draft"), encoding="utf-8")
    plan_history.snapshot_plans(str(tmp_path))
    # An agent edits the file directly (not through the plan tools).
    plan.write_text(_plan_html("draft").replace("body>x", "body>y"), encoding="utf-8")

    created = plan_history.snapshot_plans(str(tmp_path))

    assert len(created) == 1
    history = plans / ".history" / "my-plan_ab12cd"
    entries = plan_versions.read_index(history)
    newest = entries[created[0].rsplit("/", 1)[1]]
    assert newest["author"] == {"kind": "external"} and newest["reason"] == "external"
    snap = tmp_path / created[0]
    assert plan_versions.read_version(snap.parent, snap.name) == plan.read_bytes()


def test_stage_transition_creates_snapshot(tmp_path: Path) -> None:
    plans = _plans_dir(tmp_path)
    plan = plans / "my-plan_ab12cd.html"
    plan.write_text(_plan_html("in-review"), encoding="utf-8")
    plan_history.snapshot_plans(str(tmp_path))
    plan.write_text(_plan_html("approved"), encoding="utf-8")

    created = plan_history.snapshot_plans(str(tmp_path))

    assert len(created) == 1
    assert created[0].endswith("_approved.html.gz")
    history = plans / ".history" / "my-plan_ab12cd"
    assert len(plan_versions.list_versions(history)) == 2


def test_infra_hidden_and_metaless_files_skipped(tmp_path: Path) -> None:
    plans = _plans_dir(tmp_path)
    (plans / "_template.html").write_text(_plan_html("draft"), encoding="utf-8")
    (plans / ".hidden.html").write_text(_plan_html("draft"), encoding="utf-8")
    (plans / "plain-doc_ab12cd.html").write_text("<html><body>no meta</body></html>", encoding="utf-8")

    assert plan_history.snapshot_plans(str(tmp_path)) == []
    assert not (plans / ".history").exists()


def test_older_stage_snapshots_are_kept_forever(tmp_path: Path) -> None:
    plans = _plans_dir(tmp_path)
    plan = plans / "my-plan_ab12cd.html"
    plan.write_text(_plan_html("approved"), encoding="utf-8")
    history = plans / ".history" / "my-plan_ab12cd"
    history.mkdir(parents=True)
    # 25 snapshots from before versions had an index: stage snapshots, all old.
    for i in range(25):
        (history / f"20000101T0000{i:02d}_draft.html").write_text("old", encoding="utf-8")

    created = plan_history.snapshot_plans(str(tmp_path))

    assert len(created) == 1
    remaining = sorted(p.name for p in history.glob("*.html*"))
    # Nothing was pruned (the former 20-snapshot cap is gone); the newest
    # entry is the fresh stage version.
    assert len(remaining) == 26
    assert remaining[-1].endswith("_approved.html.gz")


def test_missing_plans_dir_is_noop(tmp_path: Path) -> None:
    assert plan_history.snapshot_plans(str(tmp_path)) == []


# ── parse_plan_stage_md ──────────────────────────────────────────────────


def test_parse_stage_md_valid() -> None:
    assert plan_history.parse_plan_stage_md(_plan_md("approved")) == "approved"


def test_parse_stage_md_quoted_value() -> None:
    md = _plan_md("draft").replace("stage: draft", 'stage: "in-review"')
    assert plan_history.parse_plan_stage_md(md) == "in-review"


def test_parse_stage_md_no_frontmatter() -> None:
    assert plan_history.parse_plan_stage_md("# Just markdown\n\nno frontmatter") is None


def test_parse_stage_md_missing_stage_key() -> None:
    assert plan_history.parse_plan_stage_md(_plan_md(None)) is None


def test_parse_stage_md_unknown_stage_value() -> None:
    assert plan_history.parse_plan_stage_md(_plan_md("shipped")) is None


def test_parse_stage_md_ignores_indented_stage() -> None:
    # A nested (indented) `stage:` must not be mistaken for the document stage.
    md = "\n".join(["---", "name: T", "meta:", "  stage: approved", "---", "", "body"])
    assert plan_history.parse_plan_stage_md(md) is None


# ── snapshot_plans: markdown (.plan.md) ──────────────────────────────────


def test_md_first_sight_creates_baseline_snapshot(tmp_path: Path) -> None:
    plans = _plans_dir(tmp_path)
    (plans / "my-plan_ab12cd.plan.md").write_text(_plan_md("in-review"), encoding="utf-8")

    created = plan_history.snapshot_plans(str(tmp_path))

    assert len(created) == 1
    assert created[0].startswith(".agent-team/plans/.history/my-plan_ab12cd/")
    assert created[0].endswith("_in-review.plan.md.gz")
    snap = tmp_path / created[0]
    assert plan_versions.read_version(snap.parent, snap.name).decode("utf-8") == _plan_md("in-review")


def test_md_stage_transition_creates_snapshot(tmp_path: Path) -> None:
    plans = _plans_dir(tmp_path)
    plan = plans / "my-plan_ab12cd.plan.md"
    plan.write_text(_plan_md("in-review"), encoding="utf-8")
    plan_history.snapshot_plans(str(tmp_path))
    plan.write_text(_plan_md("approved"), encoding="utf-8")

    created = plan_history.snapshot_plans(str(tmp_path))

    assert len(created) == 1
    assert created[0].endswith("_approved.plan.md.gz")
    history = plans / ".history" / "my-plan_ab12cd"
    assert len(plan_versions.list_versions(history)) == 2


def test_md_body_edit_is_a_version_and_unchanged_bytes_are_not(tmp_path: Path) -> None:
    plans = _plans_dir(tmp_path)
    plan = plans / "my-plan_ab12cd.plan.md"
    plan.write_text(_plan_md("draft"), encoding="utf-8")
    assert len(plan_history.snapshot_plans(str(tmp_path))) == 1
    assert plan_history.snapshot_plans(str(tmp_path)) == []
    plan.write_text(_plan_md("draft").replace("# Body", "# Body edited"), encoding="utf-8")
    assert len(plan_history.snapshot_plans(str(tmp_path))) == 1


def test_md_without_stage_is_not_snapshotted(tmp_path: Path) -> None:
    plans = _plans_dir(tmp_path)
    (plans / "legacy_ab12cd.plan.md").write_text(_plan_md(None), encoding="utf-8")
    assert plan_history.snapshot_plans(str(tmp_path)) == []
    assert not (plans / ".history").exists()


def test_md_infra_and_hidden_files_skipped(tmp_path: Path) -> None:
    plans = _plans_dir(tmp_path)
    (plans / "_template.plan.md").write_text(_plan_md("draft"), encoding="utf-8")
    (plans / ".hidden.plan.md").write_text(_plan_md("draft"), encoding="utf-8")
    assert plan_history.snapshot_plans(str(tmp_path)) == []
    assert not (plans / ".history").exists()


def test_md_older_stage_snapshots_are_kept_forever(tmp_path: Path) -> None:
    plans = _plans_dir(tmp_path)
    plan = plans / "my-plan_ab12cd.plan.md"
    plan.write_text(_plan_md("approved"), encoding="utf-8")
    history = plans / ".history" / "my-plan_ab12cd"
    history.mkdir(parents=True)
    for i in range(25):
        (history / f"20000101T0000{i:02d}_draft.plan.md").write_text("old", encoding="utf-8")

    created = plan_history.snapshot_plans(str(tmp_path))

    assert len(created) == 1
    remaining = sorted(p.name for p in history.glob("*.plan.md*"))
    assert len(remaining) == 26
    assert remaining[-1].endswith("_approved.plan.md.gz")


def test_html_and_md_plans_snapshot_independently(tmp_path: Path) -> None:
    plans = _plans_dir(tmp_path)
    (plans / "html-plan_ab12cd.html").write_text(_plan_html("approved"), encoding="utf-8")
    (plans / "md-plan_ef34gh.plan.md").write_text(_plan_md("in-review"), encoding="utf-8")

    created = plan_history.snapshot_plans(str(tmp_path))

    assert len(created) == 2
    assert any(c.endswith("_approved.html.gz") for c in created)
    assert any(c.endswith("_in-review.plan.md.gz") for c in created)


def test_nested_plan_root_plans_are_snapshotted(tmp_path: Path) -> None:
    """A nested repository's plans are listed, so they get history too."""
    (tmp_path / "project" / ".git").mkdir(parents=True)
    nested_plans = tmp_path / "project" / ".agent-team" / "plans"
    nested_plans.mkdir(parents=True)
    (nested_plans / "inner.html").write_text(_plan_html("approved"), encoding="utf-8")

    created = plan_history.snapshot_plans(str(tmp_path))

    assert len(created) == 1
    assert created[0].startswith("project/.agent-team/plans/.history/inner/")
    assert (tmp_path / created[0]).is_file()


def test_same_named_plans_in_two_roots_keep_separate_histories(tmp_path: Path) -> None:
    """Sharing one history directory would show each root the other's snapshots."""
    outer = _plans_dir(tmp_path)
    (outer / "plan.html").write_text(_plan_html("draft"), encoding="utf-8")
    (tmp_path / "project" / ".git").mkdir(parents=True)
    inner = tmp_path / "project" / ".agent-team" / "plans"
    inner.mkdir(parents=True)
    (inner / "plan.html").write_text(_plan_html("done"), encoding="utf-8")

    created = plan_history.snapshot_plans(str(tmp_path))

    assert sorted(created) == sorted(
        [
            next(p for p in created if p.startswith(".agent-team/")),
            next(p for p in created if p.startswith("project/")),
        ]
    )
    assert len(created) == 2
    assert (outer / ".history" / "plan").is_dir()
    assert (inner / ".history" / "plan").is_dir()

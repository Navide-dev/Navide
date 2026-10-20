"""#448 (review of #453): a run that stops because a stage's kickoff failed
must resume at that stage, not re-run the stage before it.

pipeline.stage_spawn is the only call that marks the previous stage completed
and moves current_stage_index; abort marks whatever stage is current as
aborted, and resume picks the first stage that is not completed. So the
renderer records the stage as spawned before it aborts. Replayed here on the
real ProjectStore in the order the renderer sends them."""

from __future__ import annotations

from pathlib import Path

from agent_team_backend.projects import ProjectStore


def _started(ws: str) -> ProjectStore:
    store = ProjectStore()
    store.start_pipeline(
        ws,
        task_description="t",
        total_stages=2,
        stage_blueprint=[{"stage_id": "01", "slots": []}, {"stage_id": "02", "slots": []}],
    )
    store.record_stage_spawn(ws, stage_index=0, pane_id="p0", agent="claude", role="")
    return store


def test_resume_after_a_failed_kickoff_continues_at_the_stage_that_failed(tmp_path: Path) -> None:
    ws = str(tmp_path)
    store = _started(ws)
    # Stage 02 activates; its slot's kickoff fails: spawn recorded, then abort.
    store.record_stage_spawn(ws, stage_index=1, pane_id="p1", agent="codex", role="")
    store.abort_pipeline(ws, reason="failed")
    project, next_index = store.resume_pipeline(ws)
    assert next_index == 1
    assert [s.status for s in project.stages][0] == "completed"


def test_aborting_before_the_stage_is_recorded_would_rerun_the_finished_stage(tmp_path: Path) -> None:
    # Why the renderer's order matters: the order #453 first shipped.
    ws = str(tmp_path)
    store = _started(ws)
    store.abort_pipeline(ws, reason="failed")
    _, next_index = store.resume_pipeline(ws)
    assert next_index == 0

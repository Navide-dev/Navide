"""pipeline_define / stage_define / role_define / next / resume / reset / restart.

Two halves, one subject: an outside agent could read Navide's pipelines
(pipeline_list) and watch a run (pipeline_status) but could neither change what
a pipeline IS nor drive a run past the button the user has to press.

- The three definition tools write backend state directly (stages_store /
  roles_store) rather than going through a window, and what these pin is the
  half that is invisible from the return value: every op that changes state
  broadcasts the same events its ws.* twin broadcasts, or the Pipelines window
  keeps showing the definition it loaded at open time. Also pinned: an op we do
  not know is refused by name instead of falling through to a default, and a
  half-given op is refused BEFORE the store is touched, so a rejected call
  never leaves a partial write behind.

- The four execution tools go to the renderer, which owns the orchestration.
  What is pinned is that each goes out as the right UI action with the right
  args, that a window which refuses is reported as a refusal, and that the
  three which spawn panes are on the slow-timeout list — a successful
  multi-pane spawn on the normal budget reports itself as a dead window.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging, app
from agent_team_backend.mcp_server import auth as plan_mcp_auth
from agent_team_backend.mcp_server import server as plan_mcp


@pytest.fixture(autouse=True)
def _clean_registry() -> Any:
    agent_messaging._reset_for_test()
    plan_mcp._ui_invoke_pending.pending.clear()
    yield
    agent_messaging._reset_for_test()
    plan_mcp._ui_invoke_pending.pending.clear()


def _ctx() -> Any:
    """A host credential: the definition tools need a valid caller, not a pane."""
    params = {"client": "host", "t": plan_mcp_auth.internal_token()}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


# ── Fakes ───────────────────────────────────────────────────────────────────


class _FakeStagesStore:
    """Records mutations separately from reads, so "nothing was written" is a
    claim a test can actually make."""

    def __init__(self) -> None:
        self.writes: list[tuple[Any, ...]] = []
        self.reads: list[tuple[Any, ...]] = []
        self.pipelines: list[dict[str, Any]] = [
            {"id": "default", "name": "Default", "builtin": True, "stage_count": 2},
            {"id": "custom", "name": "Custom", "builtin": False, "stage_count": 1},
        ]
        self.active_pipeline_id = "default"
        self.stages: list[dict[str, Any]] = [
            {"id": "s1", "title": "One", "slots": [{"agent_key": "claude"}]},
            {"id": "s2", "title": "Two", "slots": [{"agent_key": "codex"}]},
        ]
        self.role_usages: list[dict[str, Any]] = []
        self.repointed: list[str] = []
        self.cleared: list[str] = []

    # reads
    def list_pipelines(self) -> list[dict[str, Any]]:
        self.reads.append(("list_pipelines",))
        return list(self.pipelines)

    def get_active_pipeline_id(self) -> str:
        return self.active_pipeline_id

    def list(self, pipeline_id: str | None = None) -> list[dict[str, Any]]:
        self.reads.append(("list", pipeline_id))
        return list(self.stages)

    def find_role_usages(self, role_key: str) -> list[dict[str, Any]]:
        self.reads.append(("find_role_usages", role_key))
        return list(self.role_usages)

    # writes
    def create_pipeline(self, name: str) -> dict[str, Any]:
        self.writes.append(("create_pipeline", name))
        return {"id": "new1", "name": name, "builtin": False, "stage_count": 0}

    def rename_pipeline(self, pipeline_id: str, name: str) -> dict[str, Any]:
        self.writes.append(("rename_pipeline", pipeline_id, name))
        return {"id": pipeline_id, "name": name, "builtin": False, "stage_count": 1}

    def delete_pipeline(self, pipeline_id: str) -> list[dict[str, Any]]:
        self.writes.append(("delete_pipeline", pipeline_id))
        return list(self.pipelines)

    def set_active_pipeline(self, pipeline_id: str) -> str:
        self.writes.append(("set_active_pipeline", pipeline_id))
        self.active_pipeline_id = pipeline_id
        return pipeline_id

    def reset_builtin(self, pipeline_id: str) -> dict[str, Any]:
        self.writes.append(("reset_builtin", pipeline_id))
        return {"id": pipeline_id, "name": "Default", "builtin": True, "stage_count": 2}

    def upsert(self, data: dict[str, Any], pipeline_id: str | None = None) -> dict[str, Any]:
        self.writes.append(("upsert", data, pipeline_id))
        return dict(data)

    def reorder(self, ids: list[str], pipeline_id: str | None = None) -> list[dict[str, Any]]:
        self.writes.append(("reorder", list(ids), pipeline_id))
        return list(self.stages)

    def delete(self, id: str, pipeline_id: str | None = None) -> list[dict[str, Any]]:
        self.writes.append(("delete", id, pipeline_id))
        return list(self.stages)

    def reset(self, pipeline_id: str | None = None) -> list[dict[str, Any]]:
        self.writes.append(("reset", pipeline_id))
        return list(self.stages)

    def repoint_role_references(self, old_key: str, new_key: str) -> list[str]:
        self.writes.append(("repoint_role_references", old_key, new_key))
        return list(self.repointed)

    def clear_missing_role_references(self, valid: set[str]) -> list[str]:
        self.writes.append(("clear_missing_role_references", sorted(valid)))
        return list(self.cleared)


class _FakeRolesStore:
    def __init__(self) -> None:
        self.writes: list[tuple[Any, ...]] = []
        self.roles: list[dict[str, Any]] = [
            {"key": "pm", "label": "PM", "one_line": "plans", "system_prompt": "be a pm"},
            {"key": "dev", "label": "Dev", "one_line": "writes", "system_prompt": "be a dev"},
        ]

    def list(self) -> list[dict[str, Any]]:
        return list(self.roles)

    def get(self, key: str) -> dict[str, Any] | None:
        return next((r for r in self.roles if r["key"] == key), None)

    def upsert(
        self, *, key: str, label: str, one_line: str, system_prompt: str, properties: Any = None
    ) -> dict[str, Any]:
        self.writes.append(("upsert", key, label, one_line, system_prompt))
        role = {"key": key, "label": label, "one_line": one_line, "system_prompt": system_prompt}
        if properties is not None:
            role["properties"] = properties
        self.roles = [r for r in self.roles if r["key"] != key] + [role]
        return role

    def delete(self, key: str) -> list[dict[str, Any]]:
        self.writes.append(("delete", key))
        self.roles = [r for r in self.roles if r["key"] != key]
        return list(self.roles)

    def reset(self) -> list[dict[str, Any]]:
        self.writes.append(("reset",))
        self.roles = [
            {"key": "pm", "label": "PM", "one_line": "plans", "system_prompt": "be a pm"}
        ]
        return list(self.roles)


class _FakeProjectStore:
    def __init__(self, project: Any = None) -> None:
        self.project = project

    def peek(self, workspace_path: str) -> Any:
        return self.project


@pytest.fixture
def stores(monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    stages = _FakeStagesStore()
    roles = _FakeRolesStore()
    projects = _FakeProjectStore()
    monkeypatch.setattr(app, "stages_store", stages, raising=False)
    monkeypatch.setattr(app, "roles_store", roles, raising=False)
    monkeypatch.setattr(app, "project_store", projects, raising=False)
    return SimpleNamespace(stages=stages, roles=roles, projects=projects)


@pytest.fixture
def events(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """Collects what the open windows would have been told."""
    collected: list[dict[str, Any]] = []

    async def fake_broadcast(event: dict[str, Any], **_kwargs: Any) -> None:
        collected.append(event)

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    return collected


def _running(pipeline_id: str = "default") -> SimpleNamespace:
    return SimpleNamespace(state="running", pipeline_id=pipeline_id)


def _kinds(events: list[dict[str, Any]]) -> list[tuple[str, str]]:
    return [(e["type"], e["payload"].get("reason", "")) for e in events]


# ── A. pipeline_define ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_pipeline_define_create_adds_a_pipeline_and_announces_it(
    stores: SimpleNamespace, events: list[dict[str, Any]]
) -> None:
    result = await plan_mcp.pipeline_define(_ctx(), "create", name="Release")

    assert result["ok"] is True
    assert result["pipeline"]["name"] == "Release"
    assert stores.stages.writes == [("create_pipeline", "Release")]
    assert _kinds(events) == [("pipelines.changed", "create")]


@pytest.mark.asyncio
async def test_pipeline_define_rename_announces_the_new_name(
    stores: SimpleNamespace, events: list[dict[str, Any]]
) -> None:
    result = await plan_mcp.pipeline_define(
        _ctx(), "rename", pipeline_id="custom", name="Renamed"
    )

    assert result["ok"] is True
    assert stores.stages.writes == [("rename_pipeline", "custom", "Renamed")]
    assert _kinds(events) == [("pipelines.changed", "rename")]


@pytest.mark.asyncio
async def test_pipeline_define_delete_removes_it_and_announces_it(
    stores: SimpleNamespace, events: list[dict[str, Any]]
) -> None:
    result = await plan_mcp.pipeline_define(_ctx(), "delete", pipeline_id="custom")

    assert result["ok"] is True
    assert "pipeline" not in result
    assert stores.stages.writes == [("delete_pipeline", "custom")]
    assert _kinds(events) == [("pipelines.changed", "delete")]


@pytest.mark.asyncio
async def test_pipeline_define_set_active_switches_and_announces_it(
    stores: SimpleNamespace, events: list[dict[str, Any]]
) -> None:
    result = await plan_mcp.pipeline_define(_ctx(), "set_active", pipeline_id="custom")

    assert result["ok"] is True
    assert result["active_pipeline_id"] == "custom"
    assert stores.stages.writes == [("set_active_pipeline", "custom")]
    assert _kinds(events) == [("pipelines.changed", "set_active")]


@pytest.mark.asyncio
async def test_pipeline_define_reset_builtin_announces_both_pipelines_and_stages(
    stores: SimpleNamespace, events: list[dict[str, Any]]
) -> None:
    """It replaces the whole stage list, so a stages.changed has to go out too —
    a pipelines.changed alone leaves the stage editor showing the old stages."""
    result = await plan_mcp.pipeline_define(_ctx(), "reset_builtin", pipeline_id="default")

    assert result["ok"] is True
    assert stores.stages.writes == [("reset_builtin", "default")]
    assert _kinds(events) == [
        ("pipelines.changed", "reset_builtin"),
        ("stages.changed", "reset_builtin"),
    ]
    assert events[1]["payload"]["pipeline_id"] == "default"


@pytest.mark.asyncio
async def test_pipeline_define_refuses_an_op_it_does_not_know(
    stores: SimpleNamespace, events: list[dict[str, Any]]
) -> None:
    result = await plan_mcp.pipeline_define(_ctx(), "archive", pipeline_id="custom")

    assert result["ok"] is False
    assert result["error_code"] == "bad_op"
    for op in ("create", "rename", "delete", "set_active", "reset_builtin"):
        assert op in result["error"]
    assert stores.stages.writes == []
    assert events == []


@pytest.mark.parametrize("op", ["rename", "delete", "set_active", "reset_builtin"])
@pytest.mark.asyncio
async def test_pipeline_define_needs_a_pipeline_id_before_it_touches_the_store(
    op: str, stores: SimpleNamespace, events: list[dict[str, Any]]
) -> None:
    result = await plan_mcp.pipeline_define(_ctx(), op, name="whatever")

    assert result["ok"] is False
    assert result["error_code"] == "missing_argument"
    assert "pipeline_id" in result["error"]
    assert stores.stages.writes == []
    assert events == []


@pytest.mark.parametrize("op", ["create", "rename"])
@pytest.mark.asyncio
async def test_pipeline_define_needs_a_name_before_it_touches_the_store(
    op: str, stores: SimpleNamespace, events: list[dict[str, Any]]
) -> None:
    result = await plan_mcp.pipeline_define(_ctx(), op, pipeline_id="custom")

    assert result["ok"] is False
    assert result["error_code"] == "missing_argument"
    assert "name" in result["error"]
    assert stores.stages.writes == []
    assert events == []


@pytest.mark.parametrize("op", ["delete", "set_active"])
@pytest.mark.asyncio
async def test_pipeline_define_refuses_to_delete_or_switch_during_a_run(
    op: str, stores: SimpleNamespace, events: list[dict[str, Any]]
) -> None:
    stores.projects.project = _running()

    result = await plan_mcp.pipeline_define(
        _ctx(), op, pipeline_id="custom", workspace_path="/ws/alpha"
    )

    assert result["ok"] is False
    assert result["error_code"] == "pipeline_running"
    assert stores.stages.writes == []
    assert events == []


@pytest.mark.asyncio
async def test_pipeline_define_refuses_reset_builtin_of_the_pipeline_being_run(
    stores: SimpleNamespace, events: list[dict[str, Any]]
) -> None:
    """The guard compares against the pipeline the RUN recorded, so naming it
    explicitly must not walk past it."""
    stores.projects.project = _running("default")

    result = await plan_mcp.pipeline_define(
        _ctx(), "reset_builtin", pipeline_id="default", workspace_path="/ws/alpha"
    )

    assert result["ok"] is False
    assert result["error_code"] == "pipeline_running"
    assert stores.stages.writes == []


@pytest.mark.asyncio
async def test_pipeline_define_allows_resetting_a_pipeline_the_run_is_not_using(
    stores: SimpleNamespace, events: list[dict[str, Any]]
) -> None:
    stores.projects.project = _running("custom")

    result = await plan_mcp.pipeline_define(
        _ctx(), "reset_builtin", pipeline_id="default", workspace_path="/ws/alpha"
    )

    assert result["ok"] is True
    assert stores.stages.writes == [("reset_builtin", "default")]


@pytest.mark.asyncio
async def test_pipeline_define_reports_a_store_refusal_rather_than_raising(
    stores: SimpleNamespace, events: list[dict[str, Any]]
) -> None:
    def boom(_pipeline_id: str) -> list[dict[str, Any]]:
        raise ValueError("cannot delete the last remaining pipeline")

    stores.stages.delete_pipeline = boom  # type: ignore[assignment]

    result = await plan_mcp.pipeline_define(_ctx(), "delete", pipeline_id="default")

    assert result == {
        "ok": False,
        "error": "cannot delete the last remaining pipeline",
        "error_code": "invalid",
    }
    assert events == []


# ── B. stage_define ─────────────────────────────────────────────────────────


_STAGE = {"id": "s3", "title": "Three", "slots": [{"agent_key": "claude", "role_key": "dev"}]}


@pytest.mark.asyncio
async def test_stage_define_upsert_writes_the_stage_and_announces_both_views(
    stores: SimpleNamespace, events: list[dict[str, Any]]
) -> None:
    """stages.changed alone leaves the pipeline summary's stage_count stale, so
    the summaries are republished with it."""
    result = await plan_mcp.stage_define(
        _ctx(), "upsert", pipeline_id="custom", stage=dict(_STAGE)
    )

    assert result["ok"] is True
    assert result["stage"] == _STAGE
    assert stores.stages.writes == [("upsert", _STAGE, "custom")]
    assert _kinds(events) == [
        ("stages.changed", "upsert"),
        ("pipelines.changed", "stage_upsert"),
    ]
    assert events[0]["payload"]["pipeline_id"] == "custom"


@pytest.mark.asyncio
async def test_stage_define_delete_removes_one_stage_and_announces_both_views(
    stores: SimpleNamespace, events: list[dict[str, Any]]
) -> None:
    result = await plan_mcp.stage_define(_ctx(), "delete", pipeline_id="custom", stage_id="s2")

    assert result["ok"] is True
    assert stores.stages.writes == [("delete", "s2", "custom")]
    assert _kinds(events) == [
        ("stages.changed", "delete"),
        ("pipelines.changed", "stage_delete"),
    ]


@pytest.mark.asyncio
async def test_stage_define_reorder_passes_the_order_through(
    stores: SimpleNamespace, events: list[dict[str, Any]]
) -> None:
    result = await plan_mcp.stage_define(
        _ctx(), "reorder", pipeline_id="custom", ids=["s2", "s1"]
    )

    assert result["ok"] is True
    assert stores.stages.writes == [("reorder", ["s2", "s1"], "custom")]
    assert _kinds(events) == [
        ("stages.changed", "reorder"),
        ("pipelines.changed", "stage_reorder"),
    ]


@pytest.mark.asyncio
async def test_stage_define_reset_reseeds_and_announces_both_views(
    stores: SimpleNamespace, events: list[dict[str, Any]]
) -> None:
    result = await plan_mcp.stage_define(_ctx(), "reset", pipeline_id="default")

    assert result["ok"] is True
    assert stores.stages.writes == [("reset", "default")]
    assert _kinds(events) == [
        ("stages.changed", "reset"),
        ("pipelines.changed", "stage_reset"),
    ]


@pytest.mark.asyncio
async def test_stage_define_with_no_pipeline_id_means_the_active_one(
    stores: SimpleNamespace, events: list[dict[str, Any]]
) -> None:
    result = await plan_mcp.stage_define(_ctx(), "delete", stage_id="s2")

    assert result["ok"] is True
    assert stores.stages.writes == [("delete", "s2", None)]
    assert events[0]["payload"]["pipeline_id"] == "default"
    assert result["pipeline_id"] == "default"


@pytest.mark.asyncio
async def test_stage_define_refuses_an_op_it_does_not_know(
    stores: SimpleNamespace, events: list[dict[str, Any]]
) -> None:
    result = await plan_mcp.stage_define(_ctx(), "duplicate", stage_id="s1")

    assert result["ok"] is False
    assert result["error_code"] == "bad_op"
    for op in ("upsert", "delete", "reorder", "reset"):
        assert op in result["error"]
    assert stores.stages.writes == []
    assert events == []


@pytest.mark.asyncio
async def test_stage_define_upsert_needs_a_stage_before_it_touches_the_store(
    stores: SimpleNamespace, events: list[dict[str, Any]]
) -> None:
    result = await plan_mcp.stage_define(_ctx(), "upsert", pipeline_id="custom")

    assert result["ok"] is False
    assert result["error_code"] == "missing_argument"
    assert "stage" in result["error"]
    assert stores.stages.writes == []
    assert events == []


@pytest.mark.asyncio
async def test_stage_define_delete_needs_a_stage_id_before_it_touches_the_store(
    stores: SimpleNamespace, events: list[dict[str, Any]]
) -> None:
    result = await plan_mcp.stage_define(_ctx(), "delete", pipeline_id="custom")

    assert result["ok"] is False
    assert result["error_code"] == "missing_argument"
    assert "stage_id" in result["error"]
    assert stores.stages.writes == []
    assert events == []


@pytest.mark.asyncio
async def test_stage_define_reorder_needs_ids_before_it_touches_the_store(
    stores: SimpleNamespace, events: list[dict[str, Any]]
) -> None:
    result = await plan_mcp.stage_define(_ctx(), "reorder", pipeline_id="custom", ids=[])

    assert result["ok"] is False
    assert result["error_code"] == "missing_argument"
    assert "ids" in result["error"]
    assert stores.stages.writes == []
    assert events == []


@pytest.mark.parametrize("op", ["upsert", "delete", "reorder", "reset"])
@pytest.mark.asyncio
async def test_stage_define_refuses_every_op_while_that_pipeline_is_running(
    op: str, stores: SimpleNamespace, events: list[dict[str, Any]]
) -> None:
    stores.projects.project = _running("custom")

    result = await plan_mcp.stage_define(
        _ctx(),
        op,
        pipeline_id="custom",
        stage_id="s2",
        stage=dict(_STAGE),
        ids=["s2", "s1"],
        workspace_path="/ws/alpha",
    )

    assert result["ok"] is False
    assert result["error_code"] == "pipeline_running"
    assert stores.stages.writes == []
    assert events == []


@pytest.mark.asyncio
async def test_stage_define_reports_a_store_refusal_rather_than_raising(
    stores: SimpleNamespace, events: list[dict[str, Any]]
) -> None:
    def boom(_id: str, _pipeline_id: str | None = None) -> list[dict[str, Any]]:
        raise KeyError("stage not found: nope")

    stores.stages.delete = boom  # type: ignore[assignment]

    result = await plan_mcp.stage_define(_ctx(), "delete", stage_id="nope")

    assert result["ok"] is False
    assert result["error_code"] == "not_found"
    assert "nope" in result["error"]
    assert events == []


# ── C. role_define ──────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_role_define_upsert_writes_the_role_and_announces_it(
    stores: SimpleNamespace, events: list[dict[str, Any]]
) -> None:
    result = await plan_mcp.role_define(
        _ctx(),
        "upsert",
        key="qa",
        label="QA",
        one_line="tests",
        system_prompt="be a tester",
    )

    assert result["ok"] is True
    assert result["role"]["key"] == "qa"
    assert stores.roles.writes == [("upsert", "qa", "QA", "tests", "be a tester")]
    assert _kinds(events) == [("roles.changed", "upsert")]


@pytest.mark.asyncio
async def test_role_define_rename_repoints_the_slots_and_announces_both(
    stores: SimpleNamespace, events: list[dict[str, Any]]
) -> None:
    """A rename moves stage slots too, so the pipelines whose stages were
    rewritten get a stages.changed of their own."""
    stores.stages.repointed = ["default", "custom"]

    result = await plan_mcp.role_define(_ctx(), "rename", key="dev", new_key="engineer")

    assert result["ok"] is True
    assert result["repointed_pipeline_ids"] == ["default", "custom"]
    assert ("repoint_role_references", "dev", "engineer") in stores.stages.writes
    assert ("delete", "dev") in stores.roles.writes
    assert _kinds(events) == [
        ("roles.changed", "rename"),
        ("stages.changed", "role_rename"),
        ("stages.changed", "role_rename"),
    ]
    assert [e["payload"]["pipeline_id"] for e in events[1:]] == ["default", "custom"]


@pytest.mark.asyncio
async def test_role_define_rename_carries_the_prompt_across_when_not_resent(
    stores: SimpleNamespace, events: list[dict[str, Any]]
) -> None:
    """roles_store.upsert refuses a blank label or system_prompt, so a rename
    that passed the arguments through untouched would fail on every role whose
    text the caller did not happen to resend."""
    await plan_mcp.role_define(_ctx(), "rename", key="dev", new_key="engineer")

    assert ("upsert", "engineer", "Dev", "writes", "be a dev") in stores.roles.writes


@pytest.mark.asyncio
async def test_role_define_rename_refuses_an_unknown_key(
    stores: SimpleNamespace, events: list[dict[str, Any]]
) -> None:
    result = await plan_mcp.role_define(_ctx(), "rename", key="ghost", new_key="engineer")

    assert result["ok"] is False
    assert result["error_code"] == "not_found"
    assert stores.roles.writes == []
    assert events == []


@pytest.mark.asyncio
async def test_role_define_rename_refuses_to_merge_onto_an_existing_key(
    stores: SimpleNamespace, events: list[dict[str, Any]]
) -> None:
    result = await plan_mcp.role_define(_ctx(), "rename", key="dev", new_key="pm")

    assert result["ok"] is False
    assert result["error_code"] == "role_key_exists"
    assert stores.roles.writes == []
    assert events == []


@pytest.mark.asyncio
async def test_role_define_delete_removes_an_unused_role_and_announces_it(
    stores: SimpleNamespace, events: list[dict[str, Any]]
) -> None:
    result = await plan_mcp.role_define(_ctx(), "delete", key="dev")

    assert result["ok"] is True
    assert stores.roles.writes == [("delete", "dev")]
    assert _kinds(events) == [("roles.changed", "delete")]


@pytest.mark.asyncio
async def test_role_define_delete_refuses_while_a_stage_slot_still_names_it(
    stores: SimpleNamespace, events: list[dict[str, Any]]
) -> None:
    stores.stages.role_usages = [{"pipeline_id": "default", "stage_id": "s1", "label": "Dev"}]

    result = await plan_mcp.role_define(_ctx(), "delete", key="dev")

    assert result["ok"] is False
    assert result["error_code"] == "role_in_use"
    assert result["usages"] == stores.stages.role_usages
    assert stores.roles.writes == []
    assert events == []


@pytest.mark.asyncio
async def test_role_define_reset_reseeds_and_blanks_the_dangling_slots(
    stores: SimpleNamespace, events: list[dict[str, Any]]
) -> None:
    stores.stages.cleared = ["custom"]

    result = await plan_mcp.role_define(_ctx(), "reset")

    assert result["ok"] is True
    assert ("reset",) in stores.roles.writes
    assert ("clear_missing_role_references", ["pm"]) in stores.stages.writes
    assert _kinds(events) == [
        ("roles.changed", "reset"),
        ("stages.changed", "roles_reset"),
    ]


@pytest.mark.asyncio
async def test_role_define_refuses_an_op_it_does_not_know(
    stores: SimpleNamespace, events: list[dict[str, Any]]
) -> None:
    result = await plan_mcp.role_define(_ctx(), "clone", key="dev")

    assert result["ok"] is False
    assert result["error_code"] == "bad_op"
    for op in ("upsert", "rename", "delete", "reset"):
        assert op in result["error"]
    assert stores.roles.writes == []
    assert events == []


@pytest.mark.parametrize(
    ("kwargs", "missing"),
    [
        ({"op": "upsert", "label": "QA", "system_prompt": "p"}, "key"),
        ({"op": "upsert", "key": "qa", "system_prompt": "p"}, "label"),
        ({"op": "upsert", "key": "qa", "label": "QA"}, "system_prompt"),
        ({"op": "rename", "key": "dev"}, "new_key"),
        ({"op": "delete"}, "key"),
    ],
)
@pytest.mark.asyncio
async def test_role_define_needs_its_arguments_before_it_touches_the_store(
    kwargs: dict[str, Any],
    missing: str,
    stores: SimpleNamespace,
    events: list[dict[str, Any]],
) -> None:
    result = await plan_mcp.role_define(_ctx(), **kwargs)

    assert result["ok"] is False
    assert result["error_code"] == "missing_argument"
    assert missing in result["error"]
    assert stores.roles.writes == []
    assert stores.stages.writes == []
    assert events == []


@pytest.mark.asyncio
async def test_role_define_reports_a_store_refusal_rather_than_raising(
    stores: SimpleNamespace, events: list[dict[str, Any]]
) -> None:
    def boom(**_kwargs: Any) -> dict[str, Any]:
        raise ValueError("key must be lowercase letters/digits/underscore/dash, 1-32 chars")

    stores.roles.upsert = boom  # type: ignore[assignment]

    result = await plan_mcp.role_define(
        _ctx(), "upsert", key="QA", label="QA", system_prompt="p"
    )

    assert result["ok"] is False
    assert result["error_code"] == "invalid"
    assert events == []


# ── D. the execution tools ──────────────────────────────────────────────────


@pytest.fixture
def ui_calls(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    """Record what would have been asked of the window, and answer ok."""
    calls: list[dict[str, Any]] = []

    async def fake_ui_request(
        workspace_path: str,
        op: str,
        *,
        caller: Any = None,
        action: str | None = None,
        args: dict[str, Any] | None = None,
        is_global: bool = False,
    ) -> dict[str, Any]:
        calls.append(
            {
                "workspace_path": workspace_path,
                "op": op,
                "action": action,
                "args": args,
                "is_global": is_global,
            }
        )
        return {"ok": True, "result": {"state": "running"}, "error": None}

    monkeypatch.setattr(plan_mcp, "_ui_request", fake_ui_request)
    return calls


_RUN_TOOLS = [
    ("pipeline_next", "ui.pipeline.next"),
    ("pipeline_resume", "ui.pipeline.resume"),
    ("pipeline_reset", "ui.pipeline.reset"),
    ("pipeline_restart", "ui.pipeline.restart"),
]


@pytest.mark.parametrize(("tool_name", "action"), _RUN_TOOLS)
@pytest.mark.asyncio
async def test_the_run_tools_ask_the_window_by_their_own_action_name(
    tool_name: str, action: str, ui_calls: list[dict[str, Any]]
) -> None:
    tool = getattr(plan_mcp, tool_name)

    result = await tool(_ctx(), workspace_path="/ws/alpha")

    assert result == {"ok": True, "result": {"state": "running"}, "error": None}
    assert ui_calls == [
        {
            "workspace_path": "/ws/alpha",
            "op": "invoke",
            "action": action,
            "args": {},
            "is_global": False,
        }
    ]


@pytest.mark.parametrize(("tool_name", "action"), _RUN_TOOLS)
@pytest.mark.asyncio
async def test_a_window_that_refuses_is_not_reported_as_success(
    tool_name: str, action: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def refusing(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        return {
            "ok": False,
            "result": None,
            "error": f"{action}: no pipeline is running in this workspace",
            "error_code": "ui_action_failed",
        }

    monkeypatch.setattr(plan_mcp, "_ui_request", refusing)
    tool = getattr(plan_mcp, tool_name)

    result = await tool(_ctx(), workspace_path="/ws/alpha")

    assert result["ok"] is False
    assert result["result"] is None
    assert "no pipeline is running" in result["error"]


@pytest.mark.asyncio
async def test_a_caller_with_no_pane_must_name_the_workspace_to_drive_a_run(
    ui_calls: list[dict[str, Any]],
) -> None:
    from agent_team_backend.fs_service import FsError

    with pytest.raises(FsError):
        await plan_mcp.pipeline_next(_ctx())
    assert ui_calls == []


def test_the_pane_spawning_run_actions_get_the_slow_timeout() -> None:
    """next / resume / restart all reach activateStage, which spawns a pane per
    slot of the stage it activates; on the normal budget a SUCCESSFUL one
    answers after the deadline and reads as an unresponsive window. reset only
    tears panes down, so it stays on the normal budget."""
    assert "ui.pipeline.next" in plan_mcp._UI_INVOKE_SLOW_ACTIONS
    assert "ui.pipeline.resume" in plan_mcp._UI_INVOKE_SLOW_ACTIONS
    assert "ui.pipeline.restart" in plan_mcp._UI_INVOKE_SLOW_ACTIONS
    assert "ui.pipeline.reset" not in plan_mcp._UI_INVOKE_SLOW_ACTIONS
    assert plan_mcp._UI_INVOKE_SLOW_TIMEOUT_S > plan_mcp._UI_INVOKE_TIMEOUT_S


# ── E. cli_permission_settings ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_reading_the_permission_switch_sends_no_yolo_key_at_all(
    ui_calls: list[dict[str, Any]],
) -> None:
    """The read path must not write. An args dict that always carried the key
    would turn every read into a write of whatever the default serialised to,
    so absent is the assertion — not null and not false."""
    result = await plan_mcp.cli_permission_settings(_ctx(), workspace_path="/ws/alpha")

    assert result["ok"] is True
    assert ui_calls[0]["action"] == "ui.settings.yolo"
    assert ui_calls[0]["args"] == {}
    assert "yolo" not in ui_calls[0]["args"]


@pytest.mark.asyncio
async def test_turning_the_permission_switch_off_sends_the_value(
    ui_calls: list[dict[str, Any]],
) -> None:
    result = await plan_mcp.cli_permission_settings(
        _ctx(), yolo=False, workspace_path="/ws/alpha"
    )

    assert result["ok"] is True
    assert ui_calls == [
        {
            "workspace_path": "/ws/alpha",
            "op": "invoke",
            "action": "ui.settings.yolo",
            "args": {"yolo": False},
            "is_global": False,
        }
    ]


@pytest.mark.asyncio
async def test_an_agent_cannot_turn_the_permission_switch_on(
    ui_calls: list[dict[str, Any]],
) -> None:
    """Skipping every CLI's permission prompts is the user's call: the MCP path
    refuses it before any window is asked."""
    result = await plan_mcp.cli_permission_settings(
        _ctx(), yolo=True, workspace_path="/ws/alpha"
    )

    assert result["ok"] is False
    assert result["error_code"] == "ui_human_only"
    assert "Settings" in result["error"]
    assert ui_calls == []


@pytest.mark.asyncio
async def test_the_permission_switch_needs_no_workspace_to_reach_a_window(
    ui_calls: list[dict[str, Any]],
) -> None:
    """The setting is global, so a caller with no pane and no path must still
    get an answer — unlike the pipeline tools, which refuse without one."""
    result = await plan_mcp.cli_permission_settings(_ctx())

    assert result["ok"] is True
    assert ui_calls[0]["workspace_path"] == ""
    assert ui_calls[0]["is_global"] is True


@pytest.mark.asyncio
async def test_the_permission_switch_reports_a_window_that_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def refusing(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        return {
            "ok": False,
            "result": None,
            "error": "no Navide window is open to handle this request",
            "error_code": "ui_no_window",
        }

    monkeypatch.setattr(plan_mcp, "_ui_request", refusing)

    result = await plan_mcp.cli_permission_settings(_ctx(), yolo=False)

    assert result["ok"] is False
    assert result["result"] is None
    assert result["error_code"] == "ui_no_window"


# ── F. registration ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_the_pipeline_control_tools_are_registered_with_their_arguments() -> None:
    tools = {tool.name: tool for tool in await plan_mcp.server.list_tools()}
    assert set(tools) >= {
        "pipeline_define",
        "stage_define",
        "role_define",
        "pipeline_next",
        "pipeline_resume",
        "pipeline_reset",
        "pipeline_restart",
        "cli_permission_settings",
    }
    # The Context parameter is injected, never asked of the agent.
    assert set(tools["pipeline_define"].inputSchema.get("properties") or {}) == {
        "op",
        "pipeline_id",
        "name",
        "workspace_path",
    }
    assert set(tools["stage_define"].inputSchema.get("properties") or {}) == {
        "op",
        "pipeline_id",
        "stage_id",
        "stage",
        "ids",
        "workspace_path",
    }
    assert set(tools["role_define"].inputSchema.get("properties") or {}) == {
        "op",
        "key",
        "new_key",
        "label",
        "one_line",
        "system_prompt",
        "properties",
    }
    for name in ("pipeline_next", "pipeline_resume", "pipeline_reset", "pipeline_restart"):
        assert set(tools[name].inputSchema.get("properties") or {}) == {"workspace_path"}
    assert set(tools["cli_permission_settings"].inputSchema.get("properties") or {}) == {
        "yolo",
        "workspace_path",
    }
    # Nothing is required: with no argument at all it is a pure read.
    assert not (tools["cli_permission_settings"].inputSchema.get("required") or [])
    # op is the one argument none of the three definition tools may default.
    for name in ("pipeline_define", "stage_define", "role_define"):
        assert tools[name].inputSchema.get("required") == ["op"]


@pytest.mark.asyncio
async def test_the_existing_pipeline_tools_are_left_alone() -> None:
    tools = {tool.name: tool for tool in await plan_mcp.server.list_tools()}
    assert set(tools["pipeline_status"].inputSchema.get("properties") or {}) == {
        "workspace_path"
    }
    assert set(tools["pipeline_start"].inputSchema.get("properties") or {}) == {
        "task",
        "pipeline_id",
        "workspace_path",
    }
    assert set(tools["pipeline_abort"].inputSchema.get("properties") or {}) == {
        "workspace_path"
    }
    assert not (tools["pipeline_list"].inputSchema.get("properties") or {})

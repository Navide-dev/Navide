"""cli_usage / workspace_list / pipeline_list / pipeline_status / skills_list /
cli_message_log: the read-only inventory an agent had no way to see.

Navide tracks CLI quota, the projects it may address, the pipeline templates a
team of panes is assembled from, the shared skill library and a persisted
message log — and none of it was reachable over MCP. An agent handed work to a
pane whose plan was exhausted, guessed at workspace paths, and could not tell
that it was itself stage three of five.

What these pin is what such an inventory must not do: hand back whole prompts
and skill bodies that bury the answer, invent a project for a workspace that
has never run one, or show one pane another pane's mail.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging
from agent_team_backend import app as backend_app
from agent_team_backend import usage_service as usage_service_module
from agent_team_backend.mcp_server import (
    server as plan_mcp,
    auth as plan_mcp_auth,
    wiring as plan_mcp_wiring,
)
from agent_team_backend.projects import PaneRecord, Project, StageRecord


@pytest.fixture(autouse=True)
def _clean_registry() -> Any:
    agent_messaging._reset_for_test()
    yield
    agent_messaging._reset_for_test()


def _ctx(pane_id: str = "pa") -> Any:
    params = {"pane": pane_id, "t": plan_mcp_wiring.caller_token(pane_id)}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


def _host_ctx() -> Any:
    params = {"client": "host", "t": plan_mcp_auth.internal_token()}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


# ── A. cli_usage ────────────────────────────────────────────────────────────


class _FakeUsageService:
    """Stands in for usage_service.service, whose payload() polls real CLIs."""

    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload
        self.calls = 0

    def payload(self) -> dict[str, Any]:
        self.calls += 1
        return self._payload


_USAGE_PAYLOAD: dict[str, Any] = {
    "providers": {
        "claude": {"provider": "claude", "status": "ok", "windows": [{"used": 42}]},
        "codex": {"provider": "codex", "status": "exhausted", "windows": []},
    },
    "accounts": {
        "claude": {"slot-a": {"provider": "claude", "status": "ok"}},
        "codex": {"__default__": {"provider": "codex", "status": "exhausted"}},
    },
    "enabled": True,
    "intervalSec": 300,
}


@pytest.fixture
def usage(monkeypatch: pytest.MonkeyPatch) -> _FakeUsageService:
    service = _FakeUsageService(_USAGE_PAYLOAD)
    monkeypatch.setattr(usage_service_module, "service", service)
    return service


@pytest.mark.asyncio
async def test_cli_usage_reports_every_vendor_exactly_as_the_service_gave_it(
    usage: _FakeUsageService,
) -> None:
    """The vendors' own numbers, unedited: this project shows official data as
    it arrives, so a snapshot must survive the trip byte for byte."""
    agent_messaging.register("pa", "reviewer", "/ws/alpha", agent_key="claude")

    result = await plan_mcp.cli_usage(_ctx())

    assert result["ok"] is True
    assert result["providers"] == _USAGE_PAYLOAD["providers"]
    assert result["accounts"] == _USAGE_PAYLOAD["accounts"]
    assert result["enabled"] is True
    assert result["intervalSec"] == 300
    assert "agent" not in result  # no filter was asked for
    assert usage.calls == 1


@pytest.mark.asyncio
async def test_cli_usage_narrows_to_one_vendor(usage: _FakeUsageService) -> None:
    result = await plan_mcp.cli_usage(_host_ctx(), agent="codex")

    assert result["agent"] == "codex"
    assert set(result["providers"]) == {"codex"}
    assert set(result["accounts"]) == {"codex"}
    assert result["providers"]["codex"] == _USAGE_PAYLOAD["providers"]["codex"]


@pytest.mark.asyncio
async def test_cli_usage_for_an_untracked_vendor_is_empty_not_an_error(
    usage: _FakeUsageService,
) -> None:
    """"Navide reads no quota for this vendor" is an answer, not a failure."""
    result = await plan_mcp.cli_usage(_host_ctx(), agent="  KILO  ")

    assert result["ok"] is True
    assert result["agent"] == "kilo"
    assert result["providers"] == {}
    assert result["accounts"] == {}


# ── B. workspace_list ───────────────────────────────────────────────────────


class _FakeRecentWorkspaces:
    def __init__(self, entries: list[dict[str, Any]]) -> None:
        self._entries = entries

    def list(self) -> list[dict[str, Any]]:
        return [dict(entry) for entry in self._entries]


@pytest.fixture
def recent(monkeypatch: pytest.MonkeyPatch) -> None:
    store = _FakeRecentWorkspaces(
        [
            {"path": "/ws/alpha", "name": "alpha", "pinned": False, "exists": True},
            {"path": "/ws/beta", "name": "beta", "pinned": True, "exists": False},
        ]
    )
    monkeypatch.setattr(backend_app, "recent_workspaces_store", store)


@pytest.mark.asyncio
async def test_workspace_list_marks_which_recent_workspaces_have_a_live_pane(
    monkeypatch: pytest.MonkeyPatch, recent: None
) -> None:
    """A workspace with no live pane has no window watching it, so a plan or a
    preview written there is never shown to the user."""
    monkeypatch.setattr(plan_mcp, "_live_pane_workspaces", lambda: ["/ws/alpha"])

    result = await plan_mcp.workspace_list(_host_ctx())

    by_path = {entry["path"]: entry for entry in result["workspaces"]}
    assert by_path["/ws/alpha"]["has_live_panes"] is True
    assert by_path["/ws/beta"]["has_live_panes"] is False
    # The store's own record is carried through, not replaced by a summary.
    assert by_path["/ws/beta"]["pinned"] is True
    assert by_path["/ws/beta"]["exists"] is False


@pytest.mark.asyncio
async def test_workspace_list_reports_a_live_workspace_the_recent_list_never_saw(
    monkeypatch: pytest.MonkeyPatch, recent: None, tmp_path: Path
) -> None:
    """A pane can run in a project the user never opened from the welcome
    screen — a legal workspace_path the recent list does not mention."""
    # Real absolute paths: the live set is reported in resolved form.
    alpha = str((tmp_path / "alpha").resolve())
    gamma = str((tmp_path / "gamma").resolve())
    monkeypatch.setattr(plan_mcp, "_live_pane_workspaces", lambda: [gamma, alpha])

    result = await plan_mcp.workspace_list(_host_ctx())

    assert result["live_pane_workspaces"] == [alpha, gamma]
    assert gamma not in {entry["path"] for entry in result["workspaces"]}


# ── C. pipeline_list ────────────────────────────────────────────────────────


class _FakeStagesStore:
    def __init__(self) -> None:
        self.stages = {
            "default": [
                {
                    "id": "plan",
                    "title": "Planning",
                    "short_title": "Plan",
                    "question": "What are we building?",
                    "description": "Write the plan",
                    "sentinel": "PLAN-DONE",
                    "recommended_roles": ["pm"],
                    "allow_questions": True,
                    "doc_query": "",
                    "slots": [
                        {
                            "agent_key": "claude",
                            "role_key": "pm",
                            "label": "Planner",
                            "is_commander": True,
                            "kickoff_body": "x" * 4000,
                        }
                    ],
                }
            ],
            "maint": [],
        }

    def list_pipelines(self) -> list[dict[str, Any]]:
        return [
            {"id": "default", "name": "SDLC", "builtin": True, "stage_count": 1},
            {"id": "maint", "name": "Maintenance", "builtin": True, "stage_count": 0},
        ]

    def get_active_pipeline_id(self) -> str:
        return "maint"

    def list(self, pipeline_id: str | None = None) -> list[dict[str, Any]]:
        return [dict(stage) for stage in self.stages[pipeline_id or "default"]]


class _FakeRolesStore:
    def list(self) -> list[dict[str, Any]]:
        return [
            {
                "key": "pm",
                "label": "Product Manager",
                "one_line": "PRD, user stories",
                "system_prompt": "y" * 4000,
                "is_default": True,
                "created_at": "2026-01-01T00:00:00Z",
            }
        ]


@pytest.fixture
def pipelines(monkeypatch: pytest.MonkeyPatch) -> _FakeStagesStore:
    stages = _FakeStagesStore()
    monkeypatch.setattr(backend_app, "stages_store", stages)
    monkeypatch.setattr(backend_app, "roles_store", _FakeRolesStore())
    return stages


@pytest.mark.asyncio
async def test_pipeline_list_returns_each_pipeline_with_its_own_stages(
    pipelines: _FakeStagesStore,
) -> None:
    result = await plan_mcp.pipeline_list(_host_ctx())

    assert result["active_pipeline_id"] == "maint"
    by_id = {pipeline["id"]: pipeline for pipeline in result["pipelines"]}
    assert set(by_id) == {"default", "maint"}
    assert by_id["maint"]["stages"] == []
    stage = by_id["default"]["stages"][0]
    assert stage["id"] == "plan"
    assert stage["short_title"] == "Plan"
    assert stage["recommended_roles"] == ["pm"]
    assert stage["slots"] == [
        {
            "agent_key": "claude",
            "role_key": "pm",
            "label": "Planner",
            "is_commander": True,
        }
    ]
    assert result["roles"] == [
        {
            "key": "pm",
            "label": "Product Manager",
            "one_line": "PRD, user stories",
            "is_default": True,
        }
    ]


@pytest.mark.asyncio
async def test_pipeline_list_never_returns_a_kickoff_body_or_a_system_prompt(
    pipelines: _FakeStagesStore,
) -> None:
    """Both are whole prompts. A dozen of them is more context than the answer
    they are attached to, and neither helps choose between pipelines."""
    result = await plan_mcp.pipeline_list(_host_ctx())

    assert "x" * 100 not in repr(result)
    assert "y" * 100 not in repr(result)


# ── D. pipeline_status ──────────────────────────────────────────────────────


class _FakeProjectStore:
    def __init__(self, projects: dict[str, Project]) -> None:
        self._projects = projects

    def peek(self, workspace_path: str) -> Project | None:
        return self._projects.get(workspace_path)

    def project_dir(self, workspace_path: str) -> Path:
        return Path(workspace_path) / ".agent-team"

    def project_file(self, workspace_path: str) -> Path:
        return self.project_dir(workspace_path) / "project.json"

    def log_file(self, workspace_path: str, name: str) -> Path:
        return self.project_dir(workspace_path) / name


def _running_project() -> Project:
    return Project(
        id="prj-1",
        name="alpha",
        workspace_path="/ws/alpha",
        created_at="2026-01-01T00:00:00Z",
        updated_at="2026-01-02T00:00:00Z",
        task_description="Add the login page",
        state="running",
        current_stage_index=1,
        total_stages=3,
        pipeline_id="default",
        run_count=2,
        log_file_name="runs/20260101-000000-task/pipeline.log",
        theme="dark-github",
        ui_spawn_history=[{"title": "some long renderer-owned history record"}],
        stages=[
            StageRecord(stage_id="plan", title="Planning", status="completed"),
            StageRecord(
                stage_id="build", title="Build", agent="claude", status="running"
            ),
        ],
        panes=[
            PaneRecord(
                pane_id="p-slot",
                agent="claude",
                role="backend",
                origin="pipeline",
                stage_id="build",
                stage_index=1,
                slot_label="Builder",
                spawn_status="spawned",
                kickoff_status="sent",
            ),
            PaneRecord(pane_id="p-hand", agent="codex", origin="manual"),
        ],
    )


@pytest.fixture
def projects(monkeypatch: pytest.MonkeyPatch) -> None:
    store = _FakeProjectStore({"/ws/alpha": _running_project()})
    monkeypatch.setattr(backend_app, "project_store", store)


@pytest.mark.asyncio
async def test_pipeline_status_for_a_workspace_with_no_project_is_an_empty_state(
    projects: None,
) -> None:
    """peek() creates nothing, so "never ran a pipeline here" has to read as an
    answer rather than an error — and rather than a project file written on the
    way past."""
    result = await plan_mcp.pipeline_status(_host_ctx(), workspace_path="/ws/beta")

    assert result == {"workspace_path": "/ws/beta", "active": False}


@pytest.mark.asyncio
async def test_pipeline_status_reports_the_run_and_only_its_pipeline_panes(
    projects: None,
) -> None:
    result = await plan_mcp.pipeline_status(_host_ctx(), workspace_path="/ws/alpha")

    assert result["workspace_path"] == "/ws/alpha"
    assert result["active"] is True
    assert result["state"] == "running"
    assert result["pipeline_id"] == "default"
    assert result["task_description"] == "Add the login page"
    assert (result["current_stage_index"], result["total_stages"]) == (1, 3)
    assert [stage["stage_id"] for stage in result["stages"]] == ["plan", "build"]
    assert result["stages"][1]["status"] == "running"
    # A pane the user opened by hand is not a slot of this run.
    assert [pane["pane_id"] for pane in result["panes"]] == ["p-slot"]
    assert result["panes"][0]["slot_label"] == "Builder"


@pytest.mark.asyncio
async def test_pipeline_status_leaves_the_renderers_ui_state_out(
    projects: None,
) -> None:
    """The stored project is mostly persisted UI state — themes, tab order,
    spawn history. Returning it whole would bury the two lines that answer the
    question."""
    result = await plan_mcp.pipeline_status(_host_ctx(), workspace_path="/ws/alpha")

    for key in ("theme", "ui_spawn_history", "ui_run_groups", "tab_order", "paths"):
        assert key not in result


@pytest.mark.asyncio
async def test_pipeline_status_defaults_to_the_calling_panes_workspace(
    projects: None,
) -> None:
    agent_messaging.register("pa", "reviewer", "/ws/alpha", agent_key="claude")

    result = await plan_mcp.pipeline_status(_ctx())

    assert result["workspace_path"] == "/ws/alpha"
    assert result["active"] is True


# ── E. skills_list ──────────────────────────────────────────────────────────


class _FakeSkillsStore:
    def __init__(self) -> None:
        self.targets_calls: list[str] = []

    def list_skills(self) -> dict[str, Any]:
        return {
            "skills": [
                {
                    "name": "verify",
                    "description": "How to drive this repo's surfaces",
                    "enabled": True,
                    "targets": None,
                    "managed": True,
                    "valid": True,
                    "native_conflict": False,
                    "path": "/skills/verify",
                    "revision": "abc",
                    "fields": {"name": "verify"},
                    "body": "z" * 4000,
                }
            ],
            "native": [
                {
                    "name": "notebooklm",
                    "description": "NotebookLM API",
                    "source": "claude",
                    "owner_agent": "claude",
                    "path": "~/.claude/skills/notebooklm",
                    "real_path": "/home/u/.claude/skills/notebooklm",
                    "aliases": [],
                    "valid": True,
                    "error": "",
                }
            ],
            "native_targets": {"/home/u/.claude/skills/notebooklm": ["codex"]},
            "root": "/home/u/.agents/skills",
            "write_consented": True,
            "agents": [{"key": "claude", "support": "wired"}],
        }

    def targets_for(self, agent_key: str) -> list[str]:
        self.targets_calls.append(agent_key)
        return ["verify"]

    def native_targets_for(self, agent_key: str) -> list[str]:
        return ["/home/u/.claude/skills/notebooklm"] if agent_key == "codex" else []


@pytest.fixture
def skills(monkeypatch: pytest.MonkeyPatch) -> _FakeSkillsStore:
    store = _FakeSkillsStore()
    monkeypatch.setattr(backend_app, "skills_store", store)
    return store


@pytest.mark.asyncio
async def test_skills_list_summarises_the_library_without_the_instructions(
    skills: _FakeSkillsStore,
) -> None:
    """A skill's body is the instructions themselves — read from its folder
    when the skill is used, never from a listing."""
    result = await plan_mcp.skills_list(_host_ctx())

    assert result["skills"] == [
        {
            "id": "shared:verify",
            "name": "verify",
            "description": "How to drive this repo's surfaces",
            "enabled": True,
            "targets": None,
            "managed": True,
            "valid": True,
            "native_conflict": False,
        }
    ]
    from agent_team_backend.plugins.builtin.navide_skills.skills_tools import skill_id

    assert result["native"] == [
        {
            "id": skill_id({"real_path": "/home/u/.claude/skills/notebooklm"}, native=True),
            "name": "notebooklm",
            "description": "NotebookLM API",
            "source": "claude",
            "owner_agent": "claude",
            "real_path": "/home/u/.claude/skills/notebooklm",
            "valid": True,
        }
    ]
    assert result["root"] == "/home/u/.agents/skills"
    assert result["agents"] == [{"key": "claude", "support": "wired"}]
    assert "z" * 100 not in repr(result)


@pytest.mark.asyncio
async def test_skills_list_marks_what_is_delivered_to_the_calling_pane(
    skills: _FakeSkillsStore,
) -> None:
    agent_messaging.register("pa", "reviewer", "/ws/alpha", agent_key="codex")

    result = await plan_mcp.skills_list(_ctx())

    assert result["delivered_to_me"] == {
        "agent_key": "codex",
        "skills": ["verify"],
        "native_paths": ["/home/u/.claude/skills/notebooklm"],
    }
    assert skills.targets_calls == ["codex"]


@pytest.mark.asyncio
async def test_skills_list_distinguishes_configuration_from_cli_loading(
    skills: _FakeSkillsStore,
) -> None:
    agent_messaging.register("pa", "reviewer", "/ws/alpha", agent_key="codex")

    result = await plan_mcp.skills_list(_ctx())

    assert result["configured_for_me"]["skills"] == ["verify"]
    assert result["configured_for_me"]["materialized_in_current_session"] is None
    assert result["configured_for_me"]["loaded_in_current_session"] is None
    assert result["configured_for_me"]["activation"] == "new_session"
    assert result["delivery_semantics"] == "configuration_only"
    assert result["skills"][0]["id"] == "shared:verify"
    assert result["native"][0]["id"].startswith("native:")


@pytest.mark.asyncio
async def test_skills_list_omits_delivery_for_a_caller_with_no_pane_identity(
    skills: _FakeSkillsStore,
) -> None:
    """A host or external caller is nobody's delivery target, so the "mine"
    half is absent rather than guessed at."""
    result = await plan_mcp.skills_list(_host_ctx())

    assert "delivered_to_me" not in result
    assert skills.targets_calls == []


# ── F. cli_message_log ──────────────────────────────────────────────────────


class _FakeMessageLog:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self._rows = rows
        self.tail_limits: list[int] = []

    def tail(self, limit: int = 500) -> list[dict[str, Any]]:
        self.tail_limits.append(limit)
        return [dict(row) for row in self._rows[-limit:]]


def _row(uid: str, sender: str, recipient: str, **extra: Any) -> dict[str, Any]:
    row: dict[str, Any] = {
        "uid": uid,
        "created_at": 1_700_000_000_000,
        "status": "delivered",
        "sender": sender,
        "recipient": recipient,
        "content": "  hello\n  there  ",
        "reason": None,
        "delivered_at": None,
        "remote": None,
        "remote_workspace": None,
        "sender_agent": "claude",
        "recipient_agent": "codex",
        "kind": None,
        "reply_to": None,
        "correlation_id": None,
    }
    row.update(extra)
    return row


@pytest.mark.asyncio
async def test_cli_message_log_returns_only_the_callers_own_messages(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Everybody's traffic shares one table. A pane may read its own half of it
    and nothing else."""
    agent_messaging.register("pa", "reviewer", "/ws/alpha", agent_key="claude")
    agent_messaging.register("pb", "builder", "/ws/alpha", agent_key="codex")
    log = _FakeMessageLog(
        [
            _row("m1", "reviewer", "builder"),
            _row("m2", "builder", "reviewer", correlation_id="k-2"),
            _row("m3", "builder", "someone-else"),
            _row("m4", "beta/remote", "alpha/reviewer", remote="dev-2"),
        ]
    )
    monkeypatch.setattr(backend_app, "agent_message_log", log)

    result = await plan_mcp.cli_message_log(_ctx())

    assert result["ok"] is True
    assert [message["uid"] for message in result["messages"]] == ["m1", "m2", "m4"]
    directions = {m["uid"]: m["direction"] for m in result["messages"]}
    assert directions == {"m1": "sent", "m2": "received", "m4": "received"}
    # Optional columns are present only when set, and content arrives flattened.
    assert result["messages"][1]["correlation_id"] == "k-2"
    assert "reason" not in result["messages"][0]
    assert result["messages"][0]["excerpt"] == "hello there"


@pytest.mark.asyncio
async def test_cli_message_log_clamps_the_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    agent_messaging.register("pa", "reviewer", "/ws/alpha", agent_key="claude")
    log = _FakeMessageLog(
        [_row(f"m{i}", "reviewer", "builder") for i in range(300)]
    )
    monkeypatch.setattr(backend_app, "agent_message_log", log)

    zero = await plan_mcp.cli_message_log(_ctx(), limit=0)
    assert zero["count"] == 1

    huge = await plan_mcp.cli_message_log(_ctx(), limit=9999)
    assert huge["count"] == 200
    assert huge["truncated"] is True
    # Newest last: the clamp keeps the tail, not the head.
    assert huge["messages"][-1]["uid"] == "m299"
    # The read that feeds the filter is bounded too.
    assert log.tail_limits == [500, 500]


@pytest.mark.asyncio
async def test_cli_message_log_refuses_a_caller_with_no_pane_identity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A host or external caller has no messaging name, so it can own no row —
    and must not be handed everyone else's."""
    log = _FakeMessageLog([_row("m1", "reviewer", "builder")])
    monkeypatch.setattr(backend_app, "agent_message_log", log)

    result = await plan_mcp.cli_message_log(_host_ctx())

    assert result["ok"] is False
    assert "messages" not in result
    assert log.tail_limits == []


# ── G. registration ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_the_inventory_tools_are_registered_with_their_declared_arguments() -> None:
    tools = {tool.name: tool for tool in await plan_mcp.server.list_tools()}
    assert set(tools) >= {
        "cli_usage",
        "workspace_list",
        "pipeline_list",
        "pipeline_status",
        "skills_list",
        "cli_message_log",
        "workspace_open",
        "workspace_switch",
    }
    # The Context parameter is injected, never asked of the agent.
    for name in ("workspace_open", "workspace_switch"):
        assert set(tools[name].inputSchema.get("properties") or {}) == {"path"}
    assert set(tools["cli_usage"].inputSchema.get("properties") or {}) == {"agent"}
    assert set(tools["pipeline_status"].inputSchema.get("properties") or {}) == {
        "workspace_path"
    }
    assert set(tools["cli_message_log"].inputSchema.get("properties") or {}) == {
        "limit"
    }
    for name in ("workspace_list", "pipeline_list", "skills_list"):
        assert not (tools[name].inputSchema.get("properties") or {})

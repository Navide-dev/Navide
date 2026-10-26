"""pipeline_start / pipeline_abort, plus the server's first resources and prompts.

Three surfaces, one theme: everything here is the protocol's own vocabulary
rather than another tool.

- The two pipeline tools ACT, and neither may act on its own. Running a
  pipeline is a renderer job — the backend's own handler writes the run record
  while the panes are spawned in the window — so a tool that took the short cut
  would leave a run that reads as started and did nothing. What is pinned is
  that both go out as UI actions, with the right name and the right args, and
  that a window which refuses is reported as a refusal.

- The resources are read-only views of what a tool already serves. What is
  pinned is that they are registered where a client will find them (a
  parameterless resource must stay a *concrete* resource — as a template it
  would never match its own uri and would be unreadable), and that the single
  plan resource cannot be walked out of the plans directory.

- The prompts are templates the user fills in and sends, so what is pinned is
  that the arguments actually reach the rendered text.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging
from agent_team_backend.fs_service import FsError
from agent_team_backend.mcp_server import auth as plan_mcp_auth
from agent_team_backend.mcp_server import server as plan_mcp
from agent_team_backend.mcp_server import wiring as plan_mcp_wiring
from agent_team_backend.plan_index import resolve_plan_root


@pytest.fixture(autouse=True)
def _clean_registry() -> Any:
    agent_messaging._reset_for_test()
    yield
    agent_messaging._reset_for_test()


@pytest.fixture(autouse=True)
def _host_approves_legacy_test_recovery(monkeypatch: pytest.MonkeyPatch) -> None:
    """The plan resources delegate to the plan tools, which route through the
    Host; with no window to answer, the tests must model its pre-dispatch
    verdict the same way the plan-tool tests do."""

    async def route(*args: Any, **kwargs: Any) -> dict[str, Any]:
        return {
            "ok": False,
            "error": {"code": "BACKEND_UNAVAILABLE", "message": "test pre-dispatch failure"},
            "recoveryDisposition": "legacy-safe-before-dispatch",
        }

    monkeypatch.setattr(plan_mcp, "request_host_agent_workspace_backend", route)


def _ctx(pane_id: str = "pa") -> Any:
    params = {"pane": pane_id, "t": plan_mcp_wiring.caller_token(pane_id)}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


def _external_ctx() -> Any:
    plan_mcp_auth.set_external_enabled(True)
    params = {"client": "external", "t": plan_mcp_auth.external_token()}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


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
            {"workspace_path": workspace_path, "op": op, "action": action, "args": args}
        )
        return {"ok": True, "result": {"state": "running"}, "error": None}

    monkeypatch.setattr(plan_mcp, "_ui_request", fake_ui_request)
    return calls


def _refusing_window(monkeypatch: pytest.MonkeyPatch, message: str) -> None:
    async def fake_ui_request(*args: Any, **kwargs: Any) -> dict[str, Any]:
        return {"ok": False, "result": None, "error": message, "error_code": "ui_action_failed"}

    monkeypatch.setattr(plan_mcp, "_ui_request", fake_ui_request)


# ── A. pipeline_start / pipeline_abort ──────────────────────────────────────


async def test_pipeline_start_asks_the_window_to_run_the_pipeline(
    tmp_path: Path, ui_calls: list[dict[str, Any]]
) -> None:
    agent_messaging.register("pa", "caller", str(tmp_path))

    result = await plan_mcp.pipeline_start(
        _ctx(), task="ship the thing", pipeline_id="pl-1"
    )

    assert result["ok"] is True
    assert ui_calls == [
        {
            "workspace_path": resolve_plan_root(str(tmp_path)),
            "op": "invoke",
            "action": "ui.pipeline.start",
            "args": {"task": "ship the thing", "pipelineId": "pl-1"},
        }
    ]


async def test_pipeline_start_leaves_out_a_pipeline_id_it_was_not_given(
    tmp_path: Path, ui_calls: list[dict[str, Any]]
) -> None:
    """An absent id means "the workspace's selected pipeline"; sending an empty
    one would name a pipeline that does not exist."""
    agent_messaging.register("pa", "caller", str(tmp_path))

    await plan_mcp.pipeline_start(_ctx(), task="ship the thing")

    assert ui_calls[0]["args"] == {"task": "ship the thing"}


async def test_pipeline_start_reports_a_window_that_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Nothing was spawned, so nothing may read as started."""
    agent_messaging.register("pa", "caller", str(tmp_path))
    _refusing_window(monkeypatch, "a pipeline is already running in this workspace")

    result = await plan_mcp.pipeline_start(_ctx(), task="ship the thing")

    assert result["ok"] is False
    assert "already running" in result["error"]


async def test_pipeline_abort_asks_the_window_to_stop_the_run(
    tmp_path: Path, ui_calls: list[dict[str, Any]]
) -> None:
    agent_messaging.register("pa", "caller", str(tmp_path))

    result = await plan_mcp.pipeline_abort(_ctx())

    assert result["ok"] is True
    assert ui_calls == [
        {
            "workspace_path": resolve_plan_root(str(tmp_path)),
            "op": "invoke",
            "action": "ui.pipeline.abort",
            "args": {},
        }
    ]


async def test_pipeline_abort_reports_a_window_that_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    agent_messaging.register("pa", "caller", str(tmp_path))
    _refusing_window(monkeypatch, "no pipeline is running in this workspace")

    result = await plan_mcp.pipeline_abort(_ctx())

    assert result["ok"] is False
    assert "no pipeline is running" in result["error"]


async def test_a_caller_with_no_pane_must_name_the_workspace_to_start_a_run(
    ui_calls: list[dict[str, Any]]
) -> None:
    """An external client has no own workspace; picking one would start a run
    in whichever project happened to be first."""
    with pytest.raises(FsError):
        await plan_mcp.pipeline_start(_external_ctx(), task="ship the thing")

    assert ui_calls == []


def test_starting_a_pipeline_gets_the_slow_timeout() -> None:
    """The action spawns every slot of the first stage before it answers, which
    on the default budget is reported as a window that never replied."""
    assert "ui.pipeline.start" in plan_mcp._UI_INVOKE_SLOW_ACTIONS


# ── B. Resources ────────────────────────────────────────────────────────────


def _plan_html(name: str) -> str:
    meta = (
        '{"name": "%s", "stage": "draft", "overview": "an overview", "todos": []}' % name
    )
    return (
        f"<h1>{name}</h1>\n"
        f'<script type="application/json" id="plan-meta">\n{meta}\n</script>\n'
    )


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    plans = tmp_path / ".agent-team" / "plans"
    plans.mkdir(parents=True)
    (plans / "alpha_ab12cd.html").write_text(_plan_html("Alpha"), encoding="utf-8")
    # Outside the plans subtree: the target a traversal would be reaching for.
    (tmp_path / ".agent-team" / "secret.html").write_text("secret", encoding="utf-8")
    return tmp_path


async def test_the_three_resources_are_registered() -> None:
    uris = {str(resource.uri) for resource in await plan_mcp.server.list_resources()}
    templates = {
        template.uriTemplate for template in await plan_mcp.server.list_resource_templates()
    }

    # The two parameterless ones must be CONCRETE resources. Declaring a
    # Context parameter on either would move it into `templates`, where a
    # parameterless uri never matches itself — the resource would simply be
    # unreadable, with "Unknown resource" as the only symptom.
    assert "navide://workspace/plans" in uris
    assert "navide://panes" in uris
    assert "navide://workspace/plan/{rel_path}" in templates


async def test_the_plans_resource_lists_the_workspaces_plans(
    workspace: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    agent_messaging.register("pa", "caller", str(workspace))
    monkeypatch.setattr(plan_mcp.server, "get_context", lambda: _ctx())

    answer = await plan_mcp.workspace_plans_resource()

    assert answer["workspace_path"] == resolve_plan_root(str(workspace))
    assert [plan["rel_path"] for plan in answer["plans"]] == [
        ".agent-team/plans/alpha_ab12cd.html"
    ]


async def test_the_panes_resource_serves_the_same_roster_as_the_tool(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    agent_messaging.register("pa", "caller", str(tmp_path))
    agent_messaging.register("pb", "other", str(tmp_path))
    monkeypatch.setattr(plan_mcp.server, "get_context", lambda: _ctx())

    assert await plan_mcp.panes_resource() == await plan_mcp.cli_list_targets(_ctx())


async def test_the_plan_resource_reads_one_document(workspace: Path) -> None:
    agent_messaging.register("pa", "caller", str(workspace))

    answer = await plan_mcp.workspace_plan_resource("alpha_ab12cd.html", _ctx())

    assert answer["rel_path"] == ".agent-team/plans/alpha_ab12cd.html"
    assert answer["meta"]["name"] == "Alpha"
    assert "<h1>Alpha</h1>" in answer["html"]


@pytest.mark.parametrize(
    "rel_path",
    [
        "../../../etc/passwd",
        # The form that actually survives a uri template segment: a resource
        # uri cannot carry a raw "/", so the escape arrives percent-encoded and
        # is decoded before it is resolved. Decoding is exactly what makes the
        # guard load-bearing rather than decorative.
        "..%2F..%2F..%2Fetc%2Fpasswd",
        "..%2Fsecret.html",
    ],
)
async def test_the_plan_resource_refuses_to_leave_the_plans_directory(
    workspace: Path, rel_path: str
) -> None:
    agent_messaging.register("pa", "caller", str(workspace))

    with pytest.raises(FsError):
        await plan_mcp.workspace_plan_resource(rel_path, _ctx())


# ── C. Prompts ──────────────────────────────────────────────────────────────


async def test_the_three_prompts_are_registered() -> None:
    prompts = {prompt.name: prompt for prompt in await plan_mcp.server.list_prompts()}

    assert set(prompts) >= {"delegate_to_pane", "start_pipeline", "review_plan"}
    assert [argument.name for argument in prompts["delegate_to_pane"].arguments or []] == [
        "target",
        "task",
    ]
    assert [argument.name for argument in prompts["start_pipeline"].arguments or []] == ["task"]
    assert [argument.name for argument in prompts["review_plan"].arguments or []] == ["rel_path"]


def _rendered(result: Any) -> str:
    return "\n".join(message.content.text for message in result.messages)


async def test_delegate_to_pane_renders_both_arguments() -> None:
    result = await plan_mcp.server.get_prompt(
        "delegate_to_pane", {"target": "worktree/scout", "task": "audit the reader"}
    )

    text = _rendered(result)
    assert "worktree/scout" in text
    assert "audit the reader" in text
    # It is an instruction to send, not a description of the tool.
    assert "cli_send" in text


async def test_start_pipeline_renders_the_task() -> None:
    result = await plan_mcp.server.get_prompt("start_pipeline", {"task": "migrate the store"})

    text = _rendered(result)
    assert "migrate the store" in text
    assert "pipeline_start" in text


async def test_review_plan_renders_the_document_path() -> None:
    result = await plan_mcp.server.get_prompt("review_plan", {"rel_path": "alpha_ab12cd.html"})

    text = _rendered(result)
    assert "alpha_ab12cd.html" in text
    assert "plan_add_note" in text

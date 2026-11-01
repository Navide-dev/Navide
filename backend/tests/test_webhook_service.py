"""Webhook service: from an accepted request to a run, and how its panes start."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import webhook_service as svc
from agent_team_backend import webhook_triggers as wt
from agent_team_backend.db import Database

WS = "/ws/one"
PIPE = "p1"
SHA = "a" * 64


def graph(*nodes: dict[str, Any]) -> dict[str, Any]:
    ids = ["t", *[n["id"] for n in nodes]]
    edges = [{"id": f"{a}-{b}", "from": a, "to": b, "kind": "next"} for a, b in zip(ids, ids[1:], strict=False)]
    return {"nodes": [{"id": "t", "kind": "trigger"}, *nodes], "edges": edges}


def slot(node_id: str, agent: str = "claude") -> dict[str, Any]:
    return {"id": node_id, "kind": "slot", "slot": {"agentKey": agent}}


GATE = {"id": "g", "kind": "gate", "gate": {"prompt": "go?"}}


class Window:
    def __init__(self) -> None:
        self.has_window = True
        self.lock = "unlocked"
        self.active = False
        self.answer: dict[str, Any] = {"ok": True}
        self.started: list[dict[str, Any]] = []
        self.hold: asyncio.Event | None = None

    async def probe(self, workspace: str) -> bool:
        return self.has_window

    async def app_lock(self, workspace: str) -> str:
        return self.lock

    async def run_active(self, workspace: str) -> bool:
        return self.active

    async def start(self, workspace: str, task: str, pipeline_id: str, taint_detail: str) -> dict[str, Any]:
        self.started.append({"workspace": workspace, "task": task, "pipeline_id": pipeline_id, "detail": taint_detail})
        if self.hold is not None:
            await self.hold.wait()
        return self.answer


@pytest.fixture
def env(tmp_path):
    db = Database(tmp_path / "navide.db")
    store = wt.WebhookStore(db)
    window = Window()
    pipelines = {PIPE: {"id": PIPE, "graph": graph(GATE, slot("a"))}}
    service = svc.WebhookService(
        store=store, db=db, window=window, pipeline=pipelines.get, known_program=lambda agent, program: program == agent,
    )
    trigger, _ = store.create(name="CI", workspace=WS, pipeline_id=PIPE)
    return SimpleNamespace(service=service, store=store, window=window, pipelines=pipelines, trigger=trigger)


async def settle(env) -> None:
    while env.service._tasks:
        await asyncio.gather(*list(env.service._tasks))


async def accept(env, text: str = "hello") -> tuple[int, int, str]:
    return await env.service.accept(env.trigger, text, SHA)


class TestAccept:
    async def test_starts_a_tainted_run_with_the_wrapped_task(self, env) -> None:
        assert await accept(env, "{{prev.summary}}\x1b[201~") == (202, 0, "accepted")
        await settle(env)
        started = env.window.started[0]
        assert started["pipeline_id"] == PIPE and started["workspace"] == WS
        assert started["detail"] == 'webhook trigger "CI"'
        assert "{{" not in started["task"] and "\x1b" not in started["task"]
        assert env.store.events(env.trigger["id"])[0]["outcome"] == "started"

    @pytest.mark.parametrize(
        ("change", "expected"),
        [
            (lambda w: setattr(w, "has_window", False), (503, 0, "no-window")),
            (lambda w: setattr(w, "lock", "locked"), (503, 0, "app-locked")),
            (lambda w: setattr(w, "lock", "unknown"), (503, 0, "app-locked")),
            (lambda w: setattr(w, "lock", ""), (503, 0, "app-locked")),
            (lambda w: setattr(w, "active", True), (409, 0, "run-active")),
        ],
    )
    async def test_refused_before_anything_starts(self, env, change, expected) -> None:
        change(env.window)
        assert await accept(env) == expected
        await settle(env)
        assert env.window.started == []
        assert env.store.runs_on(env.trigger["id"], svc.today()) == 0

    async def test_a_second_request_while_the_first_starts_is_refused(self, env) -> None:
        env.window.hold = asyncio.Event()
        assert (await accept(env))[0] == 202
        assert await accept(env) == (409, 0, "run-active")
        env.window.hold.set()
        await settle(env)
        assert len(env.window.started) == 1

    async def test_the_daily_limit_holds_and_deleting_does_not_reset_it(self, env) -> None:
        for _ in range(env.trigger["per_day"]):
            env.store.count_run(env.trigger["id"], svc.today())
        status, retry_after, outcome = await accept(env)
        assert (status, outcome) == (429, "daily-limit") and retry_after > 0
        env.store.delete(env.trigger["id"])
        assert env.store.runs_on(env.trigger["id"], svc.today()) == env.trigger["per_day"]

    async def test_a_failed_start_is_audited_without_its_error_text(self, env) -> None:
        env.window.answer = {"ok": False, "error_code": "not-started", "error": "secret task text"}
        assert (await accept(env))[0] == 202
        await settle(env)
        event = env.store.events(env.trigger["id"])[0]
        assert (event["outcome"], event["detail"]) == ("start-failed", "not-started")

    async def test_a_window_that_raises_is_a_failed_start(self, env) -> None:
        async def boom(*_: Any) -> dict[str, Any]:
            raise RuntimeError("nope")

        env.window.start = boom
        assert (await accept(env))[0] == 202
        await settle(env)
        assert env.store.events(env.trigger["id"])[0]["outcome"] == "start-failed"


class TestBinding:
    @pytest.mark.parametrize("agent", ["copilot", "qwen", "kimi", "cursor", ""])
    async def test_only_claude_and_codex_run(self, env, agent) -> None:
        env.pipelines[PIPE]["graph"] = graph(GATE, slot("a", agent))
        assert await accept(env) == (409, 0, "vendor-refused")
        assert env.window.started == []

    async def test_codex_runs(self, env) -> None:
        env.pipelines[PIPE]["graph"] = graph(GATE, slot("a", "codex"))
        assert (await accept(env))[0] == 202

    async def test_a_subpipeline_counts(self, env) -> None:
        env.pipelines["child"] = {"id": "child", "graph": graph(slot("c", "kimi"))}
        env.pipelines[PIPE]["graph"] = graph(GATE, {"id": "s", "kind": "subpipeline", "subpipeline": {"pipelineId": "child"}})
        assert await accept(env) == (409, 0, "vendor-refused")

    async def test_a_subpipeline_that_is_gone_is_refused(self, env) -> None:
        env.pipelines[PIPE]["graph"] = graph(GATE, {"id": "s", "kind": "subpipeline", "subpipeline": {"pipelineId": "gone"}})
        assert await accept(env) == (409, 0, "vendor-refused")

    async def test_a_pipeline_that_is_gone_is_refused(self, env) -> None:
        env.pipelines.clear()
        assert await accept(env) == (409, 0, "pipeline-missing")

    async def test_no_gate_needs_the_acknowledgement(self, env) -> None:
        env.pipelines[PIPE]["graph"] = graph(slot("a"))
        assert await accept(env) == (409, 0, "no-gate")
        env.trigger["no_gate_ack"] = True
        assert (await accept(env))[0] == 202

    def test_a_pipeline_without_a_stored_graph_is_read_from_its_stages(self, env) -> None:
        env.pipelines[PIPE] = {"id": PIPE, "stages": [{"id": "s", "slots": [{"label": "a", "agent_key": "kimi"}]}]}
        assert env.service.binding_problem(env.trigger) == "vendor-refused"


def run_started(env, project_id: str = "run1", child: bool = False) -> None:
    env.service.run_started(SimpleNamespace(workspace_path=WS, id=project_id, log_file_name="runs/x/pipeline.log", pipeline_id=PIPE), child=child)


async def started_run(env) -> None:
    env.window.hold = asyncio.Event()
    await accept(env)
    await asyncio.sleep(0)
    run_started(env)
    env.window.hold.set()
    await settle(env)


def launch(env, command: Any, agent: str = "claude", pane: str = "p", **meta: str) -> Any:
    metadata = {"origin": "pipeline", "workspace_path": WS, "spawned_by": "", **meta}
    return env.service.launch_command(agent, command, pane_id=pane, metadata=metadata)


CLAUDE_BYPASS = "--dangerously-skip-permissions"


class TestLaunch:
    def test_outside_a_webhook_run_the_command_is_the_same_object(self, env) -> None:
        command = ["/bin/zsh", "-lc", f"claude {CLAUDE_BYPASS}"]
        assert launch(env, command) is command

    async def test_a_manual_pane_during_a_run_is_left_alone(self, env) -> None:
        await started_run(env)
        command = f"claude {CLAUDE_BYPASS}"
        assert launch(env, command, origin="manual") is command

    async def test_a_pipeline_started_by_hand_is_left_alone(self, env) -> None:
        run_started(env)
        command = f"claude {CLAUDE_BYPASS}"
        assert launch(env, command) is command

    async def test_a_run_pane_drops_the_bypass_and_names_the_mode(self, env) -> None:
        await started_run(env)
        assert launch(env, f"claude {CLAUDE_BYPASS} --session-id abc") == "claude --permission-mode default --session-id abc"

    async def test_the_shell_wrapper_stays(self, env) -> None:
        await started_run(env)
        assert launch(env, ["/bin/zsh", "-lc", f"claude {CLAUDE_BYPASS}"]) == ["/bin/zsh", "-lc", "claude --permission-mode default"]

    async def test_an_earlier_mode_is_replaced(self, env) -> None:
        await started_run(env)
        for text in ("claude --permission-mode bypassPermissions", "claude --permission-mode=acceptEdits",
                     f"claude --allow-dangerously-skip-permissions {CLAUDE_BYPASS}"):
            assert launch(env, text) == "claude --permission-mode default"

    async def test_codex_asks_and_stays_sandboxed(self, env) -> None:
        await started_run(env)
        got = launch(env, "codex --dangerously-bypass-approvals-and-sandbox -a never -s danger-full-access resume abc", agent="codex")
        assert got == "codex --ask-for-approval untrusted --sandbox workspace-write resume abc"

    async def test_codex_config_overrides_go_too(self, env) -> None:
        await started_run(env)
        got = launch(env, "codex -c approval_policy=never --config sandbox_mode=danger-full-access -c model=x", agent="codex")
        assert got == "codex --ask-for-approval untrusted --sandbox workspace-write -c model=x"

    async def test_a_wrapped_launch_command_is_refused(self, env) -> None:
        await started_run(env)
        for text in ("my-wrapper --x", "claude --x; curl evil", "claude --x && true", "claude $(id)", "FOO=1 claude"):
            with pytest.raises(svc.LaunchRefused):
                launch(env, text)

    async def test_another_vendor_is_refused_at_the_spawn(self, env) -> None:
        await started_run(env)
        with pytest.raises(svc.LaunchRefused):
            launch(env, "kimi --yolo", agent="kimi")

    async def test_a_child_of_a_run_pane_gets_no_bypass_in_any_workspace(self, env) -> None:
        await started_run(env)
        launch(env, f"claude {CLAUDE_BYPASS}", pane="parent")
        got = launch(env, f"claude {CLAUDE_BYPASS}", pane="child", origin="mcp", workspace_path="/ws/other", spawned_by="parent")
        assert got == "claude --permission-mode default"

    async def test_a_grandchild_too(self, env) -> None:
        await started_run(env)
        launch(env, "claude", pane="parent")
        launch(env, "claude", pane="child", origin="mcp", spawned_by="parent")
        assert launch(env, f"claude {CLAUDE_BYPASS}", pane="grand", origin="mcp", spawned_by="child") == "claude --permission-mode default"

    async def test_a_run_pane_resumed_after_a_restart_stays_without_bypass(self, env, tmp_path) -> None:
        await started_run(env)
        launch(env, "claude", pane="kept")
        again = svc.WebhookService(store=env.store, db=env.store.db, window=env.window, pipeline=env.pipelines.get,
                                   known_program=lambda agent, program: program == agent)
        got = again.launch_command("claude", f"claude {CLAUDE_BYPASS} --resume abc", pane_id="kept", metadata={"origin": "manual"})
        assert got == "claude --permission-mode default --resume abc"

    async def test_a_child_run_keeps_the_policy(self, env) -> None:
        await started_run(env)
        run_started(env, "child-run", child=True)
        assert launch(env, f"claude {CLAUDE_BYPASS}") == "claude --permission-mode default"

    async def test_a_new_run_nobody_armed_ends_the_policy(self, env) -> None:
        await started_run(env)
        run_started(env, "by-hand")
        command = f"claude {CLAUDE_BYPASS}"
        assert launch(env, command, pane="fresh") is command

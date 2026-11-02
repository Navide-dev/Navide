"""Webhook service: from an accepted request to a run, and how its panes start."""

from __future__ import annotations

import asyncio
import sqlite3
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
        self.status: dict[str, Any] = {"active": True, "state": "running", "gate": {}}
        self.awaiting: set[str] = set()
        self.stuck: set[str] = set()
        self.calls: list[str] = []

    async def probe(self, workspace: str) -> bool:
        return self.has_window

    async def app_lock(self, workspace: str) -> str:
        return self.lock

    async def run_active(self, workspace: str) -> bool:
        return self.active

    async def run_status(self, workspace: str) -> dict[str, Any]:
        self.calls.append("status")
        return self.status

    async def pane_awaiting(self, workspace: str, pane_id: str) -> bool:
        return pane_id in self.awaiting

    async def abort(self, workspace: str) -> None:
        self.calls.append("abort")

    async def interrupt(self, workspace: str, pane_id: str) -> None:
        self.calls.append(f"interrupt {pane_id}")

    async def reclaim(self, workspace: str, pane_id: str) -> bool:
        self.calls.append(f"reclaim {pane_id}")
        return pane_id not in self.stuck

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
    @pytest.mark.parametrize("agent", ["codex", "copilot", "qwen", "kimi", "cursor", ""])
    async def test_only_claude_runs(self, env, agent) -> None:
        env.pipelines[PIPE]["graph"] = graph(GATE, slot("a", agent))
        assert await accept(env) == (409, 0, "vendor-refused")
        assert env.window.started == []

    async def test_claude_runs(self, env) -> None:
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

    async def test_codex_is_refused_at_the_spawn(self, env) -> None:
        await started_run(env)
        with pytest.raises(svc.LaunchRefused):
            launch(env, "codex", agent="codex")
        assert not env.service.is_run_pane("p")

    async def test_a_run_pane_cannot_open_codex(self, env) -> None:
        await started_run(env)
        launch(env, "claude", pane="parent")
        with pytest.raises(svc.LaunchRefused):
            launch(env, "codex", agent="codex", pane="child", origin="mcp", spawned_by="parent")

    def test_the_kept_codex_row_is_a_read_only_sandbox(self) -> None:
        got = svc._with_mode("codex", "codex --dangerously-bypass-approvals-and-sandbox -a never -s danger-full-access resume abc", unattended=False)
        assert got == "codex --ask-for-approval on-request --sandbox read-only resume abc"

    def test_the_kept_codex_row_drops_config_overrides(self) -> None:
        got = svc._with_mode("codex", "codex -c approval_policy=never --config sandbox_mode=danger-full-access -c model=x", unattended=False)
        assert got == "codex --ask-for-approval on-request --sandbox read-only -c model=x"

    async def test_a_wrapped_launch_command_is_refused(self, env) -> None:
        await started_run(env)
        for text in ("my-wrapper --x", "claude --x; curl evil", "claude --x && true", "claude $(id)", "FOO=1 claude"):
            with pytest.raises(svc.LaunchRefused):
                launch(env, text)

    async def test_it_knows_its_panes(self, env) -> None:
        await started_run(env)
        launch(env, "claude", pane="in")
        assert env.service.is_run_pane("in") and not env.service.is_run_pane("out")

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

    async def test_a_new_run_closes_one_the_watchdog_has_not_reached(self, env) -> None:
        await started_run(env)
        first = env.service._active[WS]["id"]
        await started_run(env)
        assert [run["id"] for run in env.store.open_runs()] != [first]
        assert len(env.store.open_runs()) == 1

    async def test_a_new_run_nobody_armed_ends_the_policy(self, env) -> None:
        await started_run(env)
        run_started(env, "by-hand")
        command = f"claude {CLAUDE_BYPASS}"
        assert launch(env, command, pane="fresh") is command


SESSION = "11111111-2222-3333-4444-555555555555"


def continued(env, pipeline_id: str = PIPE, frames: tuple[str, ...] = ()) -> None:
    """The run has ended; the record the window continues from says this."""
    env.service.finish_run(WS, "interrupted")
    stack = [{"run": {"pipeline_id": frame}} for frame in frames]
    env.service._project = lambda _: SimpleNamespace(workspace_path=WS, pipeline_id=pipeline_id, run_stack=stack)


class TestAPipelinePaneAfterTheRunEnded:
    """Resume, Start Over and restart-from-node all open new panes on the same
    task, which holds what the webhook sent, with no open run to claim them."""

    async def test_it_loses_the_bypass(self, env) -> None:
        await started_run(env)
        continued(env)
        assert launch(env, f"claude {CLAUDE_BYPASS}", pane="next") == "claude --permission-mode default"

    async def test_an_unattended_run_does_not_get_it_back(self, env, monkeypatch) -> None:
        monkeypatch.setattr(svc.guard_fail_closed, "unattended_supported", lambda: True)
        env.store.set_unattended(env.trigger["id"], True)
        await started_run(env)
        continued(env)
        assert launch(env, f"claude {CLAUDE_BYPASS}", pane="next") == "claude --permission-mode default"

    async def test_a_sub_pipeline_of_that_run_loses_it_too(self, env) -> None:
        await started_run(env)
        continued(env, pipeline_id="child", frames=(PIPE,))
        assert launch(env, f"claude {CLAUDE_BYPASS}", pane="next") == "claude --permission-mode default"

    async def test_the_pane_and_its_session_stay_the_runs(self, env) -> None:
        await started_run(env)
        continued(env)
        launch(env, f"claude --session-id {SESSION} {CLAUDE_BYPASS}", pane="next")
        assert env.service.is_run_pane("next")
        assert env.store.run_session(SESSION) is not None

    async def test_a_custom_command_is_refused_as_in_the_run(self, env) -> None:
        await started_run(env)
        continued(env)
        with pytest.raises(svc.LaunchRefused):
            launch(env, f"my-wrapper {CLAUDE_BYPASS} | tee log", pane="next")

    async def test_another_vendor_is_refused_as_in_the_run(self, env) -> None:
        await started_run(env)
        continued(env)
        with pytest.raises(svc.LaunchRefused):
            launch(env, "codex --dangerously-bypass-approvals-and-sandbox", agent="codex", pane="next")

    async def test_another_pipeline_in_that_workspace_is_left_alone(self, env) -> None:
        await started_run(env)
        continued(env, pipeline_id="other")
        command = f"claude {CLAUDE_BYPASS}"
        assert launch(env, command, pane="next") is command

    async def test_a_pane_opened_by_hand_is_left_alone(self, env) -> None:
        await started_run(env)
        continued(env)
        command = f"claude {CLAUDE_BYPASS}"
        assert launch(env, command, pane="next", origin="manual") is command

    async def test_it_is_still_the_rule_after_a_restart(self, env) -> None:
        await started_run(env)
        continued(env)
        again = svc.WebhookService(store=env.store, db=env.store.db, window=env.window, pipeline=env.pipelines.get,
                                   known_program=lambda agent, program: program == agent, project=env.service._project)
        got = again.launch_command("claude", f"claude {CLAUDE_BYPASS}", pane_id="next",
                                   metadata={"origin": "pipeline", "workspace_path": WS, "spawned_by": ""})
        assert got == "claude --permission-mode default"

    async def test_a_record_that_cannot_be_read_loses_the_bypass(self, env) -> None:
        await started_run(env)
        env.service.finish_run(WS, "interrupted")

        def broken(_: str) -> Any:
            raise OSError("no record")

        env.service._project = broken
        assert CLAUDE_BYPASS not in launch(env, f"claude {CLAUDE_BYPASS}", pane="next")

    async def test_a_lookup_that_fails_loses_the_bypass(self, env, monkeypatch) -> None:
        await started_run(env)
        continued(env)

        def broken(*_: Any) -> Any:
            raise sqlite3.OperationalError("locked")

        monkeypatch.setattr(env.store, "latest_run_of", broken)
        assert CLAUDE_BYPASS not in launch(env, f"claude {CLAUDE_BYPASS}", pane="next")


def restarted(env) -> Any:
    """The same store under a new service: what an app restart leaves."""
    return svc.WebhookService(store=env.store, db=env.store.db, window=env.window, pipeline=env.pipelines.get,
                              known_program=lambda agent, program: program == agent)


def reopen(service: Any, command: Any, pane: str = "new-id", workspace: str = WS, origin: str = "manual") -> Any:
    return service.launch_command("claude", command, pane_id=pane, metadata={"origin": origin, "workspace_path": workspace})


async def run_with_session(env, session: str = SESSION, unattended: bool = False) -> None:
    if unattended:
        env.store.set_unattended(env.trigger["id"], True)
        env.trigger = next(t for t in env.store.list() if t["id"] == env.trigger["id"])
    await started_run(env)
    launch(env, f"claude {CLAUDE_BYPASS} --session-id {session}", pane="first")


class TestResumedSession:
    """A restored pane has a new id: its session is what still names the run."""

    @pytest.mark.parametrize(
        "command",
        [
            f"claude {CLAUDE_BYPASS} --resume {SESSION}",
            f"claude --resume {SESSION} {CLAUDE_BYPASS}",
            f"claude {CLAUDE_BYPASS} --resume={SESSION}",
            f"claude {CLAUDE_BYPASS} -r {SESSION}",
            f"claude {CLAUDE_BYPASS} --session-id={SESSION}",
            f"claude {CLAUDE_BYPASS} --resume '{SESSION}'",
            f'claude {CLAUDE_BYPASS} --resume "{SESSION}"',
            ["/bin/zsh", "-ilc", f"claude --resume {SESSION} {CLAUDE_BYPASS}"],
            ["powershell.exe", "-NoLogo", "-Command", f"claude --resume {SESSION} {CLAUDE_BYPASS}"],
            f"bash -lc 'claude --resume {SESSION} {CLAUDE_BYPASS}'",
        ],
    )
    async def test_every_form_finds_the_session_after_a_restart(self, env, command) -> None:
        await run_with_session(env)
        again = restarted(env)
        got = reopen(again, command) if not str(command).startswith("bash") else None
        if got is None:
            # Not the plain standard command, so it is refused: still no bypass.
            with pytest.raises(svc.LaunchRefused):
                reopen(again, command)
            return
        assert CLAUDE_BYPASS not in str(got) and "--permission-mode default" in str(got)
        assert again.is_run_pane("new-id")

    async def test_a_powershell_call_operator_is_refused_not_passed(self, env) -> None:
        await run_with_session(env)
        with pytest.raises(svc.LaunchRefused):
            reopen(restarted(env), f"& 'claude' --resume {SESSION} {CLAUDE_BYPASS}")

    async def test_the_session_survives_the_run_ending(self, env) -> None:
        await run_with_session(env)
        env.service.finish_run(WS, "finished")
        got = reopen(restarted(env), f"claude {CLAUDE_BYPASS} --resume {SESSION}")
        assert got == f"claude --permission-mode default --resume {SESSION}"

    async def test_a_restart_while_the_run_is_live(self, env) -> None:
        await run_with_session(env)
        got = reopen(restarted(env), f"claude {CLAUDE_BYPASS} --resume {SESSION}", origin="pipeline")
        assert got == f"claude --permission-mode default --resume {SESSION}"

    async def test_a_rebuild_that_changes_the_account_is_the_same_resume(self, env) -> None:
        # Failover and account switches rebuild a pane under a new id; only this
        # gate stands in their way, and it needs nothing from them.
        await run_with_session(env)
        got = reopen(env.service, ["/bin/zsh", "-ilc", f"claude --resume {SESSION} {CLAUDE_BYPASS}"], pane="rebuilt")
        assert got == ["/bin/zsh", "-ilc", f"claude --permission-mode default --resume {SESSION}"]

    async def test_a_wake_from_a_channel_is_the_same_resume(self, env) -> None:
        await run_with_session(env)
        got = reopen(env.service, f"claude {CLAUDE_BYPASS} --resume {SESSION}", pane="woken", origin="mcp")
        assert got == f"claude --permission-mode default --resume {SESSION}"

    async def test_a_new_session_in_a_run_pane_is_recorded(self, env) -> None:
        await run_with_session(env)
        env.service.note_pane_session("first", "claude", "after-clear")
        got = reopen(restarted(env), f"claude {CLAUDE_BYPASS} --resume after-clear")
        assert got == "claude --permission-mode default --resume after-clear"

    async def test_a_session_of_another_pane_is_not_recorded(self, env) -> None:
        await run_with_session(env)
        env.service.note_pane_session("someone-else", "claude", "theirs")
        command = f"claude {CLAUDE_BYPASS} --resume theirs"
        assert reopen(env.service, command) is command

    async def test_a_new_resume_chain_is_recorded_too(self, env) -> None:
        await run_with_session(env)
        reopen(env.service, f"claude --resume {SESSION} --session-id forked {CLAUDE_BYPASS}")
        got = reopen(restarted(env), f"claude {CLAUDE_BYPASS} --resume forked", pane="third")
        assert got == "claude --permission-mode default --resume forked"

    async def test_rows_outlive_the_trigger_and_the_events(self, env) -> None:
        await run_with_session(env)
        env.service.finish_run(WS, "finished")
        env.store.delete(env.trigger["id"])
        for _ in range(3):
            env.service.audit([{"trigger_id": env.trigger["id"], "outcome": "accepted", "status": 202}])
        env.store.seen_recently(env.trigger["id"], "b" * 64, 10**12)
        assert env.store.run_session(SESSION) is not None
        got = reopen(restarted(env), f"claude {CLAUDE_BYPASS} --resume {SESSION}")
        assert got == f"claude --permission-mode default --resume {SESSION}"


class TestUnsureMeansNoBypass:
    @pytest.mark.parametrize(
        "command",
        [
            f"claude {CLAUDE_BYPASS} --continue",
            f"claude {CLAUDE_BYPASS} -c",
            f"claude {CLAUDE_BYPASS} --resume",
            f"claude --resume {CLAUDE_BYPASS}",
            f"claude {CLAUDE_BYPASS} -r",
            f"claude {CLAUDE_BYPASS} --resume=",
            f"claude {CLAUDE_BYPASS} --resume $ID",
            f"claude --permission-mode bypassPermissions --continue",
        ],
    )
    async def test_a_resume_it_cannot_name_in_a_workspace_with_runs(self, env, command) -> None:
        await run_with_session(env)
        again = restarted(env)
        got = reopen(again, command)
        assert CLAUDE_BYPASS not in got and "bypassPermissions" not in got
        assert not again.is_run_pane("new-id")

    async def test_the_same_commands_elsewhere_are_untouched(self, env) -> None:
        await run_with_session(env)
        command = f"claude {CLAUDE_BYPASS} --continue"
        assert reopen(env.service, command, workspace="/ws/other") is command

    async def test_no_workspace_counts_as_any_run(self, env) -> None:
        await run_with_session(env)
        got = reopen(env.service, f"claude {CLAUDE_BYPASS} --continue", workspace="")
        assert CLAUDE_BYPASS not in got

    async def test_a_trailing_slash_is_the_same_workspace(self, env) -> None:
        await run_with_session(env)
        assert CLAUDE_BYPASS not in reopen(env.service, f"claude {CLAUDE_BYPASS} --continue", workspace=WS + "/")

    async def test_without_a_bypass_it_stays_as_it_was(self, env) -> None:
        await run_with_session(env)
        command = "claude --continue"
        assert reopen(env.service, command) is command

    async def test_a_store_error_drops_the_bypass_and_trusts_no_run(self, env, monkeypatch, caplog) -> None:
        await run_with_session(env)

        def broken(*_: Any) -> None:
            raise sqlite3.OperationalError("disk I/O error")

        monkeypatch.setattr(env.store, "run_session", broken)
        with caplog.at_level("WARNING"):
            got = reopen(env.service, f"claude {CLAUDE_BYPASS} --resume {SESSION}")
        assert got == f"claude --resume {SESSION}"
        assert not env.service.is_run_pane("new-id")
        assert "webhook" in caplog.text

    async def test_a_store_error_leaves_a_command_without_a_bypass_alone(self, env, monkeypatch) -> None:
        def broken(*_: Any) -> None:
            raise sqlite3.OperationalError("disk I/O error")

        monkeypatch.setattr(env.store, "run_session", broken)
        command = f"claude --resume {SESSION}"
        assert reopen(env.service, command) is command

    def test_a_service_that_failed_to_start_drops_a_resume_bypass(self) -> None:
        assert svc.without_bypass("claude", f"claude {CLAUDE_BYPASS} --resume {SESSION}") == f"claude --resume {SESSION}"
        assert svc.without_bypass("claude", ["/bin/zsh", "-ilc", f"claude {CLAUDE_BYPASS} -c"]) == ["/bin/zsh", "-ilc", "claude -c"]

    def test_that_leaves_new_panes_and_other_vendors_alone(self) -> None:
        for agent, command in (("claude", f"claude {CLAUDE_BYPASS} --session-id x"), ("codex", "codex --yolo resume x")):
            assert svc.without_bypass(agent, command) is command

    def test_the_window_hears_only_of_a_bypass_that_was_really_taken_away(self) -> None:
        kept = f"claude {CLAUDE_BYPASS} -c"
        assert svc.bypass_dropped_from(kept, "claude -c") == "claude -c"
        assert svc.bypass_dropped_from(["/bin/zsh", "-ilc", kept], ["/bin/zsh", "-ilc", "claude -c"]) == "claude -c"
        assert svc.bypass_dropped_from(kept, kept) == ""
        assert svc.bypass_dropped_from("claude -c", "claude -c") == ""


class TestUnattendedOnEveryPath:
    @pytest.fixture(autouse=True)
    def posix(self, monkeypatch) -> None:
        monkeypatch.setattr(svc.guard_fail_closed, "unattended_supported", lambda: True)

    async def test_a_session_keeps_it_while_the_trigger_does(self, env) -> None:
        await run_with_session(env, unattended=True)
        again = restarted(env)
        got = reopen(again, f"claude {CLAUDE_BYPASS} --resume {SESSION}")
        assert got == f"claude {CLAUDE_BYPASS} --resume {SESSION}"
        assert again.launch_env("new-id")

    @pytest.mark.parametrize("change", ["off", "deleted"])
    @pytest.mark.parametrize("path", ["session", "pane", "active"])
    async def test_it_ends_when_the_trigger_stops_being_unattended(self, env, change, path) -> None:
        await run_with_session(env, unattended=True)
        if change == "off":
            env.store.set_unattended(env.trigger["id"], False)
        else:
            env.store.delete(env.trigger["id"])
        again = restarted(env)
        if path == "session":
            got = reopen(again, f"claude {CLAUDE_BYPASS} --resume {SESSION}")
            pane = "new-id"
        elif path == "pane":
            got = reopen(again, f"claude {CLAUDE_BYPASS} --resume {SESSION}", pane="first")
            pane = "first"
        else:
            got = reopen(again, f"claude {CLAUDE_BYPASS}", pane="next-stage", origin="pipeline")
            pane = "next-stage"
        assert CLAUDE_BYPASS not in got and "--permission-mode default" in got
        assert again.launch_env(pane) == {}

    async def test_a_child_never_had_it(self, env) -> None:
        await run_with_session(env, unattended=True)
        got = launch(env, f"claude {CLAUDE_BYPASS}", pane="child", origin="mcp", spawned_by="first")
        assert got == "claude --permission-mode default"


class TestNeverUsed:
    def test_a_resume_with_no_webhook_history_is_the_same_object(self, env) -> None:
        for command in (f"claude {CLAUDE_BYPASS} --resume {SESSION}", f"claude {CLAUDE_BYPASS} --continue",
                        ["/bin/zsh", "-ilc", f"claude {CLAUDE_BYPASS} --session-id {SESSION}"]):
            assert reopen(env.service, command) is command
        assert not env.service.is_run_pane("new-id")


class TestKickoffFailure:
    async def test_a_run_reported_started_records_the_failure(self, env) -> None:
        await started_run(env)
        env.service.note_kickoff_failed(WS)
        latest = env.store.events(env.trigger["id"])[0]
        assert (latest["outcome"], latest["detail"]) == ("start-failed", "kickoff")

    async def test_while_starting_only_the_start_reports_it(self, env) -> None:
        env.window.hold = asyncio.Event()
        await accept(env)
        await asyncio.sleep(0)
        run_started(env)
        env.service.note_kickoff_failed(WS)
        assert "kickoff" not in [e["detail"] for e in env.store.events(env.trigger["id"])]
        env.window.hold.set()
        await settle(env)

    def test_a_workspace_with_no_webhook_run_records_nothing(self, env) -> None:
        env.service.note_kickoff_failed("/ws/other")
        assert env.store.events(env.trigger["id"]) == []


class Clock:
    def __init__(self, env, monkeypatch) -> None:
        self.now = 1_000_000.0
        env.service._clock = lambda: self.now
        monkeypatch.setattr(svc, "SETTLE_S", 0)


@pytest.fixture
async def watched(env, monkeypatch):
    await started_run(env)
    launch(env, "claude", pane="p")
    clock = Clock(env, monkeypatch)
    run = next(iter(env.service._active.values()))
    run["started_at"] = clock.now
    return SimpleNamespace(env=env, clock=clock, run=run)


def outcomes(env) -> list[str]:
    return [e["outcome"] for e in env.store.events(env.trigger["id"])]


class TestWatchdog:
    async def test_a_working_run_is_left_alone(self, watched) -> None:
        await watched.env.service.tick()
        watched.clock.now += 60 * 60
        await watched.env.service.tick()
        assert "abort" not in watched.env.window.calls

    async def test_a_gate_nobody_answers_stops_the_run_and_approves_nothing(self, watched) -> None:
        env, clock = watched.env, watched.clock
        env.window.status["gate"] = {"nodeId": "g"}
        await env.service.tick()
        assert "awaiting-approval" in outcomes(env)
        clock.now += 30 * 60 - 1
        await env.service.tick()
        assert "abort" not in env.window.calls
        clock.now += 1
        await env.service.tick()
        calls = [c for c in env.window.calls if c != "status"]
        assert calls == ["abort", "interrupt p", "reclaim p"]
        assert "approval-timeout" in outcomes(env) and env.service._active == {}

    async def test_a_pane_at_a_prompt_counts_too(self, watched) -> None:
        env, clock = watched.env, watched.clock
        env.window.awaiting = {"p"}
        await env.service.tick()
        clock.now += 30 * 60
        await env.service.tick()
        assert "abort" in env.window.calls

    async def test_every_new_wait_counts_from_its_own_start(self, watched) -> None:
        env, clock = watched.env, watched.clock
        env.window.awaiting = {"p"}
        await env.service.tick()
        clock.now += 29 * 60
        env.window.awaiting = set()
        await env.service.tick()
        env.window.awaiting = {"p"}
        await env.service.tick()
        clock.now += 29 * 60
        await env.service.tick()
        assert "abort" not in env.window.calls

    async def test_the_trigger_sets_the_wait(self, watched) -> None:
        env, clock = watched.env, watched.clock
        short, _ = env.store.create(name="short", workspace=WS, pipeline_id=PIPE, approval_timeout_min=5)
        watched.run["trigger_id"] = short["id"]
        env.window.awaiting = {"p"}
        await env.service.tick()
        clock.now += 5 * 60
        await env.service.tick()
        assert "abort" in env.window.calls

    async def test_a_run_has_a_cap_whatever_it_does(self, watched) -> None:
        watched.clock.now += svc.RUN_CAP_S
        await watched.env.service.tick()
        assert "run-timeout" in outcomes(watched.env) and "abort" in watched.env.window.calls

    async def test_a_pane_that_will_not_free_is_reported(self, watched) -> None:
        env = watched.env
        env.window.stuck = {"p"}
        env.window.awaiting = {"p"}
        await env.service.tick()
        watched.clock.now += 30 * 60
        await env.service.tick()
        assert any(e["detail"] == "1 pane(s) not reclaimed" for e in env.store.events(env.trigger["id"]))

    async def test_a_finished_run_closes_without_a_word(self, watched) -> None:
        env = watched.env
        env.window.status = {"active": False, "state": "completed"}
        await env.service.tick()
        assert env.service._active == {} and env.store.open_runs() == []
        assert "abort" not in env.window.calls

    async def test_an_interrupted_run_is_recorded_and_not_resumed(self, watched) -> None:
        env = watched.env
        env.window.status = {"active": False, "state": "interrupted"}
        await env.service.tick()
        assert "interrupted" in outcomes(env) and "abort" not in env.window.calls

    async def test_a_restart_rebuilds_the_watch_from_the_table(self, watched) -> None:
        env = watched.env
        again = svc.WebhookService(store=env.store, db=env.store.db, window=env.window, pipeline=env.pipelines.get,
                                   known_program=lambda agent, program: program == agent)
        assert WS in again._active

    async def test_one_failing_tick_does_not_end_the_loop(self, env, monkeypatch) -> None:
        monkeypatch.setattr(svc, "WATCH_EVERY_S", 0)
        ticks: list[int] = []

        async def tick() -> None:
            ticks.append(1)
            if len(ticks) == 1:
                raise RuntimeError("boom")

        env.service.tick = tick
        env.service.start_watchdog()
        while len(ticks) < 3:
            await asyncio.sleep(0)
        await env.service.stop_watchdog()


def test_the_wait_has_bounds(env) -> None:
    for minutes in (4, 241):
        with pytest.raises(wt.WebhookInvalid):
            env.store.create(name="x", workspace=WS, pipeline_id=PIPE, approval_timeout_min=minutes)


class TestUnattended:
    @pytest.fixture(autouse=True)
    def posix(self, monkeypatch) -> None:
        monkeypatch.setattr(svc.guard_fail_closed, "unattended_supported", lambda: True)

    async def run(self, env) -> None:
        env.store.set_unattended(env.trigger["id"], True)
        env.trigger["unattended"] = True
        await started_run(env)

    async def test_off_by_default(self, env) -> None:
        assert env.trigger["unattended"] is False
        await started_run(env)
        launch(env, "claude")
        assert env.service.launch_env("p") == {}

    async def test_a_run_pane_gets_the_bypass_and_the_variable(self, env) -> None:
        await self.run(env)
        assert launch(env, "claude --session-id a") == "claude --dangerously-skip-permissions --session-id a"
        assert env.service.launch_env("p") == {svc.guard_fail_closed.ENV: "1"}

    async def test_codex_never_gets_the_variable(self, env) -> None:
        await self.run(env)
        with pytest.raises(svc.LaunchRefused):
            launch(env, "codex", agent="codex")
        assert env.service.launch_env("p") == {}

    async def test_a_child_gets_neither(self, env) -> None:
        await self.run(env)
        launch(env, "claude", pane="parent")
        got = launch(env, f"claude {CLAUDE_BYPASS}", pane="child", origin="mcp", spawned_by="parent")
        assert got == "claude --permission-mode default"
        assert env.service.launch_env("child") == {}

    async def test_a_pane_outside_the_run_gets_neither(self, env) -> None:
        await self.run(env)
        assert launch(env, "claude", pane="other", origin="manual") == "claude"
        assert env.service.launch_env("other") == {}

    async def test_a_resume_after_a_restart_keeps_the_mode(self, env) -> None:
        await self.run(env)
        launch(env, "claude", pane="kept")
        again = svc.WebhookService(store=env.store, db=env.store.db, window=env.window, pipeline=env.pipelines.get,
                                   known_program=lambda agent, program: program == agent)
        assert again.launch_env("kept") == {svc.guard_fail_closed.ENV: "1"}

    async def test_where_it_is_not_supported_the_run_asks(self, env, monkeypatch) -> None:
        monkeypatch.setattr(svc.guard_fail_closed, "unattended_supported", lambda: False)
        await self.run(env)
        assert launch(env, "claude") == "claude --permission-mode default"

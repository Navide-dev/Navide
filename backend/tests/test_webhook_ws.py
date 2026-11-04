"""The window's webhook.* messages, the listener's lifecycle, and what stays
exactly as it was while nobody uses any of this."""

from __future__ import annotations

import asyncio
import json
import socket
import threading
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import app as app_module
from agent_team_backend import webhook_payload, webhook_service, webhook_triggers, webhook_ws, ws_handlers
from agent_team_backend.db import Database
from agent_team_backend.projects import ProjectStore

from .test_webhook_service import GATE, PIPE, WS, Window, graph, slot


class Session:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


async def call(message: str, /, **payload: Any) -> dict[str, Any]:
    session = Session()
    await webhook_ws.HANDLERS[message](session, "id", message, payload)
    return session.sent[-1]


def listener_threads() -> list[threading.Thread]:
    return [t for t in threading.enumerate() if t.name == "webhook-listener"]


def port_open(port: int) -> bool:
    with socket.socket() as probe:
        probe.settimeout(0.5)
        return probe.connect_ex(("127.0.0.1", port)) == 0


@pytest.fixture
async def env(tmp_path, monkeypatch):
    db = Database(tmp_path / "navide.db")
    monkeypatch.setattr(app_module, "database", db)
    monkeypatch.setattr(webhook_ws, "_guard_on", lambda: True)
    store = webhook_triggers.WebhookStore(db)
    pipelines = {PIPE: {"id": PIPE, "graph": graph(GATE, slot("a"))}}
    service = webhook_service.WebhookService(
        store=store, db=db, window=Window(), pipeline=pipelines.get, known_program=lambda agent, program: program == agent,
    )
    webhook_service.configure(service)
    yield service
    await webhook_ws.shutdown()


async def enabled_trigger() -> str:
    await call("webhook.settings.set", enabled=True)
    created = await call("webhook.trigger.create", name="CI", workspace_path=WS, pipeline_id=PIPE)
    trigger_id = created["payload"]["trigger"]["id"]
    assert (await call("webhook.trigger.enable", id=trigger_id, enabled=True))["ok"]
    return trigger_id


class TestLifecycle:
    async def test_nothing_listens_by_default(self, env) -> None:
        await webhook_ws.reconcile()
        status = (await call("webhook.status"))["payload"]
        assert status["listening"] is False and status["port"] == 0 and listener_threads() == []

    async def test_a_trigger_without_the_switch_does_not_listen(self, env) -> None:
        created = await call("webhook.trigger.create", name="CI", workspace_path=WS, pipeline_id=PIPE)
        await call("webhook.trigger.enable", id=created["payload"]["trigger"]["id"], enabled=True)
        assert listener_threads() == []

    async def test_the_switch_without_a_trigger_does_not_listen(self, env) -> None:
        await call("webhook.settings.set", enabled=True)
        assert listener_threads() == []

    async def test_listens_only_while_wanted_and_keeps_its_port(self, env) -> None:
        trigger_id = await enabled_trigger()
        port = (await call("webhook.status"))["payload"]["port"]
        assert port and port_open(port)
        await call("webhook.trigger.enable", id=trigger_id, enabled=False)
        assert not port_open(port) and listener_threads() == []
        await call("webhook.trigger.enable", id=trigger_id, enabled=True)
        assert (await call("webhook.status"))["payload"]["port"] == port

    async def test_a_taken_port_is_an_error_not_another_port(self, env) -> None:
        with socket.socket() as taken:
            taken.bind(("127.0.0.1", 0))
            taken.listen()
            port = taken.getsockname()[1]
            webhook_triggers.save_listener_settings(app_module.database, enabled=True, port=port, public_host="", now=1)
            created = await call("webhook.trigger.create", name="CI", workspace_path=WS, pipeline_id=PIPE)
            await call("webhook.trigger.enable", id=created["payload"]["trigger"]["id"], enabled=True)
            status = (await call("webhook.status"))["payload"]
        assert status["listening"] is False and str(port) in status["error"]
        assert status["settings"]["port"] == port

    async def test_shutdown_frees_the_port(self, env) -> None:
        await enabled_trigger()
        port = (await call("webhook.status"))["payload"]["port"]
        await webhook_ws.shutdown()
        assert not port_open(port)


def flaky_start(monkeypatch, failures: int) -> list[int]:
    """The listener's start fails `failures` times, as on a first launch that
    did not get the CPU within START_TIMEOUT_S, then starts for real."""
    calls: list[int] = []
    real = webhook_ws.webhook_listener.WebhookListener.start

    def start(self) -> None:
        calls.append(1)
        if len(calls) <= failures:
            raise webhook_ws.webhook_listener.ListenerError("the webhook listener did not start")
        real(self)

    monkeypatch.setattr(webhook_ws.webhook_listener.WebhookListener, "start", start)
    return calls


async def settled(predicate, timeout: float = 5.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while not predicate():
        assert asyncio.get_running_loop().time() < deadline, "never settled"
        await asyncio.sleep(0.01)


class TestStartRetry:
    """A listener that failed to start is tried again, and says so meanwhile.
    VM 0.2.37: the first AppImage launch missed the start deadline once and the
    listener stayed off until the app was restarted."""

    async def test_a_failed_start_is_retried_until_it_listens(self, env, monkeypatch) -> None:
        # The first wait is long enough for the status read below on a slow
        # runner (Windows arm64 read it after both 0.05 s waits had run out).
        monkeypatch.setattr(webhook_ws, "RETRY_DELAYS_S", (0.5, 0.05, 0.05), raising=False)
        calls = flaky_start(monkeypatch, failures=2)
        await enabled_trigger()
        status = (await call("webhook.status"))["payload"]
        assert status["listening"] is False and "did not start" in status["error"]
        assert status["retry"]["attempt"] >= 1 and status["retry"]["max"] == 4
        await settled(lambda: webhook_ws._listener is not None)
        status = (await call("webhook.status"))["payload"]
        assert status["listening"] is True and status["error"] == "" and status["retry"] is None
        assert port_open(status["port"]) and len(calls) == 3

    async def test_the_status_reports_the_retry_while_it_runs(self, env, monkeypatch) -> None:
        # Windows arm64 CI: a status read during the retry's own start attempt
        # showed the failure with retry None, as if no retry were coming.
        monkeypatch.setattr(webhook_ws, "RETRY_DELAYS_S", (0.01, 0.01, 0.01), raising=False)
        seen: list[bool] = []
        real = webhook_ws.webhook_listener.WebhookListener.start

        def start(self) -> None:
            seen.append(webhook_ws._retry_task is not None)
            if len(seen) == 1:
                raise webhook_ws.webhook_listener.ListenerError("the webhook listener did not start")
            real(self)

        monkeypatch.setattr(webhook_ws.webhook_listener.WebhookListener, "start", start)
        await enabled_trigger()
        await settled(lambda: webhook_ws._listener is not None)
        assert seen == [False, True]
        assert webhook_ws._retry_task is None

    async def test_retries_stop_at_the_limit_and_every_failure_is_logged(self, env, monkeypatch, caplog) -> None:
        monkeypatch.setattr(webhook_ws, "RETRY_DELAYS_S", (0.01, 0.01), raising=False)
        calls = flaky_start(monkeypatch, failures=99)
        with caplog.at_level("WARNING", logger=webhook_ws.log.name):
            await enabled_trigger()
            await settled(lambda: len(calls) == 3 and webhook_ws._retry_task is None)
            await asyncio.sleep(0.1)
        assert len(calls) == 3
        status = (await call("webhook.status"))["payload"]
        assert status["listening"] is False and "did not start" in status["error"] and status["retry"] is None
        failures = [r.getMessage() for r in caplog.records if "did not start" in r.getMessage()]
        assert len(failures) == 3 and "attempt 1 of 3" in failures[0] and "attempt 3 of 3" in failures[-1]

    async def test_turning_webhooks_off_cancels_a_pending_retry(self, env, monkeypatch) -> None:
        monkeypatch.setattr(webhook_ws, "RETRY_DELAYS_S", (60.0,), raising=False)
        calls = flaky_start(monkeypatch, failures=99)
        await enabled_trigger()
        assert (await call("webhook.status"))["payload"]["retry"]["attempt"] == 1
        await call("webhook.settings.set", enabled=False)
        status = (await call("webhook.status"))["payload"]
        assert status["retry"] is None and status["error"] == "" and webhook_ws._retry_task is None
        assert len(calls) == 1

    async def test_a_timed_out_listener_is_not_left_holding_the_port(self, env, monkeypatch) -> None:
        """The thread of a start that timed out is still stuck when the retry
        comes: the retry gets the same port, and turning webhooks off frees it."""
        from .test_webhook_listener import free_port, stall_listener_thread

        port = free_port()
        webhook_triggers.save_listener_settings(app_module.database, enabled=False, port=port, public_host="", now=1)
        monkeypatch.setattr(webhook_ws, "RETRY_DELAYS_S", (0.05, 0.05), raising=False)
        release = stall_listener_thread(monkeypatch, times=1)
        try:
            await enabled_trigger()
            await settled(lambda: webhook_ws._listener is not None)
            assert webhook_ws._listener.port == port and port_open(port)
            await call("webhook.settings.set", enabled=False)
            assert not port_open(port)
        finally:
            release.set()
        await settled(lambda: listener_threads() == [])
        assert not port_open(port)

    async def test_shutdown_cancels_a_pending_retry(self, env, monkeypatch) -> None:
        monkeypatch.setattr(webhook_ws, "RETRY_DELAYS_S", (60.0,), raising=False)
        flaky_start(monkeypatch, failures=99)
        await enabled_trigger()
        task = webhook_ws._retry_task
        assert task is not None
        await webhook_ws.shutdown()
        await asyncio.gather(task, return_exceptions=True)
        assert task.cancelled() and webhook_ws._retry_task is None


def gated_start(monkeypatch, failures: int = 0) -> tuple[threading.Event, threading.Event, threading.Event]:
    """The listener's start, after `failures` failed ones, waits for `gate`
    before it binds: `entered` once it waits, `done` once it has started."""
    entered, gate, done = threading.Event(), threading.Event(), threading.Event()
    calls: list[int] = []
    real = webhook_ws.webhook_listener.WebhookListener.start

    def start(self) -> None:
        calls.append(1)
        if len(calls) <= failures:
            raise webhook_ws.webhook_listener.ListenerError("the webhook listener did not start")
        entered.set()
        gate.wait(10)
        real(self)
        done.set()

    monkeypatch.setattr(webhook_ws.webhook_listener.WebhookListener, "start", start)
    return entered, gate, done


class TestShutdownDuringStart:
    """Review of 0.2.37: a shutdown that cancels a start in flight left the
    listener that start went on to bring up untracked, holding its port."""

    async def shut_down_while_starting(self, entered, gate, done, port) -> None:
        await settled(entered.is_set)
        closing = asyncio.create_task(webhook_ws.shutdown())
        await asyncio.sleep(0.05)
        gate.set()
        await closing
        await settled(done.is_set)
        await asyncio.sleep(0.05)
        assert not port_open(port)
        await settled(lambda: listener_threads() == [])

    async def test_a_first_start_cut_off_by_shutdown_is_stopped(self, env, monkeypatch) -> None:
        from .test_webhook_listener import free_port

        port = free_port()
        webhook_triggers.save_listener_settings(app_module.database, enabled=False, port=port, public_host="", now=1)
        await enabled_trigger()
        await webhook_ws.shutdown()
        monkeypatch.setattr(webhook_service.WebhookService, "start_watchdog", lambda _: None)
        entered, gate, done = gated_start(monkeypatch)
        try:
            await webhook_ws.startup()
            await self.shut_down_while_starting(entered, gate, done, port)
        finally:
            gate.set()

    async def test_a_retry_cut_off_by_shutdown_is_stopped(self, env, monkeypatch) -> None:
        from .test_webhook_listener import free_port

        port = free_port()
        webhook_triggers.save_listener_settings(app_module.database, enabled=False, port=port, public_host="", now=1)
        monkeypatch.setattr(webhook_ws, "RETRY_DELAYS_S", (0.01,), raising=False)
        entered, gate, done = gated_start(monkeypatch, failures=1)
        try:
            await enabled_trigger()
            await self.shut_down_while_starting(entered, gate, done, port)
        finally:
            gate.set()


class TestRefusals:
    async def test_guard_off_refuses_both_switches(self, env, monkeypatch) -> None:
        created = await call("webhook.trigger.create", name="CI", workspace_path=WS, pipeline_id=PIPE)
        monkeypatch.setattr(webhook_ws, "_guard_on", lambda: False)
        for name, args in (("webhook.settings.set", {"enabled": True}),
                           ("webhook.trigger.enable", {"id": created["payload"]["trigger"]["id"], "enabled": True})):
            answer = await call(name, **args)
            assert answer["ok"] is False and answer["error"]["code"] == "GUARD_OFF"

    async def test_enabling_a_refused_binding_says_why(self, env, monkeypatch) -> None:
        created = await call("webhook.trigger.create", name="CI", workspace_path=WS, pipeline_id=PIPE)
        monkeypatch.setattr(env, "_pipeline", {PIPE: {"id": PIPE, "graph": graph(GATE, slot("a", "kimi"))}}.get)
        answer = await call("webhook.trigger.enable", id=created["payload"]["trigger"]["id"], enabled=True)
        assert answer["error"]["code"] == "BINDING_REFUSED" and answer["error"]["details"]["reason"] == "vendor-refused"
        assert env.store.snapshot() == {}

    async def test_a_public_host_must_be_a_hostname(self, env) -> None:
        assert (await call("webhook.settings.set", enabled=False, public_host="http://x/y"))["ok"] is False

    async def test_an_unknown_trigger(self, env) -> None:
        for name in ("webhook.trigger.rotate", "webhook.trigger.delete"):
            assert (await call(name, id="nope"))["error"]["code"] == "NOT_FOUND"
        assert (await call("webhook.trigger.enable", id="nope", enabled=True))["error"]["code"] == "NOT_FOUND"

    async def test_going_without_the_gate_is_audited(self, env) -> None:
        created = await call("webhook.trigger.create", name="CI", workspace_path=WS, pipeline_id=PIPE, no_gate_ack=True)
        rows = env.store.events(created["payload"]["trigger"]["id"])
        assert [r["outcome"] for r in rows] == ["no-gate-acknowledged"]


class TestSessionNotes:
    async def test_the_app_passes_a_run_panes_new_session_on(self, env) -> None:
        run = env.store.open_run(trigger_id="t", workspace=WS, project_id="p", pipeline_id=PIPE, unattended=False)
        env.store.add_run_pane("pane", run["id"], False)
        webhook_service.configure(webhook_service.WebhookService(
            store=env.store, db=env.store.db, window=Window(), pipeline=lambda _: None, known_program=lambda *_: True,
        ))
        app_module._note_webhook_session("pane", "claude", "after-clear")
        assert env.store.run_session("after-clear") == (run["id"], False)

    def test_with_no_service_nothing_happens(self, monkeypatch) -> None:
        monkeypatch.setattr(webhook_service, "_service", None)
        app_module._note_webhook_session("pane", "claude", "x")


class TestStartup:
    async def test_the_service_can_read_the_workspaces_run_record(self, env, monkeypatch) -> None:
        """Without this a pane after the run's end is simply nobody's."""
        async def nothing() -> None:
            return None

        monkeypatch.setattr(app_module, "database", env.store.db)
        monkeypatch.setattr(webhook_ws, "reconcile", nothing)
        monkeypatch.setattr(webhook_service.WebhookService, "start_watchdog", lambda _: None)
        await webhook_ws.startup()
        assert webhook_service.current()._project == app_module.project_store.peek

    async def test_a_slow_listener_start_does_not_hold_up_the_backend(self, env, monkeypatch) -> None:
        """VM 0.2.37: startup awaited the listener, so the backend took no
        connection for its start deadline plus the stop join (10 s + 7 s)."""
        import time as _time

        await enabled_trigger()
        await webhook_ws.shutdown()
        real = webhook_ws.webhook_listener.WebhookListener.start

        def slow(self) -> None:
            _time.sleep(1.0)
            real(self)

        monkeypatch.setattr(app_module, "database", env.store.db)
        monkeypatch.setattr(webhook_service.WebhookService, "start_watchdog", lambda _: None)
        monkeypatch.setattr(webhook_ws.webhook_listener.WebhookListener, "start", slow)
        began = _time.monotonic()
        await webhook_ws.startup()
        assert _time.monotonic() - began < 0.5
        await settled(lambda: webhook_ws._listener is not None)
        assert (await call("webhook.status"))["payload"]["listening"] is True


    async def test_the_first_request_does_not_build_the_text_filter(self, env, monkeypatch) -> None:
        """The filter's character class takes 0.3-1 s to build. Built lazily on
        the first body, it held up the request that needs the fastest answer;
        the listener's start builds it in a worker thread first."""
        import unicodedata

        from agent_team_backend import webhook_payload

        await enabled_trigger()
        await webhook_ws.shutdown()
        webhook_payload._dash_run.cache_clear()
        monkeypatch.setattr(app_module, "database", env.store.db)
        monkeypatch.setattr(webhook_service.WebhookService, "start_watchdog", lambda _: None)
        await webhook_ws.startup()
        await settled(lambda: webhook_ws._listener is not None)
        calls = [0]
        real = unicodedata.category

        def counting(ch: str) -> str:
            calls[0] += 1
            return real(ch)

        monkeypatch.setattr(unicodedata, "category", counting)
        assert webhook_payload.sanitize_text("a - - - b") == "a \u2013 \u2013 \u2013 b"
        assert calls[0] == 0


class Sink:
    async def send_json(self, _: Any) -> None:
        return None


async def _noop_broadcast(_: Any) -> None:
    return None


class TestKickoffFailure:
    async def test_a_failed_kickoff_reaches_the_activity_list(self, env, monkeypatch) -> None:
        created = await call("webhook.trigger.create", name="CI", workspace_path=WS, pipeline_id=PIPE)
        trigger_id = created["payload"]["trigger"]["id"]
        run = env.store.open_run(trigger_id=trigger_id, workspace=WS, project_id="p", pipeline_id=PIPE, unattended=False)
        env._active[WS] = run
        monkeypatch.setattr(app_module.project_store, "abort_pipeline", lambda *_, **__: SimpleNamespace(workspace_path=WS, node_states={}))
        monkeypatch.setattr(ws_handlers, "_mirror_pipeline_state", lambda _: None)
        monkeypatch.setattr(app_module.tokens_store, "end_run", lambda *_, **__: None)
        monkeypatch.setattr(app_module.tokens_store, "snapshot", lambda _: {})
        monkeypatch.setattr(app_module, "_project_payload", lambda _: {})
        monkeypatch.setattr(app_module, "broadcast", _noop_broadcast)
        session = Sink()
        await ws_handlers.pipeline_abort(session, "1", "pipeline.abort", {"workspace_path": WS, "reason": "failed", "kickoff_failed": True})
        assert [e["detail"] for e in env.store.events(trigger_id)][0] == "kickoff"


class TestUnattended:
    async def test_is_audited_both_ways(self, env, monkeypatch) -> None:
        monkeypatch.setattr(webhook_ws.guard_fail_closed, "unattended_supported", lambda: True)
        created = await call("webhook.trigger.create", name="CI", workspace_path=WS, pipeline_id=PIPE)
        trigger_id = created["payload"]["trigger"]["id"]
        assert created["payload"]["trigger"]["unattended"] is False
        await call("webhook.trigger.set_unattended", id=trigger_id, unattended=True)
        await call("webhook.trigger.set_unattended", id=trigger_id, unattended=False)
        assert [r["outcome"] for r in env.store.events(trigger_id)] == ["unattended-off", "unattended-on"]

    async def test_is_refused_where_it_is_not_supported(self, env, monkeypatch) -> None:
        monkeypatch.setattr(webhook_ws.guard_fail_closed, "unattended_supported", lambda: False)
        created = await call("webhook.trigger.create", name="CI", workspace_path=WS, pipeline_id=PIPE)
        answer = await call("webhook.trigger.set_unattended", id=created["payload"]["trigger"]["id"], unattended=True)
        assert answer["error"]["code"] == "UNATTENDED_UNSUPPORTED"


class TestLimits:
    async def test_a_change_reaches_the_listener_and_stays_in_bounds(self, env) -> None:
        trigger_id = await enabled_trigger()
        answer = await call("webhook.trigger.update", id=trigger_id, per_minute=60, per_day=500, approval_timeout_min=240)
        assert answer["ok"] and webhook_ws._listener._triggers[trigger_id]["per_minute"] == 60
        for bad in ({"per_minute": 61}, {"per_day": 501}, {"approval_timeout_min": 4}, {"per_day": "x"}):
            limits = {"per_minute": 6, "per_day": 20, "approval_timeout_min": 30, **bad}
            assert (await call("webhook.trigger.update", id=trigger_id, **limits))["error"]["code"] == "BAD_REQUEST"

    async def test_an_unknown_trigger(self, env) -> None:
        answer = await call("webhook.trigger.update", id="nope", per_minute=6, per_day=20, approval_timeout_min=30)
        assert answer["error"]["code"] == "NOT_FOUND"


class TestStatus:
    async def test_says_how_long_a_waiting_run_has_left(self, env) -> None:
        run = {"id": "r", "trigger_id": "t", "workspace": WS, "started_at": 5, "unattended": 0}
        env._active[WS] = run
        env._waiting_since["r"] = 1000.0
        view = (await call("webhook.status"))["payload"]["runs"][0]
        assert (view["waiting_since"], view["stops_at"]) == (1000, 1000 + 30 * 60)
        del env._active[WS]


class TestKeys:
    async def test_the_key_is_in_the_create_answer_and_nowhere_else(self, env) -> None:
        created = await call("webhook.trigger.create", name="CI", workspace_path=WS, pipeline_id=PIPE)
        token = created["payload"]["token"]
        assert token.startswith("nvwh_")
        status = await call("webhook.status")
        assert token not in json.dumps(status) and webhook_triggers.hash_token(token) not in json.dumps(status)


class TestTaint:
    def test_without_a_binding_it_is_the_import_detail(self, env, monkeypatch) -> None:
        monkeypatch.setattr(ws_handlers, "_imported_taint_detail", lambda pid: f"imported {pid}" if pid == "n8n" else "")
        assert ws_handlers._run_taint_detail("n8n") == "imported n8n"
        assert ws_handlers._run_taint_detail("plain") == ""
        assert ws_handlers._run_taint_detail("") == ""

    def test_no_service_means_the_import_detail(self, monkeypatch) -> None:
        webhook_service.configure(None)
        monkeypatch.setattr(ws_handlers, "_imported_taint_detail", lambda pid: "")
        assert ws_handlers._run_taint_detail("anything") == ""

    def test_a_bound_pipeline_stays_tainted_after_its_trigger_is_deleted(self, env, monkeypatch) -> None:
        monkeypatch.setattr(ws_handlers, "_imported_taint_detail", lambda pid: "")
        trigger, _ = env.store.create(name="CI", workspace=WS, pipeline_id=PIPE)
        assert ws_handlers._run_taint_detail(PIPE)
        env.store.delete(trigger["id"])
        assert ws_handlers._run_taint_detail(PIPE)


class TestLog:
    def test_a_webhook_task_stays_out_of_the_run_log(self, tmp_path) -> None:
        secret = "customer-record-" + "7" * 8
        store = ProjectStore()
        project = store.start_pipeline(
            str(tmp_path), task_description=webhook_payload.build_task("CI", secret), total_stages=1,
            stage_blueprint=[{"stage_id": "01", "title": "s", "slots": []}], backend_version="0",
        )
        logs = list(Path(tmp_path).rglob("*.log"))
        text = "".join(p.read_text(encoding="utf-8") for p in logs)
        assert logs and "webhook data (" in text and secret not in text
        assert secret not in project.log_file_name

    def test_any_other_task_is_logged_as_it_was(self, tmp_path) -> None:
        assert webhook_payload.log_safe_task("fix the login page") == "fix the login page"
        ProjectStore().start_pipeline(
            str(tmp_path), task_description="fix the login page", total_stages=1,
            stage_blueprint=[{"stage_id": "01", "title": "s", "slots": []}], backend_version="0",
        )
        text = "".join(p.read_text(encoding="utf-8") for p in Path(tmp_path).rglob("*.log"))
        assert '"task": "fix the login page"' in text


class TestNoDoorForAgents:
    def test_nothing_outside_the_window_reaches_these(self) -> None:
        root = Path(webhook_ws.__file__).parent
        for path in (root / "mcp_server" / "server.py", root / "plugins" / "agent_tools_contract.py"):
            assert "webhook." not in path.read_text(encoding="utf-8")

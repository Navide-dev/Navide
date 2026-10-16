"""Vendor fixtures cross real readers, watcher checkpoints and app sinks.

The external writer is synthetic. Reader dispatch, attribution, session
persistence, activity delivery, usage accounting, and resume preflight are
the production implementations. The shared suite owns PTY mechanics.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from types import SimpleNamespace

import pytest

from agent_team_backend import agent_messaging, app, osplat
from agent_team_backend.cli_vendors.registry import VENDORS
from agent_team_backend.log_readers.attribution import Attribution
from agent_team_backend.log_readers.watcher import LogWatcher
from agent_team_backend.projects import ProjectStore
from agent_team_backend.spawn_history import SpawnHistoryStore
from agent_team_backend.tokens_store import TokensStore
from .catalog import load_catalog
from .support.vendor_data import MARKER, PANE, VendorData
from .support.backend_process import BackendProcess
from .support.cli_shim import base_python_executable, install_cli_shim

CATALOG = load_catalog()["vendors"]


def vendors_with(capability):
    return [key for key, entry in CATALOG.items() if capability in entry["capabilities"]]


@pytest.fixture
def data(request, tmp_path, monkeypatch, set_home):
    fixture = VendorData(request.param, tmp_path, monkeypatch, set_home)
    try:
        yield fixture
    finally:
        fixture.close()


@pytest.mark.parametrize("data", vendors_with("reader"), indirect=True)
async def test_vendor_reader(data, tmp_path, monkeypatch):
    key = data.fixture["vendor"]
    reader = VENDORS[key].make_log_reader()
    attribution = Attribution([reader], workspaces_path=tmp_path / "workspaces.json")
    attribution.register_pane(
        PANE, vendor=key, cwd=str(data.workspace), workspace_path=str(data.workspace),
        session_marker="" if key == "codex" else MARKER,
        explicit_session_id=data.fixture["sessionId"] if key == "claude" else "",
        session_home_id=PANE if key == "codex" else "",
    )
    store_args = dict(global_path=tmp_path / "tokens.json", workspace_base_dir=tmp_path / "tokens",
                      ingestion_state_path=tmp_path / "checkpoints.json")
    store = TokensStore(**store_args)
    projects = ProjectStore()
    history = SpawnHistoryStore()
    events = []

    async def broadcast(event):
        events.append(event)

    monkeypatch.setattr(app, "_readers", [reader])
    monkeypatch.setattr(app, "attribution", attribution)
    monkeypatch.setattr(app, "tokens_store", store)
    monkeypatch.setattr(app, "project_store", projects)
    monkeypatch.setattr(app, "spawn_history_store", history)
    monkeypatch.setattr(app, "broadcast", broadcast)
    # Live UI aggregation and its debounce are downstream of the guarantees
    # under test; actual persistence and activity/token sinks stay intact.
    monkeypatch.setattr(app, "track_live_session", lambda **_: None)
    monkeypatch.setattr(app, "_schedule_tokens_broadcast", lambda _: None)

    def watcher(current_reader, current_store):
        result = LogWatcher(
            sink=app._on_log_token_usage, activity_sink=app._on_log_activity,
            session_sink=app._on_session_file,
            checkpoint_provider=current_store.get_ingestion_checkpoint,
            checkpoint_sink=current_store.advance_ingestion_checkpoint,
            workspace_provider=lambda: [str(data.workspace)],
        )
        result.add_reader(current_reader)
        return result

    current = watcher(reader, store)
    data.apply("initial")
    assert reader.claims_path(data.path.resolve()), "fixture never reached its registered reader"
    await current._process_path(data.path)
    data.apply("response")
    await current._process_path(data.path)
    store.flush()

    # Reconstruct both the reader and durable checkpoint owner between the
    # assistant text and its completion boundary. No copied in-memory bag.
    reader = VENDORS[key].make_log_reader()
    store = TokensStore(**store_args)
    monkeypatch.setattr(app, "_readers", [reader])
    monkeypatch.setattr(app, "tokens_store", store)
    current = watcher(reader, store)
    data.apply("complete")
    await current._process_path(data.path)

    completions = [event["payload"] for event in events
                   if event["type"] == "agent.activity"
                   and event["payload"]["event_type"] == "turn_complete"]
    assert len(completions) == 1, (
        [(event["type"], event["payload"].get("event_type"), event["payload"].get("detail")) for event in events],
        [(event.event_type, event.cwd, event.text) for event in reader.parse_activity(data.path, set())],
        store.get_ingestion_checkpoint(str(data.path.resolve()), "@activity"),
    )
    assert completions[0]["text"].strip() == data.fixture["expected"]["reply"]
    assert completions[0]["vendor"] == key
    assert completions[0]["pane_id"] == PANE
    assert completions[0]["workspace_path"] == str(data.workspace)
    totals = store.snapshot(str(data.workspace))["global"]["all_time"]
    assert [totals["input"], totals["output"]] == data.fixture["expected"]["tokens"]
    assert attribution.pane_for_session(data.fixture["sessionId"])[0] == PANE
    if key != "claude":
        detected = [event["payload"] for event in events if event["type"] == "session.detected"]
        assert [event["session_id"] for event in detected] == [data.fixture["sessionId"]]
        # A fresh store instance, rather than the in-memory project object.
        saved = ProjectStore().peek(str(data.workspace))
        assert saved is not None
        assert any(pane.pane_id == PANE and pane.session_id == data.fixture["sessionId"]
                   for pane in saved.panes)

    store.flush()
    before = len(events)
    store = TokensStore(**store_args)
    monkeypatch.setattr(app, "tokens_store", store)
    await watcher(VENDORS[key].make_log_reader(), store)._process_path(data.path)
    assert len(events) == before, "restart replayed an already delivered session or activity"
    assert store.snapshot(str(data.workspace))["global"]["all_time"] == totals
    store.flush()


@pytest.mark.parametrize("data", vendors_with("resume"), indirect=True)
def test_vendor_resume(data):
    key = data.fixture["vendor"]
    data.apply("initial")
    data.apply("response")
    data.apply("complete")
    assert app._resume_id_for_agent(key, data.fixture["resumeCommand"]) == data.fixture["sessionId"]
    assert app._resume_id_for_agent(key, data.fixture["binary"]) == ""
    assert app._session_exists(key, str(data.workspace), data.fixture["sessionId"])
    assert not app._session_exists(key, str(data.workspace), "missing-session")


@pytest.mark.parametrize("data", vendors_with("unsupported_session"), indirect=True)
async def test_vendor_unsupported_session(data, monkeypatch):
    key = data.fixture["vendor"]
    assert app._resume_id_for_agent(key, data.fixture["binary"]) == ""
    if key == "aider":
        assert not app._session_exists(key, str(data.workspace), "informational-id")
        data.apply("initial")
        assert app._session_exists(key, str(data.workspace), "informational-id")
    from agent_team_backend.mcp_server import server, wiring
    events = []

    async def broadcast(event, **_):
        events.append(event)

    monkeypatch.setattr(app, "broadcast", broadcast)
    agent_messaging.register(PANE, "regression-caller", str(data.workspace), agent_key="claude")
    context = SimpleNamespace(request_context=SimpleNamespace(request=SimpleNamespace(
        query_params={"pane": PANE, "t": wiring.caller_token(PANE)},
    )))
    try:
        refused = await server.cli_open_agent(key, "helper", "continue", context, session_id="fixture-id")
        assert refused["ok"] is False
        assert refused["error_code"] == "no-session-support"
        assert events == [], "unsupported resume must not emit a spawn request"
    finally:
        agent_messaging.unregister(PANE)


@pytest.mark.parametrize("data", ["copilot", "grok", "kimi", "mcode"], indirect=True)
def test_vendor_login(data):
    key = data.fixture["vendor"]
    command = data.fixture["binary"] + " --fixture-repl-only --resume stale-session"
    assert app._login_spawn_command(key, command) == data.fixture["loginCommand"]


@pytest.mark.parametrize("vendor", vendors_with("launch"))
async def test_vendor_launch(vendor, tmp_path):
    fixture = json.loads((Path(__file__).resolve().parents[3] / "tests" / "fixtures" /
                         "cli-regression" / f"{vendor}.json").read_text(encoding="utf-8"))
    backend = BackendProcess(tmp_path)
    destination = tmp_path / "launch.json"
    script = Path(__file__).parent / "support" / "vendor_launch.py"
    arguments = [base_python_executable(), "-u", str(script), vendor, str(destination)]
    executable = install_cli_shim(tmp_path, fixture["binary"], arguments)
    guarded = fixture["guardedEnvironment"]
    backend.env.update({key: "fixture-inherited-home" for key in guarded})
    environment = {key: "fixture-requested-home" for key in guarded}
    environment.update(REGRESSION_MARKER="ordinary-setting", REGRESSION_GUARDED_KEYS=json.dumps(guarded))
    command = osplat.paths.shell_command(osplat.paths.quote_arg(str(executable)))
    async with backend, backend.connect() as socket:
        created = await backend.create(socket, pane_id=vendor, agent_key=vendor,
                                       command=command, env=environment)
        await backend.expect_output(socket, created["terminal_session_id"], "VENDOR_LAUNCH_READY")
        observed = json.loads(destination.read_text(encoding="utf-8"))
        assert observed["marker"] == "ordinary-setting"
        assert observed["leaked_overrides"] == []
        if vendor == "kimi":
            assert observed["esc_timeout"] == "100"
        if vendor == "mcode":
            assert observed["minimax_relocated"] is False
            assert observed["argv"] == [], "unsupported interactive flags must not be injected"

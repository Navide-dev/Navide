"""Plugin `agents.*` event source: which changes become events, and that every
payload is the pinned metadata projection (no text, no account fields)."""

from __future__ import annotations

import ast
import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import agent_messaging, app, plugin_host_events

WS = "/work/alpha"
FORBIDDEN_KEYS = {
    "content", "body", "text", "summary", "output", "excerpt", "workspace_path",
    "profileId", "profile_id", "sessionId", "session_id", "email", "account",
}
CONTRACTS = (
    Path(__file__).resolve().parents[2]
    / "packages" / "plugin-contracts" / "src" / "schemas" / "capabilities-v1.json"
)


@pytest.fixture
async def frames(monkeypatch: pytest.MonkeyPatch) -> Any:
    sent: list[dict[str, Any]] = []

    async def fake_broadcast(event: dict[str, Any], **_kw: Any) -> None:
        sent.append(event)

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    agent_messaging._reset_for_test()
    plugin_host_events.start(asyncio.get_running_loop())
    try:
        yield sent
    finally:
        plugin_host_events.stop()
        agent_messaging._reset_for_test()


async def _drain() -> None:
    for _ in range(3):
        await asyncio.sleep(0)


def _events(sent: list[dict[str, Any]]) -> list[tuple[str, str, dict[str, Any]]]:
    out = []
    for frame in sent:
        assert frame["type"] == plugin_host_events.EVENT_TYPE
        p = frame["payload"]
        assert set(p) == {"event", "workspace_path", "payload"}
        assert not FORBIDDEN_KEYS & set(p["payload"])
        out.append((p["event"], p["workspace_path"], p["payload"]))
    return out


async def test_pane_lifecycle_events(frames: list[dict[str, Any]]) -> None:
    agent_messaging.register("p1", "worker", WS, agent_key="claude", spawned_by="p0")
    agent_messaging.register("p1", "worker-renamed", WS, agent_key="claude")  # rename: no event
    agent_messaging.set_busy("p1", True, "running")
    agent_messaging.set_busy("p1", False, "idle")
    agent_messaging.set_busy("p1", False, "idle")  # no change: no event
    agent_messaging.unregister("p1")
    await _drain()
    assert _events(frames) == [
        ("agents.paneCreated", WS, {"paneId": "p1", "name": "worker", "agentKey": "claude", "spawnedBy": "p0"}),
        ("agents.turnEnded", WS, {"paneId": "p1", "name": "worker-renamed"}),
        ("agents.paneIdle", WS, {"paneId": "p1", "name": "worker-renamed"}),
        ("agents.paneClosed", WS, {"paneId": "p1", "name": "worker-renamed"}),
    ]


async def test_message_received_is_metadata_only(frames: list[dict[str, Any]]) -> None:
    agent_messaging.notify_message_rows([
        {"uid": "m1", "created_at": 5, "status": "delivered", "sender": "a", "recipient": "b",
         "content": "secret text", "recipient_workspace": WS, "sender_workspace": WS},
        {"uid": "m2", "content": "relayed", "recipient_workspace": WS, "remote": "inbound"},
        {"uid": "m3", "content": "no workspace stamp"},
    ])
    await _drain()
    events = _events(frames)
    assert [e[0] for e in events] == ["agents.messageReceived"]
    assert events[0][2]["id"] == "m1"
    assert events[0][2]["bodyLength"] == len("secret text")
    assert "secret text" not in json.dumps(frames)


def _plan(stage: str) -> str:
    meta = json.dumps({"stage": stage, "title": "t", "todos": []})
    return f'<html><body><script type="application/json" id="plan-meta">{meta}</script></body></html>'


async def test_plan_stage_changes_after_first_scan(frames: list[dict[str, Any]], tmp_path: Path) -> None:
    plans = tmp_path / ".agent-team" / "plans"
    plans.mkdir(parents=True)
    doc = plans / "a_123456.html"
    doc.write_text(_plan("draft"))
    workspace = str(tmp_path)
    await plugin_host_events.on_plans_changed(workspace)  # first scan: baseline only
    doc.write_text(_plan("approved"))
    import os
    os.utime(doc, ns=(doc.stat().st_atime_ns, doc.stat().st_mtime_ns + 1_000_000))
    await plugin_host_events.on_plans_changed(workspace)
    await _drain()
    assert _events(frames) == [
        ("agents.planStageChanged", workspace,
         {"relPath": ".agent-team/plans/a_123456.html", "stage": "approved", "previousStage": "draft"}),
    ]


async def test_pipeline_node_changes(frames: list[dict[str, Any]]) -> None:
    before = plugin_host_events.node_statuses({"n1": {"status": "running"}, "n2": {"status": "done"}})
    plugin_host_events.on_pipeline_node_states(WS, "pipe", before, {
        "n1": {"status": "done", "summary": "private reply"},
        "n2": {"status": "done"},
        "n3": {"status": "running"},
    })
    await _drain()
    assert _events(frames) == [
        ("agents.pipelineNodeChanged", WS, {"pipelineId": "pipe", "nodeId": "n1", "status": "done", "previousStatus": "running"}),
        ("agents.pipelineNodeChanged", WS, {"pipelineId": "pipe", "nodeId": "n3", "status": "running", "previousStatus": ""}),
    ]


async def test_schedule_fired(frames: list[dict[str, Any]]) -> None:
    plugin_host_events.on_schedule_fired(
        {"id": "j1", "name": "nightly", "action": {"kind": "message", "workspace": WS, "text": "do it"}},
        manual=False,
    )
    await _drain()
    assert _events(frames) == [
        ("agents.scheduleFired", WS, {"jobId": "j1", "name": "nightly", "actionKind": "message", "manual": False}),
    ]
    assert "do it" not in json.dumps(frames)


async def test_nothing_is_sent_before_start(monkeypatch: pytest.MonkeyPatch) -> None:
    sent: list[Any] = []

    async def fake_broadcast(event: dict[str, Any], **_kw: Any) -> None:
        sent.append(event)

    monkeypatch.setattr(app, "broadcast", fake_broadcast)
    plugin_host_events.on_schedule_fired({"id": "j", "action": {"workspace": WS}}, manual=True)
    await _drain()
    assert sent == []


def test_event_list_matches_capability_catalog() -> None:
    catalog = json.loads(CONTRACTS.read_text())
    cataloged = [
        entry["address"] for entry in catalog["capabilities"]
        if entry.get("kind") == "event" and entry["address"] in plugin_host_events.EVENTS
    ]
    assert cataloged == list(plugin_host_events.EVENTS)


def test_module_never_imports_account_or_quota_code() -> None:
    source = Path(plugin_host_events.__file__).read_text()
    names: set[str] = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.ImportFrom):
            names.update(alias.name for alias in node.names)
            names.add(node.module or "")
        elif isinstance(node, ast.Import):
            names.update(alias.name for alias in node.names)
    banned = ("quota", "usage", "credential", "account", "profile", "keychain")
    assert not [n for n in names if any(b in n for b in banned)]

"""tokens.watch: windows that declare their workspaces get a small notice for
those workspaces only; connections that never declared (older renderers) keep
getting the full `tokens.changed` snapshot."""
from __future__ import annotations

import json
from typing import Any

import pytest

from agent_team_backend import app


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


def _snapshot(workspace_path):
    # Sized like a real one: the global history is most of its ~80 KB.
    days = {f"2026-{m:02d}-{d:02d}": {"input": 1, "output": 2, "calls": 3} for m in range(1, 13) for d in range(1, 29)}
    return {
        "workspace_path": workspace_path or "",
        "workspace": {"current_run": None, "runs": [{"run_id": "r1"}], "cumulative": {}, "live_by_session": {}},
        "global": {"all_time": {"input": 9, "output": 9, "calls": 9}, "by_day": days,
                   "by_account_day": {f"acct-{i}": days for i in range(2)}},
    }


@pytest.fixture
def sessions(monkeypatch: pytest.MonkeyPatch):
    built: list[str] = []

    def snapshot(workspace_path):
        built.append(workspace_path or "")
        return _snapshot(workspace_path)

    monkeypatch.setattr(app.tokens_store, "snapshot", snapshot)
    monkeypatch.setattr(app, "refresh_live_scans", lambda *_: None)
    registry: set = set()
    monkeypatch.setattr(app, "_SESSIONS", registry)

    def make(watch=None):
        session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
        session.tokens_watch = None if watch is None else frozenset(watch)
        registry.add(session)
        return session

    make.built = built  # type: ignore[attr-defined]
    return make


def _sent(session) -> list[dict[str, Any]]:
    return [event for event in session.websocket.sent if event.get("type", "").startswith("tokens.")]


async def _call(session, msg_type: str, **payload: Any) -> dict[str, Any]:
    await app.handle_message(session, {"id": "m1", "type": msg_type, "payload": payload})
    return session.websocket.sent[-1]


@pytest.mark.asyncio
async def test_notice_goes_only_to_windows_watching_that_workspace(sessions) -> None:
    a, b, every, none = sessions(["/ws/a"]), sessions(["/ws/b"]), sessions(["*"]), sessions([])
    await app.broadcast_tokens_changed("/ws/a")

    [notice] = _sent(a)
    assert notice["type"] == "tokens.notice"
    assert notice["payload"]["workspace_path"] == "/ws/a"
    assert len(json.dumps(notice)) < 300
    assert _sent(b) == [] and _sent(none) == []
    assert [event["type"] for event in _sent(every)] == ["tokens.notice"]
    # Nobody needs the full snapshot, so it is not even built.
    assert sessions.built == []


@pytest.mark.asyncio
async def test_old_and_new_windows_on_one_workspace_both_update(sessions) -> None:
    new, old = sessions(["/ws/a"]), sessions()
    await app.broadcast_tokens_changed("/ws/a")

    [notice] = _sent(new)
    [legacy] = _sent(old)
    assert notice["type"] == "tokens.notice"
    assert legacy["type"] == "tokens.changed"
    assert legacy["payload"] == _snapshot("/ws/a")
    assert len(json.dumps(legacy)) > 50_000  # what every window used to get
    assert sessions.built == ["/ws/a"]


@pytest.mark.asyncio
async def test_given_snapshot_is_sent_as_is_to_legacy_windows(sessions) -> None:
    old = sessions()
    snap = {"workspace_path": "", "workspace": {}, "global": {"all_time": {}}}
    await app.broadcast_tokens_changed("", snap)
    assert _sent(old)[0]["payload"] is snap
    assert sessions.built == []


@pytest.mark.asyncio
async def test_watch_declaration_replaces_and_validates(sessions) -> None:
    session = sessions()
    reply = await _call(session, "tokens.watch", paths=["/ws/b", "/ws/a"])
    assert reply["ok"] and reply["payload"] == {"paths": ["/ws/a", "/ws/b"]}
    assert session.tokens_watch == {"/ws/a", "/ws/b"}
    reply = await _call(session, "tokens.watch", paths=[])
    assert session.tokens_watch == frozenset()
    reply = await _call(session, "tokens.watch", paths="/ws/a")
    assert not reply["ok"]
    assert session.tokens_watch == frozenset()


@pytest.mark.asyncio
async def test_snapshot_can_leave_out_the_global_history(sessions) -> None:
    session = sessions()
    full = (await _call(session, "tokens.snapshot", workspace_path="/ws/a"))["payload"]
    assert full == _snapshot("/ws/a")
    slim = (await _call(session, "tokens.snapshot", workspace_path="/ws/a", **{"global": "all_time"}))["payload"]
    assert slim == {**full, "global": {"all_time": full["global"]["all_time"]}}


@pytest.mark.asyncio
async def test_registered_plugin_host_session_gets_no_token_broadcast(sessions, monkeypatch) -> None:
    monkeypatch.setattr(app, "host_session_token_matches", lambda token: token == "host-token")
    broker = sessions()
    reply = await _call(broker, "host.register", token="host-token")
    assert reply["ok"]
    await app.broadcast_tokens_changed("/ws/a")
    assert _sent(broker) == []
    assert sessions.built == []

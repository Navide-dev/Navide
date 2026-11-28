"""commander_watch: one notice per stall episode, chat only when bound,
clean stop. The service is a fake; time is a fake clock."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import commander_watch
from agent_team_backend.commander_service import GONE, IDLE, REPORTED, STALLED, WORKING


class FakeService:
    def __init__(self, stall_minutes: int = 20) -> None:
        self.commander = SimpleNamespace(id="c1", name="指揮A", stall_minutes=stall_minutes)
        self.store = SimpleNamespace(list=lambda: [self.commander])
        self.states: dict[str, str] = {"child": WORKING}
        self.body_pane = "boss"

    def tree(self, commander_id: str) -> dict[str, Any]:
        children = [{"pane_id": p, "name": f"n-{p}", "task": "do it", "state": s, "children": []}
                    for p, s in self.states.items()]
        return {"commander_id": commander_id,
                "root": {"pane_id": self.body_pane, "state": WORKING, "children": children}}

    def body(self, commander_id: str) -> Any:
        return SimpleNamespace(pane_id=self.body_pane) if self.body_pane else None


class Harness:
    def __init__(self, svc: FakeService, *, chats: bool = True, body_live: bool = True) -> None:
        self.svc = svc
        self.now = 1000.0
        self.sent: list[tuple[str, str]] = []
        self.chats: list[tuple[str, str]] = []
        self.events: list[tuple[str, str, str]] = []
        self.has_chat = chats

        async def send_to_body(pane_id: str, text: str) -> None:
            self.sent.append((pane_id, text))

        async def push_chats(commander_id: str, text: str) -> None:
            if self.has_chat:
                self.chats.append((commander_id, text))

        async def broadcast(cid: str, pane_id: str, state: str) -> None:
            self.events.append((cid, pane_id, state))

        self.watch = commander_watch.CommanderWatch(
            service=lambda: svc, send_to_body=send_to_body, push_chats=push_chats, broadcast=broadcast,
            live_pane=lambda pid: object() if body_live else None, monotonic=lambda: self.now)

    def tick(self, minutes: float = 1) -> None:
        self.now += minutes * 60
        asyncio.run(self.watch.run_once())


def test_stall_is_noticed_once_per_episode() -> None:
    svc = FakeService()
    h = Harness(svc)
    h.tick()
    assert h.events == []
    svc.states["child"] = STALLED
    for _ in range(5):
        h.tick()
    assert h.events == [("c1", "child", STALLED)]
    assert [p for p, _ in h.sent] == ["boss"]
    assert "n-child" in h.sent[0][1]
    assert len(h.chats) == 1


def test_recovery_then_stall_again_notices_again() -> None:
    svc = FakeService()
    h = Harness(svc)
    svc.states["child"] = STALLED
    h.tick()
    svc.states["child"] = WORKING
    h.tick()
    svc.states["child"] = STALLED
    h.tick()
    assert h.events == [("c1", "child", STALLED), ("c1", "child", STALLED)]
    assert len(h.sent) == 2


def test_idle_is_noticed_only_after_stall_minutes() -> None:
    svc = FakeService(stall_minutes=20)
    h = Harness(svc)
    svc.states["child"] = IDLE
    h.tick()
    h.tick(10)
    assert h.events == []
    h.tick(10)
    assert h.events == [("c1", "child", IDLE)]
    h.tick(30)
    assert len(h.events) == 1


def test_reported_or_gone_is_never_noticed() -> None:
    svc = FakeService(stall_minutes=1)
    h = Harness(svc)
    svc.states = {"a": REPORTED, "b": GONE}
    for _ in range(5):
        h.tick()
    assert h.events == [] and h.sent == []


def test_grandchildren_are_watched() -> None:
    svc = FakeService()
    tree = svc.tree

    def nested(cid: str) -> dict[str, Any]:
        t = tree(cid)
        t["root"]["children"][0]["children"] = [
            {"pane_id": "grand", "name": "g", "task": "", "state": STALLED, "children": []}]
        return t

    svc.tree = nested  # type: ignore[method-assign]
    h = Harness(svc)
    h.tick()
    assert h.events == [("c1", "grand", STALLED)]


def test_no_chat_binding_tells_only_the_commander() -> None:
    svc = FakeService()
    h = Harness(svc, chats=False)
    svc.states["child"] = STALLED
    h.tick()
    assert len(h.sent) == 1 and h.chats == []
    assert h.events == [("c1", "child", STALLED)]


def test_no_body_pushes_chat_and_broadcasts_only() -> None:
    svc = FakeService()
    svc.body_pane = ""
    h = Harness(svc)
    svc.states["child"] = STALLED
    h.tick()
    assert h.sent == []
    assert len(h.chats) == 1 and h.events == [("c1", "child", STALLED)]


def test_dead_body_is_not_sent_to() -> None:
    svc = FakeService()
    h = Harness(svc, body_live=False)
    svc.states["child"] = STALLED
    h.tick()
    assert h.sent == [] and len(h.chats) == 1


def test_one_failing_notice_does_not_stop_the_others() -> None:
    svc = FakeService()
    h = Harness(svc)

    async def boom(pane_id: str, text: str) -> None:
        raise RuntimeError("down")

    h.watch._send_to_body = boom  # type: ignore[assignment]
    svc.states["child"] = STALLED
    h.tick()
    assert len(h.chats) == 1 and len(h.events) == 1


def test_watch_never_touches_the_pane() -> None:
    """Only the three notice seams are called: no wake, no interrupt."""
    svc = FakeService()
    calls: list[str] = []
    svc.interrupt = lambda *a: calls.append("interrupt")  # type: ignore[attr-defined]
    h = Harness(svc)
    svc.states["child"] = STALLED
    h.tick()
    assert calls == []
    assert "不會自動叫醒" in h.sent[0][1]


@pytest.mark.asyncio
async def test_start_and_stop_cleanly() -> None:
    svc = FakeService()
    scans = 0

    def counting() -> FakeService:
        nonlocal scans
        scans += 1
        return svc

    watch = commander_watch.CommanderWatch(service=counting, interval_s=0.01)
    watch.start()
    for _ in range(200):
        if scans:
            break
        await asyncio.sleep(0.01)
    assert scans >= 1
    task = watch._task
    await watch.stop()
    assert task is not None and task.done()
    assert watch._task is None
    await watch.stop()  # a second stop is a no-op


@pytest.mark.asyncio
async def test_module_startup_shutdown(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(commander_watch, "_WATCH", None)
    await commander_watch.startup()
    watch = commander_watch._WATCH
    assert watch is not None and watch._task is not None and not watch._task.done()
    await commander_watch.shutdown()
    assert commander_watch._WATCH is None and watch._task is None

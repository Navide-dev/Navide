"""Shipped Log batch 3: the daily digest — a Navide system job in the
scheduler that pushes the last 24 hours to the bound chats, masked."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import app as app_module
from agent_team_backend import scheduler as sched_mod
from agent_team_backend.db import Database, WorkspaceDatabases
from agent_team_backend.plugins.builtin.navide_shipped_log import digest
from agent_team_backend.plugins.builtin.navide_shipped_log.ledger import ShipLogLedger
from agent_team_backend.scheduler import JobInvalid, SchedulerService
from agent_team_backend.scheduler_store import SchedulerStore

NOW = datetime(2026, 11, 20, 9, 0, tzinfo=timezone(timedelta(hours=8)))


def _fake_email() -> str:
    return "ops" + "@" + "dealpilot.example"


class _Bridge:
    def __init__(self) -> None:
        self.digests: list[tuple[str, bool]] = []

    def has_window(self) -> bool:
        return True

    def still_queued(self, msg_key: Any) -> bool:
        return False

    async def budget_limited(self, action: Any) -> bool:
        return False

    async def deliver(self, action: Any) -> dict:
        raise AssertionError("a digest never goes to a pane")

    async def deliver_ship_digest(self, action: dict, manual: bool) -> dict:
        self.digests.append((action["workspace"], manual))
        return {"status": "ok", "detail": "sent"}


@pytest.fixture
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    db = Database(tmp_path / "navide.db")

    async def quiet(event: dict, *, exclude: Any = None) -> None:
        pass

    monkeypatch.setattr(app_module, "broadcast", quiet)
    monkeypatch.setattr(app_module, "host_disabled_plugins", lambda: frozenset())
    bridge = _Bridge()
    service = SchedulerService(SchedulerStore(db), clock=lambda: NOW.timestamp(), bridge=bridge)
    monkeypatch.setattr(sched_mod, "_service", service)
    ws = tmp_path / "proj"
    ws.mkdir()
    book = ShipLogLedger(WorkspaceDatabases())
    yield SimpleNamespace(service=service, ws=str(ws.resolve()), bridge=bridge, book=book)
    for task, _manual in list(service._runs.values()):  # noqa: SLF001
        task.cancel()
    db.close()


# ── settings and the system job ─────────────────────────────────────────────


async def test_settings_save_the_system_job(env) -> None:
    answer = await digest.set_settings(env.ws, {"digest_enabled": True, "digest_at": "18:30",
                                                "digest_tz": "Asia/Taipei"}, book=env.book)
    assert answer["ok"] is True and answer["settings"]["digest_at"] == "18:30"
    job = await env.service.store.get_job(digest.job_id_for(env.ws))
    assert job["enabled"] is True and job["action"] == {"kind": "ship_digest", "workspace": env.ws}
    assert job["schedule"] == {"kind": "daily", "at": "18:30", "tz": "Asia/Taipei"}
    assert job["owner"] == {"kind": "system", "feature": "shipped-log", "workspace": env.ws}
    assert answer["next_run_at"] is not None
    # scheduler.list / scheduler_list show it like any system job.
    [listed] = (await env.service.list())["jobs"]
    assert listed["action"] == {"kind": "ship_digest", "workspace": env.ws}


@pytest.mark.parametrize("updates, message", [
    ({"digest_at": "25:00"}, "HH:MM"),
    ({"digest_enabled": "yes"}, "true or false"),
    ({"digest_tz": "Mars/Base"}, "time zone"),
    ({"digest_chat": "x"}, "unknown"),
])
async def test_bad_settings_are_refused(env, updates: dict, message: str) -> None:
    answer = await digest.set_settings(env.ws, updates, book=env.book)
    assert answer["ok"] is False and message in answer["error"]
    assert await env.service.store.get_job(digest.job_id_for(env.ws)) is None


async def test_nobody_else_can_create_or_change_the_digest_job(env) -> None:
    with pytest.raises(JobInvalid, match="ship_digest"):
        await env.service.upsert({"name": "x", "schedule": {"kind": "daily", "at": "09:00", "tz": "UTC"},
                                  "action": {"kind": "ship_digest", "workspace": env.ws}})
    await digest.set_settings(env.ws, {"digest_enabled": True}, book=env.book)
    answer = await env.service.upsert({"id": digest.job_id_for(env.ws), "name": "renamed"})
    assert answer["ok"] is False and answer["code"] == sched_mod.SYSTEM_JOB and "Shipped Log" in answer["error"]


async def test_a_due_digest_fires_through_its_own_bridge_call(env) -> None:
    await digest.set_settings(env.ws, {"digest_enabled": True, "digest_at": "09:05"}, book=env.book)
    job = await env.service.store.get_job(digest.job_id_for(env.ws))
    env.service.clock = lambda: job["state"]["next_run_at"] / 1000 + 1
    await env.service.tick()
    task, manual = env.service._runs[job["id"]]  # noqa: SLF001
    await task
    assert env.bridge.digests == [(env.ws, False)]
    assert (await env.service.runs(job["id"]))["runs"][0]["status"] == "ok"


# ── one run ─────────────────────────────────────────────────────────────────


async def test_a_run_sends_the_masked_chat_rendering(env) -> None:
    at = int((NOW - timedelta(hours=2)).timestamp())
    env.book.record(env.ws, summary=f"Invoices go out from {_fake_email()}", source_kind="other", at=at)
    env.book.record(env.ws, summary="SMTP relay switched", source_kind="config", at=at + 1)
    env.book.record(env.ws, summary="Too old", source_kind="other", at=at - 2 * 86400)
    env.book.record_detection(env.ws, at=at + 2, pane="p", vendor="claude", rule="npm-publish",
                              excerpt="npm publish", ok=True)
    sent: list[str] = []
    scopes: list[str] = []

    async def sender(text: str, workspace: str) -> int:
        sent.append(text)
        scopes.append(workspace)
        return 2

    outcome = await digest.run(env.ws, now=NOW, book=env.book, sender=sender)
    assert outcome == {"status": "ok", "detail": "sent to 2 chat(s), 2 item(s)"}
    [text] = sent
    assert scopes == [digest._canonical(env.ws)]  # only that workspace's chats
    assert text.startswith("📋 proj｜每日上線摘要")
    assert _fake_email() not in text and "o***@dealpilot.example" in text
    assert "SMTP relay switched" not in text and "正式機設定變更 1 筆" in text
    assert "npm publish" not in text and "1 筆偵測到的部署指令待確認" in text
    assert "Too old" not in text


async def test_empty_days_skip_unless_asked(env) -> None:
    async def sender(text: str, workspace: str) -> int:
        return 1

    assert (await digest.run(env.ws, now=NOW, book=env.book, sender=sender))["reason"] == "empty"
    assert (await digest.run(env.ws, manual=True, now=NOW, book=env.book, sender=sender))["status"] == "ok"
    env.book.put_settings(env.ws, {"digest_skip_empty": False})
    assert (await digest.run(env.ws, now=NOW, book=env.book, sender=sender))["status"] == "ok"


async def test_no_chat_and_plugin_off_are_skips(env, monkeypatch: pytest.MonkeyPatch) -> None:
    async def nobody(text: str, workspace: str) -> int:
        return 0

    assert (await digest.run(env.ws, manual=True, now=NOW, book=env.book, sender=nobody))["reason"] == "no_chat"
    monkeypatch.setattr(app_module, "host_disabled_plugins", lambda: frozenset({"navide.shipped-log"}))
    assert (await digest.run(env.ws, manual=True, now=NOW, book=env.book, sender=nobody))["reason"] == "plugin_disabled"
    assert (await digest.run(env.ws + "-gone", now=NOW, book=env.book))["reason"] == "workspace_gone"


async def test_the_manager_sends_each_direct_chat_of_the_workspace_once() -> None:
    from types import MethodType

    from agent_team_backend.channels.manager import ChannelManager

    def binding(key: str, kind: str, pane: str) -> Any:
        return SimpleNamespace(location=lambda: SimpleNamespace(key=lambda: key, name=key), platform="telegram",
                               kind=kind, pane_id=pane, account="default")

    sent: list[str] = []

    async def send(location: Any, text: str) -> None:
        if location.name == "broken":
            raise RuntimeError("down")
        sent.append(location.name)

    workspaces = {"p1": "/ws/a", "p2": "/ws/a", "other": "/ws/b"}
    fake = SimpleNamespace(
        store=SimpleNamespace(bindings=lambda: [binding("a", "direct", "p1"), binding("a", "direct", "p2"),
                                                binding("g", "group", "p1"), binding("broken", "direct", "p1"),
                                                binding("b", "direct", "p2"), binding("x", "direct", "other")]),
        _chat_kind=lambda b: b.kind,
        _seams=SimpleNamespace(resolve_pane=lambda p: p, pane_workspace=lambda p: workspaces.get(p, "")),
        mirror=SimpleNamespace(send=send),
    )
    fake._workspace_chats = MethodType(ChannelManager._workspace_chats, fake)
    assert await ChannelManager.notify_shipped_digest(fake, "digest", "/ws/a") == 2
    assert sent == ["a", "b"]  # never "x", another workspace's chat

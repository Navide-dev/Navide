"""channels.overview / unbind_many / focus_pane: the Settings page's view of who is bound where."""

from __future__ import annotations

import asyncio
import dataclasses

import pytest

from agent_team_backend.channels import ws_api
from agent_team_backend.channels.base import Location
from agent_team_backend.channels.store import ChannelStore

from .test_manager import Env, FakeAdapter, _until, fast_timers  # noqa: F401 — fast_timers is autouse

DIRECTORY = [
    {"pane_id": "pane-1", "name": "api", "qualified_name": "Agent-Team/api",
     "spawned_by": "", "display_status": "running"},
    {"pane_id": "pane-2", "name": "scout", "qualified_name": "Other/scout",
     "spawned_by": "", "display_status": "idle"},
    {"pane_id": "kid-1", "name": "reviewer", "qualified_name": "Agent-Team/reviewer",
     "spawned_by": "pane-1", "display_status": "idle"},
]
WORKSPACES = {"pane-1": "/w/Agent-Team", "pane-2": "/w/Other", "kid-1": "/w/Agent-Team"}


@pytest.fixture
async def ov(tmp_path):
    e = Env(tmp_path)
    e.m._seams = dataclasses.replace(
        e.m._seams,
        pane_directory=lambda: [dict(p) for p in DIRECTORY if p["pane_id"] not in e.fake.gone],
        pane_workspace=lambda p: "" if p in e.fake.gone else WORKSPACES.get(p, ""),
        pane_agent=lambda p: "" if p in e.fake.gone else "claude",
    )
    await e.m.start()
    assert (await e.m.configure("telegram", {}, {"token": "tok-A"}))["ok"]
    e.store.add_allow("telegram", "7", "alice", 1)
    yield e
    await e.m.stop()
    e.db.close()


def _bot(res: dict, platform: str = "telegram", account: str = "default") -> dict:
    return next(b for b in res["bots"] if b["platform"] == platform and b["account"] == account)


def _chat(bot: dict, chat_id: str) -> dict:
    return next(c for c in bot["chats"] if c["chat_id"] == chat_id)


async def test_overview_lists_each_chat_with_the_panes_bound_to_its_topics(ov: Env) -> None:
    await ov.inbound("hi", chat="-100", thread="50")  # the bot has seen the group
    ov.store.remember_chat("telegram", _bot_key(ov), "-100", "Dev group", "supergroup", True, 2)
    ov.store.bind("pane-1", Location("telegram", "default", "-100", "50", "api"), verbosity="replies")
    ov.store.bind("pane-2", Location("telegram", "default", "-100", "60", "scout"), verbosity="standard")
    res = ov.m.overview()
    assert res["ok"] is True
    chat = _chat(_bot(res), "-100")
    assert chat["title"] == "Dev group" and chat["supports_topics"] is True
    by_pane = {b["pane_id"]: b for b in chat["bindings"]}
    assert set(by_pane) == {"pane-1", "pane-2"}
    assert by_pane["pane-2"]["thread_id"] == "60"
    assert by_pane["pane-2"]["verbosity"] == "standard"
    assert by_pane["pane-2"]["pane"] == {
        "exists": True, "name": "scout", "qualified_name": "Other/scout",
        "workspace_path": "/w/Other", "display_status": "idle", "agent_key": "claude",
    }
    assert isinstance(by_pane["pane-1"]["created_at"], int)
    assert _bot(res)["orphans"] == []


def _bot_key(env: Env) -> str:
    from agent_team_backend.channels.manager import _bot_key as key

    return key(env.tg)


async def test_a_seen_chat_with_no_pane_is_listed_without_bindings(ov: Env) -> None:
    await ov.inbound("hi", chat="-300", thread="")
    chat = _chat(_bot(ov.m.overview()), "-300")
    assert chat["bindings"] == []


async def test_a_binding_whose_pane_is_gone_is_an_orphan(ov: Env) -> None:
    ov.store.bind("pane-9", Location("telegram", "default", "-100", "", "support"))
    ov.fake.gone.add("pane-9")
    bot = _bot(ov.m.overview())
    entry = _chat(bot, "-100")["bindings"][0]
    assert entry["pane"]["exists"] is False
    assert entry["pane"]["name"] == "support"  # the title it was bound under
    assert bot["orphans"] == ["pane-9"]


async def test_overview_follows_panes_to_their_ids_after_a_restart(ov: Env) -> None:
    ov.store.bind("old-1", Location("telegram", "default", "-100", "50", "api"))
    ov.fake.aliases["old-1"] = "pane-1"
    bot = _bot(ov.m.overview())
    entry = _chat(bot, "-100")["bindings"][0]
    assert entry["pane_id"] == "pane-1" and entry["pane"]["exists"] is True
    assert bot["orphans"] == []


async def test_auto_child_topics_carry_their_parent(ov: Env) -> None:
    ov.store.bind("pane-1", Location("telegram", "default", "-100", "50", "api"))
    ov.store.bind("kid-1", Location("telegram", "default", "-100", "51", "↳ reviewer"),
                  parent_pane_id="pane-1", auto=True)
    kid = next(b for b in _chat(_bot(ov.m.overview()), "-100")["bindings"] if b["pane_id"] == "kid-1")
    assert kid["auto"] is True and kid["parent_pane_id"] == "pane-1"


async def test_a_chat_the_running_bot_never_saw_is_still_listed_from_its_binding(ov: Env) -> None:
    # Bound under an older token: the new token's bot has no channel_chats row for it.
    ov.store.bind("pane-1", Location("telegram", "default", "-555", "", "old chat"))
    chat = _chat(_bot(ov.m.overview()), "-555")
    assert chat["title"] == "old chat"
    assert [b["pane_id"] for b in chat["bindings"]] == ["pane-1"]


async def test_every_configured_bot_is_listed_even_without_chats(ov: Env) -> None:
    assert (await ov.m.configure("telegram", {"account": "b2"}, {"token": "tok-B"}, "b2"))["ok"]
    res = ov.m.overview()
    assert _bot(res, account="b2")["chats"] == []


async def test_unbind_many_broadcasts_once_and_notifies_each_chat(ov: Env) -> None:
    ov.store.bind("pane-1", Location("telegram", "default", "-100", "50", "api"))
    ov.store.bind("pane-2", Location("telegram", "default", "-100", "60", "scout"))
    ov.fake.events.clear()
    res = await ov.m.unbind_many(["pane-1", "pane-2"])
    assert res["ok"] is True
    assert res["results"] == [{"pane_id": "pane-1", "ok": True, "removed": True},
                              {"pane_id": "pane-2", "ok": True, "removed": True}]
    assert ov.store.bindings() == []
    assert [e for e, _ in ov.fake.events if e == "channels.changed"] == ["channels.changed"]
    await _until(lambda: sum(t.startswith("🔌") for t in ov.tg.texts()) == 2)
    assert any("「scout」" in t for t in ov.tg.texts())  # the pane's current name, not just the title


async def test_unbind_many_also_releases_auto_children_in_the_one_broadcast(ov: Env) -> None:
    ov.store.bind("pane-1", Location("telegram", "default", "-100", "50", "api"))
    ov.store.bind("kid-1", Location("telegram", "default", "-100", "51", "↳ reviewer"),
                  parent_pane_id="pane-1", auto=True)
    ov.fake.events.clear()
    await ov.m.unbind_many(["pane-1"])
    assert ov.store.bindings() == []
    assert [e for e, _ in ov.fake.events if e == "channels.changed"] == ["channels.changed"]


async def test_unbind_many_reports_each_failure_and_keeps_going(ov: Env, monkeypatch) -> None:
    ov.store.bind("pane-1", Location("telegram", "default", "-100", "50", "api"))
    ov.store.bind("pane-2", Location("telegram", "default", "-100", "60", "scout"))
    real = ov.m.unbind

    async def flaky(pane_id: str, **kw):
        if pane_id == "pane-1":
            raise RuntimeError("db locked")
        return await real(pane_id, **kw)

    monkeypatch.setattr(ov.m, "unbind", flaky)
    ov.fake.events.clear()
    res = await ov.m.unbind_many(["pane-1", "pane-2", "nobody"])
    assert res["results"] == [
        {"pane_id": "pane-1", "ok": False, "error": "RuntimeError: db locked"},
        {"pane_id": "pane-2", "ok": True, "removed": True},
        {"pane_id": "nobody", "ok": True, "removed": False},
    ]
    assert [e for e, _ in ov.fake.events if e == "channels.changed"] == ["channels.changed"]


async def test_unbind_many_with_nothing_removed_does_not_broadcast(ov: Env) -> None:
    ov.fake.events.clear()
    res = await ov.m.unbind_many(["nobody"])
    assert res["results"] == [{"pane_id": "nobody", "ok": True, "removed": False}]
    assert [e for e, _ in ov.fake.events if e == "channels.changed"] == []


async def test_a_change_during_unbind_many_still_goes_out(ov: Env) -> None:
    """Another request's change while the batch holds the broadcast is not lost."""
    ov.store.bind("pane-1", Location("telegram", "default", "-100", "50", "api"))
    ov.fake.events.clear()
    await ov.m.unbind_many(["pane-1"])
    await ov.m._changed()
    assert [e for e, _ in ov.fake.events if e == "channels.changed"] == ["channels.changed"] * 2


async def test_focus_pane_resolves_the_current_pane_and_its_workspace(ov: Env) -> None:
    ov.fake.aliases["old-2"] = "pane-2"
    assert ov.m.focus_pane("old-2") == {"ok": True, "pane_id": "pane-2", "workspace_path": "/w/Other"}


async def test_focus_pane_of_a_gone_pane_says_so(ov: Env) -> None:
    ov.fake.gone.add("pane-9")
    assert ov.m.focus_pane("pane-9") == {"ok": False, "error": "pane not found"}
    assert ov.m.focus_pane("") == {"ok": False, "error": "pane not found"}


async def test_ws_api_routes_the_new_requests(ov: Env) -> None:
    for name in ("channels.overview", "channels.unbind_many", "channels.focus_pane"):
        assert name in ws_api.MESSAGE_TYPES
    ov.store.bind("pane-1", Location("telegram", "default", "-100", "50", "api"))
    assert (await ws_api._dispatch(ov.m, "channels.overview", {}))["ok"] is True
    res = await ws_api._dispatch(ov.m, "channels.unbind_many", {"pane_ids": ["pane-1"]})
    assert res["results"][0]["removed"] is True
    bad = await ws_api._dispatch(ov.m, "channels.unbind_many", {"pane_ids": "pane-1"})
    assert bad == {"ok": False, "error": "pane_ids must be a list of pane ids"}
    focus = await ws_api._dispatch(ov.m, "channels.focus_pane", {"pane_id": "pane-2"})
    assert focus["ok"] is True and focus["workspace_path"] == "/w/Other"


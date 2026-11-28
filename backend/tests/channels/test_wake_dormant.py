"""A binding outlives its pane: closing the pane parks the binding (dormant) instead of
deleting it, the chat can wake the conversation back or start a new one, and unlinking --
from the chat or the window -- is what lets the chat go."""

from __future__ import annotations

import dataclasses
from typing import Any

from agent_team_backend.channels import manager as mgr_mod
from agent_team_backend.channels import store as store_mod
from agent_team_backend.channels import wake, ws_api
from agent_team_backend.channels.base import Capabilities, Location
from agent_team_backend.channels.manager import (
    FRESH_CALLBACK, UNLINK_CALLBACK, UNLINK_CONFIRM_CALLBACK, UNLINK_KEEP_CALLBACK, WAKE_CALLBACK,
    fresh_buttons, unlink_buttons, wake_buttons,
)
from agent_team_backend.channels.store import ChannelStore
from agent_team_backend.db import Database

from .test_manager import Env, _make_env, env, fast_timers  # noqa: F401 — pytest fixtures


def _zh(key: str, **kw: Any) -> str:
    return wake.text("zh-TW", key, **kw)


class FakeWakes:
    """Both wake seams: what comes back, and every call."""

    def __init__(self, env: Env) -> None:
        self.env = env
        self.result: dict[str, Any] = {"ok": True, "pane_id": "pane-1b"}
        self.fresh_result: dict[str, Any] = {"ok": True, "pane_id": "pane-1n"}
        self.calls: list[tuple[str, ...]] = []
        env.m._seams = dataclasses.replace(
            env.m._seams, wake=self.wake, wake_fresh=self.wake_fresh, windows_open=lambda: True,
            wake_target=lambda _pane_id: {"workspace_path": "/ws", "session_id": "sess-1", "agent": "claude"})

    async def wake(self, pane_id: str, workspace_path: str, session_id: str) -> dict[str, Any]:
        self.calls.append(("wake", pane_id, workspace_path, session_id))
        if self.result.get("ok"):
            self.env.fake.gone.discard(self.result["pane_id"])
        return dict(self.result)

    async def wake_fresh(self, pane_id: str, workspace_path: str, agent: str, name: str) -> dict[str, Any]:
        self.calls.append(("fresh", pane_id, workspace_path, agent, name))
        if self.fresh_result.get("ok"):
            self.env.fake.gone.discard(self.fresh_result["pane_id"])
        return dict(self.fresh_result)


async def _close(env: Env, *, session_id: str = "sess-1", agent: str = "claude") -> dict[str, Any]:
    """The window closed pane-1 for good (App.vue's paneClosed)."""
    env.fake.gone.add("pane-1")
    return await env.m.park("pane-1", pane_name="api", workspace_path="/ws", session_id=session_id, agent=agent)


def _no_buttons(env: Env) -> None:
    env.tg.capabilities = Capabilities(threads=True, create_location=True, edit=True, typing=True,
                                       buttons=False, text_limit=4000)


# --- store ---------------------------------------------------------------------------


def test_v9_gives_old_bindings_an_active_state_and_parks_keep_a_known_target(tmp_path) -> None:
    db = Database(tmp_path / "n.db")
    for version, fn in ((1, store_mod._v1), (2, store_mod._v2), (3, store_mod._v3), (4, store_mod._v4),
                        (5, store_mod._v5), (6, store_mod._v6), (7, store_mod._v7), (8, store_mod._v8)):
        db.migrate("channels", version, fn)
    with db.transaction() as cur:
        cur.execute("INSERT INTO channel_bindings (pane_id, platform, account, chat_id, thread_id, title,"
                    " created_at, workspace_path, session_id) VALUES ('p1', 'telegram', 'default', '-1', '5',"
                    " 't', 9, '/known', 's-known')")
    s = ChannelStore(db)
    assert db.schema_version("channels") == 10
    [b] = s.bindings()
    assert (b.state, b.agent, b.closed_at, b.dormant) == ("active", "", 0, False)
    parked = s.park("p1", workspace_path="/other", session_id="s-other", agent="codex")
    assert parked is not None and parked.dormant and parked.closed_at > 0
    # What the binding already learnt stays; only what it did not know is filled in.
    assert (parked.workspace_path, parked.session_id, parked.agent) == ("/known", "s-known", "codex")
    assert parked.public()["state"] == "dormant"
    assert s.park("nobody") is None
    assert s.rename_pane("p1", "p2")
    [b] = s.bindings()
    assert (b.pane_id, b.state, b.closed_at) == ("p2", "active", 0)
    s.park("p2")
    assert s.activate("p2") and not s.activate("p2")
    assert s.bindings()[0].state == "active"
    db.close()


# --- closing a pane ------------------------------------------------------------------


async def test_closing_a_pane_parks_its_binding_and_tells_the_chat(env: Env) -> None:
    FakeWakes(env)
    answer = await _close(env)
    assert answer["ok"] and answer["parked"]
    [b] = env.store.bindings()
    assert (b.pane_id, b.state, b.workspace_path, b.session_id, b.agent) == ("pane-1", "dormant", "/ws", "sess-1",
                                                                            "claude")
    await env.m.wait_idle()
    notice = _zh("parked", name="api")
    assert notice in env.tg.texts()
    assert env.tg.buttons[notice] == wake_buttons("zh-TW")


async def test_a_closed_pane_with_no_conversation_offers_a_new_one(env: Env) -> None:
    FakeWakes(env)
    await _close(env, session_id="")
    await env.m.wait_idle()
    assert env.tg.buttons[_zh("parked", name="api")] == fresh_buttons("zh-TW")


async def test_closing_an_unbound_pane_changes_nothing(env: Env) -> None:
    assert await env.m.park("pane-9") == {"ok": True, "parked": False}
    assert [b.pane_id for b in env.store.bindings()] == ["pane-1"]


async def test_a_mirror_child_topic_still_goes_with_its_pane(env: Env) -> None:
    env.store.bind("child-1", Location("telegram", "default", "-100", "77", "↳ kid"), parent_pane_id="pane-1",
                   auto=True)
    assert (await env.m.park("child-1", pane_name="kid"))["parked"] is False
    assert "child-1" not in [b.pane_id for b in env.store.bindings()]


async def test_the_window_parks_and_wakes_through_ws(env: Env) -> None:
    fw = FakeWakes(env)
    env.fake.gone.add("pane-1")
    assert "channels.park" in ws_api.MESSAGE_TYPES and "channels.wake" in ws_api.MESSAGE_TYPES
    answer = await ws_api._dispatch(env.m, "channels.park", {
        "pane_id": "pane-1", "pane_name": "api", "workspace_path": "/ws", "session_id": "sess-1",
        "agent": "claude"})
    assert answer["binding"]["state"] == "dormant"
    assert (await ws_api._dispatch(env.m, "channels.wake", {"pane_id": "pane-1", "fresh": True}))["ok"]
    assert fw.calls[-1][0] == "fresh"


# --- the chat of a dormant binding ---------------------------------------------------


async def test_a_dormant_chat_wakes_its_conversation_back(env: Env) -> None:
    fw = FakeWakes(env)
    await _close(env)
    await env.inbound("please carry on")
    assert env.tg.buttons[env.tg.texts()[-1]] == wake_buttons("zh-TW")
    await env.inbound("", callback=WAKE_CALLBACK)
    assert fw.calls == [("wake", "pane-1", "/ws", "sess-1")]
    [b] = env.store.bindings()
    assert (b.pane_id, b.state) == ("pane-1b", "active")
    assert env.fake.delivered[-1][:2] == ("pane-1b", "please carry on")


async def test_a_wake_that_comes_back_under_the_same_id_is_active_again(env: Env) -> None:
    fw = FakeWakes(env)
    fw.result = {"ok": True, "pane_id": "pane-1"}
    await _close(env)
    await env.inbound("", callback=WAKE_CALLBACK)
    assert env.store.bindings()[0].state == "active"


async def test_an_unresumable_conversation_offers_a_new_one_which_starts_and_binds(env: Env) -> None:
    fw = FakeWakes(env)
    fw.result = {"ok": False, "code": "unknown-session-id", "started": False}
    await _close(env)
    await env.inbound("", callback=WAKE_CALLBACK)
    failed = env.tg.texts()[-1]
    assert failed == _zh("unresumable", reason=_zh("reason_unavailable"))
    assert env.tg.buttons[failed] == fresh_buttons("zh-TW")
    await env.inbound("", callback=FRESH_CALLBACK)
    assert fw.calls[-1] == ("fresh", "pane-1", "/ws", "claude", "api")
    assert env.tg.texts()[-1] == _zh("woke_fresh")
    [b] = env.store.bindings()
    assert (b.pane_id, b.state) == ("pane-1n", "active")
    await env.inbound("next")
    assert env.fake.delivered[-1][:2] == ("pane-1n", "next")


async def test_a_dormant_chat_with_no_conversation_asks_for_a_new_one(env: Env) -> None:
    fw = FakeWakes(env)
    await _close(env, session_id="")
    await env.inbound("", callback=WAKE_CALLBACK)
    assert env.tg.texts()[-1] == _zh("fresh_only", name="api")
    assert fw.calls == []
    await env.inbound("/wake_new")
    assert fw.calls == [("fresh", "pane-1", "/ws", "claude", "api")]


async def test_a_failed_new_conversation_offers_only_unlink(env: Env) -> None:
    fw = FakeWakes(env)
    fw.fresh_result = {"ok": False, "code": "workspace-missing", "started": False}
    await _close(env)
    await env.inbound("", callback=FRESH_CALLBACK)
    assert env.tg.texts()[-1] == _zh("workspace_missing")
    assert env.tg.buttons[env.tg.texts()[-1]] == unlink_buttons("zh-TW")
    assert env.store.bindings()[0].dormant


async def test_a_conversation_open_in_another_pane_is_followed_there(env: Env) -> None:
    fw = FakeWakes(env)
    fw.result = {"ok": False, "code": "session-open-elsewhere", "started": False,
                 "open_pane_id": "live-2", "open_pane_name": "api-2"}
    await _close(env)
    await env.inbound("kept for later")
    await env.inbound("", callback=WAKE_CALLBACK)
    assert _zh("moved_to_open", name="api-2") in env.tg.texts()
    [b] = env.store.bindings()
    assert (b.pane_id, b.state) == ("live-2", "active")
    assert env.fake.delivered[-1][:2] == ("live-2", "kept for later")


async def test_a_conversation_open_in_a_pane_another_chat_drives_is_not_taken(env: Env) -> None:
    fw = FakeWakes(env)
    env.store.bind("live-2", Location("telegram", "default", "-200", "", "other"))
    fw.result = {"ok": False, "code": "session-open-elsewhere", "started": False,
                 "open_pane_id": "live-2", "open_pane_name": "api-2"}
    await _close(env)
    await env.inbound("", callback=WAKE_CALLBACK)
    assert env.tg.texts()[-1].startswith(_zh("open_elsewhere"))
    assert next(b for b in env.store.bindings() if b.chat_id == "-100").pane_id == "pane-1"


async def test_a_live_pane_answers_the_new_conversation_button_without_sending_it(env: Env) -> None:
    fw = FakeWakes(env)
    await env.inbound("", callback=FRESH_CALLBACK)
    assert env.tg.texts()[-1] == _zh("already_online")
    assert fw.calls == [] and env.fake.delivered == []


# --- unlinking -----------------------------------------------------------------------


async def test_unlink_asks_once_then_lets_the_chat_go(env: Env) -> None:
    FakeWakes(env)
    await _close(env)
    await env.inbound("", callback=UNLINK_CALLBACK)
    ask = env.tg.texts()[-1]
    assert ask == _zh("unlink_ask", name="api")
    assert [data for _, data in env.tg.buttons[ask]] == [UNLINK_CONFIRM_CALLBACK, UNLINK_KEEP_CALLBACK]
    assert len(env.store.bindings()) == 1
    await env.inbound("", callback=UNLINK_CONFIRM_CALLBACK)
    await env.m.wait_idle()
    assert env.store.bindings() == []
    assert _zh("unlinked", name="api") in env.tg.texts()
    await env.inbound("anyone?")
    assert env.tg.texts()[-1] == mgr_mod.MSG_NOT_BOUND


async def test_keep_leaves_the_binding_alone(env: Env) -> None:
    FakeWakes(env)
    await _close(env)
    await env.inbound("", callback=UNLINK_CALLBACK)
    await env.inbound("", callback=UNLINK_KEEP_CALLBACK)
    assert env.tg.texts()[-1] == _zh("unlink_kept")
    assert env.store.bindings()[0].dormant


async def test_a_live_pane_can_be_unlinked_from_its_chat_too(env: Env) -> None:
    FakeWakes(env)
    await env.inbound("/unlink")
    await env.inbound("/unlink_confirm")
    await env.m.wait_idle()
    assert env.store.bindings() == [] and env.fake.delivered == []


async def test_mattermost_unlinks_with_the_bare_words(env: Env) -> None:
    assert (await env.m.configure("mattermost", {}, {"token": "tok-" + "mm"}))["ok"]
    env.store.add_allow("mattermost", "7", "alice", 1)
    env.store.bind("pane-2", Location("mattermost", "default", "c1", "", "ops"))
    env.adapters["mattermost"].capabilities = Capabilities(threads=False, create_location=False, edit=True,
                                                           typing=True, buttons=False, text_limit=4000)
    at = {"platform": "mattermost", "chat": "c1", "thread": ""}
    await env.inbound("unlink", **at)
    ask = env.adapters["mattermost"].texts()[-1]
    assert "unlink_confirm" in ask and "/unlink_confirm" not in ask
    await env.inbound("unlink_confirm", **at)
    await env.m.wait_idle()
    assert "pane-2" not in [b.pane_id for b in env.store.bindings()]


async def test_a_buttonless_chat_is_told_the_typed_commands_when_its_pane_closes(env: Env) -> None:
    FakeWakes(env)
    _no_buttons(env)
    await _close(env)
    await env.m.wait_idle()
    parked = next(t for t in env.tg.texts() if t.startswith(_zh("parked", name="api")))
    assert "/wake" in parked and "/unlink" in parked


# --- the window's own wake -------------------------------------------------------------


async def test_the_window_wakes_a_dormant_binding_and_the_chat_is_told(env: Env) -> None:
    fw = FakeWakes(env)
    await _close(env)
    answer = await env.m.wake_from_app("pane-1")
    assert answer == {"ok": True, "pane_id": "pane-1b"}
    assert fw.calls == [("wake", "pane-1", "/ws", "sess-1")]
    await env.m.wait_idle()
    assert _zh("woke_app", name="api") in env.tg.texts()
    assert env.store.bindings()[0].state == "active"


async def test_the_window_starts_a_new_conversation_and_reports_a_refusal(env: Env) -> None:
    fw = FakeWakes(env)
    await _close(env, session_id="")
    assert (await env.m.wake_from_app("pane-1"))["pane_id"] == "pane-1n"
    assert fw.calls[-1][0] == "fresh"
    env.fake.gone.add("pane-1n")
    env.store.park("pane-1n")
    fw.fresh_result = {"ok": False, "code": "quota", "agent": "claude", "started": False}
    answer = await env.m.wake_from_app("pane-1n")
    assert answer == {"ok": False, "reason": "quota", "error": _zh("quota", agent="claude")}
    assert (await env.m.wake_from_app("nobody"))["ok"] is False

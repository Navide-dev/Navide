"""Two-way pane mirroring (round 4): verbosity, local prompts, delegation, children."""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

import pytest

from agent_team_backend import agent_messaging
from agent_team_backend.channels import mirror as mirror_mod
from agent_team_backend.channels import redact, ws_api
from agent_team_backend.channels.base import Capabilities, ChannelSendError, Location
from agent_team_backend.channels.mirror import (
    EchoGuard, Outbox, OwnerMap, format_tree, match_name, parse_at_target, parse_command,
)
from agent_team_backend.channels.store import ChannelStore
from agent_team_backend.db import Database

from .test_manager import (  # noqa: F401 — fixtures and helpers shared with the manager suite
    Env, _said, _until, clocked, env, fast_timers,
)

NO_THREADS = Capabilities(threads=False, create_location=False, edit=False, typing=False,
                          buttons=False, text_limit=4000)


def _pane(pid: str, name: str, parent: str = "", status: str = "idle") -> dict[str, Any]:
    return {"pane_id": pid, "name": name, "qualified_name": f"proj/{name}",
            "spawned_by": parent, "display_status": status}


def _use_directory(env: Env, panes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    env.m._seams.pane_directory = lambda: panes
    return panes


def _topics(env: Env) -> None:
    """Give the fake adapter a distinct thread per created topic."""
    counter = iter(range(100, 200))

    async def create_location(chat_id: str, title: str) -> Location:
        return Location("telegram", "default", chat_id, str(next(counter)), title)

    env.tg.create_location = create_location  # type: ignore[method-assign]


def _set_verbosity(env: Env, level: str) -> None:
    assert env.store.set_verbosity("pane-1", level) is not None


# --- store / WS ------------------------------------------------------------------


def test_store_v4_gives_old_bindings_the_pre_mirror_replies_level(tmp_path) -> None:
    from agent_team_backend.channels import store as store_mod

    db = Database(tmp_path / "n.db")
    for version, fn in ((1, store_mod._v1), (2, store_mod._v2), (3, store_mod._v3)):
        db.migrate("channels", version, fn)
    with db.transaction() as cur:
        cur.execute("INSERT INTO channel_bindings VALUES ('p1','telegram','default','-1','5','t',9)")
    s = ChannelStore(db)
    assert db.schema_version("channels") == 5
    assert s.bindings()[0].public() == {
        "pane_id": "p1", "platform": "telegram", "account": "default", "chat_id": "-1", "thread_id": "5",
        "title": "t", "verbosity": "replies", "parent_pane_id": "", "auto": False}
    # A binding made after the upgrade with no level named gets the conservative one too.
    assert s.bind("p2", Location("telegram", "default", "-2", "", "u")).verbosity == "replies"
    db.close()


async def test_set_binding_options_shape_and_validation(env: Env) -> None:
    listed = env.m.bindings()["bindings"][0]
    assert listed["verbosity"] == "full" and listed["parent_pane_id"] == "" and listed["auto"] is False
    result = await ws_api._dispatch(env.m, "channels.set_binding_options",
                                    {"pane_id": "pane-1", "verbosity": "standard"})
    assert result["ok"] and result["binding"]["verbosity"] == "standard"
    assert env.m.bindings()["bindings"][0]["verbosity"] == "standard"
    bad = await env.m.set_binding_options("pane-1", "loud")
    assert not bad["ok"] and "minimal" in bad["error"]
    assert not (await env.m.set_binding_options("nobody", "full"))["ok"]
    assert ("channels.changed", {}) in env.fake.events


async def test_bind_uses_the_level_the_user_chose_and_defaults_to_replies(env: Env) -> None:
    chosen = await ws_api._dispatch(env.m, "channels.bind", {
        "pane_id": "pane-7", "pane_name": "a", "platform": "telegram", "mode": "existing",
        "chat_id": "-700", "verbosity": "full"})
    assert chosen["ok"] and chosen["binding"]["verbosity"] == "full"
    unnamed = await ws_api._dispatch(env.m, "channels.bind", {
        "pane_id": "pane-8", "pane_name": "b", "platform": "telegram", "mode": "existing", "chat_id": "-800"})
    assert unnamed["ok"] and unnamed["binding"]["verbosity"] == "replies"
    bad = await env.m.bind("pane-8", "b", "telegram", "existing", "-800", verbosity="loud")
    assert not bad["ok"] and "replies" in bad["error"]
    assert next(b for b in env.store.bindings() if b.pane_id == "pane-8").verbosity == "replies"


async def test_moving_a_binding_takes_the_newly_chosen_level(env: Env) -> None:
    await env.m.set_binding_options("pane-1", "minimal")
    result = await env.m.bind("pane-1", "api", "telegram", "existing", "-100", "51", verbosity="standard")
    assert result["binding"]["verbosity"] == "standard"


async def test_rebinding_a_pane_keeps_its_verbosity(env: Env) -> None:
    await env.m.set_binding_options("pane-1", "minimal")
    result = await env.m.bind("pane-1", "api", "telegram", "existing", "-100", "51")
    assert result["binding"]["verbosity"] == "minimal"


# --- pure helpers ------------------------------------------------------------------


def test_command_and_target_parsing() -> None:
    assert parse_command("/status") == ("status", "")
    assert parse_command("/status@navide_bot") == ("status", "")
    assert parse_command("/stop tester") == ("stop", "tester")
    assert parse_command("/stop") == ("", "")
    assert parse_command("hello") == ("", "")
    kids = [_pane("2", "tester"), _pane("3", "test runner"), _pane("4", "docs")]
    assert match_name("DOCS", kids)["pane_id"] == "4"
    assert match_name("test", kids) is None  # ambiguous prefix
    assert match_name("↳ tester", kids)["pane_id"] == "2"
    pane, rest = parse_at_target("@test runner go now", kids)
    assert (pane["pane_id"], rest) == ("3", "go now")
    assert parse_at_target("@tester", kids) is None  # nothing to say
    assert parse_at_target("@testerx hi", kids) is None
    assert parse_at_target("plain", kids) is None


def test_format_tree_and_echo_guard_and_owner_map() -> None:
    tree = format_tree(_pane("1", "main", status="running"),
                       [(1, _pane("2", "tester", "1", "awaiting")), (1, _pane("3", "docs", "1"))])
    assert tree == "📋 main　🔄 執行中\n├─ ↳ tester　⚠️ 等確認\n└─ ↳ docs　💤 閒置"
    guard = EchoGuard(clock=lambda: 0.0)
    guard.remember("p", "run the login tests please")
    assert guard.consume("p", "  run the   login tests please and report ")
    assert not guard.consume("p", "run the login tests please")  # single use
    owners = OwnerMap()
    owners.remember("loc", ["1", "2"], "child")
    assert owners.owner("loc", "2") == "child" and owners.owner("loc", "9") == ""
    owners.rename("child", "child2")
    assert owners.owner("loc", "1") == "child2"


async def test_outbox_paces_to_the_rate_and_merges_a_backlog() -> None:
    now = {"t": 0.0}
    sent: list[str] = []
    slept: list[float] = []

    async def send(text: str, buttons=None) -> list[str]:
        sent.append(text)
        return [str(len(sent))]

    async def sleep(seconds: float) -> None:
        slept.append(seconds)
        now["t"] += seconds

    box = Outbox(send, per_min=20, burst=2, limit=4000, clock=lambda: now["t"], sleep=sleep)
    for i in range(2):  # the burst goes out at once
        box.post(f"m{i}", "pane")
        await asyncio.sleep(0)
        await asyncio.sleep(0)
    assert sent == ["m0", "m1"] and not slept
    for i in range(2, 6):  # tokens are gone: these wait, and are merged rather than dropped
        box.post(f"m{i}", "pane")
    await box._task
    assert slept and sent == ["m0", "m1", "m2\n\nm3\n\nm4\n\nm5"]
    assert now["t"] >= 3.0 - 1e-6  # 20/min = one token per 3s


async def test_outbox_never_merges_across_owners_or_past_the_limit() -> None:
    sent: list[str] = []

    async def send(text: str, buttons=None) -> list[str]:
        sent.append(text)
        return []

    box = Outbox(send, per_min=6000, burst=1, limit=20, sleep=lambda s: asyncio.sleep(0))
    box.post("a" * 15, "x")
    box.post("b" * 3, "y")
    box.post("c" * 8, "y")
    box.post("d" * 8, "y")
    await box._task
    assert sent[0] == "a" * 15 and "bbb" in sent[1] and all(len(t) <= 20 for t in sent)


def _status_seen(env: Env) -> bool:
    return any("處理中" in t for t in env.tg.texts()) or any("處理中" in t for _, t in env.tg.edits)


# --- local prompts and results ------------------------------------------------------


async def test_full_verbosity_mirrors_local_prompt_text_and_labels_the_result(env: Env) -> None:
    env.m.mirror.on_local_prompt("pane-1", "順便也改註冊頁的同一個判斷")
    await _until(lambda: "🖥 你：順便也改註冊頁的同一個判斷" in env.tg.texts())
    await _until(lambda: _status_seen(env))
    env.turn_complete("pane-1", "註冊頁已同步修正。")
    await _until(lambda: "✅ 完成 · 🖥 本機\n註冊頁已同步修正。" in env.tg.texts())
    assert any(t.startswith("✅ 完成") for _, t in env.tg.edits)  # the status message closed in place


async def test_standard_verbosity_only_says_a_local_command_happened(env: Env) -> None:
    _set_verbosity(env, "standard")
    env.m.mirror.on_local_prompt("pane-1", "secret local words")
    await _until(lambda: "🖥 本機下了新指令" in env.tg.texts())
    assert not _said(env, "secret local words")


async def test_minimal_verbosity_sends_only_the_result(env: Env) -> None:
    _set_verbosity(env, "minimal")
    env.m.mirror.on_local_prompt("pane-1", "typed at the keyboard")
    await asyncio.sleep(0.15)
    assert env.tg.texts() == [] and env.tg.typing == 0 and env.tg.edits == []
    env.turn_complete("pane-1", "done")
    await _until(lambda: "✅ 完成 · 🖥 本機\ndone" in env.tg.texts())


async def test_replies_level_sends_only_answers_to_what_the_chat_started(env: Env) -> None:
    _topics(env)
    _set_verbosity(env, "replies")
    _use_directory(env, [_pane("pane-1", "main"), _pane("pane-9", "planner"), _pane("pane-2", "tester", "pane-1")])
    env.m.mirror.on_local_prompt("pane-1", "local secret prompt")
    env.m.mirror.on_message_rows([_row("u1", "planner", "main", "delegated secret")])
    env.turn_complete("pane-1", "local secret result")
    env.turn_complete("pane-2", "child secret result")
    env.fake.states["pane-1"] = {"exists": True, "busy": True, "display_status": "awaiting"}
    env.m.mirror.on_status("pane-1")
    await env.m.mirror.sync_lineage()
    await asyncio.sleep(0.2)
    assert env.tg.texts() == [] and env.tg.typing == 0 and env.tg.edits == []
    assert [b.pane_id for b in env.store.bindings()] == ["pane-1"]  # no child topic either
    env.fake.states["pane-1"] = {"exists": True, "busy": False, "display_status": "idle"}
    env.m.mirror.on_status("pane-1")
    await env.inbound("what changed?")
    env.fake.verdicts["k1"] = {"status": "delivered"}
    await asyncio.sleep(0.1)
    env.turn_complete("pane-1", "the chat's answer")
    await _until(lambda: _said(env, "the chat's answer"))
    assert not _said(env, "secret")


async def test_a_chat_message_coming_back_as_the_prompt_is_not_echoed(env: Env) -> None:
    await env.inbound("fix the login bug in auth.ts")
    env.m.mirror.on_local_prompt("pane-1", "fix the login bug in auth.ts")
    env.m.mirror.on_local_prompt("pane-1", "[Navide MSG] from: telegram:alice\nfix the login bug")
    await asyncio.sleep(0.15)
    assert not _said(env, "🖥")


async def test_local_prompt_text_is_redacted(env: Env) -> None:
    redact.add_secret("sk-live-1234567890abcdef")
    env.m.mirror.on_local_prompt("pane-1", "use key sk-live-1234567890abcdef now")
    await _until(lambda: _said(env, "🖥 你："))
    assert not _said(env, "sk-live-1234567890abcdef") and _said(env, "<redacted>")


async def test_a_turn_nobody_announced_is_still_mirrored_as_local(env: Env) -> None:
    env.turn_complete("pane-1", "result from a turn we never saw start")
    await _until(lambda: "✅ 完成 · 🖥 本機\nresult from a turn we never saw start" in env.tg.texts())


async def test_unbound_pane_activity_goes_nowhere(env: Env) -> None:
    env.m.mirror.on_local_prompt("stranger", "hello")
    env.turn_complete("stranger", "bye")
    await asyncio.sleep(0.1)
    assert env.tg.texts() == []


# --- delegation ----------------------------------------------------------------------


def _row(uid: str, sender: str, recipient: str, content: str, **extra: Any) -> dict[str, Any]:
    return {"uid": uid, "sender": sender, "recipient": recipient, "content": content,
            "status": "queued", **extra}


async def test_delegation_text_is_mirrored_in_full_mode_with_source_on_the_result(env: Env) -> None:
    _use_directory(env, [_pane("pane-1", "main"), _pane("pane-9", "planner")])
    env.m.mirror.on_message_rows([_row("u1", "planner", "main", "跑登入測試，失敗就回報")])
    await _until(lambda: "🤖 planner → main：跑登入測試，失敗就回報" in env.tg.texts())
    env.turn_complete("pane-1", "測試通過")
    await _until(lambda: "✅ 完成 · 🤖 planner\n測試通過" in env.tg.texts())


async def test_delegation_is_deduplicated_and_skips_chat_and_failed_rows(env: Env) -> None:
    _use_directory(env, [_pane("pane-1", "main"), _pane("pane-9", "planner")])
    env.m.mirror.on_message_rows([
        _row("u1", "planner", "main", "same words"),
        _row("u2", "planner", "main", "same words"),  # same message logged by the other window
        _row("u3", "telegram:alice", "main", "from the chat"),
        _row("u4", "planner", "main", "never sent", status="failed"),
        _row("u5", "planner", "main", "an ack", kind="ack"),
    ])
    await asyncio.sleep(0.15)
    assert [t for t in env.tg.texts() if t.startswith("🤖")] == ["🤖 planner → main：same words"]


async def test_standard_verbosity_hides_delegation_text(env: Env) -> None:
    _set_verbosity(env, "standard")
    _use_directory(env, [_pane("pane-1", "main"), _pane("pane-9", "planner")])
    env.m.mirror.on_message_rows([_row("u1", "planner", "main", "private plan")])
    await asyncio.sleep(0.15)
    assert not _said(env, "private plan")


# --- awaiting -------------------------------------------------------------------------


async def test_awaiting_is_pushed_even_for_a_turn_the_chat_did_not_start(env: Env) -> None:
    env.m.mirror.on_local_prompt("pane-1", "run the migration")
    env.fake.states["pane-1"] = {"exists": True, "busy": True, "display_status": "awaiting"}
    env.m.mirror.on_status("pane-1")
    await _until(lambda: _said(env, "Allow Bash(npm run build)?"))
    env.m.mirror.on_status("pane-1")  # same prompt: not posted twice
    await asyncio.sleep(0.1)
    assert sum("Allow Bash" in t for t in env.tg.texts()) == 1
    assert env.m.relay.for_pane("pane-1")
    env.fake.states["pane-1"] = {"exists": True, "busy": True, "display_status": "running"}
    env.m.mirror.on_status("pane-1")
    assert env.m.relay.for_pane("pane-1") == []  # answered at the keyboard


# --- children ---------------------------------------------------------------------------


async def test_child_of_a_bound_pane_gets_an_auto_topic_and_is_two_way(env: Env) -> None:
    _topics(env)
    _set_verbosity(env, "standard")
    _use_directory(env, [_pane("pane-1", "main"), _pane("pane-2", "tester", "pane-1")])
    inherited: list[tuple[str, str]] = []
    env.m._seams.inherit_taint = lambda child, parent: inherited.append((child, parent))
    await env.m.mirror.sync_lineage()
    child = next(b for b in env.store.bindings() if b.pane_id == "pane-2")
    assert (child.auto, child.parent_pane_id, child.title, child.verbosity) == (True, "pane-1", "↳ tester", "standard")
    assert child.thread_id == "100" and child.chat_id == "-100"
    assert inherited == [("pane-2", "pane-1")]
    await _until(lambda: "🤖 main 開了子視窗「tester」" in env.tg.texts())
    await _until(lambda: _said(env, "這個話題連接子視窗「tester」"))
    await env.m.mirror.sync_lineage()  # nothing new: no second topic
    assert [b.pane_id for b in env.store.bindings() if b.auto] == ["pane-2"]
    # Two-way: a message in the child's topic reaches the child pane.
    await env.inbound("run e2e", thread="100")
    assert ("pane-2", "run e2e", "telegram:alice") in env.fake.delivered


async def test_lineage_is_event_driven_from_the_registry(env: Env) -> None:
    _topics(env)
    agent_messaging._reset_for_test()
    env.m._seams.pane_directory = lambda: [
        {"pane_id": p.pane_id, "name": p.name, "qualified_name": p.qualified_name,
         "spawned_by": p.spawned_by, "display_status": p.display_status}
        for p in agent_messaging.list_panes()]
    agent_messaging.pane_listeners.append(env.m.mirror.on_registry)
    try:
        agent_messaging.register("pane-1", "main", "/w")
        agent_messaging.register("pane-2", "tester", "/w", spawned_by="pane-1")
        await _until(lambda: any(b.pane_id == "pane-2" and b.auto for b in env.store.bindings()))
    finally:
        agent_messaging.pane_listeners.remove(env.m.mirror.on_registry)
        agent_messaging._reset_for_test()


async def test_registry_status_event_relays_a_childs_permission_prompt(env: Env) -> None:
    agent_messaging._reset_for_test()
    agent_messaging.register("pane-1", "main", "/w")
    agent_messaging.register("pane-2", "tester", "/w", spawned_by="pane-1")
    env.m._seams.pane_directory = lambda: [
        {"pane_id": p.pane_id, "name": p.name, "qualified_name": p.qualified_name,
         "spawned_by": p.spawned_by, "display_status": p.display_status}
        for p in agent_messaging.list_panes()]
    env.tg.capabilities = NO_THREADS
    env.m._seams.pane_state = lambda pid: {
        "exists": True, "busy": True,
        "display_status": agent_messaging.get(pid).display_status if agent_messaging.get(pid) else ""}
    agent_messaging.pane_listeners.append(env.m.mirror.on_registry)
    try:
        agent_messaging.set_busy("pane-2", True, "awaiting")
        await _until(lambda: _said(env, "↳ tester"))
        assert _said(env, "Allow Bash(npm run build)?")
    finally:
        agent_messaging.pane_listeners.remove(env.m.mirror.on_registry)
        agent_messaging._reset_for_test()


async def test_without_threads_child_results_ride_the_parent_chat_with_a_prefix(env: Env) -> None:
    env.tg.capabilities = NO_THREADS
    _use_directory(env, [_pane("pane-1", "main"), _pane("pane-2", "tester", "pane-1")])
    await env.m.mirror.sync_lineage()
    assert [b for b in env.store.bindings() if b.auto] == []
    long_text = "T" * 900
    env.turn_complete("pane-2", long_text)
    await _until(lambda: any(t.startswith(f"{mirror_mod.child_tag('tester')} ✅ 完成 · 🖥 本機\n") for t in env.tg.texts()))
    # Full verbosity: the whole text, chunked by the platform limit rather than summarised.
    assert sum(t.count("T") for t in env.tg.texts()) == 900
    _set_verbosity(env, "standard")
    env.turn_complete("pane-2", long_text)
    await _until(lambda: _said(env, "完整內容請在 Navide 查看"))
    _set_verbosity(env, "minimal")
    before = len(env.tg.sent)
    env.turn_complete("pane-2", "hidden")
    await asyncio.sleep(0.1)
    assert len(env.tg.sent) == before


async def test_topic_creation_failure_falls_back_to_prefixed_messages(env: Env) -> None:
    async def boom(chat_id: str, title: str) -> Location:
        raise RuntimeError("forum topics are off")

    env.tg.create_location = boom  # type: ignore[method-assign]
    _use_directory(env, [_pane("pane-1", "main"), _pane("pane-2", "tester", "pane-1")])
    await env.m.mirror.sync_lineage()
    await env.m.mirror.sync_lineage()
    assert [b for b in env.store.bindings() if b.auto] == []
    env.turn_complete("pane-2", "still reported")
    await _until(lambda: _said(env, f"{mirror_mod.child_tag('tester')} ✅ 完成"))


async def test_a_chat_that_is_not_a_forum_is_asked_for_a_topic_only_once(env: Env, caplog) -> None:
    # Every new child in a plain Telegram group used to try createForumTopic again
    # and warn "the chat is not a forum"; the chat cannot have topics, so it is remembered.
    calls: list[str] = []

    async def not_a_forum(chat_id: str, title: str) -> Location:
        calls.append(title)
        raise ChannelSendError("這個群組沒有開啟主題功能 (the chat is not a forum)")

    env.tg.create_location = not_a_forum  # type: ignore[method-assign]
    caplog.set_level(logging.INFO, logger="agent_team_backend.channels.mirror")
    panes = _use_directory(env, [_pane("pane-1", "main"), _pane("pane-2", "tester", "pane-1")])
    await env.m.mirror.sync_lineage()
    panes.append(_pane("pane-3", "linter", "pane-1"))
    await env.m.mirror.sync_lineage()
    assert calls == ["↳ tester"]
    assert [b for b in env.store.bindings() if b.auto] == []
    warnings = [r for r in caplog.records if r.levelno >= logging.WARNING and "topic" in r.getMessage()]
    assert len(warnings) == 1
    env.turn_complete("pane-3", "still reported")
    await _until(lambda: _said(env, f"{mirror_mod.child_tag('linter')} ✅ 完成"))


def _flaky_forum(env: Env) -> list[str]:
    # A plain group until `env.forum_on` is set: then it can have topics.
    calls: list[str] = []
    env.forum_on = False  # type: ignore[attr-defined]

    async def create(chat_id: str, title: str) -> Location:
        calls.append(title)
        if not env.forum_on:  # type: ignore[attr-defined]
            raise ChannelSendError("這個群組沒有開啟主題功能 (the chat is not a forum)")
        return Location(env.tg.platform, env.tg.account, chat_id, f"t-{len(calls)}")

    env.tg.create_location = create  # type: ignore[method-assign]
    return calls


async def test_a_chat_that_is_not_a_forum_is_not_asked_again_within_the_retry_window(clocked) -> None:
    env, clock = clocked
    calls = _flaky_forum(env)
    panes = _use_directory(env, [_pane("pane-1", "main"), _pane("pane-2", "tester", "pane-1")])
    await env.m.mirror.sync_lineage()
    clock.t += mirror_mod.NO_TOPIC_RETRY_S - 1
    panes.append(_pane("pane-3", "linter", "pane-1"))
    await env.m.mirror.sync_lineage()
    assert calls == ["↳ tester"]


async def test_a_chat_that_is_not_a_forum_is_asked_again_after_the_retry_window(clocked, caplog) -> None:
    # A group can turn topics on later; that used to need an app restart.
    env, clock = clocked
    calls = _flaky_forum(env)
    caplog.set_level(logging.INFO, logger="agent_team_backend.channels.mirror")
    panes = _use_directory(env, [_pane("pane-1", "main"), _pane("pane-2", "tester", "pane-1")])
    await env.m.mirror.sync_lineage()
    clock.t += mirror_mod.NO_TOPIC_RETRY_S + 1
    panes.append(_pane("pane-3", "linter", "pane-1"))
    await env.m.mirror.sync_lineage()
    assert calls == ["↳ tester", "↳ linter"]
    # Still not a forum: one info line, no second warning, and the chat is remembered again.
    topic = [r for r in caplog.records if "topic" in r.getMessage()]
    assert [r.levelno for r in topic] == [logging.WARNING, logging.INFO]
    assert f"tried again in {int(mirror_mod.NO_TOPIC_RETRY_S // 60)} minutes" in topic[0].getMessage()
    panes.append(_pane("pane-4", "fmt", "pane-1"))
    await env.m.mirror.sync_lineage()
    assert calls == ["↳ tester", "↳ linter"]


async def test_a_chat_that_became_a_forum_gets_topics_after_the_retry_window(clocked) -> None:
    env, clock = clocked
    calls = _flaky_forum(env)
    panes = _use_directory(env, [_pane("pane-1", "main"), _pane("pane-2", "tester", "pane-1")])
    await env.m.mirror.sync_lineage()
    env.forum_on = True  # type: ignore[attr-defined]
    clock.t += mirror_mod.NO_TOPIC_RETRY_S + 1
    panes.append(_pane("pane-3", "linter", "pane-1"))
    await env.m.mirror.sync_lineage()
    panes.append(_pane("pane-4", "fmt", "pane-1"))
    await env.m.mirror.sync_lineage()
    assert calls == ["↳ tester", "↳ linter", "↳ fmt"]
    assert {b.pane_id for b in env.store.bindings() if b.auto} == {"pane-3", "pane-4"}
    assert env.m.mirror._no_topic_chats == {}


async def test_closed_child_releases_its_topic_and_says_so(env: Env) -> None:
    _topics(env)
    panes = _use_directory(env, [_pane("pane-1", "main"), _pane("pane-2", "tester", "pane-1")])
    await env.m.mirror.sync_lineage()
    panes.pop()
    env.fake.gone.add("pane-2")
    await env.m.mirror._release("pane-2")
    assert [b.pane_id for b in env.store.bindings()] == ["pane-1"]
    await _until(lambda: _said(env, "🔌"))
    assert _said(env, "🔌 ↳ tester 已關閉，話題已釋放")


async def test_a_rebuilt_child_is_followed_not_released(env: Env) -> None:
    _topics(env)
    _use_directory(env, [_pane("pane-1", "main"), _pane("pane-2", "tester", "pane-1")])
    await env.m.mirror.sync_lineage()
    env.fake.aliases["pane-2"] = "pane-2n"  # rebuilt around a live PTY: new id, old one is an alias
    await env.m.mirror._release("pane-2")
    assert {b.pane_id for b in env.store.bindings()} == {"pane-1", "pane-2n"}


async def test_unbinding_the_parent_releases_its_auto_topics(env: Env) -> None:
    _topics(env)
    _use_directory(env, [_pane("pane-1", "main"), _pane("pane-2", "tester", "pane-1")])
    await env.m.mirror.sync_lineage()
    await env.m.unbind("pane-1")
    assert env.store.bindings() == []


async def test_moving_the_parent_to_another_chat_moves_its_child_topics_too(env: Env) -> None:
    _topics(env)
    _use_directory(env, [_pane("pane-1", "main"), _pane("pane-2", "tester", "pane-1")])
    await env.m.mirror.sync_lineage()
    assert next(b for b in env.store.bindings() if b.pane_id == "pane-2").chat_id == "-100"
    assert (await env.m.bind("pane-1", "main", "telegram", "existing", "-200", ""))["ok"]
    await _until(lambda: {b.pane_id: b.chat_id for b in env.store.bindings()} == {"pane-1": "-200", "pane-2": "-200"})
    # The old group can no longer drive the child.
    await env.inbound("run e2e", chat="-100", thread="100")
    assert not any(d[0] == "pane-2" for d in env.fake.delivered)


async def test_rebinding_the_same_pane_after_unbind_reopens_its_child_topics(env: Env) -> None:
    _topics(env)
    _use_directory(env, [_pane("pane-1", "main"), _pane("pane-2", "tester", "pane-1"),
                         _pane("pane-3", "helper", "pane-2")])
    await env.m.mirror.sync_lineage()
    assert {b.pane_id for b in env.store.bindings()} == {"pane-1", "pane-2", "pane-3"}
    await env.m.unbind("pane-1")
    assert (await env.m.bind("pane-1", "main", "telegram", "existing", "-100", "50", verbosity="full"))["ok"]
    await _until(lambda: {b.pane_id for b in env.store.bindings()} == {"pane-1", "pane-2", "pane-3"})


async def test_verbosity_change_follows_to_auto_children(env: Env) -> None:
    _topics(env)
    _use_directory(env, [_pane("pane-1", "main"), _pane("pane-2", "tester", "pane-1")])
    await env.m.mirror.sync_lineage()
    await env.m.set_binding_options("pane-1", "minimal")
    assert {b.pane_id: b.verbosity for b in env.store.bindings()} == {"pane-1": "minimal", "pane-2": "minimal"}


async def test_child_of_a_tainted_pane_is_tainted(env: Env, monkeypatch) -> None:
    from agent_team_backend import guard  # noqa: F401
    from agent_team_backend.guard import taint

    marked: list[tuple[str, str, str]] = []
    monkeypatch.setattr(taint, "is_tainted", lambda pid: pid == "pane-1")
    monkeypatch.setattr(taint, "safe_mark_tainted", lambda pid, src, detail="", key="": marked.append((pid, src, detail)))
    from agent_team_backend.channels import default_seams

    seams = default_seams()
    seams.inherit_taint("pane-2", "pane-1")
    seams.inherit_taint("pane-3", "pane-9")
    assert marked == [("pane-2", "agent", "spawned by tainted pane pane-1")]


# --- commands and routing --------------------------------------------------------------------


async def test_status_shows_the_parent_child_tree(env: Env) -> None:
    env.tg.capabilities = NO_THREADS
    _use_directory(env, [_pane("pane-1", "main", status="running"),
                         _pane("pane-2", "tester", "pane-1", "awaiting"), _pane("pane-3", "docs", "pane-1")])
    await env.inbound("/status")
    assert env.tg.texts()[-1] == "📋 main　🔄 執行中\n├─ ↳ docs　💤 閒置\n└─ ↳ tester　⚠️ 等確認"
    assert env.fake.delivered == []


async def test_stop_with_a_name_interrupts_only_that_child(env: Env) -> None:
    env.tg.capabilities = NO_THREADS
    _use_directory(env, [_pane("pane-1", "main"), _pane("pane-2", "tester", "pane-1")])
    await env.inbound("/stop tester")
    assert env.fake.interrupts == ["pane-2"] and "⏹ 已送出中斷（tester）" in env.tg.texts()
    await env.inbound("/stop ghost")
    assert env.fake.interrupts == ["pane-2"] and "⚠️ 找不到子視窗「ghost」" in env.tg.texts()
    await env.inbound("/stop")
    assert env.fake.interrupts == ["pane-2", "pane-1"]


async def test_at_name_routes_to_the_child_and_its_reply_carries_the_prefix(env: Env) -> None:
    env.tg.capabilities = NO_THREADS
    _use_directory(env, [_pane("pane-1", "main"), _pane("pane-2", "tester", "pane-1")])
    await env.inbound("@tester run e2e again")
    assert env.fake.delivered == [("pane-2", "run e2e again", "telegram:alice")]
    assert "✔ 已轉給 tester" in env.tg.texts()
    env.fake.verdicts["k1"] = {"status": "delivered"}
    await asyncio.sleep(0.1)
    env.turn_complete("pane-2", "e2e green")
    await _until(lambda: f"{mirror_mod.child_tag('tester')} ✅ 完成 · 💬 alice\ne2e green" in env.tg.texts())


async def test_reply_to_a_childs_message_routes_to_that_child(env: Env) -> None:
    import dataclasses
    from agent_team_backend.channels.base import InboundMessage

    env.tg.capabilities = NO_THREADS
    _use_directory(env, [_pane("pane-1", "main"), _pane("pane-2", "tester", "pane-1")])
    env.turn_complete("pane-2", "child speaking")
    await _until(lambda: _said(env, "child speaking"))
    message_id = str(next(i for i, (_, t) in enumerate(env.tg.sent, 1) if "child speaking" in t))
    msg = InboundMessage(platform="telegram", account="default", chat_id="-100", thread_id="50",
                         sender_id="7", sender_name="alice", text="再跑一次 e2e", message_id="r1",
                         is_direct=False, ts=time.time(), reply_to_id=message_id)
    await env.m.handle_inbound(msg)
    await env.m.wait_idle()
    assert env.fake.delivered == [("pane-2", "再跑一次 e2e", "telegram:alice")]
    other = dataclasses.replace(msg, message_id="r2", text="plain", reply_to_id="999")
    await env.m.handle_inbound(other)
    await env.m.wait_idle()
    assert env.fake.delivered[-1][0] == "pane-1"


async def test_high_risk_child_prompt_still_cannot_be_approved_from_the_chat(env: Env, tmp_path) -> None:
    env.tg.capabilities = NO_THREADS
    # Classify the prompt in its pane's workspace. Falling back to HOME makes
    # the result depend on whether the runner's home is a temporary directory.
    env.m._seams.pane_workspace = lambda _pane_id: str(tmp_path / "workspace")
    env.fake.prompt = "Allow Bash(rm -rf ./dist ../cache)?"
    _use_directory(env, [_pane("pane-1", "main"), _pane("pane-2", "tester", "pane-1")])
    env.fake.states["pane-2"] = {"exists": True, "busy": True, "display_status": "awaiting"}
    env.m.mirror.on_status("pane-2")
    await _until(lambda: bool(env.m.relay.for_pane("pane-2")))
    rid = env.m.relay.for_pane("pane-2")[0].id
    await env.inbound(f"yes {rid}")
    assert env.fake.answers == []


async def test_message_log_rows_reach_the_mirror_through_the_registry_hook(env: Env) -> None:
    _use_directory(env, [_pane("pane-1", "main"), _pane("pane-9", "planner")])
    agent_messaging.message_row_listeners.append(env.m.mirror.on_message_rows)
    try:
        agent_messaging.notify_message_rows([_row("u1", "planner", "main", "via the hook"), "junk"])  # type: ignore[list-item]
        await _until(lambda: "🤖 planner → main：via the hook" in env.tg.texts())
    finally:
        agent_messaging.message_row_listeners.remove(env.m.mirror.on_message_rows)


async def test_direct_replies_and_mirrored_messages_share_one_ordered_queue(env: Env) -> None:
    from agent_team_backend.channels.base import InboundMessage

    real_send = env.tg.send_text

    async def slow_send(loc, text, *, buttons=None):
        await asyncio.sleep(0.02)  # a slow platform lets a backlog build behind the first send
        return await real_send(loc, text, buttons=buttons)

    env.tg.send_text = slow_send  # type: ignore[method-assign]
    loc = Location("telegram", "default", "-100", "50")
    msg = InboundMessage(platform="telegram", account="default", chat_id="-100", thread_id="50",
                         sender_id="7", sender_name="alice", text="x", message_id="o1", is_direct=False,
                         ts=time.time())
    env.m.mirror.post(loc, "mirror-1")
    env.m.mirror.post(loc, "mirror-2")
    reply = asyncio.ensure_future(env.m._reply(msg, "direct-reply"))
    await asyncio.sleep(0)
    env.m.mirror.post(loc, "mirror-3")
    await env.m._notice(env.tg, loc, "notice-4")
    assert await reply
    order = [w for t in env.tg.texts() for w in t.split("\n\n")]
    assert order == ["mirror-1", "mirror-2", "direct-reply", "mirror-3", "notice-4"]


async def test_outbox_submit_returns_ids_raises_errors_and_keeps_draining() -> None:
    calls: list[str] = []

    async def send(text: str, buttons) -> list[str]:
        calls.append(text)
        if text == "boom":
            raise RuntimeError("platform said no")
        return [f"id-{text}"]

    box = Outbox(send, per_min=6000, burst=10)
    first = asyncio.ensure_future(box.submit("a"))
    bad = asyncio.ensure_future(box.submit("boom"))
    await asyncio.sleep(0)  # let both be queued, in order, before the next caller
    box.post("c")
    third = asyncio.ensure_future(box.submit("d", buttons=[("Yes", "y")]))
    assert await first == ["id-a"]
    with pytest.raises(RuntimeError, match="platform said no"):
        await bad
    assert await third == ["id-d"]
    assert calls == ["a", "boom", "c", "d"]  # a waited-for send is never merged into its neighbours


async def test_long_local_prompts_are_mirrored_whole_up_to_the_cap(env: Env) -> None:
    # The capped prompt goes out as more messages than the outbox's burst, and the default
    # pacing (1/s past the burst) would put its last chunk right at `_until`'s deadline.
    # Pacing has its own test above; this one is about content, so the chat is fast.
    env.tg.rate_per_min = 6000  # type: ignore[attr-defined]
    long_prompt = "詳細" * 1000  # 2000 chars: past the 500-char naming cap
    env.m.mirror.on_local_prompt("pane-1", long_prompt)
    await _until(lambda: sum(t.count("詳細") for t in env.tg.texts()) == 1000)
    assert not _said(env, "完整內容請在 Navide 查看")
    env.m.mirror.on_local_prompt("pane-1", "x" * mirror_mod.LOCAL_PROMPT_MAX)
    await _until(lambda: _said(env, "完整內容請在 Navide 查看"))


# --- C1: telling children apart in a chat without topics -------------------------------


def test_a_child_tag_has_a_colour_that_stays_with_its_name() -> None:
    tag = mirror_mod.child_tag("tester")
    assert tag.startswith("↳ ") and tag.endswith(" tester")
    assert tag.split(" ")[1] in mirror_mod.CHILD_COLOURS
    assert mirror_mod.child_tag("tester") == tag
    tags = {mirror_mod.child_tag(name).split(" ")[1] for name in ("a", "b", "c", "d", "e", "f", "g", "h", "i")}
    assert len(tags) > 1


async def test_a_chat_without_topics_is_told_once_how_to_get_them(env: Env) -> None:
    async def not_a_forum(chat_id: str, title: str) -> Location:
        raise ChannelSendError("這個群組沒有開啟主題功能 (the chat is not a forum)")

    env.tg.create_location = not_a_forum  # type: ignore[method-assign]
    panes = _use_directory(env, [_pane("pane-1", "main"), _pane("pane-2", "tester", "pane-1")])
    await env.m.mirror.sync_lineage()
    panes.append(_pane("pane-3", "linter", "pane-1"))
    await env.m.mirror.sync_lineage()
    await _until(lambda: _said(env, "主題"))
    await env.m.wait_idle()
    assert sum(mirror_mod.MSG_NO_TOPICS in t for t in env.tg.texts()) == 1

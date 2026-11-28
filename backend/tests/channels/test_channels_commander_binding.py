"""A chat binding moved onto a commander at upgrade follows the commander's current body,
comes back field for field at downgrade, and is paused (kept) while the commander is
archived. Bindings without a commander behave exactly as before."""

from __future__ import annotations

import pytest

from agent_team_backend import commander_service as cs
from agent_team_backend.channels.base import Location

from ..commander_fakes import World, pane, service
from .test_manager import _make_env, fast_timers  # noqa: F401 — pytest fixture


@pytest.fixture
async def cenv(tmp_path):
    world = World()
    world.add(pane("pane-1", "api"))
    (tmp_path / "cmd").mkdir()
    svc = service(tmp_path / "cmd", world)
    cs.configure(svc)
    e = await _make_env(tmp_path)
    e.world, e.svc = world, svc
    yield e
    await e.m.stop()
    e.db.close()
    cs.configure(None)


def _all(env):
    with env.db.transaction() as cur:
        return [dict(r) for r in cur.execute("SELECT * FROM channel_bindings ORDER BY pane_id").fetchall()]


async def test_binding_without_commander_is_unchanged(cenv):
    b = cenv.store.bindings()[0]
    assert b.commander_id == "" and not b.paused
    assert "commander_id" not in b.public()
    await cenv.inbound("hello")
    assert cenv.fake.delivered[-1][0] == "pane-1"


async def test_upgrade_moves_only_the_panes_own_binding(cenv):
    cenv.store.bind("pane-9", Location("telegram", "default", "-200", "", "other"))
    c = cenv.svc.upgrade_pane(cenv.world.panes["pane-1"], {})
    by_pane = {b.pane_id: b for b in cenv.store.bindings()}
    assert by_pane["pane-1"].commander_id == c.id
    assert by_pane["pane-9"].commander_id == ""
    assert by_pane["pane-1"].public()["commander_id"] == c.id
    kinds = {s["kind"] for s in cenv.svc.bindings(c.id)}
    assert "channel_binding" in kinds


async def test_messages_follow_the_commanders_new_body(cenv):
    c = cenv.svc.upgrade_pane(cenv.world.panes["pane-1"], {})
    await cenv.inbound("first")
    assert cenv.fake.delivered[-1][0] == "pane-1"
    # The commander is reopened in a new pane (a new id, not an alias of the old one).
    cenv.world.add(pane("pane-2", "api"))
    cenv.svc.store.attach_body(c.id, pane_id="pane-2", workspace="/ws", agent_key="claude", session_id="s2")
    await cenv.inbound("second")
    assert cenv.fake.delivered[-1][0] == "pane-2"
    b = cenv.store.commander_bindings(c.id)[0]
    assert b.pane_id == "pane-2" and b.commander_id == c.id


async def test_no_live_body_keeps_the_pane_and_takes_the_bodys_wake_target(cenv):
    c = cenv.svc.upgrade_pane(cenv.world.panes["pane-1"], {}, session_id="sess-c")
    cenv.svc.store.attach_body(c.id, pane_id="pane-3", workspace="/ws2", agent_key="codex", session_id="sess-3")
    cenv.fake.gone.add("pane-3")  # not running: nothing to move onto
    b = cenv.m._binding_for(_msg())  # noqa: SLF001
    assert b is not None and b.pane_id == "pane-1"
    assert (b.workspace_path, b.session_id, b.agent) == ("/ws2", "sess-3", "codex")


async def test_downgrade_restores_every_column(cenv):
    before = _all(cenv)
    c = cenv.svc.upgrade_pane(cenv.world.panes["pane-1"], {})
    assert _all(cenv) != before
    cenv.svc.downgrade(c.id)
    assert _all(cenv) == before


async def test_downgrade_after_a_body_change_lands_on_the_current_pane(cenv):
    c = cenv.svc.upgrade_pane(cenv.world.panes["pane-1"], {})
    cenv.world.add(pane("pane-2", "api"))
    cenv.svc.store.attach_body(c.id, pane_id="pane-2", workspace="/ws", agent_key="claude")
    cenv.svc.downgrade(c.id)
    (b,) = cenv.store.bindings()
    assert b.pane_id == "pane-2" and b.commander_id == "" and not b.paused


async def test_archive_pauses_without_deleting_and_resume_brings_it_back(cenv):
    c = cenv.svc.upgrade_pane(cenv.world.panes["pane-1"], {})
    cenv.svc.archive(c.id)
    assert cenv.store.bindings() == []
    (kept,) = cenv.store.commander_bindings(c.id)
    assert kept.paused
    sent = len(cenv.fake.delivered)
    await cenv.inbound("while archived")
    assert len(cenv.fake.delivered) == sent
    cenv.m.commander_set_paused(c.id, False)
    assert [b.pane_id for b in cenv.store.bindings()] == ["pane-1"]


def _msg():
    from agent_team_backend.channels.base import InboundMessage

    return InboundMessage(platform="telegram", account="default", chat_id="-100", thread_id="50",
                          sender_id="7", sender_name="alice", text="x", message_id="m", is_direct=False,
                          ts=0.0)

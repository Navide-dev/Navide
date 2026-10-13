"""/menu end to end through the manager: menu, presses, paging and every refusal."""

from __future__ import annotations

from agent_team_backend import prompt_skills
from agent_team_backend.channels import quick_menu as qm
from agent_team_backend.channels.base import Capabilities, Location
from agent_team_backend.channels.manager import MSG_OFFLINE

from .test_manager import Env, env, fast_timers  # noqa: F401 — pytest fixtures


def _buttons(env: Env, menu: int = -1) -> list[tuple[str, str]]:
    return [b for row in env.tg.menus[menu][2] for b in row]


def _press_data(env: Env, label_part: str, menu: int = -1) -> str:
    return next(data for label, data in _buttons(env, menu) if label_part in label)


SAVED = [
    {"id": "fix", "name": "Fix it", "prompt": "fix the failing tests", "isDefault": True},
    {"id": "doc", "name": "Docs", "prompt": "update the docs"},
    {"id": "off", "name": "Off", "prompt": "never", "enabled": False},
]


async def test_menu_lists_prompts_and_the_panes_skills(env: Env) -> None:
    env.fake.settings = {"prompt-skills": SAVED}
    env.fake.agents["pane-1"] = "claude"
    env.fake.skills["claude"] = ["deploy"]
    await env.inbound("/menu")
    loc, body, rows = env.tg.menus[-1]
    assert loc == Location("telegram", "default", "-100", "50", "api")
    assert "api" in body
    assert [label for label, _ in _buttons(env)] == ["💬 Fix it", "💬 Docs", "🧩 deploy"]
    assert all(data.startswith("nv2:") for _, data in _buttons(env))
    assert env.fake.delivered == []


async def test_never_saved_prompts_offer_the_builtin(env: Env) -> None:
    await env.inbound("/start")  # Telegram's first contact without a link code
    name = prompt_skills.load_seed()["name"]["zh-TW"]
    assert [label for label, _ in _buttons(env)] == [f"💬 {name}"]
    assert qm.text("zh-TW", "no_skill_syntax") in env.tg.menus[-1][1]  # vendor unknown


async def test_pressing_a_prompt_sends_it_once(env: Env) -> None:
    env.fake.settings = {"prompt-skills": SAVED}
    await env.inbound("/menu")
    await env.inbound("", callback=_press_data(env, "Fix it"))
    assert env.fake.delivered[-1][:2] == ("pane-1", "fix the failing tests")
    assert env.tg.texts()[-1] == qm.text("zh-TW", "sent", name="💬 Fix it")


async def test_pressing_a_skill_sends_the_vendors_command(env: Env) -> None:
    for agent, want in (("claude", "/deploy"), ("codex", "$deploy"), ("kimi", "/skill:deploy")):
        env.fake.agents["pane-1"] = agent
        env.fake.skills[agent] = ["deploy"]
        await env.inbound("/menu")
        await env.inbound("", callback=_press_data(env, "deploy"))
        assert env.fake.delivered[-1][:2] == ("pane-1", want)


async def test_a_vendor_without_a_verified_syntax_gets_no_skills(env: Env) -> None:
    env.fake.agents["pane-1"] = "opencode"
    env.fake.skills["opencode"] = ["deploy"]
    await env.inbound("/menu")
    assert not any("deploy" in label for label, _ in _buttons(env))


async def test_unbound_chat_is_told_to_connect_first(env: Env) -> None:
    await env.inbound("/menu", thread="99")
    assert env.tg.texts()[-1] == qm.text("zh-TW", "not_bound")
    assert env.tg.menus == []


async def test_offline_pane_and_buttonless_platform(env: Env) -> None:
    env.fake.gone.add("pane-1")
    await env.inbound("/menu")
    assert env.tg.texts()[-1] == MSG_OFFLINE
    env.fake.gone.clear()
    env.tg.capabilities = Capabilities(threads=True, create_location=True, edit=True, typing=True,
                                       buttons=False, text_limit=4000)
    await env.inbound("/menu")
    assert env.tg.texts()[-1] == qm.text("zh-TW", "no_buttons")


async def test_expired_unknown_and_moved_menus(env: Env, monkeypatch) -> None:
    env.fake.settings = {"prompt-skills": SAVED}
    await env.inbound("/menu")
    data = _press_data(env, "Fix it")
    await env.inbound("", callback="nv2:p:zzzzzzzz")
    assert env.tg.texts()[-1] == qm.text("zh-TW", "expired")
    # The chat now drives another pane: the old menu's buttons are dead.
    env.store.unbind("pane-1")
    env.store.bind("pane-2", Location("telegram", "default", "-100", "50", "web"))
    await env.inbound("", callback=data)
    assert env.tg.texts()[-1] == qm.text("zh-TW", "expired")
    env.store.unbind("pane-2")
    env.store.bind("pane-1", Location("telegram", "default", "-100", "50", "api"))
    monkeypatch.setattr(qm, "MENU_TTL_S", -1.0)
    await env.inbound("", callback=data)
    assert env.tg.texts()[-1] == qm.text("zh-TW", "expired")
    assert env.fake.delivered == []


async def test_a_prompt_deleted_after_the_menu_was_sent_is_gone(env: Env) -> None:
    env.fake.settings = {"prompt-skills": SAVED}
    await env.inbound("/menu")
    env.fake.settings = {"prompt-skills": SAVED[:1]}
    await env.inbound("", callback=_press_data(env, "Docs"))
    assert env.tg.texts()[-1] == qm.text("zh-TW", "gone", name="💬 Docs")
    assert env.fake.delivered == []


async def test_paging_edits_the_menu_in_place_and_falls_back_to_a_new_one(env: Env) -> None:
    env.fake.settings = {"prompt-skills": [{"id": f"p{i}", "name": f"P{i}", "prompt": f"do {i}"} for i in range(25)]}
    await env.inbound("/menu")
    await env.inbound("", callback=_press_data(env, "▶"))
    message_id, body, rows = env.tg.menu_edits[-1]
    assert message_id == "menu1" and "2/3" in body
    assert [label for label, _ in rows[-1]] == ["◀ 上一頁", "下一頁 ▶"]
    env.tg.fail_edits = True
    await env.inbound("", callback=next(d for label, d in rows[-1] if "▶" in label))
    assert len(env.tg.menus) == 2 and "3/3" in env.tg.menus[-1][1]


async def test_the_users_language_is_used(env: Env) -> None:
    env.fake.settings = {"agent-team:language": "en-US"}
    await env.inbound("/menu", thread="99")
    assert env.tg.texts()[-1] == qm.text("en-US", "not_bound")


async def test_a_held_pane_gets_no_sent_notice(env: Env) -> None:
    env.fake.settings = {"prompt-skills": SAVED}
    await env.inbound("/menu")
    env.fake.states["pane-1"] = {"exists": True, "busy": False, "display_status": "awaiting"}
    await env.inbound("", callback=_press_data(env, "Fix it"))
    assert env.fake.delivered == []
    assert qm.text("zh-TW", "sent", name="💬 Fix it") not in env.tg.texts()


async def test_menu_for_another_bot_is_ignored(env: Env) -> None:
    env.tg.status.identity = "@navide_bot"
    await env.inbound("/menu@other_bot")
    assert env.tg.menus == []
    await env.inbound("/menu@navide_bot")
    assert len(env.tg.menus) == 1


async def test_a_menu_the_platform_refuses_is_answered_with_why(env: Env) -> None:
    env.fake.settings = {"prompt-skills": SAVED}
    env.tg.fail_menus = True
    await env.inbound("/menu")
    assert env.tg.menus == []
    assert env.tg.texts()[-1] == qm.text("zh-TW", "send_failed", error="Bad Request: BUTTON_DATA_INVALID")


async def test_a_page_that_can_be_neither_edited_nor_resent_is_answered_with_why(env: Env) -> None:
    env.fake.settings = {"prompt-skills": [{"id": f"p{i}", "name": f"P{i}", "prompt": f"do {i}"} for i in range(25)]}
    await env.inbound("/menu")
    env.tg.fail_edits = True
    env.tg.fail_menus = True
    await env.inbound("", callback=_press_data(env, "▶"))
    assert len(env.tg.menus) == 1
    assert env.tg.texts()[-1] == qm.text("zh-TW", "send_failed", error="Bad Request: BUTTON_DATA_INVALID")

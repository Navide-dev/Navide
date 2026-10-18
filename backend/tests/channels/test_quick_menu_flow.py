"""/prompts and /skills end to end through the manager: menu, presses, paging and every
refusal; /menu and a bare /start point to /prompts, /skills and /mcp."""

from __future__ import annotations

from agent_team_backend import prompt_skills
from agent_team_backend.channels import quick_menu as qm
from agent_team_backend.channels.base import Capabilities, Location
from agent_team_backend.channels.manager import (
    MCP_CALLBACK,
    MENU_MOVED_BUTTONS,
    MSG_OFFLINE,
    PROMPTS_CALLBACK,
    SKILLS_CALLBACK,
)

from .test_manager import Env, env, fast_timers  # noqa: F401 — pytest fixtures


def _buttons(env: Env, menu: int = -1) -> list[tuple[str, str]]:
    return [b for row in env.tg.menus[menu][2] for b in row]


def _press_data(env: Env, label_part: str, menu: int = -1) -> str:
    return next(data for label, data in _buttons(env, menu) if label_part in label)


def _no_buttons(env: Env) -> None:
    env.tg.capabilities = Capabilities(threads=True, create_location=True, edit=True, typing=True,
                                       buttons=False, text_limit=4000)


SAVED = [
    {"id": "fix", "name": "Fix it", "prompt": "fix the failing tests", "isDefault": True},
    {"id": "doc", "name": "Docs", "prompt": "update the docs"},
    {"id": "off", "name": "Off", "prompt": "never", "enabled": False},
]


async def test_prompts_and_skills_list_the_prompts_and_the_panes_skills(env: Env) -> None:
    env.fake.settings = {"prompt-skills": SAVED}
    env.fake.agents["pane-1"] = "claude"
    env.fake.skills["claude"] = ["deploy"]
    await env.inbound("/prompts")
    loc, body, rows = env.tg.menus[-1]
    assert loc == Location("telegram", "default", "-100", "50", "api")
    assert "api" in body
    assert [label for label, _ in _buttons(env)] == ["💬 Fix it", "💬 Docs"]
    await env.inbound("/skills")
    assert [label for label, _ in _buttons(env)] == ["🧩 deploy"]
    assert all(data.startswith("nv2:") for _, data in _buttons(env))
    assert env.fake.delivered == []


async def test_never_saved_prompts_offer_the_builtin(env: Env) -> None:
    await env.inbound("/prompts")
    name = prompt_skills.load_seed()["name"]["zh-TW"]
    assert [label for label, _ in _buttons(env)] == [f"💬 {name}"]
    await env.inbound("/skills")
    assert env.tg.texts()[-1] == qm.text("zh-TW", "no_skill_syntax")  # vendor unknown


async def test_menu_and_a_bare_start_point_to_the_three_commands(env: Env) -> None:
    env.fake.settings = {"prompt-skills": SAVED}
    for command in ("/menu", "/start"):  # /start: Telegram's first contact without a link code
        await env.inbound(command)
        assert env.tg.texts()[-1] == qm.text("zh-TW", "menu_moved")
        assert env.tg.buttons[qm.text("zh-TW", "menu_moved")] == MENU_MOVED_BUTTONS
    assert [label for label, _ in MENU_MOVED_BUTTONS] == ["💬 Prompts", "🧩 Skills", "🔌 MCP"]
    assert env.tg.menus == [] and env.fake.delivered == []


async def test_the_pointers_buttons_open_each_menu(env: Env) -> None:
    env.fake.settings = {"prompt-skills": SAVED}
    env.fake.agents["pane-1"] = "claude"
    env.fake.skills["claude"] = ["deploy"]
    env.fake.mcp_navide = [{"name": "search", "status": "connected", "tool_count": 1}]
    await env.inbound("/menu")
    await env.inbound("", callback=PROMPTS_CALLBACK)
    assert env.tg.menus[-1][1].startswith(qm.text("zh-TW", "title_prompts", pane="api"))
    await env.inbound("", callback=SKILLS_CALLBACK)
    assert env.tg.menus[-1][1].startswith(qm.text("zh-TW", "title_skills", pane="api"))
    await env.inbound("", callback=MCP_CALLBACK)
    assert env.tg.menus[-1][1].startswith(qm.text("zh-TW", "title_mcp", pane="api"))
    assert env.fake.delivered == []


async def test_without_buttons_the_pointer_is_text_only(env: Env) -> None:
    _no_buttons(env)
    await env.inbound("/menu")
    assert env.tg.texts()[-1] == qm.text("zh-TW", "menu_moved")
    assert env.tg.buttons == {} and env.tg.menus == []


async def test_the_pointer_speaks_the_users_language(env: Env) -> None:
    for lang in ("en-US", "ja-JP"):
        env.fake.settings = {"agent-team:language": lang}
        await env.inbound("/menu")
        assert env.tg.texts()[-1] == qm.text(lang, "menu_moved")
        assert "/prompts" in env.tg.texts()[-1] and "/mcp" in env.tg.texts()[-1]


async def test_pressing_a_prompt_sends_it_once(env: Env) -> None:
    env.fake.settings = {"prompt-skills": SAVED}
    await env.inbound("/prompts")
    await env.inbound("", callback=_press_data(env, "Fix it"))
    assert env.fake.delivered[-1][:2] == ("pane-1", "fix the failing tests")
    assert env.tg.texts()[-1] == qm.text("zh-TW", "sent", name="💬 Fix it")


async def test_pressing_a_skill_sends_the_vendors_command(env: Env) -> None:
    for agent, want in (("claude", "/deploy"), ("codex", "$deploy"), ("kimi", "/skill:deploy")):
        env.fake.agents["pane-1"] = agent
        env.fake.skills[agent] = ["deploy"]
        await env.inbound("/skills")
        await env.inbound("", callback=_press_data(env, "deploy"))
        assert env.fake.delivered[-1][:2] == ("pane-1", want)


async def test_a_vendor_without_a_verified_syntax_gets_no_skills(env: Env) -> None:
    env.fake.agents["pane-1"] = "opencode"
    env.fake.skills["opencode"] = ["deploy"]
    await env.inbound("/skills")
    assert env.tg.menus == []
    assert env.tg.texts()[-1] == qm.text("zh-TW", "no_skill_syntax")


async def test_unbound_chat_is_told_to_connect_first(env: Env) -> None:
    await env.inbound("/menu", thread="99")
    assert env.tg.texts()[-1] == qm.text("zh-TW", "not_bound")
    assert env.tg.menus == []


async def test_offline_pane_and_buttonless_platform(env: Env) -> None:
    env.fake.gone.add("pane-1")
    await env.inbound("/prompts")
    assert env.tg.texts()[-1] == MSG_OFFLINE
    env.fake.gone.clear()
    _no_buttons(env)
    await env.inbound("/prompts")
    assert env.tg.menus == [] and qm.text("zh-TW", "pick_hint_p") in env.tg.texts()[-1]


async def test_a_buttonless_platform_gets_a_numbered_menu_and_picks_by_number(env: Env) -> None:
    _no_buttons(env)
    env.fake.settings = {"prompt-skills": SAVED}
    env.fake.agents["pane-1"] = "claude"
    env.fake.skills["claude"] = ["deploy"]
    await env.inbound("/skills")
    body = env.tg.texts()[-1]
    assert "1. 🧩 deploy" in body
    await env.inbound("/menu 1")
    assert env.fake.delivered[-1][:2] == ("pane-1", "/deploy")
    assert env.tg.texts()[-1] == qm.text("zh-TW", "sent", name="🧩 deploy")
    await env.inbound("/menu 9")
    assert env.tg.texts()[-1] == qm.text("zh-TW", "bad_pick")
    assert len(env.fake.delivered) == 1


async def test_a_buttonless_platform_picks_each_list_with_its_own_command(env: Env) -> None:
    _no_buttons(env)
    env.fake.settings = {"prompt-skills": SAVED}
    env.fake.agents["pane-1"] = "claude"
    env.fake.skills["claude"] = ["deploy"]
    await env.inbound("/prompts")
    body = env.tg.texts()[-1]
    assert "1. 💬 Fix it" in body and "2. 💬 Docs" in body and "deploy" not in body
    assert qm.text("zh-TW", "pick_hint_p") in body
    await env.inbound("/skills")
    body = env.tg.texts()[-1]
    assert "1. 🧩 deploy" in body and "Fix it" not in body
    assert qm.text("zh-TW", "pick_hint_s") in body
    # Each command picks from its own list, whichever was sent last.
    await env.inbound("/prompts 2")
    assert env.fake.delivered[-1][:2] == ("pane-1", "update the docs")
    await env.inbound("/skills 1")
    assert env.fake.delivered[-1][:2] == ("pane-1", "/deploy")
    assert env.tg.texts()[-1] == qm.text("zh-TW", "sent", name="🧩 deploy")
    await env.inbound("/skills 9")
    assert env.tg.texts()[-1] == qm.text("zh-TW", "bad_pick")
    assert len(env.fake.delivered) == 2


async def test_menu_n_still_picks_from_the_newest_list(env: Env) -> None:
    """The old habit: /menu <n> picks item n of the newest list this chat was sent,
    exactly as before /menu became a pointer."""
    _no_buttons(env)
    env.fake.settings = {"prompt-skills": SAVED}
    env.fake.agents["pane-1"] = "claude"
    env.fake.skills["claude"] = ["deploy", "lint"]
    await env.inbound("/skills")
    await env.inbound("/menu 2")
    assert env.fake.delivered[-1][:2] == ("pane-1", "/lint")
    assert env.tg.texts()[-1] == qm.text("zh-TW", "sent", name="🧩 lint")
    await env.inbound("/prompts")
    await env.inbound("/menu 1")
    assert env.fake.delivered[-1][:2] == ("pane-1", "fix the failing tests")
    await env.inbound("/menu 9")
    assert env.tg.texts()[-1] == qm.text("zh-TW", "bad_pick")


async def test_a_pick_without_a_menu_is_expired(env: Env) -> None:
    await env.inbound("/menu 1")
    assert env.tg.texts()[-1] == qm.text("zh-TW", "expired") and env.fake.delivered == []
    _no_buttons(env)
    for command in ("/prompts 1", "/skills 1"):
        await env.inbound(command)
        assert env.tg.texts()[-1] == qm.text("zh-TW", "expired")
    assert env.fake.delivered == []


async def test_with_buttons_prompts_n_and_skills_n_go_to_the_pane_as_typed(env: Env) -> None:
    """As on main: a platform with buttons has no numbered lists, and the CLI has its own
    /skills, so "/prompts 2" and "/skills 1" are plain text for the pane."""
    env.fake.settings = {"prompt-skills": SAVED}
    env.fake.agents["pane-1"] = "claude"
    env.fake.skills["claude"] = ["deploy"]
    await env.inbound("/prompts")
    await env.inbound("/skills")
    await env.inbound("/prompts 2")
    assert env.fake.delivered[-1][:2] == ("pane-1", "/prompts 2")
    await env.inbound("/skills 1")
    assert env.fake.delivered[-1][:2] == ("pane-1", "/skills 1")
    assert qm.text("zh-TW", "sent", name="💬 Docs") not in env.tg.texts()


async def test_without_buttons_prompts_n_and_skills_n_pick_from_their_lists(env: Env) -> None:
    _no_buttons(env)
    env.fake.settings = {"prompt-skills": SAVED}
    env.fake.agents["pane-1"] = "claude"
    env.fake.skills["claude"] = ["deploy"]
    await env.inbound("/prompts")
    await env.inbound("/prompts 2")
    assert env.fake.delivered[-1][:2] == ("pane-1", "update the docs")
    await env.inbound("/skills")
    await env.inbound("/skills 1")
    assert env.fake.delivered[-1][:2] == ("pane-1", "/deploy")
    assert len(env.fake.delivered) == 2


async def test_a_numbered_pick_in_an_unbound_chat(env: Env) -> None:
    _no_buttons(env)
    await env.inbound("/prompts 1", thread="99")
    assert env.tg.texts()[-1] == qm.text("zh-TW", "not_bound")


async def test_expired_unknown_and_moved_menus(env: Env, monkeypatch) -> None:
    env.fake.settings = {"prompt-skills": SAVED}
    await env.inbound("/prompts")
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
    await env.inbound("/prompts")
    env.fake.settings = {"prompt-skills": SAVED[:1]}
    await env.inbound("", callback=_press_data(env, "Docs"))
    assert env.tg.texts()[-1] == qm.text("zh-TW", "gone", name="💬 Docs")
    assert env.fake.delivered == []


async def test_paging_edits_the_menu_in_place_and_falls_back_to_a_new_one(env: Env) -> None:
    env.fake.settings = {"prompt-skills": [{"id": f"p{i}", "name": f"P{i}", "prompt": f"do {i}"} for i in range(25)]}
    await env.inbound("/prompts")
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
    await env.inbound("/prompts")
    env.fake.states["pane-1"] = {"exists": True, "busy": False, "display_status": "awaiting"}
    await env.inbound("", callback=_press_data(env, "Fix it"))
    assert env.fake.delivered == []
    assert qm.text("zh-TW", "sent", name="💬 Fix it") not in env.tg.texts()


async def test_menu_for_another_bot_is_ignored(env: Env) -> None:
    env.tg.status.identity = "@navide_bot"
    await env.inbound("/prompts@other_bot")
    await env.inbound("/menu@other_bot")
    assert env.tg.menus == [] and env.tg.texts() == []
    await env.inbound("/prompts@navide_bot")
    assert len(env.tg.menus) == 1
    await env.inbound("/menu@navide_bot")
    assert env.tg.texts()[-1] == qm.text("zh-TW", "menu_moved")


async def test_a_menu_the_platform_refuses_is_answered_with_why(env: Env) -> None:
    env.fake.settings = {"prompt-skills": SAVED}
    env.tg.fail_menus = True
    await env.inbound("/prompts")
    assert env.tg.menus == []
    assert env.tg.texts()[-1] == qm.text("zh-TW", "send_failed", error="Bad Request: BUTTON_DATA_INVALID")


async def test_a_page_that_can_be_neither_edited_nor_resent_is_answered_with_why(env: Env) -> None:
    env.fake.settings = {"prompt-skills": [{"id": f"p{i}", "name": f"P{i}", "prompt": f"do {i}"} for i in range(25)]}
    await env.inbound("/prompts")
    env.tg.fail_edits = True
    env.tg.fail_menus = True
    await env.inbound("", callback=_press_data(env, "▶"))
    assert len(env.tg.menus) == 1
    assert env.tg.texts()[-1] == qm.text("zh-TW", "send_failed", error="Bad Request: BUTTON_DATA_INVALID")


async def test_prompts_lists_only_the_prompt_skills(env: Env) -> None:
    env.fake.settings = {"prompt-skills": SAVED}
    env.fake.agents["pane-1"] = "claude"
    env.fake.skills["claude"] = ["deploy"]
    await env.inbound("/prompts")
    assert [label for label, _ in _buttons(env)] == ["💬 Fix it", "💬 Docs"]
    assert env.tg.menus[-1][1].startswith(qm.text("zh-TW", "title_prompts", pane="api"))
    await env.inbound("", callback=_press_data(env, "Docs"))
    assert env.fake.delivered[-1][:2] == ("pane-1", "update the docs")


async def test_skills_lists_only_the_panes_skills(env: Env) -> None:
    env.fake.settings = {"prompt-skills": SAVED}
    env.fake.agents["pane-1"] = "codex"
    env.fake.skills["codex"] = ["deploy", "lint"]
    await env.inbound("/skills")
    assert [label for label, _ in _buttons(env)] == ["🧩 deploy", "🧩 lint"]
    assert env.tg.menus[-1][1].startswith(qm.text("zh-TW", "title_skills", pane="api"))
    await env.inbound("", callback=_press_data(env, "lint"))
    assert env.fake.delivered[-1][:2] == ("pane-1", "$lint")


async def test_skills_explains_a_vendor_without_a_verified_syntax(env: Env) -> None:
    env.fake.agents["pane-1"] = "opencode"
    env.fake.skills["opencode"] = ["deploy"]
    await env.inbound("/skills")
    assert env.tg.menus == []
    assert env.tg.texts()[-1] == qm.text("zh-TW", "no_skill_syntax")


async def test_skills_with_none_installed_says_so(env: Env) -> None:
    env.fake.agents["pane-1"] = "claude"
    await env.inbound("/skills")
    assert env.tg.menus == []
    assert env.tg.texts()[-1] == qm.text("zh-TW", "empty_skills")


async def test_a_buttonless_platform_gets_numbered_prompts_and_picks_by_number(env: Env) -> None:
    _no_buttons(env)
    env.fake.settings = {"prompt-skills": SAVED}
    env.fake.agents["pane-1"] = "claude"
    env.fake.skills["claude"] = ["deploy"]
    await env.inbound("/prompts")
    body = env.tg.texts()[-1]
    assert "1. 💬 Fix it" in body and "2. 💬 Docs" in body and "deploy" not in body
    await env.inbound("/menu 2")
    assert env.fake.delivered[-1][:2] == ("pane-1", "update the docs")


async def test_prompts_and_skills_in_an_unbound_chat(env: Env) -> None:
    for command in ("/prompts", "/skills"):
        await env.inbound(command, thread="99")
        assert env.tg.texts()[-1] == qm.text("zh-TW", "not_bound")
    assert env.tg.menus == []

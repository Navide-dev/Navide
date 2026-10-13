from __future__ import annotations

from typing import Any

import pytest

from agent_team_backend.channels import quick_menu as qm


class Clock:
    def __init__(self) -> None:
        self.t = 100.0

    def __call__(self) -> float:
        return self.t


def _prompts(n: int) -> list[dict[str, Any]]:
    return [{"id": f"p{i}", "name": f"Prompt {i}"} for i in range(n)]


def _menu(menus: qm.QuickMenus, *, prompts: int = 1, skills: list[str] | None = None,
          platform: str = "telegram", agent: str = "claude", lang: str = "zh-TW") -> qm.Menu:
    menu = menus.create(platform=platform, location_key="telegram:default:-100:50", pane_id="pane-1",
                        pane_title="api", agent_key=agent, lang=lang, prompts=_prompts(prompts),
                        skills=skills if skills is not None else [])
    assert menu is not None
    return menu


@pytest.mark.parametrize("body,identity,want", [
    ("/menu", "", True),
    ("/MENU", "", True),
    ("/start", "", True),
    ("/menu@navide_bot", "@navide_bot", True),
    ("/menu@other_bot", "@navide_bot", False),
    ("<@U123> /menu", "", True),
    ("/menu now", "", False),
    ("/start ABCD-1234", "", False),
    ("menu", "", False),
    ("/status", "", False),
])
def test_menu_command(body: str, identity: str, want: bool) -> None:
    assert qm.is_menu_command(body, identity) is want


def test_callback_data_fits_every_platform_and_round_trips() -> None:
    menus = qm.QuickMenus()
    menu = _menu(menus, prompts=1, skills=["deploy"])
    _, rows = menus.render(menu, 0)
    for row in rows:
        for _label, data in row:
            assert len(data.encode()) <= 64  # Telegram callback_data: 1-64 bytes
            kind, token = qm.parse_callback(data)
            press = menus.press(kind, token, menu.location_key)
            assert press is not None and press.menu is menu
    assert qm.parse_callback("nv1:abcde:y") is None
    assert qm.parse_callback("nv2:x:abcdefgh") is None


def test_groups_never_share_a_row_and_pages_follow_the_layout() -> None:
    menus = qm.QuickMenus()
    menu = _menu(menus, prompts=3, skills=[f"s{i}" for i in range(11)])
    layout = qm.LAYOUTS["telegram"]
    flat = [row for page in menu.pages for row in page]
    assert [[i.kind for i in row] for row in flat[:2]] == [["p", "p"], ["p"]]
    assert all(len(row) <= layout.per_row for row in flat)
    assert all(len(page) <= layout.rows for page in menu.pages)
    assert len(menu.pages) == 2


def test_page_buttons_only_where_there_is_a_page_to_go_to() -> None:
    menus = qm.QuickMenus()
    menu = _menu(menus, prompts=25)
    text0, rows0 = menus.render(menu, 0)
    assert "1/3" in text0
    assert [label for label, _ in rows0[-1]] == ["下一頁 ▶"]
    _, rows1 = menus.render(menu, 1)
    assert [label for label, _ in rows1[-1]] == ["◀ 上一頁", "下一頁 ▶"]
    _, rows2 = menus.render(menu, 2)
    assert [label for label, _ in rows2[-1]] == ["◀ 上一頁"]
    kind, token = qm.parse_callback(rows0[-1][0][1])
    assert kind == "g" and menus.press(kind, token, menu.location_key).key == "1"


def test_discord_and_slack_stay_inside_their_documented_limits() -> None:
    for platform, row_max in (("discord", 5), ("slack", 25)):
        menus = qm.QuickMenus()
        menu = _menu(menus, prompts=60, platform=platform)
        _, rows = menus.render(menu, 1)
        assert all(len(row) <= row_max for row in rows)
        if platform == "discord":
            assert len(rows) <= 5  # five action rows a message
            assert all(len(label) <= 38 and len(data) <= 100 for row in rows for label, data in row)


def test_long_names_are_clipped() -> None:
    menus = qm.QuickMenus()
    menu = menus.create(platform="telegram", location_key="k", pane_id="p", pane_title="t",
                        agent_key="claude", lang="en-US", prompts=[{"id": "x", "name": "y" * 200}], skills=[])
    label = menu.pages[0][0][0].label
    assert len(label) == qm.LAYOUTS["telegram"].label_max and label.endswith("…")


def test_tokens_expire_with_their_menu_and_only_work_in_their_chat() -> None:
    clock = Clock()
    menus = qm.QuickMenus(clock=clock)
    menu = _menu(menus)
    _, rows = menus.render(menu, 0)
    kind, token = qm.parse_callback(rows[0][0][1])
    assert menus.press(kind, token, "telegram:default:-100:51") is None
    assert menus.press("s", token, menu.location_key) is None
    clock.t += qm.MENU_TTL_S + 1
    assert menus.press(kind, token, menu.location_key) is None


def test_nothing_to_offer_is_no_menu() -> None:
    menus = qm.QuickMenus()
    assert menus.create(platform="telegram", location_key="k", pane_id="p", pane_title="t",
                        agent_key="claude", lang="zh-TW", prompts=[], skills=[]) is None


def test_vendor_without_a_verified_syntax_says_so_in_every_language() -> None:
    for lang in qm.STRINGS:
        menus = qm.QuickMenus()
        menu = _menu(menus, agent="opencode", lang=lang)
        body, _ = menus.render(menu, 0)
        assert qm.text(lang, "no_skill_syntax") in body
    assert all(set(table) == set(qm.STRINGS["zh-TW"]) for table in qm.STRINGS.values())


def test_skill_command_per_vendor() -> None:
    assert qm.skill_command("claude", "deploy") == "/deploy"
    assert qm.skill_command("codex", "deploy") == "$deploy"
    assert qm.skill_command("kimi", "deploy") == "/skill:deploy"


class FakeSkillStore:
    def __init__(self, agents: list[dict[str, Any]]) -> None:
        self.agents = agents

    def list_skills(self) -> dict[str, Any]:
        return {
            "skills": [
                {"name": "shared-a", "valid": True},
                {"name": "shared-b", "valid": True},
                {"name": "broken", "valid": False},
            ],
            "native": [
                {"name": "mine", "valid": True, "owner_agent": "claude", "real_path": "/c/mine"},
                {"name": "theirs", "valid": True, "owner_agent": "codex", "real_path": "/x/theirs"},
                {"name": "given", "valid": True, "owner_agent": "codex", "real_path": "/x/given"},
                {"name": "has space", "valid": True, "owner_agent": "claude", "real_path": "/c/sp"},
            ],
            "agents": self.agents,
        }

    def targets_for(self, agent_key: str) -> list[str]:
        return ["shared-a"]

    def native_targets_for(self, agent_key: str) -> list[str]:
        return ["/x/given"] if agent_key == "claude" else []


def test_agent_skills_follow_delivery() -> None:
    wired = FakeSkillStore([{"key": "claude", "state": "wired", "reads_shared_root": False}])
    assert qm.agent_skills(wired, "claude") == ["given", "mine", "shared-a"]
    reads_root = FakeSkillStore([{"key": "codex", "state": "wired", "reads_shared_root": True}])
    assert qm.agent_skills(reads_root, "codex") == ["given", "shared-a", "shared-b", "theirs"]
    assert qm.agent_skills(wired, "opencode") == []  # no verified syntax


def test_paging_back_and_forth_does_not_pile_up_tokens() -> None:
    # Each render mints a page's buttons; only the last few renders keep theirs,
    # instead of every one living out the menu's TTL.
    menus = qm.QuickMenus(clock=Clock())
    menu = _menu(menus, prompts=40)
    _, first = menus.render(menu, 0)
    per_page = sum(len(row) for row in first)
    for page in [1, 0] * 50:
        _, rows = menus.render(menu, page)
    assert len(menus._tokens) <= (per_page + 1) * qm.MAX_RENDERS_PER_MENU
    # The page on screen still works.
    kind, token = qm.parse_callback(rows[0][0][1])
    assert menus.press(kind, token, "telegram:default:-100:50") is not None

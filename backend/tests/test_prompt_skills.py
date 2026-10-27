from __future__ import annotations

import json
import re
from pathlib import Path

from agent_team_backend import prompt_skills as ps

REPO = Path(__file__).resolve().parents[2]


def test_seed_is_the_file_the_renderer_imports() -> None:
    # One source for both halves: the renderer must import this exact file.
    seed = json.loads((REPO / "backend" / "agent_team_backend" / "prompt_skill_seed.json").read_text("utf-8"))
    assert ps.load_seed() == seed
    renderer = (REPO / "src" / "renderer" / "src" / "lib" / "promptSkillSeed.ts").read_text("utf-8")
    assert "backend/agent_team_backend/prompt_skill_seed.json" in renderer
    assert set(seed["name"]) == set(ps.LANGUAGES) == set(seed["description"])


def test_never_saved_gives_the_builtin_in_the_users_language() -> None:
    skills = ps.effective({"agent-team:language": "en-US"})
    assert [s["id"] for s in skills] == ["advance"]
    assert skills[0]["name"] == ps.load_seed()["name"]["en-US"]
    assert skills[0]["prompt"] == ps.load_seed()["prompt"]
    assert skills[0]["isDefault"] is True and skills[0]["enabled"] is True


def test_builtin_takes_the_legacy_loop_prompt_and_unknown_language_falls_back() -> None:
    skills = ps.effective({"loop-prompt-text": "keep going", "agent-team:language": "it-IT"})
    assert skills[0]["prompt"] == "keep going"
    assert skills[0]["name"] == ps.load_seed()["name"][ps.DEFAULT_LANGUAGE]


def test_language_resolution() -> None:
    assert ps.language({"agent-team:language": "ja-JP"}) == "ja-JP"
    assert ps.language({"agent-team:language": "zh-TW"}) == "zh-TW"
    # Every UI locale has its own backend strings.
    for code in ("zh-CN", "ko-KR", "es-ES", "fr-FR", "de-DE", "pt-BR", "ru-RU", "vi-VN"):
        assert ps.language({"agent-team:language": code}) == code
    # Unset or garbage keeps the historical default.
    assert ps.language({}) == ps.DEFAULT_LANGUAGE == "zh-TW"
    assert ps.language({"agent-team:language": "fr"}) == "zh-TW"
    assert ps.language({"agent-team:language": 3}) == "zh-TW"


def test_languages_mirror_the_renderer_list() -> None:
    source = (REPO / "packages" / "plugin-ui" / "src" / "foundation" / "i18n" / "uiLocales.ts").read_text("utf-8")
    block = source.split("export const UI_LOCALES = [", 1)[1].split("]", 1)[0]
    assert set(re.findall(r"'([a-z]{2}-[A-Z]{2})'", block)) == set(ps.LANGUAGES)


def test_saved_list_is_normalized_like_the_renderer() -> None:
    raw = [
        {"id": "a", "name": "A", "prompt": "do a", "enabled": False, "isDefault": True},
        {"id": "a", "name": "B", "prompt": "do b"},
        {"id": "c", "name": "C", "prompt": "   "},
        "junk",
        {"id": "d", "name": "", "prompt": "do d", "isDefault": True},
    ]
    skills = ps.effective({"prompt-skills": raw})
    assert [s["prompt"] for s in skills] == ["do a", "do b", "do d"]
    assert len({s["id"] for s in skills}) == 3
    # The disabled default loses the flag to the first enabled flagged skill.
    assert [s["isDefault"] for s in skills] == [False, False, True]
    assert ps.castable(skills)[0]["prompt"] == "do d"
    assert [s["prompt"] for s in ps.castable(skills)] == ["do d", "do b"]


def test_empty_saved_list_falls_back_to_the_builtin() -> None:
    assert [s["id"] for s in ps.effective({"prompt-skills": []})] == ["advance"]

"""Every chat-side text table has every Navide UI language, with the same keys and
placeholders as zh-TW (the authored original)."""

from __future__ import annotations

import re
import unicodedata

import pytest

from agent_team_backend import prompt_skills as ps
from agent_team_backend.channels import media, quick_menu, telegram, wake

_SEED = ps.load_seed()
TABLES: dict[str, dict[str, dict[str, str]]] = {
    "wake": wake.STRINGS,
    "quick_menu": quick_menu.STRINGS,
    "media": media.STRINGS,
    "telegram": telegram.BOT_COMMAND_DESCRIPTIONS,
    "seed": {lang: {"name": _SEED["name"][lang], "description": _SEED["description"][lang]}
             for lang in _SEED["name"]},
}
_PLACEHOLDER = re.compile(r"\{[^}]*\}")


def _placeholders(text: str) -> list[str]:
    return sorted(_PLACEHOLDER.findall(text))


# The same check as frenchPunctuationProblems in plugin-ui's glossary.test.ts: a
# word-final : ; ? ! takes a no-break space before it.
def _french_punctuation_problems(text: str) -> list[str]:
    body = re.sub(r"`[^`]*`", " ", text)
    body = _PLACEHOLDER.sub(" ", body)
    body = re.sub(r"\b[a-z][a-z0-9+.-]*://\S+", " ", body, flags=re.I)
    body = re.sub(r"[^\s<>\u0080-￿]*[/\\][^\s<>\u0080-￿]*", " ", body)
    return [m.group(0) for m in re.finditer(r"[^\W_] ?([:;?!])(?=\s|$)", body)]


@pytest.mark.parametrize("name", sorted(TABLES))
def test_every_language_has_every_key_with_a_value(name: str) -> None:
    table = TABLES[name]
    assert set(table) == set(ps.LANGUAGES)
    keys = set(table["zh-TW"])
    for lang in ps.LANGUAGES:
        assert set(table[lang]) == keys, lang
        empty = [k for k, v in table[lang].items() if not v.strip()]
        assert empty == [], f"{name} {lang}: {empty}"


@pytest.mark.parametrize("name", sorted(TABLES))
def test_placeholders_match_the_original(name: str) -> None:
    table = TABLES[name]
    wrong = [f"{lang} {key}" for lang in ps.LANGUAGES for key, text in table[lang].items()
             if _placeholders(text) != _placeholders(table["zh-TW"][key])]
    assert wrong == []


@pytest.mark.parametrize("name", sorted(TABLES))
def test_french_puts_a_no_break_space_before_high_punctuation(name: str) -> None:
    problems = [f"{key}: {hit!r}" for key, text in TABLES[name]["fr-FR"].items()
                for hit in _french_punctuation_problems(text)]
    assert problems == []


@pytest.mark.parametrize("name", sorted(TABLES))
def test_vietnamese_is_nfc(name: str) -> None:
    assert [k for k, v in TABLES[name]["vi-VN"].items() if v != unicodedata.normalize("NFC", v)] == []


def test_french_check_matches_the_renderer_rule() -> None:
    assert _french_punctuation_problems("Supprimer ? Oui ! Note : ok") == []
    assert _french_punctuation_problems("Supprimer ? Oui!") == ["r ?", "i!"]
    assert _french_punctuation_problems("Erreur: {error}") == ["r:"]
    assert _french_punctuation_problems("{count}? voir https://navide.dev/a?b=1 et `a: b` à 10:30") == []


def test_each_language_renders_with_its_own_text() -> None:
    for lang in ps.LANGUAGES:
        assert wake.text(lang, "button") == wake.STRINGS[lang]["button"]
        assert quick_menu.text(lang, "mcp_on") == quick_menu.STRINGS[lang]["mcp_on"]
    # An unknown language still falls back to zh-TW.
    assert wake.text("it-IT", "button") == wake.STRINGS["zh-TW"]["button"]
    assert ps.language({"agent-team:language": "it-IT"}) == "zh-TW"

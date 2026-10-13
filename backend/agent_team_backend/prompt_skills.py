"""The Prompts page's skills (the ∞ button's prompts) as the backend reads them.

The renderer owns editing; the list lives in ui_settings under ``prompt-skills``.
A user who never saved one still has the builtin skill, seeded from
``prompt_skill_seed.json`` — the same file the renderer imports
(src/renderer/src/lib/promptSkillSeed.ts), so the two never drift.
``effective`` follows ``normalizePromptSkills`` in src/renderer/src/lib/promptSkills.ts.
"""

from __future__ import annotations

import functools
import json
import re
from pathlib import Path
from typing import Any

SETTING_KEY = "prompt-skills"
LEGACY_PROMPT_KEY = "loop-prompt-text"  # LOOP_PROMPT_SETTING_KEY in loopPrompt.ts
LANGUAGE_KEY = "agent-team:language"  # LANGUAGE_KEY in plugin-ui's i18n
LANGUAGES = ("zh-TW", "en-US", "ja-JP")
DEFAULT_LANGUAGE = "zh-TW"  # the renderer's fallbackLocale

_SEED_PATH = Path(__file__).with_name("prompt_skill_seed.json")


@functools.cache
def load_seed() -> dict[str, Any]:
    return json.loads(_SEED_PATH.read_text("utf-8"))


def language(settings: dict[str, Any]) -> str:
    saved = settings.get(LANGUAGE_KEY)
    return saved if saved in LANGUAGES else DEFAULT_LANGUAGE


def builtin(settings: dict[str, Any]) -> list[dict[str, Any]]:
    seed = load_seed()
    lang = language(settings)
    legacy = settings.get(LEGACY_PROMPT_KEY)
    return [{
        "id": seed["id"], "name": seed["name"][lang], "icon": seed["icon"],
        "description": seed["description"][lang],
        "prompt": legacy if isinstance(legacy, str) and legacy.strip() else seed["prompt"],
        "resumePrompt": "", "maxTurns": 0, "category": seed["category"],
        "enabled": True, "isDefault": True,
    }]


def _next_id(taken: list[str], name: str) -> str:
    stem = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:32] or "skill"
    if stem not in taken:
        return stem
    n = 2
    while f"{stem}-{n}" in taken:
        n += 1
    return f"{stem}-{n}"


def effective(settings: dict[str, Any]) -> list[dict[str, Any]]:
    """The saved list made valid (unique ids, exactly one default), else the builtin."""
    raw = settings.get(SETTING_KEY)
    if not isinstance(raw, list) or not raw:
        return builtin(settings)
    ids: list[str] = []
    skills: list[dict[str, Any]] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        prompt = entry.get("prompt") if isinstance(entry.get("prompt"), str) else ""
        if not prompt.strip():
            continue
        name = (entry.get("name") if isinstance(entry.get("name"), str) else "").strip()
        raw_id = (entry.get("id") if isinstance(entry.get("id"), str) else "").strip()
        skill_id = raw_id if raw_id and raw_id not in ids else _next_id(ids, name)
        ids.append(skill_id)
        skills.append({**entry, "id": skill_id, "name": name or skill_id, "prompt": prompt,
                       "enabled": entry.get("enabled") is not False,
                       "isDefault": entry.get("isDefault") is True})
    if not skills:
        return builtin(settings)
    flagged = next((i for i, s in enumerate(skills) if s["isDefault"] and s["enabled"]), -1)
    chosen = flagged if flagged >= 0 else max(0, next((i for i, s in enumerate(skills) if s["enabled"]), 0))
    return [{**s, "isDefault": i == chosen} for i, s in enumerate(skills)]


def castable(skills: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Enabled only, default first (``castablePromptSkills``)."""
    enabled = [s for s in skills if s["enabled"]]
    return sorted(enabled, key=lambda s: not s["isDefault"])

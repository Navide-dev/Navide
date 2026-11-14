"""The renderer shows and sends the builtin pipelines' Chinese stage text in
English under a non-Chinese UI, through a table keyed by the exact seed text
(src/renderer/src/lib/builtinPipelineText.json). A seed edited here without
the table would silently fall back to Chinese, so every Chinese string the
three builtins carry must be a key."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Iterator

from agent_team_backend.stages_store import (
    default_evolve_landing_pipeline,
    default_maintenance_stages,
    default_stages,
)

TABLE = Path(__file__).resolve().parents[2] / "src/renderer/src/lib/builtinPipelineText.json"
CJK = re.compile(r"[一-鿿]")


def _strings(value: Any) -> Iterator[str]:
    if isinstance(value, dict):
        for v in value.values():
            yield from _strings(v)
    elif isinstance(value, list):
        for v in value:
            yield from _strings(v)
    elif isinstance(value, str):
        yield value


def test_every_chinese_seed_string_has_an_english_entry() -> None:
    table = json.loads(TABLE.read_text(encoding="utf-8"))
    seeds = [default_stages(), default_maintenance_stages(), default_evolve_landing_pipeline()]
    chinese = {s for seed in seeds for s in _strings(seed) if CJK.search(s)}
    assert chinese, "the seeds should carry Chinese text"
    missing = sorted(s[:60] for s in chinese - table.keys())
    assert not missing, f"seed text missing from builtinPipelineText.json: {missing}"
    stale = sorted(k[:60] for k in table.keys() - chinese)
    assert not stale, f"builtinPipelineText.json keys no seed carries: {stale}"


def test_english_values_hold_no_chinese() -> None:
    table = json.loads(TABLE.read_text(encoding="utf-8"))
    assert not [k[:60] for k, v in table.items() if CJK.search(v)]

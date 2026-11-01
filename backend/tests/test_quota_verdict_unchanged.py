"""Accounts that report their windows are judged exactly as v0.2.36 judged them.

`absentWindows` changes the verdict for one kind of reading only: one a reader
proved has no such window. The baseline was recorded by running v0.2.36's own
code on every reading below, so these fail if the change reaches anything else.
"""

from __future__ import annotations

import datetime as dt
import itertools
import json
from pathlib import Path

import pytest

from agent_team_backend import quota_failover as qf

NOW = 1_800_000_000.0
KINDS = ("session", "weekly", "weekly-model", "monthly")
AGENTS = ("claude", "codex", "kimi", "qwen", "copilot")
LETTER = {"fresh-headroom": "F", "stale-headroom": "S", "reset-expected": "R", "unknown": "U", "exhausted": "X"}
BASELINE = json.loads(
    (Path(__file__).resolve().parents[2] / "tests/fixtures/quota-verdict-baseline-v0.2.36.json")
    .read_text(encoding="utf-8")
)["backendTiers"]


def iso(ts: float) -> str:
    return dt.datetime.fromtimestamp(ts, dt.timezone.utc).isoformat().replace("+00:00", "Z")


def readings(agent: str):
    for size in range(len(KINDS) + 1):
        for kinds in itertools.combinations(KINDS, size):
            for used in itertools.product((30, 100), repeat=size):
                for status in ("ok", "error"):
                    for stale in (False, True):
                        yield {
                            "provider": agent, "status": status, "stale": stale, "error": None,
                            "planType": None, "fetchedAt": iso(NOW - 60), "lastSuccessAt": iso(NOW - 60),
                            "windows": [
                                {"kind": k, "label": k, "usedPercent": u, "resetsAt": iso(NOW + 3600)}
                                for k, u in zip(kinds, used)
                            ],
                        }


def tier(reading: dict) -> str:
    return LETTER[qf.classify_candidate(reading, now=NOW)[0]]


@pytest.mark.parametrize("agent", AGENTS)
def test_a_reading_without_the_field_gets_the_v0_2_36_verdict(agent: str) -> None:
    assert "".join(tier(reading) for reading in readings(agent)) == BASELINE[agent]


@pytest.mark.parametrize("agent", AGENTS)
def test_a_reading_with_a_session_window_ignores_the_field(agent: str) -> None:
    for reading, expected in zip(readings(agent), BASELINE[agent]):
        if any(window["kind"] == "session" for window in reading["windows"]):
            assert tier({**reading, "absentWindows": ["session"]}) == expected


@pytest.mark.parametrize("empty", [None, []])
def test_an_empty_field_is_the_same_as_no_field(empty: list | None) -> None:
    for reading, expected in zip(readings("claude"), BASELINE["claude"]):
        assert tier({**reading, "absentWindows": empty}) == expected

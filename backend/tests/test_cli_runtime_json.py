"""Python's half of the JSON dialect the Rust runtime sorts.

``native/navide-cli-runtime/src/pyjson.rs`` decides, for a text its own parser
rejects, whether main's ``json.loads`` may read it (then the call is Python's)
or rejects it too (then the text is skipped as main skips it). Its cases live
in ``native/navide-cli-runtime/tests/json_dialect.json``; the crate holds the
runtime's answer to them, and this file holds the claims they make about
Python to Python itself, so neither side can drift alone.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

CASES = json.loads(
    (Path(__file__).resolve().parents[2] / "native" / "navide-cli-runtime" / "tests" / "json_dialect.json").read_text(
        encoding="utf-8"
    )
)


def _python_accepts(text: str | bytes) -> bool:
    try:
        json.loads(text)
    except ValueError:  # JSONDecodeError, and UnicodeDecodeError for bytes
        return False
    return True


def _payload(case: dict) -> str | bytes:
    """A case is a ``text`` or, for what ``json.loads(bytes)`` detects, a ``hex`` byte string."""
    return bytes.fromhex(case["hex"]) if "hex" in case else case["text"]


@pytest.mark.parametrize("case", CASES, ids=lambda case: repr(_payload(case))[:48])
def test_python_does_what_the_case_says(case: dict) -> None:
    assert _python_accepts(_payload(case)) == case["python_accepts"]


def test_no_text_python_reads_is_ever_sorted_as_rejected() -> None:
    """The one direction that loses records: a text Python reads that the runtime skips."""
    lost = [_payload(case) for case in CASES if case["python_accepts"] and case["expect"] == "rejected"]
    assert lost == []


def test_the_cases_cover_each_extension_python_has() -> None:
    python_only = [
        case["text"] for case in CASES if "text" in case and case["expect"] == "python" and case["python_accepts"]
    ]
    joined = "\n".join(python_only)
    for needle in ("\\ud83d", "NaN", "Infinity", "1e999"):
        assert needle in joined, needle
    assert any(len(text) > 300 for text in python_only), "an integer of more than 300 digits"


def test_the_cases_cover_each_way_json_loads_detects_an_encoding_in_bytes() -> None:
    byte_cases = [bytes.fromhex(case["hex"]) for case in CASES if "hex" in case and case["python_accepts"]]
    assert any(raw.startswith(b"\xef\xbb\xbf") for raw in byte_cases), "UTF-8 BOM"
    assert any(raw.startswith((b"\xff\xfe", b"\xfe\xff")) for raw in byte_cases), "UTF-16 BOM"
    assert any(b"\x00" in raw[:4] and not raw.startswith((b"\xff\xfe", b"\xfe\xff")) for raw in byte_cases), "NUL"


def test_nesting_is_python_only_between_128_levels_and_its_own_limit() -> None:
    """The depth cases are built, not typed: `pyjson`'s unit test builds the same texts."""
    nested = lambda depth: '{"n":' + "[" * depth + "]" * depth + "}"  # noqa: E731
    assert _python_accepts(nested(100))
    assert _python_accepts(nested(200))
    # Where it gives up depends on the interpreter's version and the stack it
    # is called from: `pyjson` hands everything past 900 levels over either way.
    with pytest.raises(RecursionError):
        json.loads(nested(200_000))
    assert not _python_accepts("[" * 200 + "]" * 199)

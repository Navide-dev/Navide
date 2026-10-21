"""A plan that starts with a UTF-8 BOM reaches the Host as a valid frame.

The Host refuses any child frame that holds a raw U+FEFF
(parseBackendWireFrame, src/main/plugins/pluginBackendSupervisor.ts), so the
child writes it as the JSON escape `\\ufeff`: the value is the same, and the
plan no longer drops Plans v2 into legacy recovery with PROTOCOL_ERROR.
"""

from __future__ import annotations

import importlib.util
import io
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ENTRY = Path(__file__).resolve().parents[2] / "plugins" / "navide-plans" / "backend" / "plans_backend.py"
_spec = importlib.util.spec_from_file_location("plans_backend_bom", ENTRY)
assert _spec is not None and _spec.loader is not None
plans_backend = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(plans_backend)

BOM_PLAN = "﻿<!doctype html><html><body>plan ﻿ mid</body></html>"


def _written(monkeypatch: pytest.MonkeyPatch, frame: dict) -> bytes:
    out = io.BytesIO()
    monkeypatch.setattr(sys, "stdout", SimpleNamespace(buffer=out))
    plans_backend._write_frame(frame)
    return out.getvalue()


def test_a_bom_in_a_frame_is_written_escaped_and_reads_back_unchanged(monkeypatch: pytest.MonkeyPatch) -> None:
    frame = {"jsonrpc": "2.0", "id": "r1", "result": {"resultType": "complete", "value": {"html": BOM_PLAN}}}
    line = _written(monkeypatch, frame)
    assert b"\xef\xbb\xbf" not in line
    assert line.endswith(b"\n") and line.count(b"\n") == 1
    assert json.loads(line)["result"]["value"]["html"] == BOM_PLAN


def test_frames_without_a_bom_are_written_as_before(monkeypatch: pytest.MonkeyPatch) -> None:
    frame = {"jsonrpc": "2.0", "id": "r2", "result": {"value": {"html": "é ✓ 計畫 😀"}}}
    line = _written(monkeypatch, frame)
    assert line == json.dumps(frame, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"


def test_size_budgets_count_the_escaped_bom(monkeypatch: pytest.MonkeyPatch) -> None:
    value = {"html": BOM_PLAN}
    assert plans_backend._encoded_size(value) == len(_written(monkeypatch, value)) - 1

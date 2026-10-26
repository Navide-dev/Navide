"""Page text holding a U+FEFF reaches the Host as a valid frame.

The Host refuses any child frame that holds a raw U+FEFF
(parseBackendWireFrame, src/main/plugins/pluginBackendSupervisor.ts), so the
browser child writes it as the JSON escape `\\ufeff`, as the Plans child does.
"""

from __future__ import annotations

import importlib.util
import io
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ENTRY = Path(__file__).resolve().parents[2] / "plugins" / "navide-browser" / "backend" / "browser_backend.py"
_spec = importlib.util.spec_from_file_location("navide_browser_backend_bom", ENTRY)
assert _spec is not None and _spec.loader is not None
browser = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(browser)

PAGE_TEXT = "﻿Hello ﻿ world"


def _written(monkeypatch: pytest.MonkeyPatch, frame: dict) -> bytes:
    out = io.BytesIO()
    monkeypatch.setattr(sys, "stdout", SimpleNamespace(buffer=out))
    browser._write_frame(frame)
    return out.getvalue()


def test_a_bom_in_page_text_is_written_escaped_and_reads_back_unchanged(monkeypatch: pytest.MonkeyPatch) -> None:
    frame = {"jsonrpc": "2.0", "id": "r1", "result": {"resultType": "complete", "value": {"text": PAGE_TEXT}}}
    line = _written(monkeypatch, frame)
    assert b"\xef\xbb\xbf" not in line
    assert line.endswith(b"\n") and line.count(b"\n") == 1
    assert json.loads(line)["result"]["value"]["text"] == PAGE_TEXT


def test_frames_without_a_bom_are_written_as_before(monkeypatch: pytest.MonkeyPatch) -> None:
    frame = {"jsonrpc": "2.0", "id": "r2", "result": {"value": {"text": "é ✓ 網頁 😀"}}}
    line = _written(monkeypatch, frame)
    assert line == json.dumps(frame, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n"

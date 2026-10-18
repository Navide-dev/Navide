"""The on-disk error ledger: bounded, never raising, and fed by the backend's
unretrieved task exceptions and failed request handlers."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import error_ledger


@pytest.fixture
def ledger(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> error_ledger.ErrorLedger:
    led = error_ledger.ErrorLedger(tmp_path / "logs" / error_ledger.FILE_NAME)
    monkeypatch.setattr(error_ledger, "_ledger", led)
    yield led
    led.close()


def test_entries_are_written_as_json_lines_and_read_back_newest_last(ledger) -> None:
    error_ledger.record("backend", "error", "a.code", "first", pane_id="p1")
    error_ledger.record("renderer", "warn", "b.code", "second", workspace="/ws")
    lines = ledger.path.read_text(encoding="utf-8").splitlines()
    assert [json.loads(line)["code"] for line in lines] == ["a.code", "b.code"]
    entries = ledger.read()
    assert [e["message"] for e in entries] == ["first", "second"]
    assert entries[0]["pane_id"] == "p1" and entries[1]["workspace"] == "/ws"
    assert [e["message"] for e in ledger.read(limit=1)] == ["second"]
    assert [e["message"] for e in ledger.read(source="renderer")] == ["second"]
    assert [e["message"] for e in ledger.read(pane_id="p1")] == ["first"]
    assert [e["message"] for e in ledger.read(since_ts=entries[0]["ts"])] in (["second"], [])


def test_unknown_source_and_level_are_normalised_and_long_text_cut(ledger) -> None:
    entry = error_ledger.record("??", "fatal", "c", "x" * 10_000)
    assert entry is not None
    assert entry["source"] == "backend" and entry["level"] == "error"
    assert len(entry["message"]) == error_ledger.MAX_MESSAGE


def test_the_ledger_is_bounded_on_disk(ledger, monkeypatch) -> None:
    monkeypatch.setattr(error_ledger, "MAX_BYTES", 2_000)
    monkeypatch.setattr(error_ledger, "BACKUPS", 2)
    led = error_ledger.ErrorLedger(ledger.path.with_name("small.jsonl"))
    for i in range(200):
        led.record("backend", "error", "spam", f"entry {i} " + "y" * 50)
    files = list(ledger.path.parent.glob("small.jsonl*"))
    assert len(files) <= 3
    assert sum(f.stat().st_size for f in files) < 3 * 2_000 + 500
    newest = led.read(limit=1)
    assert newest and newest[0]["message"].startswith("entry 199 ")
    led.close()


def test_a_corrupt_line_is_skipped(ledger) -> None:
    error_ledger.record("backend", "error", "ok", "kept")
    with ledger.path.open("a", encoding="utf-8") as fh:
        fh.write("{not json\n[1, 2]\n")
    error_ledger.record("backend", "error", "ok", "kept too")
    assert [e["message"] for e in ledger.read()] == ["kept", "kept too"]


def test_recording_never_raises_when_the_file_cannot_be_written(tmp_path, monkeypatch) -> None:
    blocker = tmp_path / "not-a-dir"
    blocker.write_text("")
    monkeypatch.setattr(error_ledger, "_ledger", error_ledger.ErrorLedger(blocker / "errors.jsonl"))
    assert error_ledger.record("backend", "error", "x", "y") is None


async def test_an_unretrieved_task_exception_is_recorded_and_still_reaches_the_old_handler(ledger) -> None:
    loop = asyncio.get_running_loop()
    seen: list[dict[str, Any]] = []
    old = loop.get_exception_handler()
    loop.set_exception_handler(lambda _loop, ctx: seen.append(ctx))
    try:
        error_ledger.install_loop_handler(loop)

        loop.call_exception_handler({
            "message": "Task exception was never retrieved",
            "exception": RuntimeError("nobody awaited me"),
            "task": asyncio.ensure_future(asyncio.sleep(0)),
        })
        await asyncio.sleep(0)
    finally:
        loop.set_exception_handler(old)
    entries = ledger.read()
    assert len(entries) == 1
    assert entries[0]["code"] == "loop.unhandled"
    assert "RuntimeError: nobody awaited me" in entries[0]["message"]
    assert len(seen) == 1  # handed on unchanged


async def test_a_failing_request_handler_is_recorded(ledger, monkeypatch) -> None:
    from agent_team_backend import app, ws_handlers

    async def broken(session, msg_id, msg_type, payload) -> None:
        raise ValueError("handler blew up")

    monkeypatch.setattr(ws_handlers, "lookup", lambda msg_type: broken)
    sent: list[dict[str, Any]] = []

    class _Session:
        dead = False

        async def send_json(self, data: dict[str, Any]) -> None:
            sent.append(data)

    await app.handle_message(_Session(), {"id": "1", "type": "some.request", "payload": {}})
    assert sent and sent[0]["error"]["code"] == "INTERNAL_ERROR"
    entries = ledger.read()
    assert [e["code"] for e in entries] == ["ws.internal_error"]
    assert "some.request: ValueError: handler blew up" in entries[0]["message"]


class _WsSession:
    dead = False

    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, data: dict[str, Any]) -> None:
        self.sent.append(data)


async def test_the_renderer_records_through_diagnostics_record(ledger) -> None:
    from agent_team_backend import app

    session = _WsSession()
    await app.handle_message(session, {"id": "7", "type": "diagnostics.record", "payload": {
        "level": "error", "code": "window.error", "message": "TypeError: x is undefined",
        "paneId": "p1", "workspace": "/ws/a",
    }})
    assert session.sent[0]["ok"] is True
    entry = ledger.read()[-1]
    assert entry["source"] == "renderer" and entry["code"] == "window.error"
    assert entry["pane_id"] == "p1" and entry["workspace"] == "/ws/a"


@pytest.mark.parametrize("payload", [
    None, [], {"level": "info", "code": "c", "message": "m"}, {"level": "error", "code": "", "message": "m"},
    {"level": "error", "code": "c", "message": 5},
])
async def test_diagnostics_record_refuses_what_is_not_a_warn_or_error_entry(ledger, payload) -> None:
    from agent_team_backend import app

    session = _WsSession()
    await app.handle_message(session, {"id": "8", "type": "diagnostics.record", "payload": payload})
    assert session.sent[0]["error"]["code"] == "BAD_REQUEST"
    assert ledger.read() == []


def test_read_filters_by_workspace(ledger) -> None:
    ledger.record("renderer", "error", "c", "in alpha", workspace="/ws/alpha/")
    ledger.record("renderer", "error", "c", "in beta", workspace="/ws/beta")
    ledger.record("main", "error", "c", "nowhere")
    assert [e["message"] for e in ledger.read(workspace="/ws/alpha")] == ["in alpha"]
    assert len(ledger.read()) == 3


def test_an_entry_with_a_known_pane_records_that_panes_workspace(ledger) -> None:
    from agent_team_backend import agent_messaging

    agent_messaging._reset_for_test()
    try:
        agent_messaging.register("p9", "worker", "/ws/alpha", owner=object())
        entry = error_ledger.record("renderer", "error", "pane.exit", "x", pane_id="p9")
        assert entry is not None and entry["workspace"] == "/ws/alpha"
        unknown = error_ledger.record("renderer", "error", "pane.exit", "y", pane_id="gone")
        assert unknown is not None and "workspace" not in unknown
    finally:
        agent_messaging._reset_for_test()

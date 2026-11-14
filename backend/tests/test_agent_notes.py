"""agent.notes: read-only memory / todo summaries from a fake HERMES_HOME and a
fake OpenClaw state dir. Never touches the real ~/.hermes or ~/.openclaw."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import agent_notes, app


@pytest.fixture(autouse=True)
def _fake_homes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, Path]:
    hermes = tmp_path / "hermes-home"
    openclaw = tmp_path / "openclaw-state"
    monkeypatch.setenv("HERMES_HOME", str(hermes))
    monkeypatch.setenv("OPENCLAW_STATE_DIR", str(openclaw))
    monkeypatch.setattr(agent_notes, "_logged", set())
    return {"hermes": hermes, "openclaw": openclaw}


def _write(path: Path, text: str, mtime: float) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    os.utime(path, (mtime, mtime))


def test_hermes_memories_newest_first_with_preview(_fake_homes: dict[str, Path]) -> None:
    mem = _fake_homes["hermes"] / "memories"
    _write(mem / "MEMORY.md", "# Memory\n\nUser prefers short replies.\n", 1_000)
    _write(mem / "USER.md", "Lives in Taipei.", 2_000)
    _write(mem / "notes.json", '{"k": "v"}', 1_500)
    _write(mem / "ignored.txt", "not a memory file", 3_000)
    _write(mem / ".hidden.md", "hidden", 4_000)

    out = agent_notes.read_agent_notes("hermes", limit=5)

    memory = out["memory"]
    assert memory["status"] == "ok"
    assert memory["root"] == str(mem)
    assert [e["name"] for e in memory["entries"]] == ["USER.md", "notes.json", "MEMORY.md"]
    assert memory["entries"][2]["preview"] == "Memory User prefers short replies."
    assert memory["entries"][0]["modified_at"] == 2_000_000
    assert out["todos"] == {"status": "unsupported", "root": "", "entries": []}


def test_hermes_limit_and_symlinks_skipped(_fake_homes: dict[str, Path], tmp_path: Path) -> None:
    mem = _fake_homes["hermes"] / "memories"
    for i in range(4):
        _write(mem / f"m{i}.md", f"note {i}", 1_000 + i)
    outside = tmp_path / "outside.md"
    _write(outside, "secret elsewhere", 9_000)
    (mem / "link.md").symlink_to(outside)

    entries = agent_notes.read_agent_notes("hermes", limit=2)["memory"]["entries"]

    assert [e["name"] for e in entries] == ["m3.md", "m2.md"]


def test_hermes_missing_and_empty_folders(_fake_homes: dict[str, Path]) -> None:
    assert agent_notes.read_agent_notes("hermes")["memory"]["status"] == "missing"
    (_fake_homes["hermes"] / "memories").mkdir(parents=True)
    assert agent_notes.read_agent_notes("hermes")["memory"]["status"] == "empty"


def test_hermes_state_db_is_not_read(_fake_homes: dict[str, Path]) -> None:
    # No memory table was measured in state.db: a store there changes nothing.
    _write(_fake_homes["hermes"] / "state.db", "not sqlite", 1_000)
    (_fake_homes["hermes"] / "memories").mkdir(parents=True)
    assert agent_notes.read_agent_notes("hermes")["memory"] == {
        "status": "empty", "root": str(_fake_homes["hermes"] / "memories"), "entries": [],
    }


def test_openclaw_memory_file_and_daily_notes(_fake_homes: dict[str, Path]) -> None:
    ws = _fake_homes["openclaw"] / "workspace"
    _write(ws / "MEMORY.md", "Durable facts.", 1_000)
    _write(ws / "memory" / "2026-11-09.md", "Yesterday's notes.", 2_000)
    _write(ws / "memory" / "2026-11-10.md", "Today's notes.", 3_000)
    _write(ws / "AGENTS.md", "workspace rules, not memory", 4_000)
    _write(ws / "SOUL.md", "persona, not memory", 4_000)

    out = agent_notes.read_agent_notes("openclaw", limit=5)

    assert out["memory"]["status"] == "ok"
    assert out["memory"]["root"] == str(ws)
    assert [e["name"] for e in out["memory"]["entries"]] == [
        "memory/2026-11-10.md", "memory/2026-11-09.md", "MEMORY.md",
    ]
    assert out["todos"]["status"] == "unsupported"


def test_openclaw_workspace_without_memory_is_empty(_fake_homes: dict[str, Path]) -> None:
    _write(_fake_homes["openclaw"] / "workspace" / "AGENTS.md", "rules", 1_000)
    assert agent_notes.read_agent_notes("openclaw")["memory"]["status"] == "empty"


def test_unknown_vendor_is_unsupported() -> None:
    out = agent_notes.read_agent_notes("claude")
    assert out["memory"]["status"] == "unsupported"
    assert out["todos"]["status"] == "unsupported"


def test_unavailable_source_logged_once(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level("INFO", logger="agent_team_backend.agent_notes")
    agent_notes.read_agent_notes("hermes")
    agent_notes.read_agent_notes("hermes")
    lines = [r.getMessage() for r in caplog.records if "hermes todos unsupported" in r.getMessage()]
    assert len(lines) == 1


class _FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


@pytest.mark.asyncio
async def test_ws_handler_answers_with_the_summary(_fake_homes: dict[str, Path]) -> None:
    _write(_fake_homes["hermes"] / "memories" / "MEMORY.md", "remember this", 1_000)
    ws = _FakeWebSocket()
    session = app.Session(ws)  # type: ignore[arg-type]

    await app.handle_message(session, {
        "id": "m1", "type": "agent.notes", "payload": {"agent_key": "hermes", "limit": "bad"},
    })

    reply = ws.sent[-1]
    assert reply["id"] == "m1"
    assert reply["payload"]["memory"]["entries"][0]["preview"] == "remember this"

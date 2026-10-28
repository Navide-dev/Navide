"""terminal.create filesystem work stays off asyncio's shared event loop."""

from __future__ import annotations

import asyncio
import threading
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import app, ws_handlers


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


class FakeTerminals:
    def __init__(self) -> None:
        self.created: list[dict[str, Any]] = []

    def create(self, **kwargs: Any) -> SimpleNamespace:
        self.created.append(kwargs)
        return SimpleNamespace(
            id=f"term-{len(self.created)}",
            pane_id=kwargs["pane_id"],
            command=kwargs["command"],
            proc=SimpleNamespace(pid=1234),
        )

    def find_live_by_resume_id(self, *args: Any, **kwargs: Any) -> list[Any]:
        return []


class FakeAttribution:
    def __init__(self):
        self.registered = []

    def register_pane(self, pane_id: str, **kwargs: Any) -> None:
        self.registered.append((pane_id, kwargs))

    def scan_pane_baseline(self, pane_id: str) -> None:
        pass


class FakeCodexHomeManager:
    def __init__(self, root: Path, default_home: bool = False) -> None:
        self.default_home = default_home
        self.root = root
        self.real_home = root / "real"

    def find_session_home(self, _resume_id: str) -> Path | None:
        return self.real_home if self.default_home else None

    def prepare(self, home_id: str, *, source_home: Path | None = None) -> Path:
        assert source_home is None
        return self.root / home_id


@pytest.mark.asyncio
@pytest.mark.parametrize("default_home", [False, True])
async def test_codex_home_lookup_prepare_and_spawn_wiring_use_to_thread(
    default_home: bool,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    original_to_thread = asyncio.to_thread
    threaded: list[str] = []

    async def spy(operation: Any, *args: Any, **kwargs: Any) -> Any:
        threaded.append(operation.__name__)
        return await original_to_thread(operation, *args, **kwargs)

    async def no_path_refresh(_agent_key: str) -> None:
        pass

    probe_threads: list[str] = []

    def probe(_agent_key: str, _command: Any) -> None:
        probe_threads.append(threading.current_thread().name)
        threaded.append("probe")
        return None

    def wire(
        _host: Any,
        _agent_key: str,
        command: Any,
        _pane_id: str = "",
        _env: dict[str, str] | None = None,
        _cwd: str = "",
    ) -> Any:
        return command

    monkeypatch.setattr(ws_handlers.asyncio, "to_thread", spy)
    monkeypatch.setattr(app, "_ensure_fresh_path_for_spawn", no_path_refresh)
    monkeypatch.setattr(app, "_probe_agent_cli_for_spawn", probe)
    monkeypatch.setattr(app, "attribution", FakeAttribution())
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    monkeypatch.setattr(app, "codex_home_manager", FakeCodexHomeManager(tmp_path / "homes", default_home))
    monkeypatch.setattr(
        app,
        "cli_profiles_store",
        SimpleNamespace(get_default_profile=lambda _agent_key: None),
    )
    monkeypatch.setattr(app.plugin_wiring, "apply_spawn_wiring", wire)
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    session.terminals = FakeTerminals()  # type: ignore[assignment]

    await app.handle_message(
        session,
        {
            "id": "codex-create",
            "type": "terminal.create",
            "payload": {
                "pane_id": "codex-pane",
                "agent_key": "codex",
                "command": "codex resume 12345678-1234-1234-1234-123456789abc",
                "cwd": "/ws",
                "metadata": {"workspace_path": "/ws"},
            },
        },
    )

    # wire_command is core's own MCP wiring, offloaded the same way and run
    # ahead of the plugin transformers: the endpoint it hands the pane is
    # Navide's own, and a pane that misses it loses every navide tool.
    assert threaded == ["probe", "find_session_home", *([] if default_home else ["prepare"]), "wire", "wire_command", "wire", "fingerprint"]
    # The probe runs in its own pool, never on asyncio's shared default one.
    assert probe_threads[0].startswith("cli-probe")
    created = session.terminals.created[0]  # type: ignore[attr-defined]
    if default_home:
        assert "CODEX_HOME" not in created["env"]
    else:
        assert created["env"]["CODEX_HOME"] == str(tmp_path / "homes" / "codex-pane")
    assert app.attribution.registered[0][1]["explicit_session_id"] == "12345678-1234-1234-1234-123456789abc"
    assert session.websocket.sent[-1]["ok"] is True  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_claude_spawn_wiring_uses_to_thread_and_preserves_transformer_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    original_to_thread = asyncio.to_thread
    threaded: list[str] = []

    async def spy(operation: Any, *args: Any, **kwargs: Any) -> Any:
        threaded.append(operation.__name__)
        return await original_to_thread(operation, *args, **kwargs)

    async def no_path_refresh(_agent_key: str) -> None:
        pass

    probe_threads: list[str] = []

    def probe(_agent_key: str, _command: Any) -> None:
        probe_threads.append(threading.current_thread().name)
        threaded.append("probe")
        return None

    def wire(
        _host: Any,
        _agent_key: str,
        command: Any,
        _pane_id: str = "",
        _env: dict[str, str] | None = None,
        _cwd: str = "",
    ) -> Any:
        return [*command[:-1], f"{command[-1]} --wired"]

    monkeypatch.setattr(ws_handlers.asyncio, "to_thread", spy)
    monkeypatch.setattr(app, "_ensure_fresh_path_for_spawn", no_path_refresh)
    monkeypatch.setattr(app, "_probe_agent_cli_for_spawn", probe)
    monkeypatch.setattr(app, "attribution", FakeAttribution())
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    monkeypatch.setattr(
        app,
        "cli_profiles_store",
        SimpleNamespace(get_default_profile=lambda _agent_key: None),
    )
    monkeypatch.setattr(app.plugin_wiring, "apply_spawn_wiring", wire)
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    session.terminals = FakeTerminals()  # type: ignore[assignment]

    await app.handle_message(
        session,
        {
            "id": "claude-create",
            "type": "terminal.create",
            "payload": {
                "pane_id": "claude-pane",
                "agent_key": "claude",
                "command": ["/bin/zsh", "-lc", "claude"],
                "cwd": "/ws",
                "metadata": {"workspace_path": "/ws"},
            },
        },
    )

    # wire_command is core's own MCP wiring, offloaded the same way and run
    # ahead of the plugin transformers: the endpoint it hands the pane is
    # Navide's own, and a pane that misses it loses every navide tool.
    assert threaded == ["probe", "wire_command", "wire", "fingerprint"]
    # The probe runs in its own pool, never on asyncio's shared default one.
    assert probe_threads[0].startswith("cli-probe")
    created = session.terminals.created[0]  # type: ignore[attr-defined]
    assert created["command"] == ["/bin/zsh", "-lc", "claude --wired"]
    assert session.websocket.sent[-1]["ok"] is True  # type: ignore[attr-defined]

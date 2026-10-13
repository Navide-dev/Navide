"""Settings → General → Resource limits: the test-runner worker cap.

Off by default — a pane gets exactly the env it always did, so test runs keep
their speed. Turned on, every NEW pane carries NAVIDE_TEST_MAX_WORKERS, which
this repo's vitest.config.ts reads to cap its worker pool. A bad value or an
unreadable settings store never blocks the spawn: the cap is simply not set.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import app, resource_limits

from .test_app_terminal_create import FakeAttribution, _session


class FakeSettingsStore:
    def __init__(self, values: dict[str, Any] | None = None, *, broken: bool = False) -> None:
        self.values = values or {}
        self.broken = broken

    def get(self) -> dict[str, Any]:
        if self.broken:
            raise RuntimeError("store unavailable")
        return dict(self.values)


async def _spawn_env(monkeypatch: pytest.MonkeyPatch, store: FakeSettingsStore) -> dict[str, str]:
    monkeypatch.setattr(app, "attribution", FakeAttribution())
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    monkeypatch.setattr(app, "ui_settings_store", store)
    session = _session()
    await app.handle_message(session, {
        "id": "c1",
        "type": "terminal.create",
        "payload": {
            "pane_id": "p1", "agent_key": "terminal", "command": "zsh",
            "cwd": "/ws", "metadata": {"workspace_path": "/ws"},
        },
    })
    created = session.terminals.created[0]  # type: ignore[attr-defined]
    return dict(created["env"] or {})


@pytest.mark.asyncio
async def test_default_leaves_the_pane_env_alone(monkeypatch: pytest.MonkeyPatch) -> None:
    env = await _spawn_env(monkeypatch, FakeSettingsStore())
    assert resource_limits.TEST_WORKERS_ENV not in env


@pytest.mark.asyncio
async def test_a_set_cap_reaches_new_panes(monkeypatch: pytest.MonkeyPatch) -> None:
    env = await _spawn_env(monkeypatch, FakeSettingsStore({resource_limits.TEST_WORKERS_KEY: "4"}))
    assert env[resource_limits.TEST_WORKERS_ENV] == "4"


@pytest.mark.asyncio
@pytest.mark.parametrize("value", ["0", "", "abc", "-3", None, [], "999"])
async def test_off_or_bad_values_set_no_cap(monkeypatch: pytest.MonkeyPatch, value: Any) -> None:
    env = await _spawn_env(monkeypatch, FakeSettingsStore({resource_limits.TEST_WORKERS_KEY: value}))
    assert resource_limits.TEST_WORKERS_ENV not in env


@pytest.mark.asyncio
async def test_an_unreadable_store_fails_open(monkeypatch: pytest.MonkeyPatch) -> None:
    env = await _spawn_env(monkeypatch, FakeSettingsStore(broken=True))
    assert resource_limits.TEST_WORKERS_ENV not in env

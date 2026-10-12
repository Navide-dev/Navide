"""Phase 3 for claude: Navide's hooks ride on the panes it starts.

A carried claude pane gets ``--settings <file>``, a file inside Navide's own
data holding exactly the hooks Phase 2 merged into ~/.claude/settings.json.
The user's config is never written, for fresh spawns and resumes alike.
"""

from __future__ import annotations

import inspect
import json
import stat
from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import app, claude_hooks, convenience_wiring, osplat, push_delivery, ws_handlers
from agent_team_backend.osplat import paths

from .test_app_terminal_create import FakeAttribution, _session

_SHELL = "/bin/zsh"


@pytest.fixture
def homes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, Path]:
    """A sandbox HOME whose ~/.claude is the CLI's config dir, and the
    backend's port file inside Navide's own (test) data dir."""
    home = tmp_path / "home"
    config = home / ".claude"
    config.mkdir(parents=True)
    monkeypatch.setenv("HOME", str(home))
    # Windows takes the home from USERPROFILE, not HOME.
    monkeypatch.setenv(osplat.paths.home_env_var(), str(home))
    monkeypatch.delenv("CLAUDE_CONFIG_DIR", raising=False)
    (config / "settings.json").write_text(json.dumps({"theme": "dark"}), encoding="utf-8")
    port = tmp_path / "backend-port"
    port.write_text("1234")
    return {"home": home, "config": config, "port": port}


@pytest.fixture
def carried(monkeypatch: pytest.MonkeyPatch) -> None:
    """claude registered as a pane carrier, as the backend's startup does."""
    monkeypatch.setattr(convenience_wiring, "_PANE_CARRIERS", {"claude": claude_hooks.prepare_pane_settings})
    monkeypatch.setattr(convenience_wiring, "_CARRYING", set())
    monkeypatch.setattr(claude_hooks, "_prepared_with", None)


def _tree(root: Path) -> dict[str, bytes]:
    return {str(p.relative_to(root)): p.read_bytes() for p in sorted(root.rglob("*")) if p.is_file()}


def _phase2_hooks(tmp_path: Path, port: str, skip: frozenset[str] = frozenset()) -> dict[str, Any]:
    """What Phase 2 merged into an empty shared settings file."""
    shared = tmp_path / "phase2" / "settings.json"
    claude_hooks.install_hooks(port, settings_file=shared, skip=skip)
    return json.loads(shared.read_text(encoding="utf-8"))


async def _spawn(command: str, *, pane_id: str = "claude-pane", is_login: bool = False) -> str:
    session = _session()
    payload: dict[str, Any] = {
        "pane_id": pane_id,
        "agent_key": "claude",
        "command": [_SHELL, "-lc", command],
        "cwd": "/ws",
        "metadata": {"workspace_path": "/ws"},
    }
    if is_login:
        payload["is_login"] = True
    await app.handle_message(session, {"id": "m1", "type": "terminal.create", "payload": payload})
    return session.terminals.created[0]["command"][-1]  # type: ignore[attr-defined]


@pytest.fixture
def spawnable(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(app, "attribution", FakeAttribution())
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)


def _settings_flag() -> str:
    return f"--settings {paths.quote_arg(str(claude_hooks.pane_settings_path()))}"


# ── the pane-side file ──────────────────────────────────────────────────────


def test_the_pane_file_holds_exactly_the_hooks_phase_2_wrote(homes, tmp_path) -> None:
    port = str(homes["port"])

    claude_hooks.prepare_pane_settings(port, frozenset())

    pane = claude_hooks.pane_settings_path()
    assert json.loads(pane.read_text(encoding="utf-8")) == _phase2_hooks(tmp_path, port)
    if osplat.paths.enforces_posix_modes():  # Windows keeps no mode bits
        assert stat.S_IMODE(pane.stat().st_mode) == 0o600
    assert pane.parent == push_delivery.runtime_dir("claude")


def test_the_pane_file_leaves_out_the_hooks_the_user_removed(homes, tmp_path) -> None:
    port = str(homes["port"])
    skip = frozenset({"Notification:notification", "PreToolUse:guard"})

    claude_hooks.prepare_pane_settings(port, skip)

    hooks = json.loads(claude_hooks.pane_settings_path().read_text(encoding="utf-8"))
    assert hooks == _phase2_hooks(tmp_path, port, skip)
    assert "Notification" not in hooks["hooks"]


def test_the_pane_file_follows_the_push_channel_switch(homes, tmp_path, monkeypatch) -> None:
    port = str(homes["port"])
    claude_hooks.prepare_pane_settings(port, frozenset())
    assert "SessionStart" in json.loads(claude_hooks.pane_settings_path().read_text(encoding="utf-8"))["hooks"]

    monkeypatch.setattr(claude_hooks, "_rewake_wanted", lambda: False)
    claude_hooks.prepare_pane_settings(port, frozenset())

    hooks = json.loads(claude_hooks.pane_settings_path().read_text(encoding="utf-8"))
    assert hooks == _phase2_hooks(tmp_path, port)
    assert "SessionStart" not in hooks["hooks"]


def test_rewriting_the_pane_file_leaves_nothing_else_behind(homes) -> None:
    port = str(homes["port"])
    claude_hooks.prepare_pane_settings(port, frozenset())
    claude_hooks.prepare_pane_settings(port, frozenset({"Stop:stop"}))

    names = sorted(p.name for p in claude_hooks.pane_settings_path().parent.iterdir())
    assert names == [claude_hooks.pane_settings_path().name]


# ── carrying, through the gate ──────────────────────────────────────────────


def test_carrying_claude_retracts_the_shared_entry_and_prepares_the_pane_file(homes, carried) -> None:
    port = str(homes["port"])
    with pytest.MonkeyPatch.context() as m:
        m.setattr(convenience_wiring, "_PANE_CARRIERS", {})
        convenience_wiring.install_hooks_gated("claude", claude_hooks.install_hooks, port)
    shared = homes["config"] / "settings.json"
    assert claude_hooks.hooks_present(shared)

    result = convenience_wiring.install_hooks_gated("claude", claude_hooks.install_hooks, port)

    assert result["convenience"] == "pane"
    assert not claude_hooks.hooks_present(shared)
    assert json.loads(shared.read_text(encoding="utf-8"))["theme"] == "dark"
    assert claude_hooks.hooks_present(claude_hooks.pane_settings_path())
    assert convenience_wiring.pane_carries_hooks("claude")


def test_the_push_channel_switch_refreshes_the_pane_file_not_the_shared_one(
    homes, carried, monkeypatch
) -> None:
    import asyncio

    monkeypatch.setattr("agent_team_backend.applog.backend_port_file", lambda: homes["port"])
    convenience_wiring.install_hooks_gated("claude", claude_hooks.install_hooks, str(homes["port"]))
    before = _tree(homes["home"])
    monkeypatch.setattr(claude_hooks, "_rewake_wanted", lambda: False)

    asyncio.run(ws_handlers._reinstall_claude_hooks())

    assert _tree(homes["home"]) == before
    hooks = json.loads(claude_hooks.pane_settings_path().read_text(encoding="utf-8"))["hooks"]
    assert "SessionStart" not in hooks
    assert convenience_wiring.pane_carries_hooks("claude")


def test_the_windows_version_probe_refreshes_the_pane_file_not_the_shared_one(
    homes, carried, monkeypatch
) -> None:
    port = str(homes["port"])
    convenience_wiring.install_hooks_gated("claude", claude_hooks.install_hooks, port)
    before = _tree(homes["home"])
    monkeypatch.setattr(claude_hooks, "_probe_claude_version", lambda: (2, 1, 200))
    monkeypatch.setattr(claude_hooks, "_known_claude_version", lambda: None)
    monkeypatch.setattr(claude_hooks, "_rewake_wanted", lambda: False)

    class _Db:
        def kv_set(self, *_a: Any, **_k: Any) -> None:
            pass

    monkeypatch.setattr("agent_team_backend.onboarding_deps._get_db", lambda: _Db())

    claude_hooks._refresh_claude_version(port)

    assert _tree(homes["home"]) == before
    assert "SessionStart" not in json.loads(claude_hooks.pane_settings_path().read_text(encoding="utf-8"))["hooks"]


def test_the_backend_registers_claude_as_a_carrier_before_installing_hooks() -> None:
    source = inspect.getsource(app._start_log_watcher)
    register = source.index('register_pane_carrier("claude", claude_hooks.prepare_pane_settings)')
    assert register < source.index("install_cli_hooks(")


# ── dev and production backends side by side ────────────────────────────────


def _production_hooks(homes: dict[str, Path], tmp_path: Path) -> Path:
    """The installed app's Phase 2 entries in the shared file."""
    production = tmp_path / "Agent-Team" / "backend-port"
    production.parent.mkdir()
    production.write_text("4321")
    shared = homes["config"] / "settings.json"
    claude_hooks.install_hooks(str(production), settings_file=shared)
    return shared


def test_a_dev_backend_never_retracts_the_production_backends_hooks(homes, carried, tmp_path) -> None:
    shared = _production_hooks(homes, tmp_path)
    before = shared.read_bytes()
    dev_port = tmp_path / "Agent-Team-dev" / "backend-port"
    dev_port.parent.mkdir()
    dev_port.write_text("5555")

    result = convenience_wiring.install_hooks_gated("claude", claude_hooks.install_hooks, str(dev_port))

    assert shared.read_bytes() == before
    # The dev panes carry their own hooks, aimed at the dev backend.
    assert result["convenience"] == "pane"
    assert "Agent-Team-dev" in claude_hooks.pane_settings_path().read_text(encoding="utf-8")


def test_a_dev_backend_switched_off_leaves_the_production_hooks_alone(homes, carried, tmp_path) -> None:
    shared = _production_hooks(homes, tmp_path)
    before = shared.read_bytes()
    dev_port = tmp_path / "Agent-Team-dev" / "backend-port"
    dev_port.parent.mkdir()
    dev_port.write_text("5555")

    convenience_wiring.set_feature("claude.hooks", False, port_file=str(dev_port))

    assert shared.read_bytes() == before


def test_a_dev_backend_retracts_its_own_shared_entry(homes, carried, tmp_path) -> None:
    dev_port = tmp_path / "Agent-Team-dev" / "backend-port"
    dev_port.parent.mkdir()
    dev_port.write_text("5555")
    shared = homes["config"] / "settings.json"
    claude_hooks.install_hooks(str(dev_port), settings_file=shared)

    convenience_wiring.install_hooks_gated("claude", claude_hooks.install_hooks, str(dev_port))

    assert not claude_hooks.hooks_present(shared)


# ── spawn ───────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "command",
    ["claude --dangerously-skip-permissions", "claude --resume resumed-uuid --dangerously-skip-permissions"],
)
async def test_a_carried_pane_starts_with_the_hooks_and_leaves_the_users_config_alone(
    homes, carried, spawnable, command
) -> None:
    convenience_wiring.install_hooks_gated("claude", claude_hooks.install_hooks, str(homes["port"]))
    before = _tree(homes["home"])

    spawned = await _spawn(command)

    assert spawned.startswith(command)
    assert spawned.count("--settings") == 1
    assert _settings_flag() in spawned
    assert _tree(homes["home"]) == before


@pytest.mark.asyncio
async def test_a_command_already_carrying_the_settings_is_not_wired_twice(homes, carried, spawnable) -> None:
    convenience_wiring.install_hooks_gated("claude", claude_hooks.install_hooks, str(homes["port"]))

    spawned = await _spawn(f"claude {_settings_flag()}")

    assert spawned.count("--settings") == 1


@pytest.mark.asyncio
async def test_a_login_pane_gets_no_settings(homes, carried, spawnable) -> None:
    convenience_wiring.install_hooks_gated("claude", claude_hooks.install_hooks, str(homes["port"]))

    spawned = await _spawn("claude --dangerously-skip-permissions", is_login=True)

    assert "--settings" not in spawned


@pytest.mark.asyncio
async def test_switched_off_no_pane_carries_the_hooks_and_nothing_is_written(homes, carried, spawnable) -> None:
    port = str(homes["port"])
    convenience_wiring.install_hooks_gated("claude", claude_hooks.install_hooks, port)
    convenience_wiring.set_feature("claude.hooks", False, port_file=port)
    before = _tree(homes["home"])

    off = await _spawn("claude")
    assert "--settings" not in off
    assert _tree(homes["home"]) == before

    convenience_wiring.set_feature("claude.hooks", True, port_file=port)
    assert _settings_flag() in await _spawn("claude", pane_id="claude-pane-2")
    assert _tree(homes["home"]) == before


@pytest.mark.asyncio
async def test_a_shared_entry_that_cannot_be_retracted_keeps_the_shared_hooks_and_no_settings(
    homes, carried, spawnable, monkeypatch
) -> None:
    port = str(homes["port"])
    shared = homes["config"] / "settings.json"
    with pytest.MonkeyPatch.context() as m:
        m.setattr(convenience_wiring, "_PANE_CARRIERS", {})
        convenience_wiring.install_hooks_gated("claude", claude_hooks.install_hooks, port)

    def stuck(*_a: Any, **_k: Any) -> None:
        raise OSError("read-only")

    monkeypatch.setattr(claude_hooks, "uninstall_hooks", stuck)
    convenience_wiring.install_hooks_gated("claude", claude_hooks.install_hooks, port)

    assert claude_hooks.hooks_present(shared)
    assert not convenience_wiring.pane_carries_hooks("claude")
    assert "--settings" not in await _spawn("claude")


@pytest.mark.asyncio
async def test_a_pane_file_gone_while_carrying_is_written_again_at_spawn(
    homes, carried, spawnable, tmp_path
) -> None:
    port = str(homes["port"])
    skip = frozenset({"Notification:notification"})
    with pytest.MonkeyPatch.context() as m:
        m.setattr(convenience_wiring, "_PANE_CARRIERS", {})
        convenience_wiring.install_hooks_gated("claude", claude_hooks.install_hooks, port)
        shared = homes["config"] / "settings.json"
        data = json.loads(shared.read_text(encoding="utf-8"))
        del data["hooks"]["Notification"]
        shared.write_text(json.dumps(data), encoding="utf-8")
        convenience_wiring.install_hooks_gated("claude", claude_hooks.install_hooks, port)
    convenience_wiring.install_hooks_gated("claude", claude_hooks.install_hooks, port)
    pane = claude_hooks.pane_settings_path()
    pane.unlink()

    spawned = await _spawn("claude")

    assert _settings_flag() in spawned
    assert json.loads(pane.read_text(encoding="utf-8")) == _phase2_hooks(tmp_path, port, skip)


@pytest.mark.asyncio
async def test_a_pane_file_that_cannot_be_written_again_starts_the_pane_without_settings(
    homes, carried, spawnable, monkeypatch, caplog
) -> None:
    convenience_wiring.install_hooks_gated("claude", claude_hooks.install_hooks, str(homes["port"]))
    claude_hooks.pane_settings_path().unlink()

    def broken(*_a: Any, **_k: Any) -> dict[str, Any]:
        return {"installed": False, "error": "disk full"}

    monkeypatch.setattr(claude_hooks, "install_hooks", broken)

    spawned = await _spawn("claude --dangerously-skip-permissions")

    assert spawned.startswith("claude --dangerously-skip-permissions")
    assert "--settings" not in spawned
    assert "pane settings" in caplog.text

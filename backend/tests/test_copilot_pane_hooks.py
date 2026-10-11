"""Phase 3 for Copilot: Navide's hook file rides on the panes it starts.

The pane's COPILOT_HOME shim gets a real ``hooks/`` directory holding
Navide's file plus a link to each of the user's hook files, so both fire and
nothing is written under ``~/.copilot``.
"""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path

import pytest

from agent_team_backend import convenience, convenience_wiring, copilot_hooks
from agent_team_backend.cli_vendors.registry import VENDORS
from agent_team_backend.db import Database
from agent_team_backend.plugins.builtin.navide_skills import skills_wiring


@pytest.fixture
def sandbox(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, Path]:
    home = tmp_path / "home"
    copilot = home / ".copilot"
    (copilot / "hooks").mkdir(parents=True)
    (copilot / "config.json").write_text('{"lastLoggedInUser": "me"}', encoding="utf-8")
    (copilot / "hooks" / "mine.json").write_text('{"version": 1, "hooks": {}}', encoding="utf-8")
    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(data))
    monkeypatch.setenv("COPILOT_HOME", str(copilot))
    monkeypatch.setattr(skills_wiring, "panes_root", lambda: tmp_path / "panes")
    monkeypatch.setattr(skills_wiring, "real_home", lambda: home)
    monkeypatch.setattr(skills_wiring, "_active", True)
    port = data / "backend-port"
    port.write_text("1234", encoding="utf-8")
    return {"home": home, "copilot": copilot, "data": data, "port": port, "panes": tmp_path / "panes"}


@pytest.fixture
def gate(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    gate = convenience.ConvenienceGate(Database(tmp_path / "navide.db"), backup_root=tmp_path / "backups")
    convenience_wiring.install(gate)
    monkeypatch.setattr(convenience_wiring, "_PANE_CARRIERS", {"copilot": copilot_hooks.prepare_pane_hooks})
    monkeypatch.setattr(convenience_wiring, "_CARRYING", set())
    yield gate
    convenience_wiring.install(None)


def _install(port: Path) -> dict:
    return convenience_wiring.install_hooks_gated("copilot", copilot_hooks.install_hooks, str(port))


def _spawn(sandbox: dict[str, Path], pane_id: str = "pane-1") -> Path:
    wiring = VENDORS["copilot"].skills_wiring
    root = skills_wiring.prepare_root(
        "copilot", wiring, pane_id, {}, store=None, native_root=sandbox["home"] / "native", home=sandbox["home"],
    )
    assert root is not None
    return Path(root)


def _tree(root: Path) -> dict[str, tuple[str, bytes | str]]:
    """Every entry under ``root``: its kind and bytes (or link target)."""
    found: dict[str, tuple[str, bytes | str]] = {}
    for dirpath, dirnames, filenames in os.walk(root):
        for name in [*dirnames, *filenames]:
            entry = Path(dirpath) / name
            rel = str(entry.relative_to(root))
            if entry.is_symlink():
                found[rel] = ("link", os.readlink(entry))
            elif entry.is_dir():
                found[rel] = ("dir", b"")
            else:
                found[rel] = ("file", entry.read_bytes())
    return found


def _carry(gate, sandbox: dict[str, Path]) -> None:
    assert _install(sandbox["port"])["convenience"] == "pane"
    assert convenience_wiring.pane_carries_hooks("copilot")


def test_the_pane_file_is_what_phase_2_wrote_into_the_shared_folder(sandbox, tmp_path) -> None:
    shared = tmp_path / "phase2"
    copilot_hooks.install_hooks(str(sandbox["port"]), shared)

    pane_file = copilot_hooks.prepare_pane_hooks(str(sandbox["port"]), frozenset())

    assert pane_file == sandbox["data"] / "runtime" / "copilot" / "hooks" / "agent-team.json"
    assert json.loads(pane_file.read_text(encoding="utf-8")) == json.loads(
        (shared / "agent-team.json").read_text(encoding="utf-8")
    )
    assert stat.S_IMODE(pane_file.stat().st_mode) == 0o600


def test_startup_retracts_the_shared_file_after_backing_it_up(gate, sandbox) -> None:
    shared = sandbox["copilot"] / "hooks" / "agent-team.json"
    with pytest.MonkeyPatch.context() as m:
        m.setattr(convenience_wiring, "_PANE_CARRIERS", {})
        _install(sandbox["port"])
    phase2 = shared.read_bytes()

    _carry(gate, sandbox)

    assert not shared.exists()
    assert (sandbox["copilot"] / "hooks" / "mine.json").read_text(encoding="utf-8") == '{"version": 1, "hooks": {}}'
    entry = gate.history("copilot.hooks", limit=1)[0]
    assert entry["action"] == "retract"
    assert Path(entry["backup"]).read_bytes() == phase2
    # The pane-side copy is the same document.
    assert json.loads(copilot_hooks.pane_hooks_file().read_bytes()) == json.loads(phase2)


def test_a_carried_pane_gets_its_own_hooks_folder_with_both_sets(gate, sandbox) -> None:
    _carry(gate, sandbox)

    shim = _spawn(sandbox)

    hooks = shim / "hooks"
    assert hooks.is_dir() and not hooks.is_symlink()
    assert sorted(p.name for p in hooks.iterdir()) == ["agent-team.json", "mine.json"]
    assert (hooks / "agent-team.json").resolve() == copilot_hooks.pane_hooks_file().resolve()
    assert (hooks / "mine.json").resolve() == (sandbox["copilot"] / "hooks" / "mine.json").resolve()
    # A hook file the user adds later is seen on the next spawn; one they
    # delete is gone from it.
    (sandbox["copilot"] / "hooks" / "later.json").write_text("{}", encoding="utf-8")
    (sandbox["copilot"] / "hooks" / "mine.json").unlink()
    _spawn(sandbox)
    assert sorted(p.name for p in hooks.iterdir()) == ["agent-team.json", "later.json"]


def test_the_users_copilot_tree_is_byte_identical_across_fresh_and_resumed_spawns(gate, sandbox) -> None:
    _carry(gate, sandbox)
    before = _tree(sandbox["home"])

    shim = _spawn(sandbox)  # fresh
    # Something Copilot itself leaves in the pane's hooks folder must stay
    # there, never be adopted into ~/.copilot.
    (shim / "hooks" / "made-here.json").write_text("{}", encoding="utf-8")
    _spawn(sandbox)  # resume: the same pane started again

    assert _tree(sandbox["home"]) == before
    assert (shim / "hooks" / "made-here.json").is_file()


def test_a_user_file_named_like_navides_is_linked_under_another_name(gate, sandbox) -> None:
    _carry(gate, sandbox)
    theirs = sandbox["copilot"] / "hooks" / "agent-team.json"
    theirs.write_text('{"version": 1, "hooks": {"sessionStart": []}}', encoding="utf-8")

    hooks = _spawn(sandbox) / "hooks"

    assert (hooks / "agent-team.json").resolve() == copilot_hooks.pane_hooks_file().resolve()
    assert (hooks / "agent-team.user.json").resolve() == theirs.resolve()


def test_another_backends_hook_file_is_neither_retracted_nor_linked(gate, sandbox, tmp_path, monkeypatch) -> None:
    # The installed app wrote the shared file; this backend is a dev one
    # beside it, with its own data folder.
    installed = tmp_path / "Agent-Team"
    installed.mkdir()
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(installed))
    copilot_hooks.install_hooks(str(installed / "backend-port"), sandbox["copilot"] / "hooks")
    shared = sandbox["copilot"] / "hooks" / "agent-team.json"
    production = shared.read_bytes()
    dev = tmp_path / "Agent-Team-dev"
    dev.mkdir()
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(dev))
    sandbox["port"] = dev / "backend-port"

    _carry(gate, sandbox)
    hooks = _spawn(sandbox) / "hooks"

    assert shared.read_bytes() == production
    assert sorted(p.name for p in hooks.iterdir()) == ["agent-team.json", "mine.json"]
    assert (hooks / "agent-team.json").resolve() == copilot_hooks.pane_hooks_file().resolve()


def test_off_keeps_todays_link_and_the_switch_goes_both_ways(gate, sandbox) -> None:
    convenience_wiring.set_feature("copilot.hooks", False, port_file=str(sandbox["port"]))
    assert not convenience_wiring.pane_carries_hooks("copilot")
    hooks = _spawn(sandbox) / "hooks"
    assert hooks.is_symlink() and hooks.resolve() == (sandbox["copilot"] / "hooks").resolve()

    convenience_wiring.set_feature("copilot.hooks", True, port_file=str(sandbox["port"]))
    assert convenience_wiring.pane_carries_hooks("copilot")
    _spawn(sandbox)
    assert hooks.is_dir() and not hooks.is_symlink()
    assert (hooks / "agent-team.json").is_symlink()

    convenience_wiring.set_feature("copilot.hooks", False, port_file=str(sandbox["port"]))
    _spawn(sandbox)
    assert hooks.is_symlink() and hooks.resolve() == (sandbox["copilot"] / "hooks").resolve()
    assert not (sandbox["copilot"] / "hooks" / "agent-team.json").exists()


def test_a_shared_file_that_cannot_be_retracted_stays_and_the_pane_keeps_the_link(gate, sandbox, monkeypatch) -> None:
    shared = sandbox["copilot"] / "hooks" / "agent-team.json"
    with pytest.MonkeyPatch.context() as m:
        m.setattr(convenience_wiring, "_PANE_CARRIERS", {})
        _install(sandbox["port"])
    monkeypatch.setattr(copilot_hooks, "uninstall_hooks", lambda: {"removed": False, "error": "read-only"})

    _install(sandbox["port"])

    assert not convenience_wiring.pane_carries_hooks("copilot")
    assert shared.is_file()
    assert any(e["action"] == "retract-failed" for e in gate.history("copilot.hooks"))
    hooks = _spawn(sandbox) / "hooks"
    assert hooks.is_symlink()


@pytest.mark.parametrize("command", ["copilot", "copilot --resume 0a1b2c3d"])
def test_a_spawn_carries_the_hooks_through_its_copilot_home(gate, sandbox, monkeypatch, command) -> None:
    _carry(gate, sandbox)
    before = _tree(sandbox["home"])
    env: dict[str, str] = {}

    assert skills_wiring.wire_command("copilot", command, None, "pane-7", env) == command

    hooks = Path(env["COPILOT_HOME"]) / "hooks"
    assert (hooks / "agent-team.json").resolve() == copilot_hooks.pane_hooks_file().resolve()
    assert (hooks / "mine.json").is_symlink()
    assert _tree(sandbox["home"]) == before


def test_without_the_skills_plugin_the_shared_file_stays_in_use(gate, sandbox, monkeypatch) -> None:
    monkeypatch.setattr(skills_wiring, "_active", False)

    assert _install(sandbox["port"])["convenience"] != "pane"

    assert not convenience_wiring.pane_carries_hooks("copilot")
    assert (sandbox["copilot"] / "hooks" / "agent-team.json").is_file()


def test_a_copilot_home_the_shims_do_not_mirror_keeps_the_shared_file(gate, sandbox, tmp_path, monkeypatch) -> None:
    # The backend inherited the user's own COPILOT_HOME: Phase 2 writes there,
    # but a shim mirrors ~/.copilot, so the panes could not carry the hooks.
    elsewhere = tmp_path / "elsewhere"
    (elsewhere / "hooks").mkdir(parents=True)
    monkeypatch.setenv("COPILOT_HOME", str(elsewhere))

    _install(sandbox["port"])

    assert not convenience_wiring.pane_carries_hooks("copilot")
    assert (elsewhere / "hooks" / "agent-team.json").is_file()


def test_the_skills_plugin_starting_or_stopping_moves_the_carrying(gate, sandbox, monkeypatch) -> None:
    from agent_team_backend.plugins.builtin.navide_skills import backend

    monkeypatch.setattr(skills_wiring, "_active", False)
    monkeypatch.setattr(convenience_wiring, "_installer", lambda key: copilot_hooks.install_hooks)
    _install(sandbox["port"])
    assert not convenience_wiring.pane_carries_hooks("copilot")

    backend.activate(type("Context", (), {"register_spawn_transformer": print, "register_mcp_tools": print})())

    assert convenience_wiring.pane_carries_hooks("copilot")
    assert not (sandbox["copilot"] / "hooks" / "agent-team.json").exists()
    backend.deactivate()
    assert not convenience_wiring.pane_carries_hooks("copilot")


def test_a_pane_with_its_own_copilot_home_is_warned_about(gate, sandbox, caplog) -> None:
    _carry(gate, sandbox)
    wiring = VENDORS["copilot"].skills_wiring

    skills_wiring.prepare_root("copilot", wiring, "pane-1", {"COPILOT_HOME": str(sandbox["home"] / "mine")})

    assert "without Navide's hooks" in caplog.text


def test_a_link_the_cli_made_in_the_pane_hooks_folder_is_kept(gate, sandbox, tmp_path) -> None:
    _carry(gate, sandbox)
    hooks = _spawn(sandbox) / "hooks"
    elsewhere = tmp_path / "theirs.json"
    elsewhere.write_text("{}", encoding="utf-8")
    (hooks / "cli-made.json").symlink_to(elsewhere)

    _spawn(sandbox)

    assert (hooks / "cli-made.json").resolve() == elsewhere.resolve()


def test_a_real_file_in_navides_place_is_moved_aside_not_left_to_hide_the_guard(gate, sandbox) -> None:
    _carry(gate, sandbox)
    hooks = _spawn(sandbox) / "hooks"
    (hooks / "agent-team.json").unlink()
    (hooks / "agent-team.json").write_text('{"hooks": {}}', encoding="utf-8")

    _spawn(sandbox)

    assert (hooks / "agent-team.json").resolve() == copilot_hooks.pane_hooks_file().resolve()
    assert (hooks / "agent-team.user.json").read_text(encoding="utf-8") == '{"hooks": {}}'

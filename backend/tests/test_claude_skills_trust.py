"""Claude Code 2.1.32x asks about every --add-dir directory with no trust
record ("Adding a new directory: ... This session hasn't worked here before"),
which stopped every new Claude pane on Navide's own skills view.

The view gets the CLI's own trust record (feature ``claude.skills-trust``):
``projects[<view>].hasTrustDialogAccepted`` in the config the pane's claude
reads, written under Claude Code's config lock, and nothing else trusted.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from agent_team_backend import claude_skills_trust, convenience, convenience_wiring
from agent_team_backend.db import Database
from agent_team_backend.mcp_server import pane_home
from agent_team_backend.plugins.builtin.navide_skills import skills_wiring

FEATURE = "claude.skills-trust"
USERS_OWN = {
    "numStartups": 7,
    "oauthAccount": {"emailAddress": "someone@example.invalid"},
    "projects": {"/work/repo": {"hasTrustDialogAccepted": True, "allowedTools": []}},
}


@pytest.fixture
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    fake = tmp_path / "home"
    fake.mkdir()
    monkeypatch.setattr(pane_home, "real_home", lambda: fake)
    monkeypatch.delenv(claude_skills_trust.CONFIG_DIR_ENV, raising=False)
    return fake


@pytest.fixture
def view(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "app data" / "runtime" / "skills-views" / "claude"
    (root / ".claude" / "skills" / "alpha").mkdir(parents=True)
    monkeypatch.setattr(skills_wiring, "prepare_view", lambda *a, **k: root)
    monkeypatch.setattr(skills_wiring, "agent_view_root", lambda agent_key: root)
    return root


@pytest.fixture
def gate(tmp_path: Path):
    gate = convenience.ConvenienceGate(Database(tmp_path / "navide.db"), backup_root=tmp_path / "backups")
    convenience_wiring.install(gate)
    yield gate
    convenience_wiring.install(None)


def _spawn(env: dict[str, str] | None = None, cwd: str = "/work/repo") -> str:
    return skills_wiring.wire_command("claude", "claude", None, "p1", {} if env is None else env, cwd)


def _config(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _key(view: Path) -> str:
    return claude_skills_trust.project_key(view)


def test_a_claude_spawn_records_the_skills_view_as_trusted(gate, home: Path, view: Path) -> None:
    config = home / ".claude.json"
    config.write_text(json.dumps(USERS_OWN, indent=2), encoding="utf-8")

    command = _spawn()

    assert "--add-dir" in command
    written = _config(config)
    assert written["projects"][_key(view)] == {"hasTrustDialogAccepted": True}
    # Everything else is the user's, unchanged.
    assert {k: v for k, v in written.items() if k != "projects"} == {
        k: v for k, v in USERS_OWN.items() if k != "projects"
    }
    assert written["projects"]["/work/repo"] == USERS_OWN["projects"]["/work/repo"]
    assert len(written["projects"]) == 2, "only the view is trusted, never the workspace or a parent"
    assert [e["action"] for e in gate.history(FEATURE)] == ["first"]


def test_an_account_pane_gets_the_record_in_its_own_config_dir(gate, home: Path, view: Path, tmp_path: Path) -> None:
    account = tmp_path / "accounts" / "slot-1"
    account.mkdir(parents=True)

    _spawn({claude_skills_trust.CONFIG_DIR_ENV: str(account)})

    assert _config(account / ".claude.json")["projects"][_key(view)]["hasTrustDialogAccepted"] is True
    assert not (home / ".claude.json").exists()


def test_an_existing_record_is_left_byte_for_byte(gate, home: Path, view: Path) -> None:
    config = home / ".claude.json"
    users = {**USERS_OWN, "projects": {_key(view): {"hasTrustDialogAccepted": True, "x": 1}}}
    config.write_text(json.dumps(users), encoding="utf-8")
    before = config.read_bytes()

    _spawn()

    assert config.read_bytes() == before


def test_a_held_claude_config_lock_is_waited_out_never_broken(
    gate, home: Path, view: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(claude_skills_trust, "LOCK_WAIT_S", 0.1)
    config = home / ".claude.json"
    config.write_text(json.dumps(USERS_OWN), encoding="utf-8")
    before = config.read_bytes()
    lock = Path(os.fspath(config) + ".lock")
    lock.mkdir()

    command = _spawn()

    assert "--add-dir" in command, "the spawn goes ahead; the pane shows the prompt as before"
    assert config.read_bytes() == before
    assert lock.is_dir(), "Claude Code's lock is its own"


def test_a_config_that_is_not_json_is_never_overwritten(gate, home: Path, view: Path) -> None:
    config = home / ".claude.json"
    config.write_text("{ not json", encoding="utf-8")

    _spawn()

    assert config.read_text(encoding="utf-8") == "{ not json"


def test_off_writes_nothing(gate, home: Path, view: Path) -> None:
    convenience_wiring.set_feature(FEATURE, False, port_file="")

    _spawn()

    assert not (home / ".claude.json").exists()


def test_the_switch_takes_back_exactly_the_record(gate, home: Path, view: Path) -> None:
    config = home / ".claude.json"
    config.write_text(json.dumps(USERS_OWN), encoding="utf-8")
    _spawn()
    assert _key(view) in _config(config)["projects"]

    convenience_wiring.set_feature(FEATURE, False, port_file="")

    assert _config(config) == USERS_OWN
    assert gate.state(FEATURE) == ("off", "user")


def test_a_record_the_user_removed_is_not_written_there_again(gate, home: Path, view: Path) -> None:
    config = home / ".claude.json"
    config.write_text(json.dumps(USERS_OWN), encoding="utf-8")
    _spawn()
    config.write_text(json.dumps(USERS_OWN), encoding="utf-8")

    _spawn()

    assert _key(view) not in _config(config)["projects"]
    assert gate.allowed(FEATURE), "one file's choice, not the feature's"


def test_the_feature_is_registered_and_switchable() -> None:
    assert convenience.feature(FEATURE).cli == "claude"
    assert convenience.feature(FEATURE).toggleable
    assert FEATURE in convenience_wiring.TAKEBACKS

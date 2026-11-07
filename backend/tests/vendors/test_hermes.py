"""hermes (Hermes Agent) vendor spec.

Hermes is a standalone agent: its providers and keys live in its own home
(~/.hermes, $HERMES_HOME). These lock down what Navide deliberately leaves to
it, and that Windows is offered (native PowerShell is an official install).
"""

from __future__ import annotations

from pathlib import Path

from agent_team_backend.cli_vendors import hermes, registry
from agent_team_backend.cli_vendors.base import VendorRuntimeContext

SPEC = registry.VENDORS["hermes"]


def test_identity_and_category() -> None:
    assert SPEC.key == "hermes"
    assert SPEC.label == "Hermes Agent"
    assert SPEC.category == "standalone"


def test_install_entry_runs_no_installer_on_any_platform() -> None:
    dep = SPEC.install_dep
    assert dep is not None
    assert dep.check_cmd == ["hermes", "--version"]
    assert dep.install_cmd == ""
    assert dep.install_cmds == {}
    assert dep.platforms == ()  # Windows included
    assert dep.update_cmd == "hermes update"
    assert dep.doctor_cmd == "hermes doctor"


def test_navide_holds_no_key() -> None:
    assert SPEC.live_file is None
    assert SPEC.account_switch is None
    assert SPEC.fetch_usage is None
    assert SPEC.login_command_args is None


def test_no_resume_model_or_reader() -> None:
    assert SPEC.supports_session_resume is False
    assert SPEC.make_log_reader is None
    assert SPEC.supports_model is False


def test_windows_home_is_local_appdata(tmp_path: Path) -> None:
    home = tmp_path / "home"
    local = tmp_path / "local"
    ctx = VendorRuntimeContext(home=home, env={"LOCALAPPDATA": str(local)}, cwd=tmp_path)
    assert hermes._home(ctx, platform="win32") == local / "hermes"
    bare = VendorRuntimeContext(home=home, env={}, cwd=tmp_path)
    assert hermes._home(bare, platform="win32") == home / "AppData" / "Local" / "hermes"
    assert hermes._home(bare, platform="darwin") == home / ".hermes"

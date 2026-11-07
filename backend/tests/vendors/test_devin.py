"""devin (Devin CLI, Cognition) vendor spec.

Wired from the official docs (read 2026-11-07) with no binary installed. These
lock down what Navide deliberately leaves to the CLI: sign-in, keys and the
cloud handoff stay Devin's own, and nothing unverified is declared.
"""

from __future__ import annotations

import re
from pathlib import Path

from agent_team_backend.cli_vendors import devin, registry
from agent_team_backend.cli_vendors.base import VendorRuntimeContext

SPEC = registry.VENDORS["devin"]


def test_identity_and_category() -> None:
    assert SPEC.key == "devin"
    assert SPEC.label == "Devin CLI (Cognition)"
    # A coding CLI: offered in the ＋ menu's CLI list, not the standalone block.
    assert SPEC.category == "cli"


def test_install_entry_runs_no_installer_on_any_platform() -> None:
    """Both official installers pipe a script into a shell; Navide only links the docs."""
    dep = SPEC.install_dep
    assert dep is not None
    assert dep.group == "agent_cli"
    assert dep.check_cmd == ["devin", "--version"]
    assert dep.install_cmd == ""
    assert dep.install_cmds == {}
    assert dep.platforms == ()  # Windows included
    assert dep.docs_url == "https://docs.devin.ai/cli"
    assert dep.update_cmd == "devin update"
    assert dep.doctor_cmd == "devin doctor"


def test_version_regex_reads_the_release_numbering() -> None:
    """Releases are numbered v3000.12.17 (changelog); the shape of the
    --version line itself is undocumented, so only the number is matched."""
    for line in ("v3000.12.17", "devin 3000.12.17\n", "Devin CLI v3000.11.234 (stable)"):
        match = re.search(SPEC.install_dep.version_regex, line)
        assert match is not None, line
    assert re.search(SPEC.install_dep.version_regex, "devin v3000.12.17").group(1) == "3000.12.17"


def test_navide_holds_no_key() -> None:
    assert SPEC.live_file is None
    assert SPEC.account_switch is None
    assert SPEC.fetch_usage is None
    assert SPEC.login_command_args is None
    assert SPEC.quota_exhausted_patterns == ()


def test_no_resume_model_reader_or_verified_version() -> None:
    assert SPEC.supports_session_resume is False
    assert SPEC.make_log_reader is None
    assert SPEC.supports_model is False
    assert SPEC.supports_effort is False
    assert SPEC.cli_verified_version == ""


def test_extensions_declared_unverified() -> None:
    assert SPEC.extensions is not None
    assert SPEC.extensions.supported is False
    assert SPEC.extensions.sources == ()


def test_data_root_is_the_documented_config_dir(tmp_path: Path) -> None:
    home = tmp_path / "home"
    appdata = tmp_path / "roaming"
    ctx = VendorRuntimeContext(home=home, env={"APPDATA": str(appdata)}, cwd=tmp_path)
    assert devin._config_dir(ctx, platform="win32") == appdata / "devin"
    bare = VendorRuntimeContext(home=home, env={}, cwd=tmp_path)
    assert devin._config_dir(bare, platform="win32") == home / "AppData" / "Roaming" / "devin"
    assert devin._config_dir(ctx, platform="darwin") == home / ".config" / "devin"
    assert SPEC.data_dir_env_vars == ("APPDATA",)

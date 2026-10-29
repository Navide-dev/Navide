"""An isolated backend (dev web mode) never reads the user's real home.

The readers below look the home up in the password database so a shimmed
``$HOME`` cannot redirect them. Under ``AGENT_TEAM_ISOLATED_HOME=1`` they must
use the scratch ``$HOME`` instead; without it they keep the passwd entry.
"""
import os
from pathlib import Path

import pytest

from agent_team_backend import native_mcp, native_skills, skills_store
from agent_team_backend.mcp_server import pane_home
from agent_team_backend.plugins.builtin.navide_skills import skills_wiring

READERS = [native_skills._home, skills_store._real_home, native_mcp._home,
           pane_home.real_home, skills_wiring.real_home]


@pytest.mark.parametrize("reader", READERS, ids=lambda f: f"{f.__module__}.{f.__name__}")
def test_isolated_backend_resolves_home_to_scratch_home(reader, tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))  # Path.home() on Windows
    monkeypatch.setenv("AGENT_TEAM_ISOLATED_HOME", "1")
    assert reader() == tmp_path


@pytest.mark.parametrize("reader", READERS, ids=lambda f: f"{f.__module__}.{f.__name__}")
def test_without_the_flag_the_passwd_home_still_wins_over_home(reader, tmp_path, monkeypatch):
    pwd = pytest.importorskip("pwd")
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("AGENT_TEAM_ISOLATED_HOME", raising=False)
    assert reader() == Path(pwd.getpwuid(os.getuid()).pw_dir)

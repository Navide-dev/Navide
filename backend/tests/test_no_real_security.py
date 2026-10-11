"""No test can run the real `security` binary (review KC-5).

The first guard patched one module attribute, which missed the vault app.py
builds at import, the vendor readers that call `/usr/bin/security` themselves,
and — found the hard way on 2026-10-11 — any test that calls
``monkeypatch.undo()``, which also undoes conftest's patches because they share
the fixture. This one replaces ``subprocess.Popen`` for the whole session.
"""

from __future__ import annotations

import asyncio
import subprocess

import pytest

from agent_team_backend import app
from agent_team_backend.credential_vault import CredentialVault

#: Never executed — the guard refuses it by name on every platform — so the
#: POSIX-path hygiene check has nothing to gate.
SECURITY = "/usr/bin/security"


@pytest.mark.parametrize("argv", [
    ["/usr/bin/security", "find-generic-password", "-s", "x"],
    ["security", "-i"],
    "security find-generic-password -s x",
])
def test_subprocess_cannot_start_security(argv):
    with pytest.raises(AssertionError, match="real Keychain"):
        subprocess.run(argv, shell=isinstance(argv, str), capture_output=True, timeout=5)
    with pytest.raises(AssertionError, match="real Keychain"):
        subprocess.Popen(argv, shell=isinstance(argv, str))


def test_the_guard_survives_monkeypatch_undo(monkeypatch):
    monkeypatch.undo()
    with pytest.raises(AssertionError, match="real Keychain"):
        subprocess.run([SECURITY, "-i"], input="", text=True, timeout=5)


def test_an_asyncio_subprocess_cannot_start_security():
    async def start():
        await asyncio.create_subprocess_exec("/usr/bin/security", "-i")

    with pytest.raises(AssertionError, match="real Keychain"):
        asyncio.run(start())


def test_a_vault_with_the_real_runner_cannot_reach_it(tmp_path):
    """What app.py builds at import. A test's monkeypatch.undo() no longer
    brings that one back (see the last test here), so one is built the same
    way: no runner given, so the real one."""
    vault = CredentialVault(root=tmp_path / "root", real_home=tmp_path / "home")
    with pytest.raises(AssertionError, match="real Keychain"):
        vault._security(["find-generic-password", "-s", "x"], None)


def test_other_programs_still_run():
    assert subprocess.run(["true"]).returncode == 0
    assert isinstance(CredentialVault, type)


def test_a_reloaded_app_cannot_reach_it_either():
    """``importlib.reload(app)`` (test_analyzer_routing does it) builds a fresh
    vault with the real runner. The guard is on subprocess, not on the vault,
    so that vault is refused too."""
    import importlib

    reloaded = importlib.reload(app)
    with pytest.raises(AssertionError, match="real Keychain"):
        reloaded.credential_vault._security(["find-generic-password", "-s", "x"], None)


def test_monkeypatch_undo_leaves_conftest_isolation_in_place(monkeypatch, tmp_path):
    """A test's ``monkeypatch.undo()`` undid conftest's isolation too, since
    both shared the one fixture: the vault went back to the import-time one
    with the real runner, under the real HOME (2026-10-11 16:19, a sync test).
    conftest now keeps its own MonkeyPatch, undone only at its own teardown."""
    import os

    from agent_team_backend import native_skills
    from agent_team_backend.cli_vendors import claude as claude_vendor

    vault = app.credential_vault
    fetch = claude_vendor.fetch_claude_usage_via_cli
    home = native_skills._home
    monkeypatch.undo()
    assert app.credential_vault is vault
    assert os.environ["AGENT_TEAM_DATA_DIR"] == str(tmp_path)
    assert claude_vendor.fetch_claude_usage_via_cli is fetch
    assert native_skills._home is home

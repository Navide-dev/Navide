"""The frozen backend must not hand its bundled library path to child processes.

Issue #417: on the Linux onefile build every pane printed
``systemd-cat: /tmp/_MEI…/libcrypto.so.3: version OPENSSL_3.4.0 not found``,
because PyInstaller's bootloader points ``LD_LIBRARY_PATH`` at the extraction
directory and every spawn inherited it.
"""

from __future__ import annotations

import ast
import os
import sys
from pathlib import Path

import pytest

from agent_team_backend import frozen_env

MEI = "/tmp/_MEI123abc"


@pytest.fixture
def frozen(monkeypatch):
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", MEI, raising=False)


def test_restores_the_original_value_when_the_bootloader_saved_one(frozen):
    env = {"LD_LIBRARY_PATH": f"{MEI}{os.pathsep}/opt/lib", "LD_LIBRARY_PATH_ORIG": "/opt/lib"}
    frozen_env.restore_bundled_library_path(env)
    assert env["LD_LIBRARY_PATH"] == "/opt/lib"


def test_removes_the_variable_when_there_was_no_original(frozen):
    env = {"LD_LIBRARY_PATH": MEI, "PATH": "/usr/bin"}
    frozen_env.restore_bundled_library_path(env)
    assert env == {"PATH": "/usr/bin"}


def test_leaves_a_value_the_bootloader_did_not_set(frozen):
    # macOS and Windows bootloaders never set LD_LIBRARY_PATH, so a value the
    # user exported themselves must survive untouched.
    env = {"LD_LIBRARY_PATH": "/opt/lib"}
    frozen_env.restore_bundled_library_path(env)
    assert env == {"LD_LIBRARY_PATH": "/opt/lib"}


def test_noop_when_not_frozen(monkeypatch):
    monkeypatch.delattr(sys, "frozen", raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", MEI, raising=False)
    env = {"LD_LIBRARY_PATH": MEI, "LD_LIBRARY_PATH_ORIG": "/opt/lib"}
    frozen_env.restore_bundled_library_path(env)
    assert env == {"LD_LIBRARY_PATH": MEI, "LD_LIBRARY_PATH_ORIG": "/opt/lib"}


def test_entry_point_restores_before_importing_the_backend():
    # It has to run before `osplat` snapshots os.environ at import (_PS_ENV)
    # and before the credential helper exec()s a CLI from __main__.
    tree = ast.parse((Path(__file__).resolve().parents[1] / "run.py").read_text())
    body = [ast.unparse(node) for node in tree.body]
    restore = next(i for i, s in enumerate(body) if "restore_bundled_library_path(" in s)
    backend = next(i for i, s in enumerate(body) if "agent_team_backend.__main__" in s)
    assert restore < backend


# ---- panes get the user's own temp dir back ---------------------------------
#
# The packaged app points the backend's TMPDIR/TMP/TEMP at
# <data dir>/backend-tmp (src/main/backend.ts) so no OS temp cleaner sweeps its
# files. Panes must not inherit that path: it has a space and differs in case
# from the repo name, and 41 release-gate tests failed on it (0.2.40).

BACKEND_TMP = "/Users/u/Library/Application Support/Agent-Team/backend-tmp"


def _own(original: dict[str, str]) -> dict[str, str]:
    import json

    return {
        "TMPDIR": BACKEND_TMP,
        "TMP": BACKEND_TMP,
        "TEMP": BACKEND_TMP,
        frozen_env.ORIGINAL_TEMP_ENV_VAR: json.dumps(original),
    }


def test_pane_gets_the_original_temp_dir_back():
    own = _own({"TMPDIR": "/var/folders/xx/T/"})
    env = frozen_env.restore_user_temp_env(dict(own), own)
    assert env == {"TMPDIR": "/var/folders/xx/T/"}


def test_keys_that_were_unset_are_dropped():
    own = _own({})
    env = frozen_env.restore_user_temp_env({**own, "PATH": "/bin"}, own)
    assert env == {"PATH": "/bin"}


def test_windows_tmp_and_temp_are_restored():
    own = _own({"TMP": r"C:\Users\u\AppData\Local\Temp", "TEMP": r"C:\Users\u\AppData\Local\Temp"})
    env = frozen_env.restore_user_temp_env(dict(own), own)
    assert env == {"TMP": r"C:\Users\u\AppData\Local\Temp", "TEMP": r"C:\Users\u\AppData\Local\Temp"}


def test_a_temp_dir_the_pane_chose_itself_is_kept():
    own = _own({"TMPDIR": "/var/folders/xx/T/"})
    env = frozen_env.restore_user_temp_env({"TMPDIR": "/my/tmp"}, own)
    assert env == {"TMPDIR": "/my/tmp"}


def test_no_marker_leaves_the_env_alone():
    own = {"TMPDIR": "/var/folders/xx/T/"}
    env = {"TMPDIR": "/var/folders/xx/T/"}
    assert frozen_env.restore_user_temp_env(env, own) == {"TMPDIR": "/var/folders/xx/T/"}


def test_the_callers_env_is_not_mutated():
    own = _own({})
    env = dict(own)
    frozen_env.restore_user_temp_env(env, own)
    assert env == own


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX pty")
def test_posix_pane_spawn_hands_the_child_the_restored_env(monkeypatch):
    from agent_team_backend.osplat import _posix

    own = _own({"TMPDIR": "/var/folders/xx/T/"})
    monkeypatch.setattr(frozen_env.os, "environ", own)
    seen: dict = {}

    class _Stop(Exception):
        pass

    def fake_popen(argv, **kwargs):
        seen.update(kwargs["env"])
        raise _Stop

    monkeypatch.setattr(_posix.subprocess, "Popen", fake_popen)
    with pytest.raises(_Stop):
        _posix.PosixTerminalBackend().spawn(["true"], cwd="/", env=dict(own), rows=24, cols=80)
    assert seen == {"TMPDIR": "/var/folders/xx/T/"}

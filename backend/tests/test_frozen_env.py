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

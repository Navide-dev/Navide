"""A Python process a test starts cannot run the real `security` either.

conftest's guard lives in the test process. A backend or helper a test spawns
(`python -m agent_team_backend` in the shutdown and parent-watch tests) builds
its own vault with the real runner and, under the isolated HOME conftest sets,
asked the real `security` for the server token and vendor items — found under a
sandbox on 2026-10-11 while tracing a "keychain cannot be found" dialog.
"""

from __future__ import annotations

import os
import subprocess
import sys

_PROBE = r"""
import subprocess, sys
if subprocess.Popen.__name__ != "_NoKeychainPopen":
    print("unguarded", subprocess.Popen.__name__)
    sys.exit(3)  # never try the real binary from an unguarded process
try:
    subprocess.run(["security", "find-generic-password", "-s", "x"], timeout=5)
except PermissionError as err:
    print("refused", err)
    sys.exit(0)
sys.exit(4)
"""


def test_a_spawned_python_refuses_security():
    result = subprocess.run([sys.executable, "-c", _PROBE], env=dict(os.environ),
                            capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "real Keychain" in result.stdout


def test_a_spawned_python_keeps_the_guard_for_its_own_children():
    nested = f"import subprocess, sys; sys.exit(subprocess.run([sys.executable, '-c', {_PROBE!r}]).returncode)"
    result = subprocess.run([sys.executable, "-c", nested], env=dict(os.environ),
                            capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stdout + result.stderr

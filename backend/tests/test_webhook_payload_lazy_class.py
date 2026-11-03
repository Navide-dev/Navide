"""The invisible-character class is built on first use, not at import.

Building it calls unicodedata.category for all 1,114,112 code points: 0.3 to
1 s of CPU, longer on a busy VM, paid on every backend start whether or not a
webhook ever arrives.
"""

from __future__ import annotations

import os
import subprocess
import sys
import textwrap
from pathlib import Path

import agent_team_backend

_PROBE = textwrap.dedent(
    """
    import unicodedata
    calls = [0]
    real = unicodedata.category
    def counting(ch):
        calls[0] += 1
        return real(ch)
    unicodedata.category = counting
    import agent_team_backend.webhook_payload as wp
    at_import = calls[0]
    out = wp.sanitize_text("-\\u200b-\\u0301-")
    print(at_import, calls[0] > 0, out == "\\u2013\\u200b\\u2013\\u0301\\u2013")
    """
)


def test_import_does_not_build_the_class_and_first_use_does() -> None:
    # The package this test run imports, not whichever checkout the
    # interpreter's own path points at.
    root = str(Path(agent_team_backend.__file__).resolve().parents[1])
    env = {**os.environ, "PYTHONPATH": os.pathsep.join(filter(None, [root, os.environ.get("PYTHONPATH")]))}
    done = subprocess.run([sys.executable, "-c", _PROBE], capture_output=True, text=True, timeout=120, env=env)
    assert done.returncode == 0, done.stderr
    assert done.stdout.split() == ["0", "True", "True"], done.stdout + done.stderr

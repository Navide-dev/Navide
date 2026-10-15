"""`tests/osplat_win_swap.py` named in a file list is skipped, never applied.

Applied there, its swap held for the rest of the process: every later test that
spawns through `osplat.paths.shell_command()` was handed a `cmd.exe` command
(test_vendor_contracts' 15 vendor_launch cases, on a `backend/tests/*.py` run).
"""

import subprocess
import sys
from pathlib import Path

TESTS = Path(__file__).resolve().parent


def test_the_win_swap_plugin_named_as_a_file_is_skipped_not_applied(tmp_path) -> None:
    probe = TESTS / "osplat_win_swap.py"
    result = subprocess.run(
        [sys.executable, "-m", "pytest", str(probe), "-q", "-rs", "-p", "no:randomly", "-p", "no:cacheprovider",
         "--rootdir", str(TESTS.parent), "--basetemp", str(tmp_path / "t")],
        cwd=TESTS.parent, capture_output=True, text=True, timeout=120,
    )
    # A run whose only item is a module-level skip exits 5 ("no tests ran"),
    # as the old code's did; the summary line is what tells the two apart.
    assert "1 skipped" in result.stdout and "a plugin, not a test module" in result.stdout, (
        result.stdout + result.stderr
    )

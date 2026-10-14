"""pytest plugin: run the suite on a POSIX host with `osplat.paths` swapped to
the Windows implementation.

    OSPLAT_SWAP=paths uv --project backend run pytest backend/tests -p tests.osplat_win_swap

Not a Windows emulator. It catches one class of bug minutes before the
Windows CI job would: a test that builds a platform-dependent value by a
different route than the module under test (a `HOME` set where the code reads
`paths.home_env_var()`, a `~/.config` literal where the code asks
`paths.config_home()`, an `os.name` branch picking the expected value). Those
tests pass on the platform they were written on and fail on exactly one
other. With the seam swapped they fail here, on the fastest runner. What it
verifies and what it cannot is written up in CONTRIBUTING.md.

Loaded with `-p tests.osplat_win_swap`, which works from any cwd because the
editable install puts `backend/` on `sys.path` (so `tests` is importable).

THE SWAP HAPPENS AT MODULE IMPORT TIME, ON PURPOSE. Do not move it into
`pytest_configure`. `-p` plugins are imported during option preparsing, before
`tests/conftest.py`; that conftest imports `app` and `ws_handlers`, which
transitively execute every bound-style `from .osplat import paths` in the
feature code — `git_service.py`, `host_shell.py`, `push_delivery.py`,
`mcp_server/wiring.py`, `cli_vendors/base.py` (re-exported by
`cli_vendors/cursor.py`) bind the object at import and never look at
`osplat.paths` again. A swap in `pytest_configure` runs after that conftest,
so those five modules would keep the host implementation and the run would
go green while exercising nothing. Import-time is the only point that reaches
them. (Verified 2026-09-13 with an identity check on each module's `paths`
after loading the conftest.)

Only `paths` and `platform_id` are swappable:

- `paths` is pure path arithmetic over environment variables and runs
  anywhere; swapping it makes every seam-keyed skip (`enforces_posix_modes()`,
  `login_path_probe() is None`) fall the way it falls on Windows, and every
  `home_env_var()` / `config_home()` / `shell_command()` caller compute the
  Windows answer. Full suite on 2026-09-13: 5185 passed, 352 skipped, 0 failed.
- `platform_id` is harmless and adds little: the feature code that reads it
  (`onboarding_deps`, `executions_service`, `server_link`) is tested with the
  value monkeypatched, and the win-only skips key on `sys.platform`.
- `secret_files`, `terminal_backend`, `process_tree`, `resource_probe` are NOT
  swappable and are refused below. Their Windows implementations reach
  `ctypes.WinDLL` (crypt32 for DPAPI, kernel32 for Job Objects), `icacls`, and
  `import winpty` at call time; none exist on macOS or Linux, so a swap turns
  every caller red with `AttributeError: module 'ctypes' has no attribute
  'WinDLL'` / `No module named 'winpty'` — measured at 70 and 8 failures for
  three and five test files respectively. That is noise, not signal; the
  stubbed seam tests (`test_osplat_windows_terminal.py`,
  `test_secret_file_protection.py`) already cover those code paths.
"""

from __future__ import annotations

import os
import sys

import pytest

# Loaded with `-p`, this module is imported before `tests/conftest.py`. Imported
# after it, it is being collected as a test file: a file list such as
# `backend/tests/*.py` names it, and pytest collects an explicitly named file
# whatever its name. A swap then would hold for the rest of the process and
# hand every later test that spawns through `paths.shell_command()` a
# `cmd.exe` command, so it does nothing and reports itself skipped.
if "tests.conftest" in sys.modules:
    pytest.skip("a plugin, not a test module: load it with -p tests.osplat_win_swap", allow_module_level=True)

from agent_team_backend import osplat  # noqa: E402
from agent_team_backend.osplat import _windows  # noqa: E402

_SWAPPABLE = ("paths", "platform_id")

SEAMS: tuple[str, ...] = tuple(
    s.strip() for s in os.environ.get("OSPLAT_SWAP", "paths").split(",") if s.strip()
)

_unknown = [s for s in SEAMS if s not in _SWAPPABLE]
if _unknown:
    raise pytest.UsageError(
        f"OSPLAT_SWAP={','.join(SEAMS)}: only {', '.join(_SWAPPABLE)} can be swapped "
        f"on a POSIX host; {', '.join(_unknown)} would fail on missing WinDLL/winpty/"
        "icacls, not on anything the tests assert (see the module docstring)"
    )

for _seam in SEAMS:
    if _seam == "platform_id":
        osplat.platform_id = "win32"
    else:
        setattr(osplat, _seam, getattr(_windows, _seam))


def pytest_report_header(config: pytest.Config) -> list[str]:
    return [
        f"osplat_win_swap: swapped={list(SEAMS)} "
        f"paths={type(osplat.paths).__name__} platform_id={osplat.platform_id}"
    ]

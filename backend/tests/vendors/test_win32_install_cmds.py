"""The install each agent CLI offers on Windows is the vendor's own Windows one.

`curl … | bash` / `| sh` can never work there: Windows PowerShell 5.1 aliases
`curl` to Invoke-WebRequest, and the `bash` a Windows PATH may carry is WSL's,
which installs into the Linux VM rather than for Navide. Every command below
is taken verbatim from the vendor's official Windows instructions (sources in
each vendor module).
"""

import re

import pytest

from agent_team_backend.onboarding_deps import DEPS, DEPS_BY_ID

WIN32 = {
    "antigravity": ("irm https://antigravity.google/cli/install.ps1 | iex", ()),
    "grok": ("irm https://x.ai/cli/install.ps1 | iex", ()),
    "kimi": ("irm https://code.kimi.com/kimi-code/install.ps1 | iex", ()),
    "opencode": ("npm install -g opencode-ai", ("npm",)),
    "copilot": ("winget install GitHub.Copilot", ("winget",)),
    "cursor": ("irm 'https://cursor.com/install?win32=true' | iex", ()),
    "aider": ('powershell -ExecutionPolicy ByPass -c "irm https://aider.chat/install.ps1 | iex"', ()),
    "droid": ("irm https://app.factory.ai/cli/windows | iex", ()),
    "muse": ("irm https://dev.meta.ai/install.ps1 | iex", ()),
}


@pytest.mark.parametrize("dep_id", sorted(WIN32))
def test_win32_install_is_the_vendors_windows_command(dep_id: str) -> None:
    command, requires = WIN32[dep_id]
    install = DEPS_BY_ID[dep_id].install_for("win32")
    assert install.command == command
    assert install.requires_binaries == requires
    assert install.needs_terminal  # all interactive, as on the other platforms


@pytest.mark.parametrize("dep_id", sorted(WIN32))
def test_win32_override_leaves_macos_and_linux_alone(dep_id: str) -> None:
    dep = DEPS_BY_ID[dep_id]
    # Copilot and Droid install from a macOS-only cask, so Linux links their docs instead.
    linux = {"linux"} if dep_id in {"copilot", "droid"} else set()
    assert set(dep.install_cmds) == {"win32"} | linux
    assert dep.install_for("darwin").command == dep.install_cmd


def test_no_win32_install_is_a_posix_pipe_or_bare_curl() -> None:
    for dep in DEPS:
        if not dep.applies_to("win32"):
            continue
        install = dep.install_for("win32")
        assert not re.search(r"\|\s*(ba)?sh\b", install.command), dep.id
        # Bare `curl` is Invoke-WebRequest in PowerShell 5.1; curl.exe is not.
        assert not re.search(r"(^|[\s;|&])curl(\s|$)", install.command), dep.id
        assert "curl" not in install.requires_binaries, dep.id
        assert "brew" not in install.requires_binaries, dep.id

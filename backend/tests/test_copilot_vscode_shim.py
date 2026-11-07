"""VS Code's `copilot` stand-in is not the GitHub Copilot CLI.

VS Code installs `<VS Code>\\bin\\copilot-shim\\copilot.exe` and puts its bin
dir on PATH. Navide took it for the Copilot CLI: after installing VS Code on a
Windows VM, the CLI health check reported "GitHub Copilot CLI — Startup probe
failed" with that file as the active binary (0.2.37 VM re-verify).
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from agent_team_backend import app, onboarding_deps, osplat
from agent_team_backend.cli_vendors.registry import VENDORS

COPILOT = VENDORS["copilot"].install_dep
SHIM = r"C:\Users\navide\AppData\Local\Programs\Microsoft VS Code\bin\copilot-shim\copilot.exe"


@pytest.fixture(autouse=True)
def _clear_identity_cache():
    onboarding_deps._IDENTITY_CACHE.clear()
    yield
    onboarding_deps._IDENTITY_CACHE.clear()


def _only_shim_on_path(monkeypatch) -> None:
    monkeypatch.setattr(
        osplat.paths, "resolve_program",
        lambda name, path=None: SHIM if name == "copilot" else None,
    )
    monkeypatch.setattr(onboarding_deps, "_distinct_executables", lambda command: (
        [{"path": SHIM, "resolved_path": SHIM, "aliases": [SHIM]}] if command == "copilot" else []
    ))


def _no_subprocess(monkeypatch) -> None:
    def fail(argv, **kwargs):
        raise AssertionError(f"the shim must not be run: {argv}")

    monkeypatch.setattr(onboarding_deps.subprocess, "run", fail)


def test_shim_is_recognised_by_its_directory() -> None:
    assert onboarding_deps.is_shim(COPILOT, SHIM)
    assert onboarding_deps.is_shim(COPILOT, "/usr/share/code/bin/Copilot-Shim/copilot")
    assert not onboarding_deps.is_shim(
        COPILOT, r"C:\Users\navide\AppData\Local\Microsoft\WinGet\Links\copilot.exe"
    )
    assert not onboarding_deps.is_shim(COPILOT, "/opt/homebrew/bin/copilot")
    # Only copilot declares the stand-in.
    assert not onboarding_deps.is_shim(VENDORS["claude"].install_dep, SHIM)


def test_shim_alone_reads_as_missing(monkeypatch) -> None:
    _only_shim_on_path(monkeypatch)
    _no_subprocess(monkeypatch)

    assert onboarding_deps.resolve_executable(COPILOT) == ""
    detected = onboarding_deps.detect_dep(COPILOT)
    assert detected["status"] == "missing"
    assert detected["binary_path"] == ""


def test_real_cli_after_the_shim_on_path_is_found(monkeypatch, tmp_path: Path) -> None:
    real = str(tmp_path / "WinGet" / "Links" / "copilot.exe")
    monkeypatch.setattr(
        osplat.paths, "resolve_program",
        lambda name, path=None: SHIM if name == "copilot" else None,
    )
    monkeypatch.setattr(onboarding_deps, "_distinct_executables", lambda command: [
        {"path": SHIM, "resolved_path": SHIM, "aliases": [SHIM]},
        {"path": real, "resolved_path": real, "aliases": [real]},
    ])

    assert onboarding_deps.resolve_executable(COPILOT) == real


def test_health_check_reports_no_copilot_for_the_shim(monkeypatch) -> None:
    _only_shim_on_path(monkeypatch)
    _no_subprocess(monkeypatch)
    status = onboarding_deps.detect_dep(COPILOT)

    health = onboarding_deps.build_cli_health([status])

    assert [e["agent_key"] for e in health["entries"]] == []
    assert [f for f in health["findings"] if f.get("agent_key") == "copilot"] == []


def test_spawn_probe_does_not_run_the_shim(monkeypatch) -> None:
    _only_shim_on_path(monkeypatch)
    probed: list[list[str]] = []

    def fake_probe(command):
        probed.append(list(command))
        return subprocess.CompletedProcess(command, 1, "", "")

    monkeypatch.setattr(app, "_run_spawn_probe", fake_probe)

    try:
        result = app._probe_agent_cli_for_spawn("copilot", "copilot")
    except app.AgentCliProbeError as error:
        result = error.details
    assert probed == []
    assert result["reason"] == "not_found"
    assert result["binary_path"] == ""


def test_spawn_command_uses_the_real_cli_behind_the_shim(monkeypatch, tmp_path: Path) -> None:
    """PATH has the shim first and a real Copilot CLI later: the pane's shell
    would run the bare `copilot` as the shim, so the command names the real
    CLI's absolute path instead."""
    real = str(tmp_path / "WinGet" / "Links" / "copilot")
    monkeypatch.setattr(
        osplat.paths, "resolve_program",
        lambda name, path=None: SHIM if name == "copilot" else None,
    )
    monkeypatch.setattr(onboarding_deps, "_distinct_executables", lambda command: [
        {"path": SHIM, "resolved_path": SHIM, "aliases": [SHIM]},
        {"path": real, "resolved_path": real, "aliases": [real]},
    ])
    command = ["/bin/zsh", "-ilc", "copilot --resume abc"]

    assert app._command_with_installed_cli_alias("copilot", command) == [
        "/bin/zsh", "-ilc", f"{real} --resume abc",
    ]


def test_spawn_command_untouched_without_the_shim(monkeypatch) -> None:
    real = "/opt/homebrew/bin/copilot"
    monkeypatch.setattr(
        osplat.paths, "resolve_program",
        lambda name, path=None: real if name == "copilot" else None,
    )
    command = ["/bin/zsh", "-ilc", "copilot --resume abc"]

    assert app._command_with_installed_cli_alias("copilot", command) == command

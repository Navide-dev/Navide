"""Version drift: a CLI newer than the version Navide last verified it at.

The startup probe already parses ``--version``. When that version is higher
than the vendor's ``verified_version``, the probe result carries an
``untested_version`` line that the pane prints. Disclosure only: the spawn is
never blocked and nothing else in the result changes.
"""
from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from agent_team_backend import app, onboarding_deps
from agent_team_backend.cli_vendors.registry import VENDORS


def _probe(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, key: str, stdout: str) -> dict:
    binary = tmp_path / key
    binary.write_text("#!/bin/sh\n")
    monkeypatch.setattr(app.osplat.paths, "resolve_program", lambda _name, *, path=None: str(binary))
    monkeypatch.setattr(
        app, "_run_spawn_probe", lambda _command: SimpleNamespace(returncode=0, stdout=stdout, stderr="")
    )
    result = app._probe_agent_cli_for_spawn(key)
    assert result is not None
    return result


def _bump(version: str) -> str:
    # 2026.08.25-3e8eec8 -> 2026.08.26 ; 2.1.278 -> 2.1.279
    head = version.split("-", 1)[0].split(".")
    head[-1] = str(int(head[-1]) + 1).zfill(len(head[-1]))
    return ".".join(head)


def _printed(key: str, version: str) -> str:
    # What each vendor's own --version looks like where the bare number
    # would not parse (grok must also pass its official_regex).
    return {"grok": f"grok {version} (1474f9cbdd91)"}.get(key, version) + "\n"


_VERIFIED = [
    (spec.key, spec.account_switch.verified_version)
    for spec in VENDORS.values()
    if spec.account_switch is not None and spec.account_switch.verified_version
]


def test_every_vendor_has_a_verified_version() -> None:
    assert len(_VERIFIED) == len(VENDORS) == 15


@pytest.mark.parametrize(("key", "verified"), _VERIFIED)
def test_a_newer_version_is_disclosed_as_untested(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, key: str, verified: str
) -> None:
    newer = _bump(verified)
    result = _probe(monkeypatch, tmp_path, key, _printed(key, newer))

    assert result["version"] == newer
    note = result["untested_version"]
    assert newer in note and verified.split("-", 1)[0] in note
    assert "not been tested" in note
    assert "warning" not in result  # disclosure, not a warning about the binary


@pytest.mark.parametrize(("key", "verified"), _VERIFIED)
def test_the_verified_version_is_quiet(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, key: str, verified: str
) -> None:
    printed = verified.split("-", 1)[0]
    result = _probe(monkeypatch, tmp_path, key, _printed(key, printed))

    assert result["version"] == printed
    assert "untested_version" not in result


def test_an_older_version_is_quiet(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    result = _probe(monkeypatch, tmp_path, "claude", "2.1.100 (Claude Code)\n")

    assert "untested_version" not in result


def test_no_parsed_version_is_quiet(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    result = _probe(monkeypatch, tmp_path, "claude", "Claude Code\n")

    assert "untested_version" not in result


def test_a_third_party_grok_gets_the_identity_warning_only(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # Its version says nothing about Grok Build, so no drift line on top.
    result = _probe(monkeypatch, tmp_path, "grok", "9.9.9\n")

    assert "Grok Build" in result["warning"]
    assert "untested_version" not in result


def test_drift_never_blocks_the_spawn(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    # A nonzero exit that still printed a newer version is accepted as before.
    binary = tmp_path / "claude"
    binary.write_text("#!/bin/sh\n")
    monkeypatch.setattr(app.osplat.paths, "resolve_program", lambda _name, *, path=None: str(binary))
    monkeypatch.setattr(
        app, "_run_spawn_probe", lambda _command: SimpleNamespace(returncode=1, stdout="99.0.0\n", stderr="")
    )

    result = app._probe_agent_cli_for_spawn("claude")

    assert result is not None and result["exit_code"] == 1
    assert "99.0.0" in result["untested_version"]


def test_every_vendor_is_an_agent_cli_dep() -> None:
    # The probe looks the dep up by the vendor key; a rename would silently
    # drop that vendor out of the drift check.
    for key, _ in _VERIFIED:
        dep = onboarding_deps.DEPS_BY_ID[key]
        assert dep.group == "agent_cli"

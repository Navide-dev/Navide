"""Account dirs on a Windows box that cannot create symlinks (no Developer
Mode, not elevated: ``WinError 1314``). The shared ``projects`` store used to
be drained into the real home and then left unlinked, so every ``claude
--resume`` of a pinned pane answered "No conversation found". Junctions need no
privilege; when no link can be made at all, nothing is moved. Tmp homes and
fake session ids only."""

from __future__ import annotations

import errno
import os
from pathlib import Path

import pytest

from agent_team_backend import credential_vault as cv
from agent_team_backend.credential_vault import CredentialVault
from tests.test_credential_vault import FakeSecurity

SID = "00000000-0000-4000-8000-000000000001"
PROJECT = "C--Users-Robert-Desktop-Robert-Dev"


def _vault(tmp_path: Path, platform: str) -> CredentialVault:
    return CredentialVault(
        root=tmp_path / "root",
        real_home=tmp_path / "home",
        security_runner=FakeSecurity(),
        platform=platform,
    )


def _no_symlinks(monkeypatch: pytest.MonkeyPatch, vault: CredentialVault) -> None:
    def refuse(self, *_a, **_k):
        raise OSError(errno.EPERM, "A required privilege is not held by the client")

    monkeypatch.setattr(vault, "_symlinks_available", lambda: False)
    monkeypatch.setattr(Path, "symlink_to", refuse)


def _fake_junctions(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str]]:
    """Stand in for _winapi.CreateJunction with a plain os.symlink (which
    the patched Path.symlink_to does not block)."""
    made: list[tuple[str, str]] = []

    def junction(target: Path, link: Path) -> None:
        made.append((os.fspath(target), os.fspath(link)))
        os.symlink(target, link, target_is_directory=True)

    monkeypatch.setattr(cv, "_create_junction", junction)
    return made


def _write_transcript(projects: Path) -> Path:
    path = projects / PROJECT / f"{SID}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{}\n", encoding="utf-8")
    return path


def _real(tmp_path: Path) -> Path:
    real = tmp_path / "home" / ".claude"
    (real / "projects").mkdir(parents=True)
    (real / "settings.json").write_text("{}", encoding="utf-8")
    return real


def test_windows_without_symlinks_links_projects_with_a_junction(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    vault = _vault(tmp_path, "win32")
    _no_symlinks(monkeypatch, vault)
    made = _fake_junctions(monkeypatch)
    real = _real(tmp_path)
    directory = vault.prepare_account_dir("p1")
    assert (directory / "projects").resolve() == (real / "projects").resolve()
    assert [link for _t, link in made] == [os.fspath(directory / "projects")]
    # A file cannot be a junction: settings.json stays as it was, unlinked.
    assert not (directory / "settings.json").exists()


def test_resume_survives_a_second_spawn_without_symlinks(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The field failure: the transcript a pinned pane wrote must still be
    visible from its config dir on the next spawn (its --resume)."""
    vault = _vault(tmp_path, "win32")
    _no_symlinks(monkeypatch, vault)
    _fake_junctions(monkeypatch)
    _real(tmp_path)
    directory = vault.prepare_account_dir("p1")
    _write_transcript(directory / "projects")
    directory = vault.prepare_account_dir("p1")
    assert (directory / "projects" / PROJECT / f"{SID}.jsonl").is_file()


def test_a_real_projects_dir_is_merged_then_junctioned(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A dir left by an earlier build that could not link is drained into the
    real home only because a junction can then take its place."""
    vault = _vault(tmp_path, "win32")
    _no_symlinks(monkeypatch, vault)
    _fake_junctions(monkeypatch)
    real = _real(tmp_path)
    directory = vault.account_dir_path("p1")
    _write_transcript(directory / "projects")
    vault.prepare_account_dir("p1")
    assert (real / "projects" / PROJECT / f"{SID}.jsonl").is_file()
    assert (directory / "projects" / PROJECT / f"{SID}.jsonl").is_file()


def test_no_link_possible_leaves_the_sessions_where_they_are(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Neither a symlink nor a junction: never drain the store into the real
    home, or the CLI on this config dir loses every session (WinError 1314)."""
    vault = _vault(tmp_path, "win32")
    _no_symlinks(monkeypatch, vault)

    def junction_fails(target: Path, link: Path) -> None:
        raise OSError(errno.EINVAL, "junctions unsupported on this volume")

    monkeypatch.setattr(cv, "_create_junction", junction_fails)
    real = _real(tmp_path)
    directory = vault.account_dir_path("p1")
    transcript = _write_transcript(directory / "projects")
    vault.prepare_account_dir("p1")
    assert transcript.is_file()
    assert not (real / "projects" / PROJECT).exists()


def test_no_link_method_at_all_moves_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Off Windows there is no junction to fall back on: a store that cannot
    be linked stays in place."""
    vault = _vault(tmp_path, "linux")
    _no_symlinks(monkeypatch, vault)
    real = _real(tmp_path)
    directory = vault.account_dir_path("p1")
    transcript = _write_transcript(directory / "projects")
    vault.prepare_account_dir("p1")
    assert transcript.is_file()
    assert not (real / "projects" / PROJECT).exists()


def test_account_dir_unshared_names_the_entries_left_unlinked(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    vault = _vault(tmp_path, "win32")
    _no_symlinks(monkeypatch, vault)
    _fake_junctions(monkeypatch)
    _real(tmp_path)
    vault.prepare_account_dir("p1")
    assert vault.account_dir_unshared("p1") == ["settings.json"]


def test_account_dir_unshared_is_empty_when_symlinks_work(tmp_path: Path) -> None:
    vault = _vault(tmp_path, "darwin")
    _real(tmp_path)
    vault.prepare_account_dir("p1")
    assert vault.account_dir_unshared("p1") == []

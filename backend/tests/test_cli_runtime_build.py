"""The build helper the runtime tests share (``cli_runtime_build.py``): what a
developer sees when cargo cannot build the runtime, and which Rust homes it uses."""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from tests import cli_runtime_build

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="the runtime is not built on Windows")


def test_a_failed_build_says_what_it_needs_and_how_to_skip(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    failing_cargo = tmp_path / "cargo"
    failing_cargo.write_text("#!/bin/sh\necho 'rustc is too old' >&2\nexit 1\n", encoding="utf-8")
    failing_cargo.chmod(0o755)
    monkeypatch.delenv(cli_runtime_build.REQUIRED_ENV, raising=False)
    monkeypatch.setattr(cli_runtime_build.shutil, "which", lambda _name: str(failing_cargo))

    with pytest.raises(pytest.fail.Exception) as failed:
        cli_runtime_build.cargo("build")

    message = str(failed.value)
    assert "rustc is too old" in message
    assert f"{cli_runtime_build.REQUIRED_ENV}=0" in message and "skips" in message
    assert "rust-version" in message and cli_runtime_build._rust_version() in message


def test_the_crate_declares_the_oldest_rust_it_builds_with() -> None:
    assert cli_runtime_build._rust_version().replace(".", "").isdigit()


def test_cargo_keeps_its_crates_in_the_accounts_home_not_the_throwaway_one(
        tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import pwd

    account = tmp_path / "account"
    account.mkdir()  # no .cargo, no .rustup
    monkeypatch.setattr(pwd, "getpwuid", lambda _uid: SimpleNamespace(pw_dir=str(account)))
    monkeypatch.delenv("CARGO_HOME", raising=False)
    monkeypatch.delenv("RUSTUP_HOME", raising=False)

    env = cli_runtime_build._toolchain_env()
    assert env["CARGO_HOME"] == str(account / ".cargo")
    assert "RUSTUP_HOME" not in env, "no rustup here, so no toolchain home to name"

    (account / ".rustup").mkdir()
    assert cli_runtime_build._toolchain_env()["RUSTUP_HOME"] == str(account / ".rustup")

    monkeypatch.setenv("CARGO_HOME", "/somewhere/else")
    assert cli_runtime_build._toolchain_env()["CARGO_HOME"] == "/somewhere/else", "the environment wins"

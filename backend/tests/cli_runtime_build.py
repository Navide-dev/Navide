"""The Rust CLI runtime, built from this checkout's source, for the tests that run it.

A binary that was built earlier proves nothing about the source beside it, so
no test runs one: ``binary()`` has cargo bring the release build up to date
first (the build ``cli_runtime.binary()`` finds in a checkout). With nothing
changed that takes well under a second.

Whether a run builds it is decided by where cargo is expected:

* ``NAVIDE_CLI_RUNTIME_REQUIRED=1`` (CI's ``cli-runtime`` job): it must build.
  No cargo, or a build that fails, fails the test.
* ``NAVIDE_CLI_RUNTIME_REQUIRED=0`` (CI's backend jobs, which compile no
  Rust): the tests skip. The ``cli-runtime`` job is where they run.
* Unset (a developer's machine): built when cargo is on ``PATH``, and a build
  that fails fails the test. Without cargo (the isolated runner,
  ``scripts/isolated-pytest.sh``, starts from an empty environment) the tests
  that drive ``serve`` use the release build only when it is newer than every
  source of the crate, and skip otherwise; nothing older than the source runs.
* Windows: skipped. The runtime is not built or shipped there (it has no file
  identity or PTY off Unix, so it observes nothing).
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

CRATE = Path(__file__).resolve().parents[2] / "native" / "navide-cli-runtime"
REQUIRED_ENV = "NAVIDE_CLI_RUNTIME_REQUIRED"

_built: Path | None = None


def cargo(*args: str, timeout: float = 1500.0) -> "subprocess.CompletedProcess[str]":
    """``cargo <args>`` on the crate, or the skip / failure this run calls for."""
    expected = os.environ.get(REQUIRED_ENV)
    if sys.platform == "win32":
        pytest.skip("navide-cli-runtime is not built on Windows")
    if expected == "0":
        pytest.skip(f"this run does not build navide-cli-runtime ({REQUIRED_ENV}=0)")
    exe = shutil.which("cargo")
    if exe is None:
        if expected == "1":
            pytest.fail(f"cargo was not found, and {REQUIRED_ENV}=1")
        pytest.skip("cargo is not installed: navide-cli-runtime cannot be built from source")
    done = subprocess.run([exe, args[0], "--locked", "--manifest-path", str(CRATE / "Cargo.toml"), *args[1:]],
                          capture_output=True, text=True, encoding="utf-8", timeout=timeout, env=_toolchain_env())
    if done.returncode != 0:
        pytest.fail(
            f"cargo {args[0]} failed for navide-cli-runtime (it needs Rust {_rust_version()} or newer, "
            f"Cargo.toml's rust-version; {REQUIRED_ENV}=0 skips the tests that need the runtime):\n"
            f"{done.stderr[-4000:]}"
        )
    return done


def _rust_version() -> str:
    for line in (CRATE / "Cargo.toml").read_text(encoding="utf-8").splitlines():
        if line.startswith("rust-version"):
            return line.split("=", 1)[1].strip().strip('"')
    return "(no rust-version declared)"


def _toolchain_env() -> dict[str, str]:
    """This process's environment, with the Rust homes of the account running it.

    The suite's conftest points ``HOME`` at an empty directory. A cargo that
    rustup manages looks for its toolchains under ``$HOME/.rustup`` and finds
    none there: it fails ("rustup could not choose a version of cargo to
    run") or, with ``RUSTUP_TOOLCHAIN`` set, installs that toolchain into the
    empty directory. Cargo would fetch every crate again into
    ``$HOME/.cargo`` too. Both homes are
    named from the account's own home, which the password database still
    knows, unless the environment already names them. ``.rustup`` is named
    only where it exists (no rustup, no toolchain home); ``.cargo`` always,
    since that is where any cargo keeps its crates by default, so a cargo that
    is not rustup's, on an account that has no ``.cargo`` yet, still fills the
    account's cache and not the suite's throwaway home on every run.
    """
    import pwd  # Unix only, as this helper is past the Windows skip

    env = dict(os.environ)
    home = Path(pwd.getpwuid(os.getuid()).pw_dir)
    env.setdefault("CARGO_HOME", str(home / ".cargo"))
    if "RUSTUP_HOME" not in env and (home / ".rustup").is_dir():
        env["RUSTUP_HOME"] = str(home / ".rustup")
    return env


def _newer_than_the_source(exe: Path) -> bool:
    sources = [CRATE / "Cargo.toml", CRATE / "Cargo.lock", CRATE / "build.rs", *(CRATE / "src").rglob("*.rs")]
    return exe.is_file() and exe.stat().st_mtime > max(source.stat().st_mtime for source in sources)


def binary() -> Path:
    """The release build, up to date with the source (settled once per process)."""
    global _built
    if _built is None:
        exe = CRATE / "target" / "release" / "navide-cli-runtime"
        unasked = sys.platform != "win32" and os.environ.get(REQUIRED_ENV) is None
        if unasked and shutil.which("cargo") is None and _newer_than_the_source(exe):
            _built = exe  # no cargo here to ask, and no source is newer than it
        else:
            cargo("build", "--release")
            assert exe.is_file(), f"cargo built no {exe}"
            _built = exe
    return _built

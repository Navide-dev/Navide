"""Tests for _refresh_path_from_login_shell() in onboarding_deps."""

from __future__ import annotations

import os
import shutil
import sys
from unittest.mock import patch, MagicMock
import subprocess

import pytest

# Import the private function directly for unit testing
from pathlib import Path

from agent_team_backend import osplat
from agent_team_backend import onboarding_deps
from agent_team_backend.osplat import _darwin, _linux, _posix_paths, _windows
from agent_team_backend.onboarding_deps import (
    _path_probe_command,
    _refresh_path_from_login_shell,
    get_status,
)


# ── helpers ──────────────────────────────────────────────────────────────────

# The login-shell probe is a POSIX seam: osplat answers None on Windows by
# design (PATH comes from the registry), so the refresh is a no-op there.
_needs_login_shell_probe = pytest.mark.skipif(
    osplat.paths.login_path_probe() is None,
    reason="login-shell PATH probe is None on this platform (Windows) by design",
)


@pytest.fixture(autouse=True)
def _reset_path_probe_cache(monkeypatch):
    """Each test assumes its call actually probes — clear the TTL cache.

    Both halves of it: which TTL applies depends on whether the last probe
    answered, so a test that leaves that flag set would shorten or lengthen
    the next one's cache window.
    """
    monkeypatch.setattr(onboarding_deps, "_path_refreshed_at", None)
    monkeypatch.setattr(onboarding_deps, "_path_probe_answered", False)


@pytest.fixture(autouse=True)
def _no_tail_by_default(monkeypatch):
    """The tail list is this machine's real ~/.nvm on macOS; appended to PATH it
    would leak into every exact-PATH assertion here. Tests of the tail set it.

    Patched on the consumer, not on `osplat.paths`: on macOS that object IS
    `_darwin.paths`, so stubbing it would also stub the implementation the tail
    tests below call directly."""
    monkeypatch.setattr(onboarding_deps, "_tail_path_dirs", lambda: [])


MARKER = osplat.spec.LOGIN_PATH_MARKER


def _make_run_result(stdout: str, returncode: int = 0) -> MagicMock:
    result = MagicMock()
    result.stdout = stdout
    result.returncode = returncode
    return result


def _probe_output(path: str, *chatter: str) -> str:
    """What the marker probe prints: rc-file chatter, then the marked PATH."""
    return "".join(f"{line}\n" for line in chatter) + f"{MARKER}{path}\n"


def _no_fallbacks(monkeypatch) -> None:
    monkeypatch.setattr(osplat.paths, "login_path_fallbacks", lambda home: [])


def _fallbacks(monkeypatch, *dirs) -> None:
    monkeypatch.setattr(osplat.paths, "login_path_fallbacks", lambda home: list(dirs))


# ── merge order ──────────────────────────────────────────────────────────────


@_needs_login_shell_probe
def test_new_paths_prepended(monkeypatch):
    """Paths returned by the shell that are absent from PATH should be prepended."""
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    shell_path = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
    with patch("subprocess.run", return_value=_make_run_result(_probe_output(shell_path))):
        _refresh_path_from_login_shell()
    parts = os.environ["PATH"].split(os.pathsep)
    assert parts[0] == "/opt/homebrew/bin"
    assert parts[1] == "/usr/local/bin"
    # original paths preserved after new ones
    assert "/usr/bin" in parts
    assert "/bin" in parts


@_needs_login_shell_probe
def test_existing_paths_not_duplicated(monkeypatch):
    """Paths already in PATH must not appear twice after refresh.

    Gated like its siblings: on Windows there is no login shell to probe, the
    refresh returns before touching PATH, and this test used to pass there
    only because its ":"-joined fixture was split on ":" — asserting "no
    duplicates" on a PATH the function never touched. Splitting on
    os.pathsep (";" there) made that visible."""
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    shell_path = "/usr/bin:/bin"
    with patch("subprocess.run", return_value=_make_run_result(_probe_output(shell_path))):
        _refresh_path_from_login_shell()
    parts = os.environ["PATH"].split(os.pathsep)
    assert parts.count("/usr/bin") == 1
    assert parts.count("/bin") == 1


@_needs_login_shell_probe
def test_login_shell_order_wins_for_entries_already_on_path(monkeypatch):
    """The wizard tells a user whose `python3` is the old /usr/bin one to fix
    their shell's PATH order and re-detect. Entries already on PATH used to
    keep their inherited position, so /usr/bin stayed ahead of Homebrew and the
    re-detect could never see the fix — only a new terminal would."""
    _no_fallbacks(monkeypatch)
    monkeypatch.setenv("PATH", "/usr/bin:/bin:/opt/homebrew/bin")
    shell_path = "/opt/homebrew/bin:/usr/bin:/bin"
    with patch("subprocess.run", return_value=_make_run_result(_probe_output(shell_path))):
        _refresh_path_from_login_shell()
    assert os.environ["PATH"].split(os.pathsep) == ["/opt/homebrew/bin", "/usr/bin", "/bin"]


@_needs_login_shell_probe
def test_entries_only_the_process_has_follow_the_login_shell_ones(monkeypatch):
    """Nothing the process PATH carries is dropped; it just no longer outranks
    what the user's own terminal would resolve first."""
    _no_fallbacks(monkeypatch)
    monkeypatch.setenv("PATH", "/app/only:/usr/bin")
    shell_path = "/opt/homebrew/bin:/usr/bin"
    with patch("subprocess.run", return_value=_make_run_result(_probe_output(shell_path))):
        _refresh_path_from_login_shell()
    assert os.environ["PATH"].split(os.pathsep) == ["/opt/homebrew/bin", "/usr/bin", "/app/only"]


@_needs_login_shell_probe
def test_unanswered_probe_keeps_the_inherited_order(monkeypatch, tmp_path):
    """Without an answer there is no order to prefer: fallbacks are guesses, so
    they are only added, never allowed to reorder what is already there."""
    _fallbacks(monkeypatch, str(tmp_path))
    monkeypatch.setenv("PATH", f"/usr/bin:{tmp_path}")
    with patch("subprocess.run", side_effect=subprocess.TimeoutExpired("zsh", 3)):
        _refresh_path_from_login_shell()
    assert os.environ["PATH"].split(os.pathsep) == ["/usr/bin", str(tmp_path)]


# ── dedup ─────────────────────────────────────────────────────────────────────


@_needs_login_shell_probe
def test_dedup_within_shell_output(monkeypatch):
    """Even if shell output contains duplicates, only first occurrence is added."""
    monkeypatch.setenv("PATH", "/usr/bin")
    shell_path = "/new/path:/new/path:/usr/bin"
    with patch("subprocess.run", return_value=_make_run_result(_probe_output(shell_path))):
        _refresh_path_from_login_shell()
    parts = os.environ["PATH"].split(os.pathsep)
    assert parts.count("/new/path") == 1


# ── timeout / garbage tolerance ───────────────────────────────────────────────


def test_timeout_swallowed(monkeypatch):
    """TimeoutExpired must not propagate; PATH unchanged (fallback disabled)."""
    _no_fallbacks(monkeypatch)
    original = "/usr/bin:/bin"
    monkeypatch.setenv("PATH", original)
    with patch("subprocess.run", side_effect=subprocess.TimeoutExpired(cmd="bash", timeout=3)):
        _refresh_path_from_login_shell()
    assert os.environ["PATH"] == original


def test_oserror_swallowed(monkeypatch):
    """OSError (e.g. bash not found) must not propagate."""
    _no_fallbacks(monkeypatch)
    original = "/usr/bin:/bin"
    monkeypatch.setenv("PATH", original)
    with patch("subprocess.run", side_effect=OSError("not found")):
        _refresh_path_from_login_shell()
    assert os.environ["PATH"] == original


def test_unmarked_output_adds_nothing(monkeypatch):
    """Output with no marked line is chatter, not a PATH: nothing is merged."""
    _no_fallbacks(monkeypatch)
    monkeypatch.setenv("PATH", "/usr/bin")
    with patch("subprocess.run", return_value=_make_run_result("some banner text\n/looks/like/a/path\n")):
        _refresh_path_from_login_shell()
    assert os.environ["PATH"] == "/usr/bin"


def test_empty_stdout_no_crash(monkeypatch):
    """Empty stdout must not crash."""
    _no_fallbacks(monkeypatch)
    original = "/usr/bin"
    monkeypatch.setenv("PATH", original)
    with patch("subprocess.run", return_value=_make_run_result("")):
        _refresh_path_from_login_shell()
    assert os.environ["PATH"] == original


# ── fallback install prefixes ────────────────────────────────────────────────


@_needs_login_shell_probe
def test_fallback_dirs_merged_when_probe_fails(monkeypatch, tmp_path):
    """Standard install prefixes are merged even when the login-shell probe fails."""
    fallback = tmp_path / "brew-bin"
    fallback.mkdir()
    _fallbacks(monkeypatch, str(fallback))
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    with patch("subprocess.run", side_effect=subprocess.TimeoutExpired(cmd="zsh", timeout=3)):
        _refresh_path_from_login_shell()
    assert os.environ["PATH"].split(os.pathsep)[0] == str(fallback)


def test_fallback_dir_skipped_when_missing(monkeypatch, tmp_path):
    """A fallback prefix that does not exist on disk is not added."""
    _fallbacks(monkeypatch, str(tmp_path / "nope"))
    original = "/usr/bin:/bin"
    monkeypatch.setenv("PATH", original)
    with patch("subprocess.run", side_effect=OSError("not found")):
        _refresh_path_from_login_shell()
    assert os.environ["PATH"] == original


@_needs_login_shell_probe
def test_shell_paths_ordered_before_fallback(monkeypatch, tmp_path):
    """Shell-derived paths are prepended ahead of fallback prefixes."""
    fallback = tmp_path / "fb"
    fallback.mkdir()
    _fallbacks(monkeypatch, str(fallback))
    monkeypatch.setenv("PATH", "/usr/bin")
    with patch("subprocess.run", return_value=_make_run_result(_probe_output("/shell/bin:/usr/bin"))):
        _refresh_path_from_login_shell()
    parts = os.environ["PATH"].split(os.pathsep)
    # Every entry the shell answered keeps the shell's order; a guessed
    # fallback goes after them, never between them.
    assert parts == ["/shell/bin", "/usr/bin", str(fallback)]


@_needs_login_shell_probe
def test_marked_line_used_whatever_the_rc_files_print(monkeypatch):
    """The marked line is the PATH even when chatter comes before AND after
    it — an interactive bash on Linux prints its motd last, which is exactly
    what taking "the last non-empty line" used to merge into PATH."""
    _no_fallbacks(monkeypatch)
    monkeypatch.setenv("PATH", "/usr/bin")
    output = _probe_output("/opt/homebrew/bin:/usr/bin", "Welcome to zsh!") + "motd: 3 updates\n"
    with patch("subprocess.run", return_value=_make_run_result(output)):
        _refresh_path_from_login_shell()
    assert os.environ["PATH"].split(os.pathsep) == ["/opt/homebrew/bin", "/usr/bin"]


# ── probe command shape ───────────────────────────────────────────────────────


SCRIPT = _posix_paths.LOGIN_PATH_PROBE_SCRIPT


@_needs_login_shell_probe
def test_probe_uses_interactive_zsh(monkeypatch):
    """zsh reads ~/.zshrc only in interactive mode; installers (e.g. grok)
    write PATH exports there, so the probe must run zsh with -i."""
    monkeypatch.setenv("SHELL", "/bin/zsh")
    assert _path_probe_command() == ["/bin/zsh", "-ilc", SCRIPT]


def test_linux_probes_bash_interactively(monkeypatch):
    """The stock Debian/Ubuntu ~/.bashrc — where nvm, bun and npm-global put
    their PATH exports — returns at its first line unless the shell is
    interactive, so `bash -lc` sees ~/.profile and nothing else."""
    monkeypatch.setenv("SHELL", "/bin/bash")
    assert _linux.paths.login_path_probe() == ["/bin/bash", "-ilc", SCRIPT]


def test_macos_keeps_a_plain_login_bash(monkeypatch):
    monkeypatch.setenv("SHELL", "/bin/bash")
    assert _darwin.paths.login_path_probe() == ["/bin/bash", "-lc", SCRIPT]


def test_other_shells_get_a_plain_login_shell_everywhere(monkeypatch):
    monkeypatch.setenv("SHELL", "/usr/bin/fish")
    assert _linux.paths.login_path_probe() == ["/usr/bin/fish", "-lc", SCRIPT]
    assert _darwin.paths.login_path_probe() == ["/usr/bin/fish", "-lc", SCRIPT]


@_needs_login_shell_probe
def test_probe_falls_back_to_bash_without_shell_env(monkeypatch):
    monkeypatch.delenv("SHELL", raising=False)
    assert _path_probe_command()[0] == "/bin/bash"
    assert _path_probe_command()[-1] == SCRIPT


@_needs_login_shell_probe
def test_probe_script_marks_the_path_line():
    """The script prints the marker and PATH on ONE line, so the parser can
    pick it out of whatever the rc files printed around it."""
    proc = subprocess.run(osplat.paths.shell_command(SCRIPT), capture_output=True, text=True,
                          env={"PATH": "/a:/b"}, timeout=5)
    assert proc.stdout == f"{MARKER}/a:/b\n"


# ── fallback lists per platform ──────────────────────────────────────────────


def test_linux_fallbacks_name_the_node_manager_and_toolchain_dirs(tmp_path):
    """A .desktop-launched app on Linux gets the session PATH, which has none
    of these; nvm's per-version bins come newest first."""
    for v in ("v18.20.4", "v22.11.0", "v20.19.0"):
        (tmp_path / ".nvm" / "versions" / "node" / v / "bin").mkdir(parents=True)
    dirs = _linux.paths.login_path_fallbacks(tmp_path)
    assert dirs == [
        str(tmp_path / ".local" / "bin"),
        str(tmp_path / ".local" / "share" / "pnpm"),
        str(tmp_path / ".npm-global" / "bin"),
        str(tmp_path / ".cargo" / "bin"),
        str(tmp_path / ".bun" / "bin"),
        str(tmp_path / ".nvm" / "versions" / "node" / "v22.11.0" / "bin"),
        str(tmp_path / ".nvm" / "versions" / "node" / "v20.19.0" / "bin"),
        str(tmp_path / ".nvm" / "versions" / "node" / "v18.20.4" / "bin"),
        "/usr/local/bin",
        "/snap/bin",
    ]


def test_linux_fallbacks_without_nvm(tmp_path):
    dirs = _linux.paths.login_path_fallbacks(tmp_path)
    assert not any(".nvm" in d for d in dirs)
    assert "/snap/bin" in dirs


def _exe(directory, *names):
    """Executables named `names` in `directory` (created), so PATH resolves them."""
    directory.mkdir(parents=True, exist_ok=True)
    for name in names:
        f = directory / name
        f.write_text("#!/bin/sh\n")
        f.chmod(0o755)
    return directory


def test_macos_fallbacks_name_the_node_manager_dirs_too(tmp_path):
    """`npm install -g` (codex, qwen, kilo) lands under a version manager, not
    under a Homebrew prefix. nvm's per-version bins are on disk here and still
    absent: they belong to the tail list, never to this prepended one."""
    for v in ("v18.20.4", "v22.11.0"):
        (tmp_path / ".nvm" / "versions" / "node" / v / "bin").mkdir(parents=True)
    assert _darwin.paths.login_path_fallbacks(tmp_path) == [
        str(tmp_path / ".local" / "bin"),
        str(tmp_path / "Library" / "pnpm"),
        str(tmp_path / ".npm-global" / "bin"),
        str(tmp_path / ".volta" / "bin"),
        str(tmp_path / ".bun" / "bin"),
        "/usr/local/bin",
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
    ]


def test_macos_fallbacks_without_nvm(tmp_path):
    dirs = _darwin.paths.login_path_fallbacks(tmp_path)
    assert not any(".nvm" in d for d in dirs)
    assert dirs[0] == str(tmp_path / ".local" / "bin")


def test_macos_tail_is_the_nvm_bins_newest_first(tmp_path):
    for v in ("v18.20.4", "v22.11.0", "v20.19.0"):
        (tmp_path / ".nvm" / "versions" / "node" / v / "bin").mkdir(parents=True)
    assert _darwin.paths.login_path_tail_fallbacks(tmp_path) == [
        str(tmp_path / ".nvm" / "versions" / "node" / v / "bin")
        for v in ("v22.11.0", "v20.19.0", "v18.20.4")
    ]


def test_linux_has_no_tail(tmp_path):
    """Linux keeps nvm in its prepended list, as before. (Windows' tail is the
    registry PATH plus npm's global dir — see the Windows section below.)"""
    (tmp_path / ".nvm" / "versions" / "node" / "v22.11.0" / "bin").mkdir(parents=True)
    assert _linux.paths.login_path_tail_fallbacks(tmp_path) == []


# The merge itself, on the macOS lists, with a disk laid out per case. Mirror
# system directories into the fixture: a real Homebrew CLI must not shadow a
# fake nvm CLI just because the developer happens to have it installed.
# Skipped where there is no login-shell merge or extensionless executable.


def _merge_as_macos(monkeypatch, home, login_path, *, probe_ok=True):
    def isolated(path):
        source = Path(path)
        if source.is_relative_to(home):
            return path
        target = home / "system" / source.relative_to(source.anchor)
        target.mkdir(parents=True, exist_ok=True)
        return str(target)

    login_path = os.pathsep.join(isolated(path) for path in login_path.split(os.pathsep))
    monkeypatch.setattr(onboarding_deps, "_fallback_path_dirs",
                        lambda: [isolated(path) for path in _darwin.paths.login_path_fallbacks(home)])
    monkeypatch.setattr(onboarding_deps, "_tail_path_dirs",
                        lambda: _darwin.paths.login_path_tail_fallbacks(home))
    monkeypatch.setenv("PATH", login_path)
    if probe_ok:
        with patch("subprocess.run", return_value=_make_run_result(_probe_output(login_path))):
            _refresh_path_from_login_shell()
    else:
        with patch("subprocess.run", side_effect=subprocess.TimeoutExpired("zsh", 3)):
            _refresh_path_from_login_shell()
    return os.environ["PATH"]


_SYSTEM = "/usr/local/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/bin:/bin"


@_needs_login_shell_probe
def test_merge_keeps_the_nvm_version_the_user_chose(tmp_path, monkeypatch):
    nvm = tmp_path / ".nvm" / "versions" / "node"
    _exe(nvm / "v22.11.0" / "bin", "node")
    v20 = _exe(nvm / "v20.19.0" / "bin", "node")
    merged = _merge_as_macos(monkeypatch, tmp_path, f"{v20}:{_SYSTEM}")
    assert shutil.which("node", path=merged) == str(v20 / "node")


@_needs_login_shell_probe
def test_merge_keeps_homebrew_node_over_a_leftover_nvm(tmp_path, monkeypatch):
    _exe(tmp_path / ".nvm" / "versions" / "node" / "v22.11.0" / "bin", "node")
    brew = _exe(tmp_path / "brew", "node")
    merged = _merge_as_macos(monkeypatch, tmp_path, f"{brew}:{_SYSTEM}")
    assert shutil.which("node", path=merged) == str(brew / "node")


@_needs_login_shell_probe
def test_merge_finds_a_cli_only_a_lazily_loaded_nvm_provides(tmp_path, monkeypatch):
    """zsh-nvm lazy load plus a Homebrew node hands the backend exactly the PATH
    the leftover case above does — no nvm bin on it. Guarding on "PATH resolves
    a node" lost codex here; appending keeps it and still keeps Homebrew first."""
    nvm_bin = _exe(tmp_path / ".nvm" / "versions" / "node" / "v22.11.0" / "bin", "node", "codex")
    brew = _exe(tmp_path / "brew", "node")
    merged = _merge_as_macos(monkeypatch, tmp_path, f"{brew}:{_SYSTEM}")
    assert shutil.which("codex", path=merged) == str(nvm_bin / "codex")
    assert shutil.which("node", path=merged) == str(brew / "node")


@_needs_login_shell_probe
def test_merge_finds_an_nvm_cli_when_the_probe_times_out(tmp_path, monkeypatch):
    """The customer's case: a heavy ~/.zshrc times the probe out, leaving the
    launchd PATH. codex lives only under nvm."""
    nvm_bin = _exe(tmp_path / ".nvm" / "versions" / "node" / "v22.11.0" / "bin", "node", "codex")
    merged = _merge_as_macos(monkeypatch, tmp_path, "/usr/bin:/bin:/usr/sbin:/sbin", probe_ok=False)
    assert shutil.which("codex", path=merged) == str(nvm_bin / "codex")


def test_windows_has_no_fallbacks(tmp_path):
    assert _windows.paths.login_path_fallbacks(tmp_path) == []


def test_refresh_asks_the_platform_for_its_fallbacks(monkeypatch, tmp_path):
    """The merge goes through the seam, not a module-level tuple."""
    fallback = tmp_path / "platform-bin"
    fallback.mkdir()
    seen: list = []

    def fallbacks(home):
        seen.append(home)
        return [str(fallback)]

    monkeypatch.setattr(osplat.paths, "login_path_fallbacks", fallbacks)
    monkeypatch.setattr(osplat.paths, "login_path_probe", lambda: ["/bin/sh", "-c", "true"])
    monkeypatch.setenv("PATH", "/usr/bin")
    with patch("subprocess.run", return_value=_make_run_result("")):
        _refresh_path_from_login_shell()
    assert seen == [Path.home()]
    assert os.environ["PATH"].split(os.pathsep)[0] == str(fallback)


# ── non-POSIX no-op ───────────────────────────────────────────────────────────


def test_non_posix_noop(monkeypatch):
    """On non-POSIX platforms the function should be a no-op (no subprocess call)."""
    original = "/usr/bin"
    monkeypatch.setenv("PATH", original)
    # No login shell to ask: what the Windows paths implementation answers.
    monkeypatch.setattr(osplat.paths, "login_path_probe", lambda: None)
    with patch("subprocess.run") as mock_run:
        _refresh_path_from_login_shell()
    mock_run.assert_not_called()
    assert os.environ["PATH"] == original


# ── detection missing → ok after refresh ─────────────────────────────────────


@_needs_login_shell_probe
def test_detection_missing_to_ok_after_refresh(monkeypatch, tmp_path):
    """
    Simulate a tool that is absent from the original PATH but present in the
    login-shell PATH. After refresh, detect_dep should find it as 'ok'.
    """
    from agent_team_backend.onboarding_deps import detect_dep, Dep

    # Create a fake 'mytool' binary that prints a version string
    fake_bin = tmp_path / "mytool"
    fake_bin.write_text("#!/bin/sh\necho 'mytool 1.2.3'\n")
    fake_bin.chmod(0o755)

    dep = Dep(
        id="mytool",
        label="My Tool",
        description="test tool",
        group="foundation",
        check_cmd=["mytool", "--version"],
        version_regex=r"(\d+\.\d+\.\d+)",
    )

    # Before refresh: tmp_path is not in PATH, so tool is missing
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    assert shutil.which("mytool") is None
    result_before = detect_dep(dep)
    assert result_before["status"] == "missing"

    # Simulate login shell returning a PATH that includes tmp_path
    shell_path_output = _probe_output(f"{tmp_path}:/usr/bin:/bin")
    with patch("subprocess.run", return_value=_make_run_result(shell_path_output)):
        _refresh_path_from_login_shell()

    # After refresh: tmp_path is now in os.environ["PATH"]
    assert str(tmp_path) in os.environ["PATH"].split(os.pathsep)

    # detect_dep uses shutil.which which reads os.environ["PATH"]
    assert shutil.which("mytool") is not None

    # Now we need subprocess.run to actually run the real binary for detect_dep
    # Restore subprocess.run to real implementation
    result_after = detect_dep(dep)
    assert result_after["status"] == "ok"
    assert result_after["version"] == "1.2.3"


# ── negative caching: a failed probe must not be remembered as a good one ─────


@_needs_login_shell_probe
def test_a_timed_out_probe_is_retried_sooner_than_a_successful_one(monkeypatch):
    """The timestamp used to be stamped BEFORE the probe ran, so a timeout was
    cached exactly like a success and detection spent the next five minutes on
    a PATH the probe had contributed nothing to."""
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    _no_fallbacks(monkeypatch)

    with patch("subprocess.run", side_effect=subprocess.TimeoutExpired(cmd="zsh", timeout=15)):
        _refresh_path_from_login_shell()

    assert onboarding_deps._path_refreshed_at is not None
    assert onboarding_deps._path_probe_answered is False

    # Still inside the retry window: no second probe.
    monkeypatch.setattr(onboarding_deps, "_path_refreshed_at", onboarding_deps.time.monotonic())
    with patch("subprocess.run", side_effect=AssertionError("probed inside the retry TTL")):
        _refresh_path_from_login_shell()

    # Past the retry window but well inside the success window: probes again,
    # which is the whole point — a success would still be cached here.
    assert onboarding_deps._PATH_RETRY_TTL_S < onboarding_deps._PATH_REFRESH_TTL_S
    monkeypatch.setattr(
        onboarding_deps,
        "_path_refreshed_at",
        onboarding_deps.time.monotonic() - onboarding_deps._PATH_RETRY_TTL_S - 1,
    )
    with patch("subprocess.run", return_value=_make_run_result(_probe_output("/opt/x:/usr/bin:/bin"))):
        _refresh_path_from_login_shell()
    assert "/opt/x" in os.environ["PATH"].split(os.pathsep)
    assert onboarding_deps._path_probe_answered is True


@_needs_login_shell_probe
def test_a_successful_probe_holds_for_the_full_ttl(monkeypatch):
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    _no_fallbacks(monkeypatch)

    with patch("subprocess.run", return_value=_make_run_result(_probe_output("/opt/y:/usr/bin:/bin"))):
        _refresh_path_from_login_shell()
    assert onboarding_deps._path_probe_answered is True

    # Past the retry TTL, inside the success TTL: a success is NOT re-probed.
    monkeypatch.setattr(
        onboarding_deps,
        "_path_refreshed_at",
        onboarding_deps.time.monotonic() - onboarding_deps._PATH_RETRY_TTL_S - 1,
    )
    with patch("subprocess.run", side_effect=AssertionError("re-probed a cached success")):
        _refresh_path_from_login_shell()


@_needs_login_shell_probe
def test_an_empty_answer_counts_as_no_answer(monkeypatch):
    """A shell that printed no marked line told us nothing about PATH, even
    though it exited fine — that is a fallback-list run, not a known PATH."""
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    _no_fallbacks(monkeypatch)

    with patch("subprocess.run", return_value=_make_run_result("some rc banner\n")):
        _refresh_path_from_login_shell()

    assert onboarding_deps._path_probe_answered is False


def _probe_timeout_used(monkeypatch, **call_kwargs) -> float:
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    _no_fallbacks(monkeypatch)
    seen: dict[str, object] = {}

    def capture(*args, **kwargs):
        seen.update(kwargs)
        return _make_run_result(_probe_output("/usr/bin:/bin"))

    with patch("subprocess.run", side_effect=capture):
        _refresh_path_from_login_shell(**call_kwargs)
    return float(seen["timeout"])


@_needs_login_shell_probe
def test_the_probe_ceiling_is_per_caller_not_global(monkeypatch):
    """One global ceiling cannot satisfy every caller's budget.

    A heavy ~/.zshrc needs more than the 3s this once allowed, but the passive
    status pass rides a 10s wsClient deadline and the pre-spawn refresh sits
    inside a 30s terminal.create budget that already promises 25s to the
    credential switch lock. So the ceiling belongs to the caller.
    """
    monkeypatch.setattr(onboarding_deps, "_path_refreshed_at", None)
    assert _probe_timeout_used(monkeypatch) == onboarding_deps._PATH_PROBE_TIMEOUT_S

    monkeypatch.setattr(onboarding_deps, "_path_refreshed_at", None)
    forced = _probe_timeout_used(monkeypatch, force=True)
    assert forced == onboarding_deps._PATH_PROBE_TIMEOUT_FORCED_S

    monkeypatch.setattr(onboarding_deps, "_path_refreshed_at", None)
    spawn = _probe_timeout_used(monkeypatch, timeout_s=onboarding_deps._PATH_PROBE_TIMEOUT_SPAWN_S)
    assert spawn == onboarding_deps._PATH_PROBE_TIMEOUT_SPAWN_S


def test_the_probe_ceilings_respect_the_deadlines_around_them():
    """Guards the three numbers against being "tidied" back into one.

    Passive must clear the wsClient default (10s) that onboarding.status rides
    on when no explicit timeout is passed; pre-spawn plus the switch lock's 25s
    must stay under the frontend's 30s terminal.create timeout; forced is the
    only one the user is actively waiting on, and App.vue gives it 45s.
    """
    assert onboarding_deps._PATH_PROBE_TIMEOUT_S < 10.0
    assert onboarding_deps._PATH_PROBE_TIMEOUT_SPAWN_S + 25.0 < 30.0
    assert (
        onboarding_deps._PATH_PROBE_TIMEOUT_SPAWN_S
        < onboarding_deps._PATH_PROBE_TIMEOUT_S
        < onboarding_deps._PATH_PROBE_TIMEOUT_FORCED_S
    )
    # Still generous enough to reach a shell measured at 6.9s here.
    assert onboarding_deps._PATH_PROBE_TIMEOUT_S > 6.9


def test_a_relative_npm_prefix_is_refused(tmp_path, monkeypatch):
    """A relative PATH entry resolves against the CHILD's cwd, which for a CLI
    pane is the user's workspace — a repo shipping its own `<prefix>/bin/node`
    would outrank the real one for everything Navide spawns."""
    monkeypatch.chdir(tmp_path)
    (tmp_path / "relbin" / "bin").mkdir(parents=True)
    (tmp_path / ".npmrc").write_text("prefix=relbin\n", encoding="utf-8")
    monkeypatch.delenv("npm_config_prefix", raising=False)
    assert _posix_paths.npm_prefix_bins(tmp_path) == []


# ── npm prefix: read the setting instead of guessing directory names ──────────


@pytest.fixture(autouse=True)
def _no_inherited_npm_prefix(monkeypatch):
    """Start every test in this module from a machine with no npm_config_prefix.

    Autouse, so it covers the whole file rather than the group it sits in; no
    test here wants an inherited one.

    npm_prefix_bins reads that variable before the rc file — correctly, since
    npm itself does — so a machine that exports it makes every rc-file case
    resolve somewhere else and return []. The GitHub Windows runner is such a
    machine: `Backend checks (Windows)` failed on main at f6e31785 with these
    five tests and nothing else, and exporting any npm_config_prefix locally
    reproduces exactly that set. The two tests that are about the variable set
    it themselves and are unaffected.
    """
    monkeypatch.delenv("npm_config_prefix", raising=False)


def test_npm_prefix_bins_reads_the_configured_prefix(tmp_path):
    """One report had `prefix=~/.npm`, so codex landed in ~/.npm/bin while the
    fallback list knew only ~/.npm-global/bin."""
    (tmp_path / ".npmrc").write_text("prefix=~/.npm\n", encoding="utf-8")
    expected = tmp_path / ".npm" / "bin"
    expected.mkdir(parents=True)
    with patch.object(Path, "expanduser", lambda self: Path(str(self).replace("~", str(tmp_path), 1))):
        assert _posix_paths.npm_prefix_bins(tmp_path) == [str(expected)]


def test_npm_prefix_bins_takes_an_absolute_prefix_as_written(tmp_path):
    prefix = tmp_path / "elsewhere"
    (prefix / "bin").mkdir(parents=True)
    (tmp_path / ".npmrc").write_text(f"prefix={prefix}\n", encoding="utf-8")
    assert _posix_paths.npm_prefix_bins(tmp_path) == [str(prefix / "bin")]


def test_npm_prefix_bins_ignores_a_prefix_whose_bin_does_not_exist(tmp_path):
    (tmp_path / ".npmrc").write_text(f"prefix={tmp_path / 'ghost'}\n", encoding="utf-8")
    assert _posix_paths.npm_prefix_bins(tmp_path) == []


def test_npm_prefix_bins_is_empty_without_an_npmrc(tmp_path):
    assert _posix_paths.npm_prefix_bins(tmp_path) == []


def test_npm_prefix_bins_ignores_comments_and_other_keys(tmp_path):
    prefix = tmp_path / "real"
    (prefix / "bin").mkdir(parents=True)
    (tmp_path / ".npmrc").write_text(
        "; prefix=/commented/out\n"
        "# prefix=/also/not/this\n"
        "registry=https://registry.npmjs.org/\n"
        "prefix-is-not-prefix=/nope\n"
        f"prefix={prefix}\n",
        encoding="utf-8",
    )
    assert _posix_paths.npm_prefix_bins(tmp_path) == [str(prefix / "bin")]


def test_npm_prefix_bins_lets_the_last_prefix_win(tmp_path):
    """npm's own ini parser does, so a stale earlier line must not win here."""
    winner = tmp_path / "second"
    (winner / "bin").mkdir(parents=True)
    (tmp_path / "first" / "bin").mkdir(parents=True)
    (tmp_path / ".npmrc").write_text(
        f"prefix={tmp_path / 'first'}\nprefix={winner}\n", encoding="utf-8"
    )
    assert _posix_paths.npm_prefix_bins(tmp_path) == [str(winner / "bin")]


def test_npm_prefix_bins_prefers_the_environment_variable(tmp_path, monkeypatch):
    """npm_config_prefix outranks the rc file for npm, so it does here too."""
    env_prefix = tmp_path / "from-env"
    (env_prefix / "bin").mkdir(parents=True)
    (tmp_path / "from-rc" / "bin").mkdir(parents=True)
    (tmp_path / ".npmrc").write_text(f"prefix={tmp_path / 'from-rc'}\n", encoding="utf-8")
    monkeypatch.setenv("npm_config_prefix", str(env_prefix))
    assert _posix_paths.npm_prefix_bins(tmp_path) == [str(env_prefix / "bin")]


def test_npm_prefix_bins_expands_a_variable_in_the_prefix(tmp_path, monkeypatch):
    prefix = tmp_path / "expanded"
    (prefix / "bin").mkdir(parents=True)
    monkeypatch.setenv("NPM_TEST_ROOT", str(tmp_path))
    (tmp_path / ".npmrc").write_text("prefix=${NPM_TEST_ROOT}/expanded\n", encoding="utf-8")
    assert _posix_paths.npm_prefix_bins(tmp_path) == [str(prefix / "bin")]


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX fallback lists only")
def test_the_configured_npm_prefix_reaches_the_platform_fallback_list(tmp_path, monkeypatch):
    """The unit above is only useful if the list actually calls it."""
    prefix = tmp_path / "npm-somewhere"
    (prefix / "bin").mkdir(parents=True)
    monkeypatch.setenv("npm_config_prefix", str(prefix))
    impl = _darwin.paths if sys.platform == "darwin" else _linux.paths
    assert str(prefix / "bin") in impl.login_path_fallbacks(tmp_path)


# ── Windows: no login shell, so the registry and npm say where a CLI landed ──
#
# 11-03 report: the guided install ran `npm install -g @openai/codex` (exit 0)
# and detection still read "missing". The backend keeps the PATH Explorer gave
# Navide at launch, and with no login shell to probe the refresh returned
# before merging anything — so a dir an installer added to the registry PATH,
# or npm's global dir, stayed invisible until Navide restarted.


class _FakeWinreg:
    """The slice of `winreg` the registry read uses."""

    HKEY_LOCAL_MACHINE = "HKLM"
    HKEY_CURRENT_USER = "HKCU"

    def __init__(self, values, env):
        self._values = values
        self._env = env

    def OpenKey(self, root, subkey):  # noqa: N802 — winreg's own name
        if (root, subkey) not in self._values:
            raise OSError(2, "not found")
        return (root, subkey)

    def QueryValueEx(self, key, name):  # noqa: N802
        if name != "Path":
            raise OSError(2, "not found")
        return self._values[key], 2

    def CloseKey(self, key):  # noqa: N802
        pass

    def ExpandEnvironmentStrings(self, value):  # noqa: N802
        for var, sub in self._env.items():
            value = value.replace(f"%{var}%", sub)
        return value


def test_windows_registry_path_reads_machine_then_user_expanded(monkeypatch):
    fake = _FakeWinreg(
        {
            ("HKLM", _windows._MACHINE_ENV_KEY): r"C:\Windows\system32;C:\Program Files\nodejs\;",
            ("HKCU", _windows._USER_ENV_KEY): r"%USERPROFILE%\AppData\Roaming\npm",
        },
        {"USERPROFILE": r"C:\Users\amy"},
    )
    monkeypatch.setitem(sys.modules, "winreg", fake)
    assert _windows._registry_path_entries() == [
        r"C:\Windows\system32",
        "C:\\Program Files\\nodejs\\",
        r"C:\Users\amy\AppData\Roaming\npm",
    ]


def test_windows_registry_path_survives_a_missing_key(monkeypatch):
    fake = _FakeWinreg({("HKCU", _windows._USER_ENV_KEY): r"C:\tools"}, {})
    monkeypatch.setitem(sys.modules, "winreg", fake)
    assert _windows._registry_path_entries() == [r"C:\tools"]


def test_windows_tail_is_the_registry_path_then_npm_global_dir(tmp_path, monkeypatch):
    roaming = tmp_path / "Roaming"
    monkeypatch.setenv("APPDATA", str(roaming))
    monkeypatch.delenv("npm_config_prefix", raising=False)
    monkeypatch.setattr(_windows, "_registry_path_entries", lambda: [r"C:\nvm4w\nodejs"])
    assert _windows.paths.login_path_tail_fallbacks(tmp_path) == [
        r"C:\nvm4w\nodejs",
        str(roaming / "npm"),
    ]


def test_windows_tail_includes_a_configured_npm_prefix(tmp_path, monkeypatch):
    """On Windows npm puts its shims in the prefix itself, not `<prefix>/bin`."""
    monkeypatch.setenv("APPDATA", str(tmp_path / "Roaming"))
    monkeypatch.setattr(_windows, "_registry_path_entries", lambda: [])
    prefix = tmp_path / "npm-global"
    (tmp_path / ".npmrc").write_text(f"prefix={prefix}\n", encoding="utf-8")
    monkeypatch.delenv("npm_config_prefix", raising=False)
    assert str(prefix) in _windows.paths.login_path_tail_fallbacks(tmp_path)


def _windows_cli(directory, name):
    directory.mkdir(parents=True, exist_ok=True)
    shim = directory / f"{name}.cmd"
    shim.write_text("@ECHO off\r\n")
    shim.chmod(0o755)  # shutil.which on a POSIX test host wants the bit
    return shim


def test_windows_refresh_finds_a_cli_npm_installed_after_launch(tmp_path, monkeypatch):
    """The reported case, end to end through the refresh the install triggers."""
    npm_dir = tmp_path / "Roaming" / "npm"
    shim = _windows_cli(npm_dir, "codex")
    stale = tmp_path / "System32"
    stale.mkdir()
    monkeypatch.setenv("PATH", str(stale))
    monkeypatch.setenv("PATHEXT", ".COM;.EXE;.BAT;.CMD")
    monkeypatch.setattr(osplat.paths, "login_path_probe", lambda: None)
    monkeypatch.setattr(onboarding_deps, "_tail_path_dirs", lambda: [str(npm_dir)])
    with patch("subprocess.run", side_effect=OSError("no npm here")):
        _refresh_path_from_login_shell(force=True)
    assert os.environ["PATH"].split(os.pathsep) == [str(stale), str(npm_dir)]
    assert _windows.paths.resolve_program("codex", path=os.environ["PATH"]) == str(shim)


def test_windows_refresh_appends_and_never_duplicates(tmp_path, monkeypatch):
    """Appended, so nothing the inherited PATH resolves first is displaced; a
    dir already there in another case is the same dir on NTFS."""
    have = tmp_path / "Have"
    have.mkdir()
    new = tmp_path / "New"
    new.mkdir()
    monkeypatch.setenv("PATH", str(have))
    monkeypatch.setattr(osplat.paths, "login_path_probe", lambda: None)
    monkeypatch.setattr(onboarding_deps.os.path, "normcase", lambda p: p.lower())
    monkeypatch.setattr(onboarding_deps, "_tail_path_dirs",
                        lambda: [str(have).upper(), str(new), str(new), str(tmp_path / "gone")])
    with patch("subprocess.run") as mock_run:
        _refresh_path_from_login_shell()
    mock_run.assert_not_called()  # an unforced read stays subprocess-free
    assert os.environ["PATH"].split(os.pathsep) == [str(have), str(new)]


def test_forced_refresh_asks_npm_for_its_global_prefix_on_windows(tmp_path, monkeypatch):
    """`npm prefix -g` covers what no guess can: a prefix set in npm's builtin
    or global npmrc, and fnm's per-shell node dirs."""
    prefix = tmp_path / "fnm" / "node-versions" / "v22" / "installation"
    _windows_cli(prefix, "codex")
    monkeypatch.setenv("PATH", str(tmp_path))
    monkeypatch.setattr(osplat.paths, "login_path_probe", lambda: None)
    monkeypatch.setattr(osplat.paths, "resolve_program",
                        lambda name, path=None: r"C:\nodejs\npm.cmd" if name == "npm" else None)
    monkeypatch.setattr(osplat.paths, "launch_argv", lambda program, args=(): [program, *args])
    with patch("subprocess.run", return_value=_make_run_result(f"{prefix}\n")) as mock_run:
        _refresh_path_from_login_shell(force=True)
    assert mock_run.call_args.args[0] == [r"C:\nodejs\npm.cmd", "prefix", "-g"]
    assert os.environ["PATH"].split(os.pathsep)[-1] == str(prefix)


def test_a_failed_or_relative_npm_prefix_adds_nothing(tmp_path, monkeypatch):
    monkeypatch.setenv("PATH", str(tmp_path))
    monkeypatch.setattr(osplat.paths, "login_path_probe", lambda: None)
    monkeypatch.setattr(osplat.paths, "resolve_program",
                        lambda name, path=None: "npm" if name == "npm" else None)
    for result in (_make_run_result("relative\\dir\n"), _make_run_result("", returncode=1)):
        with patch("subprocess.run", return_value=result):
            _refresh_path_from_login_shell(force=True)
        assert os.environ["PATH"] == str(tmp_path)


def _codepage_run(stdout: bytes):
    """A `subprocess.run` that decodes the way Windows does: with the ANSI
    code page (cp950 on zh-TW) unless the caller names an encoding."""
    def run(argv, **kwargs):
        out = stdout.decode(kwargs.get("encoding") or "cp950", kwargs.get("errors") or "strict")
        return subprocess.CompletedProcess(argv, 0, stdout=out, stderr="")
    return run


def _npm_on_path(monkeypatch):
    monkeypatch.setattr(osplat.paths, "resolve_program",
                        lambda name, path=None: "npm" if name == "npm" else None)
    monkeypatch.setattr(osplat.paths, "launch_argv", lambda program, args=(): [program, *args])


def test_npm_prefix_under_a_chinese_user_name_is_read_as_utf8(tmp_path, monkeypatch):
    """npm prints UTF-8; read with the zh-TW code page, `C:\\Users\\王小明\\...`
    raised UnicodeDecodeError out of get_status(fresh=True) — the re-detect
    right after the guided install."""
    prefix = tmp_path / "王小明" / "AppData" / "Roaming" / "npm"
    _npm_on_path(monkeypatch)
    with patch("subprocess.run", side_effect=_codepage_run(f"{prefix}\r\n".encode("utf-8"))):
        assert onboarding_deps._npm_global_bin_dirs() == [str(prefix)]


def test_undecodable_npm_prefix_output_adds_nothing(tmp_path, monkeypatch):
    _npm_on_path(monkeypatch)
    with patch("subprocess.run", side_effect=_codepage_run(f"{tmp_path}/\xff".encode("latin-1"))):
        assert onboarding_deps._npm_global_bin_dirs() == []
    decode_error = UnicodeDecodeError("cp950", b"\xe7", 0, 1, "illegal multibyte sequence")
    with patch("subprocess.run", side_effect=decode_error):
        assert onboarding_deps._npm_global_bin_dirs() == []

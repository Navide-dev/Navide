"""The Windows answers to the discovery questions on the osplat Paths contract,
and the inert Windows scheduler. Run on every host: the implementation
module imports everywhere and nothing here touches Win32.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from agent_team_backend.osplat import _posix_paths, _windows
from agent_team_backend.osplat.spec import SchedulerError


@pytest.fixture
def win(monkeypatch: pytest.MonkeyPatch) -> _windows.WindowsDiscoveryLayout:
    monkeypatch.setenv("PATHEXT", ".COM;.EXE;.BAT;.CMD")
    return _windows.WindowsDiscoveryLayout()


class TestExecutableCandidates:
    def test_a_bare_name_expands_to_every_pathext_suffix_in_order(self, win) -> None:
        assert win.executable_candidates("claude") == [
            "claude.com", "claude.exe", "claude.bat", "claude.cmd",
        ]

    def test_a_name_that_already_carries_a_suffix_is_kept_as_is(self, win) -> None:
        assert win.executable_candidates("Code.CMD") == ["Code.CMD"]

    def test_pathext_is_split_on_semicolons_even_off_windows(self, win, monkeypatch) -> None:
        monkeypatch.setenv("PATHEXT", ".EXE;.CMD")
        assert win.executable_candidates("uv") == ["uv.exe", "uv.cmd"]

    @pytest.mark.skipif(sys.platform == "win32", reason="exercises the POSIX exec bit on the host; Windows access(X_OK) always answers True")
    def test_posix_asks_for_the_bare_name_and_the_exec_bit(self, tmp_path: Path) -> None:
        assert _posix_paths.executable_candidates("claude") == ["claude"]
        plain = tmp_path / "plain"
        plain.write_text("")
        assert _posix_paths.is_executable(plain) is False
        plain.chmod(0o755)
        assert _posix_paths.is_executable(plain) is True

    def test_windows_runnability_is_the_extension_not_a_mode_bit(self, win, tmp_path) -> None:
        exe = tmp_path / "tool.exe"
        exe.write_bytes(b"")
        assert win.is_executable(exe) is True


class TestOtherDiscoveryAnswers:
    def test_no_login_shell_to_probe(self, win) -> None:
        assert win.login_path_probe() is None
        assert _posix_paths.login_path_probe()[-1] == _posix_paths.LOGIN_PATH_PROBE_SCRIPT

    def test_backend_entry_gains_exe_unless_it_names_a_suffix(self, win) -> None:
        assert win.backend_entry_on_disk("backend/navide-plans") == "backend/navide-plans.exe"
        assert win.backend_entry_on_disk("backend/navide-plans.exe") == "backend/navide-plans.exe"
        assert _posix_paths.backend_entry_on_disk("backend/navide-plans") == "backend/navide-plans"

    def test_ntfs_has_no_posix_modes(self, win) -> None:
        assert win.enforces_posix_modes() is False
        assert _posix_paths.enforces_posix_modes() is True

    def test_shell_command_goes_through_cmd_exe(self, win, monkeypatch) -> None:
        assert win.shell_command("echo hi") == ["cmd.exe", "/d", "/s", "/c", "echo hi"]
        # The POSIX answer on a host that has /bin/sh; a Windows runner has none
        # and would otherwise resolve Git's sh.exe instead.
        real_exists = _posix_paths.os.path.exists
        monkeypatch.setattr(_posix_paths.os.path, "exists", lambda p: p == "/bin/sh" or real_exists(p))
        assert _posix_paths.shell_command("echo hi") == ["/bin/sh", "-c", "echo hi"]

    def test_symlink_probe_is_asked_once_and_cached(self, win, monkeypatch) -> None:
        calls: list[int] = []
        monkeypatch.setattr(_windows, "_symlinks_available", None)
        monkeypatch.setattr(_windows, "_probe_symlinks", lambda: calls.append(1) or False)
        assert win.symlinks_available() is False
        assert win.symlinks_available() is False
        assert calls == [1]


class TestWindowsScheduler:
    async def test_lists_every_kind_as_unsupported_without_spawning(self, monkeypatch) -> None:
        import asyncio

        async def _no_spawn(*args, **kwargs):  # pragma: no cover - must not run
            raise AssertionError("the Windows scheduler must not spawn anything")

        monkeypatch.setattr(asyncio, "create_subprocess_exec", _no_spawn)
        sched = _windows.WindowsScheduler()
        assert await sched.list_jobs("crontab") == {
            "supported": False, "entries": [], "unparsed": 0, "error": None,
        }
        assert (await sched.list_jobs("launchagent"))["supported"] is False

    async def test_mutations_name_the_platform(self) -> None:
        sched = _windows.WindowsScheduler()
        with pytest.raises(SchedulerError, match="Windows"):
            await sched.set_enabled("crontab", "x", True)
        with pytest.raises(SchedulerError, match="Windows"):
            await sched.remove("launchagent", "com.x")
        with pytest.raises(ValueError):
            await sched.list_jobs("systemd")

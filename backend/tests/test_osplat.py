"""The platform seam: selection, the Linux probe, and the no-branching rule.

The Linux implementation is exercised here on whatever machine runs the suite,
because it is pure Python over `/proc` paths — pointing it at a fixture
directory tests the parsing without needing a Linux box. What a Linux box is
still needed for is whether `/proc` really looks like this, which is what the
container smoke test covers.
"""

from __future__ import annotations

import ast
import os
import re
import stat
import sys
from pathlib import Path

import pytest

from agent_team_backend import osplat
from agent_team_backend.osplat import _linux


class TestSelection:
    def test_picks_the_implementation_for_this_platform(self):
        expected = {
            "darwin": "_darwin",
            "linux": "_linux",
            "win32": "_windows",
        }.get(sys.platform, "_linux")
        assert osplat.impl_name == expected

    def test_exposes_a_probe_that_satisfies_the_contract(self):
        probe = osplat.resource_probe
        assert isinstance(probe.available(), bool)
        assert isinstance(probe.sample([]), dict)
        assert isinstance(probe.memory_kind(), str)

    # An unknown POSIX is far closer to Linux than to nothing, and each seam
    # degrades to unavailable on its own if the guess turns out wrong.
    def test_unknown_platforms_fall_back_to_linux(self):
        assert "freebsd" not in {"darwin", "win32"}
        assert osplat.impl_name in {"_darwin", "_linux", "_windows"}


class TestDarwinDelegation:
    """macOS must keep running exactly the code it ran before the extraction."""

    @pytest.mark.skipif(sys.platform != "darwin", reason="darwin-only seam")
    def test_delegates_to_proc_rusage(self, monkeypatch):
        from agent_team_backend import proc_rusage

        monkeypatch.setattr(proc_rusage, "available", lambda: True)
        monkeypatch.setattr(proc_rusage, "sample", lambda pids: {7: (11, 2.0)})
        assert osplat.resource_probe.available() is True
        assert osplat.resource_probe.sample([7]) == {7: (11, 2.0)}

    @pytest.mark.skipif(sys.platform != "darwin", reason="darwin-only seam")
    def test_reports_the_counter_it_actually_reads(self):
        assert osplat.resource_probe.memory_kind() == "phys_footprint"


def _fake_proc(root: Path, pid: int, *, pss_kb: int | None, comm: str = "claude",
               utime: int = 0, stime: int = 0) -> None:
    """Write the two `/proc/<pid>` files the Linux probe reads."""
    entry = root / str(pid)
    entry.mkdir(parents=True, exist_ok=True)
    if pss_kb is not None:
        (entry / "smaps_rollup").write_text(
            f"55a4a2e00000-7ffd0f5f2000 ---p 00000000 00:00 0 [rollup]\n"
            f"Rss:               99999 kB\n"
            f"Pss:               {pss_kb} kB\n"
            f"Shared_Clean:       1234 kB\n",
            encoding="utf-8",
        )
    # Fields: pid (comm) state ppid ... utime(14) stime(15) ...
    before = f"{pid} ({comm}) S 1 1 1 0 -1 4194304 100 0 0 0"
    after = " ".join(str(v) for v in [utime, stime] + [0] * 30)
    (entry / "stat").write_text(f"{before} {after}\n", encoding="utf-8")


class TestLinuxProbe:
    def test_reads_pss_and_cpu_from_proc(self, tmp_path, monkeypatch):
        _fake_proc(tmp_path, 42, pss_kb=2048, utime=150, stime=50)
        monkeypatch.setattr(_linux, "_PROC", tmp_path)
        monkeypatch.setattr(_linux, "_PSS_AVAILABLE", True)
        monkeypatch.setattr(_linux, "_CLK_TCK", 100.0)
        assert _linux.resource_probe.sample([42]) == {42: (2048 * 1024, 2.0)}

    # `comm` is unquoted and may contain spaces and parentheses, so the fields
    # after it can only be found by splitting from the last `)`.
    def test_parses_stat_for_a_process_whose_name_has_spaces(self, tmp_path, monkeypatch):
        _fake_proc(tmp_path, 43, pss_kb=1024, comm="my (odd) name", utime=300, stime=0)
        monkeypatch.setattr(_linux, "_PROC", tmp_path)
        monkeypatch.setattr(_linux, "_PSS_AVAILABLE", True)
        monkeypatch.setattr(_linux, "_CLK_TCK", 100.0)
        assert _linux.resource_probe.sample([43]) == {43: (1024 * 1024, 3.0)}

    # Same contract as the Darwin probe: a pid that has died, or that belongs
    # to another user, is absent rather than zero.
    def test_omits_pids_it_cannot_read(self, tmp_path, monkeypatch):
        _fake_proc(tmp_path, 44, pss_kb=512)
        monkeypatch.setattr(_linux, "_PROC", tmp_path)
        monkeypatch.setattr(_linux, "_PSS_AVAILABLE", True)
        sampled = _linux.resource_probe.sample([44, 9999])
        assert set(sampled) == {44}

    def test_ignores_impossible_pids(self, tmp_path, monkeypatch):
        monkeypatch.setattr(_linux, "_PROC", tmp_path)
        monkeypatch.setattr(_linux, "_PSS_AVAILABLE", True)
        assert _linux.resource_probe.sample([0, -1]) == {}

    # A kernel without smaps_rollup reports unavailable rather than falling
    # back to RSS: mixing PSS for some panes and RSS for others would make the
    # column incomparable across rows, which is worse than an empty panel.
    def test_reports_unavailable_without_smaps_rollup(self, tmp_path, monkeypatch):
        monkeypatch.setattr(_linux, "_PROC", tmp_path)
        monkeypatch.setattr(_linux, "_PSS_AVAILABLE", False)
        assert _linux.resource_probe.available() is False
        assert _linux.resource_probe.sample([1]) == {}

    def test_survives_a_truncated_stat_file(self, tmp_path, monkeypatch):
        entry = tmp_path / "45"
        entry.mkdir()
        (entry / "smaps_rollup").write_text("Pss: 64 kB\n", encoding="utf-8")
        (entry / "stat").write_text("45 (x) S\n", encoding="utf-8")
        monkeypatch.setattr(_linux, "_PROC", tmp_path)
        monkeypatch.setattr(_linux, "_PSS_AVAILABLE", True)
        # Memory still counts; CPU it could not parse reads as zero rather
        # than dropping the pid, because the memory figure is the one the
        # panel is gated on.
        assert _linux.resource_probe.sample([45]) == {45: (64 * 1024, 0.0)}

    def test_reports_the_counter_it_actually_reads(self):
        assert _linux.resource_probe.memory_kind() == "pss"


class TestPaths:
    def test_exposes_the_contract(self):
        assert isinstance(osplat.paths.app_support_dir("Cursor"), Path)
        assert isinstance(osplat.paths.cache_dir(), Path)

    # The layout other desktop apps follow on each platform. Getting this wrong
    # is what made the Cursor usage reader macOS-only.
    def test_each_platform_uses_its_own_convention(self, tmp_path):
        from agent_team_backend.osplat import _darwin, _linux, _windows

        assert _darwin.paths.app_support_dir("Cursor", home=tmp_path) == (
            tmp_path / "Library" / "Application Support" / "Cursor"
        )
        assert _linux.paths.app_support_dir("Cursor", home=tmp_path) == (
            tmp_path / ".config" / "Cursor"
        )
        assert _windows.paths.app_support_dir("Cursor", home=tmp_path) == (
            tmp_path / "AppData" / "Roaming" / "Cursor"
        )

    # A per-pane home exists to point a CLI somewhere other than the real user
    # directory; honouring $XDG_CONFIG_HOME there would send it straight back.
    def test_an_explicit_home_beats_the_xdg_environment(self, tmp_path, monkeypatch):
        from agent_team_backend.osplat import _linux

        monkeypatch.setenv("XDG_CONFIG_HOME", "/somewhere/else")
        assert _linux.paths.app_support_dir("Cursor", home=tmp_path) == (
            tmp_path / ".config" / "Cursor"
        )

    def test_linux_honours_xdg_when_no_home_is_named(self, monkeypatch):
        from agent_team_backend.osplat import _linux

        monkeypatch.setenv("XDG_CONFIG_HOME", "/xdg/config")
        monkeypatch.setenv("XDG_CACHE_HOME", "/xdg/cache")
        assert _linux.paths.app_support_dir("Cursor") == Path("/xdg/config/Cursor")
        assert _linux.paths.cache_dir() == Path("/xdg/cache")

    def test_linux_falls_back_to_the_spec_defaults(self, monkeypatch):
        from agent_team_backend.osplat import _linux

        monkeypatch.delenv("XDG_CONFIG_HOME", raising=False)
        monkeypatch.delenv("XDG_CACHE_HOME", raising=False)
        assert _linux.paths.app_support_dir("X") == Path.home() / ".config" / "X"
        assert _linux.paths.cache_dir() == Path.home() / ".cache"

    # The backend's own state dir: `applog` used to decide this itself. Linux
    # is `$XDG_DATA_HOME`, not `~/.config`, because that is where existing
    # installs already keep their sessions.
    def test_state_dir_keeps_each_platforms_existing_location(self, tmp_path, monkeypatch):
        from agent_team_backend.osplat import _darwin, _linux, _windows

        monkeypatch.delenv("XDG_DATA_HOME", raising=False)
        monkeypatch.delenv("APPDATA", raising=False)
        monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
        assert _darwin.paths.state_dir("Agent-Team") == (
            tmp_path / "Library" / "Application Support" / "Agent-Team"
        )
        assert _linux.paths.state_dir("Agent-Team") == (
            tmp_path / ".local" / "share" / "Agent-Team"
        )
        assert _windows.paths.state_dir("Agent-Team") == (
            tmp_path / "AppData" / "Roaming" / "Agent-Team"
        )
        monkeypatch.setenv("XDG_DATA_HOME", "/xdg/data")
        monkeypatch.setenv("APPDATA", "C:/Users/x/AppData/Roaming")
        assert _linux.paths.state_dir("Agent-Team") == Path("/xdg/data/Agent-Team")
        assert _windows.paths.state_dir("Agent-Team") == Path("C:/Users/x/AppData/Roaming/Agent-Team")

    # `os.UserConfigDir()` as Go CLIs see it — what `host_shell` used to branch on.
    def test_config_home_per_platform(self, tmp_path, monkeypatch):
        from agent_team_backend.osplat import _darwin, _linux, _windows

        assert _darwin.paths.config_home(tmp_path) == tmp_path / "Library" / "Application Support"
        assert _linux.paths.config_home(tmp_path) == tmp_path / ".config"
        monkeypatch.delenv("APPDATA", raising=False)
        assert _windows.paths.config_home(tmp_path) == tmp_path / "AppData" / "Roaming"
        assert _windows.paths.roaming_app_data() is None
        monkeypatch.setenv("APPDATA", "C:/roaming")
        assert _windows.paths.config_home(tmp_path) == Path("C:/roaming")
        assert _windows.paths.roaming_app_data() == Path("C:/roaming")
        assert _darwin.paths.roaming_app_data() is None
        assert _linux.paths.roaming_app_data() is None

    # The isolated environment a public CLI run gets: POSIX children read HOME
    # and TMPDIR, Windows children USERPROFILE plus TEMP/TMP (and HOME, which
    # several Node CLIs consult first).
    def test_isolated_home_env_names_each_platforms_variables(self, tmp_path):
        from agent_team_backend.osplat import _darwin, _linux, _windows

        home = str(tmp_path)
        assert _darwin.paths.isolated_home_env(tmp_path) == {"HOME": home, "TMPDIR": home}
        assert _linux.paths.isolated_home_env(tmp_path) == {"HOME": home, "TMPDIR": home}
        assert _windows.paths.isolated_home_env(tmp_path) == {
            "USERPROFILE": home, "HOME": home, "TEMP": home, "TMP": home,
        }
        assert _darwin.paths.home_env_var() == "HOME"
        assert _linux.paths.home_env_var() == "HOME"
        assert _windows.paths.home_env_var() == "USERPROFILE"

    # Folders a chat attachment may never come from (channels/media.py).
    def test_system_dirs_name_each_platforms_own(self, monkeypatch):
        from agent_team_backend.osplat import _darwin, _linux, _windows

        assert Path("/etc") in _darwin.paths.system_dirs() and Path("/System") in _darwin.paths.system_dirs()
        assert Path("/etc") in _linux.paths.system_dirs() and Path("/boot") in _linux.paths.system_dirs()
        home = Path.home()
        for rel in ("Library/Keychains", "Library/Cookies", "Library/Application Support/Google/Chrome",
                    "Library/Safari", "Library/Messages", "Library/Mail"):
            assert home / rel in _darwin.paths.system_dirs(), rel
        assert Path("/var/root") in _darwin.paths.system_dirs()
        for rel in ("Library/Application Support/Slack", "Library/Application Support/discord",
                    "Library/Application Support/Code/User/globalStorage", "Library/Preferences", "snap"):
            assert home / rel in _linux.paths.system_dirs(), rel
        assert Path("/run") in _linux.paths.system_dirs()
        # Credential and browser-profile dot folders: hidden paths are sendable now.
        for rel in (".ssh", ".aws", ".config/gh", ".gnupg", ".kube", ".docker", ".mozilla",
                    ".config/google-chrome", ".local/share/keyrings", ".password-store", ".navide"):
            assert home / rel in _linux.paths.system_dirs(), rel
            assert home / rel in _darwin.paths.system_dirs(), rel
        monkeypatch.setenv("SystemRoot", r"D:\Win")
        monkeypatch.setenv("ProgramData", r"D:\PD")
        monkeypatch.delenv("ProgramFiles", raising=False)
        monkeypatch.setenv("APPDATA", r"D:\Users\me\AppData\Roaming")
        monkeypatch.setenv("LOCALAPPDATA", r"D:\Users\me\AppData\Local")
        found = _windows.paths.system_dirs()
        assert Path(r"D:\Win") in found and Path(r"D:\PD") in found
        assert Path(r"C:\Program Files") in found  # the documented default when unset
        assert Path(r"D:\Users\me\AppData\Roaming") / "Microsoft" / "Credentials" in found
        assert Path(r"D:\Users\me\AppData\Local") / "Google" / "Chrome" / "User Data" in found
        # An overridden variable adds its folder; it never removes the documented default.
        assert Path(r"C:\Windows") in found and Path(r"C:\ProgramData") in found
        assert Path.home() / "AppData" / "Roaming" / "Microsoft" / "Credentials" in found
        for rel in (".ssh", ".aws", ".config/gh", ".docker", ".kube", ".navide", ".codex-panes"):
            assert home.joinpath(*rel.split("/")) in found, rel
        assert Path(r"D:\Users\me\AppData\Roaming") / "GitHub CLI" in found
        assert Path(r"D:\Users\me\AppData\Local") / "Chromium" / "User Data" in found

    # A quoted path reaches a program through the platform's own shell
    # convention: POSIX apostrophes are literal characters to cmd.exe.
    def test_quote_arg_follows_each_platforms_shell(self):
        from agent_team_backend.osplat import _darwin, _linux, _windows

        assert _darwin.paths.quote_arg("/tmp/a b") == "'/tmp/a b'"
        assert _linux.paths.quote_arg("/tmp/a b") == "'/tmp/a b'"
        assert _linux.paths.quote_arg("plain") == "plain"
        assert _windows.paths.quote_arg(r"C:\Users\a b\x.exe") == r'"C:\Users\a b\x.exe"'
        assert _windows.paths.quote_arg("plain") == "plain"


class TestLaunching:
    """Finding a program, and putting in front of it whatever starts it.

    Both implementations run on whichever machine runs the suite: the answer
    is a function of the path's extension, which a Mac can reason about for
    Windows perfectly well — and has to, since npm's `claude.cmd` is the shim
    every Windows install of a coding CLI actually gets.
    """

    def test_posix_starts_every_runnable_file_the_same_way(self):
        from agent_team_backend.osplat import _darwin, _linux

        for paths in (_darwin.paths, _linux.paths):
            assert paths.launch_kind("/usr/local/bin/claude") == "direct"
            # The extension means nothing here: the kernel reads the shebang.
            assert paths.launch_kind("/usr/local/bin/odd.cmd") == "direct"
            assert paths.launch_argv("/bin/git", ["status", "-s"]) == ["/bin/git", "status", "-s"]
            assert paths.launch_argv("/bin/git") == ["/bin/git"]
            assert paths.pty_launch_parts("/bin/zsh", ("-l",)) == ("/bin/zsh", ["-l"])

    def test_windows_names_the_interpreter_the_extension_needs(self):
        from agent_team_backend.osplat import _windows

        paths = _windows.paths
        assert paths.launch_kind(r"C:\npm\claude.CMD") == "cmd"  # the case is not part of it
        assert paths.launch_kind(r"C:\npm\run.bat") == "cmd"
        assert paths.launch_kind(r"C:\tools\setup.ps1") == "powershell"
        assert paths.launch_kind(r"C:\Program Files\Git\git.exe") == "direct"
        assert paths.launch_argv(r"C:\npm\claude.cmd", ["-p", "hi"]) == [
            "cmd.exe", "/d", "/c", r"C:\npm\claude.cmd", "-p", "hi",
        ]
        assert paths.launch_argv(r"C:\tools\setup.ps1") == [
            "powershell.exe", "-NoLogo", "-NonInteractive", "-NoProfile",
            "-ExecutionPolicy", "Bypass", "-File", r"C:\tools\setup.ps1",
        ]
        assert paths.launch_argv(r"C:\Git\git.exe", ["status"]) == [r"C:\Git\git.exe", "status"]

    # `/s` tells cmd to strip the first and last quote of everything after
    # `/c` — the very pair `list2cmdline` puts around a program path with a
    # space in it. The string form still wants it; this one must not have it.
    def test_the_cmd_wrapper_leaves_out_slash_s(self):
        from agent_team_backend.osplat import _windows

        assert _windows.paths.launch_argv(r"C:\a b\claude.cmd") == [
            "cmd.exe", "/d", "/c", r"C:\a b\claude.cmd",
        ]
        assert _windows.paths.shell_command("echo hi") == ["cmd.exe", "/d", "/s", "/c", "echo hi"]

    # ConPTY (winpty-rs) takes the application name and the rest of the line
    # as two arguments, so the terminal backend needs the split, not an argv.
    def test_pty_parts_split_the_launch_argv_for_conpty(self):
        from agent_team_backend.osplat import _windows

        assert _windows.paths.pty_launch_parts(r"C:\npm\claude.cmd", ("--resume",)) == (
            "cmd.exe", ["/d", "/c", r"C:\npm\claude.cmd", "--resume"],
        )
        assert _windows.paths.pty_launch_parts(r"C:\Git\git.exe") == (r"C:\Git\git.exe", [])

    @pytest.mark.skipif(
        sys.platform == "win32",
        reason="the exec bit decides the answer, and NTFS has none",
    )
    def test_posix_resolution_is_the_plain_path_search(self, tmp_path):
        from agent_team_backend.osplat import _darwin, _linux

        tool = tmp_path / "mytool"
        tool.write_text("#!/bin/sh\n")
        tool.chmod(0o755)
        assert _darwin.paths.resolve_program("mytool", path=str(tmp_path)) == str(tool)
        # No PATHEXT here: a name is the whole name.
        assert _darwin.paths.resolve_program("mytool.cmd", path=str(tmp_path)) is None
        assert _linux.paths.resolve_program("absent", path=str(tmp_path)) is None

    def test_windows_resolution_walks_pathext_in_order(self, tmp_path, monkeypatch):
        from agent_team_backend.osplat import _windows

        monkeypatch.setenv("PATHEXT", ".COM;.EXE;.CMD")
        for name in ("claude.cmd", "claude.exe"):
            (tmp_path / name).write_text("")
            (tmp_path / name).chmod(0o755)  # the mode bits this box's which() asks for
        assert _windows.paths.resolve_program("claude", path=str(tmp_path)) == str(
            tmp_path / "claude.exe"
        )
        monkeypatch.setenv("PATHEXT", ".CMD;.EXE")
        assert _windows.paths.resolve_program("claude", path=str(tmp_path)) == str(
            tmp_path / "claude.cmd"
        )
        # An extension already on the name is kept, not extended again.
        assert _windows.paths.resolve_program("claude.cmd", path=str(tmp_path)) == str(
            tmp_path / "claude.cmd"
        )
        assert _windows.paths.resolve_program("absent", path=str(tmp_path)) is None

    # The three command-text splits in `app` moved onto the terminal backend,
    # which is `shlex.split` here and `CommandLineToArgvW` on Windows.
    def test_posix_command_splitting_is_unchanged(self):
        import shlex

        from agent_team_backend.osplat import _posix

        text = "claude -p 'two words' --resume abc"
        # The POSIX backend is the subject; on Windows the host parser is
        # CommandLineToArgvW, which reads the single quotes literally.
        assert _posix.terminal_backend.parse_command(text) == shlex.split(text)

    @pytest.mark.skipif(sys.platform != "win32", reason="CommandLineToArgvW is Windows-only")
    def test_windows_mcp_json_survives_quote_arg_round_trip(self):
        # A Windows agent pane is handed the bare command string (no PowerShell
        # wrapper), and the backend appends `--mcp-config <quote_arg(json)>`
        # before splitting it with CommandLineToArgvW. The JSON — braces, inner
        # quotes, and a URL's `&t=` — must come back out as ONE intact argv
        # token, or the CLI receives a mangled config. This is the round trip
        # that the removed PowerShell wrapper used to break.
        from agent_team_backend.osplat import _windows

        json_payload = '{"mcpServers":{"navide":{"type":"http","url":"http://127.0.0.1:1/p?pane=x&t=y"}}}'
        command = f"claude --dangerously-skip-permissions --mcp-config {_windows.paths.quote_arg(json_payload)}"
        assert _windows.terminal_backend.parse_command(command) == [
            "claude",
            "--dangerously-skip-permissions",
            "--mcp-config",
            json_payload,
        ]


# What the shim generators actually write, verbatim (CRLF as on disk):
# npm's cmd-shim 8.0.0 (bundled with npm 10/11), the cmd-shim 2.x template
# npm 6 shipped, yarn classic's @zkochan/cmd-shim 3.1.0, and pnpm 10's
# @pnpm/cmd-shim — the last one with the NODE_PATH block pnpm adds for a
# hoisted global install and once without it.
_CLI_JS = r"node_modules\@anthropic-ai\claude-code\cli.js"

_NPM_SHIM = (
    "@ECHO off\r\n"
    "GOTO start\r\n"
    ":find_dp0\r\n"
    "SET dp0=%~dp0\r\n"
    "EXIT /b\r\n"
    ":start\r\n"
    "SETLOCAL\r\n"
    "CALL :find_dp0\r\n"
    "\r\n"
    'IF EXIST "%dp0%\\node.exe" (\r\n'
    '  SET "_prog=%dp0%\\node.exe"\r\n'
    ") ELSE (\r\n"
    '  SET "_prog=node"\r\n'
    "  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n"
    ")\r\n"
    "\r\n"
    "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "
    f'"%_prog%"  "%dp0%\\{_CLI_JS}" %*\r\n'
)

_NPM6_SHIM = (
    "@SETLOCAL\r\n"
    "\r\n"
    '@IF EXIST "%~dp0\\node.exe" (\r\n'
    '  @SET "_prog=%~dp0\\node.exe"\r\n'
    ") ELSE (\r\n"
    '  @SET "_prog=node"\r\n'
    "  @SET PATHEXT=%PATHEXT:;.JS;=;%\r\n"
    ")\r\n"
    "\r\n"
    f'"%_prog%"  "%~dp0\\{_CLI_JS}" %*\r\n'
    "@ENDLOCAL\r\n"
)

_YARN_SHIM = (
    '@IF EXIST "%~dp0\\node.exe" (\r\n'
    f'  "%~dp0\\node.exe"  "%~dp0\\{_CLI_JS}" %*\r\n'
    ") ELSE (\r\n"
    "  @SETLOCAL\r\n"
    "  @SET PATHEXT=%PATHEXT:;.JS;=;%\r\n"
    f'  node  "%~dp0\\{_CLI_JS}" %*\r\n'
    ")\r\n"
)

_PNPM_TARGET = r"..\global\5\node_modules\@anthropic-ai\claude-code\cli.js"

_PNPM_SHIM = (
    "@SETLOCAL\r\n"
    '@IF EXIST "%~dp0\\node.exe" (\r\n'
    f'  "%~dp0\\node.exe"  "%~dp0\\{_PNPM_TARGET}" %*\r\n'
    ") ELSE (\r\n"
    "  @SET PATHEXT=%PATHEXT:;.JS;=;%\r\n"
    f'  node  "%~dp0\\{_PNPM_TARGET}" %*\r\n'
    ")\r\n"
)

_PNPM_NODE_PATH_SHIM = (
    "@SETLOCAL\r\n"
    "@IF NOT DEFINED NODE_PATH (\r\n"
    '  @SET "NODE_PATH=C:\\Users\\u\\AppData\\Local\\pnpm\\global\\5\\.pnpm\\node_modules"\r\n'
    ") ELSE (\r\n"
    '  @SET "NODE_PATH=C:\\Users\\u\\AppData\\Local\\pnpm\\global\\5\\.pnpm\\node_modules;%NODE_PATH%"\r\n'
    ")\r\n"
    + _PNPM_SHIM[len("@SETLOCAL\r\n"):]
)


def _write_shim(root: Path, text: str, *, target: str = _CLI_JS, node_beside: bool = False) -> Path:
    """A shim under `root/bin` with its script on disk where `%~dp0\<target>`
    points; the shim-relative target is spelled with backslashes as the
    generators write it, whatever the host."""
    bin_dir = root / "bin"
    bin_dir.mkdir(exist_ok=True)
    script = bin_dir.joinpath(*target.split("\\")).resolve()
    script.parent.mkdir(parents=True, exist_ok=True)
    script.write_text("#!/usr/bin/env node\n")
    if node_beside:
        (bin_dir / "node.exe").write_text("")
    shim = bin_dir / "claude.CMD"
    shim.write_bytes(text.encode("utf-8"))
    return shim


def _node_on_path(root: Path) -> tuple[str, str]:
    """A `node.exe` in its own directory, and that directory as a PATH."""
    node_dir = root / "nodejs"
    node_dir.mkdir()
    node = node_dir / "node.exe"
    node.write_text("")
    node.chmod(0o755)
    return str(node), str(node_dir)


class TestShimPassthrough:
    """The ConPTY spawn looks through a generated node shim to the `node.exe
    <script>` it would run, so the pane holds the CLI and not cmd.exe. Only
    a shim of a known generator's exact shape qualifies; everything else keeps
    the cmd.exe wrapping."""

    @pytest.mark.parametrize(
        "text", [_NPM_SHIM, _NPM6_SHIM, _YARN_SHIM], ids=["npm", "npm6", "yarn-classic"]
    )
    def test_a_generated_shim_becomes_node_on_its_script(self, tmp_path, text):
        from agent_team_backend.osplat import _windows

        shim = _write_shim(tmp_path, text)
        node, node_dir = _node_on_path(tmp_path)
        script = str((tmp_path / "bin").joinpath(*_CLI_JS.split("\\")).resolve())
        assert _windows.paths.pty_launch_parts(
            str(shim), ["--resume", "abc def"], path=node_dir
        ) == (node, [script, "--resume", "abc def"])

    def test_pnpm_shim_resolves_its_parent_relative_script(self, tmp_path):
        from agent_team_backend.osplat import _windows

        shim = _write_shim(tmp_path, _PNPM_SHIM, target=_PNPM_TARGET)
        node, node_dir = _node_on_path(tmp_path)
        script = str((tmp_path / "bin").joinpath(*_PNPM_TARGET.split("\\")).resolve())
        assert _windows.paths.pty_launch_parts(str(shim), path=node_dir) == (node, [script])

    def test_node_beside_the_shim_wins_over_path(self, tmp_path):
        from agent_team_backend.osplat import _windows

        shim = _write_shim(tmp_path, _NPM_SHIM, node_beside=True)
        _node, node_dir = _node_on_path(tmp_path)
        head, _tail = _windows.paths.pty_launch_parts(str(shim), path=node_dir)
        assert head == str(tmp_path / "bin" / "node.exe")

    def _falls_back(self, shim: Path, args=(), *, path=None) -> None:
        from agent_team_backend.osplat import _windows

        assert _windows.paths.pty_launch_parts(str(shim), args, path=path) == (
            "cmd.exe", ["/d", "/c", str(shim), *args],
        )

    def test_a_shim_that_sets_node_path_keeps_cmd_exe(self, tmp_path):
        # pnpm's hoisted global layout needs NODE_PATH; the shim is the only
        # thing that sets it, so running node directly would break module
        # resolution. Environment is not carried — the shim stays in charge.
        shim = _write_shim(tmp_path, _PNPM_NODE_PATH_SHIM, target=_PNPM_TARGET)
        _node, node_dir = _node_on_path(tmp_path)
        self._falls_back(shim, ["--version"], path=node_dir)

    def test_a_shim_with_node_arguments_or_unknown_lines_keeps_cmd_exe(self, tmp_path):
        _node, node_dir = _node_on_path(tmp_path)
        with_args = _NPM_SHIM.replace('"%_prog%"  "%dp0%', '"%_prog%" --harmony "%dp0%')
        self._falls_back(_write_shim(tmp_path, with_args), path=node_dir)
        extra_line = _NPM_SHIM.replace("SETLOCAL\r\n", "SETLOCAL\r\nSET DEBUG=1\r\n", 1)
        self._falls_back(_write_shim(tmp_path, extra_line), path=node_dir)
        two_scripts = _YARN_SHIM.replace(f'node  "%~dp0\\{_CLI_JS}"', 'node  "%~dp0\\other.js"')
        self._falls_back(_write_shim(tmp_path, two_scripts), path=node_dir)
        self._falls_back(_write_shim(tmp_path, "@echo hello\r\n"), path=node_dir)

    def test_a_shim_whose_pieces_are_missing_keeps_cmd_exe(self, tmp_path):
        _node, node_dir = _node_on_path(tmp_path)
        shim = _write_shim(tmp_path, _NPM_SHIM)
        (tmp_path / "bin").joinpath(*_CLI_JS.split("\\")).unlink()  # script gone
        self._falls_back(shim, path=node_dir)
        shim = _write_shim(tmp_path, _NPM_SHIM)
        self._falls_back(shim, path=str(tmp_path / "empty"))  # no node anywhere
        big = _write_shim(tmp_path, _NPM_SHIM + "REM " + "x" * 5000 + "\r\n")
        self._falls_back(big, path=node_dir)  # not a generated shim by size alone
        self._falls_back(tmp_path / "bin" / "absent.cmd", path=node_dir)  # unreadable

    def test_only_a_cmd_program_is_looked_into(self, tmp_path):
        from agent_team_backend.osplat import _windows

        exe = tmp_path / "claude.exe"
        exe.write_bytes(_NPM_SHIM.encode())  # same bytes, wrong extension
        assert _windows.paths.pty_launch_parts(str(exe), ["x"]) == (str(exe), ["x"])

    def test_posix_ignores_the_path_argument(self):
        from agent_team_backend.osplat import _darwin, _linux

        for paths in (_darwin.paths, _linux.paths):
            assert paths.pty_launch_parts("/bin/zsh", ("-l",), path="/nowhere") == ("/bin/zsh", ["-l"])


#: What git_service hands the seam: this build's own executable plus the entry
#: mode that answers a prompt. Never the bare name `python`.
_LAUNCH_ARGV = ["/opt/navide/agent_team_backend", "--askpass-helper"]


class TestAskpassLauncher:
    """`GIT_ASKPASS` is exec'd by git with no shell: a source checkout runs the
    script's shebang, and every frozen build needs a launcher around the
    backend's own askpass entry mode -- Windows always, because it cannot exec
    a `.py` at all."""

    @pytest.mark.skipif(sys.platform == "win32", reason="the exec bit does not exist on NTFS")
    def test_posix_returns_the_script_made_executable(self, tmp_path):
        from agent_team_backend.osplat import _darwin, _linux

        helper = tmp_path / "git_askpass_helper.py"
        helper.write_text("#!/usr/bin/env python3\n", encoding="utf-8")
        helper.chmod(0o644)
        assert _darwin.paths.askpass_launcher(helper, _LAUNCH_ARGV) == helper
        assert os.stat(helper).st_mode & stat.S_IXUSR
        helper.chmod(0o644)
        assert _linux.paths.askpass_launcher(helper, _LAUNCH_ARGV) == helper
        assert os.stat(helper).st_mode & stat.S_IXUSR

    # A frozen build has no `python3` to promise the shebang, so POSIX stops
    # relying on one too: the launcher runs the executable git_service named.
    @pytest.mark.skipif(sys.platform == "win32", reason="the exec bit does not exist on NTFS")
    def test_posix_frozen_build_writes_an_sh_launcher(self, tmp_path, monkeypatch):
        from agent_team_backend.osplat import _darwin

        monkeypatch.setattr(sys, "frozen", True, raising=False)
        helper = tmp_path / "git_askpass_helper.py"
        helper.write_text("", encoding="utf-8")
        launcher = _darwin.paths.askpass_launcher(helper, _LAUNCH_ARGV)
        assert launcher == tmp_path / "git_askpass_helper.sh"
        assert launcher.read_text(encoding="utf-8") == (
            '#!/bin/sh\nexec /opt/navide/agent_team_backend --askpass-helper "$@"\n'
        )
        assert stat.S_IMODE(os.stat(launcher).st_mode) == 0o755

    def test_windows_writes_a_cmd_wrapper_beside_the_script(self, tmp_path):
        from agent_team_backend.osplat import _windows

        helper = tmp_path / "git_askpass_helper.py"
        helper.write_text("", encoding="utf-8")
        launcher = _windows.paths.askpass_launcher(
            helper, [r"C:\Program Files\Navide\backend.exe", "--askpass-helper"]
        )
        assert launcher == tmp_path / "git_askpass_helper.cmd"
        assert launcher.read_bytes() == (
            b'@"C:\\Program Files\\Navide\\backend.exe" --askpass-helper %*\r\n'
        )

    # The regression this whole entry mode exists for: `python` on a stock
    # Windows is the Store's alias stub, which hands git an empty credential.
    def test_windows_never_names_a_bare_interpreter(self, tmp_path):
        from agent_team_backend.osplat import _windows

        helper = tmp_path / "git_askpass_helper.py"
        helper.write_text("", encoding="utf-8")
        launcher = _windows.paths.askpass_launcher(helper, _LAUNCH_ARGV)
        text = launcher.read_text(encoding="utf-8")
        assert "python" not in text
        assert text.startswith("@/opt/navide/agent_team_backend --askpass-helper")

    def test_windows_leaves_an_up_to_date_launcher_untouched(self, tmp_path):
        from agent_team_backend.osplat import _windows

        helper = tmp_path / "git_askpass_helper.py"
        helper.write_text("", encoding="utf-8")
        launcher = _windows.paths.askpass_launcher(helper, _LAUNCH_ARGV)
        before = launcher.stat().st_mtime_ns
        os.utime(launcher, ns=(before - 10**9, before - 10**9))
        stamped = launcher.stat().st_mtime_ns
        assert _windows.paths.askpass_launcher(helper, _LAUNCH_ARGV) == launcher
        assert launcher.stat().st_mtime_ns == stamped

    # git_service resolves the launcher at import: a directory that cannot be
    # written must degrade the way the POSIX chmod does (log, hand git the
    # path, let git report the failure) rather than stop the backend.
    def test_windows_unwritable_directory_logs_and_still_names_the_launcher(
        self, tmp_path, monkeypatch, caplog
    ):
        from agent_team_backend.osplat import _windows

        helper = tmp_path / "git_askpass_helper.py"
        helper.write_text("", encoding="utf-8")

        def denied(self, data):
            raise PermissionError(13, "Access is denied", str(self))

        monkeypatch.setattr(Path, "write_bytes", denied)
        launcher = _windows.paths.askpass_launcher(helper, _LAUNCH_ARGV)
        assert launcher == tmp_path / "git_askpass_helper.cmd"
        assert not launcher.exists()
        assert "cannot write git askpass launcher" in caplog.text


class TestOrphanParent:
    """What the EOF-path orphan sweep in `terminals` asks the tree: which ppid
    means the real parent is gone. POSIX reparents to init (or, observed on
    macOS, to this backend); Windows never reparents, and `snapshot` writes 0
    for a stale parent instead."""

    def test_posix_is_init_or_this_process(self):
        from agent_team_backend.osplat import _posix

        tree = _posix.process_tree
        assert tree.is_orphan_parent(1, 500)
        assert tree.is_orphan_parent(500, 500)
        assert not tree.is_orphan_parent(0, 500)
        assert not tree.is_orphan_parent(42, 500)

    # systemd desktops: `systemd --user` is a child subreaper, so a CLI whose
    # backend died gets ppid = that manager, never 1 — and the sweep skipped
    # every leaked CLI after a backend crash.
    def test_linux_also_accepts_the_session_subreapers(self, monkeypatch):
        from agent_team_backend.osplat import _linux

        comms = {1234: "systemd", 5678: "bwrap", 42: "bash"}
        monkeypatch.setattr(_linux, "_read_comm", lambda pid: comms.get(pid))
        tree = _linux.process_tree
        assert tree.is_orphan_parent(1, 500)
        assert tree.is_orphan_parent(500, 500)
        assert tree.is_orphan_parent(1234, 500)
        assert tree.is_orphan_parent(5678, 500)
        assert not tree.is_orphan_parent(42, 500)
        # A parent /proc cannot describe (gone, or hidepid) is not called an orphan.
        assert not tree.is_orphan_parent(9999, 500)

    def test_linux_reads_comm_from_proc(self, tmp_path, monkeypatch):
        from agent_team_backend.osplat import _linux

        (tmp_path / "77").mkdir()
        (tmp_path / "77" / "comm").write_text("systemd\n")
        monkeypatch.setattr(_linux, "_PROC", tmp_path)
        assert _linux._read_comm(77) == "systemd"
        assert _linux._read_comm(78) is None
        assert _linux.process_tree.is_orphan_parent(77, 500)

    def test_windows_is_the_normalised_zero_or_this_process(self):
        from agent_team_backend.osplat import _windows

        tree = _windows.process_tree
        assert tree.is_orphan_parent(0, 500)
        assert tree.is_orphan_parent(500, 500)
        assert not tree.is_orphan_parent(1, 500)
        assert not tree.is_orphan_parent(42, 500)


#: Files that still decide platform behaviour for themselves. This list may
#: shrink and must never grow: a new entry means a feature module started
#: branching on the OS again, which is exactly what `osplat` exists to stop.
#:
#: `proc_rusage` stays until it moves under `osplat/` wholesale — it is already
#: reached only through the Darwin implementation, so its branch is a guard on
#: an unreachable path rather than a live decision.
PLATFORM_BRANCH_ALLOWLIST = {
    "cli_vendors/antigravity.py",
    "cli_vendors/claude.py",
    "cli_vendors/cursor.py",
    "credential_vault.py",
    "proc_rusage.py",
    "process_memory.py",
}

_BRANCH_RE = re.compile(r"sys\.platform|os\.name\s*==")


class TestNoScatteredPlatformBranches:
    def test_only_allowlisted_modules_branch_on_the_platform(self):
        root = Path(__file__).resolve().parents[1] / "agent_team_backend"
        offenders = set()
        for path in root.rglob("*.py"):
            if "osplat" in path.parts:
                continue  # the one place that is allowed to ask
            if _BRANCH_RE.search(path.read_text(encoding="utf-8")):
                offenders.add(path.relative_to(root).as_posix())
        new = offenders - PLATFORM_BRANCH_ALLOWLIST
        assert not new, (
            "these modules started branching on the platform; put the decision "
            f"behind an osplat seam instead: {sorted(new)}"
        )

    # The allowlist is a ratchet, so a cleaned-up module has to be removed from
    # it — otherwise it silently licenses the next regression.
    def test_the_allowlist_has_no_stale_entries(self):
        root = Path(__file__).resolve().parents[1] / "agent_team_backend"
        stale = {
            name
            for name in PLATFORM_BRANCH_ALLOWLIST
            if not _BRANCH_RE.search((root / name).read_text(encoding="utf-8"))
        }
        assert not stale, f"already clean, drop from the allowlist: {sorted(stale)}"


#: Modules whose secret files go through `osplat.secret_files`. Listed rather
#: than banning `chmod` everywhere: `fs_service` copying a user file's mode is
#: legitimate, and `credential_vault` still preserves the mode of the user's
#: own `.claude.json`. What these must not do is set a *literal* owner-only
#: mode themselves — on NTFS that call protects nothing, which is the whole
#: reason the seam exists.
SECRET_FILE_MODULES = {
    "ai_chat_settings.py",
    "credential_vault.py",
    "device_crypto.py",
    "device_signing.py",
    "executions_service.py",
    "hook_auth.py",
    "host_shell.py",
    "mcp_server/auth.py",
    "mcp_server/pane_home.py",
    "mcp_server/wiring.py",
    "push_delivery.py",
    "store_migrations.py",
    "usage_service.py",
    "ws_auth.py",
}

_OWNER_ONLY_MODE_RE = re.compile(
    r"chmod\([^)]*0o[67]00\)"          # os.chmod(p, 0o600) / path.chmod(0o700)
    r"|mkdir\([^)]*mode=0o700"          # path.mkdir(mode=0o700, ...)
    r"|S_IRUSR \| stat\.S_IWUSR"       # the spelled-out 0o600
)


class TestSecretFilesGoThroughTheSeam:
    def test_migrated_modules_no_longer_set_owner_only_modes_themselves(self):
        root = Path(__file__).resolve().parents[1] / "agent_team_backend"
        offenders = {
            name
            for name in SECRET_FILE_MODULES
            if _OWNER_ONLY_MODE_RE.search((root / name).read_text(encoding="utf-8"))
        }
        assert not offenders, (
            "these modules set an owner-only mode inline again; use "
            f"osplat.secret_files instead: {sorted(offenders)}"
        )


#: Modules the Windows port moved off the POSIX process and PTY APIs. Every
#: platform-specific call they used to make now goes through
#: `osplat.process_tree` / `osplat.terminal_backend` / `osplat.resource_probe`,
#: and this keeps it that way: a `fcntl` import or an `os.killpg` call creeping
#: back in would make the backend unimportable (or unkillable) on Windows.
POSIX_FREE_MODULES = (
    "ai_chat_cli_engine.py",
    "mem_probe.py",
    "pty_registry.py",
    "terminals.py",
)

_POSIX_IMPORT_RE = re.compile(
    r"^\s*(?:import|from)\s+(?:fcntl|pty|termios|resource)\b", re.MULTILINE
)
_POSIX_CALL_RE = re.compile(
    r"\bos\.(?:killpg|getpgid|tcgetpgrp|setsid|openpty|kill)\s*\("
    r"|\bpty\.openpty\b|\bsignal\.SIG(?:KILL|TERM)\b|\bTIOCS(?:WINSZ|CTTY)\b"
)


class TestPortedModulesStayPosixFree:
    @pytest.mark.parametrize("name", POSIX_FREE_MODULES)
    def test_no_posix_only_import_or_call(self, name):
        root = Path(__file__).resolve().parents[1] / "agent_team_backend"
        source = (root / name).read_text(encoding="utf-8")
        assert not _POSIX_IMPORT_RE.search(source), f"{name} imports a POSIX-only module"
        hit = _POSIX_CALL_RE.search(source)
        assert hit is None, f"{name} calls the POSIX process API directly: {hit.group(0)!r}"

    def test_the_seam_itself_still_makes_those_calls(self):
        # The ratchet would be vacuous if the calls had simply vanished.
        posix = Path(__file__).resolve().parents[1] / "agent_team_backend" / "osplat" / "_posix.py"
        source = posix.read_text(encoding="utf-8")
        assert _POSIX_IMPORT_RE.search(source)
        assert _POSIX_CALL_RE.search(source)


#: Spawns that redirect stdin or stdout without naming stderr. This list may
#: shrink and must never grow; each entry says why it cannot name one.
#:
#: Why the rule: on Windows, CPython's `Popen` duplicates the backend's
#: standard error handle (`GetStdHandle` + `DuplicateHandle`) for a child
#: whose stderr is not given whenever stdin or stdout is. `mem_probe` swaps
#: fd 2 on another thread every minute, and a spawn in that window fails with
#: WinError 6 (#445). Naming stderr (a pipe, DEVNULL, STDOUT, a file) keeps
#: the spawn off that handle.
SPAWN_STDERR_ALLOWLIST: dict[str, str] = {}

_SUBPROCESS_SPAWNS = {"Popen", "run", "call", "check_call", "check_output"}
_ASYNCIO_SPAWNS = {"create_subprocess_exec", "create_subprocess_shell"}
_LOOP_SPAWNS = {"subprocess_exec", "subprocess_shell"}


def _spawn_names(tree: ast.AST) -> set[str]:
    """Local names bound to a spawn function: `from subprocess import run`,
    `from asyncio import create_subprocess_exec as spawn`, `run = subprocess.run`."""
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module in ("subprocess", "asyncio", "asyncio.subprocess"):
            spawns = _SUBPROCESS_SPAWNS if node.module == "subprocess" else _ASYNCIO_SPAWNS
            names |= {alias.asname or alias.name for alias in node.names if alias.name in spawns}
        elif isinstance(node, ast.Assign) and _is_spawn_attribute(node.value):
            names |= {target.id for target in node.targets if isinstance(target, ast.Name)}
    return names


def _is_spawn_attribute(node: ast.AST) -> bool:
    if not isinstance(node, ast.Attribute):
        return False
    owner = ast.unparse(node.value)
    return (
        (owner == "subprocess" and node.attr in _SUBPROCESS_SPAWNS)
        or (owner in ("asyncio", "asyncio.subprocess") and node.attr in _ASYNCIO_SPAWNS)
        # loop.subprocess_exec / self._loop.subprocess_shell, whatever the loop is called
        or node.attr in _LOOP_SPAWNS
    )


def _spawn_calls(source: str) -> list[tuple[int, str, bool]]:
    """Every spawn call in `source` as (line, call text, names stderr when it
    must). A call passing `**kwargs` may redirect anything, so it must name
    stderr itself."""
    tree = ast.parse(source)
    names = _spawn_names(tree)
    calls = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if not (_is_spawn_attribute(func) or (isinstance(func, ast.Name) and func.id in names)):
            continue
        given = {keyword.arg for keyword in node.keywords}
        name = func.attr if isinstance(func, ast.Attribute) else func.id
        redirects = bool(given & {"stdin", "stdout", "input", None}) or name == "check_output"
        names_stderr = bool(given & {"stderr", "capture_output"})
        calls.append((node.lineno, ast.unparse(func), names_stderr or not redirects))
    return sorted(calls)


class TestSpawnsNameTheirStderr:
    def test_a_spawn_that_redirects_stdin_or_stdout_names_stderr(self):
        root = Path(__file__).resolve().parents[1] / "agent_team_backend"
        offenders = set()
        for path in root.rglob("*.py"):
            name = path.relative_to(root).as_posix()
            for line, call, ok in _spawn_calls(path.read_text(encoding="utf-8")):
                if not ok and f"{name}:{call}" not in SPAWN_STDERR_ALLOWLIST:
                    offenders.add(f"{name}:{line} {call}")
        assert not offenders, (
            "these spawns redirect stdin or stdout but inherit stderr, which on "
            "Windows duplicates the backend's stderr handle (WinError 6 while "
            f"mem_probe swaps it, #445); name stderr: {sorted(offenders)}"
        )

    # The allowlist is a ratchet, so a cleaned-up spawn has to be removed from
    # it — otherwise it silently licenses the next regression.
    def test_the_allowlist_has_no_stale_entries(self):
        root = Path(__file__).resolve().parents[1] / "agent_team_backend"
        stale = set()
        for entry in SPAWN_STDERR_ALLOWLIST:
            name, _, call = entry.partition(":")
            source = (root / name).read_text(encoding="utf-8")
            if not any(c == call and not ok for _, c, ok in _spawn_calls(source)):
                stale.add(entry)
        assert not stale, f"already clean, drop from the allowlist: {sorted(stale)}"

    def test_the_scan_sees_every_spelling_of_a_spawn(self):
        # The ratchet would be vacuous if the scan simply stopped matching.
        source = """
import asyncio, subprocess
from subprocess import Popen as P, check_output
from asyncio import create_subprocess_exec as spawn
run = subprocess.run
subprocess.run(a, stdout=subprocess.PIPE)
subprocess.run(a, capture_output=True)
subprocess.run(a, input=b"x", stderr=subprocess.PIPE)
subprocess.run(a)
P(a, stdin=subprocess.PIPE)
check_output(a)
run(a, stdout=f)
spawn(*a, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
asyncio.create_subprocess_exec(*a, stdin=asyncio.subprocess.PIPE)
loop.subprocess_exec(factory, *a, **kwargs)
"""
        assert [(line, ok) for line, _, ok in _spawn_calls(source)] == [
            (6, False), (7, True), (8, True), (9, True), (10, False), (11, False),
            (12, False), (13, True), (14, False), (15, False),
        ]
        # And the real backend still has spawns for it to read.
        worker = Path(__file__).resolve().parents[1] / "agent_team_backend" / "agent_tool_result_worker.py"
        assert ("asyncio.create_subprocess_exec", True) in {
            (call, ok) for _, call, ok in _spawn_calls(worker.read_text(encoding="utf-8"))
        }


class TestScripts:
    """The texts a *shell* runs: hook commands and the confirm-then-run line.

    Both implementations are exercised on whichever machine runs the suite --
    they are pure string rendering, and Copilot's hook file carries the
    PowerShell spelling even when written on a Mac.
    """

    def test_the_selected_renderer_is_this_platform(self):
        expected = "WindowsScripts" if sys.platform == "win32" else "PosixScripts"
        assert type(osplat.scripts).__name__ == expected
        assert set(osplat.scripts_by_shell) == {"bash", "powershell"}

    def test_posix_hook_entry_stays_the_shape_the_installer_has_always_written(self):
        from agent_team_backend.osplat import _posix_paths

        entry = _posix_paths.scripts.hook_entry("echo hi")
        assert entry == {"type": "command", "command": "echo hi"}

    # Without `shell`, Claude Code runs the command under Git Bash whenever it
    # is installed -- and this text is PowerShell.
    def test_windows_hook_entry_declares_powershell(self):
        from agent_team_backend.osplat import _windows

        entry = _windows.scripts.hook_entry("exit 0")
        assert entry == {"type": "command", "shell": "powershell", "command": "exit 0"}

    def test_posix_hook_post_json_reads_the_port_at_fire_time(self):
        from agent_team_backend.osplat import _posix_paths

        command = _posix_paths.scripts.hook_post_json(
            port_file="/tmp/navide.port",
            header_file="/tmp/hook.header",
            url_path="/hooks/claude",
            event="stop",
            timeout_s=4,
            keep_body=True,
        )
        assert command.startswith("PORT=$(cat /tmp/navide.port 2>/dev/null); ")
        assert "-o /dev/null" not in command  # the Stop hook's answer is read
        assert command.endswith('"http://127.0.0.1:$PORT/hooks/claude" || true')

    def test_posix_exit_zero_swallows_a_failed_curl(self):
        from agent_team_backend.osplat import _posix_paths

        command = _posix_paths.scripts.hook_post_json(
            port_file="/tmp/navide.port",
            header_file="/tmp/hook.header",
            url_path="/hooks/copilot",
            event="notification",
            timeout_s=2,
            exit_zero=True,
        )
        assert command.endswith(">/dev/null 2>&1; exit 0")

    def test_posix_without_curl_spells_the_post_with_python3(self, monkeypatch):
        # Decided when the hook is written: a box without curl (Ubuntu Desktop)
        # gets the standard-library spelling, with the same discard and tail.
        from agent_team_backend.osplat import _posix_paths

        monkeypatch.setattr(_posix_paths, "resolve_program", lambda name, *, path=None: None)
        command = _posix_paths.scripts.hook_post_json(
            port_file="/tmp/navide.port",
            header_file="/tmp/hook.header",
            url_path="/hooks/claude",
            event="pre_tool_use",
            timeout_s=2,
        )
        assert "curl -fsS" not in command
        assert command.startswith("PORT=$(cat /tmp/navide.port 2>/dev/null); ")
        assert "python3 -c " in command
        assert command.endswith("/tmp/hook.header 2 >/dev/null || true")

        rewake = _posix_paths.scripts.hook_rewake(
            port_file="/tmp/navide.port",
            header_file="/tmp/hook.header",
            url_path="/hooks/claude/rewake",
            timeout_s=1860,
        )
        assert "curl -fsS" not in rewake
        assert "BODY=$(python3 -c " in rewake
        assert rewake.endswith("exit 2")

    def test_posix_with_curl_keeps_the_exact_command_text(self, monkeypatch):
        # The curl spelling is what every installed settings.json holds; a
        # changed text would rewrite them all on the next start.
        from agent_team_backend.osplat import _posix_paths

        monkeypatch.setattr(_posix_paths, "resolve_program", lambda name, *, path=None: "/usr/bin/curl")
        command = _posix_paths.scripts.hook_post_json(
            port_file="/tmp/navide.port",
            header_file="/tmp/hook.header",
            url_path="/hooks/claude",
            event="stop",
            timeout_s=4,
            keep_body=True,
        )
        assert command == (
            "PORT=$(cat /tmp/navide.port 2>/dev/null); "
            '[ -n "$PORT" ] && curl -fsS -m 4 -X POST '
            "-H 'Content-Type: application/json' "
            "-H 'X-Agent-Team-Event: stop' "
            "-H @/tmp/hook.header "
            "--data-binary @- "
            '"http://127.0.0.1:$PORT/hooks/claude" || true'
        )
        discarded = _posix_paths.scripts.hook_post_json(
            port_file="/tmp/navide.port",
            header_file="/tmp/hook.header",
            url_path="/hooks/copilot",
            event="notification",
            timeout_s=2,
            exit_zero=True,
        )
        assert discarded == (
            "PORT=$(cat /tmp/navide.port 2>/dev/null); "
            '[ -n "$PORT" ] && curl -fsS -m 2 -o /dev/null -X POST '
            "-H 'Content-Type: application/json' "
            "-H 'X-Agent-Team-Event: notification' "
            "-H @/tmp/hook.header "
            "--data-binary @- "
            '"http://127.0.0.1:$PORT/hooks/copilot" >/dev/null 2>&1; exit 0'
        )

    def test_windows_hook_post_json_is_a_powershell_one_liner(self):
        from agent_team_backend.osplat import _windows

        command = _windows.scripts.hook_post_json(
            port_file=r"C:\Users\a b\navide.port",
            header_file=r"C:\Users\a b\hook.header",
            url_path="/hooks/copilot",
            event="notification",
            timeout_s=2,
            exit_zero=True,
        )
        assert "\n" not in command
        # `curl` alone is a PowerShell alias for Invoke-WebRequest, which takes
        # none of these arguments; `curl.exe` off PATH can be a Git or MSYS2
        # build that reads a non-ASCII header file path as `???`.
        assert "& ($env:SystemRoot + '\\System32\\curl.exe') -fsS -m 2 -o NUL -X POST" in command
        assert command.startswith(
            "$PORT = $null; try { $PORT = [IO.File]::ReadAllLines('C:\\Users\\a b\\navide.port') } catch {}; "
        )
        # `@` starts a splat in PowerShell, so both curl `@` arguments are quoted.
        assert "-H '@C:\\Users\\a b\\hook.header'" in command
        assert "--data-binary '@-'" in command
        assert command.endswith('"http://127.0.0.1:$PORT/hooks/copilot" }; exit 0')

    def test_windows_keeps_the_body_when_the_cli_reads_it(self):
        from agent_team_backend.osplat import _windows

        command = _windows.scripts.hook_post_json(
            port_file="p",
            header_file="h",
            url_path="/hooks/claude",
            event="stop",
            timeout_s=4,
            keep_body=True,
        )
        assert "-o NUL" not in command

    def test_windows_kept_body_reaches_stdout_as_the_raw_bytes(self):
        """The Stop hook's decision carries an inter-CLI message as UTF-8, and
        PowerShell's native-output capture re-coded it through the console
        code page (cp950 on zh-TW) -- the #147 garbling on the Stop path. curl
        writes to a temp file whose bytes go to the raw stdout stream."""
        from agent_team_backend.osplat import _windows

        command = _windows.scripts.hook_post_json(
            port_file="p",
            header_file="h",
            url_path="/hooks/claude",
            event="stop",
            timeout_s=4,
            keep_body=True,
        )
        assert "\n" not in command
        assert "if (-not $TMP) { [Console]::Error.Write(" in command
        assert "& ($env:SystemRoot + '\\System32\\curl.exe') -fsS -m 4 -o $TMP -X POST" in command
        assert "[IO.File]::ReadAllBytes($TMP)" in command
        assert "try { [IO.File]::Delete($TMP) } catch {}" in command
        assert "[Console]::OpenStandardOutput()" in command
        assert "OutputEncoding" not in command
        assert command.endswith("exit 0")

    def test_windows_temp_files_never_run_out_and_a_missing_one_says_why(self):
        """GetTempFileName creates tmpXXXX.tmp and fails once 65535 are left
        behind (each hook killed mid-wait leaves one), after which every hook
        exited 0 without a word. A random name under TEMP has no such ceiling,
        and a temp path that cannot be made is reported on stderr."""
        from agent_team_backend.osplat import _windows

        commands = [
            _windows.scripts.hook_post_json(
                port_file="p", header_file="h", url_path="/hooks/claude",
                event="stop", timeout_s=4, keep_body=True,
            ),
            _windows.scripts.hook_rewake(
                port_file="p", header_file="h", url_path="/hooks/claude/rewake", timeout_s=1860
            ),
        ]
        for command in commands:
            assert "GetTempFileName" not in command
            assert "$TMP = [IO.Path]::Combine($env:TEMP, [IO.Path]::GetRandomFileName())" in command
            assert "if (-not $env:TEMP) { throw 'TEMP is not set' }" in command
            assert "if (-not $TMP) { [Console]::Error.Write('navide hook: no temp file: '" in command
            assert "[Console]::Error.WriteLine" not in command  # see #147 below

    def test_windows_discarded_body_keeps_the_exact_command_text(self):
        # Only the kept-body branch changed for the Stop-path garbling; every
        # installed settings.json holds this text for the other events.
        from agent_team_backend.osplat import _windows

        command = _windows.scripts.hook_post_json(
            port_file="p",
            header_file="h",
            url_path="/hooks/claude",
            event="pre_tool_use",
            timeout_s=2,
        )
        assert command == (
            "$PORT = $null; try { $PORT = [IO.File]::ReadAllLines('p') } catch {}; "
            "if ($PORT) { & ($env:SystemRoot + '\\System32\\curl.exe') -fsS -m 2 -o NUL -X POST "
            "-H 'Content-Type: application/json' "
            "-H 'X-Agent-Team-Event: pre_tool_use' "
            "-H '@h' "
            "--data-binary '@-' "
            '"http://127.0.0.1:$PORT/hooks/claude" }; exit 0'
        )

    def test_windows_rewake_writes_the_body_to_stderr_and_exits_two(self):
        from agent_team_backend.osplat import _windows

        command = _windows.scripts.hook_rewake(
            port_file="p", header_file="h", url_path="/hooks/claude/rewake", timeout_s=1860
        )
        assert "\n" not in command
        assert "if (-not $PORT) { exit 0 }" in command
        assert "& ($env:SystemRoot + '\\System32\\curl.exe') -fsS -m 1860 -o $TMP -X POST" in command
        assert command.endswith("exit 2 }; exit 0")

    def test_windows_rewake_hands_the_body_over_as_one_utf8_string(self):
        """#147: PowerShell captures a multi-line curl output as object[], and
        `[Console]::Error.WriteLine` printed that as `System.Object[]`; it also
        decodes curl's UTF-8 with the console code page (cp950 on zh-TW), which
        turned CJK into `?`. The body goes through a temp file read back as
        UTF-8 and leaves as UTF-8 bytes on the raw stderr stream."""
        from agent_team_backend.osplat import _windows

        command = _windows.scripts.hook_rewake(
            port_file="p", header_file="h", url_path="/hooks/claude/rewake", timeout_s=1860
        )
        assert "$BODY = &" not in command
        assert "[Console]::Error.WriteLine" not in command
        assert "[IO.File]::ReadAllLines($TMP, [Text.Encoding]::UTF8)" in command
        assert "($BODY -join [Environment]::NewLine)" in command
        assert "[Text.Encoding]::UTF8.GetBytes(" in command
        assert "[Console]::OpenStandardError()" in command
        # Setting the console's encoding and restoring it afterwards still left
        # the parent console on 65001 when two hooks interleaved or one was
        # killed mid-wait (#147), so the hook never touches it.
        assert "OutputEncoding" not in command
        assert "try { [IO.File]::Delete($TMP) } catch {}" in command
        # No temp file, no wakeup to deliver; a blank body wakes nobody.
        assert "if (-not $TMP) { [Console]::Error.Write(" in command
        assert "if (($BODY -join '').Trim()) {" in command

    def test_posix_rewake_keeps_the_exact_command_text(self, monkeypatch):
        # #147 is a Windows fix; every installed POSIX settings.json holds this
        # text and a changed one would rewrite them all on the next start.
        from agent_team_backend.osplat import _posix_paths

        monkeypatch.setattr(_posix_paths, "resolve_program", lambda name, *, path=None: "/usr/bin/curl")
        command = _posix_paths.scripts.hook_rewake(
            port_file="/tmp/navide.port",
            header_file="/tmp/hook.header",
            url_path="/hooks/claude/rewake",
            timeout_s=1860,
        )
        assert command == (
            "PORT=$(cat /tmp/navide.port 2>/dev/null); "
            '[ -n "$PORT" ] || exit 0\n'
            "BODY=$(curl -fsS -m 1860 -X POST "
            "-H 'Content-Type: application/json' "
            "-H 'X-Agent-Team-Event: rewake' "
            "-H @/tmp/hook.header "
            "--data-binary @- "
            '"http://127.0.0.1:$PORT/hooks/claude/rewake" || true)\n'
            '[ -n "$BODY" ] || exit 0\n'
            "printf '%s\\n' \"$BODY\" >&2\n"
            "exit 2"
        )

    def test_posix_confirm_then_run_asks_before_running(self):
        from agent_team_backend.osplat import _posix_paths

        script = _posix_paths.scripts.confirm_then_run("Remove claude", "/usr/bin/npm uninstall")
        assert script == (
            "printf '%s\\n' 'Remove claude'; "
            "printf 'Continue? [y/N] '; read -r answer; "
            'case "$answer" in [Yy]*) /usr/bin/npm uninstall ;; *) echo \'Cancelled.\' ;; esac'
        )

    # `external-terminal.ts` runs this through `powershell -NoExit -Command`,
    # which is a syntax error away from the sh spelling above.
    def test_windows_confirm_then_run_is_powershell(self):
        from agent_team_backend.osplat import _windows

        script = _windows.scripts.confirm_then_run(
            "Remove claude from C:\\a b", '"C:\\a b\\npm.cmd" uninstall -g x'
        )
        assert script == (
            "Write-Host 'Remove claude from C:\\a b'; "
            "$a = Read-Host 'Continue? [y/N]'; "
            "if ($a -match '^[Yy]') { & \"C:\\a b\\npm.cmd\" uninstall -g x } "
            "else { Write-Host 'Cancelled.' }"
        )

    # A single quote is the one character a PowerShell single-quoted string
    # cannot carry as-is, and a directory name may well have one.
    def test_windows_doubles_a_quote_in_the_description(self):
        from agent_team_backend.osplat import _windows

        script = _windows.scripts.confirm_then_run("Remove o'brien's cli", "npm x")
        assert "Write-Host 'Remove o''brien''s cli'" in script


def test_a_folder_created_again_has_another_birth_time(tmp_path: Path) -> None:
    """The convenience gate tells a reset config folder from the user's
    removal by the folder's identity. Linux hands a recreated folder the same
    inode back, so only its birth time can say it is another one."""
    import time

    folder = tmp_path / "cfg"
    folder.mkdir()
    first = osplat.folder_birth_time(folder)
    assert first is not None
    folder.rmdir()
    time.sleep(0.02)
    folder.mkdir()

    again = osplat.folder_birth_time(folder)
    assert again is not None and again != first
    assert osplat.folder_birth_time(tmp_path / "missing") is None


def test_folder_birth_time_on_linux_falls_back_to_none_never_raising(tmp_path: Path, monkeypatch) -> None:
    """No statx (old glibc, musl), a kernel without it (ENOSYS), a filesystem
    without birth times (no STATX_BTIME in the mask) or a call ctypes cannot
    make: the folder identity then stands on device and inode, as before."""
    from agent_team_backend.osplat import folder_birth

    monkeypatch.setattr(folder_birth, "_statx", None)
    assert folder_birth.from_statx(tmp_path) is None

    monkeypatch.setattr(folder_birth, "_statx", lambda *_args: -1)
    assert folder_birth.from_statx(tmp_path) is None

    def no_btime(_dirfd, _path, _flags, _mask, buf) -> int:
        buf._obj.stx_mask = 0x7FF  # STATX_BASIC_STATS, no STATX_BTIME
        return 0

    monkeypatch.setattr(folder_birth, "_statx", no_btime)
    assert folder_birth.from_statx(tmp_path) is None

    def unconvertible(*_args) -> int:
        raise ctypes.ArgumentError("argument 2: wrong type")

    import ctypes

    monkeypatch.setattr(folder_birth, "_statx", unconvertible)
    assert folder_birth.from_statx(tmp_path) is None


def test_folder_birth_never_loads_libc_at_import() -> None:
    """ctypes.CDLL(None) raises TypeError on Windows: loading libc when the
    module is imported took the whole backend down there. It is loaded on
    the first Linux lookup only, and a failure to load is no birth time."""
    import ctypes
    import importlib

    from agent_team_backend.osplat import folder_birth

    def windows_cdll(name, *_args, **_kwargs):
        raise TypeError("argument of type 'NoneType' is not iterable")

    # Its own MonkeyPatch: undoing the test's own would undo conftest's too.
    try:
        with pytest.MonkeyPatch.context() as m:
            m.setattr(ctypes, "CDLL", windows_cdll)
            importlib.reload(folder_birth)  # must not raise
            assert folder_birth.from_statx(Path.cwd()) is None
    finally:
        importlib.reload(folder_birth)

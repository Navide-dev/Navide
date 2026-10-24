"""Darwin implementations of the platform seams.

Every seam here delegates to the module that already held the Darwin branch,
so moving a caller onto the seam cannot change what macOS does. That is the
acceptance condition for the extraction: the shipped platform keeps running
exactly the code it ran before, and the seam only decides *which* module gets
asked.
"""

from __future__ import annotations

import os
import sys
from collections.abc import Sequence
from pathlib import Path

from .. import proc_rusage
from ._posix import PosixTerminalBackend, PosixTerminalHandle, process_tree


class DarwinPaths:
    """`~/Library/...`, the layout every macOS desktop app follows."""

    def app_support_dir(self, app_name: str, *, home: Path | None = None) -> Path:
        return (home or Path.home()) / "Library" / "Application Support" / app_name

    def cache_dir(self, *, home: Path | None = None) -> Path:
        return (home or Path.home()) / "Library" / "Caches"


class DarwinResourceProbe:
    """`proc_pid_rusage`, unchanged — see `proc_rusage` for why it is a syscall."""

    def available(self) -> bool:
        return proc_rusage.available()

    def sample(self, pids: list[int]) -> dict[int, tuple[int, float]]:
        return proc_rusage.sample(pids)

    def memory_kind(self) -> str:
        return "phys_footprint"

    def peak_rss_bytes(self) -> int | None:
        import resource

        # Darwin's ru_maxrss is already in bytes.
        return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss


#: Kill switch / override for the pane helper below: "0" runs panes bare (the
#: pre-helper behaviour), any other value is the helper executable to use.
PANE_HELPER_ENV = "NAVIDE_PANE_HELPER"
_PANE_HELPER_EXE = Path("Navide Pane.app") / "Contents" / "MacOS" / "navide-pane"


def find_pane_helper(env: dict[str, str] | None = None) -> str | None:
    """Path of the pane helper executable, or None to spawn panes bare.

    Packaged: next to the frozen backend in Contents/Resources/bin (where
    electron-builder puts it, see package.json build.mac.extraResources).
    Checkout: build/pane-helper/, if `pnpm run build:pane-helper` has run.
    """
    override = (env if env is not None else os.environ).get(PANE_HELPER_ENV)
    if override is not None:
        if override.strip() in ("", "0"):
            return None
        return override if os.access(override, os.X_OK) else None
    if getattr(sys, "frozen", False):
        candidate = Path(sys.executable).resolve().parent / _PANE_HELPER_EXE
    else:
        candidate = Path(__file__).resolve().parents[3] / "build" / "pane-helper" / _PANE_HELPER_EXE
    return str(candidate) if os.access(candidate, os.X_OK) else None


class DarwinTerminalBackend(PosixTerminalBackend):
    """The POSIX pty spawn, with every pane run under the pane helper.

    LaunchServices names a process after its nearest registered ancestor, so
    a tool a pane launches that registers itself (a browser CLI did, on every
    call) showed in the Dock as another running "Navide" — the app looked
    like it was relaunching in a loop. The helper (resources/pane-helper) is
    its own LSUIElement bundle that registers first, so anything under it is
    attributed to "Navide Pane", which the Dock does not show. It forwards
    signals and exits with the child's status, so kill and exit handling in
    `terminals.py` see the same pid semantics as before. No helper → the
    pane runs exactly as it did without one.
    """

    def __init__(self, helper: str | None) -> None:
        self.helper = helper

    def spawn(
        self,
        argv: list[str] | str,
        *,
        cwd: str,
        env: dict[str, str],
        rows: int,
        cols: int,
    ) -> PosixTerminalHandle:
        if isinstance(argv, str):
            argv = self.parse_command(argv)
        if self.helper:
            argv = [self.helper, *argv]
        return super().spawn(argv, cwd=cwd, env=env, rows=rows, cols=cols)


paths = DarwinPaths()
resource_probe = DarwinResourceProbe()
# PTY and process-group handling are plain POSIX (see `_posix`); Darwin only
# adds the pane helper in front of the command.
terminal_backend = DarwinTerminalBackend(find_pane_helper())
__all__ = ["paths", "process_tree", "resource_probe", "terminal_backend"]


# ---- appended: the Paths members added for the Windows port -----------------
#
# A subclass rather than edits to `DarwinPaths` above, so this lands as a pure
# append; `paths` is rebound below to the complete implementation.

from . import _posix_durable, _posix_paths, _posix_secrets  # noqa: E402


class DarwinLayout(DarwinPaths):
    def state_dir(self, app_name: str) -> Path:
        return self.app_support_dir(app_name)

    def config_home(self, home: Path) -> Path:
        return home / "Library" / "Application Support"

    def system_dirs(self) -> list[Path]:
        return _posix_paths.system_dirs()

    def roaming_app_data(self) -> Path | None:
        return _posix_paths.roaming_app_data()

    def home_env_var(self) -> str:
        return _posix_paths.home_env_var()

    def isolated_home_env(self, home_dir: Path) -> dict[str, str]:
        return _posix_paths.isolated_home_env(home_dir)

    def env_name_key(self, name: str) -> str:
        return _posix_paths.env_name_key(name)

    def askpass_launcher(self, helper_py: Path, launch_argv: list[str]) -> Path:
        return _posix_paths.askpass_launcher(helper_py, launch_argv)

    def git_subprocess_env(self, askpass: str) -> dict[str, str]:
        return _posix_paths.git_subprocess_env(askpass)

    def executable_candidates(self, name: str) -> list[str]:
        return _posix_paths.executable_candidates(name)

    def is_executable(self, path: Path) -> bool:
        return _posix_paths.is_executable(path)

    def login_path_probe(self) -> list[str] | None:
        return _posix_paths.login_path_probe()

    def login_path_fallbacks(self, home: Path) -> list[str]:
        # Homebrew's two prefixes plus ~/.local/bin, where Claude Code's
        # installer and uv put their binaries, and the Node version managers'
        # global bins. `npm install -g` — how OpenAI ships codex — puts the
        # binary inside whichever manager owns npm, never in a Homebrew or
        # ~/.local prefix; a Finder launch whose login-shell probe timed out
        # therefore reported an installed codex as missing while claude, which
        # its installer puts in ~/.local/bin, resolved fine.
        # nvm's per-version bins are NOT here: see login_path_tail_fallbacks.
        return [
            str(home / ".local" / "bin"),
            # `pnpm setup` on darwin: ~/Library/pnpm, per pnpm's getDataDir.
            # ~/.local/share/pnpm is its Linux default and appears on a Mac
            # only under XDG_DATA_HOME, which the login shell already exports.
            str(home / "Library" / "pnpm"),
            str(home / ".npm-global" / "bin"),
            # Where npm was actually told to install, when that is neither of
            # the two guessed above. See `npm_prefix_bins`.
            *_posix_paths.npm_prefix_bins(home),
            str(home / ".volta" / "bin"),
            str(home / ".bun" / "bin"),
            "/usr/local/bin",
            "/opt/homebrew/bin",
            "/opt/homebrew/sbin",
        ]

    def login_path_tail_fallbacks(self, home: Path) -> list[str]:
        # nvm keeps one bin per installed version. Prepended, they outranked
        # the node the user chose: `nvm use 20` became v22, and someone who
        # moved to Homebrew's node but kept ~/.nvm got an old nvm node ahead of
        # /opt/homebrew/bin. Gating them on "PATH has no node yet" fixed that
        # and broke the opposite case — a lazily loaded nvm (zsh-nvm) with a
        # Homebrew node shows the backend the same PATH, and a codex installed
        # under nvm went undetected. Appended, both hold: the user's node stays
        # first, and a CLI that only nvm provides is still found.
        return _posix_paths.nvm_node_bins(home)

    def backend_entry_on_disk(self, entry: str) -> str:
        return _posix_paths.backend_entry_on_disk(entry)

    def enforces_posix_modes(self) -> bool:
        return _posix_paths.enforces_posix_modes()

    def file_name_refused(self, name: str) -> bool:
        return _posix_paths.file_name_refused(name)

    def symlinks_available(self) -> bool:
        return _posix_paths.symlinks_available()

    def shell_command(self, command: str) -> list[str]:
        return _posix_paths.shell_command(command)

    def needs_loopback_dns_proxy(self) -> bool:
        return False

    def quote_arg(self, arg: str) -> str:
        return _posix_paths.quote_arg(arg)

    def resolve_program(self, name_or_path: str, *, path: str | None = None) -> str | None:
        return _posix_paths.resolve_program(name_or_path, path=path)

    def launch_kind(self, program: str) -> str:
        return _posix_paths.launch_kind(program)

    def launch_argv(self, program: str, args: Sequence[str] = ()) -> list[str]:
        return _posix_paths.launch_argv(program, args)

    def pty_launch_parts(
        self, program: str, args: Sequence[str] = (), *, path: str | None = None
    ) -> tuple[str, list[str]]:
        return _posix_paths.pty_launch_parts(program, args, path=path)


paths = DarwinLayout()
secret_files = _posix_secrets.secret_files
durable_secret_files = _posix_durable.durable_secret_files
scripts = _posix_paths.scripts

from . import _posix_scheduler  # noqa: E402

# crontab plus launchd: the LaunchAgents directories are a macOS layout.
scheduler = _posix_scheduler.PosixScheduler(launchd=True)

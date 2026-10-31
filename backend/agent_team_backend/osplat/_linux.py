"""Linux implementations of the platform seams.

Everything here reads `/proc`. That is deliberate: the Darwin probe exists
because spawning `footprint(1)` per sweep turned out to be superlinear in the
pid count, and shelling out to `ps` on Linux would reintroduce the same shape
of problem — one fork per sweep, a timeout to tune, and a number that counts
shared pages once per process.

`/proc` has neither cost: it is a read of already-materialised kernel state,
so a sweep of a hundred and fifty pids is a hundred and fifty small file
reads with no process creation at all.
"""

from __future__ import annotations

import logging
import os
from collections.abc import Sequence
from pathlib import Path

from . import _posix
from ._posix import terminal_backend

log = logging.getLogger(__name__)

_PROC = Path("/proc")

#: `Pss:              12345 kB` in `/proc/<pid>/smaps_rollup`.
#:
#: PSS is the Linux analogue of Darwin's `phys_footprint`: a page mapped by N
#: processes is charged 1/N to each, so a fleet of same-binary CLIs sums to
#: roughly what the machine actually spends rather than N copies of the shared
#: text. RSS — what `ps` prints — charges the full page to every process, which
#: is the over-reporting the Darwin path was written to avoid (measured at
#: ~40% for a screenful of `claude` processes).
_PSS_PREFIX = "Pss:"

#: `smaps_rollup` is the kernel doing the summation, added in 4.14. Walking
#: `smaps` by hand instead would mean parsing thousands of mapping records per
#: process, which is the superlinear sweep again in a different costume — so a
#: kernel without it reports unavailable rather than falling back to RSS.
#: Mixing PSS for some panes and RSS for others would make the column
#: incomparable across rows, which is worse than an empty panel.
_ROLLUP = "smaps_rollup"

#: Clock ticks per second, for converting `/proc/<pid>/stat` CPU fields. POSIX
#: fixes this at 100 on Linux in practice, but reading it is free and the
#: hard-coded constant is exactly the kind of thing that is wrong on the one
#: machine nobody tested.
try:
    _CLK_TCK = float(os.sysconf("SC_CLK_TCK"))
except (AttributeError, ValueError, OSError):  # pragma: no cover - non-POSIX
    _CLK_TCK = 100.0


def _probe_pss_readable() -> bool:
    """Whether this kernel exposes `smaps_rollup` and lets us read our own.

    Resolved once at import, against our own pid: if the kernel is too old, or
    a hardening policy blocks the file, no amount of retrying per sweep will
    change the answer, and a panel that probes on every tick would pay for the
    failure repeatedly.
    """
    try:
        with open(_PROC / str(os.getpid()) / _ROLLUP, encoding="utf-8") as handle:
            for line in handle:
                if line.startswith(_PSS_PREFIX):
                    return True
    except (OSError, ValueError):
        return False
    return False


_PSS_AVAILABLE = _probe_pss_readable()


def _read_pss_bytes(pid: int) -> int | None:
    """Proportional set size for one pid, or None when it cannot be read."""
    try:
        with open(_PROC / str(pid) / _ROLLUP, encoding="utf-8") as handle:
            for line in handle:
                if not line.startswith(_PSS_PREFIX):
                    continue
                parts = line.split()
                # `Pss:  12345 kB` — the kernel always prints kB here.
                if len(parts) >= 2:
                    return int(parts[1]) * 1024
    except (OSError, ValueError):
        return None
    return None


def _read_cpu_seconds(pid: int) -> float | None:
    """Accumulated user+system CPU for one pid, or None when it cannot be read.

    `comm` (field 2) is the process name, unquoted and free to contain both
    spaces and parentheses, so the fields after it can only be found by
    splitting from the *last* `)` — the usual `line.split()[13]` is wrong for
    any process whose name has a space in it, which on this machine includes
    several of the CLIs being measured.
    """
    try:
        with open(_PROC / str(pid) / "stat", encoding="utf-8") as handle:
            raw = handle.read()
    except (OSError, ValueError):
        return None
    close = raw.rfind(")")
    if close < 0:
        return None
    # rest[0] is `state`, which is field 3, so field N is at rest[N - 3].
    rest = raw[close + 2 :].split()
    if len(rest) < 13:
        return None
    try:
        utime = float(rest[11])  # field 14
        stime = float(rest[12])  # field 15
    except ValueError:
        return None
    return (utime + stime) / _CLK_TCK


class LinuxPaths:
    """XDG base directories, with the spec's own defaults when unset.

    The environment variables are only consulted when the caller did not name
    a home: a per-pane home exists precisely to point a CLI somewhere other
    than the real user directory, and honouring `$XDG_CONFIG_HOME` there would
    send it straight back.
    """

    def app_support_dir(self, app_name: str, *, home: Path | None = None) -> Path:
        if home is not None:
            return home / ".config" / app_name
        configured = os.environ.get("XDG_CONFIG_HOME")
        base = Path(configured) if configured else Path.home() / ".config"
        return base / app_name

    def cache_dir(self, *, home: Path | None = None) -> Path:
        if home is not None:
            return home / ".cache"
        configured = os.environ.get("XDG_CACHE_HOME")
        return Path(configured) if configured else Path.home() / ".cache"


class LinuxResourceProbe:
    """Memory and CPU from `/proc`, one directory read per pid."""

    def available(self) -> bool:
        return _PSS_AVAILABLE

    def sample(self, pids: list[int]) -> dict[int, tuple[int, float]]:
        if not _PSS_AVAILABLE or not pids:
            return {}
        out: dict[int, tuple[int, float]] = {}
        for pid in pids:
            if pid <= 0:
                continue
            memory = _read_pss_bytes(pid)
            if memory is None:
                # Died mid-sweep, or belongs to another user. Same contract as
                # the Darwin probe: absent rather than zero, so the caller can
                # tell "not measured" from "measured as nothing".
                continue
            cpu = _read_cpu_seconds(pid)
            out[pid] = (memory, cpu if cpu is not None else 0.0)
        return out

    def memory_kind(self) -> str:
        return "pss"

    def peak_rss_bytes(self) -> int | None:
        import resource

        # Linux reports ru_maxrss in kilobytes.
        return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024


#: What `/proc/<pid>/comm` reads as for the processes that adopt orphans on a
#: Linux desktop besides init: the user's `systemd --user` (a child
#: subreaper on every systemd desktop, so an orphan's ppid is it, not 1) and
#: bubblewrap, which plays the same role inside a Flatpak.
_SUBREAPER_COMMS = frozenset({"systemd", "bwrap"})


def _read_comm(pid: int) -> str | None:
    try:
        return (_PROC / str(pid) / "comm").read_text().strip()
    except OSError:
        return None


class LinuxProcessTree(_posix.PosixProcessTree):
    def is_orphan_parent(self, ppid: int, me: int) -> bool:
        # The POSIX answer (init or this backend), plus the subreapers: a
        # CLI this backend spawned can only end up under `systemd --user`
        # by the backend dying, which is exactly the orphan `reap_stale`
        # is looking for. `terminals` still checks the process's identity
        # (ps lstart) before killing anything this says yes to.
        if super().is_orphan_parent(ppid, me):
            return True
        return _read_comm(ppid) in _SUBREAPER_COMMS


paths = LinuxPaths()
resource_probe = LinuxResourceProbe()
process_tree = LinuxProcessTree()
# PTY handling is plain POSIX; see `_posix`.
__all__ = ["paths", "process_tree", "resource_probe", "terminal_backend"]


# ---- appended: the Paths members added for the Windows port -----------------
#
# A subclass rather than edits to `LinuxPaths` above, so this lands as a pure
# append; `paths` is rebound below to the complete implementation.

from . import _posix_durable, _posix_paths, _posix_secrets  # noqa: E402


class LinuxLayout(LinuxPaths):
    def state_dir(self, app_name: str) -> Path:
        # `$XDG_DATA_HOME`, not `$XDG_CONFIG_HOME`: this is where `applog` has
        # always put the backend's state on Linux, and an install's sessions
        # and settings must stay findable across the move behind this seam.
        configured = os.environ.get("XDG_DATA_HOME")
        base = Path(configured) if configured else Path.home() / ".local" / "share"
        return base / app_name

    def config_home(self, home: Path) -> Path:
        return home / ".config"

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
        # `-i` for bash too: the stock Debian/Ubuntu ~/.bashrc, where nvm and
        # bun put their PATH lines, returns at once in a non-interactive shell.
        return _posix_paths.login_path_probe(interactive_bash=True)

    def login_path_fallbacks(self, home: Path) -> list[str]:
        # The dirs the Linux installers use and the session PATH omits: the
        # XDG-adjacent ones (uv, pnpm, `npm config set prefix`), the Rust and
        # bun toolchains, nvm's per-version bins, and snap's, which most
        # distributions leave off a .desktop-launched PATH.
        return [
            str(home / ".local" / "bin"),
            str(home / ".local" / "share" / "pnpm"),
            str(home / ".npm-global" / "bin"),
            # Where npm was actually told to install, when that is not the one
            # guessed above. See `npm_prefix_bins`.
            *_posix_paths.npm_prefix_bins(home),
            str(home / ".cargo" / "bin"),
            str(home / ".bun" / "bin"),
            *_posix_paths.nvm_node_bins(home),
            "/usr/local/bin",
            "/snap/bin",
        ]

    def login_path_tail_fallbacks(self, home: Path) -> list[str]:
        return []

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
        return _posix_paths.static_binaries_lack_resolver()

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


paths = LinuxLayout()
secret_files = _posix_secrets.secret_files
durable_secret_files = _posix_durable.durable_secret_files
scripts = _posix_paths.scripts

from . import _posix_scheduler  # noqa: E402

# crontab only: launchd does not exist here, so that kind lists as
# unsupported without ever spawning `launchctl`.
scheduler = _posix_scheduler.PosixScheduler(launchd=False)

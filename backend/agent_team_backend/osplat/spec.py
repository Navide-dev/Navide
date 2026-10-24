"""The contracts a platform implementation has to satisfy.

Named `osplat`, not `platform`, because `platform` is a stdlib module and a
package by that name inside the backend would shadow it for every importer.

Each Protocol here is a seam that already existed as a `sys.platform` branch
somewhere in the backend. Moving the branch here is the whole point: a feature
module asks the seam for a capability and never asks which OS it is running
on, so adding a platform means adding one implementation file rather than
finding every branch that needs a third arm.

A capability an implementation cannot provide reports `available() is False`
rather than raising or guessing. Callers already tolerate that shape — it is
how `proc_rusage` behaved on every non-Darwin platform — so a partial port
degrades to "this panel shows nothing" instead of taking down the request.
"""

from __future__ import annotations

import re

import asyncio
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Callable, NamedTuple, Protocol


#: What `Paths.login_path_probe` makes the shell print in front of `PATH`.
#: Rc files chatter on stdout (banners, `neofetch`, a stray `echo`), and the
#: line that carries this prefix is the only one the caller may trust.
LOGIN_PATH_MARKER = "__NAVIDE_PATH__"


class Paths(Protocol):
    """Where this platform keeps the kinds of directory the backend looks in.

    These are *other* applications' conventions as much as our own: Navide
    reads the state directories of the coding CLIs and IDEs it integrates
    with, and each platform puts them somewhere different. Hard-coding one
    platform's layout is how `cli_vendors/cursor.py` ended up unable to find
    Cursor's database anywhere but macOS, even though the IDE ships on all
    three.
    """

    def app_support_dir(self, app_name: str, *, home: Path | None = None) -> Path:
        """The per-user state directory a desktop application of this name owns.

        macOS puts it under `~/Library/Application Support`, Linux under
        `$XDG_CONFIG_HOME` (or `~/.config`), Windows under `%APPDATA%`. This is
        the convention the whole VS Code family follows, Cursor included.

        `home` overrides the user's home directory, for the per-pane homes the
        credential vault builds. An explicit `home` wins over the XDG
        environment variables, which would otherwise point back at the real
        home and defeat the isolation.
        """
        ...

    def cache_dir(self, *, home: Path | None = None) -> Path:
        """The per-user cache directory: discardable, not backed up."""
        ...

    def state_dir(self, app_name: str) -> Path:
        """Where *this* application keeps its own state (`applog.app_data_dir`).

        Not the same as `app_support_dir` on Linux: the backend has always
        lived under `$XDG_DATA_HOME` (`~/.local/share`) there, and moving it
        to `~/.config` would strand every existing install's state. macOS and
        Windows have one directory for both roles.
        """
        ...

    def config_home(self, home: Path) -> Path:
        """The per-user config root under `home`, as `os.UserConfigDir()` sees it.

        `~/Library/Application Support` on macOS, `~/.config` on Linux,
        `%APPDATA%` (falling back to `home/AppData/Roaming`) on Windows. This
        is the convention Go CLIs follow (glab included), so it is what a
        caller needs to find such a tool's config when it has not been
        overridden by the tool's own environment variable.
        """
        ...

    def roaming_app_data(self) -> Path | None:
        """`%APPDATA%` on Windows; None where the concept does not exist.

        For the few tools that special-case Windows *by name* rather than via
        `config_home` — `gh` keeps `~/.config/gh` everywhere except under
        `%APPDATA%\\GitHub CLI` — so the caller can express "the Windows
        directory if there is one, else the POSIX default" without asking
        which platform it is on.
        """
        ...

    def system_dirs(self) -> list[Path]:
        """Folders that hold the OS, installed programs, or stored credentials and
        browser profiles; a chat attachment is never sent from inside one.

        POSIX: `/etc`, `/bin`, `/System`, the keychains ... Windows: `%SystemRoot%`,
        `%ProgramFiles%`, `%ProgramData%`, and the credential, DPAPI and browser
        profile folders under `%APPDATA%` / `%LOCALAPPDATA%`.
        """
        ...

    def home_env_var(self) -> str:
        """The environment variable naming the user's home: `HOME` or `USERPROFILE`."""
        ...

    def isolated_home_env(self, home_dir: Path) -> dict[str, str]:
        """Environment entries that move a child process's home and temp dir.

        POSIX children read `HOME` and `TMPDIR`; Windows children read
        `USERPROFILE` plus `TEMP`/`TMP`, and `HOME` too because several Node
        CLIs consult it first.
        """
        ...

    def env_name_key(self, name: str) -> str:
        """The identity under which this platform's process environment
        compares a variable name.

        POSIX names are case-sensitive, so the name is its own key and
        `minimax_data_dir` is a different variable from `MINIMAX_DATA_DIR`.
        Windows names are not: `CreateProcess` matches them case-insensitively
        and a child reads whichever spelling was set. A check that asks "is
        this name X?" compares the two keys, never the raw names.
        """
        ...

    def askpass_launcher(self, helper_py: Path, launch_argv: list[str]) -> Path:
        """The path git can exec as `GIT_ASKPASS` to run the helper.

        git execs `GIT_ASKPASS` directly, with no shell, so the answer is
        always a file the kernel (or cmd.exe) can start on its own.

        `launch_argv` runs this backend's own askpass entry mode -- this
        process's executable plus the flag -- and git's prompt is appended to
        it. A launcher written around it depends on nothing but the running
        build: a frozen backend has no `python` to promise, and the name
        usually resolves on Windows to the Store's alias stub, which answers
        git with an empty credential.

        Windows always writes a sibling `.cmd`, because it cannot exec a
        `.py`. POSIX writes a sibling `.sh` only when frozen and otherwise
        returns `helper_py` itself, made executable: a source checkout's
        `/usr/bin/env python3` shebang is the same interpreter `launch_argv`
        names.
        """
        ...

    def git_subprocess_env(self, askpass: str) -> dict[str, str]:
        """The environment that makes every prompt a git subprocess can raise
        go to `askpass` — git's own (HTTPS user/password) and, where ssh is
        the transport, ssh's (key passphrase, host-key confirmation).

        The backend runs git with no controlling terminal. `GIT_ASKPASS` alone
        covers only git's prompts: ssh reads `/dev/tty` for its own, fails
        when there is none, and honours `SSH_ASKPASS` only under a display or
        when `SSH_ASKPASS_REQUIRE=force` says so (OpenSSH ≥ 8.4). Linux is
        where this bites — no Keychain-backed agent holds the passphrase by
        default — so a push over ssh died with "Permission denied (publickey)"
        and nothing to answer. `GIT_TERMINAL_PROMPT=0` closes the last gap:
        with askpass declined, git fails fast instead of waiting on a tty.
        """
        ...

    def executable_candidates(self, name: str) -> list[str]:
        """The file names a command called `name` may have on disk here.

        POSIX: just `name`. Windows: `name` plus each `PATHEXT` suffix
        (`.exe`, `.cmd`, `.bat`, `.com`) unless `name` already carries one,
        in the order `shutil.which` would try them.
        """
        ...

    def is_executable(self, path: Path) -> bool:
        """Whether an existing file at `path` can be run.

        POSIX asks the mode bits (`os.access(X_OK)`); Windows has no such
        bit — a file is runnable because of its extension, which
        `executable_candidates` already chose — so it answers True.
        """
        ...

    def login_path_probe(self) -> list[str] | None:
        """argv that prints the user's login-shell `PATH`, or None when the
        platform has no login shell whose `PATH` differs from ours.

        Installers on POSIX write `PATH` exports into shell rc files, which a
        GUI-launched backend never read; the probe recovers them. Windows
        keeps `PATH` in the registry and the process already has it, so there
        is nothing to probe — None tells the caller to keep what it has.

        The line to read is the one prefixed with `LOGIN_PATH_MARKER`: the
        shell's own rc chatter shares stdout, and "the last line" was the
        motd on more than one machine.
        """
        ...

    def login_path_fallbacks(self, home: Path) -> list[str]:
        """Where user-installed tools live when the probe cannot answer.

        Merged into `PATH` after whatever the probe found (or in its place
        when the shell timed out), so a tool in one of these is found even
        with a heavy rc file or an exotic shell. Each platform's own
        conventions, mirroring `loginPathFallbacks` in src/shared/osplat.ts;
        entries that do not exist on disk are the caller's to drop. Windows
        has nothing to add: its `PATH` is the registry's and already complete.
        """
        ...

    def login_path_tail_fallbacks(self, home: Path) -> list[str]:
        """Tool dirs that may only ever FOLLOW the user's own `PATH`.

        `login_path_fallbacks` is prepended, which is right for a dir holding
        one copy of a tool and wrong for a version manager's per-version bins:
        ahead of `PATH` they outrank the interpreter the user actually chose.
        Appended, they still make a CLI installed under one of them findable
        (nothing earlier provides it) without displacing anything the user's
        shell put first. Entries that do not exist on disk are the caller's to
        drop.
        """
        ...

    def backend_entry_on_disk(self, entry: str) -> str:
        """The file a plugin manifest's bare `backend.entry` names on disk.

        Mirrors `backendEntryOnDisk` in the Electron main process: a bare
        name (no extension) gains `.exe` on Windows and stays as it is
        everywhere else; an entry with an explicit extension is never changed.
        """
        ...

    def enforces_posix_modes(self) -> bool:
        """Whether a file's mode bits mean anything on this platform.

        A check that a secret file is `0600` is meaningful on POSIX and
        vacuous on NTFS, where `st_mode` is synthesised and never restricts
        anyone — so a caller that would refuse an over-permissive file
        asks this first.
        """
        ...

    def file_name_refused(self, name: str) -> bool:
        """Whether this platform's filesystem reads *name* (one path part) as
        something other than a file of that name.

        False on POSIX. On Windows: a reserved device name (``CON``, ``NUL``,
        ``COM1`` ..., with any extension) opens the device, and a trailing dot
        or space is stripped, so two names land on one file. A caller writing
        names that arrived from elsewhere (a synced skill) asks this first.
        """
        ...

    def symlinks_available(self) -> bool:
        """Whether this process may create symbolic links.

        Always on POSIX. On Windows `os.symlink` needs Developer Mode or an
        elevated token and otherwise fails with `WinError 1314`; the answer is
        probed once (a link in a temp dir) and cached, so a shim built from
        hundreds of links learns the answer up front rather than logging one
        failure per file.
        """
        ...

    def needs_loopback_dns_proxy(self) -> bool:
        """Whether static (musl) CLI binaries need a loopback proxy to reach the network.

        True only on Android, where `/etc/resolv.conf` does not exist; false on
        every desktop platform, so their spawns never change.
        """
        ...

    def shell_command(self, command: str) -> list[str]:
        """argv that runs `command` through the platform's shell.

        `/bin/sh -c` on POSIX; `cmd.exe /d /s /c` on Windows (`/d` skips
        AutoRun, `/s` keeps the outer quotes intact).
        """
        ...

    def quote_arg(self, arg: str) -> str:
        """`arg` quoted as one word for a command line `shell_command` runs.

        `shlex.quote` on POSIX; `subprocess.list2cmdline` on Windows, which
        is the MSVCRT convention `cmd.exe` and every Windows program parse.
        A path with a space quoted the POSIX way (`'C:\\a b'`) reaches a
        Windows program with the apostrophes still attached.
        """
        ...

    def resolve_program(self, name_or_path: str, *, path: str | None = None) -> str | None:
        """Where a program called `name_or_path` actually is, or None.

        The one lookup every caller shares, so a stored binary override and a
        fresh PATH lookup can never disagree about which file they mean. On
        Windows that means `executable_candidates` order — a bare `claude` is
        npm's `claude.cmd` shim — and the answer keeps the extension, which is
        what `launch_kind` needs to read.

        `path` overrides the PATH searched, for a caller that is about to run
        the child with an environment of its own.
        """
        ...

    def launch_kind(self, program: str) -> str:
        """How this platform has to start `program`: "direct", "cmd" or "powershell".

        Always "direct" on POSIX: the kernel reads the shebang. On Windows
        `CreateProcess` can only start a real image, so a `.cmd`/`.bat` needs
        cmd.exe and a `.ps1` needs powershell.exe — which is why handing
        npm's `claude.cmd` straight to `subprocess` fails with WinError 193.
        """
        ...

    def launch_argv(self, program: str, args: Sequence[str] = ()) -> list[str]:
        """argv that starts `program` with `args`, interpreter included.

        `[program, *args]` wherever `launch_kind` is "direct"; the interpreter
        and its flags in front of it otherwise. The result goes to
        `subprocess` unchanged — it is not a shell command line — so a caller
        never has to quote anything itself.
        """
        ...

    def pty_launch_parts(
        self, program: str, args: Sequence[str] = (), *, path: str | None = None
    ) -> tuple[str, list[str]]:
        """`launch_argv` split the way a pseudo-terminal spawn wants it.

        ConPTY (through winpty-rs) takes the application name and the rest of
        the command line separately rather than one argv, so the terminal
        backend needs the head and the tail apart. POSIX hands back `program`
        and its args untouched.

        Windows looks through an npm-style `.cmd` shim first: when the file is
        recognisably one of the generated forms (npm's cmd-shim, yarn
        classic's, pnpm's) and does nothing but start `node.exe` on a script,
        the answer is that `node.exe` and script directly, so the pane holds
        the CLI itself — Ctrl-C reaches it and not a batch interpreter, the
        exit code is its own, and the job holds one process fewer. A shim
        that is anything else — an environment it sets, arguments it adds, a
        line the parser does not know — falls back to the cmd.exe wrapping of
        `launch_argv`; the shim is never interpreted, only matched. `path`
        is the PATH the pane will run with, searched for `node.exe` the way
        the shim would search for `node`.
        """
        ...


class ResourceProbe(Protocol):
    """Per-process memory and CPU, read from the kernel without a subprocess.

    Both numbers come back from one call because every platform that can answer
    cheaply answers both at once: Darwin's `proc_pid_rusage` fills one struct,
    and Linux's `/proc/<pid>/` entries are two reads of the same directory.
    Splitting them would double the syscall count for the panel that wants
    both.
    """

    def available(self) -> bool:
        """Whether this probe can be used at all on this machine."""
        ...

    def sample(self, pids: list[int]) -> dict[int, tuple[int, float]]:
        """`{pid: (memory bytes, accumulated CPU seconds)}` for what answered.

        A pid that has died, or that belongs to another user, simply does not
        appear. Never raises.
        """
        ...

    def memory_kind(self) -> str:
        """Which memory counter `sample` reports, for the UI to label honestly.

        The platforms do not measure the same thing: Darwin reports
        `phys_footprint`, Linux reports proportional set size. Both charge
        shared pages once across the processes sharing them, which is the
        property that matters, but they are not interchangeable figures and a
        panel that says "Memory" without qualification invites a bug report
        comparing it against the wrong system tool.
        """
        ...

    def peak_rss_bytes(self) -> int | None:
        """This process's peak resident set size in bytes, or None when unknown.

        POSIX reads `getrusage(RUSAGE_SELF).ru_maxrss` — bytes on Darwin,
        kilobytes on Linux, which is why the conversion lives in the
        implementation and not in the caller. Windows reports `PeakWorkingSetSize`.
        """
        ...


class ProcInfo(NamedTuple):
    """One row of a process-table snapshot.

    A plain tuple on purpose: `terminals` and `pty_registry` index the rows
    positionally, and tests build them as bare tuples.
    """

    #: Parent pid.
    ppid: int
    #: The unit a group kill reaches. POSIX: the process group id. Windows has
    #: no process groups, so every process is its own group (`gid == pid`) and
    #: `kill_group` takes the subtree rooted there instead.
    gid: int
    #: Start-time identity string, "" when unknown. Two rows with the same pid
    #: and the same non-empty `start` are the same process; a recycled pid gets
    #: a different one. POSIX uses `ps lstart`, Windows the creation time.
    start: str


class ProcessTree(Protocol):
    """Enumerate, identify and kill processes and their descendants.

    Every kill raises `ProcessLookupError` when the target is already gone and
    `PermissionError` when it belongs to someone else, whatever the platform,
    so callers keep one `except` clause.

    `force` selects the signal on POSIX: False sends SIGTERM (the CLI gets to
    flush its transcript), True sends SIGKILL. Windows has no graceful signal
    at all — both map to `TerminateProcess`/`TerminateJobObject`, so a Windows
    CLI never sees a shutdown notice before it dies.
    """

    def snapshot(self) -> dict[int, ProcInfo]:
        """Every visible process, from one table read. Empty when the probe failed."""
        ...

    def descendants(self, pid: int) -> list[int]:
        """Every pid below `pid` (children, grandchildren, ...) from one snapshot."""
        ...

    def group_of(self, pid: int) -> int:
        """The group id a `kill_group` on this process needs; ProcessLookupError when gone."""
        ...

    def start_time(self, pid: int) -> str:
        """The `ProcInfo.start` identity string for one pid, "" when unknown."""
        ...

    def identity(self, pid: int) -> str:
        """`"<pid>:<start_time>"` — stable across exec, different after pid reuse;
        "" when the start time could not be read (a failed probe is not an answer)."""
        ...

    def command_of(self, pid: int) -> str | None:
        """The process's command line; "" when no such process, None when the probe failed."""
        ...

    def is_alive(self, pid: int) -> bool:
        """Whether a process with this pid currently exists."""
        ...

    def is_orphan_parent(self, ppid: int, me: int) -> bool:
        """Whether a `snapshot()` ppid means the real parent is gone (init or `me` on POSIX, 0 on Windows)."""
        ...

    def parent_to_follow(self, env: Mapping[str, str]) -> int | None:
        """The pid whose death should end this backend, or None when the OS does that itself.

        The app names itself in `AGENT_TEAM_PARENT_PID` when it spawns the
        backend. On POSIX nothing ties a child's life to its parent's -- a
        crashed or SIGTERMed Electron leaves the backend running, reparented,
        still holding the port file for the next launch to fight over -- so
        the backend polls this pid and shuts down when it is gone. Windows
        starts the backend inside a Job Object with KILL_ON_JOB_CLOSE, which
        already takes it down with the app, so it returns None and no thread
        is started. Also None when the variable is absent: a backend nobody
        spawned from the app (tests, a developer's terminal) follows nothing.
        """
        ...

    def kill(self, pid: int, *, force: bool) -> None:
        """Signal one process (SIGTERM/SIGKILL; TerminateProcess on Windows)."""
        ...

    def kill_group(self, gid: int, *, force: bool) -> None:
        """Signal a whole group: killpg on POSIX, the job/subtree rooted at `gid` on Windows."""
        ...

    def kill_tree(self, pid: int, *, force: bool) -> None:
        """Kill `pid` and every descendant, including ones that left its group."""
        ...

    def contain(self, pid: int) -> int | None:
        """Make a child the root of a tree `end_contained` can end whole.

        On Windows the child joins a Job Object that kills its processes when
        closed (processes it starts afterwards join too); its handle is
        returned, so the caller can end that job and no other. On POSIX it
        must have been started in a session of its own (`start_new_session`);
        that is already the tree, so nothing is done and None is returned.
        """
        ...

    def end_contained(self, pid: int, job: int | None = None) -> None:
        """Kill the tree `contain` made for `pid`, everything in it, even when
        the root itself has exited: killpg on POSIX, closing the job on Windows.

        With `job` (what `contain` returned) only that job is closed, and the
        table entry for `pid` is dropped only while it is still that job's."""
        ...

    def isolate_stdin_from_children(self) -> bool:
        """Stop children that are not given a stdin from inheriting this one.

        On Windows the app keeps the backend's stdin open for the `shutdown`
        line and a thread waits in a synchronous read on it. A child handed
        that same pipe blocks on its first query of the handle until the read
        returns, which is at shutdown (git.exe and node.exe hung at launch).
        This points the process's standard input handle -- what a spawn
        without its own stdin hands down -- at NUL, while the already-open
        `sys.stdin` keeps reading the pipe. True when it did; POSIX has
        nothing to do and returns False."""
        ...

    def stderr_handle_info(self) -> str:
        """For a child that could not be started: this process's standard
        error handle as the OS reports it (Windows), "" elsewhere. Diagnostics
        only."""
        ...


class ChildProcess(Protocol):
    """The slice of `subprocess.Popen` a terminal session relies on."""

    pid: int
    returncode: int | None

    def poll(self) -> int | None:
        """Exit code once the child has exited, None while it runs."""
        ...

    def wait(self, timeout: float | None = None) -> int:
        """Block for the exit code; `subprocess.TimeoutExpired` after `timeout`."""
        ...


class TerminalHandle(Protocol):
    """One spawned terminal: its byte streams, its size and its child.

    Readability reaches the event loop through `start_reading`: on POSIX the
    handle registers its master fd with `loop.add_reader`, on Windows a worker
    thread pumps the ConPTY pipe and wakes the loop with
    `call_soon_threadsafe`. Either way the callback runs on the loop thread
    and drains with `read` until `BlockingIOError`, so the caller has exactly
    one code path.
    """

    #: The child's pid.
    pid: int
    #: The child, for `poll`/`wait`/`returncode`.
    proc: ChildProcess

    def read(self, max_bytes: int) -> bytes | None:
        """Up to `max_bytes` of output; None at EOF; BlockingIOError when nothing is ready."""
        ...

    def write(self, data: bytes) -> int:
        """Bytes accepted (may be fewer); BlockingIOError when none could be taken now."""
        ...

    def resize(self, rows: int, cols: int) -> None:
        """Change the terminal size (SIGWINCH on POSIX, ResizePseudoConsole on Windows)."""
        ...

    def foreground_group(self) -> int:
        """The group in front of the tty (tcgetpgrp), 0 when unknown; the child's pid on Windows."""
        ...

    def start_reading(
        self, loop: asyncio.AbstractEventLoop, callback: Callable[[], None]
    ) -> None:
        """Arrange for `callback()` on the loop thread whenever output is readable."""
        ...

    def pause_reading(self) -> None:
        """Stop readability callbacks (backpressure); output stays queued in the kernel/pump."""
        ...

    def resume_reading(self) -> None:
        """Undo `pause_reading`; ValueError/OSError when the handle can no longer be watched."""
        ...

    def stop_reading(self) -> None:
        """Detach the readability callback for good (close path)."""
        ...

    def watch_writable(
        self, loop: asyncio.AbstractEventLoop, callback: Callable[[], None]
    ) -> None:
        """Arrange for `callback()` once `write` would accept more bytes."""
        ...

    def unwatch_writable(self) -> None:
        """Cancel `watch_writable`; a no-op when nothing is being watched."""
        ...

    def close(self) -> None:
        """Release the terminal (master fd / pseudoconsole and job). Idempotent."""
        ...


class TerminalBackend(Protocol):
    """Spawn a child on a pseudo-terminal."""

    helper_waits_for_child: bool = False
    #: Whether a handle's foreground_group() tells the shell apart from a
    #: program it started (tcgetpgrp). False on Windows, whose handle reports
    #: the child's own pid whatever runs in front.
    reports_foreground: bool = False

    def parse_command(self, command: str) -> list[str]:
        """Split a command-line string into argv the way this platform's shell would."""
        ...

    def self_check_conpty(self) -> tuple[bool, str]:
        """Prove a real pseudo-terminal can be opened here, for CI to gate on.

        Returns ``(ok, message)``. POSIX has no packaging risk around its pty
        and returns ``(True, ...)`` without spawning anything. Windows freezes
        winpty's ``OpenConsole.exe`` into the bundle; when it is missing the
        pseudoconsole is torn down at once and the child dies with
        ``STATUS_CONTROL_C_EXIT`` — so there it spawns a real ConPTY and
        fails on that. Run against the FROZEN exe (``--self-check conpty``),
        where the unit tests cannot see whether the bootloader laid the file
        out where ``conpty.dll`` finds it.
        """
        ...

    def spawn(
        self,
        argv: list[str] | str,
        *,
        cwd: str,
        env: dict[str, str],
        rows: int,
        cols: int,
    ) -> TerminalHandle:
        """Start `argv` (a string is a ready-made command line on Windows) on a new terminal.

        The returned handle owns everything the spawn created; on failure
        nothing is left open. `FileNotFoundError` when argv[0] cannot be found.
        """
        ...


class SecretFiles(Protocol):
    """Files that hold a secret: private keys, tokens, vault fallbacks.

    POSIX protects these with mode bits — `0600` on the file, `0700` on the
    directory — and `os.chmod` does exactly that. On NTFS the same call
    silently does nothing (Python maps it to the read-only attribute), which
    is how a "0600" private key ends up readable by every account on a shared
    Windows machine. The seam exists so a feature module says *what* it wants
    ("this is a secret") and the platform decides *how*.

    Two write shapes, because two audiences read these files:

    - `write_private` is for content only this backend reads back (device
      keys, MCP auth tokens, credential-vault slots). Windows encrypts it with
      DPAPI, so the file is useless to any other account — and to any other
      *program* too, which is why it must not be used for the second kind.
    - `write_private_plain` is for a secret another process consumes as-is:
      the ws token Electron reads, the header file curl loads, the MCP config
      a CLI parses. POSIX gives it the same 0600; Windows has to write it in
      the clear and protects it with an owner-only ACL instead (`icacls`,
      see `_windows`).
    """

    def write_private(self, path: Path, data: bytes) -> None:
        """Atomically replace `path` with `data`, readable by this user's backend only."""
        ...

    def write_private_plain(self, path: Path, data: bytes) -> None:
        """Atomically replace `path` with `data` as-is, owner-only where the platform can."""
        ...

    def read_private(self, path: Path) -> bytes:
        """The content written by `write_private`, or a legacy plaintext file.

        Raises `OSError` (including `FileNotFoundError`) like a plain read.
        """
        ...

    def harden_file(self, path: Path) -> None:
        """Take an existing file down to owner-only, if the platform can express it."""
        ...

    def make_private_dir(self, path: Path) -> None:
        """Create `path` (and parents) and make the leaf owner-only."""
        ...


class DurableSecretFiles(Protocol):
    """A secret file that has to survive a power cut and is never read or
    written through a link: fsync on the file and its directory, every byte
    written, `O_NOFOLLOW`. Windows has no such writer and uses DPAPI through
    `SecretFiles` instead.

    Separate from `SecretFiles` because that writer is shared with CLI account
    slots and is left exactly as it was.
    """

    def read(self, path: Path) -> bytes:
        """The file's bytes. Raises `OSError` (including `FileNotFoundError`)."""
        ...

    def write(self, path: Path, data: bytes) -> None:
        """Atomically and durably replace `path` with `data`, owner-only."""
        ...


class SchedulerError(Exception):
    """A scheduler operation failed for an operational reason.

    Callers surface the message to the user verbatim (it usually carries the
    failing command's stderr), so keep messages human-readable.
    """


class Scheduler(Protocol):
    """The machine's registered background jobs, by kind.

    Kinds are the `executions.*` WebSocket contract: `"crontab"` (the user's
    cron table) and `"launchagent"` (launchd jobs under
    `~/Library/LaunchAgents` and the two system directories). A kind the
    platform does not have — launchd off macOS, both on Windows — lists as
    `{"supported": False, "entries": [], ...}` rather than raising, and its
    mutations raise `SchedulerError` naming the platform. Nothing here may
    spawn a helper for a kind it reports unsupported.

    Windows Task Scheduler (`schtasks`) is deliberately not wired: it is a
    different model (triggers, principals, XML task definitions) and would
    need its own kind and UI, so the Windows implementation reports both
    kinds unsupported and stays inert. The premise that makes this a
    decision rather than a gap: Navide never creates scheduled jobs of its
    own on any platform — this seam only reads and edits what the user set
    up — and Task Scheduler already manages the machine's tasks. Revisit
    only if Navide starts registering tasks itself, as a third kind over
    the PowerShell `ScheduledTasks` module (locale-independent state and
    trigger data; `schtasks` output is localised and OEM-encoded).
    """

    async def list_jobs(self, kind: str) -> dict:
        """`{"supported", "entries", "error", ...}` for one kind; never raises."""
        ...

    async def set_enabled(self, kind: str, target: str, enabled: bool) -> None:
        """Enable or disable one job; `SchedulerError` on failure."""
        ...

    async def remove(self, kind: str, target: str) -> None:
        """Delete one job; `SchedulerError` on failure."""
        ...


class Scripts(Protocol):
    """Text the platform's own shell runs: hook commands, and terminal prompts.

    Three of the things the backend writes are *programs for a shell* rather
    than argv, and each is read back by something that picked the shell for
    us. Claude Code runs a hook's `command` under Git Bash on Windows, or
    PowerShell when Git Bash is absent, and the hook entry says which with a
    `shell` field; Copilot's hook file carries a `bash` and a `powershell`
    spelling side by side and picks at fire time; and the "confirm, then run"
    line goes to whichever terminal the app opens, `cmd`/PowerShell on
    Windows.

    So the renderer is the seam, not the caller: `osplat.scripts` is this
    machine's, and `osplat.scripts_by_shell` names both for the one file that
    has to carry a shell this machine is not running.
    """

    def hook_entry(self, command: str) -> dict:
        """`command` as a Claude Code hook entry, declaring its shell.

        POSIX: `{"type": "command", "command": ...}`, unchanged from what the
        installer has always written. Windows adds `"shell": "powershell"`,
        without which Claude Code falls back to Git Bash and finds nothing to
        run this text with when it is not installed.
        """
        ...

    def hook_post_json(
        self,
        *,
        port_file: str,
        header_file: str,
        url_path: str,
        event: str,
        timeout_s: int,
        keep_body: bool = False,
        exit_zero: bool = False,
        env_header: tuple[str, str] | None = None,
    ) -> str:
        """A one-liner that POSTs the hook's stdin JSON to the running backend.

        `port_file` is read when the hook fires, not now, so the command
        survives a backend restart on a different port, and its absence (no
        backend) makes the whole thing a no-op. `header_file` is the
        owner-only file curl loads the auth header out of -- the secret is
        never written into the command, which lands in a world-readable
        settings file.

        `keep_body` keeps curl's stdout, which is where the CLI reads a hook's
        decision from; everything else discards it. `exit_zero` ends the line
        with an unconditional success, for a CLI that reads a non-zero exit as
        a hook failure (Copilot) rather than as "nothing to report".

        `env_header` is (header name, environment variable): the header is sent
        with that variable's value as the hook sees it when it fires, so a
        value only the CLI's own process tree carries (Navide's per-pane guard
        token) reaches the backend; unset, the value is empty.
        """
        ...

    def hook_rewake(
        self, *, port_file: str, header_file: str, url_path: str, timeout_s: int
    ) -> str:
        """The parked-waiter variant: the body goes to stderr and exit 2 wakes the agent.

        Backgrounded by the CLI, which reads only the exit code, so the
        response body has to travel on stderr. An empty body, a missing port
        file, or a refused connection all exit 0, which is "nothing to
        report".
        """
        ...

    def confirm_then_run(self, description: str, command: str) -> str:
        """A script that prints `description`, asks for y/N, and runs `command` on yes.

        Handed to a terminal the app opens, so it has to be that terminal's
        language: sh on POSIX, PowerShell on Windows (`external-terminal.ts`
        runs it through `powershell -NoExit -Command` there).
        """
        ...


#: Device names Windows reserves in every directory, with any extension.
#: COM/LPT take the superscript digits too (Win32 namespace rules), and
#: CONIN$/CONOUT$ are the console's own.
_WINDOWS_RESERVED = re.compile(r"(?i)^(con|prn|aux|nul|conin\$|conout\$|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])$")


#: An 8.3 short name: up to six characters, ~ and a number, an extension of
#: up to three ("REFERE~1.MD"). Only that shape — "v1~2.md" is a long name.
_SHORT_NAME = re.compile(r"^[^.]{1,6}~\d+(\.[^.]{1,3})?$", re.IGNORECASE)


def windows_short_name(name: str) -> bool:
    """Whether *name* has the shape of an 8.3 short name ("REFERE~1.MD"):
    on Windows it may open the long-named file it stands for, another
    spelling of a path already there. Asked by the Windows file-name seam
    only, not by the portability rule every install applies, since a name
    like "v1~2.md" is an ordinary file everywhere else."""
    return bool(_SHORT_NAME.match(name))


def windows_refused_file_name(name: str) -> bool:
    """``Paths.file_name_refused`` as Windows answers it. A pure string rule,
    kept here so the tests of any platform can exercise it.

    The device check is on the part before the first dot with trailing
    spaces dropped, which is how Windows reads ``con .txt``."""
    if not name:
        return False
    return name[-1] in ". " or bool(_WINDOWS_RESERVED.match(name.split(".", 1)[0].rstrip(" ")))

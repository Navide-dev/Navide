"""The `Paths` members Darwin and Linux answer identically.

Both are POSIX from the point of view of a child process — `HOME`, `TMPDIR`,
a shebang the kernel honours — so the two implementation modules delegate
here rather than carrying the same three functions twice. What they do *not*
share (the config and state roots) stays in each module.
"""

from __future__ import annotations

import logging
import shlex
import stat
import sys
from pathlib import Path

from . import spec

log = logging.getLogger(__name__)


def home_env_var() -> str:
    return "HOME"


def roaming_app_data() -> Path | None:
    return None


# One list for macOS and Linux: a folder that does not exist on one simply never matches.
_POSIX_SYSTEM_DIRS = (
    "/etc", "/private/etc", "/bin", "/sbin", "/usr/bin", "/usr/sbin", "/usr/libexec", "/boot",
    "/proc", "/sys", "/dev", "/run", "/var/run", "/var/spool", "/root", "/var/root",
    "/private/var/root", "/System", "/Library/Keychains", "/private/var/db", "/var/db", "/var/lib",
)
# Home-relative credential dot folders, shared with the Windows list (osplat/_windows.py).
_DOT_SECRET_DIRS = (
    ".ssh", ".aws", ".azure", ".config/gcloud", ".gnupg", ".kube", ".docker", ".config/gh",
    ".git-credentials", ".config/git/credentials", ".password-store", ".local/share/keyrings",
    ".config/google-chrome", ".config/chromium", ".config/BraveSoftware", ".config/microsoft-edge",
    ".mozilla",
    # Navide's own CLI account slots and per-pane CLI homes.
    ".navide", ".codex-panes",
)
# Per-user folders holding credentials, browser profiles (cookies, saved logins) and
# private messages: macOS keeps them under ~/Library, Linux and the CLIs in dot folders
# (a pane may send hidden files, so these must be listed). Absent folders never match.
_POSIX_USER_SECRET_DIRS = (
    "Library/Keychains", "Library/Cookies", "Library/Safari", "Library/Messages", "Library/Mail",
    "Library/Accounts", "Library/Group Containers", "Library/Containers",
    "Library/Application Support/Google/Chrome", "Library/Application Support/Firefox",
    "Library/Application Support/Microsoft Edge", "Library/Application Support/BraveSoftware",
    "Library/Application Support/com.apple.TCC", "Library/Application Support/1Password",
    "Library/Application Support/Arc", "Library/Application Support/Vivaldi",
    "Library/Application Support/com.operasoftware.Opera", "Library/Application Support/Chromium",
    "Library/Application Support/Slack", "Library/Application Support/discord",
    "Library/Application Support/Signal", "Library/Application Support/Telegram Desktop",
    "Library/Application Support/Code/User/globalStorage", "Library/Preferences",
    # Snap-packaged apps (Chromium, Firefox ...) keep their profiles under ~/snap on Linux.
    "snap",
    # Dot folders holding keys, cloud and CLI logins, keyrings and browser profiles.
    *_DOT_SECRET_DIRS,
)


def system_dirs() -> list[Path]:
    home = Path.home()
    return [Path(p) for p in _POSIX_SYSTEM_DIRS] + [home / rel for rel in _POSIX_USER_SECRET_DIRS]


def isolated_home_env(home_dir: Path) -> dict[str, str]:
    home = str(home_dir)
    return {"HOME": home, "TMPDIR": home}


def env_name_key(name: str) -> str:
    return name


def askpass_launcher(helper_py: Path, launch_argv: list[str]) -> Path:
    """The `.py` itself, or a `.sh` around `launch_argv` in a frozen build.

    From a source checkout the answer stays what it has always been: git execs
    the script and the kernel runs its `/usr/bin/env python3` shebang. A
    frozen build has no `python3` to promise — it ships one inside itself —
    so it gets a sibling `.sh` that runs its own askpass entry mode and passes
    git's prompt through.

    Best effort on both writes: a helper on a read-only volume is still worth
    pointing git at, and git reports the exec failure itself.
    """
    if getattr(sys, "frozen", False):
        launcher = helper_py.with_suffix(".sh")
        argv = " ".join(shlex.quote(part) for part in launch_argv)
        content = f'#!/bin/sh\nexec {argv} "$@"\n'.encode("utf-8")
        try:
            existing = launcher.read_bytes()
        except OSError:
            existing = b""
        try:
            # Rewritten only when its content differs, so a launcher that is
            # already right keeps its mtime and no other process sees it flicker.
            if existing != content:
                launcher.write_bytes(content)
            launcher.chmod(0o755)
        except OSError as err:
            log.warning("cannot write git askpass launcher %s: %s", launcher, err)
        return launcher

    try:
        helper_py.chmod(helper_py.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    except OSError:
        pass
    return helper_py



# ---- appended: the members added for the Windows port ------------------------

import os  # noqa: E402
import shutil  # noqa: E402
from collections.abc import Sequence  # noqa: E402


def executable_candidates(name: str) -> list[str]:
    return [name]


def is_executable(path: Path) -> bool:
    return os.access(path, os.X_OK)


#: What the probe runs: `printf` rather than `echo` so the marker and the
#: value land on one line whatever the rc files printed before it.
LOGIN_PATH_PROBE_SCRIPT = f'printf "{spec.LOGIN_PATH_MARKER}%s\\n" "$PATH"'


def login_path_probe(*, interactive_bash: bool = False) -> list[str]:
    """The shell invocation used to read the user's real PATH.

    Uses $SHELL, not bash: installers write PATH exports into the user's own
    shell config. For zsh that file is ~/.zshrc, which zsh only reads in
    INTERACTIVE mode — a plain login shell (-lc) misses it (real case: grok's
    installer writes to ~/.zshrc; `zsh -lc` couldn't see it, so both detection
    and spawn kept failing with command-not-found after install).

    `interactive_bash` asks the same of bash. Linux wants it: the nvm, bun and
    `npm config set prefix` instructions all append to ~/.bashrc, and the
    Debian/Ubuntu stock ~/.bashrc returns at its first line unless the shell
    is interactive, so `bash -lc` sees ~/.profile and nothing else. macOS
    keeps `-lc` for bash — the shipped bash 3.2 rc files are not written with
    an interactive-but-headless shell in mind, and that is what shipped there.
    Same split as `loginShellFlags` in src/shared/osplat.ts.
    """
    shell = os.environ.get("SHELL") or _default_login_shell()
    name = os.path.basename(shell)
    interactive = name == "zsh" or (interactive_bash and name == "bash")
    return [shell, "-ilc" if interactive else "-lc", LOGIN_PATH_PROBE_SCRIPT]


def git_subprocess_env(askpass: str) -> dict[str, str]:
    return {
        "GIT_ASKPASS": askpass,
        "SSH_ASKPASS": askpass,
        "SSH_ASKPASS_REQUIRE": "force",
        "GIT_TERMINAL_PROMPT": "0",
    }


def nvm_node_bins(home: Path) -> list[str]:
    """Every `bin` nvm has installed under `home`, newest version first.

    nvm exports exactly one of these (the `default` alias) and only from the
    rc file the probe just failed to read, so which one the shell would have
    chosen is unknowable here. A CLI installed with `npm install -g` lives
    under the node version that installed it, so all of them go on `PATH`.
    """
    versions = home / ".nvm" / "versions" / "node"
    try:
        entries = [d for d in versions.iterdir() if (d / "bin").is_dir()]
    except OSError:
        return []

    def key(d: Path) -> tuple[int, ...]:
        digits = d.name.lstrip("v").split(".")
        return tuple(int(part) if part.isdigit() else 0 for part in digits)

    return [str(d / "bin") for d in sorted(entries, key=key, reverse=True)]


def _npmrc_prefix(home: Path) -> str:
    """The `prefix` setting in `~/.npmrc`, or "" when it sets none.

    A hand-rolled read of one key rather than `npm config get prefix`: that
    needs npm on PATH, which is precisely what is missing whenever this is
    asked. npm's own ini parser lets a later line win, so this keeps the last.
    """
    try:
        text = (home / ".npmrc").read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    found = ""
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped[0] in ";#[":
            continue
        key, sep, value = stripped.partition("=")
        if sep and key.strip() == "prefix":
            found = value.strip().strip("\"'")
    return found


def npm_prefix_bins(home: Path) -> list[str]:
    """`<prefix>/bin` when npm is configured to install globally somewhere else.

    `npm install -g` is how OpenAI ships codex, and `npm config set prefix`
    can point it anywhere. One report had `prefix=~/.npm`, putting codex in
    `~/.npm/bin` while the fallback list knew only `~/.npm-global/bin` — one
    letter apart and undetectable. No list of guessed directory names can
    cover a value the user chose, so read the value instead.
    """
    raw = (os.environ.get("npm_config_prefix") or "").strip() or _npmrc_prefix(home)
    if not raw:
        return []
    try:
        # npm expands both, and a prefix written as ~/.npm or ${HOME}/.npm is
        # a literal directory name to everyone else.
        bin_dir = Path(os.path.expandvars(raw)).expanduser() / "bin"
        # Absolute only. A relative PATH entry resolves against each child's
        # cwd, which for a CLI pane is the user's workspace — a repo carrying
        # its own `<prefix>/bin/node` would then outrank the real one for
        # everything Navide spawns.
        if not bin_dir.is_absolute():
            return []
        return [str(bin_dir)] if bin_dir.is_dir() else []
    except (OSError, ValueError, RuntimeError):
        # RuntimeError: expanduser on a "~user" that the passwd db has no home for.
        return []


def backend_entry_on_disk(entry: str) -> str:
    return entry


def enforces_posix_modes() -> bool:
    return True


def file_name_refused(name: str) -> bool:
    return False


def symlinks_available() -> bool:
    return True


def _system_sh() -> str:
    """`/bin/sh`, or where `sh` lives on a system without `/bin` (Android has
    only `/system/bin/sh`; Termux puts its own under its prefix)."""
    if os.path.exists("/bin/sh"):
        return "/bin/sh"
    return shutil.which("sh") or "/system/bin/sh"


def _default_login_shell() -> str:
    """`/bin/bash` when $SHELL is unset, falling back the same way as `sh`."""
    if os.path.exists("/bin/bash"):
        return "/bin/bash"
    return shutil.which("bash") or _system_sh()


def shell_command(command: str) -> list[str]:
    return [_system_sh(), "-c", command]


def static_binaries_lack_resolver() -> bool:
    """Whether a statically linked (musl) binary cannot resolve host names here.

    musl reads `/etc/resolv.conf` and nothing else; Android has no such file,
    so a static CLI such as Codex fails every lookup unless it is pointed at a
    loopback proxy that resolves through the system. Never true on a desktop.
    """
    return sys.platform == "android" and not os.path.exists("/etc/resolv.conf")


def quote_arg(arg: str) -> str:
    return shlex.quote(arg)


# ---- appended: finding a program and starting it ----------------------------


def resolve_program(name_or_path: str, *, path: str | None = None) -> str | None:
    return shutil.which(name_or_path, path=path)


def launch_kind(program: str) -> str:
    # Nothing to interpret: the kernel reads the shebang, so every runnable
    # file starts the same way.
    return "direct"


def launch_argv(program: str, args: Sequence[str] = ()) -> list[str]:
    return [program, *args]


def pty_launch_parts(
    program: str, args: Sequence[str] = (), *, path: str | None = None
) -> tuple[str, list[str]]:
    return program, list(args)


# ---- appended: the sh renderings of the scripts the backend writes -----------


# What a hook runs to POST its stdin to the backend when there is no curl.
# Ubuntu Desktop ships without curl (Server has it), and a hook that fails
# quietly there took every hook-driven feature with it. python3 is on every
# desktop Linux, so the same request is spelled with the standard library:
# argv carries port, path, event, header file and timeout so nothing here has
# to be quoted for sh. Errors go to stderr and exit non-zero, like curl -f.
_PY_POST = (
    "import os,sys,urllib.request as u\n"
    "p,q,e,h,t=sys.argv[1:6]\n"
    'H={"Content-Type":"application/json","X-Agent-Team-Event":e}\n'
    "if os.path.exists(h):\n"
    '    for l in open(h,encoding="utf-8"):\n'
    '        if ":" in l:\n'
    '            k,v=l.split(":",1);H[k.strip()]=v.strip()\n'
    'r=u.urlopen(u.Request("http://127.0.0.1:"+p+q,data=sys.stdin.buffer.read(),headers=H,method="POST"),timeout=float(t))\n'
    "sys.stdout.buffer.write(r.read())"
)
# The same request plus one header read from the environment at fire time;
# argv[6] is "<header>=<variable>". A separate text so every hook that does
# not need it stays byte-for-byte what is already installed.
_PY_POST_ENV_HEADER = _PY_POST.replace(
    "r=u.urlopen",
    'k,v=sys.argv[6].split("=",1)\n'
    "if os.environ.get(v):H[k]=os.environ[v]\n"
    "r=u.urlopen",
)


class PosixScripts:
    """sh, for every shell a POSIX box opens and for Claude Code's default.

    Also the `bash` half of Copilot's hook file on *every* platform: that file
    declares both spellings and picks at fire time, so it is written once and
    read wherever Copilot runs.
    """

    def hook_entry(self, command: str) -> dict:
        # No `shell` key: sh is what Claude Code runs a hook with here, and
        # adding one would rewrite every existing settings.json for nothing.
        return {"type": "command", "command": command}

    def _post(
        self, *, header_file: str, url_path: str, event: str, timeout_s: int, discard: bool,
        env_header: tuple[str, str] | None = None,
    ) -> str:
        """The request itself: JSON body from stdin, response to stdout unless
        `discard`. Decided when the hook is *written*: curl when this machine
        has it -- that text is byte-for-byte what every installed settings.json
        already holds -- and the python3 spelling otherwise."""
        if resolve_program("curl") is not None:
            sink = "-o /dev/null " if discard else ""
            extra = f'-H "{env_header[0]}: ${env_header[1]}" ' if env_header else ""
            return (
                f"curl -fsS -m {timeout_s} {sink}-X POST "
                f"-H 'Content-Type: application/json' "
                f"-H 'X-Agent-Team-Event: {event}' "
                f"-H @{shlex.quote(header_file)} {extra}"
                f"--data-binary @- "
                f'"http://127.0.0.1:$PORT{url_path}"'
            )
        script = _PY_POST_ENV_HEADER if env_header else _PY_POST
        return (
            f"python3 -c {shlex.quote(script)} \"$PORT\" "
            f"{shlex.quote(url_path)} {shlex.quote(event)} "
            f"{shlex.quote(header_file)} {timeout_s}"
            + (f" {shlex.quote(env_header[0] + '=' + env_header[1])}" if env_header else "")
            + (" >/dev/null" if discard else "")
        )

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
        tail = ' >/dev/null 2>&1; exit 0' if exit_zero else " || true"
        if exit_zero and keep_body:
            # The body is the answer (Copilot's guard hook), so only stderr
            # is silenced; the exit stays 0 because non-zero means deny there.
            tail = " 2>/dev/null; exit 0"
        post = self._post(
            header_file=header_file, url_path=url_path, event=event, timeout_s=timeout_s,
            discard=not keep_body, env_header=env_header,
        )
        return (
            f"PORT=$(cat {shlex.quote(port_file)} 2>/dev/null); "
            f'[ -n "$PORT" ] && {post}{tail}'
        )

    def hook_rewake(
        self, *, port_file: str, header_file: str, url_path: str, timeout_s: int
    ) -> str:
        post = self._post(
            header_file=header_file, url_path=url_path, event="rewake", timeout_s=timeout_s,
            discard=False,
        )
        return (
            f"PORT=$(cat {shlex.quote(port_file)} 2>/dev/null); "
            f'[ -n "$PORT" ] || exit 0\n'
            f"BODY=$({post} || true)\n"
            f'[ -n "$BODY" ] || exit 0\n'
            f"printf '%s\\n' \"$BODY\" >&2\n"
            f"exit 2"
        )

    def confirm_then_run(self, description: str, command: str) -> str:
        return (
            f"printf '%s\\n' {shlex.quote(description)}; "
            "printf 'Continue? [y/N] '; read -r answer; "
            f"case \"$answer\" in [Yy]*) {command} ;; *) echo 'Cancelled.' ;; esac"
        )


scripts = PosixScripts()

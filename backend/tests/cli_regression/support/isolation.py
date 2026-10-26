"""Environment and external-boundary isolation for fresh backend processes."""
from __future__ import annotations

import ipaddress
import asyncio
import json
import os
from pathlib import Path
import shlex
import shutil
import socket
import subprocess
import sys


CLI_NAMES = frozenset({
    "claude", "codex", "gemini", "kimi", "grok", "qwen", "opencode", "kilo",
    "kilocode", "cursor-agent", "agent", "copilot", "pi", "droid", "aider",
    "agy", "antigravity", "muse", "mcode", "goose",
})


def isolated_environment(root: Path) -> dict[str, str]:
    """Allow only OS runtime inputs; never inherit provider or shell settings."""
    keys = {
        "PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP",
        "TMPDIR", "LANG", "LC_ALL", "SYSTEMDRIVE", "NUMBER_OF_PROCESSORS",
    }
    env = {key: value for key, value in os.environ.items() if key.upper() in keys}
    # Shell children do not inherit Python's Popen/socket guards. Give them
    # only the platform utilities and this test interpreter, never the user's
    # npm/global/agent installation directories. Scenarios explicitly prepend
    # their own fake bin directory when testing a named vendor executable.
    if os.name == "nt":
        system_root = Path(os.environ.get("SystemRoot", r"C:\Windows"))
        system_paths = [system_root / "System32", system_root,
                        system_root / "System32" / "WindowsPowerShell" / "v1.0"]
    else:
        system_paths = [Path(path) for path in os.defpath.split(os.pathsep) if Path(path).is_absolute()]
    env["PATH"] = os.pathsep.join(str(path) for path in [Path(sys.executable).parent, *system_paths])
    home = root / "home"
    home.mkdir(parents=True, exist_ok=True)
    for key, path in {
        "HOME": home, "USERPROFILE": home, "ZDOTDIR": home,
        "APPDATA": root / "roaming", "LOCALAPPDATA": root / "local",
        "XDG_CONFIG_HOME": root / "config", "XDG_CACHE_HOME": root / "cache",
        "XDG_DATA_HOME": root / "share", "XDG_STATE_HOME": root / "state",
        "AGENT_TEAM_DATA_DIR": root / "data",
    }.items():
        path.mkdir(parents=True, exist_ok=True)
        env[key] = str(path)
    env.update(PYTHONUTF8="1", PYTHONUNBUFFERED="1", PYTHONNOUSERSITE="1")
    return env


def command_words(args) -> list[str]:
    def split(value):
        lexer = shlex.shlex(value, posix=os.name != "nt", punctuation_chars=";&|()")
        lexer.whitespace_split = True
        return list(lexer)

    if isinstance(args, (str, bytes, os.PathLike)):
        try:
            args = split(os.fsdecode(args))
        except ValueError:
            args = os.fsdecode(args).split()
    words: list[str] = []
    for value in args:
        text = os.fsdecode(value)
        words.append(text)
        # Shell command strings can hide a CLI after env assignments, pipes,
        # or a long wrapper prefix. Inspect all tokens, never just argv[:3].
        if any(char in text for char in " ;|&"):
            try:
                words.extend(split(text))
            except ValueError:
                pass
    return [word.strip("\"';|&()") for word in words]


_SHELLS = frozenset({"sh", "bash", "zsh", "dash", "ksh", "fish"})
_POWERSHELLS = frozenset({"powershell", "pwsh"})
_INTERPRETERS = frozenset({"node", "python", "python3", "pythonw", "py", "bun", "deno"})
# Run the rest of their argv as a command: `env FOO=1 codex`, `nohup codex`.
_PREFIXES = frozenset({"env", "exec", "command", "nohup", "nice", "time", "timeout"})
_SEPARATORS = frozenset({";", "&", "|", "&&", "||", "(", ")"})


def _program(word: str) -> str:
    # Windows paths split on either slash, whatever the host's own separator.
    name = word.replace("\\", "/").rsplit("/", 1)[-1].lower()
    return name.rsplit(".", 1)[0] if "." in name else name


def _shell_line_words(line: str) -> list[str]:
    """The executed word of every command in a shell line, never its data."""
    lexer = shlex.shlex(line, posix=os.name != "nt", punctuation_chars=";&|()")
    lexer.whitespace_split = True
    try:
        tokens = list(lexer)
    except ValueError:
        tokens = line.split()
    words: list[str] = []
    segment: list[str] = []
    for token in [*tokens, ";"]:
        if token in _SEPARATORS:
            words.extend(_argv_words(segment))
            segment = []
        else:
            segment.append(token.strip("\"'"))
    return words


def _argv_words(argv: list[str]) -> list[str]:
    """The word(s) an argv actually executes: argv[0], plus what a known
    wrapper hands control to. Arguments are data and are never classified --
    `security -s gemini` or `python x.py codex` start no CLI."""
    rest = list(argv)
    while rest and "=" in rest[0] and not rest[0].startswith(("-", "/")):
        rest.pop(0)  # VAR=value assignments before the command
    if not rest:
        return []
    head, args = rest[0], rest[1:]
    program = _program(head)
    if program in _PREFIXES:
        while args and (args[0].startswith("-") or "=" in args[0]):
            args.pop(0)
        if program == "timeout" and args:
            args.pop(0)  # the duration
        return [head, *_argv_words(args)]
    if program in _SHELLS:
        for index, arg in enumerate(args[:-1]):
            if arg.startswith("-") and not arg.startswith("--") and "c" in arg:
                return [head, *_shell_line_words(args[index + 1])]
        return [head]
    if program == "cmd":
        lowered = [arg.lower() for arg in args]
        for switch in ("/c", "/k"):
            if switch in lowered:
                return [head, *_shell_line_words(" ".join(args[lowered.index(switch) + 1:]))]
        return [head]
    if program in _POWERSHELLS:
        lowered = [arg.lower() for arg in args]
        for switch in ("-c", "-command"):
            if switch in lowered:
                return [head, *_shell_line_words(" ".join(args[lowered.index(switch) + 1:]))]
        return [head]
    if program in _INTERPRETERS:
        for arg in args:
            if arg in {"-c", "-e", "-m", "--eval", "-p", "--print"}:
                break  # inline code or a module: no script path to classify
            if not arg.startswith("-"):
                return [head, arg]
        return [head]
    return [head]


def executed_words(args) -> list[str]:
    if isinstance(args, (str, bytes, os.PathLike)):
        return _shell_line_words(os.fsdecode(args))
    return _argv_words([os.fsdecode(value) for value in args])


def real_cli_in(args, env, allowed_roots: tuple[Path, ...]) -> str | None:
    for word in executed_words(args):
        if "://" in word:
            continue  # HTTP hook URLs are data, never executable paths.
        stem = Path(word).stem.lower()
        if stem not in CLI_NAMES:
            continue
        found = word if os.path.dirname(word) else shutil.which(word, path=(env or os.environ).get("PATH"))
        if found and Path(found).is_file():
            resolved = Path(found).resolve()
            if not any(resolved.is_relative_to(root.resolve()) for root in allowed_roots):
                return str(resolved)
    return None


def install_external_guards(root: Path) -> None:
    """Install before app import; persist refusals even when callers catch them.

    This process is disposable. The terminal backend wrapper also covers
    Windows ConPTY's native spawn, which does not pass through Popen.
    """
    refusals = root / "refusals.jsonl"

    def refuse(kind: str) -> None:
        with refusals.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps({"boundary": kind}) + "\n")
        raise PermissionError(f"regression harness refused {kind}")

    original_popen = subprocess.Popen

    def launch_env(env):
        result = dict(os.environ if env is None else env)
        controlled = isolated_environment(root)["PATH"]
        fake_paths = [path for path in result.get("PATH", "").split(os.pathsep)
                      if path and Path(path).resolve().is_relative_to(root.resolve())]
        result["PATH"] = os.pathsep.join([*fake_paths, controlled])
        return result

    class GuardedPopen(original_popen):
        def __init__(self, args, *rest, **kwargs):
            if real_cli_in(args, kwargs.get("env"), (root,)):
                refuse("real CLI")
            if any(Path(word).name == "security" for word in command_words(args)):
                refuse("Keychain executable")
            kwargs["env"] = launch_env(kwargs.get("env"))
            super().__init__(args, *rest, **kwargs)

    subprocess.Popen = GuardedPopen
    original_connect = socket.socket.connect
    original_connect_ex = socket.socket.connect_ex
    original_getaddrinfo = socket.getaddrinfo

    def check(address):
        if not isinstance(address, tuple):
            return  # local UNIX sockets
        host = os.fsdecode(address[0])
        if host == "localhost":
            return
        try:
            if ipaddress.ip_address(host).is_loopback:
                return
        except ValueError:
            pass
        refuse("non-loopback network")

    def connect(sock, address):
        check(address)
        return original_connect(sock, address)

    def connect_ex(sock, address):
        check(address)
        return original_connect_ex(sock, address)

    socket.socket.connect = connect
    socket.socket.connect_ex = connect_ex

    def getaddrinfo(host, port, *args, **kwargs):
        if host is not None:
            check((host, port))
        return original_getaddrinfo(host, port, *args, **kwargs)

    socket.getaddrinfo = getaddrinfo

    # uvicorn[standard] selects uvloop on POSIX. Its C transport bypasses
    # socket.socket.connect and socket.getaddrinfo; Windows' proactor also
    # connects below that Python seam. Guard the actual loop classes while
    # leaving their implementations, scheduling and transport intact.
    def guard_loop(loop_type):
        original_connection = loop_type.create_connection
        original_dns = loop_type.getaddrinfo
        original_sock_connect = loop_type.sock_connect
        original_datagram = loop_type.create_datagram_endpoint

        async def create_connection(loop, protocol_factory, host=None, port=None, **kwargs):
            if host is not None:
                check((host, port))
            return await original_connection(loop, protocol_factory, host, port, **kwargs)

        async def resolve(loop, host, port, **kwargs):
            if host is not None:
                check((host, port))
            return await original_dns(loop, host, port, **kwargs)

        async def sock_connect(loop, sock, address):
            check(address)
            return await original_sock_connect(loop, sock, address)

        async def create_datagram(loop, protocol_factory, **kwargs):
            if kwargs.get("remote_addr") is not None:
                check(kwargs["remote_addr"])
            return await original_datagram(loop, protocol_factory, **kwargs)

        loop_type.create_connection = create_connection
        loop_type.getaddrinfo = resolve
        loop_type.sock_connect = sock_connect
        loop_type.create_datagram_endpoint = create_datagram

    guard_loop(asyncio.SelectorEventLoop)
    if hasattr(asyncio, "ProactorEventLoop"):
        guard_loop(asyncio.ProactorEventLoop)
    try:
        import uvloop
    except ImportError:
        pass  # not installed on Windows
    else:
        guard_loop(uvloop.Loop)

    from agent_team_backend import osplat
    spawn = osplat.terminal_backend.spawn

    def guarded_spawn(argv, **kwargs):
        if real_cli_in(argv, kwargs.get("env"), (root,)):
            refuse("real native CLI")
        kwargs["env"] = launch_env(kwargs.get("env"))
        return spawn(argv, **kwargs)

    osplat.terminal_backend.spawn = guarded_spawn
    # The real vault implementation still runs; only the external OS account
    # store is empty. A scenario needing credentials supplies its own fake.
    from agent_team_backend import credential_vault
    credential_vault._default_security_runner = lambda *_args, **_kwargs: (44, "")

"""Static danger classification of a CLI tool call.

Deterministic string/path analysis only — never an LLM (an LLM judge would be
injectable) and never a filesystem or network lookup (this runs inside a
synchronous PreToolUse hook, so it must stay in the millisecond range).

The first version is deliberately narrow: "critical" holds only a handful of
unambiguous patterns, because false positives are what make users switch a
guard off. Everything a pattern does not name is "normal".

``parseable=False`` means the command cannot be judged statically (eval,
variable expansion in a command word or in the target of a destructive op,
``base64 -d | sh``, executing a downloaded or unknown script, interpreter
``-c`` code). The policy layer treats that as "high" for tainted panes.
"""

from __future__ import annotations

import fnmatch
import os
import posixpath
import re
import shlex
from dataclasses import dataclass, field

from .. import osplat

LEVEL_ORDER = {"normal": 0, "high": 1, "critical": 2}

#: Longer shell commands are graded without being parsed (see classify()).
MAX_COMMAND_CHARS = 64_000

SHELL_TOOLS = {
    "shell", "bash", "exec", "exec_command", "local_shell", "run_shell_command",
    "shell_command", "run_command", "terminal", "powershell",
}
WRITE_TOOLS = {
    "write", "edit", "multiedit", "notebookedit", "write_file", "edit_file",
    "replace", "apply_patch", "str_replace_editor", "create",
}
READ_TOOLS = {"read", "read_file", "view", "cat", "notebookread"}
#: Search tools: grep reads the contents under its path (like a read), glob
#: lists names (like ls). Grep's pattern is the text searched for, not a path.
#: Qwen Code calls its grep `grep_search`; Copilot CLI offers `grep` or `rg`.
GREP_TOOLS = {"grep", "grep_search", "rg"}
GLOB_TOOLS = {"glob"}
#: Third-party MCP tools that do what a built-in tool does, graded by the same
#: rules. Vendors name them `mcp__<server>__<tool>`; only <tool> is looked up,
#: exactly and case-folded, so a server's own name never decides anything and
#: a tool that merely contains "shell" in its name is not caught. Values: a
#: SHELL_TOOLS name (the call's `command` is graded as that shell), a
#: WRITE_TOOLS / READ_TOOLS name (its path fields are graded as that tool's),
#: "process-input" (`input` is graded as a shell command), "write-pdf" (`path`
#: and `outputPath` are writes), or one of MCP_ACTIONS (see
#: _classify_mcp_action). A "shell" row is graded in the dialect its `shell`
#: argument names, or as both POSIX and PowerShell when it names none. Add a
#: row for each server tool verified to take these arguments.
MCP_TOOLS = {
    # Windows-MCP (CursorTouch/Windows-MCP): PowerShell(command), FileSystem(mode,
    # path, destination, recursive), Registry(mode, path), Process(mode, name, pid).
    "powershell": "powershell",
    "filesystem": "filesystem",
    "registry": "registry",
    "process": "process",
    # Generic shell tools: `command` holds the command line.
    "bash": "bash",
    "shell": "shell",
    "run_command": "run_command",
    "run_shell_command": "run_shell_command",
    "shell_command": "shell_command",
    "exec_command": "exec_command",
    "execute_command": "shell",
    # Desktop Commander (wonderwhy-er/DesktopCommanderMCP, src/tools/schemas.ts):
    # start_process(command), interact_with_process(pid, input) types into a
    # running process (often a shell), kill_process / force_terminate(pid),
    # file tools on `path` / `paths` / `file_path`, move_file(source, destination).
    "start_process": "shell",
    "interact_with_process": "process-input",
    "kill_process": "process-kill",
    "force_terminate": "process-kill",
    "write_file": "write",
    "write_pdf": "write-pdf",
    "create_directory": "write",
    "edit_block": "edit",
    "read_file": "read",
    "read_multiple_files": "read",
    "move_file": "move-file",
}
#: MCP_TOOLS kinds that act through arguments rather than a command line.
MCP_ACTIONS = {"filesystem", "registry", "process", "process-kill", "move-file"}
#: The modes each mode-driven kind accepts; any other mode is not judged.
_MCP_MODES = {
    "filesystem": {"read", "write", "copy", "move", "delete", "list", "search", "info"},
    "registry": {"get", "set", "delete", "list"},
    "process": {"list", "kill"},
}
_FALSE_WORDS = {"", "0", "false", "f", "no", "n", "off", "none"}

WRAPPERS_NO_ARG = {"nohup", "time", "command", "builtin", "exec", "caffeinate", "stdbuf"}
SHELLS = {"sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh"}
INTERPRETERS = SHELLS | {
    "python", "python2", "python3", "perl", "ruby", "node", "php", "osascript",
    "deno", "bun", "pwsh",
}
DOWNLOADERS = {"curl", "wget", "fetch", "http", "https", "aria2c"}
DECODERS = {"base64", "base32", "xxd", "openssl", "gunzip", "zcat", "uudecode"}
LIST_ONLY = {"ls", "stat", "test", "[", "[[", "file", "du", "exa", "eza", "tree"}
NON_PATH_CMDS = {"echo", "printf", "true", "false", ":", "export", "unset", "alias"}
LEADING_KEYWORDS = {"if", "then", "else", "elif", "do", "while", "until", "!", "{", "}", "fi", "done"}
SKIP_SEGMENT_KEYWORDS = {"for", "case", "esac", "select", "function"}
PUBLISH = {
    ("npm", "publish"), ("pnpm", "publish"), ("yarn", "publish"), ("twine", "upload"),
    ("uv", "publish"), ("poetry", "publish"), ("cargo", "publish"), ("gem", "push"),
    ("flit", "publish"), ("hatch", "publish"),
}
PROTECTED_BRANCHES = {"main", "master"}
SYSTEM_BIN_PREFIXES = (
    "/usr/", "/bin/", "/sbin/", "/opt/homebrew/", "/opt/local/", "/Applications/",
    "/System/", "/Library/", "/nix/",
)
_TEMP_ROOTS = ("/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp", "/var/folders", "/private/var/folders")
_GLOB_CHARS = set("*?[")
# Every path is compared in one canonical form: '/'-separated and, on
# Windows, drive-lettered. Case is folded where the default filesystem is
# case-insensitive (NTFS, APFS), so ~/.SSH/id_rsa is the same file as
# ~/.ssh/id_rsa there; Linux filesystems are case-sensitive, so it is not.
_WINDOWS = osplat.platform_id == "win32"
_FOLD_CASE = osplat.platform_id in ("darwin", "win32")
_DRIVE_RE = re.compile(r"^[A-Za-z]:")
_MSYS_DRIVE_RE = re.compile(r"^/([A-Za-z])(?=/|$)")  # Git Bash's /c/Users/...
_HOME_TOKENS = ("${HOME}", "$HOME", "${env:USERPROFILE}", "$env:USERPROFILE", "$USERPROFILE", "%USERPROFILE%")
_PLACEHOLDER = "\x00SUBST"
_HEREDOC = "\x00HEREDOC"


@dataclass(frozen=True)
class Verdict:
    level: str
    rule_ids: tuple[str, ...]
    reasons: tuple[str, ...]
    parseable: bool


@dataclass
class _Acc:
    level: str = "normal"
    rules: list[str] = field(default_factory=list)
    reasons: list[str] = field(default_factory=list)
    parseable: bool = True
    # The level each hit() raised its rule to (opaque-only rules are absent).
    levels: dict[str, str] = field(default_factory=dict)

    def hit(self, level: str, rule: str, reason: str) -> None:
        if LEVEL_ORDER[level] > LEVEL_ORDER[self.level]:
            self.level = level
        if LEVEL_ORDER[level] > LEVEL_ORDER[self.levels.get(rule, "normal")]:
            self.levels[rule] = level
        if rule not in self.rules:
            self.rules.append(rule)
            self.reasons.append(reason)

    def opaque(self, rule: str, reason: str) -> None:
        self.parseable = False
        if rule not in self.rules:
            self.rules.append(rule)
            self.reasons.append(reason)

    def verdict(self) -> Verdict:
        return Verdict(self.level, tuple(self.rules), tuple(self.reasons), self.parseable)


@dataclass
class _Ctx:
    cwd: str
    workspace: str
    home: str
    downloaded: set[str] = field(default_factory=set)
    # Windows: $HOME when it differs from %USERPROFILE% (Git Bash with a custom HOME).
    env_home: str = ""
    protected: frozenset[str] = frozenset(PROTECTED_BRANCHES)
    # Heredoc bodies cut out of the command, as (body, delimiter quoted).
    heredocs: list[tuple[str, bool]] = field(default_factory=list)
    # A heredoc whose delimiter could not be parsed or whose terminator line
    # never came: its text was left in place and read as shell lines.
    heredoc_unparsed: bool = False


# ---------------------------------------------------------------- paths


def _fold(path: str) -> str:
    return path.lower() if _FOLD_CASE else path


def _norm(path: str) -> str:
    if not path:
        return path
    if not _WINDOWS:
        return _fold(posixpath.normpath(path))
    p = path.replace("\\", "/")
    m = _MSYS_DRIVE_RE.match(p)
    if m:
        p = m.group(1) + ":" + p[2:]
    if _DRIVE_RE.match(p):
        p = p[:2] + posixpath.normpath("/" + p[2:].lstrip("/"))
    else:
        p = posixpath.normpath(p)
    return _fold(p)


def _isabs(path: str) -> bool:
    return path.startswith("/") or (_WINDOWS and bool(_DRIVE_RE.match(path)))


def _home() -> str:
    return _norm(os.path.expanduser("~"))


def _env_home() -> str:
    """Windows only: $HOME, which Python's "~" ignores there but Git Bash uses."""
    return _norm(os.environ.get("HOME", "")) if _WINDOWS else ""


def _homes(ctx: _Ctx) -> tuple[str, ...]:
    if ctx.env_home and ctx.env_home != ctx.home:
        return (ctx.home, ctx.env_home)
    return (ctx.home,)


def _resolve(arg: str, ctx: _Ctx) -> str | None:
    """Absolute normalized path for an argument, or None when it cannot be
    known statically (variable other than HOME, command substitution)."""
    if _PLACEHOLDER in arg:
        return None
    p = arg.replace("\\", "/") if _WINDOWS else arg
    for token in _HOME_TOKENS:
        if p == token or p.startswith(token + "/"):
            home = (ctx.env_home or ctx.home) if token in ("${HOME}", "$HOME") else ctx.home
            p = home + p[len(token):]
    if "$" in p:
        return None
    if p == "~" or p.startswith("~/"):
        p = ctx.home + p[1:]
    elif p.startswith("~"):
        return None  # ~otheruser
    if not _isabs(p):
        if not ctx.cwd:
            return None  # after a `cd` to a computed directory
        p = posixpath.join(ctx.cwd, p)
    return _norm(p)


def _glob_base(path: str) -> str:
    """The directory a glob can reach: '/a/b/*.x' -> '/a/b'."""
    parts = path.split("/")
    for i, part in enumerate(parts):
        if _GLOB_CHARS & set(part):
            base = "/".join(parts[:i])
            if _WINDOWS and _DRIVE_RE.fullmatch(base):
                base += "/"
            return base or "/"
    return path


def _inside(root: str, path: str) -> bool:
    if not root:
        return False
    return path == root or path.startswith(root.rstrip("/") + "/")


def _is_temp(path: str) -> bool:
    tmpdirs = [os.environ.get(v, "") for v in (("TMPDIR", "TEMP", "TMP") if _WINDOWS else ("TMPDIR",))]
    roots = _TEMP_ROOTS + tuple(_norm(t) for t in tmpdirs if t)
    return any(path != r and _inside(r, path) for r in roots)


def _credential_kind(path: str, ctx: _Ctx) -> str | None:
    """'credential' for secret stores, None otherwise."""
    for h in _homes(ctx):
        if not _inside(h, path) or path == h:
            continue
        rel = path[len(h) + 1:]
        first = rel.split("/", 1)[0]
        if first in {".ssh", ".aws", ".gnupg", ".netrc", ".kube", ".docker", ".azure", ".gcloud"}:
            if first == ".kube" and not rel.startswith(".kube/config"):
                return None
            if first == ".docker" and rel != ".docker/config.json":
                return None
            return "credential"
        if rel.startswith(_fold("Library/Keychains")):
            return "credential"
        if rel.startswith(".config/gcloud") or rel == ".config/gh/hosts.yml":
            return "credential"
        base = posixpath.basename(path)
        if rel.startswith(".claude/") and base.startswith(".credentials"):
            return "credential"
        if rel == ".claude/secrets" or rel.startswith(".claude/secrets/"):
            return "credential"
        if rel.startswith(".codex/") and base.startswith("auth"):
            return "credential"
    if path.startswith(_fold("/Library/Keychains")) or path.endswith(".keychain") or path.endswith(".keychain-db"):
        return "credential"
    return None


#: Home-relative stand-ins for the stores _credential_kind names, as
#: (path, directory). A directory reaches every name below it; a file only itself.
_STORE_PATHS = tuple((_fold(p), d) for p, d in (
    (".ssh", True), (".aws", True), (".gnupg", True), (".netrc", False), (".kube/config", False),
    (".docker/config.json", False), (".azure", True), (".gcloud", True), ("Library/Keychains", True),
    (".config/gcloud", True), (".config/gh/hosts.yml", False), (".claude/.credentials.json", False),
    (".claude/secrets", True), (".codex/auth.json", False),
))


def _expand_braces(text: str) -> list[str]:
    """``a{b,c}d`` -> ['abd', 'acd'] (nested too). Past 64 variants the rest
    of the pattern from the first brace becomes ``*/**``: a superset, so a
    huge expansion is graded more strictly, never skipped."""
    start = text.find("{")
    while start >= 0:
        depth, parts, last = 0, [], start + 1
        for i in range(start, len(text)):
            c = text[i]
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    break
            elif c == "," and depth == 1:
                parts.append(text[last:i])
                last = i + 1
        else:
            return [text]  # unclosed: a literal brace
        if parts:
            parts.append(text[last:i])
            out: list[str] = []
            for alt in parts:
                out += _expand_braces(text[:start] + alt + text[i + 1:])
                if len(out) > 64:
                    return [text[:start] + "*/**"]
            return out
        start = text.find("{", start + 1)
    return [text]


#: File names that hold secrets inside a store directory (e.g. ~/.ssh/id_rsa).
_SECRET_NAMES = tuple(_fold(n) for n in (
    "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "credentials", "config", ".netrc", "auth.json",
    "hosts.yml", ".credentials.json", "login.keychain-db",
))


_EXTENSION_FILTER = re.compile(r"\*\.[^*?\[\]]+")


def _names(seg: str, name: str, *, file: bool) -> bool:
    """A glob segment that matches ``name`` beyond a bare sweep: '.s?h',
    '*ssh' and '*_rsa' name their store or file; '*' only sweeps, and so does
    an extension filter ('*.json') on a file with a stem before it (auth.json)."""
    if not fnmatch.fnmatchcase(name, seg) or not set(seg) - set("*?"):
        return False
    # '*.netrc' matches all of .netrc, so it names it rather than filtering.
    return not (file and _EXTENSION_FILTER.fullmatch(seg) and len(name) > len(seg) - 1)


def _glob_reaches(globs: list[str], store: list[str], directory: bool) -> int:
    """Whether glob segments can match ``store`` (a file) or a name below it
    (a directory): 2 when a segment names the store or a secret file in it,
    1 when it is only reached through ``**`` or a ``*`` sweep, 0 when not."""
    memo: dict[tuple[int, int], int] = {}

    def reach(i: int, j: int) -> int:
        if (i, j) not in memo:
            if j == len(store):
                if not directory:
                    memo[i, j] = int(all(g == "**" for g in globs[i:]))
                elif i == len(globs):
                    memo[i, j] = 0
                else:
                    memo[i, j] = 2 if any(_names(globs[-1], n, file=True) for n in _SECRET_NAMES) else 1
            elif i == len(globs):
                memo[i, j] = 0
            elif globs[i] == "**":
                memo[i, j] = max(reach(i + 1, j), reach(i, j + 1))
            elif not fnmatch.fnmatchcase(store[j], globs[i]):
                memo[i, j] = 0
            else:
                r = reach(i + 1, j + 1)
                memo[i, j] = 2 if r and j == len(store) - 1 and _names(globs[i], store[j], file=not directory) else r
        return memo[i, j]

    return reach(0, 0)


def _stores_reached(path: str, ctx: _Ctx) -> list[tuple[str, bool]]:
    """Secret stores below a glob's literal base that its wildcards can expand
    into, as (store, named): see _glob_reaches."""
    base = _glob_base(path)
    if base == path:
        return []
    globs = [g for g in path[len(base):].split("/") if g]
    # Consecutive `**` match the same paths as one.
    globs = [g for i, g in enumerate(globs) if not (g == "**" and i and globs[i - 1] == "**")]
    out = []
    for h in _homes(ctx):
        for store, directory in _STORE_PATHS:
            full = h + "/" + store
            if full != base and _inside(base, full):
                r = _glob_reaches(globs, [s for s in full[len(base):].split("/") if s], directory)
                if r:
                    out.append((full, r == 2))
    return out


def _glob_dialect(pattern: str) -> str:
    """The ripgrep / picomatch glob as fnmatch reads it: ``[^x]`` negates like
    ``[!x]`` and a backslash escapes the next character (POSIX only: on
    Windows it is the path separator)."""
    out = []
    i = 0
    while i < len(pattern):
        c = pattern[i]
        if c == "\\" and not _WINDOWS and i + 1 < len(pattern):
            n = pattern[i + 1]
            out.append(f"[{n}]" if n in "*?[{},!^" else n)
            i += 2
            continue
        if c == "[" and pattern[i + 1:i + 2] == "^":
            out.append("[!")
            i += 2
            continue
        out.append(c)
        i += 1
    return "".join(out)


def _is_dotenv(path: str) -> bool:
    base = posixpath.basename(path)
    return base == ".env" or (base.startswith(".env.") and base not in {".env.example", ".env.sample", ".env.template"})


def _agent_config(path: str, ctx: _Ctx) -> bool:
    return any(
        (
            fnmatch.fnmatch(posixpath.basename(path), "settings*.json")
            and posixpath.dirname(path) == posixpath.join(h, ".claude")
        ) or path == posixpath.join(h, ".codex", "config.toml")
        for h in _homes(ctx)
    )


#: Navide's Electron userData folder names: package.json `name`, and the dev
#: instance's suffixes from src/main/devUserData.ts.
_APP_NAMES = ("agent-team", "agent-team-dev")
_APP_DEV_PLANS = "agent-team-dev-plans-"
#: Below userData, the plugin install root (Developer Mode folders, activation
#: and grants included) and the local trust records are protected whole; the
#: native backend folder only for its consent store and the kept-source
#: markers and set-aside folders beside plugin data, never a plugin's own data.
_STORE_DIRS = ("plugins", "plugin-local-trust")
_NATIVE_DIR = "plugin-native-backends"
_NATIVE_CONSENT = "native-backends.json"
_NATIVE_DATA = "data"
#: A write naming userData itself or a native backend folder can swap the
#: stores below it in one step, so those count too.
_STORE_ACCEPT = {"u", "native", "data", "in"}


def _app_data_roots(ctx: _Ctx) -> list[tuple[tuple[str, ...], bool]]:
    """Electron's appData folders on every platform's layout, as path
    segments with named=False (a userData name follows), plus an explicit
    absolute dev userData (named=True). Checking every layout everywhere costs
    nothing and covers a home shared across systems."""
    cands = []
    for h in _homes(ctx):
        cands += [posixpath.join(h, "Library/Application Support"), posixpath.join(h, ".config"),
                  posixpath.join(h, "AppData/Roaming")]
    cands += [os.environ.get(v, "") for v in ("XDG_CONFIG_HOME", "APPDATA")]
    out = [(tuple(n.split("/")), False) for n in (_norm(c) for c in cands if c) if _isabs(n)]
    dev = _norm(os.environ.get("NAVIDE_DEV_USER_DATA_DIR", ""))
    if dev and _isabs(dev):
        out.append((tuple(dev.split("/")), True))
    return out


def _seg_match(g: str, name: str) -> bool:
    return fnmatch.fnmatchcase(name, g) if _GLOB_CHARS & set(g) else g == name


def _store_step(state: tuple, g: str) -> list[tuple]:
    """Where one path segment ``g`` (literal or glob) leads from ``state``."""
    kind = state[0]
    if kind == "root":
        _, segs, k, named = state
        if not _seg_match(g, segs[k]):
            return []
        if k + 1 < len(segs):
            return [("root", segs, k + 1, named)]
        return [("u",)] if named else [("name",)]
    if kind == "name":
        prefix = _fold(_APP_DEV_PLANS)
        names = [_fold(n) for n in _APP_NAMES] + [prefix + "x"]
        dev = g.startswith(prefix) and (len(g) > len(prefix) or bool(_GLOB_CHARS & set(g)))
        return [("u",)] if dev or any(_seg_match(g, n) for n in names) else []
    out: list[tuple] = []
    if kind == "u":
        if any(_seg_match(g, _fold(d)) for d in _STORE_DIRS):
            out.append(("in",))
        if _seg_match(g, _fold(_NATIVE_DIR)):
            out.append(("native",))
    elif kind == "native":
        if _seg_match(g, _fold(_NATIVE_CONSENT)):
            out.append(("in",))
        if _seg_match(g, _fold(_NATIVE_DATA)):
            out.append(("data",))
    elif kind == "data":
        # `<id>@kept-source.json` and `<id>@set-aside-<source>-<ms>` (pluginNativeBackendData.ts);
        # a glob here may reach them, so it counts.
        if _GLOB_CHARS & set(g) or g.endswith(_fold("@kept-source.json")) or _fold("@set-aside-") in g:
            out.append(("in",))
    elif kind == "in":
        out.append(("in",))
    return out


def _reaches_store(path: str, ctx: _Ctx) -> bool:
    segs = path.split("/")
    for root, named in _app_data_roots(ctx):
        states: set[tuple] = {("root", root, 0, named)}
        for g in segs:
            if g == "**":
                # Zero or more segments: every state any segment can lead to.
                while True:
                    more = {n for s in states for n in _store_step(s, "*")} - states
                    if not more:
                        break
                    states |= more
                continue
            states = {n for s in states for n in _store_step(s, g)}
            if not states:
                break
        if any(s[0] in _STORE_ACCEPT for s in states):
            return True
    return False


def _store_write(acc: _Acc, path: str, ctx: _Ctx) -> None:
    """A write to Navide's plugin install root or trust stores: a same-user
    writer there can make Navide load code without the consent dialog."""
    if any(_reaches_store(p, ctx) for p in _expand_braces(path)):
        acc.hit("critical", "plugin-store-write", f"writes Navide's plugin install root or trust store: {path}")


def _check_path(
    acc: _Acc, path: str, ctx: _Ctx, *, write: bool, list_only: bool = False, store: bool = True,
) -> None:
    """``store=False``: the caller grades plugin store writes itself (a copy's source is only read)."""
    ws = ctx.workspace
    if _credential_kind(path, ctx):
        if list_only:
            acc.hit("high", "credential-path-list", f"lists a credential location: {path}")
        else:
            acc.hit("critical", "credential-access", f"touches a credential store: {path}")
        return
    if _is_dotenv(path) and not _inside(ws, path):
        acc.hit("critical", "dotenv-outside-workspace", f".env file outside the workspace: {path}")
        return
    if not write:
        return
    if store:
        _store_write(acc, path, ctx)
    if "/.git/hooks/" in path + "/" and path.rstrip("/").split("/.git/hooks", 1)[1:] != [""]:
        acc.hit("high", "git-hooks-write", f"writes a git hook: {path}")
    elif "/.github/workflows/" in path:
        acc.hit("high", "ci-workflow-write", f"writes a CI workflow: {path}")
    elif _agent_config(path, ctx):
        acc.hit("high", "agent-config-write", f"writes agent CLI settings (hooks live there): {path}")


# ---------------------------------------------------------------- shell parsing


#: Paths through which a program reads its own stdin.
_STDIN_PATHS = {"-", "/dev/stdin", "/dev/fd/0", "/proc/self/fd/0"}
#: Rules a data screen drops: a `// comment` or `$var = 1` line in a body is
#: not a script outside the workspace or a computed command name.
_SCREEN_IGNORED = {"unknown-script", "dynamic-command"}


def _heredoc_delimiter(text: str, j: int) -> tuple[str, bool, int] | None:
    """The delimiter word starting at ``j`` as (word after quote removal,
    any part quoted, end), or None when it is not one this parser can match
    exactly as bash would (expansions, an unclosed quote, an empty word)."""
    word: list[str] = []
    quoted = False
    n = len(text)
    while j < n and not text[j].isspace() and text[j] not in ";&|<>()":
        c = text[j]
        if c in "$`":
            return None
        if c == "\\":
            if j + 1 >= n or text[j + 1] == "\n":
                return None
            word.append(text[j + 1])
            quoted = True
            j += 2
        elif c == "'":
            end = text.find("'", j + 1)
            if end < 0:
                return None
            word.append(text[j + 1:end])
            quoted = True
            j = end + 1
        elif c == '"':
            k = j + 1
            while k < n and text[k] != '"':
                if text[k] in "$`":
                    return None
                if text[k] == "\\" and k + 1 < n and text[k + 1] in '"\\':
                    k += 1
                word.append(text[k])
                k += 1
            if k >= n:
                return None
            quoted = True
            j = k + 1
        else:
            word.append(c)
            j += 1
    return ("".join(word), quoted, j) if word else None


def _extract_heredocs(text: str, ctx: _Ctx) -> str:
    """Cut each heredoc body out of the command and leave a ``<<`` redirect
    to a marker in its place, so a body is never read as shell lines: it is
    input, and _classify_pipeline decides what it means for its command."""
    out: list[str] = []
    pending: list[tuple[str, bool, int]] = []  # (delimiter, strip tabs, index)
    first = len(ctx.heredocs)
    i, n = 0, len(text)
    in_single = in_double = False
    while i < n:
        c = text[i]
        if c == "\\" and not in_single and i + 1 < n:
            out.append(text[i:i + 2])
            i += 2
            continue
        if c == "'" and not in_double:
            in_single = not in_single
        elif c == '"' and not in_single:
            in_double = not in_double
        elif not in_single and not in_double and c == "#" and (i == 0 or text[i - 1] in " \t\n;&|()"):
            # A comment starts no heredoc: `# <<X` must not hide the lines after it.
            end = text.find("\n", i)
            end = n if end < 0 else end
            out.append(text[i:end])
            i = end
            continue
        elif not in_single and not in_double and text.startswith("((", i):
            # Arithmetic: `$((1<<2))` shifts, it starts no heredoc.
            depth, j = 0, i
            while j < n:
                depth += {"(": 1, ")": -1}.get(text[j], 0)
                j += 1
                if depth == 0:
                    break
            out.append(text[i:j])
            i = j
            continue
        elif not in_single and not in_double and text.startswith("<<<", i):
            out.append("<<<")  # a here-string, not a heredoc
            i += 3
            continue
        elif not in_single and not in_double and text.startswith("<<", i):
            j = i + 2
            strip = text.startswith("-", j)
            j += strip
            while j < n and text[j] in " \t":
                j += 1
            if text.startswith(_HEREDOC, j):
                # A marker left by an outer pass (this text is a $( ) inner).
                end = text.index("\x00", j + 1) + 1
                out.append(text[i:end])
                i = end
                continue
            delim = _heredoc_delimiter(text, j)
            if delim is None:
                return _heredoc_unparsed(text, ctx, first)
            word, quoted, end = delim
            ctx.heredocs.append(("", quoted))
            pending.append((word, strip, len(ctx.heredocs) - 1))
            out.append(f"<< {_HEREDOC}{len(ctx.heredocs) - 1}\x00 ")
            i = end
            continue
        elif c == "\n" and pending and not in_single and not in_double:
            out.append(c)
            i += 1
            for word, strip, idx in pending:
                lines: list[str] = []
                while True:
                    if i >= n:
                        return _heredoc_unparsed(text, ctx, first)
                    end = text.find("\n", i)
                    end = n if end < 0 else end
                    line = text[i:end].lstrip("\t") if strip else text[i:end]
                    i = end + 1
                    if line == word:
                        break
                    lines.append(line)
                ctx.heredocs[idx] = ("\n".join(lines), ctx.heredocs[idx][1])
            pending = []
            continue
        out.append(c)
        i += 1
    if pending:
        return _heredoc_unparsed(text, ctx, first)
    return "".join(out)


def _heredoc_unparsed(text: str, ctx: _Ctx, first: int) -> str:
    """Fail closed: a body this parser cannot bound exactly is read as shell
    lines, as before heredocs were cut out, and the verdict is opaque."""
    del ctx.heredocs[first:]
    ctx.heredoc_unparsed = True
    return text


def _heredoc_bodies(cmd: _Cmd, ctx: _Ctx) -> list[tuple[str, bool]]:
    bodies = []
    for op, target in cmd.redirects:
        m = re.fullmatch(re.escape(_HEREDOC) + r"(\d+)\x00", target) if op in ("<<", "<<-") else None
        if m and int(m.group(1)) < len(ctx.heredocs):
            bodies.append(ctx.heredocs[int(m.group(1))])
    return bodies


def _extract_substitutions(text: str) -> tuple[str, list[tuple[str, str]]]:
    """Replace $(...), `...`, <(...), >(...) with placeholders and turn
    unquoted newlines into ';'. Returns (flat text, [(kind, inner)])."""
    out: list[str] = []
    subs: list[tuple[str, str]] = []
    i, n = 0, len(text)
    in_single = in_double = False
    while i < n:
        c = text[i]
        if c == "\\" and not in_single and i + 1 < n:
            if text[i + 1] == "\n":
                i += 2
                continue
            out.append(text[i:i + 2])
            i += 2
            continue
        if c == "'" and not in_double:
            in_single = not in_single
        elif c == '"' and not in_single:
            in_double = not in_double
        elif not in_single and (text.startswith("$(", i) or (not in_double and text[i:i + 2] in ("<(", ">("))):
            kind = "process" if c in "<>" else "arith" if text.startswith("$((", i) else "command"
            depth, j = 1, i + 2
            while j < n and depth:
                if text[j] == "(":
                    depth += 1
                elif text[j] == ")":
                    depth -= 1
                j += 1
            subs.append((kind, text[i + 2:j - 1] if depth == 0 else text[i + 2:]))
            out.append(f"{_PLACEHOLDER}{len(subs) - 1}\x00")
            i = j
            continue
        elif c == "`" and not in_single:
            j = text.find("`", i + 1)
            j = n if j < 0 else j
            subs.append(("command", text[i + 1:j]))
            out.append(f"{_PLACEHOLDER}{len(subs) - 1}\x00")
            i = j + 1
            continue
        elif c == "#" and not in_single and not in_double and (
            not out or (len(out[-1]) == 1 and out[-1] in " \t;&|()<>")
        ):
            # A comment runs to the end of its line only; shlex would take the
            # rest of the flattened text with it once newlines become ';'. An
            # escaped blank (`\ #`) keeps the word going, so no comment starts.
            end = text.find("\n", i)
            i = n if end < 0 else end
            continue
        elif c == "\n" and not in_single and not in_double:
            out.append(";")
            i += 1
            continue
        out.append(c)
        i += 1
    return "".join(out), subs


@dataclass
class _Cmd:
    argv: list[str]
    redirects: list[tuple[str, str]]  # (op, target)


_SEPARATORS = {";", "&&", "||", "&", ";;", "(", ")", "\n"}
_PIPES = {"|", "|&"}


def _split(text: str) -> list[list[_Cmd]]:
    """Lists of pipelines; raises ValueError on unbalanced quotes."""
    lex = shlex.shlex(text, posix=True, punctuation_chars=True)
    lex.whitespace_split = True
    # Comments are already gone (_extract_substitutions); shlex would also end
    # a word at a `#` inside it, which bash does not.
    lex.commenters = ""
    pipelines: list[list[_Cmd]] = []
    pipeline: list[_Cmd] = []
    cur = _Cmd([], [])
    pending_redirect: str | None = None

    def close_cmd() -> None:
        nonlocal cur
        if cur.argv or cur.redirects:
            pipeline.append(cur)
        cur = _Cmd([], [])

    for tok in lex:
        if pending_redirect is not None:
            cur.redirects.append((pending_redirect, tok))
            pending_redirect = None
            continue
        if tok in _PIPES:
            close_cmd()
            continue
        if tok in _SEPARATORS or (tok and set(tok) <= set(";&|()") ):
            close_cmd()
            if pipeline:
                pipelines.append(pipeline)
            pipeline = []
            continue
        # `>|` (noclobber override) is one punctuation token that holds a `|`.
        if tok == ">|" or (tok and set(tok) <= set("<>&") and ("<" in tok or ">" in tok)):
            if tok.endswith("&"):
                continue  # >&2 style fd dup; the next token is an fd
            pending_redirect = tok
            continue
        cur.argv.append(tok)
    close_cmd()
    if pipeline:
        pipelines.append(pipeline)
    return pipelines


_PLAIN_REDIRECTS = frozenset({"<", ">", ">>", "<<", "<<-", "<<<", ">|", "<>", "&>", "&>>"})
_OPERATOR_CHARS = frozenset(";&|()<>")


def single_command(text: str) -> bool:
    """Whether `text` runs one simple command, after any number of plain
    `cd DIR` steps, with no substitution and no heredoc left unparsed: the
    only shape a whole-command allow glob may vouch for on a tainted pane
    (policy.apply_taint_allow). A glob's `*` spans `;` and newlines, so on a
    longer line it would vouch for commands it never named."""
    # Only shapes whose split is unambiguous vouch for anything; quoting and
    # comment edge cases are refused rather than trusted.
    if "$'" in text or "\r" in text:
        return False
    ctx = _Ctx("", "", "")
    try:
        body_free = _extract_heredocs(text, ctx)
        flat, subs = _extract_substitutions(body_free)
        if len(flat) != len(_extract_substitutions(body_free.replace("#", "\x01"))[0]):
            return False
        pipelines = _split(flat)
    except ValueError:
        return False
    if subs or ctx.heredoc_unparsed or not pipelines or any(len(p) != 1 for p in pipelines):
        return False
    # Redirection and operator tokens must be plain.
    if any(
        op not in _PLAIN_REDIRECTS or set(target) <= _OPERATOR_CHARS
        for p in pipelines for op, target in p[0].redirects
    ) or any(set(word) <= _OPERATOR_CHARS for p in pipelines for word in p[0].argv):
        return False
    # An unquoted heredoc body runs its substitutions; quotes there are text.
    if any(not quoted and ("$(" in body or "`" in body) for body, quoted in ctx.heredocs):
        return False
    return all(
        p[0].argv[:1] == ["cd"] and len(p[0].argv) <= 2 and not p[0].redirects for p in pipelines[:-1]
    )


def _in_modelled_subset(text: str, depth: int = 0) -> bool:
    """Whether `text` stays inside the shell subset the tokenizer models the
    way bash and zsh do: no control characters other than newline and tab,
    no ANSI-C quoting, no unquoted backslash before an operator character or
    blank, no unquoted `(` inside a word, and no quoted word made only of
    operator characters (shlex drops the quotes, so it reads as an operator).
    Anything outside it is graded unanalysable rather than trusted to split
    as shlex splits it."""
    if depth == 0 and any((ord(c) < 0x20 and c not in "\n\t") or c == "\x7f" for c in text):
        return False
    if depth > 6:
        return True  # _classify_script already reports nesting-too-deep
    flat, subs = _extract_substitutions(_extract_heredocs(text, _Ctx("", "", "")))
    in_single = in_double = quoted = False
    word: list[str] = []
    blanks = _OPERATOR_CHARS | {" ", "\t"}
    flat += " "
    i = 0
    while i < len(flat):
        c = flat[i]
        if in_single:
            if c == "'":
                in_single = False
            else:
                word.append(c)
        elif c == "\\":
            if not in_double and flat[i + 1] in blanks:
                return False
            word.append(flat[i + 1])
            i += 1
        elif c == "$" and flat[i + 1] == "'":
            return False
        elif c == "'" and not in_double:
            in_single = quoted = True
        elif c == '"':
            in_double, quoted = not in_double, True
        elif in_double or c not in blanks:
            word.append(c)
        else:
            # End of a word: a `(` glued to it, or a quoted word shlex would read as an operator.
            if c == "(" and (word or quoted):
                return False
            if quoted and word and set(word) <= _OPERATOR_CHARS:
                return False
            word, quoted = [], False
        i += 1
    # Substitution bodies are shell too; an arithmetic body only through its own substitutions.
    return all(
        _in_modelled_subset(inner, depth + 1) if kind != "arith"
        else all(_in_modelled_subset(nested, depth + 1) for _, nested in _extract_substitutions(inner)[1])
        for kind, inner in subs
    )


def _unwrap(argv: list[str], acc: _Acc) -> tuple[list[str], bool]:
    """Strip sudo/env/nohup/time/... wrappers. Returns (argv, from_stdin)."""
    from_stdin = False
    while argv:
        word = os.path.basename(argv[0]) if "/" in argv[0] else argv[0]
        if word in LEADING_KEYWORDS:
            argv = argv[1:]
        elif re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", argv[0]):
            argv = argv[1:]
        elif word in {"sudo", "doas"}:
            acc.hit("critical", "sudo", "runs with elevated privileges (sudo)")
            argv = argv[1:]
            while argv and argv[0].startswith("-"):
                opt = argv[0]
                argv = argv[1:]
                if opt in {"-u", "-g", "-C", "-h", "-p", "-U", "-r", "-t"} and argv:
                    argv = argv[1:]
        elif word == "su":
            acc.hit("critical", "sudo", "switches user (su)")
            return [], from_stdin
        elif word == "env":
            argv = argv[1:]
            while argv and (argv[0].startswith("-") or "=" in argv[0]):
                opt = argv[0]
                argv = argv[1:]
                if opt in {"-u", "-C", "-S"} and argv:
                    argv = argv[1:]
        elif word in WRAPPERS_NO_ARG:
            argv = argv[1:]
            while argv and argv[0].startswith("-"):
                argv = argv[1:]
        elif word in {"nice", "timeout", "ionice"}:
            argv = argv[1:]
            while argv and argv[0].startswith("-"):
                opt = argv[0]
                argv = argv[1:]
                if opt in {"-n", "-s", "-k", "-c"} and argv:
                    argv = argv[1:]
            if word == "timeout" and argv:
                argv = argv[1:]  # duration
        elif word == "xargs":
            from_stdin = True
            argv = argv[1:]
            while argv and argv[0].startswith("-"):
                opt = argv[0]
                argv = argv[1:]
                if opt in {"-I", "-n", "-P", "-L", "-d", "-E", "-s"} and argv:
                    argv = argv[1:]
        else:
            break
    return argv, from_stdin


def _classify_script(text: str, ctx: _Ctx, acc: _Acc, depth: int = 0) -> None:
    if depth > 6:
        acc.opaque("nesting-too-deep", "command nests too deeply to analyse")
        # Still screen the words, flattened: without this, wrapping `rm -rf ~`
        # in seven $( ) hid it entirely.
        try:
            pipelines = _split(re.sub(r"\$\(|[`()]", " ", text))
        except ValueError:
            return
        for pipeline in pipelines:
            _classify_pipeline(pipeline, ctx, acc, set(), depth)
        return
    flat, subs = _extract_substitutions(_extract_heredocs(text, ctx))
    if ctx.heredoc_unparsed:
        acc.opaque("heredoc-unparsed", "a heredoc's delimiter or end cannot be determined")
    try:
        pipelines = _split(flat)
    except ValueError:
        acc.opaque("unbalanced-quotes", "command has unbalanced quotes")
        return
    sub_downloads = {i for i, (_, inner) in enumerate(subs) if _mentions_downloader(inner)}
    for kind, inner in subs:
        if kind == "arith":
            # `$((1<<2))` is arithmetic: only the substitutions inside it run.
            for _, nested in _extract_substitutions(inner)[1]:
                _classify_script(nested, ctx, acc, depth + 1)
        else:
            _classify_script(inner, ctx, acc, depth + 1)
    for pipeline in pipelines:
        _classify_pipeline(pipeline, ctx, acc, sub_downloads, depth)


def _mentions_downloader(text: str) -> bool:
    return any(re.search(rf"(^|[\s;|&(/]){d}(\s|$)", text) for d in DOWNLOADERS)


def _sub_index(arg: str) -> int | None:
    m = re.search(re.escape(_PLACEHOLDER) + r"(\d+)\x00", arg)
    return int(m.group(1)) if m else None


def _classify_pipeline(pipeline: list[_Cmd], ctx: _Ctx, acc: _Acc, sub_downloads: set[int], depth: int) -> None:
    upstream: set[str] = set()  # kinds of producers earlier in this pipeline
    piped: list[str] = []  # heredoc bodies and here-strings flowing down the pipe
    for idx, cmd in enumerate(pipeline):
        argv, from_stdin = _unwrap(list(cmd.argv), acc)
        from_stdin = from_stdin or idx > 0
        heredocs = _heredoc_bodies(cmd, ctx)
        for body, quoted in heredocs:
            if not quoted:
                # An unquoted body still expands: its $( ) and ` ` run.
                for _, inner in _extract_substitutions(body)[1]:
                    _classify_script(inner, ctx, acc, depth + 1)
        inputs = [body for body, _ in heredocs] + [t for op, t in cmd.redirects if op == "<<<"]
        if inputs and not _shell_reads_stdin(argv):
            # Not a shell's program: data, unless it can still reach one.
            last = idx == len(pipeline) - 1
            if not (last and _stdout_to_file(cmd, ctx) and os.path.basename(argv[0] if argv else "") not in INTERPRETERS):
                for body in inputs:
                    _screen_data(body, ctx, acc, depth)
            if not last:
                piped.extend(inputs)
        for op, target in cmd.redirects:
            if op in ("<<", "<<-"):
                continue
            path = _resolve(target, ctx)
            if path:
                _check_path(acc, path, ctx, write=">" in op)
        if not argv:
            continue
        word_raw = argv[0]
        word = os.path.basename(word_raw)
        if word_raw in SKIP_SEGMENT_KEYWORDS:
            continue
        if _PLACEHOLDER in word_raw or "$" in word_raw:
            acc.opaque("dynamic-command", "command name is computed at run time")
            continue
        if word == "eval":
            acc.opaque("eval", "eval runs a string that cannot be analysed statically")
            if any((i := _sub_index(a)) is not None and i in sub_downloads for a in argv[1:]):
                acc.hit("critical", "pipe-download-to-shell", "executes content fetched from the network")
            _classify_script(" ".join(argv[1:]), ctx, acc, depth + 1)
            continue
        if word in {"source", "."} and len(argv) > 1:
            if argv[1] in _STDIN_PATHS:
                # Sources its stdin: the same as a shell reading its program there.
                _classify_interpreter("sh", ["sh"], ctx, acc, upstream, sub_downloads, depth, inputs, piped)
            else:
                _check_script_exec(argv[1], ctx, acc, sub_downloads)
            continue

        if word in INTERPRETERS:
            _classify_interpreter(word, argv, ctx, acc, upstream, sub_downloads, depth, inputs, piped)
        else:
            if "/" in word_raw:
                _check_script_exec(word_raw, ctx, acc, sub_downloads)
            _classify_command(word, argv, ctx, acc, from_stdin)

        if word in DOWNLOADERS:
            upstream.add("download")
            _track_downloads(word, argv, ctx)
        elif word in DECODERS and any(a in {"-d", "-D", "--decode", "-r"} or a.startswith("-d") for a in argv[1:]):
            upstream.add("decode")
        else:
            upstream.add("other")


def _interpreter_args(word: str, args: list[str]) -> tuple[str | None, str | None, bool]:
    """(inline code, script, runs a named module); neither code nor script
    means the program is read from stdin."""
    code_flag = {"-c"} if word in SHELLS else {"-c", "-e", "-E", "--eval", "-r"}
    i = 0
    while i < len(args):
        a = args[i]
        if a in code_flag or (word in SHELLS and a.startswith("-") and not a.startswith("--") and "c" in a[1:]):
            return (args[i + 1] if i + 1 < len(args) else ""), None, False
        if a == "-" or a == "-s":
            break
        if a.startswith("-"):
            if word not in SHELLS and a in {"-m"}:
                return None, None, True  # python -m module: a named module, not a script
            i += 1
            continue
        return None, (None if a in _STDIN_PATHS else a), False
    return None, None, False


def _shell_reads_stdin(argv: list[str]) -> bool:
    """A shell (or source/.) that takes its program from stdin."""
    if not argv:
        return False
    word = os.path.basename(argv[0])
    if word in {"source", "."}:
        return len(argv) > 1 and argv[1] in _STDIN_PATHS
    if word not in SHELLS:
        return False
    code, script, _ = _interpreter_args(word, argv[1:])
    return code is None and script is None


def _stdout_to_file(cmd: _Cmd, ctx: _Ctx) -> bool:
    """Output redirected to a regular file, where nothing in this command
    reads it back (a device or /proc path may be the pipe itself). The last
    redirect wins, as in the shell; a bare number among the words may be the
    fd of a split `2>` or `>&1`, which cannot be told apart, so it is not one."""
    if any(a.isdigit() for a in cmd.argv):
        return False
    targets = [target for op, target in cmd.redirects if ">" in op]
    path = _resolve(targets[-1], ctx) if targets else None
    return bool(path) and not path.startswith(("/dev/", "/proc/"))


def _screen_data(body: str, ctx: _Ctx, acc: _Acc, depth: int) -> None:
    """Escalate-only screen of input that no analysed shell consumes but
    that may still reach one (a pipe, a substitution, eval): each line is
    read as shell and only its high/critical hits count."""
    copy = _Ctx(ctx.cwd, ctx.workspace, ctx.home, set(ctx.downloaded), env_home=ctx.env_home, protected=ctx.protected)
    for line in body.splitlines():
        sub = _Acc()
        _classify_script(line, copy, sub, depth + 1)
        if "unbalanced-quotes" in sub.rules:
            # Prose with an apostrophe: still screen its words.
            sub = _Acc()
            _classify_script(re.sub(r"[\"'`]", " ", line), copy, sub, depth + 1)
        for rule, reason in zip(sub.rules, sub.reasons):
            level = sub.levels.get(rule)
            if level and rule not in _SCREEN_IGNORED:
                acc.hit(level, rule, reason)


def _classify_interpreter(word, argv, ctx, acc, upstream, sub_downloads, depth, inputs=(), piped=()) -> None:
    code, script, module = _interpreter_args(word, argv[1:])
    if module:
        return
    if code is not None:
        if word in SHELLS:
            idx = _sub_index(code)
            if idx is not None and idx in sub_downloads:
                acc.hit("critical", "pipe-download-to-shell", "executes a script fetched from the network")
            _classify_script(code, ctx, acc, depth + 1)
        else:
            acc.opaque("interpreter-inline-code", f"{word} runs inline code that is not analysed")
        return
    if script is not None:
        idx = _sub_index(script)
        if idx is not None and idx in sub_downloads:
            acc.hit("critical", "pipe-download-to-shell", "executes a script fetched from the network")
            return
        _check_script_exec(script, ctx, acc, sub_downloads)
        return
    # No script and no -c: the interpreter reads its program from stdin.
    if inputs:
        if word in SHELLS:
            for body in inputs:
                idx = _sub_index(body)
                if idx is not None:
                    # A here-string built at run time: `bash <<< "$(...)"`.
                    if idx in sub_downloads:
                        acc.hit("critical", "pipe-download-to-shell", "executes a script fetched from the network")
                    else:
                        acc.hit("high", "dynamic-stdin-script", "shell runs a program computed at run time")
                    acc.opaque("dynamic-stdin-script", "shell runs a program computed at run time")
                _classify_script(body, ctx, acc, depth + 1)
        else:
            acc.opaque("interpreter-inline-code", f"{word} runs inline code that is not analysed")
    elif "download" in upstream:
        acc.hit("critical", "pipe-download-to-shell", "pipes a network download into an interpreter")
    elif "decode" in upstream:
        acc.hit("high", "decode-and-exec", "pipes decoded data into an interpreter")
        acc.opaque("decode-and-exec", "pipes decoded data into an interpreter")
    elif upstream:
        acc.opaque("stdin-script", "interpreter runs a program read from a pipe")
        if word in SHELLS:
            # What a heredoc or here-string upstream carries: an earlier
            # stage may have reshaped it, so it is screened, not trusted.
            for body in piped:
                _classify_script(body, ctx, acc, depth + 1)


def _track_downloads(word: str, argv: list[str], ctx: _Ctx) -> None:
    args = argv[1:]
    for i, a in enumerate(args):
        target = None
        if a in {"-o", "--output", "-O", "--output-document"} and i + 1 < len(args):
            target = args[i + 1]
            if word == "curl" and a == "-O":
                target = None
        elif a.startswith("--output=") or a.startswith("--output-document="):
            target = a.split("=", 1)[1]
        if target:
            path = _resolve(target, ctx)
            if path:
                ctx.downloaded.add(path)


def _check_script_exec(script: str, ctx: _Ctx, acc: _Acc, sub_downloads: set[int]) -> None:
    idx = _sub_index(script)
    if idx is not None:
        if idx in sub_downloads:
            acc.hit("critical", "pipe-download-to-shell", "executes a script fetched from the network")
        else:
            acc.opaque("unknown-script", "executes a script whose path is computed at run time")
        return
    path = _resolve(script, ctx)
    if path is None:
        acc.opaque("unknown-script", f"executes a script whose path is not static: {script}")
        return
    if path in ctx.downloaded:
        acc.hit("critical", "download-then-exec", f"executes a file downloaded in the same command: {script}")
        acc.opaque("download-then-exec", "executes a downloaded script")
        return
    if _inside(ctx.workspace, path) or path.startswith(tuple(_fold(p) for p in SYSTEM_BIN_PREFIXES)):
        return
    if any(_inside(posixpath.join(h, ".local", "bin"), path) for h in _homes(ctx)):
        return
    acc.opaque("unknown-script", f"executes a script outside the workspace: {path}")


# ---------------------------------------------------------------- command rules


def _flags(args: list[str]) -> set[str]:
    out: set[str] = set()
    for a in args:
        if a == "--":
            break
        if a.startswith("--"):
            out.add(a.split("=", 1)[0])
        elif a.startswith("-") and len(a) > 1:
            out.update(f"-{ch}" for ch in a[1:])
    return out


def _positionals(args: list[str]) -> list[str]:
    out, after_dd = [], False
    for a in args:
        if after_dd:
            out.append(a)
        elif a == "--":
            after_dd = True
        elif not a.startswith("-") or a == "-":
            out.append(a)
    return out


def _classify_command(word: str, argv: list[str], ctx: _Ctx, acc: _Acc, from_stdin: bool) -> None:
    args = argv[1:]
    if word in NON_PATH_CMDS:
        return
    if word in {"cd", "pushd"}:
        pos = _positionals(args)
        target = pos[0] if pos else "~"
        ctx.cwd = _resolve(target, ctx) or ""
        return
    if word == "rm":
        _classify_rm(args, ctx, acc, from_stdin, recursive=bool(_flags(args) & {"-r", "-R", "--recursive"}))
        return
    if word == "find" and ("-delete" in args or ("-exec" in args and "rm" in args) or ("-execdir" in args and "rm" in args)):
        roots = []
        for a in args:
            if a.startswith("-") or a in {"(", "!", ")"}:
                break
            roots.append(a)
        _classify_rm(roots or ["."], ctx, acc, from_stdin=False, recursive=True, filtered=True)
        return
    if word == "dd":
        if any(a.startswith("of=/dev/") for a in args):
            acc.hit("critical", "disk-write", "dd writes directly to a device")
        else:
            acc.hit("high", "dd", "dd copies raw data")
        for a in args:
            if a.startswith("of="):
                _store_arg(acc, a[3:], ctx)
        return
    if word.startswith("mkfs") or word.startswith("newfs") or word in {"fdisk", "sfdisk", "gpt", "wipefs"}:
        acc.hit("critical", "disk-format", f"{word} formats or repartitions a disk")
        return
    if word == "diskutil" and args:
        sub = args[0].lower()
        if sub.startswith(("erase", "zero", "random", "secureerase", "partition", "reformat")) or (
            sub in {"apfs", "cs", "ar"} and len(args) > 1 and args[1].lower().startswith(("delete", "erase"))
        ):
            acc.hit("critical", "disk-format", f"diskutil {args[0]} erases or repartitions a disk")
        return
    if word == "security" and args:
        sub = args[0]
        if re.match(r"^(find-(generic|internet)-password|dump-keychain|export|delete-|unlock-keychain|set-generic-password|add-generic-password)", sub):
            acc.hit("critical", "keychain-access", f"reads or changes the Keychain (security {sub})")
        return
    if word == "git":
        _classify_git(args, ctx, acc)
        return
    if len(args) >= 1 and (word, args[0]) in PUBLISH or (word == "yarn" and args[:2] == ["npm", "publish"]):
        acc.hit("high", "package-publish", f"publishes a package ({word} {args[0]})")
        return
    if word in {"terraform", "tofu"} and args and (args[0] == "destroy" or (args[0] == "apply" and "-destroy" in args)):
        acc.hit("critical", "cloud-destroy", f"{word} destroys infrastructure")
        return
    if word == "kubectl" and "delete" in _positionals(args):
        acc.hit("critical", "cloud-destroy", "kubectl deletes cluster resources")
        return
    if word == "aws":
        pos = _positionals(args)
        if any(p.startswith(("delete-", "terminate-")) for p in pos) or (
            pos[:2] == ["s3", "rb"] or (pos[:2] == ["s3", "rm"] and "--recursive" in args)
        ):
            acc.hit("critical", "cloud-destroy", "aws command deletes cloud resources")
        return
    if word in {"gcloud", "az"} and "delete" in _positionals(args):
        acc.hit("critical", "cloud-destroy", f"{word} deletes cloud resources")
        return
    if word in DOWNLOADERS:
        # A download's output file is graded exactly like `>` into it.
        for a in _download_outputs(word, args):
            for cand in _arg_paths(a) or ([a] if not a.startswith("-") else []):
                path = _resolve(cand, ctx)
                if path:
                    _check_path(acc, path, ctx, write=True)
        _classify_upload(word, args, ctx, acc)
        return
    # Generic: any path-like argument that names a credential store or a
    # protected write target.
    list_only = word in LIST_ONLY
    writes = word in {"cp", "mv", "tee", "install", "ln", "rsync", "scp", "touch", "chmod", "sed", "truncate"}
    for a in args:
        for cand in _arg_paths(a):
            path = _resolve(cand, ctx)
            if path:
                _check_path(acc, path, ctx, write=writes, list_only=list_only, store=False)
    if writes or word in _STORE_ONLY_WRITES:
        for a in _store_targets(word, args):
            _store_arg(acc, a, ctx)


#: Commands that change files but grade normal elsewhere: only the plugin
#: store check reads them, so their grading outside the stores stays as it was.
_STORE_ONLY_WRITES = {"unlink", "rmdir", "mkdir", "chown", "chgrp", "xattr", "ditto"}


def _store_arg(acc: _Acc, arg: str, ctx: _Ctx) -> None:
    """Plugin store check for one argument. A bare word (``acme.json``) is a
    path relative to the working directory here too, unlike _arg_paths:
    after ``cd plugin-local-trust`` it names a trust record, and anywhere
    outside the stores it changes nothing."""
    for cand in _arg_paths(arg) or ([arg] if arg and not arg.startswith("-") else []):
        path = _resolve(cand, ctx)
        if path:
            _store_write(acc, path, ctx)


def _url_file_name(url: str) -> str:
    path = re.sub(r"^[A-Za-z][A-Za-z0-9+.-]*://[^/]*", "", url).split("?", 1)[0].split("#", 1)[0]
    return posixpath.basename(path) or "index.html"


def _download_outputs(word: str, args: list[str]) -> list[str]:
    """Files a download writes: curl -o/--output, wget -O/--output-document,
    and otherwise (curl -O, a plain wget) the URL's file name in --output-dir
    / -P or the working directory. ``-`` is stdout."""
    curl = word != "wget"
    files: list[str] = []
    dirs: list[str] = []
    remote = not curl
    i = 0
    while i < len(args):
        a, nxt = args[i], (args[i + 1] if i + 1 < len(args) else "")
        i += 1
        if a.startswith("--"):
            key, eq, val = a.partition("=")
            if key in ("--output", "--output-document", "--output-dir", "--directory-prefix"):
                if not eq:
                    val, i = nxt, i + 1
                (dirs if key in ("--output-dir", "--directory-prefix") else files).append(val)
            elif key in ("--remote-name", "--remote-name-all"):
                remote = True
            continue
        if not a.startswith("-") or a == "-":
            continue
        for j, ch in enumerate(a[1:], 1):
            if curl and ch == "O":
                remote = True
            elif ch == ("o" if curl else "O") or (not curl and ch == "P"):
                val = a[j + 1:]
                if not val:
                    val, i = nxt, i + 1
                (dirs if ch == "P" else files).append(val)
                break
    if files or not remote:
        return [f for f in files if f and f != "-"]
    names = [_url_file_name(a) for a in args if re.match(r"^[A-Za-z][A-Za-z0-9+.-]*://", a)]
    return [posixpath.join(d, n) for n in names for d in dirs] if dirs else names


def _store_targets(word: str, args: list[str]) -> list[str]:
    """The arguments a write command changes: every one (mv, ln and chmod
    change their sources too), but only a copy's destination, and sed's files
    only with -i."""
    if word == "sed":
        return args if _flags(args) & {"-i", "--in-place"} else []
    if word == "xattr":
        return args if _flags(args) & {"-w", "-d", "-c"} else []
    if word in {"cp", "install", "rsync", "scp", "ditto"}:
        for i, a in enumerate(args):
            if a == "-t" and i + 1 < len(args):
                return [args[i + 1]]
            if a.startswith("--target-directory="):
                return [a.split("=", 1)[1]]
        return _positionals(args)[-1:]
    return args


def _arg_paths(arg: str) -> list[str]:
    """Candidate paths inside one argument: 'x', '@x', '--opt=x', 'k=@x'."""
    if not arg or arg == "-":
        return []
    cands = []
    if arg.startswith("-"):
        if "=" in arg:
            arg = arg.split("=", 1)[1]
        else:
            return []
    elif "=" in arg and not arg.startswith(("/", "~", ".")):
        arg = arg.split("=", 1)[1]
    if arg.startswith("@"):
        arg = arg[1:]
    if arg.startswith(("/", "~", ".") + _HOME_TOKENS) or "/" in arg or arg.startswith(".env"):
        cands.append(arg)
    elif _WINDOWS and ("\\" in arg or _DRIVE_RE.match(arg)):
        cands.append(arg)
    return cands


def _classify_rm(
    targets: list[str], ctx: _Ctx, acc: _Acc, from_stdin: bool, recursive: bool, filtered: bool = False
) -> None:
    paths = _positionals(targets)
    if from_stdin and not paths and recursive:
        acc.hit("high", "rm-unresolved-target", "recursive rm on targets read from stdin")
        acc.opaque("rm-unresolved-target", "rm targets come from stdin")
        return
    ws = ctx.workspace
    for raw in paths:
        path = _resolve(raw, ctx)
        if path is None:
            acc.hit("high", "rm-unresolved-target", f"rm target is computed at run time: {raw}")
            acc.opaque("rm-unresolved-target", f"rm target is computed at run time: {raw}")
            continue
        base = _glob_base(path)
        if _credential_kind(base, ctx) or _credential_kind(path, ctx):
            acc.hit("critical", "credential-access", f"deletes a credential store: {path}")
            continue
        _store_write(acc, path, ctx)
        if base == "/" or base in _homes(ctx) or (_WINDOWS and _DRIVE_RE.fullmatch(base.rstrip("/"))) or (ws and _inside(base, ws) and base != ws):
            acc.hit("critical", "rm-root-or-home", f"deletes the root, home, or a parent of the workspace: {path}")
            continue
        if ws and _inside(ws, path):
            if not recursive:
                continue
            if path == ws and not filtered:
                acc.hit("critical", "rm-workspace-root", "recursively deletes the whole workspace")
            else:
                acc.hit("high", "rm-recursive-in-workspace", f"recursive delete inside the workspace: {path}")
            continue
        if _is_temp(base):
            continue
        if recursive:
            acc.hit("critical", "rm-outside-workspace", f"recursive delete outside the workspace: {path}")
        else:
            acc.hit("high", "rm-file-outside-workspace", f"deletes a file outside the workspace: {path}")


def _classify_git(args: list[str], ctx: _Ctx, acc: _Acc) -> None:
    i = 0
    while i < len(args) and args[i].startswith("-"):
        if args[i] in {"-C", "-c", "--git-dir", "--work-tree", "--namespace"} and i + 1 < len(args):
            i += 2
        else:
            i += 1
    if i >= len(args):
        return
    sub, rest = args[i], args[i + 1:]
    fl = _flags(rest)
    if sub == "clone":
        # The clone's destination (the repository's name when none is given).
        pos = _positionals(rest)
        urls = [k for k, p in enumerate(pos) if "://" in p or ":" in p or p.endswith(".git")]
        if urls:
            k = urls[0]
            dest = pos[k + 1] if k + 1 < len(pos) else posixpath.basename(pos[k].rstrip("/")).removesuffix(".git")
            _store_arg(acc, dest, ctx)
        return
    if sub == "push":
        pos = _positionals(rest)
        refspecs = pos[1:]
        force = bool(fl & {"-f", "--force", "--force-with-lease", "--force-if-includes", "--mirror"}) or any(
            r.startswith("+") for r in refspecs
        )
        delete = bool(fl & {"-d", "--delete"})
        dsts = set()
        for r in refspecs:
            r = r.lstrip("+")
            dst = r.split(":", 1)[1] if ":" in r else r
            if r.startswith(":"):
                delete = True
            dsts.add(dst.removeprefix("refs/heads/"))
        protected = dsts & ctx.protected
        if (force or delete) and protected:
            acc.hit("critical", "git-force-push-protected",
                    f"force-pushes or deletes protected branch {', '.join(sorted(protected))}")
        elif force:
            acc.hit("high", "git-push-force", "force push (history rewrite on the remote)")
        else:
            acc.hit("high", "git-push", "pushes to a remote")
    elif sub == "reset" and "--hard" in fl:
        acc.hit("high", "git-reset-hard", "git reset --hard discards local changes")
    elif sub == "clean" and fl & {"-f", "--force"}:
        acc.hit("high", "git-clean-force", "git clean -f deletes untracked files")


def _classify_upload(word: str, args: list[str], ctx: _Ctx, acc: _Acc) -> None:
    files: list[str] = []
    for i, a in enumerate(args):
        nxt = args[i + 1] if i + 1 < len(args) else ""
        if a in {"-d", "--data", "--data-binary", "--data-raw", "--data-urlencode", "-F", "--form"}:
            if "@" in nxt:
                files.append(nxt.split("@", 1)[1].split(";", 1)[0])
        elif a.startswith(("--data=", "--data-binary=", "--form=")) and "@" in a:
            files.append(a.split("@", 1)[1])
        elif a in {"-T", "--upload-file", "--post-file", "--body-file"}:
            files.append(nxt)
        elif a.startswith(("--post-file=", "--body-file=")):
            files.append(a.split("=", 1)[1])
    hosts = [a for a in args if re.match(r"^https?://", a)]
    local = hosts and all(re.match(r"^https?://(localhost|127\.0\.0\.1|\[::1\])([:/]|$)", h) for h in hosts)
    for f in files:
        path = _resolve(f, ctx)
        if path and (_credential_kind(path, ctx) or _is_dotenv(path)):
            acc.hit("critical", "credential-exfil", f"uploads a secret file: {path}")
        elif not local:
            acc.hit("high", "http-upload-file", f"uploads a local file with {word}")


# ---------------------------------------------------------------- entry points


def _ctx(cwd: str, workspace: str, protected: frozenset[str] | None = None) -> _Ctx:
    home = _home()
    ws = _norm(os.path.expanduser(workspace)) if workspace else ""
    base = _norm(os.path.expanduser(cwd)) if cwd else (ws or home)
    return _Ctx(cwd=base, workspace=ws, home=home, env_home=_env_home(),
                protected=frozenset(PROTECTED_BRANCHES if protected is None else protected))


def _tool_command(tool_input: dict) -> str | None:
    cmd = tool_input.get("command", tool_input.get("cmd"))
    if isinstance(cmd, list):
        cmd = [str(c) for c in cmd]
        # codex style ["bash", "-lc", "<script>"] keeps working as a plain argv.
        return shlex.join(cmd)
    if isinstance(cmd, str):
        return cmd
    return None


def _tool_paths(tool_input: dict) -> list[str]:
    out = []
    # Every path field is read, and a field may hold a list of paths.
    for key in ("file_path", "path", "paths", "notebook_path", "filename", "target_file", "absolute_path"):
        v = tool_input.get(key)
        out += [p for p in (v if isinstance(v, list) else [v]) if isinstance(p, str) and p]
    return out


def classify(
    tool: str, tool_input: dict, *, cwd: str, workspace: str, protected_branches: frozenset[str] | None = None,
) -> Verdict:
    """``protected_branches``: the user's list (store); None = the defaults."""
    acc = _Acc()
    ctx = _ctx(cwd, workspace, protected_branches)
    name = (tool or "").strip().lower()
    tool_input = tool_input if isinstance(tool_input, dict) else {}
    if name == "prompt":
        # The rendered text of a permission prompt (chat relay).
        return classify_prompt_text(str(tool_input.get("text") or ""), workspace=workspace,
                                    protected_branches=protected_branches)
    mcp = _mcp_tool(name)
    if mcp == "process-input":
        mcp, tool_input = "shell", {"command": tool_input.get("input")}
    if mcp == "shell":
        # The server picks the shell: a POSIX shell, or PowerShell / cmd on
        # Windows. Unless the call names POSIX or PowerShell, grade both and
        # keep the worse; cmd has no dialect of its own here, so it is also
        # marked not statically judgeable.
        dialect = _mcp_shell_dialect(tool_input.get("shell"))
        if dialect in (None, "cmd"):
            kw = {"cwd": cwd, "workspace": workspace, "protected_branches": protected_branches}
            both = _worse(classify("shell", tool_input, **kw), classify("powershell", tool_input, **kw))
            if dialect == "cmd" and _tool_command(tool_input):
                opaque = _Acc()
                opaque.opaque("untokenizable-shape", "cmd syntax is not modelled")
                both = _worse(both, opaque.verdict())
            return both
        mcp = dialect
    if mcp == "write-pdf":
        mcp, tool_input = "write", {"paths": [p for p in (tool_input.get("path"), tool_input.get("outputPath")) if p]}
    if mcp in MCP_ACTIONS:
        _classify_mcp_action(mcp, tool_input, ctx, acc)
        return acc.verdict()
    if mcp is not None:
        name = mcp
    if name in SHELL_TOOLS:
        command = _tool_command(tool_input)
        if command and name == "powershell":
            # A backslash separates paths in PowerShell rather than escaping; '/' is equivalent there.
            command = command.replace("\\", "/")
        if command and len(command) > MAX_COMMAND_CHARS:
            # shlex is quadratic in a token's length: a padded command took
            # longer than the hook's budget and so failed open unexamined.
            acc.hit("high", "too-long", f"command is longer than {MAX_COMMAND_CHARS} characters")
            acc.opaque("too-long", "command is too long to analyse")
        elif command:
            if name != "powershell" and not _in_modelled_subset(command):
                # The rules below still run, so a level they find is never lowered.
                acc.opaque("untokenizable-shape", "command uses shell syntax the analyser cannot model")
            _classify_script(command, ctx, acc)
    elif name in WRITE_TOOLS or name in READ_TOOLS:
        for raw in _tool_paths(tool_input):
            path = _resolve(raw, ctx)
            if path is None:
                acc.opaque("dynamic-path", f"path is not static: {raw}")
                continue
            _check_path(acc, path, ctx, write=name in WRITE_TOOLS)
    elif name in GREP_TOOLS or name in GLOB_TOOLS:
        _check_search(acc, name, tool_input, ctx)
    return acc.verdict()


def _mcp_tool(name: str) -> str | None:
    """The MCP_TOOLS row for an `mcp__<server>__<tool>` name, else None."""
    if not name.startswith("mcp__"):
        return None
    server, sep, tool = name[len("mcp__"):].rpartition("__")
    return MCP_TOOLS.get(tool) if server and sep else None


def _mcp_shell_dialect(shell: object) -> str | None:
    """"powershell", "shell" or "cmd" for the shell an MCP call names, else None."""
    if not isinstance(shell, str) or not shell.strip():
        return None
    base = re.split(r"[\\/]", shell.strip())[-1].lower().removesuffix(".exe")
    if base in ("powershell", "pwsh"):
        return "powershell"
    if base == "cmd":
        return "cmd"
    return "shell" if base in SHELLS else None


def _worse(a: Verdict, b: Verdict) -> Verdict:
    """Both verdicts' rules, the higher level, and parseable only if both are."""
    rules, reasons = list(a.rule_ids), list(a.reasons)
    for rule, reason in zip(b.rule_ids, b.reasons):
        if rule not in rules:
            rules.append(rule)
            reasons.append(reason)
    level = a.level if LEVEL_ORDER[a.level] >= LEVEL_ORDER[b.level] else b.level
    return Verdict(level, tuple(rules), tuple(reasons), a.parseable and b.parseable)


def _classify_mcp_action(kind: str, tool_input: dict, ctx: _Ctx, acc: _Acc) -> None:
    """MCP tools that act through arguments rather than a command line."""
    mode = str(tool_input.get("mode") or "").strip().lower()
    if kind in _MCP_MODES and mode not in _MCP_MODES[kind]:
        acc.opaque("mcp-unknown-mode", f"MCP tool mode is not one Guard knows: {mode or '(none)'}")
        return
    if kind in ("filesystem", "move-file"):
        path = tool_input.get("source" if kind == "move-file" else "path")
        if not isinstance(path, str) or not path:
            return
        if mode == "delete":
            # Graded as the rm it amounts to, so the rm rules decide. Any value
            # the server could read as true counts as recursive.
            recursive = str(tool_input.get("recursive")).strip().lower() not in _FALSE_WORDS
            _classify_rm(["--", path], ctx, acc, from_stdin=False, recursive=recursive)
            return
        dest = tool_input.get("destination")
        if kind == "move-file":
            mode = "move"
        writes = {"write": [path], "move": [path, dest], "copy": [dest]}.get(mode, [])
        reads = [path] if mode in ("read", "copy") else []
        for raw, write in [(r, True) for r in writes] + [(r, False) for r in reads]:
            if not isinstance(raw, str) or not raw:
                continue
            resolved = _resolve(raw, ctx)
            if resolved is None:
                acc.opaque("dynamic-path", f"path is not static: {raw}")
            else:
                _check_path(acc, resolved, ctx, write=write)
    elif kind == "registry":
        if mode in ("set", "delete"):
            acc.hit("high", "mcp-registry-write", f"MCP tool changes the Windows registry ({mode})")
    elif kind == "process-kill" or mode == "kill":
        acc.hit("high", "mcp-process-kill", "MCP tool kills a process")


def _check_search(acc: _Acc, name: str, tool_input: dict, ctx: _Ctx) -> None:
    """Grep / Glob: the locations they reach, against the same credential
    rules as Read (grep) and ls (glob). These tools expand nothing, so a path
    that does not resolve statically is skipped rather than made opaque."""
    # Copilot CLI names the root `paths`: one directory, or a list of them.
    # Both keys are read: a call carrying both reaches every root it names.
    roots = []
    for root in (tool_input.get("path"), tool_input.get("paths")):
        roots += [r for r in (root if isinstance(root, list) else [root]) if isinstance(r, str) and r]
    # Glob's pattern and Grep's glob filter are paths under root (or absolute).
    sub = tool_input.get("pattern" if name in GLOB_TOOLS else "glob")
    sub = _glob_dialect(sub) if isinstance(sub, str) and sub else None
    raws = list(roots)
    if sub:
        absolute = sub.startswith(("/", "~")) or _isabs(sub) or any(sub.startswith(t) for t in _HOME_TOKENS)
        if name in GREP_TOOLS and not absolute and "/" not in sub:
            # ripgrep matches a glob without '/' against the file name at any depth.
            sub = "**/" + sub
        raws += [sub] if absolute or not roots else [posixpath.join(r, sub) for r in roots]
    # A {a,b} brace is checked as each path it expands to; wildcards that can
    # expand into a store below the literal base count as naming that store.
    for raw in [v for r in raws for v in _expand_braces(r)]:
        path = _resolve(raw, ctx)
        if path is not None:
            _check_path(acc, path, ctx, write=False, list_only=name in GLOB_TOOLS)
            for store, named in _stores_reached(path, ctx):
                # A grep that only sweeps a store in (naming no store or secret
                # file) counts as no more than grepping the bare root: normal.
                if named or name in GLOB_TOOLS:
                    _check_path(acc, store, ctx, write=False, list_only=name in GLOB_TOOLS)


_TOOL_CALL_RE = re.compile(r"\b[A-Z][A-Za-z]*\((.+)\)\s*$")
_BOX_CHARS = "│┃║|╭╮╰╯─━═>❯›•●○◯▸▶*⎿ \t"


def classify_prompt_text(text: str, *, workspace: str, protected_branches: frozenset[str] | None = None) -> Verdict:
    """Screen the rendered text of a CLI permission prompt (relay path).

    The prompt layout differs per vendor, so every line is classified as if
    it were a command, tool-call wrappers like ``Bash(rm -rf x)`` are
    unwrapped, and the most severe level wins. Lines that are prose simply
    come out "normal". Parseability only reflects lines that parsed as shell.
    """
    acc = _Acc()
    ctx = _ctx(workspace, workspace, protected_branches)
    for raw_line in (text or "").splitlines():
        line = raw_line.strip().strip(_BOX_CHARS).strip()
        if not line:
            continue
        if line.startswith("$ "):
            line = line[2:]
        # A bare path line ("Read file\n  ~/.ssh/id_rsa") is not a command
        # argument, so screen every path-looking word directly as well.
        for word in re.split(r"[\s()'\"`,]+", line):
            for cand in _arg_paths(word):
                path = _resolve(cand, ctx)
                if path:
                    _check_path(acc, path, ctx, write=False)
        m = _TOOL_CALL_RE.search(line)
        candidates = [line] + ([m.group(1)] if m else [])
        for cand in candidates:
            sub = _Acc()
            _classify_script(cand, _Ctx(ctx.cwd, ctx.workspace, ctx.home, env_home=ctx.env_home, protected=ctx.protected), sub)
            if "unbalanced-quotes" in sub.rules:
                # Prose with apostrophes ("don't ask again"): retry without quotes.
                sub = _Acc()
                _classify_script(re.sub(r"[\"'`]", " ", cand), _Ctx(ctx.cwd, ctx.workspace, ctx.home, env_home=ctx.env_home, protected=ctx.protected), sub)
            for rule, reason in zip(sub.rules, sub.reasons):
                if rule != "unbalanced-quotes" and rule not in acc.rules:
                    acc.rules.append(rule)
                    acc.reasons.append(reason)
            if LEVEL_ORDER[sub.level] > LEVEL_ORDER[acc.level]:
                acc.level = sub.level
            if not sub.parseable and set(sub.rules) - {"unbalanced-quotes"}:
                acc.parseable = False
    return acc.verdict()

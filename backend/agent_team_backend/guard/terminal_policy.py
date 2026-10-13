"""Which command lines may be typed into a plain terminal pane.

A plain terminal (agent key ``terminal``) is the user's login shell: whatever
reaches it runs with the user's privileges, and it has none of the CLI tool
hooks the rest of Guard works through. So text an agent, an MCP client or a
SPAWN block would type into one is checked here, on the backend, before it is
written to the PTY — and refused outright, whatever the Guard switch says
(the same stance as the chat-relay veto): the person who could approve it is
not the one typing it.

The check is deterministic, like classify(): the line is split into segments
(``;`` ``&&`` ``||`` ``|`` ``&``, newlines, ``$( )`` and backticks), every
segment goes through Guard's own classifier plus the explicit rules below,
and one refused segment refuses the whole payload.

Settings (Settings → Security → Terminal command protection) are read on
every check through the store, which caches them until they change:
built-in categories can be switched off one by one, user block patterns add
refusals, and user allow prefixes exempt a segment from the built-in checks.
A block pattern outranks an allow prefix, and an allow prefix never exempts a
pipeline that feeds a download into a shell.
"""

from __future__ import annotations

import fnmatch
import os
import re
from dataclasses import dataclass, field

from .classify import (
    _HOME_TOKENS,
    DOWNLOADERS,
    MAX_COMMAND_CHARS,
    PROTECTED_BRANCHES,
    WRAPPERS_NO_ARG,
)
from .classify import classify as _classify


@dataclass(frozen=True)
class Category:
    id: str
    description: str
    example: str


#: Built-in refusal categories, in display order. On by default except those
#: in DEFAULT_OFF; a category missing from the store (one added in a later
#: version) takes its default.
CATEGORIES: tuple[Category, ...] = (
    Category("rm-system", "Recursive delete of the root, your home, or anything outside the workspace",
             "rm -rf ~   ·   Remove-Item -Recurse C:\\"),
    Category("privilege", "Running as another user or as administrator", "sudo …   ·   su -   ·   doas …"),
    Category("disk", "Formatting, erasing, repartitioning or raw-writing a disk",
             "mkfs  ·  dd of=/dev/disk2  ·  diskutil eraseDisk  ·  format C:"),
    Category("power", "Shutting down, rebooting or halting the machine", "shutdown -h now   ·   reboot"),
    Category("mass-kill", "Killing processes by name or pattern, or every process",
             "killall Finder   ·   pkill -f python"),
    Category("recursive-perms", "Recursive permission or owner change on the root, your home or a system folder",
             "chmod -R 777 /   ·   chown -R me ~"),
    Category("system-write", "Writing into system folders", "echo x > /etc/hosts   ·   cp a /usr/bin/"),
    Category("service-disable", "Stopping, unloading or disabling system services",
             "launchctl unload …   ·   systemctl disable sshd"),
    Category("fork-bomb", "Fork bombs", ":(){ :|:& };:"),
    Category("pipe-to-shell", "Running a script straight from the network", "curl https://… | sh"),
    Category("credential", "Reading, copying or deleting credential files (SSH keys, cloud keys, Keychain, .env)",
             "cat ~/.ssh/id_rsa"),
    Category("force-push-main", "Force-pushing to or deleting main / master", "git push --force origin main"),
    Category("classifier-critical", "Anything else Guard's classifier rates critical",
             "terraform destroy   ·   kubectl delete …"),
    Category("classifier-high", "Anything else Guard's classifier rates high", "git push   ·   git reset --hard"),
    Category("unanalyzable", "Lines that cannot be judged statically (computed command names, eval)",
             "$CMD -rf /   ·   eval \"$X\""),
)
CATEGORY_IDS = tuple(c.id for c in CATEGORIES)
#: Off unless the user turns them on: the generic "high" bucket holds everyday
#: operations (git push, git reset --hard, rm -rf node_modules inside the
#: workspace), not damage to the system.
DEFAULT_OFF = frozenset({"classifier-high"})

#: Classifier rule ids owned by a specific category. A hit whose rule is not
#: listed falls to classifier-critical / classifier-high by its level.
_RULE_CATEGORY = {
    "rm-root-or-home": "rm-system",
    "rm-outside-workspace": "rm-system",
    "rm-workspace-root": "rm-system",
    "sudo": "privilege",
    "disk-format": "disk",
    "disk-write": "disk",
    "pipe-download-to-shell": "pipe-to-shell",
    "download-then-exec": "pipe-to-shell",
    "credential-access": "credential",
    "credential-exfil": "credential",
    "credential-path-list": "credential",
    "keychain-access": "credential",
    "dotenv-outside-workspace": "credential",
    "git-force-push-protected": "force-push-main",
    # A recursive delete whose target is only known at run time (X=/; rm -rf
    # $X) cannot be judged, which is what "unanalyzable" refuses.
    "rm-unresolved-target": "unanalyzable",
}
#: Pipeline-context rules: judged on the whole line, never exempted by an
#: allow prefix on one of its segments.
_PIPELINE_RULES = {"pipe-download-to-shell", "download-then-exec", "decode-and-exec"}
#: Opaque verdicts that mean "cannot be judged" rather than "an unknown script".
_UNANALYZABLE_RULES = {"dynamic-command", "eval", "unbalanced-quotes", "nesting-too-deep", "too-long",
                       "decode-and-exec", "stdin-script", "dynamic-stdin-script"}
#: Opaque-only notes that are not a danger by themselves (an unknown script, a
#: python -c): they share the verdict's level but never decide a refusal. An
#: unparsed heredoc's lines were screened as shell, which decides on its own.
_NOTE_RULES = {"unknown-script", "interpreter-inline-code", "dynamic-path", "heredoc-unparsed",
               "untokenizable-shape"}

_MAX_PATTERN = 500
_MAX_TEXT = MAX_COMMAND_CHARS


@dataclass(frozen=True)
class Settings:
    disabled: frozenset[str] = DEFAULT_OFF
    block_patterns: tuple[str, ...] = ()
    allow_prefixes: tuple[str, ...] = ()
    # Shared with Guard's CLI grading (store guard_protected_branches).
    protected_branches: frozenset[str] = frozenset(PROTECTED_BRANCHES)


@dataclass(frozen=True)
class Refusal:
    rule: str  # a category id, or "block-pattern"
    segment: str
    reason: str
    pattern: str = ""

    def message(self) -> str:
        what = f"refused to type into a terminal: `{_clip(self.segment)}` — {self.reason}"
        return f"{what}. Run it yourself in the terminal if you really mean to."

    def as_dict(self) -> dict[str, str]:
        out = {"rule": self.rule, "segment": self.segment, "reason": self.reason, "message": self.message()}
        if self.pattern:
            out["pattern"] = self.pattern
        return out


@dataclass
class _Found:
    refusal: Refusal | None = None
    rules: list[str] = field(default_factory=list)


def _clip(text: str, n: int = 120) -> str:
    text = " ".join(text.split())
    return text if len(text) <= n else text[: n - 1] + "…"


# ── pattern validation ─────────────────────────────────────────────────────

def validate_pattern(pattern: str) -> str | None:
    """Why a user pattern cannot be stored, or None. Patterns are globs
    (``*`` ``?`` ``[...]``) when they contain one, otherwise a plain substring
    of a segment — the same matching Guard's own user rules use."""
    p = (pattern or "").strip()
    if not p:
        return "the pattern is empty"
    if len(p) > _MAX_PATTERN:
        return f"the pattern is longer than {_MAX_PATTERN} characters"
    if any(ord(ch) < 32 for ch in p):
        return "the pattern contains a control character"
    if p.count("[") != p.count("]"):
        return "the pattern has an unclosed [ ]"
    if set(p) <= set("*? "):
        return "the pattern would match every command"
    return None


def _pattern_matches(pattern: str, segment: str) -> bool:
    p = pattern.strip()
    s = " ".join(segment.split())
    if any(ch in p for ch in "*?["):
        return fnmatch.fnmatchcase(s, p) or fnmatch.fnmatchcase(s, p + "*") or fnmatch.fnmatchcase(s, "*" + p + "*")
    return p in s


def _allowed(prefixes: tuple[str, ...], segment: str) -> bool:
    s = " ".join(segment.split())
    for p in prefixes:
        p = " ".join(p.split())
        if p and (s == p or s.startswith(p + " ")):
            return True
    return False


# ── segmentation ───────────────────────────────────────────────────────────

def segments(text: str) -> list[str]:
    """Every command segment of a line, substitutions included, in order.

    Tolerant on purpose: a backslash escapes only a quote, a space or a shell
    operator, so a Windows path (``C:\\Windows``) survives, and quotes are
    tracked so an operator inside them does not split."""
    out: list[str] = []
    _segments_into(text, out, 0)
    return [s for s in (x.strip() for x in out) if s]


def _segments_into(text: str, out: list[str], depth: int) -> None:
    cur: list[str] = []
    i, n = 0, len(text)
    sq = dq = False

    def flush() -> None:
        out.append("".join(cur))
        cur.clear()

    while i < n:
        c = text[i]
        if c == "\\" and not sq and i + 1 < n and text[i + 1] in "\"' ;&|`$()\n":
            cur.append(text[i:i + 2])
            i += 2
            continue
        if c == "'" and not dq:
            sq = not sq
        elif c == '"' and not sq:
            dq = not dq
        elif not sq and (text.startswith("$(", i) or (not dq and text[i:i + 2] in ("<(", ">("))):
            level, j = 1, i + 2
            while j < n and level:
                level += {"(": 1, ")": -1}.get(text[j], 0)
                j += 1
            inner = text[i + 2:j - 1] if level == 0 else text[i + 2:]
            if depth < 8:
                _segments_into(inner, out, depth + 1)
            cur.append(text[i:j])
            i = j
            continue
        elif c == "`" and not sq:
            j = text.find("`", i + 1)
            j = n if j < 0 else j
            if depth < 8:
                _segments_into(text[i + 1:j], out, depth + 1)
            cur.append(text[i:j + 1])
            i = j + 1
            continue
        elif not sq and not dq and (c in ";\n" or c in "&|"):
            flush()
            i += 1
            while i < n and text[i] in "&|":
                i += 1
            continue
        cur.append(c)
        i += 1
    flush()


# ── explicit rules ─────────────────────────────────────────────────────────

#: A cmd switch (/s, /q, /?) — a bare "/" is the root, not a switch.
_WIN_SWITCH = re.compile(r"^/[a-z?]$", re.I)
_WIN_DRIVE_ROOT = re.compile(r"^[a-z]:[\\/]*\*?$", re.I)
_SYSTEM_DIRS = ("/etc", "/private/etc", "/system", "/usr", "/bin", "/sbin", "/library", "/boot",
                "/var/db", "/private/var/db", "c:/windows", "c:/program files", "c:/program files (x86)")
_FORK_BOMB = re.compile(r"(\S+)\s*\(\s*\)\s*\{[^}]*\1\s*\|\s*\1\s*&[^}]*\}")
_DOWNLOADER_WORDS = DOWNLOADERS | {"iwr", "irm", "invoke-webrequest", "invoke-restmethod"}


def _words(segment: str) -> list[str]:
    """Unquoted words; the command word is also stripped of backslashes (in a
    POSIX shell ``r\\m`` is ``rm``)."""
    words: list[str] = []
    for raw in re.findall(r"\"[^\"]*\"|'[^']*'|\S+", segment):
        words.append(raw.replace('"', "").replace("'", ""))
    return words


def _command(words: list[str]) -> tuple[str, list[str]]:
    """The command word (lowercased, path and .exe dropped) after the
    wrappers classify() also strips, and its arguments."""
    i = 0
    while i < len(words):
        # Escape characters mean nothing in a command name but hide it: POSIX
        # "\\" (r\\m), cmd "^" (r^d), PowerShell "`" (Re`move-Item).
        w = words[i]
        if "/" not in w and ":" not in w:
            w = w.replace("\\", "")
        w = w.replace("^", "").replace("`", "")
        base = w.rsplit("/", 1)[-1].lower().removesuffix(".exe")
        if re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", words[i]) or base in WRAPPERS_NO_ARG | {"env", "nice", "!"}:
            i += 1
            continue
        return base, words[i + 1:]
    return "", []


def _home_like(arg: str, home: str) -> bool:
    a = arg.rstrip("/\\")
    if a in ("~", "") or a in _HOME_TOKENS:
        return True
    return bool(home) and a.lower() == home.rstrip("/").lower()


def _root_or_home(arg: str, home: str) -> bool:
    a = arg.replace("\\", "/")
    return a.rstrip("/*") == "" or _home_like(a.rstrip("*"), home) or bool(_WIN_DRIVE_ROOT.match(arg))


def _system_path(arg: str) -> bool:
    a = arg.replace("\\", "/").lower().rstrip("/")
    return any(a == d or a.startswith(d + "/") for d in _SYSTEM_DIRS)


def _explicit(segment: str, home: str) -> tuple[str, str] | None:
    """(category, reason) for an explicitly destructive segment, or None."""
    if _FORK_BOMB.search(segment):
        return "fork-bomb", "a fork bomb exhausts the machine's processes"
    words = _words(segment)
    word, args = _command(words)
    if not word:
        return None
    lower = [a.lower() for a in args]
    flags = {a for a in lower if a.startswith("-") or _WIN_SWITCH.match(a)}
    # privilege
    if word in {"sudo", "su", "doas", "pkexec", "runas", "gsudo"} or (
        word == "start-process" and "-verb" in lower and "runas" in lower
    ):
        return "privilege", f"{word} runs the command with elevated privileges"
    # disk
    if word.startswith(("mkfs", "newfs")) or word in {"fdisk", "sfdisk", "gdisk", "parted", "gpt", "wipefs",
                                                       "diskpart", "format-volume", "clear-disk",
                                                       "initialize-disk", "remove-partition"}:
        return "disk", f"{word} formats, erases or repartitions a disk"
    if word == "format" and args and re.match(r"^[a-z]:", args[0], re.I):
        return "disk", f"format {args[0]} erases a drive"
    if word == "dd" and any(a.startswith("of=/dev/") for a in lower):
        return "disk", "dd writes raw data onto a device"
    if word == "diskutil" and lower and lower[0].startswith(("erase", "zero", "random", "secureerase",
                                                               "partition", "reformat")):
        return "disk", f"diskutil {args[0]} erases or repartitions a disk"
    # power
    if word in {"shutdown", "reboot", "halt", "poweroff", "stop-computer", "restart-computer"} or (
        word in {"init", "telinit"} and args[:1] in (["0"], ["6"])
    ) or (word == "systemctl" and lower[:1] in (["poweroff"], ["reboot"], ["halt"])):
        return "power", f"{word} shuts down or restarts the machine"
    # mass kill
    if word in {"killall", "pkill", "killall5"} or (word == "kill" and "-1" in args) or (
        word == "taskkill" and ("/im" in lower or "/f" in lower)
    ) or (word == "stop-process" and "-name" in lower):
        return "mass-kill", f"{word} kills processes by name, pattern or all at once"
    # recursive delete (incl. Windows forms)
    recursive = bool(flags & {"-r", "-rf", "-fr", "-R".lower(), "--recursive", "-recurse", "/s"}) or any(
        a.startswith("-") and not a.startswith("--") and "r" in a[1:] for a in lower if word == "rm"
    )
    if word in {"rm", "remove-item", "ri", "rmdir", "rd", "del", "erase"} and recursive:
        targets = [a for a in args if not a.startswith("-") and not _WIN_SWITCH.match(a)]
        for t in targets:
            if _root_or_home(t, home) or _system_path(t):
                return "rm-system", f"recursively deletes the root, your home or a system folder: {t}"
    # recursive permission change
    if word in {"chmod", "chown", "chgrp", "icacls", "takeown"} and (
        flags & {"-r", "--recursive", "/t", "/r"} or any(re.match(r"^-[a-z]*r", a) for a in lower)
    ):
        for t in args:
            if not t.startswith("-") and (_root_or_home(t, home) or _system_path(t)):
                return "recursive-perms", f"recursively changes permissions or owner of {t}"
    # service disable
    if word == "launchctl" and lower and lower[0] in {"unload", "disable", "bootout", "remove", "kill"}:
        return "service-disable", f"launchctl {args[0]} stops or disables a service"
    if word == "systemctl" and lower and lower[0] in {"disable", "stop", "mask", "kill"}:
        return "service-disable", f"systemctl {args[0]} stops or disables a service"
    if (word == "sc" and lower and lower[0] in {"stop", "delete", "config"}) or word in {"stop-service",
                                                                                        "remove-service"} or (
        word == "set-service" and "disabled" in lower
    ):
        return "service-disable", f"{word} stops or disables a service"
    # writes into system folders: redirections and writing commands
    for m in re.finditer(r">>?\s*(\"[^\"]+\"|'[^']+'|\S+)", segment):
        target = m.group(1).strip("\"'")
        if _system_path(target):
            return "system-write", f"writes into a system folder: {target}"
    writers = {"cp", "mv", "tee", "install", "ln", "rsync", "touch", "truncate", "sed", "rm", "copy-item",
               "move-item", "set-content", "out-file", "new-item", "copy", "move", "xcopy", "robocopy"}
    if word in writers:
        for t in args:
            if not t.startswith("-") and _system_path(t):
                return "system-write", f"{word} writes into a system folder: {t}"
    # PowerShell pipe-to-shell (the POSIX forms are the classifier's)
    if word in {"iex", "invoke-expression"} and any(w.lower().lstrip("(") in _DOWNLOADER_WORDS for w in words):
        return "pipe-to-shell", "runs a script fetched from the network"
    return None


# ── the check ──────────────────────────────────────────────────────────────

def _category_of(rule: str, level: str) -> str:
    if rule in _UNANALYZABLE_RULES or rule == "rm-unresolved-target":
        return "unanalyzable"
    return _RULE_CATEGORY.get(rule) or ("classifier-critical" if level == "critical" else "classifier-high")


#: Every way a terminal's shell may read the line. Which shell a terminal pane
#: runs is not the host's to assume — a Windows machine runs Git Bash, WSL or
#: msys as readily as PowerShell or cmd, and any of them can be started inside
#: the pane — so a line is judged as each would read it, and a refusal under
#: any one refuses it. "bash" unescapes backslashes (r\m is rm); "powershell"
#: reads them as path separators.
_LEXERS = ("bash", "powershell")


def _classifier_hits(text: str, workspace: str, protected: frozenset[str]) -> list[tuple[str, str, str]]:
    """(rule, level, reason) for every classifier hit on ``text``, under every
    shell in _LEXERS. Opaque verdicts come back with level "opaque";
    unbalanced quotes count only when no shell could parse the line."""
    hits: list[tuple[str, str, str]] = []
    unparsed = 0
    for tool in _LEXERS:
        v = _classify(tool, {"command": text}, cwd=workspace, workspace=workspace, protected_branches=protected)
        if "unbalanced-quotes" in v.rule_ids and "\\" in text:
            # A Windows path's backslashes read as escapes to a POSIX lexer;
            # judge the line with them as the separators they are.
            v2 = _classify(tool, {"command": text.replace("\\", "/")}, cwd=workspace, workspace=workspace,
                           protected_branches=protected)
            if "unbalanced-quotes" not in v2.rule_ids:
                v = v2
        for rule, reason in zip(v.rule_ids, v.reasons):
            if rule in _NOTE_RULES:
                continue
            if rule == "unbalanced-quotes":
                unparsed += 1
                continue
            # classify() reports one level for the whole verdict; rules it gave
            # a lower level to still read as that level here, which errs on
            # the side of refusing.
            level = "opaque" if rule in _UNANALYZABLE_RULES else v.level
            if (rule, level, reason) not in hits:
                hits.append((rule, level, reason))
    if unparsed == len(_LEXERS):
        hits.append(("unbalanced-quotes", "opaque", "command has unbalanced quotes"))
    return hits


def check(text: str, *, workspace: str, settings: Settings | None = None) -> Refusal | None:
    """The refusal for typing ``text`` into a plain terminal, or None."""
    settings = settings or Settings()
    enabled = [c for c in CATEGORY_IDS if c not in settings.disabled]
    home = os.path.expanduser("~")
    text = text or ""
    if len(text) > _MAX_TEXT:
        return Refusal("unanalyzable", text[:80], "the command is too long to check") if "unanalyzable" in enabled else None
    segs = segments(text)
    # 0. a fork bomb spans the separators it is built from
    if _FORK_BOMB.search(text) and "fork-bomb" in enabled:
        return Refusal("fork-bomb", text, "a fork bomb exhausts the machine's processes")
    # 1. user block patterns, on every segment and on the whole line
    for seg in segs + [text]:
        for p in settings.block_patterns:
            if _pattern_matches(p, seg):
                return Refusal("block-pattern", seg, f"matches your block pattern `{p}`", pattern=p)
    # 2. pipeline-context rules on the whole line (never exempted by allow)
    for rule, level, reason in _classifier_hits(text, workspace, settings.protected_branches):
        if rule in _PIPELINE_RULES:
            cat = _category_of(rule, level if level != "opaque" else "high")
            if rule == "decode-and-exec":
                cat = "unanalyzable"
            if cat in enabled:
                return Refusal(cat, text, reason)
    # 3. every segment on its own
    for seg in segs:
        if _allowed(settings.allow_prefixes, seg):
            continue
        hit = _explicit(seg, home)
        if hit and hit[0] in enabled:
            return Refusal(hit[0], seg, hit[1])
        for rule, level, reason in _classifier_hits(seg, workspace, settings.protected_branches):
            if rule in _PIPELINE_RULES:
                continue
            if level == "opaque":
                if "unanalyzable" in enabled:
                    return Refusal("unanalyzable", seg, reason)
                continue
            if level == "normal":
                continue
            cat = _category_of(rule, level)
            if cat in enabled:
                return Refusal(cat, seg, reason)
    return None


def check_with_store(text: str, *, workspace: str) -> Refusal | None:
    """check() against the settings the user has saved (read on every call;
    the store caches them until they change)."""
    from . import runtime

    return check(text, workspace=workspace, settings=runtime.store().terminal_settings())


def enforce(text: str, *, workspace: str, pane_id: str, via: str) -> Refusal | None:
    """check_with_store(), and when it refuses: an audit row and a
    guard.decision event (the window shows it as a notice on that pane).
    ``via`` names the path that tried to type it (cli_send, cli_open_agent,
    agent_msg.route, terminal.input). Bookkeeping never overturns a refusal,
    and a checker error refuses rather than letting the line through."""
    import logging
    import time

    from . import runtime

    log = logging.getLogger(__name__)
    try:
        refusal = check_with_store(text, workspace=workspace)
    except Exception as err:  # noqa: BLE001 - fail closed: this is a shell
        log.warning("guard: terminal check failed; refusing: %s", err, exc_info=True)
        refusal = Refusal("guard-error", text[:200], f"the terminal command check failed ({err})")
    if refusal is None:
        return None
    try:
        runtime.store().audit_add({
            "ts": time.time(), "pane_id": pane_id or "", "vendor": "terminal", "source": "agent",
            "tool": f"terminal:{via}", "excerpt": _clip(refusal.segment, 200), "level": "critical",
            "action": "deny", "rule_ids": (f"terminal-{refusal.rule}",), "tainted": False,
        })
    except Exception:  # noqa: BLE001
        log.warning("guard: terminal refusal audit failed; refusal stands", exc_info=True)
    try:
        runtime.emit("guard.decision", {
            "pane_id": pane_id, "action": "deny", "level": "critical",
            "reason": refusal.message(), "excerpt": _clip(refusal.segment, 200),
        })
    except Exception:  # noqa: BLE001
        log.warning("guard: terminal refusal event failed; refusal stands", exc_info=True)
    return refusal

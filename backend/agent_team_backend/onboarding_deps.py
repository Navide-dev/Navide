"""Onboarding dependency registry + detection.

Single source of truth for the first-run environment wizard. Each `Dep`
describes how to detect a tool and (where safe) how to install it. The frontend
only renders backend-computed status — it never hardcodes commands. Install is
driven by `dep_id` against this whitelist, mirroring the git-config allowlist
security model.

Platform-aware: a dep declares which platforms it exists for and how each one
installs it (`Dep.platforms` / `Dep.install_cmds`). A platform with no install
command gets the docs link rather than a command naming a package manager that
is not there — which is what every entry used to do off macOS.
"""

from __future__ import annotations

import json
import hashlib
import logging
import os
import re
import shlex
import signal
import sqlite3
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from . import osplat
from .applog import app_data_dir
from .cli_vendors.base import Dep, PlatformInstall
from .cli_vendors.registry import VENDORS
from .db import DB_FILENAME, Database
from .profiles_store import default_profiles_root

log = logging.getLogger("agent_team_backend.onboarding_deps")




# ── Registry ──────────────────────────────────────────────────────────────────
# NOTE: Agent-CLI install commands are best-effort and may change upstream; they
# are marked needs_terminal so the user runs/authenticates them interactively.

# The wizard's historical display order. Vendors missing from this tuple (a
# newly contributed CLI) append in registry order — never silently dropped, and
# a contributor does not need to touch this file.
_AGENT_CLI_ORDER = ("claude", "codex", "antigravity", "grok", "kimi", "opencode",
                    "kilo", "qwen", "pi", "copilot", "cursor", "aider")


def _agent_cli_deps() -> list[Dep]:
    declared = {key: spec.install_dep for key, spec in VENDORS.items()
                if spec.install_dep is not None}
    ordered = [declared.pop(key) for key in _AGENT_CLI_ORDER if key in declared]
    ordered.extend(declared.values())
    return ordered


DEPS: list[Dep] = [
    # Step 1 — Foundation
    # macOS-only by definition. Listed at all on Linux it would read as
    # "your machine is missing something", when what is missing is a package
    # manager for a different operating system.
    Dep("homebrew", "Homebrew", "macOS package manager", "foundation",
        ["brew", "--version"], r"Homebrew (\d+\.\d+\.\d+)",
        needs_terminal=True, requires_binaries=("curl",), docs_url="https://brew.sh",
        platforms=("darwin",),
        install_cmds={
            "darwin": PlatformInstall(
                '/bin/bash -c "$(curl -fsSL '
                'https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
                ("curl",),
                needs_terminal=True,
            ),
        }),
    # Unversioned formula on purpose: node@22 is keg-only, so `node` would
    # stay off PATH after a successful install and detection would never pass.
    #
    # No Linux entry: Node ships no official install script, and every
    # distribution's own package is a different command with a different
    # version policy. Guessing one would be worse than the docs link.
    Dep("node", "Node.js", "JavaScript runtime (≥ 22)", "foundation",
        ["node", "--version"], r"v?(\d+\.\d+\.\d+)", min_version="22.0.0",
        docs_url="https://nodejs.org",
        install_cmds={
            "darwin": PlatformInstall("brew install node", ("brew",)),
            # The LTS MSI installs machine-wide and asks for elevation, so
            # the UAC prompt needs a terminal the user can see.
            "win32": PlatformInstall(
                "winget install --id OpenJS.NodeJS.LTS -e", ("winget",), needs_terminal=True
            ),
        }),
    Dep("pnpm", "pnpm", "Package manager", "foundation",
        ["pnpm", "--version"], r"(\d+\.\d+\.\d+)",
        docs_url="https://pnpm.io",
        install_cmds={
            "darwin": PlatformInstall("brew install pnpm", ("brew",)),
            # pnpm's own installer, from pnpm.io. Writes under the user's home
            # and needs no elevation, so it can run inline like the brew one.
            "linux": PlatformInstall(
                "curl -fsSL https://get.pnpm.io/install.sh | sh -", ("curl",)
            ),
            # Per-user standalone exe, no elevation. The agreement flags keep a
            # first-run winget from stopping at a prompt nobody can answer
            # when the command runs inline with its output captured.
            "win32": PlatformInstall(
                "winget install --id pnpm.pnpm -e "
                "--accept-source-agreements --accept-package-agreements",
                ("winget",),
            ),
        }),
    # Unversioned formula on purpose: versioned kegs (python@3.12) only link
    # `python3.12`, never `python3`, so detection (`python3 --version`) would
    # keep failing after a successful install.
    #
    # No Linux entry: python3 is present on every distribution we would ship
    # to, and replacing a distribution's Python is a good way to break it.
    Dep("python", "Python", "Python 3.12+", "foundation",
        ["python3", "--version"], r"Python (\d+\.\d+\.\d+)", min_version="3.12.0",
        docs_url="https://python.org",
        install_cmds={
            "darwin": PlatformInstall("brew install python3", ("brew",)),
            "win32": PlatformInstall(
                "winget install --id Python.Python.3.12 -e", ("winget",), needs_terminal=True
            ),
        }),
    Dep("uv", "uv", "Python package and environment manager", "foundation",
        ["uv", "--version"], r"uv (\d+\.\d+\.\d+)",
        docs_url="https://docs.astral.sh/uv",
        install_cmds={
            "darwin": PlatformInstall("brew install uv", ("brew",)),
            # Astral's own installer. Unpacks into ~/.local/bin, no elevation.
            "linux": PlatformInstall(
                "curl -LsSf https://astral.sh/uv/install.sh | sh", ("curl",)
            ),
            "win32": PlatformInstall(
                "winget install --id astral-sh.uv -e "
                "--accept-source-agreements --accept-package-agreements",
                ("winget",),
            ),
        }),

    # Step 2 — Agent CLIs (≥ 1 required) + Analyzer.
    # Each vendor declares its own entry (cli_vendors/<key>.py, spec.install_dep);
    # aggregated here so the wizard still sees one flat table.
    *_agent_cli_deps(),
    Dep("ollama", "Ollama", "Local LLM runtime (required for Analyzer)", "analyzer",
        ["ollama", "--version"], r"(\d+\.\d+\.\d+)",
        docs_url="https://ollama.com",
        install_cmds={
            "darwin": PlatformInstall("brew install ollama", ("brew",)),
            # Ollama's official Linux installer calls sudo to place the binary
            # and register a systemd unit, so unlike the other two it has to be
            # handed to a real terminal where the password prompt is visible.
            "linux": PlatformInstall(
                "curl -fsSL https://ollama.com/install.sh | sh",
                ("curl",),
                needs_terminal=True,
            ),
            # OllamaSetup.exe is a GUI installer that also starts the app.
            "win32": PlatformInstall(
                "winget install --id Ollama.Ollama -e", ("winget",), needs_terminal=True
            ),
        }),
]

DEPS_BY_ID: dict[str, Dep] = {d.id: d for d in DEPS}


def applicable_deps() -> list[Dep]:
    """The deps worth showing on this machine.

    Only the wizard's listing is filtered; `DEPS_BY_ID` keeps every entry so an
    install request naming a dep this platform hides is still recognised and
    refused with a reason, rather than looking like an unknown id.
    """
    return [dep for dep in DEPS if dep.applies_to(osplat.platform_id)]

# A model whose presence satisfies the analyzer requirement is any installed
# Ollama model; we surface the list so the UI can offer a pull if empty.
_SUGGESTED_MODEL = "qwen2.5-coder:7b"

# Curated catalog of analyzer-suitable Ollama models surfaced in the wizard so
# the common choices are one-click. Any installed model satisfies the gate; the
# user may still pull an arbitrary (validated) name via the custom field. Sizes
# are approximate download sizes for the default quantization.
MODEL_CATALOG: list[dict[str, Any]] = [
    {"name": "qwen2.5-coder:7b", "size": "~4.7 GB",
     "desc": "Recommended · Best balance for code analysis", "recommended": True},
    {"name": "qwen2.5-coder:1.5b", "size": "~1.0 GB",
     "desc": "Lightweight · Low memory, fast", "recommended": False},
    {"name": "qwen2.5-coder:3b", "size": "~2.0 GB",
     "desc": "Lightweight+ · Balance of size and quality", "recommended": False},
    {"name": "qwen2.5-coder:14b", "size": "~9.0 GB",
     "desc": "High quality · Requires more memory", "recommended": False},
    {"name": "qwen2.5-coder:32b", "size": "~20 GB",
     "desc": "Best quality · Requires large memory", "recommended": False},
    {"name": "deepseek-coder-v2:16b", "size": "~8.9 GB",
     "desc": "Alternative · Strong code comprehension", "recommended": False},
    {"name": "llama3.1:8b", "size": "~4.7 GB",
     "desc": "General purpose · Broad conversation and analysis", "recommended": False},
]


def _path_probe_command() -> list[str] | None:
    """The shell invocation used to read the user's real PATH, or None where
    there is no login shell to ask (Windows). See `Paths.login_path_probe`."""
    return osplat.paths.login_path_probe()


def _parse_login_path(stdout: str) -> list[str]:
    """PATH entries from the probe's stdout: the `LOGIN_PATH_MARKER` line."""
    marked = [line for line in stdout.splitlines() if line.startswith(osplat.spec.LOGIN_PATH_MARKER)]
    if not marked:
        return []
    value = marked[-1][len(osplat.spec.LOGIN_PATH_MARKER):].strip()
    return [entry for entry in value.split(os.pathsep) if entry]


def _fallback_path_dirs() -> list[str]:
    """Standard install prefixes merged into PATH even when the login-shell
    probe fails (slow shell config outruns the per-caller timeout, GUI launches
    get the session's minimal PATH) — otherwise brew itself is invisible to detection
    and installs, and a CLI whose installer exported its dir from a shell rc
    file (aider, opencode, cursor, kimi into ~/.local/bin; nvm and bun on
    Linux) still reads as missing right after installing. Which dirs those
    are is the platform's to say — see `Paths.login_path_fallbacks`."""
    return osplat.paths.login_path_fallbacks(Path.home())


def _tail_path_dirs() -> list[str]:
    """Dirs merged at the END of PATH — see `Paths.login_path_tail_fallbacks`."""
    return osplat.paths.login_path_tail_fallbacks(Path.home())


# The login-shell probe costs ~1-3s (interactive zsh reads the full rc chain),
# and its result only changes when an installer writes a new PATH export — so
# cache it. Wizard flows that just ran an installer pass force=True (wired from
# the frontend's fresh flag); passive status reads reuse the merged PATH, which
# persists in os.environ anyway. Benign race: two threads may double-probe.
_PATH_REFRESH_TTL_S = 300.0
# A probe that answered nothing leaves detection running on the fallback list,
# which is a list of guesses. Retry sooner than a success — but not on every
# status read, because each attempt pays the timeout below.
_PATH_RETRY_TTL_S = 60.0
# The probe is the same work everywhere; the budget around it is not, so the
# ceiling is per caller. One global 15s broke two deadlines at once: the
# wsClient default of 10s that onboarding.status rides on, and the 30s
# terminal.create budget that already promises 25s of it to the credential
# switch lock (see ws_handlers._SWITCH_LOCK_TIMEOUT_SEC).
#
# A heavy ~/.zshrc was measured at 13s+ (src/main/backend.ts) and at 6.9s on a
# developer machine here, so the 3s this used to allow was too short to reach
# either — but only the caller the user is actually waiting on can afford to
# wait that long.
_PATH_PROBE_TIMEOUT_S = 8.0
# The user asked for a re-detect, or an installer just ran: they are watching a
# spinner, and App.vue gives this path 45s.
_PATH_PROBE_TIMEOUT_FORCED_S = 15.0
# Pre-spawn, where the probe is speculative and 25s of the 30s budget is
# already spoken for. Anything this misses the pane's own login shell still
# resolves, so a miss here costs nothing.
_PATH_PROBE_TIMEOUT_SPAWN_S = 3.0
_path_refreshed_at: float | None = None
# Whether the last probe actually returned a PATH. Distinguishes "we know what
# the login shell exports" from "we fell back to guessing", which decides
# which of the two TTLs above applies.
_path_probe_answered = False


def _refresh_path_from_login_shell(
    force: bool = False, *, timeout_s: float | None = None
) -> None:
    """Merge PATH from a login shell into os.environ so newly-installed CLIs are visible.

    Best-effort: all failures are swallowed silently. A platform with no
    login shell to probe (Windows) keeps the PATH it already has, homebrew and
    `~/.local/bin` fallbacks included — they are POSIX layouts and would only
    ever be missing directories there.
    """
    global _path_refreshed_at, _path_probe_answered
    probe = _path_probe_command()
    if probe is None:
        return
    now = time.monotonic()
    ttl = _PATH_REFRESH_TTL_S if _path_probe_answered else _PATH_RETRY_TTL_S
    if (not force and _path_refreshed_at is not None
            and now - _path_refreshed_at < ttl):
        return
    probe_timeout = timeout_s if timeout_s is not None else (
        _PATH_PROBE_TIMEOUT_FORCED_S if force else _PATH_PROBE_TIMEOUT_S
    )
    shell_paths: list[str] = []
    try:
        proc = subprocess.run(
            probe,
            capture_output=True,
            text=True,
            timeout=probe_timeout,
        )
        # Only the marked line: rc files print banners, and an interactive
        # bash's last line was a motd on more than one machine.
        shell_paths = _parse_login_path(proc.stdout or "")
    except Exception:  # noqa: BLE001
        pass
    # Stamped after the probe, never before. Stamping first recorded a timeout
    # exactly like a success, so one slow shell at startup put the next five
    # minutes of detection on a PATH the probe had contributed nothing to.
    _path_refreshed_at = time.monotonic()
    _path_probe_answered = bool(shell_paths)
    # An answered probe is the order the user's own terminal resolves in, so
    # its entries take that order even when PATH already had them further
    # down. Otherwise a re-detect after fixing PATH order in ~/.zprofile kept
    # finding /usr/bin/python3 ahead of Homebrew's until the app restarted.
    login_set = set(shell_paths)
    shell_paths.extend(d for d in _fallback_path_dirs() if os.path.isdir(d))
    current_paths = [
        p for p in os.environ.get("PATH", "").split(os.pathsep) if p not in login_set
    ]
    current_set = set(current_paths)
    seen: set[str] = set()
    new_paths: list[str] = []
    for p in shell_paths:
        if p and p not in current_set and p not in seen:
            seen.add(p)
            new_paths.append(p)
    tail_paths: list[str] = []
    for p in _tail_path_dirs():
        if p and p not in current_set and p not in seen and os.path.isdir(p):
            seen.add(p)
            tail_paths.append(p)
    if new_paths or tail_paths:
        os.environ["PATH"] = os.pathsep.join(new_paths + current_paths + tail_paths)


def _parse_version(text: str, regex: str) -> str:
    m = re.search(regex, text)
    return m.group(1) if m else ""


def _version_tuple(v: str) -> tuple[int, ...]:
    return tuple(int(p) for p in re.findall(r"\d+", v)) or (0,)


def _meets_min(version: str, min_version: str) -> bool:
    if not min_version:
        return True
    if not version:
        return False
    return _version_tuple(version) >= _version_tuple(min_version)


def _install_method(resolved_path: str) -> str:
    """Classify HOW a binary got installed, from where it physically lives.

    Drives which official maintenance command applies, so it must not guess:
    anything unrecognised stays 'unknown' and the UI falls back to vendor docs.

        npm       .../node_modules/<pkg>/...   (nvm, brew-node, system npm alike)
        homebrew  /opt/homebrew/... | /usr/local/Cellar/...
        native    ~/.local/share/<tool>/...    (vendor's own installer)
        script    ~/.<tool>/bin/... | ~/.local/bin/...  (vendor install script)
    """
    if not resolved_path:
        return ""
    # Forward slashes on every platform, so the markers below match a
    # Windows `realpath` too.
    resolved_path = Path(resolved_path).as_posix()
    if "/node_modules/" in resolved_path:
        return "npm"
    if resolved_path.startswith(("/opt/homebrew/", "/usr/local/Cellar/")):
        return "homebrew"
    home = Path.home().as_posix()
    if resolved_path.startswith(f"{home}/.local/share/"):
        return "native"
    if resolved_path.startswith(f"{home}/.") and "/bin/" in resolved_path:
        return "script"
    return "unknown"


# Identity probes are a subprocess each, so the answer is remembered for the
# life of the process, keyed by the resolved path. A binary that changes under
# a running Navide is what the wizard's "re-detect" is for.
_IDENTITY_CACHE: dict[str, bool] = {}
_IDENTITY_TIMEOUT_S = 5.0


def _is_that_tool(dep: Dep, binary_path: str) -> bool:
    """Whether `binary_path` really is dep's tool, for deps that can be confused.

    Only deps declaring `identity_regex` are probed; every other dep answers
    True without spawning anything. A probe that cannot run (missing, slow,
    crashing) also answers True: refusing a binary on a failed probe would
    hide an installed CLI, which is worse than the ambiguity this guards.
    """
    if not dep.identity_regex:
        return True
    cached = _IDENTITY_CACHE.get(binary_path)
    if cached is not None:
        return cached
    try:
        proc = subprocess.run(  # noqa: S603 - argv from the registry, never user input
            [binary_path, *dep.check_cmd[1:]],
            capture_output=True,
            text=True,
            timeout=_IDENTITY_TIMEOUT_S,
        )
    except (OSError, subprocess.SubprocessError):
        return True
    ok = re.search(dep.identity_regex, proc.stdout + proc.stderr) is not None
    _IDENTITY_CACHE[binary_path] = ok
    return ok


def resolve_executable(dep: Dep, quick: bool = False) -> str:
    """PATH location of the dep's binary — its primary name, else an alternate.

    A vendor rename (cursor's `cursor-agent` → `agent`) otherwise reports an
    installed CLI as missing and blocks its spawn.

    A generic name can also be taken by a DIFFERENT vendor — xAI's grok ships
    `~/.grok/bin/agent`, the name Cursor uses — which had Navide detecting and
    spawning grok as Cursor. So a candidate that fails the dep's identity probe
    steps aside for a later one; if none identifies, the first name that
    resolved is still returned, keeping a format change from hiding a CLI that
    really is installed.

    quick=True is quick_status's no-subprocess contract: the probe is skipped
    and the first name on PATH wins, exactly as before. That paint only answers
    "present or missing", which the squatter does not change, and the full
    pass that follows grades the binary properly.
    """
    fallback = ""
    for name in (dep.check_cmd[0], *dep.alt_commands):
        found = osplat.paths.resolve_program(name)
        if not found:
            continue
        if quick or _is_that_tool(dep, found):
            return found
        fallback = fallback or found
    return fallback


# Where an unlinked (or versioned, never-`python3`-linked) Homebrew keg keeps
# its interpreter: <root>/python@3.N/bin/python3.
_HOMEBREW_OPT_ROOTS = ("/opt/homebrew/opt", "/usr/local/opt")
# Newest minor probed. Only names that exist on disk cost a subprocess.
_PYTHON_MINOR_CEILING = 30


def _suitable_versioned_python(dep: Dep) -> tuple[str, str]:
    """(path, version) of the newest Python meeting dep.min_version that is not
    reachable as `python3`, or ('', '').

    Nothing Navide runs needs `python3` itself to be new — the packaged backend
    is frozen, dev runs under uv's venv, and the curl-less hook fallback runs
    on any Python 3 — so Xcode's /usr/bin/python3 3.9.6 winning PATH must not
    block the wizard when Homebrew's python@3.13 (which links only
    `python3.13`) or an unlinked keg is installed. `brew install python3`
    reports those as already installed and changes nothing.
    """
    min_minor = _version_tuple(dep.min_version)[1:2] or (0,)
    for minor in range(_PYTHON_MINOR_CEILING, min_minor[0] - 1, -1):
        candidates = [osplat.paths.resolve_program(f"python3.{minor}")]
        candidates += [
            os.path.join(root, f"python@3.{minor}", "bin", "python3")
            for root in _HOMEBREW_OPT_ROOTS
        ]
        for path in candidates:
            if not path or not os.path.isfile(path):
                continue
            try:
                proc = subprocess.run(
                    osplat.paths.launch_argv(path, dep.check_cmd[1:]),
                    capture_output=True, text=True, timeout=8,
                )
            except (subprocess.SubprocessError, OSError):
                continue
            version = _parse_version((proc.stdout or "") + (proc.stderr or ""), dep.version_regex)
            if _meets_min(version, dep.min_version):
                return path, version
    return "", ""


def detect_dep(dep: Dep, quick: bool = False) -> dict[str, Any]:
    """Run the dep's check_cmd and classify ok | missing | outdated.

    quick=True skips the version subprocess: presence on PATH reads "ok"
    (version empty) until a full pass can grade it. Used by quick_status for
    the wizard's first paint — missing is exact either way.
    """
    binary_path = resolve_executable(dep, quick=quick)
    exit_code: int | None = None
    signal_name = ""
    duration_ms: int | None = None
    # A `--version` that outlives its ceiling says nothing about the binary: a
    # loaded cold start does it and the next launch answers. Kept distinct from
    # a definitive failure so the health guide does not report it.
    probe_timed_out = False
    if not binary_path:
        status = "missing"
        version = ""
    elif quick:
        status = "ok"
        version = ""
    else:
        started = time.monotonic()
        try:
            proc = subprocess.run(
                osplat.paths.launch_argv(binary_path, dep.check_cmd[1:]),
                capture_output=True, text=True, timeout=8,
            )
            duration_ms = max(0, round((time.monotonic() - started) * 1000))
            exit_code = proc.returncode
            if proc.returncode < 0:
                try:
                    signal_name = signal.Signals(-proc.returncode).name
                except ValueError:
                    signal_name = f"SIG{-proc.returncode}"
            out = (proc.stdout or "") + (proc.stderr or "")
            version = _parse_version(out, dep.version_regex)
            if version and not _meets_min(version, dep.min_version):
                status = "outdated"
            elif proc.returncode == 0 or version:
                status = "ok"
            else:
                status = "missing"
        except (subprocess.SubprocessError, OSError) as exc:
            duration_ms = max(0, round((time.monotonic() - started) * 1000))
            version = ""
            probe_timed_out = isinstance(exc, subprocess.TimeoutExpired)
            # A timeout found the binary and only failed to grade it — the
            # spawn probe lets the same timeout through (app.py), so calling
            # it missing here put the install wizard over a working CLI.
            status = "ok" if probe_timed_out else "missing"
    if dep.id == "python" and not quick and status in ("outdated", "missing"):
        found_path, found_version = _suitable_versioned_python(dep)
        if found_path:
            binary_path, version, status = found_path, found_version, "ok"
    # Resolved once: `can_install`, `needs_terminal` and `install_cmd` below
    # all have to describe the same install, or the dialog shows one command
    # and runs another.
    _install = dep.install_for(osplat.platform_id)
    return {
        "id": dep.id,
        "label": dep.label,
        "description": dep.description,
        "group": dep.group,
        "status": status,
        "version": version,
        "min_version": dep.min_version,
        "optional": dep.optional,
        "needs_terminal": _install.needs_terminal,
        "can_install": bool(_install.command),
        # Surfaced so the install dialog can show exactly what will run before
        # the user agrees to it — the renderer still never composes a command.
        "install_cmd": _install.command,
        # Prerequisites with their CURRENT state, so the guided install can show
        # "Homebrew is missing" during its check step instead of only after the
        # install command has already failed.
        "requirements": [
            {"name": name, "ok": osplat.paths.resolve_program(name) is not None}
            # Read the resolved install, not the Dep: the platform port moved
            # the foundation deps' brew requirement into install_cmds, which
            # left this list empty on macOS and the wizard no longer pulled
            # Homebrew in ahead of node/pnpm/python/uv/ollama.
            for name in _install.requires_binaries
        ],
        "docs_url": dep.docs_url,
        "binary_path": binary_path,
        "resolved_path": os.path.realpath(binary_path) if binary_path else "",
        "install_method": _install_method(os.path.realpath(binary_path) if binary_path else ""),
        "update_cmd": dep.update_cmd,
        "doctor_cmd": dep.doctor_cmd,
        "autoupdate_env": dep.autoupdate_env,
        "autoupdate_policy": cli_autoupdate_policy(dep.id) if dep.autoupdate_env else "",
        "exit_code": exit_code,
        "signal": signal_name,
        "duration_ms": duration_ms,
        "probe_timed_out": probe_timed_out,
        # The install the user picked for Navide to launch ("use this
        # version"); '' = the PATH default. The backend is its only store.
        "binary_override": cli_binary_override(dep.id) if dep.group == "agent_cli" else "",
    }


def _distinct_executables(command: str) -> list[dict[str, Any]]:
    """Executable PATH entries collapsed by physical file identity."""
    grouped: dict[tuple[int, int] | tuple[str, str], dict[str, Any]] = {}
    for directory in os.environ.get("PATH", "").split(os.pathsep):
        if not directory:
            continue
        # One name on POSIX; `name.exe`/`.cmd`/... on Windows, where a file
        # is runnable by extension rather than by a mode bit.
        for filename in osplat.paths.executable_candidates(command):
            candidate = Path(directory).expanduser() / filename
            if not candidate.is_file() or not osplat.paths.is_executable(candidate):
                continue
            try:
                stat = candidate.stat()
                identity: tuple[int, int] | tuple[str, str] = (stat.st_dev, stat.st_ino)
                resolved = str(candidate.resolve())
            except OSError:
                identity = ("path", str(candidate))
                resolved = os.path.realpath(candidate)
            entry = grouped.setdefault(identity, {"path": str(candidate), "resolved_path": resolved, "aliases": []})
            if str(candidate) not in entry["aliases"]:
                entry["aliases"].append(str(candidate))
    return list(grouped.values())


def _probe_alternate(dep: Dep, executable: str) -> dict[str, Any]:
    started = time.monotonic()
    exit_code: int | None = None
    signal_name = ""
    version = ""
    status = "failed"
    try:
        proc = subprocess.run(
            osplat.paths.launch_argv(executable, dep.check_cmd[1:]),
            capture_output=True,
            text=True,
            timeout=3,
        )
        exit_code = proc.returncode
        output = (proc.stdout or "") + (proc.stderr or "")
        version = _parse_version(output, dep.version_regex)
        if proc.returncode < 0:
            try:
                signal_name = signal.Signals(-proc.returncode).name
            except ValueError:
                signal_name = f"SIG{-proc.returncode}"
        status = "ok" if proc.returncode == 0 or version else "failed"
    except (subprocess.SubprocessError, OSError):
        pass
    return {
        "version": version,
        "status": status,
        "exit_code": exit_code,
        "signal": signal_name,
        "duration_ms": max(0, round((time.monotonic() - started) * 1000)),
    }


def _same_npm_install(first: dict[str, Any], second: dict[str, Any], package: str) -> bool:
    """True when both candidates resolve into the same npm prefix of `package`."""
    if not package:
        return False
    marker = f"/node_modules/{package}/"
    first_resolved = Path(str(first.get("resolved_path") or "")).as_posix()
    second_resolved = Path(str(second.get("resolved_path") or "")).as_posix()
    if marker not in first_resolved or marker not in second_resolved:
        return False
    return first_resolved.split(marker, 1)[0] == second_resolved.split(marker, 1)[0]


def _candidate_removal(candidate: dict[str, Any], dep: Dep, version: str) -> dict[str, str]:
    """Return a confirmed removal command only when ownership is unambiguous."""
    package = dep.npm_package
    resolved = Path(str(candidate.get("resolved_path") or "")).as_posix()
    path = str(candidate.get("path") or "")
    package_marker = f"/node_modules/{package}/" if package else ""
    # The npm beside the binary: `npm` on POSIX, `npm.cmd` on Windows.
    npm = None
    for filename in osplat.paths.executable_candidates("npm"):
        entry = Path(path).parent / filename
        if entry.is_file() and osplat.paths.is_executable(entry):
            npm = entry
            break
    if not package_marker or package_marker not in resolved or npm is None:
        return {"manager": "", "command": ""}

    quote = osplat.paths.quote_arg
    uninstall = f"{quote(str(npm))} uninstall -g {quote(package)}"
    description = f"Remove {dep.label} {version or ''} from {path}".replace("  ", " ")
    # The user's terminal runs this, so it has to be that terminal's language:
    # `external-terminal.ts` opens sh on POSIX and PowerShell on Windows.
    confirmed = osplat.scripts.confirm_then_run(description, uninstall)
    return {"manager": "npm", "command": confirmed}


def _config_homes(dep: Dep) -> list[tuple[str, Path]]:
    """Every config home where ``dep`` may have written state, deduped by path.

    A CLI writes its update result into whichever config home the run used, so
    a profile pane's failure lands in that profile's home and is invisible from
    the default one — all of them have to be checked.
    """
    homes: list[tuple[str, Path]] = []
    if dep.config_home_default:
        homes.append(("default", Path.home() / dep.config_home_default))
    env_home = os.environ.get(dep.config_home_env, "") if dep.config_home_env else ""
    if env_home:
        homes.append(("env", Path(env_home)))
    try:
        for entry in sorted((default_profiles_root() / dep.id).iterdir()):
            if entry.is_dir():
                homes.append((f"profile:{entry.name}", entry))
    except OSError:
        pass  # no profiles for this agent
    seen: set[str] = set()
    unique: list[tuple[str, Path]] = []
    for scope, home in homes:
        key = os.path.realpath(home)
        if key in seen:
            continue
        seen.add(key)
        unique.append((scope, home))
    return unique


def read_update_state(dep: Dep) -> list[dict[str, Any]]:
    """The CLI's own last-update records across its config homes, newest first.

    Pure read-back of what the vendor already wrote — Navide never authors these
    files and never infers an outcome the CLI did not record.
    """
    if not dep.update_state_file:
        return []
    records: list[dict[str, Any]] = []
    for scope, home in _config_homes(dep):
        try:
            data = json.loads((home / dep.update_state_file).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(data, dict):
            continue
        records.append({
            "scope": scope,
            "home": str(home),
            "timestamp": str(data.get("timestamp") or ""),
            "outcome": str(data.get("outcome") or ""),
            "status": str(data.get("status") or ""),
            "version_from": str(data.get("version_from") or ""),
            "version_to": str(data.get("version_to") or ""),
        })
    records.sort(key=lambda record: record["timestamp"], reverse=True)
    return records


def _stale_update_failure(record: dict[str, Any], current_version: str) -> bool:
    """True when a failure predates the version now installed (already moved on)."""
    recorded_from = str(record.get("version_from") or "")
    return bool(recorded_from and current_version and recorded_from != current_version)


def build_cli_health(dep_statuses: list[dict[str, Any]]) -> dict[str, Any]:
    """Build actionable health findings for installed agent CLIs."""
    status_by_id = {status["id"]: status for status in dep_statuses}
    cli_entries: list[dict[str, Any]] = []
    findings: list[dict[str, Any]] = []
    for dep in DEPS:
        if dep.group != "agent_cli":
            continue
        candidates = _distinct_executables(dep.check_cmd[0])
        if not candidates:
            continue  # Missing optional CLIs are handled by normal onboarding.
        dep_status = status_by_id.get(dep.id, {})
        primary_resolved = str(dep_status.get("resolved_path") or "")
        # A generic name can belong to a different vendor (grok ships
        # `~/.grok/bin/agent`, Cursor's name). resolve_executable already
        # steps past such a squatter when picking the primary; listing it
        # here would report a duplicate install of a CLI it is not.
        candidates = [
            candidate for candidate in candidates
            if candidate["resolved_path"] == primary_resolved
            or _is_that_tool(dep, candidate["resolved_path"])
        ]
        if not candidates:
            continue
        probed: list[tuple[dict[str, Any], dict[str, Any], bool]] = []
        for candidate in candidates:
            is_primary = candidate["resolved_path"] == primary_resolved
            probe = {
                "version": dep_status.get("version", ""),
                "status": "ok" if dep_status.get("status") == "ok" else "failed",
                "exit_code": dep_status.get("exit_code"),
                "signal": dep_status.get("signal", ""),
                "duration_ms": dep_status.get("duration_ms"),
            } if is_primary else _probe_alternate(dep, candidate["resolved_path"])
            probed.append((candidate, probe, is_primary))
        detailed_candidates: list[dict[str, Any]] = []
        for candidate, probe, is_primary in probed:
            # Removal must never target the last working install: broken
            # candidates are always removable (removing them cannot lose a
            # working CLI), working ones only when a different physical
            # install also probes ok.
            package = dep.npm_package
            removable = probe.get("status") != "ok" or any(
                other_probe.get("status") == "ok"
                and not _same_npm_install(candidate, other_candidate, package)
                for other_candidate, other_probe, _ in probed
                if other_candidate is not candidate
            )
            removal = (
                _candidate_removal(candidate, dep, str(probe.get("version") or ""))
                if removable
                else {"manager": "", "command": ""}
            )
            detailed_candidates.append({
                **candidate,
                **probe,
                "is_primary": is_primary,
                "install_method": _install_method(str(candidate.get("resolved_path") or "")),
                "install_manager": removal["manager"],
                "removal_command": removal["command"],
            })
        update_records = read_update_state(dep)
        entry = {
            "agent_key": dep.id,
            "label": dep.label,
            "diagnostic_command": dep.doctor_cmd or " ".join(dep.check_cmd),
            "update_command": dep.update_cmd,
            "docs_url": dep.docs_url,
            # The guide's same-install check must use the package the removal
            # gate above used ("" when the vendor is not npm-installed).
            "npm_package": dep.npm_package,
            "update_state": update_records,
            "candidates": detailed_candidates,
        }
        cli_entries.append(entry)
        primary = next((candidate for candidate in detailed_candidates if candidate["is_primary"]), detailed_candidates[0])
        failed_updates = [
            record for record in update_records
            if record["outcome"] == "failed"
            and not _stale_update_failure(record, str(primary.get("version") or ""))
        ]
        if failed_updates:
            findings.append({
                "type": "update_failed",
                "agent_key": dep.id,
                "label": dep.label,
                "records": failed_updates,
            })
        # The user already chose which install Navide launches for this CLI
        # (onboarding's "use this version"). A working choice is the repair
        # for both a duplicate install and a broken primary, since spawns no
        # longer reach the PATH default; a broken choice repairs nothing.
        override = cli_binary_override(dep.id)
        if override and any(
            candidate["status"] == "ok"
            and (override == candidate["path"] or override in candidate.get("aliases", []))
            for candidate in detailed_candidates
        ):
            continue
        # A timed-out primary probe is transient, not a finding: reporting it
        # added an entry to the fingerprint and re-opened a dismissed guide
        # on every loaded cold start.
        if primary["status"] != "ok" and not (
            primary["is_primary"] and dep_status.get("probe_timed_out")
        ):
            findings.append({
                "type": "probe_failed",
                "agent_key": dep.id,
                "label": dep.label,
                "primary": primary,
            })
        if len(detailed_candidates) > 1:
            findings.append({
                "type": "duplicate_install",
                "agent_key": dep.id,
                "label": dep.label,
                "candidates": detailed_candidates,
            })

    # The fingerprint scopes a dismissal to what the user actually looked at
    # in the launch guide: which repairable findings, for which CLIs, on which
    # binaries. Two things are deliberately left out, because each brought a
    # dismissed guide back on the next launch with nothing the user could see
    # having changed: probe details (version, status, exit code, signal) come
    # from `--version` subprocesses under a few-second ceiling and flip on a
    # loaded cold start; update_failed findings are not shown by the guide at
    # all (CLI management surfaces them), so a vendor's next failed
    # auto-update must not re-open it. A probe outcome still decides whether a
    # probe_failed finding exists, so a primary timeout emits none (above) —
    # only a definitive failure (non-zero exit with no version, a signal, a
    # binary that cannot run) moves the fingerprint.
    fingerprint_source = [
        {
            "type": finding["type"],
            "agent_key": finding["agent_key"],
            "candidates": [
                {"resolved_path": candidate["resolved_path"]}
                for candidate in (
                    finding.get("candidates")
                    or ([finding["primary"]] if finding.get("primary") else [])
                )
            ],
        }
        for finding in findings
        if finding["type"] != "update_failed"
    ]
    fingerprint = hashlib.sha256(
        json.dumps(fingerprint_source, sort_keys=True).encode("utf-8")
    ).hexdigest()[:16] if findings else ""
    dismissed = fingerprint != "" and _dismissed_cli_health_fingerprint() == fingerprint
    return {
        "entries": cli_entries,
        "findings": findings,
        "fingerprint": fingerprint,
        "dismissed": dismissed,
        "needs_attention": bool(findings) and not dismissed,
    }


def detect_ollama_status() -> dict[str, Any]:
    """Installed Ollama models plus whether the daemon actually answered.

    `ollama list` exits non-zero when the service is down — indistinguishable
    from "no models installed" if only the parsed list is returned, which left
    the wizard telling users to pull a model that could never succeed.
    """
    if osplat.paths.resolve_program("ollama") is None:
        return {"models": [], "reachable": False, "detail": "ollama not installed"}
    try:
        proc = subprocess.run(
            ["ollama", "list"], capture_output=True, text=True, timeout=8
        )
    except (subprocess.SubprocessError, OSError) as exc:
        return {"models": [], "reachable": False, "detail": str(exc) or "ollama list failed"}
    if proc.returncode != 0:
        detail = ((proc.stderr or "") + (proc.stdout or "")).strip()
        return {
            "models": [],
            "reachable": False,
            "detail": detail or f"exit code {proc.returncode}",
        }
    models: list[str] = []
    for line in (proc.stdout or "").splitlines()[1:]:  # skip header
        name = line.split()[0] if line.split() else ""
        if name:
            models.append(name)
    return {"models": models, "reachable": True, "detail": ""}


def ollama_reachable() -> bool:
    """True when the ollama daemon answered a list request."""
    return bool(detect_ollama_status()["reachable"])


def compute_gate(
    dep_statuses: list[dict[str, Any]],
    models: list[str],
    ollama_service_up: bool = True,
) -> dict[str, Any]:
    """Compute the hard-block gate from detected statuses."""
    by_group: dict[str, list[dict[str, Any]]] = {"foundation": [], "agent_cli": [], "analyzer": []}
    for s in dep_statuses:
        by_group.get(s["group"], []).append(s)

    foundation_ready = all(s["status"] == "ok" for s in by_group["foundation"] if not s.get("optional"))
    has_any_cli = any(s["status"] == "ok" for s in by_group["agent_cli"])
    ollama_ok = any(s["id"] == "ollama" and s["status"] == "ok" for s in by_group["analyzer"])
    # Installed but not serving is its own state: pulling a model would fail.
    ollama_service_ready = ollama_ok and ollama_service_up
    analyzer_ready = ollama_service_ready and len(models) > 0

    # Analyzer (ollama + a multi-GB local model) is optional — it must not
    # hard-block first use. analyzer_ready is still reported so Settings can
    # surface it as a recommended extra.
    # Foundation is not required either: the packaged app never runs
    # python/uv/pnpm itself, and a CLI that needs brew or node pulls it in
    # through the install prompt's prerequisite chain. foundation_ready is
    # still reported for CLI management.
    all_required_ready = has_any_cli
    return {
        "foundation_ready": foundation_ready,
        "has_any_cli": has_any_cli,
        "analyzer_ready": analyzer_ready,
        "ollama_ok": ollama_ok,
        "ollama_service_up": ollama_service_ready,
        "has_model": len(models) > 0,
        "all_required_ready": all_required_ready,
        "suggested_model": _SUGGESTED_MODEL,
    }


_EMPTY_CLI_HEALTH: dict[str, Any] = {
    "entries": [], "findings": [], "fingerprint": "", "dismissed": False,
    "needs_attention": False,
}


def quick_status() -> dict[str, Any]:
    """PATH-presence-only snapshot: no login-shell probe, no subprocesses.

    Cheap enough to answer inline on the event loop. Serves the UI's first
    paint so a missing CLI reads "not installed" immediately instead of after
    the full batch's slowest --version probe; a get_status pass follows and
    replaces it (real versions, ollama, cli_health).

    Until the login-shell PATH has answered, a miss reads "unknown": nvm,
    volta and custom npm prefixes only reach PATH through that shell, so a
    miss before it says nothing about whether the CLI is installed."""
    deps = [detect_dep(dep, quick=True) for dep in applicable_deps()]
    if _path_probe_command() is not None and not _path_probe_answered:
        for entry in deps:
            if entry["status"] == "missing":
                entry["status"] = "unknown"
    return {
        "deps": deps,
        "models": [],
        "ollama_detail": "",
        "gate": compute_gate(deps, [], False),
        "model_catalog": MODEL_CATALOG,
        "cli_health": dict(_EMPTY_CLI_HEALTH),
        "install_prompt_dismissed": install_prompt_dismissals(),
        "quick": True,
    }


def get_status(fresh: bool = False) -> dict[str, Any]:
    """Full onboarding status: every dep + installed models + gate.

    fresh=True re-probes the login-shell PATH even when cached — pass it after
    running an installer, whose PATH export the cache cannot have seen."""
    _refresh_path_from_login_shell(force=fresh)
    # Probe every dep concurrently. Each detect_dep runs an independent
    # `--version` subprocess (up to 8s each), so serial execution scaled the
    # whole call with dep count — long enough that a concurrent WS request
    # (e.g. workspace.list_recent) could time out. Fan out so the total cost
    # is the slowest single probe, not their sum, and overlap the ollama probe.
    with ThreadPoolExecutor(
        max_workers=min(len(DEPS) + 1, 8), thread_name_prefix="dep-probe"
    ) as pool:
        models_future = pool.submit(detect_ollama_status)
        deps = list(pool.map(detect_dep, applicable_deps()))
        ollama = models_future.result()
    models = list(ollama["models"])
    return {
        "deps": deps,
        "models": models,
        "ollama_detail": ollama["detail"],
        "gate": compute_gate(deps, models, bool(ollama["reachable"])),
        "model_catalog": MODEL_CATALOG,
        "cli_health": build_cli_health(deps),
        "install_prompt_dismissed": install_prompt_dismissals(),
    }


# ── Maintenance (registry-driven, official commands only) ────────────────────
MAINTENANCE_ACTIONS = ("update", "doctor", "install")


def maintenance_command(dep_id: str, action: str) -> dict[str, Any]:
    """Resolve the vendor's own maintenance command for ``dep_id``.

    The caller passes an action id, never a command string: everything runnable
    comes from the registry. A vendor that ships no such command yields an
    error plus its docs URL — Navide does not substitute one of its own.
    """
    dep = DEPS_BY_ID.get(dep_id)
    if dep is None:
        return {"ok": False, "error": f"unknown dependency: {dep_id!r}"}
    if action not in MAINTENANCE_ACTIONS:
        return {"ok": False, "error": f"unknown action: {action!r}"}
    command = {
        "update": dep.update_cmd,
        "doctor": dep.doctor_cmd,
        "install": dep.install_for(osplat.platform_id).command,
    }[action]
    if not command:
        return {
            "ok": False,
            "error": f"{dep.label} has no official {action} command",
            "docs_url": dep.docs_url,
        }
    command = _command_on_the_resolved_binary(dep, command)
    # Always interactive: an update may prompt, authenticate or need sudo, so it
    # belongs in a terminal the user can see and answer.
    return {"ok": True, "needs_terminal": True, "command": command, "docs_url": dep.docs_url}



def _command_on_the_resolved_binary(dep: Dep, command: str) -> str:
    """Point a maintenance command at the binary detection actually resolved.

    `update_cmd` and friends are stored as plain strings naming the CLI
    (`agent update`), and they are handed to a terminal verbatim. When the name
    they use is one another vendor also ships, running the string runs the
    wrong tool — `agent update` on a machine carrying xAI's grok updates grok,
    not Cursor. Rewriting only the leading token, and only when it is one of
    this dep's own names, leaves every argument the vendor documented intact.
    """
    head, _, rest = command.partition(" ")
    if head not in (dep.check_cmd[0], *dep.alt_commands):
        return command
    resolved = resolve_executable(dep)
    if not resolved or os.path.basename(resolved) == head:
        return command
    return f"{shlex.quote(resolved)} {rest}".strip()

# ── Install (whitelist-driven) ────────────────────────────────────────────────
def missing_requirements(dep: Dep) -> list[str]:
    """Bootstrap binaries this platform's install needs that are not on PATH.

    Resolved per platform because the requirement differs with the command:
    the macOS install of `uv` needs Homebrew, the Linux one needs curl.
    """
    install = dep.install_for(osplat.platform_id)
    return [name for name in install.requires_binaries if osplat.paths.resolve_program(name) is None]


def install_dep(dep_id: str) -> dict[str, Any]:
    """Resolve the install command for a dep id. Only registry ids are accepted.

    Nothing runs here: `onboarding.run` spawns the resolved command in a PTY
    the window shows, so sudo, OAuth and progress output all reach the user.
    """
    dep = DEPS_BY_ID.get(dep_id)
    if dep is None:
        log.warning("install rejected: unknown dependency %r", dep_id)
        return {"ok": False, "error": f"unknown dependency: {dep_id!r}"}
    context = {"dep_id": dep.id, "label": dep.label, "docs_url": dep.docs_url}
    if not dep.applies_to(osplat.platform_id):
        return {
            **context,
            "ok": False,
            "error": f"{dep.label} does not apply to this platform",
        }
    install = dep.install_for(osplat.platform_id)
    if not install.command:
        return {**context, "ok": False, "error": "no install command for this dependency"}
    # Bootstrap gate: `brew install …` on a Mac without Homebrew only ever
    # produced a bare exit 127. Name the real blocker instead.
    missing = missing_requirements(dep)
    if missing:
        log.warning("install blocked for %s: missing %s", dep.id, ", ".join(missing))
        return {
            **context,
            "ok": False,
            "error": (
                f"{', '.join(missing)} is required to install {dep.label}. "
                f"Install {missing[0]} first, then retry."
            ),
            "missing_requirements": missing,
            "command": install.command,
        }
    return {**context, "ok": True, "command": install.command}


# ── Embedded run (onboarding.run) ─────────────────────────────────────────────
RUN_KINDS = ("install", "maintenance", "pull_model", "start_ollama")


def resolve_run(request: dict[str, Any]) -> dict[str, Any]:
    """The whitelisted command an `onboarding.run` request stands for.

    The window names a kind plus ids, never a command: each kind goes through
    the same resolver (and prerequisite checks) its old one-shot handler used.
    """
    kind = request.get("kind")
    if kind == "install":
        return install_dep(str(request.get("dep_id") or ""))
    if kind == "maintenance":
        return maintenance_command(
            str(request.get("agent_key") or ""), str(request.get("action") or "")
        )
    if kind == "pull_model":
        return pull_model(str(request.get("model") or _SUGGESTED_MODEL))
    if kind == "start_ollama":
        return start_ollama_service()
    return {"ok": False, "error": f"unknown run kind: {kind!r}"}


# PowerShell's own exit status is 0 after a failed native command unless the
# script says otherwise; this carries the last native exit code (or a cmdlet
# failure) out as the process exit code the window reports.
# `$?` is judged first: it describes the command's last statement, while
# $LASTEXITCODE keeps the code of whichever native program ran last — inside
# an `irm ... | iex` installer that can be a probe that returned non-zero
# before the install went on to succeed.
_POWERSHELL_EXIT_TAIL = (
    "\n$navideOk = $?; $navideCode = $LASTEXITCODE\n"
    "if ($navideOk) { exit 0 }\n"
    "if ($navideCode) { exit $navideCode }\n"
    "exit 1"
)


def run_argv(command: str) -> list[str]:
    """How a resolved command is started in the run's PTY.

    The same shells the external terminal used, minus the keep-open flag, so
    the command's own exit code ends the run. POSIX picks the rc-reading flags
    of `login_path_probe`: an install that follows another one must see the
    PATH export the first one wrote into ~/.zshrc / ~/.bashrc.
    """
    if osplat.platform_id == "win32":
        # A resolved binary comes back quoted (`'C:\...\claude.cmd' update`),
        # which PowerShell parses as a string followed by a stray token; the
        # call operator makes it a command.
        if command.startswith(("'", '"')):
            command = "& " + command
        # `npm` resolves to npm.ps1, which the default Restricted / AllSigned
        # policy refuses to load. Bypass is scoped to this one process: the
        # user's own policy is untouched, and it covers every .ps1 shim.
        return [
            "powershell.exe", "-NoLogo", "-ExecutionPolicy", "Bypass",
            "-Command", command + _POWERSHELL_EXIT_TAIL,
        ]
    shell = os.environ.get("SHELL") or "/bin/bash"
    name = os.path.basename(shell)
    interactive = name == "zsh" or (name == "bash" and osplat.platform_id == "linux")
    return [shell, "-ilc" if interactive else "-lc", command]


# Ollama model names may be namespaced (`hf.co/user/repo`, `library/llama3`),
# so '/' is allowed; the charset still excludes every shell metacharacter, and
# leading '-' / '..' are rejected so the name can't act as a flag or traverse.
_MODEL_NAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/\-]*")


def pull_model(model: str) -> dict[str, Any]:
    """Pull an Ollama model. The model name is constrained to a safe charset."""
    name = model or ""
    if not _MODEL_NAME_RE.fullmatch(name) or ".." in name:
        return {"ok": False, "error": "invalid model name"}
    if osplat.paths.resolve_program("ollama") is None:
        return {"ok": False, "error": "ollama not installed"}
    if not ollama_reachable():
        return {
            "ok": False,
            "error": "Ollama is installed but its service is not running.",
            "needs_service": True,
        }
    # Long download — onboarding.run streams its progress into the window.
    return {"ok": True, "needs_terminal": True, "command": f"ollama pull {name}"}


# Installing the formula does not start the service; without this the model
# list stays empty forever and `ollama pull` fails with a connection error.
OLLAMA_SERVICE_CMD = "brew services start ollama"


def start_ollama_service() -> dict[str, Any]:
    """Resolve the official service-start command for onboarding.run."""
    if osplat.paths.resolve_program("ollama") is None:
        return {"ok": False, "error": "ollama not installed"}
    if osplat.paths.resolve_program("brew") is None:
        return {"ok": False, "error": "brew is required to manage the ollama service"}
    return {"ok": True, "needs_terminal": True, "command": OLLAMA_SERVICE_CMD}


# ── Completion flag ───────────────────────────────────────────────────────────
_KV_KEY = "onboarding"


def _flag_path() -> Path:
    return app_data_dir() / "onboarding.json"


_STATE_LOCK = threading.Lock()

# Lazily-opened database handle. The app injects its shared instance at
# startup (set_database); when the resolved flag dir changes (tests patch
# _flag_path per test) a fresh handle is opened for it.
_db: Database | None = None


def set_database(db: Database | None) -> None:
    """Share the app's Database instance instead of opening a second one."""
    global _db
    _db = db


def _get_db() -> Database:
    global _db
    path = _flag_path().parent / DB_FILENAME
    db = _db
    if db is None or db.path != path:
        db = Database(path)
        _db = db
    return db


def _import_legacy_state(cur: object, data: object) -> None:
    if isinstance(data, dict):
        _get_db().kv_set(_KV_KEY, data, now=int(time.time()))


def _kv_state() -> dict[str, Any] | None:
    """Stored onboarding document, importing the legacy app-data JSON once.

    None means "nothing stored yet" — distinct from an (imported) empty dict,
    so is_complete() knows when to fall back to the legacy home-dir flag.
    """
    db = _get_db()
    data = db.kv_get(_KV_KEY)
    if data is None:
        db.import_json(_KV_KEY, _flag_path(), _import_legacy_state)
        data = db.kv_get(_KV_KEY)
    return data if isinstance(data, dict) else None


def _read_state() -> dict[str, Any]:
    return _kv_state() or {}


def _write_state(data: dict[str, Any]) -> None:
    try:
        _get_db().kv_set(_KV_KEY, data, now=int(time.time()))
    except sqlite3.Error as err:
        # Callers guard with OSError, matching the old file-write contract.
        raise OSError(str(err)) from err


def _legacy_flag_path() -> Path:
    return Path.home() / ".agent-team" / "onboarding.json"


def _migrate_legacy_flag() -> None:
    """One-time seed of the stored state from ~/.agent-team/onboarding.json.

    Best-effort: existing users must not see onboarding again, so on seed
    failure `is_complete()` still falls back to reading the legacy path.
    """
    if _kv_state() is not None:
        return
    legacy = _legacy_flag_path()
    if not legacy.exists():
        return
    try:
        data = json.loads(legacy.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            _write_state(data)
    except (OSError, ValueError):
        pass


def should_skip() -> bool:
    return os.environ.get("AGENT_TEAM_SKIP_ONBOARDING", "") == "1"


def is_complete() -> bool:
    if should_skip():
        return True
    _migrate_legacy_flag()
    state = _kv_state()
    if state is not None:
        return bool(state.get("complete"))
    # Read-only fallback: the legacy home-dir flag (kept even though the seed
    # above normally captures it — a failed seed must not re-show onboarding).
    try:
        data = json.loads(_legacy_flag_path().read_text(encoding="utf-8"))
        return bool(data.get("complete"))
    except (OSError, ValueError):
        return False


def set_complete(value: bool) -> dict[str, Any]:
    try:
        with _STATE_LOCK:
            data = _read_state()
            data["complete"] = value
            _write_state(data)
    except OSError as error:
        return {"ok": False, "error": str(error)}
    return {"ok": True}


def _dismissed_cli_health_fingerprint() -> str:
    _migrate_legacy_flag()
    return str(_read_state().get("dismissed_cli_health") or "")


def dismiss_cli_health(fingerprint: str) -> dict[str, Any]:
    if not re.fullmatch(r"[0-9a-f]{16}", fingerprint or ""):
        return {"ok": False, "error": "invalid fingerprint"}
    _migrate_legacy_flag()
    try:
        with _STATE_LOCK:
            data = _read_state()
            data["dismissed_cli_health"] = fingerprint
            _write_state(data)
    except OSError as error:
        return {"ok": False, "error": str(error)}
    return {"ok": True}


def install_prompt_dismissals() -> list[str]:
    """Dep ids whose guided-install prompt the user switched off.

    Declining once is not the same as never wanting to be asked again, so the
    prompt keeps appearing until the user explicitly opts out — this list is
    what makes that opt-out survive a restart.
    """
    _migrate_legacy_flag()
    stored = _read_state().get("install_prompt_dismissed")
    if not isinstance(stored, list):
        return []
    return [dep_id for dep_id in stored if isinstance(dep_id, str) and dep_id in DEPS_BY_ID]


def set_install_prompt_dismissed(dep_id: str, dismissed: bool) -> dict[str, Any]:
    """Turn the guided-install prompt for one dep off (or back on)."""
    if dep_id not in DEPS_BY_ID:
        return {"ok": False, "error": f"unknown dependency: {dep_id!r}"}
    _migrate_legacy_flag()
    try:
        with _STATE_LOCK:
            data = _read_state()
            stored = data.get("install_prompt_dismissed")
            ids = [i for i in stored if isinstance(i, str)] if isinstance(stored, list) else []
            if dismissed:
                if dep_id not in ids:
                    ids.append(dep_id)
            else:
                ids = [i for i in ids if i != dep_id]
            data["install_prompt_dismissed"] = ids
            _write_state(data)
    except OSError as error:
        return {"ok": False, "error": str(error)}
    return {"ok": True, "dep_id": dep_id, "dismissed": dismissed}


def cli_binary_override(agent_key: str) -> str:
    """Return a persisted executable only while it still exists and is executable."""
    _migrate_legacy_flag()
    data = _read_state()
    overrides = data.get("cli_binary_overrides")
    if not isinstance(overrides, dict):
        return ""
    path = str(overrides.get(agent_key) or "")
    dep = DEPS_BY_ID.get(agent_key)
    # The spellings `_distinct_executables` admitted: `claude` on POSIX,
    # `claude.cmd`/`.exe`/... on Windows.
    if dep is None or Path(path).name not in osplat.paths.executable_candidates(dep.check_cmd[0]):
        return ""
    return path if Path(path).is_file() and osplat.paths.is_executable(Path(path)) else ""


def select_cli_binary(agent_key: str, path: str) -> dict[str, Any]:
    """Persist a verified CLI choice.

    Nothing is dismissed here: the override itself resolves this CLI's
    findings (see build_cli_health), so other CLIs' findings stay visible.
    """
    dep = DEPS_BY_ID.get(agent_key)
    if dep is None or dep.group != "agent_cli":
        return {"ok": False, "error": "unknown agent CLI"}
    candidates = _distinct_executables(dep.check_cmd[0])
    selected = next((candidate for candidate in candidates if path in candidate.get("aliases", [])), None)
    if selected is None:
        return {"ok": False, "error": "binary is not an installed PATH candidate"}

    canonical_path = path
    _migrate_legacy_flag()
    try:
        with _STATE_LOCK:
            data = _read_state()
            overrides = data.get("cli_binary_overrides")
            if not isinstance(overrides, dict):
                overrides = {}
            overrides[agent_key] = canonical_path
            data["cli_binary_overrides"] = overrides
            _write_state(data)
    except OSError as error:
        return {"ok": False, "error": str(error)}
    return {"ok": True, "agent_key": agent_key, "path": canonical_path}


# ── Auto-update policy (the vendor's own switch, not a Navide mechanism) ──────
AUTOUPDATE_POLICIES = ("vendor", "manual")


def cli_autoupdate_policy(agent_key: str) -> str:
    """'vendor' (default — the CLI updates itself as it always has) or 'manual'."""
    _migrate_legacy_flag()
    policies = _read_state().get("cli_autoupdate")
    if not isinstance(policies, dict):
        return "vendor"
    policy = str(policies.get(agent_key) or "")
    return policy if policy in AUTOUPDATE_POLICIES else "vendor"


def set_cli_autoupdate_policy(agent_key: str, policy: str) -> dict[str, Any]:
    dep = DEPS_BY_ID.get(agent_key)
    if dep is None or not dep.autoupdate_env:
        return {"ok": False, "error": "agent has no vendor auto-update switch"}
    if policy not in AUTOUPDATE_POLICIES:
        return {"ok": False, "error": f"unknown policy: {policy!r}"}
    _migrate_legacy_flag()
    try:
        with _STATE_LOCK:
            data = _read_state()
            policies = data.get("cli_autoupdate")
            if not isinstance(policies, dict):
                policies = {}
            policies[agent_key] = policy
            data["cli_autoupdate"] = policies
            _write_state(data)
    except OSError as error:
        return {"ok": False, "error": str(error)}
    return {"ok": True, "agent_key": agent_key, "policy": policy}


def spawn_env_for(agent_key: str) -> dict[str, str]:
    """Env the CLI's own auto-update switch needs for this spawn.

    Empty unless the user explicitly chose 'manual', so the default spawn stays
    byte-for-byte what the vendor expects.
    """
    dep = DEPS_BY_ID.get(agent_key)
    if dep is None or not dep.autoupdate_env:
        return {}
    return {dep.autoupdate_env: "1"} if cli_autoupdate_policy(agent_key) == "manual" else {}

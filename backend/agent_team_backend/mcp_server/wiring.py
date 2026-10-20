"""Wire pane CLI agents to the Plan MCP endpoint.

The backend serves a Plan MCP server at ``/plan-mcp`` (see server.py) on a
dynamic port picked fresh each launch, so nothing static can point at it.
Merge-writing user-owned config files was rejected as clobber-prone:
``~/.claude.json`` is rewritten wholesale by a running claude CLI (a
read-modify-write from us can lose its update, and vice versa) and
``~/.codex/config.toml`` is user-global and shared into every per-pane
CODEX_HOME via symlink. Instead, terminal.create uses whatever additive,
CLI-native spawn-time surface each CLI offers.

Which surface a CLI offers, the flag it spells it with and the config
vocabulary it reads are that CLI's own business and are declared by its module
in ``cli_vendors`` (``VendorSpec.mcp_wiring``); this module knows only the four
mechanisms and does the I/O:

- a spawn-time FLAG carrying the config (claude, copilot, qwen) or a one-shot
  config override (codex). Additive by construction: servers passed this way
  load in addition to the user's own, and a command that already carries the
  flag — ours from an earlier pass, or the user's deliberate MCP setup — is
  left exactly as it is. The document carries a credential and argv is
  readable by every account through ``ps``, so it is passed as a 0600 file
  under ``<app_data_dir>/plan-mcp-panes/`` (codex: the credential goes in the
  spawn env, named by a second override). A claude spawn with no pane id is
  handed the app-owned ``<app_data_dir>/plan-mcp.json``, which is why that
  file is still written at startup.
- an ENVIRONMENT VARIABLE carrying a whole config document (opencode, kilo),
  deep-merged by the CLI over the user's files, so nothing on disk is written
  and the value dies with the pane. A value already present in the spawn env
  is left alone. Note this reaches only variables Navide itself set — one
  exported from the user's shell profile is inherited by the CLI process and
  would be overwritten.
- a PROJECT CONFIG FILE in the workspace (cursor), the one exception to "no
  user config file is ever modified". It is merge-written, and because one
  file is shared by every pane in the workspace it holds a reference to an
  environment variable rather than a URL, with the per-pane credential riding
  in the spawn env. A file we created is added to ``.git/info/exclude`` so it
  stays out of the user's git status; one that already existed is left to the
  user to manage. Unparseable JSON aborts the write rather than clobbering it.
- a CONFIG FILE UNDER THE HOME DIRECTORY and nothing else (kimi, grok,
  antigravity). Each pane gets a shim of that directory — mirrored by symlink
  so credentials and sessions stay the user's, with only the MCP config
  materialised. See pane_home.py.

The port is read from the discovery file written by __main__ before uvicorn
starts (same mechanism the Claude hooks use). File absent → wiring no-ops,
so a spawn is never broken over MCP wiring.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import secrets
import tempfile
import threading
from pathlib import Path
from typing import Any
from urllib.parse import quote

from agent_team_backend import log_redaction
from agent_team_backend.applog import app_data_dir, backend_port_file
from agent_team_backend.cli_vendors import registry
from agent_team_backend.cli_vendors.base import McpWiring, mcp_document, mcp_entry
from agent_team_backend.mcp_server import auth, pane_home
from agent_team_backend.osplat import paths, secret_files, terminal_backend

log = logging.getLogger("agent_team_backend.mcp_server.wiring")

SERVER_NAME = "navide"
SERVER_LABEL = "Navide"
CLAUDE_CONFIG_FILENAME = "plan-mcp.json"

# Names this server shipped under before. Every config surface we merge into
# rather than rewrite has to drop them, or a CLI upgraded in place loads the
# old entry alongside the new one — same endpoint, every tool twice.
LEGACY_SERVER_NAMES = ("navide-plans",)

# A project config file is written once per workspace and shared by every pane
# in it, so the pane-specific URL cannot be baked into it. It holds a reference
# to this variable instead — in whatever syntax the CLI interpolates — and the
# spawn env carries the real value.
PROJECT_URL_ENV = "NAVIDE_MCP_URL"

# The credential a CLI configured by flag reads from its environment, for a
# flag that carries a URL rather than a config document (codex). argv is
# readable by every account on the machine through `ps`; the environment is not.
TOKEN_ENV = "NAVIDE_MCP_TOKEN"

# Per-spawn config documents for CLIs whose flag reads a file. Each one holds a
# credential, so the directory is owner-only and is emptied at startup: the
# documents are read once at CLI start and their tokens die with the run.
PANE_CONFIG_DIRNAME = "plan-mcp-panes"

# One credential per pane id, minted the first time that pane is wired and
# kept while anything still names the pane, so a respawn of the same id (the
# embedded AI dock) carries the token its previous CLI had rather than
# stranding it. Revoked by release_pane_token once the pane is closed.
# Memory only: a backend restart moves the port anyway, so nothing from a
# previous run could reach this one. Spawn wiring runs in worker threads and
# concurrent pane restores would otherwise race to mint the same pane's token.
_PANE_TOKENS: dict[str, str] = {}
_PANE_TOKENS_LOCK = threading.Lock()


def plan_mcp_url(port: int, pane_id: str = "", *, with_token: bool = True) -> str:
    """Endpoint URL, identifying the pane the CLI runs in when known.

    The endpoint requires a credential on every call (see
    plan_mcp._resolve_caller): with a pane id, the pane credential rides in
    the query string so a tool that acts *as* the calling pane (cli_send) can
    tell who is asking. Without one — the fallback claude config and any
    wired command spawned before a pane id was known — this backend's own
    host credential rides instead, so its own CLI wiring is never mistaken
    for an external caller.

    ``with_token=False`` leaves the credential out, for a CLI that sends it
    as a bearer header instead (see TOKEN_ENV).
    """
    base = f"http://127.0.0.1:{port}/plan-mcp"
    query = f"pane={quote(pane_id, safe='')}" if pane_id else "client=host"
    if not with_token:
        return f"{base}?{query}"
    return f"{base}?{query}&t={quote(spawn_token(pane_id), safe='')}"


def spawn_token(pane_id: str = "") -> str:
    """The credential a spawn's wiring carries: the pane's, or the host's."""
    return caller_token(pane_id) if pane_id else auth.internal_token()


def caller_token(pane_id: str) -> str:
    """The secret that marks a caller as ``pane_id``, minted on first use.

    Per pane: plan_mcp._resolve_caller accepts ``pane=<id>`` only with the
    token minted for that id, and there is no longer one token shared by every
    pane. That is not a boundary between processes of the same user: the
    token sits in the pane's spawn environment or in its 0600 file under
    ``plan-mcp-panes/`` (or its shim home), and any process running as the
    user — another pane's agent included — can read those and obtain another
    pane's token (see plan_mcp._PANE_PRIVATE_UI_ACTIONS). Binding a caller to
    the pane's own process is a separate follow-up. It never rides in a
    pane's command line (see wire_command), so it is not on show to other
    accounts through ``ps``. Minted only by spawn wiring in production — the
    server looks tokens up with bound_pane_token, which never mints.
    """
    with _PANE_TOKENS_LOCK:
        token = _PANE_TOKENS.get(pane_id)
        if token is None:
            token = secrets.token_urlsafe(24)
            _PANE_TOKENS[pane_id] = token
            log_redaction.add_secret(token)
        return token


def release_pane_token(pane_id: str) -> None:
    """Revoke ``pane_id``'s token once nothing can still be using it.

    Called when the messaging registry forgets the id (pane closed, aged out
    offline, or a former id dropped with its pane) and when its PTY exits.
    The token is kept while either side still names the pane: a registered or
    aliased id is a pane on screen whose CLI may be re-attached under a new id
    (it keeps presenting this one), and a live PTY is a CLI that holds it —
    the same-id AI dock respawn, or a close that reached the registry before
    the process was gone. Revoked, the id gets a fresh token when it is next
    spawned, so a CLI that has exited cannot be impersonated with its old
    token under a reused id.

    Not covered: a CLI whose PTY is still running when its id is closed and
    the same id registers again keeps the token, because nothing tells that
    CLI apart from the new pane's. Pane ids are random UUIDs; only the AI dock
    reuses one, and its terminal.create kills the old PTY before respawning.

    The check and the revoke hold the lock that minting takes, so a same-id
    respawn's wiring cannot be handed the token this call is about to drop.
    """
    from agent_team_backend import agent_messaging

    with _PANE_TOKENS_LOCK:
        if pane_id not in _PANE_TOKENS:
            return
        if agent_messaging.names_pane(pane_id) or _pane_has_live_pty(pane_id):
            return
        token = _PANE_TOKENS.pop(pane_id, None)
        pane_home.forget_grok_workspace(pane_id)
    if token:
        log_redaction.remove_secret(token)


def _pane_has_live_pty(pane_id: str) -> bool:
    """Whether a PTY of this backend still runs with ``pane_id``. The app
    module is only consulted when loaded: without it there are no PTYs."""
    import sys

    app = sys.modules.get("agent_team_backend.app")
    terminals = getattr(app, "_TERMINALS", None) if app is not None else None
    if terminals is None:
        return False
    try:
        return bool(terminals.live_session_ids_for_pane(pane_id))
    except Exception:  # noqa: BLE001 — keep the token when unsure
        return True


def bound_pane_token(pane_id: str) -> str:
    """The token minted for ``pane_id`` in this run, or "" when it was never
    wired — in which case no pane credential can name it."""
    with _PANE_TOKENS_LOCK:
        return _PANE_TOKENS.get(pane_id, "") if pane_id else ""


def claude_config_path() -> Path:
    """App-owned MCP config file handed to claude panes via --mcp-config."""
    return app_data_dir() / CLAUDE_CONFIG_FILENAME


def mcp_wiring(agent_key: str) -> McpWiring | None:
    """How this CLI takes MCP wiring, or None when it takes none at all."""
    spec = registry.vendor(agent_key)
    return spec.mcp_wiring if spec is not None else None


def config_document(agent_key: str, url: str) -> dict[str, Any]:
    """The config document ``agent_key``'s CLI reads, naming this server.

    Every CLI spells the same thing differently (``type: http``, a bare
    ``httpUrl``, ``type: remote``, a list keyed by ``id``), so the shape comes
    from the vendor registry and only the identity is this plugin's.
    """
    wiring = mcp_wiring(agent_key)
    if wiring is None or wiring.config is None:
        return {}
    return mcp_document(
        wiring.config, {}, name=SERVER_NAME, label=SERVER_LABEL, url=url
    )


def config_json(agent_key: str, port: int, pane_id: str = "") -> str:
    """Single-line config document, for the flags and variables that take one
    literally, so a pane-specific URL needs no per-pane file."""
    return json.dumps(
        config_document(agent_key, plan_mcp_url(port, pane_id)), separators=(",", ":")
    )


def backend_port() -> int | None:
    """Current backend port from the discovery file (absent/invalid → None)."""
    try:
        text = backend_port_file().read_text(encoding="utf-8").strip()
        return int(text) if text else None
    except (OSError, ValueError):
        return None


def _harden(path: Path) -> None:
    """Tighten a config file left group/world readable by an older version.

    Everything written below is already 0600, but an unchanged-content run
    returns before rewriting anything, so a file from before that would keep
    its old mode forever.
    """
    try:
        secret_files.harden_file(path)
    except OSError:
        pass


def write_claude_config(port: int, path: Path | None = None) -> Path:
    """Write the claude ``--mcp-config`` file pointing at ``port``.

    The file is wholly app-owned (it contains only our own entry;
    the user's own MCP config is a separate surface we never touch), so this
    is a plain idempotent rewrite: unchanged content is left alone, a stale
    port from a previous run is overwritten. Atomic via os.replace.

    The URL embeds the host internal token, so the file must never exist
    group/world readable — see _harden and the 0600 create below.
    """
    path = path or claude_config_path()
    content = json.dumps(config_document("claude", plan_mcp_url(port)), indent=2) + "\n"
    try:
        if path.read_text(encoding="utf-8") == content:
            _harden(path)
            return path
    except OSError:
        pass
    # Owner-only from creation (the seam sets the mode before the token is
    # written), replaced atomically; plain content because claude parses it.
    secret_files.write_private_plain(path, content.encode("utf-8"))
    return path


def pane_config_dir() -> Path:
    return app_data_dir() / PANE_CONFIG_DIRNAME


def write_spawn_config(agent_key: str, port: int, pane_id: str = "") -> Path:
    """Write ``agent_key``'s config document for one spawn, owner-only.

    Named by the pane (or "host" without one), so a pane that is respawned
    replaces its own file rather than adding another.
    """
    directory = pane_config_dir()
    secret_files.make_private_dir(directory)
    digest = hashlib.sha256((pane_id or "host").encode("utf-8")).hexdigest()[:16]
    path = directory / f"{agent_key}-{digest}.json"
    document = config_document(agent_key, plan_mcp_url(port, pane_id))
    secret_files.write_private_plain(path, json.dumps(document, indent=2).encode("utf-8"))
    return path


def clear_pane_configs() -> None:
    """Remove the previous run's per-spawn config files; their tokens are dead."""
    try:
        entries = list(pane_config_dir().iterdir())
    except OSError:
        return
    for entry in entries:
        try:
            entry.unlink()
        except OSError as err:
            log.warning("could not remove %s: %s", entry, err)


def _command_text(command: Any) -> str:
    """Real CLI command string from a terminal.create payload command.

    The frontend wraps agent commands as ``[shell, '-ilc'|'-lc', '<cmd>']`` —
    the real command is the LAST element. Plain strings pass through.
    (Local copy of app._command_text; importing app here would be circular.)
    """
    if isinstance(command, list):
        return str(command[-1]) if command else ""
    return str(command or "")


def _already_wired(text: str, marker: str) -> bool:
    """Whether ``marker`` (a flag, or a quoted server name) is in ``text``.

    Checked against the command as typed and against its argv words: the
    marker is written in the unquoted form (``"navide"`` inside inline JSON),
    and the platform's quoting can hide it from a substring test — Windows
    escapes the inner quotes (``\\"navide\\"``), POSIX only wraps the word.
    Without the second look a wired command reads as unwired and gets the
    flag appended again on every spawn.
    """
    if marker in text:
        return True
    try:
        words = terminal_backend.parse_command(text)
    except ValueError:
        return False
    return any(marker in word for word in words)


def _append_to_command(command: Any, suffix: str) -> Any:
    """Append ``suffix`` to the real command, preserving the shell wrapper."""
    if isinstance(command, list):
        updated = list(command)
        updated[-1] = f"{updated[-1]} {suffix}"
        return updated
    return f"{command} {suffix}"


def project_config_path(agent_key: str, cwd: str | Path) -> Path | None:
    """Project MCP config this CLI discovers from the pane's working directory,
    or None when it has no such surface."""
    wiring = mcp_wiring(agent_key)
    if wiring is None or not wiring.project_config:
        return None
    return Path(cwd).joinpath(*wiring.project_config)


def project_config_inside(path: Path, root: Path) -> bool:
    """Whether ``path``, a project MCP config of the workspace ``root``, is
    really the workspace's own.

    The repository decides what its ``.cursor`` holds, so a folder level that
    is a link, or a config that is a link resolving outside the workspace (to
    ``~/.claude.json``, or to a path that does not exist yet), is never
    written, created or cleaned through. A link that stays inside is fine.
    """
    from agent_team_backend.plugins.builtin.navide_skills.skills_wiring import project_target_safe

    if not project_target_safe(path.parent, root):
        return False
    try:
        path.resolve().relative_to(root.resolve())
    except (OSError, ValueError):
        return False
    return True


def _project_root(agent_key: str, path: Path) -> Path:
    """The workspace a project MCP config path belongs to."""
    wiring = mcp_wiring(agent_key)
    depth = len(wiring.project_config) if wiring is not None and wiring.project_config else 1
    return path.parents[depth - 1]


def _write_atomic(path: Path, content: str) -> None:
    """Replace ``path`` in one step, with a temp name no other pane can share.

    A fixed ``.tmp`` neighbour would collide when two panes on the same
    workspace spawn at once: one os.replace wins, the other raises on a temp
    file that is already gone, and worse, a CLI starting in between could read
    a half-written config. A link (a dotfiles-managed config) is written
    through: replacing it would turn it into a plain file.
    """
    path = path.resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        mode: int | None = path.stat().st_mode & 0o777
    except OSError:
        mode = None
    handle, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".")
    tmp = Path(tmp_name)
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            stream.write(content)
        # os.replace carries the temp file's mode over, and mkstemp makes it
        # 0600. Keep whatever the user's file had; a new one follows the umask
        # like any other file this process creates.
        if mode is None:
            umask = os.umask(0)
            os.umask(umask)
            mode = 0o666 & ~umask
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except OSError:
        tmp.unlink(missing_ok=True)
        raise


def _git_repo_root(start: Path) -> Path | None:
    """Nearest ancestor holding a ``.git`` directory, ``start`` included.

    A pane's cwd is often a subdirectory of the repo, and only the root's
    ``.git/info/exclude`` governs it. The walk stops below the home directory:
    a home that is itself a dotfiles repo would otherwise claim every workspace
    under it that is not a repo of its own. A ``.git`` *file* ends the walk
    too — that is a worktree or submodule, whose exclude file is the
    superproject's and not ours to append to.
    """
    # The real home, not $HOME: a backend launched from a shimmed pane
    # inherits the shim's, and Windows ignores HOME altogether.
    home = pane_home.real_home().resolve()
    for candidate in (start, *start.parents):
        if candidate.resolve() == home:
            return None
        dot_git = candidate / ".git"
        if dot_git.is_file():
            return None
        if (dot_git / "info").is_dir():
            return candidate
    return None


def _exclude_from_git(config_path: Path, start: Path) -> None:
    """Ignore the config locally, without touching the user's .gitignore.

    ``.git/info/exclude`` is per-clone and never committed, so a file Navide
    created does not turn up in the user's git status or get swept into a
    commit. Only called for a config file we created: an existing one is the
    user's, and so is the decision to track it.
    """
    repo = _git_repo_root(start)
    if repo is None:
        return  # no repo, or a worktree/submodule layout that is not ours
    try:
        relpath = config_path.relative_to(repo).as_posix()
    except ValueError:
        return
    exclude = repo / ".git" / "info" / "exclude"
    try:
        text = exclude.read_text(encoding="utf-8") if exclude.is_file() else ""
        # Line-wise, not whitespace-split: the path appearing inside a comment
        # ("# .cursor/mcp.json is tracked on purpose") does not ignore it.
        if any(line.strip() == relpath for line in text.splitlines()):
            return
        prefix = "" if not text or text.endswith("\n") else "\n"
        with exclude.open("a", encoding="utf-8") as handle:
            handle.write(f"{prefix}{relpath}\n")
    except OSError as err:
        log.warning("could not exclude %s from git: %s", relpath, err)


def ensure_project_config(agent_key: str, cwd: str | Path) -> bool:
    """Merge our entry into a workspace's project MCP config.

    Returns whether the file ends up carrying our entry. The user's own
    servers are preserved, and a file that does not parse as a JSON object is
    left exactly as it is — a pane losing MCP wiring is a far smaller harm
    than eating the servers someone hand-wrote. Entries under a name we used
    to ship under are ours, not the user's, so they are dropped.
    """
    wiring = mcp_wiring(agent_key)
    path = project_config_path(agent_key, cwd)
    if wiring is None or wiring.config is None or path is None:
        return False
    root = Path(cwd)
    if not root.is_dir():
        return False
    if root.resolve() == pane_home.real_home().resolve():
        # A project config under the home directory is the CLI's *global* one,
        # not a project one: our entry would apply in every project the user
        # opens, and outside Navide the variable is unset, leaving a server
        # that cannot connect.
        log.warning("workspace is the home directory — not wiring %s globally", agent_key)
        return False
    if not project_config_inside(path, root):
        log.warning("%s reaches outside %s through a link — leaving %s unwired", path, root, agent_key)
        return False
    existed = path.exists()
    document: dict[str, Any] = {}
    if existed:
        try:
            raw = path.read_text(encoding="utf-8").strip()
        except OSError:
            return False
        if raw:
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError:
                log.warning("%s is not valid JSON — leaving %s unwired", path, agent_key)
                return False
            if not isinstance(parsed, dict):
                return False
            document = parsed
    # A project config is a flat map of servers; the URL in it is a reference
    # to the variable the spawn env carries, in this CLI's own syntax.
    section = wiring.config.section[-1]
    servers = document.get(section, {})
    if not isinstance(servers, dict):
        # Present but the wrong shape: whatever it means, it is the user's.
        # Replacing it with a map holding only our server would be exactly the
        # clobber the unparseable-JSON branch above refuses to do.
        log.warning("%s has a non-object %s — leaving %s unwired", path, section, agent_key)
        return False
    entry = mcp_entry(
        wiring.config,
        name=SERVER_NAME,
        label=SERVER_LABEL,
        url=wiring.url_env_template % PROJECT_URL_ENV,
    )
    stale = [name for name in LEGACY_SERVER_NAMES if name in servers]
    if not stale and servers.get(SERVER_NAME) == entry:
        return True
    document[section] = {
        **{key: value for key, value in servers.items() if key not in stale},
        SERVER_NAME: entry,
    }
    try:
        _write_atomic(path, json.dumps(document, indent=2) + "\n")
    except OSError as err:
        log.warning("could not write %s: %s", path, err)
        return False
    if not existed:
        _exclude_from_git(path, root)
    return True


def project_config_has_entry(agent_key: str, path: Path) -> bool:
    """Whether a project MCP config still carries our server.

    Raises when the file exists but is not a JSON object: an unreadable file
    says nothing about whether the user removed our entry.
    """
    wiring = mcp_wiring(agent_key)
    if wiring is None or wiring.config is None or not path.is_file():
        return False
    if not project_config_inside(path, _project_root(agent_key, path)):
        return False  # not the workspace's file: nothing of Navide's is there
    raw = path.read_text(encoding="utf-8").strip()
    document = json.loads(raw) if raw else {}
    if not isinstance(document, dict):
        raise ValueError(f"{path} is not a JSON object")
    servers = document.get(wiring.config.section[-1])
    return isinstance(servers, dict) and SERVER_NAME in servers


def remove_project_config(agent_key: str, path: Path) -> bool:
    """Take our server back out of a project MCP config; True when it was there.

    The user's servers stay. A file left holding nothing but an empty server
    map was Navide's alone: it is deleted, along with the git exclude line
    ``ensure_project_config`` added for it. A file that does not parse is left
    exactly as it is.
    """
    wiring = mcp_wiring(agent_key)
    if wiring is None or wiring.config is None or not path.is_file():
        return False
    if not project_config_inside(path, _project_root(agent_key, path)):
        log.warning("%s reaches outside its workspace through a link — leaving it alone", path)
        return False
    try:
        raw = path.read_text(encoding="utf-8").strip()
        document = json.loads(raw) if raw else {}
    except (OSError, json.JSONDecodeError) as err:
        log.warning("%s unreadable (%s) — leaving it alone", path, err)
        return False
    section = wiring.config.section[-1]
    servers = document.get(section) if isinstance(document, dict) else None
    if not isinstance(servers, dict):
        return False
    ours = [name for name in (SERVER_NAME, *LEGACY_SERVER_NAMES) if name in servers]
    if not ours:
        return False
    kept = {key: value for key, value in servers.items() if key not in ours}
    if not kept and set(document) == {section}:
        path.unlink(missing_ok=True)
        _unexclude_from_git(path, path.parent)
        return True
    document[section] = kept
    _write_atomic(path, json.dumps(document, indent=2) + "\n")
    return True


def _unexclude_from_git(config_path: Path, start: Path) -> None:
    """Drop the exclude line ``_exclude_from_git`` added for a file we removed."""
    repo = _git_repo_root(start)
    if repo is None:
        return
    try:
        relpath = config_path.relative_to(repo).as_posix()
    except ValueError:
        return
    exclude = repo / ".git" / "info" / "exclude"
    try:
        lines = exclude.read_text(encoding="utf-8").splitlines(keepends=True)
    except OSError:
        return
    kept = [line for line in lines if line.strip() != relpath]
    if kept != lines:
        try:
            exclude.write_text("".join(kept), encoding="utf-8")
        except OSError as err:
            log.warning("could not update %s: %s", exclude, err)


def wire_command(
    agent_key: str,
    command: Any,
    port: int | None,
    pane_id: str = "",
    env: dict[str, str] | None = None,
    cwd: str = "",
    *,
    claude_config: Path | None = None,
    warnings: list[str] | None = None,
) -> Any:
    """Point a pane spawn at the Plan MCP endpoint, the way its CLI takes it.

    A pure dispatcher over ``VendorSpec.mcp_wiring``: which surface each CLI
    offers is declared there, and each of the four is handled once here.

    No-op for agents that declare no wiring, an unknown port, empty commands,
    already-wired commands, a flag the user supplied themselves (respect their
    deliberate MCP setup, esp. with --strict-mcp-config), or a missing fallback
    config file — a spawn must never break over MCP wiring.

    No credential is ever put in the command line: ``ps`` shows argv to every
    account on the machine. A flag that reads a file is handed a 0600
    per-spawn document (see write_spawn_config); codex's URL override is
    paired with an override naming TOKEN_ENV, set in ``env``.

    ``env`` is the spawn environment and is mutated in place for the CLIs
    configured by variable; None (or a variable already set) leaves it alone.
    ``cwd`` is the pane's working directory, needed only for a project config —
    without it the file cannot be located and the pane goes unwired.
    ``warnings``, when given, collects a line for the pane whenever this
    machine cannot wire it at all — the pane otherwise looks healthy while
    every navide tool is missing from it.
    """
    if port is None:
        return command
    text = _command_text(command)
    if not text.strip():
        return command
    wiring = mcp_wiring(agent_key)
    if wiring is None:
        return command
    if wiring.flag:
        if _already_wired(text, wiring.already_wired.format(flag=wiring.flag, name=SERVER_NAME)):
            return command
        if wiring.flag_file_prefix is not None and _already_wired(text, PANE_CONFIG_DIRNAME):
            return command
        extra = ""
        if wiring.flag_value:
            # The credential goes in the environment, never in argv; without an
            # env to put it in, the URL has to carry it.
            by_env = bool(wiring.flag_token_env_value) and env is not None
            value = wiring.flag_value.format(
                name=SERVER_NAME, url=plan_mcp_url(port, pane_id, with_token=not by_env)
            )
            if by_env:
                env[TOKEN_ENV] = spawn_token(pane_id)
                token_value = wiring.flag_token_env_value.format(name=SERVER_NAME, env=TOKEN_ENV)
                extra = f" {wiring.flag} {paths.quote_arg(token_value)}"
        elif wiring.flag_accepts_path and not pane_id:
            config = claude_config or claude_config_path()
            if not config.is_file():
                return command
            value = str(config)
        elif wiring.flag_file_prefix is not None:
            try:
                path = write_spawn_config(agent_key, port, pane_id)
            except OSError as err:
                log.warning("%s pane %s spawns unwired: %s", agent_key, pane_id, err)
                if warnings is not None:
                    warnings.append(f"navide MCP not wired: {err}")
                return command
            value = f"{wiring.flag_file_prefix}{path}"
        else:
            value = config_json(agent_key, port, pane_id)
        return _append_to_command(command, f"{wiring.flag} {paths.quote_arg(value)}{extra}")
    if wiring.config_env:
        if env is not None and wiring.config_env not in env:
            env[wiring.config_env] = config_json(agent_key, port, pane_id)
        return command
    if wiring.project_config:
        # env first: with nowhere to put the URL there is no point writing a
        # config file into the user's repo.
        from ..convenience_wiring import ensure_project_config_gated

        if cwd and env is not None and ensure_project_config_gated(agent_key, cwd):
            env.setdefault(PROJECT_URL_ENV, plan_mcp_url(port, pane_id))
        return command
    if wiring.config_file:
        # No pane id means no shim: the directory is keyed by it, and a shared
        # one would have panes overwriting each other's endpoint. A variable
        # already set (an account-isolated home) is checked before preparing,
        # so a spawn we are going to leave alone does no filesystem work at all.
        shim = pane_home.SHIM_SPECS[agent_key]
        if pane_id and env is not None and shim.env_var not in env:
            reason = pane_home.unavailable_reason(agent_key)
            if reason is not None:
                log.warning("%s pane %s spawns unwired: %s", agent_key, pane_id, reason)
                if warnings is not None:
                    warnings.append(f"navide MCP not wired: {reason}")
                return command
            prepared = pane_home.prepare(
                agent_key,
                pane_id,
                plan_mcp_url(port, pane_id),
                SERVER_NAME,
                SERVER_LABEL,
                LEGACY_SERVER_NAMES,
                workspace=cwd,
            )
            if prepared is not None:
                _, root = prepared
                env.update(shim.spawn_env(root))
    return command


def write_claude_config_for_current_port() -> None:
    """Refresh the app-owned claude ``--mcp-config`` file with this run's port,
    and drop the previous run's per-spawn config files.

    Port discovery file absent -> no-op; panes just spawn unwired. Kept apart
    from the session-manager startup so a failure in one never skips the other.
    """
    clear_pane_configs()
    port = backend_port()
    if port is not None:
        write_claude_config(port)

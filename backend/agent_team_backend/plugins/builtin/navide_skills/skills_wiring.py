"""Expose enabled app-managed skills to a pane's CLI agent at spawn time.

Every CLI that has skills discovers them from directories, so the shape is
always the same: build a view directory of symlinks for this agent, then hand
the CLI that path in whatever way it accepts one. The per-vendor part — which
flag, which config key, which layout — is declared in each vendor's
``SkillsWiring`` spec rather than branched on here.

Two rules the vendor specs exist to keep:

- **The user's own skills are never displaced.** Managed names that collide
  with a native ``~/.claude/skills`` entry are dropped from the view, and a
  flag that replaces the CLI's own discovery (kimi's ``--skills-dir``) gets
  the discovery roots passed back alongside ours.
- **A spawn never breaks over skills.** Every failure path returns the command
  unchanged; the worst outcome is a pane without managed skills, and the pane
  says so at startup (``take_spawn_warnings``).
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import stat
import tempfile
import threading
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any

from agent_team_backend import osplat
from agent_team_backend.applog import app_data_dir
from agent_team_backend.cli_vendors.base import SkillsWiring
from agent_team_backend.cli_vendors.registry import vendor
from agent_team_backend.skills_store import SkillsStore

log = logging.getLogger("agent_team_backend.plugins.builtin.navide_skills.skills_wiring")

VIEWS_DIR = "skills-views"
#: Shared with pane_home: a vendor that needs a shim for both MCP and skills
#: must end up with one, not two.
PANES_DIR_NAME = ".navide-panes"
#: Same guard pane_home applies — the lookahead rejects "." and ".." on their
#: own, which would otherwise resolve a shim onto a directory we do not own.
_SAFE_PANE_ID = re.compile(r"^(?!\.+$)[A-Za-z0-9_.:-]+$")

#: pane id -> lines that pane prints at startup because its skills could not
#: be wired. Filled by wire_command, drained by the spawn handler right after
#: the spawn transformers ran.
_spawn_warnings: dict[str, list[str]] = {}
_spawn_warnings_lock = threading.Lock()


def take_spawn_warnings(pane_id: str) -> list[str]:
    """The startup lines for ``pane_id`` collected by wire_command, once."""
    with _spawn_warnings_lock:
        return _spawn_warnings.pop(pane_id or "", [])


def _record_spawn_warnings(pane_id: str, errors: list[str]) -> None:
    if not errors:
        return
    with _spawn_warnings_lock:
        _spawn_warnings.setdefault(pane_id or "", []).extend(
            f"navide skills not wired: {error}" for error in errors
        )


def views_root() -> Path:
    return app_data_dir() / "runtime" / VIEWS_DIR


def agent_view_root(agent_key: str) -> Path:
    return views_root() / agent_key


def skills_wiring(agent_key: str) -> SkillsWiring | None:
    spec = vendor(agent_key)
    return spec.skills_wiring if spec is not None else None


def prepare_view(
    agent_key: str,
    wiring: SkillsWiring,
    *,
    store: SkillsStore | None = None,
    native_root: Path | None = None,
    view_root: Path | None = None,
    errors: list[str] | None = None,
) -> Path | None:
    """Build this agent's view of the managed library, or None when empty.

    The view is rebuilt from scratch and swapped in atomically, so a removed
    or newly-targeted skill can never linger. Returns the path the CLI should
    be pointed at — the view root, with the vendor's required layout already
    materialised inside it. ``errors``, when given, collects why it failed.
    """
    try:
        view_root = view_root or agent_view_root(agent_key)
        sources = _managed_sources(agent_key, store, native_root)
        _replace_view(view_root, sources, wiring.view_layout)
        return view_root if sources else None
    except Exception as err:  # noqa: BLE001 - optional wiring must never block spawn
        log.warning("Managed-skills view for %s failed: %s", agent_key, err)
        if errors is not None:
            errors.append(str(err))
        return None


def discovery_roots(wiring: SkillsWiring, cwd: str) -> list[Path]:
    """Roots the CLI would have discovered itself, for a replacing flag.

    Only existing directories are returned: passing a path the CLI would not
    have found is a behaviour change, not a restoration.
    """
    roots: list[Path] = []
    if not wiring.replaces_discovery:
        return roots
    try:
        home = Path.home()
    except (OSError, RuntimeError):
        home = None
    bases = [(home, wiring.discovery_home)]
    if cwd:
        bases.append((Path(cwd), wiring.discovery_project))
    for base, relatives in bases:
        if base is None:
            continue
        for relative in relatives:
            candidate = base.joinpath(*relative)
            try:
                if candidate.is_dir():
                    roots.append(candidate)
            except OSError:
                continue
    return roots


def flag_values(wiring: SkillsWiring, view: Path, cwd: str) -> list[str]:
    """Every path this CLI's flag should be repeated over."""
    leaf = view.joinpath(*wiring.view_layout)
    if wiring.flag_takes == "each":
        try:
            entries = sorted(leaf.iterdir(), key=lambda path: path.name)
        except OSError:
            return []
        paths = [str(entry) for entry in entries]
    else:
        paths = [str(view)]
    return paths + [str(root) for root in discovery_roots(wiring, cwd)]


def config_document(wiring: SkillsWiring, existing: str, view: Path) -> str:
    """``existing`` config document with our view added to its skills paths.

    The variable is shared with MCP wiring, so this merges into whatever is
    already there instead of replacing it, and keeps any path the user's own
    document already registered. A document that is not a JSON object raises
    ValueError: it is the user's, and replacing it would drop what it holds.
    """
    document = json.loads(existing) if existing.strip() else {}
    if not isinstance(document, dict):
        raise ValueError("not a JSON object")
    node: dict[str, Any] = document
    for step in wiring.config_paths_key[:-1]:
        child = node.get(step)
        child = dict(child) if isinstance(child, dict) else {}
        node[step] = child
        node = child
    leaf = wiring.config_paths_key[-1]
    current = node.get(leaf)
    paths = [item for item in current if isinstance(item, str)] if isinstance(current, list) else []
    target = str(view.joinpath(*wiring.view_layout))
    if target not in paths:
        paths.append(target)
    node[leaf] = paths
    return json.dumps(document)


#: Whether this plugin is running, i.e. whether pane spawns get shims.
_active = False


def active() -> bool:
    return _active


def set_active(running: bool) -> None:
    """The plugin started or stopped: Copilot's hooks ride on the shims."""
    global _active
    _active = running
    from agent_team_backend.convenience_wiring import pane_carrier_changed

    pane_carrier_changed("copilot", running)


def _warn_uncarried(agent_key: str, pane_id: str, why: str) -> None:
    from agent_team_backend.convenience_wiring import pane_carries_hooks

    if agent_key == "copilot" and pane_carries_hooks(agent_key):
        log.warning("copilot pane %s starts without Navide's hooks: %s", pane_id, why)


def real_home() -> Path:
    """The user's home, read the way pane_home reads it.

    ``Path.home()`` prefers ``$HOME``, and launching Navide from inside a
    shimmed pane makes the backend inherit that pane's HOME — building a shim
    under it would mirror links to links.
    """
    try:
        import pwd

        return Path(pwd.getpwuid(os.getuid()).pw_dir)
    except (ImportError, AttributeError, KeyError, OSError):
        return Path.home()


def panes_root() -> Path:
    """Same tree pane_home uses, so a vendor needing both gets one shim."""
    return real_home() / PANES_DIR_NAME


def owns_its_shim(agent_key: str) -> bool:
    """Whether MCP wiring already builds this vendor's per-pane home.

    Those vendors are ridden, never created for: the MCP side skips its own
    work when the variable is already set, so creating the root here first
    would silently cost the pane its MCP server.
    """
    spec = vendor(agent_key)
    mcp = spec.mcp_wiring if spec is not None else None
    return bool(mcp is not None and mcp.config_dir)


def prepare_root(
    agent_key: str,
    wiring: SkillsWiring,
    pane_id: str,
    env: dict[str, str],
    *,
    store: SkillsStore | None = None,
    native_root: Path | None = None,
    home: Path | None = None,
    errors: list[str] | None = None,
) -> str | None:
    """Materialise this CLI's own skills directory inside a per-pane root.

    Skills-owned roots mirror the real one entry by entry. An isolated root
    owned by the vendor's home manager keeps its sibling entries unchanged.
    Returns the value ``root_env`` should carry, or None when nothing should
    be wired. ``errors``, when given, collects why it failed.
    """
    if not _SAFE_PANE_ID.match(pane_id or ""):
        _warn_uncarried(agent_key, pane_id, "no pane shim for this pane id")
        return None
    try:
        home = home or real_home()
        existing = env.get(wiring.root_env)
        if existing:
            _warn_uncarried(agent_key, pane_id, f"it runs with its own {wiring.root_env}")
            root = Path(existing)
            # Someone else's shim: it does its own reconciliation, and a
            # directory *it* built (its MCP config dir) is not ours to move
            # into the user's home just because the name is free there.
            ours = False
        elif owns_its_shim(agent_key):
            # MCP builds this vendor's shim; without it there is nowhere safe
            # to put the directory, and creating one would displace MCP.
            return None
        else:
            root = panes_root() / agent_key / pane_id
            ours = True
            from agent_team_backend.convenience_wiring import note

            note(
                "pane-shims", panes_root(),
                detail="per-pane homes for skills; entries a pane creates are moved"
                " into the vendor's own folder",
            )
        real_root = home.joinpath(*wiring.root_home)
        sources = _managed_sources(agent_key, store, native_root)
        suppressed = [home.joinpath(*rel) for rel in wiring.discovery_home]
        isolated = bool(
            existing and wiring.isolated_panes_home
            and root.parent.resolve() == home.joinpath(*wiring.isolated_panes_home).resolve()
        )
        # A root that stands in for the whole $HOME is never adopted from, as
        # in pane_home._mirror: what a tool writes to ``~`` there (a cloned
        # repo, a shell rc file) is not ours to promote into the real home.
        # copilot's ``hooks`` is rebuilt on its own (copilot_hooks), and a
        # real folder there must never be adopted into the user's tree.
        own_hooks = agent_key == "copilot" and ours and bool(wiring.root_home)
        _materialise(
            root, real_root, wiring.skills_rel, sources, suppressed,
            adopt=ours and bool(wiring.root_home), mirror_home=not isolated,
            own=frozenset({"hooks"}) if own_hooks else frozenset(),
        )
        if own_hooks:
            from agent_team_backend import copilot_hooks

            copilot_hooks.wire_pane_hooks(root, real_root / "hooks")
        return str(root)
    except Exception as err:  # noqa: BLE001 - optional wiring must never block spawn
        log.warning("Managed-skills root for %s failed: %s", agent_key, err)
        _warn_uncarried(agent_key, pane_id, "its shim could not be built")
        if errors is not None:
            errors.append(str(err))
        return None


def sync_project_dir(
    agent_key: str,
    wiring: SkillsWiring,
    cwd: str,
    *,
    store: SkillsStore | None = None,
    native_root: Path | None = None,
    skipped: list[Path] | None = None,
    errors: list[str] | None = None,
) -> bool:
    """Keep our links in the workspace's skill directory up to date.

    The last-resort surface, for a CLI with no relocation variable: the
    directory belongs to the user's repository, so only links *we planted*
    are ever written or removed there. Which those are cannot be inferred
    from where a link points — a delivered native skill lives in another
    CLI's directory, exactly like a link the user might make themselves — so
    the set is recorded in a manifest beside the links. Anything not in the
    manifest is the user's and is left untouched.

    ``skipped`` collects the links a skill's name kept from being created
    (one named like the manifest), for the caller to tell the user, and
    ``errors`` why the sync failed.
    """
    if not cwd:
        return False
    try:
        target = Path(cwd).joinpath(*wiring.project_rel)
        if not project_target_safe(target, Path(cwd)):
            log.warning("%s reaches outside %s through a link — not syncing skills there", target, cwd)
            return False
        if not manifest_safe(target):
            log.warning("%s is not a regular file — not syncing skills there", target / MANIFEST_FILE)
            return False
        if _manifest_unreadable(target):
            log.warning("%s cannot be read — not syncing skills there", target / MANIFEST_FILE)
            return False
        sources = _managed_sources(agent_key, store, native_root)
        planted = _read_manifest(target)
        refused = _read_refused(target)
        if not sources and not planted and not target.is_dir():
            return False
        ours = not target.is_dir() or _manifest_created(target)
        target.mkdir(parents=True, exist_ok=True)
        # Only a name the manifest carries back unchanged: any other link
        # would be an orphan that taking the links back never finds. A skill
        # named like the manifest would take the manifest's place.
        wanted = {
            source.name: source for source in sources
            if _manifest_name(source.name) and source.name != MANIFEST_FILE
        }
        for source in sources:
            if source.name == MANIFEST_FILE:
                log.warning("skill %s is named like Navide's manifest — not linked in %s", source, target)
                if skipped is not None:
                    skipped.append(target / source.name)
        # Remove what we planted before and no longer want; never anything else.
        for name in sorted(planted):
            if name in wanted:
                continue
            link = target / name
            if link.is_symlink():
                link.unlink(missing_ok=True)
            planted.discard(name)
        for name, source in wanted.items():
            if name in refused:
                continue  # the user deleted our link here once
            link = target / name
            if link.is_symlink():
                if _resolve(link) == _resolve(source):
                    planted.add(name)
                    continue
                if name not in planted:
                    continue  # the user's own link wins
                link.unlink(missing_ok=True)
            elif link.exists():
                continue  # a real directory here is the user's skill
            link.symlink_to(source, target_is_directory=True)
            planted.add(name)
        _write_manifest(target, planted, created=ours, refused=refused)
        if ours:
            _exclude_from_git(target)
        elif planted:
            # The directory is the user's: hide only what we put in it, so
            # their own untracked skills stay visible in git status.
            for name in sorted({*planted, MANIFEST_FILE}):
                _exclude_from_git(target / name, directory=False)
        return bool(sources)
    except Exception as err:  # noqa: BLE001 - optional wiring must never block spawn
        log.warning("Managed-skills project directory for %s failed: %s", agent_key, err)
        if errors is not None:
            errors.append(str(err))
        return False


def project_target_safe(target: Path, root: Path) -> bool:
    """Whether ``target`` really lives inside ``root``, the workspace.

    A cloned repository can make ``.cursor`` or ``.cursor/skills`` a link to
    a folder outside it — the user's own skills — with a manifest naming the
    user's links there. Every level below ``root`` must be a real directory
    (or absent) and the resolved target must stay inside the resolved root;
    otherwise the folder is not the workspace's and is never written or
    cleaned.
    """
    try:
        rel = target.relative_to(root)
    except ValueError:
        return False
    level = root
    for part in rel.parts:
        level = level / part
        if level.is_symlink():
            return False
    try:
        target.resolve().relative_to(root.resolve())
    except (OSError, ValueError):
        return False
    return True


def project_dir_intact(target: Path) -> bool:
    """Whether every link Navide planted in a workspace skills directory is
    still there.

    The manifest alone cannot say: a link the user deleted by hand leaves its
    name behind. A name in the manifest that is no longer a link is the
    user's removal.
    """
    if not has_manifest(target):
        return False
    return all((target / name).is_symlink() for name in _read_manifest(target))


def refuse_missing_links(target: Path) -> list[str]:
    """Record the planted links the user deleted by hand as refused.

    A name in the manifest that is no longer a link means the user does not
    want that skill in this workspace: it moves from the planted names to the
    refused ones and is never linked here again, while every other skill
    keeps working. Returns the names refused now.
    """
    if _manifest_unreadable(target):
        return []
    planted = _read_manifest(target)
    missing = sorted(name for name in planted if not (target / name).is_symlink())
    if missing:
        _write_manifest(
            target, planted - set(missing), created=_manifest_created(target),
            refused=_read_refused(target) | set(missing),
        )
    return missing


def clear_refused(target: Path, *, root: Path | None = None) -> None:
    """Forget the names refused in a workspace: re-allowing starts fresh."""
    if (
        not project_target_safe(target, root or target.parent)
        or _manifest_unreadable(target)
        or not _read_refused(target)
    ):
        return
    _write_manifest(target, _read_manifest(target), created=_manifest_created(target))


def remove_project_dir(target: Path, *, root: Path | None = None) -> int:
    """Take back the links Navide planted in a workspace skills directory.

    Only names in the manifest that are still symlinks are removed, then the
    manifest itself and the git exclude lines ``sync_project_dir`` added; the
    user's own skills there are never touched. A directory Navide created is
    deleted once it is empty. ``root`` is the workspace ``target`` belongs
    to (its parent when not given); a target reaching outside it through a
    link is left alone. Returns how many links were removed.
    """
    if not project_target_safe(target, root or target.parent):
        log.warning("%s reaches outside its workspace through a link — leaving it alone", target)
        return 0
    if not manifest_safe(target):
        log.warning("%s is not a regular file — leaving it alone", target / MANIFEST_FILE)
        return 0
    if _manifest_unreadable(target):
        log.warning("%s cannot be read — leaving it alone", target / MANIFEST_FILE)
        return 0
    removed = 0
    names = _read_manifest(target)
    created = _manifest_created(target) or _excluded_from_git(target)
    for name in sorted(names):
        link = target / name
        if link.is_symlink():
            link.unlink(missing_ok=True)
            removed += 1
    (target / MANIFEST_FILE).unlink(missing_ok=True)
    _unexclude_from_git(target, {*names, MANIFEST_FILE}, directory=created)
    if created:
        try:
            target.rmdir()
        except OSError:
            pass  # not empty: what is left is the user's
    return removed


#: Names of the links Navide planted in a workspace skills directory. Lives
#: beside them so it travels with the checkout and is covered by the same
#: git exclude.
MANIFEST_FILE = ".navide-links"
#: Manifest line recording that the directory itself was Navide's, so turning
#: the feature off may delete it once empty.
_CREATED_LINE = "# Navide created this directory"
#: Manifest lines naming a link the user deleted by hand: never linked again
#: in this workspace until the feature is re-allowed.
_REFUSED_PREFIX = "# refused: "
#: Open flags that never follow a link a repository ships in a file's place
#: and never block on a pipe; Windows has neither, and the lstat check that
#: precedes every open stands alone there.
_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)


def manifest_safe(target: Path) -> bool:
    """Whether the manifest in ``target`` is a regular file or absent.

    The skills folder may be the repository's own, and a repository can ship
    a link (to ``~/.zshrc``, or dangling) or a pipe under the manifest's
    name. Such a manifest is never read, written or deleted.
    """
    return _regular_or_absent(target / MANIFEST_FILE)


def _manifest_unreadable(target: Path) -> bool:
    """Whether a manifest is there but cannot be read (no permission, not
    UTF-8). That is not an empty manifest: the names it refuses are unknown,
    so nothing is planted, taken back or rewritten (fail closed)."""
    try:
        _read_regular(target / MANIFEST_FILE)
    except (OSError, UnicodeDecodeError):
        return True
    return False


def has_manifest(target: Path) -> bool:
    """Whether ``target`` holds a manifest Navide could have written: a
    regular file with one name, never a link."""
    try:
        return _sole_regular((target / MANIFEST_FILE).lstat())
    except OSError:
        return False


def _sole_regular(info: os.stat_result) -> bool:
    """A regular file with one name: not a link, not a hard link to a file
    that lives under another name somewhere else."""
    return stat.S_ISREG(info.st_mode) and info.st_nlink == 1


def _regular_or_absent(path: Path) -> bool:
    try:
        return _sole_regular(path.lstat())
    except FileNotFoundError:
        return True
    except OSError:
        return False


def _read_regular(path: Path) -> str | None:
    """``path``'s text, None when it is absent. Anything but a regular file
    (a link, a directory, a pipe) raises OSError and is never followed."""
    if not _regular_or_absent(path):
        raise OSError(f"{path} is not a regular file")
    try:
        fd = os.open(path, os.O_RDONLY | _NOFOLLOW)
    except FileNotFoundError:
        return None
    with os.fdopen(fd, "rb") as handle:
        if not _sole_regular(os.fstat(handle.fileno())):
            raise OSError(f"{path} is not a regular file")
        return handle.read().decode("utf-8")


def _replace_regular(path: Path, text: str) -> None:
    """Write ``path`` through a temporary file in its folder and an atomic
    rename, which replaces a link rather than writing where it leads. Only a
    regular file (or nothing) is ever replaced."""
    if not _regular_or_absent(path):
        raise OSError(f"{path} is not a regular file")
    try:
        mode = stat.S_IMODE(path.lstat().st_mode)
    except FileNotFoundError:
        mode = 0o644
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
            handle.write(text)
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def _read_manifest(target: Path) -> set[str]:
    """Names of the links Navide planted, as plain entry names only.

    The manifest sits in the user's repository where anyone can edit it, and
    its names are unlinked: one with a separator or ``..`` would reach outside
    the skills directory, and so would a Windows drive-relative name
    (``C:x``) or stream (``a:b``). Only a name that is its own final path
    component under both POSIX and Windows rules is kept. Lines split on
    ``\\n`` alone, the one separator ``_write_manifest`` writes.
    """
    try:
        text = _read_regular(target / MANIFEST_FILE)
    except OSError:
        return set()
    if text is None:
        return set()
    names = {line.strip() for line in text.split("\n") if line.strip() and not line.startswith("#")}
    return {name for name in names if _plain_entry_name(name)}


def _plain_entry_name(name: str) -> bool:
    return (
        name not in (".", "..")
        and name.isprintable()
        and ":" not in name
        and PurePosixPath(name).name == name
        and PureWindowsPath(name).name == name
    )


def _manifest_name(name: str) -> bool:
    """Whether ``name`` survives a round trip through the manifest: a plain
    entry name that is neither stripped (surrounding spaces) nor read as a
    comment (a leading ``#``)."""
    return _plain_entry_name(name) and name == name.strip() and not name.startswith("#")


def _manifest_created(target: Path) -> bool:
    try:
        lines = (_read_regular(target / MANIFEST_FILE) or "").split("\n")
    except OSError:
        return False
    return _CREATED_LINE in lines


def _read_refused(target: Path) -> set[str]:
    try:
        lines = (_read_regular(target / MANIFEST_FILE) or "").split("\n")
    except OSError:
        return set()
    names = {line[len(_REFUSED_PREFIX):].strip() for line in lines if line.startswith(_REFUSED_PREFIX)}
    return {name for name in names if _plain_entry_name(name)}


def _write_manifest(
    target: Path, planted: set[str], *, created: bool = False, refused: set[str] = frozenset()
) -> None:
    manifest = target / MANIFEST_FILE
    if not _regular_or_absent(manifest):
        raise OSError(f"{manifest} is not a regular file")
    if _manifest_unreadable(target):
        raise OSError(f"{manifest} cannot be read")
    if not planted and not refused:
        manifest.unlink(missing_ok=True)
        return
    body = "# links planted by Navide; edit or delete freely, Navide only touches these\n"
    if created:
        body += f"{_CREATED_LINE}\n"
    body += "".join(f"{_REFUSED_PREFIX}{name}\n" for name in sorted(refused))
    body += "".join(f"{name}\n" for name in sorted(planted))
    _replace_regular(manifest, body)


def wire_command(
    agent_key: str,
    command: Any,
    _port: int | None,
    pane_id: str = "",
    env: dict[str, str] | None = None,
    cwd: str = "",
) -> Any:
    """Point one pane spawn at the managed skills library.

    No-op for a CLI with no skills wiring, an empty command, a spawn already
    carrying our view, or a library with nothing targeted at this agent. A
    failure leaves the spawn as it was and is kept for the pane to print
    (``take_spawn_warnings``).
    """
    errors: list[str] = []
    try:
        return _wire_command(agent_key, command, pane_id, env, cwd, errors)
    finally:
        _record_spawn_warnings(pane_id, errors)


def _wire_command(
    agent_key: str,
    command: Any,
    pane_id: str,
    env: dict[str, str] | None,
    cwd: str,
    errors: list[str],
) -> Any:
    wiring = skills_wiring(agent_key)
    if wiring is None:
        return command
    text = _command_text(command)
    if not text.strip():
        return command
    if wiring.root_env:
        if env is not None:
            root = prepare_root(agent_key, wiring, pane_id, env, errors=errors)
            if root is not None:
                env[wiring.root_env] = root
        return command
    if wiring.project_rel:
        from agent_team_backend.convenience_wiring import sync_project_dir_gated

        sync_project_dir_gated(agent_key, wiring, cwd, errors=errors)
        return command
    try:
        view = prepare_view(agent_key, wiring, errors=errors)
    except Exception as err:  # noqa: BLE001 - optional wiring must never block spawn
        log.warning("Managed-skills wiring for %s failed: %s", agent_key, err)
        errors.append(str(err))
        return command
    if view is None:
        return command
    if wiring.config_env:
        if env is not None:
            try:
                env[wiring.config_env] = config_document(
                    wiring, env.get(wiring.config_env, ""), view
                )
            except ValueError as err:
                # The user's own document: kept as it is, at the cost of skills.
                log.warning("%s for %s is unusable, left unchanged: %s", wiring.config_env, agent_key, err)
                errors.append(f"{wiring.config_env} is not a valid JSON object ({err}); left unchanged")
        return command
    if not wiring.flag or str(view) in text:
        return command
    suffix = " ".join(
        f"{wiring.flag} {osplat.paths.quote_arg(value)}" for value in flag_values(wiring, view, cwd)
    )
    return _append_to_command(command, suffix) if suffix else command


def _managed_root(store: SkillsStore | None) -> Path:
    return (store or SkillsStore()).runtime_root


def _managed_sources(
    agent_key: str,
    store: SkillsStore | None,
    native_root: Path | None,
) -> list[Path]:
    """Every skill this agent should receive through delivery.

    Two sources feed a pane, and each has a case where delivering would only
    double what the agent already reads on its own:

    - **shared** (``~/.agents/skills``): skipped entirely for a CLI that
      discovers the shared root itself (``reads_shared_root``) — it sees them
      without us, and a second copy in the view would shadow the original.
    - **native** (another CLI's own directory): skipped for the CLI that owns
      that directory, delivered to everyone else. This is how a copilot skill
      reaches claude without anyone moving a file.

    A native skill whose name collides with a shared one is dropped from the
    view for *this* agent (native > shared, the same rule the store applies),
    unless both names resolve to the very same directory — that is one skill
    seen twice, not a collision.
    """
    store = store or SkillsStore()
    native_root = native_root or (Path.home() / ".claude" / "skills")
    wiring = skills_wiring(agent_key)
    sources: list[Path] = []
    seen_real: set[Path] = set()

    if not (wiring is not None and wiring.reads_shared_root):
        managed_root = store.rebuild_runtime_projection()
        # A same-named native skill wins for the CLI whose root it lives in;
        # ``native_root`` is that root for the delivery target.
        native_names = _directory_names(native_root)
        for name in store.targets_for(agent_key):
            candidate = managed_root / name
            if not (candidate.is_dir() or candidate.is_symlink()):
                continue
            if name in native_names:
                try:
                    if (native_root / name).resolve() != candidate.resolve():
                        continue
                except OSError:
                    continue
            sources.append(candidate)
            seen_real.add(_resolve(candidate))

    for skill in _native_targets(store, agent_key):
        real = Path(skill.real_path)
        if real in seen_real:
            continue
        seen_real.add(real)
        sources.append(real)
    return sources


def _native_targets(store: SkillsStore, agent_key: str) -> list[Any]:
    """Native skills to deliver to ``agent_key``: enabled, targeted, not its own."""
    try:
        native = store.native_skills()
    except Exception as err:  # noqa: BLE001 - reflection is optional
        log.warning("native skills scan failed: %s", err)
        return []
    wanted = set(store.native_targets_for(agent_key))
    return [
        skill
        for skill in native
        if skill.valid
        and skill.owner_agent != agent_key
        and skill.real_path in wanted
    ]


def _materialise(
    root: Path,
    real_root: Path,
    skills_rel: tuple[str, ...],
    sources: list[Path],
    suppressed: list[Path] | None = None,
    *,
    adopt: bool = True,
    mirror_home: bool = True,
    own: frozenset[str] = frozenset(),
) -> None:
    """Rebuild the skills directory; optionally mirror its ancestor directories.

    When mirroring, every ancestor's other entries link back to the user's
    root. A vendor-owned isolated root leaves those entries to its owner.
    ``own`` are entries of the root someone else rebuilds: neither linked
    nor adopted here.

    ``suppressed`` are roots the CLI scans only while the variable is unset —
    relocating it would silently cost the user those skills, so their contents
    are linked into the leaf as well. Verified on copilot: with COPILOT_HOME
    set, ``~/.agents/skills`` stops being scanned.
    """
    root.mkdir(parents=True, exist_ok=True)
    src, dst = real_root, root
    for name in skills_rel:
        # adopt on the way down only: a real entry the CLI created in the shim
        # (a fresh login, a new session dir) belongs in the user's tree, not
        # trapped in one pane. The leaf below is ours and is never adopted —
        # that would copy managed links into the user's own skills directory.
        if mirror_home:
            _mirror_into(dst, src, skip={name, *own}, adopt=adopt)
        src, dst = src / name, dst / name
        # Only the leaf may be ours, and every level above it must be a real
        # directory of our own. A link here — left by an MCP shim that mirrored
        # the whole home — would make every write below reach through into the
        # user's real tree, planting managed links in their own skills folder.
        if dst.is_symlink():
            dst.unlink()
        dst.mkdir(parents=True, exist_ok=True)
    # The user's own skills in that directory keep working, and keep winning:
    # they are linked first and a managed name never replaces one.
    _mirror_into(dst, src, skip=set())
    for extra in suppressed or []:
        _mirror_into(dst, extra, skip=set())
    for source in sources:
        link = dst / source.name
        if link.exists() or link.is_symlink():
            continue
        link.symlink_to(source, target_is_directory=True)


def _mirror_into(dst: Path, src: Path, *, skip: set[str], adopt: bool = False) -> None:
    """Link every entry of ``src`` into ``dst``, minus ``skip``.

    Re-run on every spawn: links whose target is gone are dropped first, so a
    dangling one can never shadow a name the CLI wants to create, and — where
    ``adopt`` is set — real entries the CLI made in the shim are moved back
    into ``src`` so they are shared with every other pane instead of living
    and dying in this one.
    """
    dst.mkdir(parents=True, exist_ok=True)
    for entry in dst.iterdir():
        if entry.is_symlink() and not entry.exists():
            entry.unlink(missing_ok=True)
            continue
        # A name on the way to our leaf is a directory we built, not something
        # the CLI left behind — adopting it would try to push our own view into
        # the user's tree on every spawn.
        if adopt and not entry.is_symlink() and entry.name not in skip:
            _adopt(entry, src / entry.name)
    if not src.is_dir():
        return
    for entry in src.iterdir():
        if entry.name in skip:
            continue
        link = dst / entry.name
        if link.exists() or link.is_symlink():
            continue
        link.symlink_to(entry, target_is_directory=entry.is_dir())


def _adopt(entry: Path, target: Path) -> None:
    """Move a real entry out of the shim and into the user's tree.

    A name that exists on both sides is a genuine conflict: the shim copy is
    left where it is rather than overwriting the user's, and reported.
    """
    if target.exists() or target.is_symlink():
        log.warning("%s exists in both the shim and the real tree; keeping the shim copy", target)
        return
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        os.replace(entry, target)
    except OSError as err:
        log.warning("could not adopt %s into %s: %s", entry, target, err)
        return
    from agent_team_backend.convenience_wiring import changed

    changed("pane-shims", target, detail=f"moved from the pane home {entry}", once=True)


def _resolve(path: Path) -> Path:
    try:
        return path.resolve()
    except OSError:
        return path


def _exclude_from_git(target: Path, *, directory: bool = True) -> None:
    """Keep our links out of the user's git status, best effort.

    The walk stops at the home directory: a home that is itself a dotfiles
    repo does not own the workspaces under it. The real home, not ``$HOME``:
    a backend launched from a shimmed pane inherits the shim's.
    """
    found = _exclude_file(target)
    if found is None:
        return
    exclude, rel = found
    line = f"/{rel}/" if directory else f"/{rel}"
    try:
        # Never through a link: the exclude file or its folders may lead
        # outside the repository.
        if not _exclude_path_safe(exclude):
            raise OSError(f"{exclude} is behind a link")
        existing = _read_regular(exclude) or ""
        lines = existing.splitlines()
        if line in lines or (not directory and f"/{PurePosixPath(rel).parent}/" in lines):
            return
        exclude.parent.mkdir(parents=True, exist_ok=True)
        prefix = "" if not existing or existing.endswith("\n") else "\n"
        fd = os.open(exclude, os.O_WRONLY | os.O_APPEND | os.O_CREAT | _NOFOLLOW, 0o644)
        with os.fdopen(fd, "a", encoding="utf-8") as handle:
            if not _sole_regular(os.fstat(handle.fileno())):
                raise OSError(f"{exclude} is not a regular file")
            handle.write(f"{prefix}{line}\n")
    except OSError as err:
        log.warning("could not add %s to git exclude: %s", target, err)


def _exclude_path_safe(exclude: Path) -> bool:
    """Whether ``.git/info/exclude`` is reached without a link: neither
    ``.git`` nor ``info`` is one, and the file is absent or a regular file
    with no second name."""
    try:
        for folder in (exclude.parent.parent, exclude.parent):
            if folder.is_symlink():
                return False
    except OSError:
        return False
    return _regular_or_absent(exclude)


def exclude_safe(target: Path) -> bool:
    """Whether the git exclude for ``target`` may be written: True when
    ``target`` is in no repository at all."""
    found = _exclude_file(target)
    return found is None or _exclude_path_safe(found[0])


def _exclude_file(target: Path) -> tuple[Path, str] | None:
    """(the repo's ``.git/info/exclude``, ``target`` relative to the repo)."""
    root = target
    home = real_home().resolve()
    for candidate in [target, *target.parents]:
        if candidate.resolve() == home:
            return None
        if (candidate / ".git").is_dir():
            root = candidate
            break
    else:
        return None
    try:
        rel = target.relative_to(root).as_posix()
    except ValueError:
        return None
    return root / ".git" / "info" / "exclude", rel


def _excluded_from_git(target: Path) -> bool:
    """Whether the whole directory carries the exclude line Navide adds only
    for a directory it created — the marker before manifests recorded it."""
    found = _exclude_file(target)
    if found is None:
        return False
    exclude, rel = found
    if not _exclude_path_safe(exclude):
        return False
    try:
        return f"/{rel}/" in (_read_regular(exclude) or "").splitlines()
    except OSError:
        return False


def _unexclude_from_git(target: Path, names: set[str], *, directory: bool) -> None:
    """Drop the exclude lines ``_exclude_from_git`` added for ``target``."""
    found = _exclude_file(target)
    if found is None:
        return
    exclude, rel = found
    ours = {f"/{rel}/{name}" for name in names}
    if directory:
        ours.add(f"/{rel}/")
    try:
        if not _exclude_path_safe(exclude):
            return
        text = _read_regular(exclude)
    except OSError:
        return
    if text is None:
        return
    lines = text.splitlines(keepends=True)
    kept = [line for line in lines if line.strip() not in ours]
    if kept != lines:
        try:
            _replace_regular(exclude, "".join(kept))
        except OSError as err:
            log.warning("could not update %s: %s", exclude, err)


def _replace_view(view_root: Path, sources: list[Path], layout: tuple[str, ...]) -> None:
    parent = view_root.parent
    parent.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix=f".{view_root.name}-", dir=parent))
    backup = parent / f".{view_root.name}.old"
    try:
        leaf = tmp.joinpath(*layout) if layout else tmp
        leaf.mkdir(parents=True, exist_ok=True)
        for source in sources:
            (leaf / source.name).symlink_to(source, target_is_directory=True)
        if backup.exists() or backup.is_symlink():
            _remove_generated_path(backup)
        if view_root.exists() or view_root.is_symlink():
            os.replace(view_root, backup)
        os.replace(tmp, view_root)
        if backup.exists() or backup.is_symlink():
            _remove_generated_path(backup)
    except Exception:
        _remove_generated_path(tmp)
        if not view_root.exists() and backup.exists():
            os.replace(backup, view_root)
        raise


def _directory_names(root: Path) -> set[str]:
    if not root.is_dir():
        return set()
    return {
        entry.name
        for entry in root.iterdir()
        if entry.is_dir() or entry.is_file() or entry.is_symlink()
    }


def _command_text(command: Any) -> str:
    if isinstance(command, list):
        return str(command[-1]) if command else ""
    return str(command or "")


def _append_to_command(command: Any, suffix: str) -> Any:
    if isinstance(command, list):
        updated = list(command)
        updated[-1] = f"{updated[-1]} {suffix}"
        return updated
    return f"{command} {suffix}"


def _remove_generated_path(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink(missing_ok=True)
    elif path.exists():
        shutil.rmtree(path)

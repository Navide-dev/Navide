"""Per-pane shim homes for the CLIs whose only MCP surface is a home-dir file.

kimi, grok and antigravity have no MCP flag and no variable that carries a
config document, so wiring them means giving each pane its own copy of the
directory holding one. Done naively that logs the user out — their credentials
live in the same tree. So a shim mirrors the real directory by symlink and
materialises *only* the MCP config as a real file: credentials, sessions and
history stay links to the user's own, and writes go straight through to them.

Two shapes, picked by what the CLI offers:

- kimi has a dedicated config-dir variable (``KIMI_CODE_HOME``), so its shim is
  just that directory and ``$HOME`` is left alone.
- grok and antigravity have none (their config root is hardcoded to
  ``Path.home()``), so theirs is a whole HOME shim: the top level of ``$HOME``
  mirrored by symlink with the vendor directory rebuilt inside it. This is the
  shape credential_vault already uses for grok login panes.

grok is the awkward one: its MCP servers and its own settings live in the
*same* file (``~/.grok/config.toml``), so that file alone cannot be a symlink
and is copied instead. Which copy a spawn builds on is decided by mtime (see
_base_config): a pane that rotated its own key keeps it, and an account switch
reaches the pane on its next spawn but never one already running. Its OAuth
credential is a separate file and stays linked, so this affects the BYO key and
preferences only.

Every failure here is non-fatal: prepare() returns None and the pane spawns
unwired rather than not at all.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import tempfile
import tomllib
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import tomli_w

from agent_team_backend.cli_vendors import registry
from agent_team_backend.cli_vendors.base import McpWiring, mcp_document
from agent_team_backend import osplat
from agent_team_backend.osplat import secret_files

log = logging.getLogger("agent_team_backend.mcp_server.pane_home")

PANES_DIR_NAME = ".navide-panes"

# Our in-progress writes. Distinct enough to recognise as ours on the next
# spawn, since a crash between mkstemp and os.replace leaves one behind.
TMP_PREFIX = ".navide-tmp-"

# Pane ids are UUIDs from the frontend, but they reach us as untrusted payload
# and become a path segment. Separators are excluded by the character class;
# the lookahead additionally rejects "." and ".." on their own, which would
# otherwise pass it and resolve the shim onto a directory we do not own.
_SAFE_PANE_ID = re.compile(r"^(?!\.+$)[A-Za-z0-9_.:-]+$")


@dataclass(frozen=True)
class ShimSpec:
    """How one vendor's shim is assembled.

    Everything about the CLI itself — which directory, which variable (if
    any), which config file inside it, which config vocabulary — comes from
    the vendor registry. Only the fields below exist because of this mirror,
    which is why they are not vendor knowledge and do not live there.
    """

    mcp: McpWiring
    # Entries inside the vendor dir linked from the first spawn, by creating
    # the real one empty when the CLI has not made it yet. _adopt() would move
    # them back on the *next* spawn anyway, but that leaves the first pane's
    # whole run pane-local — invisible to the log readers, which look under
    # the real home. Only empty-safe names belong here: a directory, or a
    # sqlite file (empty is a valid empty database, which is why
    # credential_vault's grok shim seeds the same three). Never a credential
    # file the CLI parses — an empty one there reads as corrupt, not absent.
    seeded_dirs: tuple[str, ...] = ()
    seeded_files: tuple[str, ...] = ()
    # Names that are rebuildable scratch, discarded from the shim on conflict
    # instead of being kept. Keeping a pane-local sqlite -wal beside a linked
    # (shared) database is worse than having none: SQLite replays a valid WAL
    # header, so stale frames would be written into the user's real database.
    volatile: tuple[str, ...] = ()

    @property
    def vendor_dir(self) -> str:
        return self.mcp.config_dir

    @property
    def config_relpath(self) -> tuple[str, ...]:
        """Relative to the vendor directory; every level of it is rebuilt as a
        real directory so that only the leaf is ours."""
        return self.mcp.config_file

    @property
    def shims_home(self) -> bool:
        """A CLI with no config-dir variable can only be relocated by $HOME."""
        return not self.mcp.config_dir_env

    @property
    def env_var(self) -> str:
        """The variable the CLI reads for the directory: its own, or the
        platform's spelling of the home (``USERPROFILE`` on Windows — agy
        resolves its config root from it and ignores ``HOME``)."""
        return self.mcp.config_dir_env or osplat.paths.home_env_var()

    def spawn_env(self, root: str) -> dict[str, str]:
        """Every variable handing ``root`` to the CLI. A relocated home is
        spelled both ways: the platform's own for CLIs that resolve the home
        natively, and ``HOME`` for the Node CLIs that consult it first (one key
        on POSIX, where the two coincide)."""
        env = {self.env_var: root}
        if self.shims_home:
            env["HOME"] = root
        return env


# Only the mirror's own knobs. The vendors are whichever ones the registry says
# reach their MCP config through a file in their config directory.
_MIRROR_EXTRAS: dict[str, dict[str, tuple[str, ...]]] = {
    "kimi": {"seeded_dirs": ("sessions", "credentials", "oauth")},
    "antigravity": {"seeded_dirs": ("antigravity-cli",)},
    # The sqlite sidecars are seeded for the same reason credential_vault's
    # grok shim lists them explicitly: they are absent after a clean shutdown,
    # so "link it only if it already exists" would leave them pane-local.
    "grok": {
        "seeded_dirs": ("sessions",),
        "seeded_files": ("grok.db", "grok.db-wal", "grok.db-shm"),
        "volatile": ("grok.db-wal", "grok.db-shm"),
    },
}

SHIM_SPECS: dict[str, ShimSpec] = {
    key: ShimSpec(spec.mcp_wiring, **_MIRROR_EXTRAS.get(key, {}))
    for key, spec in registry.VENDORS.items()
    if spec.mcp_wiring is not None and spec.mcp_wiring.config_file
}


def real_home() -> Path:
    """The user's home — the single seam tests redirect to a tmp_path.

    Read from the password database rather than ``Path.home()``, which prefers
    ``$HOME``. Launching Navide from a terminal inside a shimmed pane makes the
    backend inherit that pane's ``$HOME``, and building a shim under it would
    mirror links to links; the passwd entry is immune to that for every kind of
    shim, not just this module's.
    """
    try:
        import pwd

        return Path(pwd.getpwuid(os.getuid()).pw_dir)
    except (ImportError, AttributeError, KeyError, OSError):
        return Path.home()


def panes_root() -> Path:
    """Parent of every shim home: ``~/.navide-panes/<agent>/<pane>``."""
    return real_home() / PANES_DIR_NAME


def unavailable_reason(agent_key: str) -> str | None:
    """Why no shim can be built for ``agent_key`` on this machine, or None.

    A shim is a tree of links. Without the privilege (Windows before Developer
    Mode) every entry would fail one by one, so the answer is known before any
    filesystem work — and the caller can tell the pane, whose only other trace
    of the degradation is a backend log line.
    """
    if agent_key not in SHIM_SPECS:
        return None
    if not osplat.paths.symlinks_available():
        return (
            "symbolic links are not available to this process, so the per-pane "
            f"{agent_key} home cannot be built; enable Windows Developer Mode "
            "(Settings > For developers) or run Navide elevated"
        )
    return None


def shim_root(agent_key: str, pane_id: str) -> Path | None:
    """Where ``pane_id``'s shim for ``agent_key`` lives, if both are usable."""
    if agent_key not in SHIM_SPECS or not _SAFE_PANE_ID.match(pane_id or ""):
        return None
    return panes_root() / agent_key / pane_id


def _remove(entry: Path) -> None:
    try:
        if entry.is_dir() and not entry.is_symlink():
            shutil.rmtree(entry)
        else:
            entry.unlink(missing_ok=True)
    except OSError as err:
        log.warning("could not remove %s: %s", entry, err)


def _adopt(entry: Path, target: Path) -> bool:
    """Move a real entry the CLI created in the shim out to the real tree.

    A name the real directory did not have when the shim was built is created
    *inside* it — a session dir, a fresh oauth token. Left alone it would stay
    pane-local forever, because the link pass below skips any name already
    present. Moving it out and letting it be re-linked is what keeps a pane's
    sessions visible to the log readers and its login shared with every other
    pane. A name that exists on both sides is a genuine conflict: it is left in
    the shim rather than overwriting the user's, and reported.
    """
    if target.exists() or target.is_symlink():
        log.warning(
            "%s exists in both the shim and the real tree; leaving the shim copy",
            target,
        )
        return False
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        os.replace(entry, target)
    except OSError as err:
        log.warning("could not adopt %s into %s: %s", entry, target, err)
        return False
    from ..convenience_wiring import changed

    changed("pane-shims", target, detail=f"moved from the pane home {entry}", once=True)
    return True


def _mirror(
    dst: Path,
    src: Path,
    skip: set[str],
    *,
    adopt: bool = False,
    volatile: tuple[str, ...] = (),
) -> None:
    """Symlink every entry of ``src`` into ``dst``, minus ``skip``.

    Re-run on every spawn, in two passes. First the shim is reconciled: links
    whose target has since been deleted are dropped (a dangling link would
    shadow a name the CLI wants to create), and — where ``adopt`` is set —
    real entries the CLI made are moved back into ``src``. Then everything in
    ``src`` is linked, which picks up both those adoptions and anything the
    user added since.

    ``adopt`` is off by default and deliberately off for the ``$HOME`` level:
    a shimmed home is the pane's whole home, so anything a tool inside it
    writes to ``~`` lands there — a cloned repo, a shell rc file the user does
    not have. Promoting those into the real home is not this module's business
    and would be a way for pane content to reach the user's login shell. Only
    the vendor directory, whose contents are the sessions and credentials the
    shim exists to share, is adopted.
    """
    dst.mkdir(parents=True, exist_ok=True)
    try:
        existing = list(dst.iterdir())
    except OSError as err:
        log.warning("cannot read shim dir %s: %s", dst, err)
        existing = []
    for entry in existing:
        if entry.name in skip:
            continue  # ours to own (the MCP config), never adopted away
        if entry.is_symlink():
            if not entry.exists():
                entry.unlink(missing_ok=True)
            continue
        if entry.name.startswith(TMP_PREFIX):
            # Our own crashed write. Distinctly named so it is cleaned up here
            # rather than adopted into the real tree — for grok that would
            # strand a copy of the API key there.
            _remove(entry)
            continue
        if not adopt:
            continue
        target = src / entry.name
        if entry.name in volatile and (target.exists() or target.is_symlink()):
            _remove(entry)  # rebuildable scratch: the shared one wins outright
            continue
        _adopt(entry, target)
    try:
        sources = list(src.iterdir())
    except OSError:
        return  # real dir absent (fresh install) — an empty shim is still valid
    for item in sources:
        if item.name in skip:
            continue
        link = dst / item.name
        if link.exists() or link.is_symlink():
            continue
        try:
            link.symlink_to(item, target_is_directory=item.is_dir())
        except OSError as err:
            log.warning("shim symlink %s -> %s failed: %s", link, item, err)


def _is_toml(path: Path) -> bool:
    """Which codec this config file speaks. The vendor names the file, so the
    suffix is the whole decision: grok's is config.toml, kimi's and
    antigravity's are JSON."""
    return path.suffix == ".toml"


def _read_config_object(path: Path) -> dict[str, Any]:
    """The user's config as a dict; empty for absent, unreadable or non-object.

    Unparseable input is treated as empty rather than propagated: the result
    is written to the shim copy, never back over the user's file, so the worst
    case is a pane that starts with only our server configured.
    """
    try:
        raw = path.read_text(encoding="utf-8").strip()
    except OSError:
        return {}
    if not raw:
        return {}
    if _is_toml(path):
        try:
            return tomllib.loads(raw)
        except tomllib.TOMLDecodeError:
            log.warning("%s is not valid TOML — shim starts from an empty config", path)
            return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        log.warning("%s is not valid JSON — shim starts from an empty config", path)
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _seed_link_targets(spec: ShimSpec, real_vendor: Path, shim_vendor: Path) -> None:
    """Create the empty real targets the seeded names need to be linkable."""
    if not real_vendor.is_dir():
        # The CLI has never run. Creating its config directory here would put
        # Navide's fingerprints in the home of a tool the user does not have,
        # and there is nothing to share on a first spawn anyway — _adopt()
        # picks the entries up once the directory genuinely exists.
        return
    from ..convenience_wiring import changed

    for name in spec.seeded_dirs:
        target = real_vendor / name
        if target.exists() or target.is_symlink():
            continue
        existing = shim_vendor / name
        if existing.is_dir() and not existing.is_symlink():
            # The next mirror pass adopts this directory. An empty seed here
            # would turn the older pane's only session tree into a conflict.
            continue
        try:
            target.mkdir(parents=True, exist_ok=True)
        except OSError as err:
            log.warning("could not seed %s: %s", target, err)
            continue
        changed("pane-shims", target, detail="created empty so panes can share it", once=True)
    for name in spec.seeded_files:
        target = real_vendor / name
        if target.exists() or target.is_symlink():
            continue
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.touch()
        except OSError as err:
            log.warning("could not seed %s: %s", target, err)
            continue
        changed("pane-shims", target, detail="created empty so panes can share it", once=True)


def _base_config(real: Path, shim: Path) -> dict[str, Any]:
    """The document our entry is merged into: the newer of the two copies.

    grok keeps its own settings in the same file as its MCP servers, so an
    edit made inside a pane lives only in the shim copy — always
    rebuilding from the real file would throw it away on the next spawn, and
    the user would be asked to log in again. When the real file is the newer
    one (the user switched accounts or edited it) that one wins instead.
    """
    try:
        shim_mtime = shim.stat().st_mtime
    except OSError:
        return _read_config_object(real)
    try:
        real_mtime = real.stat().st_mtime
    except OSError:
        return _read_config_object(shim)
    # Strictly newer, so a tie goes to the real file: coarse filesystem
    # timestamps (1s on HFS+ and exFAT) make ties real, and silently shadowing
    # an account switch is the worse of the two failures.
    return _read_config_object(shim if shim_mtime > real_mtime else real)


def _write_config(path: Path, document: dict[str, Any]) -> None:
    """Atomically write the shim's config, 0600 (grok's carries its settings).

    TOML is re-emitted rather than patched: the shim copy is ours to rebuild,
    so the user's data survives the round trip while comments and key order do
    not. Their own file is never written — only this copy (and, through the
    convenience gate, grok's trusted_folders.toml: see
    merge_grok_folder_trust).
    """
    content = tomli_w.dumps(document) if _is_toml(path) else json.dumps(document, indent=2) + "\n"
    try:
        if path.read_text(encoding="utf-8") == content:
            return
    except OSError:
        pass
    # mkstemp, not a fixed ".tmp" name: it creates the file 0600 with no
    # world-readable window for grok's key, and two panes preparing at the
    # same moment must not race over one temp path.
    handle, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=TMP_PREFIX)
    tmp = Path(tmp_name)
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            stream.write(content)
        os.replace(tmp, path)
    except OSError:
        tmp.unlink(missing_ok=True)
        raise


def prepare(
    agent_key: str,
    pane_id: str,
    url: str,
    server_name: str,
    server_label: str = "",
    legacy_names: Sequence[str] = (),
) -> tuple[str, str] | None:
    """Build (or refresh) the pane's shim and return ``(env_var, path)``.

    None when the vendor has no shim, the pane id is unusable as a path
    segment, or the filesystem work fails — the caller then spawns unwired.
    The server's name, display label and former names are the caller's: this
    module must not import the one that serves the endpoint. Blocking I/O:
    call off the event loop.
    """
    spec = SHIM_SPECS.get(agent_key)
    root = shim_root(agent_key, pane_id)
    if spec is None or root is None:
        return None
    reason = unavailable_reason(agent_key)
    if reason is not None:
        log.warning("%s pane %s spawns unwired: %s", agent_key, pane_id, reason)
        return None
    from ..convenience_wiring import note

    note(
        "pane-shims", panes_root(),
        detail="per-pane homes for MCP and skills; entries a pane creates are moved"
        " into the vendor's own folder, which may also get empty seed entries",
    )
    home = real_home()
    if PANES_DIR_NAME in home.parts:
        # The backend was launched from inside a shimmed pane and inherited its
        # HOME, so "the real home" is another pane's shim. Nesting one shim in
        # another would mirror links to links; refuse instead.
        log.warning("home %s is itself a shim — not preparing another", home)
        return None
    real_vendor = home / spec.vendor_dir
    if agent_key == "grok":
        # Before this shim's mirror pass, so the merged file is what it links.
        from ..convenience_wiring import merge_grok_folder_trust_gated

        merge_grok_folder_trust_gated(real_vendor)
    try:
        # Created before anything is written into them: a grok shim holds a
        # copy of the API key, so no part of the path may be world-readable,
        # even briefly.
        for directory in (panes_root(), root.parent, root):
            secret_files.make_private_dir(directory)
        if spec.shims_home:
            # PANES_DIR_NAME is skipped alongside the vendor dir: it lives in
            # the real home too, and mirroring it would point every shim at the
            # tree that contains it.
            _mirror(root, home, {spec.vendor_dir, PANES_DIR_NAME})
            vendor_root = root / spec.vendor_dir
        else:
            vendor_root = root
        _seed_link_targets(spec, real_vendor, vendor_root)
        # Rebuild each directory on the way to the config file, so only the
        # leaf is ours and every sibling stays a link to the user's.
        src, dst = real_vendor, vendor_root
        for name in spec.config_relpath:
            _mirror(dst, src, {name}, adopt=True, volatile=spec.volatile)
            src, dst = src / name, dst / name
        existing = _base_config(src, dst)
        document = mcp_document(
            spec.mcp.config,
            existing,
            name=server_name,
            label=server_label,
            url=url,
            drop=legacy_names,
        )
        _write_config(dst, document)
    except OSError as err:
        log.warning("could not prepare %s shim home for pane %s: %s", agent_key, pane_id, err)
        return None
    return spec.env_var, str(root)


# ---- grok folder trust (convenience feature grok.folder-trust) ----

#: Where Grok Build records the folders the user trusted (its docs,
#: 18-sandbox.md). A pane that answers the trust prompt writes it inside its
#: own shim, where no other pane — and no later pane for the same folder —
#: can see it, so every new grok pane asked again (issue #402).
GROK_TRUST_FILE = "trusted_folders.toml"
#: The rows Navide merged into the user's file, so the switch can take back
#: exactly those. Lives beside the grok shims, in Navide's own tree.
GROK_TRUST_LEDGER = ".folder-trust-merged.json"


def _grok_trust_ledger() -> Path:
    return panes_root() / "grok" / GROK_TRUST_LEDGER


def grok_trust_ledger_rows() -> dict[str, Any]:
    """The rows Navide merged and has not taken back, keyed by folder."""
    try:
        rows = json.loads(_grok_trust_ledger().read_text(encoding="utf-8")).get("rows")
    except (OSError, ValueError, AttributeError):
        return {}
    return rows if isinstance(rows, dict) else {}


def _grok_trust_folders(path: Path) -> dict[str, Any] | None:
    """A trust file's ``folders`` table; ``{}`` when it does not exist, None
    when it cannot be read or parsed (never written over)."""
    if not path.exists():
        return {}
    try:
        folders = tomllib.loads(path.read_text(encoding="utf-8")).get("folders", {})
    except (OSError, ValueError):
        return None
    return folders if isinstance(folders, dict) else None


def grok_trust_rows_present(rows: dict[str, Any], real_vendor: Path) -> bool:
    """Whether every row Navide merged is still in the user's file."""
    folders = _grok_trust_folders(real_vendor / GROK_TRUST_FILE)
    return bool(rows) and folders is not None and all(folders.get(k) == v for k, v in rows.items())


def merge_grok_folder_trust(real_vendor: Path) -> None:
    """Move the trust decisions grok panes recorded in their shims into the
    user's ``~/.grok/trusted_folders.toml``, and point those shims at it.

    Only folders the user's file does not mention are added: a decision made
    outside Navide always wins. A file that cannot be parsed is left alone, and
    so are the shim copies. Each added row goes into the ledger the switch's
    takeback reads.
    """
    if not real_vendor.is_dir():
        return
    real = real_vendor / GROK_TRUST_FILE
    stranded = [
        path for path in sorted((panes_root() / "grok").glob(f"*/.grok/{GROK_TRUST_FILE}"))
        if path.is_file() and not path.is_symlink()
    ]
    if not stranded:
        return
    created = not real.exists()
    folders = _grok_trust_folders(real)
    if folders is None:
        log.warning("%s cannot be parsed; leaving the panes' trust where it is", real)
        return
    document: dict[str, Any] = {} if created else tomllib.loads(real.read_text(encoding="utf-8"))
    added: dict[str, Any] = {}
    merged: list[Path] = []
    for path in stranded:
        rows = _grok_trust_folders(path)
        if rows is None:
            continue
        for key, row in rows.items():
            if key not in folders and isinstance(row, dict):
                folders[key] = row
                added[key] = row
        merged.append(path)
    if added:
        document["folders"] = folders
        _write_config(real, document)
        ledger = _grok_trust_ledger()
        try:
            state = json.loads(ledger.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            state = {"created": created, "rows": {}}
        state.setdefault("rows", {}).update(added)
        ledger.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
    if not real.exists():
        return
    for path in merged:
        try:
            path.unlink()
            path.symlink_to(real)
        except OSError as err:
            log.warning("could not point %s at %s: %s", path, real, err)


def take_back_grok_folder_trust(real_vendor: Path) -> None:
    """The switch's takeback: remove the rows Navide merged (unless the user
    changed them since), and the file itself when Navide created it and
    nothing else is left in it."""
    real = real_vendor / GROK_TRUST_FILE
    rows = grok_trust_ledger_rows()
    folders = _grok_trust_folders(real)
    if folders is None:
        raise OSError(f"{real} cannot be parsed")
    if rows and real.exists():
        document = tomllib.loads(real.read_text(encoding="utf-8"))
        for key, row in rows.items():
            if folders.get(key) == row:
                del folders[key]
        try:
            created = bool(json.loads(_grok_trust_ledger().read_text(encoding="utf-8")).get("created"))
        except (OSError, ValueError, AttributeError):
            created = False
        if folders:
            document["folders"] = folders
        else:
            document.pop("folders", None)
        if created and not document:
            real.unlink()
        else:
            _write_config(real, document)
    _grok_trust_ledger().unlink(missing_ok=True)

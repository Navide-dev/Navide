"""One-time migration of legacy isolated Claude profile homes.

Before the credential-vault design, a claude profile spawned with
``CLAUDE_CONFIG_DIR=~/.navide/cli-profiles/claude/<id>`` and accumulated a
full config home there (its own ``projects/`` session tree and a Keychain
item keyed to that path). With profiles now sharing the real home, those
sessions would fall out of view and the credentials would be stranded.

For every legacy home (detected by a ``projects/`` directory):

1. merge its session logs into the real ``~/.claude/projects`` tree
   (per encoded-cwd directory; a same-name collision keeps the larger file,
   and a real file it replaces is kept under ``replaced-projects/``),
2. harvest its credentials into the profile's vault slot (best effort), and
3. archive the home as ``<id>.migrated-<ns>`` — never delete.

Idempotent by construction: archiving removes the ``projects/`` marker, so a
restart finds nothing to do. Roots are injectable (store's profiles_root,
``real_home``) — tests must never touch the real home or Keychain.
"""

from __future__ import annotations

import logging
import shutil
import time
from pathlib import Path

from .credential_vault import CredentialVault
from .profiles_store import CliProfilesStore

log = logging.getLogger("agent_team_backend.profile_migration")


def _merge_projects(src_projects: Path, dst_projects: Path, replaced: Path) -> None:
    """``replaced`` receives each real file a larger legacy copy replaces."""
    for proj_dir in src_projects.iterdir():
        if not proj_dir.is_dir():
            continue
        dst_dir = dst_projects / proj_dir.name
        dst_dir.mkdir(parents=True, exist_ok=True)
        for src in proj_dir.iterdir():
            if not src.is_file() or src.suffix != ".jsonl":
                continue
            dst = dst_dir / src.name
            # Session file names are uuids, so a collision means the same
            # session was written in both homes — keep the larger record.
            if dst.exists() and dst.stat().st_size >= src.stat().st_size:
                continue
            if dst.exists():
                # The copies may have diverged: keep the one being replaced.
                kept = replaced / proj_dir.name / src.name
                kept.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(dst, kept)
            shutil.copy2(src, dst)


def _archive(home: Path) -> None:
    base = f"{home.name}.migrated-{time.time_ns()}"
    target = home.with_name(base)
    suffix = 1
    while target.exists():
        target = home.with_name(f"{base}-{suffix}")
        suffix += 1
    home.rename(target)


def migrate_legacy_claude_homes(
    store: CliProfilesStore,
    vault: CredentialVault,
    *,
    real_home: Path | None = None,
) -> int:
    """Migrate every legacy claude profile home. Never raises; returns the
    number of homes migrated."""
    real_home = real_home or Path.home()
    root = store.profiles_root / "claude"
    if not root.is_dir():
        return 0
    migrated = 0
    for home in sorted(root.iterdir()):
        # Archived homes carry a dotted suffix (.deleted-/.migrated-); live
        # profile ids never contain a dot.
        if not home.is_dir() or "." in home.name:
            continue
        if not (home / "projects").is_dir():
            continue  # already slot-only (or empty) — nothing legacy here
        try:
            _merge_projects(home / "projects", real_home / ".claude" / "projects", home / "replaced-projects")
            try:
                vault.harvest_legacy_claude_home(home.name, home)
            except Exception as err:  # noqa: BLE001 — slot stays empty, home is archived anyway
                log.warning("credential harvest for legacy home %s failed: %s", home, err)
            _archive(home)
            migrated += 1
            log.info("migrated legacy claude profile home %s", home)
        except Exception as err:  # noqa: BLE001 — one broken home must not block the rest
            log.warning("migration of legacy claude home %s failed: %s", home, err)
    return migrated

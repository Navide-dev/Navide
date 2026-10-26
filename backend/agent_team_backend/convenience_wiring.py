"""Where each convenience feature meets the code that writes it.

``convenience.ConvenienceGate`` knows nothing about CLIs; this module gives
each feature its target, its presence check and its removal, and routes the
existing writers through the gate. With no gate installed (tests that build
no app, tooling) every writer runs exactly as it did before the gate existed.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from pathlib import Path
from typing import Any, Callable

from .convenience import ConvenienceGate, Takeback, canonical_path

log = logging.getLogger("agent_team_backend.convenience_wiring")

_gate: ConvenienceGate | None = None
_loop: asyncio.AbstractEventLoop | None = None


def install(gate: ConvenienceGate | None) -> None:
    global _gate
    _gate = gate


def gate() -> ConvenienceGate | None:
    return _gate


def remember_loop(loop: asyncio.AbstractEventLoop) -> None:
    global _loop
    _loop = loop


def broadcast_change(change: dict[str, Any]) -> None:
    """The gate's ``notify``: tell every window, from whichever thread wrote."""
    loop = _loop
    if loop is None or loop.is_closed():
        return
    from . import app
    from .ipc import make_event

    event = make_event("convenience.changed", change)

    def send() -> None:
        loop.create_task(app.broadcast(event))

    try:
        running = asyncio.get_running_loop()
    except RuntimeError:
        running = None
    if running is loop:
        send()
    else:
        loop.call_soon_threadsafe(send)


def note(feature_id: str, target: str | Path, *, detail: str = "") -> None:
    """Disclose a target a required feature created (first time only)."""
    g = _gate
    if g is None:
        return
    try:
        g.note(feature_id, target, detail=detail)
    except Exception as err:  # noqa: BLE001 — disclosure never blocks a spawn
        log.warning("noting %s %s failed: %s", feature_id, target, err)


def changed(feature_id: str, target: str | Path, *, detail: str, once: bool = False) -> None:
    """Announce a change a required feature made to the user's own files;
    with ``once``, later changes to the same path are only logged."""
    g = _gate
    if g is None:
        return
    try:
        if once:
            g.changed_once(feature_id, target, detail=detail)
        else:
            g.record(feature_id, "repair", str(target), detail=detail)
    except Exception as err:  # noqa: BLE001
        log.warning("recording %s %s failed: %s", feature_id, target, err)


# ── CLI hooks (S1–S3) ──────────────────────────────────────────────────────

HOOK_FEATURES = {"claude": "claude.hooks", "qwen": "qwen.hooks", "copilot": "copilot.hooks"}

#: Vendors whose settings file holds one Navide hook per event, so one the
#: user deleted is told apart from the rest (their installers take ``skip``).
#: Copilot's hook file is Navide's alone: deleting it is the whole removal.
_PER_HOOK = frozenset({"claude", "qwen"})


#: Phase 3: vendors whose hooks ride on the panes Navide starts instead of
#: the shared settings file. ``prepare(port_file, skip)`` writes the pane-side
#: copy inside Navide's own data (``skip``: the hooks the user removed).
_PANE_CARRIERS: dict[str, Callable[[str, frozenset[str]], Any]] = {}

#: The carried vendors whose panes carry the hooks right now: their shared
#: entry is gone and the pane-side copy is ready.
_CARRYING: set[str] = set()


def register_pane_carrier(agent_key: str, prepare: Callable[[str, frozenset[str]], Any]) -> None:
    _PANE_CARRIERS[agent_key] = prepare


def pane_carries_hooks(agent_key: str) -> bool:
    """Whether a pane of ``agent_key`` starts with Navide's hooks injected."""
    return agent_key in _CARRYING


def pane_carrier_changed(agent_key: str, ready: bool) -> None:
    """What a carrier needs came or went while running (Copilot: the skills
    plugin that builds its pane shims). Ready re-runs the vendor's hook pass
    once the startup pass has registered the carrier, so the panes take the
    hooks over. Not ready only stops the panes carrying them: a plugin stops
    only at quit, and writing the shared file back then would be undone at
    the next start."""
    if not ready:
        _CARRYING.discard(agent_key)
        return
    if _gate is None or agent_key not in _PANE_CARRIERS:
        return
    installer = _installer(agent_key)
    if installer is not None:
        from .applog import backend_port_file

        install_hooks_gated(agent_key, installer, str(backend_port_file()))


def _hook_target(agent_key: str, port_file: str = "") -> tuple[Path, Callable[[], bool], Callable[[], Any]]:
    """(file, present, remove) for one vendor's hook installation. For a dev
    backend (``port_file`` in a ``-dev`` data dir) claude's are its own
    entries only: the installed app's share the file and are never its to
    take out."""
    if agent_key == "claude":
        from . import claude_hooks

        path = claude_hooks.settings_path()
        if "-dev" in port_file:
            return (
                path, lambda: claude_hooks.hooks_present(path, dev_only=True),
                lambda: claude_hooks.uninstall_hooks(dev_only=True),
            )
        return path, lambda: claude_hooks.hooks_present(path), claude_hooks.uninstall_hooks
    if agent_key == "qwen":
        from . import claude_hooks, qwen_hooks

        path = qwen_hooks.settings_path()
        return path, lambda: claude_hooks.hooks_present(path), qwen_hooks.uninstall_hooks
    if agent_key == "copilot":
        from . import copilot_hooks

        path = copilot_hooks.hooks_dir() / copilot_hooks._HOOK_FILENAME
        return path, path.is_file, copilot_hooks.uninstall_hooks
    raise KeyError(agent_key)


def install_hooks_gated(
    agent_key: str, install: Callable[[str], dict[str, Any]], port_file: str
) -> dict[str, Any]:
    """Run a vendor's hook installer through the gate.

    The result is the installer's own, plus ``convenience`` naming what the
    gate did. A vendor without a convenience feature runs ungated.
    """
    feature_id = HOOK_FEATURES.get(agent_key)
    g = _gate
    if g is None or feature_id is None:
        return install(port_file)
    path, present, _ = _hook_target(agent_key)
    if agent_key in _PANE_CARRIERS:
        carried = _carry_in_panes(agent_key, feature_id, path, port_file)
        if carried is not None:
            return {"convenience": carried}
    result: dict[str, Any] = {}
    parts = None
    if agent_key in _PER_HOOK:
        from . import claude_hooks

        parts = lambda: claude_hooks.hook_parts(path)  # noqa: E731

    def write() -> None:
        skip = g.excluded(feature_id, path) if parts is not None else frozenset()
        result.update((install(port_file, skip=skip) if parts is not None else install(port_file)) or {})

    # Only the CLI's whole config folder gone or created anew is a reset;
    # the settings or hook file deleted from it is the user's removal.
    outcome = g.apply(
        feature_id, path, write=write, present=present, file=path, parts=parts,
        reset_folder=path.parent if agent_key in _PER_HOOK else path.parent.parent,
    )
    return {**result, "convenience": outcome}


def _carry_in_panes(agent_key: str, feature_id: str, path: Path, port_file: str) -> str | None:
    """Phase 3 for a carried vendor: take Navide's entry back out of the
    shared file and let the panes carry the hooks. Returns the outcome, or
    None when the shared hooks must stay in use (Phase 2): the entry could
    not be taken back, or the pane-side copy could not be prepared. Never
    both at once — every hook would run twice."""
    g = _gate
    _CARRYING.discard(agent_key)
    if not g.allowed(feature_id):
        return "off"
    if not g.retract(feature_id, _hook_takeback(agent_key, port_file)):
        return None
    skip = g.excluded(feature_id, path) if agent_key in _PER_HOOK else frozenset()
    try:
        _PANE_CARRIERS[agent_key](port_file, skip)
    except Exception as err:  # noqa: BLE001 — the shared hooks take over again
        log.warning("preparing the %s pane hooks failed; using the shared file: %s", agent_key, err)
        return None
    _CARRYING.add(agent_key)
    return "pane"


def install_cli_hooks(port_file: str) -> dict[str, dict[str, Any]]:
    """The startup pass: every vendor's hook installer, through the gate, then
    the one-time upgrade notice. Failure per vendor is logged, never raised —
    the orchestrator falls back to log-tail + sentinel detection."""
    from .cli_vendors.registry import VENDORS as CLI_VENDORS

    results: dict[str, dict[str, Any]] = {}
    for key, spec in CLI_VENDORS.items():
        if spec.install_hooks is None:
            continue
        try:
            results[key] = install_hooks_gated(key, spec.install_hooks, port_file)
            log.info("%s hooks install: %s", key, results[key])
        except Exception as err:  # noqa: BLE001
            log.warning("%s hooks install failed: %s", key, err)
    try:
        carry_codex_hook_trust(port_file)
    except Exception as err:  # noqa: BLE001
        log.warning("moving codex hook trust into the panes failed: %s", err)
    if _gate is not None:
        try:
            _gate.finish_startup_scan()
        except Exception as err:  # noqa: BLE001
            log.warning("publishing the convenience upgrade notice failed: %s", err)
    return results


def remove_hooks(agent_key: str) -> Any:
    return _hook_target(agent_key)[2]()


def _hook_takeback(agent_key: str, port_file: str = "") -> list[Takeback]:
    path, present, remove = _hook_target(agent_key, port_file)
    if agent_key == "copilot":
        from . import copilot_hooks

        # Another backend's file (the installed app beside a dev one) is not
        # this backend's to take back: its panes would lose their hooks.
        mine = present
        present = lambda: mine() and not copilot_hooks.another_backends(path)  # noqa: E731
    return [Takeback(str(path), remove, present, path)]


# ── switches ───────────────────────────────────────────────────────────────


def set_feature(feature_id: str, allowed: bool, *, port_file: str, source: str = "") -> None:
    """The overview's switch: off takes Navide's entries back first; allowed
    re-applies a startup feature at once (a per-spawn one on its next spawn).
    ``source`` is who moved it, for the log (``ConvenienceGate.record``)."""
    g = _gate
    if g is None:
        raise RuntimeError("convenience gate not installed")
    agent_key = next((k for k, f in HOOK_FEATURES.items() if f == feature_id), None)
    takeback = TAKEBACKS.get(feature_id)
    if agent_key is not None:
        takeback = lambda: _hook_takeback(agent_key, port_file)  # noqa: E731
    refusing = _targets(feature_id) if allowed and feature_id == "cursor.project-skills" else []
    if not allowed and agent_key is not None:
        _CARRYING.discard(agent_key)
    if not allowed and feature_id == "codex.hook-trust":
        _CARRYING.discard("codex")
    g.set_allowed(feature_id, allowed, takeback=takeback, source=source)
    if refusing:
        _clear_refused_skills(refusing)
    if allowed and feature_id == "codex.hook-trust":
        carry_codex_hook_trust(port_file)
    if allowed and agent_key is not None:
        installer = _installer(agent_key)
        if installer is not None:
            install_hooks_gated(agent_key, installer, port_file)


def _installer(agent_key: str) -> Callable[[str], dict[str, Any]] | None:
    from .cli_vendors.registry import VENDORS as CLI_VENDORS

    spec = CLI_VENDORS.get(agent_key)
    return spec.install_hooks if spec is not None else None


def _targets(feature_id: str) -> list[str]:
    g = _gate
    if g is None:
        return []
    return [target["path"] for target in g.listing_feature(feature_id)["targets"]]


# ── Cursor: project MCP config (H1) ────────────────────────────────────────


def ensure_project_config_gated(agent_key: str, cwd: str | Path) -> bool:
    """``mcp_server.wiring.ensure_project_config`` as the feature
    cursor.project-mcp. False when the feature is off: the pane then runs
    without Navide's tools, which is what turning it off costs."""
    from .mcp_server import wiring

    g = _gate
    if g is not None and cwd:
        cwd = canonical_path(cwd)  # one key per workspace, however it is spelled
    path = wiring.project_config_path(agent_key, cwd)
    if g is None or path is None:
        return wiring.ensure_project_config(agent_key, cwd)
    if not wiring.project_config_inside(path, Path(cwd)):
        # Not the workspace's file: nothing is written, so nothing is gated,
        # but the pane goes without Navide's tools and the user is told.
        _refused_unsafe("cursor.project-mcp", path)
        return wiring.ensure_project_config(agent_key, cwd)
    wired = [False]

    def write() -> None:
        wired[0] = wiring.ensure_project_config(agent_key, cwd)

    # A removal is that workspace's alone; the .cursor folder gone (git
    # clean, a fresh clone, a re-created worktree) is its reset.
    outcome = g.apply(
        "cursor.project-mcp", path, write=write,
        present=lambda: _project_config_present(agent_key, path), file=path,
        reset_folder=path.parent, per_target=True,
    )
    return wired[0] and outcome not in ("off", "removed", "refused")


def _project_config_present(agent_key: str, path: Path) -> bool:
    """Whether the workspace's config still carries Navide's entry. An empty
    file (an editor or Cursor truncated it mid-write) cannot tell, so it is
    unknown — repaired, never read as the user's removal."""
    from .mcp_server import wiring

    if path.is_file() and not path.read_text(encoding="utf-8").strip():
        raise ValueError(f"{path} is empty")
    return wiring.project_config_has_entry(agent_key, path)


def _refused_unsafe(feature_id: str, target: Path) -> None:
    """A workspace whose .cursor leads outside it is left alone for safety;
    say so once for that workspace, while the feature is allowed."""
    g = _gate
    if g is None or not g.allowed(feature_id):
        return
    try:
        g.record_once(
            feature_id, "refused-unsafe", target,
            detail="leads outside the workspace through a link; not set up here",
        )
    except Exception as err:  # noqa: BLE001 — disclosure never blocks a spawn
        log.warning("recording %s %s failed: %s", feature_id, target, err)


def _remove_project_configs() -> None:
    from .mcp_server import wiring

    for target in _targets("cursor.project-mcp"):
        try:
            wiring.remove_project_config("cursor", Path(target))
        except OSError as err:
            log.warning("removing Navide's entry from %s failed: %s", target, err)


def _project_config_takeback() -> list[Takeback]:
    from .mcp_server import wiring

    return [
        Takeback(
            target,
            lambda path=Path(target): wiring.remove_project_config("cursor", path),
            lambda path=Path(target): wiring.project_config_has_entry("cursor", path),
            Path(target),
        )
        for target in _targets("cursor.project-mcp")
    ]


# ── Cursor: project skills (H2) ────────────────────────────────────────────


def sync_project_dir_gated(agent_key: str, wiring: Any, cwd: str, *, errors: list[str] | None = None) -> bool:
    """``skills_wiring.sync_project_dir`` as the feature cursor.project-skills.

    The manifest of planted links is the marker. A planted link the user
    deleted by hand is refused in that workspace only — logged and announced
    as a removal of that one name — and the feature stays allowed. The
    whole folder or its manifest deleted is refused for that workspace only
    as well; the .cursor folder gone is the workspace's reset. When a sync
    leaves nothing planted, Navide removed the manifest itself, so the target
    is forgotten rather than later read as a removal by the user.
    ``errors`` collects why a sync failed, for the pane to print.
    """
    from .plugins.builtin.navide_skills import skills_wiring

    g = _gate
    if g is None or not cwd:
        return skills_wiring.sync_project_dir(agent_key, wiring, cwd, errors=errors)
    cwd = str(canonical_path(cwd))  # one key per workspace, however it is spelled
    target = Path(cwd).joinpath(*wiring.project_rel)
    if not skills_wiring.project_target_safe(target, Path(cwd)):
        # Not the workspace's folder: nothing is written, so nothing is gated.
        _refused_unsafe("cursor.project-skills", target)
        return skills_wiring.sync_project_dir(agent_key, wiring, cwd, errors=errors)
    if not skills_wiring.manifest_safe(target):
        # The repository put a link (or a pipe) where the manifest goes: it
        # is never read, written or gated, so the folder is left alone too.
        _refused_unsafe("cursor.project-skills", target)
        return skills_wiring.sync_project_dir(agent_key, wiring, cwd, errors=errors)
    manifest = target / skills_wiring.MANIFEST_FILE
    delivered = [False]
    skipped: list[Path] = []
    # Before the gate reads the manifest, so recording the refusal is not
    # mistaken for a change Navide made.
    refused = skills_wiring.refuse_missing_links(target) if g.allowed("cursor.project-skills") else []

    def write() -> None:
        delivered[0] = skills_wiring.sync_project_dir(agent_key, wiring, cwd, skipped=skipped, errors=errors)

    outcome = g.apply(
        "cursor.project-skills", target, write=write,
        present=lambda: skills_wiring.project_dir_intact(target), file=manifest,
        reset_folder=Path(cwd) / wiring.project_rel[0], per_target=True,
    )
    for name in refused:
        g.record("cursor.project-skills", "removed-entry", str(target / name), detail="link deleted outside Navide")
    if outcome in ("off", "removed", "refused", "unknown"):
        return False
    for link in skipped:
        g.record_once(
            "cursor.project-skills", "refused-name", link,
            detail="a skill with the manifest's name; not linked here",
        )
    if delivered[0] and not skills_wiring.exclude_safe(target):
        # The links are planted, but the repository's .git (or its exclude)
        # is a link or a second name for another file: they stay visible to
        # git status rather than writing there.
        g.record_once(
            "cursor.project-skills", "refused-exclude", target,
            detail="the git exclude is behind a link; not written",
        )
    if not skills_wiring.has_manifest(target):
        g.forget("cursor.project-skills", target)
    return delivered[0]


def _remove_project_dirs() -> None:
    from .plugins.builtin.navide_skills import skills_wiring

    wiring = skills_wiring.skills_wiring("cursor")
    depth = len(wiring.project_rel) if wiring is not None and wiring.project_rel else 1
    for target in _targets("cursor.project-skills"):
        try:
            skills_wiring.remove_project_dir(Path(target), root=Path(target).parents[depth - 1])
        except OSError as err:
            log.warning("removing Navide's links from %s failed: %s", target, err)


def _clear_refused_skills(targets: list[str]) -> None:
    from .plugins.builtin.navide_skills import skills_wiring

    wiring = skills_wiring.skills_wiring("cursor")
    depth = len(wiring.project_rel) if wiring is not None and wiring.project_rel else 1
    for target in targets:
        try:
            skills_wiring.clear_refused(Path(target), root=Path(target).parents[depth - 1])
        except OSError as err:
            log.warning("clearing refused skills in %s failed: %s", target, err)


def _project_dir_takeback() -> list[Takeback]:
    from .plugins.builtin.navide_skills import skills_wiring

    wiring = skills_wiring.skills_wiring("cursor")
    depth = len(wiring.project_rel) if wiring is not None and wiring.project_rel else 1
    items = []
    for target in _targets("cursor.project-skills"):
        path = Path(target)
        # A manifest that is a link is not Navide's: never backed up (that
        # would copy where it leads) and never counted as left behind.
        items.append(Takeback(
            target, lambda path=path: skills_wiring.remove_project_dir(path, root=path.parents[depth - 1]),
            lambda path=path: skills_wiring.has_manifest(path),
            path / skills_wiring.MANIFEST_FILE if skills_wiring.has_manifest(path) else None,
        ))
    return items


# ── Codex: hook trust (S4) ─────────────────────────────────────────────────


def seed_hook_trust_gated(manager: Any, pane_home: Path) -> int:
    """``CodexHomeManager.seed_hook_trust`` as the feature codex.hook-trust.

    Announced the first time it touches config.toml; the row each new pane
    adds after that is logged quietly. Rows the user deleted for a live pane
    home turn the feature off."""
    g = _gate
    if g is None:
        return manager.seed_hook_trust(pane_home)
    config = manager.real_home / "config.toml"
    seeded = [0]

    def write() -> None:
        seeded[0] = manager.seed_hook_trust(pane_home)

    outcome = g.apply(
        "codex.hook-trust", config, write=write,
        present=lambda: manager.hook_trust_intact(exclude=pane_home), file=config,
        quiet_repairs=True, reset_folder=manager.real_home,
    )
    return 0 if outcome in ("off", "removed") else seeded[0]


def carry_codex_hook_trust(port_file: str) -> bool:
    """Phase 3: take the trust rows Navide seeded back out of the user's
    config.toml and let each pane carry its own inline (``-c hooks.state=``,
    `CodexHomeManager.hook_trust_override`). Runs at startup and on re-allow.
    False when the feature is off, or a row could not be taken back: spawns
    then keep seeding config.toml (Phase 2), never both.

    A dev backend (its port file says ``-dev``, as in claude_hooks) never
    takes rows back: ~/.codex-panes is shared with the installed Navide,
    whose live panes' rows would go too. It stays on Phase 2. The installed
    one does take back a dev backend's rows; that dev's next spawn re-seeds."""
    g = _gate
    _CARRYING.discard("codex")
    if g is None or not g.allowed("codex.hook-trust") or "-dev" in port_file:
        return False
    if not g.retract("codex.hook-trust", _codex_hook_trust_takeback()):
        return False
    _CARRYING.add("codex")
    return True


def _drop_codex_hook_trust() -> None:
    from . import app

    manager = getattr(app, "codex_home_manager", None)
    if manager is not None:
        manager.drop_all_hook_trust()


# ── Grok: folder trust (issue #402) ────────────────────────────────────────


def merge_grok_folder_trust_gated(real_vendor: Path) -> None:
    """``pane_home.merge_grok_folder_trust`` as the feature grok.folder-trust.

    Writes ``~/.grok/trusted_folders.toml``, the user's own file: backed up
    before every change, announced the first time, and taken back by the
    switch. Off, a pane's trust decision stays in that pane's home. Without a
    gate nothing is written. A failure never blocks the spawn."""
    from .mcp_server import pane_home

    real = real_vendor / pane_home.GROK_TRUST_FILE
    g = _gate
    if g is None:
        return
    try:
        g.apply(
            "grok.folder-trust", real,
            write=lambda: pane_home.merge_grok_folder_trust(real_vendor),
            present=lambda: pane_home.grok_trust_rows_present(pane_home.grok_trust_ledger_rows(), real_vendor),
            file=real, quiet_repairs=True, reset_folder=real_vendor,
            detail="merged the folders Grok panes were told to trust; only the workspace"
            " a pane was opened in, or a folder inside it, is shared to ~/.grok",
        )
    except Exception as err:  # noqa: BLE001 — the spawn goes ahead whatever happens here
        log.warning("could not merge grok folder trust into %s: %s", real, err)


def _grok_folder_trust_takeback() -> list[Takeback]:
    from .mcp_server import pane_home

    real_vendor = pane_home.real_home() / ".grok"
    rows = pane_home.grok_trust_ledger_rows()
    return [Takeback(
        str(real_vendor / pane_home.GROK_TRUST_FILE),
        lambda: pane_home.take_back_grok_folder_trust(real_vendor),
        lambda: pane_home.grok_trust_rows_present(rows, real_vendor),
        real_vendor / pane_home.GROK_TRUST_FILE,
    )]


# ── Account auto-repair (D7) ───────────────────────────────────────────────


def login_fingerprint(secret: str | None) -> str:
    """The account prompt's handle on one live login: a hash, never the
    secret ('' when nobody is signed in). Its "switch back" sends it back,
    so the switch applies to the login the user was told about."""
    if secret is None:
        return ""
    digest = hashlib.sha256(b"navide-account-prompt\0" + secret.encode("utf-8"))
    return digest.hexdigest()[:24]


def repair_live_login(
    agent_key: str,
    slot_id: str,
    restore: Callable[[], Any],
    *,
    reason: str,
    live_email: str | None = None,
    slot_email: str | None = None,
    slot_label: str = "",
    other_account: bool = False,
    live_fingerprint: str = "",
    requested: bool = False,
) -> bool:
    """Write the active account back into the CLI's live login, as the
    feature credentials.auto-repair. Returns whether it was written.
    ``requested``: the user asked for it (a sign-in through Navide), so it
    applies whatever the auto-repair switch says.

    D7: when the live login is a *different* signed-in account than the one
    Navide would restore, the user changed it outside Navide. That is never
    overridden: the user gets a prompt (keep it, or switch back) instead.
    ``other_account`` says so when no pair of emails can (an unidentified
    login whose secret is not the slot's own). ``live_fingerprint``
    (``login_fingerprint``) names that login in the prompt.
    """
    g = _gate
    if g is None:
        restore()
        return True
    if not requested and not g.allowed("credentials.auto-repair"):
        return False
    target = f"{agent_key} live login"
    if other_account or (
        live_email and slot_email and live_email.casefold() != slot_email.casefold()
    ):
        g.record(
            "credentials.auto-repair", "prompt", target,
            detail=json.dumps({
                "agentKey": agent_key, "slotId": slot_id, "slotLabel": slot_label,
                "liveEmail": live_email, "slotEmail": slot_email,
                "liveFingerprint": live_fingerprint,
            }),
        )
        return False
    log.info("restoring the %s live login from slot %s (%s)", agent_key, slot_id, reason)
    try:
        restore()
    except Exception as err:
        # The write may have landed before it failed (Keychain first, then
        # ~/.claude.json): a failure still leaves its row.
        g.record("credentials.auto-repair", "repair", target, detail=f"{reason}; failed: {err}")
        raise
    g.record("credentials.auto-repair", "repair", target, detail=reason)
    return True


def prompt_live_logout(agent_key: str) -> bool:
    """The live login went empty after Navide had it signed in: the user
    signed out outside Navide. Never signed back in; the user is told.
    Returns whether the user was told (False while the feature is off)."""
    g = _gate
    if g is None or not g.allowed("credentials.auto-repair"):
        return False
    g.record(
        "credentials.auto-repair", "prompt", f"{agent_key} live login",
        detail=json.dumps({"agentKey": agent_key, "reason": "logout"}),
    )
    return True


def _codex_hook_trust_takeback() -> list[Takeback]:
    from . import app

    manager = getattr(app, "codex_home_manager", None)
    if manager is None:
        return []
    config = manager.real_home / "config.toml"
    return [Takeback(str(config), manager.drop_all_hook_trust, manager.any_pane_hook_trust, config)]


#: Removal for the features that are not CLI hooks.
REMOVERS: dict[str, Callable[[], Any]] = {
    "cursor.project-mcp": _remove_project_configs,
    "cursor.project-skills": _remove_project_dirs,
    "codex.hook-trust": _drop_codex_hook_trust,
}

#: The same removals per target, as the off switch runs them: backed up,
#: checked afterwards and logged one by one.
TAKEBACKS: dict[str, Callable[[], list[Takeback]]] = {
    "cursor.project-mcp": _project_config_takeback,
    "cursor.project-skills": _project_dir_takeback,
    "codex.hook-trust": _codex_hook_trust_takeback,
    "grok.folder-trust": _grok_folder_trust_takeback,
}

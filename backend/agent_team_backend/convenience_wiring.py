"""Where each convenience feature meets the code that writes it.

``convenience.ConvenienceGate`` knows nothing about CLIs; this module gives
each feature its target, its presence check and its removal, and routes the
existing writers through the gate. With no gate installed (tests that build
no app, tooling) every writer runs exactly as it did before the gate existed.
"""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Any, Callable

from .convenience import ConvenienceGate, Takeback

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


def _hook_target(agent_key: str) -> tuple[Path, Callable[[], bool], Callable[[], Any]]:
    """(file, present, remove) for one vendor's hook installation."""
    if agent_key == "claude":
        from . import claude_hooks

        path = claude_hooks.settings_path()
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
    result: dict[str, Any] = {}
    parts = None
    if agent_key in _PER_HOOK:
        from . import claude_hooks

        parts = lambda: claude_hooks.hook_parts(path)  # noqa: E731

    def write() -> None:
        skip = g.excluded(feature_id, path) if parts is not None else frozenset()
        result.update((install(port_file, skip=skip) if parts is not None else install(port_file)) or {})

    # Claude's and Qwen's settings.json are the user's: that file gone is a
    # reset. Copilot's hook file is Navide's own, so deleting it stays the
    # user's removal; only its whole config folder gone is a reset.
    outcome = g.apply(
        feature_id, path, write=write, present=present, file=path, parts=parts,
        reset_when_missing=path if agent_key in _PER_HOOK else path.parent.parent,
    )
    return {**result, "convenience": outcome}


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
    if _gate is not None:
        try:
            _gate.finish_startup_scan()
        except Exception as err:  # noqa: BLE001
            log.warning("publishing the convenience upgrade notice failed: %s", err)
    return results


def remove_hooks(agent_key: str) -> Any:
    return _hook_target(agent_key)[2]()


def _hook_takeback(agent_key: str) -> list[Takeback]:
    path, present, remove = _hook_target(agent_key)
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
        takeback = lambda: _hook_takeback(agent_key)  # noqa: E731
    refusing = _targets(feature_id) if allowed and feature_id == "cursor.project-skills" else []
    g.set_allowed(feature_id, allowed, takeback=takeback, source=source)
    if refusing:
        _clear_refused_skills(refusing)
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

    path = wiring.project_config_path(agent_key, cwd)
    g = _gate
    if g is None or path is None:
        return wiring.ensure_project_config(agent_key, cwd)
    wired = [False]

    def write() -> None:
        wired[0] = wiring.ensure_project_config(agent_key, cwd)

    outcome = g.apply(
        "cursor.project-mcp", path, write=write,
        present=lambda: wiring.project_config_has_entry(agent_key, path), file=path,
    )
    return wired[0] and outcome not in ("off", "removed")


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


def sync_project_dir_gated(agent_key: str, wiring: Any, cwd: str) -> bool:
    """``skills_wiring.sync_project_dir`` as the feature cursor.project-skills.

    The manifest of planted links is the marker. A planted link the user
    deleted by hand is refused in that workspace only — logged and announced
    as a removal of that one name — and the feature stays allowed. When a sync leaves nothing
    planted, Navide removed the manifest itself, so the target is forgotten
    rather than later read as a removal by the user.
    """
    from .plugins.builtin.navide_skills import skills_wiring

    g = _gate
    if g is None or not cwd:
        return skills_wiring.sync_project_dir(agent_key, wiring, cwd)
    target = Path(cwd).joinpath(*wiring.project_rel)
    if not skills_wiring.project_target_safe(target, Path(cwd)):
        # Not the workspace's folder: nothing is written, so nothing is gated.
        return skills_wiring.sync_project_dir(agent_key, wiring, cwd)
    manifest = target / skills_wiring.MANIFEST_FILE
    delivered = [False]
    # Before the gate reads the manifest, so recording the refusal is not
    # mistaken for a change Navide made.
    refused = skills_wiring.refuse_missing_links(target) if g.allowed("cursor.project-skills") else []

    def write() -> None:
        delivered[0] = skills_wiring.sync_project_dir(agent_key, wiring, cwd)

    outcome = g.apply(
        "cursor.project-skills", target, write=write,
        present=lambda: skills_wiring.project_dir_intact(target), file=manifest,
    )
    for name in refused:
        g.record("cursor.project-skills", "removed", str(target / name), detail="link deleted outside Navide")
    if outcome in ("off", "removed"):
        return False
    if not manifest.is_file():
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
        manifest = Path(target) / skills_wiring.MANIFEST_FILE
        items.append(Takeback(
            target, lambda path=Path(target): skills_wiring.remove_project_dir(path, root=path.parents[depth - 1]), manifest.is_file, manifest,
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
        quiet_repairs=True,
    )
    return 0 if outcome in ("off", "removed") else seeded[0]


def _drop_codex_hook_trust() -> None:
    from . import app

    manager = getattr(app, "codex_home_manager", None)
    if manager is not None:
        manager.drop_all_hook_trust()


# ── Account auto-repair (D7) ───────────────────────────────────────────────


def repair_live_login(
    agent_key: str,
    slot_id: str,
    restore: Callable[[], Any],
    *,
    reason: str,
    live_email: str | None = None,
    slot_email: str | None = None,
    slot_label: str = "",
) -> bool:
    """Write the active account back into the CLI's live login, as the
    feature credentials.auto-repair. Returns whether it was written.

    D7: when the live login is a *different* signed-in account than the one
    Navide would restore, the user changed it outside Navide. That is never
    overridden: the user gets a prompt (keep it, or switch back) instead.
    """
    g = _gate
    if g is None:
        restore()
        return True
    if not g.allowed("credentials.auto-repair"):
        return False
    target = f"{agent_key} live login"
    if live_email and slot_email and live_email.casefold() != slot_email.casefold():
        g.record(
            "credentials.auto-repair", "prompt", target,
            detail=json.dumps({
                "agentKey": agent_key, "slotId": slot_id, "slotLabel": slot_label,
                "liveEmail": live_email, "slotEmail": slot_email,
            }),
        )
        return False
    restore()
    g.record("credentials.auto-repair", "repair", target, detail=reason)
    return True


def _codex_hook_trust_takeback() -> list[Takeback]:
    from . import app

    manager = getattr(app, "codex_home_manager", None)
    if manager is None:
        return []
    config = manager.real_home / "config.toml"
    return [Takeback(str(config), manager.drop_all_hook_trust, None, config)]


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
}

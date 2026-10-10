"""Where each convenience feature meets the code that writes it.

``convenience.ConvenienceGate`` knows nothing about CLIs; this module gives
each feature its target, its presence check and its removal, and routes the
existing writers through the gate. With no gate installed (tests that build
no app, tooling) every writer runs exactly as it did before the gate existed.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any, Callable

from .convenience import ConvenienceGate

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


# ── CLI hooks (S1–S3) ──────────────────────────────────────────────────────

HOOK_FEATURES = {"claude": "claude.hooks", "qwen": "qwen.hooks", "copilot": "copilot.hooks"}


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

    def write() -> None:
        result.update(install(port_file) or {})

    outcome = g.apply(feature_id, path, write=write, present=present, file=path)
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


# ── switches ───────────────────────────────────────────────────────────────


def set_feature(feature_id: str, allowed: bool, *, port_file: str) -> None:
    """The overview's switch: off takes Navide's entries back first; allowed
    re-applies a startup feature at once (a per-spawn one on its next spawn)."""
    g = _gate
    if g is None:
        raise RuntimeError("convenience gate not installed")
    agent_key = next((k for k, f in HOOK_FEATURES.items() if f == feature_id), None)
    remove = REMOVERS.get(feature_id)
    if agent_key is not None:
        remove = lambda: remove_hooks(agent_key)  # noqa: E731
    g.set_allowed(feature_id, allowed, remove=remove)
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


# ── Cursor: project skills (H2) ────────────────────────────────────────────


def sync_project_dir_gated(agent_key: str, wiring: Any, cwd: str) -> bool:
    """``skills_wiring.sync_project_dir`` as the feature cursor.project-skills.

    The manifest of planted links is the marker. When a sync leaves nothing
    planted, Navide removed the manifest itself, so the target is forgotten
    rather than later read as a removal by the user.
    """
    from .plugins.builtin.navide_skills import skills_wiring

    g = _gate
    if g is None or not cwd:
        return skills_wiring.sync_project_dir(agent_key, wiring, cwd)
    target = Path(cwd).joinpath(*wiring.project_rel)
    manifest = target / skills_wiring.MANIFEST_FILE
    delivered = [False]

    def write() -> None:
        delivered[0] = skills_wiring.sync_project_dir(agent_key, wiring, cwd)

    outcome = g.apply("cursor.project-skills", target, write=write, present=manifest.is_file, file=manifest)
    if outcome in ("off", "removed"):
        return False
    if not manifest.is_file():
        g.forget("cursor.project-skills", target)
    return delivered[0]


def _remove_project_dirs() -> None:
    from .plugins.builtin.navide_skills import skills_wiring

    for target in _targets("cursor.project-skills"):
        try:
            skills_wiring.remove_project_dir(Path(target))
        except OSError as err:
            log.warning("removing Navide's links from %s failed: %s", target, err)


#: Removal for the features that are not CLI hooks.
REMOVERS: dict[str, Callable[[], Any]] = {
    "cursor.project-mcp": _remove_project_configs,
    "cursor.project-skills": _remove_project_dirs,
}

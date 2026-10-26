"""Read-only inventory of the CLI extensions each AI CLI installed for itself.

"CLI extension" is the glossary's term (docs/en-US/glossary.md) for an add-on
that belongs to one AI CLI: Claude plugins and mods, Codex plugins and hooks,
opencode plugins, Pi extensions and the rest. Navide's own plugins are not
listed here; they have their own page.

Where each CLI keeps them is declared on its vendor spec (``ExtensionsSpec``);
this module holds the per-format readers. Like ``native_skills`` and
``native_mcp`` it has no write path at all, by construction, and every call is
a fresh scan. Four rules it keeps:

- **Read, never run.** A reader parses files. The one exception is a listing
  command a vendor declares (``cli-json``), run with no stdin, a timeout and
  nothing but its declared arguments: never install, enable or update.
- **One broken file is one broken row.** A document that will not parse is
  reported as an invalid record naming the reason; the scan goes on.
- **Say what is a guess.** Capabilities read off source text are marked
  ``evidence: inferred``. The CLI's own manifest never states them.
- **Agents get metadata.** ``public_dict`` drops paths and hook command lines,
  which can name scripts, hosts and tokens.

Scope is the user-global install of each CLI (D2 in the plan): project-scoped
extensions belong to a workspace, and Navide's per-pane homes link back to
these same directories, so one machine has one set per CLI.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import subprocess
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from .native_mcp import REDACTED_SECRET, _home, _mask_args, _strip_jsonc
from .osplat import paths as platform_paths

log = logging.getLogger("agent_team_backend.cli_extensions")

#: ``(argv, timeout) -> stdout or None``; injectable so tests never spawn.
Runner = Callable[[list[str], float], "str | None"]

_LIST_TIMEOUT_S = 10.0
_SOURCE_READ_BYTES = 512 * 1024
_SOURCE_FILES_MAX = 40
_DETAIL_MAX = 200
_CODE_SUFFIXES = (".ts", ".tsx", ".js", ".mjs", ".cjs", ".mts", ".cts", ".jsx")

#: Markers on every hook Navide installs (claude_hooks, qwen_hooks,
#: copilot_hooks): the comment line, the event header, the port file, and the
#: Windows exec-form Guard script named in ``args``.
_NAVIDE_HOOK_RE = re.compile(r"agent-team-hook|X-Agent-Team-Event|Agent-Team[/\\]backend-port|/hooks/copilot|navide-guard\.cmd")

#: Hook events whose handler sees, and may veto or rewrite, a tool call.
_TOOL_EVENT_RE = re.compile(r"pre_?tool|beforeshell|beforemcp|permission|tool\.check", re.I)
_PROMPT_EVENT_RE = re.compile(r"prompt", re.I)

#: Credential shapes a shell command line carries that ``_mask_args`` (built
#: for MCP argv) does not see once the line is split on spaces: a quoted
#: header, an Authorization scheme, and tokens recognisable by their prefix.
_SECRET_IN_COMMAND: tuple[re.Pattern[str], ...] = (
    re.compile(r"(?i)((?:proxy-)?authorization\s*:\s*(?:bearer|basic|token|digest)?\s*)[^\s'\"]+"),
    re.compile(r"(?i)(\bbearer\s+)[^\s'\"]+"),
    re.compile(r"(?i)((?:[A-Za-z0-9_-]*(?:api[-_]?key|token|secret|passw(?:or)?d|auth)[A-Za-z0-9_-]*)\s*[:=]\s*['\"]?)[^\s'\"]+"),
    re.compile(r"()\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[abprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})"),
)

#: What a piece of in-process code can reach, read off its source text.
_CAPABILITY_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("exec", re.compile(r"child_process|\bspawn\(|\bexecSync\(|\$\.process\b|Bun\.\$|\$`|\bexecFile\(")),
    ("network", re.compile(r"\bfetch\(|\$\.http\b|https?\.request|\bWebSocket\b|\baxios\b|node:https?")),
    ("fs", re.compile(r"\$\.fs\b|node:fs|from ['\"]fs|readFileSync|writeFile")),
    ("intercept-tools", re.compile(r"tool\.call|tool\.execute\.before|['\"]tool_call['\"]|PreToolUse|preToolUse|tool\.check")),
    ("rewrite-prompt", re.compile(r"prompt\.compose|prompt\.submit|system[_ ]?prompt|session\.compacting")),
    ("ui", re.compile(r"\$\.ui\b|ui\.render|ctx\.ui\b|tui\.(?:toast|prompt|command)")),
    ("telemetry", re.compile(r"\btelemetry\.")),
)

_MANIFESTS = (
    (".claude-plugin", "plugin.json"),
    (".codex-plugin", "plugin.json"),
    (".factory-plugin", "plugin.json"),
    (".cursor-plugin", "plugin.json"),
    (".github", "plugin", "plugin.json"),
    ("plugin.json",),
    ("qwen-extension.json",),
    ("gemini-extension.json",),
    ("package.json",),
)

_COMPONENT_DIRS = {
    "skills": "skills",
    "commands": "commands",
    "agents": "agents",
    "droids": "agents",
    "output-styles": "output-styles",
    "themes": "themes",
    "prompts": "prompts",
}
_COMPONENT_FILES = {
    ".mcp.json": "mcp",
    "mcp.json": "mcp",
    ".lsp.json": "lsp",
    "lsp.json": "lsp",
}


@dataclass(frozen=True)
class CliExtension:
    """One extension, hook or package a CLI installed for itself."""

    cli: str
    id: str
    name: str
    #: ``plugin`` | ``mod`` | ``extension`` | ``hook`` | ``package``, or
    #: ``navide-change`` for a convenience-feature target (see navide_changes).
    kind: str
    #: The vendor's own name for it, untranslated ("Claude plugin").
    type_label: str
    version: str = ""
    #: ``user`` | ``project`` | ``local`` | ``org``.
    scope: str = "user"
    enabled: bool = True
    #: ``L1`` text assets, ``L2`` subprocess (hooks, MCP, LSP), ``L3`` code
    #: running inside the CLI's own process.
    exec_tier: str = "L1"
    capabilities: tuple[str, ...] = ()
    native_consent: str = "none"
    #: ``navide`` when Navide wrote it, else ``user``.
    owner: str = "user"
    #: ``verified`` (the CLI's own files say so) or ``inferred``.
    evidence: str = "verified"
    path: str = ""
    components: tuple[str, ...] = ()
    #: A hook's command, first line, masked and cut short. Page only.
    detail: str = ""
    valid: bool = True
    error: str = ""
    #: Why ``enabled`` is a default, not a reading: the file holding the
    #: CLI's on/off switch could not be read. Empty when the state is known.
    enabled_error: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            **self.public_dict(),
            "path": self.path,
            "components": list(self.components),
            "detail": self.detail,
            "valid": self.valid,
            "error": self.error,
        }

    def public_dict(self) -> dict[str, Any]:
        return {
            "cli": self.cli,
            "id": self.id,
            "name": self.name,
            "version": self.version,
            "kind": self.kind,
            "type_label": self.type_label,
            "scope": self.scope,
            "enabled": self.enabled,
            "exec_tier": self.exec_tier,
            "capabilities": list(self.capabilities),
            "native_consent": self.native_consent,
            "owner": self.owner,
            "evidence": self.evidence,
            "enabled_error": self.enabled_error,
        }


@dataclass
class Inventory:
    vendors: list[dict[str, Any]] = field(default_factory=list)
    items: list[CliExtension] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {"vendors": self.vendors, "items": [item.as_dict() for item in self.items]}

    def public_dict(self) -> dict[str, Any]:
        """``unreadable`` names what could not be read, so an agent does not
        take a file it could not open for an extension that is not there."""
        return {
            "vendors": self.vendors,
            "items": [item.public_dict() for item in self.items if item.valid],
            "unreadable": [
                {
                    "cli": item.cli, "id": item.id, "name": item.name, "kind": item.kind,
                    "type_label": item.type_label, "error": _without_path(item.error, item.path),
                }
                for item in self.items if not item.valid
            ],
        }


def scan(home: Path | None = None, runner: Runner | None = None) -> Inventory:
    """Every CLI extension on this machine, CLI by CLI in registry order."""
    from .cli_vendors.registry import VENDORS

    base = home or _home()
    run = runner or _run_readonly
    inventory = Inventory()
    for key in sorted(VENDORS):
        spec = VENDORS[key]
        ext = spec.extensions
        if ext is None:
            continue
        found: list[CliExtension] = []
        if ext.supported:
            for source in ext.sources:
                found.extend(_read_source(key, source, base, run))
        inventory.vendors.append({
            "cli": key,
            "label": spec.label,
            "supported": ext.supported,
            "note": ext.note,
            "count": sum(1 for item in found if item.valid),
            "unreadable": sum(1 for item in found if not item.valid),
        })
        inventory.items.extend(found)
    return inventory


# ── readers ──────────────────────────────────────────────────────────────────


#: Convenience features listed beside each CLI's own extensions. Hooks are
#: left out — the scan already reads them from the CLI's files — and so is the
#: account repair, which writes logins, not anything a CLI loads.
_CHANGE_CLIS: dict[str, tuple[str, ...]] = {
    "codex.hook-trust": ("codex",),
    "codex.login-promote": ("codex",),
    "codex.pane-homes": ("codex",),
    "cursor.project-mcp": ("cursor",),
    "cursor.project-skills": ("cursor",),
    "claude.account-homes": ("claude",),
    "pane-shims": ("kimi", "grok", "antigravity", "muse", "copilot", "qwen"),
}


def navide_changes(features: list[dict[str, Any]]) -> list[CliExtension]:
    """What Navide wrote into a CLI's world for a convenience feature, one row
    per recorded target, so the CLI Extensions page shows them with owner
    navide. ``features`` is ``ConvenienceGate.listing()["features"]``.

    The id names the target by a hash of its path: the agent's copy of this
    inventory (``public_dict``) carries no paths, and a Cursor target is a
    path in some other workspace."""
    out: list[CliExtension] = []
    for feature in features:
        for cli in _CHANGE_CLIS.get(feature["id"], ()):
            for target in feature["targets"]:
                out.append(CliExtension(
                    cli=cli, id=f"navide-change:{feature['id']}:{hashlib.sha256(target['path'].encode('utf-8')).hexdigest()[:16]}",
                    name=feature["id"], kind="navide-change", type_label="Navide change",
                    enabled=feature["state"] == "allowed", owner="navide", evidence="recorded",
                    path=target["path"],
                ))
    return out


def _read_source(cli: str, source: Any, home: Path, run: Runner) -> list[CliExtension]:
    reader = _READERS.get(source.reader)
    if reader is None:
        return [_broken(cli, source, home.joinpath(*source.relative), f"unknown reader {source.reader}")]
    try:
        return reader(cli, source, home, run)
    except Exception as err:  # noqa: BLE001 - one source never takes the page down
        log.warning("cli extensions: %s %s failed (%s)", cli, source.reader, type(err).__name__)
        return [_broken(cli, source, home.joinpath(*source.relative), f"{type(err).__name__}: {err}")]


def _read_plugins_json(cli: str, source: Any, home: Path, run: Runner) -> list[CliExtension]:
    """Claude's ``installed_plugins.json``: {plugins: {id: [{scope, installPath, version}]}}."""
    path = home.joinpath(*source.relative)
    if not path.is_file():
        return []
    document = _load(path)
    enabled, enabled_error = _enabled_map(home, source)
    records = document.get("plugins") if isinstance(document, dict) else None
    if not isinstance(records, dict):
        return [_broken(cli, source, path, "no plugins map")]
    out = []
    for plugin_id, installs in records.items():
        for install in installs if isinstance(installs, list) else [installs]:
            if not isinstance(install, dict):
                continue
            root = Path(str(install.get("installPath", "")))
            out.append(_plugin_record(
                cli, source, plugin_id, root,
                version=str(install.get("version", "")),
                scope=str(install.get("scope", "user")),
                enabled=enabled.get(plugin_id, True),
                enabled_error=enabled_error,
            ))
    return out


def _read_plugin_dirs(cli: str, source: Any, home: Path, run: Runner) -> list[CliExtension]:
    """Every plugin directory under a root, found by its manifest.

    How deep a cache nests (``<name>``, ``<marketplace>/<name>`` or
    ``<marketplace>/<name>/<version>``) differs per CLI and is not verified
    for all of them, so the walk descends until it meets a manifest, at most
    ``depth`` levels (3 when unset). A plugin below the first level is named
    ``<name>@<first level>``, the marketplace by convention.
    """
    root = home.joinpath(*source.relative)
    if not root.is_dir():
        return []
    enabled, enabled_error = _enabled_map(home, source)
    out = []
    for plugin, top in _plugin_roots(root, source.depth or 3):
        manifest = _manifest(plugin)
        name = str(manifest.get("name") or (plugin.name if top is None else plugin.parent.name if _is_version_dir(plugin) else plugin.name))
        plugin_id = name if top is None else f"{name}@{top}"
        out.append(_plugin_record(
            cli, source, plugin_id, plugin,
            version=str(manifest.get("version", "")),
            enabled=enabled.get(plugin_id, enabled.get(name, True)),
            enabled_error=enabled_error,
        ))
    return out


def _plugin_roots(root: Path, depth: int) -> list[tuple[Path, str | None]]:
    """``(plugin dir, first-level name or None)`` for every manifest found."""
    found: list[tuple[Path, str | None]] = []

    def walk(directory: Path, level: int, top: str | None) -> None:
        for child in _subdirs(directory):
            if _manifest(child) or _components(child):
                found.append((child, top))
            elif level < depth:
                walk(child, level + 1, top if top is not None else child.name)

    walk(root, 1, None)
    return found


def _is_version_dir(path: Path) -> bool:
    return bool(re.match(r"^v?\d+(\.\d+)*([-+].*)?$|^[0-9a-f]{7,40}$", path.name))


def _read_codex_config(cli: str, source: Any, home: Path, run: Runner) -> list[CliExtension]:
    """Codex ``config.toml [plugins]`` ({"id@marketplace": {enabled}}) plus its cache."""
    path = home.joinpath(*source.relative)
    if not path.is_file():
        return []
    document = _load(path)
    plugins = _dig(document, source.section) if isinstance(document, dict) else None
    if not isinstance(plugins, dict):
        return []
    cache = path.parent / "plugins" / "cache"
    out = []
    for plugin_id, state in plugins.items():
        name, _, marketplace = plugin_id.partition("@")
        root = _newest_version(cache / marketplace / name) if marketplace else Path()
        manifest = _manifest(root) if root.is_dir() else {}
        out.append(_plugin_record(
            cli, source, plugin_id, root,
            version=str(manifest.get("version", "")),
            enabled=bool(state.get("enabled", True)) if isinstance(state, dict) else True,
        ))
    return out


def _read_hooks(cli: str, source: Any, home: Path, run: Runner) -> list[CliExtension]:
    path = home.joinpath(*source.relative)
    if not path.is_file():
        return []
    document = _load(path)
    container = _dig(document, source.section) if source.section else document
    return _hook_records(cli, source, path, container)


def _read_hooks_dir(cli: str, source: Any, home: Path, run: Runner) -> list[CliExtension]:
    root = home.joinpath(*source.relative)
    if not root.is_dir():
        return []
    out = []
    for path in sorted(root.glob("*.json")):
        try:
            document = _load(path)
        except (OSError, ValueError) as err:
            out.append(_broken(cli, source, path, str(err)))
            continue
        container = document.get("hooks") if isinstance(document, dict) else None
        out.extend(_hook_records(cli, source, path, container, prefix=path.stem))
    return out


def _read_code_files(cli: str, source: Any, home: Path, run: Runner) -> list[CliExtension]:
    """Loose in-process code: one file, or a directory with an index file."""
    root = home.joinpath(*source.relative)
    if not root.is_dir():
        return []
    out = []
    for entry in sorted(root.iterdir()):
        if entry.name.startswith("."):
            continue
        if entry.is_file() and entry.suffix in _CODE_SUFFIXES:
            files = [entry]
        elif entry.is_dir() and any((entry / f"index{s}").is_file() for s in _CODE_SUFFIXES):
            files = _code_files(entry)
        else:
            continue
        out.append(CliExtension(
            cli=cli, id=entry.name, name=entry.name, kind="extension",
            type_label=source.type_label, exec_tier="L3",
            capabilities=_scan_capabilities(files), native_consent=source.native_consent,
            evidence="inferred", path=str(entry),
        ))
    return out


def _read_npm_list(cli: str, source: Any, home: Path, run: Runner) -> list[CliExtension]:
    """A config list of npm package names the CLI installs and loads itself."""
    path = home.joinpath(*source.relative)
    if not path.is_file():
        return []
    names = _dig(_load(path), source.section)
    if not isinstance(names, list):
        return []
    out = []
    for raw in names:
        spec = raw if isinstance(raw, str) else (raw.get("source") or raw.get("name") if isinstance(raw, dict) else "")
        if not spec:
            continue
        name, version = _split_npm(str(spec))
        out.append(CliExtension(
            cli=cli, id=name, name=name, version=version, kind="package",
            type_label=source.type_label, exec_tier="L3", native_consent=source.native_consent,
            evidence="inferred", path=str(path),
        ))
    return out


def _read_qwen_extensions(cli: str, source: Any, home: Path, run: Runner) -> list[CliExtension]:
    root = home.joinpath(*source.relative)
    if not root.is_dir():
        return []
    enablement = root / "extension-enablement.json"
    enabled_error = ""
    try:
        overrides = _load(enablement) if enablement.is_file() else {}
    except (OSError, ValueError) as err:
        overrides, enabled_error = {}, _read_error(enablement, err)
    out = []
    for directory in _subdirs(root):
        manifest = _manifest(directory)
        if not manifest:
            continue
        name = str(manifest.get("name") or directory.name)
        rules = overrides.get(name, {}).get("overrides", []) if isinstance(overrides, dict) else []
        components = set(_components(directory))
        if manifest.get("mcpServers"):
            components.add("mcp")
        if manifest.get("contextFileName"):
            components.add("context")
        out.append(_finish(CliExtension(
            cli=cli, id=name, name=name, version=str(manifest.get("version", "")),
            kind="extension", type_label=source.type_label,
            enabled="!/*" not in rules, enabled_error=enabled_error, native_consent=source.native_consent,
            path=str(directory), components=tuple(sorted(components)),
        ), directory))
    return out


def _read_cli_json(cli: str, source: Any, home: Path, run: Runner) -> list[CliExtension]:
    """A vendor's own read-only JSON listing (``muse plugins list --json``)."""
    binary = _resolve_program(source.list_argv[0])
    if not binary:
        return []
    raw = run([binary, *source.list_argv[1:]], _LIST_TIMEOUT_S)
    if raw is None:
        return [_broken(cli, source, Path(binary), "listing command failed or timed out")]
    document = json.loads(raw)
    rows = _dig(document, source.section) if source.section else document
    out = []
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        name = str(row.get("name") or row.get("id") or "")
        if not name:
            continue
        root = Path(str(row.get("path") or row.get("installPath") or ""))
        out.append(_finish(CliExtension(
            cli=cli, id=str(row.get("id") or name), name=name, version=str(row.get("version", "")),
            kind="plugin", type_label=source.type_label, scope=str(row.get("scope") or "user"),
            enabled=bool(row.get("enabled", True)), native_consent=source.native_consent,
            path=str(root) if str(root) not in ("", ".") else "",
        ), root if root.is_dir() else None))
    return out


_READERS: dict[str, Callable[[str, Any, Path, Runner], list[CliExtension]]] = {
    "plugins-json": _read_plugins_json,
    "plugin-dirs": _read_plugin_dirs,
    "codex-config": _read_codex_config,
    "hooks": _read_hooks,
    "hooks-dir": _read_hooks_dir,
    "code-files": _read_code_files,
    "npm-list": _read_npm_list,
    "qwen-extensions": _read_qwen_extensions,
    "cli-json": _read_cli_json,
}


# ── records ──────────────────────────────────────────────────────────────────


def _plugin_record(
    cli: str, source: Any, plugin_id: str, root: Path, *, version: str = "",
    scope: str = "user", enabled: bool = True, enabled_error: str = "",
) -> CliExtension:
    name = plugin_id.partition("@")[0] or plugin_id
    hooks_doc = _hooks_document(root)
    is_mod = bool(source.mod_label) and isinstance(hooks_doc, dict) and bool(hooks_doc.get("modules"))
    record = CliExtension(
        cli=cli, id=plugin_id, name=name, version=version, scope=scope, enabled=enabled,
        enabled_error=enabled_error, kind="mod" if is_mod else "plugin",
        type_label=source.mod_label if is_mod else source.type_label,
        native_consent="hot-reload" if is_mod else source.native_consent,
        path=str(root) if root.is_dir() else "",
        components=tuple(_components(root)) if root.is_dir() else (),
    )
    if is_mod:
        modules = [root / "hooks" / str(m) for m in hooks_doc.get("modules", [])]
        files = [path for path in modules if path.is_file()] + _code_files(root)
        return _replace(record, exec_tier="L3", evidence="inferred", capabilities=_scan_capabilities(files))
    return _finish(record, root if root.is_dir() else None, hooks_doc)


def _finish(record: CliExtension, root: Path | None, hooks_doc: Any = None) -> CliExtension:
    """Tier and capabilities of a packaged plugin, from what it ships."""
    components = set(record.components)
    capabilities: set[str] = set()
    if root is not None and hooks_doc is None:
        hooks_doc = _hooks_document(root)
    if hooks_doc:
        components.add("hooks")
        capabilities.add("exec")
        events = " ".join(_hook_events(hooks_doc))
        if _TOOL_EVENT_RE.search(events):
            capabilities.add("intercept-tools")
        if _PROMPT_EVENT_RE.search(events):
            capabilities.add("rewrite-prompt")
    if components & {"mcp", "lsp"}:
        capabilities.add("exec")
    tier = "L2" if capabilities else "L1"
    return _replace(record, exec_tier=tier, components=tuple(sorted(components)), capabilities=_ordered(capabilities))


def _hook_records(cli: str, source: Any, path: Path, container: Any, prefix: str = "") -> list[CliExtension]:
    out = []
    for index, (event, command) in enumerate(_walk_hooks(container)):
        capabilities = {"exec"}
        if _TOOL_EVENT_RE.search(event):
            capabilities.add("intercept-tools")
        if _PROMPT_EVENT_RE.search(event):
            capabilities.add("rewrite-prompt")
        hook_id = f"{prefix + ':' if prefix else ''}{event}#{index}"
        out.append(CliExtension(
            cli=cli, id=hook_id, name=event, kind="hook", type_label=source.type_label,
            exec_tier="L2", capabilities=_ordered(capabilities), native_consent=source.native_consent,
            owner="navide" if _NAVIDE_HOOK_RE.search(command) else "user",
            path=str(path), detail=_summary(command),
        ))
    return out


def _walk_hooks(container: Any) -> list[tuple[str, str]]:
    """``(event, command)`` for every hook, whichever of the three shapes:
    ``{event: [{hooks: [{command}]}]}`` (claude, codex, droid, qwen),
    ``{event: [{command}]}`` (cursor, copilot) or ``[{event, command}]`` (kimi)."""
    found: list[tuple[str, str]] = []

    def commands(node: Any) -> list[str]:
        if isinstance(node, dict):
            own = node.get("command") or node.get("bash") or node.get("powershell")
            if isinstance(own, str):
                # Exec form (claude): the program in `command`, what it runs in `args`.
                args = node.get("args")
                if isinstance(args, list) and args:
                    return [" ".join([own, *map(str, args)])]
                return [own]
            return [c for child in node.values() if isinstance(child, (list, dict)) for c in commands(child)]
        if isinstance(node, list):
            return [c for child in node for c in commands(child)]
        return []

    if isinstance(container, dict):
        for event, entries in container.items():
            found.extend((str(event), command) for command in commands(entries))
    elif isinstance(container, list):
        for entry in container:
            if isinstance(entry, dict) and isinstance(entry.get("event"), str):
                found.extend((entry["event"], command) for command in commands(entry))
    return found


def _broken(cli: str, source: Any, path: Path, error: str) -> CliExtension:
    return CliExtension(
        cli=cli, id=f"!{path.name or source.reader}", name=path.name or source.reader,
        kind="plugin", type_label=source.type_label, path=str(path), valid=False, error=error,
    )


# ── helpers ──────────────────────────────────────────────────────────────────


def _replace(record: CliExtension, **changes: Any) -> CliExtension:
    from dataclasses import replace

    return replace(record, **changes)


def _ordered(capabilities: set[str]) -> tuple[str, ...]:
    order = [name for name, _ in _CAPABILITY_PATTERNS]
    return tuple(sorted(capabilities, key=lambda c: order.index(c) if c in order else len(order)))


def _scan_capabilities(files: list[Path]) -> tuple[str, ...]:
    found: set[str] = set()
    for path in files[:_SOURCE_FILES_MAX]:
        try:
            with path.open("rb") as handle:
                text = handle.read(_SOURCE_READ_BYTES).decode("utf-8", "replace")
        except OSError:
            continue
        found.update(name for name, pattern in _CAPABILITY_PATTERNS if pattern.search(text))
    return _ordered(found)


def _code_files(root: Path) -> list[Path]:
    if not root.is_dir():
        return []
    out = []
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = [d for d in dirnames if d not in ("node_modules", ".git") and not d.startswith(".")]
        out.extend(Path(dirpath, f) for f in sorted(filenames) if f.endswith(_CODE_SUFFIXES))
        if len(out) >= _SOURCE_FILES_MAX:
            break
    return out[:_SOURCE_FILES_MAX]


def _components(root: Path) -> list[str]:
    found = {label for name, label in _COMPONENT_DIRS.items() if (root / name).is_dir()}
    found.update(label for name, label in _COMPONENT_FILES.items() if (root / name).is_file())
    return sorted(found)


def _hooks_document(root: Path) -> Any:
    path = root / "hooks" / "hooks.json"
    if not path.is_file():
        return None
    try:
        return _load(path)
    except (OSError, ValueError):
        return None


def _hook_events(document: Any) -> list[str]:
    hooks = document.get("hooks") if isinstance(document, dict) else None
    return [str(event) for event in hooks] if isinstance(hooks, dict) else []


def _manifest(root: Path) -> dict[str, Any]:
    for parts in _MANIFESTS:
        path = root.joinpath(*parts)
        if path.is_file():
            try:
                document = _load(path)
            except (OSError, ValueError):
                return {}
            return document if isinstance(document, dict) else {}
    return {}


def _subdirs(root: Path) -> list[Path]:
    try:
        return sorted(p for p in root.iterdir() if p.is_dir() and not p.name.startswith("."))
    except OSError:
        return []


def _newest_version(directory: Path) -> Path:
    """A cache entry is either the plugin itself or a folder of versions."""
    if not directory.is_dir() or _manifest(directory) or _components(directory):
        return directory
    versions = _subdirs(directory)
    if not versions:
        return directory
    return max(versions, key=lambda p: p.stat().st_mtime)


def _enabled_map(home: Path, source: Any) -> tuple[dict[str, bool], str]:
    """The settings' on/off map, and why it is empty when the file holding it
    could not be read (every plugin then shows its default, not its state)."""
    if not source.settings:
        return {}, ""
    path = home.joinpath(*source.settings)
    try:
        document = _load(path) if path.is_file() else {}
    except (OSError, ValueError) as err:
        return {}, _read_error(path, err)
    plugins = document.get("enabledPlugins") if isinstance(document, dict) else None
    return ({str(k): bool(v) for k, v in plugins.items()} if isinstance(plugins, dict) else {}), ""


def _read_error(path: Path, err: Exception) -> str:
    """Why a file could not be read, naming the file but not where it is."""
    if isinstance(err, OSError):
        return f"cannot read {path.name}: {err.strerror or type(err).__name__}"
    return f"cannot parse {path.name}: {err}"


def _without_path(error: str, path: str) -> str:
    """An error for the agent's copy, which carries no paths."""
    return error.replace(path, Path(path).name) if path else error


def _load(path: Path) -> Any:
    raw = path.read_text(encoding="utf-8")
    if path.suffix == ".toml":
        return tomllib.loads(raw)
    if path.suffix == ".jsonc":
        return json.loads(_strip_jsonc(raw))
    try:
        return json.loads(raw)
    except ValueError:
        return json.loads(_strip_jsonc(raw))


def _dig(document: Any, section: tuple[str, ...]) -> Any:
    node = document
    for key in section:
        if not isinstance(node, dict):
            return None
        node = node.get(key)
    return node


def _split_npm(spec: str) -> tuple[str, str]:
    at = spec.rfind("@")
    if at > 0:
        return spec[:at], spec[at + 1:]
    return spec, ""


def _summary(command: str) -> str:
    """The first line that is not a comment, secrets masked, cut short."""
    lines = [line.strip() for line in command.splitlines() if line.strip()]
    meaningful = [line for line in lines if not line.startswith(("#", "rem "))] or lines
    first = meaningful[0] if meaningful else ""
    for pattern in _SECRET_IN_COMMAND:
        first = pattern.sub(lambda m: m.group(1) + REDACTED_SECRET, first)
    masked = " ".join(_mask_args(tuple(first.split(" "))))
    return masked if len(masked) <= _DETAIL_MAX else masked[: _DETAIL_MAX - 1] + "…"


def _resolve_program(name: str) -> str:
    return platform_paths.resolve_program(name) or ""


def _run_readonly(argv: list[str], timeout: float) -> str | None:
    """Run a declared listing command: no stdin, no terminal, a hard timeout."""
    env = {**os.environ, "NO_COLOR": "1", "CI": "1", "TERM": "dumb"}
    try:
        proc = subprocess.run(  # noqa: S603 - argv from a vendor spec, never user input
            argv, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout, env=env,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return proc.stdout if proc.returncode == 0 else None

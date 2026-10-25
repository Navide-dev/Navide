"""Step-0 contract for Navide plugin disclosure (plan B, D1-D5).

The disclosure is computed from a package manifest only, so the Registry (at
publish time, in the signed disclosure envelope) and the App (at prepareInstall, from
the package's own manifest) compute the same object and compare their
canonical spellings. Registry-only facts (publisher verification, review and
scan results) travel beside it, never inside it.

Types and pure functions only: nothing in the backend imports this module yet.
Normative text: docs/en-US/plugin-agent-tools-contract.md. TypeScript twin:
src/shared/pluginDisclosure.ts.
"""
from __future__ import annotations

import json
from typing import Any, Literal, TypedDict

from .agent_tools_contract import AGENT_TOOL_DEFAULT_TIMEOUT_MS, MAX_SAFE_INTEGER

DISCLOSURE_SCHEMA_VERSION = 1
DISCLOSURE_SUMMARY_TEMPLATE = "plugin-disclosure.summary.v1"
#: The Host shell allowlist (plugin-development-v2.md, "Host-managed storage partitions").
HOST_SHELL_ALLOWLIST = ("gh", "git", "glab")

DisclosureRiskLevel = Literal["low", "medium", "high", "highest"]
_RISK_RANK = {"low": 0, "medium": 1, "high": 2, "highest": 3}

#: Every reason with its level, in the order reasons are listed.
DISCLOSURE_RISK_RULES = (
    ("system.ui", "low"),
    ("system.fs", "medium"),
    ("system.aiCli", "high"),
    ("system.web", "high"),
    ("system.agents", "medium"),
    ("system.agentMessages", "high"),
    ("shell.allowlist", "high"),
    ("nativeBackend", "high"),
    ("agentTools.write", "high"),
    ("shell.full", "highest"),
    ("network", "highest"),
)

DISCLOSURE_ITEM_KINDS = (
    "agentTool", "backendEvent", "backendMethod", "fsScopeRead", "fsScopeRoot", "fsScopeWrite",
    "nativeBackend", "network", "shell", "shellExecutable", "system",
)


class ManifestDisclosure(TypedDict):
    """The manifest-derived disclosure. Signed by the Registry and recomputed by the App."""

    schemaVersion: int
    plugin: dict[str, str]
    summary: dict[str, Any]
    risk: dict[str, Any]
    permissions: dict[str, Any]
    nativeBackend: dict[str, list[str]] | None
    network: Literal["none", "via-shell"]
    agentTools: list[dict[str, Any]]
    dataLocations: dict[str, Any]


class RegistryDisclosureFacts(TypedDict):
    """Facts only the Registry knows; computed there (not covered by a signature), never derived from the manifest."""

    publisher: dict[str, Any]   # {name, verifiedDomain, domainVerifiedAt}
    signature: dict[str, Any]   # {signed, keyId}
    review: dict[str, Any]      # {status, reviewedAt, nativeCodeInspected}
    scan: dict[str, Any]        # {secretScan, secretFindings, similarityWarning, similarTo, scannedAt}


class DisclosureCard(TypedDict):
    manifest: ManifestDisclosure
    scan: dict[str, Any] | None  # ScanReport (contract 3.8), or None when the version has none
    registry: RegistryDisclosureFacts | None


class DisclosureItem(TypedDict):
    kind: str
    key: str
    detail: dict[str, Any] | None


# Functional form: the diff has a "from" key, which is a Python keyword.
DisclosureDiff = TypedDict("DisclosureDiff", {
    "schemaVersion": int,
    "from": dict[str, str],
    "to": dict[str, str],
    "added": list[DisclosureItem],
    "removed": list[DisclosureItem],
    "unchanged": list[DisclosureItem],
    "widened": bool,
})


class CanonicalJsonError(TypeError):
    """A value with no canonical contract spelling (a non-integer or unsafe number, or a non-JSON type)."""


def risk_level_for_reasons(reasons: list[dict[str, Any]]) -> str:
    """The highest level among the reasons; low when there are none."""
    level = "low"
    for reason in reasons:
        if _RISK_RANK[reason["level"]] > _RISK_RANK[level]:
            level = reason["level"]
    return level


def compute_disclosure(manifest: dict[str, Any]) -> ManifestDisclosure:
    """The disclosure of a manifest that already passed Manifest v2 validation and validate_agent_tools."""
    declared = manifest.get("permissions") or {}
    system = sorted(declared.get("system") or [])
    if declared.get("shell") == "allowlist":
        shell: dict[str, Any] | None = {"mode": "allowlist", "executables": list(HOST_SHELL_ALLOWLIST)}
    elif declared.get("shell") == "full":
        shell = {"mode": "full", "executables": None}
    else:
        shell = None
    fs_scope = (declared.get("scopes") or {}).get("fs")
    scopes = None
    if fs_scope:
        scopes = {"fs": {
            # An explicit null means the default, as `?? "workspace"` does in TypeScript.
            "root": fs_scope.get("root") or "workspace",
            "read": sorted(fs_scope.get("read") or []),
            "write": sorted(fs_scope.get("write") or []),
        }}
    backend = manifest.get("backend")
    native = None
    if backend is not None:
        native = {"methods": sorted(backend.get("methods") or []), "events": sorted(backend.get("events") or [])}
    tools = sorted(
        (
            {
                "name": tool["name"],
                "method": tool["method"],
                "risk": tool["risk"],
                "title": tool["title"],
                "description": tool["description"],
                "timeoutMs": tool.get("timeoutMs", AGENT_TOOL_DEFAULT_TIMEOUT_MS),
                "inputSchema": tool["inputSchema"],
            }
            for tool in ((backend or {}).get("agentTools") or [])
        ),
        key=lambda tool: tool["name"],
    )
    read_tools = sum(1 for tool in tools if tool["risk"] == "read")
    write_tools = len(tools) - read_tools
    has_fs = "fs" in system

    present = set()
    if "ui" in system:
        present.add("system.ui")
    if has_fs:
        present.add("system.fs")
    if "aiCli" in system:
        present.add("system.aiCli")
    if "web" in system:
        present.add("system.web")
    if "agents" in system:
        present.add("system.agents")
    if "agentMessages" in system:
        present.add("system.agentMessages")
    if shell and shell["mode"] == "allowlist":
        present.add("shell.allowlist")
    if native is not None:
        present.add("nativeBackend")
    if write_tools:
        present.add("agentTools.write")
    if shell and shell["mode"] == "full":
        present.add("shell.full")
    reasons = [{"key": key, "level": level} for key, level in DISCLOSURE_RISK_RULES if key in present]

    clauses: list[dict[str, Any]] = []
    if native is not None:
        clauses.append({"key": "nativeBackend", "params": {}})
    if has_fs:
        read_only = scopes is not None and not scopes["fs"]["write"]
        clauses.append({"key": "files", "params": {"access": "read" if read_only else "readWrite"}})
    if shell:
        clauses.append({"key": "shell", "params": dict(shell)})
        # A declared shell runs git/gh/glab (or anything, in full mode), which
        # reach remote hosts even though the sandboxes have no network.
        clauses.append({"key": "networkViaShell", "params": {}})
    if "aiCli" in system:
        clauses.append({"key": "aiCli", "params": {}})
    if "web" in system:
        clauses.append({"key": "web", "params": {}})
    if "agents" in system:
        clauses.append({"key": "agents", "params": {}})
    if "agentMessages" in system:
        clauses.append({"key": "agentMessages", "params": {}})
    if "ui" in system:
        clauses.append({"key": "ui", "params": {}})
    if tools:
        clauses.append({"key": "agentTools", "params": {"read": read_tools, "write": write_tools}})
    if not clauses:
        clauses.append({"key": "noPermissions", "params": {}})

    if not has_fs:
        project_writes: Any = "none"
    elif scopes is None:
        project_writes = "undeclared"
    elif not scopes["fs"]["write"]:
        project_writes = "none"
    else:
        project_writes = {"root": scopes["fs"]["root"], "patterns": scopes["fs"]["write"]}

    return {
        "schemaVersion": DISCLOSURE_SCHEMA_VERSION,
        "plugin": {"id": manifest["id"], "version": manifest["version"], "publisher": manifest["publisher"]},
        "summary": {"template": DISCLOSURE_SUMMARY_TEMPLATE, "clauses": clauses},
        "risk": {"level": risk_level_for_reasons(reasons), "reasons": reasons},
        "permissions": {"system": system, "shell": shell, "scopes": scopes},
        "nativeBackend": native,
        "network": "via-shell" if shell else "none",
        "agentTools": tools,
        "dataLocations": {"hostStorage": True, "backendDataDirectory": native is not None,
                          "projectWrites": project_writes},
    }


def _normalized(value: Any) -> Any:
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, int):
        if abs(value) > MAX_SAFE_INTEGER:
            raise CanonicalJsonError(f"{value} is not a safe integer")
        return value
    if isinstance(value, float):
        if not value.is_integer() or abs(value) > MAX_SAFE_INTEGER:
            raise CanonicalJsonError(f"{value!r} is not a safe integer")
        return int(value)
    if isinstance(value, (list, tuple)):
        return [_normalized(item) for item in value]
    if isinstance(value, dict):
        return {key: _normalized(item) for key, item in value.items()}
    raise CanonicalJsonError(f"unsupported value of type {type(value).__name__}")


def canonical_contract_json(value: Any) -> str:
    """Sorted keys, no whitespace, non-ASCII escaped, safe integers only (integral floats print as ints).

    Same spelling as ``confirm_token.canonical_json`` for every value it accepts.
    """
    return json.dumps(_normalized(value), sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def disclosure_items(disclosure: ManifestDisclosure) -> list[DisclosureItem]:
    """The flat item list a diff compares, sorted by kind and then key."""
    items: list[DisclosureItem] = []

    def add(kind: str, key: str, detail: dict[str, Any] | None = None) -> None:
        items.append({"kind": kind, "key": key, "detail": detail})

    permissions = disclosure["permissions"]
    for name in permissions["system"]:
        add("system", name)
    if permissions["shell"]:
        add("shell", permissions["shell"]["mode"])
        for executable in permissions["shell"]["executables"] or []:
            add("shellExecutable", executable)
    if permissions["scopes"]:
        fs = permissions["scopes"]["fs"]
        add("fsScopeRoot", fs["root"])
        for pattern in fs["read"]:
            add("fsScopeRead", pattern)
        for pattern in fs["write"]:
            add("fsScopeWrite", pattern)
    if disclosure["nativeBackend"] is not None:
        add("nativeBackend", "native")
        for method in disclosure["nativeBackend"]["methods"]:
            add("backendMethod", method)
        for event in disclosure["nativeBackend"]["events"]:
            add("backendEvent", event)
    if disclosure["network"] != "none":
        add("network", disclosure["network"])
    for tool in disclosure["agentTools"]:
        add("agentTool", tool["name"], {key: value for key, value in tool.items() if key != "name"})
    return sorted(items, key=lambda item: (item["kind"], item["key"]))


def diff_disclosure(old: ManifestDisclosure, new: ManifestDisclosure) -> DisclosureDiff:
    """D2: what an update (or rollback) from ``old`` to ``new`` adds, removes and keeps."""
    before = disclosure_items(old)
    after = disclosure_items(new)
    before_keys = {canonical_contract_json(item) for item in before}
    after_keys = {canonical_contract_json(item) for item in after}
    added = [item for item in after if canonical_contract_json(item) not in before_keys]
    return {
        "schemaVersion": DISCLOSURE_SCHEMA_VERSION,
        "from": {"id": old["plugin"]["id"], "version": old["plugin"]["version"], "risk": old["risk"]["level"]},
        "to": {"id": new["plugin"]["id"], "version": new["plugin"]["version"], "risk": new["risk"]["level"]},
        "added": added,
        "removed": [item for item in before if canonical_contract_json(item) not in after_keys],
        "unchanged": [item for item in after if canonical_contract_json(item) in before_keys],
        "widened": bool(added) or _RISK_RANK[new["risk"]["level"]] > _RISK_RANK[old["risk"]["level"]],
    }

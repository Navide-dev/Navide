"""Step-0 contract for the Registry's publish-time static scan (plan B, D-S).

The Registry scans every published artifact and signs the scan report in the
disclosure envelope (``scanDigest``). The App cannot rerun the scan; it checks
the digest and derives the plain-language sentences, the scan risk reasons
and the declared-vs-scanned comparison from the report with the pure
functions below. The report holds facts only; everything a surface shows is
derived here, in the same way in both languages.

Types and pure functions only. Normative text:
docs/en-US/plugin-agent-tools-contract.md sections 3.8 and 3.9. TypeScript
twin: src/shared/pluginDisclosureScan.ts.
"""
from __future__ import annotations

import re
from typing import Any, Literal, TypedDict

from .disclosure_contract import HOST_SHELL_ALLOWLIST, ManifestDisclosure

SCAN_SCHEMA_VERSION = 1
SCANNER_ID = "navide-static-scan"

#: The 9 fields of the disclosure envelope, in documentation order (section 3.5).
DISCLOSURE_ENVELOPE_FIELDS = (
    "schemaVersion", "artifactDigest", "packageId", "version", "target",
    "keyId", "signedAt", "disclosureDigest", "scanDigest",
)

#: Output and work bounds of a v1 scanner (section 3.8). Exceeding one sets
#: ``coverage.truncated`` or ``coverage.timedOut``; it never fails a publish.
SCAN_LIMITS = {
    "maxItemsPerKind": 100,
    "maxPaths": 50,
    "maxPathLength": 200,
    "maxScriptBytes": 20 * 1024 * 1024,
    "maxNativeBytes": 512 * 1024 * 1024,
    "timeBudgetMs": 30_000,
}

#: ``coverage.skipped`` reasons that make a scan incomplete (section 3.8).
INCOMPLETE_SKIP_REASONS = ("scannerError", "tooComplex")

ShellCategory = Literal["remoteWrite", "remoteRead", "localWrite", "local", "other", "unknownSubcommand"]
ScanSource = Literal["frontend", "backend"]

#: Shell categories in the order their sentences are listed.
SHELL_CATEGORY_ORDER = ("remoteWrite", "other", "unknownSubcommand", "remoteRead", "localWrite", "local")

_GIT = {
    "remoteWrite": {"push", "send-email", "request-pull"},
    "remoteRead": {"fetch", "pull", "clone", "ls-remote", "submodule", "remote"},
    "localWrite": {
        "add", "am", "apply", "branch", "checkout", "cherry-pick", "clean", "commit", "config",
        "gc", "init", "merge", "mv", "notes", "rebase", "reset", "restore", "revert", "rm",
        "stash", "switch", "tag", "update-index", "worktree",
    },
    "local": {
        "blame", "cat-file", "describe", "diff", "for-each-ref", "grep", "log", "ls-files",
        "ls-tree", "merge-base", "name-rev", "reflog", "rev-list", "rev-parse", "shortlog",
        "show", "show-ref", "status", "symbolic-ref", "var", "version",
    },
}
# gh and glab always talk to the forge; only their writes are told apart.
_FORGE_WRITE_ACTIONS = {
    "create", "edit", "close", "reopen", "merge", "delete", "comment", "review", "ready",
    "lock", "unlock", "transfer", "pin", "unpin", "upload", "set", "add", "remove", "rename",
    "archive", "unarchive", "fork", "sync", "approve", "revoke", "cancel", "rerun", "run",
    "enable", "disable", "note",
}
_FORGE_READ_ACTIONS = {
    "list", "view", "status", "diff", "checks", "download", "search", "browse", "watch", "ls",
}
_FORGE_LOCAL = {"version", "help", "completion"}
_GH_API_WRITE_FLAGS = {"-f", "-F", "--field", "--raw-field", "--input"}
_GH_API_METHOD_FLAGS = {"-X", "--method"}
#: Options whose next argument is their value, not a subcommand.
_GIT_VALUE_OPTIONS = {"-C", "-c", "--git-dir", "--work-tree", "--namespace"}
_FORGE_VALUE_OPTIONS = {"-R", "--repo", "--hostname"}
#: A subcommand is reported only when it looks like one; anything else (a
#: path, a URL, a value) is never echoed.
_SUBCOMMAND_RE = re.compile(r"^[a-z][a-z0-9-]{0,39}$")


def _positionals(args: list[str], value_options: set[str]) -> list[str]:
    out: list[str] = []
    skip = False
    for arg in args:
        if skip:
            skip = False
        elif arg in value_options:
            skip = True
        elif not arg.startswith("-"):
            out.append(arg)
    return out


def _word(value: str | None) -> str | None:
    return value if value is not None and _SUBCOMMAND_RE.fullmatch(value) else None


class ShellCall(TypedDict):
    executable: str
    subcommand: str | None
    category: ShellCategory
    source: ScanSource
    evidence: Literal["callSite", "commandLikeString"]
    files: int


class ScanReport(TypedDict):
    """The signed facts of one artifact's scan (section 3.8)."""

    schemaVersion: int
    scanner: dict[str, str]
    artifactDigest: str
    target: str
    scannedAt: str
    coverage: dict[str, Any]
    shell: dict[str, Any]
    network: dict[str, Any]
    files: dict[str, Any]
    capabilities: list[dict[str, str]]
    code: dict[str, Any]
    native: list[dict[str, Any]]


def classify_shell_command(executable: str, args: list[str]) -> tuple[str | None, ShellCategory]:
    """(subcommand, category) for one parsed invocation; ``args`` excludes the
    executable. Executables outside the Host allowlist report no subcommand:
    their arguments are never echoed."""
    if executable == "git":
        positionals = _positionals(args, _GIT_VALUE_OPTIONS)
        if not positionals:
            return None, "local"
        sub = _word(positionals[0])
        if sub is None:
            return None, "unknownSubcommand"
        for category in ("remoteWrite", "remoteRead", "localWrite", "local"):
            if sub in _GIT[category]:
                return sub, category  # type: ignore[return-value]
        return sub, "unknownSubcommand"
    if executable in ("gh", "glab"):
        positionals = _positionals(args, _FORGE_VALUE_OPTIONS)
        if not positionals:
            return None, "local"
        sub = _word(positionals[0])
        if sub is None:
            return None, "unknownSubcommand"
        if sub in _FORGE_LOCAL:
            return sub, "local"
        if executable == "gh" and sub == "api":
            method = "GET"
            for index, arg in enumerate(args):
                if arg in _GH_API_METHOD_FLAGS and index + 1 < len(args):
                    method = args[index + 1].upper()
                elif arg.startswith("--method="):
                    method = arg.split("=", 1)[1].upper()
                elif arg.startswith("-X") and len(arg) > 2:
                    method = arg[2:].upper()
            writes = method != "GET" or any(
                arg in _GH_API_WRITE_FLAGS or arg.split("=", 1)[0] in _GH_API_WRITE_FLAGS for arg in args
            )
            return sub, "remoteWrite" if writes else "remoteRead"
        action = _word(positionals[1]) if len(positionals) > 1 else None
        if action in _FORGE_WRITE_ACTIONS:
            return f"{sub} {action}", "remoteWrite"
        if action in _FORGE_READ_ACTIONS:
            return f"{sub} {action}", "remoteRead"
        return (f"{sub} {action}" if action else sub), "unknownSubcommand"
    if executable in HOST_SHELL_ALLOWLIST:
        return _word(args[0] if args else None), "unknownSubcommand"
    return None, "other"


def _command(call: ShellCall) -> str:
    return call["executable"] if call["subcommand"] is None else f"{call['executable']} {call['subcommand']}"


def _code_count(signals: dict[str, Any] | None) -> int:
    if not signals:
        return 0
    return signals["eval"] + signals["newFunction"] + signals["dynamicImport"] + signals["stringTimers"]


def _incomplete_reasons(scan: ScanReport) -> list[str]:
    reasons: set[str] = set()
    coverage = scan["coverage"]
    if coverage["timedOut"]:
        reasons.add("timedOut")
    if coverage["truncated"]:
        reasons.add("truncated")
    # A scanner failure on a file, or a structural ceiling it hit, means part of
    # the package was not scanned (DS2).
    for skipped in coverage["skipped"]:
        if skipped["reason"] in INCOMPLETE_SKIP_REASONS and skipped["count"]:
            reasons.add(skipped["reason"])
    for source in ("frontend", "backend"):
        signals = scan["code"][source]
        if signals and signals["obfuscationSignals"]:
            reasons.add("obfuscated")
    for binary in scan["native"]:
        if binary["packer"] is not None:
            reasons.add("packed")
        if binary["embeddedRuntime"] is not None:
            reasons.add("embeddedRuntime")
    return sorted(reasons)


def scan_sentences(scan: ScanReport) -> list[dict[str, Any]]:
    """The ordered plain-language sentences of a report (section 3.8); i18n key
    ``pluginDisclosure.scan.<key>``. Absent kinds become ``notFound.<kind>``,
    never an empty list."""
    out: list[dict[str, Any]] = []
    calls = scan["shell"]["calls"]
    for category in SHELL_CATEGORY_ORDER:
        commands = sorted({_command(call) for call in calls if call["category"] == category})
        if commands:
            out.append({"key": f"shell.{category}", "params": {"commands": commands}})
    dynamic = scan["shell"]["dynamic"]
    if dynamic["count"]:
        out.append({"key": "shell.dynamic", "params": {"count": dynamic["count"]}})
    files = scan["files"]
    if files["writePaths"] or files["dynamicPaths"]:
        out.append({"key": "files.write", "params": {"paths": files["writePaths"], "dynamic": files["dynamicPaths"]}})
    if files["readPaths"]:
        out.append({"key": "files.read", "params": {"paths": files["readPaths"]}})
    hosts = sorted({entry["host"] for entry in scan["network"]["hosts"]})
    if hosts:
        out.append({"key": "network.hosts", "params": {"hosts": hosts}})
    for source in ("frontend", "backend"):
        count = _code_count(scan["code"][source])
        if count:
            out.append({"key": f"code.eval.{source}", "params": {"count": count}})
    signals = sorted({
        signal
        for source in ("frontend", "backend")
        for signal in ((scan["code"][source] or {}).get("obfuscationSignals") or [])
    })
    if signals:
        out.append({"key": "code.obfuscated", "params": {"signals": signals}})
    for binary in scan["native"]:
        out.append({"key": "native.summary", "params": {
            "path": binary["path"], "format": binary["format"], "arch": binary["arch"],
            "libraries": binary["libraries"],
        }})
        reason = "packed" if binary["packer"] is not None else (
            "embeddedRuntime" if binary["embeddedRuntime"] is not None else None)
        if reason is not None:
            out.append({"key": "native.unscannable", "params": {
                "path": binary["path"], "reason": reason,
                "detail": binary["packer"] if reason == "packed" else binary["embeddedRuntime"],
            }})
    incomplete = _incomplete_reasons(scan)
    if incomplete:
        out.append({"key": "coverage.incomplete", "params": {"reasons": incomplete}})
    if not calls and not dynamic["count"]:
        out.append({"key": "notFound.shell", "params": {}})
    if not hosts:
        out.append({"key": "notFound.network", "params": {}})
    if not (files["writePaths"] or files["readPaths"] or files["dynamicPaths"]):
        out.append({"key": "notFound.files", "params": {}})
    if not (_code_count(scan["code"]["frontend"]) or _code_count(scan["code"]["backend"])):
        out.append({"key": "notFound.dynamicCode", "params": {}})
    coverage = scan["coverage"]
    out.append({"key": "coverage", "params": {
        "scannerVersion": scan["scanner"]["version"], "scannedAt": scan["scannedAt"],
        "filesScanned": coverage["filesScanned"], "filesTotal": coverage["filesTotal"],
    }})
    return out


#: Scan reasons with their level, in the order they are listed (section 3.8).
SCAN_RISK_RULES = (
    ("scan.shell.remoteWrite", "highest"),
    ("scan.shell.other", "highest"),
    ("scan.shell.dynamic", "high"),  # highest when the manifest declares shell "full"
    ("scan.shell.remoteRead", "high"),
    ("scan.shell.localWrite", "high"),
    ("scan.shell.unknownSubcommand", "high"),
    ("scan.code.eval.backend", "high"),
    ("scan.incomplete", "high"),
)


def scan_risk_reasons(scan: ScanReport, disclosure: ManifestDisclosure) -> list[dict[str, str]]:
    categories = {call["category"] for call in scan["shell"]["calls"]}
    shell = disclosure["permissions"]["shell"]
    present: dict[str, str] = {}
    for key, level in SCAN_RISK_RULES:
        applies = False
        if key.startswith("scan.shell.") and key != "scan.shell.dynamic":
            applies = key.removeprefix("scan.shell.") in categories
        elif key == "scan.shell.dynamic":
            applies = scan["shell"]["dynamic"]["count"] > 0 and shell is not None
            if applies and shell["mode"] == "full":
                level = "highest"
        elif key == "scan.code.eval.backend":
            applies = _code_count(scan["code"]["backend"]) > 0
        elif key == "scan.incomplete":
            applies = bool(_incomplete_reasons(scan))
        if applies:
            present[key] = level
    return [{"key": key, "level": present[key]} for key, _ in SCAN_RISK_RULES if key in present]


_RANK = {"low": 0, "medium": 1, "high": 2, "highest": 3}


def card_risk_level(disclosure: ManifestDisclosure, scan: ScanReport | None) -> str:
    """The level every surface shows: the manifest level raised by the scan reasons."""
    level = disclosure["risk"]["level"]
    for reason in scan_risk_reasons(scan, disclosure) if scan is not None else []:
        if _RANK[reason["level"]] > _RANK[level]:
            level = reason["level"]
    return level


def scope_pattern_matches(pattern: str, path: str) -> bool:
    """Section 3.9 glob: ``**`` is zero or more whole segments, ``*`` any run
    of characters inside one segment; everything else is literal."""
    parts = []
    for index, segment in enumerate(pattern.split("/")):
        last = index == len(pattern.split("/")) - 1
        if segment == "**":
            parts.append("(?:[^/]+/)*" if not last else "(?:[^/]+(?:/[^/]+)*)?")
        else:
            parts.append("[^/]*".join(re.escape(piece) for piece in segment.split("*")) + ("" if last else "/"))
    return re.fullmatch("".join(parts), path) is not None


def declared_vs_scanned(disclosure: ManifestDisclosure, scan: ScanReport) -> dict[str, list[dict[str, str]]]:
    """Section 3.9: what the scan found that the manifest does not declare
    (``undeclared``, shown first and in red) and what the manifest declares
    that the scan did not find (``declaredNotSeen``, shown in grey)."""
    permissions = disclosure["permissions"]
    system = set(permissions["system"])
    shell = permissions["shell"]
    scopes = (permissions["scopes"] or {}).get("fs")
    undeclared: set[tuple[str, str]] = set()
    calls = scan["shell"]["calls"]
    for call in calls:
        if shell is None:
            undeclared.add(("shell", _command(call)))
        elif shell["mode"] == "allowlist" and call["executable"] not in shell["executables"]:
            undeclared.add(("shellExecutable", call["executable"]))
    if shell is None and scan["shell"]["dynamic"]["count"]:
        undeclared.add(("shellDynamic", "dynamic"))
    namespaces = {entry["address"].split(".", 1)[0] for entry in scan["capabilities"]}
    if shell is None and "shell" in namespaces:
        undeclared.add(("shell", "shell.run"))
    for namespace in ("aiCli", "fs", "ui", "web"):
        if namespace in namespaces and namespace not in system:
            undeclared.add(("system", namespace))
    files = scan["files"]
    if (files["readPaths"] or files["writePaths"]) and "fs" not in system:
        undeclared.add(("system", "fs"))
    if scopes is not None and "fs" in system:
        write_patterns = scopes["write"]
        read_patterns = scopes["read"] + scopes["write"]
        for path in files["writePaths"]:
            if not any(scope_pattern_matches(p, path) for p in write_patterns):
                undeclared.add(("fsScopeWrite", path))
        for path in files["readPaths"]:
            if not any(scope_pattern_matches(p, path) for p in read_patterns):
                undeclared.add(("fsScopeRead", path))

    not_seen: set[tuple[str, str]] = set()
    if shell is not None and not calls and not scan["shell"]["dynamic"]["count"] and "shell" not in namespaces:
        not_seen.add(("shell", shell["mode"]))
    for namespace in sorted(system):
        seen = namespace in namespaces or (
            namespace == "fs" and bool(files["readPaths"] or files["writePaths"] or files["dynamicPaths"]))
        if not seen:
            not_seen.add(("system", namespace))

    def listed(items: set[tuple[str, str]]) -> list[dict[str, str]]:
        return [{"kind": kind, "key": key} for kind, key in sorted(items)]

    return {"undeclared": listed(undeclared), "declaredNotSeen": listed(not_seen)}


def scan_items(scan: ScanReport | None) -> list[dict[str, str]]:
    """Section 3.6: the flat scan items an update diff compares."""
    if scan is None:
        return []
    items: set[tuple[str, str]] = set()
    for call in scan["shell"]["calls"]:
        items.add(("scanShell", _command(call)))
    if scan["shell"]["dynamic"]["count"]:
        items.add(("scanShellDynamic", "dynamic"))
    for entry in scan["network"]["hosts"]:
        items.add(("scanHost", entry["host"]))
    for path in scan["files"]["writePaths"]:
        items.add(("scanWritePath", path))
    for path in scan["files"]["readPaths"]:
        items.add(("scanReadPath", path))
    for entry in scan["capabilities"]:
        items.add(("scanCapability", entry["address"]))
    for source in ("frontend", "backend"):
        if _code_count(scan["code"][source]):
            items.add(("scanDynamicCode", source))
    return [{"kind": kind, "key": key} for kind, key in sorted(items)]


def diff_scan(old: ScanReport | None, new: ScanReport | None) -> dict[str, Any]:
    """Scan half of the D2 diff: ``widened`` when the newer scan found anything new."""
    before = {(item["kind"], item["key"]) for item in scan_items(old)}
    after = scan_items(new)
    added = [item for item in after if (item["kind"], item["key"]) not in before]
    after_keys = {(item["kind"], item["key"]) for item in after}
    removed = [item for item in scan_items(old) if (item["kind"], item["key"]) not in after_keys]
    return {"added": added, "removed": removed, "widened": bool(added)}

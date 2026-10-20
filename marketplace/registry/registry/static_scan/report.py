"""Build the signed scan report of one artifact (contract 3.8).

The report is facts only. ``scan_package`` reads an already validated
package archive, runs the frontend script rules on every ``.js``/``.mjs``/
``.cjs`` file, bounds the work by ``SCAN_LIMITS`` and redacts anything that
matches a secret-scan rule. The native backend executable named by
``backend.entry`` is summarized by ``native.summarize_executable``; its
commands, hosts and capability addresses are reported with
``source: "backend"``.
"""

from __future__ import annotations

import logging
import time
import zipfile
from collections.abc import Callable
from datetime import datetime, timezone
from io import BytesIO
from typing import Any

from ..plugin_contract.disclosure_scan_contract import (
    SCAN_LIMITS,
    SCAN_SCHEMA_VERSION,
    SCANNER_ID,
    ScanReport,
)
from ..secret_scan import RULES as SECRET_RULES
from ..package import backend_entry_for_target
from .js_scan import ScriptFacts, scan_script
from .limits import Deadline, ScanTimeout, TooComplex
from .native import NativeFacts, summarize_executable

SCANNER_VERSION = "1.0.0"
SCRIPT_SUFFIXES = (".js", ".mjs", ".cjs")


def _timestamp(value: datetime) -> str:
    return value.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


_log = logging.getLogger(__name__)


def failed_report(*, artifact_digest: str, target: str, now: datetime | None = None) -> ScanReport:
    """The report of a scan that failed as a whole (M1): it exists, says
    nothing was found, and is incomplete (``scannerError``), so the card
    never shows such a version as unscanned or as fully scanned."""
    return {  # type: ignore[return-value]
        "schemaVersion": SCAN_SCHEMA_VERSION,
        "scanner": {"id": SCANNER_ID, "version": SCANNER_VERSION},
        "artifactDigest": artifact_digest,
        "target": target,
        "scannedAt": _timestamp(now or datetime.now(timezone.utc)),
        "coverage": {"filesTotal": 0, "filesScanned": 0, "bytesScanned": 0,
                     "skipped": [{"reason": "scannerError", "count": 1}], "truncated": False, "timedOut": False},
        "shell": {"calls": [], "dynamic": {"count": 0, "files": 0}},
        "network": {"hosts": []},
        "files": {"readPaths": [], "writePaths": [], "dynamicPaths": 0},
        "capabilities": [],
        "code": {"frontend": None, "backend": None},
        "native": [],
    }


def _redacted(value: str) -> bool:
    data = value.encode("utf-8", "replace")
    return any(pattern.search(data) for _rule, pattern in SECRET_RULES)


def scan_package(
    data: bytes,
    *,
    artifact_digest: str,
    target: str,
    manifest: dict,
    now: datetime | None = None,
    clock: Callable[[], float] = time.monotonic,
) -> ScanReport | None:
    if manifest.get("schemaVersion") != 2:
        return None
    backend = manifest.get("backend")
    backend_path = backend_entry_for_target(backend["entry"], target) if backend else None
    started = clock()
    budget = SCAN_LIMITS["timeBudgetMs"] / 1000
    # Polled inside every scanning loop, not only between files (H1).
    deadline = Deadline(started + budget, clock)
    limit = SCAN_LIMITS["maxItemsPerKind"]
    skipped: dict[str, int] = {}
    truncated = False
    timed_out = False
    files_total = 0
    files_scanned = 0
    bytes_scanned = 0
    merged = ScriptFacts()
    call_files: dict[tuple[str, str | None, str, str, str], int] = {}
    """(executable, subcommand, category, evidence, source) -> files"""
    backend_hosts: dict[str, int] = {}
    backend_capabilities: set[str] = set()
    natives: list[NativeFacts] = []
    any_script = False

    def skip(reason: str, count: int = 1) -> None:
        skipped[reason] = skipped.get(reason, 0) + count

    with zipfile.ZipFile(BytesIO(data)) as archive:
        members = sorted((info for info in archive.infolist() if not info.is_dir()), key=lambda i: i.filename)
        for info in members:
            if info.filename == "manifest.json":
                continue
            files_total += 1
            if info.filename == backend_path:
                if timed_out or clock() - started > budget:
                    timed_out = True
                    skip("unsupported")
                    continue
                with archive.open(info) as stream:
                    binary = stream.read(SCAN_LIMITS["maxNativeBytes"] + 1)
                if len(binary) > SCAN_LIMITS["maxNativeBytes"]:
                    binary = binary[:SCAN_LIMITS["maxNativeBytes"]]
                    truncated = True
                try:
                    native = summarize_executable(info.filename, binary, deadline)
                except ScanTimeout:
                    timed_out = True
                    continue
                except Exception:  # noqa: BLE001 - M1: one file's failure never drops the report
                    _log.exception("native scan failed for %s", info.filename)
                    skip("scannerError")
                    continue
                if native.too_complex:
                    skip("tooComplex")
                natives.append(native)
                files_scanned += 1
                bytes_scanned += len(binary)
                for executable, subcommand, category in native.commands:
                    key = (executable, subcommand, category, "commandLikeString", "backend")
                    call_files[key] = call_files.get(key, 0) + 1
                for host, count in native.hosts.items():
                    backend_hosts[host] = backend_hosts.get(host, 0) + count
                backend_capabilities |= native.capabilities
                continue
            if not info.filename.lower().endswith(SCRIPT_SUFFIXES):
                skip("binaryAsset")
                continue
            if timed_out or clock() - started > budget:
                timed_out = True
                skip("unsupported")
                continue
            with archive.open(info) as stream:
                content = stream.read(SCAN_LIMITS["maxScriptBytes"] + 1)
            if len(content) > SCAN_LIMITS["maxScriptBytes"]:
                content = content[:SCAN_LIMITS["maxScriptBytes"]]
                truncated = True
            try:
                facts = scan_script(
                    content.decode("utf-8", "replace"),
                    max_path_length=SCAN_LIMITS["maxPathLength"],
                    deadline=deadline,
                )
            except ScanTimeout:
                timed_out = True
                continue
            except TooComplex:
                skip("tooComplex")
                continue
            except Exception:  # noqa: BLE001 - M1: one file's failure never drops the report
                _log.exception("script scan failed for %s", info.filename)
                skip("scannerError")
                continue
            any_script = True
            files_scanned += 1
            bytes_scanned += len(content)
            for call in facts.calls:
                key = (*call, "frontend")
                call_files[key] = call_files.get(key, 0) + 1
            merged.dynamic += facts.dynamic
            for host, count in facts.hosts.items():
                merged.hosts[host] = merged.hosts.get(host, 0) + count
            merged.capabilities |= facts.capabilities
            merged.read_paths |= facts.read_paths
            merged.write_paths |= facts.write_paths
            merged.dynamic_paths += facts.dynamic_paths
            merged.eval += facts.eval
            merged.new_function += facts.new_function
            merged.dynamic_import += facts.dynamic_import
            merged.string_timers += facts.string_timers
            merged.obfuscation_signals |= facts.obfuscation_signals
            if facts.dynamic:
                merged.dynamic_files += 1

    redactions = 0

    def keep(values: list[str]) -> list[str]:
        nonlocal redactions, truncated
        kept = []
        for value in values:
            if _redacted(value):
                redactions += 1
            else:
                kept.append(value)
        if len(kept) > limit:
            truncated = True
            kept = kept[:limit]
        return kept

    calls = []
    # The category breaks the last tie: without it two calls of one command
    # (gh api reading and writing) kept the order they were found in, which
    # follows set iteration and so changed with PYTHONHASHSEED.
    for (executable, subcommand, category, evidence, source), files in sorted(
        call_files.items(), key=lambda item: (item[0][0], item[0][1] or "", item[0][4], item[0][3], item[0][2])
    ):
        command = executable if subcommand is None else f"{executable} {subcommand}"
        if _redacted(command):
            redactions += 1
            continue
        calls.append({
            "executable": executable, "subcommand": subcommand, "category": category,
            "source": source, "evidence": evidence, "files": files,
        })
    # A command seen as a call site is not repeated as a mere string.
    sites = {(c["executable"], c["subcommand"], c["source"]) for c in calls if c["evidence"] == "callSite"}
    calls = [
        c for c in calls
        if c["evidence"] == "callSite" or (c["executable"], c["subcommand"], c["source"]) not in sites
    ]
    if len(calls) > limit:
        truncated = True
        calls = calls[:limit]
    host_entries = sorted(
        [(host, "frontend", count) for host, count in merged.hosts.items()]
        + [(host, "backend", count) for host, count in backend_hosts.items()]
    )
    kept_hosts = set(keep(sorted({host for host, _source, _count in host_entries})))
    host_entries = [entry for entry in host_entries if entry[0] in kept_hosts]
    capability_entries = sorted(
        [(address, "frontend") for address in merged.capabilities]
        + [(address, "backend") for address in backend_capabilities]
    )
    read_paths = keep(sorted(merged.read_paths))[: SCAN_LIMITS["maxPaths"]]
    write_paths = keep(sorted(merged.write_paths))[: SCAN_LIMITS["maxPaths"]]
    if len(merged.read_paths) > SCAN_LIMITS["maxPaths"] or len(merged.write_paths) > SCAN_LIMITS["maxPaths"]:
        truncated = True
    if redactions:
        skip("redacted", redactions)
    report: dict[str, Any] = {
        "schemaVersion": SCAN_SCHEMA_VERSION,
        "scanner": {"id": SCANNER_ID, "version": SCANNER_VERSION},
        "artifactDigest": artifact_digest,
        "target": target,
        "scannedAt": _timestamp(now or datetime.now(timezone.utc)),
        "coverage": {
            "filesTotal": files_total,
            "filesScanned": files_scanned,
            "bytesScanned": bytes_scanned,
            "skipped": [{"reason": reason, "count": skipped[reason]} for reason in sorted(skipped)],
            "truncated": truncated,
            "timedOut": timed_out,
        },
        "shell": {
            "calls": calls,
            "dynamic": {"count": merged.dynamic, "files": merged.dynamic_files},
        },
        "network": {"hosts": [
            {"host": host, "source": source, "count": count} for host, source, count in host_entries
        ][:limit]},
        "files": {"readPaths": read_paths, "writePaths": write_paths, "dynamicPaths": merged.dynamic_paths},
        "capabilities": [
            {"address": address, "source": source} for address, source in capability_entries
        ][:limit],
        "code": {
            "frontend": {
                "eval": merged.eval,
                "newFunction": merged.new_function,
                "dynamicImport": merged.dynamic_import,
                "stringTimers": merged.string_timers,
                "obfuscationSignals": sorted(merged.obfuscation_signals),
            } if any_script else None,
            "backend": None,
        },
        "native": [native.summary(limit) for native in natives],
    }
    return report  # type: ignore[return-value]

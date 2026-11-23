#!/usr/bin/env python3
"""Severity gate for pip-audit: block on high and critical, warn below.

pip-audit reports advisory ids but no severity, so on its own it can only
block on every advisory (a moderate ReDoS stops a release) or on none. This
reads pip-audit's JSON report and looks every advisory up in OSV
(https://api.osv.dev), the same database pip-audit queried:

  * each advisory is rated by the HIGHEST severity found across its own id
    and every alias (PYSEC, GHSA, CVE records of one bug often disagree —
    GitHub's reviewed rating can be MODERATE where the PYSEC CVSS is HIGH);
  * a record's severity is GitHub's reviewed ``database_specific.severity``
    when present, else its CVSS v3 base score computed from the vector;
  * high and critical fail the gate, low and moderate print a warning;
  * it fails closed: an advisory with no rating anywhere, an OSV lookup that
    fails, a missing or unreadable report, or pip-audit exiting with an error
    rather than "found vulnerabilities" all block, so the gate can never pass
    by not knowing.

Usage: pip-audit-severity-gate.py REPORT.json PIP_AUDIT_EXIT_CODE
Stdlib only, so it runs on a bare CI runner.
"""

from __future__ import annotations

import json
import math
import sys
import urllib.request
from collections.abc import Callable

OSV_URL = "https://api.osv.dev/v1/vulns/{}"
RANKS = {"LOW": 1, "MODERATE": 2, "MEDIUM": 2, "HIGH": 3, "CRITICAL": 4}
NAMES = {1: "LOW", 2: "MODERATE", 3: "HIGH", 4: "CRITICAL"}
BLOCK_AT = RANKS["HIGH"]

_AV = {"N": 0.85, "A": 0.62, "L": 0.55, "P": 0.2}
_AC = {"L": 0.77, "H": 0.44}
_UI = {"N": 0.85, "R": 0.62}
_CIA = {"H": 0.56, "L": 0.22, "N": 0.0}


def _roundup(x: float) -> float:
    """CVSS 3.1 Roundup: the smallest one-decimal number >= x, float-safe."""
    i = round(x * 100_000)
    return i / 100_000 if i % 10_000 == 0 else (math.floor(i / 10_000) + 1) / 10.0


def cvss3_base_score(vector: str) -> float | None:
    """Base score of a ``CVSS:3.x/...`` vector, or None if it is not one."""
    parts = vector.split("/")
    if not parts or not parts[0].startswith("CVSS:3"):
        return None
    m = dict(p.split(":", 1) for p in parts[1:] if ":" in p)
    try:
        changed = m["S"] == "C"
        pr = {"N": 0.85, "L": 0.68 if changed else 0.62, "H": 0.5 if changed else 0.27}[m["PR"]]
        iss = 1 - (1 - _CIA[m["C"]]) * (1 - _CIA[m["I"]]) * (1 - _CIA[m["A"]])
        expl = 8.22 * _AV[m["AV"]] * _AC[m["AC"]] * pr * _UI[m["UI"]]
    except KeyError:
        return None
    impact = 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15 if changed else 6.42 * iss
    if impact <= 0:
        return 0.0
    return _roundup(min((1.08 if changed else 1.0) * (impact + expl), 10.0))


def _score_rank(score: float) -> int:
    if score >= 9.0:
        return 4
    if score >= 7.0:
        return 3
    if score >= 4.0:
        return 2
    return 1 if score > 0 else 0


def record_rank(record: dict) -> int | None:
    """Severity rank one OSV record states, or None when it states none."""
    ranks: list[int] = []
    label = str((record.get("database_specific") or {}).get("severity") or "").upper()
    if label in RANKS:
        ranks.append(RANKS[label])
    for sev in record.get("severity") or []:
        if str(sev.get("type", "")).startswith("CVSS_V3"):
            score = cvss3_base_score(str(sev.get("score", "")))
            if score is not None:
                ranks.append(_score_rank(score))
    return max(ranks) if ranks else None


def fetch_osv(vuln_id: str) -> dict:
    req = urllib.request.Request(OSV_URL.format(vuln_id), headers={"User-Agent": "pip-audit-severity-gate"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def advisory_rank(ids: list[str], fetch: Callable[[str], dict]) -> tuple[int | None, list[str]]:
    """Highest rank across an advisory's ids, plus the ids OSV failed on."""
    best: int | None = None
    failed: list[str] = []
    for vid in ids:
        try:
            rank = record_rank(fetch(vid))
        except Exception:  # noqa: BLE001 — any lookup failure counts as unknown
            failed.append(vid)
            continue
        if rank is not None and (best is None or rank > best):
            best = rank
    return best, failed


def gate(report: dict, exit_code: int, fetch: Callable[[str], dict] = fetch_osv) -> tuple[bool, list[str]]:
    """(passes, annotation lines) for one pip-audit JSON report."""
    lines: list[str] = []
    blocked = False
    found = 0
    seen: set[tuple[str, str, str]] = set()
    for dep in report.get("dependencies") or []:
        for vuln in dep.get("vulns") or []:
            found += 1
            key = (str(dep.get("name")), str(dep.get("version")), vuln["id"])
            if key in seen:  # pip-audit can list one advisory twice for a package
                continue
            seen.add(key)
            ids = [vuln["id"], *[a for a in vuln.get("aliases") or [] if a != vuln["id"]]]
            rank, failed = advisory_rank(ids, fetch)
            fix = ", ".join(vuln.get("fix_versions") or []) or "none"
            where = f"{dep.get('name')} {dep.get('version')} {'/'.join(ids)} (fix: {fix})"
            if rank is None:
                blocked = True
                why = f"OSV lookup failed for {', '.join(failed)}" if failed else "no severity rating in OSV"
                lines.append(f"::error title=Dependency advisory (severity unknown)::{where} — {why}; blocking")
            elif rank >= BLOCK_AT:
                blocked = True
                lines.append(f"::error title=Dependency advisory ({NAMES[rank]})::{where}")
            else:
                lines.append(f"::warning title=Dependency advisory ({NAMES[rank]})::{where}")
    if exit_code not in (0, 1) or (exit_code == 1 and found == 0):
        blocked = True
        lines.append(f"::error title=pip-audit failed::pip-audit exited {exit_code} with {found} advisories reported")
    return not blocked, lines


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    try:
        with open(argv[1], encoding="utf-8") as fh:
            report = json.load(fh)
        exit_code = int(argv[2])
    except (OSError, ValueError) as err:
        print(f"::error title=pip-audit report unreadable::{err}")
        return 1
    ok, lines = gate(report, exit_code)
    for line in lines:
        print(line)
    print("pip-audit severity gate: " + ("pass" if ok else "BLOCKED (high/critical or unknown)"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))

"""scripts/pip-audit-severity-gate.py: block high/critical, warn below, fail closed."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

import pytest

_SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "pip-audit-severity-gate.py"
_spec = importlib.util.spec_from_file_location("pip_audit_severity_gate", _SCRIPT)
gate_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gate_mod)


@pytest.mark.parametrize(("vector", "score"), [
    ("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H", 7.5),
    ("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L", 5.3),
    ("CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:N/I:N/A:H", 5.9),
    ("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", 9.8),
    ("CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:C/C:L/I:L/A:N", 6.4),
    ("CVSS:3.0/AV:L/AC:L/PR:N/UI:R/S:U/C:N/I:N/A:N", 0.0),
])
def test_cvss3_base_scores_match_the_spec_calculator(vector: str, score: float) -> None:
    assert gate_mod.cvss3_base_score(vector) == score


def test_a_non_v3_vector_has_no_score() -> None:
    assert gate_mod.cvss3_base_score("CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N") is None


def _cvss(vector: str) -> dict:
    return {"severity": [{"type": "CVSS_V3", "score": vector}]}


HIGH = _cvss("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H")      # 7.5
MEDIUM = _cvss("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L")    # 5.3
CRITICAL = {"database_specific": {"severity": "CRITICAL"}}
LOW = {"database_specific": {"severity": "LOW"}}


def _report(*vulns: dict) -> dict:
    return {"dependencies": [{"name": "pkg", "version": "1.0", "vulns": list(vulns)}]}


def _vuln(vid: str, *aliases: str) -> dict:
    return {"id": vid, "aliases": list(aliases), "fix_versions": ["1.1"]}


def _fetch(records: dict[str, dict]):
    def fetch(vid: str) -> dict:
        if vid not in records:
            raise OSError(f"404 {vid}")
        return records[vid]
    return fetch


def test_clean_report_passes() -> None:
    ok, lines = gate_mod.gate({"dependencies": [{"name": "pkg", "version": "1", "vulns": []}]}, 0, _fetch({}))
    assert ok and lines == []


def test_moderate_and_low_only_warn() -> None:
    ok, lines = gate_mod.gate(_report(_vuln("A"), _vuln("B")), 1, _fetch({"A": MEDIUM, "B": LOW}))
    assert ok
    assert [line.split("::")[1] for line in lines] == [
        "warning title=Dependency advisory (MODERATE)", "warning title=Dependency advisory (LOW)",
    ]


@pytest.mark.parametrize("record", [HIGH, CRITICAL])
def test_high_and_critical_block(record: dict) -> None:
    ok, lines = gate_mod.gate(_report(_vuln("A"), _vuln("B")), 1, _fetch({"A": MEDIUM, "B": record}))
    assert not ok
    assert lines[1].startswith("::error")


def test_the_highest_rating_across_aliases_wins() -> None:
    """GitHub may review an advisory as MODERATE while its PYSEC alias's CVSS is HIGH."""
    records = {"GHSA-x": {"database_specific": {"severity": "MODERATE"}}, "PYSEC-x": HIGH}
    ok, _ = gate_mod.gate(_report(_vuln("PYSEC-x", "GHSA-x")), 1, _fetch(records))
    assert not ok


def test_an_advisory_listed_twice_is_reported_once() -> None:
    ok, lines = gate_mod.gate(_report(_vuln("A"), _vuln("A")), 1, _fetch({"A": MEDIUM}))
    assert ok and len(lines) == 1


def test_an_alias_lookup_failure_does_not_hide_a_known_rating() -> None:
    ok, lines = gate_mod.gate(_report(_vuln("A", "CVE-missing")), 1, _fetch({"A": MEDIUM}))
    assert ok and "MODERATE" in lines[0]


@pytest.mark.parametrize("records", [{}, {"A": {"severity": []}}])
def test_unknown_severity_fails_closed(records: dict) -> None:
    ok, lines = gate_mod.gate(_report(_vuln("A")), 1, _fetch(records))
    assert not ok and "severity unknown" in lines[0]


@pytest.mark.parametrize("exit_code", [1, 2])
def test_a_pip_audit_error_with_no_findings_blocks(exit_code: int) -> None:
    ok, lines = gate_mod.gate({"dependencies": []}, exit_code, _fetch({}))
    assert not ok and "pip-audit failed" in lines[-1]


def test_main_blocks_on_a_missing_report(tmp_path: Path) -> None:
    assert gate_mod.main(["gate", str(tmp_path / "absent.json"), "0"]) == 1


def test_main_passes_a_clean_report(tmp_path: Path) -> None:
    report = tmp_path / "r.json"
    report.write_text(json.dumps({"dependencies": [], "fixes": []}))
    assert gate_mod.main(["gate", str(report), "0"]) == 0

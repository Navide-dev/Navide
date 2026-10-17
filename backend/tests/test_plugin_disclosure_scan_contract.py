"""The Python twin of src/shared/pluginDisclosureScan.test.ts: both are held
to docs/plugin-contracts/agent-tools-fixtures/scan-cases.json."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import pytest

from agent_team_backend.plugins import disclosure_contract as disclosure
from agent_team_backend.plugins import disclosure_scan_contract as scan

FIXTURES = Path(__file__).resolve().parents[2] / "docs" / "plugin-contracts" / "agent-tools-fixtures"
_FIXTURE = json.loads((FIXTURES / "scan-cases.json").read_text(encoding="utf-8"))
_MANIFESTS = {
    case["name"]: case["manifest"]
    for case in json.loads((FIXTURES / "disclosure-cases.json").read_text(encoding="utf-8"))["cases"]
}
_SCANS = {case["name"]: case["scan"] for case in _FIXTURE["cases"]}


def test_constants_match_the_shared_fixture() -> None:
    assert list(scan.DISCLOSURE_ENVELOPE_FIELDS) == _FIXTURE["disclosureEnvelopeFields"]
    assert scan.SCAN_LIMITS == _FIXTURE["scanLimits"]
    assert [list(rule) for rule in scan.SCAN_RISK_RULES] == _FIXTURE["scanRiskRules"]
    assert list(scan.SHELL_CATEGORY_ORDER) == _FIXTURE["shellCategoryOrder"]
    assert scan.SCANNER_ID == _FIXTURE["scannerId"]
    assert list(scan.INCOMPLETE_SKIP_REASONS) == _FIXTURE["incompleteSkipReasons"]


@pytest.mark.parametrize("case", _FIXTURE["classify"], ids=lambda c: f"{c['executable']} {c['args']}")
def test_classify_shell_command(case: dict[str, Any]) -> None:
    assert list(scan.classify_shell_command(case["executable"], case["args"])) == case["expected"]


@pytest.mark.parametrize("case", _FIXTURE["globs"], ids=lambda c: f"{c['pattern']}~{c['path']}")
def test_scope_pattern_matches(case: dict[str, Any]) -> None:
    assert scan.scope_pattern_matches(case["pattern"], case["path"]) is case["matches"]


@pytest.mark.parametrize("case", _FIXTURE["cases"], ids=lambda c: c["name"])
def test_derived_values_of_a_scan_report(case: dict[str, Any]) -> None:
    computed = disclosure.compute_disclosure(_MANIFESTS[case["disclosureCase"]])
    report = case["scan"]
    expected = case["expected"]
    assert scan.scan_sentences(report) == expected["sentences"]
    assert scan.scan_risk_reasons(report, computed) == expected["riskReasons"]
    assert scan.card_risk_level(computed, report) == expected["cardRiskLevel"]
    assert scan.declared_vs_scanned(computed, report) == expected["declaredVsScanned"]
    assert scan.scan_items(report) == expected["items"]


def test_an_absent_kind_is_never_an_empty_list() -> None:
    keys = [sentence["key"] for sentence in scan.scan_sentences(_SCANS["nothing-found"])]
    assert keys == ["notFound.shell", "notFound.network", "notFound.files", "notFound.dynamicCode", "coverage"]


def test_without_a_scan_the_card_level_is_the_manifest_level() -> None:
    computed = disclosure.compute_disclosure(_MANIFESTS["ui-only"])
    assert scan.card_risk_level(computed, None) == computed["risk"]["level"]


@pytest.mark.parametrize("case", _FIXTURE["diffs"], ids=lambda c: f"{c['from']}->{c['to']}")
def test_diff_scan(case: dict[str, Any]) -> None:
    old = _SCANS[case["from"]] if case["from"] else None
    assert scan.diff_scan(old, _SCANS[case["to"]]) == case["expected"]


def test_scan_digest_is_sha256_of_the_canonical_spelling() -> None:
    spelling = disclosure.canonical_contract_json(_SCANS[_FIXTURE["scanDigestCase"]])
    assert hashlib.sha256(spelling.encode("ascii")).hexdigest() == _FIXTURE["scanDigestExpected"]

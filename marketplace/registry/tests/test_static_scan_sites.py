"""Scanner 1.2.0: every frontend finding carries where it was seen.

The sites are additive: everything a 1.1.0 report said is unchanged (the
fixture parity in test_static_scan_fixtures holds every existing field), and
an update diff or a rescan notice never treats a site as a new finding.
"""

from __future__ import annotations

import hashlib
import io
import json
import time
import zipfile
from datetime import datetime, timezone

from registry.plugin_contract import disclosure_scan_contract
from registry.publisher_web import scan_sites
from registry.static_scan import SCANNER_VERSION, js_tokens, scan_package
from registry.static_scan.js_scan import EXCERPT_LENGTH, MAX_SITES_PER_FINDING, locate

NOW = datetime(2026, 11, 10, tzinfo=timezone.utc)
MANIFEST = {"schemaVersion": 2, "id": "acme.scoped", "version": "1.0.0", "publisher": "acme"}
# A fake GitHub token, built at run time so no secret-shaped literal is in the source.
TOKEN = "gh" + "p_" + "B" * 36


def _scan(files: dict[str, str | bytes], manifest: dict = MANIFEST) -> dict:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("manifest.json", json.dumps(manifest))
        for name, data in files.items():
            archive.writestr(name, data)
    data = buffer.getvalue()
    report = scan_package(data, artifact_digest=hashlib.sha256(data).hexdigest(), target="universal",
                          manifest=manifest, now=NOW)
    assert report is not None
    return report


def _host(report: dict, host: str) -> dict:
    return next(entry for entry in report["network"]["hosts"] if entry["host"] == host)


def test_scanner_version_is_1_2_0() -> None:
    assert SCANNER_VERSION == "1.2.0"
    assert _scan({"a.js": "1"})["scanner"]["version"] == "1.2.0"


def test_token_start_is_not_part_of_equality() -> None:
    first, second = js_tokens.tokenize("'a' 'a'")
    assert (first.start, second.start) == (0, 4)
    assert first == second


def test_host_command_and_capability_sites() -> None:
    report = _scan({"frontend/a.js": "// x\nconst u =\n  'https://api.example.com/v1';\n"
                                     "invoke('shell.run', {command: 'git push'})"})
    assert _host(report, "api.example.com")["sites"] == [
        {"file": "frontend/a.js", "line": 3, "col": 3, "excerpt": "'https://api.example.com/v1';"},
    ]
    call = report["shell"]["calls"][0]
    assert (call["evidence"], call["sites"][0]["line"], call["sites"][0]["col"]) == ("callSite", 4, 31)
    capability = report["capabilities"][0]
    assert capability["address"] == "shell.run"
    assert capability["sites"][0]["excerpt"] == "invoke('shell.run', {command: 'git push'})"


def test_column_counts_code_points() -> None:
    report = _scan({"a.js": "😀😀'https://e.example.com'"})
    assert _host(report, "e.example.com")["sites"][0]["col"] == 3


def test_at_most_three_sites_per_finding_across_files() -> None:
    files = {f"f{n}.js": "'https://h.example.com';\n" * 4 for n in range(3)}
    entry = _host(_scan(files), "h.example.com")
    assert entry["count"] == 12
    assert [(site["file"], site["line"]) for site in entry["sites"]] == [("f0.js", 1), ("f0.js", 2), ("f0.js", 3)]
    assert len(entry["sites"]) == MAX_SITES_PER_FINDING


def test_excerpt_is_bounded_and_whitespace_collapsed() -> None:
    text = "x = 1;" * 100 + "  fetch(\t'https://long.example.com/'  +  '" + "w" * 1000 + "')"
    site = _host(_scan({"a.js": text}), "long.example.com")["sites"][0]
    assert len(site["excerpt"]) == EXCERPT_LENGTH
    assert "\t" not in site["excerpt"] and "  " not in site["excerpt"]
    assert "fetch( 'https://long.example.com/'" in site["excerpt"]


def test_excerpt_near_a_secret_is_hidden_and_not_counted() -> None:
    report = _scan({"a.js": f"const k = '{TOKEN}';" + " " * 100 + "fetch('https://s.example.com/')"})
    site = _host(report, "s.example.com")["sites"][0]
    assert site["excerpt"] is None
    assert (site["line"], site["col"]) == (1, 160)
    # Redaction counts are unchanged by sites: nothing found was dropped.
    assert report["coverage"]["skipped"] == []


def test_backend_findings_have_empty_sites() -> None:
    manifest = {**MANIFEST, "backend": {"entry": "backend/run.sh"}}
    report = _scan({"backend/run.sh": b"#!/bin/sh\nexec node https://cdn.example.org/x.js\n"}, manifest)
    backend = [entry for entry in report["network"]["hosts"] if entry["source"] == "backend"]
    assert backend and all(entry["sites"] == [] for entry in backend)


def test_locate_is_linear_on_one_huge_line() -> None:
    text = "a" * 20_000_000
    offsets = list(range(0, len(text), len(text) // 600))
    started = time.monotonic()
    located = locate(text, offsets, lambda _value: False)
    assert time.monotonic() - started < 5
    assert located[offsets[-1]][:2] == (1, offsets[-1] + 1)


def test_sites_are_not_new_scan_items() -> None:
    old = _scan({"a.js": "'https://h.example.com'"})
    new = json.loads(json.dumps(old))
    new["network"]["hosts"][0]["sites"] = [{"file": "b.js", "line": 9, "col": 9, "excerpt": "x"}]
    assert disclosure_scan_contract.diff_scan(old, new)["added"] == []
    for entry in old["network"]["hosts"]:
        entry.pop("sites")
    assert disclosure_scan_contract.diff_scan(old, new)["widened"] is False


def test_dashboard_lists_sites_and_reads_old_reports() -> None:
    report = _scan({"a.js": "'https://h.example.com'"})
    assert scan_sites(report, "universal") == [{
        "kind": "host", "key": "h.example.com", "target": "universal",
        "file": "a.js", "line": 1, "col": 1, "excerpt": "'https://h.example.com'",
    }]
    for entry in report["network"]["hosts"]:
        entry.pop("sites")
    assert scan_sites(report, "universal") == []
    assert scan_sites(None, "universal") == []


# Pinned in src/main/plugins/marketplaceQuery.scanSites.test.ts too: an excerpt
# with an astral character is spelled the same by both canonical JSONs, so the
# Host's scanDigest check accepts a 1.2.0 report.
FINDING_SITES_DIGEST = "f6b13e7510110475081b42ae0b2eeb11c8562ca50f9c0745626d200d1da6a97a"


def test_scan_digest_of_non_ascii_excerpts_is_pinned() -> None:
    from pathlib import Path

    from registry.disclosure import scan_digest

    cases = json.loads((Path(__file__).resolve().parents[3] / "docs/plugin-contracts/static-scan-fixtures/cases.json").read_text("utf-8"))
    expected = next(c for c in cases["cases"] if c["name"] == "finding-sites")["expected"]
    assert any("😀" in (s["excerpt"] or "") for c in expected["capabilities"] for s in c["sites"])
    assert scan_digest({**expected, "scannedAt": "2026-11-10T00:00:00Z"}) == FINDING_SITES_DIGEST

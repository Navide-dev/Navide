"""The shared static scan fixtures (docs/plugin-contracts/static-scan-fixtures).

The JavaScript port `scanPackageFiles` (packages/plugin-contracts/src/staticScan.ts)
is held to the same cases, so `navide-plugin scan` and the App's local-install
card report what the Registry signs. Regenerate with generate.py beside the file.
"""

from __future__ import annotations

import base64
import io
import json
import os
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

from registry.static_scan import scan_package

FIXTURE = Path(__file__).resolve().parents[3] / "docs" / "plugin-contracts" / "static-scan-fixtures" / "cases.json"
DOCUMENT = json.loads(FIXTURE.read_text(encoding="utf-8"))


def _bytes(entry: dict) -> bytes:
    if "base64" in entry:
        return base64.b64decode(entry["base64"])
    return ("".join(entry["textParts"]) if "textParts" in entry else entry["text"]).encode("utf-8")


@pytest.mark.parametrize("case", DOCUMENT["cases"], ids=lambda case: case["name"])
def test_the_registry_scanner_matches_the_shared_fixture(case: dict) -> None:
    assert _report(case) == case["expected"]


def _report(case: dict) -> dict | None:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("manifest.json", json.dumps(case["manifest"]))
        for name, entry in case["files"].items():
            archive.writestr(name, _bytes(entry))
    report = scan_package(
        buffer.getvalue(), artifact_digest=DOCUMENT["artifactDigest"], target=case["target"], manifest=case["manifest"]
    )
    if report is not None:
        del report["scannedAt"]
    return report


def test_the_report_does_not_depend_on_the_hash_seed() -> None:
    # "call-sites" has `gh api` as both a read and a write call site; the
    # scanner collects call sites in a set, so only the sort fixes their order.
    script = (
        "import json, sys; sys.path.insert(0, sys.argv[1]); import test_static_scan_fixtures as t; "
        "print(json.dumps(t._report(next(c for c in t.DOCUMENT['cases'] if c['name'] == 'call-sites'))))"
    )
    outputs = set()
    for seed in range(8):
        result = subprocess.run(
            [sys.executable, "-c", script, str(Path(__file__).parent)],
            env={**os.environ, "PYTHONHASHSEED": str(seed)}, capture_output=True, text=True, check=True,
        )
        outputs.add(result.stdout)
    assert len(outputs) == 1

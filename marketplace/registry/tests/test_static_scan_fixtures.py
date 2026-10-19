"""The shared static scan fixtures (docs/plugin-contracts/static-scan-fixtures).

The JavaScript port `scanPackageFiles` (packages/plugin-contracts/src/staticScan.ts)
is held to the same cases, so `navide-plugin scan` and the App's local-install
card report what the Registry signs. Regenerate with generate.py beside the file.
"""

from __future__ import annotations

import base64
import io
import json
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
    assert report == case["expected"]

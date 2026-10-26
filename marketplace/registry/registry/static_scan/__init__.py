"""Publish-time static scan of package contents (contract 3.8, plan B D-S).

`run_scan` is what publishing calls; `scan_stored_version` rescans a stored
artifact (review approval, admin rescan). A scanner failure never fails a
publish and never drops the report: a failed file is recorded as
`scannerError`, and a scan that fails as a whole becomes an incomplete report.
"""

from __future__ import annotations

import hashlib
import logging

from ..models import ExtensionVersion
from ..storage import StorageBackend
from .report import SCANNER_VERSION, failed_report, scan_package

__all__ = ["SCANNER_VERSION", "run_scan", "scan_package", "scan_stored_version"]

_log = logging.getLogger(__name__)


def run_scan(data: bytes, *, artifact_digest: str, target: str, manifest: dict) -> dict | None:
    """The scan report of a Manifest v2 artifact (None only for v1, which has
    no disclosure). A failure of the whole scan still yields an incomplete
    report (M1 of the #355 review), never a missing one."""
    try:
        return scan_package(data, artifact_digest=artifact_digest, target=target, manifest=manifest)  # type: ignore[return-value]
    except Exception:  # noqa: BLE001 - see the docstring
        _log.exception("static scan failed for %s (%s)", artifact_digest, target)
        if manifest.get("schemaVersion") != 2:
            return None
        return failed_report(artifact_digest=artifact_digest, target=target)  # type: ignore[return-value]


def scan_stored_version(storage: StorageBackend, row: ExtensionVersion) -> dict | None:
    """Rescan a stored artifact. The report binds the digest of the bytes
    actually read from storage (L1), so a stored package that no longer
    matches its signed digest cannot be signed again (sign_disclosure
    refuses a report of another artifact)."""
    data = storage.get(row.package_key)
    return run_scan(
        data,
        artifact_digest=hashlib.sha256(data).hexdigest(),
        target=row.target,
        manifest=row.manifest or {},
    )

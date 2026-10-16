"""Publish-time static scan of package contents (contract 3.8, plan B D-S).

`run_scan` is what publishing calls; `scan_stored_version` rescans a stored
artifact (review approval, admin rescan). A scanner failure never fails a
publish: the version is then published without a scan report, and its card
says it was not scanned.
"""

from __future__ import annotations

import logging

from ..models import ExtensionVersion
from ..storage import StorageBackend
from .report import SCANNER_VERSION, scan_package

__all__ = ["SCANNER_VERSION", "run_scan", "scan_package", "scan_stored_version"]

_log = logging.getLogger(__name__)


def run_scan(data: bytes, *, artifact_digest: str, target: str, manifest: dict) -> dict | None:
    try:
        return scan_package(data, artifact_digest=artifact_digest, target=target, manifest=manifest)  # type: ignore[return-value]
    except Exception:  # noqa: BLE001 - see the module docstring
        _log.exception("static scan failed for %s (%s)", artifact_digest, target)
        return None


def scan_stored_version(storage: StorageBackend, row: ExtensionVersion) -> dict | None:
    return run_scan(
        storage.get(row.package_key),
        artifact_digest=row.package_digest,
        target=row.target,
        manifest=row.manifest or {},
    )

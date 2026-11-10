"""Publish notices for views that declare ``headless: true`` (0.2.40).

A Navide Host before 0.2.40 does not know the key and refuses the manifest,
so a package that declares it should require Navide >=0.2.40. The Registry
says so at publish and accepts the package either way (disclose, don't
restrict)."""

from __future__ import annotations

from typing import TYPE_CHECKING

from .discovery import min_navide_version
from .versions import compare_semver

if TYPE_CHECKING:
    from .manifest import ManifestV2

MIN_NAVIDE_FOR_HEADLESS_VIEWS = "0.2.40"

HEADLESS_ENGINES_NOTICE = (
    "A view declares headless: true, which Navide before "
    f"{MIN_NAVIDE_FOR_HEADLESS_VIEWS} does not understand: those versions refuse to install "
    f"this package. Require Navide >={MIN_NAVIDE_FOR_HEADLESS_VIEWS} in engines.navide."
)


def headless_view_notices(manifest: ManifestV2) -> list[str]:
    """The notice when a view declares headless and engines.navide allows an older Navide."""
    views = manifest.contributes.views if manifest.contributes else []
    if not any(view.headless for view in views):
        return []
    minimum = min_navide_version(manifest.engines.navide if manifest.engines else None)
    if minimum is not None and compare_semver(minimum, MIN_NAVIDE_FOR_HEADLESS_VIEWS) >= 0:
        return []
    return [HEADLESS_ENGINES_NOTICE]

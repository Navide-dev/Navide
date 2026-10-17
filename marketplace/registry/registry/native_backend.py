"""Publishing rules for packages that carry a native backend.

A third-party backend is native code that will run on users' machines, so a
self-claimed publisher (one whose submissions are reviewed) may upload one
only when an admin allowlisted it AND it proved a domain through DNS. It must
require a Navide version that sandboxes third-party backends. It may also
request `shell: "allowlist"` (DB5: disclosed as high risk, not refused); its
backend then reaches git/gh/glab only through the Host shell broker, so it must
require a Navide version that has that broker port. `shell: "full"` stays
unavailable to a backend: the broker serves only the allowlist. Admin-created
(official) publishers are unaffected: their first-party backends keep their
existing path.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from sqlmodel import Session, select

from .discovery import min_navide_version
from .models import Publisher
from .versions import compare_semver

if TYPE_CHECKING:
    from .manifest import ManifestV2

MIN_NAVIDE_FOR_THIRD_PARTY_BACKEND = "0.2.14"
"""First Navide release that launches third-party backends in the OS sandbox.
Older Hosts never start them, so a listing they could install would only fail."""

MIN_NAVIDE_FOR_BACKEND_SHELL = "0.2.25"
"""First Navide release whose Host gives a sandboxed backend the shell broker
port. Older Hosts refuse to start a backend that declares shell."""


def native_backend_publish_problem(publisher: Publisher, manifest: ManifestV2) -> str | None:
    """Why this publisher may not publish this backend package, or None."""
    if manifest.backend is None or not publisher.review_required:
        return None
    if not publisher.native_backend_allowed:
        return (
            "publishing a native backend requires an admin to allow this publisher "
            "(native backend allowlist)"
        )
    if publisher.domain_verified_at is None:
        return "publishing a native backend requires a verified publisher domain"
    if not manifest.backend.methods:
        return "a native backend must declare the methods it serves in backend.methods"
    if manifest.permissions.shell == "full":
        return (
            "a package with a native backend cannot request full shell access; "
            'declare shell: "allowlist" (git, gh, glab through the Host broker)'
        )
    minimum = min_navide_version(manifest.engines.navide if manifest.engines else None)
    if minimum is None or compare_semver(minimum, MIN_NAVIDE_FOR_THIRD_PARTY_BACKEND) < 0:
        return (
            "a package with a native backend must require Navide "
            f">={MIN_NAVIDE_FOR_THIRD_PARTY_BACKEND} in engines.navide"
        )
    if manifest.permissions.shell == "allowlist" and compare_semver(minimum, MIN_NAVIDE_FOR_BACKEND_SHELL) < 0:
        return (
            "a package with a native backend that requests shell access must require Navide "
            f">={MIN_NAVIDE_FOR_BACKEND_SHELL} in engines.navide"
        )
    return None


def self_service_publishers(session: Session) -> list[Publisher]:
    """Publishers the native backend allowlist applies to, by name."""
    return list(
        session.exec(
            select(Publisher).where(Publisher.review_required == True).order_by(Publisher.name)  # noqa: E712
        ).all()
    )


def set_native_backend_allowed(session: Session, name: str, allowed: bool) -> Publisher | None:
    publisher = session.exec(select(Publisher).where(Publisher.name == name)).first()
    if publisher is None or not publisher.review_required:
        return None
    publisher.native_backend_allowed = allowed
    session.add(publisher)
    session.commit()
    session.refresh(publisher)
    return publisher

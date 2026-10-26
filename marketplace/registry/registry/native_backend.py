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

A local (self-hosted-dev) Registry has no self-claimed publishers: a developer
registers with the admin token instead. So that a local publish fails where the
Marketplace would, it applies the package rules above to every publisher, and
says in the publish response that it did not run the allowlist and domain gates.
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


LOCAL_NATIVE_BACKEND_NOTICE = (
    "This local Registry checked the native backend package rules only. On the Navide "
    "Marketplace a self-claimed publisher also needs an admin to allow it to publish a "
    "native backend and a verified publisher domain."
)
"""Publish-response notice for a backend package a local Registry accepted from an
admin-created publisher: the gates it skipped, so passing here is not mistaken
for passing the Marketplace."""


def native_backend_publish_problem(
    publisher: Publisher, manifest: ManifestV2, *, local: bool = False
) -> str | None:
    """Why this publisher may not publish this backend package, or None.

    `local` (a self-hosted-dev Registry) applies the package rules to
    admin-created publishers too."""
    if manifest.backend is None:
        return None
    if not publisher.review_required:
        return _backend_package_problem(manifest) if local else None
    if not publisher.native_backend_allowed:
        return (
            "publishing a native backend requires an admin to allow this publisher "
            "(native backend allowlist)"
        )
    if publisher.domain_verified_at is None:
        return "publishing a native backend requires a verified publisher domain"
    return _backend_package_problem(manifest)


def local_native_backend_notices(publisher: Publisher, manifest: ManifestV2, *, local: bool) -> list[str]:
    """What a local Registry's acceptance of this package does not cover."""
    if local and manifest.backend is not None and not publisher.review_required:
        return [LOCAL_NATIVE_BACKEND_NOTICE]
    return []


def _backend_package_problem(manifest: ManifestV2) -> str | None:
    """The rules a backend package itself must meet, whoever publishes it."""
    assert manifest.backend is not None
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

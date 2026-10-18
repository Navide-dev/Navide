"""SQLModel data model for the registry.

Persistence is SQLite for the local/dev slice; all access goes through
`repository.RegistryRepository` so a different store can replace it later.
"""

from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import JSON, Column, Index, UniqueConstraint, text
from sqlmodel import Field, SQLModel


def _now() -> datetime:
    return datetime.now(timezone.utc)


class Publisher(SQLModel, table=True):
    __tablename__ = "publisher"

    id: int | None = Field(default=None, primary_key=True)
    name: str = Field(index=True, unique=True)
    """The publisher namespace (lowercase)."""
    display_name: str | None = None
    public_key: str | None = None
    """Registered Ed25519 public key (PEM); used to verify package signatures."""
    token_hash: str | None = Field(default=None, index=True)
    """sha256 of the publisher's bearer token; None until a token is issued."""
    navide_member_id: str | None = Field(default=None, index=True)
    """Navide Cloud account that claimed this namespace (None: admin-created).
    Not unique: one account may own up to MAX_NAMESPACES_PER_ACCOUNT."""
    review_required: bool = Field(default=False)
    """Submissions wait for admin review. True for self-claimed namespaces;
    admin-created (official) publishers stay auto-approved."""
    verified_domain: str | None = None
    """Domain the publisher asked to verify (DNS TXT), verified or not."""
    domain_token: str | None = None
    """Random value expected in `_navide-verify.<domain>` TXT."""
    domain_verified_at: datetime | None = None
    """Set once the TXT record matched; cleared when the domain changes."""
    native_backend_allowed: bool = Field(default=False, sa_column_kwargs={"server_default": text("0")})
    """Admin allowlist for publishing native backends (see native_backend.py)."""
    created_at: datetime = Field(default_factory=_now)


class Extension(SQLModel, table=True):
    __tablename__ = "extension"
    __table_args__ = (UniqueConstraint("namespace", "name", name="uq_extension_identity"),)

    id: int | None = Field(default=None, primary_key=True)
    publisher_id: int = Field(foreign_key="publisher.id", index=True)
    namespace: str = Field(index=True)
    name: str = Field(index=True)
    identity: str = Field(index=True, unique=True)
    """`namespace.name`."""
    display_name: str | None = None
    description: str | None = None
    categories: list[str] = Field(default_factory=list, sa_column=Column(JSON))
    featured: bool = Field(default=False, index=True)
    """Curation flag surfaced in the marketplace Featured section (admin-set)."""
    download_count: int = Field(default=0)
    """Aggregate downloads across all versions of this extension."""
    rating_sum: int = Field(default=0)
    """Sum of member rating scores (ExtensionRating); average = sum / count."""
    rating_count: int = Field(default=0)
    """Number of member ratings (ExtensionRating rows)."""
    legacy_rating_sum: int = Field(default=0, sa_column_kwargs={"server_default": text("0")})
    legacy_rating_count: int = Field(default=0, sa_column_kwargs={"server_default": text("0")})
    """Anonymous ratings submitted before ratings required sign-in (migration
    6). Kept for audit only; excluded from the public aggregate."""
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)


class ExtensionVersion(SQLModel, table=True):
    """One row per published artifact: a version carries either one `universal`
    artifact or one artifact per platform target (enforced at publish)."""

    __tablename__ = "extension_version"
    __table_args__ = (
        UniqueConstraint(
            "extension_id", "version", "target", name="uq_version_target_identity"
        ),
    )

    id: int | None = Field(default=None, primary_key=True)
    extension_id: int = Field(foreign_key="extension.id", index=True)
    version: str = Field(index=True)
    manifest: dict = Field(default_factory=dict, sa_column=Column(JSON))
    """Frozen snapshot of the manifest at publish time."""
    package_digest: str
    """sha256 hex of the uploaded package."""
    package_key: str
    """Storage key for the package blob."""
    signature: str | None = None
    """Detached Ed25519 signature (base64) over the package digest, if signed."""
    target: str = Field(default="universal", index=True)
    registry_envelope: dict = Field(default_factory=dict, sa_column=Column(JSON))
    """Immutable artifact identity envelope signed by the registry."""
    registry_signature: str | None = None
    """Detached Ed25519 signature over canonical registry_envelope JSON."""
    trust_tier: str = Field(default="unsigned", index=True)
    """Trust tier computed at publish: 'signed-verified' or 'unsigned' (see trust.py)."""
    download_count: int = Field(default=0)
    """Number of times this specific version's package was downloaded."""
    yanked: bool = Field(default=False, index=True)
    channel: str = Field(
        default="stable", index=True, sa_column_kwargs={"server_default": "stable"}
    )
    """'stable' | 'pre-release' (derived from SemVer at publish) | 'testplace'
    (versions.py). Public reads never return a testplace row."""
    expires_at: datetime | None = None
    """When a testplace version stops being installable; None otherwise."""
    published_at: datetime = Field(default_factory=_now)
    review_status: str = Field(default="approved", index=True)
    """'pending' | 'approved' | 'rejected' (review.py). Only approved rows are
    registry-signed and visible through public reads."""
    review_reason: str | None = None
    """Rejection reason shown to the publisher."""
    reviewed_at: datetime | None = None
    reviewed_by: str | None = None
    review_report: dict = Field(default_factory=dict, sa_column=Column(JSON))
    """Automatic checks run at submission (similarity, secret scan, limits).
    Holds locations and rule names only, never a matched secret value."""
    disclosure: dict | None = Field(default=None, sa_column=Column(JSON, nullable=True))
    """Manifest disclosure (contract 3.1) computed when the row was signed;
    None for a v1 manifest, an unsigned row or a row signed before D-a."""
    disclosure_envelope: dict | None = Field(default=None, sa_column=Column(JSON, nullable=True))
    """Disclosure envelope (contract 3.5) signed with the package envelope."""
    disclosure_signature: str | None = None
    """Detached Ed25519 signature over canonical disclosure_envelope JSON."""
    scan: dict | None = Field(default=None, sa_column=Column(JSON, nullable=True))
    """Static scan report (contract 3.8) signed through `scanDigest`; None
    until the Registry has a scanner (DS8)."""


class ExtensionAsset(SQLModel, table=True):
    __tablename__ = "extension_asset"

    id: int | None = Field(default=None, primary_key=True)
    version_id: int = Field(foreign_key="extension_version.id", index=True)
    path: str
    """Archive-relative path."""
    size: int
    content_type: str


class PublisherToken(SQLModel, table=True):
    """Short-lived, revocable publish token scoped to one namespace."""

    __tablename__ = "publisher_token"

    id: int | None = Field(default=None, primary_key=True)
    publisher_id: int = Field(foreign_key="publisher.id", index=True)
    label: str
    token_hash: str = Field(index=True, unique=True)
    created_at: datetime = Field(default_factory=_now)
    expires_at: datetime
    revoked_at: datetime | None = None
    last_used_at: datetime | None = None


class BlocklistEntry(SQLModel, table=True):
    """Admin-managed removal, merged with the trust config's blocklists."""

    __tablename__ = "blocklist_entry"
    __table_args__ = (UniqueConstraint("kind", "value", name="uq_blocklist_entry"),)

    id: int | None = Field(default=None, primary_key=True)
    kind: str
    """'publisher' (a namespace) or 'package' (`ns.name` or `ns.name@version`)."""
    value: str
    reason: str
    created_at: datetime = Field(default_factory=_now)
    created_by: str | None = None


class CliAuthCode(SQLModel, table=True):
    """One-time code handed to `navide-plugin login` through its loopback
    redirect and exchanged, with the PKCE verifier, for a publish token."""

    __tablename__ = "cli_auth_code"

    id: int | None = Field(default=None, primary_key=True)
    code_hash: str = Field(index=True, unique=True)
    publisher_id: int = Field(foreign_key="publisher.id")
    code_challenge: str
    label: str
    expires_at: datetime
    used_at: datetime | None = None


class MemberSession(SQLModel, table=True):
    """Per-account session generation. A session cookie carries the version
    it was issued under; signing out bumps it, which revokes every session of
    that account at once (cookies are otherwise stateless for 12 h)."""

    __tablename__ = "member_session"

    member_id: str = Field(primary_key=True)
    version: int = Field(default=0)


class ExtensionRating(SQLModel, table=True):
    """One 1-5 rating per Navide Cloud member per extension (ratings.py)."""

    __tablename__ = "extension_rating"
    __table_args__ = (
        UniqueConstraint("extension_id", "member_id", name="uq_extension_rating_member"),
    )

    id: int | None = Field(default=None, primary_key=True)
    extension_id: int = Field(foreign_key="extension.id", index=True)
    member_id: str = Field(index=True)
    score: int
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)


class ExtensionReport(SQLModel, table=True):
    """A member's report about an extension (or one version), reports.py.
    The reporter is never shown to the publisher."""

    __tablename__ = "extension_report"
    __table_args__ = (
        # One open report per member per extension.
        Index(
            "uq_extension_report_open",
            "extension_id",
            "reporter_member_id",
            unique=True,
            sqlite_where=text("status = 'open'"),
        ),
    )

    id: int | None = Field(default=None, primary_key=True)
    extension_id: int = Field(foreign_key="extension.id", index=True)
    version: str | None = None
    reporter_member_id: str = Field(index=True)
    reason: str
    """'malware' | 'impersonation' | 'spam' | 'broken' | 'other'."""
    detail: str = ""
    status: str = Field(default="open", index=True)
    """'open' | 'dismissed' | 'actioned'."""
    created_at: datetime = Field(default_factory=_now)
    resolved_at: datetime | None = None
    resolved_by: str | None = None
    resolution: str | None = None
    """The action taken: 'dismiss' | 'yank' | 'block-package' | 'block-publisher'."""
    resolution_note: str | None = None


class ReportAuditEntry(SQLModel, table=True):
    """Append-only trail of every report event: who, when, what."""

    __tablename__ = "report_audit"

    id: int | None = Field(default=None, primary_key=True)
    report_id: int = Field(foreign_key="extension_report.id", index=True)
    actor: str
    action: str
    note: str | None = None
    created_at: datetime = Field(default_factory=_now)

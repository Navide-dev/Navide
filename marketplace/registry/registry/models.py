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
    frozen_at: datetime | None = None
    """Set when the owner's developer qualification is revoked: nothing more
    can be published or issued under this namespace (qualification.py)."""
    frozen_reason: str | None = None
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
    promotion_status: str | None = None
    """Testplace -> Marketplace promotion (testplace.py): 'requested' |
    'approved' | 'rejected'; None when never sent for review."""
    promotion_requested_at: datetime | None = None
    promotion_reviewed_at: datetime | None = None
    promotion_reviewed_by: str | None = None
    promotion_reason: str | None = None
    """Rejection reason shown to the publisher."""


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


class DeveloperQualification(SQLModel, table=True):
    """One developer application and its decision per Navide Cloud account
    (qualification.py). Cloud's own `members` table is never touched."""

    __tablename__ = "developer_qualification"

    navide_member_id: str = Field(primary_key=True)
    status: str = Field(index=True)
    """'pending' | 'approved' | 'rejected' | 'revoked'."""
    application: dict = Field(default_factory=dict, sa_column=Column(JSON))
    """The submitted fields (real-name identity); shown to the applicant and admins only."""
    field_sources: dict = Field(default_factory=dict, sa_column=Column(JSON))
    """Who filled each field: 'user' or 'agent-draft'."""
    source: str | None = None
    """Where the application came from (for example 'navide-app' or 'web')."""
    submitted_at: datetime = Field(default_factory=_now)
    decided_at: datetime | None = None
    decided_by: str | None = None
    reason: str | None = None
    """Rejection or revocation reason, shown to the applicant."""


class AccountToken(SQLModel, table=True):
    """Account-scoped bearer token: proves which Cloud account is calling
    (developer application, own versions, testplace). It cannot publish."""

    __tablename__ = "account_token"

    id: int | None = Field(default=None, primary_key=True)
    navide_member_id: str = Field(index=True)
    label: str
    token_hash: str = Field(index=True, unique=True)
    created_at: datetime = Field(default_factory=_now)
    expires_at: datetime
    revoked_at: datetime | None = None
    last_used_at: datetime | None = None


class AccountAuthCode(SQLModel, table=True):
    """One-time PKCE code for `/cli/authorize?scope=account`."""

    __tablename__ = "account_auth_code"

    id: int | None = Field(default=None, primary_key=True)
    code_hash: str = Field(index=True, unique=True)
    navide_member_id: str
    code_challenge: str
    label: str
    expires_at: datetime
    used_at: datetime | None = None


class PublisherKey(SQLModel, table=True):
    """Every Ed25519 key a publisher has registered; a replaced or revoked
    key keeps its row so a client can tell a revoked signature from none."""

    __tablename__ = "publisher_key"
    __table_args__ = (UniqueConstraint("publisher_id", "key_id", name="uq_publisher_key"),)

    id: int | None = Field(default=None, primary_key=True)
    publisher_id: int = Field(foreign_key="publisher.id", index=True)
    key_id: str
    """`sha256:<hex>` of the SPKI DER (signing.public_key_fingerprint)."""
    public_key: str
    created_at: datetime = Field(default_factory=_now)
    revoked_at: datetime | None = None
    revoked_reason: str | None = None


class RegistryAudit(SQLModel, table=True):
    """Append-only trail of qualification, namespace, token, key, publish,
    yank and blocklist actions: who did what to which target."""

    __tablename__ = "registry_audit"

    id: int | None = Field(default=None, primary_key=True)
    created_at: datetime = Field(default_factory=_now, index=True)
    actor: str = Field(index=True)
    """'member:<id>', 'admin:member:<id>', 'admin-token' or 'system:<why>'."""
    action: str = Field(index=True)
    target: str = Field(index=True)
    reason: str | None = None
    detail: dict = Field(default_factory=dict, sa_column=Column(JSON))
    """Facts about the action; never a token, key or other secret."""


class TestplaceInvite(SQLModel, table=True):
    """One tester seat of a testplace extension (testplace.py). A personal
    invite is created with a single-use join token and bound to the Cloud
    member who redeems it; a public-code seat is created already bound."""

    __tablename__ = "testplace_invite"
    __table_args__ = (
        # One live seat per member per extension, whichever way they joined.
        Index(
            "uq_testplace_invite_member",
            "extension_id",
            "member_id",
            unique=True,
            sqlite_where=text("member_id IS NOT NULL AND revoked_at IS NULL"),
        ),
    )

    id: int | None = Field(default=None, primary_key=True)
    extension_id: int = Field(foreign_key="extension.id", index=True)
    label: str = ""
    """The developer's note for this seat (for example the address the link
    was sent to). Never shown to the tester or to anyone else."""
    token_hash: str | None = Field(default=None, index=True, unique=True)
    """sha256 of the join token; None for a seat taken through a public code."""
    code_id: int | None = Field(default=None, foreign_key="testplace_code.id", index=True)
    member_id: str | None = Field(default=None, index=True)
    created_at: datetime = Field(default_factory=_now)
    claimed_at: datetime | None = None
    revoked_at: datetime | None = None


class TestplaceCode(SQLModel, table=True):
    """A public test code with a tester cap (testplace.py). The first code of
    an extension waits for a light admin review (D2) before it can be used."""

    __tablename__ = "testplace_code"

    id: int | None = Field(default=None, primary_key=True)
    extension_id: int = Field(foreign_key="extension.id", index=True)
    code_hash: str = Field(index=True, unique=True)
    max_testers: int
    review_status: str = Field(default="pending", index=True)
    """'pending' | 'approved' | 'rejected' (review.py statuses)."""
    review_reason: str | None = None
    reviewed_at: datetime | None = None
    reviewed_by: str | None = None
    created_at: datetime = Field(default_factory=_now)
    revoked_at: datetime | None = None

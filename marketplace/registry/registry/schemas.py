"""API response models."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class VersionInfo(BaseModel):
    version: str
    package_digest: str
    yanked: bool
    published_at: datetime
    target: str
    registry_envelope: dict
    registry_signature: str | None
    signed: bool
    trust_tier: str
    capabilities: list[str]
    """Declared v2 permission namespaces or legacy `manifest.requires`."""
    sensitive_capabilities: list[str]
    """Subset of `capabilities` flagged for elevated scrutiny (fs/aiCli/shell)."""
    download_count: int
    """Downloads recorded for this specific version."""
    engines_navide: str | None = None
    """The version's `engines.navide` requirement, verbatim."""
    min_navide_version: str | None = None
    """Lowest Navide release the requirement accepts (see discovery.py)."""
    compatible: bool | None = None
    """Against the request's `navide_version`; None when either is unknown."""
    channel: str = "stable"
    """`pre-release` for a SemVer prerelease version, else `stable`."""
    disclosure: dict | None = None
    """Manifest disclosure (contract 3.1); None for versions without one."""
    disclosure_envelope: dict | None = None
    """Registry-signed disclosure envelope (contract 3.5); the package
    `registry_envelope` above is unchanged."""
    disclosure_signature: str | None = None
    scan: dict | None = None
    """Registry static scan report (contract 3.8), signed through the
    disclosure envelope's `scanDigest`; None when the version has none."""
    registry: dict | None = None
    """Unsigned Registry facts (contract 3.4): publisher verification, review
    and scan summary as counts and status only."""


class ExtensionSummary(BaseModel):
    namespace: str
    name: str
    identity: str
    display_name: str | None
    description: str | None
    categories: list[str]
    latest_version: str | None
    """Newest stable version (the newest pre-release only when there is no
    stable version at all)."""
    latest_targets: list[str]
    """Targets `latest_version` is published for (`universal`, or platforms)."""
    updated_at: datetime
    download_count: int
    """Aggregate downloads across all versions."""
    rating_average: float
    """Mean rating (0.0 when unrated)."""
    rating_count: int
    featured: bool
    engines_navide: str | None = None
    """`engines.navide` of `latest_version`."""
    min_navide_version: str | None = None
    compatible: bool | None = None
    """`latest_version` against the request's `navide_version`."""
    license: str | None = None
    repository: str | None = None
    homepage: str | None = None
    extension_pack: list[str] | None = None
    trust_tier: str | None = None
    """Trust tier of `latest_version` (see trust.py); None with no version."""
    """Member ids when `latest_version` is an Extension Pack, else None."""
    latest_prerelease_version: str | None = None
    """Newest pre-release when it is newer than `latest_version`, else None."""
    disclosure: dict | None = None
    """Manifest disclosure of `latest_version` (contract 3.1), display data for
    the list card's summary and risk level; None for versions without one."""
    scan: dict | None = None
    """Static scan report of one `latest_version` artifact (contract 3.8),
    display data for the list card's risk level; None when it has none."""
    risk_by_target: dict[str, str] | None = None
    """`cardRiskLevel` of each `latest_version` artifact by target (contract
    3.3), so the list card can show the highest one; None without a
    disclosure. Display data; readers that do not know it ignore it."""
    icon_path: str | None = None
    """Package-relative raster icon of `latest_version`, served by the website
    asset route; None when the package has no safe icon."""


class ExtensionDetail(ExtensionSummary):
    publisher: str
    trust_metadata: dict
    trust_metadata_signature: str
    versions: list[VersionInfo]
    has_changelog: bool = False
    """`latest_version` ships a root CHANGELOG.md (see the changelog route)."""


class ReadmeResponse(BaseModel):
    version: str | None
    """Latest non-yanked version the README was read from."""
    markdown: str | None
    """Raw README markdown; clients render it themselves (None when absent)."""


class ChangelogResponse(BaseModel):
    version: str | None
    markdown: str | None


class CategoryInfo(BaseModel):
    slug: str
    label: str
    count: int


class CategoryListResponse(BaseModel):
    items: list[CategoryInfo]


class ExtensionListResponse(BaseModel):
    items: list[ExtensionSummary]
    total: int
    offset: int
    limit: int


class PublishResponse(BaseModel):
    namespace: str
    name: str
    version: str
    target: str
    package_digest: str
    yanked: bool
    review_status: str = "approved"
    """'pending' when the namespace is review-required (not public yet)."""


class YankResponse(BaseModel):
    namespace: str
    name: str
    version: str
    yanked: bool
    targets: list[str]
    """Every target's artifact the yank covered."""


class PublisherRegisterRequest(BaseModel):
    name: str
    public_key: str | None = None
    token: str | None = None
    display_name: str | None = None


class PublisherRegisterResponse(BaseModel):
    name: str
    display_name: str | None
    has_public_key: bool
    has_token: bool


class FeaturedRequest(BaseModel):
    featured: bool = True


class FeaturedResponse(BaseModel):
    namespace: str
    name: str
    featured: bool


class HealthResponse(BaseModel):
    status: str


class TestplaceVersionInfo(VersionInfo):
    """A testplace artifact as its tester sees it (testplace_api.py)."""

    expires_at: datetime | None = None
    promotion_status: str | None = None


class TestplaceExtension(BaseModel):
    namespace: str
    name: str
    identity: str
    display_name: str | None
    description: str | None
    publisher: str
    trust_metadata: dict
    trust_metadata_signature: str
    versions: list[TestplaceVersionInfo]
    """Installable testplace artifacts, newest version first."""


class TestplaceListResponse(BaseModel):
    items: list[TestplaceExtension]

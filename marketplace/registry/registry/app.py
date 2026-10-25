"""FastAPI application for the marketplace registry."""

from __future__ import annotations

import logging
import time
import urllib.parse
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import BinaryIO, Iterator

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import Engine
from starlette.types import ASGIApp, Message, Receive, Scope, Send
from sqlmodel import Session

from . import audit, cloud_auth, qualification
from .auth import PublisherIdentity, get_publisher_identity
from .config import TRUST_PROFILE_SELF_HOSTED_DEV, VERIFIER_ACCEPTING, Settings, load_settings
from . import review
from .qualification import publisher_problem
from .testplace import expiry as testplace_expiry
from .testplace_api import register_testplace_routes
from .blocklist import db_blocklists, digest_blocked
from .db import create_db_engine
from .dns_verify import TxtResolver, doh_txt_resolver
from .disclosure import registry_facts, sign_disclosure
from .static_scan import run_scan
from .plugin_contract.disclosure_contract import CanonicalJsonError
from .plugin_contract.disclosure_scan_contract import card_risk_level
from .discovery import (
    CATEGORIES,
    PACK_CATEGORY,
    engine_compatible,
    engine_requirement,
    in_category,
    is_navide_version,
    marketplace_links,
    min_navide_version,
    pack_members,
)
from .models import Extension, ExtensionVersion, Publisher
from .native_backend import local_native_backend_notices, native_backend_publish_problem
from .manifest import ManifestV2, manifest_capabilities, manifest_icon
from .package import MAX_ARCHIVE_SIZE, PackageError, read_package
from .packs import pack_conflict
from .ratelimit import SlidingWindowLimiter
from .ratings import RATING_LIMIT_PER_HOUR
from .reports import REPORT_LIMIT_PER_HOUR
from .repository import RegistryRepository, VersionConflictError, rating_average
from .registry_trust import REGISTRY_TIME_NONCE, RegistryTrustSigner
from .schemas import (
    CategoryInfo,
    CategoryListResponse,
    ChangelogResponse,
    ExtensionDetail,
    ExtensionListResponse,
    ExtensionSummary,
    FeaturedRequest,
    FeaturedResponse,
    HealthResponse,
    PublisherRegisterRequest,
    PublisherRegisterResponse,
    PublishResponse,
    ReadmeResponse,
    VersionInfo,
    YankResponse,
)
from .signing import (
    AcceptingSignatureVerifier,
    Ed25519SignatureVerifier,
    SignatureVerifier,
)
from .storage import LocalStorageBackend, StorageBackend, StorageError
from .trust import compute_trust_tier, sensitive_capabilities
from .versions import (
    TESTPLACE_CHANNEL,
    VERSION_CHANNELS,
    latest_prerelease_version,
    latest_stable_version,
    version_channel,
)
from .web import CHANGELOG_NAMES, SAFE_ASSET_TYPES, changelog_text, readme_text

_log = logging.getLogger(__name__)


@dataclass
class RegistryState:
    engine: Engine
    storage: StorageBackend
    verifier: SignatureVerifier
    settings: Settings
    trust_signer: RegistryTrustSigner
    txt_resolver: TxtResolver
    """DNS TXT lookup for publisher domain verification (injected in tests)."""
    rating_limiter: SlidingWindowLimiter = field(
        default_factory=lambda: SlidingWindowLimiter(RATING_LIMIT_PER_HOUR, 3600)
    )
    report_limiter: SlidingWindowLimiter = field(
        default_factory=lambda: SlidingWindowLimiter(REPORT_LIMIT_PER_HOUR, 3600)
    )
    grandfather_swept_at: float | None = None
    """Monotonic time of the last grandfather sweep (sweep_grandfather)."""


GRANDFATHER_SWEEP_SECONDS = 600


def sweep_grandfather(state: RegistryState) -> None:
    """Reclaim grandfathered namespaces whose grace period ran out, at most
    once every GRANDFATHER_SWEEP_SECONDS. Publishing does not wait for it:
    publisher_problem refuses an expired namespace at once."""
    now = time.monotonic()
    if state.grandfather_swept_at is not None and now - state.grandfather_swept_at < GRANDFATHER_SWEEP_SECONDS:
        return
    state.grandfather_swept_at = now
    try:
        with Session(state.engine) as session:
            reclaimed = qualification.reclaim_expired(session)
    except Exception:  # noqa: BLE001 - the next sweep retries
        _log.exception("grandfather sweep failed")
        return
    if reclaimed:
        _log.info("reclaimed grandfathered namespaces: %s", ", ".join(reclaimed))


def _make_verifier(settings: Settings) -> SignatureVerifier:
    if settings.verifier_kind == VERIFIER_ACCEPTING:
        return AcceptingSignatureVerifier()
    return Ed25519SignatureVerifier()


def _admin_token_configured(settings: Settings) -> bool:
    return bool(settings.admin_token and settings.admin_token.strip())


def _require_admin_token(
    settings: Settings, presented: str | None, *, honor_open_admin: bool = True
) -> None:
    """Fail closed: no configured admin token refuses every X-Admin-Token call.

    `honor_open_admin=False` keeps an endpoint closed even under the dev
    `allow_open_admin` opt-in (the review/blocklist JSON API never had one).
    """
    if not _admin_token_configured(settings):
        if honor_open_admin and settings.allow_open_admin:
            return
        _log.warning(
            "refused admin request: REGISTRY_ADMIN_TOKEN is not set "
            "(set it, or REGISTRY_ALLOW_OPEN_ADMIN=1 for a local dev registry)"
        )
        raise HTTPException(
            status_code=401,
            detail="admin endpoints are disabled: REGISTRY_ADMIN_TOKEN is not set",
        )
    if presented is None or not cloud_auth.constant_time_equal(
        settings.admin_token, presented
    ):
        raise HTTPException(status_code=401, detail="invalid admin token")


def create_app(
    settings: Settings | None = None, *, txt_resolver: TxtResolver | None = None
) -> FastAPI:
    settings = settings or load_settings()
    if settings.allow_open_admin and not _admin_token_configured(settings):
        _log.warning(
            "REGISTRY_ALLOW_OPEN_ADMIN is on and no admin token is set: "
            "admin endpoints accept unauthenticated calls (local dev only)"
        )
    engine = create_db_engine(settings.db_path)
    state = RegistryState(
        engine=engine,
        storage=LocalStorageBackend(settings.storage_root),
        verifier=_make_verifier(settings),
        settings=settings,
        # Admin blocklist entries join the config lists in publish refusal and
        # in the signed trust metadata (blocklist.py).
        trust_signer=replace(
            RegistryTrustSigner.from_settings(settings),
            extra_blocklist=lambda: db_blocklists(engine),
        ),
        txt_resolver=txt_resolver or doh_txt_resolver,
    )

    # root_path lets the registry sit under a reverse-proxy path prefix. Routing
    # accepts both prefixed (ALB forwards the path unchanged) and prefix-stripped
    # request paths, and every URL the website emits carries the prefix.
    app = FastAPI(
        title="Navide Marketplace Registry",
        version="0.1.0",
        root_path=settings.root_path,
    )
    app.state.registry = state
    if settings.root_path:
        app.add_middleware(_RootPathMiddleware, root_path=settings.root_path)

    @app.middleware("http")
    async def _grandfather_sweep(request: Request, call_next):
        await run_in_threadpool(sweep_grandfather, request.app.state.registry)
        return await call_next(request)

    _register_routes(app)
    register_testplace_routes(
        app,
        version_info=_version_info,
        file_chunks=_file_chunks,
        require_admin_token=_require_admin_token,
    )

    # Discovery website (p3-discovery): server-rendered pages + self-hosted
    # static assets, mounted alongside the /api/* JSON API on the same app.
    from .web import create_web_router

    static_dir = Path(__file__).parent / "web_static"
    app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")
    app.include_router(create_web_router())
    # Phase 2: Navide Cloud sign-in, publisher dashboard, CLI login, review
    # queue, blocklist and the removed-extensions list.
    from .publisher_web import create_publisher_router

    app.include_router(create_publisher_router())
    from .testplace_web import create_testplace_admin_router

    app.include_router(create_testplace_admin_router())
    app.add_middleware(_HtmlSecurityHeadersMiddleware, csp=html_content_security_policy(settings))
    return app


def html_content_security_policy(settings: Settings) -> str:
    """The policy every HTML page carries. The website is script-free, so
    there is no script-src at all (default-src 'none' denies scripts). Forms
    post to this registry, and two of them end in a redirect elsewhere: the
    CLI login hands its code to the loopback listener, and sign-in goes to
    navide-auth."""
    form_action = ["'self'", "http://127.0.0.1:*"]
    if settings.auth_url:
        parts = urllib.parse.urlsplit(settings.auth_url)
        form_action.append(f"{parts.scheme}://{parts.netloc}")
    return "; ".join(
        [
            "default-src 'none'",
            "style-src 'self'",
            "img-src 'self' data:",
            f"form-action {' '.join(form_action)}",
            "base-uri 'none'",
            "frame-ancestors 'none'",
        ]
    )


class _HtmlSecurityHeadersMiddleware:
    """Add the HTML Content-Security-Policy to text/html responses that do not
    set their own (package assets already send a stricter sandbox policy)."""

    def __init__(self, app: ASGIApp, csp: str) -> None:
        self.app = app
        self.csp = csp.encode()

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_csp(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = list(message.get("headers", []))
                names = {name.lower() for name, _ in headers}
                content_type = next((v for n, v in headers if n.lower() == b"content-type"), b"")
                if content_type.startswith(b"text/html") and b"content-security-policy" not in names:
                    headers.append((b"content-security-policy", self.csp))
                    message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, send_with_csp)


class _RootPathMiddleware:
    """Normalize a prefix-stripped request path back under `root_path`.

    Starlette routes a path that already carries `root_path` (the form an ALB
    forwards) correctly everywhere, but mounted apps such as StaticFiles miss a
    path a proxy stripped. Re-prefixing gives every route one path form.
    """

    def __init__(self, app: ASGIApp, root_path: str) -> None:
        self.app = app
        self.root_path = root_path

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] in {"http", "websocket"}:
            path = scope["path"]
            if path != self.root_path and not path.startswith(self.root_path + "/"):
                scope = dict(scope)
                scope["path"] = self.root_path + path
                if "raw_path" in scope and scope["raw_path"] is not None:
                    scope["raw_path"] = self.root_path.encode() + scope["raw_path"]
        await self.app(scope, receive, send)


# -- dependencies -------------------------------------------------------
def _state(request: Request) -> RegistryState:
    return request.app.state.registry


def _session(state: RegistryState = Depends(_state)) -> Iterator[Session]:
    with Session(state.engine) as session:
        yield session


def _repo(session: Session = Depends(_session)) -> RegistryRepository:
    return RegistryRepository(session)


# -- helpers ------------------------------------------------------------
UNIVERSAL_TARGET = "universal"


def _package_key(namespace: str, name: str, version: str, target: str) -> str:
    # Rows published before per-target artifacts keep their stored
    # `{version}/package.vsix` key; the key is read from the row, never rebuilt.
    return f"{namespace}/{name}/{version}/{target}/package.vsix"


def _publish_conflict(
    identity: str, version: str, target: str, existing: list[ExtensionVersion], *, testplace: bool = False
) -> str | None:
    """Why `target` cannot join the artifacts already published for `version`.

    A version number belongs to one channel until promotion (S8 R3-M2): a
    testplace artifact never shares it with a stable or pre-release one, so a
    revoke or yank of one can never reach the other.

    A version is either one `universal` artifact or a set of platform
    artifacts, never both: the client prefers an exact platform match over
    `universal`, so a mix would make which bytes a host installs depend on
    publish order, and a frontend-only package (the only kind that may be
    universal) has nothing platform-specific to split.
    """
    targets = [row.target for row in existing]
    other = [row for row in existing if (row.channel == TESTPLACE_CHANNEL) != testplace]
    if other:
        held = "testplace" if not testplace else "the public channel"
        return f"version {version} of {identity} already exists on {held}; a version belongs to one channel until promotion"
    if target in targets:
        return f"version {version} of {identity} already exists for target {target}"
    if any(row.yanked for row in existing):
        return f"version {version} of {identity} is yanked"
    if targets and UNIVERSAL_TARGET in (target, *targets):
        return (
            f"version {version} of {identity} is published for "
            f"{', '.join(targets)}; a version is either universal or "
            "per-platform"
        )
    return None


def _other_channel_conflict(session, extension, version: str, *, testplace: bool) -> str | None:
    """The one-channel rule again, inside the publish's own write (S8 R4-L3)."""
    rows = RegistryRepository(session).list_version_artifacts(extension.id, version, public_only=False)
    if any((row.channel == TESTPLACE_CHANNEL) != testplace for row in rows):
        held = "testplace" if not testplace else "the public channel"
        return f"version {version} of {extension.identity} already exists on {held}; a version belongs to one channel until promotion"
    return None


def _pack_conflict(repo: RegistryRepository, manifest: object) -> str | None:
    """Why this publish would nest one Extension Pack inside another
    (packs.py). Pending submissions count, so two packs waiting for review
    cannot list each other; the App re-checks each member's verified
    manifest at install time."""
    if not isinstance(manifest, ManifestV2):
        return None
    return pack_conflict(
        repo, manifest.id, manifest.extensionPack, include_pending=True
    )


def _version_info(
    row: ExtensionVersion,
    navide_version: str | None = None,
    publisher: Publisher | None = None,
) -> VersionInfo:
    capabilities = manifest_capabilities(row.manifest)
    requirement = engine_requirement(row.manifest)
    return VersionInfo(
        version=row.version,
        package_digest=row.package_digest,
        yanked=row.yanked,
        published_at=row.published_at,
        target=row.target,
        registry_envelope=row.registry_envelope,
        registry_signature=row.registry_signature,
        signed=row.registry_signature is not None,
        trust_tier=compute_trust_tier(signed=row.registry_signature is not None),
        capabilities=capabilities,
        sensitive_capabilities=sensitive_capabilities(capabilities),
        download_count=row.download_count,
        engines_navide=requirement,
        min_navide_version=min_navide_version(requirement),
        compatible=engine_compatible(requirement, navide_version),
        channel=version_channel(row.version),
        disclosure=row.disclosure,
        disclosure_envelope=row.disclosure_envelope,
        disclosure_signature=row.disclosure_signature,
        scan=row.scan,
        registry=registry_facts(row, publisher),
    )


def _icon_path(repo: RegistryRepository, row: ExtensionVersion | None) -> str | None:
    """The row's manifest icon when the package stores it as a safe raster
    asset (the same allowlist the website asset route serves)."""
    if row is None:
        return None
    icon = manifest_icon(row.manifest)
    if icon is None:
        return None
    for asset in repo.list_assets(row.id):
        if asset.path == icon and asset.content_type in SAFE_ASSET_TYPES:
            return icon
    return None


def _summary(
    extension: Extension,
    versions: list[ExtensionVersion],
    repo: RegistryRepository,
    navide_version: str | None = None,
) -> ExtensionSummary:
    active = [v.version for v in versions if not v.yanked]
    # Stable-only by default (p4-channel-rule); a newer pre-release is named
    # separately so a client can offer it to users who opted in.
    latest = latest_stable_version(active)
    # Target-independent facts (engines, links, icon) come from any artifact of
    # the latest version; the manifest is identical across its targets.
    latest_row = next(
        (v for v in sorted(versions, key=lambda v: v.target) if v.version == latest and not v.yanked),
        None,
    )
    manifest = latest_row.manifest if latest_row is not None else {}
    requirement = engine_requirement(manifest)
    return ExtensionSummary(
        namespace=extension.namespace,
        name=extension.name,
        identity=extension.identity,
        display_name=extension.display_name,
        description=extension.description,
        categories=extension.categories,
        latest_version=latest,
        latest_prerelease_version=latest_prerelease_version(active),
        latest_targets=sorted(
            v.target for v in versions if v.version == latest and not v.yanked
        ),
        updated_at=extension.updated_at,
        download_count=extension.download_count,
        rating_average=rating_average(extension),
        rating_count=extension.rating_count,
        featured=extension.featured,
        engines_navide=requirement,
        min_navide_version=min_navide_version(requirement),
        compatible=engine_compatible(requirement, navide_version),
        **marketplace_links(manifest),
        icon_path=_icon_path(repo, latest_row),
        extension_pack=pack_members(manifest),
        trust_tier=(
            compute_trust_tier(signed=latest_row.registry_signature is not None)
            if latest_row is not None
            else None
        ),
        disclosure=latest_row.disclosure if latest_row is not None else None,
        scan=latest_row.scan if latest_row is not None else None,
        risk_by_target={
            v.target: card_risk_level(v.disclosure, v.scan)
            for v in versions
            if v.version == latest and not v.yanked and v.disclosure
        } or None,
    )


def _latest_row(
    repo: RegistryRepository, extension: Extension
) -> ExtensionVersion | None:
    """One artifact of the latest non-yanked version (target-independent reads)."""
    active = [v for v in repo.list_versions(extension.id) if not v.yanked]
    latest = latest_stable_version([v.version for v in active])
    return next((v for v in active if v.version == latest), None)


def _navide_version_param(navide_version: str | None) -> str | None:
    if navide_version is not None and not is_navide_version(navide_version):
        raise HTTPException(status_code=400, detail="invalid navide_version")
    return navide_version


_DOWNLOAD_CHUNK_SIZE = 1024 * 1024


def _file_chunks(stream: BinaryIO) -> Iterator[bytes]:
    """Yield fixed-size chunks. Iterating a binary file directly splits it on
    newline bytes, which turns a multi-MB package into thousands of tiny
    threadpool round-trips (a 10 MB package took ~30 s to download)."""
    with stream:
        while chunk := stream.read(_DOWNLOAD_CHUNK_SIZE):
            yield chunk


def _register_routes(app: FastAPI) -> None:
    @app.get("/api/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        return HealthResponse(status="ok")

    @app.get("/api/categories", response_model=CategoryListResponse)
    def list_categories(
        repo: RegistryRepository = Depends(_repo),
    ) -> CategoryListResponse:
        """The closed category list with per-category extension counts."""
        rows = repo.search_extensions(limit=10**9)[0]
        return CategoryListResponse(
            items=[
                CategoryInfo(
                    slug=slug,
                    label=label,
                    count=sum(1 for e in rows if in_category(e.categories, slug)),
                )
                for slug, label in CATEGORIES
            ]
        )

    @app.post(
        "/api/publishers",
        response_model=PublisherRegisterResponse,
        status_code=201,
    )
    def register_publisher(
        request: Request,
        body: PublisherRegisterRequest,
        x_admin_token: str | None = Header(default=None),
        repo: RegistryRepository = Depends(_repo),
    ) -> PublisherRegisterResponse:
        """Register/update a publisher's Ed25519 public key and bearer token.

        Admin-gated by `X-Admin-Token`; refused while no admin token is
        configured unless `allow_open_admin` opts a dev registry out.
        """
        _require_admin_token(request.app.state.registry.settings, x_admin_token)
        publisher = repo.register_publisher(
            name=body.name,
            public_key=body.public_key,
            token=body.token,
            display_name=body.display_name,
        )
        audit.record(
            repo.session,
            actor=audit.ADMIN_TOKEN_ACTOR,
            action="publisher.register",
            target=f"publisher:{publisher.name}",
            detail={"public_key_set": body.public_key is not None, "token_set": body.token is not None},
        )
        repo.session.commit()
        return PublisherRegisterResponse(
            name=publisher.name,
            display_name=publisher.display_name,
            has_public_key=publisher.public_key is not None,
            has_token=publisher.token_hash is not None,
        )

    @app.post("/api/publish", response_model=PublishResponse, status_code=201)
    async def publish(
        request: Request,
        package: UploadFile,
        signature: str | None = None,
        target: str = Query(
            default="universal",
            min_length=1,
            max_length=64,
            pattern=r"^[a-z0-9][a-z0-9-]*$",
        ),
        channel: str | None = None,
        identity: PublisherIdentity = Depends(get_publisher_identity),
        repo: RegistryRepository = Depends(_repo),
    ) -> PublishResponse:
        state: RegistryState = request.app.state.registry
        settings = state.settings
        testplace_publish = channel == TESTPLACE_CHANNEL
        # Testplace (0.2.27): only an authenticated, vetted publisher; the
        # row is signed with `channel`/`expiresAt` (which released Apps
        # reject) and reaches testers only through testplace_api.py.
        if testplace_publish and not identity.authenticated:
            raise HTTPException(
                status_code=401,
                detail="testplace publishing needs a publisher token",
            )
        if channel is not None and channel not in VERSION_CHANNELS:
            raise HTTPException(status_code=400, detail=f"unknown channel '{channel}'")
        data = await package.read()
        try:
            loaded = read_package(data, target=target)
        except PackageError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        if digest_blocked(repo.session, loaded.digest) is not None:
            raise HTTPException(
                status_code=403,
                detail={"code": "DIGEST_BLOCKED", "message": "this package's sha256 is on the registry blocklist"},
            )

        manifest = loaded.manifest
        namespace = manifest.namespace
        name = manifest.extension_name
        if (
            channel is not None
            and not testplace_publish
            and channel != version_channel(manifest.version)
        ):
            raise HTTPException(
                status_code=400,
                detail=(
                    f"version {manifest.version} is {version_channel(manifest.version)}, "
                    f"not {channel}"
                ),
            )

        # Namespace entitlement: an authenticated publisher may only publish
        # under its own namespace (p3-publish).
        if identity.authenticated and identity.publisher != namespace:
            raise HTTPException(
                status_code=403,
                detail=(
                    f"publisher '{identity.publisher}' is not entitled to "
                    f"namespace '{namespace}'"
                ),
            )

        publisher_name = (
            identity.publisher if identity.authenticated else manifest.publisher
        )
        block_reason = state.trust_signer.block_reason(
            publisher_id=publisher_name,
            package_id=f"{namespace}.{name}",
            version=manifest.version,
        )
        if block_reason is not None:
            raise HTTPException(status_code=403, detail=block_reason)
        publisher = repo.get_or_create_publisher(publisher_name)
        if testplace_publish:
            problem = publisher_problem(repo.session, publisher)
            if problem is not None:
                raise HTTPException(
                    status_code=403, detail={"code": problem[0], "message": problem[1]}
                )

        # Signature gate (p3-security): reject a bad signature; allow unsigned
        # only when the config explicitly permits it (dev).
        if signature is None:
            if settings.require_signature:
                raise HTTPException(
                    status_code=403, detail="package signature is required"
                )
        elif not state.verifier.verify(
            digest=loaded.digest,
            signature=signature,
            public_key=publisher.public_key,
        ):
            raise HTTPException(
                status_code=403, detail="invalid package signature"
            )

        pack_conflict = _pack_conflict(repo, manifest)
        if pack_conflict is not None:
            raise HTTPException(status_code=400, detail=pack_conflict)

        local = settings.trust_profile == TRUST_PROFILE_SELF_HOSTED_DEV
        if isinstance(manifest, ManifestV2):
            backend_problem = native_backend_publish_problem(publisher, manifest, local=local)
            if backend_problem is not None:
                raise HTTPException(status_code=403, detail=backend_problem)

        if isinstance(manifest, ManifestV2):
            display_name = manifest.name
            description = manifest.marketplace.description
            categories = manifest.marketplace.categories
            # A pack is listed under Extension Packs whatever it declares.
            if manifest.extensionPack is not None and PACK_CATEGORY not in categories:
                categories = [*categories, PACK_CATEGORY]
        else:
            display_name = manifest.displayName or manifest.name
            description = manifest.description
            categories = manifest.categories

        extension = repo.get_or_create_extension(
            publisher=publisher,
            namespace=namespace,
            name=name,
            display_name=display_name,
            description=description,
            categories=categories,
            # A testplace build never changes the public listing.
            update_existing=not publisher.review_required and not testplace_publish,
        )

        conflict = _publish_conflict(
            extension.identity,
            manifest.version,
            target,
            repo.list_version_artifacts(
                extension.id, manifest.version, public_only=False
            ),
            testplace=testplace_publish,
        )
        if conflict is not None:
            raise HTTPException(status_code=409, detail=conflict)

        # Contract 3.8 / DS4: scan synchronously, within the time budget, before
        # anything is signed. A pending submission keeps its (unsigned) report
        # for the reviewer; approval scans again and signs that report.
        scan = run_scan(data, artifact_digest=loaded.digest, target=target,
                        manifest=manifest.model_dump(exclude_none=True))
        expires_at = None
        if testplace_publish:
            # D2: an invite-list build gets the automatic checks only, so a
            # blocking one refuses it instead of waiting for a reviewer.
            review_report = review.submission_report(
                repo.session,
                namespace=namespace,
                name=name,
                data=data,
                manifest=manifest.model_dump(exclude_none=True),
                signature_present=signature is not None,
                size_limit=MAX_ARCHIVE_SIZE,
            )
            if review.blocking_similarity(review_report):
                raise HTTPException(
                    status_code=422,
                    detail="name similarity check blocks this testplace build",
                )
            if review.secret_findings(review_report):
                raise HTTPException(
                    status_code=422,
                    detail="secret scan found likely credentials in this testplace build",
                )
            expires_at = testplace_expiry()
            try:
                registry_envelope, registry_signature = state.trust_signer.sign_envelope(
                    artifact_digest=loaded.digest,
                    package_id=f"{namespace}.{name}",
                    version=manifest.version,
                    target=target,
                    publisher_id=publisher_name,
                    channel=TESTPLACE_CHANNEL,
                    expires_at=expires_at,
                )
            except ValueError as exc:
                raise HTTPException(status_code=503, detail=str(exc)) from exc
            try:
                disclosure, disclosure_envelope, disclosure_signature = sign_disclosure(
                    state.trust_signer,
                    manifest.model_dump(exclude_none=True),
                    registry_envelope,
                    scan,
                )
            except CanonicalJsonError as exc:
                raise HTTPException(status_code=400, detail=f"manifest cannot be disclosed: {exc}") from exc
            trust_tier = compute_trust_tier(signed=True)
            review_status = review.APPROVED
        elif publisher.review_required:
            # Review before publish (D3): a self-claimed namespace's upload
            # waits unsigned and invisible until an admin approves it, which
            # is when the registry signs it (review.approve).
            registry_envelope, registry_signature = {}, None
            disclosure = disclosure_envelope = disclosure_signature = None
            trust_tier = compute_trust_tier(signed=False)
            review_status = review.PENDING
            review_report = review.submission_report(
                repo.session,
                namespace=namespace,
                name=name,
                data=data,
                manifest=manifest.model_dump(exclude_none=True),
                signature_present=signature is not None,
                size_limit=MAX_ARCHIVE_SIZE,
            )
        else:
            try:
                registry_envelope, registry_signature = (
                    state.trust_signer.sign_envelope(
                        artifact_digest=loaded.digest,
                        package_id=f"{namespace}.{name}",
                        version=manifest.version,
                        target=target,
                        publisher_id=publisher_name,
                    )
                )
            except ValueError as exc:
                raise HTTPException(status_code=503, detail=str(exc)) from exc
            try:
                disclosure, disclosure_envelope, disclosure_signature = sign_disclosure(
                    state.trust_signer,
                    manifest.model_dump(exclude_none=True),
                    registry_envelope,
                    scan,
                )
            except CanonicalJsonError as exc:
                raise HTTPException(status_code=400, detail=f"manifest cannot be disclosed: {exc}") from exc
            # Publisher signatures authenticate a submission only. Client-facing
            # integrity is established by the registry signature created above.
            trust_tier = compute_trust_tier(signed=True)
            review_status = review.APPROVED
            review_report = {}

        key = _package_key(namespace, name, manifest.version, target)
        state.storage.put(key, data)
        try:
            row = repo.add_version(
                extension=extension,
                version=manifest.version,
                manifest=manifest.model_dump(exclude_none=True),
                package_digest=loaded.digest,
                package_key=key,
                signature=signature,
                target=target,
                registry_envelope=registry_envelope,
                registry_signature=registry_signature,
                trust_tier=trust_tier,
                assets=[(a.path, a.size, a.content_type) for a in loaded.assets],
                review_status=review_status,
                review_report=review_report,
                disclosure=disclosure,
                disclosure_envelope=disclosure_envelope,
                disclosure_signature=disclosure_signature,
                scan=scan,
                channel=TESTPLACE_CHANNEL if testplace_publish else None,
                expires_at=expires_at,
                recheck=lambda session: _other_channel_conflict(
                    session, extension, manifest.version, testplace=testplace_publish
                ),
            )
        except VersionConflictError as exc:
            # The blob stays: in a same-target race its key may be the winner's.
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        if identity.authenticated:
            audit.record(
                repo.session,
                actor=identity.actor or f"publisher:{publisher_name}",
                action="version.submit",
                target=f"package:{namespace}.{name}@{row.version}",
                detail={"target": row.target, "digest": row.package_digest, "review_status": row.review_status},
            )
            repo.session.commit()
        return PublishResponse(
            namespace=namespace,
            name=name,
            version=row.version,
            target=row.target,
            package_digest=row.package_digest,
            yanked=row.yanked,
            review_status=row.review_status,
            notices=(
                local_native_backend_notices(publisher, manifest, local=local)
                if isinstance(manifest, ManifestV2)
                else []
            ),
        )

    @app.get("/api/extensions", response_model=ExtensionListResponse)
    def list_extensions(
        q: str | None = None,
        category: str | None = None,
        sort: str = "updated",
        offset: int = 0,
        limit: int = 20,
        navide_version: str | None = None,
        compatible_only: bool = False,
        repo: RegistryRepository = Depends(_repo),
    ) -> ExtensionListResponse:
        """`navide_version` (the client's release) fills each item's
        `compatible`; with `compatible_only` an item is kept only when it is
        known to be compatible, before paging so `total` stays exact."""
        limit = max(1, min(limit, 100))
        offset = max(0, offset)
        if sort not in {"updated", "downloads", "rating"}:
            sort = "updated"
        navide_version = _navide_version_param(navide_version)

        def keep(extension: Extension) -> bool:
            if category and not in_category(extension.categories, category):
                return False
            if compatible_only and navide_version is not None:
                summary = _summary(
                    extension, repo.list_versions(extension.id), repo, navide_version
                )
                return summary.compatible is not False
            return True

        rows, total = repo.search_extensions(
            query=q, sort=sort, offset=offset, limit=limit, keep=keep
        )
        items = [
            _summary(e, repo.list_versions(e.id), repo, navide_version) for e in rows
        ]
        return ExtensionListResponse(
            items=items, total=total, offset=offset, limit=limit
        )

    @app.get(
        "/api/extensions/{namespace}/{name}", response_model=ExtensionDetail
    )
    def extension_detail(
        request: Request,
        namespace: str,
        name: str,
        navide_version: str | None = None,
        repo: RegistryRepository = Depends(_repo),
    ) -> ExtensionDetail:
        navide_version = _navide_version_param(navide_version)
        extension = repo.get_extension(namespace, name)
        if extension is None:
            raise HTTPException(status_code=404, detail="extension not found")
        versions = repo.list_versions(extension.id)
        summary = _summary(extension, versions, repo, navide_version)
        publisher = repo.session.get(Publisher, extension.publisher_id)
        publisher_name = publisher.name if publisher else extension.namespace
        trust_metadata, trust_metadata_signature = (
            request.app.state.registry.trust_signer.signed_metadata()
        )
        ordered = sorted(
            versions, key=lambda v: v.published_at, reverse=True
        )
        latest_row = _latest_row(repo, extension)
        return ExtensionDetail(
            **summary.model_dump(),
            publisher=publisher_name,
            trust_metadata=trust_metadata,
            trust_metadata_signature=trust_metadata_signature,
            versions=[_version_info(v, navide_version, publisher) for v in ordered],
            has_changelog=latest_row is not None
            and any(
                a.path.lower() in CHANGELOG_NAMES
                for a in repo.list_assets(latest_row.id)
            ),
        )

    @app.get(
        "/api/extensions/{namespace}/{name}/changelog",
        response_model=ChangelogResponse,
    )
    def extension_changelog(
        request: Request,
        namespace: str,
        name: str,
        repo: RegistryRepository = Depends(_repo),
    ) -> ChangelogResponse:
        """Raw root CHANGELOG.md of the latest version, as text (like readme)."""
        extension = repo.get_extension(namespace, name)
        if extension is None:
            raise HTTPException(status_code=404, detail="extension not found")
        row = _latest_row(repo, extension)
        if row is None:
            return ChangelogResponse(version=None, markdown=None)
        return ChangelogResponse(
            version=row.version, markdown=changelog_text(request, row)
        )

    @app.get(
        "/api/extensions/{namespace}/{name}/readme", response_model=ReadmeResponse
    )
    def extension_readme(
        request: Request,
        namespace: str,
        name: str,
        repo: RegistryRepository = Depends(_repo),
    ) -> ReadmeResponse:
        """Raw README markdown of the latest non-yanked version.

        Unlike the website, the JSON API returns text, not HTML: the desktop
        client renders it without trusting registry-produced markup.
        """
        extension = repo.get_extension(namespace, name)
        if extension is None:
            raise HTTPException(status_code=404, detail="extension not found")
        row = _latest_row(repo, extension)
        if row is None:
            return ReadmeResponse(version=None, markdown=None)
        return ReadmeResponse(version=row.version, markdown=readme_text(request, row))

    @app.get("/api/extensions/{namespace}/{name}/{version}/download")
    def download(
        request: Request,
        namespace: str,
        name: str,
        version: str,
        target: str | None = None,
        repo: RegistryRepository = Depends(_repo),
    ) -> StreamingResponse:
        """Stream one artifact. `target` names it exactly (no fallback to
        `universal`: the client picks the row and asks for its target); it may
        be omitted only when the version has a single artifact."""
        state: RegistryState = request.app.state.registry
        extension = repo.get_extension(namespace, name)
        if extension is None:
            raise HTTPException(status_code=404, detail="extension not found")
        artifacts = repo.list_version_artifacts(extension.id, version)
        if not artifacts:
            raise HTTPException(status_code=404, detail="version not found")
        available = ", ".join(a.target for a in artifacts)
        if target is None:
            if len(artifacts) > 1:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"version {version} has per-target artifacts; pass "
                        f"?target= (available: {available})"
                    ),
                )
            row = artifacts[0]
        else:
            row = next((a for a in artifacts if a.target == target), None)
            if row is None:
                raise HTTPException(
                    status_code=404,
                    detail=(
                        f"version {version} has no {target} artifact "
                        f"(available: {available})"
                    ),
                )
        if digest_blocked(repo.session, row.package_digest) is not None:
            raise HTTPException(
                status_code=403,
                detail={"code": "DIGEST_BLOCKED", "message": "this package's sha256 is on the registry blocklist"},
            )
        try:
            stream = state.storage.open_stream(row.package_key)
        except StorageError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        repo.increment_download(extension, row)
        suffix = "" if row.target == UNIVERSAL_TARGET else f"@{row.target}"
        filename = f"{namespace}.{name}-{version}{suffix}.vsix"
        return StreamingResponse(
            _file_chunks(stream),
            media_type="application/zip",
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"',
                "X-Package-Digest": row.package_digest,
            },
        )

    @app.post(
        "/api/extensions/{namespace}/{name}/{version}/yank",
        response_model=YankResponse,
    )
    def yank(
        namespace: str,
        name: str,
        version: str,
        channel: str | None = None,
        identity: PublisherIdentity = Depends(get_publisher_identity),
        repo: RegistryRepository = Depends(_repo),
    ) -> YankResponse:
        # Only the owning publisher may yank (p3-publish); dev/anonymous is
        # allowed when auth is not required. Errors carry a stable
        # `detail.code`: NOT_OWNER or NOT_FOUND (token errors: auth.py).
        if identity.authenticated and identity.publisher != namespace:
            raise HTTPException(
                status_code=403,
                detail={
                    "code": "NOT_OWNER",
                    "message": (
                        f"publisher '{identity.publisher}' cannot yank in "
                        f"namespace '{namespace}'"
                    ),
                },
            )
        extension = repo.get_extension(namespace, name, public_only=False)
        if extension is None:
            raise HTTPException(
                status_code=404, detail={"code": "NOT_FOUND", "message": "extension not found"}
            )
        # A version is yanked as a whole, across every target's artifact, so
        # "latest" resolves the same on every platform.
        # One channel per yank (S8 R3-M2): `channel=testplace` for a test
        # build, otherwise the public artifacts, or the test build when the
        # version has no public one. A version an older Registry let hold
        # both is never yanked on both at once.
        artifacts = repo.list_version_artifacts(
            extension.id, version, public_only=False
        )
        test_builds = [a for a in artifacts if a.channel == TESTPLACE_CHANNEL]
        public = [a for a in artifacts if a.channel != TESTPLACE_CHANNEL]
        if channel == TESTPLACE_CHANNEL:
            artifacts = test_builds
        elif channel is not None:
            artifacts = public
        else:
            artifacts = public or test_builds
        if not artifacts:
            raise HTTPException(
                status_code=404, detail={"code": "NOT_FOUND", "message": "version not found"}
            )
        if identity.authenticated and not all(a.yanked for a in artifacts):
            audit.record(
                repo.session,
                actor=identity.actor or f"publisher:{namespace}",
                action="version.yank",
                target=f"package:{namespace}.{name}@{version}",
                detail={"targets": [a.target for a in artifacts]},
            )
        repo.yank_version(artifacts)
        return YankResponse(
            namespace=namespace,
            name=name,
            version=version,
            yanked=True,
            targets=[a.target for a in artifacts],
        )

    @app.get("/api/trust/local-install")
    def local_install_trust(request: Request, repo: RegistryRepository = Depends(_repo)) -> dict:
        """Root-signed approved publisher keys (revoked ones included) and
        blocked package digests, for packages installed from a file or folder."""
        keys, digests = qualification.local_install_entries(repo.session)
        document, signature = request.app.state.registry.trust_signer.signed_local_install(
            publisher_keys=keys, blocked_digests=digests
        )
        return {"local_trust_metadata": document, "local_trust_metadata_signature": signature}

    @app.get("/api/trust/time")
    def registry_time(request: Request, nonce: str = "") -> dict:
        """Root-signed Registry time for an App whose clock is off (see
        verifyRegistryTimeAttestation in the App)."""
        if not REGISTRY_TIME_NONCE.fullmatch(nonce):
            raise HTTPException(
                status_code=400,
                detail={"code": "INVALID_NONCE", "message": "nonce must be 22-86 base64url characters"},
            )
        document, signature = request.app.state.registry.trust_signer.signed_time(nonce=nonce)
        return {"registry_time": document, "registry_time_signature": signature}

    @app.post("/api/extensions/{namespace}/{name}/rating")
    def submit_rating(namespace: str, name: str) -> None:
        """Anonymous ratings ended with member ratings (p3-rating-auth): rating
        needs a Navide Cloud sign-in on the marketplace website."""
        raise HTTPException(
            status_code=401,
            detail=(
                "Ratings require a signed-in Navide Cloud account: sign in on "
                f"the marketplace website and rate on /extensions/{namespace}/{name}."
            ),
        )

    @app.post(
        "/api/extensions/{namespace}/{name}/featured",
        response_model=FeaturedResponse,
    )
    def set_featured(
        request: Request,
        namespace: str,
        name: str,
        body: FeaturedRequest,
        x_admin_token: str | None = Header(default=None),
        repo: RegistryRepository = Depends(_repo),
    ) -> FeaturedResponse:
        """Admin-gated curation flag (same `X-Admin-Token` gate as publishers)."""
        _require_admin_token(request.app.state.registry.settings, x_admin_token)
        extension = repo.get_extension(namespace, name)
        if extension is None:
            raise HTTPException(status_code=404, detail="extension not found")
        extension = repo.set_featured(extension, body.featured)
        return FeaturedResponse(
            namespace=namespace, name=name, featured=extension.featured
        )


# Module-level app for `uvicorn registry.app:app`.
app = create_app()

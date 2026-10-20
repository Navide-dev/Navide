"""Server-rendered marketplace website (p3-discovery).

A dependency-light discovery frontend for the registry: Jinja2 templates +
self-hosted CSS, mounted on the same FastAPI app as the JSON API. It reads
through the same `RegistryRepository` the API uses -- no duplicated query logic
-- and renders package READMEs from the stored `.vsix` blob.

Security: README markdown is rendered with `markdown-it-py` configured with
raw-HTML disabled (`html=False`), so any `<script>`/`<img onerror=...>` in a
README is escaped to inert text and dangerous link schemes are dropped by the
built-in link validator. No user-authored HTML is ever emitted verbatim.
Package assets (icons/screenshots) are served only for a raster-image
Content-Type allowlist (`SAFE_ASSET_TYPES`) with `nosniff` + a locked-down CSP,
so a package cannot serve active `text/html`/`image/svg+xml` on this origin.
"""

from __future__ import annotations

import zipfile
from io import BytesIO
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from markdown_it import MarkdownIt
from sqlmodel import Session

from .cloud_auth import current_viewer, viewer_context
from .discovery import CATEGORIES, engine_requirement, min_navide_version
from .manifest import manifest_capabilities, manifest_icon
from .ratings import is_own_extension, member_score
from .models import Extension, ExtensionVersion, Publisher
from .repository import RegistryRepository, rating_average
from .self_service import verified_domain
from .versions import compare_semver
from .storage import StorageError
from .trust import compute_trust_tier, sensitive_capabilities
from .versions import latest_stable_version, version_channel

# Package assets are third-party uploads served on the marketplace origin, so a
# stored `text/html` or `image/svg+xml` Content-Type would be a stored-XSS
# vector. Assets are only ever icons/screenshots, so restrict to raster images
# and harden the response; anything else is rejected rather than sniffed.
SAFE_ASSET_TYPES = frozenset(
    {"image/png", "image/jpeg", "image/gif", "image/webp"}
)

_TEMPLATES_DIR = Path(__file__).parent / "web_templates"

# Raw HTML disabled -> README markdown cannot inject active markup (XSS-safe).
_MD = MarkdownIt("commonmark", {"html": False, "linkify": False})

_README_NAMES = {"readme.md", "readme.markdown", "readme"}


def render_markdown(text: str) -> str:
    """Render trusted-as-text markdown to sanitized HTML (no raw HTML)."""
    return _MD.render(text)


def _repo(request: Request) -> tuple[Session, RegistryRepository]:
    engine = request.app.state.registry.engine
    session = Session(engine)
    return session, RegistryRepository(session)


def _latest_active(versions: list[ExtensionVersion]) -> ExtensionVersion | None:
    active = [v for v in versions if not v.yanked]
    if not active:
        return None
    # Same channel rule as the API: stable first (p4-channel-rule).
    latest = latest_stable_version([v.version for v in active])
    return next(v for v in active if v.version == latest)


def _card(
    extension: Extension, versions: list[ExtensionVersion], repo: RegistryRepository
) -> dict:
    latest = _latest_active(versions)
    caps = manifest_capabilities(latest.manifest) if latest else []
    return {
        "namespace": extension.namespace,
        "name": extension.name,
        "identity": extension.identity,
        "display_name": extension.display_name or extension.name,
        "description": extension.description or "",
        "categories": extension.categories,
        "download_count": extension.download_count,
        "rating_average": rating_average(extension),
        "rating_count": extension.rating_count,
        "featured": extension.featured,
        "latest_version": latest.version if latest else None,
        "latest_targets": sorted(
            v.target
            for v in versions
            if latest and v.version == latest.version and not v.yanked
        ),
        "trust_tier": (
            compute_trust_tier(signed=latest.registry_signature is not None)
            if latest
            else "unsigned"
        ),
        "sensitive_capabilities": sensitive_capabilities(caps),
        **_navide_requirement(latest),
        "icon_path": _safe_icon(repo, latest),
    }


def _safe_icon(repo: RegistryRepository, row: ExtensionVersion | None) -> str | None:
    """The manifest icon only when the package stored it as a raster asset the
    asset route will serve (the API's `_icon_path` rule), so the page never
    points at an icon that can only 404 or 415."""
    icon = manifest_icon(row.manifest) if row else None
    if row is None or icon is None:
        return None
    for asset in repo.list_assets(row.id):
        if asset.path == icon and asset.content_type in SAFE_ASSET_TYPES:
            return icon
    return None


# Every Navide release anyone can still install meets this, so a minimum at or
# below it says nothing a reader can act on. It was on nearly every card.
_UNREMARKABLE_NAVIDE_MINIMUM = "0.1.0"


def _navide_requirement(row: ExtensionVersion | None) -> dict[str, str | None]:
    """`engines.navide` of `row` and the minimum release it names, read with
    the same rule the API's compat flag uses. `*` (any release), forms the rule
    cannot read, and minimums no higher than 0.1.0 have no minimum worth
    showing. Display only: the API's compat flag still reads the full rule."""
    requirement = engine_requirement(row.manifest) if row else None
    minimum = min_navide_version(requirement)
    worth_showing = minimum is not None and compare_semver(minimum, _UNREMARKABLE_NAVIDE_MINIMUM) > 0
    return {
        "engines_navide": requirement,
        "min_navide_version": minimum if worth_showing else None,
    }


def _read_package_zip(request: Request, package_key: str) -> zipfile.ZipFile | None:
    storage = request.app.state.registry.storage
    try:
        data = storage.get(package_key)
    except StorageError:
        return None
    if not zipfile.is_zipfile(BytesIO(data)):
        return None
    return zipfile.ZipFile(BytesIO(data))


def _extract_readme(request: Request, row: ExtensionVersion) -> str | None:
    raw = readme_text(request, row)
    return render_markdown(raw) if raw is not None else None


def readme_text(request: Request, row: ExtensionVersion) -> str | None:
    """Return the package README as raw markdown text (not rendered)."""
    zf = _read_package_zip(request, row.package_key)
    if zf is None:
        return None
    with zf:
        target = None
        for entry in zf.namelist():
            if Path(entry).name.lower() in _README_NAMES:
                target = entry
                break
        if target is None:
            return None
        try:
            raw = zf.read(target).decode("utf-8", errors="replace")
        except KeyError:  # pragma: no cover - name came from the archive
            return None
    return raw


CHANGELOG_NAMES = frozenset({"changelog.md", "changelog.markdown", "changelog"})


def changelog_text(request: Request, row: ExtensionVersion) -> str | None:
    """The package's root CHANGELOG as raw markdown text, or None."""
    zf = _read_package_zip(request, row.package_key)
    if zf is None:
        return None
    with zf:
        target = next(
            (entry for entry in zf.namelist() if entry.lower() in CHANGELOG_NAMES),
            None,
        )
        if target is None:
            return None
        return zf.read(target).decode("utf-8", errors="replace")


_CATEGORY_LABELS = dict(CATEGORIES)


def category_label(slug: str) -> str:
    """Display name of a closed-list category slug; any other slug as-is."""
    return _CATEGORY_LABELS.get(slug.lower(), slug)


TILE_HUES = 24


def tile_hue(identity: str) -> int:
    """Hue bucket (0..23, 15 degrees apart) of an extension or publisher tile.

    The same hash the Navide app uses for its letter tiles
    (MarketplaceIcon.vue), so an extension wears one colour in both places.
    Buckets, not a free hue: the site is CSP-locked to its stylesheet, so each
    colour is a class there.
    """
    data = identity.encode("utf-16-le")  # the code units JavaScript's charCodeAt sees
    value = 0
    for i in range(0, len(data), 2):
        value = (value * 31 + (data[i] | data[i + 1] << 8)) & 0xFFFFFFFF
    return value % TILE_HUES


_CAPABILITY_HINTS = {
    "fs": "reads and writes files",
    "shell": "runs shell commands",
    "terminal": "runs commands in a terminal",
    "aiCli": "drives AI CLI agents",
    "web": "browses websites with your sign-ins and keeps them",
}


def capability_hint(capability: str) -> str:
    """What a sensitive capability lets a package do, in a few words."""
    return _CAPABILITY_HINTS.get(capability, capability)


def _base_path_context(request: Request) -> dict[str, str]:
    """Expose the public path prefix so every emitted link carries it."""
    return {"base": request.scope.get("root_path", "").rstrip("/")}


def create_web_router() -> APIRouter:
    router = APIRouter(include_in_schema=False)
    templates = Jinja2Templates(
        directory=str(_TEMPLATES_DIR),
        context_processors=[_base_path_context, viewer_context],
    )
    templates.env.filters["category_label"] = category_label
    templates.env.filters["tile_hue"] = tile_hue
    templates.env.filters["capability_hint"] = capability_hint

    @router.get("/", response_class=HTMLResponse)
    def home(
        request: Request,
        q: str | None = None,
        category: str | None = None,
        sort: str = "updated",
    ) -> HTMLResponse:
        if sort not in {"updated", "downloads", "rating"}:
            sort = "updated"
        session, repo = _repo(request)
        try:
            rows, total = repo.search_extensions(
                query=q, category=category, sort=sort, offset=0, limit=60
            )
            items = [_card(e, repo.list_versions(e.id), repo) for e in rows]
            featured = [
                _card(e, repo.list_versions(e.id), repo) for e in repo.list_featured()
            ]
            categories = repo.all_categories()
        finally:
            session.close()
        return templates.TemplateResponse(
            request,
            "home.html",
            {
                "items": items,
                "featured": featured,
                "categories": categories,
                "total": total,
                "query": q or "",
                "active_category": category or "",
                "sort": sort,
            },
        )

    @router.get("/extensions/{namespace}/{name}", response_class=HTMLResponse)
    def detail(request: Request, namespace: str, name: str) -> HTMLResponse:
        session, repo = _repo(request)
        try:
            extension = repo.get_extension(namespace, name)
            if extension is None:
                raise HTTPException(status_code=404, detail="extension not found")
            versions = repo.list_versions(extension.id)
            latest = _latest_active(versions)
            ordered = sorted(versions, key=lambda v: v.published_at, reverse=True)
            version_views = [
                {
                    "version": v.version,
                    "channel": version_channel(v.version),
                    "target": v.target,
                    "trust_tier": compute_trust_tier(
                        signed=v.registry_signature is not None
                    ),
                    "signed": v.registry_signature is not None,
                    "yanked": v.yanked,
                    "published_at": v.published_at,
                    "download_count": v.download_count,
                    "capabilities": manifest_capabilities(v.manifest),
                    "sensitive_capabilities": sensitive_capabilities(
                        manifest_capabilities(v.manifest)
                    ),
                }
                for v in ordered
            ]
            readme_html = _extract_readme(request, latest) if latest else None
            screenshots = _screenshots(repo, latest) if latest else []
            icon_path = _safe_icon(repo, latest)
            pub = repo.session.get(Publisher, extension.publisher_id)
            viewer = current_viewer(request)
            publisher_display = pub.name if pub else extension.namespace
            context = {
                "ext": _card(extension, versions, repo),
                "publisher": publisher_display,
                "publisher_domain": verified_domain(pub),
                "versions": version_views,
                "readme_html": readme_html,
                "screenshots": screenshots,
                "icon_path": icon_path,
                "latest_version": latest.version if latest else None,
                "latest_targets": sorted(
                    v.target
                    for v in versions
                    if latest and v.version == latest.version and not v.yanked
                ),
                "download_count": extension.download_count,
                "rating_average": rating_average(extension),
                "rating_count": extension.rating_count,
                "my_rating": (
                    member_score(repo.session, extension, viewer.member_id) if viewer else None
                ),
                "own_extension": (
                    is_own_extension(repo.session, extension, viewer.member_id) if viewer else False
                ),
            }
        finally:
            session.close()
        return templates.TemplateResponse(request, "detail.html", context)

    @router.get("/extensions/{namespace}/{name}/{version}/assets/{asset_path:path}")
    def asset(
        request: Request,
        namespace: str,
        name: str,
        version: str,
        asset_path: str,
    ) -> Response:
        session, repo = _repo(request)
        try:
            extension = repo.get_extension(namespace, name)
            if extension is None:
                raise HTTPException(status_code=404, detail="extension not found")
            row = repo.get_version(extension.id, version)
            if row is None:
                raise HTTPException(status_code=404, detail="version not found")
            allowed = {a.path: a.content_type for a in repo.list_assets(row.id)}
            if asset_path not in allowed:
                raise HTTPException(status_code=404, detail="asset not found")
            zf = _read_package_zip(request, row.package_key)
            if zf is None:
                raise HTTPException(status_code=404, detail="package unavailable")
            with zf:
                try:
                    blob = zf.read(asset_path)
                except KeyError as exc:
                    raise HTTPException(
                        status_code=404, detail="asset not found"
                    ) from exc
            media = allowed[asset_path]
        finally:
            session.close()
        if media not in SAFE_ASSET_TYPES:
            raise HTTPException(status_code=415, detail="unsupported asset type")
        return Response(
            content=blob,
            media_type=media,
            headers={
                "Content-Security-Policy": "default-src 'none'; sandbox",
                "X-Content-Type-Options": "nosniff",
                "Content-Disposition": f'inline; filename="{Path(asset_path).name}"',
            },
        )

    return router


def _screenshots(repo: RegistryRepository, row: ExtensionVersion) -> list[str]:
    icon = manifest_icon(row.manifest)
    paths = []
    for asset in repo.list_assets(row.id):
        if asset.content_type.startswith("image/") and asset.path != icon:
            paths.append(asset.path)
    return sorted(paths)

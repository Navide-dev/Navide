"""Phase 2 website and API: Navide Cloud sign-in, namespace claims, the
publisher dashboard, `navide-plugin login`, the admin review queue, the admin
blocklist and the public removed-extensions list (plan cards 7-10).

Browser routes use the registry session cookie (cloud_auth.py); every
state-changing form carries a CSRF token bound to the session. The admin JSON
API uses `X-Admin-Token` and is closed when no admin token is configured.
"""

from __future__ import annotations

import functools
import re
import time
import urllib.parse
from pathlib import Path

from fastapi import APIRouter, Form, Header, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel
from sqlmodel import Session, select

from . import cloud_auth, qualification, ratings, reports, review
from .account_auth import exchange_account_code, find_account_code, issue_account_code
from .developer_web import register_developer_routes
from .app import _require_admin_token as require_admin_token
from .blocklist import BlocklistError, add_entry, db_entries, remove_entry, removed_list
from .dns_verify import DomainError, record_host, record_value
from .models import Extension, ExtensionVersion, Publisher
from .native_backend import self_service_publishers, set_native_backend_allowed
from .repository import RegistryRepository
from .self_service import (
    MAX_NAMESPACES_PER_ACCOUNT,
    MAX_TOKEN_DAYS,
    QualificationRequired,
    SelfServiceError,
    check_claim,
    check_domain,
    claim_namespace,
    create_token,
    exchange_cli_code,
    issue_cli_code,
    list_tokens,
    owned_publisher,
    owned_publishers,
    revoke_token,
    set_domain,
    set_public_key,
    token_state,
    verified_domain,
)
from .signing import public_key_fingerprint
from .similarity import ClaimVerdict
from .static_scan import scan_stored_version
from .storage import StorageError
from .web import _base_path_context, tile_hue

_TEMPLATES_DIR = Path(__file__).parent / "web_templates"
_NO_STORE = {"Cache-Control": "no-store"}
SCOPE_PUBLISH = "publish"
SCOPE_ACCOUNT = "account"
CLI_SCOPES = (SCOPE_PUBLISH, SCOPE_ACCOUNT)
"""`/cli/authorize?scope=`: a namespace publish token (default) or an account
token that names the Cloud account only (account_auth.py)."""
_CLI_TOKEN_RE = re.compile(r"[A-Za-z0-9_-]+")
"""ASCII only: str.isalnum() also accepts Unicode letters and digits."""


class CliTokenRequest(BaseModel):
    code: str
    code_verifier: str


class ApproveRequest(BaseModel):
    acknowledge_secret_findings: bool = False
    # Required for a version with a native backend (every target inspected).
    inspected_native_backend: bool = False
    # Package digests from the review queue: the decision applies to exactly these.
    artifacts: list[str] = []

class RejectRequest(BaseModel):
    reason: str
    artifacts: list[str] = []


class BlockRequest(BaseModel):
    kind: str
    value: str
    reason: str
    digest_reason: str | None = None


class _Redirect(Exception):
    def __init__(self, location: str) -> None:
        self.location = location


def _settings(request: Request):
    return request.app.state.registry.settings


def _base(request: Request) -> str:
    return request.scope.get("root_path", "").rstrip("/")


def _redirect(request: Request, path: str) -> RedirectResponse:
    return RedirectResponse(_base(request) + path, status_code=303)


def _require_viewer(request: Request, next_path: str | None = None) -> cloud_auth.Viewer:
    """`next_path` names the page to return to after sign-in; a form POST
    passes it, since the POST path itself cannot be revisited with GET."""
    if not _settings(request).cloud_auth_enabled:
        raise HTTPException(status_code=503, detail="Navide Cloud sign-in is not configured")
    viewer = cloud_auth.current_viewer(request)
    if viewer is None:
        if next_path is None:
            next_path = request.url.path[len(_base(request)) :] or "/publisher"
            if request.url.query:
                next_path += "?" + request.url.query
        raise _Redirect("/login?" + urllib.parse.urlencode({"next": next_path}))
    return viewer


def _require_admin(request: Request) -> cloud_auth.Viewer:
    viewer = _require_viewer(request)
    if not viewer.is_admin:
        raise HTTPException(status_code=403, detail="admin only")
    return viewer


def _check_csrf(request: Request, viewer: cloud_auth.Viewer, token: str) -> None:
    if not cloud_auth.csrf_ok(_settings(request), viewer, token):
        raise HTTPException(status_code=403, detail="invalid form token; reload the page")


def _require_admin_token(request: Request, presented: str | None) -> None:
    require_admin_token(_settings(request), presented, honor_open_admin=False)


def _session(request: Request) -> Session:
    return Session(request.app.state.registry.engine)


def _owned_or_404(session: Session, viewer: cloud_auth.Viewer, namespace: str) -> Publisher:
    publisher = owned_publisher(session, viewer.member_id, namespace)
    if publisher is None:
        raise HTTPException(status_code=404, detail="namespace not found")
    return publisher


def _version_rows(session: Session, publisher: Publisher) -> list[dict]:
    rows = []
    extensions = session.exec(
        select(Extension).where(Extension.publisher_id == publisher.id)
    ).all()
    for extension in extensions:
        versions = session.exec(
            select(ExtensionVersion).where(ExtensionVersion.extension_id == extension.id)
        ).all()
        grouped: dict[str, dict] = {}
        for row in versions:
            item = grouped.setdefault(
                row.version,
                {
                    "identity": extension.identity,
                    "version": row.version,
                    "submitted_at": row.published_at,
                    "status": row.review_status,
                    "reason": row.review_reason,
                    "targets": [],
                    "downloads": 0,
                    "yanked": row.yanked,
                    "secret_findings": [],
                },
            )
            item["targets"].append(row.target)
            item["downloads"] += row.download_count
            item["secret_findings"].extend(review.secret_findings(row.review_report))
        rows.extend(grouped.values())
    rows.sort(key=lambda r: r["submitted_at"], reverse=True)
    return rows


def _manifest_check(report: dict) -> str:
    return report.get("signature", "unsigned")


def create_publisher_router() -> APIRouter:
    router = APIRouter(include_in_schema=False)
    templates = Jinja2Templates(
        directory=str(_TEMPLATES_DIR),
        context_processors=[_base_path_context, cloud_auth.viewer_context],
    )
    templates.env.filters["tile_hue"] = tile_hue

    def page(request: Request, name: str, context: dict, status: int = 200) -> HTMLResponse:
        return templates.TemplateResponse(request, name, context, status_code=status, headers=_NO_STORE)

    # FastAPI has no per-router exception handlers; wrap instead.
    def guarded(handler):
        @functools.wraps(handler)
        def wrapper(*args, **kwargs):
            try:
                return handler(*args, **kwargs)
            except _Redirect as redirect:
                request = kwargs.get("request") or args[0]
                return _redirect(request, redirect.location)

        return wrapper

    # -- sign in (card 7) ------------------------------------------------
    @router.get("/publish", response_class=HTMLResponse)
    def publish_landing(request: Request) -> Response:
        if cloud_auth.current_viewer(request) is not None:
            return _redirect(request, "/publisher")
        return page(request, "publish_signin.html", {"enabled": _settings(request).cloud_auth_enabled})

    @router.get("/login")
    def login(request: Request, next: str | None = None) -> Response:
        settings = _settings(request)
        if not settings.cloud_auth_enabled:
            raise HTTPException(status_code=503, detail="Navide Cloud sign-in is not configured")
        state, location = cloud_auth.start_login(settings, cloud_auth.safe_next(next), time.time())
        response = RedirectResponse(location, status_code=303, headers=_NO_STORE)
        cloud_auth.set_cookie(
            response, request, settings, cloud_auth.LOGIN_STATE_COOKIE, state, cloud_auth.LOGIN_STATE_TTL_SECONDS
        )
        return response

    @router.get("/auth/callback")
    def auth_callback(request: Request, sso: str = "", sig: str = "") -> Response:
        settings = _settings(request)
        if not settings.cloud_auth_enabled:
            raise HTTPException(status_code=503, detail="Navide Cloud sign-in is not configured")
        now = time.time()
        state = cloud_auth.unseal(
            settings, "login-state", request.cookies.get(cloud_auth.LOGIN_STATE_COOKIE), now
        )
        identity = (
            cloud_auth.verify_callback(settings, sso, sig, str(state.get("nonce", "")), now)
            if state is not None
            else None
        )
        if identity is None:
            response = page(
                request,
                "publish_signin.html",
                {"enabled": True, "error": "Sign-in failed or expired. Please try again."},
                status=400,
            )
            cloud_auth.clear_cookie(response, request, settings, cloud_auth.LOGIN_STATE_COOKIE)
            return response
        response = _redirect(request, cloud_auth.safe_next(str(state.get("next", ""))))
        response.headers["Cache-Control"] = "no-store"
        cloud_auth.clear_cookie(response, request, settings, cloud_auth.LOGIN_STATE_COOKIE)
        cloud_auth.set_cookie(
            response,
            request,
            settings,
            cloud_auth.SESSION_COOKIE,
            cloud_auth.new_session(
                settings,
                identity,
                now,
                cloud_auth.session_version(request.app.state.registry.engine, identity.member_id),
            ),
            cloud_auth.SESSION_TTL_SECONDS,
        )
        return response

    @router.post("/logout")
    @guarded
    def logout(request: Request, csrf: str = Form("")) -> Response:
        viewer = _require_viewer(request)
        _check_csrf(request, viewer, csrf)
        cloud_auth.revoke_sessions(request.app.state.registry.engine, viewer.member_id)
        response = _redirect(request, "/")
        cloud_auth.clear_cookie(response, request, _settings(request), cloud_auth.SESSION_COOKIE)
        return response

    # -- dashboard (card 9) ---------------------------------------------
    @router.get("/publisher", response_class=HTMLResponse)
    @guarded
    def dashboard(request: Request) -> Response:
        viewer = _require_viewer(request)
        with _session(request) as session:
            publishers = owned_publishers(session, viewer.member_id)
            if len(publishers) == 1:
                return _redirect(request, f"/publisher/{publishers[0].name}")
            items = [
                {
                    "name": p.name,
                    "verified_domain": verified_domain(p),
                    "rows": _version_rows(session, p),
                }
                for p in publishers
            ]
        return page(
            request,
            "publisher_home.html",
            {"items": items, "can_claim": len(items) < MAX_NAMESPACES_PER_ACCOUNT, "max": MAX_NAMESPACES_PER_ACCOUNT},
        )

    @router.get("/publisher/claim", response_class=HTMLResponse)
    @guarded
    def claim_form(request: Request, namespace: str = "") -> Response:
        viewer = _require_viewer(request)
        verdict = None
        if namespace:
            with _session(request) as session:
                verdict = check_claim(session, viewer.member_id, namespace.strip().lower())
        return page(request, "publisher_claim.html", {"namespace": namespace, "verdict": verdict})

    @router.post("/publisher/claim")
    @guarded
    def claim(request: Request, namespace: str = Form(""), csrf: str = Form("")) -> Response:
        viewer = _require_viewer(request)
        _check_csrf(request, viewer, csrf)
        with _session(request) as session:
            try:
                publisher = claim_namespace(
                    session, member_id=viewer.member_id, display_name=viewer.name, namespace=namespace
                )
            except SelfServiceError as exc:
                return page(
                    request,
                    "publisher_claim.html",
                    {"namespace": namespace, "verdict": ClaimVerdict(False, str(exc))},
                    status=409,
                )
            name = publisher.name
        return _redirect(request, f"/publisher/{name}")

    def _namespace_page(request: Request, viewer, namespace: str, extra: dict | None = None, status: int = 200) -> Response:
        with _session(request) as session:
            publisher = _owned_or_404(session, viewer, namespace)
            tokens = [
                {"id": t.id, "label": t.label, "expires_at": t.expires_at, "state": token_state(t), "last_used_at": t.last_used_at}
                for t in list_tokens(session, publisher)
            ]
            rows = _version_rows(session, publisher)
            fingerprint = None
            if publisher.public_key:
                try:
                    fingerprint = public_key_fingerprint(publisher.public_key)
                except Exception:  # noqa: BLE001 - show as unset
                    fingerprint = None
            context = {
                "publisher": {
                    "name": publisher.name,
                    "domain": publisher.verified_domain,
                    "verified_domain": verified_domain(publisher),
                    "record_host": record_host(publisher.verified_domain) if publisher.verified_domain else None,
                    "record_value": record_value(publisher.domain_token) if publisher.domain_token else None,
                    "key_fingerprint": fingerprint,
                    "review_required": publisher.review_required,
                    "frozen_at": publisher.frozen_at,
                    "frozen_reason": publisher.frozen_reason,
                },
                "grandfather": qualification.grandfather_view(session, publisher),
                "rows": rows,
                "reports": reports.publisher_reports(session, publisher),
                "report_reasons": dict(reports.REASONS),
                "extension_count": len({r["identity"] for r in rows}),
                "in_review": sum(1 for r in rows if r["status"] == review.PENDING),
                "tokens": tokens,
                "max_token_days": MAX_TOKEN_DAYS,
                "owned_count": len(owned_publishers(session, viewer.member_id)),
                "registry_url": str(request.base_url).rstrip("/"),
            }
        context.update(extra or {})
        return page(request, "publisher_dashboard.html", context, status=status)

    @router.get("/publisher/{namespace}", response_class=HTMLResponse)
    @guarded
    def namespace_dashboard(request: Request, namespace: str) -> Response:
        viewer = _require_viewer(request)
        return _namespace_page(request, viewer, namespace)

    @router.post("/publisher/{namespace}/key")
    @guarded
    def set_key(request: Request, namespace: str, public_key: str = Form(""), csrf: str = Form("")) -> Response:
        viewer = _require_viewer(request)
        _check_csrf(request, viewer, csrf)
        with _session(request) as session:
            publisher = _owned_or_404(session, viewer, namespace)
            try:
                set_public_key(session, publisher, public_key)
            except SelfServiceError as exc:
                return _namespace_page(request, viewer, namespace, {"key_error": str(exc)}, status=400)
        return _redirect(request, f"/publisher/{namespace}")

    @router.post("/publisher/{namespace}/domain")
    @guarded
    def add_domain(request: Request, namespace: str, domain: str = Form(""), csrf: str = Form("")) -> Response:
        viewer = _require_viewer(request)
        _check_csrf(request, viewer, csrf)
        with _session(request) as session:
            publisher = _owned_or_404(session, viewer, namespace)
            try:
                set_domain(session, publisher, domain)
            except DomainError as exc:
                return _namespace_page(request, viewer, namespace, {"domain_error": str(exc)}, status=400)
        return _redirect(request, f"/publisher/{namespace}")

    @router.post("/publisher/{namespace}/domain/check")
    @guarded
    def verify_domain(request: Request, namespace: str, csrf: str = Form("")) -> Response:
        viewer = _require_viewer(request)
        _check_csrf(request, viewer, csrf)
        with _session(request) as session:
            publisher = _owned_or_404(session, viewer, namespace)
            try:
                found = check_domain(session, publisher, request.app.state.registry.txt_resolver)
            except SelfServiceError as exc:
                return _namespace_page(request, viewer, namespace, {"domain_error": str(exc)}, status=400)
        if not found:
            return _namespace_page(
                request, viewer, namespace, {"domain_check": "not found yet — DNS can take up to 1 hour."}
            )
        return _redirect(request, f"/publisher/{namespace}")

    @router.post("/publisher/{namespace}/tokens")
    @guarded
    def new_token(
        request: Request,
        namespace: str,
        label: str = Form(""),
        days: int = Form(30),
        csrf: str = Form(""),
    ) -> Response:
        viewer = _require_viewer(request)
        _check_csrf(request, viewer, csrf)
        with _session(request) as session:
            publisher = _owned_or_404(session, viewer, namespace)
            try:
                plain, row = create_token(session, publisher, label=label, days=days)
            except SelfServiceError as exc:
                return _namespace_page(request, viewer, namespace, {"token_error": str(exc)}, status=400)
            expires = row.expires_at
        return _namespace_page(
            request, viewer, namespace, {"new_token": plain, "new_token_label": label.strip(), "new_token_expires": expires}
        )

    @router.post("/publisher/{namespace}/tokens/{token_id}/revoke")
    @guarded
    def revoke(request: Request, namespace: str, token_id: int, csrf: str = Form("")) -> Response:
        viewer = _require_viewer(request)
        _check_csrf(request, viewer, csrf)
        with _session(request) as session:
            publisher = _owned_or_404(session, viewer, namespace)
            if not revoke_token(session, publisher, token_id):
                raise HTTPException(status_code=404, detail="token not found")
        return _redirect(request, f"/publisher/{namespace}")

    # -- member ratings (p3-rating-auth) ---------------------------------
    def _public_extension(session: Session, namespace: str, name: str) -> Extension:
        extension = RegistryRepository(session).get_extension(namespace, name)
        if extension is None:
            raise HTTPException(status_code=404, detail="extension not found")
        return extension

    def _rate_limited(request: Request, limiter_name: str, viewer: cloud_auth.Viewer) -> None:
        limiter = getattr(request.app.state.registry, limiter_name)
        if not limiter.allow(viewer.member_id, time.time()):
            raise HTTPException(status_code=429, detail="too many requests; try again later")

    @router.post("/extensions/{namespace}/{name}/rating")
    @guarded
    def rate(request: Request, namespace: str, name: str, score: int = Form(0), csrf: str = Form("")) -> Response:
        viewer = _require_viewer(request, f"/extensions/{namespace}/{name}")
        _check_csrf(request, viewer, csrf)
        with _session(request) as session:
            extension = _public_extension(session, namespace, name)
            if ratings.is_own_extension(session, extension, viewer.member_id):
                raise HTTPException(status_code=403, detail="publishers cannot rate their own extensions")
            _rate_limited(request, "rating_limiter", viewer)
            try:
                ratings.set_rating(session, extension, viewer.member_id, score)
            except ratings.RatingError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
        return _redirect(request, f"/extensions/{namespace}/{name}#rating")

    @router.post("/extensions/{namespace}/{name}/rating/delete")
    @guarded
    def unrate(request: Request, namespace: str, name: str, csrf: str = Form("")) -> Response:
        viewer = _require_viewer(request, f"/extensions/{namespace}/{name}")
        _check_csrf(request, viewer, csrf)
        with _session(request) as session:
            extension = _public_extension(session, namespace, name)
            _rate_limited(request, "rating_limiter", viewer)
            ratings.remove_rating(session, extension, viewer.member_id)
        return _redirect(request, f"/extensions/{namespace}/{name}#rating")

    # -- member reports (p3-moderation) ---------------------------------
    def _report_page(request: Request, extension: Extension, versions: list[str], extra: dict, status: int = 200) -> Response:
        context = {
            "ext": {"namespace": extension.namespace, "name": extension.name, "identity": extension.identity,
                    "display_name": extension.display_name or extension.name},
            "versions": versions,
            "reasons": reports.REASONS,
            "max_detail": reports.MAX_DETAIL_LENGTH,
            "form": {"reason": "", "version": "", "detail": ""},
        }
        context.update(extra)
        return page(request, "report.html", context, status=status)

    def _version_names(session: Session, extension: Extension) -> list[str]:
        rows = RegistryRepository(session).list_versions(extension.id)
        return sorted({r.version for r in rows}, reverse=True)

    @router.get("/extensions/{namespace}/{name}/report", response_class=HTMLResponse)
    @guarded
    def report_form(request: Request, namespace: str, name: str) -> Response:
        viewer = _require_viewer(request)
        with _session(request) as session:
            extension = _public_extension(session, namespace, name)
            already = reports.has_open_report(session, extension, viewer.member_id)
            return _report_page(request, extension, _version_names(session, extension), {"already_open": already})

    @router.post("/extensions/{namespace}/{name}/report")
    @guarded
    def submit_report(
        request: Request,
        namespace: str,
        name: str,
        reason: str = Form(""),
        version: str = Form(""),
        detail: str = Form(""),
        csrf: str = Form(""),
    ) -> Response:
        viewer = _require_viewer(request, f"/extensions/{namespace}/{name}/report")
        _check_csrf(request, viewer, csrf)
        with _session(request) as session:
            extension = _public_extension(session, namespace, name)
            _rate_limited(request, "report_limiter", viewer)
            try:
                reports.create_report(
                    session, extension=extension, member_id=viewer.member_id, reason=reason, detail=detail, version=version
                )
            except reports.ReportError as exc:
                return _report_page(
                    request,
                    extension,
                    _version_names(session, extension),
                    {"error": str(exc), "form": {"reason": reason, "version": version, "detail": detail}},
                    status=400,
                )
            return _report_page(request, extension, [], {"submitted": True})

    @router.get("/admin/reports", response_class=HTMLResponse)
    @guarded
    def admin_reports(request: Request) -> Response:
        _require_admin(request)
        with _session(request) as session:
            open_items, resolved = reports.admin_queue(session)
        return page(
            request,
            "admin_reports.html",
            {"open_items": open_items, "resolved": resolved, "reasons": dict(reports.REASONS)},
        )

    @router.post("/admin/reports/{report_id}/resolve")
    @guarded
    def admin_resolve_report(
        request: Request, report_id: int, action: str = Form(""), note: str = Form(""), csrf: str = Form("")
    ) -> Response:
        viewer = _require_admin(request)
        _check_csrf(request, viewer, csrf)
        with _session(request) as session:
            try:
                reports.resolve(session, report_id=report_id, actor=f"member:{viewer.member_id}", action=action, note=note)
            except LookupError as exc:
                raise HTTPException(status_code=404, detail=str(exc)) from exc
            except reports.ReportError as exc:
                open_items, resolved = reports.admin_queue(session)
                return page(
                    request,
                    "admin_reports.html",
                    {"open_items": open_items, "resolved": resolved, "reasons": dict(reports.REASONS),
                     "error": f"Report #{report_id}: {exc}"},
                    status=409,
                )
        return _redirect(request, "/admin/reports")

    # -- CLI login: browser + loopback + state + PKCE --------------------
    def _cli_params_ok(port: int, state: str, code_challenge: str) -> bool:
        return (
            1024 <= port <= 65535
            and 16 <= len(state) <= 128
            and 43 <= len(code_challenge) <= 128
            and _CLI_TOKEN_RE.fullmatch(state) is not None
            and _CLI_TOKEN_RE.fullmatch(code_challenge) is not None
        )

    @router.get("/cli/authorize", response_class=HTMLResponse)
    @guarded
    def cli_authorize_form(
        request: Request,
        port: int = 0,
        state: str = "",
        code_challenge: str = "",
        label: str = "navide-plugin CLI",
        scope: str = SCOPE_PUBLISH,
    ) -> Response:
        if not _cli_params_ok(port, state, code_challenge) or scope not in CLI_SCOPES:
            raise HTTPException(status_code=400, detail="invalid CLI login request")
        viewer = _require_viewer(request)
        with _session(request) as session:
            # Only a namespace that may publish is offered (qualification.py).
            namespaces = [
                p.name for p in owned_publishers(session, viewer.member_id) if qualification.publisher_vetted(session, p)
            ]
            qualification_status = qualification.status_of(session, viewer.member_id)
        return page(
            request,
            "cli_authorize.html",
            {
                "namespaces": namespaces,
                "port": port,
                "state": state,
                "code_challenge": code_challenge,
                "label": label[:64],
                "scope": scope,
                "qualification": qualification_status,
            },
        )

    @router.post("/cli/authorize")
    @guarded
    def cli_authorize(
        request: Request,
        namespace: str = Form(""),
        port: int = Form(0),
        state: str = Form(""),
        code_challenge: str = Form(""),
        label: str = Form("navide-plugin CLI"),
        scope: str = Form(SCOPE_PUBLISH),
        csrf: str = Form(""),
    ) -> Response:
        viewer = _require_viewer(request)
        _check_csrf(request, viewer, csrf)
        if not _cli_params_ok(port, state, code_challenge) or scope not in CLI_SCOPES:
            raise HTTPException(status_code=400, detail="invalid CLI login request")
        with _session(request) as session:
            try:
                if scope == SCOPE_ACCOUNT:
                    code = issue_account_code(
                        session, viewer.member_id, code_challenge=code_challenge, label=label
                    )
                else:
                    publisher = _owned_or_404(session, viewer, namespace)
                    code = issue_cli_code(session, publisher, code_challenge=code_challenge, label=label)
            except QualificationRequired as exc:
                raise HTTPException(status_code=403, detail={"code": exc.code, "message": str(exc)}) from exc
            except SelfServiceError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
        query = urllib.parse.urlencode({"code": code, "state": state})
        # Loopback only: the port is the sole caller-chosen part of the URL.
        return RedirectResponse(f"http://127.0.0.1:{port}/callback?{query}", status_code=303, headers=_NO_STORE)

    @router.post("/cli/deny")
    @guarded
    def cli_deny(
        request: Request,
        port: int = Form(0),
        state: str = Form(""),
        code_challenge: str = Form(""),
        csrf: str = Form(""),
    ) -> Response:
        """Cancel: no code is issued; the CLI is told so it stops waiting."""
        viewer = _require_viewer(request)
        _check_csrf(request, viewer, csrf)
        if not _cli_params_ok(port, state, code_challenge):
            raise HTTPException(status_code=400, detail="invalid CLI login request")
        query = urllib.parse.urlencode({"error": "access_denied", "state": state})
        return RedirectResponse(f"http://127.0.0.1:{port}/callback?{query}", status_code=303, headers=_NO_STORE)

    @router.post("/api/cli/token")
    def cli_token(request: Request, body: CliTokenRequest) -> JSONResponse:
        """Exchange a one-time code for a token: a publisher token for a
        namespace (scope "publisher"), or an account token when the code came
        from `/cli/authorize?scope=account` (scope "account", namespace null)."""
        with _session(request) as session:
            try:
                if find_account_code(session, body.code) is not None:
                    plain, account = exchange_account_code(session, code=body.code, code_verifier=body.code_verifier)
                    return JSONResponse(
                        {
                            "token": plain,
                            "scope": "account",
                            "namespace": None,
                            "expires_at": account.expires_at.isoformat(),
                        },
                        headers=_NO_STORE,
                    )
                plain, row, publisher = exchange_cli_code(session, code=body.code, code_verifier=body.code_verifier)
            except QualificationRequired as exc:
                raise HTTPException(status_code=403, detail={"code": exc.code, "message": str(exc)}) from exc
            except SelfServiceError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            return JSONResponse(
                {
                    "token": plain,
                    "scope": "publisher",
                    "namespace": publisher.name,
                    "expires_at": row.expires_at.isoformat(),
                },
                headers=_NO_STORE,
            )

    # -- admin review queue (card 10) -----------------------------------
    def _queue_view(session: Session) -> list[dict]:
        items = []
        for group in review.review_queue(session):
            report = group["reports"][0] if group["reports"] else {}
            findings = [f for r in group["reports"] for f in review.secret_findings(r)]
            items.append(
                {
                    "identity": group["extension"].identity,
                    "namespace": group["extension"].namespace,
                    "name": group["extension"].name,
                    "version": group["version"],
                    "targets": group["targets"],
                    "artifacts": group["artifacts"],
                    "publisher": group["publisher"].name if group["publisher"] else None,
                    "publisher_domain": verified_domain(group["publisher"]),
                    "submitted_at": group["submitted_at"],
                    "waiting": review.format_wait(group["waiting"]),
                    "overdue": group["overdue"],
                    "deadline": group["deadline"],
                    "signature": _manifest_check(report),
                    "similarity": report.get("similarity", []),
                    "similarity_blocked": any(review.blocking_similarity(r) for r in group["reports"]),
                    "secret_findings": findings,
                    "files_scanned": (report.get("secret_scan") or {}).get("files_scanned", 0),
                    "capabilities": report.get("capabilities", []),
                    "sensitive_capabilities": report.get("sensitive_capabilities", []),
                    "size": report.get("size", 0),
                    "size_limit": report.get("size_limit", 0),
                    "native_backend": any(r.get("native_backend") for r in group["reports"]),
                }
            )
        return items

    @router.get("/admin/review", response_class=HTMLResponse)
    @guarded
    def admin_review(request: Request) -> Response:
        _require_admin(request)
        with _session(request) as session:
            items = _queue_view(session)
        oldest = items[0]["waiting"] if items else None
        return page(
            request,
            "admin_review.html",
            {"items": items, "oldest": oldest, "sla_days": review.SLA_BUSINESS_DAYS},
        )

    def _decide(request: Request, namespace: str, name: str, version: str, reviewer: str, action: str, artifacts: list[str], *, reason: str = "", acknowledge: bool = False, inspected_native_backend: bool = False) -> None:
        state = request.app.state.registry
        with _session(request) as session:
            repo = RegistryRepository(session)
            extension = repo.get_extension(namespace, name, public_only=False)
            if extension is None:
                raise HTTPException(status_code=404, detail="extension not found")
            try:
                if action == "approve":
                    review.approve(
                        session,
                        state.trust_signer,
                        extension=extension,
                        version=version,
                        reviewer=reviewer,
                        artifacts=artifacts,
                        acknowledge_secret_findings=acknowledge,
                        inspected_native_backend=inspected_native_backend,
                        rescan=lambda row: scan_stored_version(state.storage, row),
                    )
                else:
                    review.reject(
                        session, extension=extension, version=version, reviewer=reviewer, reason=reason, artifacts=artifacts
                    )
            except review.ReviewError as exc:
                raise HTTPException(status_code=409, detail=str(exc)) from exc

    @router.post("/admin/review/{namespace}/{name}/{version}/approve")
    @guarded
    def admin_approve(
        request: Request, namespace: str, name: str, version: str, csrf: str = Form(""), acknowledge: str = Form(""),
        artifact: list[str] = Form([]), inspected_backend: str = Form(""),
    ) -> Response:
        viewer = _require_admin(request)
        _check_csrf(request, viewer, csrf)
        _decide(
            request, namespace, name, version, f"member:{viewer.member_id}", "approve", artifact,
            acknowledge=acknowledge == "yes", inspected_native_backend=inspected_backend == "yes",
        )
        return _redirect(request, "/admin/review")

    @router.post("/admin/review/{namespace}/{name}/{version}/reject")
    @guarded
    def admin_reject(
        request: Request, namespace: str, name: str, version: str, csrf: str = Form(""), reason: str = Form(""),
        artifact: list[str] = Form([]),
    ) -> Response:
        viewer = _require_admin(request)
        _check_csrf(request, viewer, csrf)
        _decide(request, namespace, name, version, f"member:{viewer.member_id}", "reject", artifact, reason=reason)
        return _redirect(request, "/admin/review")

    @router.get("/admin/review/{namespace}/{name}/{version}/{target}/package")
    @guarded
    def admin_download(request: Request, namespace: str, name: str, version: str, target: str) -> Response:
        _require_admin(request)
        with _session(request) as session:
            repo = RegistryRepository(session)
            extension = repo.get_extension(namespace, name, public_only=False)
            row = None
            if extension is not None:
                row = next(
                    (
                        r
                        for r in repo.list_version_artifacts(extension.id, version, public_only=False)
                        if r.target == target
                    ),
                    None,
                )
            if row is None:
                raise HTTPException(status_code=404, detail="version not found")
            key = row.package_key
        try:
            data = request.app.state.registry.storage.get(key)
        except StorageError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        return Response(
            data,
            media_type="application/zip",
            headers={
                "Content-Disposition": f'attachment; filename="{namespace}.{name}-{version}@{target}.vsix"',
                **_NO_STORE,
            },
        )

    # -- blocklist + removed list ---------------------------------------
    @router.get("/admin/blocklist", response_class=HTMLResponse)
    @guarded
    def admin_blocklist(request: Request) -> Response:
        _require_admin(request)
        with _session(request) as session:
            items = removed_list(session, _settings(request))
            entries = {(e.kind, e.value): e.id for e in db_entries(session)}
        for item in items:
            item["id"] = entries.get((item["kind"], item["value"]))
        return page(request, "admin_blocklist.html", {"items": items})

    @router.post("/admin/blocklist")
    @guarded
    def admin_block(
        request: Request,
        kind: str = Form(""),
        value: str = Form(""),
        reason: str = Form(""),
        digest_reason: str = Form(""),
        csrf: str = Form(""),
    ) -> Response:
        viewer = _require_admin(request)
        _check_csrf(request, viewer, csrf)
        with _session(request) as session:
            try:
                add_entry(
                    session,
                    kind=kind,
                    value=value,
                    reason=reason,
                    created_by=f"member:{viewer.member_id}",
                    digest_reason=(digest_reason or None) if kind == "digest" else None,
                )
            except BlocklistError as exc:
                items = removed_list(session, _settings(request))
                return page(request, "admin_blocklist.html", {"items": items, "error": str(exc)}, status=400)
        return _redirect(request, "/admin/blocklist")

    @router.post("/admin/blocklist/{entry_id}/delete")
    @guarded
    def admin_unblock(request: Request, entry_id: int, csrf: str = Form("")) -> Response:
        viewer = _require_admin(request)
        _check_csrf(request, viewer, csrf)
        with _session(request) as session:
            if not remove_entry(session, entry_id, actor=f"member:{viewer.member_id}"):
                raise HTTPException(status_code=404, detail="entry not found")
        return _redirect(request, "/admin/blocklist")

    # -- native backend allowlist ---------------------------------------
    @router.get("/admin/native-backends", response_class=HTMLResponse)
    @guarded
    def admin_native_backends(request: Request) -> Response:
        _require_admin(request)
        with _session(request) as session:
            publishers = [
                {
                    "name": p.name,
                    "allowed": p.native_backend_allowed,
                    "domain": verified_domain(p),
                }
                for p in self_service_publishers(session)
            ]
        return page(request, "admin_native_backends.html", {"publishers": publishers})

    @router.post("/admin/native-backends/{name}")
    @guarded
    def admin_set_native_backend(
        request: Request, name: str, allowed: str = Form(""), csrf: str = Form("")
    ) -> Response:
        viewer = _require_admin(request)
        _check_csrf(request, viewer, csrf)
        with _session(request) as session:
            if set_native_backend_allowed(session, name, allowed == "yes") is None:
                raise HTTPException(status_code=404, detail="publisher not found")
        return _redirect(request, "/admin/native-backends")

    @router.get("/removed", response_class=HTMLResponse)
    def removed_page(request: Request) -> HTMLResponse:
        with _session(request) as session:
            items = removed_list(session, _settings(request))
        return templates.TemplateResponse(request, "removed.html", {"items": items})

    @router.get("/api/removed")
    def removed_api(request: Request) -> JSONResponse:
        with _session(request) as session:
            items = removed_list(session, _settings(request))
        return JSONResponse(
            {
                "items": [
                    {
                        "kind": i["kind"],
                        "id": i["value"],
                        "reason": i["reason"],
                        "removed_at": i["removed_at"].isoformat() if i["removed_at"] else None,
                    }
                    for i in items
                ]
            }
        )

    # -- admin JSON API (X-Admin-Token) ---------------------------------
    @router.get("/api/admin/review")
    def api_review_queue(request: Request, x_admin_token: str | None = Header(default=None)) -> JSONResponse:
        _require_admin_token(request, x_admin_token)
        with _session(request) as session:
            items = _queue_view(session)
        for item in items:
            item["submitted_at"] = item["submitted_at"].isoformat()
            item["deadline"] = item["deadline"].isoformat()
        return JSONResponse({"items": items})

    @router.post("/api/admin/review/{namespace}/{name}/{version}/approve")
    def api_approve(
        request: Request,
        namespace: str,
        name: str,
        version: str,
        body: ApproveRequest | None = None,
        x_admin_token: str | None = Header(default=None),
    ) -> JSONResponse:
        _require_admin_token(request, x_admin_token)
        _decide(
            request,
            namespace,
            name,
            version,
            "admin-token",
            "approve",
            body.artifacts if body else [],
            acknowledge=bool(body and body.acknowledge_secret_findings),
            inspected_native_backend=bool(body and body.inspected_native_backend),
        )
        return JSONResponse({"identity": f"{namespace}.{name}", "version": version, "review_status": review.APPROVED})

    @router.post("/api/admin/review/{namespace}/{name}/{version}/reject")
    def api_reject(
        request: Request,
        namespace: str,
        name: str,
        version: str,
        body: RejectRequest,
        x_admin_token: str | None = Header(default=None),
    ) -> JSONResponse:
        _require_admin_token(request, x_admin_token)
        _decide(request, namespace, name, version, "admin-token", "reject", body.artifacts, reason=body.reason)
        return JSONResponse({"identity": f"{namespace}.{name}", "version": version, "review_status": review.REJECTED})

    @router.post("/api/admin/blocklist", status_code=201)
    def api_block(request: Request, body: BlockRequest, x_admin_token: str | None = Header(default=None)) -> JSONResponse:
        _require_admin_token(request, x_admin_token)
        with _session(request) as session:
            try:
                entry = add_entry(
                    session,
                    kind=body.kind,
                    value=body.value,
                    reason=body.reason,
                    created_by="admin-token",
                    digest_reason=body.digest_reason,
                )
            except BlocklistError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            return JSONResponse(
                {"id": entry.id, "kind": entry.kind, "value": entry.value, "digest_reason": entry.digest_reason},
                status_code=201,
            )

    @router.delete("/api/admin/blocklist/{entry_id}")
    def api_unblock(request: Request, entry_id: int, x_admin_token: str | None = Header(default=None)) -> Response:
        _require_admin_token(request, x_admin_token)
        with _session(request) as session:
            if not remove_entry(session, entry_id, actor="admin-token"):
                raise HTTPException(status_code=404, detail="entry not found")
        return Response(status_code=204)

    register_developer_routes(
        router,
        page=page,
        guarded=guarded,
        require_viewer=_require_viewer,
        require_admin=_require_admin,
        check_csrf=_check_csrf,
        require_admin_token=_require_admin_token,
        redirect=_redirect,
    )
    return router

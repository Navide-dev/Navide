"""Developer qualification routes (qualification.py): the applicant's own
application and versions over bearer tokens (account_auth.py), the website
application page, and the admin application queue (website and
`X-Admin-Token` JSON API).

JSON errors carry a stable `detail.code`, for example APPLICATION_EXISTS,
APPLICATION_INVALID, QUALIFICATION_REQUIRED, TOKEN_SCOPE and the TOKEN_*
codes. A token or key never appears in a response or the audit trail.
"""

from __future__ import annotations

from datetime import timezone

from fastapi import APIRouter, Form, Header, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel
from sqlmodel import Session, select

from . import audit, qualification, review
from .account_auth import SCOPE_PUBLISHER, Bearer, BearerError, require_bearer
from .models import Extension, ExtensionVersion, Publisher
from .plugin_contract.disclosure_scan_contract import card_risk_level, declared_vs_scanned
from .self_service import QualificationRequired, SelfServiceError, owned_publishers, set_public_key
from .signing import public_key_fingerprint
from .versions import version_channel

_NO_STORE = {"Cache-Control": "no-store"}


class ApplicationRequest(BaseModel):
    fields: dict
    field_sources: dict = {}
    source: str | None = None


class KeyRequest(BaseModel):
    public_key: str


class DecisionRequest(BaseModel):
    reason: str = ""


def _error(status: int, code: str, message: str, **extra: object) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message, **extra})


def _bearer(request: Request, authorization: str | None) -> Bearer:
    with Session(request.app.state.registry.engine) as session:
        try:
            return require_bearer(session, authorization)
        except BearerError as exc:
            raise exc.http() from exc


def _member(bearer: Bearer) -> str:
    if bearer.member_id is None:
        raise _error(403, "TOKEN_SCOPE", "this token does not belong to a Navide Cloud account")
    return bearer.member_id


def _publisher_bearer(bearer: Bearer) -> Publisher:
    if bearer.scope != SCOPE_PUBLISHER or bearer.publisher is None:
        raise _error(403, "TOKEN_SCOPE", "this endpoint needs a publisher token")
    return bearer.publisher


def _iso(value) -> str | None:
    if value is None:
        return None
    return (value if value.tzinfo else value.replace(tzinfo=timezone.utc)).isoformat()


def _fingerprint(publisher: Publisher) -> str | None:
    if not publisher.public_key:
        return None
    try:
        return public_key_fingerprint(publisher.public_key)
    except Exception:  # noqa: BLE001 - an unparsable key reads as unset
        return None


def _scan_view(row: ExtensionVersion) -> dict:
    if not row.disclosure:
        return {"risk": None, "declared_vs_scanned": None}
    return {
        "risk": card_risk_level(row.disclosure, row.scan),
        "declared_vs_scanned": declared_vs_scanned(row.disclosure, row.scan) if row.scan else None,
    }


def version_items(
    session: Session, publishers: list[Publisher], *, extension: str | None = None, version: str | None = None
) -> list[dict]:
    """One item per version (its targets grouped), newest submission first."""
    items: dict[tuple[int, str], dict] = {}
    for publisher in publishers:
        extensions = session.exec(select(Extension).where(Extension.publisher_id == publisher.id)).all()
        for ext in extensions:
            if extension is not None and ext.identity != extension:
                continue
            rows = session.exec(select(ExtensionVersion).where(ExtensionVersion.extension_id == ext.id)).all()
            for row in sorted(rows, key=lambda r: r.target):
                if version is not None and row.version != version:
                    continue
                item = items.setdefault(
                    (ext.id, row.version),
                    {
                        "namespace": ext.namespace,
                        "name": ext.name,
                        "identity": ext.identity,
                        "version": row.version,
                        "channel": row.channel or version_channel(row.version),
                        "targets": [],
                        "status": row.review_status,
                        "reason": row.review_reason if row.review_status == review.REJECTED else None,
                        "yanked": False,
                        "submitted_at": row.published_at,
                        "reviewed_at": row.reviewed_at,
                        "scan_by_target": {},
                    },
                )
                item["targets"].append(row.target)
                item["yanked"] = item["yanked"] or row.yanked
                item["scan_by_target"][row.target] = _scan_view(row)
    ordered = sorted(items.values(), key=lambda i: _iso(i["submitted_at"]), reverse=True)
    for item in ordered:
        item["submitted_at"] = _iso(item["submitted_at"])
        item["reviewed_at"] = _iso(item["reviewed_at"])
    return ordered


def _admin_view(row) -> dict:
    return {
        "member_id": row.navide_member_id,
        "status": row.status,
        "fields": row.application,
        "field_sources": row.field_sources,
        "source": row.source,
        "submitted_at": _iso(row.submitted_at),
        "decided_at": _iso(row.decided_at),
        "decided_by": row.decided_by,
        "reason": row.reason,
    }


def register_developer_routes(router: APIRouter, *, page, guarded, require_viewer, require_admin, check_csrf, require_admin_token, redirect) -> None:
    """Add the routes to the publisher router, reusing its page and guard helpers."""

    def session_of(request: Request) -> Session:
        return Session(request.app.state.registry.engine)

    # -- applicant: JSON over bearer tokens -------------------------------
    @router.get("/api/developer/me/application")
    def my_application(request: Request, authorization: str | None = Header(default=None)) -> JSONResponse:
        member_id = _member(_bearer(request, authorization))
        with session_of(request) as session:
            body = qualification.view(qualification.get(session, member_id))
        return JSONResponse(body, headers=_NO_STORE)

    @router.post("/api/developer/me/application", status_code=201)
    def submit_application(
        request: Request, body: ApplicationRequest, authorization: str | None = Header(default=None)
    ) -> JSONResponse:
        member_id = _member(_bearer(request, authorization))
        with session_of(request) as session:
            try:
                row = qualification.submit_application(
                    session, member_id, fields=body.fields, field_sources=body.field_sources, source=body.source
                )
            except qualification.QualificationError as exc:
                status = 422 if exc.code == "APPLICATION_INVALID" else 409
                extra = {"field": exc.field} if exc.field else {}
                raise _error(status, exc.code, exc.message, **extra) from exc
            return JSONResponse(
                {"status": row.status, "submitted_at": _iso(row.submitted_at)}, status_code=201, headers=_NO_STORE
            )

    @router.get("/api/publisher/me")
    def publisher_me(request: Request, authorization: str | None = Header(default=None)) -> JSONResponse:
        bearer = _bearer(request, authorization)
        publisher = _publisher_bearer(bearer)
        with session_of(request) as session:
            status = (
                qualification.status_of(session, publisher.navide_member_id)
                if publisher.navide_member_id is not None
                else qualification.APPROVED
            )
        return JSONResponse(
            {
                "namespace": publisher.name,
                "display_name": publisher.display_name,
                "qualification": status,
                "frozen": publisher.frozen_at is not None,
                "public_key_fingerprint": _fingerprint(publisher),
                "token_expires_at": _iso(bearer.expires_at),
            },
            headers=_NO_STORE,
        )

    @router.put("/api/publisher/me/key")
    def publisher_key(request: Request, body: KeyRequest, authorization: str | None = Header(default=None)) -> JSONResponse:
        publisher = _publisher_bearer(_bearer(request, authorization))
        with session_of(request) as session:
            publisher = session.get(Publisher, publisher.id)
            try:
                fingerprint = set_public_key(session, publisher, body.public_key)
            except QualificationRequired as exc:
                raise _error(403, exc.code, str(exc)) from exc
            except SelfServiceError as exc:
                raise _error(400, "KEY_INVALID", str(exc)) from exc
        return JSONResponse({"public_key_fingerprint": fingerprint}, headers=_NO_STORE)

    @router.get("/api/publisher/me/versions")
    def my_versions(
        request: Request,
        extension: str | None = None,
        version: str | None = None,
        authorization: str | None = Header(default=None),
    ) -> JSONResponse:
        bearer = _bearer(request, authorization)
        with session_of(request) as session:
            if bearer.publisher is not None:
                publishers = [bearer.publisher]
                namespace = bearer.publisher.name
            else:
                publishers = owned_publishers(session, _member(bearer))
                namespace = None
            if extension is not None and extension.partition(".")[0] not in {p.name for p in publishers}:
                raise _error(404, "NOT_FOUND", "extension not found")
            items = version_items(session, publishers, extension=extension, version=version)
        return JSONResponse({"namespace": namespace, "items": items}, headers=_NO_STORE)

    # -- applicant: website -----------------------------------------------
    def apply_page(request: Request, viewer, extra: dict | None = None, status: int = 200) -> Response:
        with session_of(request) as session:
            current = qualification.view(qualification.get(session, viewer.member_id))
        context = {
            "current": current,
            "can_apply": current["status"] in (qualification.NONE, qualification.REJECTED),
            "values": (current["fields"] or {}),
            "countries_hint": "ISO 3166-1 alpha-2, for example TW",
        }
        context.update(extra or {})
        return page(request, "developer_apply.html", context, status=status)

    @router.get("/developer/apply")
    @guarded
    def apply_form(request: Request) -> Response:
        viewer = require_viewer(request)
        return apply_page(request, viewer)

    @router.post("/developer/apply")
    @guarded
    def apply_submit(
        request: Request,
        csrf: str = Form(""),
        applicant_type: str = Form(""),
        legal_name: str = Form(""),
        display_name: str = Form(""),
        contact_email: str = Form(""),
        country: str = Form(""),
        intended_namespace: str = Form(""),
        description: str = Form(""),
        organization_name: str = Form(""),
        organization_id: str = Form(""),
        website: str = Form(""),
        source_url: str = Form(""),
        domain: str = Form(""),
        needs_native_backend: str = Form(""),
        agreed_terms: str = Form(""),
    ) -> Response:
        viewer = require_viewer(request, "/developer/apply")
        check_csrf(request, viewer, csrf)
        fields = {
            "applicant_type": applicant_type,
            "legal_name": legal_name,
            "display_name": display_name,
            "contact_email": contact_email,
            "country": country.strip().upper(),
            "intended_namespace": intended_namespace,
            "description": description,
            "organization_name": organization_name if applicant_type == "organization" else "",
            "organization_id": organization_id if applicant_type == "organization" else "",
            "website": website,
            "source_url": source_url,
            "domain": domain,
            "needs_native_backend": needs_native_backend == "yes",
            "agreed_terms": agreed_terms == "yes",
        }
        with session_of(request) as session:
            try:
                qualification.submit_application(session, viewer.member_id, fields=fields, source="web")
            except qualification.QualificationError as exc:
                return apply_page(request, viewer, {"error": exc.message, "values": fields}, status=400)
        return redirect(request, "/developer/apply")

    # -- admin queue: website ---------------------------------------------
    @router.get("/admin/developers")
    @guarded
    def admin_developers(request: Request) -> Response:
        require_admin(request)
        with session_of(request) as session:
            pending = [_admin_view(r) for r in qualification.queue(session, qualification.PENDING)]
            approved = [_admin_view(r) for r in qualification.queue(session, qualification.APPROVED)]
            closed = [
                _admin_view(r)
                for r in qualification.queue(session, None)
                if r.status in (qualification.REJECTED, qualification.REVOKED)
            ]
            for item in approved:
                item["namespaces"] = [p.name for p in owned_publishers(session, item["member_id"])]
        return page(request, "admin_developers.html", {"pending": pending, "approved": approved, "closed": closed})

    def decide(request: Request, member_id: str, action: str, actor: str, reason: str):
        with session_of(request) as session:
            try:
                if action == "revoke":
                    return qualification.revoke(session, member_id, actor=actor, reason=reason)
                return qualification.decide(session, member_id, approve=action == "approve", actor=actor, reason=reason)
            except qualification.QualificationError as exc:
                status = 404 if exc.code == "NOT_FOUND" else 409 if exc.code in ("NOT_PENDING", "NOT_APPROVED") else 400
                raise _error(status, exc.code, exc.message) from exc

    # The action is bound by a factory, never a parameter FastAPI could read
    # from the query string.
    def web_decider(action: str):
        def admin_decide(request: Request, member_id: str, csrf: str = Form(""), reason: str = Form("")) -> Response:
            viewer = require_admin(request)
            check_csrf(request, viewer, csrf)
            decide(request, member_id, action, audit.admin_actor(viewer.member_id), reason)
            return redirect(request, "/admin/developers")

        return admin_decide

    for action in ("approve", "reject", "revoke"):
        router.post(f"/admin/developers/{{member_id}}/{action}")(guarded(web_decider(action)))

    # -- admin queue: JSON (X-Admin-Token) --------------------------------
    @router.get("/api/admin/developers")
    def api_developers(request: Request, status: str | None = "pending", x_admin_token: str | None = Header(default=None)) -> JSONResponse:
        require_admin_token(request, x_admin_token)
        with session_of(request) as session:
            rows = qualification.queue(session, None if status == "all" else status)
            items = [_admin_view(r) for r in rows]
        return JSONResponse({"items": items}, headers=_NO_STORE)

    def api_decider(action: str):
        def api_decide(
            request: Request,
            member_id: str,
            body: DecisionRequest | None = None,
            x_admin_token: str | None = Header(default=None),
        ) -> JSONResponse:
            require_admin_token(request, x_admin_token)
            result = decide(request, member_id, action, audit.ADMIN_TOKEN_ACTOR, body.reason if body else "")
            if action == "revoke":
                return JSONResponse(
                    {
                        "member_id": member_id,
                        "status": qualification.REVOKED,
                        "namespaces": result.namespaces,
                        "tokens_revoked": result.tokens_revoked,
                        "versions_yanked": result.versions_yanked,
                        "keys_revoked": result.keys_revoked,
                    }
                )
            return JSONResponse({"member_id": member_id, "status": result.status})

        return api_decide

    for action in ("approve", "reject", "revoke"):
        router.post(f"/api/admin/developers/{{member_id}}/{action}")(api_decider(action))

    @router.get("/api/admin/audit")
    def api_audit(request: Request, target: str | None = None, limit: int = 200, x_admin_token: str | None = Header(default=None)) -> JSONResponse:
        require_admin_token(request, x_admin_token)
        with session_of(request) as session:
            rows = audit.entries(session, target=target, limit=max(1, min(limit, 1000)))
            items = [
                {
                    "id": r.id,
                    "at": _iso(r.created_at),
                    "actor": r.actor,
                    "action": r.action,
                    "target": r.target,
                    "reason": r.reason,
                    "detail": r.detail,
                }
                for r in rows
            ]
        return JSONResponse({"items": items}, headers=_NO_STORE)

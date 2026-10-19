"""Admin page for Testplace (/admin/testplace): the light review of public
test codes, promotion requests with their test facts, and force-revoke.
The JSON equivalents are in testplace_api.py."""

from __future__ import annotations

import functools

from fastapi import APIRouter, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, Response
from fastapi.templating import Jinja2Templates

from . import audit, cloud_auth, testplace
from .models import Extension
from .publisher_web import (
    _NO_STORE,
    _TEMPLATES_DIR,
    _Redirect,
    _check_csrf,
    _redirect,
    _require_admin,
    _session,
)
from .repository import RegistryRepository
from .web import _base_path_context, tile_hue


def create_testplace_admin_router() -> APIRouter:
    router = APIRouter(include_in_schema=False)
    templates = Jinja2Templates(
        directory=str(_TEMPLATES_DIR),
        context_processors=[_base_path_context, cloud_auth.viewer_context],
    )
    templates.env.filters["tile_hue"] = tile_hue

    def guarded(handler):
        @functools.wraps(handler)
        def wrapper(*args, **kwargs):
            try:
                return handler(*args, **kwargs)
            except _Redirect as redirect:
                return _redirect(kwargs.get("request") or args[0], redirect.location)

        return wrapper

    def render(request: Request, error: str | None = None, status: int = 200) -> HTMLResponse:
        with _session(request) as session:
            codes = []
            for row in testplace.code_queue(session):
                extension = session.get(Extension, row.extension_id)
                codes.append({"row": row, "identity": extension.identity})
            promotions = []
            for extension, version, rows in testplace.promotion_queue(session):
                promotions.append(
                    {
                        "extension": extension,
                        "version": version,
                        "artifacts": sorted(r.package_digest for r in rows),
                        "targets": [r.target for r in rows],
                        "requested_at": rows[0].promotion_requested_at,
                        "facts": testplace.promotion_facts(session, extension),
                    }
                )
        return templates.TemplateResponse(
            request,
            "admin_testplace.html",
            {"codes": codes, "promotions": promotions, "error": error},
            status_code=status,
            headers=_NO_STORE,
        )

    def extension_or_404(session, identity: str) -> Extension:
        namespace, _, name = identity.partition(".")
        extension = RegistryRepository(session).get_extension(namespace, name, public_only=False)
        if extension is None:
            raise HTTPException(status_code=404, detail="extension not found")
        return extension

    @router.get("/admin/testplace", response_class=HTMLResponse)
    @guarded
    def admin_testplace(request: Request) -> Response:
        _require_admin(request)
        return render(request)

    @router.post("/admin/testplace/codes/{code_id}")
    @guarded
    def admin_code(
        request: Request, code_id: int, decision: str = Form(""), reason: str = Form(""), csrf: str = Form("")
    ) -> Response:
        viewer = _require_admin(request)
        _check_csrf(request, viewer, csrf)
        actor = audit.admin_actor(viewer.member_id)
        with _session(request) as session:
            approve = decision == "approve"
            audit.record(
                session,
                actor=actor,
                action="testplace.code.approve" if approve else "testplace.code.reject",
                target=f"testplace-code:{code_id}",
                reason=reason or None,
            )
            try:
                testplace.decide_code(session, code_id, approve=approve, reviewer=actor, reason=reason)
            except testplace.TestplaceError as exc:
                return render(request, str(exc), status=exc.status)
        return _redirect(request, "/admin/testplace")

    @router.post("/admin/testplace/promotions/{namespace}/{name}/{version}")
    @guarded
    def admin_promotion(
        request: Request,
        namespace: str,
        name: str,
        version: str,
        decision: str = Form(""),
        reason: str = Form(""),
        artifact: list[str] = Form([]),
        csrf: str = Form(""),
    ) -> Response:
        viewer = _require_admin(request)
        _check_csrf(request, viewer, csrf)
        actor = audit.admin_actor(viewer.member_id)
        with _session(request) as session:
            extension = extension_or_404(session, f"{namespace}.{name}")
            approve = decision == "approve"
            audit.record(
                session,
                actor=actor,
                action="testplace.promotion.approve" if approve else "testplace.promotion.reject",
                target=f"extension:{extension.identity}@{version}",
                reason=reason or None,
            )
            try:
                if approve:
                    testplace.approve_promotion(
                        session,
                        request.app.state.registry.trust_signer,
                        extension=extension,
                        version=version,
                        reviewer=actor,
                        artifacts=artifact,
                    )
                else:
                    testplace.reject_promotion(
                        session, extension=extension, version=version, reviewer=actor, reason=reason, artifacts=artifact
                    )
            except testplace.TestplaceError as exc:
                return render(request, str(exc), status=exc.status)
        return _redirect(request, "/admin/testplace")

    @router.post("/admin/testplace/revoke")
    @guarded
    def admin_revoke(
        request: Request,
        identity: str = Form(""),
        version: str = Form(""),
        reason: str = Form(""),
        csrf: str = Form(""),
    ) -> Response:
        viewer = _require_admin(request)
        _check_csrf(request, viewer, csrf)
        if not reason.strip():
            return render(request, "a reason is required to revoke a testplace version", status=400)
        actor = audit.admin_actor(viewer.member_id)
        with _session(request) as session:
            extension = extension_or_404(session, identity.strip())
            audit.record(
                session,
                actor=actor,
                action="testplace.version.revoke",
                target=f"extension:{extension.identity}@{version}",
                reason=reason,
            )
            try:
                testplace.revoke_version(session, extension, version.strip(), reason=reason, actor=actor)
            except testplace.TestplaceError as exc:
                return render(request, str(exc), status=exc.status)
        return _redirect(request, "/admin/testplace")

    return router

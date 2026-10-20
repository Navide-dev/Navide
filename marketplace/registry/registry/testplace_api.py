"""Testplace JSON API (testplace.py has the rules).

- Testers: a Navide Cloud account token (`require_member`). An account that
  holds no live seat gets the same 404 as for an extension that does not
  exist, and anonymous calls get 401, so nobody uninvited can tell a
  testplace extension exists.
- Developers: a publisher token of the namespace, or an account token of the
  account that owns it; the namespace must be vetted (qualification.py).
- Admins: the `X-Admin-Token` gate the other admin JSON routes use.

Errors carry `detail: {code, message}` like account_auth.py.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime

from fastapi import Body, Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import or_
from sqlmodel import Session, select

from . import audit, testplace
from .account_auth import BearerError, require_bearer, require_member
from .models import Extension, ExtensionVersion, Publisher
from .qualification import publisher_problem
from .repository import RegistryRepository
from .schemas import TestplaceExtension, TestplaceListResponse, TestplaceVersionInfo
from .self_service import owned_publisher
from .static_scan import scan_stored_version
from .storage import StorageError
from .versions import TESTPLACE_CHANNEL, version_key

NOT_FOUND = HTTPException(
    status_code=404, detail={"code": "NOT_FOUND", "message": "extension not found"}
)


def _http(exc: testplace.TestplaceError) -> HTTPException:
    return HTTPException(status_code=exc.status, detail={"code": exc.code, "message": str(exc)})


def _iso(value: datetime | None) -> str | None:
    return testplace._aware(value).isoformat() if value is not None else None


def register_testplace_routes(
    app: FastAPI,
    *,
    version_info: Callable[..., object],
    file_chunks: Callable,
    require_admin_token: Callable[..., None],
) -> None:
    def session_dep(request: Request):
        with Session(request.app.state.registry.engine) as session:
            yield session

    def extension_or_404(session: Session, namespace: str, name: str) -> Extension:
        extension = RegistryRepository(session).get_extension(namespace, name, public_only=False)
        if extension is None:
            raise NOT_FOUND
        return extension

    # -- testers -----------------------------------------------------------
    def tester_extension(session: Session, member_id: str, namespace: str, name: str) -> Extension:
        extension = extension_or_404(session, namespace, name)
        publisher = session.get(Publisher, extension.publisher_id)
        if (
            publisher is None
            or publisher_problem(session, publisher) is not None
            or not testplace.is_tester(session, extension, member_id)
        ):
            raise NOT_FOUND
        return extension

    def view(request: Request, session: Session, extension: Extension) -> TestplaceExtension:
        publisher = session.get(Publisher, extension.publisher_id)
        rows = sorted(
            testplace.live_rows(session, extension),
            key=lambda r: (version_key(r.version), r.target),
            reverse=True,
        )
        metadata, metadata_signature = request.app.state.registry.trust_signer.signed_metadata()
        return TestplaceExtension(
            namespace=extension.namespace,
            name=extension.name,
            identity=extension.identity,
            display_name=(rows[0].manifest or {}).get("displayName") or extension.display_name
            if rows
            else extension.display_name,
            description=extension.description,
            publisher=publisher.name if publisher else extension.namespace,
            trust_metadata=metadata,
            trust_metadata_signature=metadata_signature,
            versions=[
                TestplaceVersionInfo(
                    **version_info(row, None, publisher).model_dump(exclude={"channel"}),
                    channel=row.channel,
                    expires_at=row.expires_at,
                    promotion_status=row.promotion_status,
                )
                for row in rows
            ],
        )

    @app.get("/api/testplace", response_model=TestplaceListResponse)
    def tester_list(
        request: Request,
        member_id: str = Depends(require_member),
        session: Session = Depends(session_dep),
    ) -> TestplaceListResponse:
        items = []
        for extension in testplace.tester_extensions(session, member_id):
            publisher = session.get(Publisher, extension.publisher_id)
            if publisher is None or publisher_problem(session, publisher) is not None:
                continue
            items.append(view(request, session, extension))
        return TestplaceListResponse(items=items)

    @app.get("/api/testplace/{namespace}/{name}", response_model=TestplaceExtension)
    def tester_detail(
        request: Request,
        namespace: str,
        name: str,
        member_id: str = Depends(require_member),
        session: Session = Depends(session_dep),
    ) -> TestplaceExtension:
        return view(request, session, tester_extension(session, member_id, namespace, name))

    @app.get("/api/testplace/{namespace}/{name}/{version}/download")
    def tester_download(
        request: Request,
        namespace: str,
        name: str,
        version: str,
        target: str | None = None,
        member_id: str = Depends(require_member),
        session: Session = Depends(session_dep),
    ) -> StreamingResponse:
        extension = tester_extension(session, member_id, namespace, name)
        rows = [r for r in testplace.live_rows(session, extension) if r.version == version]
        if target is None:
            row = rows[0] if len(rows) == 1 else None
        else:
            row = next((r for r in rows if r.target == target), None)
        if row is None:
            raise HTTPException(
                status_code=404, detail={"code": "NOT_FOUND", "message": "version not found"}
            )
        state = request.app.state.registry
        try:
            stream = state.storage.open_stream(row.package_key)
        except StorageError as exc:
            raise HTTPException(status_code=404, detail={"code": "NOT_FOUND", "message": str(exc)}) from exc
        RegistryRepository(session).increment_download(extension, row)
        suffix = "" if row.target == "universal" else f"@{row.target}"
        return StreamingResponse(
            file_chunks(stream),
            media_type="application/zip",
            headers={
                "Content-Disposition": f'attachment; filename="{namespace}.{name}-{version}{suffix}.vsix"',
                "X-Package-Digest": row.package_digest,
            },
        )

    @app.post("/api/testplace/join")
    def tester_join(
        token: str = Body(..., embed=True, max_length=200),
        member_id: str = Depends(require_member),
        session: Session = Depends(session_dep),
    ) -> dict:
        try:
            extension = testplace.join(session, member_id, token)
        except testplace.TestplaceError as exc:
            raise _http(exc) from exc
        publisher = session.get(Publisher, extension.publisher_id)
        if publisher is None or publisher_problem(session, publisher) is not None:
            raise _http(testplace.TestplaceError("NOT_FOUND", "invite or code not found", 404))
        return {"namespace": extension.namespace, "name": extension.name, "identity": extension.identity}

    @app.post("/api/testplace/{namespace}/{name}/leave", status_code=204)
    def tester_leave(
        namespace: str,
        name: str,
        member_id: str = Depends(require_member),
        session: Session = Depends(session_dep),
    ) -> None:
        # The tester gate, so a member without a seat gets the same 404 as for
        # an extension that does not exist.
        extension = tester_extension(session, member_id, namespace, name)
        testplace.leave(session, extension, member_id)

    # -- developers ----------------------------------------------------------
    def developer(
        session: Session, authorization: str | None, namespace: str, name: str
    ) -> tuple[Extension, str]:
        """The extension and the audit actor, for the namespace's own
        publisher token or the owning account's token."""
        try:
            bearer = require_bearer(session, authorization)
        except BearerError as exc:
            raise exc.http() from exc
        if bearer.publisher is not None:
            publisher = bearer.publisher if bearer.publisher.name == namespace else None
        elif bearer.member_id is not None:
            publisher = owned_publisher(session, bearer.member_id, namespace)
        else:
            publisher = None
        if publisher is None:
            raise HTTPException(
                status_code=403,
                detail={"code": "FORBIDDEN", "message": f"not entitled to namespace '{namespace}'"},
            )
        problem = publisher_problem(session, publisher)
        if problem is not None:
            raise HTTPException(status_code=403, detail={"code": problem[0], "message": problem[1]})
        extension = extension_or_404(session, namespace, name)
        if extension.publisher_id != publisher.id:
            raise NOT_FOUND
        return extension, bearer.actor

    def invite_view(row) -> dict:
        return {
            "id": row.id,
            "label": row.label,
            "source": "code" if row.code_id is not None else "invite",
            "state": testplace.invite_state(row),
            "created_at": _iso(row.created_at),
            "joined_at": _iso(row.claimed_at),
        }

    def code_view(session: Session, row) -> dict:
        return {
            "id": row.id,
            "state": testplace.code_state(row),
            "max_testers": row.max_testers,
            "testers": testplace.code_testers(session, row),
            "review_reason": row.review_reason,
            "created_at": _iso(row.created_at),
        }

    @app.get("/api/testplace/{namespace}/{name}/versions")
    def developer_versions(
        namespace: str,
        name: str,
        authorization: str | None = Header(default=None),
        session: Session = Depends(session_dep),
    ) -> dict:
        extension, _ = developer(session, authorization, namespace, name)
        rows = session.exec(
            select(ExtensionVersion).where(
                ExtensionVersion.extension_id == extension.id,
                or_(
                    ExtensionVersion.channel == TESTPLACE_CHANNEL,
                    ExtensionVersion.promotion_status.is_not(None),
                ),
            )
        ).all()
        return {
            "versions": [
                {
                    "version": r.version,
                    "target": r.target,
                    "channel": r.channel,
                    "package_digest": r.package_digest,
                    "yanked": r.yanked,
                    "published_at": _iso(r.published_at),
                    "expires_at": _iso(r.expires_at),
                    "promotion_status": r.promotion_status,
                    "promotion_reason": r.promotion_reason,
                }
                for r in sorted(rows, key=lambda r: (version_key(r.version), r.target), reverse=True)
            ]
        }

    @app.get("/api/testplace/{namespace}/{name}/invites")
    def developer_invites(
        namespace: str,
        name: str,
        authorization: str | None = Header(default=None),
        session: Session = Depends(session_dep),
    ) -> dict:
        extension, _ = developer(session, authorization, namespace, name)
        return {"invites": [invite_view(r) for r in testplace.list_invites(session, extension)]}

    @app.post("/api/testplace/{namespace}/{name}/invites", status_code=201)
    def developer_invite(
        namespace: str,
        name: str,
        labels: list[str] = Body(..., embed=True),
        authorization: str | None = Header(default=None),
        session: Session = Depends(session_dep),
    ) -> dict:
        extension, actor = developer(session, authorization, namespace, name)
        audit.record(
            session,
            actor=actor,
            action="testplace.invite",
            target=f"extension:{extension.identity}",
            detail={"count": len(labels)},
        )
        try:
            created = testplace.create_invites(session, extension, labels)
        except testplace.TestplaceError as exc:
            raise _http(exc) from exc
        # The join token is shown once, here; only its hash is stored.
        return {"invites": [{**invite_view(row), "join_token": plain} for plain, row in created]}

    @app.post("/api/testplace/{namespace}/{name}/invites/{invite_id}/revoke")
    def developer_revoke_invite(
        namespace: str,
        name: str,
        invite_id: int,
        authorization: str | None = Header(default=None),
        session: Session = Depends(session_dep),
    ) -> dict:
        extension, actor = developer(session, authorization, namespace, name)
        audit.record(
            session,
            actor=actor,
            action="testplace.invite.revoke",
            target=f"extension:{extension.identity}",
            detail={"invite_id": invite_id},
        )
        try:
            return invite_view(testplace.revoke_invite(session, extension, invite_id))
        except testplace.TestplaceError as exc:
            raise _http(exc) from exc

    @app.get("/api/testplace/{namespace}/{name}/codes")
    def developer_codes(
        namespace: str,
        name: str,
        authorization: str | None = Header(default=None),
        session: Session = Depends(session_dep),
    ) -> dict:
        extension, _ = developer(session, authorization, namespace, name)
        return {"codes": [code_view(session, r) for r in testplace.list_codes(session, extension)]}

    @app.post("/api/testplace/{namespace}/{name}/codes", status_code=201)
    def developer_code(
        namespace: str,
        name: str,
        max_testers: int = Body(..., embed=True),
        authorization: str | None = Header(default=None),
        session: Session = Depends(session_dep),
    ) -> dict:
        extension, actor = developer(session, authorization, namespace, name)
        audit.record(
            session,
            actor=actor,
            action="testplace.code",
            target=f"extension:{extension.identity}",
            detail={"max_testers": max_testers},
        )
        try:
            plain, row = testplace.create_code(session, extension, max_testers)
        except testplace.TestplaceError as exc:
            raise _http(exc) from exc
        return {**code_view(session, row), "code": plain}

    @app.post("/api/testplace/{namespace}/{name}/codes/{code_id}/revoke")
    def developer_revoke_code(
        namespace: str,
        name: str,
        code_id: int,
        authorization: str | None = Header(default=None),
        session: Session = Depends(session_dep),
    ) -> dict:
        extension, actor = developer(session, authorization, namespace, name)
        audit.record(
            session,
            actor=actor,
            action="testplace.code.revoke",
            target=f"extension:{extension.identity}",
            detail={"code_id": code_id},
        )
        try:
            return code_view(session, testplace.revoke_code(session, extension, code_id))
        except testplace.TestplaceError as exc:
            raise _http(exc) from exc

    @app.post("/api/testplace/{namespace}/{name}/versions/{version}/revoke")
    def developer_revoke_version(
        namespace: str,
        name: str,
        version: str,
        reason: str = Body("", embed=True, max_length=500),
        authorization: str | None = Header(default=None),
        session: Session = Depends(session_dep),
    ) -> dict:
        extension, actor = developer(session, authorization, namespace, name)
        audit.record(
            session,
            actor=actor,
            action="testplace.version.revoke",
            target=f"extension:{extension.identity}@{version}",
            reason=reason or None,
        )
        try:
            rows = testplace.revoke_version(
                session, extension, version, reason=reason or "revoked by the developer", actor=actor
            )
        except testplace.TestplaceError as exc:
            raise _http(exc) from exc
        return {"version": version, "targets": [r.target for r in rows], "revoked": True}

    @app.post("/api/testplace/{namespace}/{name}/versions/{version}/promote")
    def developer_promote(
        namespace: str,
        name: str,
        version: str,
        authorization: str | None = Header(default=None),
        session: Session = Depends(session_dep),
    ) -> dict:
        extension, actor = developer(session, authorization, namespace, name)
        audit.record(
            session,
            actor=actor,
            action="testplace.promotion.request",
            target=f"extension:{extension.identity}@{version}",
        )
        try:
            rows = testplace.request_promotion(session, extension, version)
        except testplace.TestplaceError as exc:
            raise _http(exc) from exc
        return {"version": version, "targets": [r.target for r in rows], "promotion_status": "requested"}

    # -- admins ----------------------------------------------------------------
    def admin(request: Request, token: str | None) -> None:
        require_admin_token(request.app.state.registry.settings, token, honor_open_admin=False)

    @app.get("/api/admin/testplace/codes")
    def admin_codes(
        request: Request,
        x_admin_token: str | None = Header(default=None),
        session: Session = Depends(session_dep),
    ) -> dict:
        admin(request, x_admin_token)
        items = []
        for row in testplace.code_queue(session):
            extension = session.get(Extension, row.extension_id)
            items.append({**code_view(session, row), "extension": extension.identity})
        return {"codes": items}

    @app.post("/api/admin/testplace/codes/{code_id}/decision")
    def admin_code_decision(
        request: Request,
        code_id: int,
        approve: bool = Body(..., embed=True),
        reason: str = Body("", embed=True),
        x_admin_token: str | None = Header(default=None),
        session: Session = Depends(session_dep),
    ) -> dict:
        admin(request, x_admin_token)
        audit.record(
            session,
            actor=audit.ADMIN_TOKEN_ACTOR,
            action="testplace.code.approve" if approve else "testplace.code.reject",
            target=f"testplace-code:{code_id}",
            reason=reason or None,
        )
        try:
            row = testplace.decide_code(
                session, code_id, approve=approve, reviewer=audit.ADMIN_TOKEN_ACTOR, reason=reason
            )
        except testplace.TestplaceError as exc:
            raise _http(exc) from exc
        return code_view(session, row)

    @app.get("/api/admin/testplace/promotions")
    def admin_promotions(
        request: Request,
        x_admin_token: str | None = Header(default=None),
        session: Session = Depends(session_dep),
    ) -> dict:
        admin(request, x_admin_token)
        items = []
        for extension, version, rows in testplace.promotion_queue(session):
            facts = testplace.promotion_facts(session, extension)
            items.append(
                {
                    "extension": extension.identity,
                    "version": version,
                    "artifacts": sorted(r.package_digest for r in rows),
                    "requested_at": _iso(rows[0].promotion_requested_at),
                    "testers": facts.testers,
                    "testing_since": _iso(facts.first_published_at),
                    "reports": facts.reports,
                }
            )
        return {"promotions": items}

    @app.post("/api/admin/testplace/promotions/{namespace}/{name}/{version}/decision")
    def admin_promotion_decision(
        request: Request,
        namespace: str,
        name: str,
        version: str,
        approve: bool = Body(..., embed=True),
        artifacts: list[str] = Body(..., embed=True),
        reason: str = Body("", embed=True),
        acknowledge_secret_findings: bool = Body(False, embed=True),
        inspected_native_backend: bool = Body(False, embed=True),
        x_admin_token: str | None = Header(default=None),
        session: Session = Depends(session_dep),
    ) -> dict:
        admin(request, x_admin_token)
        extension = extension_or_404(session, namespace, name)
        audit.record(
            session,
            actor=audit.ADMIN_TOKEN_ACTOR,
            action="testplace.promotion.approve" if approve else "testplace.promotion.reject",
            target=f"extension:{extension.identity}@{version}",
            reason=reason or None,
        )
        try:
            if approve:
                rows = testplace.approve_promotion(
                    session,
                    request.app.state.registry.trust_signer,
                    extension=extension,
                    version=version,
                    reviewer=audit.ADMIN_TOKEN_ACTOR,
                    artifacts=artifacts,
                    acknowledge_secret_findings=acknowledge_secret_findings,
                    inspected_native_backend=inspected_native_backend,
                    rescan=lambda row: scan_stored_version(request.app.state.registry.storage, row),
                )
            else:
                rows = testplace.reject_promotion(
                    session,
                    extension=extension,
                    version=version,
                    reviewer=audit.ADMIN_TOKEN_ACTOR,
                    reason=reason,
                    artifacts=artifacts,
                )
        except testplace.TestplaceError as exc:
            raise _http(exc) from exc
        return {
            "version": version,
            "promotion_status": rows[0].promotion_status,
            "channel": rows[0].channel,
        }

    @app.post("/api/admin/testplace/{namespace}/{name}/versions/{version}/revoke")
    def admin_revoke_version(
        request: Request,
        namespace: str,
        name: str,
        version: str,
        reason: str = Body(..., embed=True, min_length=1, max_length=500),
        x_admin_token: str | None = Header(default=None),
        session: Session = Depends(session_dep),
    ) -> dict:
        admin(request, x_admin_token)
        extension = extension_or_404(session, namespace, name)
        audit.record(
            session,
            actor=audit.ADMIN_TOKEN_ACTOR,
            action="testplace.version.revoke",
            target=f"extension:{extension.identity}@{version}",
            reason=reason,
        )
        try:
            rows = testplace.revoke_version(
                session, extension, version, reason=reason, actor=audit.ADMIN_TOKEN_ACTOR
            )
        except testplace.TestplaceError as exc:
            raise _http(exc) from exc
        return {"version": version, "targets": [r.target for r in rows], "revoked": True}

"""An admin unfreezes a reclaimed or revoked namespace for its own account
(PROPOSAL-namespace-unfreeze, user decision 2026-10-21: "restore versions" is
off by default; only the original account, never another developer)."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from sqlmodel import Session, select

from registry import blocklist, qualification
from registry.models import (
    BlocklistEntry,
    DeveloperQualification,
    Extension,
    ExtensionVersion,
    Publisher,
    PublisherKey,
    PublisherToken,
)
from registry.self_service import MAX_NAMESPACES_PER_ACCOUNT
from registry.signing import generate_keypair
from tests.phase2_helpers import (
    ADMIN_HEADERS,
    ADMIN_MEMBER,
    approve_developer,
    claim,
    cloud_settings,
    csrf_of,
    make_client,
    package_for,
    publish,
    sign_in,
)
from tests.test_developer_qualification import MEMBER, approved_publisher, audit_rows, bearer

NAMESPACE = "mei-tools"


@pytest.fixture()
def client(tmp_path):
    return make_client(cloud_settings(tmp_path))


def _engine(client):
    return client.app.state.registry.engine


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _publisher(client, namespace: str = NAMESPACE) -> Publisher:
    with Session(_engine(client)) as session:
        return session.exec(select(Publisher).where(Publisher.name == namespace)).one()


def _versions(client) -> dict[str, ExtensionVersion]:
    with Session(_engine(client)) as session:
        rows = session.exec(select(ExtensionVersion)).all()
        return {row.version: row for row in rows}


def _digest_entries(client) -> dict[str, BlocklistEntry]:
    with Session(_engine(client)) as session:
        return {e.value: e for e in session.exec(select(BlocklistEntry).where(BlocklistEntry.kind == "digest")).all()}


def reclaimed_namespace(client) -> dict:
    """A grandfathered namespace with three versions, reclaimed by the sweep:
    1.0.0 is a plain version the freeze yanked and blocked; 1.1.0 was already
    yanked by its developer; 1.2.0's digest was blocked for security first.
    The owner is then approved again. Returns the old publisher token and the
    three digests."""
    token = approved_publisher(client, NAMESPACE)
    public_pem = generate_keypair()[1]
    assert client.put("/api/publisher/me/key", json={"public_key": public_pem}, headers=bearer(token)).status_code == 200
    for version in ("1.0.0", "1.1.0", "1.2.0"):
        assert publish(client, token, package_for(NAMESPACE, "hello", version=version)).status_code == 201
    digests = {v: row.package_digest for v, row in _versions(client).items()}
    with Session(_engine(client)) as session:
        row = session.exec(select(ExtensionVersion).where(ExtensionVersion.version == "1.1.0")).one()
        row.yanked = True
        session.add(row)
        blocklist.block_digests(
            session, [digests["1.2.0"]], reason="malware", digest_reason=blocklist.DIGEST_SECURITY, created_by="admin-token"
        )
        session.delete(session.get(DeveloperQualification, MEMBER))
        publisher = session.exec(select(Publisher).where(Publisher.name == NAMESPACE)).one()
        publisher.grandfather_until = _now() - timedelta(days=1)
        session.add(publisher)
        session.commit()
    client.app.state.registry.grandfather_swept_at = None
    client.get("/api/trust/local-install")
    assert _publisher(client).frozen_at is not None
    approve_developer(client, MEMBER)
    return {"token": token, "digests": digests}


def unfreeze(client, namespace: str = NAMESPACE, **body):
    body.setdefault("reason", "Owner approved after the grace period.")
    return client.post(f"/api/admin/namespaces/{namespace}/unfreeze", json=body, headers=ADMIN_HEADERS)


def _code(resp) -> str:
    return resp.json()["detail"]["code"]


# -- the default: the name comes back, nothing else ---------------------------
def test_unfreeze_returns_the_name_and_leaves_versions_digests_tokens_and_keys(client):
    state = reclaimed_namespace(client)
    before = _digest_entries(client)

    resp = unfreeze(client)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["namespace"] == NAMESPACE
    assert body["restored_versions"] == [] and body["digests_unblocked"] == []

    publisher = _publisher(client)
    assert publisher.frozen_at is None and publisher.frozen_reason is None
    assert publisher.token_hash is None
    assert {v: row.yanked for v, row in _versions(client).items()} == {"1.0.0": True, "1.1.0": True, "1.2.0": True}
    assert set(_digest_entries(client)) == set(before)
    with Session(_engine(client)) as session:
        assert all(t.revoked_at is not None for t in session.exec(select(PublisherToken)).all())
        assert all(k.revoked_at is not None for k in session.exec(select(PublisherKey)).all())
    # The old publisher token stays dead.
    resp = publish(client, state["token"], package_for(NAMESPACE, "hello", version="2.0.0"))
    assert resp.status_code == 401


def test_restore_unyanks_and_unblocks_only_what_this_freeze_did(client):
    state = reclaimed_namespace(client)
    digests = state["digests"]

    resp = unfreeze(client, restore_versions=True)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    # The freeze blocked 1.0.0 and 1.1.0; 1.2.0 was blocked for security first.
    assert body["digests_unblocked"] == sorted([digests["1.0.0"], digests["1.1.0"]])
    assert body["restored_versions"] == [f"{NAMESPACE}.hello@1.0.0#universal"]

    yanked = {v: row.yanked for v, row in _versions(client).items()}
    # 1.1.0 was yanked by its developer, 1.2.0 is still blocked for security.
    assert yanked == {"1.0.0": False, "1.1.0": True, "1.2.0": True}
    entries = _digest_entries(client)
    assert digests["1.0.0"] not in entries
    assert digests["1.1.0"] not in entries
    assert entries[digests["1.2.0"]].digest_reason == blocklist.DIGEST_SECURITY


def test_unfreeze_is_audited_with_actor_reason_and_what_was_restored(client):
    reclaimed_namespace(client)
    assert unfreeze(client, reason="Appeal accepted.", restore_versions=True).status_code == 200
    row = audit_rows(client, f"publisher:{NAMESPACE}")[0]
    assert row["action"] == "namespace.unfreeze"
    assert row["actor"] == "admin-token"
    assert row["reason"] == "Appeal accepted."
    assert row["detail"]["restore_versions"] is True
    assert row["detail"]["restored_versions"] == [f"{NAMESPACE}.hello@1.0.0#universal"]
    assert len(row["detail"]["digests_unblocked"]) == 2


# -- refusals -----------------------------------------------------------------
def test_a_namespace_that_is_not_frozen_is_refused(client):
    approved_publisher(client, NAMESPACE)
    resp = unfreeze(client)
    assert resp.status_code == 409 and _code(resp) == "NOT_FROZEN"


def test_an_unknown_namespace_is_refused(client):
    resp = unfreeze(client, "no-such-ns")
    assert resp.status_code == 404 and _code(resp) == "NOT_FOUND"


def test_a_reason_is_required(client):
    reclaimed_namespace(client)
    resp = unfreeze(client, reason="  ")
    assert resp.status_code == 400 and _code(resp) == "REASON_REQUIRED"
    assert _publisher(client).frozen_at is not None


@pytest.mark.parametrize("status", [None, "pending", "rejected", "revoked"])
def test_an_owner_who_is_not_approved_now_is_refused(client, status):
    reclaimed_namespace(client)
    with Session(_engine(client)) as session:
        row = session.get(DeveloperQualification, MEMBER)
        if status is None:
            session.delete(row)
        else:
            row.status = status
            session.add(row)
        session.commit()
    resp = unfreeze(client)
    assert resp.status_code == 409 and _code(resp) == "OWNER_NOT_APPROVED"
    assert _publisher(client).frozen_at is not None


def test_an_owner_at_the_namespace_allowance_is_refused(client):
    reclaimed_namespace(client)
    sign_in(client, MEMBER)
    for index in range(MAX_NAMESPACES_PER_ACCOUNT):
        assert claim(client, f"mei-more-{index}").status_code == 303
    resp = unfreeze(client)
    assert resp.status_code == 409 and _code(resp) == "OVER_ALLOWANCE"
    assert _publisher(client).frozen_at is not None


def test_the_namespace_never_moves_to_another_account(client):
    """Only the original owner: the API takes no account to give it to."""
    reclaimed_namespace(client)
    approve_developer(client, "mem-other")
    resp = unfreeze(client, member_id="mem-other")
    assert resp.status_code == 422
    assert _publisher(client).navide_member_id == MEMBER
    assert _publisher(client).frozen_at is not None


# -- the gates ----------------------------------------------------------------
def test_the_json_api_is_closed_without_a_configured_admin_token(tmp_path):
    client = make_client(cloud_settings(tmp_path, admin_token=None))
    resp = client.post(f"/api/admin/namespaces/{NAMESPACE}/unfreeze", json={"reason": "x"})
    assert resp.status_code == 401


def test_the_json_api_refuses_a_wrong_admin_token(client):
    reclaimed_namespace(client)
    resp = client.post(
        f"/api/admin/namespaces/{NAMESPACE}/unfreeze", json={"reason": "x"}, headers={"X-Admin-Token": "nope"}
    )
    assert resp.status_code == 401
    assert _publisher(client).frozen_at is not None


def test_the_admin_page_lists_frozen_namespaces_and_unfreezes(client):
    reclaimed_namespace(client)
    sign_in(client, ADMIN_MEMBER)
    page = client.get("/admin/namespaces")
    assert page.status_code == 200
    assert NAMESPACE in page.text and MEMBER in page.text
    csrf = csrf_of(client, "/admin/namespaces")
    resp = client.post(f"/admin/namespaces/{NAMESPACE}/unfreeze", data={"csrf": csrf, "reason": "Approved."})
    assert resp.status_code == 303
    assert _publisher(client).frozen_at is None
    row = audit_rows(client, f"publisher:{NAMESPACE}")[0]
    assert (row["action"], row["actor"]) == ("namespace.unfreeze", f"admin:member:{ADMIN_MEMBER}")
    assert row["detail"]["restore_versions"] is False


def test_the_admin_page_refuses_a_non_admin_and_a_missing_csrf(client):
    reclaimed_namespace(client)
    sign_in(client, MEMBER)
    assert client.get("/admin/namespaces").status_code == 403
    assert client.post(f"/admin/namespaces/{NAMESPACE}/unfreeze", data={"reason": "x"}).status_code == 403
    sign_in(client, ADMIN_MEMBER)
    assert client.post(f"/admin/namespaces/{NAMESPACE}/unfreeze", data={"reason": "x", "csrf": "0" * 32}).status_code == 403
    assert _publisher(client).frozen_at is not None


def test_the_admin_page_shows_a_refusal_without_unfreezing(client):
    reclaimed_namespace(client)
    with Session(_engine(client)) as session:
        session.delete(session.get(DeveloperQualification, MEMBER))
        session.commit()
    sign_in(client, ADMIN_MEMBER)
    csrf = csrf_of(client, "/admin/namespaces")
    resp = client.post(f"/admin/namespaces/{NAMESPACE}/unfreeze", data={"csrf": csrf, "reason": "x"})
    assert resp.status_code == 409
    assert "approved" in resp.text
    assert _publisher(client).frozen_at is not None


def test_unfreeze_after_a_revocation_and_a_new_approval(client):
    """A freeze that followed a qualification revocation unfreezes the same
    way once the owner is approved again."""
    approved_publisher(client, NAMESPACE)
    resp = client.post(f"/api/admin/developers/{MEMBER}/revoke", json={"reason": "x"}, headers=ADMIN_HEADERS)
    assert resp.status_code == 200
    with Session(_engine(client)) as session:
        row = session.get(DeveloperQualification, MEMBER)
        row.status = qualification.APPROVED
        session.add(row)
        session.commit()
    assert unfreeze(client).status_code == 200
    assert _publisher(client).frozen_at is None


def test_a_reclaimed_then_unfrozen_namespace_is_not_reclaimed_again(client):
    reclaimed_namespace(client)
    assert unfreeze(client).status_code == 200
    client.app.state.registry.grandfather_swept_at = None
    client.get("/api/trust/local-install")
    assert _publisher(client).frozen_at is None
    with Session(_engine(client)) as session:
        assert session.exec(select(Extension)).first() is not None

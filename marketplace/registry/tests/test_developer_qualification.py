"""Developer qualification (W2): applications, the admin queue, the gates on
claiming and token issuance, revocation, the account token, the applicant's
own endpoints, the local-install trust document and the audit trail."""

from __future__ import annotations

import urllib.parse
from datetime import datetime, timezone

import pytest
from sqlmodel import Session

from registry import cli
from registry.models import DeveloperQualification
from registry.signing import generate_keypair, public_key_fingerprint
from tests.phase2_helpers import (
    ADMIN_HEADERS,
    ADMIN_MEMBER,
    claim,
    cloud_settings,
    csrf_of,
    make_client,
    new_token,
    package_for,
    publish,
    queued_artifacts,
    register_official,
    sign_in,
)
from tests.test_registry_signing import _verify

MEMBER = "mem-dev"
FIELDS = {
    "applicant_type": "individual",
    "legal_name": "Lin Mei",
    "display_name": "Mei Tools",
    "contact_email": "mei@example.test",
    "country": "TW",
    "intended_namespace": "mei-tools",
    "description": "Small productivity plugins.",
    "agreed_terms": True,
}


@pytest.fixture()
def client(tmp_path):
    return make_client(cloud_settings(tmp_path))


def _pkce_code(client, scope: str, namespace: str = "", verifier: str = "v" * 50):
    params = {"port": "5555", "state": "s" * 20, "code_challenge": cli.pkce_challenge(verifier), "label": "Navide app"}
    if scope:
        params["scope"] = scope
    page = client.get("/cli/authorize", params=params)
    assert page.status_code == 200, page.text
    csrf = page.text.split('name="csrf" value="')[1].split('"')[0]
    return client.post("/cli/authorize", data={**params, "namespace": namespace, "csrf": csrf})


def _code_of(resp) -> str:
    assert resp.status_code == 303, resp.text
    return dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(resp.headers["location"]).query))["code"]


def account_token(client) -> str:
    code = _code_of(_pkce_code(client, "account"))
    resp = client.post("/api/cli/token", json={"code": code, "code_verifier": "v" * 50})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["scope"] == "account" and body["namespace"] is None
    assert body["token"].startswith("nva_")
    return body["token"]


def bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def apply(client, token: str, fields: dict | None = None, **extra):
    return client.post(
        "/api/developer/me/application",
        json={"fields": fields or FIELDS, **extra},
        headers=bearer(token),
    )


def admin(client, action: str, member_id: str = MEMBER, reason: str = ""):
    return client.post(f"/api/admin/developers/{member_id}/{action}", json={"reason": reason}, headers=ADMIN_HEADERS)


def audit_rows(client, target: str | None = None) -> list[dict]:
    params = {"target": target} if target else {}
    return client.get("/api/admin/audit", params=params, headers=ADMIN_HEADERS).json()["items"]


def approved_publisher(client, namespace: str = "mei-tools") -> str:
    """Sign in unapproved, apply with an account token, get approved, claim, and
    return a dashboard publish token."""
    sign_in(client, MEMBER, approved=False)
    token = account_token(client)
    assert apply(client, token).status_code == 201
    assert admin(client, "approve").status_code == 200
    assert claim(client, namespace).status_code == 303
    return new_token(client, namespace)


# -- (1) no approval, no namespace and no token ------------------------------
def test_an_unapproved_account_can_neither_claim_nor_get_a_token(client):
    sign_in(client, MEMBER, approved=False)
    resp = claim(client, "mei-tools")
    assert resp.status_code == 409
    assert "approved developer" in resp.text

    # The publish-scope CLI login offers no namespace and refuses one by name.
    page = client.get(
        "/cli/authorize",
        params={"port": "5555", "state": "s" * 20, "code_challenge": cli.pkce_challenge("v" * 50)},
    )
    assert "developer/apply" in page.text
    resp = _pkce_code(client, "", namespace="mei-tools")
    assert resp.status_code == 404

    # Pending is not approved either.
    assert apply(client, account_token(client)).status_code == 201
    assert claim(client, "mei-tools").status_code == 409


def test_an_existing_namespace_stops_issuing_and_publishing_without_approval(client):
    """A namespace claimed before qualification existed (no approval row)
    keeps its rows but can no longer get a token or publish with an old one."""
    token = approved_publisher(client)
    with Session(client.app.state.registry.engine) as session:
        session.delete(session.get(DeveloperQualification, MEMBER))
        session.commit()

    resp = publish(client, token, package_for("mei-tools", "hello"))
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "QUALIFICATION_REQUIRED"
    resp = client.post(
        "/publisher/mei-tools/tokens",
        data={"label": "x", "days": "30", "csrf": csrf_of(client, "/publisher/mei-tools")},
    )
    assert resp.status_code == 400
    assert "not approved" in resp.text


def test_approval_unlocks_claim_token_and_publish(client):
    token = approved_publisher(client)
    resp = publish(client, token, package_for("mei-tools", "hello"))
    assert resp.status_code == 201, resp.text
    assert resp.json()["review_status"] == "pending"

    code = _code_of(_pkce_code(client, "", namespace="mei-tools"))
    resp = client.post("/api/cli/token", json={"code": code, "code_verifier": "v" * 50})
    assert resp.json()["scope"] == "publisher" and resp.json()["namespace"] == "mei-tools"


# -- applications ------------------------------------------------------------
def test_application_round_trip_keeps_field_sources(client):
    sign_in(client, MEMBER, approved=False)
    token = account_token(client)
    assert client.get("/api/developer/me/application", headers=bearer(token)).json()["status"] == "none"

    resp = apply(
        client,
        token,
        field_sources={"legal_name": "agent-draft", "description": "agent-draft"},
        source="navide-app",
    )
    assert resp.status_code == 201
    assert resp.json()["status"] == "pending"
    mine = client.get("/api/developer/me/application", headers=bearer(token)).json()
    assert mine["fields"]["legal_name"] == "Lin Mei"
    assert mine["field_sources"]["legal_name"] == "agent-draft"
    assert mine["field_sources"]["country"] == "user"
    assert mine["source"] == "navide-app"

    again = apply(client, token)
    assert again.status_code == 409
    assert again.json()["detail"]["code"] == "APPLICATION_EXISTS"

    queue = client.get("/api/admin/developers", headers=ADMIN_HEADERS).json()["items"]
    assert [q["member_id"] for q in queue] == [MEMBER]
    assert queue[0]["field_sources"]["description"] == "agent-draft"
    page = client.get("/admin/developers")
    assert page.status_code in (303, 403)  # admin only (not signed in as admin)


@pytest.mark.parametrize(
    ("change", "field"),
    [
        ({"country": "Taiwan"}, "country"),
        ({"agreed_terms": False}, "agreed_terms"),
        ({"contact_email": "nope"}, "contact_email"),
        ({"intended_namespace": "Bad Name"}, "intended_namespace"),
        ({"surprise": "x"}, "surprise"),
        ({"applicant_type": "organization"}, "organization_name"),
    ],
)
def test_invalid_applications_name_the_field(client, change, field):
    sign_in(client, MEMBER, approved=False)
    resp = apply(client, account_token(client), {**FIELDS, **change})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "APPLICATION_INVALID"
    assert resp.json()["detail"]["field"] == field


def test_unknown_field_source_is_refused(client):
    sign_in(client, MEMBER, approved=False)
    resp = apply(client, account_token(client), field_sources={"legal_name": "robot"})
    assert resp.status_code == 422


def test_rejected_applicant_sees_the_reason_and_may_reapply(client):
    sign_in(client, MEMBER, approved=False)
    token = account_token(client)
    apply(client, token)
    assert admin(client, "reject").status_code == 400  # a reason is required
    assert admin(client, "reject", reason="Portfolio link is missing.").status_code == 200
    mine = client.get("/api/developer/me/application", headers=bearer(token)).json()
    assert (mine["status"], mine["reason"]) == ("rejected", "Portfolio link is missing.")
    assert apply(client, token).status_code == 201
    assert admin(client, "approve").status_code == 200
    assert admin(client, "approve").json()["detail"]["code"] == "NOT_PENDING"


def test_website_application_form(client):
    sign_in(client, MEMBER, approved=False)
    csrf = csrf_of(client, "/developer/apply")
    form = {k: ("yes" if v is True else v) for k, v in FIELDS.items()}
    resp = client.post("/developer/apply", data={**form, "csrf": csrf})
    assert resp.status_code == 303, resp.text
    assert "waiting for review" in client.get("/developer/apply").text


def test_admin_web_queue_approves(client):
    sign_in(client, MEMBER, approved=False)
    apply(client, account_token(client))
    sign_in(client, ADMIN_MEMBER)
    page = client.get("/admin/developers")
    assert page.status_code == 200 and "Lin Mei" in page.text
    csrf = csrf_of(client, "/admin/developers")
    resp = client.post(f"/admin/developers/{MEMBER}/approve", data={"csrf": csrf})
    assert resp.status_code == 303
    rows = audit_rows(client, f"member:{MEMBER}")
    assert rows[0]["action"] == "qualification.approve"
    assert rows[0]["actor"] == f"admin:member:{ADMIN_MEMBER}"


def test_an_action_query_parameter_cannot_change_the_admin_action(client):
    sign_in(client, MEMBER, approved=False)
    apply(client, account_token(client))
    resp = client.post(
        f"/api/admin/developers/{MEMBER}/reject?action=approve", json={"reason": "no"}, headers=ADMIN_HEADERS
    )
    assert resp.json()["status"] == "rejected"


# -- (2) revocation ------------------------------------------------------------
def test_revocation_revokes_tokens_freezes_and_yanks_everything(client):
    token = approved_publisher(client)
    public_pem = generate_keypair()[1]
    assert client.put("/api/publisher/me/key", json={"public_key": public_pem}, headers=bearer(token)).status_code == 200
    assert publish(client, token, package_for("mei-tools", "hello")).status_code == 201
    approve = client.post(
        "/api/admin/review/mei-tools/hello/1.0.0/approve",
        json={"artifacts": queued_artifacts(client, "mei-tools", "hello")},
        headers=ADMIN_HEADERS,
    )
    assert approve.status_code == 200, approve.text
    assert publish(client, token, package_for("mei-tools", "hello", version="1.1.0")).status_code == 201
    account = account_token(client)
    assert client.get("/api/extensions/mei-tools/hello").status_code == 200

    resp = admin(client, "revoke", reason="Impersonated another company.")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["namespaces"] == ["mei-tools"]
    assert body["versions_yanked"] == 2
    assert body["keys_revoked"] == 1

    for revoked in (token, account):
        resp = client.get("/api/developer/me/application", headers=bearer(revoked))
        assert resp.status_code == 401
        assert resp.json()["detail"]["code"] == "TOKEN_REVOKED"
    resp = publish(client, token, package_for("mei-tools", "hello", version="1.2.0"))
    assert resp.status_code == 401
    assert resp.json()["detail"]["code"] == "TOKEN_REVOKED"

    detail = client.get("/api/extensions/mei-tools/hello").json()
    assert all(v["yanked"] for v in detail["versions"])
    assert detail["latest_version"] is None

    # Frozen: no new token, key or claim; the account cannot reapply.
    resp = client.post(
        "/publisher/mei-tools/tokens",
        data={"label": "x", "days": "30", "csrf": csrf_of(client, "/publisher/mei-tools")},
    )
    assert resp.status_code == 400
    assert claim(client, "mei-tools-two").status_code == 409

    # (5) the audit trail names who did it and what followed.
    actions = {(r["action"], r["actor"]) for r in audit_rows(client)}
    assert ("qualification.revoke", "admin-token") in actions
    assert ("namespace.freeze", "system:qualification-revoked") in actions
    assert ("version.submit", f"member:{MEMBER}") in actions
    assert ("publisher-token.issue", f"member:{MEMBER}") in actions
    assert ("publisher-key.set", f"member:{MEMBER}") in actions
    assert ("namespace.claim", f"member:{MEMBER}") in actions
    assert ("qualification.apply", f"member:{MEMBER}") in actions


def test_only_an_approved_qualification_can_be_revoked(client):
    sign_in(client, MEMBER, approved=False)
    apply(client, account_token(client))
    resp = admin(client, "revoke", reason="x")
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "NOT_APPROVED"


# -- bearer errors and scopes --------------------------------------------------
def test_token_errors_have_stable_codes(client):
    assert client.get("/api/developer/me/application").json()["detail"]["code"] == "TOKEN_MISSING"
    resp = client.get("/api/developer/me/application", headers=bearer("nva_" + "x" * 10))
    assert resp.status_code == 401 and resp.json()["detail"]["code"] == "TOKEN_INVALID"
    resp = publish(client, "nvp_" + "nope", package_for("mei-tools", "hello"))
    assert resp.json()["detail"]["code"] == "TOKEN_INVALID"
    assert client.post("/api/publish", files={"package": ("p.vsix", b"x")}).json()["detail"]["code"] == "TOKEN_MISSING"


def test_an_account_token_cannot_publish(client):
    sign_in(client, MEMBER, approved=False)
    token = account_token(client)
    resp = publish(client, token, package_for("mei-tools", "hello"))
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "TOKEN_SCOPE"
    assert client.get("/api/publisher/me", headers=bearer(token)).json()["detail"]["code"] == "TOKEN_SCOPE"


def test_unknown_scope_is_refused(client):
    sign_in(client, MEMBER, approved=False)
    params = {"port": "5555", "state": "s" * 20, "code_challenge": "c" * 43, "scope": "admin"}
    assert client.get("/cli/authorize", params=params).status_code == 400


# -- the applicant's own endpoints -------------------------------------------------
def test_publisher_me_and_versions(client):
    token = approved_publisher(client)
    me = client.get("/api/publisher/me", headers=bearer(token)).json()
    assert me["namespace"] == "mei-tools"
    assert me["qualification"] == "approved"
    assert me["public_key_fingerprint"] is None
    assert me["token_expires_at"] is not None

    public_pem = generate_keypair()[1]
    resp = client.put("/api/publisher/me/key", json={"public_key": public_pem}, headers=bearer(token))
    assert resp.json()["public_key_fingerprint"] == public_key_fingerprint(public_pem)
    bad = client.put("/api/publisher/me/key", json={"public_key": "nope"}, headers=bearer(token))
    assert bad.status_code == 400 and bad.json()["detail"]["code"] == "KEY_INVALID"

    publish(client, token, package_for("mei-tools", "hello"))
    publish(client, token, package_for("mei-tools", "other"))
    client.post(
        "/api/admin/review/mei-tools/other/1.0.0/reject",
        json={"reason": "Broken icon.", "artifacts": queued_artifacts(client, "mei-tools", "other")},
        headers=ADMIN_HEADERS,
    )
    body = client.get("/api/publisher/me/versions", headers=bearer(token)).json()
    assert body["namespace"] == "mei-tools"
    by_identity = {i["identity"]: i for i in body["items"]}
    assert by_identity["mei-tools.hello"]["status"] == "pending"
    assert by_identity["mei-tools.hello"]["reason"] is None
    assert by_identity["mei-tools.hello"]["targets"] == ["universal"]
    assert by_identity["mei-tools.hello"]["scan_by_target"]["universal"]["risk"] is None
    assert by_identity["mei-tools.other"]["status"] == "rejected"
    assert by_identity["mei-tools.other"]["reason"] == "Broken icon."

    filtered = client.get(
        "/api/publisher/me/versions", params={"extension": "mei-tools.hello"}, headers=bearer(token)
    ).json()["items"]
    assert [i["identity"] for i in filtered] == ["mei-tools.hello"]
    assert client.get(
        "/api/publisher/me/versions", params={"extension": "navide.x"}, headers=bearer(token)
    ).status_code == 404

    account = account_token(client)
    across = client.get("/api/publisher/me/versions", headers=bearer(account)).json()
    assert across["namespace"] is None
    assert {i["identity"] for i in across["items"]} == {"mei-tools.hello", "mei-tools.other"}


# -- yank codes ------------------------------------------------------------------
def test_yank_errors_have_stable_codes(client):
    token = approved_publisher(client)
    register_official(client)
    resp = client.post("/api/extensions/navide/x/1.0.0/yank", headers=bearer(token))
    assert resp.status_code == 403 and resp.json()["detail"]["code"] == "NOT_OWNER"
    resp = client.post("/api/extensions/mei-tools/missing/1.0.0/yank", headers=bearer(token))
    assert resp.status_code == 404 and resp.json()["detail"]["code"] == "NOT_FOUND"
    publish(client, token, package_for("mei-tools", "hello"))
    resp = client.post("/api/extensions/mei-tools/hello/9.9.9/yank", headers=bearer(token))
    assert resp.json()["detail"]["code"] == "NOT_FOUND"
    assert client.post("/api/extensions/mei-tools/hello/1.0.0/yank", headers=bearer(token)).status_code == 200
    # Yanking again stays an idempotent 200, as before.
    assert client.post("/api/extensions/mei-tools/hello/1.0.0/yank", headers=bearer(token)).status_code == 200
    yanks = [r for r in audit_rows(client) if r["action"] == "version.yank"]
    assert len(yanks) == 1 and yanks[0]["actor"] == f"member:{MEMBER}"


# -- local-install trust document ------------------------------------------------
def test_local_install_trust_lists_vetted_keys_and_blocked_digests(client):
    token = approved_publisher(client)
    first, second = generate_keypair()[1], generate_keypair()[1]
    client.put("/api/publisher/me/key", json={"public_key": first}, headers=bearer(token))
    client.put("/api/publisher/me/key", json={"public_key": second}, headers=bearer(token))
    official_pem = generate_keypair()[1]
    client.post("/api/publishers", json={"name": "navide", "public_key": official_pem}, headers=ADMIN_HEADERS)
    # A namespace whose owner was never approved does not appear.
    sign_in(client, "mem-other")
    claim(client, "other-tools")
    with Session(client.app.state.registry.engine) as session:
        session.delete(session.get(DeveloperQualification, "mem-other"))
        session.commit()

    data = package_for("mei-tools", "blocked-one")
    import hashlib

    digest = hashlib.sha256(data).hexdigest()
    added = client.post(
        "/api/admin/blocklist", json={"kind": "digest", "value": digest.upper(), "reason": "malware"}, headers=ADMIN_HEADERS
    )
    assert added.status_code == 201, added.text

    resp = client.get("/api/trust/local-install")
    assert resp.status_code == 200
    body = resp.json()
    document = body["local_trust_metadata"]
    root_public = client.app.state.registry.trust_signer.root_private_key
    from registry.signing import public_key_from_private

    _verify(public_key_from_private(root_public), document, body["local_trust_metadata_signature"])
    assert set(document) == {
        "schemaVersion",
        "kind",
        "registryProfile",
        "generatedAt",
        "expiresAt",
        "blockedDigests",
        "publisherKeys",
    }
    assert document["kind"] == "local-install-trust"
    assert document["blockedDigests"] == [digest]
    keys = {(k["publisherId"], k["keyId"]): k for k in document["publisherKeys"]}
    assert keys[("mei-tools", public_key_fingerprint(first))]["status"] == "revoked"
    assert keys[("mei-tools", public_key_fingerprint(first))]["revokedAt"].endswith("Z")
    assert keys[("mei-tools", public_key_fingerprint(second))]["status"] == "active"
    assert keys[("mei-tools", public_key_fingerprint(second))]["revokedAt"] is None
    assert keys[("navide", public_key_fingerprint(official_pem))]["status"] == "active"
    assert all(k["publisherId"] != "other-tools" for k in document["publisherKeys"])
    assert set(next(iter(keys.values()))) == {"publisherId", "keyId", "publicKey", "status", "revokedAt"}

    # A blocked digest is refused at publish.
    resp = publish(client, token, data)
    assert resp.status_code == 403 and resp.json()["detail"]["code"] == "DIGEST_BLOCKED"

    # Revocation turns every key of the account revoked.
    admin(client, "revoke", reason="x")
    document = client.get("/api/trust/local-install").json()["local_trust_metadata"]
    assert {k["status"] for k in document["publisherKeys"] if k["publisherId"] == "mei-tools"} == {"revoked"}

    entry_id = client.get("/api/admin/audit", headers=ADMIN_HEADERS).json()["items"]
    assert any(r["action"] == "blocklist.add" and r["target"] == f"digest:{digest}" for r in entry_id)


def test_invalid_digest_entries_are_refused(client):
    resp = client.post(
        "/api/admin/blocklist", json={"kind": "digest", "value": "abc", "reason": "x"}, headers=ADMIN_HEADERS
    )
    assert resp.status_code == 400


# -- (4) the existing signed shapes are unchanged ----------------------------------
def test_stable_envelope_and_trust_metadata_shapes_are_unchanged(client):
    signer = client.app.state.registry.trust_signer
    # Inside the signer's validity window (it starts a minute before the app does).
    when = datetime.now(timezone.utc)
    envelope, _signature = signer.sign_envelope(
        artifact_digest="a" * 64,
        package_id="mei-tools.hello",
        version="1.0.0",
        target="universal",
        publisher_id="mei-tools",
        now=when,
    )
    assert list(envelope) == [
        "schemaVersion",
        "artifactDigest",
        "packageId",
        "version",
        "target",
        "publisherId",
        "keyId",
        "signedAt",
    ]
    metadata, _ = signer.signed_metadata(now=when)
    assert list(metadata) == [
        "schemaVersion",
        "registryProfile",
        "rootFingerprint",
        "generatedAt",
        "expiresAt",
        "signers",
        "blockedPublishers",
        "blockedPackages",
    ]
    # A digest entry never leaks into the metadata released Apps verify.
    client.post("/api/admin/blocklist", json={"kind": "digest", "value": "b" * 64, "reason": "x"}, headers=ADMIN_HEADERS)
    metadata, _ = signer.signed_metadata(now=when)
    assert metadata["blockedPackages"] == [] and metadata["blockedPublishers"] == []


def test_a_blocked_digest_of_a_published_version_is_not_served(client):
    token = approved_publisher(client)
    data = package_for("mei-tools", "hello")
    publish(client, token, data)
    client.post(
        "/api/admin/review/mei-tools/hello/1.0.0/approve",
        json={"artifacts": queued_artifacts(client, "mei-tools", "hello")},
        headers=ADMIN_HEADERS,
    )
    assert client.get("/api/extensions/mei-tools/hello/1.0.0/download").status_code == 200
    import hashlib

    added = client.post(
        "/api/admin/blocklist",
        json={"kind": "digest", "value": hashlib.sha256(data).hexdigest(), "reason": "malware"},
        headers=ADMIN_HEADERS,
    )
    resp = client.get("/api/extensions/mei-tools/hello/1.0.0/download")
    assert resp.status_code == 403 and resp.json()["detail"]["code"] == "DIGEST_BLOCKED"
    # Unblocking restores it: the block is reversible, unlike a yank.
    client.delete(f"/api/admin/blocklist/{added.json()['id']}", headers=ADMIN_HEADERS)
    assert client.get("/api/extensions/mei-tools/hello/1.0.0/download").status_code == 200

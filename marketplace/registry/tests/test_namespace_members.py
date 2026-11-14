"""Namespace members (0.2.40): the owner adds and removes publisher members;
a publisher may publish and yank under the namespace but cannot change its
members or signing key; anyone else can do none of it."""

from __future__ import annotations

import sqlite3
import urllib.parse

import pytest
from sqlmodel import Session

from registry import cli
from registry.db import create_db_engine
from registry.migrations import MIGRATIONS, applied_migrations, run_migrations
from registry.models import DeveloperQualification
from registry.signing import generate_keypair, public_key_fingerprint
from tests.phase2_helpers import (
    ADMIN_HEADERS,
    claim,
    cloud_settings,
    make_client,
    new_token,
    package_for,
    publish,
    sign_in,
)

OWNER = "mem-owner"
PUBLISHER = "mem-publisher"
OUTSIDER = "mem-outsider"
NAMESPACE = "mei-tools"
VERIFIER = "v" * 50


@pytest.fixture()
def client(tmp_path):
    return make_client(cloud_settings(tmp_path))


def bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def cli_token(client, namespace: str) -> str:
    """The signed-in account's publish token for ``namespace`` through the
    CLI / App login (the path a publisher member uses)."""
    params = {"port": "5555", "state": "s" * 20, "code_challenge": cli.pkce_challenge(VERIFIER), "label": "Navide app"}
    page = client.get("/cli/authorize", params=params)
    assert page.status_code == 200, page.text
    csrf = page.text.split('name="csrf" value="')[1].split('"')[0]
    resp = client.post("/cli/authorize", data={**params, "namespace": namespace, "csrf": csrf})
    assert resp.status_code == 303, resp.text
    code = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(resp.headers["location"]).query))["code"]
    resp = client.post("/api/cli/token", json={"code": code, "code_verifier": VERIFIER})
    assert resp.status_code == 200, resp.text
    assert resp.json()["namespace"] == namespace
    return resp.json()["token"]


def add(client, token: str, member_id: str, **extra):
    return client.post("/api/publisher/me/members", json={"member_id": member_id, **extra}, headers=bearer(token))


def remove(client, token: str, member_id: str):
    return client.delete(f"/api/publisher/me/members/{member_id}", headers=bearer(token))


def yank(client, token: str, version: str):
    return client.post(f"/api/extensions/{NAMESPACE}/hello/{version}/yank", headers=bearer(token))


def audit_rows(client) -> list[dict]:
    return client.get("/api/admin/audit", headers=ADMIN_HEADERS).json()["items"]


@pytest.fixture()
def tokens(client) -> dict[str, str]:
    """An owner with a namespace, a publisher member of it and an outsider
    (an approved developer with a namespace of its own), each with a token."""
    sign_in(client, OWNER)
    assert claim(client, NAMESPACE).status_code == 303
    owner = new_token(client, NAMESPACE)
    sign_in(client, OUTSIDER)
    assert claim(client, "other-tools").status_code == 303
    outsider = new_token(client, "other-tools")
    sign_in(client, PUBLISHER)
    assert add(client, owner, PUBLISHER).status_code == 201
    publisher = cli_token(client, NAMESPACE)
    return {"owner": owner, "publisher": publisher, "outsider": outsider}


# -- the permission matrix ---------------------------------------------------
@pytest.mark.parametrize(("who", "allowed"), [("owner", True), ("publisher", True), ("outsider", False)])
def test_publish(client, tokens, who, allowed):
    resp = publish(client, tokens[who], package_for(NAMESPACE, "hello", version="1.0.0"))
    if allowed:
        assert resp.status_code == 201, resp.text
    else:
        assert resp.status_code == 403


@pytest.mark.parametrize(("who", "allowed"), [("owner", True), ("publisher", True), ("outsider", False)])
def test_yank(client, tokens, who, allowed):
    assert publish(client, tokens["owner"], package_for(NAMESPACE, "hello", version="1.0.0")).status_code == 201
    resp = yank(client, tokens[who], "1.0.0")
    if allowed:
        assert resp.status_code == 200, resp.text
    else:
        assert resp.status_code == 403 and resp.json()["detail"]["code"] == "NOT_OWNER"


@pytest.mark.parametrize(("who", "allowed"), [("owner", True), ("publisher", False), ("outsider", False)])
def test_add_member(client, tokens, who, allowed):
    sign_in(client, "mem-new")  # approved developer
    resp = add(client, tokens[who], "mem-new")
    members = client.get("/api/publisher/me/members", headers=bearer(tokens["owner"])).json()["members"]
    if allowed:
        assert resp.status_code == 201, resp.text
        assert "mem-new" in {m["member_id"] for m in members}
        return
    assert "mem-new" not in {m["member_id"] for m in members}
    if who == "publisher":
        assert resp.status_code == 403 and resp.json()["detail"]["code"] == "OWNER_ONLY"
    else:
        # An outsider's token names its own namespace only: the call can
        # never reach this one.
        assert resp.json()["namespace"] == "other-tools"


@pytest.mark.parametrize(("who", "allowed"), [("owner", True), ("publisher", False), ("outsider", False)])
def test_remove_member(client, tokens, who, allowed):
    resp = remove(client, tokens[who], PUBLISHER)
    members = client.get("/api/publisher/me/members", headers=bearer(tokens["owner"])).json()["members"]
    if allowed:
        assert resp.status_code == 200, resp.text
        assert PUBLISHER not in {m["member_id"] for m in members}
        return
    assert PUBLISHER in {m["member_id"] for m in members}
    if who == "publisher":
        assert resp.status_code == 403 and resp.json()["detail"]["code"] == "OWNER_ONLY"
    else:
        assert resp.status_code == 404  # not a member of the outsider's own namespace


# -- members list and audit --------------------------------------------------
def test_members_list_shows_owner_first_and_each_callers_role(client, tokens):
    body = client.get("/api/publisher/me/members", headers=bearer(tokens["owner"])).json()
    assert body["namespace"] == NAMESPACE and body["your_role"] == "owner"
    assert [(m["member_id"], m["role"]) for m in body["members"]] == [(OWNER, "owner"), (PUBLISHER, "publisher")]
    assert body["members"][1]["added_by"] == f"member:{OWNER}" and body["members"][1]["added_at"]
    body = client.get("/api/publisher/me/members", headers=bearer(tokens["publisher"])).json()
    assert body["your_role"] == "publisher"
    # The outsider's token only ever sees its own namespace.
    body = client.get("/api/publisher/me/members", headers=bearer(tokens["outsider"])).json()
    assert body["namespace"] == "other-tools" and [m["member_id"] for m in body["members"]] == [OUTSIDER]


def test_publisher_actions_are_audited_as_the_member(client, tokens):
    assert publish(client, tokens["publisher"], package_for(NAMESPACE, "hello", version="1.0.0")).status_code == 201
    assert yank(client, tokens["publisher"], "1.0.0").status_code == 200
    rows = audit_rows(client)
    assert [r["actor"] for r in rows if r["action"] == "version.yank"] == [f"member:{PUBLISHER}"]
    adds = [r for r in rows if r["action"] == "namespace-member.add"]
    assert adds and adds[0]["actor"] == f"member:{OWNER}" and adds[0]["detail"]["member_id"] == PUBLISHER
    for row in rows:
        assert "nvp_" not in str(row)


# -- refusals ----------------------------------------------------------------
def test_only_the_publisher_role_exists(client, tokens):
    sign_in(client, "mem-new")
    resp = add(client, tokens["owner"], "mem-new", role="maintainer")
    assert resp.status_code == 422 and resp.json()["detail"]["code"] == "ROLE_INVALID"


def test_an_unapproved_account_cannot_be_added(client, tokens):
    resp = add(client, tokens["owner"], "mem-never-applied")
    assert resp.status_code == 409 and resp.json()["detail"]["code"] == "QUALIFICATION_REQUIRED"


def test_the_owner_and_an_existing_member_cannot_be_added_again(client, tokens):
    assert add(client, tokens["owner"], OWNER).json()["detail"]["code"] == "MEMBER_INVALID"
    assert add(client, tokens["owner"], PUBLISHER).json()["detail"]["code"] == "MEMBER_INVALID"
    assert remove(client, tokens["owner"], "mem-nobody").status_code == 404


def test_an_account_token_cannot_change_members(client, tokens):
    params = {"port": "5555", "state": "s" * 20, "code_challenge": cli.pkce_challenge(VERIFIER), "scope": "account"}
    page = client.get("/cli/authorize", params=params)
    csrf = page.text.split('name="csrf" value="')[1].split('"')[0]
    resp = client.post("/cli/authorize", data={**params, "csrf": csrf})
    code = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(resp.headers["location"]).query))["code"]
    account = client.post("/api/cli/token", json={"code": code, "code_verifier": VERIFIER}).json()["token"]
    resp = add(client, account, "mem-new")
    assert resp.status_code == 403 and resp.json()["detail"]["code"] == "TOKEN_SCOPE"


def test_removing_a_member_revokes_its_tokens(client, tokens):
    assert remove(client, tokens["owner"], PUBLISHER).status_code == 200
    resp = publish(client, tokens["publisher"], package_for(NAMESPACE, "hello", version="1.0.0"))
    assert resp.status_code == 401 and resp.json()["detail"]["code"] == "TOKEN_REVOKED"
    # The removed account is no longer offered the namespace at login.
    page = client.get(
        "/cli/authorize",
        params={"port": "5555", "state": "s" * 20, "code_challenge": cli.pkce_challenge(VERIFIER)},
    )
    assert f'value="{NAMESPACE}"' not in page.text
    assert [r for r in audit_rows(client) if r["action"] == "namespace-member.remove"][0]["detail"]["tokens_revoked"] == 1


def test_a_member_whose_qualification_lapses_stops_publishing(client, tokens):
    with Session(client.app.state.registry.engine) as session:
        session.get(DeveloperQualification, PUBLISHER).status = "revoked"
        session.commit()
    resp = publish(client, tokens["publisher"], package_for(NAMESPACE, "hello", version="1.0.0"))
    assert resp.status_code == 401 and resp.json()["detail"]["code"] == "TOKEN_REVOKED"
    # The owner is unaffected.
    assert publish(client, tokens["owner"], package_for(NAMESPACE, "hello", version="1.0.0")).status_code == 201


def test_a_publisher_cannot_set_or_replace_the_signing_key(client, tokens):
    _private, member_key = generate_keypair()
    resp = client.put("/api/publisher/me/key", json={"public_key": member_key}, headers=bearer(tokens["publisher"]))
    assert resp.status_code == 403 and resp.json()["detail"]["code"] == "OWNER_ONLY"

    _private, owner_key = generate_keypair()
    resp = client.put("/api/publisher/me/key", json={"public_key": owner_key}, headers=bearer(tokens["owner"]))
    assert resp.status_code == 200, resp.text
    resp = client.put("/api/publisher/me/key", json={"public_key": member_key}, headers=bearer(tokens["publisher"]))
    assert resp.status_code == 409 and resp.json()["detail"]["code"] == "KEY_EXISTS"
    assert resp.json()["detail"]["public_key_fingerprint"] == public_key_fingerprint(owner_key)
    resp = client.put(
        "/api/publisher/me/key", json={"public_key": member_key, "replace": True}, headers=bearer(tokens["publisher"])
    )
    assert resp.status_code == 403 and resp.json()["detail"]["code"] == "OWNER_ONLY"
    # Confirming the namespace's own key is fine.
    resp = client.put("/api/publisher/me/key", json={"public_key": owner_key}, headers=bearer(tokens["publisher"]))
    assert resp.status_code == 200
    me = client.get("/api/publisher/me", headers=bearer(tokens["owner"])).json()
    assert me["public_key_fingerprint"] == public_key_fingerprint(owner_key)


# -- migration -----------------------------------------------------------------
def test_migration_14_adds_members_and_token_owner_columns(tmp_path):
    path = tmp_path / "registry.db"
    engine = create_db_engine(path)
    assert applied_migrations(engine)[14] == "namespace-members"
    with sqlite3.connect(path) as db:
        db.execute("DROP TABLE namespace_member")
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert "namespace_member" not in tables
        step = next(step for number, _, step in MIGRATIONS if number == 14)
        step(db)
        step(db)  # idempotent
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        token_columns = {row[1] for row in db.execute("PRAGMA table_info(publisher_token)")}
        code_columns = {row[1] for row in db.execute("PRAGMA table_info(cli_auth_code)")}
    assert "namespace_member" in tables
    assert "navide_member_id" in token_columns and "navide_member_id" in code_columns
    assert run_migrations(engine) == []


def test_testplace_developer_endpoints_are_the_owners(client, tokens):
    assert publish(client, tokens["owner"], package_for(NAMESPACE, "hello", version="1.0.0")).status_code == 201
    path = f"/api/testplace/{NAMESPACE}/hello/invites"
    assert client.get(path, headers=bearer(tokens["owner"])).status_code == 200
    resp = client.get(path, headers=bearer(tokens["publisher"]))
    assert resp.status_code == 403 and resp.json()["detail"]["code"] == "FORBIDDEN"
    resp = client.post(path, json={"labels": ["x"]}, headers=bearer(tokens["publisher"]))
    assert resp.status_code == 403


def test_revoking_a_members_qualification_revokes_its_member_tokens(client, tokens):
    resp = client.post(f"/api/admin/developers/{PUBLISHER}/revoke", json={"reason": "abuse"}, headers=ADMIN_HEADERS)
    assert resp.status_code == 200, resp.text
    with Session(client.app.state.registry.engine) as session:
        from sqlmodel import select

        from registry.models import PublisherToken

        rows = session.exec(select(PublisherToken).where(PublisherToken.navide_member_id == PUBLISHER)).all()
        assert rows and all(row.revoked_at is not None for row in rows)
    # The owner's namespace is not frozen by a member's revocation.
    assert publish(client, tokens["owner"], package_for(NAMESPACE, "hello", version="1.0.0")).status_code == 201

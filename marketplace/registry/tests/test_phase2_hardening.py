"""Hardening from the independent verification: pending packs in the nesting
check (M1), ASCII-only comparisons (L1), single-use CLI codes (L2), atomic
namespace claims (L3), session revocation (L4), reserved words in extension
names (L5) and listing rollback on approval (L6)."""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest
from sqlmodel import Session, select

from registry import app as app_module
from registry import self_service
from registry.cli import pkce_challenge
from registry.cloud_auth import SESSION_COOKIE
from registry.models import CliAuthCode, Publisher, PublisherToken
from registry.similarity import check_extension_name
from tests.fixtures import CONTRACT_FIXTURES, build_v2_package, contract_manifest
from tests.phase2_helpers import (
    approve_developer,
    ADMIN_HEADERS,
    claim,
    cloud_settings,
    csrf_of,
    make_client,
    navide_auth_callback,
    new_token,
    package_for,
    publish,
    queued_artifacts,
    sign_in,
    start_login,
)


@pytest.fixture()
def client(tmp_path):
    client = make_client(cloud_settings(tmp_path))
    sign_in(client)
    return client


def _pack(ident: str, members: list[str]) -> bytes:
    manifest = json.loads((CONTRACT_FIXTURES / "valid" / "extension-pack.json").read_text())
    manifest.update(id=ident, publisher=ident.split(".")[0], version="1.0.0", extensionPack=members)
    return build_v2_package(copy.deepcopy(manifest))


def _v2(ident: str, version: str, description: str) -> bytes:
    manifest = copy.deepcopy(contract_manifest())
    manifest.update(id=ident, publisher=ident.split(".")[0], version=version)
    manifest["marketplace"]["description"] = description
    return build_v2_package(manifest)


def _approve(client, namespace, name, version="1.0.0"):
    return client.post(
        f"/api/admin/review/{namespace}/{name}/{version}/approve",
        json={"artifacts": queued_artifacts(client, namespace, name, version)},
        headers=ADMIN_HEADERS,
    )


# -- M1 ----------------------------------------------------------------------------
def test_two_pending_packs_cannot_list_each_other(client):
    """The verifier's exact repro: pack-a lists pack-b, pack-b lists pack-a."""
    claim(client, "packs")
    token = new_token(client, "packs")
    first = publish(client, token, _pack("packs.pack-a", ["packs.pack-b"]))
    assert first.status_code == 201 and first.json()["review_status"] == "pending"
    second = publish(client, token, _pack("packs.pack-b", ["packs.pack-a"]))
    assert second.status_code == 400
    assert second.json()["detail"] == "extension pack member packs.pack-a is itself an extension pack"
    assert _approve(client, "packs", "pack-a").status_code == 200
    assert _approve(client, "packs", "pack-b").status_code == 404  # refused before it existed
    public = {i["identity"] for i in client.get("/api/extensions").json()["items"]}
    assert public == {"packs.pack-a"}


def test_approval_rechecks_pack_nesting(client, monkeypatch):
    """Should two cyclic packs both be pending anyway (a race, or rows from
    before this check), approval refuses the second with a clear reason."""
    claim(client, "packs")
    token = new_token(client, "packs")
    monkeypatch.setattr(app_module, "pack_conflict", lambda *a, **k: None)
    assert publish(client, token, _pack("packs.pack-a", ["packs.pack-b"])).status_code == 201
    assert publish(client, token, _pack("packs.pack-b", ["packs.pack-a"])).status_code == 201
    monkeypatch.undo()
    assert _approve(client, "packs", "pack-a").status_code == 200
    refused = _approve(client, "packs", "pack-b")
    assert refused.status_code == 409
    assert refused.json()["detail"] == "cannot approve: extension pack member packs.pack-a is itself an extension pack"
    assert client.get("/api/extensions/packs/pack-b").status_code == 404


# -- L1 ----------------------------------------------------------------------------
UNICODE_STATE = "ｓ" * 20  # full-width letters: str.isalnum() says True


@pytest.mark.parametrize(
    "params",
    [
        {"port": "5555", "state": UNICODE_STATE, "code_challenge": "c" * 43},
        {"port": "5555", "state": "s" * 20, "code_challenge": "é" * 43},
    ],
)
def test_unicode_cli_parameters_are_refused_with_400(client, params):
    assert client.get("/cli/authorize", params=params).status_code == 400
    csrf = csrf_of(client, "/publisher/claim")
    assert client.post("/cli/authorize", data={**params, "namespace": "x", "csrf": csrf}).status_code == 400
    assert client.post("/cli/deny", data={**params, "csrf": csrf}).status_code == 400


def test_unicode_tokens_are_refused_not_500(client):
    assert client.post("/publisher/claim", data={"namespace": "acme-tools", "csrf": "é"}).status_code == 403
    assert client.get("/api/admin/review", headers={"X-Admin-Token": "é".encode()}).status_code == 401
    assert client.post("/api/cli/token", json={"code": "é", "code_verifier": "é"}).status_code == 400
    nonce = start_login(client)
    bad = navide_auth_callback(nonce)
    assert client.get("/auth/callback", params={**bad, "sig": "é" * 64}).status_code == 400


# -- L2 ----------------------------------------------------------------------------
def test_a_cli_code_redeems_once_even_when_raced(client):
    claim(client, "acme-tools")
    engine = client.app.state.registry.engine
    verifier = "v" * 50
    with Session(engine) as session:
        publisher = session.exec(select(Publisher).where(Publisher.name == "acme-tools")).one()
        code = self_service.issue_cli_code(session, publisher, code_challenge=pkce_challenge(verifier), label="t")

    class RacingSession(Session):
        """Another redemption lands between our read and our update."""

        def exec(self, statement, *args, **kwargs):
            result = super().exec(statement, *args, **kwargs)
            if "cli_auth_code" in str(statement):
                # Drain the cursor so the concurrent writer is not blocked.
                result = _Rows(result.all())
                with Session(engine) as other:
                    row = other.exec(select(CliAuthCode)).one()
                    row.used_at = self_service._now()
                    other.add(row)
                    other.commit()
            return result

    with RacingSession(engine) as session:
        with pytest.raises(self_service.SelfServiceError):
            self_service.exchange_cli_code(session, code=code, code_verifier=verifier)
    with Session(engine) as session:
        assert session.exec(select(PublisherToken)).all() == []


class _Rows:
    def __init__(self, rows):
        self.rows = rows

    def first(self):
        return self.rows[0] if self.rows else None


# -- L3 ----------------------------------------------------------------------------
def test_claim_cap_and_uniqueness_hold_without_the_precheck(client, monkeypatch):
    """With the pre-check bypassed (two claims that both passed it), the
    INSERT itself still enforces the cap, and a duplicate is a clean error."""
    engine = client.app.state.registry.engine
    monkeypatch.setattr(self_service, "check_claim", lambda *a, **k: self_service.ClaimVerdict(True, ""))
    approve_developer(client, "mem-9")
    approve_developer(client, "mem-8")
    with Session(engine) as session:
        for name in ("alpha-one", "bravo-two", "charlie-three"):
            self_service.claim_namespace(session, member_id="mem-9", display_name="x", namespace=name)
        with pytest.raises(self_service.SelfServiceError, match="at most 3"):
            self_service.claim_namespace(session, member_id="mem-9", display_name="x", namespace="delta-four")
        with pytest.raises(self_service.SelfServiceError, match="already taken"):
            self_service.claim_namespace(session, member_id="mem-8", display_name="x", namespace="alpha-one")
        owned = session.exec(select(Publisher).where(Publisher.navide_member_id == "mem-9")).all()
        assert len(owned) == 3 and all(p.review_required for p in owned)
    resp = claim(client, "alpha-one")  # through the web: 409, not 500
    assert resp.status_code == 409 and "already taken" in resp.text


# -- L4 ----------------------------------------------------------------------------
def test_sign_out_revokes_the_session_cookie(client, tmp_path):
    stolen = client.cookies.get(SESSION_COOKIE)
    other_device = make_client(cloud_settings(tmp_path))
    sign_in(other_device)
    html = client.get("/").text
    csrf = html.split('name="csrf" value="')[1].split('"')[0]
    assert client.post("/logout", data={"csrf": csrf}).status_code == 303
    client.cookies.clear()
    assert client.get("/publisher", cookies={SESSION_COOKIE: stolen}).status_code == 303
    assert other_device.get("/publisher").status_code == 303  # every session of the account
    sign_in(client)  # a fresh sign-in works again
    assert client.get("/publisher").status_code == 200


# -- L5 ----------------------------------------------------------------------------
@pytest.mark.parametrize("name", ["security", "admin", "support", "system"])
def test_reserved_words_in_extension_names_only_warn(name):
    findings = check_extension_name("acme", name, [])
    assert [f.tier for f in findings] == ["warn"]
    assert "reserved name" in findings[0].message


def test_reserved_word_extension_can_be_approved_but_impersonation_stays_blocked(client):
    claim(client, "acme-tools")
    token = new_token(client, "acme-tools")
    publish(client, token, package_for("acme-tools", "security"))
    (item,) = client.get("/api/admin/review", headers=ADMIN_HEADERS).json()["items"]
    assert item["similarity_blocked"] is False and item["similarity"][0]["tier"] == "warn"
    assert _approve(client, "acme-tools", "security").status_code == 200
    assert [f.tier for f in check_extension_name("zzz", "navide-git", [("navide", "git")])] == ["block"]


# -- L6 ----------------------------------------------------------------------------
def test_approving_an_older_or_prerelease_version_keeps_the_listing(client):
    claim(client, "acme-tools")
    token = new_token(client, "acme-tools")
    for version, text in (("2.0.0", "Two"), ("1.5.0", "Older"), ("3.0.0-beta.1", "Beta")):
        assert publish(client, token, _v2("acme-tools.lint", version, text)).status_code == 201
    assert _approve(client, "acme-tools", "lint", "2.0.0").status_code == 200
    assert _approve(client, "acme-tools", "lint", "1.5.0").status_code == 200
    assert _approve(client, "acme-tools", "lint", "3.0.0-beta.1").status_code == 200
    assert client.get("/api/extensions/acme-tools/lint").json()["description"] == "Two"
    publish(client, token, _v2("acme-tools.lint", "2.1.0", "Newer"))
    _approve(client, "acme-tools", "lint", "2.1.0")
    assert client.get("/api/extensions/acme-tools/lint").json()["description"] == "Newer"


def test_first_approved_version_sets_the_listing_even_if_prerelease(client):
    claim(client, "acme-tools")
    token = new_token(client, "acme-tools")
    assert publish(client, token, _v2("acme-tools.early", "0.1.0-beta.1", "Beta only")).status_code == 201
    _approve(client, "acme-tools", "early", "0.1.0-beta.1")
    assert client.get("/api/extensions/acme-tools/early").json()["description"] == "Beta only"


# -- UI polish -----------------------------------------------------------------------
def test_cli_buttons_share_a_row_and_nav_links_share_a_style(client):
    claim(client, "acme-tools")
    params = {"port": "5555", "state": "s" * 20, "code_challenge": "c" * 43}
    html = client.get("/cli/authorize", params=params).text
    row = html.split('<div class="button-row">')[1].split("</div>")[0]
    assert "Authorize</button>" in row and '<button type="submit" form="cli-deny">Cancel</button>' in row
    assert '<form id="cli-deny" method="post" action="/cli/deny">' in html
    css = (Path(app_module.__file__).parent / "web_static" / "style.css").read_text()
    assert ".site-nav .link-button { color: var(--text);" in css


def test_an_approved_prerelease_pack_counts_as_a_pack(client):
    """R1 repro: mem-p 1.0.0 is a normal extension, mem-p 2.0.0-beta.1 an
    approved pack; a pack listing mem-p must be refused at submit and at
    approval."""
    claim(client, "packs")
    token = new_token(client, "packs")
    assert publish(client, token, _v2("packs.mem-p", "1.0.0", "Plain")).status_code == 201
    assert _approve(client, "packs", "mem-p", "1.0.0").status_code == 200
    manifest = json.loads((CONTRACT_FIXTURES / "valid" / "extension-pack.json").read_text())
    manifest.update(id="packs.mem-p", publisher="packs", version="2.0.0-beta.1", extensionPack=["packs.other"])
    assert publish(client, token, build_v2_package(manifest)).status_code == 201
    assert _approve(client, "packs", "mem-p", "2.0.0-beta.1").status_code == 200

    refused = publish(client, token, _pack("packs.pack-t", ["packs.mem-p"]))
    assert refused.status_code == 400
    assert refused.json()["detail"] == "extension pack member packs.mem-p is itself an extension pack"


def test_approval_also_sees_approved_prereleases(client, monkeypatch):
    claim(client, "packs")
    token = new_token(client, "packs")
    publish(client, token, _v2("packs.mem-p", "1.0.0", "Plain"))
    _approve(client, "packs", "mem-p", "1.0.0")
    monkeypatch.setattr(app_module, "pack_conflict", lambda *a, **k: None)
    assert publish(client, token, _pack("packs.pack-t", ["packs.mem-p"])).status_code == 201
    monkeypatch.undo()
    manifest = json.loads((CONTRACT_FIXTURES / "valid" / "extension-pack.json").read_text())
    manifest.update(id="packs.mem-p", publisher="packs", version="2.0.0-beta.1", extensionPack=["packs.other"])
    # pack-t is pending and lists mem-p, so mem-p cannot become a pack now...
    assert publish(client, token, build_v2_package(manifest)).status_code == 400
    # ...and had it slipped in, approving pack-t re-checks against public pre-releases.
    monkeypatch.setattr(app_module, "pack_conflict", lambda *a, **k: None)
    assert publish(client, token, build_v2_package(manifest)).status_code == 201
    monkeypatch.undo()
    assert _approve(client, "packs", "mem-p", "2.0.0-beta.1").status_code == 200
    refused = _approve(client, "packs", "pack-t")
    assert refused.status_code == 409
    assert refused.json()["detail"] == "cannot approve: extension pack member packs.mem-p is itself an extension pack"

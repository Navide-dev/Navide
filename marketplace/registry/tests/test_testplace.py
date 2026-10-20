"""Testplace (B2-B5): invite-only builds reach invited Cloud members only."""

from __future__ import annotations

import copy
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from registry import blocklist
from registry.account_auth import create_account_token
from registry.app import create_app
from registry.config import VERIFIER_ACCEPTING, Settings
from registry.db import create_db_engine
from registry.migrations import MIGRATIONS, applied_migrations, run_migrations
from registry.models import DeveloperQualification, ExtensionVersion, Publisher, RegistryAudit

from tests.fixtures import build_v2_package, contract_manifest

ADMIN = "testplace-admin"  # noqa: S105 - test fixture token
PUBLISHER_TOKEN = "tok-" + "acme-testplace"


@pytest.fixture()
def client(tmp_path) -> TestClient:
    settings = Settings(
        data_dir=tmp_path,
        verifier_kind=VERIFIER_ACCEPTING,
        require_signature=False,
        require_auth=False,
        admin_token=ADMIN,
    )
    client = TestClient(create_app(settings))
    resp = client.post(
        "/api/publishers",
        json={"name": "acme", "token": PUBLISHER_TOKEN},
        headers={"X-Admin-Token": ADMIN},
    )
    assert resp.status_code == 201, resp.text
    return client


def _session(client: TestClient) -> Session:
    return Session(client.app.state.registry.engine)


def _member(client: TestClient, member_id: str) -> dict:
    with _session(client) as session:
        plain, _ = create_account_token(session, member_id, label="test")
    return {"Authorization": f"Bearer {plain}"}


def _publisher() -> dict:
    return {"Authorization": f"Bearer {PUBLISHER_TOKEN}"}


def _admin() -> dict:
    return {"X-Admin-Token": ADMIN}


def _publish(client: TestClient, version: str = "1.0.0", *, headers=None, channel="testplace", ident="acme.files"):
    manifest = copy.deepcopy(contract_manifest())
    manifest.update(id=ident, publisher=ident.split(".")[0], version=version)
    return client.post(
        "/api/publish",
        params={"channel": channel},
        headers=_publisher() if headers is None else headers,
        files={"package": ("pkg.vsix", build_v2_package(manifest), "application/zip")},
    )


def _invite(client: TestClient, labels=("tester@example.com",)) -> list[str]:
    resp = client.post(
        "/api/testplace/acme/files/invites", json={"labels": list(labels)}, headers=_publisher()
    )
    assert resp.status_code == 201, resp.text
    return [item["join_token"] for item in resp.json()["invites"]]


def _join(client: TestClient, member: dict, token: str):
    return client.post("/api/testplace/join", json={"token": token}, headers=member)


# -- publishing ------------------------------------------------------------
def test_testplace_publish_signs_channel_and_a_90_day_expiry(client: TestClient) -> None:
    resp = _publish(client)
    assert resp.status_code == 201, resp.text
    with _session(client) as session:
        row = session.exec(select(ExtensionVersion)).one()
    assert row.channel == "testplace"
    expires = row.expires_at.replace(tzinfo=timezone.utc)
    assert timedelta(days=89, hours=23) < expires - datetime.now(timezone.utc) <= timedelta(days=90)
    assert row.registry_envelope["channel"] == "testplace"
    assert row.registry_envelope["expiresAt"].startswith(expires.strftime("%Y-%m-%dT%H:%M"))


def test_anonymous_testplace_publish_is_refused(client: TestClient) -> None:
    resp = _publish(client, headers={})
    assert resp.status_code == 401, resp.text


def test_an_unvetted_namespace_cannot_publish_to_testplace(client: TestClient) -> None:
    with _session(client) as session:
        publisher = session.exec(select(Publisher).where(Publisher.name == "acme")).one()
        publisher.navide_member_id = "member-owner"
        session.add(publisher)
        session.commit()
    resp = _publish(client)
    assert resp.status_code == 403, resp.text
    assert resp.json()["detail"]["code"] == "QUALIFICATION_REQUIRED"


def test_public_reads_and_anonymous_calls_never_reach_a_testplace_build(client: TestClient) -> None:
    assert _publish(client).status_code == 201
    assert client.get("/api/extensions").json()["items"] == []
    assert client.get("/api/extensions/acme/files").status_code == 404
    assert client.get("/api/extensions/acme/files/1.0.0/download").status_code == 404
    assert client.get("/api/testplace").status_code == 401
    assert client.get("/api/testplace/acme/files").status_code == 401
    assert client.get("/api/testplace/acme/files/1.0.0/download").status_code == 401


# -- invites ---------------------------------------------------------------
def test_an_uninvited_member_sees_and_downloads_nothing(client: TestClient) -> None:
    assert _publish(client).status_code == 201
    _invite(client)
    stranger = _member(client, "member-stranger")
    assert client.get("/api/testplace", headers=stranger).json() == {"items": []}
    missing = client.get("/api/testplace/acme/nope", headers=stranger)
    hidden = client.get("/api/testplace/acme/files", headers=stranger)
    assert hidden.status_code == missing.status_code == 404
    assert hidden.json() == missing.json()
    assert client.get("/api/testplace/acme/files/1.0.0/download", headers=stranger).status_code == 404


def test_an_invited_member_lists_and_downloads_the_build(client: TestClient) -> None:
    assert _publish(client).status_code == 201
    (token,) = _invite(client)
    tester = _member(client, "member-tester")
    joined = _join(client, tester, token)
    assert joined.status_code == 200, joined.text
    assert joined.json()["identity"] == "acme.files"

    (item,) = client.get("/api/testplace", headers=tester).json()["items"]
    (version,) = item["versions"]
    assert version["channel"] == "testplace"
    assert version["expires_at"] is not None
    assert version["registry_envelope"]["channel"] == "testplace"
    assert item["trust_metadata_signature"]
    download = client.get("/api/testplace/acme/files/1.0.0/download", headers=tester)
    assert download.status_code == 200
    assert download.headers["X-Package-Digest"] == version["package_digest"]

    # The token is single-use: a second account cannot ride on it.
    other = _member(client, "member-other")
    assert _join(client, other, token).status_code == 404
    assert client.get("/api/testplace/acme/files", headers=other).status_code == 404


def test_invites_and_code_caps_have_no_upper_limit(client: TestClient) -> None:
    # The former caps (100 live invites per extension, 100 per request,
    # 1-1000 testers per code) are gone; going past each still succeeds.
    assert _publish(client).status_code == 201
    assert len(_invite(client, [f"t{i}" for i in range(150)])) == 150
    assert len(_invite(client, ["one-more"])) == 1
    listed = client.get("/api/testplace/acme/files/invites", headers=_publisher()).json()
    assert len(listed["invites"]) == 151 and "limit" not in listed
    code = client.post("/api/testplace/acme/files/codes", json={"max_testers": 5000}, headers=_publisher())
    assert code.status_code == 201 and code.json()["max_testers"] == 5000
    zero = client.post("/api/testplace/acme/files/codes", json={"max_testers": 0}, headers=_publisher())
    assert zero.status_code == 400


def test_a_revoked_invite_removes_access(client: TestClient) -> None:
    assert _publish(client).status_code == 201
    (token,) = _invite(client)
    tester = _member(client, "member-tester")
    assert _join(client, tester, token).status_code == 200
    (invite,) = client.get("/api/testplace/acme/files/invites", headers=_publisher()).json()["invites"]
    assert invite["state"] == "joined"
    client.post(f"/api/testplace/acme/files/invites/{invite['id']}/revoke", headers=_publisher())
    assert client.get("/api/testplace/acme/files", headers=tester).status_code == 404


def test_only_the_namespace_owner_manages_invites(client: TestClient) -> None:
    assert _publish(client).status_code == 201
    stranger = _member(client, "member-stranger")
    resp = client.post("/api/testplace/acme/files/invites", json={"labels": ["x"]}, headers=stranger)
    assert resp.status_code == 403
    assert client.post("/api/testplace/acme/files/invites", json={"labels": ["x"]}).status_code == 401

    # The owning account's own account token works once it is vetted.
    with _session(client) as session:
        publisher = session.exec(select(Publisher).where(Publisher.name == "acme")).one()
        publisher.navide_member_id = "member-owner"
        session.add(publisher)
        session.add(DeveloperQualification(navide_member_id="member-owner", status="approved"))
        session.commit()
    owner = _member(client, "member-owner")
    resp = client.post("/api/testplace/acme/files/invites", json={"labels": ["x"]}, headers=owner)
    assert resp.status_code == 201, resp.text


def test_a_frozen_namespace_hides_its_builds_from_testers(client: TestClient) -> None:
    assert _publish(client).status_code == 201
    (token,) = _invite(client)
    tester = _member(client, "member-tester")
    assert _join(client, tester, token).status_code == 200
    with _session(client) as session:
        publisher = session.exec(select(Publisher).where(Publisher.name == "acme")).one()
        publisher.frozen_at = datetime.now(timezone.utc)
        session.add(publisher)
        session.commit()
    assert client.get("/api/testplace", headers=tester).json() == {"items": []}
    assert client.get("/api/testplace/acme/files/1.0.0/download", headers=tester).status_code == 404


# -- expiry and revocation -------------------------------------------------
def test_an_expired_build_is_no_longer_served(client: TestClient) -> None:
    assert _publish(client).status_code == 201
    (token,) = _invite(client)
    tester = _member(client, "member-tester")
    _join(client, tester, token)
    with _session(client) as session:
        row = session.exec(select(ExtensionVersion)).one()
        row.expires_at = datetime.now(timezone.utc) - timedelta(seconds=1)
        session.add(row)
        session.commit()
    (item,) = client.get("/api/testplace", headers=tester).json()["items"]
    assert item["versions"] == []
    assert client.get("/api/testplace/acme/files/1.0.0/download", headers=tester).status_code == 404


def test_revoking_a_version_blocks_it_in_the_signed_trust_metadata(client: TestClient) -> None:
    assert _publish(client).status_code == 201
    (token,) = _invite(client)
    tester = _member(client, "member-tester")
    _join(client, tester, token)
    resp = client.post(
        "/api/testplace/acme/files/versions/1.0.0/revoke", json={"reason": "crash"}, headers=_publisher()
    )
    assert resp.status_code == 200, resp.text
    assert client.get("/api/testplace/acme/files/1.0.0/download", headers=tester).status_code == 404
    # R-MED-3: the public signed metadata names nothing an outsider could probe
    # for; the invited tester learns of it from the tester detail instead.
    assert all(blocked.get("packageId") != "acme.files" for blocked in _public_trust_metadata(client)["blockedPackages"])
    detail = client.get("/api/testplace/acme/files", headers=tester)
    assert detail.status_code == 200
    assert detail.json()["withdrawn"] == [{"version": "1.0.0", "target": "universal"}]


# -- public codes ----------------------------------------------------------
def test_the_first_code_waits_for_review_and_later_ones_open_at_once(client: TestClient) -> None:
    resp = client.post("/api/testplace/acme/files/codes", json={"max_testers": 2}, headers=_publisher())
    assert resp.status_code == 404  # no such extension yet
    assert _publish(client).status_code == 201
    first = client.post("/api/testplace/acme/files/codes", json={"max_testers": 2}, headers=_publisher()).json()
    assert first["state"] == "in-review"
    tester = _member(client, "member-a")
    assert _join(client, tester, first["code"]).status_code == 404

    queue = client.get("/api/admin/testplace/codes", headers=_admin()).json()["codes"]
    assert [c["id"] for c in queue] == [first["id"]]
    assert client.get("/api/admin/testplace/codes").status_code == 401
    decided = client.post(
        f"/api/admin/testplace/codes/{first['id']}/decision", json={"approve": True}, headers=_admin()
    )
    assert decided.json()["state"] == "open"

    assert _join(client, tester, first["code"]).status_code == 200
    assert _join(client, _member(client, "member-b"), first["code"]).status_code == 200
    full = _join(client, _member(client, "member-c"), first["code"])
    assert full.status_code == 409 and full.json()["detail"]["code"] == "CODE_FULL"

    # Revoking stops new joins; testers already in stay in (TestFlight public link).
    client.post(f"/api/testplace/acme/files/codes/{first['id']}/revoke", headers=_publisher())
    assert _join(client, _member(client, "member-d"), first["code"]).status_code == 404
    assert client.get("/api/testplace/acme/files", headers=tester).status_code == 200

    second = client.post("/api/testplace/acme/files/codes", json={"max_testers": 5}, headers=_publisher()).json()
    assert second["state"] == "open"


def test_a_rejected_code_needs_a_reason_and_stays_closed(client: TestClient) -> None:
    assert _publish(client).status_code == 201
    code = client.post("/api/testplace/acme/files/codes", json={"max_testers": 2}, headers=_publisher()).json()
    assert client.post(
        f"/api/admin/testplace/codes/{code['id']}/decision", json={"approve": False}, headers=_admin()
    ).status_code == 400
    client.post(
        f"/api/admin/testplace/codes/{code['id']}/decision",
        json={"approve": False, "reason": "describe what testers should try"},
        headers=_admin(),
    )
    assert _join(client, _member(client, "member-a"), code["code"]).status_code == 404


def test_leave_answers_a_member_without_a_seat_like_a_missing_extension(client: TestClient) -> None:
    assert _publish(client).status_code == 201
    outsider = _member(client, "member-out")
    missing = client.post("/api/testplace/acme/nothing/leave", headers=outsider)
    existing = client.post("/api/testplace/acme/files/leave", headers=outsider)
    # Same answer either way, so leave cannot tell an uninvited member a test exists.
    assert (existing.status_code, existing.json()) == (missing.status_code, missing.json())
    assert existing.status_code == 404
    tester = _member(client, "member-a")
    assert _join(client, tester, _invite(client)[0]).status_code == 200
    assert client.post("/api/testplace/acme/files/leave", headers=tester).status_code == 204
    assert client.get("/api/testplace/acme/files", headers=tester).status_code == 404


def test_a_public_code_never_seats_more_testers_than_its_cap_under_a_race(client: TestClient, monkeypatch) -> None:
    from registry import testplace as tp

    assert _publish(client).status_code == 201
    code = client.post("/api/testplace/acme/files/codes", json={"max_testers": 1}, headers=_publisher()).json()
    client.post(f"/api/admin/testplace/codes/{code['id']}/decision", json={"approve": True}, headers=_admin())
    real = tp.code_testers

    def count_then_race(session, row):
        # Member B joins and commits between member A's seat count and A's insert.
        seen = real(session, row)
        monkeypatch.setattr(tp, "code_testers", real)
        assert _join(client, _member(client, "member-b"), code["code"]).status_code == 200
        return seen

    monkeypatch.setattr(tp, "code_testers", count_then_race)
    late = _join(client, _member(client, "member-a"), code["code"])
    assert late.status_code == 409 and late.json()["detail"]["code"] == "CODE_FULL"
    with _session(client) as session:
        row = session.get(tp.TestplaceCode, code["id"])
        assert real(session, row) == 1


# -- promotion -------------------------------------------------------------
def test_promotion_resigns_the_same_artifact_as_a_public_version(client: TestClient) -> None:
    assert _publish(client).status_code == 201
    (token,) = _invite(client)
    tester = _member(client, "member-tester")
    _join(client, tester, token)
    digest = client.get("/api/testplace", headers=tester).json()["items"][0]["versions"][0]["package_digest"]

    assert client.post("/api/testplace/acme/files/versions/1.0.0/promote", headers=_publisher()).status_code == 200
    (request,) = client.get("/api/admin/testplace/promotions", headers=_admin()).json()["promotions"]
    assert request["extension"] == "acme.files"
    assert request["testers"] == 1
    assert request["reports"] == 0
    assert request["artifacts"] == [digest]

    resp = client.post(
        "/api/admin/testplace/promotions/acme/files/1.0.0/decision",
        json={"approve": True, "artifacts": [digest]},
        headers=_admin(),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["channel"] == "stable"

    detail = client.get("/api/extensions/acme/files").json()
    (version,) = detail["versions"]
    assert version["package_digest"] == digest
    assert version["channel"] == "stable"
    assert "channel" not in version["registry_envelope"]
    assert "expiresAt" not in version["registry_envelope"]
    assert len(version["registry_envelope"]) == 8
    with _session(client) as session:
        actions = [a.action for a in session.exec(select(RegistryAudit)).all()]
    assert "testplace.promotion.request" in actions
    assert "testplace.promotion.approve" in actions


def test_a_stale_promotion_decision_is_refused(client: TestClient) -> None:
    assert _publish(client).status_code == 201
    client.post("/api/testplace/acme/files/versions/1.0.0/promote", headers=_publisher())
    resp = client.post(
        "/api/admin/testplace/promotions/acme/files/1.0.0/decision",
        json={"approve": True, "artifacts": ["0" * 64]},
        headers=_admin(),
    )
    assert resp.status_code == 409
    assert client.get("/api/extensions/acme/files").status_code == 404


# -- migration 12 ----------------------------------------------------------
def test_migration_12_on_a_fresh_database_and_reruns_are_noops(tmp_path: Path) -> None:
    engine = create_db_engine(tmp_path / "registry.db")
    assert applied_migrations(engine)[12] == "testplace"
    assert run_migrations(engine) == []
    with sqlite3.connect(tmp_path / "registry.db") as db:
        tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        columns = {r[1] for r in db.execute("PRAGMA table_info(extension_version)")}
    assert {"testplace_invite", "testplace_code"} <= tables
    assert {"promotion_status", "promotion_requested_at"} <= columns


def test_migration_12_on_a_database_at_migration_11_keeps_existing_rows(tmp_path: Path) -> None:
    path = tmp_path / "registry.db"
    engine = create_db_engine(path)
    with sqlite3.connect(path) as db:
        db.execute("DROP TABLE testplace_invite")
        db.execute("DROP TABLE testplace_code")
        for column in (
            "promotion_status",
            "promotion_requested_at",
            "promotion_reviewed_at",
            "promotion_reviewed_by",
            "promotion_reason",
        ):
            db.execute(f"ALTER TABLE extension_version DROP COLUMN {column}")
        db.execute(
            "INSERT INTO extension (id, publisher_id, namespace, name, identity, categories, "
            "featured, download_count, rating_sum, rating_count, legacy_rating_sum, "
            "legacy_rating_count, created_at, updated_at) VALUES (1, 1, 'acme', 'files', "
            "'acme.files', '[]', 0, 0, 0, 0, 0, 0, '2026-09-01', '2026-09-01')"
        )
        db.execute(
            "INSERT INTO extension_version (id, extension_id, version, manifest, package_digest, "
            "package_key, target, registry_envelope, trust_tier, download_count, yanked, channel, "
            "published_at, review_status, review_report) VALUES (1, 1, '1.0.0', '{}', 'abc', 'k', "
            "'universal', '{}', 'unsigned', 0, 0, 'stable', '2026-09-01', 'approved', '{}')"
        )
        db.execute("DELETE FROM schema_migrations WHERE version = 12")

    assert run_migrations(engine) == [12]
    assert run_migrations(engine) == []
    step = next(step for number, _, step in MIGRATIONS if number == 12)
    with sqlite3.connect(path) as db:
        step(db)  # a half-recorded run changes nothing
        assert db.execute(
            "SELECT version, channel, promotion_status FROM extension_version"
        ).fetchall() == [("1.0.0", "stable", None)]


# -- admin page ------------------------------------------------------------
def test_admin_page_reviews_a_code_and_a_promotion_and_revokes(tmp_path) -> None:
    from tests.phase2_helpers import ADMIN_MEMBER, ADMIN_TOKEN, cloud_settings, csrf_of, make_client, sign_in

    client = make_client(cloud_settings(tmp_path))
    assert client.post(
        "/api/publishers", json={"name": "acme", "token": PUBLISHER_TOKEN}, headers={"X-Admin-Token": ADMIN_TOKEN}
    ).status_code == 201
    assert _publish(client).status_code == 201
    code = client.post("/api/testplace/acme/files/codes", json={"max_testers": 3}, headers=_publisher()).json()
    client.post("/api/testplace/acme/files/versions/1.0.0/promote", headers=_publisher())

    # Not signed in: sent to sign-in; signed in but not an admin: 403.
    assert client.get("/admin/testplace", follow_redirects=False).status_code == 303
    sign_in(client, "mem-someone")
    assert client.get("/admin/testplace").status_code == 403

    sign_in(client, ADMIN_MEMBER)
    html = client.get("/admin/testplace").text
    assert f"#{code['id']}" in html and "acme.files @ 1.0.0" in html
    csrf = csrf_of(client, "/admin/testplace")
    assert client.post(
        f"/admin/testplace/codes/{code['id']}", data={"decision": "approve", "csrf": csrf}, follow_redirects=False
    ).status_code == 303
    digest = client.get("/api/admin/testplace/promotions", headers={"X-Admin-Token": ADMIN_TOKEN}).json()[
        "promotions"
    ][0]["artifacts"][0]
    assert client.post(
        "/admin/testplace/promotions/acme/files/1.0.0",
        data={"decision": "approve", "artifact": [digest], "csrf": csrf},
        follow_redirects=False,
    ).status_code == 303
    assert client.get("/api/extensions/acme/files").json()["versions"][0]["channel"] == "stable"

    assert _publish(client, "1.1.0").status_code == 201
    assert client.post(
        "/admin/testplace/revoke", data={"identity": "acme.files", "version": "1.1.0", "reason": "", "csrf": csrf}
    ).status_code == 400
    assert client.post(
        "/admin/testplace/revoke",
        data={"identity": "acme.files", "version": "1.1.0", "reason": "malware", "csrf": csrf},
        follow_redirects=False,
    ).status_code == 303
    with _session(client) as session:
        actions = [a.action for a in session.exec(select(RegistryAudit)).all()]
        rows = session.exec(select(ExtensionVersion).where(ExtensionVersion.version == "1.1.0")).all()
    assert {"testplace.code.approve", "testplace.promotion.approve", "testplace.version.revoke"} <= set(actions)
    assert all(r.yanked for r in rows)


def _public_trust_metadata(client: TestClient) -> dict:
    """The root-signed trust metadata every public detail carries."""
    assert _publish(client, "9.0.0", channel="stable", ident="acme.public").status_code == 201
    resp = client.get("/api/extensions/acme/public")
    assert resp.status_code == 200, resp.text
    return resp.json()["trust_metadata"]


def test_a_developer_yank_of_a_testplace_build_reaches_its_testers_only(client: TestClient) -> None:
    """T-MED-1: a yanked test build must not read like one that merely expired."""
    assert _publish(client).status_code == 201
    (token,) = _invite(client)
    tester = _member(client, "member-tester")
    assert _join(client, tester, token).status_code == 200
    assert client.get("/api/testplace/acme/files", headers=tester).json()["withdrawn"] == []
    yank = client.post("/api/extensions/acme/files/1.0.0/yank", headers=_publisher())
    assert yank.status_code == 200, yank.text
    assert client.get("/api/testplace/acme/files", headers=tester).json()["withdrawn"] == [
        {"version": "1.0.0", "target": "universal"}
    ]
    # Outsiders: the same 404 as before, and nothing in the public metadata.
    assert client.get("/api/testplace/acme/files", headers=_member(client, "member-out")).status_code == 404
    assert all(blocked.get("packageId") != "acme.files" for blocked in _public_trust_metadata(client)["blockedPackages"])


def test_the_public_report_form_cannot_tell_a_testplace_version_exists(client: TestClient) -> None:
    """R-MED-4: reporting a testplace-only version answers like a missing one."""
    from registry import reports
    from registry.models import Extension

    assert _publish(client, "9.0.0", channel="stable", ident="acme.files").status_code == 201
    assert _publish(client, "9.1.0").status_code == 201
    with _session(client) as session:
        extension = session.exec(select(Extension).where(Extension.identity == "acme.files")).one()
        answers = []
        for version in ("9.1.0", "7.7.7"):
            try:
                reports.create_report(
                    session, extension=extension, member_id="member-out", reason="malware", detail="", version=version
                )
                answers.append("accepted")
            except reports.ReportError as exc:
                answers.append(str(exc))
        assert answers == ["that version does not exist", "that version does not exist"]


def test_a_withdrawal_reaches_every_member_who_ever_held_a_seat(client: TestClient) -> None:
    """The kill switch must not depend on a live seat or a qualified publisher:
    a member whose seat was revoked, who left, or whose publisher was frozen
    still learns a build was withdrawn; nobody else learns anything."""
    assert _publish(client).status_code == 201
    stayed, removed = _member(client, "member-stayed"), _member(client, "member-removed")
    tokens = _invite(client, labels=("a@example.com", "b@example.com"))
    assert _join(client, stayed, tokens[0]).status_code == 200
    assert _join(client, removed, tokens[1]).status_code == 200
    invites = client.get("/api/testplace/acme/files/invites", headers=_publisher()).json()["invites"]
    seat = next(row for row in invites if row["label"] == "b@example.com")
    client.post(f"/api/testplace/acme/files/invites/{seat['id']}/revoke", headers=_publisher())
    assert client.get("/api/testplace/acme/files", headers=removed).status_code == 404

    def withdrawn(member: dict):
        return client.get("/api/testplace/acme/files/withdrawn", headers=member)

    assert withdrawn(removed).json() == {"withdrawn": []}
    revoked = client.post(
        "/api/admin/testplace/acme/files/versions/1.0.0/revoke", json={"reason": "malware"}, headers=_admin()
    )
    assert revoked.status_code == 200, revoked.text
    assert withdrawn(removed).json() == {"withdrawn": [{"version": "1.0.0", "target": "universal"}]}

    # A frozen publisher: every one of its test builds reads as withdrawn, but
    # a removed tester never hears of a build published after their seat ended.
    assert _publish(client, "1.1.0").status_code == 201
    with _session(client) as session:
        publisher = session.exec(select(Publisher).where(Publisher.name == "acme")).one()
        publisher.frozen_at = datetime.now(timezone.utc)
        session.add(publisher)
        session.commit()
    assert {row["version"] for row in withdrawn(stayed).json()["withdrawn"]} == {"1.0.0", "1.1.0"}
    assert {row["version"] for row in withdrawn(removed).json()["withdrawn"]} == {"1.0.0"}

    # Outsiders, anonymous callers and a missing extension: the same answers.
    outsider = withdrawn(_member(client, "member-out"))
    missing = client.get("/api/testplace/acme/nothing/withdrawn", headers=stayed)
    assert (outsider.status_code, outsider.json()) == (missing.status_code, missing.json()) == (404, outsider.json())
    assert client.get("/api/testplace/acme/files/withdrawn").status_code == 401


# -- one channel per version (S8 R3-M2) -----------------------------------
MACHO_ARM64 = (0xFEEDFACF).to_bytes(4, "little") + (0x0100000C).to_bytes(4, "little")
PE_X64 = b"MZ" + b"\0" * 0x3A + (0x40).to_bytes(4, "little") + b"PE\0\0" + (0x8664).to_bytes(2, "little")


def _publish_native(client: TestClient, target: str, *, channel: str, version: str = "1.0.0"):
    manifest = contract_manifest("backend-only-skills.json")
    manifest.update(id="acme.tool", publisher="acme", version=version)
    data = MACHO_ARM64 if target.startswith("darwin") else PE_X64
    backend_name = manifest["backend"]["entry"] + ".exe" if data.startswith(b"MZ") else None
    return client.post(
        "/api/publish",
        params={"channel": channel, "target": target},
        headers=_publisher(),
        files={"package": ("pkg.vsix", build_v2_package(manifest, backend_data=data, backend_name=backend_name), "application/zip")},
    )


def _mixed_legacy_version(client: TestClient, monkeypatch) -> None:
    """A 1.0.0 with a testplace and a stable artifact, as an older Registry allowed."""
    from registry import app as app_module

    assert _publish_native(client, "darwin-arm64", channel="testplace").status_code == 201
    monkeypatch.setattr(app_module, "_publish_conflict", lambda *args, **kwargs: None)
    stable = _publish_native(client, "win32-x64", channel="stable")
    assert stable.status_code == 201, stable.text
    monkeypatch.undo()


def _rows(client: TestClient) -> dict[str, ExtensionVersion]:
    with _session(client) as session:
        return {row.target: row for row in session.exec(select(ExtensionVersion).where(ExtensionVersion.version == "1.0.0")).all()}


def test_one_version_number_cannot_hold_a_testplace_and_a_stable_build(client: TestClient) -> None:
    assert _publish_native(client, "darwin-arm64", channel="testplace").status_code == 201
    stable = _publish_native(client, "win32-x64", channel="stable")
    assert stable.status_code == 409 and "testplace" in stable.json()["detail"]
    # And the other way round.
    assert _publish_native(client, "win32-x64", channel="stable", version="2.0.0").status_code == 201
    test_build = _publish_native(client, "darwin-arm64", channel="testplace", version="2.0.0")
    assert test_build.status_code == 409


def test_revoking_a_testplace_build_never_touches_a_public_version(client: TestClient, monkeypatch) -> None:
    _mixed_legacy_version(client, monkeypatch)
    resp = client.post("/api/testplace/acme/tool/versions/1.0.0/revoke", json={"reason": "crash"}, headers=_publisher())
    assert resp.status_code == 200, resp.text
    rows = _rows(client)
    assert rows["darwin-arm64"].yanked is True
    assert rows["win32-x64"].yanked is False
    detail = client.get("/api/extensions/acme/tool").json()
    assert [v["version"] for v in detail["versions"]] == ["1.0.0"]
    assert all(blocked.get("packageId") != "acme.tool" for blocked in detail["trust_metadata"]["blockedPackages"])


def test_a_yank_acts_on_one_channel_only(client: TestClient, monkeypatch) -> None:
    _mixed_legacy_version(client, monkeypatch)
    public = client.post("/api/extensions/acme/tool/1.0.0/yank", headers=_publisher())
    assert public.status_code == 200, public.text
    assert public.json()["targets"] == ["win32-x64"]
    rows = _rows(client)
    assert (rows["win32-x64"].yanked, rows["darwin-arm64"].yanked) == (True, False)
    test_build = client.post("/api/extensions/acme/tool/1.0.0/yank", params={"channel": "testplace"}, headers=_publisher())
    assert test_build.status_code == 200 and test_build.json()["targets"] == ["darwin-arm64"]
    assert _rows(client)["darwin-arm64"].yanked is True


# -- R-HIGH-1: promotion goes through the stable review ----------------------
def test_promotion_of_a_native_backend_build_needs_the_stable_review_confirmation(client: TestClient) -> None:
    from tests.test_native_backend import _backend_manifest, _backend_package

    assert client.post(
        "/api/publishers", json={"name": "acme-tools", "token": "tok-" + "acme-tools"}, headers=_admin()
    ).status_code == 201
    with _session(client) as session:
        publisher = session.exec(select(Publisher).where(Publisher.name == "acme-tools")).one()
        publisher.review_required = True
        publisher.native_backend_allowed = True
        publisher.verified_domain = "acme-tools.dev"
        publisher.domain_verified_at = datetime.now(timezone.utc)
        session.add(publisher)
        session.commit()
    tools = {"Authorization": "Bearer tok-" + "acme-tools"}
    resp = client.post(
        "/api/publish",
        params={"channel": "testplace", "target": "darwin-arm64"},
        headers=tools,
        files={"package": ("pkg.vsix", _backend_package(_backend_manifest()), "application/zip")},
    )
    assert resp.status_code == 201, resp.text
    digest = resp.json()["package_digest"]
    version = resp.json()["version"]
    path = f"/api/admin/testplace/promotions/acme-tools/indexer/{version}/decision"
    assert client.post(f"/api/testplace/acme-tools/indexer/versions/{version}/promote", headers=tools).status_code == 200

    # Same rule as a pending stable submission: a native backend is approved
    # only once the reviewer confirms every target's executable was inspected.
    refused = client.post(path, json={"approve": True, "artifacts": [digest]}, headers=_admin())
    assert refused.status_code == 409, refused.text
    assert "native backend" in refused.json()["detail"]["message"]
    assert client.get("/api/extensions/acme-tools/indexer").status_code == 404

    approved = client.post(
        path, json={"approve": True, "artifacts": [digest], "inspected_native_backend": True}, headers=_admin()
    )
    assert approved.status_code == 200, approved.text
    with _session(client) as session:
        row = session.exec(select(ExtensionVersion).where(ExtensionVersion.package_digest == digest)).one()
    assert row.reviewed_by == "admin-token" and row.reviewed_at is not None
    # Rescanned at approval, like review.approve: the signed report is today's.
    assert row.scan is not None and row.scan["artifactDigest"] == digest


def test_promotion_rechecks_the_blocklist_and_records_the_review(client: TestClient) -> None:
    assert _publish(client).status_code == 201
    client.post("/api/testplace/acme/files/versions/1.0.0/promote", headers=_publisher())
    digest = client.get("/api/admin/testplace/promotions", headers=_admin()).json()["promotions"][0]["artifacts"][0]
    resp = client.post(
        "/api/admin/testplace/promotions/acme/files/1.0.0/decision",
        json={"approve": True, "artifacts": [digest]},
        headers=_admin(),
    )
    assert resp.status_code == 200, resp.text
    with _session(client) as session:
        row = session.exec(select(ExtensionVersion)).one()
    assert row.reviewed_by == "admin-token"


# -- S8 round 3 -------------------------------------------------------------
def test_approving_a_stable_version_lists_it_even_when_a_newer_testplace_build_exists(client: TestClient) -> None:
    """R3-M1: a testplace build is not public, so it must not count as the
    newer version that keeps a reviewed stable one from setting the listing."""
    with _session(client) as session:
        publisher = session.exec(select(Publisher).where(Publisher.name == "acme")).one()
        publisher.review_required = True
        session.add(publisher)
        session.commit()

    def package(version: str, name: str) -> bytes:
        manifest = copy.deepcopy(contract_manifest())
        manifest.update(id="acme.files", publisher="acme", version=version, name=name)
        return build_v2_package(manifest)

    secret = client.post(
        "/api/publish",
        params={"channel": "testplace"},
        headers=_publisher(),
        files={"package": ("pkg.vsix", package("2.0.0", "Secret Next Build"), "application/zip")},
    )
    assert secret.status_code == 201, secret.text
    stable = client.post(
        "/api/publish",
        headers=_publisher(),
        files={"package": ("pkg.vsix", package("1.0.0", "Files"), "application/zip")},
    )
    assert stable.status_code == 201 and stable.json()["review_status"] == "pending", stable.text
    approved = client.post(
        "/api/admin/review/acme/files/1.0.0/approve",
        json={"artifacts": [stable.json()["package_digest"]]},
        headers=_admin(),
    )
    assert approved.status_code == 200, approved.text

    detail = client.get("/api/extensions/acme/files").json()
    assert detail["display_name"] == "Files"
    assert "Secret Next Build" not in client.get("/api/extensions").text


def test_promotion_is_refused_while_the_version_is_blocked(client: TestClient) -> None:
    """R3-L1: the shared review checks include the blocklist."""
    assert _publish(client).status_code == 201
    client.post("/api/testplace/acme/files/versions/1.0.0/promote", headers=_publisher())
    digest = client.get("/api/admin/testplace/promotions", headers=_admin()).json()["promotions"][0]["artifacts"][0]
    with _session(client) as session:
        blocklist.add_entry(session, kind="package", value="acme.files@1.0.0", reason="malware", created_by="admin")
    resp = client.post(
        "/api/admin/testplace/promotions/acme/files/1.0.0/decision",
        json={"approve": True, "artifacts": [digest]},
        headers=_admin(),
    )
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"]["code"] == "REVIEW_REFUSED"
    assert client.get("/api/extensions/acme/files").status_code == 404
    with _session(client) as session:
        row = session.exec(select(ExtensionVersion)).one()
    assert row.promotion_status == "requested" and row.channel == "testplace"

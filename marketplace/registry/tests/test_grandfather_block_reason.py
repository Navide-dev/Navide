"""Grandfathered namespaces (decision d4(a), migration 13) and digest block
reasons in the local-install trust document (decision d5)."""

from __future__ import annotations

import hashlib
import sqlite3
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from sqlmodel import Session, select

from registry import qualification
from registry.db import create_db_engine
from registry.migrations import MIGRATIONS, applied_migrations, run_migrations
from registry.models import BlocklistEntry, DeveloperQualification, Publisher
from tests.phase2_helpers import ADMIN_HEADERS, csrf_of, make_client, cloud_settings, package_for, publish, sign_in
from tests.test_developer_qualification import (
    MEMBER,
    account_token,
    admin,
    apply,
    approved_publisher,
    audit_rows,
    bearer,
)


@pytest.fixture()
def client(tmp_path):
    return make_client(cloud_settings(tmp_path))


def _engine(client):
    return client.app.state.registry.engine


def _now() -> datetime:
    return datetime.now(timezone.utc)


def grandfathered_publisher(client, *, until: datetime, namespace: str = "mei-tools") -> str:
    """A namespace as migration 13 leaves one claimed before qualification
    existed: no qualification row, a grace period ending at `until`."""
    token = approved_publisher(client, namespace)
    with Session(_engine(client)) as session:
        session.delete(session.get(DeveloperQualification, MEMBER))
        publisher = session.exec(select(Publisher).where(Publisher.name == namespace)).one()
        publisher.grandfather_until = until
        session.add(publisher)
        session.commit()
    return token


def _publisher(client, namespace: str = "mei-tools") -> Publisher:
    with Session(_engine(client)) as session:
        return session.exec(select(Publisher).where(Publisher.name == namespace)).one()


def _sweep(client) -> None:
    client.app.state.registry.grandfather_swept_at = None
    client.get("/api/trust/local-install")


def _blocked(client) -> dict[str, str]:
    document = client.get("/api/trust/local-install").json()["local_trust_metadata"]
    return {entry["digest"]: entry["reason"] for entry in document["blockedDigests"]}


# -- migration 13 ---------------------------------------------------------------
def test_migration_13_grandfathers_self_claimed_namespaces(tmp_path: Path) -> None:
    path = tmp_path / "registry.db"
    engine = create_db_engine(path)
    # Back to the schema before step 13, holding namespaces claimed earlier.
    with sqlite3.connect(path) as db:
        db.execute("ALTER TABLE publisher DROP COLUMN grandfather_until")
        db.execute("ALTER TABLE publisher DROP COLUMN grandfather_paused_at")
        db.execute("ALTER TABLE blocklist_entry DROP COLUMN digest_reason")
        db.execute("DELETE FROM schema_migrations WHERE version = 13")
        for pid, name, member in (
            (1, "official", None),
            (2, "never-applied", "mem-a"),
            (3, "in-review", "mem-b"),
            (4, "approved-one", "mem-c"),
            (5, "rejected-one", "mem-d"),
        ):
            db.execute(
                "INSERT INTO publisher (id, name, navide_member_id, review_required, native_backend_allowed, created_at) "
                "VALUES (?, ?, ?, 1, 0, '2026-09-01 00:00:00')",
                (pid, name, member),
            )
        for member, status in (("mem-b", "pending"), ("mem-c", "approved"), ("mem-d", "rejected")):
            db.execute(
                "INSERT INTO developer_qualification (navide_member_id, status, submitted_at) "
                "VALUES (?, ?, '2026-10-01 00:00:00')",
                (member, status),
            )
        db.execute(
            "INSERT INTO blocklist_entry (kind, value, reason, created_at) "
            "VALUES ('digest', ?, 'malware', '2026-10-01 00:00:00')",
            ("c" * 64,),
        )
        db.execute(
            "INSERT INTO blocklist_entry (kind, value, reason, created_at) "
            "VALUES ('package', 'x.y', 'spam', '2026-10-01 00:00:00')"
        )

    before = _now()
    assert run_migrations(engine) == [13]
    assert applied_migrations(engine)[13] == "grandfather-block-reason"
    with sqlite3.connect(path) as db:
        rows = {
            name: (until, paused)
            for name, until, paused in db.execute(
                "SELECT name, grandfather_until, grandfather_paused_at FROM publisher"
            )
        }
        reasons = dict(db.execute("SELECT kind, digest_reason FROM blocklist_entry").fetchall())
    assert rows["official"] == (None, None)
    assert rows["approved-one"] == (None, None)
    for name in ("never-applied", "in-review", "rejected-one"):
        until = datetime.fromisoformat(rows[name][0]).replace(tzinfo=timezone.utc)
        assert timedelta(days=29, hours=23) < until - before <= timedelta(days=30, minutes=1)
    assert rows["never-applied"][1] is None and rows["rejected-one"][1] is None
    assert rows["in-review"][1] is not None
    assert reasons == {"digest": "admin", "package": None}

    # Running the step again (a half-recorded run) changes nothing.
    step = next(step for number, _, step in MIGRATIONS if number == 13)
    with sqlite3.connect(path) as db:
        step(db)
        assert {
            name: (until, paused)
            for name, until, paused in db.execute(
                "SELECT name, grandfather_until, grandfather_paused_at FROM publisher"
            )
        } == rows
    assert run_migrations(engine) == []


def test_migration_13_on_a_fresh_database(tmp_path: Path) -> None:
    path = tmp_path / "registry.db"
    engine = create_db_engine(path)
    assert applied_migrations(engine)[13] == "grandfather-block-reason"
    step = next(step for number, _, step in MIGRATIONS if number == 13)
    with sqlite3.connect(path) as db:
        step(db)
    assert run_migrations(engine) == []


# -- d4(a): the grace period ------------------------------------------------------
def test_a_grandfathered_namespace_keeps_publishing_and_is_told_the_deadline(client):
    until = _now() + timedelta(days=20)
    token = grandfathered_publisher(client, until=until)
    resp = publish(client, token, package_for("mei-tools", "hello"))
    assert resp.status_code == 201, resp.text

    me = client.get("/api/publisher/me", headers=bearer(token)).json()
    assert me["qualification"] == "none"
    grace = me["grandfather"]
    assert grace["paused"] is False and grace["remind"] is False and grace["expired"] is False
    assert grace["days_left"] == 20
    page = client.get("/publisher/mei-tools").text
    assert "claimed before developer qualification existed" in page
    assert "Apply now" not in page


def test_the_last_seven_days_remind_the_owner(client):
    token = grandfathered_publisher(client, until=_now() + timedelta(days=5, hours=1))
    grace = client.get("/api/publisher/me", headers=bearer(token)).json()["grandfather"]
    assert grace["remind"] is True and grace["days_left"] == 6
    page = client.get("/publisher/mei-tools").text
    assert "Apply now" in page and 'role="alert"' in page


def test_a_pending_application_pauses_the_period_and_a_rejection_resumes_it(client):
    token = grandfathered_publisher(client, until=_now() + timedelta(days=3))
    assert apply(client, account_token(client)).status_code == 201
    assert _publisher(client).grandfather_paused_at is not None
    # Ten days in review: the original deadline passes, publishing goes on.
    with Session(_engine(client)) as session:
        publisher = session.exec(select(Publisher).where(Publisher.name == "mei-tools")).one()
        publisher.grandfather_until = _now() - timedelta(days=7)
        publisher.grandfather_paused_at = _now() - timedelta(days=10)
        session.add(publisher)
        session.commit()
    assert publish(client, token, package_for("mei-tools", "hello")).status_code == 201
    grace = client.get("/api/publisher/me", headers=bearer(token)).json()["grandfather"]
    assert grace["paused"] is True and grace["days_left"] == 3
    _sweep(client)
    assert _publisher(client).frozen_at is None
    assert "in review" in client.get("/publisher/mei-tools").text

    # A rejection resumes the period with the three days it had left.
    assert admin(client, "reject", reason="Name does not match.").status_code == 200
    publisher = _publisher(client)
    assert publisher.grandfather_paused_at is None
    left = publisher.grandfather_until.replace(tzinfo=timezone.utc) - _now()
    assert timedelta(days=2, hours=23) < left <= timedelta(days=3)
    assert publish(client, token, package_for("mei-tools", "hello", version="1.1.0")).status_code == 201


def test_an_expired_period_refuses_at_once_and_the_sweep_reclaims_the_namespace(client):
    token = grandfathered_publisher(client, until=_now() + timedelta(days=1))
    data = package_for("mei-tools", "hello")
    assert publish(client, token, data).status_code == 201
    account = account_token(client)
    with Session(_engine(client)) as session:
        publisher = session.exec(select(Publisher).where(Publisher.name == "mei-tools")).one()
        publisher.grandfather_until = _now() - timedelta(minutes=1)
        session.add(publisher)
        session.commit()

    # Refused before any sweep ran.
    client.app.state.registry.grandfather_swept_at = 10**12
    resp = publish(client, token, package_for("mei-tools", "hello", version="1.1.0"))
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "QUALIFICATION_REQUIRED"
    assert "grace period" in resp.json()["detail"]["message"]
    assert _publisher(client).frozen_at is None

    _sweep(client)
    publisher = _publisher(client)
    assert publisher.frozen_at is not None
    assert "30-day grace period" in publisher.frozen_reason
    resp = publish(client, token, package_for("mei-tools", "hello", version="1.2.0"))
    assert resp.status_code == 401 and resp.json()["detail"]["code"] == "TOKEN_REVOKED"
    detail = client.get("/api/extensions/mei-tools/hello")
    assert detail.status_code == 404 or all(v["yanked"] for v in detail.json()["versions"])
    assert _blocked(client) == {hashlib.sha256(data).hexdigest(): "qualification-revoked"}
    rows = audit_rows(client)
    reclaim = next(r for r in rows if r["action"] == "namespace.reclaim")
    assert reclaim["actor"] == "system:grandfather-expired"
    assert reclaim["target"] == f"member:{MEMBER}"
    assert ("namespace.freeze", "system:grandfather-expired") in {(r["action"], r["actor"]) for r in rows}
    # The owner is told why, on the dashboard.
    page = client.get("/publisher/mei-tools").text
    assert "This namespace was frozen on" in page
    assert "30-day grace period" in page and "qualification-revoked" in page
    assert "claim a new namespace" in page
    # ...and through its account token, which outlives the publisher token.
    mine = client.get("/api/developer/me/application", headers=bearer(account)).json()
    assert [n["namespace"] for n in mine["namespaces"]] == ["mei-tools"]
    assert "30-day grace period" in mine["namespaces"][0]["frozen_reason"]
    assert mine["namespaces"][0]["frozen_at"] is not None
    # Another account sees none of it.
    sign_in(client, "mem-other", approved=False)
    other = client.get("/api/developer/me/application", headers=bearer(account_token(client))).json()
    assert other["namespaces"] == []
    # The account may still apply; it keeps its account token.
    assert apply(client, account).status_code == 201
    # A second sweep finds nothing more to reclaim.
    with Session(_engine(client)) as session:
        assert qualification.reclaim_expired(session) == []


def test_an_application_filed_after_the_deadline_does_not_revive_the_namespace(client):
    """S8 R-MED-2: applying once the grace period is over must not bring the
    namespace back, and the sweep still reclaims it."""
    token = grandfathered_publisher(client, until=_now() - timedelta(days=5))
    client.app.state.registry.grandfather_swept_at = 10**12  # no sweep yet
    assert apply(client, account_token(client)).status_code == 201
    assert _publisher(client).grandfather_paused_at is None
    resp = publish(client, token, package_for("mei-tools", "hello"))
    assert resp.status_code == 403 and resp.json()["detail"]["code"] == "QUALIFICATION_REQUIRED"
    _sweep(client)
    assert _publisher(client).frozen_at is not None


def test_reject_and_reapply_cannot_extend_the_grace_period_forever(client):
    """S8 R-MED-2: only the first application filed inside the period pauses
    it; after a rejection the clock runs on through every re-application."""
    token = grandfathered_publisher(client, until=_now() + timedelta(days=3))
    account = account_token(client)
    assert apply(client, account).status_code == 201
    assert admin(client, "reject", reason="Name does not match.").status_code == 200
    assert apply(client, account).status_code == 201
    assert _publisher(client).grandfather_paused_at is None
    # The resumed period runs out while the second application waits.
    with Session(_engine(client)) as session:
        publisher = session.exec(select(Publisher).where(Publisher.name == "mei-tools")).one()
        publisher.grandfather_until = _now() - timedelta(minutes=1)
        session.add(publisher)
        session.commit()
    client.app.state.registry.grandfather_swept_at = 10**12
    resp = publish(client, token, package_for("mei-tools", "hello"))
    assert resp.status_code == 403 and resp.json()["detail"]["code"] == "QUALIFICATION_REQUIRED"
    _sweep(client)
    publisher = _publisher(client)
    assert publisher.frozen_at is not None
    assert "30-day grace period" in publisher.frozen_reason
    # Approving the late application later gives the namespace back only
    # through a new claim; the reclaimed one stays frozen.
    assert admin(client, "approve").status_code == 200
    assert _publisher(client).frozen_at is not None


def test_an_approved_owner_is_never_reclaimed(client):
    token = approved_publisher(client)
    with Session(_engine(client)) as session:
        publisher = session.exec(select(Publisher).where(Publisher.name == "mei-tools")).one()
        publisher.grandfather_until = _now() - timedelta(days=1)
        session.add(publisher)
        session.commit()
    _sweep(client)
    assert _publisher(client).frozen_at is None
    assert client.get("/api/publisher/me", headers=bearer(token)).json()["grandfather"] is None


# -- d5: digest reasons -------------------------------------------------------------
def _block(client, digest: str, **extra):
    return client.post(
        "/api/admin/blocklist",
        json={"kind": "digest", "value": digest, "reason": "x", **extra},
        headers=ADMIN_HEADERS,
    )


def test_each_blocked_digest_carries_its_reason(client):
    for letter, reason in zip("abcd", ("security", "admin", "qualification-revoked", "developer-withdrawn")):
        resp = _block(client, letter * 64, digest_reason=reason)
        assert resp.status_code == 201 and resp.json()["digest_reason"] == reason
    assert _block(client, "e" * 64).json()["digest_reason"] == "admin"
    assert _blocked(client) == {
        "a" * 64: "security",
        "b" * 64: "admin",
        "c" * 64: "qualification-revoked",
        "d" * 64: "developer-withdrawn",
        "e" * 64: "admin",
    }
    document = client.get("/api/trust/local-install").json()["local_trust_metadata"]
    assert all(set(entry) == {"digest", "reason"} for entry in document["blockedDigests"])


def test_an_unknown_digest_reason_or_one_on_another_kind_is_refused(client):
    assert _block(client, "a" * 64, digest_reason="because").status_code == 400
    resp = client.post(
        "/api/admin/blocklist",
        json={"kind": "package", "value": "x.y", "reason": "x", "digest_reason": "security"},
        headers=ADMIN_HEADERS,
    )
    assert resp.status_code == 400


def test_the_admin_form_takes_a_digest_reason(client):
    from tests.phase2_helpers import sign_in
    from tests.phase2_helpers import ADMIN_MEMBER

    sign_in(client, ADMIN_MEMBER)
    csrf = csrf_of(client, "/admin/blocklist")
    resp = client.post(
        "/admin/blocklist",
        data={"kind": "digest", "value": "f" * 64, "reason": "malware", "digest_reason": "security", "csrf": csrf},
    )
    assert resp.status_code == 303, resp.text
    assert _blocked(client) == {"f" * 64: "security"}
    assert "security" in client.get("/admin/blocklist").text


def test_revocation_blocks_every_version_digest_as_qualification_revoked(client):
    token = approved_publisher(client)
    first = package_for("mei-tools", "hello")
    second = package_for("mei-tools", "hello", version="1.1.0")
    assert publish(client, token, first).status_code == 201
    assert publish(client, token, second).status_code == 201
    assert client.post("/api/extensions/mei-tools/hello/1.0.0/yank", headers=bearer(token)).status_code == 200
    # A digest an admin already blocked for security keeps that reason.
    _block(client, hashlib.sha256(second).hexdigest(), digest_reason="security")

    assert admin(client, "revoke", reason="Impersonated another company.").status_code == 200
    assert _blocked(client) == {
        hashlib.sha256(first).hexdigest(): "qualification-revoked",
        hashlib.sha256(second).hexdigest(): "security",
    }
    with Session(_engine(client)) as session:
        entry = session.exec(
            select(BlocklistEntry).where(BlocklistEntry.value == hashlib.sha256(first).hexdigest())
        ).one()
    # The public reason does not repeat the admin's private revocation note.
    assert entry.reason == "Developer qualification revoked"
    assert entry.created_by == "system:qualification-revoked"
    revoke = next(r for r in audit_rows(client) if r["action"] == "qualification.revoke")
    assert revoke["detail"]["digests_blocked"] == 1

"""A namespace frozen when its owner's qualification was revoked keeps its
name for that account but no longer counts toward MAX_NAMESPACES_PER_ACCOUNT."""

from __future__ import annotations

import pytest
from sqlmodel import Session, select

from registry import qualification, self_service
from registry.models import DeveloperQualification, Publisher
from tests.phase2_helpers import claim, cloud_settings, make_client, sign_in

NAMES = ("alpha-one", "bravo-two", "charlie-three")


@pytest.fixture()
def client(tmp_path):
    return make_client(cloud_settings(tmp_path))


def _engine(client):
    return client.app.state.registry.engine


def _revoke_and_reapprove(client, member_id: str) -> None:
    with Session(_engine(client)) as session:
        qualification.revoke(session, member_id, actor="admin-token", reason="Test revocation.")
        row = session.get(DeveloperQualification, member_id)
        row.status = qualification.APPROVED
        session.add(row)
        session.commit()


def _claim_three_then_revoke(client, member_id: str = "mem-1") -> None:
    sign_in(client, member_id)
    for name in NAMES:
        assert claim(client, name).status_code == 303
    _revoke_and_reapprove(client, member_id)


def test_after_all_three_are_revoked_the_account_can_claim_a_new_name(client):
    _claim_three_then_revoke(client)
    assert "Claim a namespace" in client.get("/publisher").text
    assert claim(client, "delta-four").status_code == 303
    with Session(_engine(client)) as session:
        owned = session.exec(select(Publisher).where(Publisher.navide_member_id == "mem-1")).all()
        assert {p.name for p in owned} == {*NAMES, "delta-four"}
        assert {p.name for p in owned if p.frozen_at is None} == {"delta-four"}


def test_a_revoked_name_stays_with_its_account(client):
    _claim_three_then_revoke(client)
    sign_in(client, "mem-2")
    resp = claim(client, "alpha-one")
    assert resp.status_code == 409 and "already taken" in resp.text
    with Session(_engine(client)) as session:
        owner = session.exec(select(Publisher).where(Publisher.name == "alpha-one")).one()
        assert owner.navide_member_id == "mem-1" and owner.frozen_at is not None


def test_check_claim_and_the_insert_count_the_same_namespaces(client, monkeypatch):
    """Three frozen namespaces plus active ones: the pre-check and the INSERT
    ... SELECT must agree at every count, with the pre-check bypassed for the
    INSERT side so a disagreement cannot hide behind it."""
    _claim_three_then_revoke(client)
    real_check = self_service.check_claim
    monkeypatch.setattr(self_service, "check_claim", lambda *a, **k: self_service.ClaimVerdict(True, ""))
    with Session(_engine(client)) as session:
        for index, name in enumerate(("delta-four", "echo-five", "foxtrot-six", "golf-seven")):
            allowed = real_check(session, "mem-1", name).ok
            try:
                self_service.claim_namespace(session, member_id="mem-1", display_name="x", namespace=name)
                inserted = True
            except self_service.SelfServiceError:
                inserted = False
            assert allowed == inserted == (index < self_service.MAX_NAMESPACES_PER_ACCOUNT), name

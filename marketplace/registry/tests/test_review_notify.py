"""Admin email for new pending reviews (review_notify.py): the four triggers,
the message fields, the off switch and failure isolation."""
from __future__ import annotations

import copy
import time
from dataclasses import replace
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from registry import review_notify
from registry.app import create_app
from registry.config import VERIFIER_ACCEPTING, Settings
from registry.models import Publisher
from tests.fixtures import build_v2_package, contract_manifest
from tests.phase2_helpers import FakeDns, cloud_settings, sign_in
from tests.test_developer_qualification import account_token, apply

ADMIN = "notify-admin"  # noqa: S105 - test fixture token
PUBLISHER_TOKEN = "tok-" + "acme-notify"
TO = "admin@example.test"
FROM = "registry-noreply@example.test"
NOTIFY = {"review_notify_to": TO, "review_notify_from": FROM, "ses_region": "ap-northeast-1"}


class Outbox:
    def __init__(self) -> None:
        self.sent: list[tuple[str, str, str, str]] = []

    def __call__(self, sender: str, to: str, subject: str, body: str) -> None:
        self.sent.append((sender, to, subject, body))

    def wait(self, count: int) -> list[tuple[str, str, str, str]]:
        deadline = time.monotonic() + 5
        while len(self.sent) < count and time.monotonic() < deadline:
            time.sleep(0.01)
        return self.sent


def _client(settings: Settings, outbox: Outbox) -> TestClient:
    client = TestClient(create_app(settings, review_send=outbox))
    resp = client.post(
        "/api/publishers", json={"name": "acme", "token": PUBLISHER_TOKEN}, headers={"X-Admin-Token": ADMIN}
    )
    assert resp.status_code == 201, resp.text
    return client


def _settings(tmp_path, **overrides) -> Settings:
    return Settings(
        data_dir=tmp_path,
        verifier_kind=VERIFIER_ACCEPTING,
        require_signature=False,
        require_auth=False,
        admin_token=ADMIN,
        **{**NOTIFY, **overrides},
    )


def _publish(client: TestClient, version: str = "1.0.0", channel: str | None = "testplace"):
    manifest = copy.deepcopy(contract_manifest())
    manifest.update(id="acme.files", publisher="acme", version=version)
    return client.post(
        "/api/publish",
        params={"channel": channel} if channel else {},
        headers={"Authorization": f"Bearer {PUBLISHER_TOKEN}"},
        files={"package": ("pkg.vsix", build_v2_package(manifest), "application/zip")},
    )


def test_pending_version_emails_the_admin(tmp_path) -> None:
    outbox = Outbox()
    client = _client(_settings(tmp_path), outbox)
    with Session(client.app.state.registry.engine) as session:
        publisher = session.exec(select(Publisher).where(Publisher.name == "acme")).one()
        publisher.review_required = True
        session.add(publisher)
        session.commit()
    assert _publish(client, channel=None).status_code == 201
    [(sender, to, subject, body)] = outbox.wait(1)
    assert (sender, to) == (FROM, TO)
    assert subject.startswith("[Navide Registry] Pending review: listing version acme.files@1.0.0")
    assert "Review: /admin/review" in body
    assert "UTC" in body and "Taipei" in body


def test_auto_approved_version_sends_nothing(tmp_path) -> None:
    outbox = Outbox()
    client = _client(_settings(tmp_path), outbox)
    assert _publish(client, channel=None).status_code == 201
    time.sleep(0.2)
    assert outbox.sent == []


def test_testplace_code_and_promotion_email_the_admin(tmp_path) -> None:
    outbox = Outbox()
    client = _client(_settings(tmp_path), outbox)
    auth = {"Authorization": f"Bearer {PUBLISHER_TOKEN}"}
    assert _publish(client).status_code == 201
    resp = client.post("/api/testplace/acme/files/codes", json={"max_testers": 5}, headers=auth)
    assert resp.status_code == 201, resp.text
    assert outbox.wait(1)[0][2] == "[Navide Registry] Pending review: Testplace public code acme.files"
    resp = client.post("/api/testplace/acme/files/versions/1.0.0/promote", headers=auth)
    assert resp.status_code == 200, resp.text
    subject, body = outbox.wait(2)[1][2:]
    assert subject == "[Navide Registry] Pending review: Testplace promotion acme.files@1.0.0"
    assert "Review: /admin/testplace" in body


def test_developer_application_emails_the_admin_without_personal_data(tmp_path) -> None:
    outbox = Outbox()
    settings = replace(cloud_settings(tmp_path), **NOTIFY)
    app = create_app(settings, txt_resolver=FakeDns(), review_send=outbox)
    client = TestClient(app, base_url="https://testserver", follow_redirects=False)
    sign_in(client, "mem-dev", approved=False)
    assert apply(client, account_token(client)).status_code == 201
    [(_, _, subject, body)] = outbox.wait(1)
    assert subject.startswith("[Navide Registry] Pending review: developer application")
    for private in ("Lin Mei", "mei@example.test", "mem-dev", "Mei Tools"):
        assert private not in subject + body
    assert f"Review: {settings.developer_origin or settings.root_path}/admin/developers" in body


def test_send_failure_is_logged_and_the_submission_still_succeeds(tmp_path, caplog) -> None:
    def broken(*_args) -> None:
        raise RuntimeError("ses down")

    client = TestClient(create_app(_settings(tmp_path), review_send=broken))
    client.post("/api/publishers", json={"name": "acme", "token": PUBLISHER_TOKEN}, headers={"X-Admin-Token": ADMIN})
    assert _publish(client).status_code == 201
    resp = client.post(
        "/api/testplace/acme/files/codes", json={"max_testers": 5}, headers={"Authorization": f"Bearer {PUBLISHER_TOKEN}"}
    )
    assert resp.status_code == 201
    notifier = client.app.state.registry.review_notifier
    with caplog.at_level("WARNING", logger="registry.review_notify"):
        assert notifier.send_now(review_notify.TESTPLACE_CODE, "acme.files") is False
    assert "kind=testplace_code item=acme.files error=RuntimeError" in caplog.text


def test_unset_means_off(tmp_path) -> None:
    settings = _settings(tmp_path, review_notify_to=None, review_notify_from=None, ses_region=None)
    assert create_app(settings).state.registry.review_notifier is None


def test_the_three_settings_go_together(tmp_path) -> None:
    with pytest.raises(ValueError, match="set together"):
        _settings(tmp_path, ses_region=None)


def test_message_uses_the_console_host_for_the_admin_link() -> None:
    notifier = review_notify.ReviewNotifier(
        to=TO, sender_address=FROM, admin_base="https://developers.example.test", send=Outbox()
    )
    at = datetime(2026, 11, 25, 16, 5, tzinfo=timezone.utc)
    subject, body = notifier.message(review_notify.VERSION, "acme.files@1.0.0 (universal)", at)
    assert subject == "[Navide Registry] Pending review: listing version acme.files@1.0.0 (universal)"
    assert "Submitted: 2026-11-25 16:05 UTC (2026-11-26 00:05 Taipei)" in body
    assert "Review: https://developers.example.test/admin/review" in body


def test_item_text_cannot_add_lines_to_the_email() -> None:
    notifier = review_notify.ReviewNotifier(to=TO, sender_address=FROM, admin_base="", send=Outbox())
    subject, body = notifier.message(review_notify.VERSION, "a\r\nBcc: x@example.test", None)
    assert "\n" not in subject and "\r" not in subject
    assert "Item: aBcc: x@example.test" in body


def test_the_same_item_is_emailed_once_an_hour() -> None:
    outbox = Outbox()
    notifier = review_notify.ReviewNotifier(to=TO, sender_address=FROM, admin_base="", send=outbox)
    assert notifier.pending(review_notify.TESTPLACE_CODE, "acme.files") is True
    assert notifier.pending(review_notify.TESTPLACE_CODE, "acme.files") is False
    assert notifier.pending(review_notify.PROMOTION, "acme.files@1.0.0") is True
    assert len(outbox.wait(2)) == 2
    time.sleep(0.1)
    assert len(outbox.sent) == 2


def test_every_developer_application_is_emailed() -> None:
    outbox = Outbox()
    notifier = review_notify.ReviewNotifier(to=TO, sender_address=FROM, admin_base="", send=outbox)
    assert notifier.pending(review_notify.DEVELOPER, "via web") is True
    assert notifier.pending(review_notify.DEVELOPER, "via web") is True
    assert len(outbox.wait(2)) == 2

"""The third-party developer entry: the storefront's Build card and footer,
the console's open /developer page, /publish's seven steps and "you are on
step N", the dashboard's next-step card and the application page's
expectations. One flow (build-for-navide.md §4) on every page."""

from __future__ import annotations

import pytest
from sqlmodel import Session, select

from registry.models import DeveloperQualification, ExtensionVersion, Publisher
from tests.phase2_helpers import (
    claim,
    cloud_settings,
    make_client,
    new_token,
    package_for,
    publish,
    sign_in,
)

STEPS = (
    "Developer application",
    "Namespace",
    "Signing key",
    "Testplace (optional)",
    "Publish &amp; review",
    "Update",
    "Withdraw",
)
GUIDE = "https://github.com/Navide-dev/Navide/blob/main/docs/en-US/build-for-navide.md"


@pytest.fixture()
def client(tmp_path):
    return make_client(cloud_settings(tmp_path))


def _current_step(html: str) -> str:
    marker = 'aria-current="step"'
    assert html.count(marker) == 1, html
    return html.split(marker, 1)[1].split('class="journey-label">', 1)[1].split("<", 1)[0]


def _set_qualification(client, member_id: str, status: str, reason: str | None = None) -> None:
    with Session(client.app.state.registry.engine) as session:
        session.add(DeveloperQualification(navide_member_id=member_id, status=status, reason=reason))
        session.commit()


def _set_key(client, namespace: str) -> None:
    with Session(client.app.state.registry.engine) as session:
        publisher = session.exec(select(Publisher).where(Publisher.name == namespace)).one()
        publisher.public_key = "registered"
        session.add(publisher)
        session.commit()


def _review(client, status: str, reason: str | None = None) -> None:
    with Session(client.app.state.registry.engine) as session:
        for row in session.exec(select(ExtensionVersion)).all():
            row.review_status = status
            row.review_reason = reason
            session.add(row)
        session.commit()


def _publish_one(client, namespace: str = "acme") -> None:
    resp = publish(client, new_token(client, namespace), package_for(namespace, "hello"))
    assert resp.status_code == 201, resp.text


# -- storefront -----------------------------------------------------------
def test_home_has_the_build_card_and_footer_links(client) -> None:
    html = client.get("/").text
    assert "Build for Navide" in html
    assert 'href="/developer">Start at Navide Developers' in html
    assert "npx navide-plugin init --template vue" in html
    assert "Navide 0.2.39 or later" in html
    assert f'href="{GUIDE}"' in html
    for link in ("/discussions", "/security/policy"):
        assert f'href="https://github.com/Navide-dev/Navide{link}"' in html
    assert 'href="/developer">Build</a>' in html
    assert 'href="/developer">Developers</a>' in html


def test_filtered_home_has_no_build_card(client) -> None:
    assert "build-card" not in client.get("/", params={"q": "git"}).text


# -- /developer -------------------------------------------------------------
def test_developer_landing_is_open_without_signing_in(client) -> None:
    resp = client.get("/developer")
    assert resp.status_code == 200
    html = resp.text
    for step in STEPS:
        assert step in html
    assert 'aria-current="step"' not in html
    assert "What the application needs" in html
    assert "Do this before you sign in" in html
    assert 'href="/login?next=/developer/apply">Sign in to apply' in html
    assert f'href="{GUIDE}#2-what-a-plugin-can-do"' in html
    assert "never which" in html


def test_developer_landing_sends_a_signed_in_developer_to_their_step(client) -> None:
    sign_in(client)
    html = client.get("/developer").text
    assert 'href="/publish">See which step you are on' in html
    assert "Sign in to apply" not in html


def test_developer_landing_without_sign_in_configured(tmp_path) -> None:
    client = make_client(cloud_settings(tmp_path, auth_url=None, auth_secret=None, auth_return_url=None, session_secret=None))
    resp = client.get("/developer")
    assert resp.status_code == 200
    assert "Sign in to apply" not in resp.text
    assert "not enabled" in resp.text


# -- /publish ---------------------------------------------------------------
def test_publish_shows_every_step_and_the_checklist_before_sign_in(client) -> None:
    resp = client.get("/publish")
    assert resp.status_code == 200
    html = resp.text
    assert "journey--muted" in html
    for step in STEPS:
        assert step in html
    assert "Before you publish: the checklist" in html
    assert "403 invalid package signature" in html
    assert 'href="/login?next=/publish">Sign in with Navide Cloud' in html


@pytest.mark.parametrize(
    ("status", "reason", "step", "text"),
    [
        (None, None, "Developer application", "Apply now"),
        ("pending", None, "Developer application", "waiting for review"),
        ("rejected", "name is not real", "Developer application", "rejected: name is not real"),
        ("approved", None, "Namespace", "Claim a namespace"),
    ],
)
def test_publish_says_which_step_before_a_namespace(client, status, reason, step, text) -> None:
    if status is not None:
        _set_qualification(client, "mem-1", status, reason)
    sign_in(client, approved=False)
    html = client.get("/publish").text
    assert _current_step(html) == step
    assert text in html
    assert "Sign in with Navide Cloud" not in html


def test_publish_follows_the_namespace_through_key_publish_and_review(client) -> None:
    sign_in(client)
    claim(client, "acme")
    assert _current_step(client.get("/publish").text) == "Signing key"
    _set_key(client, "acme")
    assert _current_step(client.get("/publish").text) == "Publish &amp; review"
    _publish_one(client)
    html = client.get("/publish").text
    assert _current_step(html) == "Publish &amp; review"
    assert "is in review" in html
    _review(client, "approved")
    assert _current_step(client.get("/publish").text) == "Update"


def test_publisher_home_shows_the_step_without_a_namespace(client) -> None:
    sign_in(client)
    html = client.get("/publisher").text
    assert _current_step(html) == "Namespace"
    assert 'href="/publisher/claim">Claim a namespace' in html


# -- dashboard next step ----------------------------------------------------
def test_dashboard_next_step_card_has_four_states(client) -> None:
    sign_in(client)
    claim(client, "acme")
    html = client.get("/publisher/acme").text
    assert "Next: register your signing key" in html
    _set_key(client, "acme")
    html = client.get("/publisher/acme").text
    assert "Next: publish your first version" in html
    assert "<code>acme.</code>" in html
    _publish_one(client)
    html = client.get("/publisher/acme").text
    assert "In review" in html and "the target is 3 business days" in html
    _review(client, "rejected", "name too similar to navide.git")
    html = client.get("/publisher/acme").text
    assert "next-card--danger" in html
    assert "reason: name too similar to navide.git" in html
    assert "new version number" in html
    _review(client, "approved")
    assert "next-card" not in client.get("/publisher/acme").text


def test_dashboard_says_a_yank_cannot_be_undone(client) -> None:
    sign_in(client)
    claim(client, "acme")
    assert "cannot be undone" in client.get("/publisher/acme").text


# -- /developer/apply ---------------------------------------------------------
def test_apply_page_says_what_review_checks_and_how_long(client) -> None:
    sign_in(client, approved=False)
    html = client.get("/developer/apply").text
    assert "Not checked:" in html
    assert "target: 3 business days" in html


def test_pending_application_lists_what_to_do_while_waiting(client) -> None:
    _set_qualification(client, "mem-1", "pending")
    sign_in(client, approved=False)
    html = client.get("/developer/apply").text
    assert "While you wait" in html
    assert f'href="{GUIDE}#1-five-minutes-to-a-running-plugin"' in html
    assert f'href="{GUIDE}#3-check-it-yourself-before-anyone-else-does"' in html
    assert 'href="/publish">Read the publishing checklist' in html

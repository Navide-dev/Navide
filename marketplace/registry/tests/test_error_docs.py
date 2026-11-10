"""c3 (0.2.40): every 4xx body names its documentation (`doc`), keeping the
existing `detail` and status code; `GET /api/readiness` reports schema,
signing and scanner state without any secret."""
from __future__ import annotations

import sqlite3

from fastapi.testclient import TestClient

from registry.app import create_app
from registry.config import Settings
from registry.error_docs import (
    CAPABILITY_DENIED_DOC,
    OVERVIEW_DOC,
    PUBLISHING_DOC,
    doc_for,
)
from registry.migrations import MIGRATIONS
from tests.test_publish_network_declaration import _publish as publish_with_hosts
from tests.test_publish_network_declaration import client as network_client  # noqa: F401 - fixture


def test_a_404_keeps_detail_and_adds_the_overview_doc(client: TestClient) -> None:
    resp = client.get("/api/extensions/acme/missing")
    assert resp.status_code == 404
    assert resp.json() == {"detail": "extension not found", "doc": OVERVIEW_DOC}


def test_an_unknown_route_and_a_validation_error_carry_doc(client: TestClient) -> None:
    unknown = client.get("/api/no-such-route")
    assert unknown.status_code == 404
    assert unknown.json() == {"detail": "Not Found", "doc": OVERVIEW_DOC}
    invalid = client.get("/api/extensions", params={"limit": "many"})
    assert invalid.status_code == 422
    body = invalid.json()
    assert isinstance(body["detail"], list) and body["detail"]
    assert body["doc"] == OVERVIEW_DOC


def test_testplace_and_publish_refusals_point_at_their_sections(client: TestClient) -> None:
    testplace = client.get("/api/testplace")
    assert testplace.status_code == 401
    assert testplace.json()["doc"] == f"{PUBLISHING_DOC}#testplace"
    assert "detail" in testplace.json()
    bad_channel = client.post(
        "/api/publish", params={"channel": "nightly"}, files={"package": ("p.vsix", b"x", "application/zip")}
    )
    assert bad_channel.status_code == 400
    assert bad_channel.json()["doc"] == f"{PUBLISHING_DOC}#sign-and-publish"


def test_an_undeclared_capability_refusal_is_capability_denied(network_client: TestClient) -> None:  # noqa: F811
    resp = publish_with_hosts(network_client, ["api.github.com"], b"fetch('https://tracker.evil.net/c')")
    assert resp.status_code == 422, resp.text
    body = resp.json()
    assert "tracker.evil.net" in body["detail"]
    assert body["code"] == "CAPABILITY_DENIED"
    assert body["doc"] == CAPABILITY_DENIED_DOC


def test_doc_for_matches_details_before_paths() -> None:
    assert doc_for("/api/publish", "invalid package signature").endswith("#4-publishing-is-the-business-process")
    assert doc_for("/api/publish", "name is 92% similar to acme.x").endswith("#5-review")
    assert doc_for("/api/extensions/a/b/1.0.0/yank", "x").endswith("#8-yank-a-version")
    assert doc_for("/api/publishers", "x").endswith("#sign-in-and-claim-a-namespace")
    assert doc_for("/api/publisher/me", "x").endswith("#4-publish-to-the-marketplace")
    assert doc_for("/api/whatever", {"code": "X"}) == OVERVIEW_DOC
    assert doc_for("/api/whatever", "x", "CAPABILITY_DENIED") == CAPABILITY_DENIED_DOC


def test_a_5xx_body_is_unchanged(client: TestClient, monkeypatch) -> None:
    from fastapi import HTTPException

    def boom(*_args, **_kwargs):
        raise HTTPException(status_code=503, detail="storage down")

    monkeypatch.setattr("registry.app.RegistryRepository.get_extension", boom)
    resp = client.get("/api/extensions/acme/hello")
    assert resp.status_code == 503
    assert resp.json() == {"detail": "storage down"}


def test_readiness_reports_schema_signing_and_scanner(client: TestClient, settings: Settings) -> None:
    resp = client.get("/api/readiness")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "ready"
    latest = MIGRATIONS[-1][0]
    assert body["schema"] == {"version": latest, "latest": latest, "migrations_complete": True, "pending": []}
    assert set(body["signing"]) == {
        "registry_profile", "key_id", "key_status", "key_fingerprint", "root_fingerprint", "publisher_signatures",
    }
    assert body["scanner"]["version"]
    text = resp.text
    assert "PRIVATE KEY" not in text
    assert "BEGIN" not in text


def test_readiness_on_an_upgraded_database_with_a_missing_step_is_503(settings: Settings) -> None:
    client = TestClient(create_app(settings))
    latest = MIGRATIONS[-1][0]
    connection = sqlite3.connect(settings.db_path)
    try:
        rows_before = connection.execute("SELECT COUNT(*) FROM schema_migrations").fetchone()[0]
        connection.execute("DELETE FROM schema_migrations WHERE version = ?", (latest,))
        connection.commit()
    finally:
        connection.close()
    resp = client.get("/api/readiness")
    assert resp.status_code == 503
    assert resp.json()["status"] == "not-ready"
    assert resp.json()["schema"]["pending"] == [latest]
    # Restarting runs the missing step again; nothing else in the database moves.
    TestClient(create_app(settings))
    ready = TestClient(create_app(settings)).get("/api/readiness")
    assert ready.status_code == 200
    connection = sqlite3.connect(settings.db_path)
    try:
        assert connection.execute("SELECT COUNT(*) FROM schema_migrations").fetchone()[0] == rows_before
    finally:
        connection.close()

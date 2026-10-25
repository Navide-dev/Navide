"""Root-signed Registry time (/api/trust/time): what an App whose clock is off
checks trust metadata against instead of its own clock."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from registry.signing import public_key_from_private
from tests.phase2_helpers import cloud_settings, make_client
from tests.test_registry_signing import _verify

NONCE = "n" * 43


@pytest.fixture()
def client(tmp_path):
    return make_client(cloud_settings(tmp_path))


def _root_public(client) -> str:
    return public_key_from_private(client.app.state.registry.trust_signer.root_private_key)


def test_registry_time_is_root_signed_and_echoes_the_nonce(client):
    before = datetime.now(timezone.utc).replace(microsecond=0)
    resp = client.get("/api/trust/time", params={"nonce": NONCE})
    after = datetime.now(timezone.utc)

    assert resp.status_code == 200
    body = resp.json()
    assert set(body) == {"registry_time", "registry_time_signature"}
    document = body["registry_time"]
    _verify(_root_public(client), document, body["registry_time_signature"])
    assert set(document) == {"schemaVersion", "kind", "registryProfile", "nonce", "serverTime"}
    assert document["schemaVersion"] == 1
    assert document["kind"] == "registry-time"
    assert document["nonce"] == NONCE
    assert document["registryProfile"] == client.app.state.registry.trust_signer.registry_profile
    server_time = datetime.fromisoformat(document["serverTime"].replace("Z", "+00:00"))
    assert before <= server_time <= after


def test_registry_time_signs_each_nonce_separately(client):
    first = client.get("/api/trust/time", params={"nonce": "a" * 43}).json()
    second = client.get("/api/trust/time", params={"nonce": "b" * 43}).json()
    assert first["registry_time"]["nonce"] != second["registry_time"]["nonce"]
    assert first["registry_time_signature"] != second["registry_time_signature"]


@pytest.mark.parametrize(
    "nonce",
    ["", "a" * 21, "a" * 87, "a" * 42 + "=", "a" * 42 + "+", "a" * 42 + "/", "a" * 42 + "\n"],
)
def test_registry_time_refuses_a_malformed_nonce(client, nonce):
    resp = client.get("/api/trust/time", params={"nonce": nonce})
    assert resp.status_code == 400
    assert resp.json()["detail"]["code"] == "INVALID_NONCE"


def test_registry_time_accepts_the_nonce_length_bounds(client):
    for nonce in ("a" * 22, "-_" * 43):
        assert client.get("/api/trust/time", params={"nonce": nonce}).status_code == 200


def test_registry_time_kind_is_not_any_other_root_signed_document(client):
    # The same root key signs trust metadata and the local-install document;
    # a distinct kind and field set keep each verifier from accepting another.
    time_doc = client.get("/api/trust/time", params={"nonce": NONCE}).json()["registry_time"]
    local = client.get("/api/trust/local-install").json()["local_trust_metadata"]
    assert time_doc["kind"] != local["kind"]
    assert "generatedAt" not in time_doc and "expiresAt" not in time_doc

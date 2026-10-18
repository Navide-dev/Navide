from __future__ import annotations

from dataclasses import dataclass

import pytest
from fastapi.testclient import TestClient

from registry.app import create_app
from registry.config import (
    TRUST_PROFILE_OFFICIAL,
    VERIFIER_ED25519,
    VERIFIER_ACCEPTING,
    Settings,
)
from registry.signing import (
    generate_keypair,
    public_key_fingerprint,
    sign_digest,
)


@pytest.fixture()
def settings(tmp_path) -> Settings:
    # Dev/test posture: accepting verifier, no signature/auth requirement. The
    # security-specific tests build their own strict Settings.
    return Settings(
        data_dir=tmp_path,
        verifier_kind=VERIFIER_ACCEPTING,
        require_signature=False,
        require_auth=False,
        allow_open_admin=True,
    )


@pytest.fixture()
def client(settings: Settings) -> TestClient:
    # No context manager: this app has no lifespan startup to run.
    return TestClient(create_app(settings))


@dataclass
class SignedEnv:
    """A strict (Ed25519 + auth-required) registry with a seeded publisher."""

    client: TestClient
    publisher: str
    token: str
    private_pem: str
    public_pem: str
    registry_signer_public_pem: str
    root_public_pem: str

    def sign(self, digest: str) -> str:
        return sign_digest(self.private_pem, digest)


@pytest.fixture()
def signed_env(tmp_path) -> SignedEnv:
    registry_signer_private_pem, registry_signer_public_pem = generate_keypair()
    root_private_pem, root_public_pem = generate_keypair()
    settings = Settings(
        data_dir=tmp_path,
        verifier_kind=VERIFIER_ED25519,
        require_signature=True,
        require_auth=True,
        registry_signer_private_key=registry_signer_private_pem,
        registry_signer_key_id="registry-2026-01",
        root_private_key=root_private_pem,
        trust_profile=TRUST_PROFILE_OFFICIAL,
        expected_root_fingerprint=public_key_fingerprint(root_public_pem),
        signer_status="active",
        admin_token="official-admin-token",
        blocked_publishers=("blocked-publisher",),
        blocked_packages=(
            "blocked.package@1.0.0",
            "blocked.all",
        ),
    )
    client = TestClient(create_app(settings))
    private_pem, public_pem = generate_keypair()
    token = "tok-acme-secret"  # noqa: S105 - test fixture token
    resp = client.post(
        "/api/publishers",
        json={
            "name": "acme",
            "public_key": public_pem,
            "token": token,
            "display_name": "Acme",
        },
        headers={"X-Admin-Token": "official-admin-token"},
    )
    assert resp.status_code == 201, resp.text
    return SignedEnv(
        client=client,
        publisher="acme",
        token=token,
        private_pem=private_pem,
        public_pem=public_pem,
        registry_signer_public_pem=registry_signer_public_pem,
        root_public_pem=root_public_pem,
    )

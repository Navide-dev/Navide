from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest

from registry.app import create_app
from registry.config import VERIFIER_ACCEPTING, load_settings
from registry.signing import (
    generate_keypair,
    public_key_fingerprint,
    public_key_from_private,
)


def test_official_profile_requires_explicit_trust_configuration(
    monkeypatch, tmp_path
) -> None:
    monkeypatch.setenv("REGISTRY_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("REGISTRY_TRUST_PROFILE", "official")
    monkeypatch.delenv("REGISTRY_TRUST_CONFIG_FILE", raising=False)

    with pytest.raises(ValueError, match="REGISTRY_TRUST_CONFIG_FILE"):
        load_settings()


def test_load_settings_reads_complete_official_trust_configuration(
    monkeypatch, tmp_path
) -> None:
    signer_private, _ = generate_keypair()
    root_private, _ = generate_keypair()
    _, old_public = generate_keypair()
    signer_path = tmp_path / "signer.pem"
    root_path = tmp_path / "root.pem"
    old_path = tmp_path / "old.pub"
    signer_path.write_text(signer_private, encoding="ascii")
    root_path.write_text(root_private, encoding="ascii")
    signer_path.chmod(0o600)
    root_path.chmod(0o600)
    old_path.write_text(old_public, encoding="ascii")
    config_path = tmp_path / "official-trust.json"
    config_path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "profile": "official",
                "expectedRootFingerprint": public_key_fingerprint(
                    public_key_from_private(root_private)
                ),
                "rootPrivateKeyFile": str(root_path),
                "signer": {
                    "keyId": "registry-2026-02",
                    "privateKeyFile": str(signer_path),
                    "status": "active",
                    "notBefore": "2026-08-01T00:00:00Z",
                    "notAfter": "2027-08-01T00:00:00Z",
                },
                "trustedSigners": [
                    {
                        "keyId": "registry-2026-01",
                        "publicKeyFile": str(old_path),
                        "status": "rotating",
                        "notBefore": "2025-08-01T00:00:00Z",
                        "notAfter": "2026-09-01T00:00:00Z",
                    }
                ],
                "blockedPublishers": ["blocked-publisher"],
                "blockedPackages": ["blocked.tools.linter@1.0.0"],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("REGISTRY_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("REGISTRY_TRUST_PROFILE", "official")
    monkeypatch.setenv("REGISTRY_TRUST_CONFIG_FILE", str(config_path))
    monkeypatch.setenv("REGISTRY_ADMIN_TOKEN", "official-admin-token")

    settings = load_settings()

    assert settings.trust_profile == "official"
    assert settings.registry_signer_private_key == signer_private
    assert settings.registry_signer_key_id == "registry-2026-02"
    assert settings.signer_not_before == datetime(2026, 8, 1, tzinfo=timezone.utc)
    assert settings.signer_not_after == datetime(2027, 8, 1, tzinfo=timezone.utc)
    assert settings.root_private_key == root_private
    assert [entry.key_id for entry in settings.trusted_signers] == ["registry-2026-01"]
    assert settings.blocked_publishers == ("blocked-publisher",)
    assert settings.blocked_packages == ("blocked.tools.linter@1.0.0",)
    assert settings.admin_token == "official-admin-token"


def test_blocked_package_id_contract_fails_closed(monkeypatch, tmp_path) -> None:
    signer_private, _ = generate_keypair()
    root_private, _ = generate_keypair()
    signer_path = tmp_path / "signer.pem"
    root_path = tmp_path / "root.pem"
    signer_path.write_text(signer_private, encoding="ascii")
    root_path.write_text(root_private, encoding="ascii")
    signer_path.chmod(0o600)
    root_path.chmod(0o600)
    config_path = tmp_path / "official-trust.json"
    config_path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "profile": "official",
                "expectedRootFingerprint": public_key_fingerprint(
                    public_key_from_private(root_private)
                ),
                "rootPrivateKeyFile": str(root_path),
                "signer": {
                    "keyId": "registry-2026-02",
                    "privateKeyFile": str(signer_path),
                    "status": "active",
                    "notBefore": "2026-08-01T00:00:00Z",
                    "notAfter": "2027-08-01T00:00:00Z",
                },
                "trustedSigners": [],
                "blockedPublishers": [],
                "blockedPackages": ["acme..tools"],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("REGISTRY_TRUST_PROFILE", "official")
    monkeypatch.setenv("REGISTRY_TRUST_CONFIG_FILE", str(config_path))

    with pytest.raises(ValueError, match="blockedPackages"):
        load_settings()


def test_official_registry_rejects_root_that_does_not_match_app_pin(
    monkeypatch, tmp_path
) -> None:
    signer_private, _ = generate_keypair()
    root_private, _ = generate_keypair()
    _, other_root_public = generate_keypair()
    signer_path = tmp_path / "signer.pem"
    root_path = tmp_path / "root.pem"
    signer_path.write_text(signer_private, encoding="ascii")
    root_path.write_text(root_private, encoding="ascii")
    signer_path.chmod(0o600)
    root_path.chmod(0o600)
    config_path = tmp_path / "official-trust.json"
    config_path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "profile": "official",
                "expectedRootFingerprint": public_key_fingerprint(other_root_public),
                "rootPrivateKeyFile": str(root_path),
                "signer": {
                    "keyId": "registry-2026-02",
                    "privateKeyFile": str(signer_path),
                    "status": "active",
                    "notBefore": "2026-08-01T00:00:00Z",
                    "notAfter": "2027-08-01T00:00:00Z",
                },
                "trustedSigners": [],
                "blockedPublishers": [],
                "blockedPackages": [],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("REGISTRY_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("REGISTRY_TRUST_PROFILE", "official")
    monkeypatch.setenv("REGISTRY_TRUST_CONFIG_FILE", str(config_path))
    monkeypatch.setenv("REGISTRY_ADMIN_TOKEN", "official-admin-token")

    settings = load_settings()

    with pytest.raises(ValueError, match="App-pinned fingerprint"):
        create_app(settings)


@pytest.mark.parametrize(
    "field,value",
    [
        ("status", "unknown"),
        ("notAfter", "2025-01-01T00:00:00Z"),
    ],
)
def test_official_trust_configuration_fails_closed(
    monkeypatch, tmp_path, field: str, value: str
) -> None:
    signer_private, _ = generate_keypair()
    root_private, _ = generate_keypair()
    signer_path = tmp_path / "signer.pem"
    root_path = tmp_path / "root.pem"
    signer_path.write_text(signer_private, encoding="ascii")
    root_path.write_text(root_private, encoding="ascii")
    signer_path.chmod(0o600)
    root_path.chmod(0o600)
    signer = {
        "keyId": "registry-2026-02",
        "privateKeyFile": str(signer_path),
        "status": "active",
        "notBefore": "2026-08-01T00:00:00Z",
        "notAfter": "2027-08-01T00:00:00Z",
    }
    signer[field] = value
    config_path = tmp_path / "official-trust.json"
    config_path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "profile": "official",
                "expectedRootFingerprint": public_key_fingerprint(
                    public_key_from_private(root_private)
                ),
                "rootPrivateKeyFile": str(root_path),
                "signer": signer,
                "trustedSigners": [],
                "blockedPublishers": [],
                "blockedPackages": [],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("REGISTRY_TRUST_PROFILE", "official")
    monkeypatch.setenv("REGISTRY_TRUST_CONFIG_FILE", str(config_path))

    with pytest.raises(ValueError, match="trust config"):
        load_settings()


def test_open_admin_is_an_explicit_dev_opt_in(monkeypatch, tmp_path) -> None:
    monkeypatch.setenv("REGISTRY_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("REGISTRY_TRUST_PROFILE", raising=False)
    monkeypatch.delenv("REGISTRY_ALLOW_OPEN_ADMIN", raising=False)
    assert load_settings().allow_open_admin is False

    monkeypatch.setenv("REGISTRY_ALLOW_OPEN_ADMIN", "1")
    assert load_settings().allow_open_admin is True


def test_official_profile_rejects_security_downgrades_and_requires_admin_token(
    monkeypatch, tmp_path
) -> None:
    signer_private, _ = generate_keypair()
    root_private, _ = generate_keypair()
    signer_path = tmp_path / "signer.pem"
    root_path = tmp_path / "root.pem"
    signer_path.write_text(signer_private, encoding="ascii")
    root_path.write_text(root_private, encoding="ascii")
    signer_path.chmod(0o600)
    root_path.chmod(0o600)
    config_path = tmp_path / "official-trust.json"
    config_path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "profile": "official",
                "expectedRootFingerprint": public_key_fingerprint(
                    public_key_from_private(root_private)
                ),
                "rootPrivateKeyFile": str(root_path),
                "signer": {
                    "keyId": "registry-2026-02",
                    "privateKeyFile": str(signer_path),
                    "status": "active",
                    "notBefore": "2026-08-01T00:00:00Z",
                    "notAfter": "2027-08-01T00:00:00Z",
                },
                "trustedSigners": [],
                "blockedPublishers": [],
                "blockedPackages": [],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("REGISTRY_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("REGISTRY_TRUST_PROFILE", "official")
    monkeypatch.setenv("REGISTRY_TRUST_CONFIG_FILE", str(config_path))
    monkeypatch.setenv("REGISTRY_ADMIN_TOKEN", "official-admin-token")

    for variable, value, message in (
        ("REGISTRY_VERIFIER", VERIFIER_ACCEPTING, "ed25519 verifier"),
        ("REGISTRY_REQUIRE_SIGNATURE", "false", "package signatures"),
        ("REGISTRY_REQUIRE_AUTH", "false", "publisher authentication"),
        ("REGISTRY_ALLOW_OPEN_ADMIN", "true", "open admin"),
    ):
        monkeypatch.setenv(variable, value)
        with pytest.raises(ValueError, match=message):
            load_settings()
        monkeypatch.delenv(variable)

    monkeypatch.delenv("REGISTRY_ADMIN_TOKEN")
    with pytest.raises(ValueError, match="admin token"):
        load_settings()


@pytest.mark.parametrize("bad_field", ["root", "signer"])
def test_official_config_rejects_symlinked_private_keys(
    monkeypatch, tmp_path, bad_field: str
) -> None:
    signer_private, _ = generate_keypair()
    root_private, _ = generate_keypair()
    signer_path = tmp_path / "signer.pem"
    root_path = tmp_path / "root.pem"
    signer_path.write_text(signer_private, encoding="ascii")
    root_path.write_text(root_private, encoding="ascii")
    signer_path.chmod(0o600)
    root_path.chmod(0o600)
    bad_path = root_path if bad_field == "root" else signer_path
    target = tmp_path / f"{bad_field}-target.pem"
    target.write_text(bad_path.read_text(encoding="ascii"), encoding="ascii")
    target.chmod(0o600)
    bad_path.unlink()
    bad_path.symlink_to(target)
    config_path = tmp_path / "official-trust.json"
    config_path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "profile": "official",
                "expectedRootFingerprint": public_key_fingerprint(
                    public_key_from_private(root_private)
                ),
                "rootPrivateKeyFile": str(root_path),
                "signer": {
                    "keyId": "registry-2026-02",
                    "privateKeyFile": str(signer_path),
                    "status": "active",
                    "notBefore": "2026-08-01T00:00:00Z",
                    "notAfter": "2027-08-01T00:00:00Z",
                },
                "trustedSigners": [],
                "blockedPublishers": [],
                "blockedPackages": [],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("REGISTRY_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("REGISTRY_TRUST_PROFILE", "official")
    monkeypatch.setenv("REGISTRY_TRUST_CONFIG_FILE", str(config_path))
    monkeypatch.setenv("REGISTRY_ADMIN_TOKEN", "official-admin-token")

    with pytest.raises(ValueError, match="trust config"):
        load_settings()

"""The SDK CLI (packages/plugin-sdk/bin/navide-plugin.mjs) is the public
`navide-plugin`; this registry's verifier is what accepts its output. These
tests drive the Node CLI as a subprocess and check its keys, packages and
signatures against the registry's own reader, verifier and publish route, and
the legacy Python CLI's signatures against the Node verifier."""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from registry import cli
from registry.app import create_app
from registry.config import VERIFIER_ED25519, Settings
from registry.package import read_package
from registry.signing import Ed25519SignatureVerifier, generate_keypair, sign_digest

REPO_ROOT = Path(__file__).resolve().parents[3]
SDK_CLI = REPO_ROOT / "packages" / "plugin-sdk" / "bin" / "navide-plugin.mjs"
CONTRACTS_DIST = REPO_ROOT / "packages" / "plugin-contracts" / "dist" / "index.js"
NODE = shutil.which("node")

pytestmark = pytest.mark.skipif(
    NODE is None or not CONTRACTS_DIST.is_file(),
    reason="needs node and a built @navide/plugin-contracts (pnpm run build:public-packages)",
)

ADMIN_TOKEN = "compat-admin-token"
PUBLISHER_TOKEN = "compat-publisher-token"  # noqa: S105 - test fixture token


def _sdk(*args: str | Path, cwd: Path) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        [NODE, str(SDK_CLI), *map(str, args)], cwd=cwd, capture_output=True, text=True, check=False
    )
    assert result.returncode == 0, result.stderr
    return result


def _scaffold_package(tmp_path: Path) -> Path:
    _sdk("init", "plugin", "--id", "acme.hello", cwd=tmp_path)
    _sdk("validate", "plugin", cwd=tmp_path)
    _sdk("package", "plugin", "--out", "hello.vsix", cwd=tmp_path)
    return tmp_path / "hello.vsix"


def test_scaffold_packages_into_an_archive_the_registry_reads(tmp_path: Path) -> None:
    package = _scaffold_package(tmp_path)
    loaded = read_package(package.read_bytes(), target="universal")
    assert loaded.manifest.id == "acme.hello"
    assert loaded.manifest.engines.navide.startswith(">=")
    assert [a.path for a in loaded.assets] == [
        "README.md",
        "frontend/main/index.html",
        "frontend/main/main.js",
    ]


def test_sdk_signature_is_accepted_by_the_registry_publish_gate(tmp_path: Path) -> None:
    package = _scaffold_package(tmp_path)
    _sdk("keygen", "--out-dir", "keys", "--name", "acme", cwd=tmp_path)
    _sdk("sign", package, "--key", "keys/acme.key", "--out", "hello.sig", cwd=tmp_path)
    public_pem = (tmp_path / "keys" / "acme.pub").read_text()
    signature = (tmp_path / "hello.sig").read_text().strip()
    digest = hashlib.sha256(package.read_bytes()).hexdigest()

    verifier = Ed25519SignatureVerifier()
    assert verifier.verify(digest=digest, signature=signature, public_key=public_pem)
    assert not verifier.verify(digest="0" * 64, signature=signature, public_key=public_pem)

    client = TestClient(
        create_app(
            Settings(
                data_dir=tmp_path / "data",
                verifier_kind=VERIFIER_ED25519,
                require_signature=True,
                require_auth=True,
                admin_token=ADMIN_TOKEN,
            )
        )
    )
    created = client.post(
        "/api/publishers",
        json={"name": "acme", "public_key": public_pem, "token": PUBLISHER_TOKEN},
        headers={"X-Admin-Token": ADMIN_TOKEN},
    )
    assert created.status_code == 201, created.text
    published = cli.post_package(
        "http://testserver", package, PUBLISHER_TOKEN, signature, client=client
    )
    assert published[0] == 201, published[1]
    assert json.loads(published[1])["package_digest"] == digest


def test_legacy_python_signature_verifies_with_the_sdk_cli(tmp_path: Path) -> None:
    package = _scaffold_package(tmp_path)
    private_pem, public_pem = generate_keypair()
    (tmp_path / "acme.pub").write_text(public_pem)
    signature = sign_digest(private_pem, hashlib.sha256(package.read_bytes()).hexdigest())
    (tmp_path / "hello.sig").write_text(signature)
    verified = _sdk("verify", package, "--key", "acme.pub", "--signature", "hello.sig", cwd=tmp_path)
    assert "Verified complete archive digest" in verified.stdout


def test_python_cli_points_authors_at_the_sdk_cli(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert cli.main(["keygen", "--out-dir", str(tmp_path), "--name", "acme"]) == 0
    assert "deprecated" in capsys.readouterr().err

"""Pre-release channel (Phase 4): the channel rule, stable-only
`latest_version`, and FORMAT.md agreeing with the manifest models."""

from __future__ import annotations

import copy
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from registry.manifest import ManifestError, parse_manifest
from registry.versions import (
    latest_prerelease_version,
    latest_stable_version,
    version_channel,
)
from tests.fixtures import build_v2_package, contract_manifest, valid_manifest

FORMAT_MD = Path(__file__).parents[1] / "FORMAT.md"


def _publish(client: TestClient, version: str, ident: str = "acme.files") -> None:
    manifest = copy.deepcopy(contract_manifest())
    manifest.update(id=ident, publisher=ident.split(".")[0], version=version)
    resp = client.post(
        "/api/publish",
        files={"package": ("pkg.vsix", build_v2_package(manifest), "application/zip")},
    )
    assert resp.status_code == 201, resp.text


@pytest.mark.parametrize(
    ("version", "channel"),
    [
        ("1.0.0", "stable"),
        ("1.0.0+build.7", "stable"),
        ("1.0.0-beta.1", "pre-release"),
        ("1.0.0-rc.1+build.2", "pre-release"),
        ("1.0.0-0", "pre-release"),
    ],
)
def test_version_channel(version: str, channel: str) -> None:
    assert version_channel(version) == channel


def test_latest_stable_and_prerelease_selection() -> None:
    assert latest_stable_version(["1.0.0", "1.1.0-beta.1"]) == "1.0.0"
    assert latest_prerelease_version(["1.0.0", "1.1.0-beta.1"]) == "1.1.0-beta.1"
    # A stable release newer than every pre-release leaves none to offer.
    assert latest_prerelease_version(["1.1.0", "1.1.0-beta.1"]) is None
    # Pre-release-only: it is the only thing there is to list.
    assert latest_stable_version(["0.1.0-alpha.1", "0.1.0-alpha.2"]) == "0.1.0-alpha.2"
    assert latest_stable_version([]) is None
    assert latest_prerelease_version([]) is None


def test_stable_user_is_never_pointed_at_a_prerelease(client: TestClient) -> None:
    _publish(client, "1.0.0")
    _publish(client, "1.1.0-beta.1")
    item = client.get("/api/extensions").json()["items"][0]
    assert item["latest_version"] == "1.0.0"
    assert item["latest_prerelease_version"] == "1.1.0-beta.1"
    detail = client.get("/api/extensions/acme/files").json()
    assert detail["latest_version"] == "1.0.0"
    channels = {v["version"]: v["channel"] for v in detail["versions"]}
    assert channels == {"1.0.0": "stable", "1.1.0-beta.1": "pre-release"}
    # The README and changelog follow the stable latest too.
    assert client.get("/api/extensions/acme/files/readme").json()["version"] == "1.0.0"


def test_newer_stable_supersedes_the_prerelease(client: TestClient) -> None:
    _publish(client, "1.0.0")
    _publish(client, "1.1.0-beta.1")
    _publish(client, "1.1.0")
    item = client.get("/api/extensions").json()["items"][0]
    assert item["latest_version"] == "1.1.0"
    assert item["latest_prerelease_version"] is None


def test_prerelease_only_extension_stays_listed(client: TestClient) -> None:
    _publish(client, "0.1.0-alpha.1")
    item = client.get("/api/extensions").json()["items"][0]
    assert item["latest_version"] == "0.1.0-alpha.1"
    assert item["latest_prerelease_version"] == "0.1.0-alpha.1"


def test_format_md_matches_the_manifest_models() -> None:
    """FORMAT.md used to say "no pre-release" without saying that is v1-only
    while v2 accepts pre-releases (p4-format-md-fix)."""
    text = FORMAT_MD.read_text(encoding="utf-8")
    version_row = next(line for line in text.splitlines() if line.startswith("| `version` |"))
    assert "Manifest v1" in version_row and "Manifest v2" in version_row
    assert "## Release channels" in text
    assert "`2.5.0-beta.1`) is a **pre-release**" in text

    with pytest.raises(ManifestError):
        parse_manifest(valid_manifest(version="1.0.0-beta.1"))
    manifest = copy.deepcopy(contract_manifest())
    manifest["version"] = "2.5.0-beta.1"
    assert parse_manifest(manifest).version == "2.5.0-beta.1"


def test_testplace_publish_is_refused_until_testplace_opens(client: TestClient) -> None:
    manifest = copy.deepcopy(contract_manifest())
    manifest.update(id="acme.files", publisher="acme", version="1.0.0")
    resp = client.post(
        "/api/publish",
        params={"channel": "testplace"},
        files={"package": ("pkg.vsix", build_v2_package(manifest), "application/zip")},
    )
    assert resp.status_code == 409, resp.text
    assert "TESTPLACE_NOT_OPEN" in resp.json()["detail"]
    assert client.get("/api/extensions/acme/files").status_code == 404


@pytest.mark.parametrize("channel", ["nightly", "pre-release"])
def test_publish_channel_must_be_known_and_match_the_version(
    client: TestClient, channel: str
) -> None:
    manifest = copy.deepcopy(contract_manifest())
    manifest.update(id="acme.files", publisher="acme", version="1.0.0")
    resp = client.post(
        "/api/publish",
        params={"channel": channel},
        files={"package": ("pkg.vsix", build_v2_package(manifest), "application/zip")},
    )
    assert resp.status_code == 400, resp.text


def test_publish_with_the_matching_channel_is_unchanged(client: TestClient) -> None:
    manifest = copy.deepcopy(contract_manifest())
    manifest.update(id="acme.files", publisher="acme", version="1.0.0-beta.1")
    resp = client.post(
        "/api/publish",
        params={"channel": "pre-release"},
        files={"package": ("pkg.vsix", build_v2_package(manifest), "application/zip")},
    )
    assert resp.status_code == 201, resp.text
    detail = client.get("/api/extensions/acme/files").json()
    assert [v["channel"] for v in detail["versions"]] == ["pre-release"]


def _insert_testplace_copy(client: TestClient, version: str) -> None:
    """Store an approved testplace row the way a later Registry would: copy an
    approved row and change only its version and channel."""
    from datetime import datetime, timedelta, timezone

    from sqlmodel import Session, select

    from registry.models import ExtensionVersion

    with Session(client.app.state.registry.engine) as session:
        source = session.exec(select(ExtensionVersion)).first()
        assert source is not None
        data = source.model_dump(exclude={"id"})
        data.update(
            version=version,
            channel="testplace",
            expires_at=datetime.now(timezone.utc) + timedelta(days=90),
        )
        session.add(ExtensionVersion(**data))
        session.commit()


def test_public_reads_never_show_a_testplace_version(client: TestClient) -> None:
    _publish(client, "1.0.0")
    _insert_testplace_copy(client, "1.2.0")
    _insert_testplace_copy(client, "1.3.0-beta.1")

    item = client.get("/api/extensions").json()["items"][0]
    assert item["latest_version"] == "1.0.0"
    assert item["latest_prerelease_version"] is None
    detail = client.get("/api/extensions/acme/files").json()
    assert detail["latest_version"] == "1.0.0"
    assert [v["version"] for v in detail["versions"]] == ["1.0.0"]
    for version in ("1.2.0", "1.3.0-beta.1"):
        assert (
            client.get(f"/api/extensions/acme/files/{version}/download").status_code
            == 404
        )
    assert client.get("/api/extensions/acme/files/1.0.0/download").status_code == 200


def test_a_testplace_only_extension_is_not_listed(client: TestClient) -> None:
    _publish(client, "1.0.0")
    _insert_testplace_copy(client, "2.0.0")
    from sqlmodel import Session, select

    from registry.models import ExtensionVersion

    with Session(client.app.state.registry.engine) as session:
        stable = session.exec(
            select(ExtensionVersion).where(ExtensionVersion.version == "1.0.0")
        ).one()
        session.delete(stable)
        session.commit()

    assert client.get("/api/extensions").json()["items"] == []
    assert client.get("/api/extensions/acme/files").status_code == 404

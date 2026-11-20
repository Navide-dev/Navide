"""Marketplace discovery (Phase 1): the closed category list, paging,
Navide engine compatibility, links, icon and changelog facts."""

from __future__ import annotations

import copy

import pytest
from fastapi.testclient import TestClient

from registry.discovery import (
    engine_compatible,
    in_category,
    min_navide_version,
)
from tests.fixtures import build_package, build_v2_package, contract_manifest, valid_manifest


def _publish(client: TestClient, data: bytes) -> None:
    resp = client.post(
        "/api/publish",
        files={"package": ("pkg.vsix", data, "application/zip")},
    )
    assert resp.status_code == 201, resp.text


def _v2(
    ident: str = "acme.files",
    version: str = "1.0.0",
    engine: str | None = None,
    categories: list[str] | None = None,
) -> dict:
    manifest = copy.deepcopy(contract_manifest())
    ns = ident.split(".", 1)[0]
    manifest.update(id=ident, publisher=ns, version=version)
    if engine is not None:
        manifest["engines"] = {"navide": engine}
    if categories is not None:
        manifest["marketplace"]["categories"] = categories
    return manifest


# -- rules ---------------------------------------------------------------
@pytest.mark.parametrize(
    ("requirement", "minimum"),
    [
        ("^0.2.9", "0.2.9"),
        ("~0.2.9", "0.2.9"),
        (">=0.3.0", "0.3.0"),
        (">= 0.3.0", "0.3.0"),
        ("0.2.9", "0.2.9"),
        ("*", "0.0.0"),
        ("^1.0.0-beta.1", "1.0.0-beta.1"),
        (None, None),
        ("latest", None),
        ("^0.2", None),
        ("<1.0.0", None),
    ],
)
def test_min_navide_version(requirement: str | None, minimum: str | None) -> None:
    assert min_navide_version(requirement) == minimum


def test_engine_compatible_three_states() -> None:
    # A caret on a 0.x release is a floor, not an upper bound: the official
    # packages declare ^0.1.0 and must stay installable on 0.2.x.
    assert engine_compatible("^0.1.0", "0.2.13") is True
    assert engine_compatible(">=0.3.0", "0.2.13") is False
    assert engine_compatible("^0.2.13", "0.2.13") is True
    assert engine_compatible("^0.3.0", "0.3.0-beta.1") is False
    assert engine_compatible("^0.1.0", None) is None
    assert engine_compatible("not-a-range", "0.2.13") is None
    assert engine_compatible(None, "0.2.13") is None


def test_in_category_other_bucket() -> None:
    assert in_category(["productivity"], "productivity")
    assert in_category(["Productivity"], "productivity")
    assert not in_category(["productivity"], "other")
    assert in_category(["demo"], "other")
    assert in_category([], "other")
    assert in_category(["other", "ai"], "other")


# -- API -----------------------------------------------------------------
def test_categories_endpoint_is_the_closed_list_with_counts(client: TestClient) -> None:
    _publish(client, build_v2_package(_v2("acme.a", categories=["productivity"])))
    _publish(client, build_v2_package(_v2("acme.b", categories=["ai", "productivity"])))
    _publish(client, build_v2_package(_v2("acme.c", categories=["demo"])))
    body = client.get("/api/categories").json()
    slugs = [item["slug"] for item in body["items"]]
    assert slugs == [
        "productivity",
        "version-control",
        "themes",
        "ai",
        "extension-packs",
        "other",
    ]
    counts = {item["slug"]: item["count"] for item in body["items"]}
    assert counts == {
        "productivity": 2,
        "version-control": 0,
        "themes": 0,
        "ai": 1,
        "extension-packs": 0,
        "other": 1,
    }
    assert body["items"][0]["label"] == "Productivity"


def test_category_other_filter(client: TestClient) -> None:
    _publish(client, build_v2_package(_v2("acme.a", categories=["productivity"])))
    _publish(client, build_v2_package(_v2("acme.c", categories=["demo"])))
    body = client.get("/api/extensions", params={"category": "other"}).json()
    assert [i["identity"] for i in body["items"]] == ["acme.c"]
    assert body["total"] == 1


def test_offset_limit_paging_reports_total(client: TestClient) -> None:
    for index in range(5):
        _publish(client, build_v2_package(_v2(f"acme.p{index}")))
    first = client.get("/api/extensions", params={"limit": 2, "sort": "downloads"}).json()
    second = client.get(
        "/api/extensions", params={"limit": 2, "offset": 2, "sort": "downloads"}
    ).json()
    last = client.get(
        "/api/extensions", params={"limit": 2, "offset": 4, "sort": "downloads"}
    ).json()
    assert first["total"] == second["total"] == last["total"] == 5
    seen = [i["identity"] for i in first["items"] + second["items"] + last["items"]]
    assert sorted(seen) == [f"acme.p{i}" for i in range(5)]
    assert len(last["items"]) == 1


def test_list_compatible_flag_three_states(client: TestClient) -> None:
    _publish(client, build_v2_package(_v2("acme.old", engine="^0.1.0")))
    _publish(client, build_v2_package(_v2("acme.new", engine=">=0.3.0")))
    _publish(client, build_v2_package(_v2("acme.none")))

    unknown = client.get("/api/extensions").json()
    assert {i["identity"]: i["compatible"] for i in unknown["items"]} == {
        "acme.old": None,
        "acme.new": None,
        "acme.none": None,
    }

    body = client.get("/api/extensions", params={"navide_version": "0.2.13"}).json()
    by_id = {i["identity"]: i for i in body["items"]}
    assert by_id["acme.old"]["compatible"] is True
    assert by_id["acme.new"]["compatible"] is False
    assert by_id["acme.new"]["min_navide_version"] == "0.3.0"
    assert by_id["acme.new"]["engines_navide"] == ">=0.3.0"
    # No engines requirement: unknown, never reported as incompatible.
    assert by_id["acme.none"]["compatible"] is None


def test_compatible_only_filters_before_paging(client: TestClient) -> None:
    _publish(client, build_v2_package(_v2("acme.old", engine="^0.1.0")))
    _publish(client, build_v2_package(_v2("acme.new", engine=">=0.3.0")))
    _publish(client, build_v2_package(_v2("acme.none")))
    body = client.get(
        "/api/extensions",
        params={"navide_version": "0.2.13", "compatible_only": "true"},
    ).json()
    assert sorted(i["identity"] for i in body["items"]) == ["acme.none", "acme.old"]
    assert body["total"] == 2
    # Without a client version the flag has nothing to compare against.
    body = client.get("/api/extensions", params={"compatible_only": "true"}).json()
    assert body["total"] == 3


def test_invalid_navide_version_is_rejected(client: TestClient) -> None:
    _publish(client, build_v2_package(_v2()))
    assert (
        client.get("/api/extensions", params={"navide_version": "latest"}).status_code
        == 400
    )
    assert (
        client.get(
            "/api/extensions/acme/files", params={"navide_version": "1"}
        ).status_code
        == 400
    )


def test_detail_versions_carry_per_version_compatibility(client: TestClient) -> None:
    _publish(client, build_v2_package(_v2(version="1.0.0", engine="^0.1.0")))
    _publish(client, build_v2_package(_v2(version="2.0.0", engine=">=0.3.0")))
    detail = client.get(
        "/api/extensions/acme/files", params={"navide_version": "0.2.13"}
    ).json()
    assert detail["latest_version"] == "2.0.0"
    assert detail["compatible"] is False
    rows = {v["version"]: v for v in detail["versions"]}
    assert rows["2.0.0"]["compatible"] is False
    assert rows["1.0.0"]["compatible"] is True
    assert rows["1.0.0"]["min_navide_version"] == "0.1.0"


def test_links_and_icon_from_the_latest_manifest(client: TestClient) -> None:
    # The package builder stores the manifest's `assets/files.png`.
    _publish(client, build_v2_package(_v2()))
    item = client.get("/api/extensions").json()["items"][0]
    assert item["license"] == "MIT"
    assert item["repository"] == "https://github.com/acme/navide-files"
    assert item["homepage"] == "https://acme.example/navide-files"
    assert item["icon_path"] == "assets/files.png"
    # Cards show the signed badge from the latest version's trust tier.
    assert item["trust_tier"] == "signed-verified"


def test_non_raster_icon_is_not_advertised(client: TestClient) -> None:
    manifest = _v2()
    manifest["marketplace"]["icon"] = "assets/files.svg"
    _publish(client, build_v2_package(manifest))
    item = client.get("/api/extensions").json()["items"][0]
    assert item["icon_path"] is None


def test_legacy_manifest_has_no_links(client: TestClient) -> None:
    _publish(client, build_package(manifest=valid_manifest()))
    item = client.get("/api/extensions").json()["items"][0]
    assert item["license"] is None
    assert item["repository"] is None
    # The legacy fixture icon is a real PNG asset.
    assert item["icon_path"] == "icon.png"


def test_changelog_endpoint(client: TestClient) -> None:
    _publish(
        client,
        build_v2_package(_v2(), extra_files={"CHANGELOG.md": b"# 1.0.0\n\n- first\n"}),
    )
    detail = client.get("/api/extensions/acme/files").json()
    assert detail["has_changelog"] is True
    body = client.get("/api/extensions/acme/files/changelog").json()
    assert body == {"version": "1.0.0", "markdown": "# 1.0.0\n\n- first\n"}


def test_no_changelog(client: TestClient) -> None:
    _publish(client, build_v2_package(_v2()))
    assert client.get("/api/extensions/acme/files").json()["has_changelog"] is False
    body = client.get("/api/extensions/acme/files/changelog").json()
    assert body == {"version": "1.0.0", "markdown": None}
    assert client.get("/api/extensions/acme/nope/changelog").status_code == 404


# -- detail page fields the Navide app mirrors from the website ----------
_PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 16


def test_detail_lists_screenshots_but_not_the_icon(client: TestClient) -> None:
    _publish(client, build_v2_package(_v2(), extra_files={"media/shot-2.png": _PNG, "media/shot-1.png": _PNG}))
    detail = client.get("/api/extensions/acme/files").json()
    assert detail["screenshots"] == ["media/shot-1.png", "media/shot-2.png"]
    assert "assets/files.png" not in detail["screenshots"]


def test_detail_names_only_a_verified_publisher_domain(client: TestClient) -> None:
    from datetime import datetime, timezone

    from sqlmodel import Session, select

    from registry.models import Publisher

    _publish(client, build_v2_package(_v2()))
    detail = client.get("/api/extensions/acme/files").json()
    assert detail["verified_domain"] is None
    with Session(client.app.state.registry.engine) as session:
        publisher = session.exec(select(Publisher).where(Publisher.name == detail["publisher"])).one()
        publisher.verified_domain = "acme.dev"
        session.add(publisher)
        session.commit()
        # Claimed but not proven yet: still not shown.
        assert client.get("/api/extensions/acme/files").json()["verified_domain"] is None
        publisher.domain_verified_at = datetime.now(timezone.utc)
        session.add(publisher)
        session.commit()
    assert client.get("/api/extensions/acme/files").json()["verified_domain"] == "acme.dev"

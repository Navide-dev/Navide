"""One artifact per target for a single (extension, version)."""

from __future__ import annotations

import hashlib

from fastapi.testclient import TestClient

from registry.native_backend import MIN_NAVIDE_FOR_THIRD_PARTY_BACKEND
from tests.fixtures import build_package, build_v2_package, contract_manifest

# Minimal native headers the registry can identify per target: a 64-bit Mach-O
# for Apple silicon and a PE32+ image for x64 Windows.
MACHO_ARM64 = (0xFEEDFACF).to_bytes(4, "little") + (0x0100000C).to_bytes(4, "little")
PE_X64 = (
    b"MZ"
    + b"\0" * 0x3A
    + (0x40).to_bytes(4, "little")
    + b"PE\0\0"
    + (0x8664).to_bytes(2, "little")
)


def _meets_local_backend_rules(manifest: dict) -> dict:
    """A local Registry applies the native backend package rules to every publisher."""
    manifest["backend"]["methods"] = ["skills.list"]
    manifest["engines"] = {"navide": f">={MIN_NAVIDE_FOR_THIRD_PARTY_BACKEND}"}
    return manifest


def _backend_package(backend_data: bytes, version: str = "1.0.0") -> bytes:
    manifest = _meets_local_backend_rules(contract_manifest("backend-only-skills.json"))
    manifest["version"] = version
    # A PE image ships as the `.exe` a Windows target reads the entry as.
    backend_name = (
        manifest["backend"]["entry"] + ".exe" if backend_data.startswith(b"MZ") else None
    )
    return build_v2_package(manifest, backend_data=backend_data, backend_name=backend_name)


def _frontend_package(version: str = "1.0.0") -> bytes:
    """A frontend-only package with the same identity as `_backend_package`."""
    manifest = contract_manifest()
    manifest.update(id="navide.skills", publisher="navide", version=version)
    return build_v2_package(manifest)


def _publish(client: TestClient, data: bytes, target: str):
    return client.post(
        "/api/publish",
        files={"package": ("pkg.vsix", data, "application/zip")},
        params={"target": target},
    )


def test_same_version_publishes_once_per_platform_target(client: TestClient) -> None:
    darwin = _backend_package(MACHO_ARM64)
    windows = _backend_package(PE_X64)

    first = _publish(client, darwin, "darwin-arm64")
    second = _publish(client, windows, "win32-x64")
    assert (first.status_code, second.status_code) == (201, 201), second.text
    assert first.json()["target"] == "darwin-arm64"
    assert second.json()["target"] == "win32-x64"

    duplicate = _publish(client, darwin, "darwin-arm64")
    assert duplicate.status_code == 409
    assert "already exists for target darwin-arm64" in duplicate.json()["detail"]

    detail = client.get("/api/extensions/navide/skills").json()
    assert detail["latest_version"] == "1.0.0"
    assert detail["latest_targets"] == ["darwin-arm64", "win32-x64"]
    rows = {(v["version"], v["target"]): v for v in detail["versions"]}
    assert set(rows) == {("1.0.0", "darwin-arm64"), ("1.0.0", "win32-x64")}
    for target, data in (("darwin-arm64", darwin), ("win32-x64", windows)):
        row = rows[("1.0.0", target)]
        assert row["package_digest"] == hashlib.sha256(data).hexdigest()
        assert row["registry_envelope"]["target"] == target
        assert row["registry_envelope"]["artifactDigest"] == row["package_digest"]

    search = client.get("/api/extensions", params={"q": "skills"}).json()
    assert search["items"][0]["latest_targets"] == ["darwin-arm64", "win32-x64"]


def test_download_returns_the_requested_targets_blob(client: TestClient) -> None:
    darwin = _backend_package(MACHO_ARM64)
    windows = _backend_package(PE_X64)
    _publish(client, darwin, "darwin-arm64")
    _publish(client, windows, "win32-x64")
    base = "/api/extensions/navide/skills/1.0.0/download"

    for target, data in (("darwin-arm64", darwin), ("win32-x64", windows)):
        resp = client.get(base, params={"target": target})
        assert resp.status_code == 200
        assert resp.content == data
        assert resp.headers["x-package-digest"] == hashlib.sha256(data).hexdigest()
        assert f"navide.skills-1.0.0@{target}.vsix" in resp.headers["content-disposition"]

    ambiguous = client.get(base)
    assert ambiguous.status_code == 400
    assert "darwin-arm64, win32-x64" in ambiguous.json()["detail"]

    missing = client.get(base, params={"target": "linux-x64"})
    assert missing.status_code == 404
    assert "no linux-x64 artifact" in missing.json()["detail"]

    counts = {
        v["target"]: v["download_count"]
        for v in client.get("/api/extensions/navide/skills").json()["versions"]
    }
    assert counts == {"darwin-arm64": 1, "win32-x64": 1}


def test_universal_and_platform_artifacts_do_not_mix(client: TestClient) -> None:
    assert _publish(client, _frontend_package("1.0.0"), "universal").status_code == 201
    platform = _publish(client, _backend_package(MACHO_ARM64, "1.0.0"), "darwin-arm64")
    assert platform.status_code == 409
    assert "either universal or per-platform" in platform.json()["detail"]

    assert _publish(client, _backend_package(MACHO_ARM64, "2.0.0"), "darwin-arm64").status_code == 201
    universal = _publish(client, _frontend_package("2.0.0"), "universal")
    assert universal.status_code == 409
    assert "either universal or per-platform" in universal.json()["detail"]


def test_universal_version_downloads_without_a_target(client: TestClient) -> None:
    data = build_package()
    _publish(client, data, "universal")
    resp = client.get("/api/extensions/acme/hello/1.0.0/download")
    assert resp.status_code == 200
    assert resp.content == data
    assert 'filename="acme.hello-1.0.0.vsix"' in resp.headers["content-disposition"]


def test_yank_covers_every_target_and_blocks_new_targets(client: TestClient) -> None:
    _publish(client, _backend_package(MACHO_ARM64, "1.0.0"), "darwin-arm64")
    _publish(client, _backend_package(PE_X64, "1.0.0"), "win32-x64")
    _publish(client, _backend_package(MACHO_ARM64, "1.1.0"), "darwin-arm64")

    resp = client.post("/api/extensions/navide/skills/1.1.0/yank")
    assert resp.status_code == 200
    assert resp.json()["targets"] == ["darwin-arm64"]
    resp = client.post("/api/extensions/navide/skills/1.0.0/yank")
    assert resp.json()["targets"] == ["darwin-arm64", "win32-x64"]

    detail = client.get("/api/extensions/navide/skills").json()
    assert all(v["yanked"] for v in detail["versions"])
    assert detail["latest_version"] is None
    assert detail["latest_targets"] == []

    late = _publish(client, _backend_package(PE_X64, "1.1.0"), "win32-x64")
    assert late.status_code == 409
    assert "is yanked" in late.json()["detail"]


def test_detail_page_lists_each_target(client: TestClient) -> None:
    _publish(client, _backend_package(MACHO_ARM64), "darwin-arm64")
    _publish(client, _backend_package(PE_X64), "win32-x64")
    html = client.get("/extensions/navide/skills").text
    assert "<td>darwin-arm64</td>" in html
    assert "<td>win32-x64</td>" in html
    assert "/api/extensions/navide/skills/1.0.0/download?target=win32-x64" in html


def test_home_cards_show_the_platforms_a_package_supports(client: TestClient) -> None:
    _publish(client, build_package(), "universal")
    _publish(client, _backend_package(MACHO_ARM64), "darwin-arm64")
    html = client.get("/").text
    hello = html[html.index('href="/extensions/acme/hello"') :]
    hello = hello[: hello.index("</a>")]
    skills = html[html.index('href="/extensions/navide/skills"') :]
    skills = skills[: skills.index("</a>")]
    assert '<span class="chip chip-target">All platforms</span>' in hello
    assert '<span class="chip chip-target">darwin-arm64</span>' in skills
    assert "All platforms" not in skills


def test_detail_page_points_installs_at_the_app(client: TestClient) -> None:
    _publish(client, _backend_package(MACHO_ARM64), "darwin-arm64")
    html = client.get("/extensions/navide/skills").text
    assert "navide-plugin install" not in html
    assert "Settings → Marketplace" in html
    assert "<code>navide.skills</code>" in html
    assert "download the package for a platform directly" in html


def test_windows_target_publishes_the_exe_backend(client: TestClient) -> None:
    windows = _backend_package(PE_X64)
    resp = _publish(client, windows, "win32-x64")
    assert resp.status_code == 201, resp.text
    # The same archive has no bare entry, so no other target can take it.
    rejected = _publish(client, windows, "linux-x64")
    assert rejected.status_code == 400
    assert "'backend/navide-skills' is not present" in rejected.json()["detail"]

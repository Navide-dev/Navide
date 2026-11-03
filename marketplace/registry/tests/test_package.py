from __future__ import annotations

import io
import json
import stat
import zipfile
from pathlib import Path

import pytest

from registry.package import (
    PackageError,
    _validate_archive_entries,
    build_package as build_registry_package,
    read_package,
)
from tests.fixtures import (
    CONTRACT_FIXTURES,
    build_package,
    build_v2_package,
    contract_manifest,
    valid_manifest,
    windows_backend_bytes,
)


def _zip_with_entries(entries: list[tuple[str, bytes, int | None]]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data, mode in entries:
            info = zipfile.ZipInfo(name)
            if mode is not None:
                info.create_system = 3
                info.external_attr = mode << 16
            zf.writestr(info, data)
    return buffer.getvalue()


def _valid_archive_entries() -> list[tuple[str, bytes, int | None]]:
    return [
        ("manifest.json", json.dumps(valid_manifest()).encode(), None),
        ("README.md", b"readme", None),
        ("icon.png", b"icon", None),
    ]


def _archive_path_contract() -> dict[str, dict[str, list[dict[str, str]]]]:
    return json.loads(
        (CONTRACT_FIXTURES.parent / "archive-paths-v1.json").read_text(encoding="utf-8")
    )


def _archive_entry_type_contract() -> list[dict[str, object]]:
    return json.loads(
        (CONTRACT_FIXTURES.parent / "archive-entry-types-v1.json").read_text(
            encoding="utf-8"
        )
    )["cases"]


def _archive_infos(entries: list[dict[str, str]]) -> list[zipfile.ZipInfo]:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for entry in entries:
            info = zipfile.ZipInfo(entry["path"])
            info.create_system = 3 if entry.get("creator", "unix") == "unix" else 0
            if info.create_system == 3 and entry["type"] == "directory":
                info.create_system = 3
                info.external_attr = (stat.S_IFDIR | 0o755) << 16
            elif info.create_system == 3 and entry["type"] == "symlink":
                info.create_system = 3
                info.external_attr = (stat.S_IFLNK | 0o777) << 16
            elif info.create_system == 3 and entry["type"] == "special":
                info.create_system = 3
                info.external_attr = (stat.S_IFCHR | 0o644) << 16
            elif entry.get("dosDirectory"):
                info.external_attr = 0x10
            zf.writestr(info, b"")
    with zipfile.ZipFile(io.BytesIO(buffer.getvalue())) as zf:
        return zf.infolist()


def test_read_valid_package() -> None:
    loaded = read_package(build_package())
    assert loaded.manifest.id == "acme.hello"
    assert len(loaded.digest) == 64
    paths = {a.path for a in loaded.assets}
    assert "README.md" in paths
    assert "icon.png" in paths
    assert "manifest.json" not in paths


def test_digest_is_stable() -> None:
    data = build_package()
    assert read_package(data).digest == read_package(data).digest


def test_registry_builder_deflates_entries_and_rebuilds_identical_bytes(tmp_path: Path) -> None:
    """The registry builder deflates every entry and is deterministic.

    The digest is signed and recorded, so one canonical file list must produce
    the same archive bytes; the SDK's `makeZip` applies the same method and
    level, and a silent switch away from deflate would fork the two builders
    into different variants of the same package.
    """
    source = tmp_path / "acme.hello"
    source.mkdir()
    manifest = valid_manifest()
    (source / "manifest.json").write_text(json.dumps(manifest))
    (source / "README.md").write_text("# Hello\n")
    (source / "dist").mkdir()
    (source / "dist" / "hello.js").write_text("console.log('hello')\n")
    (source / "dist" / "bundle.js").write_text("export const value = 1\n" * 400)
    (source / "icon.png").write_bytes(b"\x89PNG\r\n\x1a\n-fake-icon-bytes")
    files = ["README.md", "dist/bundle.js", "dist/hello.js", "icon.png", "manifest.json"]

    data = build_registry_package(source, files)

    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        infos = archive.infolist()
    assert [info.filename for info in infos] == files
    assert {info.compress_type for info in infos} == {zipfile.ZIP_DEFLATED}
    # The compressible body must actually shrink; tiny entries may not.
    bundle = next(info for info in infos if info.filename == "dist/bundle.js")
    assert bundle.compress_size < bundle.file_size
    assert read_package(data).manifest.id == manifest["id"]
    assert build_registry_package(source, files) == data


def test_not_a_zip_rejected() -> None:
    with pytest.raises(PackageError, match="ZIP"):
        read_package(b"not a zip file")


def test_zip64_end_of_central_directory_rejected() -> None:
    data = bytearray(build_package())
    data[-14:-12] = (0xFFFF).to_bytes(2, "little")
    data[-12:-10] = (0xFFFF).to_bytes(2, "little")
    with pytest.raises(PackageError, match="ZIP64 archives are not supported"):
        read_package(bytes(data))


# The Host reader (src/main/plugins/pluginPackage.ts) walks the central
# directory by EOCD entry count from the raw EOCD offset. Archives the two
# readers would see differently are refused on both sides.
def test_prefixed_archive_rejected() -> None:
    # zipfile shifts every offset by the prefix and reads this happily; the
    # Host would look for the central directory at the unshifted offset.
    with pytest.raises(PackageError, match="central directory does not end"):
        read_package(b"junk" + build_package())


def test_eocd_entry_count_mismatch_rejected() -> None:
    data = bytearray(_zip_with_entries(_valid_archive_entries()))
    data[-14:-12] = (1).to_bytes(2, "little")
    data[-12:-10] = (1).to_bytes(2, "little")
    with pytest.raises(PackageError, match="central directory does not end"):
        read_package(bytes(data))


def test_local_name_mismatch_rejected_for_unread_entries() -> None:
    # zipfile checks the local name only when it reads an entry; a directory
    # entry is never read, so its local name must be checked separately.
    entries = [("aaaa/", b"", 0o040755), *_valid_archive_entries()]
    data = bytearray(_zip_with_entries(entries))
    assert data[30:35] == b"aaaa/"
    data[30:34] = b"bbbb"
    with pytest.raises(PackageError, match="local header name does not match"):
        read_package(bytes(data))


def test_missing_manifest_rejected() -> None:
    with pytest.raises(PackageError, match="missing manifest.json"):
        read_package(build_package(omit_manifest=True))


def test_invalid_json_manifest_rejected() -> None:
    with pytest.raises(PackageError, match="not valid JSON"):
        read_package(build_package(manifest_bytes=b"{not json"))


def test_invalid_utf8_manifest_rejected() -> None:
    with pytest.raises(PackageError, match="not valid JSON"):
        read_package(build_package(manifest_bytes=b'{"name":\xff}'))


def test_utf8_bom_manifest_rejected() -> None:
    raw = (CONTRACT_FIXTURES / "invalid-raw" / "manifest-utf8-bom.json").read_bytes()
    with pytest.raises(PackageError, match="BOM"):
        read_package(build_package(manifest_bytes=raw))


def test_invalid_manifest_rejected() -> None:
    with pytest.raises(PackageError, match="invalid manifest"):
        read_package(build_package(manifest=valid_manifest(version="bad")))


def test_v2_publisher_must_own_id_namespace() -> None:
    manifest = contract_manifest()
    manifest["publisher"] = "other"
    with pytest.raises(PackageError, match="publisher must match id namespace"):
        read_package(build_v2_package(manifest))


def test_missing_icon_asset_rejected() -> None:
    with pytest.raises(PackageError, match="icon"):
        read_package(build_package(include_icon=False))


def test_manifest_without_icon_allows_missing_file() -> None:
    manifest = valid_manifest()
    del manifest["icon"]
    loaded = read_package(build_package(manifest=manifest, include_icon=False))
    assert loaded.manifest.icon is None


@pytest.mark.parametrize(
    "name",
    [path.name for path in sorted((CONTRACT_FIXTURES / "valid").glob("*.json"))],
)
def test_read_valid_manifest_v2_package(name: str) -> None:
    loaded = read_package(build_v2_package(contract_manifest(name)))
    assert loaded.manifest.schemaVersion == 2


def test_manifest_v2_backend_entry_requires_executable_metadata() -> None:
    manifest = contract_manifest("backend-only-skills.json")
    with pytest.raises(PackageError, match="not marked executable"):
        read_package(build_v2_package(manifest, backend_mode=stat.S_IFREG | 0o644))


@pytest.mark.parametrize(
    "data",
    [b"#!/bin/sh\nexit 0\n", b"\xef\xbb\xbf#!/bin/sh\nexit 0\n"],
    ids=["shebang", "bom-shebang"],
)
def test_manifest_v2_backend_entry_rejects_extensionless_scripts(data: bytes) -> None:
    manifest = contract_manifest("backend-only-skills.json")
    with pytest.raises(PackageError, match="raw script"):
        read_package(build_v2_package(manifest, backend_data=data))


def test_manifest_v2_backend_entry_rejects_empty_file() -> None:
    manifest = contract_manifest("backend-only-skills.json")
    with pytest.raises(PackageError, match="backend entry is empty"):
        read_package(build_v2_package(manifest, backend_data=b""))


def test_backend_only_package_rejects_smuggled_frontend_entry() -> None:
    manifest = contract_manifest("backend-only-skills.json")
    with pytest.raises(PackageError, match="backend-only package"):
        read_package(build_v2_package(manifest, extra_files={"frontend/main/index.html": b"<!doctype html>"}))


def _windows_backend_package(files: dict[str, bytes]) -> bytes:
    manifest = contract_manifest("backend-only-skills.json")
    return _zip_with_entries(
        [("manifest.json", json.dumps(manifest).encode(), None)]
        + [(name, data, None) for name, data in files.items()]
    )


@pytest.mark.parametrize("target, architecture", [("win32-x64", "x64"), ("win32-arm64", "arm64")])
def test_windows_target_reads_bare_backend_entry_as_exe(target: str, architecture: str) -> None:
    # Packed on Windows: no POSIX mode at all, as the Host accepts it there.
    data = _windows_backend_package({"backend/navide-skills.exe": windows_backend_bytes(architecture)})
    loaded = read_package(data, target=target)
    assert "backend/navide-skills.exe" in {asset.path for asset in loaded.assets}


def test_windows_target_rejects_wrong_architecture() -> None:
    data = _windows_backend_package({"backend/navide-skills.exe": windows_backend_bytes("x64")})
    with pytest.raises(PackageError, match="backend entry does not match declared target"):
        read_package(data, target="win32-arm64")


def test_windows_target_rejects_a_missing_exe_backend() -> None:
    data = _windows_backend_package({"backend/navide-skills": windows_backend_bytes("x64")})
    with pytest.raises(PackageError, match="'backend/navide-skills.exe' is not present"):
        read_package(data, target="win32-x64")
    with pytest.raises(PackageError, match="'backend/navide-skills.exe' is not present"):
        read_package(_windows_backend_package({}), target="win32-x64")


def test_windows_target_rejects_an_empty_exe_backend() -> None:
    data = _windows_backend_package({"backend/navide-skills.exe": b""})
    with pytest.raises(PackageError, match="backend entry is empty"):
        read_package(data, target="win32-x64")


@pytest.mark.parametrize("target", [None, "linux-x64", "darwin-arm64"])
def test_non_windows_target_still_needs_the_bare_executable(target: str | None) -> None:
    exe_only = _windows_backend_package({"backend/navide-skills.exe": windows_backend_bytes("x64")})
    with pytest.raises(PackageError, match="'backend/navide-skills' is not present"):
        read_package(exe_only, target=target)
    manifest = contract_manifest("backend-only-skills.json")
    with pytest.raises(PackageError, match="not marked executable"):
        read_package(
            build_v2_package(manifest, backend_mode=stat.S_IFREG | 0o644), target=target
        )
    linux_header = bytearray(20)
    linux_header[:4] = b"\x7fELF"
    linux_header[4:6] = b"\x02\x01"
    linux_header[18:20] = (62).to_bytes(2, "little")
    darwin_header = (0xFEEDFACF).to_bytes(4, "little") + (0x0100000C).to_bytes(4, "little")
    backend_data = {"linux-x64": bytes(linux_header), "darwin-arm64": darwin_header}.get(target, b"backend")
    assert read_package(build_v2_package(manifest, backend_data=backend_data), target=target)


def test_manifest_v2_referenced_file_is_required() -> None:
    manifest = contract_manifest()
    first_entry = manifest["contributes"]["views"][0]["entry"]
    with pytest.raises(PackageError, match="referenced file"):
        read_package(build_v2_package(manifest, omit_paths={first_entry}))


def test_frontend_only_packages_must_target_universal() -> None:
    """A frontend-only artifact is one universal package: the published target
    is the universal one, and any platform-specific target is refused."""
    assert read_package(build_package(), target="universal").manifest.id
    with pytest.raises(PackageError, match="frontend-only package target must be universal"):
        read_package(build_package(), target="darwin-arm64")


def test_backend_packages_require_one_exact_platform_architecture() -> None:
    """A package with a native backend must name the platform-architecture it
    was built for; 'universal' and a bare platform are both refused."""
    manifest = contract_manifest("backend-only-skills.json")
    for target in ("universal", "darwin"):
        with pytest.raises(PackageError, match="backend package target must be one exact"):
            read_package(build_v2_package(manifest), target=target)
    # The manager delegates the runner platform to osplat (see the L6 agreement).


def test_manifest_v2_target_schema_file_is_required() -> None:
    manifest = contract_manifest()
    manifest["contributes"]["views"] = [
        {
            "id": "detail",
            "kind": "custom",
            "location": "detail",
            "title": "Detail",
            "entry": "frontend/detail/index.html",
            "targetSchema": "schemas/item.json",
        }
    ]
    with pytest.raises(PackageError, match="referenced file"):
        read_package(build_v2_package(manifest, omit_paths={"schemas/item.json"}))


def test_duplicate_manifest_key_is_rejected_in_package_reader() -> None:
    raw = (
        CONTRACT_FIXTURES / "invalid-raw" / "duplicate-permission-key.json"
    ).read_bytes()
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("manifest.json", raw)
        zf.writestr("left.html", b"<!doctype html>")
    with pytest.raises(PackageError, match="duplicate JSON object key: system"):
        read_package(buffer.getvalue())


def test_duplicate_archive_entry_is_rejected_before_manifest_read() -> None:
    entries = _valid_archive_entries()
    entries.append(("README.md", b"duplicate", None))
    with pytest.raises(PackageError, match="duplicate archive entry: README.md"):
        read_package(_zip_with_entries(entries))


def test_trailing_slash_symlink_is_rejected_as_special_entry() -> None:
    with pytest.raises(PackageError, match="not a regular file"):
        _validate_archive_entries(
            _archive_infos([{"path": "link/", "type": "symlink"}])
        )


def test_case_folded_manifest_alias_is_rejected_before_manifest_read() -> None:
    entries = _valid_archive_entries()
    entries.append(("MANIFEST.JSON", json.dumps(valid_manifest()).encode(), None))
    with pytest.raises(PackageError, match="duplicate archive entry"):
        read_package(_zip_with_entries(entries))


@pytest.mark.parametrize(
    "name",
    [
        ".navide-receipt.json",
        ".navide-registry-receipt.json",
        ".navide-package.zip",
        ".navide-registry-trust.json",
        ".navide-backend-activation.json",
    ],
)
@pytest.mark.parametrize("case_fold", [False, True], ids=["exact", "uppercase-alias"])
def test_host_owned_archive_name_is_rejected(name: str, case_fold: bool) -> None:
    archive_name = name.upper() if case_fold else name
    with pytest.raises(PackageError, match="Host-owned"):
        read_package(build_package(extra_files={archive_name: b"{}"}))


@pytest.mark.parametrize(
    "case", _archive_entry_type_contract(), ids=lambda case: case["name"]
)
def test_shared_archive_entry_type_contract(case: dict[str, object]) -> None:
    infos = _archive_infos(
        [
            {
                "path": str(case["path"]),
                "type": str(case["type"]),
                "creator": str(case["creator"]),
                "dosDirectory": bool(case["dosDirectory"]),
            }
        ]
    )
    if case["expected"] == "rejected":
        with pytest.raises(PackageError, match="not a regular file"):
            _validate_archive_entries(infos)
    else:
        validated = _validate_archive_entries(infos)
        assert validated[0][2] == case["expected"]


@pytest.mark.parametrize("name, entries", _archive_path_contract()["valid"].items())
def test_shared_archive_path_contract_accepts(
    name: str, entries: list[dict[str, str]]
) -> None:
    del name
    _validate_archive_entries(_archive_infos(entries))


@pytest.mark.parametrize("name, entries", _archive_path_contract()["invalid"].items())
def test_shared_archive_path_contract_rejects(
    name: str, entries: list[dict[str, str]]
) -> None:
    del name
    with pytest.raises(PackageError):
        _validate_archive_entries(_archive_infos(entries))


def test_noncanonical_manifest_alias_is_rejected_before_manifest_read() -> None:
    entries = [
        ("manifest.json", json.dumps(valid_manifest()).encode(), None),
        (
            "./manifest.json",
            json.dumps(valid_manifest(entry="evil.html")).encode(),
            None,
        ),
    ]
    with pytest.raises(PackageError, match="unsafe archive entry path"):
        read_package(_zip_with_entries(entries))


def test_unsafe_unreferenced_archive_entry_is_rejected() -> None:
    with pytest.raises(PackageError, match="unsafe archive entry path"):
        read_package(build_package(extra_files={"../escape.js": b"blocked"}))


@pytest.mark.parametrize("path", ["frontend/main.ts", "assets/publisher.key", ".env"])
def test_source_only_or_secret_archive_entry_is_rejected(path: str) -> None:
    with pytest.raises(PackageError, match="source-only or secret"):
        read_package(build_v2_package(extra_files={path: b"blocked"}))


def test_legacy_v1_backend_source_remains_readable() -> None:
    loaded = read_package(build_package(extra_files={"backend.py": b"legacy source"}))
    assert "backend.py" in {asset.path for asset in loaded.assets}


@pytest.mark.parametrize(
    "mode",
    [stat.S_IFLNK | 0o777, stat.S_IFCHR | 0o600],
)
def test_non_regular_archive_entry_is_rejected(mode: int) -> None:
    entries = _valid_archive_entries()
    entries.append(("special-entry", b"not a regular file", mode))
    with pytest.raises(PackageError, match="not a regular file"):
        read_package(_zip_with_entries(entries))


def test_directory_metadata_is_preserved_as_a_non_asset() -> None:
    entries = _valid_archive_entries()
    entries.append(("nested", b"", stat.S_IFDIR | 0o755))
    loaded = read_package(_zip_with_entries(entries))
    assert "nested" not in {asset.path for asset in loaded.assets}

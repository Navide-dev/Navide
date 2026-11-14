"""Reader/validator for `.vsix`-style plugin packages (see FORMAT.md)."""

from __future__ import annotations

import hashlib
import json
import mimetypes
import posixpath
import stat
import zipfile
from dataclasses import dataclass, field
from io import BytesIO
from pathlib import Path

from .manifest import (
    ManifestLike,
    ManifestError,
    is_manifest_v2,
    manifest_referenced_files,
    parse_manifest,
)
from .path_policy import (
    ArchivePathKind,
    canonical_archive_path,
    portable_archive_collision_key,
)

MANIFEST_NAME = "manifest.json"
MAX_ENTRY_SIZE = 50 * 1024 * 1024
MAX_ARCHIVE_SIZE = 200 * 1024 * 1024

# These files are written by the Host after installation and must never be
# supplied by a package. Store the names in the same portable collision-key
# form used for archive path validation so case-folded aliases are rejected.
_HOST_OWNED_ARCHIVE_NAMES = frozenset(
    {
        ".navide-receipt.json",
        ".navide-registry-receipt.json",
        ".navide-package.zip",
        ".navide-registry-trust.json",
        ".navide-backend-activation.json",
        ".navide-quarantined.json",
    }
)
_SOURCE_ONLY_SEGMENTS = frozenset({"node_modules", ".venv", "venv", "__pycache__", "tests"})
_SOURCE_ONLY_SUFFIXES = frozenset({".py", ".pyc", ".pyo", ".ts", ".tsx", ".vue", ".map", ".key", ".pem", ".p12", ".pfx"})
_SOURCE_ONLY_NAMES = frozenset(
    {"package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "uv.lock", "pyproject.toml"}
)


def _assert_publishable_file_path(path: str) -> None:
    name = Path(path).name
    if (
        any(segment in _SOURCE_ONLY_SEGMENTS for segment in path.split("/"))
        or name in _SOURCE_ONLY_NAMES
        or Path(path).suffix.lower() in _SOURCE_ONLY_SUFFIXES
        or name.startswith(".env")
    ):
        raise PackageError(f"archive entry is source-only or secret material: {path}")


class PackageError(ValueError):
    """Raised when an archive is not a valid plugin package."""


class DuplicateJsonKeyError(ValueError):
    """Raised when a manifest object repeats a JSON key."""


def _reject_duplicate_json_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise DuplicateJsonKeyError(f"duplicate JSON object key: {key}")
        result[key] = value
    return result


def _assert_safe_archive_path(path: str, kind: ArchivePathKind) -> str:
    canonical = canonical_archive_path(path, kind)
    if canonical is None:
        raise PackageError(f"unsafe archive entry path: {path}")
    return canonical


def _validate_archive_entries(
    infos: list[zipfile.ZipInfo],
) -> list[tuple[zipfile.ZipInfo, str, str]]:
    seen: set[str] = set()
    regular_paths: set[str] = set()
    ancestor_paths: set[str] = set()
    validated: list[tuple[zipfile.ZipInfo, str, str]] = []
    for info in infos:
        kind = _archive_entry_type(info)
        if kind == "directory":
            archive_kind: ArchivePathKind = "directory"
        elif kind == "regular":
            archive_kind = "regular"
        else:
            raise PackageError(f"archive entry is not a regular file: {info.filename}")
        path = _assert_safe_archive_path(info.filename, archive_kind)
        collision_key = portable_archive_collision_key(path)
        if collision_key is None:
            raise PackageError(f"unsafe archive entry path: {info.filename}")
        if collision_key in _HOST_OWNED_ARCHIVE_NAMES:
            raise PackageError(f"archive entry is Host-owned: {path}")
        if collision_key in seen:
            raise PackageError(f"duplicate archive entry: {path}")
        seen.add(collision_key)
        if kind == "regular":
            regular_paths.add(collision_key)
        segments = collision_key.split("/")
        ancestor_paths.update(
            "/".join(segments[:index]) for index in range(1, len(segments))
        )
        validated.append((info, path, kind))
    for path in regular_paths:
        if path in ancestor_paths:
            raise PackageError(
                f"archive path collides with regular file ancestor: {path}"
            )
    return validated


def _archive_entry_type(info: zipfile.ZipInfo) -> str:
    """Classify archive metadata; this is not proof of symlink authenticity."""
    mode = ((info.external_attr >> 16) & 0xFFFF) if info.create_system == 3 else 0
    file_type = stat.S_IFMT(mode)
    if info.create_system == 3 and file_type not in (0, stat.S_IFREG, stat.S_IFDIR):
        return "special"
    if info.create_system == 3 and file_type == stat.S_IFDIR:
        return "directory"
    if info.filename.endswith("/") or (
        info.create_system != 3 and (info.external_attr & 0x10) != 0
    ):
        return "directory"
    return "regular"


def _archive_entry_is_executable(info: zipfile.ZipInfo) -> bool:
    if info.create_system != 3:
        return False
    mode = (info.external_attr >> 16) & 0xFFFF
    return stat.S_IFMT(mode) in (0, stat.S_IFREG) and bool(mode & 0o111)


def _starts_with_executable_shebang(data: bytes) -> bool:
    return data.startswith(b"#!") or data.startswith(b"\xef\xbb\xbf#!")


def _has_zip64_end_of_central_directory(data: bytes) -> bool:
    marker = b"PK\x05\x06"
    offset = data.rfind(marker)
    if offset < 0 or len(data) - offset < 22:
        return False
    entries_on_disk = int.from_bytes(data[offset + 8 : offset + 10], "little")
    entry_count = int.from_bytes(data[offset + 10 : offset + 12], "little")
    central_directory_size = int.from_bytes(data[offset + 12 : offset + 16], "little")
    central_directory_offset = int.from_bytes(data[offset + 16 : offset + 20], "little")
    return (
        entries_on_disk == 0xFFFF
        or entry_count == 0xFFFF
        or central_directory_size == 0xFFFFFFFF
        or central_directory_offset == 0xFFFFFFFF
    )


def _check_archive_layout(data: bytes, infos: list[zipfile.ZipInfo]) -> None:
    """Refuse archives the Host reader would parse differently.

    The Host (src/main/plugins/pluginPackage.ts) walks the central directory by
    the EOCD entry count from the raw EOCD offset, while zipfile walks it by
    size and shifts every offset by any data placed before the archive. Both
    agree only when the directory ends exactly at the EOCD record and holds the
    counted entries. zipfile compares a local header's name with the central
    one only for entries it reads, so every local name is checked here.
    """
    eocd = data.rfind(b"PK\x05\x06")
    entry_count = int.from_bytes(data[eocd + 10 : eocd + 12], "little")
    central_directory_size = int.from_bytes(data[eocd + 12 : eocd + 16], "little")
    central_directory_offset = int.from_bytes(data[eocd + 16 : eocd + 20], "little")
    if central_directory_offset + central_directory_size != eocd or entry_count != len(infos):
        raise PackageError(
            "central directory does not end at the end-of-central-directory record"
        )
    for info in infos:
        offset = info.header_offset
        name_length = int.from_bytes(data[offset + 26 : offset + 28], "little")
        local_name = data[offset + 30 : offset + 30 + name_length]
        encoding = "utf-8" if info.flag_bits & 0x800 else "cp437"
        if (
            data[offset : offset + 4] != b"PK\x03\x04"
            or local_name != info.orig_filename.encode(encoding)
        ):
            raise PackageError(
                f"local header name does not match central directory: {info.filename}"
            )


@dataclass(frozen=True)
class AssetRef:
    """A non-manifest file inside the package."""

    path: str
    size: int
    content_type: str


@dataclass
class LoadedPackage:
    manifest: ManifestLike
    digest: str
    """sha256 hex digest of the raw package bytes."""
    assets: list[AssetRef] = field(default_factory=list)
    raw: bytes = b""


def _validate_artifact_target(manifest: ManifestLike, target: str) -> None:
    if is_manifest_v2(manifest) and manifest.backend is not None:
        if target == "universal" or "-" not in target:
            raise PackageError(
                "backend package target must be one exact platform-architecture target"
            )
    elif target != "universal":
        raise PackageError("frontend-only package target must be universal")


def _backend_matches_target(data: bytes, target: str) -> bool:
    platform, architecture = target.split("-", 1)
    if platform == "linux":
        if len(data) < 20 or data[:4] != b"\x7fELF" or data[5] not in (1, 2):
            return False
        endian = "little" if data[5] == 1 else "big"
        machine = int.from_bytes(data[18:20], endian)
        return (architecture == "x64" and data[4] == 2 and machine == 62) or (
            architecture == "arm64" and data[4] == 2 and machine == 183
        )
    if platform == "win32":
        if len(data) < 0x40 or data[:2] != b"MZ":
            return False
        offset = int.from_bytes(data[0x3C:0x40], "little")
        if offset + 6 > len(data) or data[offset : offset + 4] != b"PE\0\0":
            return False
        machine = int.from_bytes(data[offset + 4 : offset + 6], "little")
        return (architecture == "x64" and machine == 0x8664) or (
            architecture == "arm64" and machine == 0xAA64
        )
    if platform != "darwin" or len(data) < 8 or int.from_bytes(data[:4], "little") != 0xFEEDFACF:
        return False
    cpu_type = int.from_bytes(data[4:8], "little")
    return (architecture == "x64" and cpu_type == 0x01000007) or (
        architecture == "arm64" and cpu_type == 0x0100000C
    )


def backend_entry_for_target(entry: str, target: str | None) -> str:
    """The archive file a manifest's `backend.entry` names for `target`.

    Mirrors the Host's `backendEntryOnDisk` (src/main/plugins/pluginManifest.ts):
    a package ships one manifest for every platform, so the entry is written
    without an extension, and for a Windows target a bare entry names the
    `.exe` beside it. Every other target, and no target, reads it as written.
    """
    if target is None or not target.startswith("win32-"):
        return entry
    if posixpath.splitext(entry)[1] != "":
        return entry
    return f"{entry}.exe"


def read_package(data: bytes, *, target: str | None = None) -> LoadedPackage:
    """Parse and validate a `.vsix`-style archive.

    Rejects malformed archives with a clear PackageError. `target` is the
    Registry target the package is published for; it only decides which file
    the manifest's backend entry names (see `backend_entry_for_target`).
    """
    if not zipfile.is_zipfile(BytesIO(data)):
        raise PackageError("package is not a valid ZIP archive")
    if _has_zip64_end_of_central_directory(data):
        raise PackageError("ZIP64 archives are not supported")

    with zipfile.ZipFile(BytesIO(data)) as zf:
        infos = zf.infolist()
        _check_archive_layout(data, infos)
        total_size = 0
        for info in infos:
            if info.file_size > MAX_ENTRY_SIZE:
                raise PackageError(f"archive entry exceeds the 50 MiB size limit: {info.filename}")
            total_size += info.file_size
            if total_size > MAX_ARCHIVE_SIZE:
                raise PackageError("archive expanded contents exceed the 200 MiB size limit")
        validated_entries = _validate_archive_entries(infos)
        entry_types = {path: kind for _info, path, kind in validated_entries}
        regular_names = {
            path for path, kind in entry_types.items() if kind == "regular"
        }
        if MANIFEST_NAME not in regular_names:
            raise PackageError(f"archive is missing {MANIFEST_NAME} at its root")

        entry_bytes: dict[str, bytes] = {}
        actual_total_size = 0
        for info, path, kind in validated_entries:
            if kind != "regular":
                continue
            try:
                content = zf.read(info)
            except (KeyError, RuntimeError, zipfile.BadZipFile) as exc:
                raise PackageError(f"cannot read archive entry: {path}") from exc
            if len(content) > MAX_ENTRY_SIZE:
                raise PackageError(f"archive entry exceeds the 50 MiB size limit: {path}")
            actual_total_size += len(content)
            if actual_total_size > MAX_ARCHIVE_SIZE:
                raise PackageError("archive expanded contents exceed the 200 MiB size limit")
            if len(content) != info.file_size:
                raise PackageError(f"archive entry size does not match metadata: {path}")
            entry_bytes[path] = content

        manifest_bytes = entry_bytes[MANIFEST_NAME]

        try:
            manifest_text = manifest_bytes.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise PackageError(f"{MANIFEST_NAME} is not valid JSON: {exc}") from exc
        if manifest_text.startswith("\ufeff"):
            raise PackageError(f"{MANIFEST_NAME} must not contain UTF-8 BOM")
        try:
            manifest_data = json.loads(
                manifest_text, object_pairs_hook=_reject_duplicate_json_keys
            )
        except (DuplicateJsonKeyError, json.JSONDecodeError) as exc:
            raise PackageError(f"{MANIFEST_NAME} is not valid JSON: {exc}") from exc

        if not isinstance(manifest_data, dict):
            raise PackageError(f"{MANIFEST_NAME} must be a JSON object")

        try:
            manifest = parse_manifest(manifest_data)
        except ManifestError as exc:
            raise PackageError(f"invalid manifest: {exc}") from exc
        if target is not None:
            _validate_artifact_target(manifest, target)

        file_names = regular_names
        if is_manifest_v2(manifest):
            for path in file_names - {MANIFEST_NAME}:
                _assert_publishable_file_path(path)
            backend_entry = (
                manifest.backend.entry if manifest.backend is not None else None
            )
            for path in manifest_referenced_files(manifest):
                if path == backend_entry:
                    path = backend_entry_for_target(path, target)
                if path not in file_names:
                    raise PackageError(
                        f"manifest referenced file '{path}' is not present in the archive"
                    )
            frontend_entries = [path for path in file_names if path.startswith("frontend/")]
            backend_entries = [path for path in file_names if path.startswith("backend/")]
            if manifest.contributes is None and frontend_entries:
                raise PackageError("backend-only package must not contain frontend entries")
            if manifest.backend is None and backend_entries:
                raise PackageError("frontend-only package must not contain backend entries")
            if manifest.backend is not None:
                backend_path = backend_entry_for_target(manifest.backend.entry, target)
                if len(backend_entries) != 1 or backend_entries[0] != backend_path:
                    raise PackageError(
                        "backend package must contain exactly its declared self-contained backend executable"
                    )
                backend_info = next(
                    info
                    for info, path, kind in validated_entries
                    if path == backend_path and kind == "regular"
                )
                backend_data = entry_bytes[backend_path]
                if not backend_data:
                    raise PackageError(f"backend entry is empty: {backend_path}")
                # A Windows target has no exec bit to set; there, as on the Host,
                # the `.exe` extension stands in for it.
                executable = (
                    posixpath.splitext(backend_path)[1].lower() == ".exe"
                    if target is not None and target.startswith("win32-")
                    else _archive_entry_is_executable(backend_info)
                )
                if not executable:
                    raise PackageError(
                        f"backend entry is not marked executable: {backend_path}"
                    )
                if _starts_with_executable_shebang(backend_data):
                    raise PackageError(
                        "backend entry must be a packaged executable, "
                        f"not a raw script: {backend_path}"
                    )
                if target is not None and not _backend_matches_target(backend_data, target):
                    raise PackageError(
                        f"backend entry does not match declared target {target}: {backend_path}"
                    )
        elif manifest.icon and entry_types.get(manifest.icon) != "regular":
            raise PackageError(
                f"manifest.icon '{manifest.icon}' is not present in the archive"
            )

        assets: list[AssetRef] = []
        for info, path, kind in validated_entries:
            if kind != "regular" or path == MANIFEST_NAME:
                continue
            content_type = mimetypes.guess_type(path)[0] or "application/octet-stream"
            assets.append(
                AssetRef(
                    path=path,
                    size=len(entry_bytes[path]),
                    content_type=content_type,
                )
            )

    digest = hashlib.sha256(data).hexdigest()
    return LoadedPackage(
        manifest=manifest,
        digest=digest,
        assets=sorted(assets, key=lambda a: a.path),
        raw=data,
    )


def build_package(src_dir: Path | str, files: list[str], *, target: str | None = None) -> bytes:
    """Build a `.vsix`-style ZIP from a plugin source directory.

    Zips the caller's explicit canonical file list, then validates the result
    via `read_package` so a build that the reader would reject fails here.
    """
    root = Path(src_dir)
    manifest_path = root / MANIFEST_NAME
    if not manifest_path.is_file():
        raise PackageError(f"{MANIFEST_NAME} not found in {root}")

    if not files:
        raise PackageError("canonical file list is empty")
    resolved_root = root.resolve()
    paths: list[tuple[str, Path]] = []
    total_size = 0
    for file in files:
        canonical = canonical_archive_path(file, "regular")
        if canonical is None:
            raise PackageError(f"unsafe canonical file list entry: {file}")
        path = resolved_root / canonical
        cursor = resolved_root
        for index, segment in enumerate(canonical.split("/")):
            cursor = cursor / segment
            entry = cursor.lstat()
            if stat.S_ISLNK(entry.st_mode):
                raise PackageError(f"canonical file list entry contains a symlink: {file}")
            if index < len(canonical.split("/")) - 1 and not stat.S_ISDIR(entry.st_mode):
                raise PackageError(f"canonical file list entry has a non-directory ancestor: {file}")
        if not path.is_file():
            raise PackageError(f"canonical file list entry is not a regular file: {file}")
        size = path.stat().st_size
        if size > MAX_ENTRY_SIZE:
            raise PackageError(f"canonical file list entry exceeds the 50 MiB size limit: {file}")
        total_size += size
        if total_size > MAX_ARCHIVE_SIZE:
            raise PackageError("canonical file list exceeds the 200 MiB size limit")
        paths.append((canonical, path))
    if MANIFEST_NAME not in files:
        raise PackageError("canonical file list must include manifest.json")
    buffer = BytesIO()
    # Deflated (method 8) with a pinned level: fixed timestamps, modes, and
    # compression level keep one canonical file list reproducible, so the signed
    # digest the builder records can be rebuilt. The SDK's `makeZip` applies the
    # same method and level; matching byte-for-byte across the two also depends on
    # their zlib implementations.
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for arcname, path in sorted(paths):
            info = zipfile.ZipInfo(arcname, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            mode = 0o755 if arcname.startswith("backend/") else 0o644
            info.external_attr = (stat.S_IFREG | mode) << 16
            info.flag_bits = 0x800
            info.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(info, path.read_bytes(), compresslevel=9)
    data = buffer.getvalue()
    # Validate the built archive (also surfaces a bad manifest early).
    read_package(data, target=target)
    return data

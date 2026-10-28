"""Filesystem service — safe, workspace-rooted directory listing + CRUD.

Backs the Explorer pane. Every operation is resolved relative to
``workspace_path`` and must stay inside it; the internal ``.agent-team`` dir is
protected, and high-noise dirs (node_modules / .git / …) are flagged so the UI
can avoid auto-expanding them. This is NOT a gitignore filter — real on-disk
contents are listed; git status is only an overlay decided elsewhere.
"""

from __future__ import annotations

import base64
import logging
import os
import tarfile
import zipfile
from pathlib import Path
from typing import Any

import mammoth
import openpyxl
from send2trash import send2trash

try:
    import chardet as _chardet
    _HAVE_CHARDET = True
except ImportError:
    _HAVE_CHARDET = False

from .path_guard import (
    PROJECT_DIR_NAME,
    _ALLOWED_AGENT_TEAM_SUBDIRS,
    _READABLE_AGENT_TEAM_SUBDIRS,
    FsError,
    _internal_dir_index,
    _reject_protected_internal_dir,
    _resolve_safe,
    _same_path,
)
from .fs_write import (  # noqa: F401 - re-exported: fs_service is the write path's public home
    _ENC_DISPLAY,
    _ENC_FROM_LABEL,
    _STAGING_MAX_AGE_S,
    _STAGING_NAME_RE,
    _UPLOAD_ID_RE,
    _WRITE_PART_MAX_BYTES,
    _WRITE_SIZE_LIMIT,
    _resolve_mutation_safe,
    _staging_path,
    _sweep_stale_staging,
    write_abort,
    write_commit,
    write_file,
    write_part,
)

_log = logging.getLogger(__name__)

# High-noise dirs the UI should not auto-expand (performance, NOT gitignore).
# Mirrors git_watcher._IGNORE_SEGMENTS, plus `.git`.
_NOISE_SEGMENTS = frozenset({
    "node_modules", ".venv", "venv", "__pycache__", "dist", "build", "out",
    "target", ".next", ".nuxt", ".turbo", ".cache", ".mypy_cache",
    ".pytest_cache", ".ruff_cache", ".idea", ".gradle", ".git",
})

_MAX_DIR_ENTRIES = 2_000  # cap to avoid hanging on huge dirs (e.g. node_modules)
_MAX_DIRECTORY_ENTRIES = _MAX_DIR_ENTRIES


def _reject_git_internal_tree(target: Path) -> None:
    """Reject moving/removing a directory that contains a nested Git dir."""
    if not target.is_dir():
        return
    try:
        if any(child.name == ".git" for child in target.rglob(".git")):
            raise FsError("the Git internal directory is protected")
    except OSError as exc:
        raise FsError("cannot verify Git internal directory protection") from exc


def _entry(root: Path, parent: Path, name: str, is_dir: bool) -> dict[str, Any]:
    child = parent / name
    return {
        "name": name,
        "rel_path": str(child.relative_to(root)),
        "is_dir": is_dir,
        "is_hidden": name.startswith("."),
        # Noise dirs are shown as nodes but the UI should not auto-expand them.
        "is_noise": is_dir and name in _NOISE_SEGMENTS,
    }


def list_dir(
    workspace_path: str,
    rel_path: str = "",
    show_hidden: bool = False,
    mode: str = "display",
) -> dict[str, Any]:
    """List a single directory level (lazy; never recurses).

    mode="display":
        Dirs first, then files, each alphabetical. Dotfiles are excluded unless
        ``show_hidden`` is True — including ``.agent-team``, which is surfaced as a
        normal hidden dir but shows only its user-facing ``plans/``, ``reports/``
        and ``mockups/`` subtrees; the rest of its contents (the live SQLite database,
        logs, migration leftovers) stay unlistable and unopenable.
    mode="discovery":
        Strict 4-step sequence for plan root discovery:
        1. Directory candidates only (de.is_dir())
        2. Filter hidden entries and noise segments
        3. Sort by UTF-8 bytes ascending order
        4. Cap at _MAX_DIR_ENTRIES (2000) with truncated=True
    """
    if mode not in ("display", "discovery"):
        return {"ok": False, "error": "invalid list_dir mode"}

    try:
        target = _resolve_safe(workspace_path, rel_path, allow_internal_root=True, allow_mockups=True)
    except FsError as exc:
        return {"ok": False, "error": str(exc)}
    if not target.is_dir():
        return {"ok": False, "error": "not a directory"}

    root = Path(workspace_path).resolve()
    entries: list[dict[str, Any]] = []
    truncated = False
    try:
        if mode == "discovery":
            with os.scandir(target) as it:
                candidates = [
                    de
                    for de in it
                    if de.is_dir()
                    and not de.name.startswith(".")
                    and de.name not in _NOISE_SEGMENTS
                ]
            candidates.sort(key=lambda de: de.name.encode("utf-8"))
            if len(candidates) > _MAX_DIR_ENTRIES:
                candidates = candidates[:_MAX_DIR_ENTRIES]
                truncated = True
            internal_root = root / PROJECT_DIR_NAME
            for de in candidates:
                name = de.name
                if _same_path(target, internal_root) and name not in _READABLE_AGENT_TEAM_SUBDIRS:
                    continue
                entries.append(_entry(root, target, name, True))
        else:
            # os.scandir() caches is_dir() from the readdir result — no extra stat() per entry.
            with os.scandir(target) as it:
                scan = sorted(it, key=lambda e: (not e.is_dir(), e.name.lower()))
            if len(scan) > _MAX_DIR_ENTRIES:
                scan = scan[:_MAX_DIR_ENTRIES]
                truncated = True
            internal_root = root / PROJECT_DIR_NAME
            for de in scan:
                name = de.name
                if _same_path(target, internal_root) and name not in _READABLE_AGENT_TEAM_SUBDIRS:
                    continue  # internal state — only the user-facing subtrees show
                if name.startswith(".") and not show_hidden:
                    continue
                entries.append(_entry(root, target, name, de.is_dir()))
    except OSError as exc:
        return {"ok": False, "error": str(exc)}
    result: dict[str, Any] = {
        "ok": True,
        "entries": entries,
        "rel_path": str(target.relative_to(root)) if target != root else "",
    }
    if truncated:
        result["truncated"] = True
    return result


def list_files_flat(
    workspace_path: str,
    query: str = "",
    max_results: int = 100,
) -> dict[str, Any]:
    """Return a flat list of file rel_paths matching *query* (case-insensitive substring).

    A query with a path separator (``/`` or ``\\``) matches against the
    relative path, so a pasted ``app/Services/Foo.php`` finds its file; any
    other query matches the file name only. Exact matches sort first.

    Skips noise directories, hidden files, and binary-ish extensions.
    Used by the AI chat @file autocomplete.
    """
    root = Path(workspace_path).resolve()
    if not root.is_dir():
        return {"ok": False, "error": "workspace not found"}
    lower_q = query.lower().replace("\\", "/")
    path_q = "/" in lower_q
    if path_q:
        lower_q = lower_q.removeprefix("./").lstrip("/")
    results: list[str] = []
    exact: list[str] = []
    _BINARY_EXT = {".png", ".jpg", ".jpeg", ".gif", ".ico", ".svg", ".woff", ".woff2",
                   ".ttf", ".eot", ".mp4", ".mp3", ".zip", ".gz", ".tar", ".pdf", ".bin",
                   ".lock", ".pyc"}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in _NOISE_SEGMENTS and not d.startswith(".")]
        for fn in sorted(filenames):
            if fn.startswith("."):
                continue
            if Path(fn).suffix.lower() in _BINARY_EXT:
                continue
            if not path_q and lower_q and lower_q not in fn.lower():
                continue
            fp = Path(dirpath) / fn
            try:
                rel = str(fp.relative_to(root))
            except ValueError:
                continue
            if path_q:
                rel_key = rel.lower().replace("\\", "/")
                if lower_q not in rel_key:
                    continue
                is_exact = rel_key == lower_q or rel_key.endswith("/" + lower_q)
            else:
                is_exact = fn.lower() == lower_q
            (exact if is_exact else results).append(rel)
            if len(exact) + len(results) >= max_results:
                return {"ok": True, "files": exact + results, "truncated": True}
    return {"ok": True, "files": exact + results, "truncated": False}


def glob_files(
    workspace_path: str,
    pattern: str,
    max_results: int = 50,
) -> dict[str, Any]:
    """Return rel_paths matching *pattern* (glob) under the workspace root.

    Noise directories are excluded. At most *max_results* files are returned.
    """
    root = Path(workspace_path).resolve()
    if not root.is_dir():
        return {"ok": False, "error": "workspace not found"}
    if not pattern:
        return {"ok": False, "error": "pattern required"}
    # Reject patterns with .. components or absolute paths to prevent traversal.
    pattern_parts = pattern.replace("\\", "/").split("/")
    if ".." in pattern_parts or pattern.startswith("/") or pattern.startswith("\\"):
        return {"ok": False, "error": "invalid pattern"}

    _BINARY_EXT = {".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2",
                   ".ttf", ".eot", ".mp4", ".mp3", ".zip", ".gz", ".tar", ".pdf",
                   ".bin", ".lock", ".pyc"}
    root_str = str(root) + os.sep
    try:
        matches: list[str] = []
        for fp in sorted(root.glob(pattern)):
            if not fp.is_file():
                continue
            # Verify the resolved path stays inside the workspace (guards symlinks).
            try:
                real = fp.resolve(strict=True)
            except OSError:
                continue
            if not (str(real) == str(root) or str(real).startswith(root_str)):
                continue
            # skip noise dirs inside the match
            parts = fp.relative_to(root).parts
            if any(p in _NOISE_SEGMENTS or p.startswith(".") for p in parts[:-1]):
                continue
            if fp.suffix.lower() in _BINARY_EXT:
                continue
            matches.append(str(fp.relative_to(root)))
            if len(matches) >= max_results:
                return {"ok": True, "files": matches, "truncated": True}
        return {"ok": True, "files": matches, "truncated": False}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def mkdir(workspace_path: str, rel_path: str) -> dict[str, Any]:
    try:
        target = _resolve_mutation_safe(workspace_path, rel_path)
        if target == Path(workspace_path).resolve():
            raise FsError("invalid name")
        if target.exists():
            raise FsError("already exists")
        target.mkdir(parents=True, exist_ok=False)
    except (FsError, OSError) as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True}


def create_file(workspace_path: str, rel_path: str, content: str = "") -> dict[str, Any]:
    try:
        target = _resolve_mutation_safe(workspace_path, rel_path)
        if target == Path(workspace_path).resolve():
            raise FsError("invalid name")
        if target.exists():
            raise FsError("already exists")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
    except (FsError, OSError) as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True}


def rename(workspace_path: str, src_rel: str, dst_rel: str) -> dict[str, Any]:
    try:
        src = _resolve_mutation_safe(workspace_path, src_rel)
        dst = _resolve_mutation_safe(workspace_path, dst_rel)
        if src == Path(workspace_path).resolve():
            raise FsError("cannot rename the workspace root")
        _reject_git_internal_tree(src)
        _reject_git_internal_tree(dst)
        if src == dst:
            raise FsError("source and destination are the same path")
        if not src.exists():
            raise FsError("source not found")
        if dst.exists():
            raise FsError("destination already exists")
        dst.parent.mkdir(parents=True, exist_ok=True)
        src.rename(dst)
    except (FsError, OSError) as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True}


_BINARY_EXTENSIONS = {
    # Images
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico", ".tiff", ".tif", ".svg",
    ".avif", ".heic", ".heif", ".raw",
    # Audio / Video
    ".mp3", ".mp4", ".wav", ".ogg", ".flac", ".aac", ".m4a", ".webm", ".mkv", ".avi",
    ".mov", ".wmv",
    # Fonts
    ".ttf", ".otf", ".woff", ".woff2", ".eot",
    # Archives / compiled
    ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar", ".jar", ".war", ".ear",
    ".pyc", ".pyo", ".class", ".so", ".dylib", ".dll", ".exe", ".bin", ".a", ".o",
    # Documents
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
    # Database
    ".db", ".sqlite", ".sqlite3",
}

_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico", ".svg", ".avif"}

_ENCODINGS_TO_TRY = [
    "utf-8-sig",   # UTF-8 with BOM  (must come before utf-8)
    "utf-16",      # UTF-16 with BOM (auto-detects LE/BE)
    "utf-8",
    "latin-1",     # always succeeds — last resort for Western text
]


def _detect_encoding(raw: bytes) -> str:
    """Return the best encoding guess for *raw* bytes."""
    if _HAVE_CHARDET:
        result = _chardet.detect(raw[:65536])
        enc = (result.get("encoding") or "").lower().replace("-", "_")
        confidence = result.get("confidence", 0) or 0
        if enc and confidence >= 0.70:
            # Normalise common aliases
            enc = {
                "ascii": "utf_8",
                "utf_8_sig": "utf_8_sig",
                "utf_16_le": "utf_16",
                "utf_16_be": "utf_16",
                "iso_8859_1": "latin_1",
                "windows_1252": "cp1252",
                "windows_1251": "cp1251",
                "gb2312": "gb2312",
                "gbk": "gbk",
                "big5": "big5",
                "shift_jis": "shift_jis",
                "euc_jp": "euc_jp",
                "euc_kr": "euc_kr",
            }.get(enc, enc)
            return enc
    # BOM detection fallback
    if raw[:3] == b"\xef\xbb\xbf":
        return "utf_8_sig"
    if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return "utf_16"
    return "utf_8"


def _is_binary_content(raw: bytes) -> bool:
    """Heuristic: if > 0.3% of first 8 KB are null bytes, treat as binary."""
    sample = raw[:8192]
    if not sample:
        return False
    null_count = sample.count(b"\x00")
    return null_count / len(sample) > 0.003


_READ_SIZE_LIMIT = 5 * 1024 * 1024  # 5 MB — cap editor reads; bigger payloads stall WS serialization


# Directories whose documents are plan/report documents (same set as
# plan_index.PLAN_DOC_DIRS; fs_service must not import plan_index).
_PLAN_DOC_DIRS = (
    ".agent-team/plans",
    ".agent-team/reports",
    ".claude/loop-reports",
    ".claude/plans",
    ".cursor/plans",
    "docs/plans",
    "docs/reports",
)


def is_plan_document_path(rel_path: str) -> bool:
    """Whether ``rel_path`` names a plan/report document (by location and name).

    Plan documents are the one kind of file exempt from the editor read limit:
    a report with embedded screenshots is legitimately several MB and must open.
    """
    if not isinstance(rel_path, str):
        return False
    parts = rel_path.replace("\\", "/").split("/")
    name = parts[-1]
    if (
        name.startswith(("_", "."))
        or not name.lower().endswith((".html", ".plan.md", ".md"))
        or any(part in ("", ".", "..") for part in parts)
        or len(parts) < 3
    ):
        return False
    return "/".join(parts[-3:-1]) in _PLAN_DOC_DIRS


def is_plan_document(workspace_path: str, rel_path: str) -> bool:
    """:func:`is_plan_document_path` for the path as written AND as resolved.

    A symlink inside a plans directory that points at some other file in the
    workspace is not a plan document: the real location decides, so it keeps
    the normal read limit.
    """
    if not is_plan_document_path(rel_path):
        return False
    try:
        real = _resolve_safe(workspace_path, rel_path, allow_mockups=True)
        rel_real = real.relative_to(Path(workspace_path).resolve())
    except (FsError, OSError, ValueError):
        return False
    return is_plan_document_path(rel_real.as_posix())


def read_file(
    workspace_path: str,
    rel_path: str,
    encoding_override: str | None = None,
    size_limit: int | None = _READ_SIZE_LIMIT,
) -> dict[str, Any]:
    """Read a file, auto-detecting encoding.

    ``size_limit`` is the largest file returned (None: no limit); the default
    is the editor read limit.

    If *encoding_override* is given, skip detection and decode with that codec.


    Returns:
        ok=True  → {"ok": True, "content": str, "encoding": str, "bom": bool,
                     "mtime": float}
        ok=False → {"ok": False, "error": str, "is_binary": bool,
                     "size": int, "ext": str}
    """
    try:
        target = _resolve_safe(workspace_path, rel_path, allow_mockups=True)
        if not target.is_file():
            raise FsError("not a file")
        st = target.stat()
        size = st.st_size
        ext = target.suffix.lower()

        # Fast-path: known binary extension
        if ext in _BINARY_EXTENSIONS:
            return {
                "ok": False,
                "error": "binary file",
                "is_binary": True,
                "is_image": ext in _IMAGE_EXTENSIONS,
                "size": size,
                "ext": ext,
            }

        if size_limit is not None and size > size_limit:
            return {
                "ok": False,
                "error": f"file too large ({size / (1024 * 1024):.1f} MB > 5 MB)",
                "is_binary": False,
                "size": size,
                "ext": ext,
            }

        raw = target.read_bytes()

        # Heuristic binary check
        if _is_binary_content(raw):
            return {
                "ok": False,
                "error": "binary file",
                "is_binary": True,
                "is_image": False,
                "size": size,
                "ext": ext,
            }

        # Encoding detection + decode
        if encoding_override:
            detected = encoding_override.replace("-", "_").lower()
        else:
            detected = _detect_encoding(raw)
        bom = detected in ("utf_8_sig", "utf_16")

        # Try detected encoding first, then fallbacks
        order = [detected] + ([e for e in _ENCODINGS_TO_TRY if e.replace("-", "_") != detected.replace("-", "_")] if not encoding_override else [])
        content: str | None = None
        used_enc = detected
        for enc in order:
            try:
                content = raw.decode(enc)
                used_enc = enc
                break
            except (UnicodeDecodeError, LookupError):
                continue

        if content is None:
            # latin-1 never fails — absolute last resort
            content = raw.decode("latin-1", errors="replace")
            used_enc = "latin-1"

        enc_label = _ENC_DISPLAY.get(used_enc.replace("-", "_"), used_enc.upper())

        return {
            "ok": True, "content": content, "encoding": enc_label, "bom": bom,
            "mtime": st.st_mtime,
        }

    except (FsError, OSError) as exc:
        return {"ok": False, "error": str(exc), "is_binary": False, "size": 0, "ext": ""}


# Per-call ceiling for read_range. This bounds one response's memory, not the
# file: callers page through a file of any size with successive offsets.
_READ_RANGE_MAX_BYTES = 1024 * 1024


def read_range(workspace_path: str, rel_path: str, offset: int, length: int) -> dict[str, Any]:
    """Read ``length`` raw bytes of a file starting at byte ``offset``.

    Unlike :func:`read_file` there is no whole-file size limit, no binary
    sniffing and no decoding: the caller pages through the file and owns the
    decode. Used for plan documents, which must open at any size.

    Returns:
        ok=True  -> {"ok": True, "data_base64": str, "offset": int,
                     "size": int, "mtime": float, "eof": bool}
        ok=False -> {"ok": False, "error": str}
    """
    try:
        if (
            isinstance(offset, bool) or isinstance(length, bool)
            or not isinstance(offset, int) or not isinstance(length, int)
            or offset < 0 or not 0 < length <= _READ_RANGE_MAX_BYTES
        ):
            raise FsError("invalid range")
        target = _resolve_safe(workspace_path, rel_path, allow_mockups=True)
        if not target.is_file():
            raise FsError("not a file")
        with target.open("rb") as handle:
            st = os.fstat(handle.fileno())
            handle.seek(offset)
            data = handle.read(length)
        return {
            "ok": True,
            "data_base64": base64.b64encode(data).decode("ascii"),
            "offset": offset,
            "size": st.st_size,
            "mtime": st.st_mtime,
            "eof": offset + len(data) >= st.st_size,
        }
    except (FsError, OSError) as exc:
        return {"ok": False, "error": str(exc)}


# MIME type per image extension. The renderer renders the returned data URL in
# an <img>, which works in dev (http origin) and prod (file:// origin) alike —
# unlike a raw file:// src, which webSecurity blocks from the dev http origin.
_IMAGE_MIME: dict[str, str] = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".bmp": "image/bmp", ".webp": "image/webp",
    ".ico": "image/x-icon", ".svg": "image/svg+xml", ".avif": "image/avif",
}


_IMAGE_SIZE_LIMIT = 20 * 1024 * 1024  # 20 MB — cap previews; base64+WS framing of bigger blobs stalls the app


def read_image(workspace_path: str, rel_path: str) -> dict[str, Any]:
    """Read an image file and return it as a base64 ``data:`` URL.

    Returns:
        ok=True  → {"ok": True, "data_url": str, "mime": str, "size": int}
        ok=False → {"ok": False, "error": str}

    Rejects non-image extensions and images larger than 20 MB.
    """
    try:
        target = _resolve_safe(workspace_path, rel_path, allow_mockups=True)
        if not target.is_file():
            raise FsError("not a file")
        ext = target.suffix.lower()
        mime = _IMAGE_MIME.get(ext)
        if mime is None:
            return {"ok": False, "error": "not an image"}
        size = target.stat().st_size
        if size > _IMAGE_SIZE_LIMIT:
            return {"ok": False, "error": f"image too large ({size / (1024 * 1024):.1f} MB > 20 MB)"}
        b64 = base64.b64encode(target.read_bytes()).decode("ascii")
        return {"ok": True, "data_url": f"data:{mime};base64,{b64}", "mime": mime, "size": size}
    except (FsError, OSError) as exc:
        return {"ok": False, "error": str(exc)}


_ARCHIVE_SIZE_LIMIT = 100 * 1024 * 1024  # 100 MB — cap archive listing reads
_ARCHIVE_MAX_ENTRIES = 2_000  # cap entries returned per archive listing


def list_archive(workspace_path: str, rel_path: str) -> dict[str, Any]:
    """List entries of a .zip / .tar / .tar.gz / .tgz archive.

    Returns:
        ok=True  → {"ok": True, "entries": [{"name", "size", "is_dir"}],
                     "total_entries": int, "truncated": bool}
        ok=False → {"ok": False, "error": str}

    At most 2000 entries are returned (truncated=True beyond that); archives
    larger than 100 MB are rejected.
    """
    try:
        target = _resolve_safe(workspace_path, rel_path, allow_mockups=True)
        if not target.is_file():
            raise FsError("not a file")
        size = target.stat().st_size
        if size > _ARCHIVE_SIZE_LIMIT:
            return {"ok": False, "error": f"archive too large ({size / (1024 * 1024):.1f} MB > 100 MB)"}

        name = target.name.lower()
        entries: list[dict[str, Any]] = []
        total = 0
        if name.endswith(".zip"):
            with zipfile.ZipFile(target) as zf:
                for info in zf.infolist():
                    if info.flag_bits & 0x1:
                        return {"ok": False, "error": "archive is encrypted"}
                    total += 1
                    if len(entries) < _ARCHIVE_MAX_ENTRIES:
                        entries.append({
                            "name": info.filename,
                            "size": info.file_size,
                            "is_dir": info.is_dir(),
                        })
        elif name.endswith((".tar", ".tar.gz", ".tgz")):
            with tarfile.open(target, "r:*") as tf:
                for member in tf:
                    total += 1
                    if len(entries) < _ARCHIVE_MAX_ENTRIES:
                        entries.append({
                            "name": member.name,
                            "size": member.size,
                            "is_dir": member.isdir(),
                        })
        else:
            return {"ok": False, "error": "unsupported archive type (expected .zip, .tar, .tar.gz or .tgz)"}
        return {
            "ok": True,
            "entries": entries,
            "total_entries": total,
            "truncated": total > len(entries),
        }
    except (FsError, OSError) as exc:
        return {"ok": False, "error": str(exc)}
    except (zipfile.BadZipFile, tarfile.TarError) as exc:
        return {"ok": False, "error": f"corrupted archive: {exc}"}


_OFFICE_SIZE_LIMIT = 10 * 1024 * 1024  # 10 MB — cap office conversion reads
_XLSX_MAX_ROWS = 1_000  # per sheet
_XLSX_MAX_COLS = 100  # per row


def convert_office(workspace_path: str, rel_path: str) -> dict[str, Any]:
    """Convert an office document for preview.

    Returns:
        .docx → {"ok": True, "kind": "docx", "html": str}  (mammoth)
        .xlsx → {"ok": True, "kind": "xlsx",
                  "sheets": [{"name", "rows": list[list[str]], "truncated"}]}
                 (openpyxl read-only; 1000 rows × 100 cols per sheet)
        ok=False → {"ok": False, "error": str}

    Files larger than 10 MB are rejected.
    """
    try:
        target = _resolve_safe(workspace_path, rel_path, allow_mockups=True)
        if not target.is_file():
            raise FsError("not a file")
        size = target.stat().st_size
        if size > _OFFICE_SIZE_LIMIT:
            return {"ok": False, "error": f"file too large ({size / (1024 * 1024):.1f} MB > 10 MB)"}
        ext = target.suffix.lower()
    except (FsError, OSError) as exc:
        return {"ok": False, "error": str(exc)}

    if ext == ".docx":
        try:
            with target.open("rb") as fh:
                result = mammoth.convert_to_html(fh)
        except Exception as exc:  # noqa: BLE001 — mammoth raises many zip/xml error types
            return {"ok": False, "error": f"cannot convert docx: {exc}"}
        return {"ok": True, "kind": "docx", "html": result.value}

    if ext == ".xlsx":
        wb = None
        try:
            wb = openpyxl.load_workbook(target, read_only=True, data_only=True)
            sheets: list[dict[str, Any]] = []
            for sheet in wb.worksheets:
                rows: list[list[str]] = []
                truncated = False
                for row in sheet.iter_rows(values_only=True):
                    if len(rows) >= _XLSX_MAX_ROWS:
                        truncated = True
                        break
                    if len(row) > _XLSX_MAX_COLS:
                        truncated = True
                        row = row[:_XLSX_MAX_COLS]
                    rows.append(["" if cell is None else str(cell) for cell in row])
                sheets.append({"name": sheet.title, "rows": rows, "truncated": truncated})
        except Exception as exc:  # noqa: BLE001 — openpyxl raises many zip/xml error types
            return {"ok": False, "error": f"cannot read xlsx: {exc}"}
        finally:
            if wb is not None:
                wb.close()
        return {"ok": True, "kind": "xlsx", "sheets": sheets}

    return {"ok": False, "error": "unsupported office file type (expected .docx or .xlsx)"}


def stat_path(abs_path: str) -> dict[str, Any]:
    """Check whether an absolute filesystem path exists as a regular file.

    Intentionally bypasses the workspace restriction — terminal output may
    reference files anywhere on disk (e.g. system libraries, other projects).
    Read-only: no content is returned, only existence.
    """
    try:
        # expanduser: terminal output often prints '~/...' paths verbatim.
        p = Path(abs_path).expanduser().resolve()
        return {"ok": True, "exists": p.is_file()}
    except Exception:
        return {"ok": True, "exists": False}


def stat_workspace_path(workspace_path: str, rel_path: str = "") -> dict[str, Any]:
    """Return metadata for a path resolved through the workspace guard.

    The absolute ``stat_path`` endpoint is intentionally retained for terminal
    output.  Plans and other Host-bound callers must use this scoped variant so
    the workspace root and the relative path are validated together.
    """
    try:
        target = _resolve_safe(workspace_path, rel_path, allow_internal_root=True, allow_mockups=True)
        if not target.exists():
            return {
                "ok": True,
                "exists": False,
                "is_directory": False,
                "size": 0,
            }
        entry = target.stat()
        return {
            "ok": True,
            "exists": True,
            "is_directory": target.is_dir(),
            "size": entry.st_size,
            "mtime": entry.st_mtime,
        }
    except FileNotFoundError:
        return {
            "ok": True,
            "exists": False,
            "is_directory": False,
            "size": 0,
        }
    except (FsError, OSError) as exc:
        return {
            "ok": False,
            "exists": False,
            "is_directory": False,
            "size": 0,
            "error": str(exc),
        }


def delete(workspace_path: str, rel_path: str) -> dict[str, Any]:
    """Move a file or directory (including non-empty ones) to the OS Trash.

    Recoverable by design: an accidental delete can be restored from the
    system Trash/Recycle Bin instead of being gone forever. If the trash is
    unavailable, leave the original in place and return an error.
    """
    try:
        target = _resolve_mutation_safe(workspace_path, rel_path)
        if target == Path(workspace_path).resolve():
            raise FsError("cannot delete the workspace root")
        _reject_git_internal_tree(target)
        if not target.exists():
            raise FsError("not found")
        try:
            send2trash(str(target))
        except Exception as trash_exc:  # noqa: BLE001 -- log any trash failure before propagating
            _log.warning(
                "send2trash failed for %s (%s); keeping original",
                target,
                trash_exc,
            )
            raise
    except (FsError, OSError) as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True}

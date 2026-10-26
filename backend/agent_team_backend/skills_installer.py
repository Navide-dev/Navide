"""Bounded, owner-bound skill previews and add-only installation.

Previews contain immutable bytes in memory and expire on backend restart.
Nothing in a downloaded skill is executed by this module.
"""
from __future__ import annotations

import hashlib
import copy
from datetime import datetime, timezone
import gzip
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import tarfile
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
import uuid

from . import osplat
from .skills_store import SkillValidationError, SkillsStore, _safe_relative, _validate_bundle_paths

MAX_FILES = SkillsStore.MAX_INSTALL_FILES
MAX_FILE_BYTES = SkillsStore.INSTALL_FILE_LIMIT
MAX_TOTAL_BYTES = SkillsStore.INSTALL_TOTAL_LIMIT
MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024
MAX_ARCHIVE_BYTES = 128 * 1024 * 1024
MAX_ARCHIVE_ENTRIES = 4096
MAX_PREVIEWS = 8
#: A fixed budget, not MAX_PREVIEWS full-size skills: eight 32 MiB previews
#: would pin a quarter gigabyte of backend memory for fifteen minutes.
MAX_CACHE_BYTES = 64 * 1024 * 1024
PREVIEW_TTL = 15 * 60

#: Repository housekeeping a source may carry but a skill never needs. They are
#: left out of the installation and listed in the preview; every other dotfile
#: (the .navide marker above all) still refuses the whole source.
EXCLUDED_FILES = {".gitignore", ".gitkeep", ".DS_Store"}
EXCLUDED_DIRS = {".git", ".github"}

#: Skills that ship with Navide itself, offered as ``navide:<folder>`` through
#: the same preview, approval and install path as any other source.
BUNDLED_PREFIX = "navide:"
BUNDLED_ROOT = Path(__file__).resolve().parent / "bundled_skills"
_BUNDLED_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _download(url: str, limit: int) -> bytes:
    """Use public endpoints without GitHub credentials; reject redirects.

    Standard urllib proxy settings still apply to the connection.
    """
    try:
        with build_opener(_NoRedirect()).open(
            Request(url, headers={"User-Agent": "Navide-Skills", "Accept": "application/vnd.github+json"}),
            timeout=20,
        ) as response:
            data = response.read(limit + 1)
    except (HTTPError, URLError, OSError) as exc:
        raise SkillValidationError("public GitHub source could not be fetched") from exc
    if len(data) > limit:
        raise SkillValidationError("download exceeds size limit")
    return data


def _bundled_root(source: str) -> Path:
    """The shipped folder a ``navide:<folder>`` source names; nothing else resolves."""
    name = source[len(BUNDLED_PREFIX):]
    root = BUNDLED_ROOT / name
    if not _BUNDLED_NAME_RE.fullmatch(name) or root.is_symlink() or not (root / "SKILL.md").is_file():
        raise SkillValidationError(f"unknown Navide-bundled skill: {source}")
    return root


def _check_path(relative: str) -> str:
    safe = _safe_relative(relative)
    if safe is None or ":" in relative:
        raise SkillValidationError(f"unsafe skill path: {relative}")
    filename = PurePosixPath(safe).name.lower()
    if filename in {"auth.json", "credentials.json", "credentials", "id_rsa", "id_ed25519"} or filename.endswith((".pem", ".key", ".p12", ".pfx")):
        raise SkillValidationError(f"credential-like file is not installable: {relative}")
    return safe


def _exclusion(relative: str) -> dict | None:
    """The preview entry for a path that is left out, or None to keep it."""
    parts = relative.split("/")
    for index, part in enumerate(parts[:-1]):
        if part in EXCLUDED_DIRS:
            return {"path": "/".join(parts[:index + 1]) + "/", "reason": "repository metadata"}
    if parts[-1] in EXCLUDED_DIRS:
        return {"path": relative + "/", "reason": "repository metadata"}
    if parts[-1] in EXCLUDED_FILES:
        return {"path": relative, "reason": "repository housekeeping file"}
    return None


def _exclude(files: dict) -> tuple[dict, list[dict]]:
    """Split ``files`` into what installs and what is left out (one entry per excluded folder)."""
    kept, excluded = {}, {}
    for path, entry in files.items():
        reason = _exclusion(path)
        if reason is None:
            kept[path] = entry
        else:
            excluded.setdefault(reason["path"], reason)
    return kept, [excluded[key] for key in sorted(excluded)]


def _manifest(files: dict) -> list[dict]:
    return [
        {"path": path, "size": len(entry["data"]),
         "digest": hashlib.sha256(entry["data"]).hexdigest(),
         "executable": entry["executable"],
         "script": entry["data"].startswith(b"#!") or PurePosixPath(path).suffix.lower() in {
             ".sh", ".bash", ".zsh", ".fish", ".py", ".js", ".mjs", ".cjs", ".ts",
             ".ps1", ".bat", ".cmd", ".rb", ".pl", ".php",
         }}
        for path, entry in sorted(files.items())
    ]


def _digest(files: dict) -> str:
    return hashlib.sha256(json.dumps(_manifest(files), sort_keys=True).encode()).hexdigest()


class SkillInstaller:
    def __init__(self, store: SkillsStore) -> None:
        # Immutable memory staging needs no directory or shared-root writes.
        self.store = store
        self._previews: dict[str, dict] = {}
        self._lock = threading.RLock()

    def _expire(self) -> None:
        now = time.time()
        for key, value in list(self._previews.items()):
            if value["expires_at"] <= now:
                value["timer"].cancel()
                self._previews.pop(key)

    def _drop_preview(self, preview_id: str) -> None:
        with self._lock:
            self._previews.pop(preview_id, None)

    def preview(self, source: str, *, owner_key: str, ref: str = "", subdir: str = "") -> dict:
        if not isinstance(source, str) or not source or not isinstance(owner_key, str) or not owner_key:
            raise SkillValidationError("source and owner_key are required")
        if not isinstance(ref, str) or not isinstance(subdir, str):
            raise SkillValidationError("ref and subdir must be strings")
        # Refuse a full cache before fetching anything; the check under the
        # lock below is the one that counts, this one just saves a download.
        with self._lock:
            self._expire()
            self._check_preview_count()
        # Fetching and reading happen outside the lock: a GitHub download can
        # sit on a slow socket for up to 40s, and every other caller —
        # install(), a local preview — would otherwise wait on it, each
        # pinning a thread of the shared to_thread pool meanwhile.
        if re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", source):
            source = "https://github.com/" + source
        if source.startswith(BUNDLED_PREFIX):
            if ref or subdir:
                raise SkillValidationError("a Navide-bundled skill takes no ref or subdir")
            files, excluded = self._local(_bundled_root(source))
            origin = {"kind": "bundled", "name": source[len(BUNDLED_PREFIX):]}
        elif source.startswith("https://"):
            files, origin = self._github(source, ref, subdir)
            if files is None:
                return origin
            files, excluded = _exclude(files)
        else:
            if ref or subdir:
                raise SkillValidationError("local source must name the skill folder directly")
            local_root = Path(source).expanduser()
            if not local_root.is_absolute():
                raise SkillValidationError("local source must be an absolute skill folder path")
            files, excluded = self._local(local_root)
            origin = {"kind": "local", "path": str(Path(source).expanduser().absolute())}
        self._validate(files)
        fields, _ = self.store._parse_skill_file(files["SKILL.md"]["data"].decode("utf-8"))
        total = sum(len(item["data"]) for item in files.values())
        warnings = ["Shared-root readers can discover this skill regardless of Navide delivery targets.",
                    "Preview expires after 15 minutes or backend restart. No skill code has been executed."]
        if any(entry["script"] or entry["executable"] for entry in _manifest(files)):
            warnings.append("The package contains scripts or executable files; review them before installation.")
        if any(entry["executable"] for entry in files.values()) and osplat.platform_id == "win32":
            warnings.append("Windows does not preserve POSIX executable permission bits.")
        if excluded:
            warnings.append(f"{len(excluded)} repository metadata item(s) will not be installed; see excluded.")
        with self._lock:
            # Recounted here: other previews may have landed during the fetch.
            self._expire()
            self._check_preview_count()
            if sum(record["size"] for record in self._previews.values()) + total > MAX_CACHE_BYTES:
                raise SkillValidationError("preview cache size limit reached")
            preview_id = uuid.uuid4().hex
            result = {"preview_id": preview_id, "digest": _digest(files), "name": fields["name"],
                      "source": origin, "files": _manifest(files), "excluded": excluded,
                      "skill_md": files["SKILL.md"]["data"].decode("utf-8"),
                      "warnings": warnings, "expires_at": time.time() + PREVIEW_TTL,
                      "prepared_at": datetime.now(timezone.utc).isoformat()}
            self._previews[preview_id] = {**result, "owner": owner_key, "bundle": files, "size": total, "result": None}
            timer = threading.Timer(PREVIEW_TTL, self._drop_preview, args=(preview_id,))
            timer.daemon = True
            self._previews[preview_id]["timer"] = timer
            timer.start()
            return copy.deepcopy(result)

    def _check_preview_count(self) -> None:
        """Caller holds the lock."""
        if sum(record["result"] is None for record in self._previews.values()) >= MAX_PREVIEWS:
            raise SkillValidationError("too many active previews; wait for expiry")

    def peek(self, preview_id: str, expected_digest: str, *, owner_key: str,
             targets: list[str] | None) -> dict:
        """Check a preview without writing: {"receipt": ...} once installed, else {"preview": ...}."""
        with self._lock:
            self._expire()
            record = self._previews.get(preview_id)
            if record is None:
                raise SkillValidationError("preview missing or expired; create a new preview")
            if record["owner"] != owner_key or record["digest"] != expected_digest:
                raise SkillValidationError("preview owner or digest mismatch")
            if record["result"] is not None:
                if targets != record["installed_targets"]:
                    raise SkillValidationError("preview already installed with different targets; use delivery settings")
                return {"receipt": copy.deepcopy({**record["result"], "changed": False})}
            keys = ("preview_id", "digest", "name", "source", "files", "excluded", "skill_md",
                    "warnings", "expires_at", "prepared_at")
            return {"preview": copy.deepcopy({key: record[key] for key in keys})}

    def install(self, preview_id: str, expected_digest: str, *, owner_key: str,
                targets: list[str] | None, consent: bool = False) -> dict:
        with self._lock:
            self._expire()
            record = self._previews.get(preview_id)
            if record is None:
                raise SkillValidationError("preview missing or expired; create a new preview")
            if record["owner"] != owner_key or record["digest"] != expected_digest:
                raise SkillValidationError("preview owner or digest mismatch")
            if record["result"] is not None:
                if targets != record["installed_targets"]:
                    raise SkillValidationError("preview already installed with different targets; use delivery settings")
                return copy.deepcopy({**record["result"], "changed": False})
            result = self.store.install_bundle(
                record["name"], record["bundle"], targets=targets, consent=consent,
                provenance={"source": record["source"], "digest": record["digest"],
                            "schema_version": 1, "prepared_at": record["prepared_at"]},
            )
            record["installed_targets"] = copy.deepcopy(targets)
            record["result"] = {**result, "source": record["source"], "digest": record["digest"]}
            record.pop("bundle")
            record.pop("skill_md")
            record["size"] = 0
            # Receipt age starts at successful installation, which may occur
            # in a different order than preparation. Keep the original expiry.
            self._previews.pop(preview_id)
            self._previews[preview_id] = record
            receipts = [key for key, value in self._previews.items() if value["result"] is not None]
            for key in receipts[:-MAX_PREVIEWS]:
                self._previews.pop(key)["timer"].cancel()
            return copy.deepcopy(record["result"])

    def _validate(self, files: dict) -> None:
        _validate_bundle_paths(files)
        if "SKILL.md" not in files:
            raise SkillValidationError("selected folder must contain SKILL.md")
        if len(files) > MAX_FILES or sum(len(entry["data"]) for entry in files.values()) > MAX_TOTAL_BYTES:
            raise SkillValidationError("skill exceeds file count or total size limit")
        for path, entry in files.items():
            _check_path(path)
            if len(entry["data"]) > MAX_FILE_BYTES:
                raise SkillValidationError("skill file exceeds size limit")
        try:
            fields, _ = self.store._parse_skill_file(files["SKILL.md"]["data"].decode("utf-8"))
            if not isinstance(fields.get("description"), str) or not fields["description"].strip():
                raise SkillValidationError("installed skills require a nonempty description")
        except UnicodeDecodeError as exc:
            raise SkillValidationError("SKILL.md must be UTF-8") from exc

    def _local(self, root: Path) -> dict:
        if root.is_symlink() or not root.is_dir():
            raise SkillValidationError("local source must be a regular skill directory")
        files = {}
        excluded = []
        total = 0
        entries = 0
        snapshots = {}
        def signature(info):
            return (info.st_dev, info.st_ino, info.st_mode, info.st_size,
                    info.st_mtime_ns, info.st_ctime_ns)

        def unreadable_directory(error):
            raise SkillValidationError("could not read source directory") from error

        for directory, dirs, names in os.walk(root, followlinks=False, onerror=unreadable_directory):
            directory_path = Path(directory)
            info = directory_path.lstat()
            if not stat.S_ISDIR(info.st_mode):
                raise SkillValidationError("source changed while reading")
            snapshots[directory_path] = signature(info)
            for name in dirs + names:
                path = Path(directory) / name
                relative = path.relative_to(root).as_posix()
                # Checked before lstat or read: a clone's .git is never walked.
                reason = _exclusion(relative)
                if reason is not None:
                    excluded.append(reason)
                    if name in dirs:
                        dirs.remove(name)
                    continue
                entries += 1
                if entries > MAX_ARCHIVE_ENTRIES:
                    raise SkillValidationError("source exceeds entry limit")
                _check_path(relative)
                info = path.lstat()
                if stat.S_ISDIR(info.st_mode):
                    continue
                if not stat.S_ISREG(info.st_mode):
                    raise SkillValidationError("symlinks and special files are not installable")
                if len(files) >= MAX_FILES or info.st_size > MAX_FILE_BYTES:
                    raise SkillValidationError("skill exceeds file count or size limit")
                flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
                with os.fdopen(os.open(path, flags), "rb") as handle:
                    opened = os.fstat(handle.fileno())
                    if not stat.S_ISREG(opened.st_mode) or (info.st_dev, info.st_ino) != (opened.st_dev, opened.st_ino):
                        raise SkillValidationError("source changed while reading")
                    data = handle.read(MAX_FILE_BYTES + 1)
                    # Compare handle metadata with itself: Windows path and
                    # handle queries can represent timestamps/mode differently.
                    if signature(opened) != signature(os.fstat(handle.fileno())):
                        raise SkillValidationError("source changed while reading")
                total += len(data)
                if len(data) > MAX_FILE_BYTES or total > MAX_TOTAL_BYTES:
                    raise SkillValidationError("skill exceeds size limit")
                files[relative] = {"data": data, "executable": bool(info.st_mode & 0o111)}
                snapshots[path] = signature(info)
        if any(signature(path.lstat()) != expected for path, expected in snapshots.items()):
            raise SkillValidationError("source changed while reading")
        return files, sorted(excluded, key=lambda item: item["path"])

    def _github(self, source: str, ref: str, subdir: str) -> tuple[dict | None, dict]:
        url = urlsplit(source)
        match = re.fullmatch(r"/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)/?", url.path)
        if url.netloc != "github.com" or url.query or url.fragment or not match:
            raise SkillValidationError("source must be a public https://github.com/owner/repo URL")
        owner, repo = match.groups()
        repo = repo.removesuffix(".git")
        if owner in {".", ".."} or repo in {"", ".", ".."}:
            raise SkillValidationError("invalid GitHub repository")
        root_selected = subdir == "."
        if subdir and not root_selected:
            if subdir.startswith("/") or any(part in {"", ".", ".."} or "\\" in part or ":" in part or "\x00" in part for part in subdir.split("/")):
                raise SkillValidationError("unsafe source subdir")
        try:
            metadata = json.loads(_download(f"https://api.github.com/repos/{owner}/{repo}/commits/{quote(ref or 'HEAD', safe='')}", MAX_FILE_BYTES))
            commit = metadata["sha"]
        except (ValueError, KeyError, TypeError) as exc:
            raise SkillValidationError("invalid GitHub commit response") from exc
        if not isinstance(commit, str) or not re.fullmatch(r"[0-9a-f]{40}", commit):
            raise SkillValidationError("GitHub source did not resolve to a commit")
        archive = _download(f"https://codeload.github.com/{owner}/{repo}/tar.gz/{commit}", MAX_DOWNLOAD_BYTES)
        all_files = {}
        directories = set()
        entries = set()
        total = 0
        archive_root = None
        try:
            # Bound decompression before tarfile parses PAX headers as well as
            # file entries; declared member sizes alone do not bound metadata.
            with gzip.GzipFile(fileobj=io.BytesIO(archive)) as compressed:
                unpacked = compressed.read(MAX_ARCHIVE_BYTES + 1)
            if len(unpacked) > MAX_ARCHIVE_BYTES:
                raise SkillValidationError("archive expands beyond size limit")
            with tarfile.open(fileobj=io.BytesIO(unpacked), mode="r:") as tar:
                for index, member in enumerate(tar):
                    if index >= MAX_ARCHIVE_ENTRIES:
                        raise SkillValidationError("archive exceeds entry limit")
                    parts = member.name.rstrip("/").split("/")
                    if any(part in {"", ".", ".."} or "\\" in part or ":" in part or "\x00" in part for part in parts):
                        raise SkillValidationError("unsafe archive path")
                    if archive_root is None:
                        archive_root = parts[0]
                    if parts[0] != archive_root or not (member.isdir() or member.isfile()):
                        raise SkillValidationError("archive contains special files or multiple roots")
                    normalized = "/".join(parts)
                    if normalized in entries:
                        raise SkillValidationError("duplicate archive entry")
                    entries.add(normalized)
                    relative = "/".join(parts[1:])
                    if member.isdir():
                        if relative:
                            directories.add(relative)
                        continue
                    total += member.size
                    if member.size > MAX_ARCHIVE_BYTES or total > MAX_ARCHIVE_BYTES:
                        raise SkillValidationError("archive expands beyond size limit")
                    if not relative or relative in all_files:
                        raise SkillValidationError("duplicate or invalid archive file")
                    handle = tar.extractfile(member)
                    if handle is None:
                        raise SkillValidationError("unreadable archive file")
                    all_files[relative] = {"data": handle.read(MAX_ARCHIVE_BYTES + 1), "executable": bool(member.mode & 0o111)}
        except (tarfile.TarError, EOFError, OSError) as exc:
            raise SkillValidationError("invalid skill archive") from exc
        _validate_bundle_paths(all_files, directories=directories, allow_hidden=True)
        candidates = sorted(path.removesuffix("SKILL.md").rstrip("/") for path in all_files
                            if PurePosixPath(path).name == "SKILL.md" and _exclusion(path) is None)
        origin = {"kind": "github", "repository": f"{owner}/{repo}", "commit": commit}
        if ref:
            origin["requested_ref"] = ref
        if not subdir:
            if not candidates:
                raise SkillValidationError("repository contains no SKILL.md")
            if len(candidates) > 1:
                summaries = []
                for candidate in candidates:
                    prefix = candidate + "/" if candidate else ""
                    selected, _ = _exclude({path[len(prefix):]: value for path, value in all_files.items() if path.startswith(prefix)})
                    summary = {"path": candidate or "."}
                    try:
                        self._validate(selected)
                        fields, _ = self.store._parse_skill_file(selected["SKILL.md"]["data"].decode("utf-8"))
                        summary.update(name=fields["name"], description=fields["description"])
                    except SkillValidationError as exc:
                        summary["error"] = str(exc)
                    summaries.append(summary)
                return None, {"candidates": summaries, "source": origin, "selection_required": True}
            subdir = candidates[0]
        elif root_selected:
            subdir = ""
        prefix = subdir + "/" if subdir else ""
        files = {path[len(prefix):]: value for path, value in all_files.items() if path.startswith(prefix)}
        return files, {**origin, "subdir": subdir}

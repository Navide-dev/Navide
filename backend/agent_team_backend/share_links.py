"""Share links: one file, encrypted here, readable by whoever holds the URL.

    https://share.navide.dev/s/<linkId>#k=<base64url 32-byte key>

The key K is minted per link and lives only in the URL fragment, which a
browser never sends. What the server stores is the object encrypted under K,
and K itself wrapped under the account key ring (``sync_keyring.wrap_aux``),
so any device of the account can rebuild the URL and the server cannot.

Object format (the viewer page decrypts it with WebCrypto)::

    object  = header ‖ segment*
    header  = "NVL1" ‖ kind code (1) ‖ version (4, big-endian)
    segment = nonce (12) ‖ AES-256-GCM(plaintext ≤ 1 MiB) ‖ tag (16)
    AAD     = header ‖ segment index (4, big-endian) ‖ is-last (1)

Every segment binds the header, its position and whether it is the last one,
so an object cannot be relabelled, reordered or cut short.

Creating a link: check the path and the kind, mask the content
(``share_scan``), encrypt, ask the server for a row and an upload URL, PUT
the object, then commit the wrapped key and the wrapped metadata. The server
assigns the link id, and the key and metadata are wrapped for that id, so
they travel at commit rather than at create. The server calls themselves are
behind ``LinksClient``; the WebSocket implementation lives with the rest of
the Navide-Server calls.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import struct
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Protocol
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from . import share_scan, sync_keyring

SHARE_BASE = "https://share.navide.dev"

MAGIC = b"NVL1"
HEADER_LEN = len(MAGIC) + 1 + 4
SEGMENT_SIZE = 1024 * 1024
_NONCE_LEN = 12
SEGMENT_OVERHEAD = _NONCE_LEN + 16
KEY_LEN = 32
#: Largest file shared as one object; one presigned PUT, no multipart.
MAX_PLAINTEXT = 32 * 1024 * 1024
MAX_TTL_DAYS = 30

_HTTP_TIMEOUT_S = 60


@dataclass(frozen=True)
class KindSpec:
    code: int  # the header byte; the viewer picks its renderer by it
    ttl_days: int
    require_login: bool
    suffixes: tuple[str, ...]
    folders: tuple[tuple[str, ...], ...]  # the file must sit directly in one of these


#: Phase 1 kinds. A kind not listed here cannot be shared at all.
KINDS: dict[str, KindSpec] = {
    "plan": KindSpec(1, 7, False, (".html", ".plan.md"), ((".agent-team", "plans"), (".cursor", "plans"))),
    "report": KindSpec(2, 7, False, (".html",), ((".agent-team", "plans"), ("docs", "reports"))),
}
_KIND_BY_CODE = {spec.code: name for name, spec in KINDS.items()}

_PLAN_META_RE = re.compile(r'<script id="plan-meta" type="application/json">(.*?)</script>', re.DOTALL)


class ShareError(Exception):
    """A share link could not be built, uploaded or opened."""


class ShareRefused(ShareError):
    """This file, kind or option is never shared; ``code`` says which rule."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class LinksClient(Protocol):
    """The Navide-Server ``links.*`` calls this module needs."""

    def create(self, *, kind: str, size_bytes: int, ttl_days: int, require_login: bool, created_by: str) -> dict:
        """A new row in state ``uploading``: ``{linkId, uploadUrl, expiresAt}``."""
        ...

    def commit(self, *, link_id: str, wrapped_key: str, kid: str, meta_enc: str) -> dict:
        """Mark the uploaded object live, storing the wrapped key and metadata."""
        ...


# ---- object format ----------------------------------------------------------------


def new_key() -> bytes:
    return os.urandom(KEY_LEN)


def _header(kind: str, version: int) -> bytes:
    return MAGIC + bytes([KINDS[kind].code]) + struct.pack(">I", version)


def _segment_aad(header: bytes, index: int, last: bool) -> bytes:
    return header + struct.pack(">I", index) + (b"\x01" if last else b"\x00")


def encrypt_object(plaintext: bytes, key: bytes, *, kind: str, version: int) -> bytes:
    header = _header(kind, version)
    chunks = [plaintext[i : i + SEGMENT_SIZE] for i in range(0, len(plaintext), SEGMENT_SIZE)] or [b""]
    aead = AESGCM(key)
    out = [header]
    for index, chunk in enumerate(chunks):
        nonce = os.urandom(_NONCE_LEN)
        out.append(nonce + aead.encrypt(nonce, chunk, _segment_aad(header, index, index == len(chunks) - 1)))
    return b"".join(out)


def decrypt_object(blob: bytes, key: bytes) -> tuple[str, int, bytes]:
    """(kind, version, plaintext) of an object sealed by ``encrypt_object``."""
    if len(blob) < HEADER_LEN + SEGMENT_OVERHEAD or blob[:4] != MAGIC:
        raise ShareError("not a share-link object")
    header = blob[:HEADER_LEN]
    kind = _KIND_BY_CODE.get(header[4])
    if kind is None:
        raise ShareError("unknown kind in the share-link header")
    (version,) = struct.unpack(">I", header[5:9])
    body = blob[HEADER_LEN:]
    step = SEGMENT_SIZE + SEGMENT_OVERHEAD
    starts = list(range(0, len(body), step))
    aead = AESGCM(key)
    out = []
    for index, start in enumerate(starts):
        sealed = body[start : start + step]
        if len(sealed) < SEGMENT_OVERHEAD:
            raise ShareError(f"segment {index} is too short")
        try:
            out.append(aead.decrypt(sealed[:_NONCE_LEN], sealed[_NONCE_LEN:],
                                    _segment_aad(header, index, index == len(starts) - 1)))
        except Exception as err:  # noqa: BLE001 - cryptography raises a bare InvalidTag
            raise ShareError(f"segment {index} did not open") from err
    return kind, version, b"".join(out)


def link_url(link_id: str, key: bytes, base: str = SHARE_BASE) -> str:
    fragment = base64.urlsafe_b64encode(key).rstrip(b"=").decode("ascii")
    return f"{base}/s/{link_id}#k={fragment}"


def key_label(link_id: str, version: int) -> str:
    return f"link:{link_id}:v{version}"


def meta_label(link_id: str) -> str:
    return f"link-meta:{link_id}"


# ---- preparing ----------------------------------------------------------------------


@dataclass(frozen=True)
class Prepared:
    kind: str
    path: Path
    text: str  # masked
    findings: list[share_scan.Finding]
    title: str
    sha256: str  # of the masked text, i.e. of what was published


def _source_ok(real: Path, spec: KindSpec) -> bool:
    if not real.name.endswith(spec.suffixes):
        return False
    parent = tuple(real.parent.parts)
    return any(parent[-len(folder):] == folder for folder in spec.folders)


def _title(text: str, path: Path) -> str:
    m = _PLAN_META_RE.search(text)
    if m:
        try:
            name = json.loads(m.group(1)).get("name")
        except (ValueError, AttributeError):
            name = None
        if isinstance(name, str) and name.strip():
            return name.strip()
    return path.name


def prepare(raw_path: str, kind: str) -> Prepared:
    """The masked content of ``raw_path`` as ``kind``, or ``ShareRefused``."""
    spec = KINDS.get(kind)
    if spec is None:
        raise ShareRefused("unknown_kind", f"'{kind}' cannot be shared.")
    refused = share_scan.refusal(raw_path)
    if refused is not None:
        raise ShareRefused(refused.code, refused.message)
    real = Path(raw_path).resolve()
    if not _source_ok(real, spec):
        raise ShareRefused("kind_source", f"This file is not a {kind} document.")
    if real.stat().st_size > MAX_PLAINTEXT:
        raise ShareRefused("too_large", f"Files over {MAX_PLAINTEXT // (1024 * 1024)} MiB cannot be shared.")
    try:
        text = real.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as err:
        raise ShareRefused("unreadable", "The file could not be read as UTF-8 text.") from err
    result = share_scan.scan(text, kind=kind)
    return Prepared(
        kind=kind,
        path=real,
        text=result.text,
        findings=result.findings,
        title=_title(result.text, real),
        sha256=hashlib.sha256(result.text.encode("utf-8")).hexdigest(),
    )


# ---- creating -------------------------------------------------------------------------


@dataclass(frozen=True)
class Created:
    link_id: str
    url: str
    expires_at: str
    findings: list[share_scan.Finding]


def _http_put(url: str, data: bytes) -> None:
    req = Request(url, data=data, method="PUT", headers={"Content-Type": "application/octet-stream"})
    try:
        with urlopen(req, timeout=_HTTP_TIMEOUT_S) as resp:  # noqa: S310 - a presigned https URL from the server
            if not 200 <= resp.status < 300:
                raise ShareError(f"upload failed with HTTP {resp.status}")
    except HTTPError as err:
        raise ShareError(f"upload failed with HTTP {err.code}") from err
    except URLError as err:
        raise ShareError(f"upload failed: {err.reason}") from err


def _kid_of(wrapped: str) -> str:
    """The key id inside a ``wrap_aux`` envelope (bytes 1–8)."""
    return base64.b64decode(wrapped)[1:9].hex()


def create_share(
    client: LinksClient,
    raw_path: str,
    kind: str,
    *,
    ttl_days: int | None = None,
    require_login: bool | None = None,
    created_by: str = "user",
    pane: str = "",
    agent: str = "",
    put: Callable[[str, bytes], None] = _http_put,
) -> Created:
    prepared = prepare(raw_path, kind)
    spec = KINDS[kind]
    ttl = spec.ttl_days if ttl_days is None else ttl_days
    if not 1 <= ttl <= MAX_TTL_DAYS:
        raise ShareRefused("ttl", f"A link lasts between 1 and {MAX_TTL_DAYS} days.")
    if sync_keyring.account_key() is None:
        raise sync_keyring.KeyringError("this machine has no sync key yet")

    key = new_key()
    blob = encrypt_object(prepared.text.encode("utf-8"), key, kind=kind, version=1)
    row = client.create(
        kind=kind,
        size_bytes=len(blob),
        ttl_days=ttl,
        require_login=spec.require_login if require_login is None else require_login,
        created_by=created_by,
    )
    link_id = row["linkId"]
    put(row["uploadUrl"], blob)
    meta: dict[str, Any] = {
        "title": prepared.title,
        "path": str(prepared.path),
        "sha256": prepared.sha256,
        "createdBy": created_by,
        "pane": pane,
        "agent": agent,
        "masked": [{"line": f.line, "category": f.category, "action": f.action} for f in prepared.findings],
    }
    wrapped = sync_keyring.wrap_aux(key_label(link_id, 1), key)
    client.commit(
        link_id=link_id,
        wrapped_key=wrapped,
        kid=_kid_of(wrapped),
        meta_enc=sync_keyring.wrap_aux(meta_label(link_id), json.dumps(meta).encode("utf-8")),
    )
    return Created(link_id, link_url(link_id, key), row.get("expiresAt", ""), prepared.findings)

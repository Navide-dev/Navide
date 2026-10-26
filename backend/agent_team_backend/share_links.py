"""Share links: one file, encrypted here, readable by whoever holds the URL.

    https://share.navide.dev/s/<linkId>#k=<base64url 32-byte key>

The key K is minted per link and lives only in the URL fragment, which a
browser never sends. What the server stores is the object encrypted under K,
and K itself wrapped under the account key ring (``sync_keyring.wrap_aux``),
so any device of the account can rebuild the URL and the server cannot.

Object format (the viewer page decrypts it with WebCrypto)::

    object  = header ‖ segment*
    header  = "NVL1" ‖ kind code (1) ‖ version (4, big-endian) ‖ object id (16)
    segment = nonce (12) ‖ AES-256-GCM(plaintext ≤ 1 MiB) ‖ tag (16)
    AAD     = header ‖ segment index (4, big-endian) ‖ is-last (1)

Every segment binds the header, its position and whether it is the last one,
so an object cannot be relabelled, reordered or cut short; the random object
id in the header keeps two objects sealed under the same key from being
spliced together. ``version`` is the link's *content* version (1 at create,
+1 per content update), not a format version — the format is the magic.
The kind byte is ``KIND_CODES``, the table the viewer page decodes with.

Creating a link: check the path and the kind, mask the content
(``share_scan``), encrypt, ask the server for a row and an upload URL, PUT
the object, then commit the wrapped key and the wrapped metadata. The server
assigns the link id, and the key and metadata are wrapped for that id, so
they travel at commit rather than at create. The server calls themselves are
behind ``LinksClient``; the WebSocket implementation lives with the rest of
the Navide-Server calls.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
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

log = logging.getLogger("agent_team_backend.share_links")

SHARE_BASE = "https://share.navide.dev"

MAGIC = b"NVL1"
_OBJECT_ID_LEN = 16
HEADER_LEN = len(MAGIC) + 1 + 4 + _OBJECT_ID_LEN
SEGMENT_SIZE = 1024 * 1024
_NONCE_LEN = 12
SEGMENT_OVERHEAD = _NONCE_LEN + 16
KEY_LEN = 32
#: Largest file shared as one object; one presigned PUT, no multipart.
MAX_PLAINTEXT = 32 * 1024 * 1024
#: The server's range for a link's lifetime (links.caps), in seconds; the
#: minimum is the upload URL's lifetime.
MIN_TTL_SECONDS = 900
MAX_TTL_SECONDS = 30 * 86400
#: The server's cap on the wrapped metadata, so a page of links.list fits a frame.
MAX_META_CHARS = 8 * 1024

_HTTP_TIMEOUT_S = 60
#: What a server-assigned link id may look like before it goes into a URL or a label.
_LINK_ID_RE = re.compile(r"[A-Za-z0-9_-]{22,64}")

#: The kind byte of every kind the format knows, shipped or not. Shared with
#: the viewer page (Navide-Server share-web/), which must decode the same
#: table; a code is never reused for another kind, so 6 (a kind that was
#: dropped before it shipped) stays unassigned.
KIND_CODES: dict[str, int] = {
    "plan": 1, "report": 2, "pdf": 3, "preview": 4, "image": 5, "bundle": 7,
}


@dataclass(frozen=True)
class KindSpec:
    code: int  # the header byte; the viewer picks its renderer by it
    ttl_days: int
    require_login: bool
    suffixes: tuple[str, ...]
    folders: tuple[tuple[str, ...], ...]  # the file must sit directly in one of these


#: Phase 1 kinds. A kind not listed here cannot be shared at all.
KINDS: dict[str, KindSpec] = {
    "plan": KindSpec(KIND_CODES["plan"], 7, False, (".html", ".plan.md"), ((".agent-team", "plans"), (".cursor", "plans"))),
    "report": KindSpec(KIND_CODES["report"], 7, False, (".html",), ((".agent-team", "plans"), ("docs", "reports"))),
}
_KIND_BY_CODE = {code: name for name, code in KIND_CODES.items()}

# Attribute order varies: the provisioned template writes type before id.
_PLAN_META_RE = re.compile(r'<script\b[^>]*\bid="plan-meta"[^>]*>(.*?)</script>', re.DOTALL)


class ShareError(Exception):
    """A share link could not be built, uploaded or opened."""


class ShareRefused(ShareError):
    """This file, kind or option is never shared; ``code`` says which rule."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class ShareRemoteError(ShareError):
    """The server refused a ``links.*`` call; ``code`` is its own error code
    (NOT_FOUND, LINK_INACTIVE, UNSUPPORTED, UNKNOWN_TYPE …) or a local one
    naming the link state (NOT_CONFIGURED, LINK_OFFLINE …)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


#: Codes meaning "this server does not do share links": an old server, or a
#: new one with links switched off (UNKNOWN_TYPE), or without storage.
UNAVAILABLE_CODES = frozenset({"UNKNOWN_TYPE", "UNSUPPORTED", "NOT_CONFIGURED"})


class LinksClient(Protocol):
    """The Navide-Server ``links.*`` verbs: the reply's payload, or
    ``ShareRemoteError``. See ``ServerLinksClient``."""

    async def request(self, verb: str, payload: dict[str, Any]) -> dict[str, Any]: ...


class ServerLinksClient:
    """``LinksClient`` over this machine's account link (``server_link``)."""

    async def request(self, verb: str, payload: dict[str, Any]) -> dict[str, Any]:
        from . import server_link

        reply = await server_link.links_request(verb, payload)
        if reply is None:
            raise ShareRemoteError("NOT_CONFIGURED", "Navide Cloud is not set up on this machine.")
        if not reply.get("ok"):
            error = reply.get("error") if isinstance(reply.get("error"), dict) else {}
            raise ShareRemoteError(str(error.get("code") or "SHARE_FAILED"), str(error.get("message") or verb))
        body = reply.get("payload")
        return body if isinstance(body, dict) else {}


# ---- object format ----------------------------------------------------------------


def new_key() -> bytes:
    return os.urandom(KEY_LEN)


def _header(kind: str, version: int) -> bytes:
    return MAGIC + bytes([KIND_CODES[kind]]) + struct.pack(">I", version) + os.urandom(_OBJECT_ID_LEN)


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


def decrypt_object(blob: bytes, key: bytes, *, expected_version: int | None = None) -> tuple[str, int, bytes]:
    """(kind, version, plaintext) of an object sealed by ``encrypt_object``.

    With ``expected_version``, an object of any other version is refused — an
    older copy served in place of the current one opens fine otherwise."""
    if len(blob) < HEADER_LEN + SEGMENT_OVERHEAD or blob[:4] != MAGIC:
        raise ShareError("not a share-link object")
    header = blob[:HEADER_LEN]
    kind = _KIND_BY_CODE.get(header[4])
    if kind is None:
        raise ShareError("unknown kind in the share-link header")
    (version,) = struct.unpack(">I", header[5:9])
    if expected_version is not None and version != expected_version:
        raise ShareError(f"expected content version {expected_version}, got {version}")
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


#: Fragments (``#k=`` values) of every link URL this process built, newest
#: last, so a chat mask can strip a key however it was rewritten around it.
_SEEN_FRAGMENTS: list[str] = []
_SEEN_MAX = 256


def known_key_fragments() -> tuple[str, ...]:
    """The base64url keys of links built by this process (see ``link_url``)."""
    return tuple(_SEEN_FRAGMENTS)


def link_url(link_id: str, key: bytes, base: str = SHARE_BASE) -> str:
    fragment = base64.urlsafe_b64encode(key).rstrip(b"=").decode("ascii")
    if fragment not in _SEEN_FRAGMENTS:
        _SEEN_FRAGMENTS.append(fragment)
        del _SEEN_FRAGMENTS[:-_SEEN_MAX]
    return f"{base}/s/{link_id}#k={fragment}"


def key_label(link_id: str, version: int) -> str:
    return f"link:{link_id}:v{version}"


def meta_label(link_id: str, version: int) -> str:
    return f"link-meta:{link_id}:v{version}"


# ---- preparing ----------------------------------------------------------------------


@dataclass(frozen=True)
class Prepared:
    kind: str
    path: Path
    text: str  # masked
    findings: list[share_scan.Finding]
    title: str
    sha256: str  # of the masked text, i.e. of what was published


#: ``ShareRefused.code`` while the user has the built-in Navide plugin Plans
#: disabled: no plan document is published or re-published.
PLANS_DISABLED_CODE = "plugin-disabled"
PLANS_DISABLED_MESSAGE = "Navide plugin Plans is disabled. Enable it in Settings → Navide Plugins."


def _is_plans_document(real: Path, kind: str) -> bool:
    """A plan, or any file in a workspace's ``.agent-team/plans/``."""
    parent = tuple(real.parent.parts)
    return kind == "plan" or parent[-2:] == (".agent-team", "plans")


def _source_ok(real: Path, spec: KindSpec) -> bool:
    if not real.name.lower().endswith(spec.suffixes):
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
        raise ShareRefused("unknown_kind", f"A {kind!r} cannot be shared.")
    out, refused = share_scan.open_shareable(raw_path)
    if out is None:
        assert refused is not None
        raise ShareRefused(refused.code, refused.message)
    with out.fh:
        real = out.path
        if not _source_ok(real, spec):
            where = " or ".join("/".join(folder) + "/" for folder in spec.folders)
            raise ShareRefused("kind_source", f"Only files in {where} can be shared as a {kind}.")
        if _is_plans_document(real, kind):
            from . import app

            if app.plans_plugin_disabled():
                raise ShareRefused(PLANS_DISABLED_CODE, PLANS_DISABLED_MESSAGE)
        if out.size > MAX_PLAINTEXT:
            raise ShareRefused("too_large", f"Files over {MAX_PLAINTEXT // (1024 * 1024)} MiB cannot be shared.")
        try:
            text = out.fh.read(MAX_PLAINTEXT + 1).decode("utf-8")
        except (OSError, UnicodeDecodeError) as err:
            raise ShareRefused("unreadable", "The file could not be read as UTF-8 text.") from err
    if len(text.encode("utf-8")) > MAX_PLAINTEXT:
        raise ShareRefused("too_large", f"Files over {MAX_PLAINTEXT // (1024 * 1024)} MiB cannot be shared.")
    result = share_scan.scan(text, kind=kind)
    return Prepared(
        kind=kind,
        path=real,
        text=result.text,
        findings=result.findings,
        title=_title(result.text, real),
        sha256=hashlib.sha256(result.text.encode("utf-8")).hexdigest(),
    )


# ---- talking to the server ----------------------------------------------------------


@dataclass(frozen=True)
class Created:
    link_id: str
    url: str
    expires_at: str
    findings: list[share_scan.Finding]
    title: str = ""
    kind: str = ""
    #: rekey only: the server's commit listed the old link as revoked.
    replaced: bool = False


def _http_put(url: str, data: bytes) -> None:
    """PUT ``data`` to a presigned URL. The server signed Content-Length, which
    urllib sets from ``data``."""
    if not url.startswith("https://"):
        raise ShareError("refusing to upload over a non-https URL")
    req = Request(url, data=data, method="PUT", headers={"Content-Type": "application/octet-stream"})
    try:
        with urlopen(req, timeout=_HTTP_TIMEOUT_S) as resp:  # noqa: S310 - a presigned https URL from the server
            if not 200 <= resp.status < 300:
                raise ShareError(f"upload failed with HTTP {resp.status}")
    except HTTPError as err:
        raise ShareError(f"upload failed with HTTP {err.code}") from err
    except URLError as err:
        raise ShareError(f"upload failed: {err.reason}") from err


def _http_get(url: str) -> bytes:
    """GET a presigned object, refusing anything past the size a link may have."""
    if not url.startswith("https://"):
        raise ShareError("refusing to download over a non-https URL")
    limit = MAX_PLAINTEXT + HEADER_LEN + SEGMENT_OVERHEAD * (MAX_PLAINTEXT // SEGMENT_SIZE + 1)
    try:
        with urlopen(Request(url, method="GET"), timeout=_HTTP_TIMEOUT_S) as resp:  # noqa: S310 - presigned https
            if not 200 <= resp.status < 300:
                raise ShareError(f"download failed with HTTP {resp.status}")
            body = resp.read(limit + 1)
    except HTTPError as err:
        raise ShareError(f"download failed with HTTP {err.code}") from err
    except URLError as err:
        raise ShareError(f"download failed: {err.reason}") from err
    if len(body) > limit:
        raise ShareError("the stored object is larger than any share link can be")
    return body


def _kid_of(wrapped: str) -> str:
    """The key id inside a ``wrap_aux`` envelope (bytes 1–8)."""
    return base64.b64decode(wrapped)[1:9].hex()


def _version_of(row: dict[str, Any]) -> int:
    """A row's content version, or ShareError: a server answer without a sane
    one is a failed call, not a crash and not a missing key."""
    version = row.get("version")
    if isinstance(version, bool) or not isinstance(version, int) or version < 1:
        raise ShareError("the server returned no valid content version for the link")
    return version


def _open_key(link_id: str, version: int, wrapped: Any) -> bytes:
    """K from its wrapped form. No ring is KeyringError (pair this device);
    a ring that does not open it is ShareError (the stored key is unusable)."""
    if sync_keyring.account_key() is None:
        raise sync_keyring.KeyringError("this machine has no sync key yet")
    try:
        return sync_keyring.unwrap_aux(key_label(link_id, version), str(wrapped or ""))
    except sync_keyring.KeyringError as err:
        raise ShareError("the link's stored key does not open with this account's key") from err


def _check_link_id(link_id: Any) -> str:
    if not isinstance(link_id, str) or not _LINK_ID_RE.fullmatch(link_id):
        raise ShareError("the server returned a malformed link id")
    return link_id


def _seal_meta(link_id: str, version: int, meta: dict[str, Any]) -> str:
    """``meta`` wrapped for this link and version, under the server's size cap:
    the masking summary is cut first (its total is kept), then long strings."""
    meta = dict(meta)
    masked = list(meta.get("masked") or [])
    meta["maskedTotal"] = len(masked)
    keep = len(masked)
    while True:
        meta["masked"] = masked[:keep]
        sealed = sync_keyring.wrap_aux(meta_label(link_id, version), json.dumps(meta).encode("utf-8"))
        if len(sealed) <= MAX_META_CHARS:
            return sealed
        if keep:
            keep //= 2
            continue
        for field in ("path", "title", "pane", "agent"):
            if isinstance(meta.get(field), str) and len(meta[field]) > 200:
                meta[field] = meta[field][:200] + "…"
        sealed = sync_keyring.wrap_aux(meta_label(link_id, version), json.dumps(meta).encode("utf-8"))
        if len(sealed) <= MAX_META_CHARS:
            return sealed
        raise ShareError("the link's description does not fit the server's limit")


def _open_meta(link_id: str, version: int, meta_enc: Any) -> dict[str, Any] | None:
    if not isinstance(meta_enc, str) or not meta_enc:
        return None
    try:
        meta = json.loads(sync_keyring.unwrap_aux(meta_label(link_id, version), meta_enc))
    except (sync_keyring.KeyringError, ValueError):
        return None
    return meta if isinstance(meta, dict) else None


def _ttl(kind: str, ttl_seconds: int | None) -> int:
    ttl = KINDS[kind].ttl_days * 86400 if ttl_seconds is None else ttl_seconds
    if not MIN_TTL_SECONDS <= ttl <= MAX_TTL_SECONDS:
        raise ShareRefused("ttl", f"A link lasts between {MIN_TTL_SECONDS // 60} minutes and {MAX_TTL_SECONDS // 86400} days.")
    return ttl


def _require_ring() -> None:
    if sync_keyring.account_key() is None:
        raise sync_keyring.KeyringError("this machine has no sync key yet")


async def _upload(put: Callable[[str, bytes], None] | None, url: Any, blob: bytes) -> None:
    if not isinstance(url, str):
        raise ShareError("the server returned no upload URL")
    await asyncio.to_thread(put or _http_put, url, blob)


#: (connection, whether its server does share links), answered once per
#: connection: an old server must see share questions no more than that.
_support: tuple[object, bool] | None = None


def supported_now() -> bool | None:
    """Whether the server on this connection does share links; None until it
    has been asked (``caps``/``ensure_supported``) on this connection."""
    from . import server_link

    conn = server_link.connection_token()
    if conn is None or _support is None or _support[0] is not conn:
        return None
    return _support[1]


async def caps(client: LinksClient) -> dict[str, Any]:
    global _support
    from . import server_link

    conn = server_link.connection_token()
    try:
        answer = await client.request("caps", {})
    except ShareRemoteError as err:
        if err.code in UNAVAILABLE_CODES and conn is not None:
            _support = (conn, False)
        raise
    if conn is not None:
        _support = (conn, True)
    return answer


async def ensure_supported(client: LinksClient) -> bool:
    """Ask the server once per connection whether it does share links."""
    known = supported_now()
    if known is not None:
        return known
    try:
        await caps(client)
    except ShareRemoteError as err:
        if err.code in UNAVAILABLE_CODES:
            return False
        raise
    return True


async def create_share(
    client: LinksClient,
    raw_path: str,
    kind: str,
    *,
    ttl_seconds: int | None = None,
    require_login: bool | None = None,
    created_by: str = "user",
    pane: str = "",
    agent: str = "",
    pane_id: str = "",
    put: Callable[[str, bytes], None] | None = None,
) -> Created:
    """Mask, encrypt and publish ``raw_path``; the URL carries the only copy of K
    outside the account ring. ``pane_id`` (the creating pane, when an agent
    shares) is kept in the metadata so a chat notice can find its binding."""
    # A server without links hears nothing else, and nothing is read (F7-2).
    if not await ensure_supported(client):
        raise ShareRemoteError("UNSUPPORTED", "This Navide Cloud server does not offer share links.")
    prepared = await asyncio.to_thread(prepare, raw_path, kind)
    ttl = _ttl(kind, ttl_seconds)
    _require_ring()

    key = new_key()
    blob = encrypt_object(prepared.text.encode("utf-8"), key, kind=kind, version=1)
    row = await client.request(
        "create",
        {
            "kind": kind,
            "sizeBytes": len(blob),
            "ttlSeconds": ttl,
            "requireLogin": KINDS[kind].require_login if require_login is None else require_login,
            "createdBy": "agent" if created_by == "agent" else "user",
        },
    )
    link_id = _check_link_id(row.get("linkId"))
    await _upload(put, row.get("uploadUrl"), blob)
    meta: dict[str, Any] = {
        "title": prepared.title,
        "path": str(prepared.path),
        "sha256": prepared.sha256,
        "createdBy": created_by,
        "pane": pane,
        "paneId": pane_id,
        "agent": agent,
        "masked": [{"line": f.line, "category": f.category, "action": f.action} for f in prepared.findings],
    }
    wrapped = sync_keyring.wrap_aux(key_label(link_id, 1), key)
    done = await client.request(
        "commit",
        {
            "linkId": link_id,
            "version": 1,
            "wrappedKey": wrapped,
            "kid": _kid_of(wrapped),
            "metaEnc": _seal_meta(link_id, 1, meta),
        },
    )
    expires = done.get("expiresAt") or row.get("expiresAt") or ""
    return Created(link_id, link_url(link_id, key), str(expires), prepared.findings, prepared.title, kind)


async def announce_to_chat(created: Created, *, created_by: str, pane_id: str = "", chat_id: str = "") -> None:
    """Hand a new link to Channels, which posts it to the creator's chat
    (channels.share_cmds decides where). Only called when the creator asked
    for it; a failure is logged and never undoes the share."""
    try:
        from .channels import share_cmds

        await share_cmds.notify_link_created(
            {
                "linkId": created.link_id,
                "url": created.url,
                "title": created.title,
                "kind": created.kind,
                "expiresAt": created.expires_at,
                "paneId": pane_id,
                "chatId": chat_id,
                "createdBy": created_by,
                "maskedTotal": len(created.findings),
            }
        )
    except Exception as err:  # noqa: BLE001 - a chat notice must not fail the share
        log.warning("sending a new share link to chat failed: %s", err)


def _row_view(row: dict[str, Any]) -> dict[str, Any]:
    """One links.list row as the Share list shows it. The metadata is opened
    here; the key and the URL never leave this module (``copy_link`` does)."""
    link_id = str(row.get("linkId") or "")
    version = row.get("version") if isinstance(row.get("version"), int) else 1
    meta = _open_meta(link_id, version, row.get("metaEnc")) or {}
    return {
        "linkId": link_id,
        "kind": row.get("kind") or "",
        "title": meta.get("title") or "",
        "path": meta.get("path") or "",
        "createdBy": "agent" if row.get("createdBy") == "agent" else "user",
        "pane": meta.get("pane") or "",
        "paneId": meta.get("paneId") or "",
        "agent": meta.get("agent") or "",
        "maskedTotal": meta.get("maskedTotal", len(meta.get("masked") or [])),
        "deviceId": row.get("deviceId") or "",
        "deviceName": row.get("deviceName") or "",
        "version": version,
        "state": row.get("state") or "",
        "active": bool(row.get("active")),
        "requireLogin": bool(row.get("requireLogin")),
        "sizeBytes": row.get("sizeBytes") or 0,
        "createdAt": row.get("createdAt") or "",
        "expiresAt": row.get("expiresAt") or "",
        "revokedAt": row.get("revokedAt") or "",
        "openCount": row.get("openCount") or 0,
        "firstOpenedAt": row.get("firstOpenedAt") or "",
        "lastOpenedAt": row.get("lastOpenedAt") or "",
        "readable": bool(meta),
    }


async def _rewrap_if_stale(client: LinksClient, row: dict[str, Any]) -> None:
    """After a ring rotation, re-wrap K and the metadata under the active key
    (links.rewrap). Best effort: a row this machine cannot open is left alone."""
    wrapped = row.get("wrappedKey")
    active = sync_keyring.active_key_id()
    if not isinstance(wrapped, str) or not row.get("active") or active is None:
        return
    try:
        if _kid_of(wrapped) == active:
            return
        link_id = str(row["linkId"])
        version = _version_of(row)
        key = sync_keyring.unwrap_aux(key_label(link_id, version), wrapped)
        meta = _open_meta(link_id, version, row.get("metaEnc"))
        rewrapped = sync_keyring.wrap_aux(key_label(link_id, version), key)
        payload: dict[str, Any] = {
            "linkId": link_id,
            "version": version,
            "wrappedKey": rewrapped,
            "kid": _kid_of(rewrapped),
        }
        if meta is not None:
            payload["metaEnc"] = _seal_meta(link_id, version, meta)
        await client.request("rewrap", payload)
    except (sync_keyring.KeyringError, ShareError, ValueError, KeyError) as err:
        log.info("re-wrapping a share link after rotation skipped: %s", err)


async def list_links(client: LinksClient) -> list[dict[str, Any]]:
    """Every link of the account, all pages, metadata opened on this machine."""
    rows: list[dict[str, Any]] = []
    cursor: Any = None
    for _ in range(100):  # 50 a page: a 200-link account is four pages
        page = await client.request("list", {} if cursor is None else {"cursor": cursor})
        rows.extend(r for r in page.get("links") or [] if isinstance(r, dict))
        cursor = page.get("next")
        if not cursor:
            break
    for row in rows:
        await _rewrap_if_stale(client, row)
    return [_row_view(row) for row in rows]


async def _unwrap(client: LinksClient, link_id: str) -> tuple[dict[str, Any], bytes]:
    link_id = _check_link_id(link_id)
    row = await client.request("unwrap", {"linkId": link_id})
    return row, _open_key(link_id, _version_of(row), row.get("wrappedKey"))


async def copy_link(client: LinksClient, link_id: str) -> str:
    """The URL of an existing link, rebuilt from its wrapped key."""
    _row, key = await _unwrap(client, link_id)
    return link_url(link_id, key)


async def revoke(client: LinksClient, link_id: str) -> dict[str, Any]:
    return await client.request("revoke", {"linkId": _check_link_id(link_id)})


async def revoke_all(client: LinksClient, device_id: str = "") -> dict[str, Any]:
    return await client.request("revokeAll", {"deviceId": device_id} if device_id else {})


async def extend(client: LinksClient, link_id: str, ttl_seconds: int) -> dict[str, Any]:
    if not MIN_TTL_SECONDS <= ttl_seconds <= MAX_TTL_SECONDS:
        raise ShareRefused("ttl", f"A link lasts between {MIN_TTL_SECONDS // 60} minutes and {MAX_TTL_SECONDS // 86400} days.")
    return await client.request("extend", {"linkId": _check_link_id(link_id), "ttlSeconds": ttl_seconds})


async def update_content(
    client: LinksClient,
    link_id: str,
    raw_path: str = "",
    *,
    put: Callable[[str, bytes], None] | None = None,
) -> dict[str, Any]:
    """Publish the file's current content under the same link and key (only
    the device that created the link may; the server says NOT_CREATOR)."""
    row, key = await _unwrap(client, link_id)
    kind = str(row.get("kind") or "")
    old_meta = _open_meta(link_id, _version_of(row), row.get("metaEnc")) or {}
    path = raw_path or str(old_meta.get("path") or "")
    if not path:
        raise ShareRefused("missing", "This link does not say which file it was made from.")
    prepared = await asyncio.to_thread(prepare, path, kind)
    blob_len = len(encrypt_object(prepared.text.encode("utf-8"), key, kind=kind, version=1))
    started = await client.request("update", {"linkId": link_id, "sizeBytes": blob_len})
    version = int(started.get("version") or 0)
    if version < 2:
        raise ShareError("the server returned no new version for the update")
    blob = encrypt_object(prepared.text.encode("utf-8"), key, kind=kind, version=version)
    await _upload(put, started.get("uploadUrl"), blob)
    meta = {
        **old_meta,
        "title": prepared.title,
        "path": str(prepared.path),
        "sha256": prepared.sha256,
        "masked": [{"line": f.line, "category": f.category, "action": f.action} for f in prepared.findings],
    }
    wrapped = sync_keyring.wrap_aux(key_label(link_id, version), key)
    return await client.request(
        "commit",
        {
            "linkId": link_id,
            "version": version,
            "wrappedKey": wrapped,
            "kid": _kid_of(wrapped),
            "metaEnc": _seal_meta(link_id, version, meta),
        },
    )


async def rekey(
    client: LinksClient,
    link_id: str,
    *,
    put: Callable[[str, bytes], None] | None = None,
    get: Callable[[str], bytes] | None = None,
) -> Created:
    """Re-publish a link's current content under a new id and key; the old URL
    stops working once the new one is committed. Any device of the account
    holding the ring can do this."""
    row, old_key = await _unwrap(client, link_id)
    version = _version_of(row)
    blob = await asyncio.to_thread(get or _http_get, str(row.get("downloadUrl") or ""))
    kind, _v, plaintext = decrypt_object(blob, old_key, expected_version=version)
    meta = _open_meta(link_id, version, row.get("metaEnc")) or {}
    key = new_key()
    sealed = encrypt_object(plaintext, key, kind=kind, version=1)
    started = await client.request("rekey", {"linkId": link_id, "sizeBytes": len(sealed)})
    new_id = _check_link_id(started.get("linkId"))
    await _upload(put, started.get("uploadUrl"), sealed)
    wrapped = sync_keyring.wrap_aux(key_label(new_id, 1), key)
    done = await client.request(
        "commit",
        {
            "linkId": new_id,
            "version": 1,
            "wrappedKey": wrapped,
            "kid": _kid_of(wrapped),
            "metaEnc": _seal_meta(new_id, 1, meta),
        },
    )
    expires = done.get("expiresAt") or started.get("expiresAt") or ""
    replaced = link_id in (done.get("revoked") or [])
    return Created(new_id, link_url(new_id, key), str(expires), [], replaced=replaced)

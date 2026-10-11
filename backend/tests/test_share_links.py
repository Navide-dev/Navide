"""share_links: the desktop half of a share link, against a fake server.

What is asserted is what leaves the machine: the uploaded object opens only
with the key in the URL fragment, is cut into authenticated segments that
cannot be dropped, swapped or relabelled, and carries the masked text; the
key and the metadata reach the server only wrapped under the account ring.
"""

from __future__ import annotations

import base64
import os
import sys
import json
from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import share_links, sync_keyring

GHP = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"


@pytest.fixture
def ring():
    sync_keyring.ensure_account_key()
    yield
    sync_keyring.forget_account_key()


@pytest.fixture
def home(tmp_path: Path, set_home, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(tmp_path / "data"))
    (tmp_path / "home").mkdir()
    return set_home(tmp_path / "home")


def _plan(home: Path, body: str, name: str = "Secret Roadmap") -> Path:
    path = home / "work" / ".agent-team" / "plans" / "roadmap_abc123.html"
    path.parent.mkdir(parents=True, exist_ok=True)
    meta = json.dumps({"schemaVersion": 1, "name": name, "stage": "draft"})
    path.write_text(f'<html><script id="plan-meta" type="application/json">{meta}</script>\n{body}\n</html>\n')
    return path


class FakeLinks:
    """The links.* verbs as the server answers them (contract of 2026-10-11),
    in memory, with an object store behind the presigned URLs."""

    def __init__(self, link_id: str = "ab" * 16) -> None:
        self.next_ids = [link_id, "cd" * 16, "ef" * 16]
        self.rows: dict[str, dict[str, Any]] = {}
        self.objects: dict[str, bytes] = {}
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def put(self, url: str, data: bytes) -> None:
        self.objects[url] = data

    def get(self, url: str) -> bytes:
        return self.objects[url.replace("/get/", "/put/")]

    async def request(self, verb: str, payload: dict[str, Any]) -> dict[str, Any]:
        self.calls.append((verb, payload))
        if verb in ("create", "rekey"):
            link_id = self.next_ids.pop(0)
            self.rows[link_id] = {
                "linkId": link_id, "kind": payload.get("kind") or self.rows[payload["linkId"]]["kind"],
                "version": 1, "state": "uploading", "active": False, "createdBy": payload.get("createdBy", "user"),
                "expiresAt": "2026-10-18T00:00:00Z", "replaces": payload.get("linkId") if verb == "rekey" else None,
            }
            return {"linkId": link_id, "version": 1, "uploadUrl": f"https://s3.example/put/{link_id}/1",
                    "expiresAt": "2026-10-18T00:00:00Z"}
        row = self.rows.get(payload.get("linkId", ""))
        if verb == "update":
            return {"linkId": row["linkId"], "version": row["version"] + 1,
                    "uploadUrl": f"https://s3.example/put/{row['linkId']}/{row['version'] + 1}"}
        if verb == "commit":
            row.update(version=payload["version"], wrappedKey=payload["wrappedKey"], kid=payload["kid"],
                       metaEnc=payload["metaEnc"], state="live", active=True)
            revoked = []
            if row.get("replaces"):
                self.rows[row["replaces"]].update(active=False, revokedAt="now")
                revoked.append(row["replaces"])
            return {"linkId": row["linkId"], "version": row["version"], "state": "live",
                    "expiresAt": row["expiresAt"], "revoked": revoked}
        if verb == "list":
            return {"links": [dict(r) for r in self.rows.values()], "next": None}
        if verb == "unwrap":
            return {**{k: row[k] for k in ("linkId", "kind", "version", "kid", "wrappedKey", "metaEnc", "expiresAt")},
                    "downloadUrl": f"https://s3.example/get/{row['linkId']}/{row['version']}"}
        if verb == "rewrap":
            row.update({k: v for k, v in payload.items() if k in ("wrappedKey", "kid", "metaEnc")})
            return {"linkId": row["linkId"], "version": row["version"], "kid": row["kid"]}
        if verb == "revoke":
            row.update(active=False, revokedAt="now")
            return {"linkId": row["linkId"], "revokedAt": "now"}
        if verb == "caps":
            return {"kinds": {}}
        raise share_links.ShareRemoteError("UNKNOWN_TYPE", verb)

    def created(self) -> list[dict[str, Any]]:
        return [p for v, p in self.calls if v == "create"]

    def committed(self) -> list[dict[str, Any]]:
        return [p for v, p in self.calls if v == "commit"]


# ---- object format ----------------------------------------------------------------


def test_object_round_trips_across_segments() -> None:
    key = share_links.new_key()
    data = bytes(range(256)) * (share_links.SEGMENT_SIZE * 5 // 2 // 256)
    blob = share_links.encrypt_object(data, key, kind="plan", version=3)
    assert blob[:4] == b"NVL1"
    assert share_links.decrypt_object(blob, key) == ("plan", 3, data)


def test_empty_object_round_trips() -> None:
    key = share_links.new_key()
    assert share_links.decrypt_object(share_links.encrypt_object(b"", key, kind="report", version=1), key) == (
        "report", 1, b"")


def _segments(blob: bytes) -> tuple[bytes, list[bytes]]:
    header, rest = blob[: share_links.HEADER_LEN], blob[share_links.HEADER_LEN :]
    step = share_links.SEGMENT_SIZE + share_links.SEGMENT_OVERHEAD
    return header, [rest[i : i + step] for i in range(0, len(rest), step)]


@pytest.fixture
def three_segments() -> tuple[bytes, bytes]:
    key = share_links.new_key()
    data = b"x" * (share_links.SEGMENT_SIZE * 2 + 10)
    return key, share_links.encrypt_object(data, key, kind="plan", version=1)


def test_dropping_the_last_segment_is_detected(three_segments) -> None:
    key, blob = three_segments
    header, segs = _segments(blob)
    with pytest.raises(share_links.ShareError):
        share_links.decrypt_object(header + b"".join(segs[:2]), key)


def test_swapping_segments_is_detected(three_segments) -> None:
    key, blob = three_segments
    header, segs = _segments(blob)
    with pytest.raises(share_links.ShareError):
        share_links.decrypt_object(header + segs[1] + segs[0] + segs[2], key)


def test_relabelling_the_header_is_detected(three_segments) -> None:
    key, blob = three_segments
    tampered = blob[:4] + bytes([share_links.KINDS["report"].code]) + blob[5:]
    with pytest.raises(share_links.ShareError):
        share_links.decrypt_object(tampered, key)


def test_wrong_key_does_not_open(three_segments) -> None:
    _key, blob = three_segments
    with pytest.raises(share_links.ShareError):
        share_links.decrypt_object(blob, share_links.new_key())


def test_link_url_carries_the_key_only_in_the_fragment() -> None:
    key = bytes(range(32))
    url = share_links.link_url("ab" * 16, key)
    base, _, fragment = url.partition("#")
    assert base == "https://share.navide.dev/s/" + "ab" * 16
    assert fragment.startswith("k=")
    assert base64.urlsafe_b64decode(fragment[2:] + "=") == key
    assert "=" not in fragment[2:]


# ---- preparing and creating --------------------------------------------------------


def test_sensitive_path_is_refused_with_its_reason(home: Path) -> None:
    key_file = home / ".ssh" / "id_ed25519"
    key_file.parent.mkdir(parents=True)
    key_file.write_text("x")
    with pytest.raises(share_links.ShareRefused) as err:
        share_links.prepare(str(key_file), "plan")
    assert err.value.code == "denied_name"


def test_a_file_that_is_not_a_plan_is_refused_for_the_plan_kind(home: Path) -> None:
    notes = home / "notes.html"
    notes.write_text("<p>hi</p>")
    with pytest.raises(share_links.ShareRefused) as err:
        share_links.prepare(str(notes), "plan")
    assert err.value.code == "kind_source"


def test_unknown_kind_is_refused(home: Path) -> None:
    with pytest.raises(share_links.ShareRefused) as err:
        share_links.prepare(str(_plan(home, "<p/>")), "nonsense")
    assert err.value.code == "unknown_kind"


async def test_ttl_outside_the_range_is_refused(ring, home: Path) -> None:
    with pytest.raises(share_links.ShareRefused) as err:
        await share_links.create_share(
            FakeLinks(), str(_plan(home, "<p/>")), "plan", ttl_seconds=31 * 86400, put=lambda *_: None
        )
    assert err.value.code == "ttl"


def test_oversized_file_is_refused(home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(share_links, "MAX_PLAINTEXT", 64)
    with pytest.raises(share_links.ShareRefused) as err:
        share_links.prepare(str(_plan(home, "<p>" + "x" * 100 + "</p>")), "plan")
    assert err.value.code == "too_large"


async def test_create_share_uploads_masked_ciphertext_and_wraps_the_key(ring, home: Path) -> None:
    path = _plan(home, f"<p>token {GHP}</p>")
    client = FakeLinks()
    uploads: list[tuple[str, bytes]] = []

    created = await share_links.create_share(
        client, str(path), "plan", created_by="agent", pane="release", agent="claude",
        put=lambda url, data: uploads.append((url, data)),
    )

    assert client.created() == [
        {"kind": "plan", "sizeBytes": len(uploads[0][1]), "ttlSeconds": 7 * 86400, "requireLogin": False,
         "createdBy": "agent"}
    ]
    [(url, blob)] = uploads
    assert url == "https://s3.example/put/" + "ab" * 16 + "/1"
    assert b"Secret Roadmap" not in blob and GHP.encode() not in blob

    key = base64.urlsafe_b64decode(created.url.partition("#k=")[2] + "=")
    kind, version, plaintext = share_links.decrypt_object(blob, key)
    assert (kind, version) == ("plan", 1)
    assert GHP not in plaintext.decode() and "[redacted]" in plaintext.decode()
    assert [(f.line, f.category, f.action) for f in created.findings] == [(2, "github-token", "masked")]

    [commit] = client.committed()
    assert commit["linkId"] == created.link_id == "ab" * 16
    assert commit["version"] == 1
    assert commit["kid"] == sync_keyring.active_key_id()
    assert sync_keyring.unwrap_aux(f"link:{created.link_id}:v1", commit["wrappedKey"]) == key
    assert "Secret Roadmap" not in commit["metaEnc"]
    meta = json.loads(sync_keyring.unwrap_aux(f"link-meta:{created.link_id}:v1", commit["metaEnc"]))
    assert meta["title"] == "Secret Roadmap"
    assert meta["createdBy"] == "agent" and meta["pane"] == "release" and meta["agent"] == "claude"
    assert meta["masked"] == [{"line": 2, "category": "github-token", "action": "masked"}]
    assert meta["maskedTotal"] == 1
    assert GHP not in json.dumps(meta)


async def test_create_share_without_a_ring_fails_before_anything_is_sent(home: Path) -> None:
    client = FakeLinks()
    with pytest.raises(sync_keyring.KeyringError):
        await share_links.create_share(client, str(_plan(home, "<p/>")), "plan", put=lambda *_: None)
    assert client.calls == [("caps", {})]  # only the once-per-connection probe


# ---- review round 1 ---------------------------------------------------------------


@pytest.mark.parametrize("pad", [(" ", ""), ("", " "), ("\t", ""), ("", "\n")])
def test_a_path_with_whitespace_around_it_is_refused_before_it_is_opened(home: Path, pad) -> None:
    """The guard is on the string: whitespace on either end is refused with
    its own code before any file is opened, on every platform."""
    path = _plan(home, "<p/>")
    share_links.prepare(str(path), "plan")
    with pytest.raises(share_links.ShareRefused) as err:
        share_links.prepare(pad[0] + str(path) + pad[1], "plan")
    assert err.value.code == "whitespace"


@pytest.mark.skipif(sys.platform == "win32", reason="Windows cannot create a file name ending in a space")
def test_whitespace_around_the_path_is_refused(home: Path) -> None:
    """The check used to strip the path and the read did not, so 'ok.html ' was
    checked as ok.html and read as whatever 'ok.html ' pointed to."""
    plans = _plan(home, "<p/>").parent
    secret = home / "creds.txt"
    secret.write_text("TOPSECRET\n")
    os.link(secret, plans / "hl.html")
    (plans / "ok.html").write_text("benign")
    (plans / "ok.html ").symlink_to(plans / "hl.html")
    share_links.prepare(str(plans / "ok.html"), "plan")
    with pytest.raises(share_links.ShareRefused) as err:
        share_links.prepare(str(plans / "ok.html") + " ", "plan")
    assert err.value.code == "whitespace"


def test_the_file_read_is_the_file_checked(home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A swap between the check and the read is refused, not followed."""
    from agent_team_backend.channels import media

    path = _plan(home, "<p>benign</p>")
    secret = home / "creds.txt"
    secret.write_text("TOPSECRET\n")
    hard = path.parent / "hl.html"  # a second name: refused if it were checked
    os.link(secret, hard)
    real_check = media._check
    calls = {"n": 0}

    def swapping(raw: str):
        out = real_check(raw)
        calls["n"] += 1
        if calls["n"] == 1:
            path.unlink()
            path.symlink_to(hard)
        return out

    monkeypatch.setattr(media, "_check", swapping)
    with pytest.raises(share_links.ShareRefused):
        share_links.prepare(str(path), "plan")


def test_uppercase_suffix_is_accepted(home: Path) -> None:
    path = _plan(home, "<p/>")
    upper = path.with_name("UP.HTML")
    path.rename(upper)
    assert share_links.prepare(str(upper), "plan").path.name == "UP.HTML"


@pytest.mark.parametrize("bad", ["x/../../evil", "x?q=1", "x#k=ATTACKER", "a:v1", "short"])
async def test_a_malformed_link_id_from_the_server_is_refused_before_upload(ring, home: Path, bad: str) -> None:
    client = FakeLinks(link_id=bad)
    uploads: list[str] = []
    with pytest.raises(share_links.ShareError):
        await share_links.create_share(
            client, str(_plan(home, "<p/>")), "plan", put=lambda url, _d: uploads.append(url)
        )
    assert uploads == [] and client.committed() == []


def test_upload_url_must_be_https() -> None:
    with pytest.raises(share_links.ShareError):
        share_links._http_put("http://s3.example/put", b"x")


def test_objects_with_the_same_key_cannot_be_spliced() -> None:
    key = share_links.new_key()
    size = share_links.SEGMENT_SIZE * 2 + 5
    a = share_links.encrypt_object(b"a" * size, key, kind="plan", version=1)
    b = share_links.encrypt_object(b"b" * size, key, kind="plan", version=1)
    _, sa = _segments(a)
    _, sb = _segments(b)
    with pytest.raises(share_links.ShareError):
        share_links.decrypt_object(a[: share_links.HEADER_LEN] + sa[0] + sb[1] + sa[2], key)


def test_an_older_version_is_refused_when_a_newer_one_is_expected() -> None:
    key = share_links.new_key()
    v1 = share_links.encrypt_object(b"old", key, kind="plan", version=1)
    assert share_links.decrypt_object(v1, key, expected_version=1)[1] == 1
    with pytest.raises(share_links.ShareError):
        share_links.decrypt_object(v1, key, expected_version=2)


async def test_metadata_label_names_the_version(ring, home: Path) -> None:
    client = FakeLinks()
    created = await share_links.create_share(client, str(_plan(home, "<p/>")), "plan", put=lambda *_: None)
    meta_enc = client.committed()[0]["metaEnc"]
    assert json.loads(sync_keyring.unwrap_aux(f"link-meta:{created.link_id}:v1", meta_enc))["title"]
    with pytest.raises(sync_keyring.KeyringError):
        sync_keyring.unwrap_aux(f"link-meta:{created.link_id}", meta_enc)


def test_kind_codes_are_the_shared_table() -> None:
    assert share_links.KIND_CODES == {
        "plan": 1, "report": 2, "pdf": 3, "preview": 4, "image": 5, "bundle": 7,
    }
    assert 6 not in share_links.KIND_CODES.values()  # dropped before it shipped; never reused
    assert all(share_links.KINDS[k].code == share_links.KIND_CODES[k] for k in share_links.KINDS)


# ---- managing links (contract of 2026-10-11) ---------------------------------------


def _key_of(url: str) -> bytes:
    return base64.urlsafe_b64decode(url.partition("#k=")[2] + "=")


async def test_the_list_shows_titles_but_never_a_key_or_url(ring, home: Path) -> None:
    client = FakeLinks()
    created = await share_links.create_share(client, str(_plan(home, "<p/>")), "plan", put=client.put)
    [row] = await share_links.list_links(client)
    assert row["title"] == "Secret Roadmap" and row["linkId"] == created.link_id and row["readable"]
    flat = json.dumps(row)
    assert "#k=" not in flat and created.url.partition("#k=")[2] not in flat and "wrappedKey" not in flat


async def test_copy_link_rebuilds_the_same_url(ring, home: Path) -> None:
    client = FakeLinks()
    created = await share_links.create_share(client, str(_plan(home, "<p/>")), "plan", put=client.put)
    assert await share_links.copy_link(client, created.link_id) == created.url


async def test_updating_content_keeps_the_key_and_bumps_the_version(ring, home: Path) -> None:
    client = FakeLinks()
    path = _plan(home, "<p>first</p>")
    created = await share_links.create_share(client, str(path), "plan", put=client.put)
    path.write_text(path.read_text().replace("first", "second"))

    await share_links.update_content(client, created.link_id, put=client.put)

    blob = client.objects["https://s3.example/put/" + created.link_id + "/2"]
    kind, version, text = share_links.decrypt_object(blob, _key_of(created.url), expected_version=2)
    assert (kind, version) == ("plan", 2) and b"second" in text
    commit = client.committed()[-1]
    assert sync_keyring.unwrap_aux(f"link:{created.link_id}:v2", commit["wrappedKey"]) == _key_of(created.url)


async def test_rekey_moves_the_content_to_a_new_id_and_key(ring, home: Path) -> None:
    client = FakeLinks()
    created = await share_links.create_share(client, str(_plan(home, "<p>body</p>")), "plan", put=client.put)

    moved = await share_links.rekey(client, created.link_id, put=client.put, get=client.get)

    assert moved.link_id != created.link_id and _key_of(moved.url) != _key_of(created.url)
    blob = client.objects["https://s3.example/put/" + moved.link_id + "/1"]
    assert b"body" in share_links.decrypt_object(blob, _key_of(moved.url))[2]
    with pytest.raises(share_links.ShareError):
        share_links.decrypt_object(blob, _key_of(created.url))
    assert client.rows[created.link_id]["active"] is False
    [row] = [r for r in await share_links.list_links(client) if r["linkId"] == moved.link_id]
    assert row["title"] == "Secret Roadmap"


async def test_listing_rewraps_links_left_under_a_rotated_key(ring, home: Path) -> None:
    client = FakeLinks()
    created = await share_links.create_share(client, str(_plan(home, "<p/>")), "plan", put=client.put)
    sync_keyring.rotate_account_key()

    await share_links.list_links(client)

    rewraps = [p for v, p in client.calls if v == "rewrap"]
    assert len(rewraps) == 1 and rewraps[0]["kid"] == sync_keyring.active_key_id()
    assert await share_links.copy_link(client, created.link_id) == created.url


async def test_metadata_is_cut_to_the_servers_limit(ring, home: Path) -> None:
    client = FakeLinks()
    body = "\n".join(f"token=Abcdefgh{i:04d}" for i in range(2000))
    await share_links.create_share(client, str(_plan(home, body)), "plan", put=client.put)
    commit = client.committed()[0]
    assert len(commit["metaEnc"]) <= share_links.MAX_META_CHARS
    meta = json.loads(sync_keyring.unwrap_aux(f"link-meta:{commit['linkId']}:v1", commit["metaEnc"]))
    assert meta["maskedTotal"] == 2000 and len(meta["masked"]) < 2000


@pytest.mark.parametrize(
    ("reply", "code"),
    [
        (None, "NOT_CONFIGURED"),
        ({"ok": False, "error": {"code": "UNKNOWN_TYPE", "message": "x"}}, "UNKNOWN_TYPE"),
        ({"ok": False, "error": {"code": "NOT_CREATOR", "message": "x"}}, "NOT_CREATOR"),
    ],
)
async def test_the_server_client_passes_the_servers_error_code_through(monkeypatch, reply, code) -> None:
    from agent_team_backend import server_link

    async def fake(verb: str, payload: dict) -> dict | None:
        return reply

    monkeypatch.setattr(server_link, "links_request", fake)
    with pytest.raises(share_links.ShareRemoteError) as err:
        await share_links.ServerLinksClient().request("list", {})
    assert err.value.code == code


async def test_the_creating_pane_id_is_kept_for_routing_notices(ring, home: Path) -> None:
    client = FakeLinks()
    await share_links.create_share(
        client, str(_plan(home, "<p/>")), "plan", created_by="agent", pane="release", pane_id="pane-7",
        put=client.put,
    )
    commit = client.committed()[0]
    meta = json.loads(sync_keyring.unwrap_aux(f"link-meta:{commit['linkId']}:v1", commit["metaEnc"]))
    assert meta["paneId"] == "pane-7"
    [row] = await share_links.list_links(client)
    assert row["paneId"] == "pane-7"


@pytest.mark.parametrize("seconds", [1, 899])
async def test_a_lifetime_under_the_servers_upload_window_is_refused_here(ring, home: Path, seconds: int) -> None:
    client = FakeLinks()
    with pytest.raises(share_links.ShareRefused) as err:
        await share_links.create_share(client, str(_plan(home, "<p/>")), "plan", ttl_seconds=seconds, put=client.put)
    assert err.value.code == "ttl" and client.calls == [("caps", {})]
    with pytest.raises(share_links.ShareRefused):
        await share_links.extend(client, "ab" * 16, seconds)



# ---- review round 5/6 ---------------------------------------------------------------


@pytest.mark.parametrize("version", ["x", None, 0, -1])
async def test_a_bad_version_from_the_server_is_a_share_failure(ring, home: Path, version) -> None:
    """W-F4 / B5-7: not a crash, not a misleading 'no sync key'."""
    client = FakeLinks()
    created = await share_links.create_share(client, str(_plan(home, "<p/>")), "plan", put=client.put)
    client.rows[created.link_id]["version"] = version
    with pytest.raises(share_links.ShareError) as err:
        await share_links.copy_link(client, created.link_id)
    assert not isinstance(err.value, sync_keyring.KeyringError)


async def test_a_corrupt_wrapped_key_is_a_share_failure_not_a_missing_key(ring, home: Path) -> None:
    client = FakeLinks()
    created = await share_links.create_share(client, str(_plan(home, "<p/>")), "plan", put=client.put)
    client.rows[created.link_id]["wrappedKey"] = "AAAA"
    with pytest.raises(share_links.ShareError):
        await share_links.copy_link(client, created.link_id)


async def test_rekey_says_whether_the_old_link_is_gone(ring, home: Path, monkeypatch) -> None:
    """B5-6: only a commit that lists the old id in `revoked` means the old URL stopped."""
    client = FakeLinks()
    created = await share_links.create_share(client, str(_plan(home, "<p>body</p>")), "plan", put=client.put)
    moved = await share_links.rekey(client, created.link_id, put=client.put, get=client.get)
    assert moved.replaced is True

    again = await share_links.create_share(client, str(_plan(home, "<p>two</p>")), "plan", put=client.put)
    real = client.request

    async def forgetful(verb: str, payload: dict[str, Any]) -> dict[str, Any]:
        reply = await real(verb, payload)
        return {**reply, "revoked": []} if verb == "commit" else reply

    monkeypatch.setattr(client, "request", forgetful)
    client.next_ids.append("12" * 16)
    later = await share_links.rekey(client, again.link_id, put=client.put, get=client.get)
    assert later.replaced is False


class _CapsClient:
    def __init__(self, code: str = "") -> None:
        self.code = code
        self.calls = 0

    async def request(self, verb: str, payload: dict[str, Any]) -> dict[str, Any]:
        assert verb == "caps"
        self.calls += 1
        if self.code:
            raise share_links.ShareRemoteError(self.code, "no")
        return {"kinds": {}}


async def test_support_is_asked_once_per_connection(monkeypatch: pytest.MonkeyPatch) -> None:
    from agent_team_backend import server_link

    conn = [object()]
    monkeypatch.setattr(server_link, "connection_token", lambda: conn[0])
    monkeypatch.setattr(share_links, "_support", None)
    old = _CapsClient("UNKNOWN_TYPE")
    assert share_links.supported_now() is None
    assert await share_links.ensure_supported(old) is False
    assert await share_links.ensure_supported(old) is False
    assert old.calls == 1 and share_links.supported_now() is False
    conn[0] = object()  # a reconnect may land on an upgraded server
    new = _CapsClient()
    assert share_links.supported_now() is None
    assert await share_links.ensure_supported(new) is True
    assert new.calls == 1


async def test_support_is_not_remembered_without_a_connection(monkeypatch: pytest.MonkeyPatch) -> None:
    from agent_team_backend import server_link

    monkeypatch.setattr(server_link, "connection_token", lambda: None)
    monkeypatch.setattr(share_links, "_support", None)
    await share_links.ensure_supported(_CapsClient())
    assert share_links.supported_now() is None


def test_built_link_keys_are_remembered_for_masking() -> None:
    key = bytes(range(32))
    url = share_links.link_url("ab" * 16, key)
    assert url.split("#k=")[1] in share_links.known_key_fragments()


async def test_an_old_server_is_refused_before_the_file_or_ring_is_touched(home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """F7-2: share_create on a server without links read, masked and reached
    for the ring before the server said no."""
    touched: list[str] = []
    monkeypatch.setattr(share_links, "prepare", lambda *a, **k: touched.append("prepare"))
    monkeypatch.setattr(share_links, "_require_ring", lambda: touched.append("ring"))
    client = _CapsClient("UNKNOWN_TYPE")
    with pytest.raises(share_links.ShareRemoteError) as err:
        await share_links.create_share(client, str(_plan(home, "<p/>")), "plan")
    assert err.value.code == "UNSUPPORTED"
    assert touched == [] and client.calls == 1

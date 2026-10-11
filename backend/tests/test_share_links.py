"""share_links: the desktop half of a share link, against a fake server.

What is asserted is what leaves the machine: the uploaded object opens only
with the key in the URL fragment, is cut into authenticated segments that
cannot be dropped, swapped or relabelled, and carries the masked text; the
key and the metadata reach the server only wrapped under the account ring.
"""

from __future__ import annotations

import base64
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
    """The server half of links.create/commit, in memory."""

    def __init__(self) -> None:
        self.created: list[dict[str, Any]] = []
        self.committed: list[dict[str, Any]] = []

    def create(self, *, kind: str, size_bytes: int, ttl_days: int, require_login: bool, created_by: str) -> dict:
        self.created.append(
            {"kind": kind, "sizeBytes": size_bytes, "ttlDays": ttl_days, "requireLogin": require_login,
             "createdBy": created_by}
        )
        return {"linkId": "ab" * 16, "uploadUrl": "https://s3.example/put", "expiresAt": "2026-10-18T00:00:00Z"}

    def commit(self, *, link_id: str, wrapped_key: str, kid: str, meta_enc: str) -> dict:
        self.committed.append({"linkId": link_id, "wrappedKey": wrapped_key, "kid": kid, "metaEnc": meta_enc})
        return {"ok": True}


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
        share_links.prepare(str(_plan(home, "<p/>")), "transcript")
    assert err.value.code == "unknown_kind"


def test_ttl_outside_the_range_is_refused(ring, home: Path) -> None:
    with pytest.raises(share_links.ShareRefused) as err:
        share_links.create_share(FakeLinks(), str(_plan(home, "<p/>")), "plan", ttl_days=31, put=lambda *_: None)
    assert err.value.code == "ttl"


def test_oversized_file_is_refused(home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(share_links, "MAX_PLAINTEXT", 64)
    with pytest.raises(share_links.ShareRefused) as err:
        share_links.prepare(str(_plan(home, "<p>" + "x" * 100 + "</p>")), "plan")
    assert err.value.code == "too_large"


def test_create_share_uploads_masked_ciphertext_and_wraps_the_key(ring, home: Path) -> None:
    path = _plan(home, f"<p>token {GHP}</p>")
    client = FakeLinks()
    uploads: list[tuple[str, bytes]] = []

    created = share_links.create_share(
        client, str(path), "plan", created_by="agent", pane="release", agent="claude",
        put=lambda url, data: uploads.append((url, data)),
    )

    assert client.created == [
        {"kind": "plan", "sizeBytes": len(uploads[0][1]), "ttlDays": 7, "requireLogin": False, "createdBy": "agent"}
    ]
    [(url, blob)] = uploads
    assert url == "https://s3.example/put"
    assert b"Secret Roadmap" not in blob and GHP.encode() not in blob

    key = base64.urlsafe_b64decode(created.url.partition("#k=")[2] + "=")
    kind, version, plaintext = share_links.decrypt_object(blob, key)
    assert (kind, version) == ("plan", 1)
    assert GHP not in plaintext.decode() and "<redacted>" in plaintext.decode()
    assert [(f.line, f.category, f.action) for f in created.findings] == [(2, "github-token", "masked")]

    [commit] = client.committed
    assert commit["linkId"] == created.link_id == "ab" * 16
    assert commit["kid"] == sync_keyring.active_key_id()
    assert sync_keyring.unwrap_aux(f"link:{created.link_id}:v1", commit["wrappedKey"]) == key
    assert "Secret Roadmap" not in commit["metaEnc"]
    meta = json.loads(sync_keyring.unwrap_aux(f"link-meta:{created.link_id}", commit["metaEnc"]))
    assert meta["title"] == "Secret Roadmap"
    assert meta["createdBy"] == "agent" and meta["pane"] == "release" and meta["agent"] == "claude"
    assert meta["masked"] == [{"line": 2, "category": "github-token", "action": "masked"}]
    assert GHP not in json.dumps(meta)


def test_create_share_without_a_ring_fails_before_anything_is_sent(home: Path) -> None:
    client = FakeLinks()
    with pytest.raises(sync_keyring.KeyringError):
        share_links.create_share(client, str(_plan(home, "<p/>")), "plan", put=lambda *_: None)
    assert client.created == []

"""share_feedback: approvals and review notes sent from share.navide.dev.

A signed-in browser seals {action, text, contentSha256, version} with the
link's key; this device (the one that created the link) opens it, checks it
is about the content and version it published and that the plan still holds
that content, then applies it through the plan's own stage and note writers
and acks it. Anything else is refused and acked, never half-applied.
"""

from __future__ import annotations

import base64
import json
import os
from pathlib import Path
from typing import Any

import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from agent_team_backend import app, share_feedback, share_links, sync_keyring
from agent_team_backend.plugins.builtin.navide_plans.plan_meta import parse_plan_meta
from agent_team_backend.plugins.builtin.navide_plans.plan_tools import _create_plan_sync

from .test_share_links import FakeLinks


class FeedbackLinks(FakeLinks):
    """FakeLinks plus the Phase 2 links.feedback.* verbs."""

    def __init__(self) -> None:
        super().__init__()
        self.queue: list[dict[str, Any]] = []
        self.acked: list[str] = []

    async def request(self, verb: str, payload: dict[str, Any]) -> dict[str, Any]:
        if verb == "feedback.list":
            self.calls.append((verb, payload))
            return {"feedback": [f for f in self.queue if f["feedbackId"] not in self.acked][:50]}
        if verb == "feedback.ack":
            self.calls.append((verb, payload))
            self.acked.extend(payload["feedbackIds"])
            return {"acked": len(payload["feedbackIds"])}
        return await super().request(verb, payload)


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


@pytest.fixture
def broadcasts(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    sent: list[dict[str, Any]] = []

    async def broadcast(event: dict[str, Any]) -> None:
        sent.append(event)

    monkeypatch.setattr(app, "broadcast", broadcast)
    return sent


async def _shared_plan(home: Path, client: FeedbackLinks, stage: str = "in-review") -> tuple[Path, Any, str]:
    ws = home / "ws"
    ws.mkdir(exist_ok=True)
    created = _create_plan_sync(str(ws), "Phone check", "overview", ["one"], stage=stage)
    path = ws / created["rel_path"]
    link = await share_links.create_share(client, str(path), "plan", put=client.put)
    sha = json.loads(sync_keyring.unwrap_aux(f"link-meta:{link.link_id}:v1", client.committed()[0]["metaEnc"]))[
        "sha256"
    ]
    return path, link, sha


def _seal(link: Any, body: dict[str, Any], version: int = 1) -> str:
    key = base64.urlsafe_b64decode(link.url.partition("#k=")[2] + "=")
    nonce = os.urandom(12)
    aad = f"navide-feedback/v1:{link.link_id}:{version}".encode()
    sealed = nonce + AESGCM(key).encrypt(nonce, json.dumps(body).encode(), aad)
    return base64.urlsafe_b64encode(sealed).rstrip(b"=").decode()


def _item(link: Any, body: dict[str, Any], fid: str = "f1" * 16, version: int = 1, content: str = "") -> dict:
    return {
        "feedbackId": fid,
        "linkId": link.link_id,
        "cipher": _seal(link, body, version),
        "contentHash": content or body.get("contentSha256", ""),
        "version": version,
        "createdAt": "2026-10-11T10:00:00Z",
    }


def _meta(path: Path) -> dict[str, Any]:
    meta = parse_plan_meta(path.read_text(encoding="utf-8"))
    assert meta is not None
    return meta


async def test_a_phone_approval_moves_the_plan_to_approved_with_its_origin(ring, home, broadcasts) -> None:
    client = FeedbackLinks()
    path, link, sha = await _shared_plan(home, client)
    client.queue.append(_item(link, {"v": 1, "action": "approve", "text": "", "contentSha256": sha, "version": 1}))

    await share_feedback.drain(client)

    meta = _meta(path)
    assert meta["stage"] == "approved" and meta["approvedAt"]
    assert share_feedback.PHONE_APPROVED in meta["reviewNotes"][-1]["text"]
    assert client.acked == ["f1" * 16]
    assert broadcasts[-1]["payload"]["result"] == "approved"


async def test_a_phone_note_becomes_a_review_note(ring, home, broadcasts) -> None:
    client = FeedbackLinks()
    path, link, sha = await _shared_plan(home, client)
    body = {"v": 1, "action": "note", "text": "Please split phase 2", "contentSha256": sha, "version": 1}
    client.queue.append(_item(link, body))

    await share_feedback.drain(client)

    note = _meta(path)["reviewNotes"][-1]
    assert "Please split phase 2" in note["text"] and share_feedback.PHONE_NOTE in note["text"]
    assert _meta(path)["stage"] == "in-review"


async def test_an_approval_for_content_that_changed_since_is_refused(ring, home, broadcasts) -> None:
    client = FeedbackLinks()
    path, link, sha = await _shared_plan(home, client)
    path.write_text(path.read_text(encoding="utf-8").replace("overview", "rewritten overview"), encoding="utf-8")
    client.queue.append(_item(link, {"v": 1, "action": "approve", "text": "", "contentSha256": sha, "version": 1}))

    await share_feedback.drain(client)

    assert _meta(path)["stage"] == "in-review"
    assert client.acked == ["f1" * 16]
    event = broadcasts[-1]["payload"]
    assert event["result"] == "rejected" and event["reason"] == "content-changed"


@pytest.mark.parametrize("what", ["hash", "version"])
async def test_a_mismatched_hash_or_version_is_refused(ring, home, broadcasts, what) -> None:
    client = FeedbackLinks()
    path, link, sha = await _shared_plan(home, client)
    body = {"v": 1, "action": "approve", "text": "", "contentSha256": sha, "version": 1}
    if what == "hash":
        body["contentSha256"] = "0" * 64
        item = _item(link, body)
    else:
        item = _item(link, {**body, "version": 2}, version=2)
    client.queue.append(item)

    await share_feedback.drain(client)

    assert _meta(path)["stage"] == "in-review" and client.acked == ["f1" * 16]
    assert broadcasts[-1]["payload"]["result"] == "rejected"


async def test_a_plan_past_approval_is_not_moved_back(ring, home, broadcasts) -> None:
    client = FeedbackLinks()
    path, link, sha = await _shared_plan(home, client, stage="in-progress")
    client.queue.append(_item(link, {"v": 1, "action": "approve", "text": "", "contentSha256": sha, "version": 1}))

    await share_feedback.drain(client)

    assert _meta(path)["stage"] == "in-progress"
    assert client.acked == ["f1" * 16]


async def test_a_tampered_cipher_is_refused_and_nothing_changes(ring, home, broadcasts) -> None:
    client = FeedbackLinks()
    path, link, sha = await _shared_plan(home, client)
    item = _item(link, {"v": 1, "action": "approve", "text": "", "contentSha256": sha, "version": 1})
    item["cipher"] = item["cipher"][:-4] + ("AAAA" if not item["cipher"].endswith("AAAA") else "BBBB")
    client.queue.append(item)

    await share_feedback.drain(client)

    assert _meta(path)["stage"] == "in-review" and client.acked == ["f1" * 16]
    assert broadcasts[-1]["payload"]["reason"] == "unreadable"


async def test_the_same_feedback_is_applied_once(ring, home, broadcasts) -> None:
    client = FeedbackLinks()
    path, link, sha = await _shared_plan(home, client)
    item = _item(link, {"v": 1, "action": "note", "text": "once", "contentSha256": sha, "version": 1})

    await share_feedback.handle_event(client, item)
    await share_feedback.handle_event(client, item)

    assert [n["text"].count("once") for n in _meta(path)["reviewNotes"]] == [1]


async def test_a_server_without_feedback_is_left_alone(ring, home, broadcasts) -> None:
    class Old(FakeLinks):
        async def request(self, verb: str, payload: dict[str, Any]) -> dict[str, Any]:
            raise share_links.ShareRemoteError("UNKNOWN_TYPE", verb)

    await share_feedback.drain(Old())
    assert broadcasts == []


async def test_without_navide_cloud_nothing_is_fetched(monkeypatch, broadcasts) -> None:
    from agent_team_backend import server_link

    monkeypatch.setattr(server_link, "link_state", lambda: server_link.STATE_UNCONFIGURED)

    async def no_network(*_a: Any, **_k: Any) -> Any:
        raise AssertionError("the link was used while Navide Cloud is not connected")

    monkeypatch.setattr(server_link, "links_request", no_network)
    await share_feedback.drain_if_connected()
    await share_feedback.on_pushed({"feedbackId": "f1" * 16})
    assert broadcasts == []


async def test_the_link_hands_a_feedback_push_to_share_feedback(monkeypatch) -> None:
    from types import SimpleNamespace

    from agent_team_backend import server_link

    pushed: list[Any] = []

    async def on_pushed(payload: Any) -> None:
        pushed.append(payload)

    monkeypatch.setattr(share_feedback, "on_pushed", on_pushed)
    spawned: list[Any] = []
    fake = SimpleNamespace(_pending={}, _spawn=spawned.append)
    frame = {"type": "links.feedback", "payload": {"feedbackId": "f1" * 16}}
    await server_link.ServerLink._handle(fake, json.dumps(frame))  # type: ignore[arg-type]
    for coro in spawned:
        await coro
    assert pushed == [{"feedbackId": "f1" * 16}]


def test_the_link_drains_feedback_once_per_connection() -> None:
    import inspect

    from agent_team_backend import server_link

    source = inspect.getsource(server_link.ServerLink)
    assert source.count("self._spawn(self._drain_link_feedback())") == 1


# ---- review round 7 ---------------------------------------------------------------


async def test_feedback_for_a_link_that_is_gone_is_refused_and_acked(ring, home, broadcasts) -> None:
    """B7-3: LINK_INACTIVE / NOT_FOUND will never change; leaving it unacked
    replayed it on every reconnect."""
    client = FeedbackLinks()
    path, link, sha = await _shared_plan(home, client)
    real = client.request

    async def gone(verb: str, payload: dict[str, Any]) -> dict[str, Any]:
        if verb == "unwrap":
            raise share_links.ShareRemoteError("LINK_INACTIVE", "revoked")
        return await real(verb, payload)

    client.request = gone  # type: ignore[method-assign]
    client.queue.append(_item(link, {"v": 1, "action": "approve", "text": "", "contentSha256": sha, "version": 1}))
    await share_feedback.drain(client)
    assert client.acked == ["f1" * 16]
    assert broadcasts[-1]["payload"]["result"] == "rejected"
    assert broadcasts[-1]["payload"]["reason"] == "link-inactive"
    assert _meta(path)["stage"] == "in-review"


async def test_fifty_dead_items_do_not_keep_a_valid_approval_behind_them(ring, home, broadcasts) -> None:
    """B7-3: a full page of permanently failing items used to be listed 20
    times and acked 0 times, so the approval after it never ran."""
    client = FeedbackLinks()
    path, link, sha = await _shared_plan(home, client)
    dead = [
        {"feedbackId": f"{i:032x}", "linkId": "bad id!", "cipher": "x", "version": 1, "contentHash": sha}
        for i in range(50)
    ]
    good = _item(link, {"v": 1, "action": "approve", "text": "", "contentSha256": sha, "version": 1}, fid="ab" * 16)
    client.queue.extend([*dead, good])
    await share_feedback.drain(client)
    assert _meta(path)["stage"] == "approved"
    assert len(client.acked) == 51


@pytest.mark.parametrize("code", ["LINK_OFFLINE", "LINK_UNAUTHORIZED", "NOT_CONFIGURED"])
async def test_a_dropped_link_leaves_feedback_for_the_next_drain(ring, home, broadcasts, code) -> None:
    client = FeedbackLinks()
    path, link, sha = await _shared_plan(home, client)
    real = client.request

    async def offline(verb: str, payload: dict[str, Any]) -> dict[str, Any]:
        if verb == "unwrap":
            raise share_links.ShareRemoteError(code, "down")
        return await real(verb, payload)

    client.request = offline  # type: ignore[method-assign]
    client.queue.append(_item(link, {"v": 1, "action": "approve", "text": "", "contentSha256": sha, "version": 1}))
    await share_feedback.drain(client)
    assert client.acked == [] and broadcasts == []
    assert sum(1 for verb, _ in client.calls if verb == "feedback.list") == 1  # stops, does not spin
    client.request = real  # type: ignore[method-assign]
    await share_feedback.drain(client)
    assert _meta(path)["stage"] == "approved"


async def test_no_account_ring_leaves_feedback_for_later(home, broadcasts, monkeypatch) -> None:
    client = FeedbackLinks()
    monkeypatch.setattr(sync_keyring, "account_key", lambda: None)

    async def no_ring(verb: str, payload: dict[str, Any]) -> dict[str, Any]:
        if verb == "unwrap":
            raise sync_keyring.KeyringError("no ring")
        return await FeedbackLinks.request(client, verb, payload)

    client.request = no_ring  # type: ignore[method-assign]
    client.queue.append({"feedbackId": "cd" * 16, "linkId": "ab" * 16, "cipher": "x", "version": 1})
    await share_feedback.drain(client)
    assert client.acked == [] and broadcasts == []


async def test_the_masking_scan_runs_off_the_event_loop(ring, home, broadcasts, monkeypatch) -> None:
    """B7-4: prepare masks up to 32 MiB; on the loop it froze the backend."""
    import threading

    client = FeedbackLinks()
    path, link, sha = await _shared_plan(home, client)
    loop_thread = threading.get_ident()
    seen: list[bool] = []
    real = share_links.prepare

    def spy(*args: Any, **kwargs: Any) -> Any:
        seen.append(threading.get_ident() == loop_thread)
        return real(*args, **kwargs)

    monkeypatch.setattr(share_links, "prepare", spy)
    client.queue.append(_item(link, {"v": 1, "action": "approve", "text": "", "contentSha256": sha, "version": 1}))
    await share_feedback.drain(client)
    assert seen == [False]


async def test_a_path_outside_the_plans_folder_is_refused_before_it_is_read(ring, home, broadcasts, monkeypatch) -> None:
    """B7-4: the plan-location check comes before prepare reads the file."""
    client = FeedbackLinks()
    path, link, sha = await _shared_plan(home, client)
    read: list[str] = []
    monkeypatch.setattr(share_links, "_open_meta", lambda *a: {"path": str(home / "notes.html"), "sha256": sha, "title": "t"})
    monkeypatch.setattr(share_links, "prepare", lambda p, k: read.append(p))
    client.queue.append(_item(link, {"v": 1, "action": "approve", "text": "", "contentSha256": sha, "version": 1}))
    await share_feedback.drain(client)
    assert read == []
    assert broadcasts[-1]["payload"]["reason"] == "not-a-plan"


@pytest.mark.parametrize(
    "fid",
    ["Z" * 200_000, "F1" * 16, "f1" * 15, "", None],
    # A 200 000-character test id is a path too long for Windows' tmp_path.
    ids=["huge", "upper-hex", "short", "empty", "none"],
)
async def test_a_feedback_id_that_is_not_the_servers_shape_is_ignored(ring, home, broadcasts, fid) -> None:
    """B7-5: a 200 000-character id was written into the seen file as is."""
    client = FeedbackLinks()
    path, link, sha = await _shared_plan(home, client)
    item = _item(link, {"v": 1, "action": "note", "text": "x", "contentSha256": sha, "version": 1})
    item["feedbackId"] = fid
    assert await share_feedback.handle_event(client, item) is False
    assert not share_feedback._seen_path().exists()
    assert broadcasts == []


async def test_a_phone_approval_is_refused_while_plans_is_disabled(ring, home, broadcasts, monkeypatch) -> None:
    client = FeedbackLinks()
    path, link, sha = await _shared_plan(home, client)
    before = path.read_text(encoding="utf-8")
    client.queue.append(_item(link, {"v": 1, "action": "approve", "text": "", "contentSha256": sha, "version": 1}))
    monkeypatch.setattr(app, "host_disabled_plugins", lambda: frozenset({"navide.plans"}))

    await share_feedback.drain(client)

    # Refused and acked like any other refusal; the plan is untouched.
    assert path.read_text(encoding="utf-8") == before
    assert client.acked == ["f1" * 16]
    assert broadcasts[-1]["payload"]["result"] == "rejected"
    assert broadcasts[-1]["payload"]["reason"] == "plugin-disabled"


async def test_feedback_drained_before_the_host_registers_respects_a_disabled_plans(
    ring, home, broadcasts, monkeypatch,
) -> None:
    """The startup drain runs before main's host.register; main passed the
    switch at spawn, so the approval is still refused."""
    client = FeedbackLinks()
    path, link, sha = await _shared_plan(home, client)
    before = path.read_text(encoding="utf-8")
    client.queue.append(_item(link, {"v": 1, "action": "note", "text": "hi", "contentSha256": sha, "version": 1}))
    monkeypatch.setattr(app, "_host_reported_disabled", None)
    monkeypatch.setenv(app.DISABLED_BUILTIN_PLUGINS_ENV, "navide.plans")

    await share_feedback.drain(client)

    assert path.read_text(encoding="utf-8") == before
    assert broadcasts[-1]["payload"]["reason"] == "plugin-disabled"

"""The manager's side of chat attachments: what is downloaded, what the pane is told,
and which files a pane's reply may send."""

from __future__ import annotations

import dataclasses
import time
from pathlib import Path

import pytest

from agent_team_backend import osplat
from agent_team_backend.channels import media
from agent_team_backend.channels.base import (
    ChannelSendError, InboundAttachment, InboundMessage, Location, MediaTooLarge,
)

from .test_manager import _MIDS, Env, _armed, _said, _until, env, fast_timers  # noqa: F401 — fixtures


# Windows creates symlinks only with Developer Mode or elevation.
needs_symlinks = pytest.mark.skipif(not osplat.paths.symlinks_available(),
                                    reason="this Windows session may not create symlinks")


class Media:
    """Gives a FakeAdapter the MediaAdapter methods and records their use."""

    def __init__(self, adapter, upload_max: int = 50 * 1024 * 1024) -> None:
        self.downloads: list[tuple[InboundAttachment, Path, int]] = []
        self.files: list[tuple[Location, bytes, str]] = []
        self.captions: list = []
        self.payload = b"PNGDATA"
        self.fail: Exception | None = None
        adapter.upload_max_bytes = upload_max
        adapter.download = self.download
        adapter.send_file = self.send_file

    async def download(self, att: InboundAttachment, dest: Path, max_bytes: int) -> int:
        self.downloads.append((att, dest, max_bytes))
        if self.fail is not None:
            raise self.fail
        dest.write_bytes(self.payload)
        return len(self.payload)

    async def send_file(self, loc: Location, fh, filename: str, caption=None) -> list[str]:
        self.files.append((loc, fh.read(), filename))
        self.captions.append(caption)
        return [f"f{len(self.files)}"]


@pytest.fixture
def ws(tmp_path: Path) -> Path:
    root = tmp_path / "ws"
    (root / "out").mkdir(parents=True)
    (root / "out" / "chart.png").write_bytes(b"chart")
    return root


@pytest.fixture
def media_env(env: Env, tmp_path: Path, ws: Path) -> Env:
    env.m._seams = dataclasses.replace(env.m._seams, media_root=lambda: tmp_path / "media",
                                       pane_workspace=lambda _p: str(ws))
    return env


PHOTO = InboundAttachment(kind="photo", name="", size=1024, mime="image/jpeg", ref="file-1")


async def _send(env: Env, text: str, attachments: list[InboundAttachment], *, sender: str = "7",
                direct: bool = False, chat: str = "-100", thread: str = "50") -> None:
    await env.m.handle_inbound(InboundMessage(
        platform="telegram", account="default", chat_id=chat, thread_id=thread, sender_id=sender,
        sender_name="alice", text=text, message_id=f"m{next(_MIDS)}", is_direct=direct, ts=time.time(),
        attachments=attachments))
    await env.m.wait_idle()


# --- inbound ------------------------------------------------------------------------


async def test_an_allowed_senders_photo_is_saved_and_named_to_the_pane(media_env: Env, tmp_path: Path) -> None:
    m = Media(media_env.tg)
    await _send(media_env, "look at this", [PHOTO])
    (att, dest, cap), = m.downloads
    assert att == PHOTO and cap == media.INBOUND_MAX_BYTES
    assert dest.parent == tmp_path / "media" / "pane-1" and dest.name.endswith("-photo.jpg")
    assert media_env.fake.delivered[-1] == (
        "pane-1", f"look at this\n[附件] photo photo.jpg 7 B → {dest}", "telegram:alice")


async def test_an_attachment_alone_is_delivered(media_env: Env) -> None:
    m = Media(media_env.tg)
    doc = InboundAttachment(kind="document", name="../../report.pdf", size=None, mime="application/pdf", ref="f")
    await _send(media_env, "", [doc])
    dest = m.downloads[0][1]
    assert dest.name.endswith("-report.pdf")
    assert media_env.fake.delivered[-1][1] == f"[附件] document report.pdf 7 B → {dest}"


async def test_a_declared_oversize_file_is_not_downloaded(media_env: Env) -> None:
    m = Media(media_env.tg)
    big = dataclasses.replace(PHOTO, size=media.INBOUND_MAX_BYTES + 1)
    await _send(media_env, "big one", [big])
    assert m.downloads == []
    assert media_env.fake.delivered[-1][1] == "big one"
    assert _said(media_env, "20 MB")


async def test_a_download_that_runs_past_the_cap_is_refused(media_env: Env) -> None:
    m = Media(media_env.tg)
    m.fail = MediaTooLarge("over")
    await _send(media_env, "", [dataclasses.replace(PHOTO, size=None)])
    assert media_env.fake.delivered == [] and _said(media_env, "20 MB")


async def test_a_failed_download_is_reported_and_the_text_still_goes(media_env: Env) -> None:
    m = Media(media_env.tg)
    m.fail = ChannelSendError("HTTP 500")
    await _send(media_env, "caption", [PHOTO])
    assert media_env.fake.delivered[-1][1] == "caption" and _said(media_env, "HTTP 500")


async def test_a_platform_without_media_says_so(media_env: Env) -> None:
    await _send(media_env, "caption", [PHOTO])  # the plain FakeAdapter has no download
    assert media_env.fake.delivered[-1][1] == "caption"
    assert _said(media_env, "此平台尚不支援媒體")


async def test_a_group_strangers_file_is_never_downloaded(media_env: Env) -> None:
    m = Media(media_env.tg)
    await _send(media_env, "hi", [PHOTO], sender="999")
    assert m.downloads == [] and media_env.fake.delivered == []


async def test_a_dm_strangers_file_is_never_downloaded(media_env: Env) -> None:
    m = Media(media_env.tg)
    await _send(media_env, "hi", [PHOTO], sender="998", direct=True, chat="998", thread="")
    assert m.downloads == [] and media_env.fake.delivered == []


async def test_old_media_is_pruned_when_a_new_file_arrives(media_env: Env, tmp_path: Path) -> None:
    old = tmp_path / "media" / "pane-9" / "abcd-old.png"
    old.parent.mkdir(parents=True)
    old.write_bytes(b"x")
    import os
    stale = time.time() - media.RETENTION_S - 60
    os.utime(old, (stale, stale))
    Media(media_env.tg)
    await _send(media_env, "", [PHOTO])
    assert not old.exists()


# --- outbound -----------------------------------------------------------------------


def _msg(body: str) -> str:
    return f"---MSG-START--- to: telegram:alice\n{body}\n---MSG-END---"


async def test_a_reply_sends_a_workspace_file(media_env: Env, ws: Path) -> None:
    m = Media(media_env.tg)
    await _armed(media_env)
    media_env.turn_complete("pane-1", _msg(f"here it is\n---ATTACH--- {ws}/out/chart.png"))
    await _until(lambda: m.files)
    loc, data, name = m.files[0]
    assert (loc.chat_id, loc.thread_id, data, name) == ("-100", "50", b"chart",
                                                       "chart.png")
    assert _said(media_env, "here it is") and not _said(media_env, "ATTACH")


async def test_a_reply_with_only_a_file_posts_no_empty_text(media_env: Env, ws: Path) -> None:
    m = Media(media_env.tg)
    await _armed(media_env)
    before = len(media_env.tg.texts())
    media_env.turn_complete("pane-1", _msg(f"---ATTACH--- {ws}/out/chart.png"))
    await _until(lambda: m.files)
    await media_env.m.wait_idle()
    assert not any("沒有文字輸出" in t for t in media_env.tg.texts()[before:])


@pytest.mark.parametrize("target, reason", [
    ("/etc/hosts", "system"),
    ("{ws}/.env", "denied_name"),
    ("{ws}/out/../out/chart.png", "parent_ref"),
    ("{ws}/out/id_rsa", "denied_name"),
])
async def test_a_refused_file_is_not_sent_and_the_chat_hears_why(media_env: Env, ws: Path, target: str,
                                                                 reason: str) -> None:
    (ws / ".env").write_text("SECRET=1")
    (ws / "out" / "id_rsa").write_text("key")
    m = Media(media_env.tg)
    await _armed(media_env)
    media_env.turn_complete("pane-1", _msg(f"see file\n---ATTACH--- {target.format(ws=ws)}"))
    await _until(lambda: _said(media_env, "see file"))
    await _until(lambda: _said(media_env, "⚠️"))
    assert m.files == [] and not _said(media_env, "SECRET")


@needs_symlinks
async def test_a_symlink_to_a_secret_is_not_sent(media_env: Env, ws: Path, tmp_path: Path) -> None:
    secret = tmp_path / "secret.txt"
    secret.write_text("SECRET=1")
    (ws / "out" / "notes.txt").symlink_to(secret)
    m = Media(media_env.tg)
    await _armed(media_env)
    media_env.turn_complete("pane-1", _msg(f"notes\n---ATTACH--- {ws}/out/notes.txt"))
    await _until(lambda: _said(media_env, "⚠️"))
    assert m.files == []


async def test_a_file_over_the_platform_limit_is_not_sent(media_env: Env, ws: Path) -> None:
    m = Media(media_env.tg, upload_max=3)
    await _armed(media_env)
    media_env.turn_complete("pane-1", _msg(f"big\n---ATTACH--- {ws}/out/chart.png"))
    await _until(lambda: _said(media_env, "⚠️"))
    assert m.files == []


async def test_a_platform_without_media_tells_the_chat_instead_of_sending(media_env: Env, ws: Path) -> None:
    await _armed(media_env)
    media_env.turn_complete("pane-1", _msg(f"file\n---ATTACH--- {ws}/out/chart.png"))
    await _until(lambda: _said(media_env, "此平台尚不支援媒體"))


async def test_attach_lines_outside_an_msg_block_are_never_honoured(media_env: Env, ws: Path) -> None:
    m = Media(media_env.tg)
    await _armed(media_env)
    media_env.turn_complete("pane-1", f"plain turn\n---ATTACH--- {ws}/out/chart.png")
    await _until(lambda: _said(media_env, "plain turn"))
    await media_env.m.wait_idle()
    assert m.files == [] and not _said(media_env, "ATTACH")


async def test_a_reply_sends_the_panes_own_received_file(media_env: Env, tmp_path: Path) -> None:
    own = tmp_path / "media" / "pane-1" / "abcd1234-photo.jpg"
    own.parent.mkdir(parents=True)
    own.write_bytes(b"JPEG")
    m = Media(media_env.tg)
    await _armed(media_env)
    media_env.turn_complete("pane-1", _msg(f"back to you\n---ATTACH--- {own}"))
    await _until(lambda: m.files)
    assert m.files[0][1:] == (b"JPEG", "abcd1234-photo.jpg")


async def test_a_file_outside_the_workspace_goes_and_is_logged(media_env: Env, tmp_path: Path, caplog) -> None:
    """No scope any more (2026-10-08): another pane's received file goes too; the log records it."""
    import logging

    theirs = tmp_path / "media" / "pane-2" / "abcd1234-photo.png"
    theirs.parent.mkdir(parents=True)
    theirs.write_bytes(b"PNG")
    caplog.set_level(logging.INFO, logger="agent_team_backend.channels.manager")
    m = Media(media_env.tg)
    await _armed(media_env)
    media_env.turn_complete("pane-1", _msg(f"here\n---ATTACH--- {theirs}"))
    await _until(lambda: m.files)
    assert m.files[0][1:] == (b"PNG", "abcd1234-photo.png") and not _said(media_env, "⚠️")
    assert any("outside the pane's workspace" in r.getMessage() and "abcd1234-photo.png" in r.getMessage()
               for r in caplog.records)


async def test_a_file_in_the_workspace_is_not_logged_as_outside(media_env: Env, ws: Path, caplog) -> None:
    import logging

    caplog.set_level(logging.INFO, logger="agent_team_backend.channels.manager")
    m = Media(media_env.tg)
    await _armed(media_env)
    media_env.turn_complete("pane-1", _msg(f"here\n---ATTACH--- {ws}/out/chart.png"))
    await _until(lambda: m.files)
    assert not any("outside the pane's workspace" in r.getMessage() for r in caplog.records)


# --- Hardening ----------------------------------------------------------------------


async def test_a_home_folder_workspace_sends_its_files(media_env: Env, tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "Users" / "me"
    (home / "Documents").mkdir(parents=True)
    (home / "Documents" / "tax.pdf").write_bytes(b"PDF")
    monkeypatch.setattr(media, "_home", lambda: home)
    media_env.m._seams = dataclasses.replace(media_env.m._seams, pane_workspace=lambda _p: str(home))
    m = Media(media_env.tg)
    await _armed(media_env)
    media_env.turn_complete("pane-1", _msg(f"here\n---ATTACH--- {home}/Documents/tax.pdf"))
    await _until(lambda: m.files)
    assert m.files[0][1:] == (b"PDF", "tax.pdf")


async def test_a_refusal_names_the_file_but_not_its_folders(media_env: Env, ws: Path) -> None:
    (ws / "deep" / "secrets").mkdir(parents=True)
    (ws / "deep" / "secrets" / "plan.txt").write_text("x")
    Media(media_env.tg)
    await _armed(media_env)
    media_env.turn_complete("pane-1", _msg(f"see\n---ATTACH--- {ws}/deep/secrets/plan.txt"))
    await _until(lambda: _said(media_env, "⚠️"))
    note = next(t for t in media_env.tg.texts() if "⚠️" in t)
    assert "plan.txt" in note and str(ws) not in note and "deep" not in note and "secrets" not in note


async def test_attach_lines_a_chat_sends_in_never_send_anything(media_env: Env, ws: Path) -> None:
    m = Media(media_env.tg)
    await _send(media_env, f"---ATTACH--- {ws}/out/chart.png", [])
    media_env.fake.verdicts["k1"] = {"status": "delivered"}
    await media_env.m.wait_idle()
    assert m.files == [] and media_env.fake.delivered[-1][1] == f"---ATTACH--- {ws}/out/chart.png"


async def test_a_quoted_attach_line_in_a_reply_is_not_an_attachment(media_env: Env, ws: Path) -> None:
    m = Media(media_env.tg)
    await _armed(media_env)
    media_env.turn_complete("pane-1", _msg(f"you said:\n> ---ATTACH--- {ws}/out/chart.png"))
    await _until(lambda: _said(media_env, "you said:"))
    await media_env.m.wait_idle()
    assert m.files == []


# --- failures that must not lose the message or the other files -------------------


async def test_a_file_that_fails_to_open_is_refused_and_the_next_still_goes(
        media_env: Env, ws: Path, monkeypatch) -> None:
    (ws / "out" / "b.png").write_bytes(b"second")
    real_open = media.open_outbound

    def flaky(raw):
        if raw.endswith("chart.png"):
            raise OSError(5, "Input/output error")
        return real_open(raw)

    monkeypatch.setattr(media, "open_outbound", flaky)
    m = Media(media_env.tg)
    await _armed(media_env)
    media_env.turn_complete("pane-1", _msg(
        f"two files\n---ATTACH--- {ws}/out/chart.png\n---ATTACH--- {ws}/out/b.png"))
    await _until(lambda: m.files)
    assert [f[2] for f in m.files] == ["b.png"]
    await _until(lambda: _said(media_env, "chart.png"))


async def test_a_failed_download_names_no_local_folder(media_env: Env) -> None:
    m = Media(media_env.tg)
    m.fail = PermissionError(13, "Permission denied", "/Users/someone/Library/channels-media/x")
    await _send(media_env, "caption", [PHOTO])
    assert _said(media_env, "Permission denied") and not _said(media_env, "/Users/someone")


async def test_a_media_folder_that_cannot_be_made_still_delivers_the_text(media_env: Env, tmp_path: Path) -> None:
    Media(media_env.tg)
    (tmp_path / "media").write_text("a file where the folder should be")
    await _send(media_env, "caption", [PHOTO])
    assert media_env.fake.delivered[-1][1] == "caption"
    assert _said(media_env, "photo.jpg")


async def test_files_still_go_when_the_reply_text_falls_back_to_the_turn_text(
        media_env: Env, ws: Path, monkeypatch) -> None:
    real_post = media_env.m._post_reply
    calls: list[str] = []

    async def first_fails(pending, body):
        calls.append(body)
        return False if len(calls) == 1 else await real_post(pending, body)

    monkeypatch.setattr(media_env.m, "_post_reply", first_fails)
    m = Media(media_env.tg)
    await _armed(media_env)
    media_env.turn_complete("pane-1", _msg(f"here it is\n---ATTACH--- {ws}/out/chart.png"))
    await _until(lambda: m.files)
    assert m.files[0][2] == "chart.png" and len(calls) == 2


async def test_a_file_in_a_hidden_folder_goes_and_is_logged(media_env: Env, ws: Path, caplog) -> None:
    import logging

    report = ws / ".reports" / "NT---20261008.pdf"
    report.parent.mkdir()
    report.write_bytes(b"%PDF-1.7")
    caplog.set_level(logging.INFO, logger="agent_team_backend.channels.manager")
    m = Media(media_env.tg)
    await _armed(media_env)
    media_env.turn_complete("pane-1", _msg(f"here\n---ATTACH--- {report}"))
    await _until(lambda: m.files)
    assert m.files[0][1:] == (b"%PDF-1.7", "NT---20261008.pdf")
    assert not _said(media_env, "⚠️")
    assert any("hidden path" in r.getMessage() and "NT---20261008.pdf" in r.getMessage() for r in caplog.records)

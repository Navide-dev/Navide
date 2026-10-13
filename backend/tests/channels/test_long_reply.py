"""C2: a long reply goes as a short preview plus the whole text as a file, not a wall of chunks."""

from __future__ import annotations

from agent_team_backend.channels import manager as mgr_mod
from agent_team_backend.channels import mirror as mirror_mod
from agent_team_backend.channels.text import chunk_for

from .test_manager import Env, _armed, _said, _until, env, fast_timers  # noqa: F401 — fixtures
from .test_media_flow import Media, _msg, media_env, ws  # noqa: F401 — fixtures
from .test_mirror import NO_THREADS, _pane, _set_verbosity, _use_directory

LONG = "\n".join(f"第 {i} 行：這是一段很長的回覆內容。" for i in range(1200))


async def test_a_reply_past_the_chunk_limit_goes_as_a_preview_and_a_file(media_env: Env) -> None:
    assert len(chunk_for("telegram", LONG)) > mgr_mod.LONG_REPLY_MAX_CHUNKS
    m = Media(media_env.tg)
    await _armed(media_env)
    before = len(media_env.tg.texts())
    media_env.turn_complete("pane-1", _msg(LONG))
    await _until(lambda: m.files)
    await _until(lambda: _said(media_env, "完整內容見附件"))
    posted = media_env.tg.texts()[before:]
    assert len(posted) == 1 and "\n第 0 行" in posted[0] and "完整內容見附件" in posted[0]
    (_loc, data, name), = m.files
    assert data.decode() == LONG and name.startswith("reply-") and name.endswith(".md")
    assert m.captions[0].title == "完整回覆" and m.captions[0].summary == "第 0 行：這是一段很長的回覆內容。"


async def test_a_reply_within_the_limit_is_still_chunked(media_env: Env) -> None:
    text = "\n".join(LONG.split("\n")[:300])
    assert 1 < len(chunk_for("telegram", text)) <= mgr_mod.LONG_REPLY_MAX_CHUNKS
    m = Media(media_env.tg)
    await _armed(media_env)
    media_env.turn_complete("pane-1", _msg(text))
    await _until(lambda: _said(media_env, "第 299 行"))
    await media_env.m.wait_idle()
    assert m.files == []


async def test_a_platform_without_files_gets_every_chunk(media_env: Env) -> None:
    media_env.tg.rate_per_min = 6000  # type: ignore[attr-defined] — about content, not pacing
    await _armed(media_env)
    media_env.turn_complete("pane-1", _msg(LONG))
    await _until(lambda: _said(media_env, "第 1199 行"))
    assert not _said(media_env, "完整內容見附件")


async def test_a_childs_summary_comes_with_the_whole_text(env: Env) -> None:
    env.tg.capabilities = NO_THREADS
    m = Media(env.tg)
    _use_directory(env, [_pane("pane-1", "main"), _pane("pane-2", "tester", "pane-1")])
    await env.m.mirror.sync_lineage()
    _set_verbosity(env, "standard")
    env.turn_complete("pane-2", "T" * 900)
    await _until(lambda: m.files)
    await _until(lambda: _said(env, "完整內容見附件"))
    assert not _said(env, "完整內容請在 Navide 查看")
    assert m.files[0][1] == b"T" * 900
    assert mirror_mod.CHILD_SUMMARY_CHARS < 900


async def test_when_the_file_fails_the_rest_of_the_reply_still_goes(media_env: Env) -> None:
    from agent_team_backend.channels.base import ChannelSendError

    media_env.tg.rate_per_min = 6000  # type: ignore[attr-defined]
    m = Media(media_env.tg)

    async def broken(loc, fh, filename, caption=None):
        raise ChannelSendError("HTTP 500")

    media_env.tg.send_file = broken
    await _armed(media_env)
    media_env.turn_complete("pane-1", _msg(LONG))
    await _until(lambda: _said(media_env, "第 1199 行"))
    text = "".join(media_env.tg.texts())
    assert all(f"第 {i} 行" in text for i in range(1200)) and m.files == []

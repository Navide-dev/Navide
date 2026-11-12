"""account_switch_verify: the read-only post-switch login check.

Every credential here is a fake built at runtime; nothing touches a Keychain.
"""
from __future__ import annotations

import asyncio
import json

import pytest

from agent_team_backend import account_switch_verify as asv


def _blob(access: str, refresh: str) -> str:
    return json.dumps({"claudeAiOauth": {"accessToken": access, "refreshToken": refresh}})


def _fake(n: int) -> str:
    return "fake-" + "x" * n


class _Clock:
    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t


def _run(readings, *, window_s=60.0, interval_s=10.0):
    """Drive watch() over a scripted sequence of live readings."""
    clock = _Clock()
    seq = list(readings)
    notices: list[tuple[str, str, str]] = []

    async def read_live():
        value = seq.pop(0) if len(seq) > 1 else seq[0]
        if isinstance(value, Exception):
            raise value
        return value

    async def notify(agent, slot, reason):
        notices.append((agent, slot, reason))

    async def fake_sleep(s):
        clock.t += s

    async def main():
        return await asv.watch("claude", "slotA", read_live, notify, window_s=window_s,
                               interval_s=interval_s, clock=clock, sleep=fake_sleep)

    return asyncio.run(main()), notices


def test_restored_login_already_wiped_tells_the_user_once():
    result, notices = _run([_blob("", "")])
    assert result == "needs-login"
    assert notices == [("claude", "slotA", "needs-login")]


def test_nothing_signed_in_after_restore_needs_login():
    result, notices = _run([None])
    assert result == "needs-login"
    assert len(notices) == 1


def test_wiped_later_in_the_window_needs_login():
    good = _blob(_fake(8), _fake(9))
    result, notices = _run([good, good, _blob("", "")])
    assert result == "needs-login"
    assert len(notices) == 1


def test_a_renewed_credential_is_healthy_and_silent():
    result, notices = _run([_blob(_fake(8), _fake(9)), _blob(_fake(10), _fake(11))])
    assert result == "renewed"
    assert notices == []


def test_unchanged_until_the_window_ends_is_silent():
    good = _blob(_fake(8), _fake(9))
    result, notices = _run([good], window_s=30.0, interval_s=10.0)
    assert result == "timeout"
    assert notices == []


def test_a_read_failure_ends_the_check_without_a_notice():
    result, notices = _run([RuntimeError("keychain locked")])
    assert result == "error"
    assert notices == []


def test_verdict_never_needs_the_secret_value_beyond_its_digest():
    good = _blob(_fake(8), _fake(9))
    fp = asv._fingerprint(good)
    assert asv.verdict(good, fp) == "unchanged"
    assert asv.verdict(_blob(_fake(8), ""), fp) == "renewed"  # access token alone still signs in
    assert asv.verdict(_blob("", ""), fp) == "needs-login"


def test_start_watches_claude_only_and_supersedes_the_earlier_watch():
    async def main():
        never = asyncio.Event()

        async def read_live():
            await never.wait()
            return None

        async def notify(*_):
            raise AssertionError("no notice expected")

        assert asv.start("codex", "s", read_live, notify) is None
        first = asv.start("claude", "s1", read_live, notify)
        second = asv.start("claude", "s2", read_live, notify)
        await asyncio.sleep(0)
        assert first.cancelled() or first.cancelling()
        assert not second.done()
        asv._reset_for_test()
        await asyncio.sleep(0)

    asyncio.run(main())


@pytest.mark.parametrize("lang", ["zh-TW", "en-US", "ja-JP", "zh-CN", "ko-KR", "es-ES",
                                  "fr-FR", "de-DE", "pt-BR", "ru-RU", "vi-VN"])
def test_the_chat_notice_exists_in_every_language(lang):
    from agent_team_backend.channels import quick_menu

    text = quick_menu.text(lang, "account_needs_login", account="Account 5")
    assert "Account 5" in text and "/login" in text

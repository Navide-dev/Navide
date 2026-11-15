"""/shipped [window] in a bound chat: the backend answers with the bound pane's
workspace Shipped Log, masked, without waking the pane."""

from __future__ import annotations

import os
import subprocess
import time
from pathlib import Path

import pytest

from agent_team_backend import osplat
from agent_team_backend.channels import redact, shipped_cmds
from agent_team_backend.channels.manager import MSG_NOT_BOUND
from agent_team_backend.plugins.builtin.navide_shipped_log import messages
from agent_team_backend.plugins.builtin.navide_shipped_log.ledger import ledger

from .test_manager import Env, env, fast_timers  # noqa: F401 — pytest fixtures


def _fake_npm_token() -> str:
    return "np" + "m_" + "Zq7" * 12


@pytest.mark.parametrize(("body", "parsed"), [
    ("/shipped", ""),
    ("/shipped 昨天", "昨天"),
    ("/shipped@navide_bot 7d", "7d"),
    ("/SHIPPED 2026-11-15T09:00", "2026-11-15T09:00"),
    ("/shipped@other_bot 7d", None),
    ("/ship 7d", None),
    ("please /shipped", None),
])
def test_parse_command(body: str, parsed: str | None) -> None:
    assert shipped_cmds.parse_command(body, "@navide_bot") == parsed


@pytest.mark.parametrize(("text", "masked"), [
    ("mail rachel@dealpilot.tw now", "mail r***@dealpilot.tw now"),
    ("a.b+c@mail.example.co.uk", "a***@mail.example.co.uk"),
    ("no address @here or a@b", "no address @here or a@b"),
])
def test_email_mask(text: str, masked: str) -> None:
    assert redact.mask_emails(text) == masked


def test_mask_cuts_secrets_and_emails() -> None:
    out = shipped_cmds.mask(f"key {_fake_npm_token()} by ops@example.com")
    assert _fake_npm_token() not in out and "ops@example.com" not in out and "o***@example.com" in out


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    path = tmp_path / "ws"
    path.mkdir()
    return path


async def test_shipped_lists_the_bound_workspace_and_hides_sensitive_details(env: Env, workspace: Path) -> None:
    env.m._seams.pane_workspace = lambda pane_id: str(workspace) if pane_id == "pane-1" else ""  # noqa: SLF001
    now = int(time.time())
    ledger.record(str(workspace), summary="Reports now mail billing@dealpilot.tw", source_kind="other", at=now - 60)
    ledger.record(str(workspace), summary="SMTP relay switched", source_kind="config", ref="ops-42", at=now - 30)

    await env.inbound("/shipped 1d")

    reply = env.tg.texts()[-1]
    assert "b***@dealpilot.tw" in reply and "billing@dealpilot.tw" not in reply
    assert "SMTP relay switched" not in reply and "ops-42" not in reply
    assert messages.text("zh-TW", "sensitive_count", count=1) in reply
    assert env.fake.delivered == []  # answered by the backend; the pane never woke


async def test_shipped_with_a_bad_window_shows_the_usage(env: Env, workspace: Path) -> None:
    env.m._seams.pane_workspace = lambda pane_id: str(workspace)  # noqa: SLF001
    await env.inbound("/shipped last week")
    assert env.tg.texts()[-1] == messages.text("zh-TW", "usage")
    assert env.fake.delivered == []


async def test_shipped_without_a_workspace_says_so(env: Env) -> None:
    await env.inbound("/shipped")
    assert env.tg.texts()[-1] == messages.text("zh-TW", "no_workspace")


async def test_an_unbound_chat_keeps_the_current_rules(env: Env) -> None:
    await env.inbound("/shipped", thread="99")
    assert env.tg.texts()[-1] == MSG_NOT_BOUND


@pytest.mark.skipif(osplat.paths.resolve_program("git") is None, reason="git is not resolvable")
async def test_shipped_reads_the_deploy_branch_too(env: Env, workspace: Path) -> None:
    git_env = {**os.environ, "GIT_CONFIG_NOSYSTEM": "1"}

    def git(*args: str) -> None:
        subprocess.run(["git", *args], cwd=workspace, env=git_env, check=True, capture_output=True)

    git("init", "-q", "-b", "main")
    git("config", "user.email", "t@example.invalid")
    git("config", "user.name", "T")
    git("config", "commit.gpgsign", "false")
    (workspace / "f").write_text("x", encoding="utf-8")
    git("add", "f")
    git("commit", "-q", "-m", "feat: invoices export")
    env.m._seams.pane_workspace = lambda pane_id: str(workspace)  # noqa: SLF001

    await env.inbound("/shipped 今天")

    reply = env.tg.texts()[-1]
    assert reply.startswith("🚀") and "新增 invoices export" in reply and "branch" in reply

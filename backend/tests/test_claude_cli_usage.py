"""Reading the CLI's own /usage report via ``claude -p /usage``.

The sample is the plain text Claude Code v2.1.245 prints for the print-mode
command — one line per window, no escape sequences, no repaints.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from agent_team_backend.cli_vendors import claude as cu

PRINTED_REPORT = """\
You are currently using your subscription to power your Claude Code usage

Current session: 61% used · resets Aug 26 at 5:29am (Asia/Taipei)
Current week (all models): 63% used · resets Aug 26 at 4:59am (Asia/Taipei)
Current week (Fable): 35% used · resets Aug 26 at 4:59am (Asia/Taipei)

What's contributing to your limits usage?
- Long sessions
"""
NOW = datetime(2026, 8, 25, 23, 20, tzinfo=ZoneInfo("Asia/Taipei"))


# ── parser ──────────────────────────────────────────────────────────────────


def test_reads_every_window_from_the_printed_report() -> None:
    windows = cu.parse_usage_panel(PRINTED_REPORT, now=NOW)

    assert [(w["kind"], w["label"], w["usedPercent"]) for w in windows] == [
        ("session", "Session (5h)", 61.0),
        ("weekly", "Weekly (all models)", 63.0),
        ("weekly-model", "Weekly (Fable)", 35.0),
    ]


def test_reset_times_become_timestamps_the_ui_can_count_down() -> None:
    session, weekly, fable = cu.parse_usage_panel(PRINTED_REPORT, now=NOW)

    # "resets Aug 26 at 5:29am (Asia/Taipei)" == 2026-08-25T21:29Z
    assert session["resetsAt"] == "2026-08-25T21:29:00Z"
    assert weekly["resetsAt"] == "2026-08-25T20:59:00Z"
    assert fable["resetsAt"] == "2026-08-25T20:59:00Z"


def test_other_model_windows_are_labelled_generically() -> None:
    report = (
        "Current session: 10% used · resets 6am (Asia/Taipei)\n"
        "Current week (Opus): 20% used · resets Aug 30 at 1pm (Asia/Taipei)\n"
        "Current week (Sonnet): 30% used · resets Aug 30 at 1pm (Asia/Taipei)\n"
    )

    windows = cu.parse_usage_panel(report, now=NOW)

    assert [(w["kind"], w["label"], w["usedPercent"]) for w in windows[1:]] == [
        ("weekly-model", "Weekly (Opus)", 20.0),
        ("weekly-model", "Weekly (Sonnet)", 30.0),
    ]
    # "resets 6am" — a bare clock time means the next one.
    assert windows[0]["resetsAt"] == "2026-08-25T22:00:00Z"


def test_an_unparseable_reset_is_dropped_not_guessed() -> None:
    """A localized or reworded phrase must cost the countdown, never produce a
    fabricated timestamp."""
    window = cu.parse_usage_panel("Current session: 50% used · resets bientôt\n", now=NOW)[0]

    assert window["usedPercent"] == 50.0
    assert window["resetsAt"] is None


def test_a_window_without_a_figure_is_dropped() -> None:
    report = (
        "Current session: resets 6am (Asia/Taipei)\n"
        "Current week (all models): 92% used · resets Aug 30 at 1pm (Asia/Taipei)\n"
    )

    assert [w["kind"] for w in cu.parse_usage_panel(report, now=NOW)] == ["weekly"]


def test_a_report_without_usage_yields_nothing() -> None:
    assert cu.parse_usage_panel("Unknown command: /usage\n") == []


# ── invocation ──────────────────────────────────────────────────────────────


class _FakeProc:
    def __init__(self, stdout: bytes = b"", stderr: bytes = b"", rc: int = 0,
                 hang: bool = False) -> None:
        self._stdout, self._stderr, self._hang = stdout, stderr, hang
        self.returncode = rc
        self.pid = 4242

    async def communicate(self):
        if self._hang:
            await asyncio.sleep(3600)
        return self._stdout, self._stderr

    async def wait(self):
        return self.returncode


def _fake_exec(monkeypatch, proc: _FakeProc) -> list[dict]:
    calls: list[dict] = []

    async def create(*argv, **kwargs):
        calls.append({"argv": argv, **kwargs})
        return proc

    monkeypatch.setattr(asyncio, "create_subprocess_exec", create)
    return calls


async def test_the_report_is_requested_in_print_mode_without_mcp(monkeypatch) -> None:
    """One non-interactive command: print mode, the user's MCP servers left
    unstarted, nothing persisted. ``/usage`` is a local CLI command, so this
    reads the quota without consuming it."""
    calls = _fake_exec(monkeypatch, _FakeProc(stdout=PRINTED_REPORT.encode()))

    text = await cu.read_usage_panel("/bin/claude")

    assert text == PRINTED_REPORT
    assert calls[0]["argv"] == (
        "/bin/claude",
        "--strict-mcp-config",
        "--mcp-config", '{"mcpServers":{}}',
        "--no-session-persistence",
        "-p", "/usage",
    )
    assert calls[0]["start_new_session"] is True
    assert "ANTHROPIC_API_KEY" not in calls[0]["env"]


async def test_a_windows_shim_is_started_through_cmd(monkeypatch) -> None:
    """npm installs the CLI as `claude.cmd` on Windows, which CreateProcess
    cannot start — and this poll fires on a timer, so it would fail forever."""
    from agent_team_backend.osplat import _windows

    monkeypatch.setattr(cu.osplat, "paths", _windows.paths)
    calls = _fake_exec(monkeypatch, _FakeProc(stdout=PRINTED_REPORT.encode()))

    await cu.read_usage_panel(r"C:\npm\claude.cmd")

    assert calls[0]["argv"][:4] == ("cmd.exe", "/d", "/c", r"C:\npm\claude.cmd")
    assert calls[0]["argv"][4:] == cu.USAGE_ARGS


async def test_a_hung_cli_is_killed_and_reported_as_a_timeout(monkeypatch) -> None:
    killed: list[int] = []

    async def kill_group(pid: int) -> None:
        killed.append(pid)

    _fake_exec(monkeypatch, _FakeProc(hang=True))
    monkeypatch.setattr(cu, "USAGE_TIMEOUT_S", 0.05)
    monkeypatch.setattr(cu, "_kill_group", kill_group)

    with pytest.raises(RuntimeError, match="timed out after 0s"):
        await cu.read_usage_panel("/bin/claude")

    assert killed == [4242]


async def test_a_failing_cli_surfaces_its_first_stderr_line(monkeypatch) -> None:
    _fake_exec(monkeypatch, _FakeProc(
        stdout=PRINTED_REPORT.encode(), stderr=b"\nwarning: something broke\nmore\n", rc=1,
    ))

    with pytest.raises(RuntimeError, match=r"claude exited 1: warning: something broke$"):
        await cu.read_usage_panel("/bin/claude")


async def test_a_cli_that_does_not_know_print_usage_says_so(monkeypatch) -> None:
    """An older Claude Code has no print form of /usage; there is no fallback
    to the interactive UI, so the error must point at the update."""
    _fake_exec(monkeypatch, _FakeProc(stdout=b"Unknown slash command: /usage\n", rc=1))

    with pytest.raises(RuntimeError, match="needs updating.*Unknown slash command"):
        await cu.read_usage_panel("/bin/claude")


def test_probe_env_drops_credentials_and_home_relocations(monkeypatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-x")
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", "/tmp/other")

    env = cu._panel_probe_env()

    assert "ANTHROPIC_API_KEY" not in env
    assert "CLAUDE_CONFIG_DIR" not in env
    assert env["TERM"] == "xterm-256color"


# ── fetch wrapper ───────────────────────────────────────────────────────────

# Grabbed at import time, before the conftest guard swaps the module attribute.
_REAL_FETCH = cu.fetch_claude_usage_via_cli


async def test_logged_out_is_reported_without_a_spawn(monkeypatch, tmp_path) -> None:
    """No credential means the CLI could only present its login wizard — at a
    full boot's cost, on every retry. That is knowable up front."""
    from agent_team_backend import ai_chat_cli_engine

    async def no_creds(home):
        return None

    def resolve_is_too_late(name):
        raise AssertionError("resolved the binary despite no credentials")

    monkeypatch.setattr(cu, "read_claude_credentials", no_creds)
    monkeypatch.setattr(ai_chat_cli_engine, "resolve_cli_binary", resolve_is_too_late)

    snap = await _REAL_FETCH(tmp_path)

    assert snap["status"] == "no-credentials"


async def test_a_failed_read_is_priced_like_a_success_and_says_why(monkeypatch, tmp_path) -> None:
    """A read that started a whole Claude Code and still came back empty cost
    as much as a successful one; the retry cadence must reflect that, and the
    snapshot must carry the reason instead of a bare ``unavailable``."""
    from agent_team_backend import ai_chat_cli_engine

    async def creds(home):
        return {"accessToken": "x"}

    async def read_fails(binary):
        raise RuntimeError("claude -p /usage timed out after 90s")

    monkeypatch.setattr(cu, "read_claude_credentials", creds)
    monkeypatch.setattr(ai_chat_cli_engine, "resolve_cli_binary", lambda name: "/bin/claude")
    monkeypatch.setattr(cu, "read_usage_panel", read_fails)

    snap = await _REAL_FETCH(tmp_path)

    assert snap["status"] == "unavailable"
    assert snap["costlyRead"] is True
    assert snap["error"] == "claude -p /usage timed out after 90s"


async def test_a_read_with_no_windows_says_so(monkeypatch, tmp_path) -> None:
    from agent_team_backend import ai_chat_cli_engine

    async def creds(home):
        return {"accessToken": "x"}

    async def read_empty(binary):
        return "You are currently using your subscription\n"

    monkeypatch.setattr(cu, "read_claude_credentials", creds)
    monkeypatch.setattr(ai_chat_cli_engine, "resolve_cli_binary", lambda name: "/bin/claude")
    monkeypatch.setattr(cu, "read_usage_panel", read_empty)

    snap = await _REAL_FETCH(tmp_path)

    assert snap["status"] == "unavailable"
    assert snap["costlyRead"] is True
    assert "no usage windows" in snap["error"]


async def test_a_missing_binary_is_its_own_status(monkeypatch, tmp_path, caplog) -> None:
    """Nothing is spawned when there is no CLI, so this failure leaves no other
    trace: it needs a status the UI can act on and a log line naming the PATH
    that was searched. Folded into ``unavailable`` it read as "this provider
    has no usage API", which is the one thing it does not mean."""
    from agent_team_backend import ai_chat_cli_engine

    async def creds(home):
        return {"accessToken": "x"}

    monkeypatch.setattr(cu, "read_claude_credentials", creds)
    monkeypatch.setattr(ai_chat_cli_engine, "resolve_cli_binary", lambda name: "")
    monkeypatch.setenv("PATH", "/nowhere/bin")
    # fetch_claude goes through the guarded read; with no credentials read
    # and no binary found, the real one has nothing it could spawn.
    monkeypatch.setattr(cu, "fetch_claude_usage_via_cli", _REAL_FETCH)

    with caplog.at_level(logging.WARNING):
        snap = await cu.fetch_claude(tmp_path)

    assert snap["status"] == "cli-missing"
    assert "no claude binary" in caplog.text
    assert "/nowhere/bin" in caplog.text


def test_an_account_dir_probe_runs_on_that_dir(monkeypatch) -> None:
    """The live probe drops any inherited CLAUDE_CONFIG_DIR; an account-dir
    probe sets its own, so it asks that account and nobody else."""
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", "/inherited")
    assert "CLAUDE_CONFIG_DIR" not in cu._panel_probe_env()
    assert cu._panel_probe_env("/acct/config-dir")["CLAUDE_CONFIG_DIR"] == "/acct/config-dir"

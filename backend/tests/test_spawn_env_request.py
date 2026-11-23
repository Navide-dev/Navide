"""The window's per-vendor env settings, as they arrive on `terminal.create`.

That payload field has existed all along with nothing ever populating it; the
Settings surface is the first producer, so these cover the first request that
actually carries values: what is refused, what survives, and what the window is
told about the difference.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import app, osplat
from agent_team_backend.cli_vendors.registry import VENDORS
from agent_team_backend.osplat import _posix_paths, _windows
from agent_team_backend.profiles_store import CLAUDE_ENV_OVERRIDES


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


class FakeTerminals:
    def __init__(self) -> None:
        self.created: list[dict[str, Any]] = []

    def create(self, **kwargs: Any) -> SimpleNamespace:
        self.created.append(kwargs)
        return SimpleNamespace(
            id="term-1",
            pane_id=kwargs["pane_id"],
            command=kwargs["command"],
            proc=SimpleNamespace(pid=1234),
        )

    async def kill(self, session_id: str, force: bool = False) -> None:
        return None

    def find_live_by_resume_id(self, *args: Any, **kwargs: Any) -> list[Any]:
        return []


class FakeAttribution:
    def register_pane(self, pane_id: str, **kwargs: Any) -> None:
        return None

    def scan_pane_baseline(self, pane_id: str) -> None:
        return None


_SHELL = "/bin/zsh"


def _session() -> app.Session:
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    session.terminals = FakeTerminals()  # type: ignore[assignment]
    return session


@pytest.fixture(autouse=True)
def _quiet_spawn(monkeypatch: pytest.MonkeyPatch) -> None:
    """Everything the spawn path touches that is not the env chain."""
    monkeypatch.setattr(app, "attribution", FakeAttribution())
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    monkeypatch.setattr(
        app, "_probe_agent_cli_for_spawn", lambda _key, _command=None: None
    )
    # Signed in, so the advisory under test is the only event on the wire.
    monkeypatch.setattr(
        app.credential_vault, "identity",
        lambda _key, _slot=None: {"email": None, "signedIn": True},
    )


async def _create(session: app.Session, env: dict[str, str], agent_key: str = "claude") -> None:
    await app.handle_message(session, {
        "id": "m1",
        "type": "terminal.create",
        "payload": {
            "pane_id": "env-pane",
            "agent_key": agent_key,
            "command": [_SHELL, "-lc", agent_key],
            "cwd": "/ws",
            "env": env,
            "metadata": {"workspace_path": "/ws"},
        },
    })


def _events(session: app.Session, event_type: str) -> list[dict[str, Any]]:
    return [
        m["payload"] for m in session.websocket.sent  # type: ignore[attr-defined]
        if m.get("type") == event_type
    ]


# --- the deny list itself -------------------------------------------------

def test_deny_list_is_the_union_of_the_existing_removal_lists() -> None:
    """One rule, not a fourth one. A var denied on the way in must be exactly
    a var some existing list already strips on the way out."""
    deny = app.spawn_env_deny_list()

    assert set(CLAUDE_ENV_OVERRIDES) <= deny
    for spec in VENDORS.values():
        assert set(spec.home_env_vars) <= deny, spec.key


def test_deny_list_covers_the_claude_usage_drop_list() -> None:
    """`cli_vendors.claude._ENV_DROP` is deliberately NOT a third source: it is
    already a subset of the two above. This fails the day that stops holding —
    which is the day the union needs to grow, not the day it silently drifts."""
    from agent_team_backend.cli_vendors.claude import _ENV_DROP

    assert set(_ENV_DROP) <= app.spawn_env_deny_list()


def test_filter_drops_denied_keys_and_keeps_the_rest() -> None:
    kept, denied = app.filter_spawn_env_request({
        "ANTHROPIC_API_KEY": "sk-leak",
        "CLAUDE_CONFIG_DIR": "/tmp/elsewhere",
        "MY_PROJECT_TOKEN": "fine",
    })

    assert kept == {"MY_PROJECT_TOKEN": "fine"}
    assert sorted(denied) == ["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR"]


def test_filter_passes_an_empty_request_through() -> None:
    assert app.filter_spawn_env_request({}) == ({}, [])


# --- case: the platform's rule, not the list's spelling ---------------------
#
# Windows compares env names case-insensitively, so `minimax_data_dir` in a
# request sets MINIMAX_DATA_DIR for the child — and the inherited upper-case
# spelling was already stripped, so the request's value is the one the CLI
# reads. The deny check therefore has to compare through the platform seam.
# POSIX keeps exact matching: there the lower-case name is a different, legal
# variable, and denying it would refuse a user's own setting for nothing.
# Neither test runs on the platform it describes; each swaps the seam in.

def test_filter_denies_any_spelling_where_the_platform_folds_names(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(osplat.paths, "env_name_key", _windows.paths.env_name_key)

    kept, denied = app.filter_spawn_env_request({
        "minimax_data_dir": "D:\\x",
        "Claude_Config_Dir": "D:\\y",
        "MY_PROJECT_TOKEN": "fine",
    })

    # Named as requested: the notice should show what the user typed.
    assert denied == ["minimax_data_dir", "Claude_Config_Dir"]
    assert kept == {"MY_PROJECT_TOKEN": "fine"}


def test_filter_keeps_exact_matching_where_the_platform_is_case_sensitive(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(osplat.paths, "env_name_key", _posix_paths.env_name_key)

    kept, denied = app.filter_spawn_env_request({
        "minimax_data_dir": "/tmp/x",
        "MINIMAX_DATA_DIR": "/tmp/y",
    })

    assert denied == ["MINIMAX_DATA_DIR"]
    assert kept == {"minimax_data_dir": "/tmp/x"}


def test_env_name_key_folds_only_on_windows() -> None:
    assert _windows.paths.env_name_key("Minimax_Data_Dir") == "minimax_data_dir"
    assert _posix_paths.env_name_key("Minimax_Data_Dir") == "Minimax_Data_Dir"


def test_overridden_keys_report_replacement_and_removal() -> None:
    requested = {"KEEPS": "mine", "REPLACED": "mine", "REMOVED": "mine"}
    final = {"KEEPS": "mine", "REPLACED": "theirs", "REMOVED": "mine"}

    assert app.spawn_env_overridden_keys(requested, final, ["REMOVED"]) == [
        "REMOVED", "REPLACED",
    ]
    assert app.spawn_env_overridden_keys(requested, final, None) == ["REPLACED"]


# --- the spawn path -------------------------------------------------------

@pytest.mark.asyncio
async def test_denied_keys_never_reach_the_pty_and_are_announced() -> None:
    """Soft block: the key is refused, the pane still opens."""
    session = _session()

    await _create(session, {
        "CLAUDE_CONFIG_DIR": "/tmp/elsewhere",
        "ANTHROPIC_API_KEY": "sk-leak",
        "MY_PROJECT_TOKEN": "fine",
    })

    created = session.terminals.created[0]  # type: ignore[attr-defined]
    assert "CLAUDE_CONFIG_DIR" not in created["env"]
    assert "ANTHROPIC_API_KEY" not in created["env"]
    assert created["env"]["MY_PROJECT_TOKEN"] == "fine"

    notices = _events(session, "cli.env_ignored")
    assert len(notices) == 1
    assert notices[0]["denied"] == ["ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR"]
    assert notices[0]["overridden"] == []
    assert notices[0]["pane_id"] == "env-pane"
    assert notices[0]["agent_key"] == "claude"
    assert notices[0]["label"]


@pytest.mark.asyncio
async def test_an_accepted_request_announces_nothing() -> None:
    session = _session()

    await _create(session, {"MY_PROJECT_TOKEN": "fine"})

    assert _events(session, "cli.env_ignored") == []
    assert session.terminals.created[0]["env"]["MY_PROJECT_TOKEN"] == "fine"  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_a_spawn_without_env_announces_nothing() -> None:
    """The shape every spawn had before Settings could populate the field."""
    session = _session()

    await _create(session, {})

    assert _events(session, "cli.env_ignored") == []


@pytest.mark.asyncio
async def test_a_user_value_a_later_source_replaces_is_reported(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The request sits first in the chain, so onboarding still wins — and the
    window is told, rather than leaving a Settings row that quietly does
    nothing."""
    monkeypatch.setattr(
        app.onboarding_deps, "spawn_env_for",
        lambda _key: {"DISABLE_AUTOUPDATER": "1"},
    )
    session = _session()

    await _create(session, {"DISABLE_AUTOUPDATER": "0"})

    created = session.terminals.created[0]  # type: ignore[attr-defined]
    assert created["env"]["DISABLE_AUTOUPDATER"] == "1"
    notices = _events(session, "cli.env_ignored")
    assert len(notices) == 1
    assert notices[0]["denied"] == []
    assert notices[0]["overridden"] == ["DISABLE_AUTOUPDATER"]


@pytest.mark.asyncio
async def test_a_vendor_default_does_not_displace_a_user_value() -> None:
    """`spawn_env_defaults` is applied with setdefault — it fills a gap, it
    does not override. kimi declares one, so it is the live case."""
    session = _session()

    await _create(session, {"PI_TUI_ESC_TIMEOUT": "250"}, agent_key="kimi")

    created = session.terminals.created[0]  # type: ignore[attr-defined]
    assert created["env"]["PI_TUI_ESC_TIMEOUT"] == "250"
    assert _events(session, "cli.env_ignored") == []


@pytest.mark.asyncio
async def test_a_claude_pane_gets_a_longer_mcp_connect_budget(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Claude Code gives its first MCP connect 30s by default (MCP_TIMEOUT).
    During a mass restore /plan-mcp answered in 20–57s, every pane gave up
    after three retries and never tried again (2026-11-12). Verified against
    2.1.325: an HTTP server whose initialize takes 40s fails by default and
    connects with MCP_TIMEOUT=60000."""
    monkeypatch.delenv("MCP_TIMEOUT", raising=False)
    session = _session()

    await _create(session, {})

    created = session.terminals.created[0]  # type: ignore[attr-defined]
    assert created["env"]["MCP_TIMEOUT"] == "120000"


@pytest.mark.asyncio
async def test_a_user_mcp_timeout_wins_over_the_claude_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("MCP_TIMEOUT", raising=False)
    session = _session()

    await _create(session, {"MCP_TIMEOUT": "45000"})

    created = session.terminals.created[0]  # type: ignore[attr-defined]
    assert created["env"]["MCP_TIMEOUT"] == "45000"

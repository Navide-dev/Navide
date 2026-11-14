"""Spawn-time MCP/skills fingerprints and the stale-pane query (hot reload H0)."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import app, native_mcp, pane_config_fingerprint, ws_handlers

from .test_terminal_create_offload import FakeAttribution, FakeTerminals, FakeWebSocket


def _write_claude_config(home: Path, servers: dict[str, Any]) -> None:
    (home / ".claude.json").write_text(json.dumps({"mcpServers": servers, "numStartups": 1}))


def test_mcp_fingerprint_follows_the_agents_own_servers(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(native_mcp, "_home", lambda: tmp_path)
    _write_claude_config(tmp_path, {"a": {"command": "a-server"}})
    first = pane_config_fingerprint.mcp_fingerprint("claude")
    assert first is not None

    # Unrelated keys in the same file are not MCP config.
    (tmp_path / ".claude.json").write_text(
        json.dumps({"mcpServers": {"a": {"command": "a-server"}}, "numStartups": 9})
    )
    assert pane_config_fingerprint.mcp_fingerprint("claude") == first

    _write_claude_config(tmp_path, {"a": {"command": "a-server"}, "b": {"command": "b-server"}})
    assert pane_config_fingerprint.mcp_fingerprint("claude") != first


def test_mcp_fingerprint_is_none_for_a_cli_with_no_native_config() -> None:
    assert pane_config_fingerprint.mcp_fingerprint("no-such-cli") is None


class FakeStore:
    def __init__(self, shared: dict[str, str], native: list[str]) -> None:
        self.shared = shared
        self.native = native

    def targets_for(self, _agent_key: str) -> list[str]:
        return sorted(self.shared)

    def get_skill(self, name: str) -> dict[str, Any]:
        return {"skill": {"revision": self.shared[name]}}

    def native_targets_for(self, _agent_key: str) -> list[str]:
        return list(self.native)


def test_skills_fingerprint_follows_targets_and_revisions(monkeypatch: pytest.MonkeyPatch) -> None:
    from agent_team_backend import skills_store

    store = FakeStore({"one": "r1"}, [])
    monkeypatch.setattr(skills_store, "SkillsStore", lambda: store)
    first = pane_config_fingerprint.skills_fingerprint("claude")
    assert first is not None

    store.shared["one"] = "r2"
    edited = pane_config_fingerprint.skills_fingerprint("claude")
    assert edited not in (None, first)

    store.native.append("/abs/native/skill")
    assert pane_config_fingerprint.skills_fingerprint("claude") not in (None, edited)


def test_skills_fingerprint_unreadable_store_is_unknown(monkeypatch: pytest.MonkeyPatch) -> None:
    from agent_team_backend import skills_store

    def broken() -> Any:
        raise OSError("unreadable")

    monkeypatch.setattr(skills_store, "SkillsStore", broken)
    assert pane_config_fingerprint.skills_fingerprint("claude") is None


def test_stale_parts_never_flags_an_unknown_side() -> None:
    stale = pane_config_fingerprint.stale_parts
    assert stale({"mcp": "a", "skills": "b"}, {"mcp": "a", "skills": "b"}) == []
    assert stale({"mcp": "a", "skills": "b"}, {"mcp": "x", "skills": "y"}) == ["mcp", "skills"]
    assert stale({"mcp": None, "skills": "b"}, {"mcp": "x", "skills": None}) == []
    assert stale(None, {"mcp": "x", "skills": "y"}) == []


async def _create(monkeypatch: pytest.MonkeyPatch, metadata: dict[str, Any], fingerprint: Any) -> Any:
    async def no_path_refresh(_agent_key: str) -> None:
        pass

    monkeypatch.setattr(app, "_ensure_fresh_path_for_spawn", no_path_refresh)
    monkeypatch.setattr(app, "_probe_agent_cli_for_spawn", lambda _a, _c: None)
    monkeypatch.setattr(app, "attribution", FakeAttribution())
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    monkeypatch.setattr(app, "cli_profiles_store", SimpleNamespace(get_default_profile=lambda _a: None))
    monkeypatch.setattr(app.plugin_wiring, "apply_spawn_wiring", lambda _h, _a, command, *_rest: command)
    monkeypatch.setattr(pane_config_fingerprint, "fingerprint", fingerprint)
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    session.terminals = FakeTerminals()  # type: ignore[assignment]
    await app.handle_message(
        session,
        {
            "id": "create",
            "type": "terminal.create",
            "payload": {
                "pane_id": "pane",
                "agent_key": "claude",
                "command": ["/bin/zsh", "-lc", "claude"],
                "cwd": "/ws",
                "metadata": metadata,
            },
        },
    )
    return session


@pytest.mark.asyncio
async def test_spawn_records_the_fingerprint_without_touching_the_command(monkeypatch: pytest.MonkeyPatch) -> None:
    recorded = {"mcp": "m1", "skills": "s1"}
    with_fp = await _create(monkeypatch, {"workspace_path": "/ws"}, lambda _a: recorded)
    unknown = await _create(monkeypatch, {"workspace_path": "/ws"}, lambda _a: {"mcp": None, "skills": None})

    a = with_fp.terminals.created[0]
    b = unknown.terminals.created[0]
    assert a["command"] == b["command"]
    # The guard token is minted fresh per spawn; everything else must match.
    token = "NAVIDE_GUARD_PANE_TOKEN"
    assert {k: v for k, v in a["env"].items() if k != token} == {
        k: v for k, v in b["env"].items() if k != token
    }
    assert a["metadata"][pane_config_fingerprint.METADATA_KEY] == recorded
    assert with_fp.websocket.sent[-1]["ok"] is True


@pytest.mark.asyncio
async def test_spawn_ignores_a_renderer_supplied_fingerprint(monkeypatch: pytest.MonkeyPatch) -> None:
    session = await _create(
        monkeypatch,
        {"workspace_path": "/ws", pane_config_fingerprint.METADATA_KEY: {"mcp": "forged"}},
        lambda _a: {"mcp": "real", "skills": None},
    )
    assert session.terminals.created[0]["metadata"][pane_config_fingerprint.METADATA_KEY] == {
        "mcp": "real",
        "skills": None,
    }


def _stored(agent_key: str, recorded: Any, closed: bool = False) -> SimpleNamespace:
    return SimpleNamespace(
        agent_key=agent_key,
        pane_id=f"pane-{agent_key}",
        closed=closed,
        metadata={pane_config_fingerprint.METADATA_KEY: recorded} if recorded is not None else {},
    )


@pytest.mark.asyncio
async def test_config_status_lists_only_owned_live_stale_panes(monkeypatch: pytest.MonkeyPatch) -> None:
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    other = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    session.terminals = SimpleNamespace(  # type: ignore[assignment]
        _sessions={
            "stale": _stored("claude", {"mcp": "old", "skills": "s"}),
            "fresh": _stored("claude", {"mcp": "new", "skills": "s"}),
            "closed": _stored("claude", {"mcp": "old", "skills": "s"}, closed=True),
            "foreign": _stored("claude", {"mcp": "old", "skills": "s"}),
            "legacy": _stored("claude", None),
        }
    )
    for tid in ("stale", "fresh", "closed", "legacy"):
        monkeypatch.setitem(app._PTY_OWNERS, tid, session)
    monkeypatch.setitem(app._PTY_OWNERS, "foreign", other)
    calls: list[str] = []

    def current(agent_key: str) -> dict[str, str]:
        calls.append(agent_key)
        return {"mcp": "new", "skills": "s"}

    monkeypatch.setattr(pane_config_fingerprint, "fingerprint", current)
    await ws_handlers.terminal_config_status(
        session, "q", "terminal.config_status",
        {"terminal_session_ids": ["stale", "fresh", "closed", "foreign", "legacy", "missing"]},
    )
    reply = session.websocket.sent[-1]
    assert reply["ok"] is True
    assert reply["payload"]["stale"] == [
        {"terminal_session_id": "stale", "pane_id": "pane-claude", "parts": ["mcp"]}
    ]
    # One scan per agent, however many of its panes are asked about.
    assert calls == ["claude"]


@pytest.mark.asyncio
async def test_config_status_rejects_a_malformed_request() -> None:
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    await ws_handlers.terminal_config_status(session, "q", "terminal.config_status", {"terminal_session_ids": "x"})
    assert session.websocket.sent[-1]["ok"] is False


# A fake secret, assembled so no scanner mistakes the fixture for a real one.
FAKE_TOKEN = "sk-" + "ant-" + "fixture" + "0" * 24


def _claude_config_with_secrets(home: Path, value: str, email: str) -> Path:
    path = home / ".claude.json"
    path.write_text(json.dumps({
        "oauthAccount": {"emailAddress": email, "accountUuid": "uuid-" + value[-6:]},
        "mcpServers": {
            "remote": {
                "type": "http",
                "url": "https://mcp.example.test/v1?api_key=" + value,
                "headers": {"Authorization": "Bearer " + value, "X-Plain": "plain-" + value},
            },
            "local": {"command": "srv", "args": ["--port", "1"], "env": {"API_TOKEN": value, "LOG": "v-" + value}},
        },
    }))
    return path


def test_mcp_fingerprint_ignores_secret_values_and_account_fields(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setattr(native_mcp, "_home", lambda: tmp_path)
    path = _claude_config_with_secrets(tmp_path, FAKE_TOKEN, "a@example.test")
    before = path.stat()
    first = pane_config_fingerprint.fingerprint("claude")

    assert first["mcp"] is not None
    assert FAKE_TOKEN not in json.dumps(first)
    assert FAKE_TOKEN not in caplog.text
    # Read only: the file's bytes, mode and timestamps are untouched.
    after = path.stat()
    assert (after.st_mode, after.st_mtime_ns, after.st_size) == (before.st_mode, before.st_mtime_ns, before.st_size)

    # Values (env, headers, secrets inside urls) and the account never reach the
    # hash: changing only them, or switching the account, changes nothing.
    _claude_config_with_secrets(tmp_path, "sk-" + "ant-" + "other" + "1" * 24, "b@example.test")
    assert pane_config_fingerprint.mcp_fingerprint("claude") == first["mcp"]


@pytest.mark.asyncio
async def test_config_status_answer_carries_no_secret(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(native_mcp, "_home", lambda: tmp_path)
    _claude_config_with_secrets(tmp_path, FAKE_TOKEN, "a@example.test")
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    session.terminals = SimpleNamespace(  # type: ignore[assignment]
        _sessions={"t": _stored("claude", {"mcp": "old", "skills": None})}
    )
    monkeypatch.setitem(app._PTY_OWNERS, "t", session)
    await ws_handlers.terminal_config_status(session, "q", "terminal.config_status", {"terminal_session_ids": ["t"]})
    reply = session.websocket.sent[-1]
    assert reply["payload"]["stale"] == [{"terminal_session_id": "t", "pane_id": "pane-claude", "parts": ["mcp"]}]
    assert FAKE_TOKEN not in json.dumps(reply)

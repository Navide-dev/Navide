"""Credential resolution for /plan-mcp (plan_mcp._resolve_caller) and the
plan_mcp_auth token store it reads from.

Every tool on the server requires one of three credential kinds — pane, host,
or external (only while enabled). This exercises the acceptance/rejection
matrix directly against _resolve_caller (shared by every tool) plus one
integration check that a real tool (plan_list) enforces it. plan_list is a
plugin tool deliberately: it reaches the same gate through the public
mcp_server.toolkit re-export, so this also proves a plugin's tools are not a
way past the credential check.
"""

from __future__ import annotations

import os
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging, osplat
from agent_team_backend.mcp_server import server as plan_mcp, auth as plan_mcp_auth, wiring as plan_mcp_wiring
from agent_team_backend.plugins.builtin.navide_plans import plan_tools


@pytest.fixture(autouse=True)
def _clean_registry() -> Any:
    agent_messaging._reset_for_test()
    yield
    agent_messaging._reset_for_test()


def _ctx(**params: str) -> Any:
    """A Context whose HTTP request carries `params` as its query string; no
    params at all mimics a request with no query string / no request object."""
    if not params:
        return SimpleNamespace(request_context=SimpleNamespace(request=None))
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


# ── plan_mcp_auth: token persistence ────────────────────────────────────────


def test_tokens_are_generated_once_and_persisted() -> None:
    internal = plan_mcp_auth.internal_token()
    external = plan_mcp_auth.external_token()
    assert internal and external and internal != external
    # Re-reading returns the same tokens (persisted to disk, not regenerated).
    assert plan_mcp_auth.internal_token() == internal
    assert plan_mcp_auth.external_token() == external


def test_external_access_defaults_to_disabled() -> None:
    assert plan_mcp_auth.external_enabled() is False


def test_set_external_enabled_persists() -> None:
    config = plan_mcp_auth.set_external_enabled(True)
    assert config["external_enabled"] is True
    assert plan_mcp_auth.external_enabled() is True
    config = plan_mcp_auth.set_external_enabled(False)
    assert config["external_enabled"] is False
    assert plan_mcp_auth.external_enabled() is False


def test_regenerate_external_token_changes_only_the_external_token() -> None:
    internal_before = plan_mcp_auth.internal_token()
    external_before = plan_mcp_auth.external_token()
    config = plan_mcp_auth.regenerate_external_token()
    assert config["external_token"] != external_before
    assert config["internal_token"] == internal_before
    assert plan_mcp_auth.external_token() == config["external_token"]


# ── _resolve_caller: acceptance/rejection matrix ────────────────────────────


def test_resolve_caller_rejects_no_request() -> None:
    with pytest.raises(plan_mcp.CallerUnknown, match="could not identify your pane"):
        plan_mcp._resolve_caller(_ctx())


def test_resolve_caller_accepts_a_valid_pane_credential() -> None:
    agent_messaging.register("pa", "sender", "/ws/alpha")
    caller = plan_mcp._resolve_caller(
        _ctx(pane="pa", t=plan_mcp_wiring.caller_token("pa"))
    )
    assert caller.kind == "pane"
    assert caller.pane_id == "pa"


def test_resolve_caller_rejects_a_missing_pane_id() -> None:
    with pytest.raises(plan_mcp.CallerUnknown, match="could not identify your pane"):
        plan_mcp._resolve_caller(_ctx(t=plan_mcp_wiring.caller_token("pa")))


def test_resolve_caller_rejects_a_bad_pane_token() -> None:
    agent_messaging.register("pa", "sender", "/ws/alpha")
    with pytest.raises(plan_mcp.CallerUnknown, match="token rejected"):
        plan_mcp._resolve_caller(_ctx(pane="pa", t="not-the-token"))


def test_resolve_caller_rejects_a_stale_pane_id() -> None:
    with pytest.raises(plan_mcp.CallerUnknown, match="stale"):
        plan_mcp._resolve_caller(_ctx(pane="long-gone", t=plan_mcp_wiring.caller_token("long-gone")))


def test_resolve_caller_accepts_a_valid_host_credential() -> None:
    caller = plan_mcp._resolve_caller(
        _ctx(client="host", t=plan_mcp_auth.internal_token())
    )
    assert caller.kind == "host"
    assert caller.pane_id == ""


def test_resolve_caller_rejects_a_bad_host_token() -> None:
    with pytest.raises(plan_mcp.CallerUnknown, match="host token rejected"):
        plan_mcp._resolve_caller(_ctx(client="host", t="wrong"))


def test_resolve_caller_rejects_external_while_disabled() -> None:
    assert plan_mcp_auth.external_enabled() is False
    with pytest.raises(plan_mcp.CallerUnknown, match="disabled"):
        plan_mcp._resolve_caller(
            _ctx(client="external", t=plan_mcp_auth.external_token())
        )


def test_resolve_caller_accepts_a_valid_external_credential_once_enabled() -> None:
    plan_mcp_auth.set_external_enabled(True)
    caller = plan_mcp._resolve_caller(
        _ctx(client="external", t=plan_mcp_auth.external_token())
    )
    assert caller.kind == "external"
    assert caller.pane_id == ""


def test_resolve_caller_rejects_a_bad_external_token_even_when_enabled() -> None:
    plan_mcp_auth.set_external_enabled(True)
    with pytest.raises(plan_mcp.CallerUnknown, match="external token rejected"):
        plan_mcp._resolve_caller(_ctx(client="external", t="wrong"))


# ── integration: a real tool enforces the same gate ─────────────────────────


@pytest.mark.asyncio
async def test_plan_list_rejects_a_request_with_no_credential(tmp_path) -> None:
    with pytest.raises(plan_mcp.CallerUnknown):
        await plan_tools.plan_list(_ctx(), workspace_path=str(tmp_path))


@pytest.mark.asyncio
async def test_plan_list_accepts_a_host_credential(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    # No plans directory yet — plan_list just returns [] rather than erroring,
    # so reaching that (instead of CallerUnknown) proves the credential passed.
    async def route(*args: Any, **kwargs: Any) -> dict[str, Any]:
        return {
            "ok": False,
            "error": {"code": "BACKEND_UNAVAILABLE", "message": "test pre-dispatch failure"},
            "recoveryDisposition": "legacy-safe-before-dispatch",
        }

    monkeypatch.setattr(plan_mcp, "request_host_agent_workspace_backend", route)
    result = await plan_tools.plan_list(
        _ctx(client="host", t=plan_mcp_auth.internal_token()), workspace_path=str(tmp_path)
    )
    assert result == []


# ── file permissions: the tokens are bearer credentials ─────────────────────


@pytest.mark.skipif(not osplat.paths.enforces_posix_modes(), reason="POSIX mode bits")
def test_the_auth_file_is_not_readable_by_other_users() -> None:
    plan_mcp_auth.internal_token()  # generates and writes the file
    assert plan_mcp_auth.auth_path().stat().st_mode & 0o077 == 0


@pytest.mark.skipif(not osplat.paths.enforces_posix_modes(), reason="POSIX mode bits")
def test_a_rewrite_keeps_the_mode_tight() -> None:
    plan_mcp_auth.internal_token()
    plan_mcp_auth.regenerate_external_token()
    assert plan_mcp_auth.auth_path().stat().st_mode & 0o077 == 0


@pytest.mark.skipif(not osplat.paths.enforces_posix_modes(), reason="POSIX mode bits")
def test_a_file_left_world_readable_by_an_older_version_is_tightened() -> None:
    plan_mcp_auth.internal_token()
    path = plan_mcp_auth.auth_path()
    path.chmod(0o644)
    plan_mcp_auth.internal_token()  # any read hardens it
    assert path.stat().st_mode & 0o077 == 0


def _count_hardening(monkeypatch) -> list[Any]:
    calls: list[Any] = []
    harden = plan_mcp_auth.secret_files.harden_file

    def counting(path: Any) -> None:
        calls.append(path)
        harden(path)

    monkeypatch.setattr(plan_mcp_auth.secret_files, "harden_file", counting)
    return calls


def test_the_file_is_hardened_once_however_often_it_is_read(monkeypatch) -> None:
    """Review MED-1 on #399: every credential check reads this file, and on
    Windows each hardening is an icacls process."""
    plan_mcp_auth.internal_token()
    calls = _count_hardening(monkeypatch)
    plan_mcp_auth._hardened = None  # noqa: SLF001 - as in a fresh process
    for _ in range(20):
        plan_mcp_auth.internal_token()
        plan_mcp_auth.external_token()
        plan_mcp_auth.external_enabled()
    assert len(calls) == 1


def test_a_rewritten_file_is_hardened_again(monkeypatch) -> None:
    plan_mcp_auth.internal_token()
    calls = _count_hardening(monkeypatch)
    plan_mcp_auth._hardened = None  # noqa: SLF001
    plan_mcp_auth.internal_token()
    assert len(calls) == 1
    plan_mcp_auth.regenerate_external_token()
    plan_mcp_auth.internal_token()
    plan_mcp_auth.internal_token()
    assert len(calls) == 2
    # Recreated the way the cache exists for: by another writer, left at the
    # default mode. Not by this module: its own recreate is 0600, the same
    # size, and on Linux often the freed inode with mtime/ctime from the same
    # coarse clock tick, so its identity can equal the old file's and nothing
    # is done -- correctly, since a 0600 file has nothing to tighten.
    path = plan_mcp_auth.auth_path()
    content = path.read_bytes()
    path.unlink()
    path.write_bytes(content)
    path.chmod(0o644)
    plan_mcp_auth.internal_token()
    plan_mcp_auth.internal_token()
    assert len(calls) == 3


@pytest.mark.skipif(not osplat.paths.enforces_posix_modes(), reason="POSIX mode bits")
def test_a_file_loosened_after_it_was_hardened_is_tightened_on_the_next_read() -> None:
    """POSIX as on main: a read after anything widened the mode tightens it."""
    path = plan_mcp_auth.auth_path()
    for _ in range(3):
        plan_mcp_auth.internal_token()
        path.chmod(0o644)
        plan_mcp_auth.internal_token()
        assert path.stat().st_mode & 0o077 == 0


def test_no_temp_file_survives_a_failed_write(monkeypatch) -> None:
    plan_mcp_auth.internal_token()
    path = plan_mcp_auth.auth_path()
    tmp = path.with_suffix(path.suffix + ".tmp")

    def boom(*args, **kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(os, "replace", boom)
    with pytest.raises(OSError):
        plan_mcp_auth.set_external_enabled(True)
    assert not tmp.exists()


# ── _resolve_caller: never registered vs forgotten ──────────────────────────


def test_resolve_caller_tells_a_forgotten_pane_from_a_never_registered_one(caplog: Any) -> None:
    agent_messaging.register("pa", "sender", "/ws/alpha")
    agent_messaging.unregister("pa")
    with pytest.raises(plan_mcp.CallerUnknown) as forgotten:
        plan_mcp._resolve_caller(_ctx(pane="pa", t=plan_mcp_wiring.caller_token("pa")))
    # A closed main-window pane hears exactly what it heard before.
    assert str(forgotten.value) == plan_mcp._STALE

    with caplog.at_level("WARNING", logger="agent_team_backend.mcp_server"):
        with pytest.raises(plan_mcp.CallerUnknown) as never:
            plan_mcp._resolve_caller(_ctx(pane="never-registered", t=plan_mcp_wiring.caller_token("never-registered")))
    assert "never registered" in str(never.value)
    assert "stale" in str(never.value)
    assert any("never-registered" in r.getMessage() for r in caplog.records)

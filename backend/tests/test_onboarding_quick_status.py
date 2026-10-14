"""quick_status and the login-shell PATH cache (onboarding latency fixes).

quick_status is the wizard's first paint: it must never spawn a subprocess
(that is the whole point — the full pass's slowest --version probe is what
delayed "not installed" from appearing). The PATH probe cache bounds the
per-call login-shell cost; force re-probes for wizard flows that just ran an
installer.
"""

import subprocess

import pytest

from agent_team_backend import onboarding_deps as od
from agent_team_backend import osplat


@pytest.fixture(autouse=True)
def _reset_path_cache(monkeypatch):
    od._path_refreshed_at = None
    # The login-shell PATH has answered, unless a test says otherwise: only
    # then is a PATH-presence miss a verdict (see the unknown tests below).
    monkeypatch.setattr(od, "_path_probe_answered", True)
    yield
    od._path_refreshed_at = None


def test_quick_status_spawns_no_subprocess(monkeypatch):
    def boom(*args, **kwargs):
        raise AssertionError(f"quick_status spawned a subprocess: {args}")

    monkeypatch.setattr(od.subprocess, "run", boom)
    monkeypatch.setattr(od.subprocess, "Popen", boom)

    status = od.quick_status()

    assert status["quick"] is True
    assert [d["id"] for d in status["deps"]] == [d.id for d in od.applicable_deps()]
    # Presence is exact: a dep whose binary is nowhere on PATH reads missing.
    by_id = {d["id"]: d for d in status["deps"]}
    for entry in by_id.values():
        assert entry["status"] in ("ok", "missing")
        if entry["status"] == "missing":
            assert entry["binary_path"] == ""
    # No versions in the quick pass — those need the subprocess.
    assert all(d["version"] == "" for d in status["deps"])
    # cli_health is the empty shape (the full pass fills it in).
    assert status["cli_health"]["entries"] == []


def test_quick_and_full_agree_on_missing(monkeypatch):
    # Force every resolve to fail so both passes see the same world.
    monkeypatch.setattr(od, "resolve_executable", lambda dep, quick=False: "")
    quick = {d["id"]: d["status"] for d in od.quick_status()["deps"]}
    assert set(quick.values()) == {"missing"}


def test_quick_status_reports_unknown_until_the_login_path_answered(monkeypatch):
    # nvm, volta and a custom npm prefix only reach PATH through the login
    # shell. Before it has answered, a presence miss says nothing about the
    # CLI, and the spawn dropdown read "missing" as "offer the installer".
    monkeypatch.setattr(od, "_path_probe_command", lambda: ["sh", "-c", "true"])
    monkeypatch.setattr(od, "_path_probe_answered", False)
    monkeypatch.setattr(od, "resolve_executable", lambda dep, quick=False: "")
    deps = od.quick_status()["deps"]
    assert {d["status"] for d in deps} == {"unknown"}
    assert all(d["binary_path"] == "" for d in deps)


def test_quick_status_keeps_a_found_binary_ok_before_the_login_path_answered(monkeypatch):
    monkeypatch.setattr(od, "_path_probe_command", lambda: ["sh", "-c", "true"])
    monkeypatch.setattr(od, "_path_probe_answered", False)
    monkeypatch.setattr(od, "resolve_executable", lambda dep, quick=False: "/opt/bin/x")
    assert {d["status"] for d in od.quick_status()["deps"]} == {"ok"}


def test_quick_status_miss_is_exact_where_there_is_no_login_shell(monkeypatch):
    # Windows: no login shell to wait for, so the PATH it has is the answer.
    monkeypatch.setattr(od, "_path_probe_command", lambda: None)
    monkeypatch.setattr(od, "_path_probe_answered", False)
    monkeypatch.setattr(od, "resolve_executable", lambda dep, quick=False: "")
    assert {d["status"] for d in od.quick_status()["deps"]} == {"missing"}


@pytest.mark.skipif(
    osplat.paths.login_path_probe() is None,
    reason="login-shell PATH probe is None on this platform (Windows) by design",
)
def test_path_probe_cached_until_forced(monkeypatch):
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd)

        class R:
            stdout = "/usr/bin:/bin\n"
            returncode = 0

        return R()

    monkeypatch.setattr(od.subprocess, "run", fake_run)

    od._refresh_path_from_login_shell()
    od._refresh_path_from_login_shell()
    assert len(calls) == 1  # second call served from cache

    od._refresh_path_from_login_shell(force=True)
    assert len(calls) == 2  # force bypasses the cache

    # TTL expiry re-probes without force.
    od._path_refreshed_at = od.time.monotonic() - od._PATH_REFRESH_TTL_S - 1
    od._refresh_path_from_login_shell()
    assert len(calls) == 3

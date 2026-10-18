"""Production Host allowlist coverage for the shell.run handler seam."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import app, osplat, ws_handlers


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


def _session() -> app.Session:
    return app.Session(FakeWebSocket())  # type: ignore[arg-type]


async def _run(session: app.Session, payload: dict[str, Any]) -> dict[str, Any]:
    await app.handle_message(session, {"id": "shell-1", "type": "shell.run", "payload": payload})
    return session.websocket.sent[-1]["payload"]  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_allowlist_rejects_an_unregistered_workspace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(app.attribution, "known_workspaces", lambda: [])

    payload = await _run(_session(), {
        "host_mode": "allowlist", "workspace_path": str(tmp_path), "command": "git status",
    })

    assert payload == {"ok": False, "error": "workspace path not registered"}


@pytest.mark.asyncio
async def test_legacy_shell_run_without_a_workspace_is_refused(tmp_path: Path) -> None:
    """d1. With no workspace_path the legacy branch skipped the registered-
    workspace check entirely and ran the command in the backend's own cwd."""
    marker = tmp_path / "ran"

    payload = await _run(_session(), {"command": f"touch {marker}"})

    assert payload == {"ok": False, "error": "workspace path is required"}
    assert not marker.exists()


@pytest.mark.asyncio
async def test_allowlist_keeps_cwd_within_registered_workspace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    child = tmp_path / "child"
    child.mkdir()
    monkeypatch.setattr(app.attribution, "known_workspaces", lambda: [str(tmp_path)])
    calls: list[tuple[list[str], str, float]] = []

    async def fake_run(
        argv: list[str], cwd: str, *, timeout: float, workspace_root: str | None = None
    ) -> tuple[int, str, str]:
        calls.append((argv, cwd, timeout))
        return 0, "clean", ""

    monkeypatch.setattr(ws_handlers, "run_public_allowlisted_text", fake_run)

    payload = await _run(_session(), {
        "host_mode": "allowlist", "workspace_path": str(child), "command": "git status",
    })
    outside = await _run(_session(), {
        "host_mode": "allowlist", "workspace_path": str(tmp_path.parent), "command": "git status",
    })

    assert payload == {
        "ok": True, "output": "clean", "stdout": "clean", "stderr": "", "exit_code": 0,
        "truncated": False, "stdoutBytes": 5,
    }
    assert calls == [(["git", "status"], str(child.resolve()), 30.0)]
    assert outside == {"ok": False, "error": "workspace path not registered"}


@pytest.mark.asyncio
async def test_allowlist_rejects_non_allowlisted_executable(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(app.attribution, "known_workspaces", lambda: [str(tmp_path)])

    payload = await _run(_session(), {
        "host_mode": "allowlist", "workspace_path": str(tmp_path), "command": "rm -rf .",
    })

    assert payload == {"ok": False, "error": "executable is not allowlisted"}


@pytest.mark.asyncio
async def test_allowlist_rejects_git_execution_escape_hatches(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(app.attribution, "known_workspaces", lambda: [str(tmp_path)])

    payload = await _run(_session(), {
        "host_mode": "allowlist",
        "workspace_path": str(tmp_path),
        "command": "git -c alias.x=!sh x",
    })

    assert payload == {"ok": False, "error": "command is not permitted by the public shell policy"}


@pytest.mark.asyncio
async def test_public_broker_rejects_git_template_without_creating_hooks(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    template = tmp_path / "template"
    hooks = template / "hooks"
    hooks.mkdir(parents=True)
    hook = hooks / "pre-commit"
    hook.write_text("#!/bin/sh\nprintf TEMPLATE_HOOK_RAN\n", encoding="utf-8")
    hook.chmod(0o755)
    victim = tmp_path / "victim"
    monkeypatch.setattr(app.attribution, "known_workspaces", lambda: [str(tmp_path)])

    payload = await _run(_session(), {
        "host_mode": "allowlist",
        "workspace_path": str(tmp_path),
        "command": "git init --template template victim",
    })

    assert payload == {"ok": False, "error": "command is not permitted by the public shell policy"}
    assert not victim.exists()
    assert not (tmp_path / "TEMPLATE_HOOK_RAN").exists()


@pytest.mark.asyncio
@pytest.mark.skipif(
    osplat.paths.executable_candidates("gh") != ["gh"]
    or osplat.paths.resolve_program("git") is None,
    reason="fake `gh` is a #!/bin/sh script found by bare name, next to a real git "
    "(the test_host_shell fake-CLI harness)",
)
async def test_public_broker_does_not_return_provider_auth_fixture(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    subprocess.run(["git", "init", str(tmp_path)], check=True, capture_output=True, text=True)
    subprocess.run(
        ["git", "-C", str(tmp_path), "remote", "add", "origin", "https://github.com/acme/repo.git"],
        check=True,
        capture_output=True,
        text=True,
    )
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    fake_gh = bin_dir / "gh"
    fake_gh.write_text(
        "#!/bin/sh\n"
        "printf 'broker-secret-fixture\\n'\n"
        "printf 'broker-secret-fixture\\n' >&2\n",
        encoding="utf-8",
    )
    fake_gh.chmod(0o755)
    source_config = tmp_path / "gh-config"
    source_config.mkdir()
    (source_config / "hosts.yml").write_text(
        "github.com:\n  user: fixture\n  oauth_token: broker-secret-fixture\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(app.attribution, "known_workspaces", lambda: [str(tmp_path)])
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}/usr/bin:/bin")
    monkeypatch.setenv("GH_CONFIG_DIR", str(source_config))

    payload = await _run(_session(), {
        "host_mode": "allowlist",
        "workspace_path": str(tmp_path),
        "command": "gh issue list",
    })

    assert payload["ok"] is True
    assert "broker-secret-fixture" not in payload["stdout"]
    assert "broker-secret-fixture" not in payload["stderr"]
    assert "[redacted]" in payload["stdout"]
    assert "[redacted]" in payload["stderr"]


@pytest.mark.asyncio
async def test_allowlist_truncates_output_and_preserves_nonzero_envelope(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(app.attribution, "known_workspaces", lambda: [str(tmp_path)])

    async def fake_run(
        _argv: list[str], _cwd: str, *, timeout: float, workspace_root: str | None = None
    ) -> tuple[int, str, str]:
        assert timeout == 30.0
        return 23, "o" * 9000, "e" * 9000

    monkeypatch.setattr(ws_handlers, "run_public_allowlisted_text", fake_run)

    payload = await _run(_session(), {
        "host_mode": "allowlist", "workspace_path": str(tmp_path), "command": "git status",
    })

    assert payload == {
        "ok": True,
        "output": "o" * 8000,
        "stdout": "o" * 8000,
        "stderr": "e" * 8000,
        "exit_code": 23,
        "truncated": True,
        "stdoutBytes": 9000,
        "stderrBytes": 9000,
    }


def _fake_output(monkeypatch: pytest.MonkeyPatch, stdout: str, stderr: str) -> None:
    async def fake_run(
        _argv: list[str], _cwd: str, *, timeout: float, workspace_root: str | None = None
    ) -> tuple[int, str, str]:
        return 0, stdout, stderr

    monkeypatch.setattr(ws_handlers, "run_public_allowlisted_text", fake_run)


@pytest.mark.asyncio
@pytest.mark.parametrize(("stdout", "stderr", "disclosed"), [
    # Cut at 8000 characters; the sizes are the full output's UTF-8 bytes.
    ("é" * 8001, "", {"truncated": True, "stdoutBytes": 16002}),
    ("o" * 10, "è" * 9000, {"truncated": True, "stdoutBytes": 10, "stderrBytes": 18000}),
    ("o" * 9000, "e" * 9000, {"truncated": True, "stdoutBytes": 9000, "stderrBytes": 9000}),
# Short ids: a parameter's text in the test id goes into PYTEST_CURRENT_TEST,
# which Windows refuses above 32767 characters.
], ids=["stdout-multibyte", "stderr-only-multibyte", "both"])
async def test_allowlist_discloses_what_the_8000_character_cut_removed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, stdout: str, stderr: str, disclosed: dict[str, Any],
) -> None:
    monkeypatch.setattr(app.attribution, "known_workspaces", lambda: [str(tmp_path)])
    _fake_output(monkeypatch, stdout, stderr)

    payload = await _run(_session(), {
        "host_mode": "allowlist", "workspace_path": str(tmp_path), "command": "git log",
    })

    # The existing fields are what they always were; only the disclosure is new.
    assert payload == {
        "ok": True, "output": stdout[:8000], "stdout": stdout[:8000], "stderr": stderr[:8000], "exit_code": 0,
        **disclosed,
    }


@pytest.mark.asyncio
@pytest.mark.parametrize(("stdout", "stderr"), [("", ""), ("o" * 8000, "e" * 8000), ("ü" * 8000, "")],
                         ids=["empty", "exactly-8000", "multibyte-8000"])
async def test_allowlist_output_within_8000_characters_is_unchanged_and_not_truncated(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, stdout: str, stderr: str,
) -> None:
    monkeypatch.setattr(app.attribution, "known_workspaces", lambda: [str(tmp_path)])
    _fake_output(monkeypatch, stdout, stderr)

    payload = await _run(_session(), {
        "host_mode": "allowlist", "workspace_path": str(tmp_path), "command": "git log",
    })

    main_shape = {"ok": True, "output": stdout, "stdout": stdout, "stderr": stderr, "exit_code": 0}
    assert {k: v for k, v in payload.items() if k not in {"truncated", "stdoutBytes"}} == main_shape
    assert payload["truncated"] is False
    assert payload["stdoutBytes"] == len(stdout.encode("utf-8"))
    assert "stderrBytes" not in payload


@pytest.mark.asyncio
@pytest.mark.skipif(os.name == "nt", reason="POSIX sh and printf")
@pytest.mark.parametrize(("count", "truncated"), [(9000, True), (8000, False)])
async def test_legacy_shell_run_discloses_its_cut_too(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, count: int, truncated: bool,
) -> None:
    monkeypatch.setattr(app.attribution, "known_workspaces", lambda: [str(tmp_path)])

    payload = await _run(_session(), {
        "workspace_path": str(tmp_path), "command": f"printf '%{count}s' '' | tr ' ' a",
    })

    assert payload == {
        "ok": True, "output": "a" * min(count, 8000), "exit_code": 0,
        "truncated": truncated, "stdoutBytes": count,
    }


@pytest.mark.asyncio
async def test_allowlist_timeout_and_executor_error_keep_the_response_shape(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(app.attribution, "known_workspaces", lambda: [str(tmp_path)])

    async def timeout_run(
        _argv: list[str], _cwd: str, *, timeout: float, workspace_root: str | None = None
    ) -> tuple[int, str, str]:
        return 128, "", "git timed out"

    monkeypatch.setattr(ws_handlers, "run_public_allowlisted_text", timeout_run)
    timeout_payload = await _run(_session(), {
        "host_mode": "allowlist", "workspace_path": str(tmp_path), "command": "git status",
    })

    assert timeout_payload == {
        "ok": True, "output": "", "stdout": "", "stderr": "git timed out", "exit_code": 128,
        "truncated": False, "stdoutBytes": 0,
    }

    async def missing_binary(
        _argv: list[str], _cwd: str, *, timeout: float, workspace_root: str | None = None
    ) -> tuple[int, str, str]:
        return 127, "", "git not found"

    monkeypatch.setattr(ws_handlers, "run_public_allowlisted_text", missing_binary)
    error_payload = await _run(_session(), {
        "host_mode": "allowlist", "workspace_path": str(tmp_path), "command": "git status",
    })
    assert error_payload == {
        "ok": True, "output": "", "stdout": "", "stderr": "git not found", "exit_code": 127,
        "truncated": False, "stdoutBytes": 0,
    }


@pytest.mark.asyncio
@pytest.mark.skipif(os.name == "nt", reason="POSIX process groups")
async def test_legacy_timeout_kills_the_whole_process_group(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A timed-out legacy shell.run must take down what sh started, not just sh:
    a background grandchild still holding the stdout pipe used to orphan and
    keep communicate() waiting until it exited on its own."""
    import asyncio
    import signal

    monkeypatch.setattr(app.attribution, "known_workspaces", lambda: [str(tmp_path)])
    monkeypatch.setattr(ws_handlers, "_SHELL_RUN_TIMEOUT_S", 0.5)
    pidfile = tmp_path / "grandchild.pid"
    try:
        payload = await asyncio.wait_for(_run(_session(), {
            "workspace_path": str(tmp_path),
            "command": f"sleep 30 & echo $! > {pidfile}; wait",
        }), timeout=10)
        assert payload == {"ok": False, "error": "timeout after 0.5s"}
        grandchild = int(pidfile.read_text().strip())
        for _ in range(40):
            try:
                os.kill(grandchild, 0)
            except ProcessLookupError:
                break
            await asyncio.sleep(0.05)
        else:
            pytest.fail(f"grandchild {grandchild} outlived the shell.run timeout")
    finally:
        if pidfile.exists():
            try:
                os.kill(int(pidfile.read_text().strip()), signal.SIGKILL)
            except (ProcessLookupError, ValueError):
                pass

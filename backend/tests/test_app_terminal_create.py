from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import app, guard_hooks


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


class FakeTerminals:
    def __init__(self) -> None:
        self.created: list[dict[str, Any]] = []
        self.killed: list[tuple[str, bool]] = []

    def create(self, **kwargs: Any) -> SimpleNamespace:
        self.created.append(kwargs)
        return SimpleNamespace(
            id="term-1",
            pane_id=kwargs["pane_id"],
            command=kwargs["command"],
            proc=SimpleNamespace(pid=1234),
        )

    async def kill(self, session_id: str, force: bool = False) -> None:
        self.killed.append((session_id, force))

    def find_live_by_resume_id(self, *args: Any, **kwargs: Any) -> list[Any]:
        return []


class FakeAttribution:
    def __init__(self) -> None:
        self.registered: list[dict[str, Any]] = []

    def register_pane(self, pane_id: str, **kwargs: Any) -> None:
        self.registered.append({"pane_id": pane_id, **kwargs})

    def scan_pane_baseline(self, pane_id: str) -> None:
        pass


class FakeCodexHomeManager:
    def __init__(self, root: Path, session_homes: dict[str, Path] | None = None) -> None:
        self.root = root
        self.real_home = root / "real-codex"
        self.prepared: list[str] = []
        self.session_homes = session_homes or {}
        # sub-agent id -> the user thread it descends from; anything absent
        # resolves to itself, which is what a normal session does.
        self.repairs: dict[str, str] = {}
        self.looked_up: list[str] = []

    def prepare(self, home_id: str) -> Path:
        self.prepared.append(home_id)
        return self.root / home_id

    def find_session_home(self, resume_id: str) -> Path | None:
        self.looked_up.append(resume_id)
        return self.session_homes.get(resume_id)

    def resolve_user_thread_id(self, resume_id: str) -> str:
        return self.repairs.get(resume_id, resume_id)


def _env_without_guard_token(env: dict[str, str] | None) -> dict[str, str] | None:
    """The spawn env minus Navide Guard's per-pane token, which every claude,
    copilot and qwen pane gets (guard_hooks.PANE_TOKEN_ENV)."""
    rest = {k: v for k, v in (env or {}).items() if k != guard_hooks.PANE_TOKEN_ENV}
    return rest or None


def _session() -> app.Session:
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    session.terminals = FakeTerminals()  # type: ignore[assignment]
    return session


@pytest.fixture(autouse=True)
def _stub_agent_cli_probe(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        app,
        "_probe_agent_cli_for_spawn",
        lambda agent_key, _command=None: {
            "agent_key": agent_key,
            "binary_path": f"/test/bin/{agent_key}",
            "version": "1.0.0",
            "duration_ms": 1,
        } if agent_key and agent_key != "terminal" else None,
    )


@pytest.mark.asyncio
async def test_terminal_create_codex_prepares_home_and_registers_home_id(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    fake_attr = FakeAttribution()
    fake_home = FakeCodexHomeManager(tmp_path / "codex-panes")
    monkeypatch.setattr(app, "attribution", fake_attr)
    monkeypatch.setattr(app, "codex_home_manager", fake_home)
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    session = _session()

    await app.handle_message(session, {
        "id": "m1",
        "type": "terminal.create",
        "payload": {
            "pane_id": "live-pane",
            "agent_key": "codex",
            "command": "codex",
            "cwd": "/ws",
            "metadata": {
                "workspace_path": "/ws",
                "stage_id": "01",
                "slot_label": "Build",
                "session_home_id": "stable-home",
            },
        },
    })

    created = session.terminals.created[0]  # type: ignore[attr-defined]
    assert fake_home.prepared == ["stable-home"]
    assert created["env"]["CODEX_HOME"] == str(tmp_path / "codex-panes" / "stable-home")
    assert created["metadata"]["session_home_id"] == "stable-home"
    assert fake_attr.registered == [{
        "pane_id": "live-pane",
        "vendor": "codex",
        "cwd": "/ws",
        "workspace_path": "/ws",
        "stage_id": "01",
        "slot_key": "01:Build",
        "group_id": "",
        "explicit_session_id": "",
        "session_marker": "",
        "session_home_id": "stable-home",
        "defer_baseline": True,
    }]
    assert session.websocket.sent[0]["payload"]["pane_id"] == "live-pane"


@pytest.mark.asyncio
async def test_profile_agent_spawn_excluded_against_account_switch(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A regular pane of a profile agent spawns under the agent's credential
    switch lock: while a switch holds the lock, the spawn (and its
    _PTY_OWNERS claim) waits — closing the quiescence gate's TOCTOU window
    where a pane created mid-swap would start on the outgoing account's
    credentials. Non-profile agents are unaffected."""
    monkeypatch.setattr(app, "attribution", FakeAttribution())
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    session = _session()

    async with app.credential_vault.switch_lock("claude"):
        task = asyncio.create_task(app.handle_message(session, {
            "id": "m1",
            "type": "terminal.create",
            "payload": {
                "pane_id": "claude-pane",
                "agent_key": "claude",
                "command": "claude",
                "cwd": "/ws",
                "metadata": {"workspace_path": "/ws"},
            },
        }))
        # Ample opportunity to reach the spawn section — it must park on the
        # held switch lock before creating the PTY.
        for _ in range(50):
            await asyncio.sleep(0.005)
        assert session.terminals.created == []  # type: ignore[attr-defined]

        # A non-profile agent never takes the lock and spawns right through.
        other = _session()
        await asyncio.wait_for(app.handle_message(other, {
            "id": "m2",
            "type": "terminal.create",
            "payload": {
                "pane_id": "shell-pane",
                "agent_key": "terminal",
                "command": "/bin/zsh",
                "cwd": "/ws",
            },
        }), timeout=5)
        assert len(other.terminals.created) == 1  # type: ignore[attr-defined]

    await asyncio.wait_for(task, timeout=5)
    assert len(session.terminals.created) == 1  # type: ignore[attr-defined]
    assert app._PTY_OWNERS.get("term-1") is session


@pytest.mark.asyncio
async def test_terminal_create_codex_legacy_resume_keeps_default_home(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Resuming a session recorded under the real ~/.codex must not override
    CODEX_HOME — the per-pane home has no record of it and resume would fail."""
    fake_attr = FakeAttribution()
    fake_home = FakeCodexHomeManager(tmp_path / "codex-panes")
    fake_home.session_homes["legacy-id"] = fake_home.real_home
    monkeypatch.setattr(app, "attribution", fake_attr)
    monkeypatch.setattr(app, "codex_home_manager", fake_home)
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    session = _session()

    await app.handle_message(session, {
        "id": "m3",
        "type": "terminal.create",
        "payload": {
            "pane_id": "legacy-pane",
            "agent_key": "codex",
            # Real frontend shape: spawnPane wraps commands in a login shell.
            "command": ["/bin/zsh", "-lc", "codex resume legacy-id --yolo"],
            "cwd": "/ws",
            "metadata": {
                "workspace_path": "/ws",
                "session_home_id": "stable-home",
            },
        },
    })

    created = session.terminals.created[0]  # type: ignore[attr-defined]
    assert fake_home.prepared == []
    assert "CODEX_HOME" not in created["env"]


@pytest.mark.asyncio
async def test_terminal_create_codex_resume_of_pane_session_uses_pane_home(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Resume of a session NOT in the default home keeps the per-pane override."""
    fake_attr = FakeAttribution()
    fake_home = FakeCodexHomeManager(tmp_path / "codex-panes")
    monkeypatch.setattr(app, "attribution", fake_attr)
    monkeypatch.setattr(app, "codex_home_manager", fake_home)
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    session = _session()

    await app.handle_message(session, {
        "id": "m4",
        "type": "terminal.create",
        "payload": {
            "pane_id": "pane-2",
            "agent_key": "codex",
            "command": "codex resume pane-session-id",
            "cwd": "/ws",
            "metadata": {
                "workspace_path": "/ws",
                "session_home_id": "stable-home",
            },
        },
    })

    created = session.terminals.created[0]  # type: ignore[attr-defined]
    assert fake_home.prepared == ["stable-home"]
    assert created["env"]["CODEX_HOME"] == str(tmp_path / "codex-panes" / "stable-home")


@pytest.mark.asyncio
async def test_terminal_create_codex_resume_uses_owning_pane_home(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """A session recorded under another pane home resumes with THAT home,
    even when the persisted session_home_id drifted."""
    fake_attr = FakeAttribution()
    fake_home = FakeCodexHomeManager(tmp_path / "codex-panes")
    owning_home = tmp_path / "codex-panes" / "old-pane-home"
    fake_home.session_homes["drifted-id"] = owning_home
    monkeypatch.setattr(app, "attribution", fake_attr)
    monkeypatch.setattr(app, "codex_home_manager", fake_home)
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    session = _session()

    await app.handle_message(session, {
        "id": "m5",
        "type": "terminal.create",
        "payload": {
            "pane_id": "pane-3",
            "agent_key": "codex",
            "command": ["/bin/zsh", "-lc", "codex resume drifted-id"],
            "cwd": "/ws",
            "metadata": {
                "workspace_path": "/ws",
                "session_home_id": "stable-home",
            },
        },
    })

    created = session.terminals.created[0]  # type: ignore[attr-defined]
    assert fake_home.prepared == []
    assert created["env"]["CODEX_HOME"] == str(owning_home)
    assert created["metadata"]["session_home_id"] == "old-pane-home"


@pytest.mark.asyncio
async def test_terminal_create_codex_repairs_a_subagent_pin(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """A pane pinned to a sub-agent thread (what builds before the fix could
    persist) must resume the user thread instead: codex refuses direct input on
    a sub-agent, so resuming the stored id hands back an unusable pane. The
    repaired id has to reach BOTH the launch command and the home lookup."""
    fake_attr = FakeAttribution()
    fake_home = FakeCodexHomeManager(tmp_path / "codex-panes")
    fake_home.repairs["child-id"] = "parent-id"
    owning_home = tmp_path / "codex-panes" / "owning-home"
    fake_home.session_homes["parent-id"] = owning_home
    monkeypatch.setattr(app, "attribution", fake_attr)
    monkeypatch.setattr(app, "codex_home_manager", fake_home)
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    session = _session()

    await app.handle_message(session, {
        "id": "m6",
        "type": "terminal.create",
        "payload": {
            "pane_id": "pane-4",
            "agent_key": "codex",
            "command": ["/bin/zsh", "-ilc", "codex resume child-id"],
            "cwd": "/ws",
            "metadata": {
                "workspace_path": "/ws",
                "session_home_id": "stable-home",
            },
        },
    })

    created = session.terminals.created[0]  # type: ignore[attr-defined]
    assert created["command"][-1].startswith("codex resume parent-id -c ")
    # The home is the one recording the USER thread, not the sub-agent's pin.
    assert fake_home.looked_up == ["parent-id"]
    assert created["env"]["CODEX_HOME"] == str(owning_home)
    assert fake_home.prepared == []


@pytest.mark.asyncio
async def test_terminal_create_codex_leaves_an_ordinary_pin_alone(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """No repair to make: the command and the home lookup are untouched."""
    fake_attr = FakeAttribution()
    fake_home = FakeCodexHomeManager(tmp_path / "codex-panes")
    monkeypatch.setattr(app, "attribution", fake_attr)
    monkeypatch.setattr(app, "codex_home_manager", fake_home)
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    session = _session()

    await app.handle_message(session, {
        "id": "m7",
        "type": "terminal.create",
        "payload": {
            "pane_id": "pane-5",
            "agent_key": "codex",
            "command": ["/bin/zsh", "-ilc", "codex resume plain-id"],
            "cwd": "/ws",
            "metadata": {"workspace_path": "/ws", "session_home_id": "stable-home"},
        },
    })

    created = session.terminals.created[0]  # type: ignore[attr-defined]
    assert created["command"][-1].startswith("codex resume plain-id -c ")
    assert fake_home.looked_up == ["plain-id"]


def test_codex_resume_id_parses_resume_commands() -> None:
    assert app._resume_id_for_agent("codex", "codex resume abc-123") == "abc-123"
    assert app._resume_id_for_agent("codex", "codex resume abc-123 --yolo") == "abc-123"
    assert app._resume_id_for_agent("codex", "codex") == ""
    assert app._resume_id_for_agent("codex", "codex --resume abc") == ""
    assert app._resume_id_for_agent("codex", "") == ""
    assert app._resume_id_for_agent("codex", None) == ""
    # Shell-wrapped list — the shape the frontend actually sends.
    assert app._resume_id_for_agent("codex", ["/bin/zsh", "-lc", "codex resume abc-123 --yolo"]) == "abc-123"
    assert app._resume_id_for_agent("codex", ["/bin/zsh", "-lc", "codex"]) == ""
    assert app._resume_id_for_agent("codex", []) == ""


def test_claude_resume_id_parses_resume_commands() -> None:
    assert app._resume_id_for_agent("claude", "claude --resume abc-123") == "abc-123"
    assert app._resume_id_for_agent("claude", 
        "claude --resume abc-123 --dangerously-skip-permissions"
    ) == "abc-123"
    assert app._resume_id_for_agent("claude", 
        "claude --dangerously-skip-permissions --resume abc-123"
    ) == "abc-123"
    assert app._resume_id_for_agent("claude", "claude") == ""
    assert app._resume_id_for_agent("claude", "claude --session-id abc-123") == ""
    assert app._resume_id_for_agent("claude", "") == ""
    assert app._resume_id_for_agent("claude", None) == ""
    # Shell-wrapped list — the shape the frontend actually sends.
    assert app._resume_id_for_agent("claude", 
        ["/bin/zsh", "-lc", "claude --resume abc-123 --dangerously-skip-permissions"]
    ) == "abc-123"
    assert app._resume_id_for_agent("claude", ["/bin/zsh", "-lc", "claude"]) == ""


def test_kimi_resume_id_parses_resume_commands() -> None:
    assert app._resume_id_for_agent("kimi", "kimi --session session_abc-123") == "session_abc-123"
    assert app._resume_id_for_agent("kimi", "kimi -S session_abc-123") == "session_abc-123"
    assert app._resume_id_for_agent("kimi", "kimi --session session_abc-123 --yolo") == "session_abc-123"
    assert app._resume_id_for_agent("kimi", "kimi --yolo --session session_abc-123") == "session_abc-123"
    assert app._resume_id_for_agent("kimi", "kimi") == ""
    # `--session` takes an OPTIONAL id (bare flag = interactive picker); a
    # following flag must not be captured as the id.
    assert app._resume_id_for_agent("kimi", "kimi --session --yolo") == ""
    assert app._resume_id_for_agent("kimi", "kimi --session") == ""
    assert app._resume_id_for_agent("kimi", "") == ""
    assert app._resume_id_for_agent("kimi", None) == ""
    # Shell-wrapped list — the shape the frontend actually sends.
    assert app._resume_id_for_agent("kimi", 
        ["/bin/zsh", "-lc", "kimi --session session_abc-123 --yolo"]
    ) == "session_abc-123"
    assert app._resume_id_for_agent("kimi", ["/bin/zsh", "-lc", "kimi"]) == ""


def test_opencode_resume_id_parses_resume_commands() -> None:
    sid = "ses_18d0acbcaffe3eXy2s3zezEmix"
    assert app._resume_id_for_agent("opencode", f"opencode --session {sid}") == sid
    assert app._resume_id_for_agent("opencode", f"opencode -s {sid}") == sid
    assert app._resume_id_for_agent("opencode", f"opencode --session {sid} --print-logs") == sid
    assert app._resume_id_for_agent("opencode", f"opencode --print-logs --session {sid}") == sid
    assert app._resume_id_for_agent("opencode", "opencode") == ""
    # A following flag must not be captured as the id.
    assert app._resume_id_for_agent("opencode", "opencode --session --print-logs") == ""
    assert app._resume_id_for_agent("opencode", "opencode --session") == ""
    assert app._resume_id_for_agent("opencode", "") == ""
    assert app._resume_id_for_agent("opencode", None) == ""
    # Shell-wrapped list — the shape the frontend actually sends.
    assert app._resume_id_for_agent("opencode", 
        ["/bin/zsh", "-lc", f"opencode --session {sid}"]
    ) == sid
    assert app._resume_id_for_agent("opencode", ["/bin/zsh", "-lc", "opencode"]) == ""


def test_kilo_resume_id_parses_resume_commands() -> None:
    sid = "ses_29e1bcdcaffe3eXy2s3zezKilo"
    assert app._resume_id_for_agent("kilo", f"kilo --session {sid}") == sid
    assert app._resume_id_for_agent("kilo", f"kilo -s {sid}") == sid
    assert app._resume_id_for_agent("kilo", f"kilo --session {sid} --print-logs") == sid
    assert app._resume_id_for_agent("kilo", f"kilo --print-logs --session {sid}") == sid
    assert app._resume_id_for_agent("kilo", "kilo") == ""
    # A following flag must not be captured as the id.
    assert app._resume_id_for_agent("kilo", "kilo --session --print-logs") == ""
    assert app._resume_id_for_agent("kilo", "kilo --session") == ""
    assert app._resume_id_for_agent("kilo", "") == ""
    assert app._resume_id_for_agent("kilo", None) == ""
    # Shell-wrapped list — the shape the frontend actually sends.
    assert app._resume_id_for_agent("kilo", ["/bin/zsh", "-lc", f"kilo --session {sid}"]) == sid
    assert app._resume_id_for_agent("kilo", ["/bin/zsh", "-lc", "kilo"]) == ""


def test_qwen_resume_id_parses_resume_commands() -> None:
    sid = "1f0b9d5e-2f4a-4c0e-9b7d-3a5c8e9f0a1b"
    assert app._resume_id_for_agent("qwen", f"qwen --resume {sid}") == sid
    assert app._resume_id_for_agent("qwen", f"qwen -r {sid}") == sid
    assert app._resume_id_for_agent("qwen", f"qwen --resume {sid} --yolo") == sid
    assert app._resume_id_for_agent("qwen", f"qwen --yolo --resume {sid}") == sid
    assert app._resume_id_for_agent("qwen", "qwen") == ""
    # A following flag must not be captured as the id (bare --resume = latest).
    assert app._resume_id_for_agent("qwen", "qwen --resume --yolo") == ""
    assert app._resume_id_for_agent("qwen", "qwen --resume") == ""
    assert app._resume_id_for_agent("qwen", "") == ""
    assert app._resume_id_for_agent("qwen", None) == ""
    # Shell-wrapped list — the shape the frontend actually sends.
    assert app._resume_id_for_agent("qwen", ["/bin/zsh", "-lc", f"qwen --resume {sid}"]) == sid
    assert app._resume_id_for_agent("qwen", ["/bin/zsh", "-lc", "qwen"]) == ""


def test_pi_resume_id_parses_session_id_commands() -> None:
    """`pi --session-id <id>` both resumes an existing id and pins a NEW
    session's id — either way it names the pane's session, so it is claimed."""
    sid = "pi-sess.01_a"
    assert app._resume_id_for_agent("pi", f"pi --session-id {sid}") == sid
    assert app._resume_id_for_agent("pi", f"pi --session-id {sid} --no-color") == sid
    assert app._resume_id_for_agent("pi", f"pi --no-color --session-id {sid}") == sid
    assert app._resume_id_for_agent("pi", "pi") == ""
    # Flag guard: a following flag must never be captured as the id.
    assert app._resume_id_for_agent("pi", "pi --session-id --no-color") == ""
    assert app._resume_id_for_agent("pi", "pi --session-id") == ""
    assert app._resume_id_for_agent("pi", "") == ""
    assert app._resume_id_for_agent("pi", None) == ""
    # Frontend wraps commands as [shell, '-lc', '<cmd>'].
    assert app._resume_id_for_agent("pi", ["/bin/zsh", "-lc", f"pi --session-id {sid}"]) == sid
    assert app._resume_id_for_agent("pi", ["/bin/zsh", "-lc", "pi"]) == ""


def test_copilot_resume_id_parses_resume_commands() -> None:
    """`copilot --resume=<id>` both resumes an existing id and pins a NEW
    session under that UUID — either way it names the pane's session, so it
    is claimed. Both the `=` and space forms are accepted."""
    sid = "e6495800-dfd4-4a75-b2ab-d70980f83b89"
    assert app._resume_id_for_agent("copilot", f"copilot --resume={sid}") == sid
    assert app._resume_id_for_agent("copilot", f"copilot --resume {sid}") == sid
    assert app._resume_id_for_agent("copilot", f"copilot --resume={sid} --yolo") == sid
    assert app._resume_id_for_agent("copilot", f"copilot --yolo --resume={sid}") == sid
    assert app._resume_id_for_agent("copilot", f"copilot --yolo --resume {sid}") == sid
    assert app._resume_id_for_agent("copilot", "copilot") == ""
    # Flag guard: bare --resume (interactive picker) must not swallow a flag.
    assert app._resume_id_for_agent("copilot", "copilot --resume --yolo") == ""
    assert app._resume_id_for_agent("copilot", "copilot --resume") == ""
    assert app._resume_id_for_agent("copilot", "") == ""
    assert app._resume_id_for_agent("copilot", None) == ""
    # Frontend wraps commands as [shell, '-lc', '<cmd>'].
    assert app._resume_id_for_agent("copilot", ["/bin/zsh", "-lc", f"copilot --resume={sid}"]) == sid
    assert app._resume_id_for_agent("copilot", ["/bin/zsh", "-lc", "copilot"]) == ""


def test_cursor_resume_id_parses_resume_commands() -> None:
    """Cursor CLI resumes with `agent --resume=<chatId>` (legacy binary name
    `cursor-agent`); both the `=` and space forms are accepted."""
    sid = "e6495800-dfd4-4a75-b2ab-d70980f83b89"
    assert app._resume_id_for_agent("cursor", f"agent --resume={sid}") == sid
    assert app._resume_id_for_agent("cursor", f"agent --resume {sid}") == sid
    assert app._resume_id_for_agent("cursor", f"cursor-agent --resume={sid}") == sid
    assert app._resume_id_for_agent("cursor", f"cursor-agent --resume {sid}") == sid
    assert app._resume_id_for_agent("cursor", f"agent --force --resume={sid}") == sid
    assert app._resume_id_for_agent("cursor", "agent") == ""
    # Flag guard: bare --resume (picker) must not swallow a following flag.
    assert app._resume_id_for_agent("cursor", "agent --resume --force") == ""
    assert app._resume_id_for_agent("cursor", "agent --resume") == ""
    assert app._resume_id_for_agent("cursor", "") == ""
    assert app._resume_id_for_agent("cursor", None) == ""
    # Frontend wraps commands as [shell, '-lc', '<cmd>'].
    assert app._resume_id_for_agent("cursor", ["/bin/zsh", "-lc", f"agent --resume={sid}"]) == sid
    assert app._resume_id_for_agent("cursor", ["/bin/zsh", "-lc", "agent"]) == ""


@pytest.mark.asyncio
async def test_terminal_create_claude_resume_claims_resume_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Resumed Claude panes have no pinned --session-id; the resume id MUST be
    claimed at registration or the unowned-session fallback can attribute the
    session to a sibling pane in the same cwd (which then overwrites that
    sibling's persisted resume id — the lost-conversation-on-restart bug)."""
    fake_attr = FakeAttribution()
    monkeypatch.setattr(app, "attribution", fake_attr)
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    session = _session()

    await app.handle_message(session, {
        "id": "m6",
        "type": "terminal.create",
        "payload": {
            "pane_id": "claude-pane",
            "agent_key": "claude",
            "command": [
                "/bin/zsh", "-lc",
                "claude --resume resumed-uuid --dangerously-skip-permissions",
            ],
            "cwd": "/ws",
            "metadata": {"workspace_path": "/ws"},
        },
    })

    assert fake_attr.registered[0]["explicit_session_id"] == "resumed-uuid"


@pytest.mark.asyncio
async def test_terminal_create_passes_run_group_id_to_attribution(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """metadata.run_group_id is the sidebar group the pane was spawned into; it
    must reach register_pane so the pane's usage is credited to that group."""
    fake_attr = FakeAttribution()
    monkeypatch.setattr(app, "attribution", fake_attr)
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    session = _session()

    await app.handle_message(session, {
        "id": "m6g",
        "type": "terminal.create",
        "payload": {
            "pane_id": "grouped-pane",
            "agent_key": "claude",
            "command": "claude",
            "cwd": "/ws",
            "metadata": {"workspace_path": "/ws", "run_group_id": "rg-1"},
        },
    })

    assert fake_attr.registered[0]["group_id"] == "rg-1"


@pytest.mark.asyncio
async def test_terminal_create_claude_metadata_session_id_wins_over_command(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A pinned --session-id from metadata is the stronger identity; command
    parsing is only the fallback for resume spawns."""
    fake_attr = FakeAttribution()
    monkeypatch.setattr(app, "attribution", fake_attr)
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    session = _session()

    await app.handle_message(session, {
        "id": "m7",
        "type": "terminal.create",
        "payload": {
            "pane_id": "claude-pane-2",
            "agent_key": "claude",
            "command": "claude --dangerously-skip-permissions --session-id pinned-uuid",
            "cwd": "/ws",
            "metadata": {
                "workspace_path": "/ws",
                "explicit_session_id": "pinned-uuid",
            },
        },
    })

    assert fake_attr.registered[0]["explicit_session_id"] == "pinned-uuid"


@pytest.mark.asyncio
async def test_terminal_create_kimi_resume_claims_resume_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Resumed Kimi panes claim their resume id at registration so live events
    route back to them and the new-session single-candidate fallback excludes
    them (a fresh sibling pane in the same cwd stays bindable)."""
    fake_attr = FakeAttribution()
    monkeypatch.setattr(app, "attribution", fake_attr)
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    session = _session()

    await app.handle_message(session, {
        "id": "m8",
        "type": "terminal.create",
        "payload": {
            "pane_id": "kimi-pane",
            "agent_key": "kimi",
            "command": ["/bin/zsh", "-lc", "kimi --session session_resumed-uuid --yolo"],
            "cwd": "/ws",
            "metadata": {"workspace_path": "/ws"},
        },
    })

    assert fake_attr.registered[0]["explicit_session_id"] == "session_resumed-uuid"


@pytest.mark.asyncio
async def test_terminal_create_kimi_sets_escape_timeout_without_affecting_other_clis(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("PI_TUI_ESC_TIMEOUT", raising=False)
    monkeypatch.setattr(app, "attribution", FakeAttribution())
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)

    kimi_session = _session()
    await app.handle_message(kimi_session, {
        "id": "kimi-default",
        "type": "terminal.create",
        "payload": {
            "pane_id": "kimi-pane",
            "agent_key": "kimi",
            "command": "kimi --yolo",
            "cwd": "/ws",
            "metadata": {"workspace_path": "/ws"},
        },
    })
    kimi_created = kimi_session.terminals.created[0]  # type: ignore[attr-defined]
    assert kimi_created["env"]["PI_TUI_ESC_TIMEOUT"] == "100"

    qwen_session = _session()
    await app.handle_message(qwen_session, {
        "id": "qwen-default",
        "type": "terminal.create",
        "payload": {
            "pane_id": "qwen-pane",
            "agent_key": "qwen",
            "command": "qwen --yolo",
            "cwd": "/ws",
            "metadata": {"workspace_path": "/ws"},
        },
    })
    qwen_created = qwen_session.terminals.created[0]  # type: ignore[attr-defined]
    assert _env_without_guard_token(qwen_created["env"]) is None


@pytest.mark.asyncio
async def test_terminal_create_kimi_preserves_explicit_escape_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("PI_TUI_ESC_TIMEOUT", "300")
    monkeypatch.setattr(app, "attribution", FakeAttribution())
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    session = _session()

    await app.handle_message(session, {
        "id": "kimi-explicit",
        "type": "terminal.create",
        "payload": {
            "pane_id": "kimi-pane",
            "agent_key": "kimi",
            "command": "kimi --yolo",
            "cwd": "/ws",
            "env": {"PI_TUI_ESC_TIMEOUT": "250"},
            "metadata": {"workspace_path": "/ws"},
        },
    })

    created = session.terminals.created[0]  # type: ignore[attr-defined]
    assert created["env"]["PI_TUI_ESC_TIMEOUT"] == "250"

    inherited_session = _session()
    await app.handle_message(inherited_session, {
        "id": "kimi-inherited",
        "type": "terminal.create",
        "payload": {
            "pane_id": "kimi-inherited-pane",
            "agent_key": "kimi",
            "command": "kimi --yolo",
            "cwd": "/ws",
            "metadata": {"workspace_path": "/ws"},
        },
    })
    inherited_created = inherited_session.terminals.created[0]  # type: ignore[attr-defined]
    assert inherited_created["env"] is None


@pytest.mark.asyncio
async def test_terminal_create_qwen_resume_claims_resume_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Resumed Qwen panes claim their resume id at registration so live events
    route back to them and the new-session single-candidate fallback excludes
    them (a fresh sibling pane in the same cwd stays bindable)."""
    fake_attr = FakeAttribution()
    monkeypatch.setattr(app, "attribution", fake_attr)
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    session = _session()

    await app.handle_message(session, {
        "id": "m9",
        "type": "terminal.create",
        "payload": {
            "pane_id": "qwen-pane",
            "agent_key": "qwen",
            "command": ["/bin/zsh", "-lc", "qwen --resume resumed-uuid --yolo"],
            "cwd": "/ws",
            "metadata": {"workspace_path": "/ws"},
        },
    })

    assert fake_attr.registered[0]["explicit_session_id"] == "resumed-uuid"


@pytest.mark.asyncio
async def test_terminal_create_pi_session_id_claims_resume_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Pi panes launched with `--session-id <id>` claim that id at
    registration (it names the session whether it resumes or creates), so
    live events route back to this pane and the new-session single-candidate
    fallback excludes it."""
    fake_attr = FakeAttribution()
    monkeypatch.setattr(app, "attribution", fake_attr)
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    session = _session()

    await app.handle_message(session, {
        "id": "m10",
        "type": "terminal.create",
        "payload": {
            "pane_id": "pi-pane",
            "agent_key": "pi",
            "command": ["/bin/zsh", "-lc", "pi --session-id resumed-uuid"],
            "cwd": "/ws",
            "metadata": {"workspace_path": "/ws"},
        },
    })

    assert fake_attr.registered[0]["explicit_session_id"] == "resumed-uuid"


@pytest.mark.asyncio
async def test_terminal_create_copilot_resume_claims_resume_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Copilot panes launched with `--resume=<id>` claim that id at
    registration (it names the session whether it resumes or creates), so
    live events route back to this pane and the new-session single-candidate
    fallback excludes it."""
    fake_attr = FakeAttribution()
    monkeypatch.setattr(app, "attribution", fake_attr)
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    session = _session()

    await app.handle_message(session, {
        "id": "m11",
        "type": "terminal.create",
        "payload": {
            "pane_id": "copilot-pane",
            "agent_key": "copilot",
            "command": ["/bin/zsh", "-lc", "copilot --resume=resumed-uuid --yolo"],
            "cwd": "/ws",
            "metadata": {"workspace_path": "/ws"},
        },
    })

    assert fake_attr.registered[0]["explicit_session_id"] == "resumed-uuid"


@pytest.mark.asyncio
async def test_terminal_create_cursor_resume_claims_resume_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Cursor panes launched with `agent --resume=<chatId>` claim that id at
    registration (markers only appear in a fresh kickoff), so the resumed
    session's events route back to this pane."""
    fake_attr = FakeAttribution()
    monkeypatch.setattr(app, "attribution", fake_attr)
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    session = _session()

    await app.handle_message(session, {
        "id": "m12",
        "type": "terminal.create",
        "payload": {
            "pane_id": "cursor-pane",
            "agent_key": "cursor",
            "command": ["/bin/zsh", "-lc", "agent --resume=resumed-uuid --force"],
            "cwd": "/ws",
            "metadata": {"workspace_path": "/ws"},
        },
    })

    assert fake_attr.registered[0]["explicit_session_id"] == "resumed-uuid"


@pytest.mark.asyncio
async def test_terminal_create_aider_registers_without_resume_claim(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Aider panes pass the attribution whitelist but claim NO resume id —
    `aider --restore-chat-history` takes no id, so there is nothing to parse
    from the launch command; binding relies on the kickoff marker."""
    fake_attr = FakeAttribution()
    monkeypatch.setattr(app, "attribution", fake_attr)
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    session = _session()

    await app.handle_message(session, {
        "id": "m13",
        "type": "terminal.create",
        "payload": {
            "pane_id": "aider-pane",
            "agent_key": "aider",
            "command": ["/bin/zsh", "-lc", "aider --restore-chat-history"],
            "cwd": "/ws",
            "metadata": {"workspace_path": "/ws"},
        },
    })

    assert fake_attr.registered[0]["pane_id"] == "aider-pane"
    assert fake_attr.registered[0]["vendor"] == "aider"
    assert fake_attr.registered[0]["explicit_session_id"] == ""


@pytest.mark.asyncio
async def test_spawn_path_refresh_throttles(monkeypatch: pytest.MonkeyPatch) -> None:
    """Agent-CLI spawns refresh the backend PATH (so a just-installed CLI is
    found), but at most once per interval — the probe shells out."""
    calls: list[float | None] = []
    monkeypatch.setattr(
        app.onboarding_deps,
        "_refresh_path_from_login_shell",
        lambda *_a, **kw: calls.append(kw.get("timeout_s")),
    )
    monkeypatch.setattr(app, "_last_path_refresh", 0.0)

    await app._ensure_fresh_path_for_spawn("grok")
    await app._ensure_fresh_path_for_spawn("claude")  # inside throttle window

    assert len(calls) == 1
    # The pre-spawn ceiling, not the passive one: terminal.create has 30s and
    # has already promised 25s of it to the credential switch lock, so a longer
    # probe here would replace that lock's named timeout with a generic one.
    assert calls[0] == app.onboarding_deps._PATH_PROBE_TIMEOUT_SPAWN_S


@pytest.mark.asyncio
async def test_spawn_path_refresh_skips_plain_terminal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[int] = []
    monkeypatch.setattr(
        app.onboarding_deps,
        "_refresh_path_from_login_shell",
        lambda *_a, **_kw: calls.append(1),
    )
    monkeypatch.setattr(app, "_last_path_refresh", 0.0)

    await app._ensure_fresh_path_for_spawn("terminal")

    assert calls == []


@pytest.mark.asyncio
async def test_terminal_create_probe_failure_returns_details_without_spawning(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fail_probe(_agent_key: str, _command: object = None) -> None:
        raise app.AgentCliProbeError(
            "Claude Code startup probe was terminated by SIGKILL after 42ms (/opt/bin/claude)",
            {
                "binary_path": "/opt/bin/claude",
                "signal": "SIGKILL",
                "exit_code": -9,
                "duration_ms": 42,
            },
        )

    monkeypatch.setattr(app, "_probe_agent_cli_for_spawn", fail_probe)
    session = _session()

    await app.handle_message(session, {
        "id": "probe-fail",
        "type": "terminal.create",
        "payload": {
            "pane_id": "claude-pane",
            "agent_key": "claude",
            "command": "claude",
            "cwd": "/ws",
        },
    })

    assert session.terminals.created == []  # type: ignore[attr-defined]
    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["ok"] is False
    assert response["error"]["code"] == "CLI_PROBE_FAILED"
    assert response["error"]["details"]["signal"] == "SIGKILL"
    assert response["error"]["details"]["binary_path"] == "/opt/bin/claude"


@pytest.mark.asyncio
async def test_terminal_create_rejects_child_that_died_before_ack() -> None:
    session = _session()

    def create_closed(**kwargs: Any) -> SimpleNamespace:
        return SimpleNamespace(
            id="dead-term",
            pane_id=kwargs["pane_id"],
            command=kwargs["command"],
            proc=SimpleNamespace(pid=1234),
            closed=True,
            close_reason="exit",
            exit_code=-9,
            exit_signal="SIGKILL",
            uptime_ms=42,
        )

    session.terminals.create = create_closed  # type: ignore[method-assign]

    await app.handle_message(session, {
        "id": "early-death",
        "type": "terminal.create",
        "payload": {
            "pane_id": "terminal-pane",
            "agent_key": "terminal",
            "command": "bash",
            "cwd": "/ws",
        },
    })

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["ok"] is False
    assert response["error"]["code"] == "CLI_PROBE_FAILED"
    assert response["error"]["details"]["uptime_ms"] == 42
    assert response["error"]["details"]["signal"] == "SIGKILL"


@pytest.mark.asyncio
async def test_terminal_create_antigravity_registers_session_marker(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Antigravity has no launch-time session identity; its marker MUST reach
    attribution.register_pane or binding/resume can never happen (regression:
    the register gate was hardcoded to claude/codex only)."""
    fake_attr = FakeAttribution()
    monkeypatch.setattr(app, "attribution", fake_attr)
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    session = _session()

    await app.handle_message(session, {
        "id": "m3",
        "type": "terminal.create",
        "payload": {
            "pane_id": "ag-pane",
            "agent_key": "antigravity",
            "command": "agy --dangerously-skip-permissions",
            "cwd": "/ws",
            "metadata": {
                "workspace_path": "/ws",
                "session_marker": "at-pane:ag-pane",
            },
        },
    })

    assert fake_attr.registered == [{
        "pane_id": "ag-pane",
        "vendor": "antigravity",
        "cwd": "/ws",
        "workspace_path": "/ws",
        "stage_id": None,
        "slot_key": "",
        "group_id": "",
        "explicit_session_id": "",
        "session_marker": "at-pane:ag-pane",
        "session_home_id": "",
        "defer_baseline": True,
    }]


_SHELL = "/bin/zsh"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("agent_key", "expected"),
    [("claude", "claude auth login"), ("grok", "grok login"), ("codex", "codex login")],
)
async def test_live_login_spawn_rewrites_command_without_a_profile(
    monkeypatch: pytest.MonkeyPatch,
    agent_key: str,
    expected: str,
) -> None:
    """A live login (the active account) carries no profile id, but still has
    to jump straight into the vendor's sign-in trigger.

    The rewrite used to hang off `login_profile_id`, so signing in to the
    ACTIVE account opened a bare REPL instead of `<cli> login`. The command to
    run and the home to run it in are separate decisions: `is_login` selects
    the command, `login_profile_id` only selects the isolated home.
    """
    monkeypatch.setattr(app, "attribution", FakeAttribution())
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    session = _session()

    await app.handle_message(session, {
        "id": "m1",
        "type": "terminal.create",
        "payload": {
            "pane_id": "login-pane",
            "agent_key": agent_key,
            "command": [_SHELL, "-lc", f"{agent_key} --dangerously-skip-permissions"],
            "cwd": "/ws",
            "is_login": True,
            "metadata": {"workspace_path": "/ws"},
        },
    })

    created = session.terminals.created[0]  # type: ignore[attr-defined]
    # The [shell, -lc, cmd] wrapper survives; only the command text is replaced,
    # and the YOLO flag is dropped — it does not apply to an auth subcommand.
    assert created["command"][-1] == expected
    assert created["command"][:2] == [_SHELL, "-lc"]
    # A live login must NOT be marked as an isolated login pane: it signs in to
    # the live credentials on purpose.
    assert "login_profile_id" not in created["metadata"]


@pytest.mark.asyncio
async def test_ordinary_spawn_is_not_rewritten(monkeypatch: pytest.MonkeyPatch) -> None:
    """Guard for the rewrite hoist: a normal pane keeps its command verbatim."""
    monkeypatch.setattr(app, "attribution", FakeAttribution())
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    session = _session()

    await app.handle_message(session, {
        "id": "m1",
        "type": "terminal.create",
        "payload": {
            "pane_id": "normal-pane",
            "agent_key": "claude",
            "command": [_SHELL, "-lc", "claude --dangerously-skip-permissions"],
            "cwd": "/ws",
            "metadata": {"workspace_path": "/ws"},
        },
    })

    created = session.terminals.created[0]  # type: ignore[attr-defined]
    assert created["command"][-1] == "claude --dangerously-skip-permissions"


def _stub_identity(monkeypatch: pytest.MonkeyPatch, signed_in: bool) -> None:
    """Override only `identity` on the real vault — the spawn path also calls
    switch_lock and friends, and a bare stub object would mask real wiring."""
    monkeypatch.setattr(
        app.credential_vault, "identity",
        lambda _key, _slot=None: {"email": None, "signedIn": signed_in},
    )


def _events(session: app.Session, event_type: str) -> list[dict[str, Any]]:
    return [
        m["payload"] for m in session.websocket.sent  # type: ignore[attr-defined]
        if m.get("type") == event_type
    ]


@pytest.mark.asyncio
async def test_installed_but_signed_out_cli_announces_itself(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`cli.missing` says "not installed"; this says "installed, no credentials".

    The probe is a --version smoke test, so it cannot tell the two apart, and
    the pane would silently open on the vendor's own sign-in prompt. Advisory
    only: unlike cli.missing the spawn is still valid and must go ahead.
    """
    monkeypatch.setattr(app, "attribution", FakeAttribution())
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    _stub_identity(monkeypatch, False)
    session = _session()

    await app.handle_message(session, {
        "id": "m1",
        "type": "terminal.create",
        "payload": {
            "pane_id": "grok-pane",
            "agent_key": "grok",
            "command": [_SHELL, "-lc", "grok"],
            "cwd": "/ws",
            "metadata": {"workspace_path": "/ws"},
        },
    })

    notices = _events(session, "cli.signed_out")
    assert len(notices) == 1
    assert notices[0]["agent_key"] == "grok"
    assert notices[0]["pane_id"] == "grok-pane"
    assert notices[0]["label"]
    # Advisory, not fatal: the pane still spawns.
    assert session.terminals.created  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_signed_in_cli_announces_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(app, "attribution", FakeAttribution())
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    _stub_identity(monkeypatch, True)
    session = _session()

    await app.handle_message(session, {
        "id": "m1",
        "type": "terminal.create",
        "payload": {
            "pane_id": "grok-pane",
            "agent_key": "grok",
            "command": [_SHELL, "-lc", "grok"],
            "cwd": "/ws",
            "metadata": {"workspace_path": "/ws"},
        },
    })

    assert _events(session, "cli.signed_out") == []


@pytest.mark.asyncio
@pytest.mark.parametrize("agent_key", ["cursor"])
async def test_vendors_without_a_live_credential_file_are_never_reported(
    monkeypatch: pytest.MonkeyPatch,
    agent_key: str,
) -> None:
    """No live_file means nothing on disk to read.

    `credential_vault.identity` answers signedIn=False for these by default,
    which is absence of evidence, not evidence of absence — reporting it would
    put a false "not signed in" notice on every CLI Navide cannot inspect.
    """
    monkeypatch.setattr(app, "attribution", FakeAttribution())
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    _stub_identity(monkeypatch, False)
    session = _session()

    await app.handle_message(session, {
        "id": "m1",
        "type": "terminal.create",
        "payload": {
            "pane_id": f"{agent_key}-pane",
            "agent_key": agent_key,
            "command": [_SHELL, "-lc", agent_key],
            "cwd": "/ws",
            "metadata": {"workspace_path": "/ws"},
        },
    })

    assert _events(session, "cli.signed_out") == []


@pytest.mark.asyncio
async def test_a_login_pane_is_not_told_it_is_signed_out(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Signing out is the premise of a login pane, not news."""
    monkeypatch.setattr(app, "attribution", FakeAttribution())
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    _stub_identity(monkeypatch, False)
    session = _session()

    await app.handle_message(session, {
        "id": "m1",
        "type": "terminal.create",
        "payload": {
            "pane_id": "grok-login",
            "agent_key": "grok",
            "command": [_SHELL, "-lc", "grok"],
            "cwd": "/ws",
            "is_login": True,
            "metadata": {"workspace_path": "/ws"},
        },
    })

    assert _events(session, "cli.signed_out") == []


@pytest.mark.asyncio
async def test_terminal_create_codex_seeds_hook_trust_for_the_final_codex_home(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """Hook trust is carried over to whichever CODEX_HOME the pane spawns with."""

    class SeedingHome(FakeCodexHomeManager):
        def __init__(self, root: Path) -> None:
            super().__init__(root)
            self.seeded: list[Path] = []

        def seed_hook_trust(self, pane_home: Path) -> int:
            self.seeded.append(pane_home)
            return 8

    fake_home = SeedingHome(tmp_path / "codex-panes")
    monkeypatch.setattr(app, "attribution", FakeAttribution())
    monkeypatch.setattr(app, "codex_home_manager", fake_home)
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    session = _session()

    await app.handle_message(session, {
        "id": "m-seed",
        "type": "terminal.create",
        "payload": {
            "pane_id": "pane-seed",
            "agent_key": "codex",
            "command": "codex",
            "cwd": "/ws",
            "metadata": {"workspace_path": "/ws", "session_home_id": "stable-home"},
        },
    })

    created = session.terminals.created[0]  # type: ignore[attr-defined]
    assert fake_home.seeded == [Path(created["env"]["CODEX_HOME"])]

    # A non-codex spawn never touches codex's trust store.
    await app.handle_message(session, {
        "id": "m-claude",
        "type": "terminal.create",
        "payload": {
            "pane_id": "pane-claude",
            "agent_key": "claude",
            "command": "claude",
            "cwd": "/ws",
            "metadata": {"workspace_path": "/ws"},
        },
    })
    assert len(fake_home.seeded) == 1


def _missing_probe(_agent_key: str, _command: object = None) -> None:
    raise app.AgentCliProbeError("codex is not installed", {"reason": "not_found"})


@pytest.mark.asyncio
async def test_cli_missing_omits_an_empty_pane_id_rather_than_sending_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An empty pane id is not "no pane id" — but to the window it looks alike.

    The renderer reads a falsy pane id as "no pane at all", which is the branch
    that skips the don't-ask-again opt-out. Sending "" would therefore re-ask a
    user who had switched the prompt off. terminal.create requires the key, so
    only a caller that passes an empty one can produce this.
    """
    monkeypatch.setattr(app, "_probe_agent_cli_for_spawn", _missing_probe)
    session = _session()

    await app.handle_message(session, {
        "id": "empty-pane",
        "type": "terminal.create",
        "payload": {"pane_id": "", "agent_key": "codex", "command": "codex", "cwd": "/ws"},
    })

    missing = _events(session, "cli.missing")
    assert len(missing) == 1
    assert missing[0]["agent_key"] == "codex"
    assert missing[0]["reason"] == "not_found"
    assert "pane_id" not in missing[0]


@pytest.mark.asyncio
async def test_cli_missing_still_carries_a_real_pane_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The opt-out only applies to a prompt that belongs to a pane, and an
    embedded CLI dock owns a pane id without owning a pane entry — dropping it
    is what would bypass the opt-out."""
    monkeypatch.setattr(app, "_probe_agent_cli_for_spawn", _missing_probe)
    session = _session()

    await app.handle_message(session, {
        "id": "with-pane",
        "type": "terminal.create",
        "payload": {
            "pane_id": "codex-pane",
            "agent_key": "codex",
            "command": "codex",
            "cwd": "/ws",
        },
    })

    missing = _events(session, "cli.missing")
    assert len(missing) == 1
    assert missing[0]["pane_id"] == "codex-pane"


def _codex_sandbox(tmp_path: Path):
    """A real CodexHomeManager over a sandbox ~/.codex: one user hooks.json
    whose stop hook the user trusted in config.toml."""
    from agent_team_backend.cli_vendors.codex import CodexHomeManager, _toml_escape

    real = tmp_path / "home" / ".codex"
    real.mkdir(parents=True)
    (real / "hooks.json").write_text('{"hooks": {}}', encoding="utf-8")
    key = _toml_escape(str(real / "hooks.json"))
    (real / "config.toml").write_text(
        f'model = "x"\n\n[hooks.state."{key}:stop:0:0"]\ntrusted_hash = "sha256:aaaa"\n', encoding="utf-8"
    )

    class SandboxHome(CodexHomeManager):
        session_homes: dict[str, Path] = {}

        def find_session_home(self, resume_id: str) -> Path | None:
            return self.session_homes.get(resume_id)

    manager = SandboxHome(
        real_home=real, panes_root=tmp_path / "home" / ".codex-panes", managed_skills_root=tmp_path / "skills",
    )
    return manager, real


def _tree(root: Path) -> dict[str, bytes]:
    return {str(p.relative_to(root)): p.read_bytes() for p in sorted(root.rglob("*")) if p.is_file()}


def _overrides(command: Any) -> list[str]:
    import shlex

    words = shlex.split(command[-1] if isinstance(command, list) else command)
    return [words[i + 1] for i, w in enumerate(words) if w == "-c"]


@pytest.mark.asyncio
@pytest.mark.parametrize("allowed", [True, False])
async def test_terminal_create_codex_carries_hook_trust_inline_and_leaves_the_user_config_alone(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, allowed: bool,
) -> None:
    """Phase 3: fresh and resume spawns carry the trust rows as an inline
    ``-c hooks.state={...}`` beside Navide's own session hooks, and
    ~/.codex stays byte-identical. Off: neither the override nor a write."""
    import tomllib

    from agent_team_backend import convenience, convenience_wiring
    from agent_team_backend.db import Database

    gate = convenience.ConvenienceGate(Database(tmp_path / "navide.db"), backup_root=tmp_path / "backups")
    convenience_wiring.install(gate)
    monkeypatch.setattr(convenience_wiring, "_CARRYING", set())
    try:
        manager, real = _codex_sandbox(tmp_path)
        monkeypatch.setattr(app, "attribution", FakeAttribution())
        monkeypatch.setattr(app, "codex_home_manager", manager)
        monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
        if not allowed:
            convenience_wiring.set_feature("codex.hook-trust", False, port_file=str(tmp_path / "port"))
        convenience_wiring.carry_codex_hook_trust()
        before = _tree(real)
        session = _session()

        await app.handle_message(session, {
            "id": "m-fresh", "type": "terminal.create",
            "payload": {
                "pane_id": "pane-fresh", "agent_key": "codex", "command": ["/bin/zsh", "-ilc", "codex"],
                "cwd": "/ws", "metadata": {"workspace_path": "/ws", "session_home_id": "home-fresh"},
            },
        })
        resumed_home = manager.prepare("home-resume")
        manager.session_homes["11111111-2222-4333-8444-555555555555"] = resumed_home
        await app.handle_message(session, {
            "id": "m-resume", "type": "terminal.create",
            "payload": {
                "pane_id": "pane-resume", "agent_key": "codex",
                "command": ["/bin/zsh", "-ilc", "codex resume 11111111-2222-4333-8444-555555555555"],
                "cwd": "/ws", "metadata": {"workspace_path": "/ws"},
            },
        })

        assert _tree(real) == before
        created = session.terminals.created  # type: ignore[attr-defined]
        assert len(created) == 2
        for spawn in created:
            home = Path(spawn["env"]["CODEX_HOME"])
            overrides = _overrides(spawn["command"])
            # Navide's own session hooks are still wired.
            assert any(o.startswith("hooks.SessionStart=") for o in overrides)
            assert any(o.startswith("hooks.PreToolUse=") for o in overrides)
            state = [o for o in overrides if o.startswith("hooks.state=")]
            if not allowed:
                assert state == []
                continue
            assert len(state) == 1
            assert tomllib.loads(state[0]) == {"hooks": {"state": {
                f"{home / 'hooks.json'}:stop:0:0": {"trusted_hash": "sha256:aaaa"},
            }}}
        assert Path(created[1]["env"]["CODEX_HOME"]) == resumed_home
    finally:
        convenience_wiring.install(None)

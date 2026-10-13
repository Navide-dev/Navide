"""Issue #121: ``~/.codex-panes/<id>`` is reclaimed when its pane is gone.

A pane home is created per spawn and was never removed, so failed spawns and
closed panes piled up (reporter: 117 homes, one of them 5 GB). Reclaiming has
one hard rule: ``codex resume <id>`` only works from the home that recorded
the rollout, so a home that still holds one is never touched.
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import app
from agent_team_backend.cli_vendors import codex as codex_vendor
from agent_team_backend.codex_home import CodexHomeManager

PANE_A = "0a1b2c3d-1111-4222-8333-444455556666"
PANE_B = "0a1b2c3d-7777-4888-8999-aaaabbbbcccc"
PANE_C = "0a1b2c3d-dddd-4eee-8fff-000011112222"
AI_TERMINAL = "66b8aaa1-plan-ai-terminal"


def _manager(tmp_path: Path) -> tuple[CodexHomeManager, Path, Path]:
    real = tmp_path / "real-codex"
    real.mkdir()
    (real / "auth.json").write_text("{}", encoding="utf-8")
    panes = tmp_path / "panes"
    return CodexHomeManager(real_home=real, panes_root=panes), real, panes


def _rollout(home: Path, subdir: str = "sessions") -> Path:
    path = home / subdir / "2026" / "09" / "21" / "rollout-2026-09-21T00-00-00-abc.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"type": "session_meta", "payload": {"id": "abc"}}) + "\n")
    return path


# ── manager rules ───────────────────────────────────────────────────────────


def test_reclaim_removes_a_home_that_owns_no_session(tmp_path: Path) -> None:
    manager, real, panes = _manager(tmp_path)
    home = manager.prepare(PANE_A)
    (home / "history.jsonl").write_text("x", encoding="utf-8")

    assert manager.reclaim(PANE_A) is True

    assert not home.exists()
    # Shared entries are symlinks; removing the home must not reach through.
    assert (real / "auth.json").read_text(encoding="utf-8") == "{}"


@pytest.mark.parametrize("subdir", ["sessions", "archived_sessions"])
def test_reclaim_keeps_a_home_that_owns_a_rollout(tmp_path: Path, subdir: str) -> None:
    manager, _real, _panes = _manager(tmp_path)
    home = manager.prepare(PANE_A)
    rollout = _rollout(home, subdir)

    assert manager.reclaim(PANE_A) is False

    assert rollout.exists()


def _state_db(real: Path, rollout_paths: list[str]) -> Path:
    db = real / "state_5.sqlite"
    conn = sqlite3.connect(db)
    conn.execute("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)")
    conn.executemany(
        "INSERT INTO threads VALUES (?, ?)",
        [(f"thread-{i}", path) for i, path in enumerate(rollout_paths)],
    )
    conn.commit()
    conn.close()
    return db


def test_reclaim_treats_a_symlinked_sessions_dir_as_unowned(tmp_path: Path) -> None:
    """The legacy mirror: `sessions` links back to ~/.codex/sessions. Those
    rollouts belong to the real home (find_session_home routes there), so the
    pane home owns nothing — and the link is removed, never its target."""
    manager, real, _panes = _manager(tmp_path)
    real_rollout = _rollout(real)
    _state_db(real, [str(real_rollout)])
    home = manager.prepare(PANE_A)
    (home / "sessions").symlink_to(real / "sessions", target_is_directory=True)

    assert manager.reclaim(PANE_A) is True

    assert not home.exists()
    assert real_rollout.exists()


def test_reclaim_keeps_a_mirrored_home_the_state_db_still_keys_on(tmp_path: Path) -> None:
    """codex 0.155 resumes through `threads.rollout_path` in its state db. A
    rollout written through the mirror link was recorded under the PANE path,
    so removing the home strands the thread ("no rollout found for thread
    id") although the file lives on in the real home (2026-09-21)."""
    manager, real, _panes = _manager(tmp_path)
    real_rollout = _rollout(real)
    home = manager.prepare(PANE_A)
    (home / "sessions").symlink_to(real / "sessions", target_is_directory=True)
    _state_db(real, [str(home / "sessions" / real_rollout.relative_to(real / "sessions"))])

    assert manager.reclaim(PANE_A) is False

    assert (home / "sessions").is_symlink()
    assert real_rollout.exists()


def test_reclaim_keeps_a_mirrored_home_when_the_state_db_is_unreadable(tmp_path: Path) -> None:
    manager, real, _panes = _manager(tmp_path)
    (real / "state_5.sqlite").write_text("not a database", encoding="utf-8")
    home = manager.prepare(PANE_A)
    (home / "sessions").symlink_to(real / "sessions", target_is_directory=True)

    assert manager.reclaim(PANE_A) is False
    assert home.exists()


def test_reclaim_keeps_a_mirrored_home_when_the_state_db_has_no_threads_table(
    tmp_path: Path,
) -> None:
    """A schema bump that moves `threads` elsewhere must read as "unknown",
    not "unreferenced" — the latter would reclaim every mirrored home at once
    and look exactly like a clean sweep."""
    manager, real, _panes = _manager(tmp_path)
    sqlite3.connect(real / "state_5.sqlite").close()
    home = manager.prepare(PANE_A)
    (home / "sessions").symlink_to(real / "sessions", target_is_directory=True)

    assert manager.reclaim(PANE_A) is False
    assert home.exists()


def test_reclaim_only_touches_navide_shaped_home_ids(tmp_path: Path) -> None:
    manager, _real, panes = _manager(tmp_path)
    foreign = panes / "env-codex"
    foreign.mkdir(parents=True)

    assert manager.reclaim("env-codex") is False
    assert foreign.exists()

    ai_home = manager.prepare(AI_TERMINAL)
    assert manager.reclaim(AI_TERMINAL) is True
    assert not ai_home.exists()


def test_reclaim_unlinks_a_symlinked_home_without_following_it(tmp_path: Path) -> None:
    manager, _real, panes = _manager(tmp_path)
    target = tmp_path / "elsewhere"
    target.mkdir()
    (target / "keep.txt").write_text("k", encoding="utf-8")
    panes.mkdir()
    (panes / PANE_A).symlink_to(target, target_is_directory=True)

    assert manager.reclaim(PANE_A) is True

    assert not (panes / PANE_A).is_symlink()
    assert (target / "keep.txt").exists()


def test_reclaim_keeps_a_home_holding_a_stranded_login(tmp_path: Path) -> None:
    """A fresh-install login lands as a real auth.json inside the pane home
    (see promote_stranded_auth); deleting it would sign the user out."""
    manager, real, _panes = _manager(tmp_path)
    (real / "auth.json").unlink()
    home = manager.prepare(PANE_A)
    (home / "auth.json").write_text('{"tokens": 1}', encoding="utf-8")

    assert manager.reclaim(PANE_A) is False
    assert home.exists()


def test_reclaim_missing_home_is_a_noop(tmp_path: Path) -> None:
    manager, _real, _panes = _manager(tmp_path)
    assert manager.reclaim(PANE_A) is False


def test_sweep_orphans_reclaims_unowned_homes_and_keeps_the_rest(tmp_path: Path) -> None:
    manager, real, panes = _manager(tmp_path)
    empty = manager.prepare(PANE_A)
    owning = manager.prepare(PANE_B)
    _rollout(owning)
    linked = manager.prepare(PANE_C)
    (linked / "sessions").symlink_to(real / "sessions", target_is_directory=True)
    foreign = panes / "p2"
    foreign.mkdir()
    (panes / ".DS_Store").write_text("", encoding="utf-8")

    reclaimed = manager.sweep_orphans()

    assert sorted(reclaimed) == sorted([PANE_A, PANE_C])
    assert not empty.exists()
    assert not linked.exists()
    assert owning.exists()
    assert foreign.exists()


def test_sweep_orphans_skips_a_home_a_running_codex_uses(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Another Navide on this machine (a packaged build beside `pnpm dev`)
    still has panes when this backend starts. Its codex processes carry the
    home in CODEX_HOME; sweeping one from under them cost the user every
    shared link in it and the thread pointer (2026-09-21, 79 + 27 homes)."""
    manager, _real, _panes = _manager(tmp_path)
    live = manager.prepare(PANE_A)
    idle = manager.prepare(PANE_B)

    class _Proc:
        def __init__(self, env: dict[str, str] | None) -> None:
            self._env = env

        def environ(self) -> dict[str, str]:
            if self._env is None:
                raise codex_vendor.psutil.AccessDenied(pid=1)
            return self._env

    monkeypatch.setattr(
        codex_vendor.psutil, "process_iter",
        lambda: [_Proc(None), _Proc({}), _Proc({"CODEX_HOME": str(live)})],
    )

    reclaimed = manager.sweep_orphans()

    assert reclaimed == [PANE_B]
    assert live.exists()
    assert not idle.exists()


def test_sweep_orphans_without_a_panes_root_is_a_noop(tmp_path: Path) -> None:
    manager, _real, _panes = _manager(tmp_path)
    assert manager.sweep_orphans() == []


# ── handler wiring ──────────────────────────────────────────────────────────


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


class FakeTerminals:
    def __init__(self, *, fail_spawn: bool = False) -> None:
        self.fail_spawn = fail_spawn
        self.killed: list[tuple[str, bool]] = []

    def create(self, **kwargs: Any) -> Any:
        if self.fail_spawn:
            raise RuntimeError("spawn failed")
        raise AssertionError("not expected in this test")

    async def kill(self, session_id: str, force: bool = False) -> None:
        self.killed.append((session_id, force))

    def live_session_ids_for_pane(self, pane_id: str) -> list[str]:
        return []

    def find_live_by_resume_id(self, *args: Any, **kwargs: Any) -> list[Any]:
        return []


class FakeCodexHomeManager:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.real_home = root / "real-codex"
        self.prepared: list[str] = []
        self.reclaimed: list[str] = []

    def prepare(self, home_id: str) -> Path:
        self.prepared.append(home_id)
        return self.root / home_id

    def find_session_home(self, resume_id: str) -> Path | None:
        return None

    def reclaim(self, home_id: str) -> bool:
        self.reclaimed.append(home_id)
        return True


def _session(terminals: FakeTerminals) -> app.Session:
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    session.terminals = terminals  # type: ignore[assignment]
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
        },
    )


@pytest.mark.asyncio
async def test_manual_pane_unspawn_reclaims_the_codex_home(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    fake_home = FakeCodexHomeManager(tmp_path / "codex-panes")
    monkeypatch.setattr(app, "codex_home_manager", fake_home)
    ws = str(tmp_path / "ws")
    Path(ws).mkdir()
    app.project_store.record_manual_pane_spawn(
        ws, pane_id=PANE_B, agent="codex", session_home_id=PANE_A,
    )
    session = _session(FakeTerminals())

    await app.handle_message(session, {
        "id": "m1",
        "type": "manual_pane.unspawn",
        "payload": {"workspace_path": ws, "pane_id": PANE_B},
    })

    # The restored pane id and the home it kept using are both reclaimed;
    # reclaim() itself refuses a home that still owns a session.
    assert sorted(fake_home.reclaimed) == sorted([PANE_B, PANE_A])


@pytest.mark.asyncio
async def test_failed_codex_spawn_reclaims_the_home_it_prepared(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    fake_home = FakeCodexHomeManager(tmp_path / "codex-panes")
    monkeypatch.setattr(app, "codex_home_manager", fake_home)
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    session = _session(FakeTerminals(fail_spawn=True))

    await app.handle_message(session, {
        "id": "m1",
        "type": "terminal.create",
        "payload": {
            "pane_id": PANE_A,
            "agent_key": "codex",
            "command": "codex",
            "cwd": str(tmp_path),
            "metadata": {"workspace_path": str(tmp_path)},
        },
    })

    assert fake_home.prepared == [PANE_A]
    assert fake_home.reclaimed == [PANE_A]
    assert session.websocket.sent[-1]["ok"] is False  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_startup_sweep_reclaims_orphan_codex_homes(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    calls: list[str] = []

    class Sweeper(FakeCodexHomeManager):
        def sweep_orphans(self) -> list[str]:
            calls.append("swept")
            return [PANE_A]

    monkeypatch.setattr(app, "codex_home_manager", Sweeper(tmp_path))

    await app._reclaim_orphan_codex_homes()

    assert calls == ["swept"]


def test_reclaim_drops_the_hook_trust_it_seeded_for_that_home(tmp_path: Path) -> None:
    """Seeded ``hooks.state`` rows are keyed on the pane home's path.

    Left behind after the home is gone they can never match again, so
    ``~/.codex/config.toml`` grew by one set per pane, forever.
    """
    import tomllib

    manager, real, _ = _manager(tmp_path)
    real_key = codex_vendor._toml_escape(str(real / "hooks.json"))
    (real / "hooks.json").write_text('{"hooks": {}}', encoding="utf-8")
    original = (
        'model = "x"\n\n'
        f'[hooks.state."{real_key}:stop:0:0"]\n'
        'trusted_hash = "sha256:aaaa"\n'
    )
    (real / "config.toml").write_text(original, encoding="utf-8")
    keep = manager.prepare(PANE_B)
    assert manager.seed_hook_trust(keep) == 1
    home = manager.prepare(PANE_A)
    assert manager.seed_hook_trust(home) == 1

    assert manager.reclaim(PANE_A) is True

    state = tomllib.loads((real / "config.toml").read_text(encoding="utf-8"))["hooks"]["state"]
    assert sorted(state) == sorted([
        f'{real / "hooks.json"}:stop:0:0',
        f'{keep / "hooks.json"}:stop:0:0',
    ])
    assert manager.reclaim(PANE_B) is True
    assert (real / "config.toml").read_text(encoding="utf-8").rstrip("\n") == original.rstrip("\n")


@pytest.mark.skipif(not hasattr(__import__("os"), "geteuid"), reason="POSIX modes")
def test_dropping_hook_trust_keeps_the_config_files_permissions(tmp_path: Path) -> None:
    """config.toml can carry secrets; rewriting it must not widen its mode."""
    import os
    import stat

    manager, real, _ = _manager(tmp_path)
    real_key = codex_vendor._toml_escape(str(real / "hooks.json"))
    (real / "hooks.json").write_text('{"hooks": {}}', encoding="utf-8")
    config = real / "config.toml"
    config.write_text(f'[hooks.state."{real_key}:stop:0:0"]\ntrusted_hash = "sha256:aaaa"\n', encoding="utf-8")
    config.chmod(0o600)
    home = manager.prepare(PANE_A)
    assert manager.seed_hook_trust(home) == 1

    assert manager.reclaim(PANE_A) is True

    assert stat.S_IMODE(os.stat(config).st_mode) == 0o600

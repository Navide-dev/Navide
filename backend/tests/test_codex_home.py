import json
import os
import stat
from pathlib import Path

import pytest

from agent_team_backend import osplat
from agent_team_backend.codex_home import CodexHomeManager
from agent_team_backend.skills_store import SkillsStore


def test_prepare_symlinks_shared_codex_state(tmp_path: Path) -> None:
    real = tmp_path / "real-codex"
    real.mkdir()
    (real / "auth.json").write_text("{}", encoding="utf-8")
    (real / "config.toml").write_text("model = 'x'\n", encoding="utf-8")
    (real / "skills").mkdir()
    panes = tmp_path / "panes"

    home = CodexHomeManager(real_home=real, panes_root=panes).prepare("pane-1")

    assert home == panes / "pane-1"
    assert (home / "auth.json").is_symlink()
    assert (home / "config.toml").is_symlink()
    assert (home / "skills").is_symlink()
    assert (home / "sessions").exists() is False


def test_cleanup_removes_only_per_pane_home_not_symlink_targets(tmp_path: Path) -> None:
    real = tmp_path / "real-codex"
    real.mkdir()
    auth = real / "auth.json"
    auth.write_text("{}", encoding="utf-8")
    panes = tmp_path / "panes"
    manager = CodexHomeManager(real_home=real, panes_root=panes)
    home = manager.prepare("pane-1")
    (home / "sessions").mkdir()
    (home / "sessions" / "rollout.jsonl").write_text("{}", encoding="utf-8")

    assert manager.cleanup("pane-1") is True

    assert home.exists() is False
    assert auth.exists() is True
    assert auth.read_text(encoding="utf-8") == "{}"


def test_find_session_home_prefers_default_home(tmp_path: Path) -> None:
    real = tmp_path / "real-codex"
    day_dir = real / "sessions" / "2026" / "06" / "08"
    day_dir.mkdir(parents=True)
    (day_dir / "rollout-2026-06-08T16-31-16-legacy-id-1.jsonl").write_text("{}", encoding="utf-8")
    manager = CodexHomeManager(real_home=real, panes_root=tmp_path / "panes")

    assert manager.find_session_home("legacy-id-1") == real
    assert manager.find_session_home("unknown-id") is None


def test_find_session_home_locates_pane_home_sessions(tmp_path: Path) -> None:
    real = tmp_path / "real-codex"
    (real / "sessions").mkdir(parents=True)
    panes = tmp_path / "panes"
    pane_sessions = panes / "old-pane-home" / "sessions" / "2026" / "06" / "10"
    pane_sessions.mkdir(parents=True)
    (pane_sessions / "rollout-2026-06-10T12-00-00-pane-id-9.jsonl").write_text("{}", encoding="utf-8")
    manager = CodexHomeManager(real_home=real, panes_root=panes)

    assert manager.find_session_home("pane-id-9") == panes / "old-pane-home"


def test_find_session_home_refreshes_managed_skills_for_resume(tmp_path: Path) -> None:
    real = tmp_path / "real-codex"
    (real / "skills" / "native").mkdir(parents=True)
    managed = tmp_path / "managed"
    (managed / "enabled").mkdir(parents=True)
    panes = tmp_path / "panes"
    manager = CodexHomeManager(
        real_home=real,
        panes_root=panes,
        managed_skills_root=managed,
    )
    home = manager.prepare("pane-1")
    sessions = home / "sessions"
    sessions.mkdir()
    (sessions / "rollout-resume-id.jsonl").write_text("{}", encoding="utf-8")
    assert (home / "skills" / "enabled").exists()

    (managed / "enabled").rmdir()

    assert manager.find_session_home("resume-id") == home
    assert not (home / "skills" / "enabled").exists()
    assert (home / "skills" / "native").exists()


def test_archived_session_routes_home_but_is_not_resumable(tmp_path: Path) -> None:
    # `codex archive` moves the rollout into archived_sessions/ and codex then
    # REFUSES `codex resume <id>` ("session <id> is archived. Run `codex
    # unarchive <id>` ..."). Routing still needs the owning home; preflight
    # must report the session as gone so the pane can heal onto a fresh id.
    real = tmp_path / "real-codex"
    (real / "sessions").mkdir(parents=True)
    panes = tmp_path / "panes"
    archived = panes / "pane-home" / "archived_sessions"
    archived.mkdir(parents=True)
    (archived / "rollout-2026-06-10T12-00-00-archived-id-1.jsonl").write_text(
        "{}", encoding="utf-8")
    live = panes / "pane-home" / "sessions" / "2026" / "06" / "11"
    live.mkdir(parents=True)
    (live / "rollout-2026-06-11T12-00-00-live-id-1.jsonl").write_text("{}", encoding="utf-8")
    manager = CodexHomeManager(real_home=real, panes_root=panes)

    assert manager.find_session_home("archived-id-1") == panes / "pane-home"
    assert manager.find_resumable_session_home("archived-id-1") is None
    # A live rollout answers both questions the same way.
    assert manager.find_session_home("live-id-1") == panes / "pane-home"
    assert manager.find_resumable_session_home("live-id-1") == panes / "pane-home"


def test_resume_home_refreshes_profile_configs_without_sharing_runtime(tmp_path: Path) -> None:
    real = tmp_path / "real-codex"
    real.mkdir()
    manager = CodexHomeManager(
        real_home=real, panes_root=tmp_path / "panes",
        managed_skills_root=tmp_path / "managed",
    )
    home = manager.prepare("pane-1")
    (home / "sessions").mkdir()
    rollout = home / "sessions" / "rollout-resume-id.jsonl"
    rollout.write_text("{}", encoding="utf-8")
    (home / "local.config.toml").write_text("model = 'local'\n", encoding="utf-8")
    (real / "local.config.toml").write_text("model = 'global'\n", encoding="utf-8")
    (real / "fast.config.toml").write_text("model = 'fast'\n", encoding="utf-8")
    (real / "hooks.json").write_text('{"hooks": {}}', encoding="utf-8")
    (real / "state_5.sqlite").write_text("global-runtime", encoding="utf-8")

    assert manager.find_session_home("resume-id") == home

    assert (home / "fast.config.toml").resolve() == (real / "fast.config.toml").resolve()
    assert (home / "hooks.json").resolve() == (real / "hooks.json").resolve()
    assert (home / "local.config.toml").read_text(encoding="utf-8") == "model = 'local'\n"
    assert not (home / "local.config.toml").is_symlink()
    assert not (home / "sessions").is_symlink()
    assert rollout.read_text(encoding="utf-8") == "{}"
    assert not (home / "state_5.sqlite").exists()


def test_session_exists_preflight_rejects_archived_rollout(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from agent_team_backend.cli_vendors import codex as codex_vendor

    archived = tmp_path / ".codex" / "archived_sessions"
    archived.mkdir(parents=True)
    (archived / "rollout-2026-06-10T12-00-00-archived-id-2.jsonl").write_text(
        "{}", encoding="utf-8")
    monkeypatch.setattr(Path, "home", staticmethod(lambda: tmp_path))

    assert codex_vendor._session_exists("/ws", "archived-id-2") is False
    # ... while routing still knows which home owns it.
    assert codex_vendor.CodexHomeManager().find_session_home(
        "archived-id-2") == tmp_path / ".codex"


def test_find_session_home_rejects_unsafe_or_empty_id(tmp_path: Path) -> None:
    real = tmp_path / "real-codex"
    (real / "sessions").mkdir(parents=True)
    manager = CodexHomeManager(real_home=real, panes_root=tmp_path / "panes")

    assert manager.find_session_home("") is None
    assert manager.find_session_home("*") is None
    assert manager.find_session_home("../escape") is None


def test_cleanup_rejects_unsafe_home_id(tmp_path: Path) -> None:
    manager = CodexHomeManager(real_home=tmp_path / "real", panes_root=tmp_path / "panes")

    try:
        manager.cleanup("../real")
    except ValueError:
        pass
    else:
        raise AssertionError("unsafe home id should be rejected")


def test_prepare_merges_native_and_managed_skills_with_native_precedence(
    tmp_path: Path,
) -> None:
    real = tmp_path / "real-codex"
    native = real / "skills"
    managed = tmp_path / "managed"
    for root, names in (
        (native, ("native", "same")),
        (managed, ("managed", "same", "file-conflict")),
    ):
        for name in names:
            (root / name).mkdir(parents=True)
    (native / "file-conflict").write_text("reserved", encoding="utf-8")
    manager = CodexHomeManager(
        real_home=real,
        panes_root=tmp_path / "panes",
        managed_skills_root=managed,
    )

    home = manager.prepare("pane-1")

    skills = home / "skills"
    assert skills.is_symlink()
    assert sorted(path.name for path in skills.iterdir()) == ["managed", "native", "same"]
    assert (skills / "same").resolve() == (native / "same").resolve()
    assert (skills / "managed").resolve() == (managed / "managed").resolve()


def test_prepare_removes_disabled_managed_skill_on_next_spawn(tmp_path: Path) -> None:
    real = tmp_path / "real-codex"
    (real / "skills" / "native").mkdir(parents=True)
    managed = tmp_path / "managed"
    (managed / "enabled").mkdir(parents=True)
    manager = CodexHomeManager(
        real_home=real,
        panes_root=tmp_path / "panes",
        managed_skills_root=managed,
    )
    home = manager.prepare("pane-1")
    assert (home / "skills" / "enabled").exists()

    (managed / "enabled").rmdir()
    manager.prepare("pane-1")

    assert not (home / "skills" / "enabled").exists()
    assert (home / "skills" / "native").exists()


def test_prepare_refreshes_default_central_projection(tmp_path: Path) -> None:
    real = tmp_path / "real-codex"
    (real / "skills" / "native").mkdir(parents=True)
    store = SkillsStore()
    store.create_skill("managed", "Managed", consent=True)
    manager = CodexHomeManager(real_home=real, panes_root=tmp_path / "panes")

    home = manager.prepare("pane-1")

    assert (home / "skills" / "native").exists()
    assert (home / "skills" / "managed" / "SKILL.md").exists()


def test_prepare_skill_view_failure_does_not_block_spawn(
    tmp_path: Path, monkeypatch
) -> None:
    real = tmp_path / "real-codex"
    (real / "skills" / "native").mkdir(parents=True)
    manager = CodexHomeManager(real_home=real, panes_root=tmp_path / "panes")

    def fail_mkdtemp(*_args, **_kwargs):
        raise OSError("disk unavailable")

    monkeypatch.setattr("agent_team_backend.cli_vendors.codex.tempfile.mkdtemp", fail_mkdtemp)

    home = manager.prepare("pane-1")

    assert home == tmp_path / "panes" / "pane-1"
    assert (home / "skills").is_symlink()
    assert (home / "skills" / "native").exists()


# ── stranded in-pane login promotion ─────────────────────────────────────────

def _write_pane_auth(path: Path, token: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"tokens": {"access_token": token}}), encoding="utf-8"
    )


def test_promote_stranded_auth_adopts_newest_pane_login(tmp_path: Path) -> None:
    real = tmp_path / "real-codex"
    panes = tmp_path / "panes"
    manager = CodexHomeManager(real_home=real, panes_root=panes)
    old = panes / "pane-old" / "auth.json"
    _write_pane_auth(old, "old-token")
    os.utime(old, (1, 1))
    new = panes / "pane-new" / "auth.json"
    _write_pane_auth(new, "new-token")

    assert manager.promote_stranded_auth() is True

    real_auth = real / "auth.json"
    assert real_auth.is_file() and not real_auth.is_symlink()
    assert "new-token" in real_auth.read_text(encoding="utf-8")
    # The promoted pane now writes through to the shared credential.
    assert new.is_symlink()
    assert new.resolve() == real_auth
    # Other stranded logins are left untouched (they may be other accounts).
    assert old.is_file() and not old.is_symlink()
    # Idempotent once the real credential exists.
    assert manager.promote_stranded_auth() is False


def test_promote_stranded_auth_never_overwrites_real_auth(tmp_path: Path) -> None:
    real = tmp_path / "real-codex"
    real.mkdir()
    (real / "auth.json").write_text('{"keep": true}', encoding="utf-8")
    panes = tmp_path / "panes"
    manager = CodexHomeManager(real_home=real, panes_root=panes)
    stranded = panes / "pane-1" / "auth.json"
    _write_pane_auth(stranded, "pane-token")

    assert manager.promote_stranded_auth() is False

    assert (real / "auth.json").read_text(encoding="utf-8") == '{"keep": true}'
    assert stranded.is_file() and not stranded.is_symlink()


def test_promote_stranded_auth_noop_without_candidates(tmp_path: Path) -> None:
    manager = CodexHomeManager(
        real_home=tmp_path / "real", panes_root=tmp_path / "panes"
    )
    # Neither the panes root nor any stranded login exists (fresh install
    # before any codex pane spawned).
    assert manager.promote_stranded_auth() is False
    assert (tmp_path / "real" / "auth.json").exists() is False


def test_prepare_adopts_stranded_login_for_new_pane(tmp_path: Path) -> None:
    real = tmp_path / "real-codex"
    panes = tmp_path / "panes"
    manager = CodexHomeManager(real_home=real, panes_root=panes)
    stranded = panes / "pane-1" / "auth.json"
    _write_pane_auth(stranded, "pane1-token")

    home = manager.prepare("pane-2")

    # pane-1's in-pane login became the shared credential and pane-2
    # spawns already logged in.
    assert (real / "auth.json").is_file()
    assert (home / "auth.json").is_symlink()
    assert stranded.is_symlink()


def _signed_out_outside_navide(tmp_path: Path) -> tuple[CodexHomeManager, Path, Path]:
    """Two in-pane logins, the newer one promoted, then `codex logout`
    outside Navide removes the shared credential. Pane A still holds its own
    older login as a real file."""
    real = tmp_path / "real-codex"
    manager = CodexHomeManager(real_home=real, panes_root=tmp_path / "panes")
    home_a, home_b = manager.prepare("pane-a"), manager.prepare("pane-b")
    _write_pane_auth(home_a / "auth.json", "old-account")
    os.utime(home_a / "auth.json", (1, 1))
    _write_pane_auth(home_b / "auth.json", "new-account")
    assert manager.promote_stranded_auth() is True
    (real / "auth.json").unlink()
    return manager, real, home_a


def test_resuming_after_an_outside_logout_keeps_the_panes_own_login(tmp_path: Path) -> None:
    # User decision (2026-10-11): after a sign-out outside Navide, the login
    # copies Navide holds behave as on main. A resume reuses the pane home
    # as it is: its own login copy stays, and nothing signs the shared one
    # back in.
    manager, real, home_a = _signed_out_outside_navide(tmp_path)
    sid = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee"
    day = home_a / "sessions" / "2026" / "10" / "10"
    day.mkdir(parents=True)
    (day / f"rollout-2026-10-10T00-00-00-{sid}.jsonl").write_text("{}\n", encoding="utf-8")

    home = manager.find_session_home(sid)

    assert home == home_a
    assert "old-account" in (home / "auth.json").read_text(encoding="utf-8")
    assert not (real / "auth.json").exists()


def test_respawning_the_same_home_after_an_outside_logout_keeps_the_panes_own_login(tmp_path: Path) -> None:
    manager, real, home_a = _signed_out_outside_navide(tmp_path)

    home = manager.prepare("pane-a")

    assert "old-account" in (home / "auth.json").read_text(encoding="utf-8")
    assert not (real / "auth.json").exists()


# ── sub-agent pin repair ────────────────────────────────────────────────────

def _meta(sid: str, *, parent: str = "", ancestors: tuple[str, ...] = ()) -> str:
    """A rollout head: this thread's session_meta, then the ancestor records a
    forked thread replays after its own (codex 0.149 shape)."""
    if parent:
        head = {
            "type": "session_meta",
            "payload": {
                "id": sid, "session_id": parent, "parent_thread_id": parent,
                "forked_from_id": parent, "thread_source": "subagent", "cwd": "/ws",
                "source": {"subagent": {"thread_spawn": {
                    "parent_thread_id": parent, "depth": 1,
                    "agent_path": "/root/explore",
                }}},
            },
        }
    else:
        head = {"type": "session_meta", "payload": {
            "id": sid, "thread_source": "user", "source": "cli", "cwd": "/ws"}}
    lines = [json.dumps(head)]
    for anc in ancestors:
        lines.append(json.dumps({"type": "session_meta", "payload": {
            "id": anc, "thread_source": "user", "source": "cli", "cwd": "/ws"}}))
    return "\n".join(lines) + "\n"


def _rollout(day_dir: Path, sid: str, body: str) -> None:
    day_dir.mkdir(parents=True, exist_ok=True)
    (day_dir / f"rollout-2026-08-24T15-00-00-{sid}.jsonl").write_text(body, encoding="utf-8")


def test_resolve_user_thread_id_repairs_pin_from_replayed_ancestor(tmp_path: Path) -> None:
    """The common shape: the sub-agent's own rollout replays the user thread's
    session_meta, so the repair needs no second file."""
    real = tmp_path / "real-codex"
    day = tmp_path / "panes" / "pane-A" / "sessions" / "2026" / "08" / "24"
    _rollout(day, "parent-id", _meta("parent-id"))
    _rollout(day, "child-id", _meta("child-id", parent="parent-id", ancestors=("parent-id",)))
    manager = CodexHomeManager(real_home=real, panes_root=tmp_path / "panes")

    assert manager.resolve_user_thread_id("child-id") == "parent-id"


def test_resolve_user_thread_id_walks_parent_chain_when_ancestor_absent(
    tmp_path: Path,
) -> None:
    """Deeper nesting truncates the replayed ancestors out of the read budget;
    the repair then hops parent_thread_id until it reaches the user thread."""
    real = tmp_path / "real-codex"
    day = tmp_path / "panes" / "pane-A" / "sessions" / "2026" / "08" / "24"
    _rollout(day, "root-id", _meta("root-id"))
    _rollout(day, "mid-id", _meta("mid-id", parent="root-id"))
    _rollout(day, "leaf-id", _meta("leaf-id", parent="mid-id"))
    manager = CodexHomeManager(real_home=real, panes_root=tmp_path / "panes")

    assert manager.resolve_user_thread_id("leaf-id") == "root-id"


def test_resolve_user_thread_id_leaves_ordinary_and_unknown_ids_alone(
    tmp_path: Path,
) -> None:
    """A user thread, an id no rollout records, and unusable input all resume
    exactly what the caller was given."""
    real = tmp_path / "real-codex"
    day = tmp_path / "panes" / "pane-A" / "sessions" / "2026" / "08" / "24"
    _rollout(day, "plain-id", _meta("plain-id"))
    manager = CodexHomeManager(real_home=real, panes_root=tmp_path / "panes")

    assert manager.resolve_user_thread_id("plain-id") == "plain-id"
    assert manager.resolve_user_thread_id("never-recorded") == "never-recorded"
    assert manager.resolve_user_thread_id("") == ""
    assert manager.resolve_user_thread_id("../../etc/passwd") == "../../etc/passwd"


def test_resolve_user_thread_id_survives_a_cyclic_parent_chain(tmp_path: Path) -> None:
    """A corrupted chain that points at itself must terminate, not spin."""
    real = tmp_path / "real-codex"
    day = tmp_path / "panes" / "pane-A" / "sessions" / "2026" / "08" / "24"
    _rollout(day, "a-id", _meta("a-id", parent="b-id"))
    _rollout(day, "b-id", _meta("b-id", parent="a-id"))
    manager = CodexHomeManager(real_home=real, panes_root=tmp_path / "panes")

    assert manager.resolve_user_thread_id("a-id") == "a-id"


def test_command_with_resume_id_rewrites_inside_the_shell_wrapper() -> None:
    from agent_team_backend.cli_vendors.codex import command_with_resume_id

    assert command_with_resume_id(
        ["/bin/zsh", "-ilc", "codex resume child-id"], "child-id", "parent-id"
    ) == ["/bin/zsh", "-ilc", "codex resume parent-id"]
    assert command_with_resume_id(
        "codex resume child-id", "child-id", "parent-id"
    ) == "codex resume parent-id"
    # Nothing to swap, and degenerate shapes, pass through untouched.
    assert command_with_resume_id("codex", "child-id", "parent-id") == "codex"
    assert command_with_resume_id([], "child-id", "parent-id") == []


def test_resolve_user_thread_id_uses_nested_source_parent_without_optional_fields(tmp_path: Path) -> None:
    real = tmp_path / 'real'
    root = real / 'sessions'
    _rollout(root, 'parent-id', _meta('parent-id'))
    child = json.dumps({'type':'session_meta','payload':{
        'id':'child-id','cwd':'/ws','source':{'subagent':{'thread_spawn':{'parent_thread_id':'parent-id'}}}
    }}) + '\n'
    _rollout(root, 'child-id', child)
    manager = CodexHomeManager(real_home=real, panes_root=tmp_path/'panes')
    assert manager.resolve_user_thread_id('child-id') == 'parent-id'


def _hook_trust_fixture(tmp_path: Path) -> tuple[CodexHomeManager, Path, Path]:
    from agent_team_backend.cli_vendors.codex import _toml_escape

    real = tmp_path / "real-codex"
    real.mkdir()
    (real / "hooks.json").write_text('{"hooks": {"Stop": [{"hooks": [{"type": "command", "command": "true"}]}]}}', encoding="utf-8")
    # The key Codex itself writes is the hooks file's own path, so it carries
    # the platform's separator and needs TOML escaping — a hand-joined "/"
    # matches nothing on Windows, and a bare backslash is not a legal escape
    # inside a TOML basic string.
    real_key = _toml_escape(str(real / "hooks.json"))
    (real / "config.toml").write_text(
        'model = "x"\n\n[hooks.state]\n\n'
        f'[hooks.state."{real_key}:stop:0:0"]\n'
        'trusted_hash = "sha256:aaaa"\n\n'
        f'[hooks.state."{real_key}:session_start:0:0"]\n'
        'trusted_hash = "sha256:bbbb"\n\n'
        '[hooks.state."codex@openai-codex:hooks/hooks.json:stop:0:0"]\n'
        'trusted_hash = "sha256:cccc"\n',
        encoding="utf-8",
    )
    manager = CodexHomeManager(real_home=real, panes_root=tmp_path / "panes")
    pane = manager.prepare("pane-1")
    assert (pane / "hooks.json").resolve() == (real / "hooks.json").resolve()
    return manager, real, pane


def test_seed_hook_trust_copies_real_home_entries_under_pane_path(tmp_path: Path) -> None:
    import tomllib

    manager, real, pane = _hook_trust_fixture(tmp_path)

    assert manager.seed_hook_trust(pane) == 2

    state = tomllib.loads((real / "config.toml").read_text(encoding="utf-8"))["hooks"]["state"]
    pane_key = str(pane / "hooks.json")
    assert state[f"{pane_key}:stop:0:0"] == {"trusted_hash": "sha256:aaaa"}
    assert state[f"{pane_key}:session_start:0:0"] == {"trusted_hash": "sha256:bbbb"}
    # Plugin-keyed entries are not path-bound and are left alone.
    assert f"{pane_key}:hooks/hooks.json:stop:0:0" not in state
    assert len(state) == 5
    # Idempotent: a second spawn of the same home appends nothing.
    assert manager.seed_hook_trust(pane) == 0
    tomllib.loads((real / "config.toml").read_text(encoding="utf-8"))


def test_seed_hook_trust_skips_missing_or_diverged_pane_hooks(tmp_path: Path) -> None:
    manager, real, pane = _hook_trust_fixture(tmp_path)
    before = (real / "config.toml").read_text(encoding="utf-8")

    other = manager.prepare("pane-2")
    (other / "hooks.json").unlink()
    assert manager.seed_hook_trust(other) == 0  # no hooks.json in that home

    (pane / "hooks.json").unlink()
    (pane / "hooks.json").write_text('{"hooks": {}}', encoding="utf-8")
    assert manager.seed_hook_trust(pane) == 0  # different content ⇒ different hash

    assert (real / "config.toml").read_text(encoding="utf-8") == before


def test_seed_hook_trust_escapes_backslashes_in_toml_keys(tmp_path: Path) -> None:
    import tomllib

    from agent_team_backend.cli_vendors.codex import _toml_escape, _toml_unescape

    key = 'C:\\Users\\x\\.codex\\hooks.json:stop:0:0'
    assert _toml_unescape(_toml_escape(key)) == key
    manager, real, pane = _hook_trust_fixture(tmp_path)
    (real / "config.toml").write_text(
        f'[hooks.state."{_toml_escape(str(real / "hooks.json"))}:stop:0:0"]\n'
        'trusted_hash = "sha256:aaaa"\n',
        encoding="utf-8",
    )
    assert manager.seed_hook_trust(pane) == 1
    state = tomllib.loads((real / "config.toml").read_text(encoding="utf-8"))["hooks"]["state"]
    assert state[f'{pane / "hooks.json"}:stop:0:0'] == {"trusted_hash": "sha256:aaaa"}


@pytest.mark.skipif(not osplat.paths.enforces_posix_modes(), reason="Android fallback: POSIX modes and os.fchmod")
def test_promote_stranded_auth_copies_without_hard_links(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Android's CPython has no os.link; promotion must still adopt the login.
    from agent_team_backend.cli_vendors import codex as codex_vendor

    monkeypatch.delattr(codex_vendor.os, "link")
    real = tmp_path / "real-codex"
    panes = tmp_path / "panes"
    manager = CodexHomeManager(real_home=real, panes_root=panes)
    stranded = panes / "pane-1" / "auth.json"
    _write_pane_auth(stranded, "pane-token")
    stranded.chmod(0o600)

    assert manager.promote_stranded_auth() is True

    real_auth = real / "auth.json"
    assert real_auth.is_file() and not real_auth.is_symlink()
    assert "pane-token" in real_auth.read_text(encoding="utf-8")
    assert os.stat(real_auth).st_mode & 0o777 == 0o600
    assert stranded.is_symlink() and stranded.resolve() == real_auth
    assert manager.promote_stranded_auth() is False



def _trust_headers(path: Path) -> list[str]:
    """The same table header in the shapes TOML allows: a trailing comment,
    spacing inside the brackets, a literal (single-quoted) key."""
    key = str(path)
    return [
        f'[hooks.state."{key.replace(chr(92), chr(92) * 2)}:stop:0:0"]  # trusted in codex',
        f'[ hooks.state."{key.replace(chr(92), chr(92) * 2)}:stop:0:0" ]',
        f"[hooks.state.'{key}:stop:0:0']",
    ]


@pytest.mark.parametrize("shape", range(3))
def test_seed_hook_trust_reads_any_toml_shape_of_the_real_row(tmp_path: Path, shape: int) -> None:
    import tomllib

    manager, real, pane = _hook_trust_fixture(tmp_path)
    (real / "config.toml").write_text(
        f'{_trust_headers(real / "hooks.json")[shape]}\ntrusted_hash = "sha256:aaaa"\n', encoding="utf-8"
    )

    assert manager.seed_hook_trust(pane) == 1

    state = tomllib.loads((real / "config.toml").read_text(encoding="utf-8"))["hooks"]["state"]
    assert state[f'{pane / "hooks.json"}:stop:0:0'] == {"trusted_hash": "sha256:aaaa"}


@pytest.mark.parametrize("shape", range(3))
def test_a_reformatted_seeded_row_is_neither_missing_nor_seeded_twice(tmp_path: Path, shape: int) -> None:
    import tomllib

    manager, real, pane = _hook_trust_fixture(tmp_path)
    assert manager.seed_hook_trust(pane) == 2
    # The seeded stop row is rewritten into another legal TOML shape.
    text = (real / "config.toml").read_text(encoding="utf-8")
    seeded = f'[hooks.state."{_toml_escape_for_test(pane / "hooks.json")}:stop:0:0"]'
    assert seeded in text
    (real / "config.toml").write_text(text.replace(seeded, _trust_headers(pane / "hooks.json")[shape]), encoding="utf-8")

    assert manager.hook_trust_intact() is True
    assert manager.seed_hook_trust(pane) == 0
    tomllib.loads((real / "config.toml").read_text(encoding="utf-8"))
    manager.drop_all_hook_trust()
    assert manager.any_pane_hook_trust() is False


def _toml_escape_for_test(path: Path) -> str:
    from agent_team_backend.cli_vendors.codex import _toml_escape

    return _toml_escape(str(path))


def test_prepare_keeps_a_correct_skills_link_when_readlink_reports_an_extended_path(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Windows' os.readlink returns the target with a \\\\?\\ prefix. Compared
    as a raw string, the already-correct skills link read as wrong and was
    unlinked and recreated on every prepare."""
    real = tmp_path / "real-codex"
    (real / "skills" / "native").mkdir(parents=True)
    manager = CodexHomeManager(real_home=real, panes_root=tmp_path / "panes")
    home = manager.prepare("pane-1")
    assert (home / "skills").is_symlink()

    real_readlink = os.readlink

    def extended_readlink(path):
        # Windows' real readlink already carries the prefix: add it only when absent.
        raw = real_readlink(path)
        return raw if raw.startswith("\\\\?\\") else "\\\\?\\" + raw

    monkeypatch.setattr(os, "readlink", extended_readlink)
    recreated: list[str] = []
    real_symlink_to = Path.symlink_to

    def spy(self, target, target_is_directory=False):
        if self.name == "skills":
            recreated.append(self.name)
        return real_symlink_to(self, target, target_is_directory)

    monkeypatch.setattr(Path, "symlink_to", spy)
    manager.prepare("pane-1")
    assert recreated == []
    assert (home / "skills" / "native").exists()


@pytest.mark.skipif(not osplat.paths.enforces_posix_modes(), reason="POSIX symlinks and modes")
def test_a_temp_file_that_cannot_be_removed_never_changes_the_file_it_links_to(tmp_path: Path) -> None:
    """A config.toml.navide-tmp that is a link to some other file, in a folder
    that refuses the removal: nothing is done to the file it points at."""
    from agent_team_backend.cli_vendors.codex import _discard_temp

    elsewhere = tmp_path / "elsewhere"
    elsewhere.write_text("not Navide's", encoding="utf-8")
    elsewhere.chmod(0o644)
    folder = tmp_path / "dotcodex"
    folder.mkdir()
    tmp = folder / "config.toml.navide-tmp"
    tmp.symlink_to(elsewhere)
    folder.chmod(0o555)
    try:
        with pytest.raises(PermissionError):
            _discard_temp(tmp)
    finally:
        folder.chmod(0o755)

    assert stat.S_IMODE(elsewhere.stat().st_mode) == 0o644

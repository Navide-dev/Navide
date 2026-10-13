"""Legacy claude profile-home migration: session merge, credential harvest,
archival, idempotency. All roots are tmp-injected — never the real home."""

from __future__ import annotations

import shlex
from pathlib import Path

from agent_team_backend.credential_vault import (
    CredentialVault,
    legacy_claude_keychain_service,
)
from agent_team_backend.profile_migration import migrate_legacy_claude_homes
from agent_team_backend.profiles_store import CliProfilesStore
from tests.keychain_fake import security_g_output


class FakeSecurity:
    """In-memory generic-password store mimicking the `security` CLI."""

    def __init__(self) -> None:
        self.items: dict[str, str] = {}

    def __call__(self, args: list[str], input_text: str | None = None) -> tuple[int, str]:
        # `-i` interactive mode: the whole command arrives on stdin.
        tokens = shlex.split((input_text or "").strip()) if args == ["-i"] else list(args)
        service = tokens[tokens.index("-s") + 1]
        cmd = tokens[0]
        if cmd == "find-generic-password":
            if service in self.items:
                return 0, security_g_output(self.items[service])
            return 44, ""
        if cmd == "add-generic-password":
            self.items[service] = tokens[tokens.index("-w") + 1]
            return 0, ""
        if cmd == "delete-generic-password":
            return (0, "") if self.items.pop(service, None) is not None else (44, "")
        return 1, ""


def _setup(tmp_path: Path) -> tuple[CliProfilesStore, CredentialVault, FakeSecurity, Path]:
    store = CliProfilesStore(
        path=tmp_path / "cli-profiles.json",
        profiles_root=tmp_path / "cli-profiles",
    )
    sec = FakeSecurity()
    vault = CredentialVault(
        root=tmp_path / "cli-profiles",
        real_home=tmp_path / "home",
        security_runner=sec,
        platform="darwin",
    )
    real_home = tmp_path / "home"
    real_home.mkdir()
    return store, vault, sec, real_home


def _legacy_home(root: Path, profile_id: str, sessions: dict[str, dict[str, str]]) -> Path:
    """Create a legacy full config home: projects/<encoded>/<file> -> content."""
    home = root / "claude" / profile_id
    for encoded, files in sessions.items():
        d = home / "projects" / encoded
        d.mkdir(parents=True, exist_ok=True)
        for name, content in files.items():
            (d / name).write_text(content, encoding="utf-8")
    return home


def test_migrates_sessions_into_real_home(tmp_path: Path) -> None:
    store, vault, _sec, real_home = _setup(tmp_path)
    _legacy_home(store.profiles_root, "37a6f4f2", {
        "-Users-me-proj": {"s1.jsonl": "one", "s2.jsonl": "two"},
        "-Users-me-other": {"s3.jsonl": "three"},
    })

    assert migrate_legacy_claude_homes(store, vault, real_home=real_home) == 1

    projects = real_home / ".claude" / "projects"
    assert (projects / "-Users-me-proj" / "s1.jsonl").read_text(encoding="utf-8") == "one"
    assert (projects / "-Users-me-proj" / "s2.jsonl").read_text(encoding="utf-8") == "two"
    assert (projects / "-Users-me-other" / "s3.jsonl").read_text(encoding="utf-8") == "three"


def test_collision_keeps_larger_file(tmp_path: Path) -> None:
    store, vault, _sec, real_home = _setup(tmp_path)
    projects = real_home / ".claude" / "projects" / "-Users-me-proj"
    projects.mkdir(parents=True)
    (projects / "big.jsonl").write_text("real home is much longer", encoding="utf-8")
    (projects / "small.jsonl").write_text("x", encoding="utf-8")
    _legacy_home(store.profiles_root, "37a6f4f2", {
        "-Users-me-proj": {
            "big.jsonl": "short",
            "small.jsonl": "legacy is the bigger one",
        },
    })

    migrate_legacy_claude_homes(store, vault, real_home=real_home)

    assert (projects / "big.jsonl").read_text(encoding="utf-8") == "real home is much longer"
    assert (projects / "small.jsonl").read_text(encoding="utf-8") == "legacy is the bigger one"


def test_archives_home_and_is_idempotent(tmp_path: Path) -> None:
    store, vault, _sec, real_home = _setup(tmp_path)
    home = _legacy_home(store.profiles_root, "37a6f4f2", {
        "-Users-me-proj": {"s1.jsonl": "one"},
    })

    assert migrate_legacy_claude_homes(store, vault, real_home=real_home) == 1

    assert not home.exists()
    archived = [
        p for p in home.parent.iterdir()
        if p.name.startswith("37a6f4f2.migrated-")
    ]
    assert len(archived) == 1
    # Originals survive inside the archive (merge copies, never moves).
    assert (archived[0] / "projects" / "-Users-me-proj" / "s1.jsonl").exists()

    # Second run: the projects/ marker is gone with the archive — a no-op.
    assert migrate_legacy_claude_homes(store, vault, real_home=real_home) == 0


def test_harvests_legacy_keychain_credentials_into_slot(tmp_path: Path) -> None:
    store, vault, sec, real_home = _setup(tmp_path)
    home = _legacy_home(store.profiles_root, "37a6f4f2", {
        "-Users-me-proj": {"s1.jsonl": "one"},
    })
    sec.items[legacy_claude_keychain_service(home)] = "LEGACY-SECRET"

    migrate_legacy_claude_homes(store, vault, real_home=real_home)

    assert vault.read_slot("claude", "37a6f4f2").secret == "LEGACY-SECRET"


def test_skips_slot_only_and_archived_dirs(tmp_path: Path) -> None:
    store, vault, _sec, real_home = _setup(tmp_path)
    # A vault-era slot dir (no projects/) must be left alone.
    slot_dir = store.profiles_root / "claude" / "abcd1234"
    slot_dir.mkdir(parents=True)
    (slot_dir / "oauth-account.json").write_text("{}", encoding="utf-8")
    # An already-archived legacy home must not be re-migrated.
    archived = store.profiles_root / "claude" / "9999aaaa.migrated-1"
    (archived / "projects").mkdir(parents=True)

    assert migrate_legacy_claude_homes(store, vault, real_home=real_home) == 0
    assert slot_dir.exists()
    assert archived.exists()


def test_missing_root_is_noop(tmp_path: Path) -> None:
    store, vault, _sec, real_home = _setup(tmp_path)
    assert migrate_legacy_claude_homes(store, vault, real_home=real_home) == 0


def test_a_replaced_real_session_is_kept_in_the_archive(tmp_path: Path) -> None:
    """Keeping the larger record must not destroy the smaller real one.

    The two copies may have diverged, so the real file that gets replaced is
    kept beside the archived legacy home, inside Navide's own data.
    """
    store, vault, _sec, real_home = _setup(tmp_path)
    projects = real_home / ".claude" / "projects" / "-Users-me-proj"
    projects.mkdir(parents=True)
    (projects / "s.jsonl").write_text("real", encoding="utf-8")
    _legacy_home(store.profiles_root, "37a6f4f2", {"-Users-me-proj": {"s.jsonl": "legacy is longer"}})

    migrate_legacy_claude_homes(store, vault, real_home=real_home)

    assert (projects / "s.jsonl").read_text(encoding="utf-8") == "legacy is longer"
    kept = list((store.profiles_root / "claude").glob("37a6f4f2.migrated-*/replaced-projects/-Users-me-proj/s.jsonl"))
    assert [p.read_text(encoding="utf-8") for p in kept] == ["real"]

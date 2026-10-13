from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from agent_team_backend import osplat, skills_store
from agent_team_backend.skills_store import (
    SKILL_FILE_SIZE_LIMIT,
    SkillConflictError,
    SkillConsentRequired,
    SkillNotFoundError,
    SkillValidationError,
    SkillsStore,
    SkillsStoreError,
)


def _store(tmp_path: Path, *, consented: bool = True) -> SkillsStore:
    store = SkillsStore(
        root=tmp_path / "skills",
        state_path=tmp_path / "skills.json",
        runtime_root=tmp_path / "runtime" / "skills",
        native_roots=[],
    )
    if consented:
        # The shared root is the user's directory; the first write needs their
        # say-so. Most tests are about what happens after it was given.
        store.create_skill("consent-probe", "", consent=True)
        store.delete_skill("consent-probe")
    return store


@pytest.fixture
def store(tmp_path: Path) -> SkillsStore:
    return _store(tmp_path)


@pytest.fixture
def fresh_store(tmp_path: Path) -> SkillsStore:
    """No consent given yet."""
    return _store(tmp_path, consented=False)


def test_create_list_and_get_skill(store: SkillsStore) -> None:
    created = store.create_skill("review-code", "Review a change")

    assert created["skill"]["fields"] == {
        "name": "review-code",
        "description": "Review a change",
    }
    assert created["skill"]["enabled"] is True
    assert created["skill"]["native_conflict"] is False
    assert store.runtime_root.joinpath("review-code").is_symlink()
    listed = store.list_skills()
    assert listed["skills"] == [
        {
            "name": "review-code",
            "description": "Review a change",
            "enabled": True,
            "native_conflict": False,
            "targets": None,
            "managed": True,
            "migrated_from": None,
            "revision": created["skill"]["revision"],
            "valid": True,
            "path": str(store.root / "review-code"),
            "attachments": [],
        }
    ]
    assert listed["root"] == str(store.root)
    # The marker is what makes it ours; it must never surface as an attachment.
    assert (store.root / "review-code" / ".navide").is_file()
    assert {entry["key"] for entry in listed["agents"]} >= {"claude", "kimi", "pi", "opencode"}


def test_save_preserves_unknown_nested_frontmatter_and_body(store: SkillsStore) -> None:
    created = store.create_skill("review-code", "Before")
    skill_file = store.root / "review-code" / "SKILL.md"
    skill_file.write_text(
        "---\n"
        "name: review-code\n"
        "description: Before\n"
        "metadata:\n"
        "  openclaw:\n"
        "    emoji: 🧭\n"
        "allowed-tools:\n"
        "- Read\n"
        "---\n"
        "# Existing body\n\nKeep this.\n",
        encoding="utf-8",
        newline="\n",
    )
    current = store.get_skill("review-code")["skill"]

    saved = store.save_skill(
        "review-code",
        {"description": "After", "user-invocable": True},
        current["body"],
        current["revision"],
    )["skill"]

    assert saved["description"] == "After"
    assert saved["fields"]["metadata"] == {"openclaw": {"emoji": "🧭"}}
    assert saved["fields"]["allowed-tools"] == ["Read"]
    assert saved["fields"]["user-invocable"] is True
    assert saved["body"] == "# Existing body\n\nKeep this.\n"
    assert saved["revision"] != created["skill"]["revision"]


def test_stale_save_does_not_modify_file(store: SkillsStore) -> None:
    skill = store.create_skill("review-code", "Before")["skill"]
    skill_file = store.root / "review-code" / "SKILL.md"
    skill_file.write_text(skill_file.read_text(encoding="utf-8") + "external", encoding="utf-8")
    before = skill_file.read_bytes()

    with pytest.raises(SkillConflictError):
        store.save_skill("review-code", {"description": "After"}, "body", skill["revision"])

    assert skill_file.read_bytes() == before


@pytest.mark.parametrize("name", ["../escape", "UPPER", ".hidden", "two words", "a" * 65])
def test_create_rejects_invalid_names(store: SkillsStore, name: str) -> None:
    before = sorted(store.root.iterdir()) if store.root.exists() else []

    with pytest.raises(SkillValidationError):
        store.create_skill(name, "Description")

    after = sorted(store.root.iterdir()) if store.root.exists() else []
    assert after == before  # a rejected name leaves no trace


def test_a_users_symlink_out_of_the_root_is_read_only(store: SkillsStore, tmp_path: Path) -> None:
    """A link the user made may point anywhere; Navide reads it, never writes."""
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "SKILL.md").write_text("---\nname: escape\n---\n", encoding="utf-8")
    store.root.mkdir(exist_ok=True)
    (store.root / "escape").symlink_to(outside, target_is_directory=True)

    skill = store.get_skill("escape")["skill"]
    assert skill["valid"] is True
    assert skill["managed"] is False

    # Every write path refuses: nothing can reach `outside` through the link.
    with pytest.raises(SkillValidationError, match="not created by Navide"):
        store.save_skill("escape", {"description": "x"}, "y", skill["revision"])
    with pytest.raises(SkillValidationError, match="not created by Navide"):
        store.delete_skill("escape")
    assert (outside / "SKILL.md").read_text(encoding="utf-8") == "---\nname: escape\n---\n"


def test_symlink_root_is_rejected_by_every_public_store_operation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    outside = tmp_path / "outside"
    skill_dir = outside / "existing"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\nname: existing\ndescription: Outside\n---\nbody",
        encoding="utf-8",
    )
    root_link = tmp_path / "skills-link"
    root_link.symlink_to(outside, target_is_directory=True)
    store = SkillsStore(
        root=root_link,
        state_path=tmp_path / "skills.json",
        runtime_root=tmp_path / "runtime" / "skills",
        native_roots=[],
    )
    trashed: list[str] = []
    monkeypatch.setattr(skills_store, "send2trash", trashed.append)

    operations = [
        store.list_skills,
        lambda: store.get_skill("existing"),
        lambda: store.create_skill("new-skill", "New"),
        lambda: store.save_skill("existing", {}, "body", "revision"),
        lambda: store.set_enabled("existing", False),
        lambda: store.delete_skill("existing"),
        store.rebuild_runtime_projection,
    ]
    for operation in operations:
        with pytest.raises(SkillValidationError, match="root"):
            operation()

    assert trashed == []
    assert not (outside / "new-skill").exists()
    assert (skill_dir / "SKILL.md").exists()


def test_symlink_attachment_is_rejected(store: SkillsStore, tmp_path: Path) -> None:
    store.create_skill("review-code", "Review")
    outside = tmp_path / "secret.txt"
    outside.write_text("secret", encoding="utf-8")
    (store.root / "review-code" / "secret.txt").symlink_to(outside)

    with pytest.raises(SkillValidationError):
        store.get_skill("review-code")


def test_malformed_yaml_fails_without_mutation(store: SkillsStore) -> None:
    store.create_skill("review-code", "Review")
    skill_file = store.root / "review-code" / "SKILL.md"
    skill_file.write_text("---\nname: [unterminated\n---\nbody\n", encoding="utf-8")
    before = skill_file.read_bytes()

    with pytest.raises(SkillValidationError):
        store.get_skill("review-code")

    assert skill_file.read_bytes() == before


def test_oversized_skill_fails_without_mutation(store: SkillsStore) -> None:
    store.create_skill("review-code", "Review")
    skill_file = store.root / "review-code" / "SKILL.md"
    skill_file.write_bytes(b"x" * (SKILL_FILE_SIZE_LIMIT + 1))
    before = skill_file.read_bytes()

    with pytest.raises(SkillValidationError, match="size limit"):
        store.get_skill("review-code")

    assert skill_file.read_bytes() == before


def test_oversized_save_fails_without_mutation(store: SkillsStore) -> None:
    skill = store.create_skill("review-code", "Review")["skill"]
    skill_file = store.root / "review-code" / "SKILL.md"
    before = skill_file.read_bytes()

    with pytest.raises(SkillValidationError, match="size limit"):
        store.save_skill(
            "review-code",
            {},
            "x" * (SKILL_FILE_SIZE_LIMIT + 1),
            skill["revision"],
        )

    assert skill_file.read_bytes() == before


def test_enable_state_controls_runtime_projection(store: SkillsStore) -> None:
    store.create_skill("first", "First")
    store.create_skill("second", "Second")

    disabled = store.set_enabled("first", False)["skill"]

    assert disabled["enabled"] is False
    assert not (store.runtime_root / "first").exists()
    assert (store.runtime_root / "second").is_symlink()
    assert (store.root / "first" / "SKILL.md").exists()
    assert json.loads(store.state_path.read_text(encoding="utf-8")) == {
        "enabled": {"first": False, "second": True},
        "write_consented": True,
    }


def test_rebuild_projection_is_idempotent_and_skips_invalid_skills(store: SkillsStore) -> None:
    store.create_skill("valid", "Valid")
    invalid_dir = store.root / "invalid"
    invalid_dir.mkdir()
    (invalid_dir / "SKILL.md").write_text("not frontmatter", encoding="utf-8")

    first = store.rebuild_runtime_projection()
    second = store.rebuild_runtime_projection()

    assert first == second == store.runtime_root
    assert sorted(path.name for path in store.runtime_root.iterdir()) == ["valid"]


def test_delete_moves_directory_to_trash_and_removes_state(
    store: SkillsStore, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    store.create_skill("review-code", "Review")
    trashed: list[str] = []
    trash = tmp_path / "Trash"
    trash.mkdir()

    def fake_send2trash(path: str) -> None:
        trashed.append(path)
        Path(path).rename(trash / Path(path).name)

    monkeypatch.setattr(skills_store, "send2trash", fake_send2trash)

    assert store.delete_skill("review-code") == {"name": "review-code", "deleted": True}
    assert trashed == [str(store.root / "review-code")]
    assert store.list_skills()["skills"] == []
    assert json.loads(store.state_path.read_text(encoding="utf-8")) == {
        "enabled": {},
        "write_consented": True,
    }
    assert list(store.runtime_root.iterdir()) == []


def test_delete_trash_failure_keeps_skill_and_state(
    store: SkillsStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    store.create_skill("review-code", "Review")

    def fail_send2trash(_path: str) -> None:
        raise OSError("trash unavailable")

    monkeypatch.setattr(skills_store, "send2trash", fail_send2trash)

    with pytest.raises(SkillsStoreError, match="could not move"):
        store.delete_skill("review-code")

    assert (store.root / "review-code" / "SKILL.md").exists()
    assert store.get_skill("review-code")["skill"]["enabled"] is True


def test_delete_validates_state_before_moving_skill_to_trash(
    store: SkillsStore, monkeypatch: pytest.MonkeyPatch
) -> None:
    store.create_skill("review-code", "Review")
    store.state_path.write_text("{invalid", encoding="utf-8")
    trashed: list[str] = []
    monkeypatch.setattr(skills_store, "send2trash", trashed.append)

    with pytest.raises(SkillValidationError, match="state"):
        store.delete_skill("review-code")

    assert trashed == []
    assert (store.root / "review-code" / "SKILL.md").exists()


def test_projection_refresh_failure_does_not_fail_committed_mutations(
    store: SkillsStore, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    def fail_projection() -> Path:
        raise OSError("runtime unavailable")

    monkeypatch.setattr(store, "rebuild_runtime_projection", fail_projection)
    created = store.create_skill("review-code", "Review")["skill"]
    saved = store.save_skill(
        "review-code",
        {"description": "Updated"},
        "body",
        created["revision"],
    )["skill"]
    disabled = store.set_enabled("review-code", False)["skill"]
    trash = tmp_path / "Trash"
    trash.mkdir()
    monkeypatch.setattr(
        skills_store,
        "send2trash",
        lambda path: Path(path).rename(trash / Path(path).name),
    )

    deleted = store.delete_skill("review-code")

    assert saved["description"] == "Updated"
    assert disabled["enabled"] is False
    assert deleted == {"name": "review-code", "deleted": True}
    assert (trash / "review-code" / "SKILL.md").exists()


def test_missing_skill_raises_not_found(store: SkillsStore) -> None:
    with pytest.raises(SkillNotFoundError):
        store.get_skill("missing")


def test_skill_payloads_report_native_claude_or_codex_name_conflicts(
    tmp_path: Path,
) -> None:
    claude_native = tmp_path / "claude-native"
    codex_native = tmp_path / "codex-native"
    (claude_native / "review-code").mkdir(parents=True)
    codex_native.mkdir()
    (codex_native / "explain-code").write_text("native entry", encoding="utf-8")
    store = SkillsStore(
        root=tmp_path / "managed",
        state_path=tmp_path / "skills.json",
        runtime_root=tmp_path / "runtime" / "skills",
        native_roots=[claude_native, codex_native],
    )
    store.create_skill("consent-probe", "", consent=True)
    store.delete_skill("consent-probe")

    review = store.create_skill("review-code", "Review")["skill"]
    explain = store.create_skill("explain-code", "Explain")["skill"]
    assert review["native_conflict"] is True
    assert explain["native_conflict"] is True
    assert {item["name"]: item["native_conflict"] for item in store.list_skills()["skills"]} == {
        "explain-code": True,
        "review-code": True,
    }
    assert store.get_skill("review-code")["skill"]["native_conflict"] is True

    saved = store.save_skill(
        "review-code",
        {"description": "Updated"},
        review["body"],
        review["revision"],
    )["skill"]
    assert saved["native_conflict"] is True
    assert store.set_enabled("review-code", False)["skill"]["native_conflict"] is True


def test_native_conflict_inspection_failure_is_non_blocking(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    native_root = tmp_path / "native"
    native_root.mkdir()
    native_entry = native_root / "review-code"
    original_is_dir = Path.is_dir

    def flaky_is_dir(path: Path) -> bool:
        if path == native_entry:
            raise OSError("permission denied")
        return original_is_dir(path)

    monkeypatch.setattr(Path, "is_dir", flaky_is_dir)
    store = SkillsStore(
        root=tmp_path / "managed",
        state_path=tmp_path / "skills.json",
        runtime_root=tmp_path / "runtime" / "skills",
        native_roots=[native_root],
    )
    store.create_skill("consent-probe", "", consent=True)
    store.delete_skill("consent-probe")

    created = store.create_skill("review-code", "Review")

    assert created["skill"]["native_conflict"] is False
    assert store.list_skills()["skills"][0]["native_conflict"] is False


def test_broken_native_symlink_reports_name_conflict(tmp_path: Path) -> None:
    native_root = tmp_path / "native"
    native_root.mkdir()
    (native_root / "review-code").symlink_to(tmp_path / "missing-skill")
    store = SkillsStore(
        root=tmp_path / "managed",
        state_path=tmp_path / "skills.json",
        runtime_root=tmp_path / "runtime" / "skills",
        native_roots=[native_root],
    )
    store.create_skill("consent-probe", "", consent=True)
    store.delete_skill("consent-probe")

    created = store.create_skill("review-code", "Review")

    assert created["skill"]["native_conflict"] is True
    assert store.list_skills()["skills"][0]["native_conflict"] is True


def test_targets_default_to_every_agent_and_stay_out_of_the_state_file(
    store: SkillsStore,
) -> None:
    store.create_skill("shared", "Shared")

    assert store.get_skill("shared")["skill"]["targets"] is None
    assert store.targets_for("kimi") == ["shared"]
    # No targets set means no "targets" key at all: an untouched library keeps
    # the state file byte-identical to what earlier versions wrote.
    assert json.loads(store.state_path.read_text(encoding="utf-8")) == {
        "enabled": {"shared": True},
        "write_consented": True,
    }


def test_set_targets_restricts_delivery_and_survives_a_reload(store: SkillsStore) -> None:
    store.create_skill("only-pi", "Pi only")
    store.create_skill("everywhere", "All agents")

    store.set_targets("only-pi", ["pi"])

    assert store.targets_for("pi") == ["everywhere", "only-pi"]
    assert store.targets_for("claude") == ["everywhere"]
    assert json.loads(store.state_path.read_text(encoding="utf-8"))["targets"] == {
        "only-pi": ["pi"]
    }
    assert store.list_skills()["skills"][1]["targets"] == ["pi"]


def test_set_targets_none_restores_every_agent(store: SkillsStore) -> None:
    store.create_skill("scoped", "Scoped")
    store.set_targets("scoped", ["pi"])

    store.set_targets("scoped", None)

    assert store.targets_for("claude") == ["scoped"]
    assert "targets" not in json.loads(store.state_path.read_text(encoding="utf-8"))


def test_empty_targets_deliver_to_nobody(store: SkillsStore) -> None:
    store.create_skill("parked", "Parked")

    store.set_targets("parked", [])

    assert store.targets_for("claude") == []
    assert store.get_skill("parked")["skill"]["targets"] == []


def test_disabled_skill_is_never_targeted(store: SkillsStore) -> None:
    store.create_skill("off", "Off")
    store.set_targets("off", ["pi"])

    store.set_enabled("off", False)

    assert store.targets_for("pi") == []
    # Toggling enabled must not drop the target list it was carrying.
    assert store.get_skill("off")["skill"]["targets"] == ["pi"]


def test_set_targets_rejects_unusable_agent_keys(store: SkillsStore) -> None:
    store.create_skill("guarded", "Guarded")

    for agents in (["../escape"], ["UPPER"], [""], "pi", [1]):
        with pytest.raises(SkillValidationError):
            store.set_targets("guarded", agents)  # type: ignore[arg-type]

    assert store.get_skill("guarded")["skill"]["targets"] is None


def test_set_targets_requires_an_existing_skill(store: SkillsStore) -> None:
    with pytest.raises(SkillNotFoundError):
        store.set_targets("missing", ["pi"])


def test_agent_targets_reports_every_vendors_capability() -> None:
    states = {entry["key"]: entry["state"] for entry in skills_store.agent_targets()}

    # Every CLI with a skills mechanism is wired to the managed library.
    for key in (
        "claude", "codex", "copilot", "qwen", "kimi", "grok",
        "opencode", "pi", "muse", "cursor", "antigravity",
    ):
        assert states[key] == "wired", key
    # No skills mechanism exists in these CLIs at all, so the matrix must show
    # them as impossible rather than merely switched off.
    assert states["kilo"] == "unsupported"
    assert states["aider"] == "unsupported"
    assert set(states.values()) <= {"wired", "planned", "unsupported"}


# ── The shared root is the user's directory: Navide only touches its own ────


def _user_skill(store: SkillsStore, name: str, description: str = "Theirs") -> Path:
    """A skill the user put in the shared root by hand — no marker."""
    path = store.root / name
    path.mkdir(parents=True)
    (path / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {description}\n---\nbody\n", encoding="utf-8"
    )
    return path


def test_a_users_own_skill_is_listed_read_only(store: SkillsStore) -> None:
    _user_skill(store, "theirs")
    store.create_skill("ours", "Ours")

    listed = {s["name"]: s for s in store.list_skills()["skills"]}

    assert listed["theirs"]["managed"] is False
    assert listed["ours"]["managed"] is True
    # Read-only still means visible and deliverable.
    assert store.targets_for("claude") == ["ours", "theirs"]


def test_navide_refuses_to_delete_a_skill_it_did_not_create(store: SkillsStore) -> None:
    path = _user_skill(store, "theirs")

    with pytest.raises(SkillValidationError, match="not created by Navide"):
        store.delete_skill("theirs")

    assert (path / "SKILL.md").is_file()


def test_navide_refuses_to_edit_a_skill_it_did_not_create(store: SkillsStore) -> None:
    _user_skill(store, "theirs")
    current = store.get_skill("theirs")["skill"]

    with pytest.raises(SkillValidationError, match="not created by Navide"):
        store.save_skill("theirs", {"description": "hijacked"}, "new body", current["revision"])

    assert (store.root / "theirs" / "SKILL.md").read_text(encoding="utf-8").endswith("body\n")


def test_deleting_our_own_skill_still_works(store: SkillsStore) -> None:
    store.create_skill("ours", "Ours")

    result = store.delete_skill("ours")

    assert result == {"name": "ours", "deleted": True}
    assert not (store.root / "ours").exists()


def test_the_marker_never_leaks_into_attachments(store: SkillsStore) -> None:
    store.create_skill("ours", "Ours")
    (store.root / "ours" / "notes.md").write_text("x", encoding="utf-8")

    attachments = store.get_skill("ours")["skill"]["attachments"]

    assert [a["path"] for a in attachments] == ["notes.md"]


def test_native_reflection_excludes_what_the_shared_root_already_holds(
    store: SkillsStore, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A native link pointing into the shared root is the same skill twice."""
    home = tmp_path / "home"
    (home / ".claude" / "skills").mkdir(parents=True)
    store.create_skill("shared-one", "Shared")
    (home / ".claude" / "skills" / "shared-one").symlink_to(
        store.root / "shared-one", target_is_directory=True
    )
    (home / ".claude" / "skills" / "native-one").mkdir()
    (home / ".claude" / "skills" / "native-one" / "SKILL.md").write_text(
        "---\nname: native-one\ndescription: N\n---\n", encoding="utf-8"
    )
    monkeypatch.setattr(skills_store.native_skills, "_home", lambda: home)

    native = [s.name for s in store.native_skills()]

    assert native == ["native-one"]


def test_create_and_delete_preserve_other_skills_targets(store: SkillsStore) -> None:
    """Regression: create/delete used to rewrite skills.json without targets."""
    store.create_skill("kept", "Kept")
    store.set_targets("kept", ["pi"])

    store.create_skill("other", "Other")
    assert store.get_skill("kept")["skill"]["targets"] == ["pi"]

    store.delete_skill("other")
    assert store.get_skill("kept")["skill"]["targets"] == ["pi"]


# ── Native targets: opt-in delivery keyed by real path ───────────────────────


def test_native_targets_default_to_nobody(store: SkillsStore) -> None:
    assert store.native_targets() == {}
    assert store.native_targets_for("claude") == []


def test_native_targets_round_trip_and_clear(store: SkillsStore) -> None:
    store.set_native_targets("/Users/x/.copilot/skills/bug-buster", ["claude", "pi"])

    assert store.native_targets_for("claude") == ["/Users/x/.copilot/skills/bug-buster"]
    assert store.native_targets_for("kimi") == []
    assert json.loads(store.state_path.read_text(encoding="utf-8"))["native_targets"] == {
        "/Users/x/.copilot/skills/bug-buster": ["claude", "pi"]
    }

    store.set_native_targets("/Users/x/.copilot/skills/bug-buster", None)
    assert store.native_targets() == {}
    assert "native_targets" not in json.loads(store.state_path.read_text(encoding="utf-8"))


def test_native_targets_survive_shared_skill_edits(store: SkillsStore) -> None:
    store.set_native_targets("/Users/x/.copilot/skills/bug-buster", ["claude"])
    store.create_skill("ours", "Ours")
    store.set_targets("ours", ["pi"])
    store.set_enabled("ours", False)
    store.delete_skill("ours")

    assert store.native_targets_for("claude") == ["/Users/x/.copilot/skills/bug-buster"]


@pytest.mark.parametrize("bad", ["relative/path", "", "~/.copilot/skills/x"])
def test_native_targets_reject_non_absolute_keys(store: SkillsStore, bad: str) -> None:
    with pytest.raises(SkillValidationError):
        store.set_native_targets(bad, ["claude"])


def test_a_users_symlinked_skill_in_the_shared_root_is_accepted(
    store: SkillsStore, tmp_path: Path
) -> None:
    """ego-browser installs itself as a link in ~/.agents/skills."""
    real = tmp_path / "elsewhere" / "ego-browser"
    real.mkdir(parents=True)
    (real / "SKILL.md").write_text("---\nname: ego-browser\ndescription: E\n---\n", encoding="utf-8")
    (real / "helper.sh").write_text("#!/bin/sh\n", encoding="utf-8")
    store.root.mkdir(parents=True, exist_ok=True)
    (store.root / "ego-browser").symlink_to(real, target_is_directory=True)

    listed = {s["name"]: s for s in store.list_skills()["skills"]}

    assert listed["ego-browser"]["valid"] is True
    assert listed["ego-browser"]["managed"] is False
    assert [a["path"] for a in listed["ego-browser"]["attachments"]] == ["helper.sh"]
    # Delivered like any other, and the view resolves to the real directory.
    assert store.targets_for("claude") == ["ego-browser"]
    store.rebuild_runtime_projection()
    assert (store.runtime_root / "ego-browser").resolve() == real.resolve()


def test_our_own_skill_must_still_be_a_real_directory(store: SkillsStore, tmp_path: Path) -> None:
    real = tmp_path / "elsewhere" / "ours"
    real.mkdir(parents=True)
    (real / ".navide").write_text("", encoding="utf-8")
    (real / "SKILL.md").write_text("---\nname: ours\ndescription: O\n---\n", encoding="utf-8")
    store.root.mkdir(parents=True, exist_ok=True)
    (store.root / "ours").symlink_to(real, target_is_directory=True)

    listed = {s["name"]: s for s in store.list_skills()["skills"]}

    assert listed["ours"]["valid"] is False
    assert "must not be a symlink" in listed["ours"]["error"]



# ── Consent: the first write into the user's directory is asked, once ───────


def test_first_create_needs_consent_and_writes_nothing_without_it(fresh_store: SkillsStore) -> None:
    assert fresh_store.write_consented() is False

    with pytest.raises(SkillConsentRequired) as info:
        fresh_store.create_skill("first", "First")

    assert info.value.root == str(fresh_store.root)
    assert not fresh_store.root.exists()  # not even the root directory
    assert not fresh_store.state_path.exists()


def test_consent_is_recorded_once_and_survives_later_writes(fresh_store: SkillsStore) -> None:
    fresh_store.create_skill("first", "First", consent=True)
    assert fresh_store.write_consented() is True

    # Never asked again, and no later rewrite of skills.json drops the flag.
    fresh_store.create_skill("second", "Second")
    fresh_store.set_targets("second", ["pi"])
    fresh_store.set_enabled("first", False)
    fresh_store.delete_skill("first")

    assert fresh_store.write_consented() is True
    assert json.loads(fresh_store.state_path.read_text(encoding="utf-8"))["write_consented"] is True


def test_list_reports_consent_state(fresh_store: SkillsStore) -> None:
    assert fresh_store.list_skills()["write_consented"] is False
    fresh_store.create_skill("x", "", consent=True)
    assert fresh_store.list_skills()["write_consented"] is True


# ── Migration: the one operation that changes a user's directory ────────────


def _vendor_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, vendor: str = "copilot") -> Path:
    """A fake ~/.<vendor>/skills, registered as a native root."""
    home = tmp_path / "home"
    root = home / f".{vendor}" / "skills"
    root.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(skills_store.native_skills, "_home", lambda: home)
    return root


def _native_skill(root: Path, name: str) -> Path:
    path = root / name
    path.mkdir(parents=True)
    (path / "SKILL.md").write_text(f"---\nname: {name}\ndescription: N\n---\nbody\n", encoding="utf-8")
    (path / "scripts").mkdir()
    (path / "scripts" / "run.sh").write_text("#!/bin/sh\necho hi\n", encoding="utf-8")
    return path


def _tree(path: Path) -> dict[str, str]:
    """Every regular file under path with its content — the round-trip witness."""
    out = {}
    for p in sorted(path.rglob("*")):
        if p.is_file() and not p.is_symlink() and p.name != ".navide":
            out[str(p.relative_to(path))] = p.read_text(encoding="utf-8")
    return out


def test_migrate_requires_per_item_consent_every_time(
    store: SkillsStore, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    src = _native_skill(_vendor_root(tmp_path, monkeypatch), "bug-buster")

    with pytest.raises(SkillConsentRequired):
        store.migrate_native(str(src))
    assert src.is_dir() and not src.is_symlink()
    assert not (store.root / "bug-buster").exists()


def test_migrate_moves_the_skill_and_leaves_a_working_link(
    store: SkillsStore, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    src = _native_skill(_vendor_root(tmp_path, monkeypatch), "bug-buster")
    before = _tree(src)

    result = store.migrate_native(str(src), consent=True)

    target = store.root / "bug-buster"
    assert target.is_dir() and not target.is_symlink()
    assert _tree(target) == before
    # The owning CLI still finds it where it always was.
    assert src.is_symlink() and src.resolve() == target.resolve()
    assert (src / "SKILL.md").read_text(encoding="utf-8") == before["SKILL.md"]
    # It is now ours, and it remembers where it came from.
    assert result["skill"]["managed"] is True
    assert result["from"] == str(src)
    assert "migrated-from" in (target / ".navide").read_text(encoding="utf-8")


def test_restore_puts_everything_back_byte_for_byte(
    store: SkillsStore, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    src = _native_skill(_vendor_root(tmp_path, monkeypatch), "bug-buster")
    before = _tree(src)
    store.migrate_native(str(src), consent=True)

    result = store.restore_native("bug-buster")

    assert result == {"name": "bug-buster", "restored_to": str(src)}
    assert src.is_dir() and not src.is_symlink()
    assert _tree(src) == before
    assert not (src / ".navide").exists()
    assert not (store.root / "bug-buster").exists()
    assert "bug-buster" not in store.list_skills()["skills"]


def test_migrate_refuses_a_name_the_shared_root_already_has(
    store: SkillsStore, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    src = _native_skill(_vendor_root(tmp_path, monkeypatch), "clash")
    store.create_skill("clash", "Ours")

    with pytest.raises(SkillValidationError, match="already has a skill named"):
        store.migrate_native(str(src), consent=True)
    assert src.is_dir() and not src.is_symlink()


def test_migrate_refuses_anything_outside_a_cli_skills_directory(
    store: SkillsStore, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _vendor_root(tmp_path, monkeypatch)
    stray = tmp_path / "home" / "Documents" / "not-a-skill"
    stray.mkdir(parents=True)
    (stray / "SKILL.md").write_text("---\nname: not-a-skill\n---\n", encoding="utf-8")

    with pytest.raises(SkillValidationError, match="own skills directory"):
        store.migrate_native(str(stray), consent=True)


def test_migrate_refuses_a_link_it_did_not_understand(
    store: SkillsStore, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """ego-browser is a link into ~/.local/share; that is another tool's
    arrangement and not ours to rewrite."""
    root = _vendor_root(tmp_path, monkeypatch)
    real = tmp_path / "share" / "ego"
    real.mkdir(parents=True)
    (real / "SKILL.md").write_text("---\nname: ego\n---\n", encoding="utf-8")
    (root / "ego").symlink_to(real, target_is_directory=True)

    with pytest.raises(SkillValidationError, match="real directory"):
        store.migrate_native(str(root / "ego"), consent=True)


def test_restore_refuses_a_skill_that_was_not_migrated(store: SkillsStore) -> None:
    store.create_skill("born-here", "Ours")

    with pytest.raises(SkillValidationError, match="not migrated"):
        store.restore_native("born-here")
    assert (store.root / "born-here").is_dir()


def test_restore_refuses_when_the_origin_is_no_longer_our_link(
    store: SkillsStore, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The user replaced the link with something of their own; never clobber it."""
    src = _native_skill(_vendor_root(tmp_path, monkeypatch), "bug-buster")
    store.migrate_native(str(src), consent=True)
    src.unlink()
    src.mkdir()
    (src / "SKILL.md").write_text("theirs now", encoding="utf-8")

    with pytest.raises(SkillValidationError, match="no longer holds Navide's link"):
        store.restore_native("bug-buster")
    assert (src / "SKILL.md").read_text(encoding="utf-8") == "theirs now"
    assert (store.root / "bug-buster").is_dir()


@pytest.mark.parametrize("fail_at", ["copytree", "rename", "symlink"])
def test_migrate_failure_at_any_step_leaves_the_original_exactly_as_it_was(
    store: SkillsStore, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, fail_at: str
) -> None:
    src = _native_skill(_vendor_root(tmp_path, monkeypatch), "bug-buster")
    before = _tree(src)

    if fail_at == "copytree":
        monkeypatch.setattr(skills_store.shutil, "copytree", lambda *a, **k: (_ for _ in ()).throw(OSError("disk")))
    elif fail_at == "rename":
        real_rename = os.rename
        def rename(a, b):
            if str(a) == str(src): raise OSError("busy")
            return real_rename(a, b)
        monkeypatch.setattr(skills_store.os, "rename", rename)
    else:
        monkeypatch.setattr(skills_store.os, "symlink", lambda *a, **k: (_ for _ in ()).throw(OSError("no")))

    with pytest.raises(OSError):
        store.migrate_native(str(src), consent=True)

    assert src.is_dir() and not src.is_symlink()
    assert _tree(src) == before
    assert not (store.root / "bug-buster").exists()
    assert not src.with_name(".bug-buster.navide-migrating").exists()


def test_migrate_then_restore_round_trips_the_state_file(
    store: SkillsStore, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    src = _native_skill(_vendor_root(tmp_path, monkeypatch), "bug-buster")
    store.set_native_targets(str(src.resolve()), ["claude"])

    store.migrate_native(str(src), consent=True)
    # It is a shared skill now: its native opt-in is gone, shared default applies.
    assert store.native_targets() == {}
    assert store.targets_for("claude") == ["bug-buster"]

    store.restore_native("bug-buster")
    assert store.targets_for("claude") == []


# ── platforms without hard links (Android's CPython has no os.link) ──────────

def test_module_imports_without_os_link() -> None:
    import subprocess
    import sys

    result = subprocess.run(
        [sys.executable, "-c", "import os; del os.link; import agent_team_backend.skills_store"],
        capture_output=True, text=True, cwd=Path(__file__).resolve().parents[1],
    )
    assert result.returncode == 0, result.stderr


@pytest.mark.skipif(not osplat.paths.enforces_posix_modes(), reason="Android fallback: POSIX modes and os.fchmod")
@pytest.mark.parametrize("directory_fds", [True, False])
def test_install_bundle_copies_when_hard_links_are_unavailable(
    store: SkillsStore, monkeypatch: pytest.MonkeyPatch, directory_fds: bool,
) -> None:
    if directory_fds and not skills_store._DIRECTORY_FDS:
        pytest.skip("directory file descriptors are unavailable here")
    monkeypatch.delattr(skills_store.os, "link")
    monkeypatch.setattr(skills_store, "_HARD_LINKS", False)
    monkeypatch.setattr(skills_store, "_DIRECTORY_FDS", directory_fds)
    skill = b"---\nname: copied\ndescription: Copied skill\n---\nBody.\n"
    files = {
        "SKILL.md": {"data": skill, "executable": False},
        "bin/run.sh": {"data": b"#!/bin/sh\necho hi\n", "executable": True},
    }

    store.install_bundle("copied", files, targets=None, consent=True)

    root = store.root / "copied"
    assert (root / "SKILL.md").read_bytes() == skill
    assert (root / "bin" / "run.sh").read_bytes() == b"#!/bin/sh\necho hi\n"
    assert os.stat(root / "bin" / "run.sh").st_mode & 0o777 == 0o755
    assert os.stat(root / "SKILL.md").st_mode & 0o777 == 0o644
    assert store.get_skill("copied")["skill"]["name"] == "copied"

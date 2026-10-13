"""CliProfilesStore CRUD + path canonicalisation (profiles_store.py)."""

from __future__ import annotations

import json
import os
import unicodedata
from pathlib import Path

import pytest

from agent_team_backend import profiles_store as profiles_mod
from agent_team_backend.profiles_store import (
    CliProfilesStore,
    canonical_path_str,
)


def _store(tmp_path: Path) -> CliProfilesStore:
    return CliProfilesStore(
        path=tmp_path / "cli-profiles.json",
        profiles_root=tmp_path / "cli-profiles",
    )


# ---- registry CRUD ----


def test_supported_agents_are_the_vendors_declaring_a_slot_file() -> None:
    """The vendor spec's ``slot_file`` is the single switch that turns
    multi-account support on: it registers the vendor in the vault's tables,
    puts it in ``supported_agents`` and lights its accounts UI. kilo declares
    one, so it must be here — and after the four originally-ordered keys."""
    from agent_team_backend.cli_vendors.registry import VENDORS

    assert profiles_mod.SUPPORTED_AGENT_KEYS[:4] == ("claude", "codex", "kimi", "grok")
    assert profiles_mod.SUPPORTED_AGENT_KEYS[4:] == tuple(
        sorted(profiles_mod.SUPPORTED_AGENT_KEYS[4:])
    )
    assert {k for k, s in VENDORS.items() if s.slot_file is not None} == set(
        profiles_mod.SUPPORTED_AGENT_KEYS
    )


def test_create_and_list(tmp_path: Path) -> None:
    store = _store(tmp_path)
    profile = store.create(agent_key="claude", name="Work")

    assert profile["agentKey"] == "claude"
    assert profile["name"] == "Work"
    assert len(profile["id"]) == 8
    assert profile["createdAt"].endswith("Z")

    doc = store.list()
    assert doc["profiles"] == [profile]
    assert doc["defaults"] == {key: None for key in profiles_mod.SUPPORTED_AGENT_KEYS}
    assert store.get(profile["id"]) == profile
    # Stored document carries the schema version.
    stored = store._db.kv_get(profiles_mod._KV_KEY)
    assert stored["schemaVersion"] == 1


@pytest.mark.parametrize("agent_key", ["terminal", "", "gemini"])
def test_create_rejects_unsupported_agent(tmp_path: Path, agent_key: str) -> None:
    store = _store(tmp_path)
    with pytest.raises(ValueError):
        store.create(agent_key=agent_key, name="X")


def test_create_rejects_blank_name(tmp_path: Path) -> None:
    store = _store(tmp_path)
    with pytest.raises(ValueError):
        store.create(agent_key="claude", name="   ")


def test_create_does_not_touch_disk_dirs(tmp_path: Path) -> None:
    """Profile homes are lazy — created only via ensure_home (at spawn)."""
    store = _store(tmp_path)
    profile = store.create(agent_key="kimi", name="Alt")
    assert not store.home_path(profile).exists()
    home = store.ensure_home(profile)
    assert home.is_dir()
    assert home == store.home_path(profile)


def test_rename_updates_name_not_directory(tmp_path: Path) -> None:
    store = _store(tmp_path)
    profile = store.create(agent_key="claude", name="Old")
    home_before = store.ensure_home(profile)

    renamed = store.rename(profile["id"], "New")

    assert renamed["name"] == "New"
    assert renamed["id"] == profile["id"]
    assert store.home_path(renamed) == home_before
    assert home_before.is_dir()


def test_rename_blank_clears_the_alias_and_auto_names(tmp_path: Path) -> None:
    """Clearing the field is how the UI drops a custom name: the profile goes
    back to a generated "Account N" (max existing + 1, ignoring itself) and
    stops counting as custom."""
    store = _store(tmp_path)
    store.create(agent_key="claude", name="Account 2")
    store.create(agent_key="claude", name="Account 5")
    other = store.create(agent_key="codex", name="Account 9")
    profile = store.create(agent_key="claude", name="Account 3")
    store.rename(profile["id"], "Work")

    cleared = store.rename(profile["id"], "")

    assert cleared["name"] == "Account 6"
    assert "nameIsCustom" not in cleared
    assert store.get(profile["id"])["name"] == "Account 6"
    # Another agent's rows never take part in the numbering.
    assert store.get(other["id"])["name"] == "Account 9"


def test_rename_whitespace_clears_like_an_empty_name(tmp_path: Path) -> None:
    store = _store(tmp_path)
    profile = store.create(agent_key="grok", name="Work")

    cleared = store.rename(profile["id"], "   ")

    # No "Account N" row exists yet: "Account 1" is the built-in Default.
    assert cleared["name"] == "Account 2"
    assert "nameIsCustom" not in cleared


def test_rename_unknown_raises(tmp_path: Path) -> None:
    store = _store(tmp_path)
    with pytest.raises(KeyError):
        store.rename("nope1234", "X")


def test_delete_archives_home_dir_never_removes(tmp_path: Path) -> None:
    store = _store(tmp_path)
    profile = store.create(agent_key="claude", name="Work")
    home = store.ensure_home(profile)
    (home / ".credentials.json").write_text("{}", encoding="utf-8")

    doc = store.delete(profile["id"])

    assert doc["profiles"] == []
    assert not home.exists()
    archived = [
        p for p in home.parent.iterdir()
        if p.name.startswith(f"{profile['id']}.deleted-")
    ]
    assert len(archived) == 1
    # Content survives the archive rename.
    assert (archived[0] / ".credentials.json").read_text(encoding="utf-8") == "{}"


def test_delete_clears_default(tmp_path: Path) -> None:
    store = _store(tmp_path)
    profile = store.create(agent_key="grok", name="Work")
    store.set_default("grok", profile["id"])

    doc = store.delete(profile["id"])

    assert doc["defaults"]["grok"] is None


def test_delete_archive_name_avoids_same_instant_collision(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Two archives colliding on the same timestamp must not clobber each other:
    the second falls back to a suffixed name instead of failing to rename."""
    store = _store(tmp_path)
    profile = store.create(agent_key="claude", name="Work")
    home = store.ensure_home(profile)
    (home / ".credentials.json").write_text("secret", encoding="utf-8")
    # Freeze the timestamp and pre-create the exact archive name delete would
    # pick, forcing the collision the old int(time.time()) suffix couldn't dodge.
    monkeypatch.setattr(profiles_mod.time, "time_ns", lambda: 111)
    collider = home.with_name(f"{home.name}.deleted-111")
    collider.mkdir(parents=True)

    store.delete(profile["id"])

    assert not home.exists()
    archived = [
        p for p in home.parent.iterdir()
        if p.name.startswith(f"{profile['id']}.deleted-")
    ]
    # Both the pre-existing collider and the freshly archived home survive.
    assert len(archived) == 2
    with_creds = [p for p in archived if (p / ".credentials.json").exists()]
    assert len(with_creds) == 1
    assert (with_creds[0] / ".credentials.json").read_text(encoding="utf-8") == "secret"


def test_delete_unknown_raises(tmp_path: Path) -> None:
    store = _store(tmp_path)
    with pytest.raises(KeyError):
        store.delete("nope1234")


def test_set_default_and_builtin_null(tmp_path: Path) -> None:
    store = _store(tmp_path)
    profile = store.create(agent_key="codex", name="Work")

    defaults = store.set_default("codex", profile["id"])
    assert defaults["codex"] == profile["id"]
    assert store.get_default_profile("codex") == profile

    defaults = store.set_default("codex", None)
    assert defaults["codex"] is None
    assert store.get_default_profile("codex") is None


def test_set_default_validates_agent_and_profile(tmp_path: Path) -> None:
    store = _store(tmp_path)
    claude_profile = store.create(agent_key="claude", name="Work")
    with pytest.raises(ValueError):
        store.set_default("terminal", None)
    with pytest.raises(KeyError):
        store.set_default("claude", "nope1234")
    with pytest.raises(ValueError):
        store.set_default("codex", claude_profile["id"])


def test_corrupt_registry_starts_empty(tmp_path: Path) -> None:
    store = _store(tmp_path)
    legacy = tmp_path / "cli-profiles.json"
    legacy.write_text("{not json", encoding="utf-8")
    assert store.list() == {
        "profiles": [],
        "defaults": {key: None for key in profiles_mod.SUPPORTED_AGENT_KEYS},
        "defaultNames": {},
        "paneDefaults": {},
    }


def test_legacy_json_imported_once_and_retired(tmp_path: Path) -> None:
    legacy = tmp_path / "cli-profiles.json"
    legacy.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "profiles": [
                    {"id": "abcd1234", "agentKey": "claude", "name": "Work",
                     "createdAt": "2026-01-01T00:00:00Z"},
                ],
                "defaults": {"claude": "abcd1234"},
            }
        ),
        encoding="utf-8",
    )
    store = _store(tmp_path)
    doc = store.list()
    assert [p["id"] for p in doc["profiles"]] == ["abcd1234"]
    assert doc["defaults"]["claude"] == "abcd1234"
    assert not legacy.exists()
    assert legacy.with_name(legacy.name + ".migrated-v1").exists()
    # Second instance reads the imported registry.
    assert _store(tmp_path).get_default_profile("claude")["id"] == "abcd1234"


# ---- path canonicalisation ----


def test_home_path_absolute_nfc_stable(tmp_path: Path) -> None:
    """The legacy-home migration hashes the literal path string for Keychain
    service names — the path must be absolute, NFC, no trailing slash,
    identical every call."""
    nfd_root = tmp_path / unicodedata.normalize("NFD", "café-profiles")
    store = CliProfilesStore(path=tmp_path / "reg.json", profiles_root=nfd_root)
    profile = store.create(agent_key="claude", name="Work")

    home = str(store.home_path(profile))

    assert os.path.isabs(home)
    assert home == unicodedata.normalize("NFC", home)
    assert not home.endswith(os.sep)
    assert str(store.home_path(profile)) == home  # verbatim-stable across calls
    assert str(store.ensure_home(profile)) == home


def test_canonical_path_str_strips_trailing_slash(tmp_path: Path) -> None:
    base = str(tmp_path / "a" / "b")
    assert canonical_path_str(base + os.sep) == base


# ---- user aliases (Default slot names, nameIsCustom) ----


def test_set_default_name_sets_and_clears(tmp_path: Path) -> None:
    store = _store(tmp_path)
    assert store.list()["defaultNames"] == {}

    assert store.set_default_name("claude", "  Personal  ") == {"claude": "Personal"}
    store.set_default_name("codex", "Team")
    assert store.list()["defaultNames"] == {"claude": "Personal", "codex": "Team"}

    # A blank name clears the alias back to unnamed.
    store.set_default_name("claude", "   ")
    assert store.list()["defaultNames"] == {"codex": "Team"}
    store.set_default_name("kimi", "")
    assert store.list()["defaultNames"] == {"codex": "Team"}


def test_set_default_name_rejects_unsupported_agent(tmp_path: Path) -> None:
    store = _store(tmp_path)
    with pytest.raises(ValueError):
        store.set_default_name("terminal", "X")
    assert store.list()["defaultNames"] == {}


def test_legacy_doc_without_default_names_reads_empty(tmp_path: Path) -> None:
    store = _store(tmp_path)
    legacy = {
        "schemaVersion": 1,
        "profiles": [{"id": "abcd1234", "agentKey": "claude", "name": "Account 1"}],
        "defaults": {"claude": "abcd1234"},
    }
    store._db.kv_set(profiles_mod._KV_KEY, legacy, now=0)

    doc = store.list()
    assert doc["defaultNames"] == {}
    assert "nameIsCustom" not in doc["profiles"][0]
    # Writing through another path keeps the aliases field in the document.
    store.set_default_name("claude", "Home")
    store.rename("abcd1234", "Work")
    assert store._db.kv_get(profiles_mod._KV_KEY)["defaultNames"] == {"claude": "Home"}


def test_rename_marks_name_custom_create_does_not(tmp_path: Path) -> None:
    store = _store(tmp_path)
    profile = store.create(agent_key="claude", name="Account 1")
    assert "nameIsCustom" not in profile

    renamed = store.rename(profile["id"], "Work")
    assert renamed["nameIsCustom"] is True
    assert store.get(profile["id"])["nameIsCustom"] is True


# ---- alias cleaning (rename / set_default_name) ----


def test_rename_strips_control_and_format_characters(tmp_path: Path) -> None:
    store = _store(tmp_path)
    profile = store.create(agent_key="claude", name="Old")

    renamed = store.rename(profile["id"], "Wo​rk\x07\n")

    assert renamed["name"] == "Work"


def test_rename_normalises_to_nfc(tmp_path: Path) -> None:
    store = _store(tmp_path)
    profile = store.create(agent_key="claude", name="Old")

    renamed = store.rename(profile["id"], "Café")

    assert renamed["name"] == "Café"
    assert unicodedata.is_normalized("NFC", renamed["name"])


def test_rename_only_control_characters_clears_like_blank(tmp_path: Path) -> None:
    store = _store(tmp_path)
    profile = store.create(agent_key="claude", name="Old")
    store.rename(profile["id"], "Work")

    cleared = store.rename(profile["id"], "​\x00")

    assert "nameIsCustom" not in cleared


def test_rename_accepts_64_characters_and_rejects_65(tmp_path: Path) -> None:
    store = _store(tmp_path)
    profile = store.create(agent_key="claude", name="Old")

    assert store.rename(profile["id"], "x" * 64)["name"] == "x" * 64
    with pytest.raises(ValueError, match="64"):
        store.rename(profile["id"], "y" * 65)
    # A rejected name leaves the stored one untouched.
    assert store.list()["profiles"][0]["name"] == "x" * 64


def test_set_default_name_cleans_like_rename(tmp_path: Path) -> None:
    store = _store(tmp_path)

    assert store.set_default_name("claude", "Ho​me\x1b") == {"claude": "Home"}
    with pytest.raises(ValueError, match="64"):
        store.set_default_name("claude", "z" * 65)
    assert store.list()["defaultNames"] == {"claude": "Home"}

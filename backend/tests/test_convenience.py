"""The convenience-feature write gate (docs/en-US/convenience-features.md).

Every write Navide makes outside its own data goes through one gate: allowed?
→ removed by hand? → backup → write → notify → audit log. Everything is
allowed by default, so today's behaviour is kept.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from agent_team_backend import convenience
from agent_team_backend.db import Database


@pytest.fixture
def gate(tmp_path: Path) -> convenience.ConvenienceGate:
    notices: list[dict] = []
    gate = convenience.ConvenienceGate(
        Database(tmp_path / "navide.db"), backup_root=tmp_path / "backups", notify=notices.append,
    )
    gate.sent = notices  # type: ignore[attr-defined]
    return gate


class _File:
    """A target file with a Navide-marked line the write adds."""

    def __init__(self, path: Path, initial: str | None = None) -> None:
        self.path = path
        if initial is not None:
            path.write_text(initial, encoding="utf-8")

    def write(self) -> None:
        text = self.path.read_text(encoding="utf-8") if self.path.exists() else ""
        if "# navide" not in text:
            self.path.write_text(text + "# navide\n", encoding="utf-8")

    def present(self) -> bool:
        return self.path.exists() and "# navide" in self.path.read_text(encoding="utf-8")


def _apply(gate: convenience.ConvenienceGate, target: _File, feature: str = "claude.hooks") -> str:
    return gate.apply(feature, target.path, write=target.write, present=target.present, file=target.path)


def test_every_feature_is_allowed_by_default(gate) -> None:
    assert all(gate.allowed(feature.id) for feature in convenience.REGISTRY)
    assert {f.id for f in convenience.REGISTRY} >= {
        "claude.hooks", "qwen.hooks", "copilot.hooks", "codex.hook-trust", "codex.login-promote",
        "cursor.project-mcp", "cursor.project-skills", "credentials.auto-repair",
        "codex.pane-homes", "pane-shims", "claude.account-homes",
    }


def test_a_first_write_is_written_backed_up_logged_and_announced(gate, tmp_path) -> None:
    target = _File(tmp_path / "settings.json", "user: 1\n")

    assert _apply(gate, target) == "first"

    assert target.path.read_text(encoding="utf-8") == "user: 1\n# navide\n"
    [entry] = gate.history()
    assert (entry["feature"], entry["action"], entry["target"], entry["notify"]) == (
        "claude.hooks", "first", str(target.path), True,
    )
    assert Path(entry["backup"]).read_text(encoding="utf-8") == "user: 1\n"
    assert [n["entry"]["id"] for n in gate.sent] == [entry["id"]]


def test_an_unchanged_rewrite_is_silent(gate, tmp_path) -> None:
    target = _File(tmp_path / "settings.json", "")
    _apply(gate, target)

    assert _apply(gate, target) == "unchanged"

    assert len(gate.history()) == 1
    assert len(gate.sent) == 1


def test_an_entry_already_there_on_first_sight_is_adopted_silently(gate, tmp_path) -> None:
    """An upgraded install: Navide wrote it before the ledger existed."""
    target = _File(tmp_path / "settings.json", "# navide\n")

    assert _apply(gate, target) == "unchanged"

    assert gate.history() == []
    assert [t["path"] for t in gate.listing_feature("claude.hooks")["targets"]] == [str(target.path)]
    assert gate.upgrade_features() == ["claude.hooks"]


def test_a_changed_target_first_seen_is_announced_as_first(gate, tmp_path) -> None:
    target = _File(tmp_path / "settings.json", "")
    target.present = lambda: True  # type: ignore[method-assign]

    assert _apply(gate, target) == "first"


def test_a_hand_removed_entry_turns_the_feature_off_and_is_never_re_added(gate, tmp_path) -> None:
    target = _File(tmp_path / "settings.json", "")
    _apply(gate, target)
    target.path.write_text("user removed it\n", encoding="utf-8")

    assert _apply(gate, target) == "removed"
    assert _apply(gate, target) == "off"

    assert target.path.read_text(encoding="utf-8") == "user removed it\n"
    assert gate.state("claude.hooks") == ("off", "removed")
    removed = gate.history()[0]
    assert (removed["action"], removed["notify"]) == ("removed", True)


def test_re_allowing_clears_the_removal_and_writes_again(gate, tmp_path) -> None:
    target = _File(tmp_path / "settings.json", "")
    _apply(gate, target)
    target.path.write_text("", encoding="utf-8")
    _apply(gate, target)

    gate.set_allowed("claude.hooks", True)

    assert gate.state("claude.hooks") == ("allowed", "user")
    assert _apply(gate, target) == "first"
    assert target.present()


def test_turning_off_runs_the_removal_and_stops_writing(gate, tmp_path) -> None:
    target = _File(tmp_path / "settings.json", "mine\n")
    _apply(gate, target)

    gate.set_allowed("claude.hooks", False, remove=lambda: target.path.write_text("mine\n", encoding="utf-8"))

    assert gate.state("claude.hooks") == ("off", "user")
    assert _apply(gate, target) == "off"
    assert target.path.read_text(encoding="utf-8") == "mine\n"
    assert gate.history()[0]["action"] == "off"


def test_a_required_feature_cannot_be_turned_off(gate) -> None:
    with pytest.raises(ValueError):
        gate.set_allowed("codex.pane-homes", False)


def test_an_unknown_feature_is_refused(gate) -> None:
    with pytest.raises(KeyError):
        gate.allowed("nope")


def test_a_present_check_that_fails_never_reads_as_a_removal(gate, tmp_path) -> None:
    target = _File(tmp_path / "settings.json", "")
    _apply(gate, target)

    def broken() -> bool:
        raise OSError("unreadable")

    result = gate.apply("claude.hooks", target.path, write=target.write, present=broken, file=target.path)

    assert result == "unchanged"
    assert gate.allowed("claude.hooks")


def test_state_survives_a_restart(tmp_path) -> None:
    db = Database(tmp_path / "navide.db")
    first = convenience.ConvenienceGate(db, backup_root=tmp_path / "b")
    first.set_allowed("qwen.hooks", False)

    second = convenience.ConvenienceGate(db, backup_root=tmp_path / "b")

    assert second.state("qwen.hooks") == ("off", "user")


def test_the_upgrade_notice_is_published_once(gate, tmp_path) -> None:
    _apply(gate, _File(tmp_path / "settings.json", "# navide\n"))

    gate.finish_startup_scan()
    assert gate.upgrade_notice() == {"features": ["claude.hooks"]}
    gate.acknowledge_upgrade()
    assert gate.upgrade_notice() is None

    gate.finish_startup_scan()
    assert gate.upgrade_notice() is None


def test_a_fresh_install_gets_no_upgrade_notice(gate, tmp_path) -> None:
    _apply(gate, _File(tmp_path / "settings.json", ""))

    gate.finish_startup_scan()

    assert gate.upgrade_notice() is None


def test_a_recorded_event_is_logged_and_announced(gate) -> None:
    gate.record("credentials.auto-repair", "prompt", "claude", detail="live account differs")

    [entry] = gate.history()
    assert (entry["action"], entry["notify"]) == ("prompt", True)
    assert gate.notices()[0]["id"] == entry["id"]


def test_the_listing_carries_every_feature(gate, tmp_path) -> None:
    target = _File(tmp_path / "settings.json", "")
    _apply(gate, target)

    listing = gate.listing()

    by_id = {f["id"]: f for f in listing["features"]}
    assert by_id["claude.hooks"]["targets"][0]["present"] is True
    assert by_id["codex.pane-homes"]["toggleable"] is False
    assert listing["upgrade"] is None


def test_noting_a_required_target_announces_only_its_first_creation(gate, tmp_path) -> None:
    root = tmp_path / ".codex-panes"

    assert gate.note("codex.pane-homes", root, detail="per-pane CODEX_HOME") is True
    assert gate.note("codex.pane-homes", root) is False

    [entry] = gate.history()
    assert (entry["feature"], entry["action"], entry["notify"]) == ("codex.pane-homes", "first", True)
    assert gate.listing_feature("codex.pane-homes")["targets"][0]["path"] == str(root)

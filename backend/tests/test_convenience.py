"""The convenience-feature write gate (docs/en-US/convenience-features.md).

Every write Navide makes outside its own data goes through one gate: allowed?
→ removed by hand? → backup → write → notify → audit log. Everything is
allowed by default, so today's behaviour is kept.
"""

from __future__ import annotations

import stat
import sys
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


def test_a_write_that_left_no_entry_is_not_recorded_and_never_reads_as_a_removal(gate, tmp_path) -> None:
    """An installer that skipped (a dev backend, a CLI that is not set up)
    wrote nothing; holding the target in the ledger would make the next start
    read its absence as the user's removal."""
    path = tmp_path / "settings.json"
    calls: list[int] = []

    def skipped() -> None:
        calls.append(1)

    assert gate.apply("claude.hooks", path, write=skipped, present=lambda: False, file=path) == "unchanged"
    assert gate.apply("claude.hooks", path, write=skipped, present=lambda: False, file=path) == "unchanged"

    assert calls == [1, 1]
    assert gate.allowed("claude.hooks")
    assert gate.listing_feature("claude.hooks")["targets"] == []


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX modes")
def test_backups_are_private_from_the_moment_they_exist(gate, tmp_path) -> None:
    """A8: a backup holds the whole file, secrets included. Its folders are
    0700 and the file is created 0600, never readable by others in between."""
    _apply(gate, _File(tmp_path / "settings.json", "token: secret\n"))

    [backup] = (tmp_path / "backups").rglob("*.bak")
    folders = [tmp_path / "backups", *[p for p in (tmp_path / "backups").rglob("*") if p.is_dir()]]
    assert {oct(stat.S_IMODE(p.stat().st_mode)) for p in folders} == {"0o700"}
    assert stat.S_IMODE(backup.stat().st_mode) == 0o600


def test_backups_are_kept_per_target_and_rotated(gate, tmp_path) -> None:
    """A7: a target that changes on every pane start (one Codex trust row per
    pane) must not leave one full copy of the file, secrets and all, per
    change for ever. Each target keeps its last few; a removal keeps one."""
    config = tmp_path / "config.toml"
    config.write_text('[mcp_servers.gh.env]\nGITHUB_TOKEN = "ghp_secret"\n', encoding="utf-8")
    rows = [0]

    def add_row() -> None:
        rows[0] += 1
        config.write_text(config.read_text(encoding="utf-8") + f"# row {rows[0]}\n", encoding="utf-8")

    for _ in range(25):
        gate.apply("codex.hook-trust", config, write=add_row, present=lambda: True, file=config, quiet_repairs=True)
    other = _File(tmp_path / "other.toml", "x\n")
    gate.apply("codex.hook-trust", other.path, write=other.write, present=other.present, file=other.path)

    backups = list((tmp_path / "backups" / "codex.hook-trust").rglob("*.bak"))
    assert len(backups) == convenience.BACKUPS_PER_TARGET + 1
    newest = gate.history("codex.hook-trust")[1]["backup"]
    assert Path(newest).is_file()

    config.write_text("", encoding="utf-8")
    assert gate.apply(
        "codex.hook-trust", config, write=add_row, present=lambda: False, file=config
    ) == "removed"

    [kept_other] = [e["backup"] for e in gate.history("codex.hook-trust") if e["target"] == str(other.path)]
    assert sorted(map(str, (tmp_path / "backups" / "codex.hook-trust").rglob("*.bak"))) == sorted(
        [newest, kept_other]
    )


def test_switch_flips_and_the_upgrade_ack_are_announced_and_say_who_did_it(gate, tmp_path) -> None:
    """A10: moving a switch changes what Navide may do to the user's files,
    so it is announced like any write, and the log says where it came from."""
    _apply(gate, _File(tmp_path / "settings.json", "# navide\n"))
    gate.finish_startup_scan()

    gate.set_allowed("cursor.project-mcp", False, source="settings")
    gate.set_allowed("cursor.project-mcp", True, source="ws-client")
    gate.acknowledge_upgrade(source="ws-client")

    off, allowed = gate.history("cursor.project-mcp")[::-1]
    assert (off["action"], off["notify"], off["source"]) == ("off", True, "settings")
    assert (allowed["action"], allowed["notify"], allowed["source"]) == ("allowed", True, "ws-client")
    assert [n["entry"]["action"] for n in gate.sent[-3:-1]] == ["off", "allowed"]
    # R3-L4: dismissing the one-time upgrade notice is the user's say-so on
    # every feature it named, so an agent doing it must not go unseen.
    [ack] = [e for e in gate.history("claude.hooks") if e["action"] == "allowed"]
    assert (ack["source"], ack["notify"]) == ("ws-client", True)
    assert "upgrade notice" in ack["detail"]
    assert gate.sent[-1]["entry"]["id"] == ack["id"]


def test_a_log_written_before_the_source_column_still_reads(tmp_path) -> None:
    db = Database(tmp_path / "navide.db")
    with db.transaction() as cur:
        cur.execute(
            "CREATE TABLE convenience_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,"
            " feature TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL,"
            " detail TEXT NOT NULL, backup TEXT NOT NULL, notify INTEGER NOT NULL)"
        )
        cur.execute(
            "INSERT INTO convenience_log (at, feature, action, target, detail, backup, notify)"
            " VALUES (1, 'claude.hooks', 'first', 't', '', '', 1)"
        )

    gate = convenience.ConvenienceGate(db, backup_root=tmp_path / "b")

    assert gate.history()[0]["source"] == ""


def test_a_workspace_spelled_in_another_unicode_form_has_one_key(tmp_path) -> None:
    """R4-L4: "café" typed precomposed (NFC) and stored decomposed (NFD) is
    one folder on a normalization-insensitive volume; it must be one key."""
    import unicodedata

    nfd = unicodedata.normalize("NFD", "café")
    nfc = unicodedata.normalize("NFC", "café")
    (tmp_path / nfd).mkdir()
    if not (tmp_path / nfc).exists():
        pytest.skip("this file system tells the two spellings apart")

    assert convenience.canonical_path(tmp_path / nfc) == convenience.canonical_path(tmp_path / nfd)


def test_an_offline_mount_in_the_ledger_never_holds_up_the_gate(gate, tmp_path, monkeypatch) -> None:
    """Respelling a recorded workspace stats every folder on its path; one on
    an offline network mount can hang. That must happen outside the gate's
    lock and give up in bounded time, so creating another pane never waits
    on it."""
    import threading

    stuck = threading.Event()
    real = convenience.respelled

    def respelled(target: str) -> str:
        if target.startswith("/offline/"):
            stuck.wait(30)
        return real(target)

    monkeypatch.setattr(convenience, "respelled", respelled)
    monkeypatch.setattr(convenience, "_RESPELL_TIMEOUT_S", 0.2)
    gate._mark("cursor.project-skills", "/offline/ws/.cursor/skills", present=True)
    gate.record("cursor.project-skills", "refused-unsafe", "/offline/ws/.cursor/skills")
    workspace = tmp_path / "ws" / ".cursor" / "skills"
    results: list[object] = []

    def run() -> None:
        results.append(gate.apply(
            "cursor.project-skills", workspace, write=lambda: None, present=lambda: False, per_target=True,
        ))
        results.append(gate.record_once("cursor.project-skills", "refused-unsafe", workspace))

    worker = threading.Thread(target=run, daemon=True)
    try:
        worker.start()
        worker.join(5)
        assert not worker.is_alive()
        assert len(results) == 2 and results[1] is True
        holder = threading.Thread(target=lambda: gate.allowed("claude.hooks"), daemon=True)
        holder.start()
        holder.join(2)
        assert not holder.is_alive()
    finally:
        stuck.set()
        worker.join(5)


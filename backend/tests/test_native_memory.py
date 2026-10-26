"""The CLI instruction files: what the table lists, and what it refuses."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import app, applog, native_memory
from agent_team_backend.cli_vendors.registry import VENDORS


def _write(root: Path, relative: tuple[str, ...], text: str = "body\n") -> Path:
    path = root.joinpath(*relative)
    path.parent.mkdir(parents=True, exist_ok=True)
    # newline="" keeps the byte count the size assertions compare against:
    # text mode on Windows would write "\r\n" for every "\n".
    path.write_text(text, encoding="utf-8", newline="")
    return path


def _home(tmp_path: Path) -> Path:
    home = tmp_path / "home"
    home.mkdir()
    return home


def _by_relative(files: list[native_memory.MemoryFile]) -> dict[str, native_memory.MemoryFile]:
    return {f.relative: f for f in files}


# ---- scan -----------------------------------------------------------------


def test_canonical_files_are_listed_before_they_exist(tmp_path: Path) -> None:
    """A canonical row is an offer to create the file; the others are not."""
    home = _home(tmp_path)

    found = _by_relative(native_memory.scan(home))

    canonical = found[".claude/CLAUDE.md"]
    assert canonical.exists is False
    assert canonical.canonical is True
    assert canonical.size == 0 and canonical.modified == 0.0
    # pi reads ~/.pi/agent/CLAUDE.md but does not own it: nothing to offer.
    assert ".pi/agent/CLAUDE.md" not in found


def test_one_file_lists_every_reader_once(tmp_path: Path) -> None:
    home = _home(tmp_path)
    _write(home, (".claude", "CLAUDE.md"), "shared\n")

    rows = [f for f in native_memory.scan(home) if f.relative == ".claude/CLAUDE.md"]

    assert len(rows) == 1
    assert rows[0].readers == ("claude", "kilo", "opencode")
    assert rows[0].canonical is True
    assert rows[0].exists is True
    assert rows[0].size == len("shared\n")


def test_readers_do_not_change_when_the_file_is_created(tmp_path: Path) -> None:
    """Creating a file must not appear to add readers it always had."""
    home = _home(tmp_path)

    before = _by_relative(native_memory.scan(home))[".claude/CLAUDE.md"]
    _write(home, (".claude", "CLAUDE.md"), "shared\n")
    after = _by_relative(native_memory.scan(home))[".claude/CLAUDE.md"]

    assert before.readers == after.readers == ("claude", "kilo", "opencode")


@pytest.mark.parametrize(
    ("relative", "agent"),
    [
        # The five paths established on 2026-08-28 by reading the code that
        # builds them, not a filename string: regressions here mean the table
        # drifted away from what the CLI actually loads.
        ((".gemini", "GEMINI.md"), "antigravity"),
        ((".gemini", "config", "AGENTS.md"), "antigravity"),
        ((".factory", "AGENTS.md"), "droid"),
        ((".config", "muse", "AGENTS.md"), "muse"),
        ((".cursor", "rules", "style.mdc"), "cursor"),
    ],
)
def test_user_scope_paths_verified_against_the_binaries(
    tmp_path: Path, relative: tuple[str, ...], agent: str
) -> None:
    home = _home(tmp_path)
    _write(home, relative)

    found = _by_relative(native_memory.scan(home))

    assert agent in found["/".join(relative)].readers


def test_glob_sources_expand_to_individual_files(tmp_path: Path) -> None:
    home = _home(tmp_path)
    workspace = tmp_path / "project"
    _write(workspace, (".cursor", "rules", "style.mdc"))
    _write(workspace, (".cursor", "rules", "nested", "tests.mdc"))
    _write(workspace, (".cursor", "rules", "notes.txt"))

    found = _by_relative(native_memory.scan(home, workspace))

    assert ".cursor/rules/style.mdc" in found
    assert ".cursor/rules/nested/tests.mdc" in found
    assert ".cursor/rules/notes.txt" not in found
    assert found[".cursor/rules/style.mdc"].readers == ("cursor",)
    # An expanded rule is a file the user already wrote, never an offer.
    assert found[".cursor/rules/style.mdc"].canonical is False


def test_without_a_workspace_only_user_scope_is_listed(tmp_path: Path) -> None:
    home = _home(tmp_path)
    workspace = tmp_path / "project"
    _write(workspace, ("AGENTS.md",))

    assert {f.scope for f in native_memory.scan(home)} == {native_memory.USER_SCOPE}
    assert native_memory.PROJECT_SCOPE in {
        f.scope for f in native_memory.scan(home, workspace)
    }


def test_existing_files_sort_before_missing_ones(tmp_path: Path) -> None:
    home = _home(tmp_path)
    workspace = tmp_path / "project"
    _write(workspace, ("AGENTS.md",))
    _write(home, (".qwen", "QWEN.md"))

    files = native_memory.scan(home, workspace)

    existing = [i for i, f in enumerate(files) if f.exists]
    missing = [i for i, f in enumerate(files) if not f.exists]
    assert existing and missing
    assert max(existing) < min(missing)


# ---- read / save allow-list ----------------------------------------------


@pytest.mark.parametrize("relative", [("stray.md",), ("sub", "..", "AGENTS.md")])
def test_read_and_save_refuse_paths_the_table_does_not_name(
    tmp_path: Path, relative: tuple[str, ...]
) -> None:
    home = _home(tmp_path)
    workspace = tmp_path / "project"
    workspace.mkdir()
    outsider = str(workspace.joinpath(*relative))

    with pytest.raises(ValueError):
        native_memory.read(outsider, home, workspace)
    with pytest.raises(ValueError):
        native_memory.save(outsider, "x", home, workspace)


def test_read_reports_a_listed_file_that_does_not_exist_yet(tmp_path: Path) -> None:
    home = _home(tmp_path)

    result = native_memory.read(str(home / ".claude" / "CLAUDE.md"), home)

    assert result == {"path": str(home / ".claude" / "CLAUDE.md"), "text": "", "exists": False}


def test_save_creates_the_parent_and_writes_atomically(tmp_path: Path) -> None:
    home = _home(tmp_path)
    target = home / ".codex" / "AGENTS.md"

    result = native_memory.save(str(target), "be brief\n", home)

    assert target.read_text(encoding="utf-8") == "be brief\n"
    assert result["path"] == str(target)
    assert result["size"] == len("be brief\n")
    # The rename must leave no temp file behind.
    assert [p.name for p in target.parent.iterdir()] == ["AGENTS.md"]


def test_save_refuses_a_file_that_moved_on_since_it_was_read(tmp_path: Path) -> None:
    """The CLIs rewrite these files too; a stale editor must not win."""
    home = _home(tmp_path)
    target = _write(home, (".codex", "AGENTS.md"), "original\n")
    opened_at = native_memory.read(str(target), home)["modified"]

    # Something else writes the file while the editor is open.
    os.utime(target, (opened_at + 10, opened_at + 10))

    with pytest.raises(native_memory.MemoryConflictError):
        native_memory.save(str(target), "mine\n", home, expected_modified=opened_at)
    assert target.read_text(encoding="utf-8") == "original\n"

    # Reading again adopts the new mtime, and the save goes through.
    fresh = native_memory.read(str(target), home)["modified"]
    saved = native_memory.save(str(target), "mine\n", home, expected_modified=fresh)
    assert target.read_text(encoding="utf-8") == "mine\n"
    # The result carries the new mtime, so a second save is not a conflict.
    native_memory.save(str(target), "again\n", home, expected_modified=saved["modified"])


def test_creating_a_file_someone_else_just_created_is_a_conflict(tmp_path: Path) -> None:
    """A file that did not exist reads as mtime 0; anything else means lost work."""
    home = _home(tmp_path)
    target = home / ".grok" / "AGENTS.md"
    assert native_memory.read(str(target), home)["exists"] is False

    _write(home, (".grok", "AGENTS.md"), "theirs\n")

    with pytest.raises(native_memory.MemoryConflictError):
        native_memory.save(str(target), "mine\n", home, expected_modified=0.0)
    assert target.read_text(encoding="utf-8") == "theirs\n"


def test_save_and_read_refuse_anything_over_the_size_limit(tmp_path: Path) -> None:
    home = _home(tmp_path)
    target = home / ".qwen" / "QWEN.md"
    oversized = "x" * (native_memory.FILE_SIZE_LIMIT + 1)

    with pytest.raises(ValueError):
        native_memory.save(str(target), oversized, home)
    assert not target.exists()

    _write(home, (".qwen", "QWEN.md"), oversized)
    with pytest.raises(ValueError):
        native_memory.read(str(target), home)


# ---- agent coverage -------------------------------------------------------


def test_every_vendor_is_mapped_or_configured(tmp_path: Path) -> None:
    """No CLI is left unaccounted for: the table names it, or its config does."""
    by_agent = {target["agent"]: target for target in native_memory.agent_targets()}

    assert set(by_agent) == set(VENDORS)
    assert {t["state"] for t in by_agent.values()} <= {"mapped", "configured"}
    assert by_agent["claude"]["state"] == "mapped"
    assert by_agent["claude"]["scopes"] == ["project", "user"]
    # aider knows no filename of its own; .aider.conf.yml's read: names them.
    assert by_agent["aider"]["state"] == "configured"
    assert by_agent["aider"]["scopes"] == ["user", "project"]


def test_aider_lists_the_files_its_config_names(tmp_path: Path) -> None:
    home = _home(tmp_path)
    workspace = tmp_path / "project"
    conventions = _write(workspace, ("CONVENTIONS.md",), "use tabs\n")
    house_style = _write(home, ("house-style.md",), "be brief\n")
    _write(workspace, (native_memory.AIDER_CONFIG,), "read:\n  - CONVENTIONS.md\n")
    _write(home, (native_memory.AIDER_CONFIG,), f"read: {house_style}\n")

    found = {f.path: f for f in native_memory.scan(home, workspace)}

    assert found[str(conventions)].readers == ("aider",)
    assert found[str(conventions)].scope == native_memory.PROJECT_SCOPE
    assert found[str(house_style)].scope == native_memory.USER_SCOPE
    # A configured file is editable: it is in the allow-list like any other.
    native_memory.save(str(conventions), "use spaces\n", home, workspace)
    assert conventions.read_text(encoding="utf-8") == "use spaces\n"


def test_aider_ignores_config_entries_that_are_not_files(tmp_path: Path) -> None:
    """A missing path or a directory would make the page offer to edit neither."""
    home = _home(tmp_path)
    workspace = tmp_path / "project"
    (workspace / "rules").mkdir(parents=True)
    _write(workspace, (native_memory.AIDER_CONFIG,), "read:\n  - rules\n  - gone.md\n")

    assert [f for f in native_memory.scan(home, workspace) if "aider" in f.readers] == []


def test_a_workspace_aider_config_cannot_reach_outside_the_workspace(
    tmp_path: Path,
) -> None:
    """A cloned repo must not be able to put ~/.ssh in the allow-list."""
    home = _home(tmp_path)
    workspace = tmp_path / "project"
    secret = _write(home, (".ssh", "id_rsa"), "PRIVATE KEY\n")
    outside = _write(tmp_path, ("elsewhere.md",), "not yours\n")
    _write(
        workspace,
        (native_memory.AIDER_CONFIG,),
        f"read:\n  - {secret}\n  - {outside}\n  - ../elsewhere.md\n  - ~/.ssh/id_rsa\n",
    )

    listed = {f.path for f in native_memory.scan(home, workspace)}

    assert str(secret) not in listed
    assert str(outside) not in listed
    for path in (secret, outside):
        with pytest.raises(ValueError):
            native_memory.read(str(path), home, workspace)
        with pytest.raises(ValueError):
            native_memory.save(str(path), "owned\n", home, workspace)
    assert secret.read_text(encoding="utf-8") == "PRIVATE KEY\n"


def test_the_home_aider_config_stays_out_of_hidden_directories(tmp_path: Path) -> None:
    home = _home(tmp_path)
    workspace = tmp_path / "project"
    workspace.mkdir()
    hidden = _write(home, (".ssh", "config"), "Host *\n")
    plain = _write(home, ("notes", "style.md"), "be brief\n")
    _write(home, (native_memory.AIDER_CONFIG,), f"read:\n  - {hidden}\n  - {plain}\n")

    listed = {f.path for f in native_memory.scan(home, workspace)}

    assert str(hidden) not in listed
    assert str(plain) in listed


@pytest.mark.parametrize("relative", [("AGENTS.md",), (".cursor", "rules", "evil.mdc")])
def test_a_project_row_that_links_out_of_the_workspace_is_dropped(
    tmp_path: Path, relative: tuple[str, ...]
) -> None:
    """Repository content can be a symlink someone else wrote."""
    home = _home(tmp_path)
    workspace = tmp_path / "project"
    secret = _write(home, (".ssh", "id_rsa"), "PRIVATE KEY\n")
    link = workspace.joinpath(*relative)
    link.parent.mkdir(parents=True, exist_ok=True)
    link.symlink_to(secret)

    listed = {f.path for f in native_memory.scan(home, workspace)}

    assert str(link) not in listed
    with pytest.raises(ValueError):
        native_memory.save(str(link), "owned\n", home, workspace)
    assert secret.read_text(encoding="utf-8") == "PRIVATE KEY\n"


def test_a_symlinked_parent_directory_cannot_be_written_through(
    tmp_path: Path,
) -> None:
    """save() creates its temp file in the parent, so the parent must be checked.

    The file inside a symlinked ``.github`` does not exist yet, so an
    existence test alone would let a cloned repo place a file in ~/.ssh.
    """
    home = _home(tmp_path)
    workspace = tmp_path / "project"
    workspace.mkdir()
    outside = home / ".ssh"
    outside.mkdir()
    (workspace / ".github").symlink_to(outside)
    target = workspace / ".github" / "copilot-instructions.md"

    assert str(target) not in {f.path for f in native_memory.scan(home, workspace)}
    with pytest.raises(ValueError):
        native_memory.save(str(target), "owned\n", home, workspace)
    assert list(outside.iterdir()) == []


def test_a_dangling_project_link_is_not_offered(tmp_path: Path) -> None:
    home = _home(tmp_path)
    workspace = tmp_path / "project"
    workspace.mkdir()
    (workspace / "AGENTS.md").symlink_to(home / "gone.md")

    listed = {f.relative for f in native_memory.scan(home, workspace)}

    assert "AGENTS.md" not in listed


def test_a_home_row_may_be_a_symlink(tmp_path: Path) -> None:
    """Dotfiles managed in git are the normal way to keep instructions."""
    home = _home(tmp_path)
    real = _write(tmp_path, ("dotfiles", "CLAUDE.md"), "from git\n")
    link = home / ".claude" / "CLAUDE.md"
    link.parent.mkdir(parents=True, exist_ok=True)
    link.symlink_to(real)

    found = _by_relative(native_memory.scan(home))[".claude/CLAUDE.md"]

    assert found.exists is True
    assert native_memory.read(str(link), home)["text"] == "from git\n"


def test_a_broken_aider_config_is_skipped_not_fatal(tmp_path: Path) -> None:
    home = _home(tmp_path)
    workspace = tmp_path / "project"
    _write(workspace, (native_memory.AIDER_CONFIG,), "read: [unclosed\n")

    assert native_memory.scan(home, workspace)  # the other CLIs still list


# ---- WebSocket surface ----------------------------------------------------


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


async def _request(msg_type: str, payload: dict[str, Any]) -> dict[str, Any]:
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    await app.handle_message(session, {"id": "m-1", "type": msg_type, "payload": payload})
    return session.websocket.sent[-1]  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_memory_list_returns_files_agents_and_workspace(tmp_path: Path) -> None:
    workspace = tmp_path / "project"
    _write(workspace, ("AGENTS.md",), "project rules\n")

    listed = await _request("memory.list", {"workspace_path": str(workspace)})

    assert listed["ok"] is True
    assert listed["payload"]["workspace_path"] == str(workspace)
    assert {a["agent"] for a in listed["payload"]["agents"]} == set(VENDORS)
    project = [f for f in listed["payload"]["files"] if f["relative"] == "AGENTS.md"]
    assert len(project) == 1
    assert project[0]["exists"] is True
    assert "codex" in project[0]["readers"]


@pytest.mark.asyncio
async def test_memory_get_rejects_a_path_outside_the_table(tmp_path: Path) -> None:
    workspace = tmp_path / "project"
    workspace.mkdir()

    reply = await _request(
        "memory.get",
        {"workspace_path": str(workspace), "path": str(workspace / "stray.md")},
    )

    assert reply["ok"] is False
    assert reply["error"]["code"] == "MEMORY_FILE_REJECTED"
    assert reply["error"]["details"]["path"] == str(workspace / "stray.md")


@pytest.mark.asyncio
async def test_memory_save_without_text_is_rejected(tmp_path: Path) -> None:
    workspace = tmp_path / "project"
    workspace.mkdir()
    target = workspace / "AGENTS.md"

    reply = await _request(
        "memory.save", {"workspace_path": str(workspace), "path": str(target)}
    )

    assert reply["ok"] is False
    assert reply["error"]["code"] == "MEMORY_FILE_REJECTED"
    assert not target.exists()


# ---- previous version -------------------------------------------------------


def test_a_save_keeps_the_replaced_text_in_navides_own_folder(tmp_path: Path) -> None:
    """The file is the CLI's, so the version a save replaces is kept aside --
    in the app data dir, never next to the file -- and can be written back."""
    home = _home(tmp_path)
    target = _write(home, (".codex", "AGENTS.md"), "original\n")

    assert "previous" not in native_memory.read(str(target), home)
    saved = native_memory.save(str(target), "mine\n", home)

    assert saved["previous"]["size"] == len("original\n")
    kept = list((applog.app_data_dir() / native_memory.BACKUP_DIR_NAME).glob("*.txt"))
    assert [p.read_text(encoding="utf-8") for p in kept] == ["original\n"]
    assert [p.name for p in target.parent.iterdir()] == ["AGENTS.md"]
    assert native_memory.read(str(target), home)["previous"]["size"] == len("original\n")

    restored = native_memory.restore_previous(
        str(target), home, expected_modified=saved["modified"]
    )

    assert target.read_text(encoding="utf-8") == "original\n"
    # Restoring kept what it replaced, so the restore is undone the same way.
    assert restored["previous"]["size"] == len("mine\n")
    native_memory.restore_previous(str(target), home)
    assert target.read_text(encoding="utf-8") == "mine\n"


def test_creating_a_file_keeps_nothing_and_offers_no_restore(tmp_path: Path) -> None:
    home = _home(tmp_path)
    target = home / ".codex" / "AGENTS.md"

    saved = native_memory.save(str(target), "new\n", home)

    assert "previous" not in saved
    with pytest.raises(ValueError):
        native_memory.restore_previous(str(target), home)


def test_an_unchanged_save_keeps_the_older_previous_version(tmp_path: Path) -> None:
    home = _home(tmp_path)
    target = _write(home, (".codex", "AGENTS.md"), "one\n")
    native_memory.save(str(target), "two\n", home)

    native_memory.save(str(target), "two\n", home)

    native_memory.restore_previous(str(target), home)
    assert target.read_text(encoding="utf-8") == "one\n"


def test_restore_refuses_a_file_that_moved_on_and_unlisted_paths(tmp_path: Path) -> None:
    home = _home(tmp_path)
    target = _write(home, (".codex", "AGENTS.md"), "one\n")
    saved = native_memory.save(str(target), "two\n", home)
    os.utime(target, (saved["modified"] + 10, saved["modified"] + 10))

    with pytest.raises(native_memory.MemoryConflictError):
        native_memory.restore_previous(str(target), home, expected_modified=saved["modified"])
    assert target.read_text(encoding="utf-8") == "two\n"
    with pytest.raises(ValueError):
        native_memory.restore_previous(str(home / "stray.md"), home)


@pytest.mark.asyncio
async def test_memory_restore_writes_back_the_previous_version(tmp_path: Path) -> None:
    workspace = tmp_path / "project"
    target = _write(workspace, ("AGENTS.md",), "original\n")
    saved = await _request(
        "memory.save",
        {"workspace_path": str(workspace), "path": str(target), "text": "mine\n"},
    )
    assert saved["payload"]["previous"]["size"] == len("original\n")

    reply = await _request(
        "memory.restore",
        {
            "workspace_path": str(workspace),
            "path": str(target),
            "expected_modified": saved["payload"]["modified"],
        },
    )

    assert reply["ok"] is True
    assert target.read_text(encoding="utf-8") == "original\n"


@pytest.mark.asyncio
async def test_memory_restore_without_a_previous_version_is_rejected(tmp_path: Path) -> None:
    workspace = tmp_path / "project"
    target = _write(workspace, ("AGENTS.md",), "original\n")

    reply = await _request(
        "memory.restore", {"workspace_path": str(workspace), "path": str(target)}
    )

    assert reply["ok"] is False
    assert reply["error"]["code"] == "MEMORY_FILE_REJECTED"
    assert target.read_text(encoding="utf-8") == "original\n"


# ---- Claude auto-memory -------------------------------------------------------


def _auto_memory(home: Path, workspace: Path) -> Path:
    folder = native_memory.auto_memory_dir(home, workspace)
    assert folder is not None
    folder.mkdir(parents=True)
    return folder


def test_the_project_slug_matches_claude_code() -> None:
    """Every non-alphanumeric UTF-16 unit becomes "-", and a name past 200
    characters is cut and suffixed with Claude's hash (values from
    Claude Code 2.1.310, computed in JavaScript)."""
    assert native_memory._claude_project_slug("/Users/x/my.proj_1") == "-Users-x-my-proj-1"
    assert native_memory._claude_project_slug("/Users/x/客戶") == "-Users-x---"
    assert native_memory._claude_project_slug("/x/\U0001F600") == "-x---"
    long = native_memory._claude_project_slug("/x/" + "a" * 300)
    assert long == "-x-" + "a" * 197 + "-rtseee"


def test_a_worktree_shares_the_main_checkouts_auto_memory(tmp_path: Path) -> None:
    """Claude keys auto-memory by repository: a linked worktree and a
    subdirectory both resolve to the main working tree."""
    home = _home(tmp_path)
    main = tmp_path / "repo"
    (main / ".git" / "worktrees" / "wt").mkdir(parents=True)
    (main / ".git" / "worktrees" / "wt" / "commondir").write_text("../..\n", encoding="utf-8")
    (main / "src").mkdir()
    worktree = tmp_path / "wt"
    worktree.mkdir()
    (worktree / ".git").write_text(f"gitdir: {main / '.git' / 'worktrees' / 'wt'}\n", encoding="utf-8")

    expected = native_memory.auto_memory_dir(home, main)

    assert expected == (
        home / ".claude" / "projects" / native_memory._claude_project_slug(str(main.resolve())) / "memory"
    )
    assert native_memory.auto_memory_dir(home, worktree) == expected
    assert native_memory.auto_memory_dir(home, main / "src") == expected
    assert native_memory.auto_memory_dir(home, None) is None


def test_auto_memory_files_are_listed_as_claude_written_project_rows(tmp_path: Path) -> None:
    home = _home(tmp_path)
    workspace = tmp_path / "project"
    workspace.mkdir()
    folder = _auto_memory(home, workspace)
    _write(folder, ("MEMORY.md",), "- [Topic](topic.md)\n")
    _write(folder, ("topic.md",), "a fact\n")
    _write(folder, ("notes.txt",), "not markdown\n")
    _write(folder, ("proposals", "draft.md"), "nested\n")

    rows = [f for f in native_memory.scan(home, workspace) if f.auto_memory]

    assert [(f.relative, f.scope, f.readers, f.canonical) for f in rows] == [
        ("MEMORY.md", native_memory.PROJECT_SCOPE, ("claude",), False),
        ("topic.md", native_memory.PROJECT_SCOPE, ("claude",), False),
    ]
    assert rows[0].as_dict()["auto_memory"] is True
    # Nothing is offered for creation, and nothing is listed without a workspace.
    assert not [f for f in native_memory.scan(home, None) if f.auto_memory]
    assert all(
        f.as_dict()["auto_memory"] is False
        for f in native_memory.scan(home, workspace)
        if not f.auto_memory
    )


def test_an_auto_memory_link_out_of_its_folder_is_not_offered(tmp_path: Path) -> None:
    home = _home(tmp_path)
    workspace = tmp_path / "project"
    workspace.mkdir()
    folder = _auto_memory(home, workspace)
    secret = _write(home, (".ssh", "notes.md"), "private\n")
    (folder / "linked.md").symlink_to(secret)

    assert not [f for f in native_memory.scan(home, workspace) if f.auto_memory]
    with pytest.raises(ValueError):
        native_memory.read(str(folder / "linked.md"), home, workspace)


def test_an_auto_memory_file_saves_and_restores_like_any_other(tmp_path: Path) -> None:
    home = _home(tmp_path)
    workspace = tmp_path / "project"
    workspace.mkdir()
    target = _write(_auto_memory(home, workspace), ("MEMORY.md",), "claude wrote\n")

    read = native_memory.read(str(target), home, workspace)
    saved = native_memory.save(
        str(target), "user edit\n", home, workspace, expected_modified=read["modified"]
    )

    assert target.read_text(encoding="utf-8") == "user edit\n"
    assert saved["previous"]["size"] == len("claude wrote\n")
    native_memory.restore_previous(str(target), home, workspace, saved["modified"])
    assert target.read_text(encoding="utf-8") == "claude wrote\n"
    # Another project's memory folder is not reachable from this workspace.
    other = tmp_path / "other"
    other.mkdir()
    with pytest.raises(ValueError):
        native_memory.save(str(target), "x\n", home, other)


@pytest.mark.asyncio
async def test_memory_list_names_the_auto_memory_folder(tmp_path: Path) -> None:
    workspace = tmp_path / "project"
    workspace.mkdir()

    listed = await _request("memory.list", {"workspace_path": str(workspace)})
    without = await _request("memory.list", {})

    assert listed["payload"]["auto_memory_dir"] == str(
        native_memory.auto_memory_dir(None, workspace)
    )
    assert without["payload"]["auto_memory_dir"] == ""

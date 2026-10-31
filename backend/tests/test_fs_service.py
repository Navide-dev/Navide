"""fs_service — path safety + list_dir(show_hidden) + CRUD round-trips."""

from __future__ import annotations

import base64
import stat
from pathlib import Path

import pytest

from agent_team_backend import fs_service, osplat


def _ws(tmp_path: Path) -> str:
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "main.ts").write_text("x", encoding="utf-8")
    (tmp_path / "README.md").write_text("hi", encoding="utf-8")
    (tmp_path / ".env").write_text("SECRET=1", encoding="utf-8")
    (tmp_path / ".agent-team").mkdir()
    (tmp_path / ".agent-team" / "project.json").write_text("{}", encoding="utf-8")
    return str(tmp_path)


# ── Path safety ─────────────────────────────────────────────────────────────
def test_list_rejects_parent_escape(tmp_path: Path) -> None:
    res = fs_service.list_dir(_ws(tmp_path), "../..")
    assert res["ok"] is False
    assert "escape" in res["error"].lower()


def test_list_rejects_absolute_escape(tmp_path: Path) -> None:
    res = fs_service.list_dir(_ws(tmp_path), "/etc")
    # leading slash is stripped → resolves to <ws>/etc which does not exist
    assert res["ok"] is False


def test_internal_dir_lists_but_hides_its_state(tmp_path: Path) -> None:
    """The dir itself is listable so the file tree can show plans/reports.

    Everything else in it — the live SQLite database, logs, migration
    leftovers — must not surface: naming a file there is the first half of
    opening or deleting it.
    """
    res = fs_service.list_dir(_ws(tmp_path), ".agent-team")
    assert res["ok"] is True
    assert [e["name"] for e in res["entries"]] == []  # project.json stays out


def test_internal_dir_contents_stay_unreadable(tmp_path: Path) -> None:
    """Listing the dir grants nothing below it."""
    ws = _ws(tmp_path)
    for res in (
        fs_service.read_file(ws, ".agent-team/project.json"),
        fs_service.write_file(ws, ".agent-team/evil.json", "x"),
        fs_service.list_dir(ws, ".agent-team/nested"),
    ):
        assert res["ok"] is False
        assert "protected" in res["error"].lower()


def test_no_workspace(tmp_path: Path) -> None:
    assert fs_service.list_dir("", "")["ok"] is False


# ── .agent-team/plans exemption ─────────────────────────────────────────────
def _ws_with_plans(tmp_path: Path) -> str:
    ws = _ws(tmp_path)
    plans = tmp_path / ".agent-team" / "plans"
    plans.mkdir()
    (plans / "_spec.md").write_text("spec", encoding="utf-8")
    (plans / "my-plan.html").write_text("<h1>plan</h1>", encoding="utf-8")
    return ws


def test_plans_subtree_list_allowed(tmp_path: Path) -> None:
    res = fs_service.list_dir(_ws_with_plans(tmp_path), ".agent-team/plans")
    assert res["ok"] is True
    names = [e["name"] for e in res["entries"]]
    assert "my-plan.html" in names


def test_plans_subtree_read_allowed(tmp_path: Path) -> None:
    res = fs_service.read_file(_ws_with_plans(tmp_path), ".agent-team/plans/my-plan.html")
    assert res["ok"] is True
    assert res["content"] == "<h1>plan</h1>"


def test_reports_subtree_allowed(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    reports = tmp_path / ".agent-team" / "reports"
    reports.mkdir()
    (reports / "report.html").write_text("<h1>report</h1>", encoding="utf-8")

    res = fs_service.read_file(ws, ".agent-team/reports/report.html")
    assert res["ok"] is True
    assert res["content"] == "<h1>report</h1>"

    list_res = fs_service.list_dir(ws, ".agent-team/reports")
    assert list_res["ok"] is True
    assert "report.html" in [e["name"] for e in list_res["entries"]]


def test_plans_subtree_write_allowed(tmp_path: Path) -> None:
    ws = _ws_with_plans(tmp_path)
    assert fs_service.write_file(ws, ".agent-team/plans/new.html", "<p>x</p>")["ok"] is True
    assert (tmp_path / ".agent-team" / "plans" / "new.html").read_text() == "<p>x</p>"


def test_plans_subtree_delete_allowed(tmp_path: Path, monkeypatch) -> None:
    _fake_trash(monkeypatch)
    ws = _ws_with_plans(tmp_path)
    assert fs_service.delete(ws, ".agent-team/plans/my-plan.html")["ok"] is True
    assert not (tmp_path / ".agent-team" / "plans" / "my-plan.html").exists()


def test_internal_dir_cannot_be_deleted_or_renamed(tmp_path: Path) -> None:
    """Now that it shows in the tree, the destructive menu items must refuse.

    Listing is the only thing the exemption grants; every mutation path
    resolves without it and still hits the guard.
    """
    ws = _ws(tmp_path)
    for res in (
        fs_service.delete(ws, ".agent-team"),
        fs_service.rename(ws, ".agent-team", "team"),
    ):
        assert res["ok"] is False
        assert "protected" in res["error"].lower()
    assert (tmp_path / ".agent-team").is_dir()


def test_agent_team_root_lists_only_the_user_facing_subtrees(tmp_path: Path) -> None:
    ws = _ws_with_plans(tmp_path)
    (tmp_path / ".agent-team" / "reports").mkdir()
    (tmp_path / ".agent-team" / "navide.db").write_text("sqlite", encoding="utf-8")
    res = fs_service.list_dir(ws, ".agent-team")
    assert res["ok"] is True
    assert sorted(e["name"] for e in res["entries"]) == ["plans", "reports"]


def test_agent_team_sibling_still_protected(tmp_path: Path) -> None:
    res = fs_service.read_file(_ws_with_plans(tmp_path), ".agent-team/project.json")
    assert res["ok"] is False
    assert "protected" in res["error"].lower()


def test_plans_traversal_still_protected(tmp_path: Path) -> None:
    ws = _ws_with_plans(tmp_path)
    for op, rel in (
        ("read", ".agent-team/plans/../project.json"),
        ("write", ".agent-team/plans/../evil.json"),
        ("delete", ".agent-team/plans/../project.json"),
    ):
        if op == "read":
            res = fs_service.read_file(ws, rel)
        elif op == "write":
            res = fs_service.write_file(ws, rel, "x")
        else:
            res = fs_service.delete(ws, rel)
        assert res["ok"] is False, f"{op} {rel} should be blocked"
        assert "protected" in res["error"].lower()


def test_internal_dir_protected_when_named_as_the_root(tmp_path: Path) -> None:
    """Rooting at .agent-team itself must not step around the guard.

    Any existing directory is accepted as a root (that is how files outside a
    workspace are opened), so a root of `<ws>/.agent-team` would leave a
    root-relative check inspecting a filename where it expects the internal dir.
    """
    _ws_with_plans(tmp_path)
    internal = str(tmp_path / ".agent-team")
    for res in (
        fs_service.read_file(internal, "project.json"),
        fs_service.list_dir(internal, ""),
        fs_service.write_file(internal, "evil.json", "x"),
    ):
        assert res["ok"] is False
        assert "protected" in res["error"].lower()


def test_plans_subtree_still_reachable_when_named_as_the_root(tmp_path: Path) -> None:
    """The user-facing subtrees stay open however the root is expressed."""
    _ws_with_plans(tmp_path)
    plans = str(tmp_path / ".agent-team" / "plans")
    assert fs_service.read_file(plans, "my-plan.html")["ok"] is True
    assert fs_service.list_dir(plans, "")["ok"] is True


@pytest.mark.parametrize("root_rel", ["", ".agent-team", ".agent-team/mockups"])
def test_mockups_readable_under_each_root(tmp_path: Path, root_rel: str) -> None:
    _ws(tmp_path)
    mockups = tmp_path / ".agent-team" / "mockups"
    mockups.mkdir()
    document = mockups / "preview.html"
    document.write_text("<h1>mockup</h1>")
    root = tmp_path / root_rel
    rel = str(document.relative_to(root))

    result = fs_service.read_file(str(root), rel)
    assert result["ok"] is True, result
    assert result["content"] == "<h1>mockup</h1>"
    assert fs_service.stat_workspace_path(str(root), rel)["exists"] is True
    listing = fs_service.list_dir(str(root), str(mockups.relative_to(root)))
    assert [entry["name"] for entry in listing["entries"]] == ["preview.html"]


@pytest.mark.parametrize("mode", ["display", "discovery"])
def test_mockups_visible_without_exposing_internal_state(tmp_path: Path, mode: str) -> None:
    ws = _ws(tmp_path)
    (tmp_path / ".agent-team" / "mockups").mkdir()
    listing = fs_service.list_dir(ws, ".agent-team", show_hidden=True, mode=mode)
    assert [entry["name"] for entry in listing["entries"]] == ["mockups"]


@pytest.mark.parametrize("root_rel", ["", ".agent-team", ".agent-team/mockups"])
def test_mockups_mutations_remain_protected(tmp_path: Path, monkeypatch, root_rel: str) -> None:
    _ws(tmp_path)
    mockups = tmp_path / ".agent-team" / "mockups"
    mockups.mkdir()
    document = mockups / "preview.html"
    document.write_text("original")
    root = tmp_path / root_rel
    ws = str(root)
    rel = str(document.relative_to(root))
    new = str((mockups / "new.html").relative_to(root))
    trash_calls = _fake_trash(monkeypatch)

    for result in (
        fs_service.mkdir(ws, str((mockups / "new-dir").relative_to(root))),
        fs_service.create_file(ws, new, "new"),
        fs_service.write_file(ws, new, "new"),
        fs_service.write_file(ws, rel, "changed", expected_mtime=document.stat().st_mtime),
        fs_service.rename(ws, rel, new),
        fs_service.delete(ws, rel),
    ):
        assert result["ok"] is False
        assert "protected" in result["error"]
    assert document.read_text() == "original"
    assert list(mockups.iterdir()) == [document]
    assert trash_calls == []


def test_mockups_rename_destination_and_symlink_writes_protected(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    mockups = tmp_path / ".agent-team" / "mockups"
    mockups.mkdir()
    document = mockups / "preview.html"
    document.write_text("original")
    (tmp_path / "preview-link.html").symlink_to(document)

    for result in (
        fs_service.rename(ws, "README.md", ".agent-team/mockups/moved.html"),
        fs_service.rename(ws, ".agent-team/mockups/preview.html", "moved.html"),
        fs_service.write_file(ws, "preview-link.html", "changed"),
    ):
        assert result["ok"] is False
        assert "protected" in result["error"]
    assert document.read_text() == "original"
    assert (tmp_path / "README.md").read_text() == "hi"


@pytest.mark.parametrize("subdir", ["plans", "reports"])
def test_existing_user_facing_subtrees_keep_crud(tmp_path: Path, monkeypatch, subdir: str) -> None:
    ws = _ws(tmp_path)
    _fake_trash(monkeypatch)
    directory = f".agent-team/{subdir}/nested"
    original, renamed = f"{directory}/original.html", f"{directory}/renamed.html"
    assert fs_service.mkdir(ws, directory)["ok"] is True
    assert fs_service.create_file(ws, original, "original")["ok"] is True
    assert fs_service.read_file(ws, original)["content"] == "original"
    assert fs_service.write_file(ws, original, "changed")["ok"] is True
    assert fs_service.rename(ws, original, renamed)["ok"] is True
    assert fs_service.read_file(ws, renamed)["content"] == "changed"
    assert fs_service.delete(ws, renamed)["ok"] is True
    assert not (tmp_path / renamed).exists()


# ── list_dir + show_hidden ──────────────────────────────────────────────────
def test_list_hides_dotfiles_by_default(tmp_path: Path) -> None:
    res = fs_service.list_dir(_ws(tmp_path), "")
    assert res["ok"] is True
    names = [e["name"] for e in res["entries"]]
    assert "src" in names and "README.md" in names
    assert ".env" not in names           # hidden by default
    assert ".agent-team" not in names     # always excluded


def test_list_show_hidden_includes_dotfiles_and_the_internal_dir(tmp_path: Path) -> None:
    res = fs_service.list_dir(_ws(tmp_path), "", show_hidden=True)
    names = [e["name"] for e in res["entries"]]
    assert ".env" in names
    assert ".agent-team" in names  # surfaced so plans/ and reports/ are reachable
    env = next(e for e in res["entries"] if e["name"] == ".env")
    assert env["is_hidden"] is True


def test_internal_dir_follows_the_show_hidden_toggle(tmp_path: Path) -> None:
    """It is an ordinary dotfile now, not a special case."""
    res = fs_service.list_dir(_ws(tmp_path), "", show_hidden=False)
    assert ".agent-team" not in [e["name"] for e in res["entries"]]


def test_list_dirs_before_files(tmp_path: Path) -> None:
    res = fs_service.list_dir(_ws(tmp_path), "")
    kinds = [e["is_dir"] for e in res["entries"]]
    # all dirs come before all files
    assert kinds == sorted(kinds, reverse=True)


def test_noise_segment_flagged(tmp_path: Path) -> None:
    (tmp_path / "node_modules").mkdir()
    res = fs_service.list_dir(_ws(tmp_path), "")
    nm = next(e for e in res["entries"] if e["name"] == "node_modules")
    assert nm["is_noise"] is True


# ── CRUD ────────────────────────────────────────────────────────────────────
def test_create_file_and_list(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    assert fs_service.create_file(ws, "src/new.ts", "// hi")["ok"] is True
    assert (Path(ws) / "src" / "new.ts").read_text() == "// hi"
    # duplicate fails
    assert fs_service.create_file(ws, "src/new.ts")["ok"] is False


def test_mkdir(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    assert fs_service.mkdir(ws, "src/sub")["ok"] is True
    assert (Path(ws) / "src" / "sub").is_dir()


def test_rename(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    assert fs_service.rename(ws, "README.md", "README2.md")["ok"] is True
    assert not (Path(ws) / "README.md").exists()
    assert (Path(ws) / "README2.md").exists()


def test_rename_into_internal_is_blocked(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    res = fs_service.rename(ws, "README.md", ".agent-team/x.md")
    assert res["ok"] is False


def test_git_directory_is_never_a_public_fs_mutation_target(tmp_path: Path, monkeypatch) -> None:
    ws = _ws(tmp_path)
    git_dir = tmp_path / ".git"
    git_dir.mkdir()
    (git_dir / "config").write_text("original", encoding="utf-8")
    (tmp_path / ".gitignore").write_text("ignored", encoding="utf-8")
    trash_calls: list[str] = []
    monkeypatch.setattr(fs_service, "send2trash", lambda path: trash_calls.append(path))

    results = [
        fs_service.mkdir(ws, ".git/new-dir"),
        fs_service.create_file(ws, ".git/new-file", "x"),
        fs_service.write_file(ws, ".git/config", "changed"),
        fs_service.rename(ws, "README.md", ".git/moved"),
        fs_service.rename(ws, ".git/config", "moved-config"),
        fs_service.delete(ws, ".git/config"),
    ]

    assert all(result["ok"] is False for result in results)
    assert (git_dir / "config").read_text(encoding="utf-8") == "original"
    assert (tmp_path / "README.md").exists()
    assert not (tmp_path / "moved-config").exists()
    assert trash_calls == []


def test_git_directory_remains_readable_by_host_fs(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    git_dir = tmp_path / ".git"
    git_dir.mkdir()
    (git_dir / "config").write_text("[core]\n\trepositoryformatversion = 0\n", encoding="utf-8")

    root_listing = fs_service.list_dir(ws, "", show_hidden=True)
    assert root_listing["ok"] is True
    assert ".git" in [entry["name"] for entry in root_listing["entries"]]

    git_listing = fs_service.list_dir(ws, ".git", show_hidden=True)
    assert git_listing["ok"] is True
    assert "config" in [entry["name"] for entry in git_listing["entries"]]

    config = fs_service.read_file(ws, ".git/config")
    assert config["ok"] is True
    assert "repositoryformatversion" in config["content"]


def test_gitignore_remains_a_normal_workspace_file(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    assert fs_service.write_file(ws, ".gitignore", "dist/\n")["ok"] is True
    assert (tmp_path / ".gitignore").read_text(encoding="utf-8") == "dist/\n"


def _fake_trash(monkeypatch) -> list[str]:
    """Patch send2trash so tests don't move files into the developer's real
    Trash; the fake actually removes the path so 'gone from disk' still holds.
    Returns the list of paths it was called with."""
    import shutil as _shutil

    calls: list[str] = []

    def fake(path: str) -> None:
        calls.append(path)
        p = Path(path)
        if p.is_dir():
            _shutil.rmtree(p)
        else:
            p.unlink()

    monkeypatch.setattr(fs_service, "send2trash", fake)
    return calls


def test_delete_file(tmp_path: Path, monkeypatch) -> None:
    _fake_trash(monkeypatch)
    ws = _ws(tmp_path)
    assert fs_service.delete(ws, "README.md")["ok"] is True
    assert not (Path(ws) / "README.md").exists()


def test_delete_nonempty_dir_ok(tmp_path: Path, monkeypatch) -> None:
    _fake_trash(monkeypatch)
    ws = _ws(tmp_path)
    res = fs_service.delete(ws, "src")  # contains main.ts
    assert res["ok"] is True
    assert not (Path(ws) / "src").exists()


def test_delete_empty_dir_ok(tmp_path: Path, monkeypatch) -> None:
    _fake_trash(monkeypatch)
    ws = _ws(tmp_path)
    fs_service.mkdir(ws, "emptydir")
    assert fs_service.delete(ws, "emptydir")["ok"] is True


def test_delete_sends_resolved_path_to_trash(tmp_path: Path, monkeypatch) -> None:
    """delete routes the resolved absolute target to send2trash rather than
    hard-removing it, so the file is recoverable from the OS Trash."""
    calls = _fake_trash(monkeypatch)
    ws = _ws(tmp_path)
    assert fs_service.delete(ws, "README.md")["ok"] is True
    assert calls == [str((Path(ws) / "README.md").resolve())]


def test_delete_preserves_targets_when_trash_unavailable(
    tmp_path: Path, monkeypatch, caplog
) -> None:
    """If the trash is unavailable, delete returns an error and preserves the
    original file or directory so the operation remains recoverable."""
    def boom(path: str) -> None:
        raise OSError("no trash here")

    monkeypatch.setattr(fs_service, "send2trash", boom)
    ws = _ws(tmp_path)
    with caplog.at_level("WARNING"):
        file_result = fs_service.delete(ws, "README.md")
        dir_result = fs_service.delete(ws, "src")
    assert file_result == {"ok": False, "error": "no trash here"}
    assert dir_result == {"ok": False, "error": "no trash here"}
    assert (Path(ws) / "README.md").read_text(encoding="utf-8") == "hi"
    assert (Path(ws) / "src" / "main.ts").read_text(encoding="utf-8") == "x"
    assert sum("keeping original" in r.message for r in caplog.records) == 2


# ── read / write (editor) ────────────────────────────────────────────────────
def test_read_file(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    res = fs_service.read_file(ws, "README.md")
    assert res["ok"] is True and res["content"] == "hi"


def test_read_file_returns_mtime(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    res = fs_service.read_file(ws, "README.md")
    assert res["ok"] is True
    assert res["mtime"] == (Path(ws) / "README.md").stat().st_mtime


def test_read_file_rejects_oversized(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    size = fs_service._READ_SIZE_LIMIT + 1
    with (Path(ws) / "large.txt").open("wb") as fh:
        fh.truncate(size)

    res = fs_service.read_file(ws, "large.txt")

    assert res["ok"] is False
    assert "file too large" in res["error"]
    assert res["is_binary"] is False
    assert res["size"] == size


def test_read_large_pdf_is_classified_as_binary(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    size = 10 * 1024 * 1024 + 1
    pdf = Path(ws) / "large.pdf"
    with pdf.open("wb") as fh:
        fh.truncate(size)

    res = fs_service.read_file(ws, "large.pdf")

    assert res["ok"] is False
    assert res["error"] == "binary file"
    assert res["is_binary"] is True
    assert res["size"] == size


def test_read_file_rejects_escape(tmp_path: Path) -> None:
    assert fs_service.read_file(_ws(tmp_path), "../../etc/hosts")["ok"] is False


def test_write_file_roundtrip(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    assert fs_service.write_file(ws, "src/main.ts", "// edited")["ok"] is True
    assert (Path(ws) / "src" / "main.ts").read_text() == "// edited"
    assert fs_service.read_file(ws, "src/main.ts")["content"] == "// edited"


def test_write_file_blocks_internal_dir(tmp_path: Path) -> None:
    assert fs_service.write_file(_ws(tmp_path), ".agent-team/x", "y")["ok"] is False


def test_write_file_returns_mtime(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    res = fs_service.write_file(ws, "src/main.ts", "// edited")
    assert res["ok"] is True
    assert res["mtime"] == (Path(ws) / "src" / "main.ts").stat().st_mtime


def test_write_file_custom_encoding(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    res = fs_service.write_file(ws, "big5.txt", "中文", encoding="big5")
    assert res["ok"] is True
    assert (Path(ws) / "big5.txt").read_bytes() == "中文".encode("big5")


def test_write_file_accepts_display_label(tmp_path: Path) -> None:
    # read_file returns display labels ("UTF-8 with BOM"); write_file must
    # accept them back so the encoding round-trips.
    ws = _ws(tmp_path)
    res = fs_service.write_file(ws, "bom.txt", "hi", encoding="UTF-8 with BOM")
    assert res["ok"] is True
    assert (Path(ws) / "bom.txt").read_bytes() == b"\xef\xbb\xbfhi"


def test_write_file_unknown_encoding_errors(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    res = fs_service.write_file(ws, "x.txt", "hi", encoding="no-such-codec")
    assert res["ok"] is False
    assert "cannot encode" in res["error"]
    assert not (Path(ws) / "x.txt").exists()


def test_write_file_unencodable_content_errors(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    res = fs_service.write_file(ws, "x.txt", "中文", encoding="ascii")
    assert res["ok"] is False
    assert "cannot encode" in res["error"]
    assert not (Path(ws) / "x.txt").exists()


def test_write_file_mtime_conflict_refuses_write(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    target = Path(ws) / "README.md"
    stale = target.stat().st_mtime - 10.0
    res = fs_service.write_file(ws, "README.md", "clobber", expected_mtime=stale)
    assert res["ok"] is False
    assert res["conflict"] is True
    assert res["error"] == "file changed on disk"
    assert res["mtime"] == target.stat().st_mtime
    assert target.read_text() == "hi"  # untouched


def test_write_file_matching_mtime_writes(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    target = Path(ws) / "README.md"
    res = fs_service.write_file(
        ws, "README.md", "new", expected_mtime=target.stat().st_mtime
    )
    assert res["ok"] is True
    assert target.read_text() == "new"


def test_write_file_expected_mtime_ignored_for_new_file(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    res = fs_service.write_file(ws, "brand-new.txt", "x", expected_mtime=123.0)
    assert res["ok"] is True
    assert (Path(ws) / "brand-new.txt").read_text() == "x"


@pytest.mark.skipif(
    not osplat.paths.enforces_posix_modes(),
    reason="preserving a user file's 0o755 is POSIX mode-bit behaviour; NTFS has none",
)
def test_write_file_preserves_mode(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    script = Path(ws) / "run.sh"
    script.write_text("#!/bin/sh\n", encoding="utf-8")
    script.chmod(0o755)
    res = fs_service.write_file(ws, "run.sh", "#!/bin/sh\necho hi\n")
    assert res["ok"] is True
    assert stat.S_IMODE(script.stat().st_mode) == 0o755


# ── read_image ────────────────────────────────────────────────────────────────

# Smallest valid PNG: a 1x1 transparent pixel.
_PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)


def test_read_image_returns_data_url(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    (Path(ws) / "pic.png").write_bytes(_PNG_1X1)
    res = fs_service.read_image(ws, "pic.png")
    assert res["ok"] is True
    assert res["mime"] == "image/png"
    assert res["data_url"].startswith("data:image/png;base64,")
    assert res["size"] == len(_PNG_1X1)


def test_read_image_under_size_limit_ok(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    image = _PNG_1X1 + b"\0" * (10 * 1024 * 1024)  # 10 MB — below the 20 MB cap
    (Path(ws) / "large.png").write_bytes(image)

    res = fs_service.read_image(ws, "large.png")

    assert res["ok"] is True
    assert res["size"] == len(image)
    assert res["data_url"].startswith("data:image/png;base64,")


def test_read_image_rejects_oversized(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    with (Path(ws) / "huge.png").open("wb") as fh:
        fh.truncate(fs_service._IMAGE_SIZE_LIMIT + 1)

    res = fs_service.read_image(ws, "huge.png")

    assert res["ok"] is False
    assert "image too large" in res["error"]


def test_read_image_rejects_non_image(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    res = fs_service.read_image(ws, "README.md")
    assert res["ok"] is False
    assert "not an image" in res["error"]


def test_read_image_missing_file(tmp_path: Path) -> None:
    res = fs_service.read_image(_ws(tmp_path), "nope.png")
    assert res["ok"] is False


def test_read_image_rejects_escape(tmp_path: Path) -> None:
    assert fs_service.read_image(_ws(tmp_path), "../../etc/secret.png")["ok"] is False


def test_stat_path_expands_home(tmp_path: Path, set_home) -> None:
    """Terminal output prints '~/...' paths verbatim; stat must expand them."""
    set_home(tmp_path)
    (tmp_path / "cert.pem").write_text("x", encoding="utf-8")
    assert fs_service.stat_path("~/cert.pem") == {"ok": True, "exists": True}
    assert fs_service.stat_path("~/missing.pem") == {"ok": True, "exists": False}


def test_stat_workspace_path(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    (Path(ws) / "subdir").mkdir()
    (Path(ws) / "file.txt").write_text("hello", encoding="utf-8")

    dir_stat = fs_service.stat_workspace_path(ws, "subdir")
    assert dir_stat["ok"] is True
    assert dir_stat["exists"] is True
    assert dir_stat["is_directory"] is True

    file_stat = fs_service.stat_workspace_path(ws, "file.txt")
    assert file_stat["ok"] is True
    assert file_stat["exists"] is True
    assert file_stat["is_directory"] is False
    assert file_stat["size"] == 5

    missing_stat = fs_service.stat_workspace_path(ws, "missing-dir")
    assert missing_stat["ok"] is True
    assert missing_stat["exists"] is False
    assert missing_stat["is_directory"] is False

    escape_stat = fs_service.stat_workspace_path(ws, "../../etc/passwd")
    assert escape_stat["ok"] is False
    assert escape_stat["exists"] is False


def test_list_dir_mode_validation(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    res = fs_service.list_dir(ws, "", mode="invalid")
    assert res["ok"] is False
    assert res["error"] == "invalid list_dir mode"


@pytest.mark.parametrize("mode", ["display", "discovery"])
def test_list_dir_internal_case_variant_protects_both_modes(tmp_path: Path, mode: str) -> None:
    ws = _ws(tmp_path)
    internal = tmp_path / ".agent-team"
    (internal / "plans").mkdir()
    (internal / "private-state").mkdir()
    if not (tmp_path / ".Agent-Team").exists():
        pytest.skip("filesystem is case-sensitive")

    result = fs_service.list_dir(ws, ".Agent-Team", show_hidden=True, mode=mode)

    assert result["ok"] is True
    assert [entry["name"] for entry in result["entries"]] == ["plans"]


def test_list_dir_discovery_mode_contract(tmp_path: Path) -> None:
    ws = _ws(tmp_path)
    root = Path(ws)
    (root / "node_modules").mkdir()
    (root / ".cache").mkdir()
    (root / "alpha_dir").mkdir()
    (root / "Beta_dir").mkdir()
    (root / "alpha_file.txt").write_text("a", encoding="utf-8")

    # mode="display" keeps Explorer sorting: dirs first, case-insensitive, files next
    display_res = fs_service.list_dir(ws, "")
    assert display_res["ok"] is True
    display_names = [e["name"] for e in display_res["entries"]]
    assert "alpha_dir" in display_names
    assert "Beta_dir" in display_names
    assert "node_modules" in display_names
    assert "alpha_file.txt" in display_names
    assert "README.md" in display_names

    # mode="discovery" keeps only non-hidden, non-noise directories, sorted by UTF-8 bytes ascending
    discovery_res = fs_service.list_dir(ws, "", mode="discovery")
    assert discovery_res["ok"] is True
    discovery_names = [e["name"] for e in discovery_res["entries"]]
    # 'Beta_dir' (0x42) < 'alpha_dir' (0x61) in UTF-8 bytes; node_modules and files are excluded
    assert discovery_names == ["Beta_dir", "alpha_dir", "src"]


def test_list_dir_discovery_mode_2001_truncation(tmp_path: Path) -> None:
    ws = str(tmp_path)
    for i in range(1999):
        (tmp_path / f"d{i:04d}").mkdir()
    (tmp_path / "r0000-within").mkdir()
    (tmp_path / "z0000-beyond").mkdir()

    res = fs_service.list_dir(ws, "", mode="discovery")
    assert res["ok"] is True
    assert res.get("truncated") is True
    assert len(res["entries"]) == 2000
    names = [e["name"] for e in res["entries"]]
    assert names[-1] == "r0000-within"
    assert "z0000-beyond" not in names


# ── list_files_flat query matching ──────────────────────────────────────────
def _flat_ws(tmp_path: Path) -> str:
    for rel in (
        "app/Services/OrderService.php",
        "app/Services/OrderServiceTest.php",
        "legacy/app/Services/OrderService.php",
        "app/Http/OrderController.php",
    ):
        (tmp_path / rel).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / rel).write_text("<?php", encoding="utf-8")
    return str(tmp_path)


def _flat(ws: str, query: str) -> list[str]:
    res = fs_service.list_files_flat(ws, query, max_results=20)
    assert res["ok"] is True
    return [p.replace("\\", "/") for p in res["files"]]


def test_list_files_flat_bare_name_matches_file_name_only(tmp_path: Path) -> None:
    ws = _flat_ws(tmp_path)
    assert sorted(_flat(ws, "OrderService.php")) == [
        "app/Services/OrderService.php",
        "legacy/app/Services/OrderService.php",
    ]
    # A bare query never matches a directory segment.
    assert _flat(ws, "Services") == []


def test_list_files_flat_path_query_matches_relative_path(tmp_path: Path) -> None:
    ws = _flat_ws(tmp_path)
    assert sorted(_flat(ws, "app/Services/OrderService.php")) == [
        "app/Services/OrderService.php",
        "legacy/app/Services/OrderService.php",
    ]
    assert sorted(_flat(ws, "Http/Order")) == ["app/Http/OrderController.php"]
    assert _flat(ws, "./app/Http/OrderController.php") == ["app/Http/OrderController.php"]
    assert _flat(ws, "nope/OrderService.php") == []


def test_list_files_flat_accepts_windows_separators(tmp_path: Path) -> None:
    ws = _flat_ws(tmp_path)
    assert sorted(_flat(ws, "app\\Services\\OrderService.php")) == [
        "app/Services/OrderService.php",
        "legacy/app/Services/OrderService.php",
    ]


def test_list_files_flat_skips_what_its_catalog_entry_says(tmp_path: Path) -> None:
    # The behavior the `fs.listFilesFlat` catalog description promises plugins.
    for rel in ("src/a.ts", "src/.hidden.ts", "src/a.png", ".git/a.ts", "node_modules/a.ts"):
        (tmp_path / rel).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / rel).write_text("x", encoding="utf-8")
    assert _flat(str(tmp_path), "a") == ["src/a.ts"]


def test_list_files_flat_stops_at_max_results(tmp_path: Path) -> None:
    for name in ("a.ts", "b.ts", "c.ts"):
        (tmp_path / name).write_text("x", encoding="utf-8")
    res = fs_service.list_files_flat(str(tmp_path), "", max_results=2)
    assert res == {"ok": True, "files": ["a.ts", "b.ts"], "truncated": True}


def test_list_files_flat_sorts_exact_matches_first(tmp_path: Path) -> None:
    # Within one directory the walk is alphabetical, so the partial match
    # (AFoo.ts / Foo.ts.orig) comes up before the exact one unless sorted.
    d = tmp_path / "src" / "x"
    d.mkdir(parents=True)
    for name in ("AFoo.ts", "Foo.ts", "Foo.ts.orig"):
        (d / name).write_text("x", encoding="utf-8")
    ws = str(tmp_path)
    assert _flat(ws, "foo.ts") == ["src/x/Foo.ts", "src/x/AFoo.ts", "src/x/Foo.ts.orig"]
    assert _flat(ws, "x/Foo.ts") == ["src/x/Foo.ts", "src/x/Foo.ts.orig"]

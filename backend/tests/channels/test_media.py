"""channels.media: inbound storage and which files a pane may send to a chat."""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import pytest

from agent_team_backend.channels import media

from agent_team_backend import osplat
from agent_team_backend import prompt_skills as ps

# Windows creates symlinks only with Developer Mode or elevation.
needs_symlinks = pytest.mark.skipif(not osplat.paths.symlinks_available(),
                                    reason="this Windows session may not create symlinks")


def _file(path: Path, data: bytes = b"x") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


# --- inbound names and folders ------------------------------------------------------


@pytest.mark.parametrize("name, expected", [
    ("report.pdf", "report.pdf"),
    ("../../etc/passwd", "passwd"),
    ("..\\..\\win.ini", "win.ini"),
    (".env", "env"),
    ("我的 檔案 (1).png", "1.png"),
    ("報告.pdf", "file.pdf"),
    ("a\nb\x1bc.txt", "a_b_c.txt"),
    ("x" * 300 + ".txt", "x" * media.NAME_MAX_CHARS + ".txt"),
    ("evil.p\nng", "evil.png"),
])
def test_safe_name_keeps_only_safe_characters(name: str, expected: str) -> None:
    assert media.safe_name(name) == expected


def test_safe_name_falls_back_to_the_kind_and_mime() -> None:
    assert media.safe_name("", "photo") == "photo.jpg"
    assert media.safe_name("", "document", "application/pdf") == "file.pdf"
    assert media.safe_name("...", "voice") == "voice.ogg"


def test_inbound_path_is_per_pane_with_a_random_prefix(tmp_path: Path) -> None:
    a = media.new_inbound_path(tmp_path, "../pane:1", "a.png")
    b = media.new_inbound_path(tmp_path, "../pane:1", "a.png")
    assert a.parent == b.parent == media.pane_dir(tmp_path, "../pane:1") == tmp_path / "pane_1" and a != b
    assert a.name.endswith("-a.png") and len(a.name) == len("abcd1234-a.png")


@needs_symlinks
def test_prune_removes_old_files_symlinks_and_empty_folders(tmp_path: Path) -> None:
    now = time.time()
    old = _file(tmp_path / "p1" / "old.png")
    os.utime(old, (now - media.RETENTION_S - 10, now - media.RETENTION_S - 10))
    fresh = _file(tmp_path / "p2" / "fresh.png")
    outside = _file(tmp_path.parent / f"{tmp_path.name}-keep" / "secret.txt")
    (tmp_path / "p2" / "link").symlink_to(outside)
    assert media.prune(tmp_path, now) == 2
    assert not (tmp_path / "p1").exists() and fresh.exists() and outside.exists()
    assert not (tmp_path / "p2" / "link").is_symlink()


# --- outbound syntax ----------------------------------------------------------------


def test_split_attachments_takes_marker_lines_outside_fences() -> None:
    body = "here you go\n---ATTACH--- /w/a.png\n```\n---ATTACH--- /w/not.png\n```\n---ATTACH---   /w/b c.pdf  "
    text, paths = media.split_attachments(body)
    assert paths == ["/w/a.png", "/w/b c.pdf"]
    assert text == "here you go\n```\n---ATTACH--- /w/not.png\n```"


def test_split_attachments_ignores_indented_or_inline_markers() -> None:
    body = "  ---ATTACH--- /w/a.png\nsee ---ATTACH--- /w/b.png\n---ATTACH---"
    assert media.split_attachments(body) == (body, [])


# --- outbound path rules ------------------------------------------------------------


@pytest.fixture
def ws(tmp_path: Path) -> Path:
    root = tmp_path / "ws"
    _file(root / "out" / "chart.png")
    return root


def test_a_workspace_file_is_allowed(ws: Path) -> None:
    assert media.resolve_outbound(str(ws / "out" / "chart.png")) == ((ws / "out" / "chart.png").resolve(), "")


def test_the_media_folder_is_allowed(tmp_path: Path, ws: Path) -> None:
    root = tmp_path / "media"
    f = _file(root / "pane" / "abcd-a.png")
    assert media.resolve_outbound(str(f)) == (f.resolve(), "")


@pytest.mark.parametrize("raw, reason", [
    ("out/chart.png", "not_absolute"),
    ("{ws}/out/../out/chart.png", "parent_ref"),
    ("{ws}/out/missing.png", "missing"),
    ("{ws}/out", "not_file"),
])
def test_paths_outside_the_rules_are_refused(tmp_path: Path, ws: Path, raw: str, reason: str) -> None:
    outside = _file(tmp_path / "elsewhere" / "x.txt")
    raw = raw.format(ws=ws, outside=outside)
    assert media.resolve_outbound(raw) == (None, reason)


def test_a_file_anywhere_on_the_machine_may_be_sent(tmp_path: Path) -> None:
    """The user's call (2026-10-08): no workspace or attachments-folder scope; the pane judges."""
    f = _file(tmp_path / "elsewhere" / "deep" / "report.pdf")
    assert media.resolve_outbound(str(f)) == (f.resolve(), "")
    opened, reason = media.open_outbound(str(f))
    assert reason == "" and opened is not None
    with opened.fh:
        assert opened.fh.read() == b"x"


@needs_symlinks
def test_a_symlink_is_judged_by_its_target(tmp_path: Path, ws: Path) -> None:
    notes = _file(tmp_path / "home" / "notes.txt")
    (ws / "out" / "notes.txt").symlink_to(notes)
    (ws / "linkdir").symlink_to(tmp_path / "home", target_is_directory=True)
    assert media.resolve_outbound(str(ws / "out" / "notes.txt")) == (notes.resolve(), "")
    assert media.resolve_outbound(str(ws / "linkdir" / "notes.txt")) == (notes.resolve(), "")
    key = _file(tmp_path / "home" / "server.pem")
    (ws / "out" / "cert.txt").symlink_to(key)
    assert media.resolve_outbound(str(ws / "out" / "cert.txt")) == (None, "denied_name")


@needs_symlinks
def test_a_symlink_into_a_dotfolder_is_judged_like_the_target(ws: Path) -> None:
    cfg = _file(ws / ".ssh" / "config")
    (ws / "out" / "cfg").symlink_to(cfg)
    assert media.resolve_outbound(str(ws / "out" / "cfg")) == (cfg.resolve(), "")
    key = _file(ws / ".ssh" / "id_ed25519")
    (ws / "out" / "k").symlink_to(key)
    assert media.resolve_outbound(str(ws / "out" / "k")) == (None, "denied_name")


@pytest.mark.parametrize("rel", [".git/config", ".hidden/NT-20261008.pdf", "sub/.notes.md",
                                 ".agent-team/plans/report_abc123.html", ".agent-team/settings.json"])
def test_hidden_files_and_folders_may_be_sent(ws: Path, rel: str) -> None:
    """The pane judges what to send; a dot in the path is no longer a reason to refuse."""
    f = _file(ws / rel)
    assert media.resolve_outbound(str(f)) == (f.resolve(), "")
    opened, reason = media.open_outbound(str(f))
    assert reason == "" and opened is not None and opened.hidden
    opened.fh.close()


@pytest.mark.parametrize("rel", [".env", ".aws/credentials", "sub/.npmrc", ".ssh/id_rsa",
                                 ".agent-team/plans/credentials.html"])
def test_a_hidden_file_with_a_credential_name_is_still_refused(ws: Path, rel: str) -> None:
    f = _file(ws / rel)
    assert media.resolve_outbound(str(f)) == (None, "denied_name")


def test_a_plain_path_is_not_marked_hidden(ws: Path) -> None:
    opened, _ = media.open_outbound(str(ws / "out" / "chart.png"))
    assert opened is not None and not opened.hidden
    opened.fh.close()


@pytest.mark.parametrize("name", ["server.pem", "PRIVATE.KEY", "id_rsa", "id_ed25519.pub", "credentials",
                                  "credentials.json", "cert.p12", "vault.kdbx", "terraform.tfstate"])
def test_credential_shaped_names_are_refused(ws: Path, name: str) -> None:
    f = _file(ws / "keys" / name)
    assert media.resolve_outbound(str(f)) == (None, "denied_name")


def test_credential_names_are_refused_wherever_the_file_is(tmp_path: Path) -> None:
    for rel in ("elsewhere/server.pem", "elsewhere/.env", "elsewhere/credentials/notes.txt", "x/app.sqlite"):
        assert media.resolve_outbound(str(_file(tmp_path / rel))) == (None, "denied_name")


def test_system_folders_are_refused_inside_a_workspace(tmp_path: Path, monkeypatch) -> None:
    f = _file(tmp_path / "deep" / "sys" / "hosts")
    monkeypatch.setattr(media, "_system_dirs", lambda: [tmp_path / "deep" / "sys"])
    assert media.resolve_outbound(str(f)) == (None, "system")


def test_the_platforms_system_dirs_are_used() -> None:
    from agent_team_backend import osplat

    assert media._system_dirs() == osplat.paths.system_dirs()


@pytest.mark.parametrize("suffix", [":secret", ":secret:$DATA", "::$DATA"])
def test_an_alternate_data_stream_is_refused(ws: Path, suffix: str) -> None:
    """NTFS reads ``file:stream`` as a hidden stream of the file; a colon is refused
    below the anchor everywhere, before the path is resolved."""
    assert media.resolve_outbound(str(ws / "out" / "chart.png") + suffix) == (None, "denied_name")


@pytest.mark.parametrize("raw", ["C:foo\\bar.txt", "\\foo\\bar.txt", "out/chart.png", "~/chart.png"])
def test_relative_and_drive_relative_paths_are_refused(ws: Path, raw: str) -> None:
    assert media.resolve_outbound(raw) == (None, "not_absolute")


@pytest.mark.skipif(sys.platform != "win32", reason="8.3 short names exist only on Windows (NTFS)")
def test_a_short_name_cannot_hide_a_denied_folder(ws: Path) -> None:
    import ctypes

    f = _file(ws / "credentials_store" / "notes.txt")
    buf = ctypes.create_unicode_buffer(1024)
    ctypes.windll.kernel32.GetShortPathNameW(str(f.parent), buf, 1024)
    if not buf.value or Path(buf.value).name.lower() == "credentials_store":
        pytest.skip("8.3 name generation is off on this volume")
    assert media.resolve_outbound(str(Path(buf.value) / "notes.txt")) == (None, "denied_name")


def test_human_size() -> None:
    assert [media.human_size(n) for n in (5, 2048, 3 * 1024 * 1024)] == ["5 B", "2 KB", "3 MB"]
    assert media.human_size(1536) == "1.5 KB"


def test_every_language_has_every_notice() -> None:
    keys = set(media.STRINGS[media.DEFAULT_LANGUAGE])
    assert all(set(table) == keys for table in media.STRINGS.values())
    assert set(media.STRINGS) == set(ps.LANGUAGES)


# --- Hardening: broad workspaces, every path segment, links and swaps -----------------


@pytest.fixture
def home(tmp_path: Path, monkeypatch) -> Path:
    root = tmp_path / "Users" / "me"
    _file(root / "Documents" / "tax.pdf")
    monkeypatch.setattr(media, "_home", lambda: root)
    return root


def test_a_file_in_home_or_a_user_data_folder_may_be_sent(home: Path) -> None:
    f = home / "Documents" / "tax.pdf"
    assert media.resolve_outbound(str(f)) == (f.resolve(), "")


def test_a_project_inside_home_and_the_media_folder_still_work(home: Path) -> None:
    proj = _file(home / "code" / "app" / "out.png")
    pane = _file(home / "Library" / "Agent-Team" / "channels-media" / "pane-1" / "ab-x.png")
    assert media.resolve_outbound(str(proj)) == (proj.resolve(), "")
    assert media.resolve_outbound(str(pane)) == (pane.resolve(), "")


@pytest.mark.parametrize("rel", [
    "secrets/notes.txt", "credentials/aws.txt", "config/prod.env", "api_token.txt", "keys/server.ppk",
    "Chrome/Default/Cookies", "Chrome/Default/Login Data", "data/app.sqlite", "data/app.sqlite3",
    "my_password.txt", "backup.gpg", "Keychains/login.keychain-db",
])
def test_credential_shaped_names_are_refused_in_any_segment(ws: Path, rel: str) -> None:
    f = _file(ws / rel)
    assert media.resolve_outbound(str(f)) == (None, "denied_name")


def test_a_hard_link_to_another_file_is_refused(tmp_path: Path, ws: Path) -> None:
    outside = _file(tmp_path / "elsewhere" / "secret.txt", b"S")
    os.link(outside, ws / "out" / "copy.txt")
    assert media.resolve_outbound(str(ws / "out" / "copy.txt")) == (None, "hard_link")


def test_open_outbound_reads_the_checked_file(ws: Path) -> None:
    opened, reason = media.open_outbound(str(ws / "out" / "chart.png"))
    assert reason == "" and opened is not None
    with opened.fh:
        assert (opened.fh.read(), opened.size, opened.path.name) == (b"x", 1, "chart.png")


def test_an_inbound_path_never_leaves_the_pane_folder(tmp_path: Path) -> None:
    for name in ("../../x", "..\\..\\y", "/etc/passwd", "a/../../b", "\x00z"):
        dest = media.new_inbound_path(tmp_path, "pane-1", media.safe_name(name))
        assert dest.parent == media.pane_dir(tmp_path, "pane-1")


def _staged(monkeypatch, *, before_recheck=None, after_first=None, after_recheck=None) -> dict:
    """Run swaps around open_outbound's two checks: the first runs before the file is
    opened, the recheck after. The open file pins its inode, so nothing here depends on
    whether the filesystem would reuse an inode number.

    Windows will not delete or rename a file another handle has open (WinError 32), so a
    swap aimed at the open file fails there; the returned dict says whether one did, and
    the test then expects the safe Windows outcome: the checked original goes out."""
    checked = media._check
    calls = []
    state = {"blocked": False}

    def attempt(swap) -> None:
        try:
            swap()
        except PermissionError:
            state["blocked"] = True

    def staged(raw):
        calls.append(raw)
        if len(calls) == 2 and before_recheck:
            attempt(before_recheck)
        result = checked(raw)
        if len(calls) == 1 and after_first:
            attempt(after_first)
        if len(calls) == 2 and after_recheck:
            attempt(after_recheck)
        return result

    monkeypatch.setattr(media, "_check", staged)
    return state


def _sends_the_original(result) -> bool:
    opened, reason = result
    if opened is None or reason:
        return False
    with opened.fh:
        return opened.fh.read() == b"x"


def test_a_file_replaced_between_the_open_and_the_recheck_is_caught(ws: Path, monkeypatch) -> None:
    target = ws / "out" / "chart.png"

    def swap() -> None:
        target.unlink()
        target.write_bytes(b"OTHER")  # a new file under the same, still-real path

    state = _staged(monkeypatch, before_recheck=swap)
    result = media.open_outbound(str(target))
    assert _sends_the_original(result) if state["blocked"] else result == (None, "changed")


@needs_symlinks
def test_a_file_opened_through_a_folder_swapped_and_back_is_caught(tmp_path: Path, ws: Path,
                                                                   monkeypatch) -> None:
    """The open follows a folder symlink to a secret, then the folder is put back so the
    recheck passes: only comparing the open file with the path catches it."""
    _file(tmp_path / "secrets" / "chart.png", b"SECRET")

    def swap_out() -> None:
        (ws / "out").rename(ws / "moved")
        (ws / "out").symlink_to(tmp_path / "secrets", target_is_directory=True)

    def swap_back() -> None:
        (ws / "out").unlink()
        (ws / "moved").rename(ws / "out")

    state = _staged(monkeypatch, after_first=swap_out, before_recheck=swap_back)
    opened, reason = media.open_outbound(str(ws / "out" / "chart.png"))
    # Put back or not, the secret opened through the link is never handed out.
    assert opened is None and reason == ("denied_name" if state["blocked"] else "changed")


@needs_symlinks
def test_a_symlink_swapped_in_before_the_recheck_is_refused(tmp_path: Path, ws: Path, monkeypatch) -> None:
    secret = _file(tmp_path / "elsewhere" / "secret.txt", b"SECRET")
    target = ws / "out" / "chart.png"

    def swap() -> None:
        target.unlink()
        target.symlink_to(secret)

    state = _staged(monkeypatch, before_recheck=swap)
    result = media.open_outbound(str(target))
    assert _sends_the_original(result) if state["blocked"] else result == (None, "denied_name")


@needs_symlinks
def test_a_swap_before_the_open_is_never_sent(tmp_path: Path, ws: Path, monkeypatch) -> None:
    """Nothing is open yet, so the swap works everywhere. With O_NOFOLLOW the open itself
    refuses the link; Windows has no such flag, follows it, and the recheck refuses."""
    secret = _file(tmp_path / "elsewhere" / "secret.txt", b"SECRET")
    target = ws / "out" / "chart.png"

    def swap() -> None:
        target.unlink()
        target.symlink_to(secret)

    _staged(monkeypatch, after_first=swap)
    expected = "changed" if hasattr(os, "O_NOFOLLOW") else "denied_name"
    assert media.open_outbound(str(target)) == (None, expected)


def test_a_replacement_before_the_open_is_judged_by_the_recheck(tmp_path: Path, ws: Path,
                                                                monkeypatch) -> None:
    """On Linux an unlinked file's inode number is often given straight to the next file,
    so the first check's stat cannot vouch for what gets opened; the recheck does."""
    outside = _file(tmp_path / "elsewhere" / "secret.txt", b"SECRET")
    target = ws / "out" / "chart.png"

    def swap() -> None:
        target.unlink()
        os.link(outside, target)

    _staged(monkeypatch, after_first=swap)
    assert media.open_outbound(str(target)) == (None, "hard_link")


def test_a_swap_after_the_recheck_still_sends_the_checked_file(ws: Path, monkeypatch) -> None:
    target = ws / "out" / "chart.png"

    def swap() -> None:
        target.unlink()
        target.write_bytes(b"OTHER")

    _staged(monkeypatch, after_recheck=swap)
    assert _sends_the_original(media.open_outbound(str(target)))


# --- Review 2: user-data folders, the root's own path, resolved colons -----------------


@pytest.mark.parametrize("folder", ["Desktop", "Documents", "Downloads", "Pictures", "Library", "OneDrive"])
def test_a_user_data_folder_is_no_longer_off_limits(home: Path, folder: str) -> None:
    f = _file(home / folder / "report.pdf")
    assert media.resolve_outbound(str(f)) == (f.resolve(), "")


def test_a_project_under_desktop_still_works(home: Path) -> None:
    f = _file(home / "Desktop" / "app" / "out.png")
    assert media.resolve_outbound(str(f)) == (f.resolve(), "")


def test_a_project_folder_that_mentions_tokens_still_sends_its_files(home: Path) -> None:
    # 2026-10-14: "*token*" on the folder refused every file of this workspace.
    f = _file(home / "Desktop" / "Token仲介平台" / ".agent-team" / "work" / "siraya-params"
              / "announcement-draft-v2.13.md")
    assert media.resolve_outbound(str(f)) == (f.resolve(), "")
    assert media.denied_rule(str(f)) == ""


@pytest.mark.parametrize("rel, rule", [
    ("Token仲介平台/.env", "*.env"), ("Token仲介平台/github_token.txt", "*token*"),
    ("Token仲介平台/keys/id_rsa", "id_rsa*"), ("app/server.pem", "*.pem"), ("app/private.key", "*.key"),
    ("app/credentials.json", "credentials*"), ("app/token", "*token*"), ("app/api_token.txt", "*token*"),
    ("app/tokens/github.txt", "*tokens"), ("app/token/github.txt", "*token"), ("app/api_tokens/gh.txt", "*tokens"),
    ("app/github-token/gh.txt", "*token"), ("app/.tokens/gh.txt", "*tokens"), ("app/secrets/notes.txt", "*secret*"),
])
def test_real_credential_names_are_still_refused_and_name_their_rule(home: Path, rel: str, rule: str) -> None:
    f = _file(home / "Desktop" / rel)
    assert media.resolve_outbound(str(f)) == (None, "denied_name")
    assert media.denied_rule(str(f)) == rule


@pytest.mark.parametrize("lang", sorted(media.STRINGS))
def test_the_denied_name_reason_names_the_rule(lang: str) -> None:
    assert "*.pem" in media.text(lang, "reason.denied_name", rule="*.pem")


@pytest.mark.parametrize("parent, reason", [(".ssh", ""), (".aws/profile", ""),
                                            ("secrets", "denied_name"), ("work/credentials", "denied_name")])
def test_a_workspace_inside_a_secret_folder_sends_nothing(home: Path, parent: str, reason: str) -> None:
    root = home / "code" / parent / "proj"
    f = _file(root / "notes.txt")
    assert media.resolve_outbound(str(f)) == ((f.resolve(), "") if not reason else (None, reason))


@needs_symlinks
def test_a_colon_reached_through_a_symlink_is_refused(ws: Path) -> None:
    target = ws / "out" / "a:b.txt"
    try:
        target.write_text("x")
    except OSError:
        pytest.skip("this filesystem cannot name a file with a colon")
    (ws / "out" / "plain.txt").symlink_to(target)
    assert media.resolve_outbound(str(ws / "out" / "plain.txt")) == (None, "denied_name")


# --- Review 3: case-insensitive volumes ------------------------------------------------


def test_a_system_folder_matches_whatever_case_the_path_uses(tmp_path: Path, monkeypatch) -> None:
    """APFS and NTFS are case-insensitive: /etc/HOSTS and /ETC/hosts name the same file."""
    f = _file(tmp_path / "deep" / "Sys" / "hosts")
    monkeypatch.setattr(media, "_system_dirs", lambda: [tmp_path / "deep" / "SYS"])
    assert media.resolve_outbound(str(f)) == (None, "system")


def test_home_and_user_folders_match_whatever_case_the_path_uses(home: Path, monkeypatch) -> None:
    monkeypatch.setattr(media, "_home", lambda: Path(str(home).upper()))
    f = _file(home / "Desktop" / "report.pdf")
    assert media.resolve_outbound(str(f)) == (f.resolve(), "")
    k = _file(home / "Desktop" / "Keychains" / "login.keychain-db")
    assert media.resolve_outbound(str(k)) == (None, "denied_name")


# --- Review 4: CRLF output ----------------------------------------------------------


def test_crlf_attach_lines_parse_like_the_msg_markers_around_them() -> None:
    """MSG markers accept a trailing \\r (CRLF output on Windows); an attach line must too,
    or the block parses while its path keeps the \\r."""
    text, paths = media.split_attachments("hi\r\n---ATTACH--- C:\\ws\\a.png\r\n---ATTACH---\t/w/b.pdf \r")
    assert paths == ["C:\\ws\\a.png", "/w/b.pdf"] and text == "hi\r"


def test_a_file_whose_stat_fails_after_resolving_is_refused_not_raised(ws: Path, monkeypatch) -> None:
    target = ws / "out" / "chart.png"
    resolved = str(target.resolve())
    real_stat = Path.stat
    seen = {"n": 0}

    def stat(self, *a, **kw):
        if str(self) == resolved:
            seen["n"] += 1
            if seen["n"] > 1:  # is_file() passes; the inode stat right after does not
                raise PermissionError(13, "Permission denied")
        return real_stat(self, *a, **kw)

    monkeypatch.setattr(Path, "stat", stat)
    assert media.resolve_outbound(str(target)) == (None, "changed")
    seen["n"] = 0
    assert media.open_outbound(str(target)) == (None, "changed")


# --- Credential dot folders and Navide's own data, now that hidden paths may be sent ---


@pytest.mark.skipif(sys.platform == "win32", reason="Path.home() follows USERPROFILE, not HOME, on Windows")
@pytest.mark.parametrize("rel", [
    ".ssh/config", ".ssh/known_hosts", ".aws/config", ".config/gh/hosts.yml", ".codex/auth.json",
    ".claude/.credentials.json", ".kube/config", ".docker/config.json", ".gnupg/pubring.kbx",
    ".config/google-chrome/Default/Preferences", ".config/chromium/Local State",
    ".mozilla/firefox/profiles.ini", ".config/BraveSoftware/Brave-Browser/Default/History",
    ".config/microsoft-edge/Default/Bookmarks", ".local/share/keyrings/login.keyring",
    ".password-store/mail.txt", ".git-credentials", ".config/git/credentials",
    ".navide/cli-profiles/claude/slot-1/settings.json", ".codex-panes/p1/config.toml",
])
def test_credential_dot_folders_in_home_are_refused(tmp_path: Path, monkeypatch, rel: str) -> None:
    home = tmp_path / "home"
    monkeypatch.setenv("HOME", str(home))
    f = _file(home / rel)
    assert media.resolve_outbound(str(f))[1] in ("system", "denied_name")


@pytest.mark.skipif(sys.platform == "win32", reason="Path.home() follows USERPROFILE, not HOME, on Windows")
def test_ordinary_dot_files_in_home_may_still_be_sent(tmp_path: Path, monkeypatch) -> None:
    home = tmp_path / "home"
    monkeypatch.setenv("HOME", str(home))
    for rel in (".claude/CLAUDE.md", ".codex/config.toml", ".config/app/notes.md", ".zshrc"):
        f = _file(home / rel)
        assert media.resolve_outbound(str(f)) == (f.resolve(), ""), rel


def test_navides_own_data_is_refused_but_its_outbound_folders_are_not(tmp_path: Path, monkeypatch) -> None:
    from agent_team_backend.channels import pdf

    data = tmp_path / "Agent-Team"
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(data))
    for rel in ("device-keys.json", "hook-auth/x", "plan_mcp_auth.json", "git-accounts.json", "Local State"):
        assert media.resolve_outbound(str(_file(data / rel))) == (None, "system"), rel
    for f in (_file(media.media_root(data) / "pane-1" / "ab-x.png"), _file(pdf.pdf_root(data) / "p" / "a.pdf")):
        assert media.resolve_outbound(str(f)) == (f.resolve(), "")


def test_files_the_user_dropped_in_may_be_sent_but_not_their_neighbours(tmp_path: Path, monkeypatch) -> None:
    """The renderer's userData (~/.config/Agent-Team on Linux) is Navide's too; only its
    dropped-files, the copies of what the user dragged in, may go."""
    user_data = tmp_path / "userData"
    monkeypatch.setattr(osplat.paths, "app_support_dir", lambda name, **_kw: user_data / name)
    dropped = _file(user_data / "Agent-Team" / "dropped-files" / "123-shot.png")
    assert media.resolve_outbound(str(dropped)) == (dropped.resolve(), "")
    assert media.resolve_outbound(str(_file(user_data / "Agent-Team" / "Local State"))) == (None, "system")


# Windows drops trailing dots and spaces from every path segment, so "id_rsa." opens
# id_rsa: when resolve() cannot give the final path back, the name rules must still see
# the name Windows will open. Simulated through osplat.platform_id, so it runs anywhere.
@pytest.mark.parametrize("rel", ["id_rsa.", "key.pem.", "server.key. .", "keychains . /db.txt", "auth.json.."])
def test_trailing_dots_and_spaces_cannot_hide_a_denied_name_on_windows(ws: Path, monkeypatch, rel: str) -> None:
    from agent_team_backend import osplat

    written = ws / "out" / rel
    if sys.platform == "win32":
        # Windows strips them while creating, and cannot create "keychains . /db.txt" as written.
        _file(ws / "out" / "/".join(part.rstrip(". ") for part in rel.split("/")))
    else:
        _file(written)
    monkeypatch.setattr(osplat, "platform_id", "win32")
    # Real Windows does not open a path whose folder is written "keychains . ",
    # so nothing is sent and it says so; everywhere else the name rule refuses it.
    unopenable = sys.platform == "win32" and "/" in rel
    assert media.resolve_outbound(str(written)) == (None, "missing" if unopenable else "denied_name")


@pytest.mark.skipif(sys.platform == "win32", reason="Windows cannot create a name ending in a dot")
def test_trailing_dots_elsewhere_are_judged_as_written(ws: Path, monkeypatch) -> None:
    from agent_team_backend import osplat

    monkeypatch.setattr(osplat, "platform_id", "darwin")
    f = _file(ws / "out" / "key.pem.")  # not *.pem as written: as on main
    assert media.resolve_outbound(str(f)) == (f.resolve(), "")

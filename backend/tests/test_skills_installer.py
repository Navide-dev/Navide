from __future__ import annotations

import io
import gzip
import json
import os
from pathlib import Path
import tarfile
import threading

import pytest

from agent_team_backend import skills_installer as module
from agent_team_backend.skills_installer import SkillInstaller
from agent_team_backend.skills_store import SkillConflictError, SkillConsentRequired, SkillValidationError, SkillsStore

SKILL = b"---\nname: example\ndescription: Example skill\n---\nReview the project.\n"


@pytest.fixture
def setup(tmp_path):
    store = SkillsStore(root=tmp_path / "shared", state_path=tmp_path / "state.json",
                        runtime_root=tmp_path / "runtime", native_roots=[])
    source = tmp_path / "source"
    source.mkdir()
    (source / "SKILL.md").write_bytes(SKILL)
    (source / "scripts").mkdir()
    script = source / "scripts" / "check.sh"
    script.write_bytes(b"#!/bin/sh\nexit 0\n")
    script.chmod(0o755)
    return store, SkillInstaller(store), source


def preview(installer, source):
    return installer.preview(str(source), owner_key="pane-one")


def install(installer, item, **kwargs):
    return installer.install(item["preview_id"], item["digest"], owner_key="pane-one",
                             targets=["codex"], **kwargs)


def test_local_preview_install_uses_staged_bytes_and_retries(setup):
    store, installer, source = setup
    item = preview(installer, source)
    assert not store.root.exists()
    assert not store.state_path.exists()
    (source / "SKILL.md").write_text("changed upstream")
    with pytest.raises(SkillConsentRequired):
        install(installer, item)
    assert not store.root.exists()
    result = install(installer, item, consent=True)
    assert result["changed"] is True
    assert (store.root / "example" / "SKILL.md").read_bytes() == SKILL
    assert store.get_skill("example")["skill"]["targets"] == ["codex"]
    assert (store.root / "example" / "scripts" / "check.sh").read_bytes().startswith(b"#!/bin/sh")
    if os.name != "nt":
        assert (store.root / "example" / "scripts" / "check.sh").stat().st_mode & 0o111
    assert install(installer, item)["changed"] is False


@pytest.mark.parametrize("change", ["owner", "digest", "expiry"])
def test_preview_binding(setup, monkeypatch, change):
    store, installer, source = setup
    item = preview(installer, source)
    owner = "wrong" if change == "owner" else "pane-one"
    digest = "wrong" if change == "digest" else item["digest"]
    if change == "expiry":
        monkeypatch.setattr(module.time, "time", lambda: item["expires_at"] + 1)
    with pytest.raises(SkillValidationError):
        installer.install(item["preview_id"], digest, owner_key=owner, targets=None, consent=True)
    assert not store.root.exists()


@pytest.mark.parametrize("kind", ["invalid", "secret", "symlink", "oversize"])
def test_failed_preview_never_writes_shared_root(setup, kind):
    store, installer, source = setup
    if kind == "invalid":
        (source / "SKILL.md").write_bytes(b"no frontmatter")
    elif kind == "secret":
        (source / ".env").write_text("not copied")
    elif kind == "oversize":
        (source / "large").write_bytes(b"x" * (module.MAX_FILE_BYTES + 1))
    else:
        (source / "alias").symlink_to(source / "SKILL.md")
    with pytest.raises(SkillValidationError):
        preview(installer, source)
    assert not store.root.exists()
    assert not store.state_path.exists()


@pytest.mark.parametrize("managed", [True, False])
def test_existing_skill_never_overwritten(setup, managed):
    store, installer, source = setup
    item = preview(installer, source)
    if managed:
        store.create_skill("example", "existing", consent=True)
    else:
        (store.root / "example").mkdir(parents=True)
        (store.root / "example" / "SKILL.md").write_bytes(SKILL)
    before = (store.root / "example" / "SKILL.md").read_bytes()
    with pytest.raises(SkillConflictError):
        install(installer, item, consent=True)
    assert (store.root / "example" / "SKILL.md").read_bytes() == before


@pytest.mark.parametrize("failure", ["state", "move", "projection"])
def test_install_failure_restores_content_and_state(setup, monkeypatch, failure):
    store, installer, source = setup
    store.create_skill("existing", "keep", consent=True)
    before = store.state_path.read_bytes()
    item = preview(installer, source)
    def fail(*args, **kwargs):
        raise OSError("injected failure")
    if failure == "state":
        monkeypatch.setattr(store, "_write_state", fail)
    elif failure == "projection":
        monkeypatch.setattr(store, "rebuild_runtime_projection", fail)
    else:
        def link(src, dst, **kwargs):
            fail()
        monkeypatch.setattr(os, "link", link)
    with pytest.raises(OSError):
        install(installer, item, consent=True)
    assert not (store.root / "example").exists()
    assert store.state_path.read_bytes() == before
    assert (store.root / "existing" / "SKILL.md").exists()


def archive(entries):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as tar:
        for name, data, kind in entries:
            member = tarfile.TarInfo(name)
            member.type = kind
            member.size = len(data) if kind == tarfile.REGTYPE else 0
            tar.addfile(member, io.BytesIO(data) if kind == tarfile.REGTYPE else None)
    return output.getvalue()


def mock_github(monkeypatch, payload):
    urls = []
    sha = "a" * 40
    def download(url, limit):
        urls.append(url)
        return json.dumps({"sha": sha}).encode() if "api.github.com" in url else payload
    monkeypatch.setattr(module, "_download", download)
    return urls, sha


def test_github_resolves_ref_and_installs_only_skill_subtree(setup, monkeypatch):
    store, installer, _ = setup
    payload = archive([("repo/.claude-plugin/plugin.json", b"{}", tarfile.REGTYPE),
                       ("repo/skills/example/SKILL.md", SKILL, tarfile.REGTYPE),
                       ("repo/skills/example/references/info.md", b"reference", tarfile.REGTYPE)])
    urls, sha = mock_github(monkeypatch, payload)
    item = installer.preview("https://github.com/example/repo", ref="feature/test", owner_key="pane-one")
    assert urls[0].endswith("/commits/feature%2Ftest")
    assert urls[1].endswith("/" + sha)
    assert item["source"]["commit"] == sha
    assert item["source"]["subdir"] == "skills/example"
    install(installer, item, consent=True)
    assert (store.root / "example" / "references" / "info.md").read_bytes() == b"reference"
    assert not (store.root / "example" / ".claude-plugin").exists()


@pytest.mark.parametrize("path,kind", [("repo/../escape", tarfile.REGTYPE),
                                      ("/absolute", tarfile.REGTYPE),
                                      ("repo/skills/link", tarfile.SYMTYPE),
                                      ("repo/device", tarfile.CHRTYPE)])
def test_malicious_archives_rejected(setup, monkeypatch, path, kind):
    store, installer, _ = setup
    mock_github(monkeypatch, archive([("repo/skills/example/SKILL.md", SKILL, tarfile.REGTYPE),
                                      (path, b"bad", kind)]))
    with pytest.raises(SkillValidationError):
        installer.preview("https://github.com/example/repo", owner_key="pane-one")
    assert not store.root.exists()


def test_preview_cache_bounded(setup, monkeypatch):
    _, installer, source = setup
    monkeypatch.setattr(module, "MAX_PREVIEWS", 1)
    preview(installer, source)
    with pytest.raises(SkillValidationError, match="too many"):
        preview(installer, source)


def test_slow_download_does_not_block_other_callers(setup, monkeypatch):
    """A GitHub preview stuck on the network must not hold the installer lock:
    every other pane's preview/install would queue behind it (up to 40s of
    socket timeouts), each pinning a thread of the shared to_thread pool."""
    _, installer, source = setup
    entered = threading.Event()
    release = threading.Event()
    left = threading.Event()
    payload = archive([("repo/SKILL.md", SKILL, tarfile.REGTYPE)])

    def download(url, limit):
        entered.set()
        try:
            # Released only once pane B is done, so pane B finishing at all
            # while this still waits is the proof; no wall-clock bound, which
            # a loaded runner breaks (2.48 s of B's own work on Windows CI).
            # Pane B queued behind it would finish only after this times out.
            assert release.wait(30), "download was never released"
            return json.dumps({"sha": "a" * 40}).encode() if "api.github.com" in url else payload
        finally:
            left.set()

    monkeypatch.setattr(module, "_download", download)
    outcome = {}
    slow = threading.Thread(
        target=lambda: outcome.update(
            item=installer.preview("https://github.com/example/repo", owner_key="pane-a")),
    )
    slow.start()
    assert entered.wait(5)
    item = preview(installer, source)
    install(installer, item, consent=True)
    still_downloading = not left.is_set()
    release.set()
    slow.join(5)
    assert still_downloading, "pane B waited behind pane A's download"
    assert outcome["item"]["source"]["repository"] == "example/repo"


def test_concurrent_previews_still_respect_the_cache_bound(setup, monkeypatch):
    """With the fetch outside the lock, two previews can both pass the early
    count check; the recount under the lock is what keeps MAX_PREVIEWS."""
    _, installer, _ = setup
    monkeypatch.setattr(module, "MAX_PREVIEWS", 1)
    both_fetching = threading.Barrier(2, timeout=5)
    payload = archive([("repo/SKILL.md", SKILL, tarfile.REGTYPE)])

    def download(url, limit):
        if "api.github.com" in url:
            both_fetching.wait()
            return json.dumps({"sha": "a" * 40}).encode()
        return payload

    monkeypatch.setattr(module, "_download", download)
    results = []

    def run():
        try:
            results.append(installer.preview("https://github.com/example/repo", owner_key="pane"))
        except SkillValidationError as exc:
            results.append(exc)

    threads = [threading.Thread(target=run) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(5)
    landed = [item for item in results if isinstance(item, dict)]
    refused = [item for item in results if isinstance(item, SkillValidationError)]
    assert len(landed) == 1 and len(refused) == 1, results
    assert "too many" in str(refused[0])
    assert sum(record["result"] is None for record in installer._previews.values()) == 1


def test_relative_local_source_is_rejected(setup):
    _, installer, _ = setup
    with pytest.raises(SkillValidationError, match="absolute"):
        preview(installer, "relative-folder")


def test_install_retry_cannot_change_targets(setup):
    _, installer, source = setup
    item = preview(installer, source)
    install(installer, item, consent=True)
    with pytest.raises(SkillValidationError, match="different targets"):
        installer.install(item["preview_id"], item["digest"], owner_key="pane-one", targets=["claude"])


def test_hidden_github_source_folder_and_unrelated_large_asset(setup, monkeypatch):
    _, installer, _ = setup
    mock_github(monkeypatch, archive([
        ("repo/skills/.curated/example/SKILL.md", SKILL, tarfile.REGTYPE),
        ("repo/assets/image.png", b"x" * (module.MAX_FILE_BYTES + 1), tarfile.REGTYPE),
    ]))
    item = installer.preview("https://github.com/example/repo", subdir="skills/.curated/example", owner_key="pane-one")
    assert [entry["path"] for entry in item["files"]] == ["SKILL.md"]


def test_source_subdir_traversal_rejected_before_network(setup, monkeypatch):
    _, installer, _ = setup
    def unexpected(*args):
        pytest.fail("invalid subdir must not trigger a request")
    monkeypatch.setattr(module, "_download", unexpected)
    with pytest.raises(SkillValidationError, match="subdir"):
        installer.preview("https://github.com/example/repo", subdir="../secret", owner_key="pane-one")


def test_preview_return_values_cannot_mutate_staged_provenance(setup):
    _, installer, source = setup
    item = preview(installer, source)
    original = item["source"]["path"]
    item["source"]["path"] = "tampered"
    assert install(installer, item, consent=True)["source"]["path"] == original


def test_archive_decompression_is_bounded_before_tar_parsing(setup, monkeypatch):
    store, installer, _ = setup
    monkeypatch.setattr(module, "MAX_ARCHIVE_BYTES", 1024)
    mock_github(monkeypatch, gzip.compress(b"x" * 2048))
    with pytest.raises(SkillValidationError, match="expands"):
        installer.preview("https://github.com/example/repo", owner_key="pane-one")
    assert not store.root.exists()


def test_native_name_collision_is_not_installed(setup):
    store, installer, source = setup
    native = source.parent / "native"
    (native / "example").mkdir(parents=True)
    (native / "example" / "SKILL.md").write_bytes(SKILL)
    store._native_roots = (native,)
    item = preview(installer, source)
    with pytest.raises(SkillConflictError):
        install(installer, item, consent=True)
    assert not store.root.exists()


def test_preview_file_count_limit(setup, monkeypatch):
    store, installer, source = setup
    monkeypatch.setattr(module, "MAX_FILES", 1)
    with pytest.raises(SkillValidationError):
        preview(installer, source)
    assert not store.root.exists()


def test_first_install_failure_leaves_no_consent_state(setup, monkeypatch):
    store, installer, source = setup
    item = preview(installer, source)
    original = store._write_state
    def fail_after_write(*args, **kwargs):
        original(*args, **kwargs)
        raise OSError("after state commit")
    monkeypatch.setattr(store, "_write_state", fail_after_write)
    with pytest.raises(OSError):
        install(installer, item, consent=True)
    assert not store.state_path.exists()
    assert not (store.root / "example").exists()


def test_skill_instructions_published_after_helpers(setup, monkeypatch):
    store, installer, source = setup
    item = preview(installer, source)
    original = os.link
    observed = []
    def link(src, dst, **kwargs):
        assert not (store.root / "example" / "SKILL.md").exists()
        if Path(dst).name == "SKILL.md":
            assert (store.root / "example" / "scripts" / "check.sh").is_file()
        observed.append(Path(dst).name)
        return original(src, dst, **kwargs)
    monkeypatch.setattr(os, "link", link)
    install(installer, item, consent=True)
    assert observed[-1] == "SKILL.md"


def test_unsupported_target_rejected_before_install(setup):
    store, installer, source = setup
    item = preview(installer, source)
    with pytest.raises(SkillValidationError):
        installer.install(item["preview_id"], item["digest"], owner_key="pane-one",
                          targets=["not-a-real-agent"], consent=True)
    assert not store.root.exists()


@pytest.mark.parametrize("paths", [("Foo", "foo"), ("Foo/a", "foo/b"),
                                   ("caf\u00e9/a", "cafe\u0301/b"), ("file", "file/child")])
def test_archive_aliases_rejected_before_preview(setup, monkeypatch, paths):
    store, installer, _ = setup
    entries = [("repo/skill/SKILL.md", SKILL, tarfile.REGTYPE)]
    entries.extend(("repo/skill/" + path, b"content", tarfile.REGTYPE) for path in paths)
    mock_github(monkeypatch, archive(entries))
    with pytest.raises(SkillValidationError):
        installer.preview("https://github.com/example/repo", owner_key="pane-one")
    assert not store.root.exists()


@pytest.mark.parametrize("paths", [("Foo", "foo"), ("Foo/a", "foo/b"),
                                   ("CON",), ("file.",), ("file ",)])
def test_direct_bundle_rejects_nonportable_paths_before_writes(setup, paths):
    store, _, _ = setup
    files = {"SKILL.md": {"data": SKILL, "executable": False}}
    files.update({path: {"data": path.encode(), "executable": False} for path in paths})
    with pytest.raises(SkillValidationError):
        store.install_bundle("example", files, targets=None, consent=True)
    assert not store.root.exists()
    assert not store.state_path.exists()


def test_staging_exclusive_write_rejects_existing_file(setup, monkeypatch):
    store, installer, source = setup
    item = preview(installer, source)
    original = Path.open
    def opened(path, mode="r", *args, **kwargs):
        if path.name == "SKILL.md" and "-install-" in str(path) and mode == "xb":
            with original(path, "wb") as handle:
                handle.write(b"unexpected preexisting content")
        return original(path, mode, *args, **kwargs)
    monkeypatch.setattr(Path, "open", opened)
    with pytest.raises(FileExistsError):
        install(installer, item, consent=True)
    assert not (store.root / "example").exists()
    assert not store.state_path.exists()


@pytest.mark.parametrize("description", ["", "description: ''\n", "description: '   '\n", "description: 123\n"])
def test_installer_requires_nonempty_description(setup, description):
    store, installer, source = setup
    (source / "SKILL.md").write_text(f"---\nname: example\n{description}---\nbody")
    with pytest.raises(SkillValidationError):
        preview(installer, source)
    assert not store.root.exists()


def test_installation_provenance_survives_store_restart_and_retry(setup):
    store, installer, source = setup
    item = preview(installer, source)
    result = install(installer, item, consent=True)
    receipt = result["skill"]["provenance"]
    assert receipt["source"] == item["source"]
    assert receipt["digest"] == item["digest"]
    assert receipt["installed_at"]
    reloaded = SkillsStore(root=store.root, state_path=store.state_path,
                           runtime_root=store.runtime_root, native_roots=[])
    assert reloaded.get_skill("example")["skill"]["provenance"] == receipt
    assert reloaded.get_skill("example")["skill"]["migrated_from"] is None
    assert install(installer, item)["skill"]["provenance"] == receipt
    # Sync deliberately excludes the local ownership/receipt marker.
    assert ".navide" not in reloaded.export_content("example")


def test_github_provenance_is_persisted(setup, monkeypatch):
    store, installer, _ = setup
    _, sha = mock_github(monkeypatch, archive([("repo/skill/SKILL.md", SKILL, tarfile.REGTYPE)]))
    item = installer.preview("https://github.com/example/repo", owner_key="pane-one")
    install(installer, item, consent=True)
    receipt = json.loads((store.root / "example" / ".navide").read_text())["installation"]
    assert receipt["source"] == {"kind": "github", "repository": "example/repo", "commit": sha, "subdir": "skill"}


@pytest.mark.parametrize("source", ["https://github.com@evil.test/o/r", "https://github.com/o/r?token=x", "https://evil.test/o/r"])
def test_non_github_urls_never_download(setup, monkeypatch, source):
    _, installer, _ = setup
    def unexpected(*args):
        pytest.fail("invalid URLs must not trigger a request")
    monkeypatch.setattr(module, "_download", unexpected)
    with pytest.raises(SkillValidationError):
        installer.preview(source, owner_key="pane-one")


def test_bundled_plugin_authoring_skill_installs_through_the_normal_path(setup):
    store, installer, _ = setup
    item = installer.preview("navide:plugin-authoring", owner_key="pane-one")
    assert item["name"] == "navide-plugin-authoring"
    assert item["source"] == {"kind": "bundled", "name": "plugin-authoring"}
    assert [entry["path"] for entry in item["files"]] == ["SKILL.md"]
    assert not store.root.exists()
    result = install(installer, item, consent=True)
    assert result["skill"]["provenance"]["source"] == {"kind": "bundled", "name": "plugin-authoring"}
    shipped = module.BUNDLED_ROOT / "plugin-authoring" / "SKILL.md"
    assert (store.root / "navide-plugin-authoring" / "SKILL.md").read_bytes() == shipped.read_bytes()
    reloaded = SkillsStore(root=store.root, state_path=store.state_path,
                           runtime_root=store.runtime_root, native_roots=[])
    assert reloaded.get_skill("navide-plugin-authoring")["skill"]["provenance"] == result["skill"]["provenance"]


@pytest.mark.parametrize("source", [
    "navide:", "navide:../plugin-authoring", "navide:plugin-authoring/../plugin-authoring",
    "navide:/etc", "navide:..", "navide:Plugin-Authoring", "navide:plugin_authoring",
    "navide:no-such-skill", "navide:plugin-authoring/SKILL.md", "navide:plugin-authoring\x00",
])
def test_bundled_source_resolves_only_folders_shipped_with_navide(setup, source):
    store, installer, _ = setup
    with pytest.raises(SkillValidationError, match="unknown Navide-bundled skill"):
        installer.preview(source, owner_key="pane-one")
    assert not store.root.exists()


def test_bundled_source_takes_no_ref_or_subdir(setup):
    _, installer, _ = setup
    with pytest.raises(SkillValidationError, match="no ref or subdir"):
        installer.preview("navide:plugin-authoring", owner_key="pane-one", subdir="x")


def test_bundled_source_never_reaches_the_network(setup, monkeypatch):
    _, installer, _ = setup
    def unexpected(*args):
        pytest.fail("a bundled skill must not trigger a request")
    monkeypatch.setattr(module, "_download", unexpected)
    installer.preview("navide:plugin-authoring", owner_key="pane-one")


def test_local_preview_source_is_unchanged_by_bundled_sources(setup):
    # Any source not starting with navide: keeps main's behaviour and shape.
    _, installer, source = setup
    item = preview(installer, source)
    assert item["source"] == {"kind": "local", "path": str(source.absolute())}


@pytest.mark.parametrize("source", [
    {"kind": "bundled", "name": "../x"},
    {"kind": "bundled", "name": "plugin-authoring", "path": "/tmp/x"},
    {"kind": "bundled"},
])
def test_malformed_bundled_receipt_is_refused(setup, source):
    store, installer, _ = setup
    item = installer.preview("navide:plugin-authoring", owner_key="pane-one")
    bundle = {"SKILL.md": {"data": (module.BUNDLED_ROOT / "plugin-authoring" / "SKILL.md").read_bytes(),
                           "executable": False}}
    with pytest.raises(SkillValidationError, match="provenance"):
        store.install_bundle("navide-plugin-authoring", bundle, targets=["codex"], consent=True,
                             provenance={"source": source, "digest": item["digest"]})

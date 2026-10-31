"""file_query — the Host side of `fs.queryFiles`: listing, filters, paging, staleness."""

from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import time
from collections.abc import Iterator
from pathlib import Path

import pytest

from agent_team_backend import app, file_query, fs_service


@pytest.fixture(autouse=True)
def _fresh_listings() -> Iterator[None]:
    file_query._entries.clear()
    yield
    file_query._entries.clear()


def _write(root: Path, *rels: str) -> None:
    for rel in rels:
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_text("x", encoding="utf-8")


def _paths(res: dict) -> list[str]:
    assert res["ok"] is True
    return [row["path"] for row in res["files"]]


def test_name_match_finds_a_file_by_its_name_only(tmp_path: Path) -> None:
    _write(tmp_path, "app/Services/OrderService.php", "app/Order/Other.php")
    assert _paths(file_query.query_files(str(tmp_path), "order")) == ["app/Services/OrderService.php"]


def test_path_match_finds_a_pasted_relative_path(tmp_path: Path) -> None:
    _write(tmp_path, "app/Services/OrderService.php", "legacy/app/Services/OrderService.php", "app/Other.php")
    res = file_query.query_files(str(tmp_path), "app/Services/OrderService.php", match_on="path")
    assert _paths(res) == ["app/Services/OrderService.php", "legacy/app/Services/OrderService.php"]


def test_windows_separators_in_a_query_match(tmp_path: Path) -> None:
    _write(tmp_path, "app/Foo.php")
    assert _paths(file_query.query_files(str(tmp_path), "app\\Foo", match_on="path")) == ["app/Foo.php"]


def test_subsequence_mode_reports_merged_spans(tmp_path: Path) -> None:
    _write(tmp_path, "OrderService.php", "Other.php")
    res = file_query.query_files(str(tmp_path), "ordsv", mode="subsequence")
    assert [(row["name"], row["matchSpans"]) for row in res["files"]] == [("OrderService.php", [[0, 3], [5, 6], [8, 9]])]


def test_substring_mode_reports_its_span_in_the_matched_field(tmp_path: Path) -> None:
    _write(tmp_path, "src/Foo.ts")
    assert file_query.query_files(str(tmp_path), "foo")["files"][0]["matchSpans"] == [[0, 3]]
    assert file_query.query_files(str(tmp_path), "foo", match_on="path")["files"][0]["matchSpans"] == [[4, 7]]


def test_glob_mode(tmp_path: Path) -> None:
    _write(tmp_path, "src/a.ts", "src/b.py")
    assert _paths(file_query.query_files(str(tmp_path), "src/*.ts", match_on="path", mode="glob")) == ["src/a.ts"]


def test_results_are_in_path_order_with_no_ranking(tmp_path: Path) -> None:
    _write(tmp_path, "z/Foo.ts", "a/FooBar.ts", "m/Foo.ts")
    assert _paths(file_query.query_files(str(tmp_path), "foo")) == ["a/FooBar.ts", "m/Foo.ts", "z/Foo.ts"]


def test_hidden_files_and_noise_dirs_need_asking_for(tmp_path: Path) -> None:
    _write(tmp_path, "a.ts", ".env", "node_modules/x/a.ts", ".git/config")
    assert _paths(file_query.query_files(str(tmp_path))) == ["a.ts"]
    assert ".env" in _paths(file_query.query_files(str(tmp_path), include_hidden=True))
    with_noise = _paths(file_query.query_files(str(tmp_path), include_noise_dirs=True))
    assert "node_modules/x/a.ts" in with_noise
    both = _paths(file_query.query_files(str(tmp_path), include_hidden=True, include_noise_dirs=True))
    assert not any(path.startswith(".git/") for path in both)


def test_exclude_globs_take_a_vendor_tree_out(tmp_path: Path) -> None:
    _write(tmp_path, "app/Foo.php", "vendor/acme/Foo.php")
    assert _paths(file_query.query_files(str(tmp_path), "foo", exclude=["vendor/*"])) == ["app/Foo.php"]


@pytest.mark.skipif(shutil.which("rg") is None or shutil.which("git") is None, reason="needs rg and git")
def test_gitignore_is_applied_by_default_and_can_be_turned_off(tmp_path: Path) -> None:
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True, stdin=subprocess.DEVNULL)
    _write(tmp_path, "keep.txt", "skip.log")
    (tmp_path / ".gitignore").write_text("*.log\n", encoding="utf-8")
    res = file_query.query_files(str(tmp_path))
    assert (_paths(res), res["gitignoreApplied"]) == (["keep.txt"], True)
    res = file_query.query_files(str(tmp_path), respect_gitignore=False)
    assert (_paths(res), res["gitignoreApplied"]) == (["keep.txt", "skip.log"], False)


def test_without_ripgrep_it_walks_and_says_gitignore_was_not_applied(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(file_query, "_rg_bin", lambda: None)
    _write(tmp_path, "keep.txt", "skip.log")
    (tmp_path / ".gitignore").write_text("*.log\n", encoding="utf-8")
    res = file_query.query_files(str(tmp_path))
    assert (_paths(res), res["gitignoreApplied"]) == (["keep.txt", "skip.log"], False)


def test_cursor_pages_through_every_match_once(tmp_path: Path) -> None:
    _write(tmp_path, *(f"f{i}.ts" for i in range(5)))
    seen: list[str] = []
    cursor = ""
    for _ in range(5):
        res = file_query.query_files(str(tmp_path), limit=2, cursor=cursor)
        seen += _paths(res)
        cursor = res.get("nextCursor", "")
        if not cursor:
            break
    assert seen == [f"f{i}.ts" for i in range(5)]


def test_invalid_arguments_are_refused(tmp_path: Path) -> None:
    assert file_query.query_files(str(tmp_path / "missing"))["ok"] is False
    assert file_query.query_files(str(tmp_path), match_on="content")["ok"] is False
    assert file_query.query_files(str(tmp_path), mode="regex")["ok"] is False
    assert file_query.query_files(str(tmp_path), cursor="abc")["ok"] is False


def test_a_listing_is_reused_until_invalidated(tmp_path: Path) -> None:
    _write(tmp_path, "a.ts")
    assert _paths(file_query.query_files(str(tmp_path))) == ["a.ts"]
    _write(tmp_path, "b.ts")
    assert _paths(file_query.query_files(str(tmp_path))) == ["a.ts"]
    file_query.invalidate(str(tmp_path))
    assert _paths(file_query.query_files(str(tmp_path))) == ["a.ts", "b.ts"]


def test_a_listing_expires_when_nothing_invalidates_it(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _write(tmp_path, "a.ts")
    file_query.query_files(str(tmp_path))
    _write(tmp_path, "b.ts")
    monkeypatch.setattr(file_query, "_MAX_AGE_S", -1.0)
    assert _paths(file_query.query_files(str(tmp_path))) == ["a.ts", "b.ts"]


def test_a_file_removed_since_the_listing_is_left_out(tmp_path: Path) -> None:
    _write(tmp_path, "a.ts", "b.ts")
    file_query.query_files(str(tmp_path))
    (tmp_path / "a.ts").unlink()
    assert _paths(file_query.query_files(str(tmp_path))) == ["b.ts"]


@pytest.mark.skipif(os.name == "nt", reason="symlinks need privileges on Windows")
@pytest.mark.parametrize("respect_gitignore", [True, False], ids=["rg", "walk"])
def test_links_are_not_listed(tmp_path: Path, respect_gitignore: bool) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.txt").write_text("x", encoding="utf-8")
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "real.txt").write_text("x", encoding="utf-8")
    (ws / "link.txt").symlink_to(outside / "secret.txt")
    (ws / "dir").symlink_to(outside, target_is_directory=True)
    assert _paths(file_query.query_files(str(ws), respect_gitignore=respect_gitignore)) == ["real.txt"]


def test_workspaces_beyond_the_cap_release_their_listings(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(file_query, "_MAX_WORKSPACES", 2)
    for name in ("a", "b", "c"):
        (tmp_path / name).mkdir()
        file_query.query_files(str(tmp_path / name))
    assert len(file_query._entries) == 2


def test_a_tree_past_the_cap_says_the_listing_is_truncated(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(file_query, "_MAX_PATHS", 3)
    _write(tmp_path, *(f"f{i}.ts" for i in range(6)))
    res = file_query.query_files(str(tmp_path), respect_gitignore=False)
    assert (len(res["files"]), res["listingTruncated"]) == (3, True)


def test_list_files_flat_is_unaffected_by_the_listing_cache(tmp_path: Path) -> None:
    # `fs.listFilesFlat` keeps walking the tree: existing callers see a new file at once.
    _write(tmp_path, "a.ts")
    file_query.query_files(str(tmp_path))
    _write(tmp_path, "b.ts")
    assert sorted(fs_service.list_files_flat(str(tmp_path), "")["files"]) == ["a.ts", "b.ts"]


def test_a_watched_change_drops_the_listing(tmp_path: Path) -> None:
    # The sink the GitWatcher calls: `app._broadcast_git_changed` must reach `invalidate`.
    _write(tmp_path, "a.ts")
    file_query.query_files(str(tmp_path))
    _write(tmp_path, "b.ts")
    asyncio.run(app._broadcast_git_changed(str(tmp_path)))
    assert _paths(file_query.query_files(str(tmp_path))) == ["a.ts", "b.ts"]


class _FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send_json(self, payload: dict) -> None:
        self.sent.append(payload)


async def _ws_query(payload: dict) -> dict:
    session = app.Session(_FakeWebSocket())  # type: ignore[arg-type]
    await app.handle_message(session, {"id": "q", "type": "fs.query_files", "payload": payload})
    return session.websocket.sent[0]["payload"]  # type: ignore[attr-defined]


async def test_ws_handler_passes_the_strategy_through(tmp_path: Path) -> None:
    _write(tmp_path, "app/Foo.php", "vendor/Foo.php")
    res = await _ws_query({
        "workspace_path": str(tmp_path), "query": "foo", "match_on": "path", "mode": "substring",
        "exclude": ["vendor/*"], "limit": 5,
    })
    assert _paths(res) == ["app/Foo.php"]


async def test_ws_handler_defaults_match_the_catalog(tmp_path: Path) -> None:
    _write(tmp_path, "src/Foo.ts", ".hidden.ts")
    res = await _ws_query({"workspace_path": str(tmp_path), "query": "foo"})
    assert _paths(res) == ["src/Foo.ts"]
    assert res["files"][0]["matchSpans"] == [[0, 3]]


async def test_ws_handler_reports_a_bad_mode_instead_of_failing(tmp_path: Path) -> None:
    res = await _ws_query({"workspace_path": str(tmp_path), "query": "", "mode": "regex"})
    assert res == {"ok": False, "error": "invalid matchOn or mode"}


@pytest.mark.parametrize(
    "request_kwargs",
    [
        {"query": "x" * (file_query.MAX_QUERY_CHARS + 1)},
        {"exclude": ["a"] * (file_query.MAX_EXCLUDES + 1)},
        {"exclude": ["x" * (file_query.MAX_EXCLUDE_CHARS + 1)]},
    ],
    ids=["long-query", "many-excludes", "long-exclude"],
)
def test_oversized_requests_are_refused_before_any_listing(tmp_path: Path, request_kwargs: dict) -> None:
    res = file_query.query_files(str(tmp_path), **request_kwargs)
    assert res == {"ok": False, "error": "query or exclude is too long"}
    assert file_query._entries == {}


def test_requests_at_the_limits_are_served(tmp_path: Path) -> None:
    _write(tmp_path, "a.ts")
    res = file_query.query_files(
        str(tmp_path),
        "x" * file_query.MAX_QUERY_CHARS,
        exclude=["y" * file_query.MAX_EXCLUDE_CHARS] * file_query.MAX_EXCLUDES,
    )
    assert res["ok"] is True


def test_many_paths_times_many_patterns_returns_inside_the_deadline(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # The 300k × patterns case, against a seeded listing so no tree has to exist.
    paths = [f"dir{i % 1000}/file{i}.ts" for i in range(300_000)]
    listing = file_query._Listing(paths, True, False, time.monotonic())
    monkeypatch.setattr(file_query, "_listing", lambda *_args: listing)
    monkeypatch.setattr(file_query, "_QUERY_DEADLINE_S", 0.05)
    started = time.monotonic()
    res = file_query.query_files(str(tmp_path), "nomatch", exclude=[f"a{i}*b*c*d*e" for i in range(file_query.MAX_EXCLUDES)])
    elapsed = time.monotonic() - started
    assert elapsed < 2.0
    assert res["ok"] is True and res["timedOut"] is True
    assert res["files"] == []
    assert 0 < int(res["nextCursor"]) < len(paths)


def test_a_timed_out_query_resumes_from_its_cursor(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _write(tmp_path, "a.ts")
    monkeypatch.setattr(file_query, "_QUERY_DEADLINE_S", -1.0)
    res = file_query.query_files(str(tmp_path))
    assert (res["files"], res["nextCursor"], res["timedOut"]) == ([], "0", True)
    monkeypatch.setattr(file_query, "_QUERY_DEADLINE_S", 3.0)
    res = file_query.query_files(str(tmp_path), cursor=res["nextCursor"])
    assert _paths(res) == ["a.ts"] and "timedOut" not in res


@pytest.mark.skipif(os.name == "nt", reason="uses a POSIX shell script as a stuck rg")
def test_a_stuck_rg_is_stopped_at_the_deadline_with_no_output_to_check_on(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    stuck = tmp_path / "stuck-rg"
    stuck.write_text("#!/bin/sh\nexec sleep 60\n", encoding="utf-8")
    stuck.chmod(0o755)
    ws = tmp_path / "ws"
    ws.mkdir()
    monkeypatch.setattr(file_query, "_rg_bin", lambda: str(stuck))
    monkeypatch.setattr(file_query, "_LIST_DEADLINE_S", 0.2)
    started = time.monotonic()
    res = file_query.query_files(str(ws))
    assert time.monotonic() - started < 5.0
    assert (res["ok"], res["files"], res["listingTruncated"], res["gitignoreApplied"]) == (True, [], True, True)


def test_the_walk_keeps_the_same_deadline(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _write(tmp_path, "a/a.ts", "b/b.ts")
    monkeypatch.setattr(file_query, "_LIST_DEADLINE_S", -1.0)
    res = file_query.query_files(str(tmp_path), respect_gitignore=False)
    assert (res["files"], res["listingTruncated"]) == ([], True)

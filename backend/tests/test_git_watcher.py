"""GitWatcher: noise filtering + debounced on_change(ws_path) on disk changes."""

from __future__ import annotations

import asyncio
from pathlib import Path

from watchdog.events import FileModifiedEvent

import pytest

from agent_team_backend.gitignore import GitIgnore
from agent_team_backend.git_watcher import GitWatcher, _RepoHandler
from tests.watcher_arming import arm, arming_delay, wait_until  # noqa: F401


def _handler(root: Path) -> _RepoHandler:
    return _RepoHandler(root.resolve(), str(root), lambda _ws, _paths: None)


def test_working_tree_file_is_relevant(tmp_path: Path) -> None:
    h = _handler(tmp_path)
    assert h._is_relevant(str(tmp_path / "src" / "main.py")) is True


def test_is_plan_doc_covers_all_supported_dirs(tmp_path: Path) -> None:
    h = _handler(tmp_path)
    valid_paths = [
        ".agent-team/plans/feature.html",
        ".agent-team/plans/legacy.plan.md",
        ".agent-team/reports/summary.html",
        ".agent-team/reports/notes.md",
        ".claude/loop-reports/loop1.html",
        ".claude/plans/task.md",
        ".cursor/plans/arch.plan.md",
        "docs/plans/roadmap.md",
        "docs/reports/analysis.html",
    ]
    for p in valid_paths:
        assert h._is_plan_doc(str(tmp_path / p)) is True, p

    invalid_paths = [
        ".agent-team/plans/_spec.md",       # infra file
        ".agent-team/plans/.hidden.md",     # dot file
        ".agent-team/other/doc.md",         # unsupported sub-dir
        "other/plans/doc.md",               # root dir not in allowed list
        ".agent-team/plans/sub/deep.md",    # nested sub-dir
    ]
    for p in invalid_paths:
        assert h._is_plan_doc(str(tmp_path / p)) is False, p


def test_is_plan_doc_covers_nested_plan_roots(tmp_path: Path) -> None:
    """plan_index lists a nested repository's documents, so they must notify too."""
    h = _handler(tmp_path)
    for p in [
        "project/.agent-team/plans/feature.html",
        "packages/app/docs/reports/analysis.md",
    ]:
        assert h._is_plan_doc(str(tmp_path / p)) is True, p

    for p in [
        "node_modules/pkg/.agent-team/plans/dep.html",  # a dependency's document
        "dist/.claude/plans/built.md",                  # build output
        "project/.agent-team/plans/.history/snap.html",  # snapshot churn
    ]:
        assert h._is_plan_doc(str(tmp_path / p)) is False, p


def test_build_dirs_are_ignored(tmp_path: Path) -> None:
    h = _handler(tmp_path)
    for noise in ("node_modules/x/y.js", ".venv/lib/z.py", "dist/bundle.js",
                  "__pycache__/m.pyc"):
        assert h._is_relevant(str(tmp_path / noise)) is False, noise


def test_laravel_storage_churn_is_scoped(tmp_path: Path) -> None:
    h = _handler(tmp_path)
    for noise in ("storage/framework/sessions/abc", "storage/logs/laravel.log"):
        assert h._is_relevant(str(tmp_path / noise)) is False, noise
    # Other storage/ content (e.g. tracked uploads) must still be reported —
    # the scoping must not swallow a whole "storage" dir in unrelated projects.
    assert h._is_relevant(str(tmp_path / "storage" / "app" / "upload.jpg")) is True


def test_git_state_files_are_relevant(tmp_path: Path) -> None:
    h = _handler(tmp_path)
    for state in (".git/index", ".git/HEAD", ".git/MERGE_HEAD",
                  ".git/refs/heads/main", ".git/packed-refs"):
        assert h._is_relevant(str(tmp_path / state)) is True, state


def test_git_internal_churn_is_ignored(tmp_path: Path) -> None:
    h = _handler(tmp_path)
    for churn in (".git/index.lock", ".git/objects/ab/cdef",
                  ".git/logs/HEAD", ".git/refs/heads/main.lock"):
        assert h._is_relevant(str(tmp_path / churn)) is False, churn


@pytest.mark.asyncio
async def test_on_change_fires_debounced_on_file_write(tmp_path: Path, arming_delay: float) -> None:
    fired: list[tuple[str, set[str]]] = []

    async def sink(ws: str, paths: list[tuple[str, str]]) -> None:
        fired.append((ws, {rel for rel, _ in paths}))

    watcher = GitWatcher(sink, debounce_s=0.5)
    watcher.start()
    try:
        watcher.watch(str(tmp_path))
        await arm(tmp_path, fired, per_probe_s=2.0)
        # Burst of writes should coalesce into a single on_change call.
        burst = {f"f{i}.txt" for i in range(5)}
        for name in sorted(burst):
            (tmp_path / name).write_text("x")
        assert await wait_until(lambda: any(paths & burst for _, paths in fired))
        # Let a further debounce window pass: the burst must not fire twice.
        await asyncio.sleep(1.0)
        hits = [(ws, paths & burst) for ws, paths in fired if paths & burst]
        assert hits == [(str(tmp_path), burst)]
    finally:
        watcher.stop()


@pytest.mark.asyncio
async def test_noise_write_does_not_fire(tmp_path: Path, arming_delay: float) -> None:
    fired: list[set[str]] = []

    async def sink(ws: str, paths: list[tuple[str, str]]) -> None:
        fired.append({rel for rel, _ in paths})

    watcher = GitWatcher(sink, debounce_s=0.1)
    watcher.start()
    try:
        watcher.watch(str(tmp_path))
        # Without arming, a watcher that is not reading yet passes this vacuously.
        await arm(tmp_path, fired, per_probe_s=2.0)
        nm = tmp_path / "node_modules" / "pkg"; nm.mkdir(parents=True)
        (nm / "index.js").write_text("x")
        # A write after the noise: once it is reported, the noise was judged.
        (tmp_path / "sentinel.txt").write_text("x")
        assert await wait_until(lambda: any("sentinel.txt" in paths for paths in fired))
        assert not any(rel.startswith("node_modules") for paths in fired for rel in paths)
    finally:
        watcher.stop()


@pytest.mark.asyncio
async def test_sustained_churn_still_fires_and_keeps_the_window_bounded() -> None:
    # A writer that never pauses for a whole debounce window (a test run
    # generating output, a log appended every few ms) used to push the timer
    # back forever: nothing fired, and every new path piled into the open
    # window for as long as the writer kept going — unbounded memory, and a
    # Git panel that never refreshed.
    fired: list[list[tuple[str, str]]] = []

    async def sink(ws: str, paths: list[tuple[str, str]]) -> None:
        fired.append(paths)

    watcher = GitWatcher(sink, debounce_s=0.1, max_wait_s=0.3)
    watcher._loop = asyncio.get_running_loop()
    largest_window = 0
    sent: set[tuple[str, str]] = set()
    for i in range(40):
        pair = (f"out/f{i}.json", "created")
        sent.add(pair)
        watcher._schedule_fire("/ws", [pair])
        largest_window = max(largest_window, len(watcher._dirty_paths.get("/ws", ())))
        await asyncio.sleep(0.03)
    await asyncio.sleep(0.2)

    assert len(fired) >= 3
    assert largest_window <= 15
    assert {pair for paths in fired for pair in paths} == sent
    assert watcher._dirty_paths == {}



async def test_a_failing_change_sink_is_logged_not_lost(caplog) -> None:
    # The sink runs as a fire-and-forget task; an exception in it must reach
    # the log, not asyncio's "Task exception was never retrieved" (#144).
    import gc

    seen: list[dict] = []
    asyncio.get_running_loop().set_exception_handler(lambda _loop, ctx: seen.append(ctx))

    async def sink(ws: str, paths: list[tuple[str, str]]) -> None:
        raise RuntimeError("broadcast failed")

    watcher = GitWatcher(sink, debounce_s=0.05)
    watcher._loop = asyncio.get_running_loop()
    watcher._schedule_fire("/ws", [("a.txt", "modified")])
    await asyncio.sleep(0.2)
    gc.collect()
    await asyncio.sleep(0)
    assert seen == []
    assert "broadcast failed" in caplog.text

# ── .gitignore layer ──────────────────────────────────────────────────────────
#
# The fixed segment list compares whole names, so `dist-release` never matched
# `dist` and a packaging run fired a git refresh per file it wrote. These cover
# the layer that closes that gap, and — more importantly — that it only ever
# adds filtering, since removing a signal here is silent: the Git panel just
# quietly stops updating.


def _ignoring_handler(root: Path, gitignore: str) -> _RepoHandler:
    (root / ".gitignore").write_text(gitignore, encoding="utf-8")
    return _RepoHandler(
        root.resolve(), str(root), lambda _ws, _paths: None, None, GitIgnore(root.resolve())
    )


def test_dirs_the_fixed_list_misses_are_filtered_by_gitignore(tmp_path: Path) -> None:
    h = _ignoring_handler(tmp_path, "dist-release/\ndist-local/\ndist-plugins/\n")
    for d in ("dist-release", "dist-local", "dist-plugins"):
        assert h._is_relevant(str(tmp_path / d / "mac" / "app.zip")) is False, d


def test_an_unignored_neighbour_still_reports(tmp_path: Path) -> None:
    # The bug being fixed is over-reporting; fixing it by under-reporting would
    # be worse. `dist-other` looks like the ignored ones and is not ignored.
    h = _ignoring_handler(tmp_path, "dist-release/\n")
    assert h._is_relevant(str(tmp_path / "dist-other" / "keep.txt")) is True
    assert h._is_relevant(str(tmp_path / "src" / "main.py")) is True


def test_the_fixed_list_still_applies_without_a_gitignore(tmp_path: Path) -> None:
    # This repo's own `build/` is untracked and unignored: if .gitignore had
    # replaced the fixed list rather than adding to it, build churn would start
    # firing refreshes.
    h = _ignoring_handler(tmp_path, "")
    assert h._is_relevant(str(tmp_path / "build" / "out.o")) is False
    assert h._is_relevant(str(tmp_path / "node_modules" / "x" / "i.js")) is False


def test_a_workspace_with_no_ignore_rules_at_all_still_reports(tmp_path: Path) -> None:
    h = _RepoHandler(
        tmp_path.resolve(), str(tmp_path), lambda _ws, _paths: None, None, GitIgnore(tmp_path)
    )
    assert h._is_relevant(str(tmp_path / "src" / "main.py")) is True


def test_directory_only_rules_do_not_swallow_a_file_of_the_same_name(
    tmp_path: Path,
) -> None:
    h = _ignoring_handler(tmp_path, "cache/\n")
    assert h._is_relevant(str(tmp_path / "cache" / "x"), True) is False
    # `cache/` with a trailing slash is a directory rule; a *file* named cache
    # is a different thing and git does not ignore it.
    assert h._is_relevant(str(tmp_path / "cache"), False) is True


def test_editing_the_gitignore_takes_effect_on_that_event(tmp_path: Path) -> None:
    # Rules are cached, so without invalidation the first write after someone
    # ignores a directory — and every write after it — would still get through.
    h = _ignoring_handler(tmp_path, "")
    target = str(tmp_path / "artifacts" / "x.bin")
    assert h._is_relevant(target) is True
    (tmp_path / ".gitignore").write_text("artifacts/\n", encoding="utf-8")
    h.on_any_event(FileModifiedEvent(str(tmp_path / ".gitignore")))
    assert h._is_relevant(target) is False


def test_plan_documents_still_fire_after_the_gitignore_layer(tmp_path: Path) -> None:
    # .agent-team is ignored by both layers, and plan documents live inside it.
    # Their channel is checked before the filter; a refactor that moved the
    # gitignore check earlier would silently stop the Plans list refreshing.
    seen: list[str] = []
    (tmp_path / ".gitignore").write_text(".agent-team/\n", encoding="utf-8")
    h = _RepoHandler(
        tmp_path.resolve(),
        str(tmp_path),
        lambda _ws, _paths: None,
        seen.append,
        GitIgnore(tmp_path.resolve()),
    )
    plan = tmp_path / ".agent-team" / "plans" / "doc.html"
    plan.parent.mkdir(parents=True)
    plan.write_text("<p>x</p>", encoding="utf-8")
    h.on_any_event(FileModifiedEvent(str(plan)))
    assert seen == [str(tmp_path)]

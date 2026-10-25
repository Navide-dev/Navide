"""GitWatcher: noise filtering + debounced on_change(ws_path) on disk changes."""

from __future__ import annotations

import asyncio
import sys
import threading
from pathlib import Path

from watchdog.events import (
    DirCreatedEvent,
    DirDeletedEvent,
    DirModifiedEvent,
    DirMovedEvent,
    FileClosedEvent,
    FileClosedNoWriteEvent,
    FileCreatedEvent,
    FileDeletedEvent,
    FileModifiedEvent,
    FileMovedEvent,
    FileOpenedEvent,
    FileSystemEvent,
)

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


# ── #622: read-only events must never reach the handler's work ─────────────
#
# watchdog's inotify emitter (Linux) reports reads too: an open() is an
# `opened` event and a read-only close is `closed_no_write`. Reading
# .gitignore to judge such an event produced two more of them, so the handler
# fed itself, the Git panel refreshed every ~2s with nothing changed, and the
# observer's unbounded queue grew with every file any pane read.


class _FutureEvent(FileSystemEvent):
    """An event type this handler has never heard of."""

    event_type = "accessed"


def _counting_handler(root: Path, gitignore: str) -> tuple[_RepoHandler, list, list[str]]:
    (root / ".gitignore").write_text(gitignore, encoding="utf-8")
    dirty: list = []
    reads: list[str] = []
    ignores = GitIgnore(root.resolve())
    orig_read = ignores._read

    def read(path: Path) -> str:
        reads.append(str(path))
        return orig_read(path)

    ignores._read = read  # type: ignore[method-assign]
    h = _RepoHandler(
        root.resolve(), str(root), lambda ws, paths: dirty.append(paths), None, ignores
    )
    return h, dirty, reads


@pytest.mark.parametrize(
    "event_cls", [FileOpenedEvent, FileClosedEvent, FileClosedNoWriteEvent, _FutureEvent]
)
def test_events_that_change_nothing_are_dropped(tmp_path: Path, event_cls: type) -> None:
    h, dirty, reads = _counting_handler(tmp_path, "build-out/\n")
    for rel in (".gitignore", ".git/info/exclude", ".git/HEAD", "src/main.py"):
        h.on_any_event(event_cls(str(tmp_path / rel)))
    assert dirty == []
    assert reads == []


def test_reading_the_ignore_files_does_not_feed_itself(tmp_path: Path) -> None:
    # Replays inotify: every file the handler reads comes back to it as the
    # opened + closed_no_write pair the kernel would report. Before the fix
    # this never settled; now the first event is the last.
    (tmp_path / ".git" / "info").mkdir(parents=True)
    (tmp_path / ".git" / "info" / "exclude").write_text("", encoding="utf-8")
    h, dirty, reads = _counting_handler(tmp_path, "build-out/\n")
    queue = [FileClosedNoWriteEvent(str(tmp_path / ".gitignore"))]
    handled = 0
    while queue and handled < 1000:
        seen = len(reads)
        h.on_any_event(queue.pop(0))
        handled += 1
        for path in reads[seen:]:
            queue += [FileOpenedEvent(path), FileClosedNoWriteEvent(path)]
    assert handled == 1
    assert dirty == []


@pytest.mark.parametrize(
    "event",
    [
        lambda p: FileCreatedEvent(str(p / "a.txt")),
        lambda p: FileModifiedEvent(str(p / "a.txt")),
        lambda p: FileDeletedEvent(str(p / "a.txt")),
        lambda p: FileMovedEvent(str(p / "a.txt"), str(p / "b.txt")),
        lambda p: DirCreatedEvent(str(p / "d")),
        lambda p: DirModifiedEvent(str(p / "d")),
        lambda p: DirDeletedEvent(str(p / "d")),
        lambda p: DirMovedEvent(str(p / "d"), str(p / "e")),
    ],
)
def test_every_change_event_still_marks_the_workspace_dirty(tmp_path: Path, event) -> None:
    h, dirty, _ = _counting_handler(tmp_path, "")
    h.on_any_event(event(tmp_path))
    assert len(dirty) == 1


@pytest.mark.asyncio
@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="inotify reports reads")
async def test_reading_files_in_the_repo_fires_nothing_on_inotify(tmp_path: Path) -> None:
    (tmp_path / ".gitignore").write_text("build-out/\n", encoding="utf-8")
    (tmp_path / "src.py").write_text("x = 1\n", encoding="utf-8")
    fired: list[set[str]] = []

    async def sink(ws: str, paths: list[tuple[str, str]]) -> None:
        fired.append({rel for rel, _ in paths})

    watcher = GitWatcher(sink, debounce_s=0.1, max_wait_s=0.5)
    watcher.start()
    try:
        watcher.watch(str(tmp_path))
        await arm(tmp_path, fired, per_probe_s=2.0)
        # Let the probe windows close, then only read.
        await asyncio.sleep(1.0)
        fired.clear()
        for _ in range(20):
            (tmp_path / ".gitignore").read_text(encoding="utf-8")
            (tmp_path / "src.py").read_text(encoding="utf-8")
        await asyncio.sleep(2.0)
        assert fired == []
        # A real write still gets through afterwards.
        (tmp_path / "sentinel.txt").write_text("x", encoding="utf-8")
        assert await wait_until(lambda: any("sentinel.txt" in p for p in fired))
    finally:
        watcher.stop()


# ── #622: each event resolves each of its paths once ───────────────────────
#
# `Path.resolve()` walks the path on disk (an lstat per component), and this
# handler runs on watchdog's single dispatch thread: three resolves of the same
# path per event made a checkout or a build three times as slow to get through.


@pytest.mark.parametrize(
    "make",
    [
        lambda p: FileModifiedEvent(str(p / "src" / "main.py")),
        lambda p: FileModifiedEvent(str(p / ".agent-team" / "plans" / "doc.html")),
        lambda p: FileMovedEvent(str(p / "src" / "a.py"), str(p / "src" / "b.py")),
    ],
)
def test_each_path_is_resolved_once_per_event(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, make
) -> None:
    dirty: list = []
    plans: list[str] = []
    h = _RepoHandler(
        tmp_path.resolve(),
        str(tmp_path),
        lambda ws, paths: dirty.append(paths),
        plans.append,
        GitIgnore(tmp_path.resolve()),
    )
    event = make(tmp_path)
    resolved: list[str] = []
    orig = Path.resolve

    def counting(self: Path, strict: bool = False) -> Path:
        resolved.append(str(self))
        return orig(self, strict=strict)

    monkeypatch.setattr(Path, "resolve", counting)
    h.on_any_event(event)
    monkeypatch.setattr(Path, "resolve", orig)
    paths = [event.src_path] + ([event.dest_path] if event.event_type == "moved" else [])
    assert sorted(resolved) == sorted(paths)
    # And the answers are what they were.
    if "plans" in event.src_path:
        assert plans == [str(tmp_path)] and dirty == []
    elif event.event_type == "moved":
        assert dirty == [[("src/a.py", "deleted"), ("src/b.py", "created")]]
    else:
        assert dirty == [[("src/main.py", "modified")]]


# ── #622: a burst of events wakes the loop a bounded number of times ───────
#
# Every relevant event used to hop to the loop with its own
# call_soon_threadsafe, and each of those cancelled and re-armed the debounce
# timer: a checkout, or a flood like #622's, put one callback, one wake-up
# write and one timer per event onto the event loop. The burst now coalesces
# on the observer side and the loop drains it in one go.


@pytest.mark.asyncio
async def test_an_event_flood_schedules_a_bounded_number_of_loop_callbacks() -> None:
    fired: list[tuple[str, list[tuple[str, str]]]] = []

    async def sink(ws: str, paths: list[tuple[str, str]]) -> None:
        fired.append((ws, paths))

    loop = asyncio.get_running_loop()
    watcher = GitWatcher(sink, debounce_s=0.2, max_wait_s=2.0)
    watcher._loop = loop
    hops = 0
    orig = loop.call_soon_threadsafe

    def counting(*args, **kwargs):
        nonlocal hops
        hops += 1
        return orig(*args, **kwargs)

    loop.call_soon_threadsafe = counting  # type: ignore[method-assign]
    try:
        sent = {(f"src/f{i}.py", "modified") for i in range(5000)}

        def flood() -> None:
            # The observer thread, marking dirty once per event.
            for pair in sorted(sent):
                watcher._mark_dirty_threadsafe("/ws", [pair])
            watcher._mark_dirty_threadsafe("/other", [])

        await asyncio.to_thread(flood)
        assert await wait_until(lambda: len(fired) == 2, timeout=5.0)
    finally:
        loop.call_soon_threadsafe = orig  # type: ignore[method-assign]
    assert hops <= 50, hops
    # Nothing was lost on the way: one refresh per workspace, every path in it.
    by_ws = dict(fired)
    assert set(by_ws["/ws"]) == sent
    assert by_ws["/other"] == []


@pytest.mark.asyncio
async def test_a_mark_arriving_while_the_inbox_drains_is_not_lost() -> None:
    # The drain clears its queued flag before it hands the batch on, so a mark
    # that lands mid-drain queues the next drain itself. Reset the flag after
    # the batch instead and that mark sits in the inbox until something else
    # happens to wake the loop, which may be never.
    fired: list[str] = []

    async def sink(ws: str, paths: list[tuple[str, str]]) -> None:
        fired.append(ws)

    w = GitWatcher(sink, debounce_s=0.05, max_wait_s=0.5)
    w._loop = asyncio.get_running_loop()
    orig = w._schedule_fire
    injected = False

    def sched(ws: str, paths: list[tuple[str, str]]) -> None:
        nonlocal injected
        orig(ws, paths)
        if not injected:
            injected = True
            # The observer thread marking dirty while this drain is running.
            t = threading.Thread(
                target=w._mark_dirty_threadsafe, args=("/late", [("late.py", "modified")])
            )
            t.start()
            t.join()

    w._schedule_fire = sched  # type: ignore[method-assign]
    await asyncio.to_thread(w._mark_dirty_threadsafe, "/ws", [("a.py", "modified")])
    assert await wait_until(lambda: "/late" in fired, timeout=2.0)


@pytest.mark.asyncio
async def test_a_restarted_watcher_drains_again() -> None:
    # A drain queued on a loop that closed before running it leaves the flag
    # set; start() must clear it, or every later mark is swallowed.
    fired: list[str] = []

    async def sink(ws: str, paths: list[tuple[str, str]]) -> None:
        fired.append(ws)

    w = GitWatcher(sink, debounce_s=0.05, max_wait_s=0.5)
    w._drain_queued = True
    w._inbox = {"/stale": []}
    w.start()
    try:
        await asyncio.to_thread(w._mark_dirty_threadsafe, "/ws", [("a.py", "modified")])
        assert await wait_until(lambda: "/ws" in fired, timeout=2.0)
        assert "/stale" not in fired
    finally:
        w.stop()

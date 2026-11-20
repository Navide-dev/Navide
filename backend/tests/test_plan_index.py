"""plan_index: directory scan, meta cache hits/misses, and cache hygiene."""

from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
from typing import Callable

import pytest

from agent_team_backend.db import DB_FILENAME, WorkspaceDatabases
from agent_team_backend.plan_index import (
    PLAN_DOC_DIRS,
    PlanIndex,
    _DOC_SUFFIXES,
    _MAX_DIRECTORY_ENTRIES,
    _MAX_NESTED_CANDIDATES,
    _MAX_NESTED_ROOTS,
    _MAX_ROOT_DEPTH,
    _NOISE_SEGMENTS,
    find_nested_plan_roots,
    is_plan_doc_name,
    is_plan_doc_rel_path,
    resolve_plan_root,
)


@pytest.fixture()
def index() -> PlanIndex:
    return PlanIndex(databases=WorkspaceDatabases())


def _write(ws: Path, rel_path: str, content: str = "x") -> Path:
    target = ws / rel_path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    return target


def _by_rel(result: dict) -> dict[str, dict]:
    return {doc["rel_path"]: doc for doc in result["docs"]}


# ── Name / path filters ─────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "name,expected",
    [
        ("plan_a1b2c3.html", True),
        ("legacy.plan.md", True),
        ("report.md", True),
        ("PLAN.HTML", True),  # suffix match is case-insensitive
        ("_spec.md", False),  # infrastructure
        ("_template.html", False),
        (".hidden.html", False),
        ("notes.txt", False),
        ("plan.html.bak", False),
    ],
)
def test_is_plan_doc_name(name: str, expected: bool) -> None:
    assert is_plan_doc_name(name) is expected


@pytest.mark.parametrize(
    "rel_path,expected",
    [
        (".agent-team/plans/a.html", True),
        ("docs/reports/b.md", True),
        (".agent-team/plans/_spec.md", False),
        (".agent-team/plans/sub/a.html", False),  # only the directory's own level
        ("some/other/dir/a.html", False),
        ("a.html", False),
        ("../escape.html", False),
        ("", False),
    ],
)
def test_is_plan_doc_rel_path(rel_path: str, expected: bool) -> None:
    assert is_plan_doc_rel_path(rel_path) is expected


# ── Scanning ────────────────────────────────────────────────────────────────


def test_list_docs_finds_every_plan_dir(tmp_path: Path, index: PlanIndex) -> None:
    for rel_dir in PLAN_DOC_DIRS:
        _write(tmp_path, f"{rel_dir}/doc.html")

    docs = _by_rel(index.list_docs(str(tmp_path)))

    assert set(docs) == {f"{d}/doc.html" for d in PLAN_DOC_DIRS}
    assert all(doc["cached"] is False and doc["meta"] is None for doc in docs.values())


def test_list_docs_excludes_infra_hidden_and_dirs(tmp_path: Path, index: PlanIndex) -> None:
    _write(tmp_path, ".agent-team/plans/real.html")
    _write(tmp_path, ".agent-team/plans/_spec.md")
    _write(tmp_path, ".agent-team/plans/.hidden.html")
    _write(tmp_path, ".agent-team/plans/notes.txt")
    (tmp_path / ".agent-team" / "plans" / ".history").mkdir(parents=True, exist_ok=True)
    _write(tmp_path, ".agent-team/plans/.history/snapshot.html")

    docs = _by_rel(index.list_docs(str(tmp_path)))

    assert set(docs) == {".agent-team/plans/real.html"}


def test_list_docs_reports_mtime_and_name(tmp_path: Path, index: PlanIndex) -> None:
    target = _write(tmp_path, ".agent-team/plans/a.html")

    doc = _by_rel(index.list_docs(str(tmp_path)))[".agent-team/plans/a.html"]

    assert doc["name"] == "a.html"
    assert doc["mtime"] == pytest.approx(target.stat().st_mtime)


def test_list_docs_is_sorted_by_dir_order_then_name(tmp_path: Path, index: PlanIndex) -> None:
    _write(tmp_path, "docs/plans/b.html")
    _write(tmp_path, ".agent-team/plans/z.html")
    _write(tmp_path, ".agent-team/plans/a.html")

    order = [doc["rel_path"] for doc in index.list_docs(str(tmp_path))["docs"]]

    assert order == [
        ".agent-team/plans/a.html",
        ".agent-team/plans/z.html",
        "docs/plans/b.html",
    ]


def test_list_docs_rejects_missing_workspace(index: PlanIndex, tmp_path: Path) -> None:
    assert index.list_docs("")["ok"] is False
    assert index.list_docs(str(tmp_path / "nope"))["ok"] is False


def test_list_docs_on_empty_workspace_plants_no_database(
    tmp_path: Path, index: PlanIndex
) -> None:
    result = index.list_docs(str(tmp_path))

    assert result == {"ok": True, "docs": []}
    assert not (tmp_path / ".agent-team" / DB_FILENAME).exists()


def test_listing_alone_never_plants_a_database(tmp_path: Path, index: PlanIndex) -> None:
    _write(tmp_path, ".agent-team/plans/a.html")

    index.list_docs(str(tmp_path))

    assert not (tmp_path / ".agent-team" / DB_FILENAME).exists()


# ── resolve_plan_root ───────────────────────────────────────────────────────


def test_resolve_plan_root_walks_up_to_the_repository(tmp_path: Path) -> None:
    (tmp_path / "repo" / ".git").mkdir(parents=True)
    (tmp_path / "repo" / "backend" / "src").mkdir(parents=True)

    resolved = resolve_plan_root(str(tmp_path / "repo" / "backend" / "src"))

    assert Path(resolved) == (tmp_path / "repo").resolve()


def test_resolve_plan_root_keeps_a_repository_root_as_is(tmp_path: Path) -> None:
    (tmp_path / "repo" / ".git").mkdir(parents=True)

    resolved = resolve_plan_root(str(tmp_path / "repo"))

    assert Path(resolved) == (tmp_path / "repo").resolve()


def test_resolve_plan_root_accepts_a_gitfile_marker(tmp_path: Path) -> None:
    """Submodules and linked worktrees carry `.git` as a file, not a directory."""
    (tmp_path / "repo" / "pkg").mkdir(parents=True)
    (tmp_path / "repo" / ".git").write_text("gitdir: ../.git/modules/repo", encoding="utf-8")

    assert Path(resolve_plan_root(str(tmp_path / "repo" / "pkg"))) == (tmp_path / "repo").resolve()


def test_resolve_plan_root_leaves_a_non_repository_path_alone(tmp_path: Path) -> None:
    plain = tmp_path / "container"
    plain.mkdir()

    assert resolve_plan_root(str(plain)) == str(plain)


def test_resolve_plan_root_tolerates_bad_input(tmp_path: Path) -> None:
    assert resolve_plan_root("") == ""
    missing = str(tmp_path / "nope")
    assert resolve_plan_root(missing) == missing
    a_file = tmp_path / "file.txt"
    a_file.write_text("x", encoding="utf-8")
    assert resolve_plan_root(str(a_file)) == str(a_file)


def test_resolve_plan_root_stops_at_the_home_directory(tmp_path: Path, monkeypatch) -> None:
    """A dotfiles repo at ~ must never swallow every workspace under it."""
    home = tmp_path / "home"
    (home / ".git").mkdir(parents=True)
    (home / "projects" / "plain").mkdir(parents=True)
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: home))

    resolved = resolve_plan_root(str(home / "projects" / "plain"))

    assert resolved == str(home / "projects" / "plain")


def test_resolve_plan_root_respects_the_ascent_bound(tmp_path: Path) -> None:
    (tmp_path / "repo" / ".git").mkdir(parents=True)
    deep = tmp_path / "repo" / "a" / "b" / "c" / "d" / "e" / "f" / "g"
    deep.mkdir(parents=True)

    assert resolve_plan_root(str(deep)) == str(deep)


def test_packaged_resolver_matches_core_resolver(tmp_path: Path, monkeypatch) -> None:
    """The packaged child and core backend must agree on root resolution."""
    fixture_path = (
        Path(__file__).parents[2]
        / "src"
        / "main"
        / "plugins"
        / "test-fixtures"
        / "plans-backend-wire.py"
    )
    spec = importlib.util.spec_from_file_location("plans_backend_wire", fixture_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    packaged_resolve: Callable[[str], str] = module._resolve_plan_root

    repo = tmp_path / "repo"
    (repo / ".git").mkdir(parents=True)
    nested = repo / "a" / "b"
    nested.mkdir(parents=True)
    deep = repo / "a" / "b" / "c" / "d" / "e" / "f" / "g"
    deep.mkdir(parents=True)
    gitfile_repo = tmp_path / "gitfile-repo"
    gitfile_repo.mkdir()
    (gitfile_repo / ".git").write_text("gitdir: ../modules/repo", encoding="utf-8")
    (gitfile_repo / "pkg").mkdir()
    home = tmp_path / "home"
    (home / ".git").mkdir(parents=True)
    (home / "projects" / "plain").mkdir(parents=True)
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: home))
    file_path = tmp_path / "file.txt"
    file_path.write_text("x", encoding="utf-8")

    cases = [
        "",
        str(tmp_path / "missing"),
        str(file_path),
        str(tmp_path / "plain"),
        str(repo),
        str(nested),
        str(gitfile_repo / "pkg"),
        str(home / "projects" / "plain"),
        str(deep),
    ]
    (tmp_path / "plain").mkdir()
    for workspace_path in cases:
        assert packaged_resolve(workspace_path) == resolve_plan_root(workspace_path)


# ── Nested plan roots ───────────────────────────────────────────────────────


def _repo(ws: Path, rel: str) -> Path:
    """A nested git repository at `rel` (a `.git` directory is the marker)."""
    (ws / rel / ".git").mkdir(parents=True, exist_ok=True)
    return ws / rel


def test_nested_repo_plans_are_listed(tmp_path: Path, index: PlanIndex) -> None:
    """The reported symptom: the workspace is a container, the repo sits below."""
    _repo(tmp_path, "project")
    _write(tmp_path, "project/.agent-team/plans/inner.html")
    _write(tmp_path, ".agent-team/plans/outer.html")

    docs = _by_rel(index.list_docs(str(tmp_path)))

    assert set(docs) == {
        ".agent-team/plans/outer.html",
        "project/.agent-team/plans/inner.html",
    }
    assert docs[".agent-team/plans/outer.html"]["root"] == ""
    assert docs["project/.agent-team/plans/inner.html"]["root"] == "project"


def test_workspace_documents_come_before_nested_ones(tmp_path: Path, index: PlanIndex) -> None:
    _repo(tmp_path, "project")
    _write(tmp_path, "project/.agent-team/plans/a.html")
    _write(tmp_path, ".agent-team/plans/z.html")

    order = [doc["rel_path"] for doc in index.list_docs(str(tmp_path))["docs"]]

    assert order == [".agent-team/plans/z.html", "project/.agent-team/plans/a.html"]


def test_nested_repo_is_found_two_levels_down(tmp_path: Path, index: PlanIndex) -> None:
    _repo(tmp_path, "packages/app")
    _write(tmp_path, "packages/app/.agent-team/plans/deep.html")

    docs = _by_rel(index.list_docs(str(tmp_path)))

    assert set(docs) == {"packages/app/.agent-team/plans/deep.html"}


def test_scan_stops_below_the_depth_limit(tmp_path: Path, index: PlanIndex) -> None:
    _repo(tmp_path, "a/b/c")
    _write(tmp_path, "a/b/c/.agent-team/plans/toodeep.html")

    assert index.list_docs(str(tmp_path))["docs"] == []


def test_plain_subdirectory_is_not_a_plan_root(tmp_path: Path, index: PlanIndex) -> None:
    """Without a repository marker a subfolder's plans stay out of the list."""
    _write(tmp_path, "notes/.agent-team/plans/stray.html")

    assert index.list_docs(str(tmp_path))["docs"] == []


def test_walk_does_not_descend_into_a_repository(tmp_path: Path, index: PlanIndex) -> None:
    """A vendored checkout inside a repo must not flood the list."""
    _repo(tmp_path, "project")
    _repo(tmp_path, "project/vendor/third-party")
    _write(tmp_path, "project/vendor/third-party/.agent-team/plans/theirs.html")
    _write(tmp_path, "project/.agent-team/plans/ours.html")

    docs = _by_rel(index.list_docs(str(tmp_path)))

    assert set(docs) == {"project/.agent-team/plans/ours.html"}


def test_linked_worktrees_are_not_separate_plan_roots(tmp_path: Path, index: PlanIndex) -> None:
    """A worktree is another checkout of a listed repo — its plans are duplicates."""
    _repo(tmp_path, "project")
    _write(tmp_path, "project/.agent-team/plans/plan.html")
    worktree = tmp_path / "wt-feature"
    worktree.mkdir()
    (worktree / ".git").write_text("gitdir: ../project/.git/worktrees/wt-feature", encoding="utf-8")
    _write(tmp_path, "wt-feature/.agent-team/plans/plan.html")

    docs = _by_rel(index.list_docs(str(tmp_path)))

    assert set(docs) == {"project/.agent-team/plans/plan.html"}


def test_noise_directories_are_pruned(tmp_path: Path, index: PlanIndex) -> None:
    _repo(tmp_path, "node_modules/pkg")
    _write(tmp_path, "node_modules/pkg/.agent-team/plans/dep.html")
    _repo(tmp_path, ".hidden/pkg")
    _write(tmp_path, ".hidden/pkg/.agent-team/plans/hidden.html")

    assert index.list_docs(str(tmp_path))["docs"] == []


def test_nested_root_documents_cache_like_any_other(tmp_path: Path, index: PlanIndex) -> None:
    _repo(tmp_path, "project")
    target = _write(tmp_path, "project/.agent-team/plans/inner.html")

    index.cache_put(
        str(tmp_path),
        [
            {
                "rel_path": "project/.agent-team/plans/inner.html",
                "mtime": target.stat().st_mtime,
                "meta": {"name": "Inner", "stage": "draft"},
            }
        ],
    )
    doc = _by_rel(index.list_docs(str(tmp_path)))["project/.agent-team/plans/inner.html"]

    assert doc["cached"] is True
    assert doc["meta"] == {"name": "Inner", "stage": "draft"}


def test_every_listed_path_is_readable_through_fs_service(
    tmp_path: Path, index: PlanIndex
) -> None:
    """The contract the frontend depends on: a listed rel_path can be read.

    `fs_service` protects the internal `.agent-team` directory except its
    `plans/` and `reports/` subtrees, and it applies that rule at every path
    depth — a nested root's document has to survive it too.
    """
    from agent_team_backend import fs_service

    _repo(tmp_path, "project")
    _write(tmp_path, "project/.agent-team/plans/inner.html", "inner")
    _write(tmp_path, ".agent-team/reports/outer.html", "outer")
    _write(tmp_path, "project/docs/plans/doc.md", "doc")

    for doc in index.list_docs(str(tmp_path))["docs"]:
        result = fs_service.read_file(str(tmp_path), doc["rel_path"])
        assert result["ok"] is True, (doc["rel_path"], result)


# ── Cache ───────────────────────────────────────────────────────────────────


def test_cache_hit_after_put(tmp_path: Path, index: PlanIndex) -> None:
    target = _write(tmp_path, ".agent-team/plans/a.html")
    meta = {"schemaVersion": 1, "name": "A", "stage": "draft", "todos": []}

    stored = index.cache_put(
        str(tmp_path),
        [{"rel_path": ".agent-team/plans/a.html", "mtime": target.stat().st_mtime, "meta": meta}],
    )
    doc = _by_rel(index.list_docs(str(tmp_path)))[".agent-team/plans/a.html"]

    assert stored == {"ok": True, "stored": 1}
    assert doc["cached"] is True
    assert doc["meta"] == meta


def test_cache_put_creates_the_database(tmp_path: Path, index: PlanIndex) -> None:
    target = _write(tmp_path, ".agent-team/plans/a.html")

    index.cache_put(
        str(tmp_path),
        [{"rel_path": ".agent-team/plans/a.html", "mtime": target.stat().st_mtime, "meta": None}],
    )

    assert (tmp_path / ".agent-team" / DB_FILENAME).exists()


def test_null_meta_is_cached_as_a_hit(tmp_path: Path, index: PlanIndex) -> None:
    """An unparseable document must not be re-read on every refresh."""
    target = _write(tmp_path, ".agent-team/plans/plain.html")

    index.cache_put(
        str(tmp_path),
        [
            {
                "rel_path": ".agent-team/plans/plain.html",
                "mtime": target.stat().st_mtime,
                "meta": None,
            }
        ],
    )
    doc = _by_rel(index.list_docs(str(tmp_path)))[".agent-team/plans/plain.html"]

    assert doc["cached"] is True
    assert doc["meta"] is None


def test_touching_a_file_invalidates_its_entry(tmp_path: Path, index: PlanIndex) -> None:
    target = _write(tmp_path, ".agent-team/plans/a.html")
    index.cache_put(
        str(tmp_path),
        [
            {
                "rel_path": ".agent-team/plans/a.html",
                "mtime": target.stat().st_mtime,
                "meta": {"name": "A"},
            }
        ],
    )

    stat = target.stat()
    os.utime(target, (stat.st_atime, stat.st_mtime + 10))
    doc = _by_rel(index.list_docs(str(tmp_path)))[".agent-team/plans/a.html"]

    assert doc["cached"] is False
    assert doc["meta"] is None


def test_other_entries_survive_one_file_changing(tmp_path: Path, index: PlanIndex) -> None:
    a = _write(tmp_path, ".agent-team/plans/a.html")
    b = _write(tmp_path, ".agent-team/plans/b.html")
    index.cache_put(
        str(tmp_path),
        [
            {"rel_path": ".agent-team/plans/a.html", "mtime": a.stat().st_mtime, "meta": {"name": "A"}},
            {"rel_path": ".agent-team/plans/b.html", "mtime": b.stat().st_mtime, "meta": {"name": "B"}},
        ],
    )

    stat = a.stat()
    os.utime(a, (stat.st_atime, stat.st_mtime + 10))
    docs = _by_rel(index.list_docs(str(tmp_path)))

    assert docs[".agent-team/plans/a.html"]["cached"] is False
    assert docs[".agent-team/plans/b.html"]["cached"] is True


def test_deleted_document_is_pruned_from_the_cache(tmp_path: Path, index: PlanIndex) -> None:
    target = _write(tmp_path, ".agent-team/plans/gone.html")
    old_mtime = target.stat().st_mtime
    index.cache_put(
        str(tmp_path),
        [
            {
                "rel_path": ".agent-team/plans/gone.html",
                "mtime": old_mtime,
                "meta": {"name": "Gone"},
            }
        ],
    )

    target.unlink()
    assert index.list_docs(str(tmp_path))["docs"] == []

    # Re-created carrying the mtime the pruned row held: a row that survived
    # pruning would report a hit here and serve the old document's meta.
    recreated = _write(tmp_path, ".agent-team/plans/gone.html", "different content")
    os.utime(recreated, (old_mtime, old_mtime))
    doc = _by_rel(index.list_docs(str(tmp_path)))[".agent-team/plans/gone.html"]
    assert doc["cached"] is False


# ── cache_put validation ────────────────────────────────────────────────────


def test_cache_put_skips_paths_outside_the_plan_dirs(tmp_path: Path, index: PlanIndex) -> None:
    result = index.cache_put(
        str(tmp_path),
        [
            {"rel_path": "../escape.html", "mtime": 1.0, "meta": {}},
            {"rel_path": "src/main.ts", "mtime": 1.0, "meta": {}},
            {"rel_path": ".agent-team/plans/_spec.md", "mtime": 1.0, "meta": {}},
        ],
    )

    assert result == {"ok": True, "stored": 0}
    assert not (tmp_path / ".agent-team" / DB_FILENAME).exists()


def test_cache_put_skips_malformed_rows_but_keeps_good_ones(
    tmp_path: Path, index: PlanIndex
) -> None:
    target = _write(tmp_path, ".agent-team/plans/a.html")

    result = index.cache_put(
        str(tmp_path),
        [
            "not-a-dict",
            {"rel_path": ".agent-team/plans/b.html"},  # no mtime
            {"rel_path": ".agent-team/plans/c.html", "mtime": "soon", "meta": {}},
            {"rel_path": ".agent-team/plans/d.html", "mtime": True, "meta": {}},  # bool is not a time
            {"rel_path": ".agent-team/plans/e.html", "mtime": 1.0, "meta": "text"},  # meta must be object|null
            {"rel_path": ".agent-team/plans/a.html", "mtime": target.stat().st_mtime, "meta": {"name": "A"}},
        ],
    )

    assert result == {"ok": True, "stored": 1}
    assert _by_rel(index.list_docs(str(tmp_path)))[".agent-team/plans/a.html"]["cached"] is True


def test_cache_put_rejects_bad_payload_shapes(tmp_path: Path, index: PlanIndex) -> None:
    assert index.cache_put("", [])["ok"] is False
    assert index.cache_put(str(tmp_path), "nope")["ok"] is False
    assert index.cache_put(str(tmp_path), [{}] * 5_001)["ok"] is False


def test_invalidate_clears_every_entry(tmp_path: Path, index: PlanIndex) -> None:
    target = _write(tmp_path, ".agent-team/plans/a.html")
    index.cache_put(
        str(tmp_path),
        [
            {
                "rel_path": ".agent-team/plans/a.html",
                "mtime": target.stat().st_mtime,
                "meta": {"name": "A"},
            }
        ],
    )

    index.invalidate(str(tmp_path))

    assert _by_rel(index.list_docs(str(tmp_path)))[".agent-team/plans/a.html"]["cached"] is False


def test_cache_survives_a_new_index_instance(tmp_path: Path) -> None:
    """The point of persisting: a fresh window/session starts warm."""
    target = _write(tmp_path, ".agent-team/plans/a.html")
    PlanIndex(databases=WorkspaceDatabases()).cache_put(
        str(tmp_path),
        [
            {
                "rel_path": ".agent-team/plans/a.html",
                "mtime": target.stat().st_mtime,
                "meta": {"name": "A"},
            }
        ],
    )

    doc = _by_rel(PlanIndex(databases=WorkspaceDatabases()).list_docs(str(tmp_path)))[
        ".agent-team/plans/a.html"
    ]

    assert doc["cached"] is True
    assert doc["meta"] == {"name": "A"}


def test_plan_document_locations_triple_parity() -> None:
    """Triple-parity: legacy plan_index.py, the pinned navide.plans backend, and pure data fixture.

    navide.plans is built in Navide-dev/navide-plans; its backend's values for
    the pinned version are recorded in tests/fixtures/navide-plans/contract.json,
    and that repository checks its sources against the same record.
    """
    repo_root = Path(__file__).parents[2]
    fixture_path = repo_root / "docs" / "plugin-contracts" / "plan-document-locations-v1.json"
    assert fixture_path.exists(), f"Missing fixture at {fixture_path}"
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    contract = json.loads((repo_root / "tests" / "fixtures" / "navide-plans" / "contract.json").read_text(encoding="utf-8"))
    plugin = contract["planDocumentLocations"]

    # 1. Directory inventory
    assert list(PLAN_DOC_DIRS) == plugin["directoryInventory"] == contract["planDocDirs"] == fixture["directoryInventory"]
    assert len(PLAN_DOC_DIRS) == 7
    assert len(set(PLAN_DOC_DIRS)) == len(PLAN_DOC_DIRS)

    # 2. Supported extensions
    assert list(_DOC_SUFFIXES) == plugin["supportedExtensions"] == fixture["supportedExtensions"]
    assert len(_DOC_SUFFIXES) == 3

    # 3. Discovery depth, root count limits, and directory entry limits
    assert _MAX_ROOT_DEPTH == plugin["maxNestedDepth"] == fixture["maxNestedDepth"] == 2
    assert _MAX_NESTED_ROOTS == plugin["maxNestedRoots"] == fixture["maxNestedRoots"] == 50
    assert _MAX_NESTED_CANDIDATES == plugin["maxNestedCandidates"] == fixture["maxNestedCandidates"] == 2000
    assert _MAX_DIRECTORY_ENTRIES == plugin["maxDirectoryEntries"] == fixture["maxDirectoryEntries"] == 2000

    # 4. Noise segments
    assert sorted(_NOISE_SEGMENTS) == sorted(plugin["noiseSegments"]) == sorted(fixture["noiseSegments"])
    assert len(_NOISE_SEGMENTS) == 17

    # 5. Traversal sort order
    assert fixture["traversalSortOrder"] == "utf8_bytes_ascending"


def test_nested_roots_have_a_global_candidate_budget(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    for parent in range(50):
        for child in range(50):
            (tmp_path / f"parent-{parent}" / f"child-{child}").mkdir(parents=True)
    probes = 0
    original_is_dir = Path.is_dir

    def is_dir(path: Path) -> bool:
        nonlocal probes
        if path.name == ".git":
            probes += 1
        return original_is_dir(path)

    monkeypatch.setattr(Path, "is_dir", is_dir)
    assert find_nested_plan_roots(tmp_path) == []
    assert 50 < probes <= 2000


def test_nested_roots_deterministic_50_cap_and_utf8_sort(tmp_path: Path, index: PlanIndex) -> None:
    """Enforces deterministic 50-root limit using utf-8 bytes ascending order with case-differing names."""
    # 49 repos R00 through R48
    for i in range(49):
        name = f"R{i:02d}"
        _repo(tmp_path, name)
        _write(tmp_path, f"{name}/.agent-team/plans/p.html")

    # 50th: Repo-Alpha (starts with 'R' 0x52, second char 'e' 0x65 > '0'-'4')
    _repo(tmp_path, "Repo-Alpha")
    _write(tmp_path, "Repo-Alpha/.agent-team/plans/p.html")

    # 51st: repo-alpha (starts with 'r' 0x72 > 0x52)
    _repo(tmp_path, "repo-alpha")
    _write(tmp_path, "repo-alpha/.agent-team/plans/p.html")

    roots = find_nested_plan_roots(tmp_path)
    assert len(roots) == 50
    assert "Repo-Alpha" in roots
    assert "repo-alpha" not in roots

    docs = _by_rel(index.list_docs(str(tmp_path)))
    assert "Repo-Alpha/.agent-team/plans/p.html" in docs
    assert "repo-alpha/.agent-team/plans/p.html" not in docs


def test_nested_roots_deterministic_2000_cap_and_utf8_sort(tmp_path: Path, index: PlanIndex) -> None:
    """Enforces deterministic 2000-entry directory cap with 2001 candidate dirs (d0000..d1998, r0000-within, z0000-beyond)."""
    # 1,999 non-repo directories d0000 through d1998
    for i in range(1999):
        (tmp_path / f"d{i:04d}").mkdir()

    # 2,000th candidate directory with .git: r0000-within ('d' < 'r' < 'z')
    _repo(tmp_path, "r0000-within")
    _write(tmp_path, "r0000-within/.agent-team/plans/p.html")

    # 2,001st candidate directory with .git: z0000-beyond
    _repo(tmp_path, "z0000-beyond")
    _write(tmp_path, "z0000-beyond/.agent-team/plans/p.html")

    roots = find_nested_plan_roots(tmp_path)
    assert roots == ["r0000-within"]

    docs = _by_rel(index.list_docs(str(tmp_path)))
    assert "r0000-within/.agent-team/plans/p.html" in docs
    assert "z0000-beyond/.agent-team/plans/p.html" not in docs

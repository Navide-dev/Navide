"""The onefile extraction directory is kept from looking idle to the OS temp
cleaner (2026-11-08: macOS removed its dist-info METADATA after three days and
every new MCP session then failed to initialize)."""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

import pytest

from agent_team_backend import frozen_env

OLD = 1_600_000_000  # 2020-09: well past any cleaner's idle threshold


def _old_tree(root: Path) -> list[Path]:
    files = [
        root / "mcp-1.30.0.dist-info" / "METADATA",
        root / "python3.12" / "lib-dynload" / "_struct.so",
        root / "top.txt",
    ]
    for f in files:
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text("x")
        os.utime(f, (OLD, OLD))
    return files


def test_touching_marks_every_file_as_used_now(tmp_path: Path) -> None:
    files = _old_tree(tmp_path)

    assert frozen_env.touch_extraction_tree(tmp_path) == len(files)

    for f in files:
        st = f.stat()
        assert st.st_mtime > OLD + 1_000_000
        assert st.st_atime > OLD + 1_000_000


def test_touching_a_missing_directory_is_a_no_op(tmp_path: Path) -> None:
    assert frozen_env.touch_extraction_tree(tmp_path / "gone") == 0
    assert frozen_env.touch_extraction_tree(None) == 0 or getattr(sys, "frozen", False)


@pytest.mark.asyncio
async def test_keepalive_returns_at_once_outside_a_frozen_build(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delattr(sys, "frozen", raising=False)
    monkeypatch.delattr(sys, "_MEIPASS", raising=False)
    await asyncio.wait_for(frozen_env.keep_extraction_warm(interval_s=0.01), timeout=1)


@pytest.mark.asyncio
async def test_keepalive_touches_the_tree_on_a_schedule(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    files = _old_tree(tmp_path)
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", str(tmp_path), raising=False)
    monkeypatch.setattr(sys, "executable", str(tmp_path.parent / "bin" / "agent_team_backend"))

    task = asyncio.create_task(frozen_env.keep_extraction_warm(interval_s=0.05))
    try:
        await asyncio.sleep(0.02)
        assert all(f.stat().st_mtime > OLD + 1_000_000 for f in files)
        for f in files:
            os.utime(f, (OLD, OLD))
        await asyncio.sleep(0.1)
        assert all(f.stat().st_mtime > OLD + 1_000_000 for f in files)
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task


def _onedir(root: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Lay out a onedir bundle under ``root`` and point ``sys`` at it."""
    internal = root / "agent_team_backend" / "_internal"
    internal.mkdir(parents=True)
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", str(internal), raising=False)
    monkeypatch.setattr(sys, "executable", str(root / "agent_team_backend" / "agent_team_backend"))
    return internal


def test_a_onedir_build_is_not_onefile(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _onedir(tmp_path, monkeypatch)
    assert frozen_env.is_onefile_build() is False


def test_an_extraction_dir_away_from_the_executable_is_onefile(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", str(tmp_path / "backend-tmp" / "_MEIabc123"), raising=False)
    monkeypatch.setattr(sys, "executable", str(tmp_path / "resources" / "bin" / "agent_team_backend"))
    assert frozen_env.is_onefile_build() is True


def test_a_dev_run_is_not_onefile(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delattr(sys, "frozen", raising=False)
    monkeypatch.delattr(sys, "_MEIPASS", raising=False)
    assert frozen_env.is_onefile_build() is False


@pytest.mark.asyncio
async def test_keepalive_leaves_a_onedir_bundle_alone(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    internal = _onedir(tmp_path, monkeypatch)
    files = _old_tree(internal)

    await asyncio.wait_for(frozen_env.keep_extraction_warm(interval_s=0.01), timeout=1)

    assert all(f.stat().st_mtime == OLD for f in files)


def test_bin_dir_of_a_onedir_build_is_one_level_up(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _onedir(tmp_path, monkeypatch)
    assert frozen_env.packaged_bin_dir() == os.path.realpath(tmp_path)


def test_bin_dir_of_a_single_file_build_is_its_own(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "executable", str(tmp_path / "agent_team_backend"))
    assert frozen_env.packaged_bin_dir() == os.path.realpath(tmp_path)

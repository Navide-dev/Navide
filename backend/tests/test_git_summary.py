"""git.summary: the status bar's view of git.status, without the file lists."""
from __future__ import annotations

import asyncio
import subprocess
from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import app, git_service


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True)


@pytest.fixture
def repo(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(app, "_git_watcher", None)
    root = tmp_path / "repo"
    root.mkdir()
    _git(root, "init", "-q", "-b", "main")
    _git(root, "-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init")
    return root


async def _call(msg_type: str, **payload: Any) -> dict[str, Any]:
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    await app.handle_message(session, {"id": "m1", "type": msg_type, "payload": payload})
    return session.websocket.sent[-1]["payload"]  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_summary_keeps_every_scalar_and_drops_the_lists(repo: Path) -> None:
    for i in range(50):
        (repo / f"file-{i}.txt").write_text("x")
    _git(repo, "add", ".")
    full = await _call("git.status", workspace_path=str(repo))
    summary = await _call("git.summary", workspace_path=str(repo))

    assert summary == {**{k: v for k, v in full.items() if not isinstance(v, (list, dict))}, "dirty": True}
    assert summary["branch"] == "main"
    assert len(str(summary)) * 5 < len(str(full))


@pytest.mark.asyncio
async def test_untracked_files_alone_do_not_mark_it_dirty(repo: Path) -> None:
    # Same rule the bar applied to the full status: staged or unstaged only.
    (repo / "new.txt").write_text("x")
    assert (await _call("git.summary", workspace_path=str(repo)))["dirty"] is False


@pytest.mark.asyncio
async def test_a_failed_status_is_passed_through(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    async def failing(path, include_ignored=False):
        return {"ok": False, "error": "git timed out"}

    monkeypatch.setattr(app, "_git_watcher", None)
    monkeypatch.setattr(app.git_service, "get_status", failing)
    assert await _call("git.summary", workspace_path=str(tmp_path)) == {"ok": False, "error": "git timed out"}


@pytest.mark.asyncio
async def test_summary_runs_no_more_git_than_the_status_it_replaces(repo: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The bar used to send git.status next to the Git pane's; a summary
    shares the same status runs, so swapping it in adds no git process."""
    calls: list[list[str]] = []
    real = git_service._run

    async def counting(args, *rest, **kw):
        calls.append(list(args))
        return await real(args, *rest, **kw)

    monkeypatch.setattr(git_service, "_run", counting)
    await asyncio.gather(*(_call("git.status", workspace_path=str(repo)) for _ in range(3)))
    before = len(calls)
    calls.clear()
    await asyncio.gather(_call("git.status", workspace_path=str(repo)),
                         *(_call("git.summary", workspace_path=str(repo)) for _ in range(2)))
    assert len(calls) == before

from __future__ import annotations

from pathlib import Path

import pytest


@pytest.fixture(autouse=True)
def _data_dir_beside_the_files(tmp_path: Path, monkeypatch) -> None:
    """A pane never sends from Navide's own data dir (channels/media.py). The root
    conftest makes that dir tmp_path itself, which holds the files these tests send,
    so move it to a subfolder."""
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(tmp_path / "navide-data"))


@pytest.fixture(autouse=True)
def _no_startup_grace(monkeypatch) -> None:
    """A manager started a moment ago is inside its startup grace, where an offline pane is
    waited for; the suites that are not about that grace answer it at once."""
    from agent_team_backend.channels import manager

    monkeypatch.setattr(manager, "STARTUP_GRACE_S", 0.0)

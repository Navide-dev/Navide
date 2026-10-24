"""Runtime imports must be declared as runtime dependencies.

A package that only arrives through the dev group (pytest, pyinstaller) is
present in every developer and CI environment, so nothing notices until an
install that carries runtime dependencies only fails to start the backend.
"""
from __future__ import annotations

import re
import tomllib
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]


def _runtime_dependency_names() -> set[str]:
    project = tomllib.loads((BACKEND / "pyproject.toml").read_text(encoding="utf-8"))["project"]
    names = set()
    for spec in project["dependencies"]:
        match = re.match(r"\s*([A-Za-z0-9][A-Za-z0-9._-]*)", spec)
        assert match, spec
        names.add(match.group(1).lower().replace("_", "-"))
    return names


def test_packaging_is_a_declared_runtime_dependency() -> None:
    # plugins/host.py imports packaging.version at module load.
    source = (BACKEND / "agent_team_backend" / "plugins" / "host.py").read_text(encoding="utf-8")
    assert "from packaging.version import" in source
    assert "packaging" in _runtime_dependency_names()

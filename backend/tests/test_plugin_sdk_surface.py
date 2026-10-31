"""`navide_plugin_sdk` is a versioned contract: its names change only on purpose."""

from __future__ import annotations

import ast
import json
from pathlib import Path

import navide_plugin_sdk
from agent_team_backend import fs_write, path_guard, plan_versions

REPO = Path(__file__).resolve().parents[2]
PLANS_BACKEND = REPO / "plugins/navide-plans/backend/plans_backend.py"


def test_the_public_names_are_pinned() -> None:
    assert sorted(navide_plugin_sdk.__all__) == [
        "API_VERSION",
        "FsError",
        "WRITE_PART_MAX_BYTES",
        "plan_versions",
        "resolve_mutation_safe",
        "resolve_safe",
        "staging_path",
        "write_abort",
        "write_commit",
        "write_file",
        "write_part",
    ]
    assert all(hasattr(navide_plugin_sdk, name) for name in navide_plugin_sdk.__all__)


def test_each_name_is_the_core_implementation_not_a_copy() -> None:
    assert navide_plugin_sdk.write_file is fs_write.write_file
    assert navide_plugin_sdk.resolve_safe is path_guard._resolve_safe
    assert navide_plugin_sdk.resolve_mutation_safe is fs_write._resolve_mutation_safe
    assert navide_plugin_sdk.FsError is path_guard.FsError
    assert navide_plugin_sdk.plan_versions is plan_versions


def test_its_major_is_the_plugin_api_major() -> None:
    source = (REPO / "packages/plugin-sdk/package.json").read_text(encoding="utf-8")
    assert navide_plugin_sdk.API_VERSION.split(".")[0] == json.loads(source)["version"].split(".")[0]


def test_the_plans_backend_imports_only_public_names() -> None:
    tree = ast.parse(PLANS_BACKEND.read_text(encoding="utf-8"))
    modules: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            modules.add(node.module or "")
            if node.module == "navide_plugin_sdk":
                assert not [alias.name for alias in node.names if alias.name.startswith("_")]
        elif isinstance(node, ast.Import):
            modules.update(alias.name for alias in node.names)
    assert "navide_plugin_sdk" in modules
    assert not [module for module in modules if module.split(".")[0] == "agent_team_backend"]

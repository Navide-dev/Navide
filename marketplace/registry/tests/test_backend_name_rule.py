"""Guard for package-local backend names at publish. backend.methods and
backend.events keep main's rule, which the App also loads installed packages
with, so a package without agent tools is unchanged. backend.agentTools[].method
must also be a name the App's backend supervisor accepts at activation
(isMethodName in src/main/plugins/pluginBackendSupervisor.ts). The TypeScript
twin is src/main/plugins/pluginBackendNameRule.test.ts."""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from registry.manifest import ManifestError, parse_manifest

ROOT = Path(__file__).parents[3]
SUPERVISOR = (ROOT / "src" / "main" / "plugins" / "pluginBackendSupervisor.ts").read_text(encoding="utf-8")
NAMES = [
    "files.search", "files.index", "files.index_progress", "devmap.block.status", "search", "a", "a1", "a_b",
    "devmap.setStatus", "files.indexProgress", "Files.search", "files.", ".files", "files..search", "files.1x",
    "1files", "_files", "files-search", "files.search ", "files.search\n", "files/search", "fïles.search", "",
]


#: main's backend.methods / backend.events rule (origin/main 99c9ea32d), pinned.
MAIN_BACKEND_NAME = re.compile(r"^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$")


def _main_accepts(name: str) -> bool:
    return MAIN_BACKEND_NAME.fullmatch(name) is not None


def _supervisor_accepts(name: str) -> bool:
    match = re.search(r"function isMethodName\(value: unknown\): value is string \{\n\s*return typeof value === 'string' && /(.+)/u\.test\(value\)", SUPERVISOR)
    assert match, "isMethodName changed shape; update this guard"
    return re.fullmatch(match.group(1).removeprefix("^").removesuffix("$"), name) is not None


def _manifest(methods: list[str], tool_method: str | None = None) -> dict:
    manifest = {
        "schemaVersion": 2, "apiVersion": "^1.0.0", "id": "acme.files", "name": "Files", "version": "1.0.0",
        "publisher": "acme", "permissions": {}, "marketplace": {"description": "Files.", "license": "MIT"},
        "backend": {"entry": "backend/files", "protocolVersion": 1, "activation": "startup", "methods": methods},
    }
    if tool_method is not None:
        manifest["backend"]["agentTools"] = [{
            "name": "files_run", "method": tool_method, "risk": "read", "title": "Run", "description": "Run it.",
            "inputSchema": {"type": "object"},
        }]
    return manifest


def _accepts(manifest: dict) -> bool:
    try:
        parse_manifest(json.loads(json.dumps(manifest)))
    except ManifestError:
        return False
    return True


@pytest.mark.parametrize("name", NAMES, ids=repr)
def test_backend_methods_keep_the_main_rule(name: str) -> None:
    assert _accepts(_manifest([name])) is _main_accepts(name)


@pytest.mark.parametrize("name", [n for n in NAMES if n], ids=repr)
def test_agent_tool_methods_match_the_supervisor(name: str) -> None:
    # The method must also be declared (main's rule), so declare it beside a valid one.
    expected = _supervisor_accepts(name) and _main_accepts(name)
    assert _accepts(_manifest(["files.search", name] if name != "files.search" else [name], name)) is expected

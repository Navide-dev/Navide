"""0.2.39 batch 3/4: the Registry applies the parser's rules to Host events,
plugin calls, pipeline nodes, settings and command slots
(packages/plugin-contracts/tests/manifestPluginPlatform.test.ts), and the
disclosure carries each only when declared."""
from __future__ import annotations

import copy
from typing import Any

import pytest

from registry.disclosure_contract import compute_disclosure
from registry.manifest import ManifestError, parse_manifest


def _manifest(**over: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "schemaVersion": 2,
        "apiVersion": "^1.0.0",
        "id": "acme.watch",
        "name": "Watch",
        "version": "1.0.0",
        "publisher": "acme",
        "permissions": {"system": ["ui", "agents"]},
        "marketplace": {"description": "A fixture.", "license": "MIT"},
        "contributes": {
            "views": [{"id": "main", "kind": "custom", "location": "right", "title": "Watch",
                       "entry": "frontend/main/index.html"}],
            "commands": [{"id": "acme.watch.refresh", "title": "Refresh", "run": {"view": "main"}}],
        },
        "backend": {"entry": "backend/watch", "protocolVersion": 1, "activation": "startup",
                    "methods": ["watch.lookup", "watch.fetch"]},
    }
    for key, value in over.items():
        target, _, field = key.partition("__")
        if field:
            base[target] = {**base[target], field: value}
        else:
            base[key] = value
    return copy.deepcopy(base)


def _parse(raw: dict[str, Any]) -> Any:
    return parse_manifest(raw)


def test_accepts_every_new_field() -> None:
    raw = _manifest(
        permissions__agents={"events": ["agents.turnEnded"]},
        permissions__plugins=["acme.tools"],
        contributes__api=[{"method": "watch.lookup", "description": "Look a thing up"}],
        contributes__pipelineNodes=[{"id": "fetch", "title": "Fetch", "method": "watch.fetch",
                                     "n8nTypes": ["n8n-nodes-base.httpRequest"]}],
        contributes__settings=[{"key": "mode", "title": "Mode", "type": "enum", "default": "fast",
                                "options": ["fast", "slow"]}],
        contributes__statusBar=[{"command": "acme.watch.refresh", "text": "Watch"}],
        contributes__paneActions=[{"command": "acme.watch.refresh", "title": "Watch this pane"}],
        contributes__explorerMenu=[{"command": "acme.watch.refresh", "title": "Watch this file", "when": "file"}],
    )
    _parse(raw)


@pytest.mark.parametrize("over", [
    {"permissions__system": ["ui"], "permissions__agents": {"events": ["agents.turnEnded"]}},
    {"permissions__agents": {"events": ["agents.nope"]}},
    {"permissions__plugins": ["Not An Id"]},
    {"contributes__api": [{"method": "watch.other", "description": "x"}]},
    {"contributes__pipelineNodes": [{"id": "a", "title": "A", "method": "watch.fetch", "timeoutMs": 10}]},
    {"contributes__settings": [{"key": "n", "title": "N", "type": "number", "default": 20, "maximum": 10}]},
    {"contributes__settings": [{"key": "b", "title": "B", "type": "boolean", "default": True, "options": ["a"]}]},
    {"contributes__statusBar": [{"command": "acme.other.run", "text": "X"}]},
    {"contributes__paneActions": [{"command": "acme.watch.refresh", "title": "Safe‮evil"}]},
    {"contributes__explorerMenu": [{"command": "acme.watch.refresh", "title": "X", "when": "always"}]},
])
def test_refuses_what_the_parser_refuses(over: dict[str, Any]) -> None:
    with pytest.raises(ManifestError):
        _parse(_manifest(**over))


def test_disclosure_adds_fields_only_when_declared() -> None:
    plain = compute_disclosure(_manifest())
    for key in ("agentEvents", "pluginCalls", "api", "pipelineNodes", "commandSlots"):
        assert key not in plain
    full = compute_disclosure(_manifest(
        permissions__agents={"events": ["agents.turnEnded", "agents.paneIdle"]},
        permissions__plugins=["acme.tools"],
        contributes__api=[{"method": "watch.lookup", "description": "Look"}],
        contributes__pipelineNodes=[{"id": "fetch", "title": "Fetch", "method": "watch.fetch"}],
        contributes__statusBar=[{"command": "acme.watch.refresh", "text": "Watch"}],
    ))
    assert full["agentEvents"] == ["agents.paneIdle", "agents.turnEnded"]
    assert full["pluginCalls"] == ["acme.tools"]
    assert full["pipelineNodes"] == [{"id": "fetch", "title": "Fetch", "method": "watch.fetch"}]
    assert full["commandSlots"] == [{"slot": "statusBar", "command": "acme.watch.refresh", "title": "Watch"}]
    keys = [clause["key"] for clause in full["summary"]["clauses"]]
    assert keys[-4:] == ["agentEvents", "pluginCalls", "api", "pipelineNodes"]

"""The Registry ships its own copy of the agent-tools contract module.

The Registry image is built from marketplace/registry alone, so it cannot
import backend/agent_team_backend. Its copy must stay byte-identical to the
contract module the App backend and the fixtures are held to.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from registry.manifest import ManifestError, parse_manifest

ROOT = Path(__file__).parents[3]
CONTRACT = ROOT / "backend" / "agent_team_backend" / "plugins" / "agent_tools_contract.py"
COPY = ROOT / "marketplace" / "registry" / "registry" / "agent_tools_contract.py"
FIXTURE = ROOT / "docs" / "plugin-contracts" / "fixtures" / "valid" / "backend-agent-tools.json"


def test_registry_copy_is_byte_identical_to_the_contract_module() -> None:
    assert COPY.read_bytes() == CONTRACT.read_bytes()


def test_publish_keeps_the_declared_agent_tools_verbatim() -> None:
    raw = json.loads(FIXTURE.read_text(encoding="utf-8"))
    manifest = parse_manifest(raw)
    assert manifest.backend is not None
    assert manifest.backend.agentTools == raw["backend"]["agentTools"]
    dumped = manifest.model_dump(exclude_none=True)
    assert dumped["backend"]["agentTools"] == raw["backend"]["agentTools"]


def test_a_manifest_without_agent_tools_dumps_as_before() -> None:
    raw = json.loads(FIXTURE.read_text(encoding="utf-8"))
    del raw["backend"]["agentTools"]
    dumped = parse_manifest(raw).model_dump(exclude_none=True)
    assert "agentTools" not in dumped["backend"]


@pytest.mark.parametrize(
    ("change", "code"),
    [
        (lambda m: m["backend"]["agentTools"][0].update(name="other_read"), "AGENT_TOOL_PREFIX_MISMATCH"),
        (lambda m: m["backend"]["agentTools"][0].update(method="devmap.delete"), "AGENT_TOOL_METHOD_UNDECLARED"),
        (lambda m: m["backend"]["agentTools"][0].update(description="a b"), "AGENT_TOOL_TEXT_INVALID"),
        (lambda m: m["backend"]["agentTools"][1].update(timeoutMs=True), "AGENT_TOOL_TIMEOUT_INVALID"),
        (
            lambda m: (m["backend"].update(methods=["devmap.read", "devmap.setStatus"]),
                       m["backend"]["agentTools"][1].update(method="devmap.setStatus")),
            "not a backend method name the App accepts",
        ),
    ],
)
def test_publish_refuses_with_the_contract_error_code(change, code: str) -> None:
    raw = json.loads(FIXTURE.read_text(encoding="utf-8"))
    change(raw)
    with pytest.raises(ManifestError, match=code):
        parse_manifest(raw)

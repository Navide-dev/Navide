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
# agent_tools_contract imports .disclosure_contract (agent_tool_arguments_digest),
# so the Registry package ships that module next to its copy too.
DISCLOSURE_CONTRACT = ROOT / "backend" / "agent_team_backend" / "plugins" / "disclosure_contract.py"
DISCLOSURE_COPY = ROOT / "marketplace" / "registry" / "registry" / "disclosure_contract.py"
CHUNKING = ROOT / "docs" / "plugin-contracts" / "agent-tools-fixtures" / "payload-chunking.json"
FIXTURE = ROOT / "docs" / "plugin-contracts" / "fixtures" / "valid" / "backend-agent-tools.json"


def test_registry_copy_is_byte_identical_to_the_contract_module() -> None:
    assert COPY.read_bytes() == CONTRACT.read_bytes()


def test_registry_disclosure_copy_is_byte_identical_to_the_contract_module() -> None:
    assert DISCLOSURE_COPY.read_bytes() == DISCLOSURE_CONTRACT.read_bytes()


def test_the_registry_copy_digests_arguments_without_an_import_error() -> None:
    from registry.agent_tools_contract import agent_tool_arguments_digest

    for case in json.loads(CHUNKING.read_text(encoding="utf-8"))["argumentsDigest"]:
        assert agent_tool_arguments_digest(case["arguments"]) == (case["sha256"], case["bytes"]), case["name"]


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


def test_publish_accepts_schema_data_strings_and_property_names() -> None:
    # Only description/title text is refused; other schema strings are
    # neutralized in tools/list, never a reason to refuse a package.
    validation = ROOT / "docs" / "plugin-contracts" / "agent-tools-fixtures" / "agent-tools-validation.json"
    [case] = [c for c in json.loads(validation.read_text(encoding="utf-8"))["cases"]
              if c["name"].startswith("schema data strings and property names are not refused")]
    raw = json.loads(FIXTURE.read_text(encoding="utf-8"))
    raw["backend"]["agentTools"][0]["inputSchema"] = case["manifest"]["backend"]["agentTools"][0]["inputSchema"]
    manifest = parse_manifest(raw)
    assert manifest.backend is not None
    assert manifest.backend.agentTools == raw["backend"]["agentTools"]


def test_a_prefix_mismatch_names_the_prefix_the_id_derives() -> None:
    # The SDK validator says the same (navide-plugin.mjs agentToolMessage).
    raw = json.loads(FIXTURE.read_text(encoding="utf-8"))
    raw["backend"]["agentTools"][0].update(name="other_read")
    with pytest.raises(ManifestError) as refused:
        parse_manifest(raw)
    assert "'other_read' must start with 'devmap_'" in str(refused.value)
    assert "AGENT_TOOL_PREFIX_MISMATCH" in str(refused.value)

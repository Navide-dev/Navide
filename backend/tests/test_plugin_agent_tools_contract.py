"""The step-0 contract for Navide plugin agent tools and disclosure (plan B).

The TypeScript implementation (src/shared/pluginAgentTools.ts and
src/shared/pluginDisclosure.ts) is held to the same fixtures by vitest, so a
drift between the two languages is a red test on whichever side moved.
"""
from __future__ import annotations

import copy
import hashlib
import json
import sqlite3
from pathlib import Path
from typing import Any

import pytest

from agent_team_backend.plugins import agent_tools_contract as tools
from agent_team_backend.plugins import disclosure_contract as disclosure

FIXTURES = Path(__file__).parents[2] / "docs" / "plugin-contracts" / "agent-tools-fixtures"


def _load(name: str) -> Any:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


_NAMES = _load("tool-names.json")
_TEXTS = _load("texts.json")
_VALIDATION = _load("agent-tools-validation.json")["cases"]
_DISCLOSURE = _load("disclosure-cases.json")["cases"]
_BY_NAME = {case["name"]: case for case in _DISCLOSURE}
_CANONICAL = _load("canonical.json")
_DIFFS = _load("diff-cases.json")["cases"]


# ── names ───────────────────────────────────────────────────────────────────


def test_reserved_prefixes_and_core_names_match_the_shared_fixture() -> None:
    reserved = _load("reserved-names-v1.json")
    assert list(tools.RESERVED_TOOL_PREFIXES) == reserved["reservedPrefixes"]
    assert list(tools.CORE_TOOL_NAMES) == reserved["coreToolNames"]


@pytest.mark.asyncio
async def test_every_live_core_tool_is_reserved() -> None:
    """A new core tool must be listed or sit under a reserved prefix, or a plugin could take its name."""
    from mcp.server.fastmcp import FastMCP

    from agent_team_backend.mcp_server import server as core
    from agent_team_backend.plugins.builtin.navide_plans import plan_tools
    from agent_team_backend.plugins.builtin.navide_skills import skills_tools

    plugin_installed = FastMCP(name="contract-probe")
    plan_tools.install(plugin_installed)
    skills_tools.install(plugin_installed)
    live = {tool.name for tool in await core.server.list_tools()}
    live |= {tool.name for tool in await plugin_installed.list_tools()}
    assert live == set(tools.CORE_TOOL_NAMES)
    for name in live:
        assert any(name.startswith(prefix) for prefix in tools.RESERVED_TOOL_PREFIXES), name


@pytest.mark.parametrize("case", _NAMES["prefixes"], ids=lambda c: repr(c["pluginId"]))
def test_prefix_derivation(case: dict[str, Any]) -> None:
    assert tools.derive_agent_tool_prefix(case["pluginId"]) == case["expectedPrefix"]


@pytest.mark.parametrize("case", _NAMES["names"], ids=lambda c: repr(c["name"]))
def test_tool_name_validation(case: dict[str, Any]) -> None:
    assert tools.validate_agent_tool_name(case["name"], case["pluginId"]) == case["expectedError"]


# ── text ────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize("case", _TEXTS["texts"], ids=lambda c: repr(c["value"]))
def test_text_rule(case: dict[str, Any]) -> None:
    assert tools.is_valid_agent_tool_text(case["value"]) is case["valid"]


@pytest.mark.parametrize("case", _TEXTS["results"], ids=lambda c: repr(c["value"]))
def test_result_sanitizing(case: dict[str, Any]) -> None:
    assert tools.sanitize_agent_tool_result_text(case["value"]) == case["expected"]


@pytest.mark.parametrize("case", _TEXTS["byteLengths"], ids=lambda c: repr(c["value"]))
def test_utf8_byte_length(case: dict[str, Any]) -> None:
    assert tools.utf8_byte_length(case["value"]) == case["expected"]


# ── manifest validation ─────────────────────────────────────────────────────


@pytest.mark.parametrize("case", _VALIDATION, ids=lambda c: c["name"])
def test_validate_agent_tools(case: dict[str, Any]) -> None:
    assert tools.validate_agent_tools(case["manifest"]) == case["expectedErrors"]


def test_stability_cap_applies_to_description_and_schema() -> None:
    big = "x" * (tools.AGENT_TOOL_STABILITY_CAP_BYTES + 1)
    tool = {"name": "devmap_read", "method": "devmap.read", "risk": "read", "title": "Read",
            "description": big, "inputSchema": {"type": "object", "description": big}}
    manifest = {"id": "nerdtechnic.devmap", "backend": {"methods": ["devmap.read"], "agentTools": [tool]}}
    assert tools.validate_agent_tools(manifest) == [
        {"index": 0, "field": "description", "code": "AGENT_TOOL_TOO_LARGE"},
        {"index": 0, "field": "inputSchema", "code": "AGENT_TOOL_TOO_LARGE"},
    ]
    at_cap = dict(tool, description="x" * tools.AGENT_TOOL_STABILITY_CAP_BYTES, inputSchema={"type": "object"})
    manifest["backend"]["agentTools"] = [at_cap]
    assert tools.validate_agent_tools(manifest) == []


def test_schema_fragment_matches_the_validator_constants() -> None:
    fragment = _load("manifest-agent-tools.fragment.schema.json")["$defs"]["agentTool"]
    assert fragment["properties"]["timeoutMs"] == {
        "type": "integer", "minimum": 1, "maximum": tools.AGENT_TOOL_MAX_TIMEOUT_MS,
        "default": tools.AGENT_TOOL_DEFAULT_TIMEOUT_MS,
    }
    assert fragment["required"] == list(tools.AGENT_TOOL_REQUIRED_FIELDS)


def test_manifest_schema_still_refuses_agent_tools_until_b1a() -> None:
    schema = json.loads((FIXTURES.parent / "plugin-manifest-v2.schema.json").read_text(encoding="utf-8"))
    assert schema["$defs"]["backend"]["additionalProperties"] is False
    assert "agentTools" not in schema["$defs"]["backend"]["properties"]


# ── disclosure ──────────────────────────────────────────────────────────────


@pytest.mark.parametrize("case", _DISCLOSURE, ids=lambda c: c["name"])
def test_compute_disclosure(case: dict[str, Any]) -> None:
    assert disclosure.compute_disclosure(case["manifest"]) == case["expected"]


def test_disclosure_ignores_manifest_array_order() -> None:
    manifest = _BY_NAME["devmap-0.2.0"]["manifest"]
    shuffled = copy.deepcopy(manifest)
    shuffled["permissions"]["system"].reverse()
    shuffled["backend"]["methods"].reverse()
    shuffled["backend"]["agentTools"].reverse()
    shuffled["permissions"]["scopes"]["fs"]["read"].reverse()
    assert disclosure.canonical_contract_json(disclosure.compute_disclosure(shuffled)) == \
        disclosure.canonical_contract_json(disclosure.compute_disclosure(manifest))


def test_risk_level_for_reasons() -> None:
    assert disclosure.risk_level_for_reasons([]) == "low"
    assert disclosure.risk_level_for_reasons(
        [{"key": "system.fs", "level": "medium"}, {"key": "shell.full", "level": "highest"}]
    ) == "highest"


@pytest.mark.parametrize("case", _CANONICAL["values"], ids=lambda c: repr(c["value"]))
def test_canonical_contract_json(case: dict[str, Any]) -> None:
    if case["expected"] is None:
        with pytest.raises(disclosure.CanonicalJsonError):
            disclosure.canonical_contract_json(case["value"])
    else:
        assert disclosure.canonical_contract_json(case["value"]) == case["expected"]


def test_canonical_spelling_of_a_disclosure() -> None:
    manifest = _BY_NAME[_CANONICAL["disclosureCase"]]["manifest"]
    assert disclosure.canonical_contract_json(disclosure.compute_disclosure(manifest)) == \
        _CANONICAL["disclosureExpected"]


def test_disclosure_digest_is_sha256_of_the_canonical_spelling() -> None:
    # Section 3.5: the disclosure envelope's disclosureDigest.
    manifest = _BY_NAME[_CANONICAL["disclosureCase"]]["manifest"]
    spelling = disclosure.canonical_contract_json(disclosure.compute_disclosure(manifest))
    assert hashlib.sha256(spelling.encode("ascii")).hexdigest() == _CANONICAL["disclosureDigestExpected"]


@pytest.mark.parametrize("case", _DIFFS, ids=lambda c: c["name"])
def test_diff_disclosure(case: dict[str, Any]) -> None:
    a = disclosure.compute_disclosure(_BY_NAME[case["from"]]["manifest"])
    b = disclosure.compute_disclosure(_BY_NAME[case["to"]]["manifest"])
    assert disclosure.diff_disclosure(a, b) == case["expected"]


# ── storage and approval contract ───────────────────────────────────────────


def test_audit_and_activity_ddl_is_valid_sqlite() -> None:
    db = sqlite3.connect(":memory:")
    try:
        for statement in tools.PLUGIN_AUDIT_DDL:
            db.execute(statement)
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert {"plugin_tool_calls", "plugin_activity", "plugin_activity_daily"} <= tables
    finally:
        db.close()


def test_approval_kinds_and_decide_action() -> None:
    assert tools.APPROVAL_KINDS == ("skill", "plugin-install", "plugin-update", "plugin-rollback", "plugin-remove")
    assert tools.PLUGIN_APPROVAL_DECIDE_ACTION == "plugins.agent_request.decide"

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


def test_neither_the_tool_count_nor_the_whole_declaration_is_limited() -> None:
    def tool(index: int, size: int) -> dict[str, Any]:
        return {"name": f"devmap_t{index}", "method": "devmap.read", "risk": "read", "title": "T",
                "description": "x" * size, "inputSchema": {"type": "object"}}

    def manifest(items: list[dict[str, Any]]) -> dict[str, Any]:
        return {"id": "nerdtechnic.devmap", "backend": {"methods": ["devmap.read"], "agentTools": items}}

    many = [tool(i, 600 * 1024) for i in range(2)]
    assert tools.validate_agent_tools(manifest(many)) == []
    assert tools.validate_agent_tools(manifest([tool(i, 100) for i in range(500)])) == []


def test_schema_fragment_matches_the_validator_constants() -> None:
    fragment = _load("manifest-agent-tools.fragment.schema.json")["$defs"]["agentTool"]
    assert fragment["properties"]["timeoutMs"] == {
        "type": "integer", "minimum": 1, "maximum": tools.AGENT_TOOL_MAX_TIMEOUT_MS,
        "default": tools.AGENT_TOOL_DEFAULT_TIMEOUT_MS,
    }
    assert fragment["required"] == list(tools.AGENT_TOOL_REQUIRED_FIELDS)


def test_manifest_schema_accepts_agent_tools_exactly_as_the_fragment() -> None:
    # B1-a turned the fragment on (contract section 2.6); both schema copies
    # must carry it verbatim, apart from the field's description.
    fragment = _load("manifest-agent-tools.fragment.schema.json")
    for path in (
        FIXTURES.parent / "plugin-manifest-v2.schema.json",
        FIXTURES.parents[2] / "packages/plugin-contracts/src/schemas/plugin-manifest-v2.schema.json",
    ):
        schema = json.loads(path.read_text(encoding="utf-8"))
        backend = schema["$defs"]["backend"]
        assert backend["additionalProperties"] is False
        field = dict(backend["properties"]["agentTools"])
        field.pop("description")
        assert field == fragment["backendProperties"]["agentTools"]
        assert schema["$defs"]["agentTool"] == fragment["$defs"]["agentTool"]
        assert schema["$defs"]["agentToolText"] == fragment["$defs"]["agentToolText"]


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
    assert tools.APPROVAL_KINDS == (
        "skill", "plugin-install", "plugin-update", "plugin-rollback", "plugin-remove", "plugin-enable",
        "plugin-install-file",
        "developer-application", "plugin-publish", "plugin-yank", "testplace-invite",
    )
    assert set(tools.FORM_APPROVAL_KINDS) < set(tools.APPROVAL_KINDS)
    assert tools.PLUGIN_APPROVAL_DECIDE_ACTION == "plugins.agent_request.decide"


# ── chunked transfer of results and arguments (no size cap, section 4.4) ────

_CHUNKING = _load("payload-chunking.json")


def test_chunking_constants_match_the_shared_fixture() -> None:
    assert {
        "chunkBytes": tools.AGENT_TOOL_CHUNK_BYTES,
        "wireResultChunkMethod": tools.BACKEND_WIRE_RESULT_CHUNK_METHOD,
        "wireResultChunksKey": tools.BACKEND_WIRE_RESULT_CHUNKS_KEY,
        "wireArgumentChunkMethod": tools.BACKEND_WIRE_ARGUMENT_CHUNK_METHOD,
        "wireArgumentChunksKey": tools.BACKEND_WIRE_ARGUMENT_CHUNKS_KEY,
        "wsResultChunkMessage": tools.AGENT_CAPABILITY_RESULT_CHUNK_MESSAGE,
        "wsRequestChunkEvent": tools.AGENT_CAPABILITY_REQUEST_CHUNK_EVENT,
        "invalidCode": tools.AGENT_TOOL_CHUNKS_INVALID,
        "wsProgressMessage": tools.AGENT_CAPABILITY_PROGRESS_MESSAGE,
        "chunkIdleMs": tools.AGENT_TOOL_CHUNK_IDLE_MS,
        "timeoutReasons": list(tools.AGENT_TOOL_TIMEOUT_REASONS),
        "progressPhases": list(tools.AGENT_TOOL_PROGRESS_PHASES),
    } == _CHUNKING["constants"]
    assert tools.AGENT_TOOL_CHUNKS_INVALID in tools.AGENT_TOOL_CALL_ERROR_CODES


def test_a_fully_escaped_piece_fits_the_backend_ws_message_limit() -> None:
    # uvicorn's default ws_max_size (16 MiB); __main__.py does not override it.
    from uvicorn.config import Config

    worst = json.dumps(
        {"type": tools.AGENT_CAPABILITY_RESULT_CHUNK_MESSAGE, "id": "x" * 64,
         "payload": {"request_id": "x" * 64, "seq": tools.MAX_SAFE_INTEGER, "data": "\u0001" * tools.AGENT_TOOL_CHUNK_BYTES}},
        separators=(",", ":"),
    )
    assert len(worst.encode("utf-8")) < Config(app=None).ws_max_size


@pytest.mark.parametrize("case", _CHUNKING["splits"], ids=lambda c: c["name"])
def test_split_payload_text(case: dict[str, Any]) -> None:
    pieces = tools.split_agent_tool_payload_text(case["text"], case["maxBytes"])
    assert pieces == case["expected"]
    assert all(tools.utf8_byte_length(p) <= case["maxBytes"] for p in pieces)


def _split_by_code_point(text: str, max_bytes: int) -> list[str]:
    """The original code-point loop, kept as the reference the byte cut must match."""
    pieces: list[str] = []
    start = 0
    size = 0
    for index, char in enumerate(text):
        point = ord(char)
        width = 1 if point < 0x80 else 2 if point < 0x800 else 4 if point > 0xFFFF else 3
        if size + width > max_bytes:
            pieces.append(text[start:index])
            start = index
            size = 0
        size += width
    pieces.append(text[start:])
    return pieces


def test_the_byte_cut_matches_the_code_point_loop_piece_for_piece() -> None:
    import random

    alphabet = ["a", "{", "é", "\u07ff", "\u0800", "中", "\uffff", "😀", "\U00010000", "\ud800", "\udfff"]
    rng = random.Random(7)
    for _ in range(2000):
        text = "".join(rng.choice(alphabet) for _ in range(rng.randrange(0, 60)))
        for max_bytes in (4, 5, 6, 7, 8, 13, 64):
            assert tools.split_agent_tool_payload_text(text, max_bytes) == _split_by_code_point(text, max_bytes), (text, max_bytes)
    for unit in ("x", "中", "x中😀é"):
        text = unit * (300_000 // len(unit))
        assert tools.split_agent_tool_payload_text(text) == _split_by_code_point(text, tools.AGENT_TOOL_CHUNK_BYTES)


def test_a_lone_surrogate_is_escaped_as_json_stringify_escapes_it() -> None:
    assert tools.agent_tool_payload_text({"s": "a\ud800"}) == '{"s":"a\\ud800"}'


def test_split_refuses_a_piece_size_that_cannot_hold_every_code_point() -> None:
    with pytest.raises(ValueError):
        tools.split_agent_tool_payload_text("abc", 3)


@pytest.mark.parametrize("case", _CHUNKING["reassembly"], ids=lambda c: c["name"])
def test_reassemble_payload_text(case: dict[str, Any]) -> None:
    assert tools.reassemble_agent_tool_payload_text(case["chunks"], case["summary"], case["chunkBytes"]) == case["expected"]


@pytest.mark.parametrize("case", _CHUNKING["arrival"], ids=lambda c: c["name"])
def test_each_piece_is_checked_on_arrival(case: dict[str, Any]) -> None:
    seen: list[dict[str, Any]] = []
    short_seen = False
    seqs = case.get("seqs")
    for index, data in enumerate(case["pieces"]):
        if seqs is None:
            result = tools.agent_tool_chunk_arrival(short_seen, data, case["chunkBytes"])
        else:
            result = tools.agent_tool_chunk_arrival(short_seen, data, case["chunkBytes"], seqs[index], index)
        seen.append(result)
        if not result["ok"]:
            break
        short_seen = result["short"]
    assert seen == case["expected"]


@pytest.mark.parametrize("case", _CHUNKING["arguments"], ids=lambda c: c["name"])
def test_arguments_are_cut_from_the_shared_compact_spelling(case: dict[str, Any]) -> None:
    text = tools.agent_tool_payload_text(case["arguments"])
    assert text == case["text"]
    pieces = tools.split_agent_tool_payload_text(text, case["maxBytes"])
    assert pieces == case["expected"]
    joined = tools.reassemble_agent_tool_payload_text(
        [{"seq": seq, "data": data} for seq, data in enumerate(pieces)],
        {"chunks": len(pieces), "bytes": tools.utf8_byte_length(text)},
        case["maxBytes"],
    )
    assert json.loads(joined["text"]) == case["arguments"]


@pytest.mark.parametrize("case", _CHUNKING["argumentsDigest"], ids=lambda c: c["name"])
def test_arguments_digest_is_the_audit_args_fields(case: dict[str, Any]) -> None:
    assert tools.agent_tool_arguments_digest(case["arguments"]) == (case["sha256"], case["bytes"])


@pytest.mark.parametrize("direction", ["result", "arguments"])
def test_a_10_mib_value_round_trips_with_no_cap(direction: str) -> None:
    value = {"rows": [f"row {i} 中文 😀 " + "x" * 230 for i in range(42_000)]}
    text = tools.agent_tool_payload_text(value)
    size = tools.utf8_byte_length(text)
    assert size > 10 * 1_048_576
    pieces = tools.split_agent_tool_payload_text(text)
    assert all(tools.utf8_byte_length(p) <= tools.AGENT_TOOL_CHUNK_BYTES for p in pieces)
    received = [{"seq": seq, "data": data} for seq, data in enumerate(pieces)][::-1]
    joined = tools.reassemble_agent_tool_payload_text(received, {"chunks": len(pieces), "bytes": size})
    assert joined == {"ok": True, "text": text}
    assert hashlib.sha256(joined["text"].encode()).digest() == hashlib.sha256(text.encode()).digest()
    if direction == "arguments":
        assert tools.agent_tool_arguments_digest(json.loads(joined["text"]))[1] >= size

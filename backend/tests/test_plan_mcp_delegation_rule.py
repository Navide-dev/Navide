"""The delegation rule is one sentence, quoted in three places.

An agent decides between a Navide pane and its own subagent before it has
called anything, so the rule has to be where it reads: the server
instructions, cli_open_agent's description, and cli_whoami. Three hand-typed
copies drift into three slightly different rules; these tests pin each copy
to DELEGATION_RULE so a rewrite of one is a failure, not a divergence.
"""

from __future__ import annotations

import re
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging
from agent_team_backend.mcp_server import server as plan_mcp, wiring as plan_mcp_wiring


def _flat(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


@pytest.fixture(autouse=True)
def _clean_registry() -> Any:
    agent_messaging._reset_for_test()
    yield
    agent_messaging._reset_for_test()


def _ctx(pane_id: str = "pa") -> Any:
    params = {"pane": pane_id, "t": plan_mcp_wiring.caller_token(pane_id)}
    return SimpleNamespace(
        request_context=SimpleNamespace(request=SimpleNamespace(query_params=params))
    )


def test_the_rule_names_both_paths_and_which_one_is_the_default() -> None:
    rule = plan_mcp.DELEGATION_RULE
    assert "cli_open_agent" in rule
    assert "subagent" in rule
    # The exception is spelled out too, or "prefer panes" reads as "never
    # subagents" and a grep-sized lookup gets a 300MB pane.
    assert "read-only" in rule


def test_the_server_instructions_quote_the_rule_verbatim() -> None:
    assert _flat(plan_mcp.DELEGATION_RULE) in _flat(plan_mcp.server.instructions or "")


def test_the_instructions_no_longer_make_pane_delegation_wait_for_the_user() -> None:
    """The old wording — use cli_send "when the user asks you to hand work
    to" another pane — framed every pane hand-off as user-initiated, which is
    the reading under which an agent keeps its own subagents as the default."""
    text = _flat(plan_mcp.server.instructions or "")
    assert "when the user asks you to hand work to" not in text
    assert "not only when the user asks" in text


@pytest.mark.asyncio
async def test_cli_open_agent_description_quotes_the_rule_verbatim() -> None:
    tools = {tool.name: tool for tool in await plan_mcp.server.list_tools()}
    assert _flat(plan_mcp.DELEGATION_RULE) in _flat(tools["cli_open_agent"].description or "")


@pytest.mark.asyncio
async def test_whoami_hands_a_pane_the_rule() -> None:
    agent_messaging.register("pa", "reviewer", "/ws/alpha", agent_key="claude")

    me = await plan_mcp.cli_whoami(_ctx("pa"))

    assert me["ok"] is True
    assert me["delegation_hint"] == plan_mcp.DELEGATION_RULE

"""share_create / share_list / share_revoke on the Navide MCP server.

The tools are registered for every user (there is no conditional
registration), so what is pinned here is that they change nothing else and
do nothing without Navide Cloud: the existing tool list is exactly main's
(data/mcp_core_tools_main.json, dumped from main's server), the new tools come
after it, and a call while not connected answers one sentence without
touching the link, the vault, the log or the UI.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import agent_messaging, app, server_link, share_links, sync_keyring
from agent_team_backend.mcp_server import server as mcp

from .test_share_links import FakeLinks, _plan

SHARE_TOOLS = ["share_create", "share_list", "share_revoke"]
#: Tools the built-in Navide plugins install at startup (navide.plans, navide.skills).
PLUGIN_PREFIXES = ("plan_", "skills_")
BASELINE = Path(__file__).parent / "data" / "mcp_core_tools_main.json"


def _tools() -> list[dict[str, Any]]:
    return [
        {"name": t.name, "description": t.description, "parameters": t.parameters}
        for t in mcp.server._tool_manager.list_tools()  # noqa: SLF001
    ]


def test_the_existing_tools_are_exactly_mains_and_the_share_tools_come_after() -> None:
    baseline = json.loads(BASELINE.read_text(encoding="utf-8"))
    core = {t["name"] for t in baseline}
    # Other tests install the built-in Navide plugins' tools (plan_*, skills_*)
    # onto the same server; those are left out by their known prefixes, and
    # anything else that is not main's must make this fail.
    tools = [t for t in _tools() if t["name"] in core or not t["name"].startswith(PLUGIN_PREFIXES)]
    existing = [t for t in tools if t["name"] not in SHARE_TOOLS]
    assert json.loads(json.dumps(existing, sort_keys=True)) == baseline
    assert [t["name"] for t in tools[-3:]] == SHARE_TOOLS


@pytest.mark.parametrize("name", SHARE_TOOLS)
def test_each_share_tool_says_it_needs_navide_cloud(name: str) -> None:
    [tool] = [t for t in _tools() if t["name"] == name]
    assert "requires Navide Cloud" in tool["description"]


@pytest.fixture
def pane_caller(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(mcp, "_resolve_caller", lambda ctx: mcp._Caller(kind="pane", pane_id="p1"))
    monkeypatch.setattr(
        agent_messaging, "get", lambda pane_id: SimpleNamespace(name="release", agent_key="claude")
    )


@pytest.fixture
def broadcasts(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    sent: list[dict[str, Any]] = []

    async def broadcast(event: dict[str, Any]) -> None:
        sent.append(event)

    monkeypatch.setattr(app, "broadcast", broadcast)
    return sent


class _Untouchable:
    def __getattr__(self, name: str) -> Any:
        raise AssertionError(f"the vault was used ({name}) while Navide Cloud is not connected")


@pytest.mark.parametrize("state", [server_link.STATE_UNCONFIGURED, server_link.STATE_UNREACHABLE])
@pytest.mark.parametrize(
    ("tool", "args"),
    [
        ("share_create", {"path": "/tmp/x.html"}),
        ("share_list", {}),
        ("share_revoke", {"link_id": "ab" * 16}),
    ],
)
async def test_without_navide_cloud_a_call_does_nothing_at_all(
    monkeypatch, caplog, pane_caller, broadcasts, state, tool, args
) -> None:
    monkeypatch.setattr(server_link, "link_state", lambda: state)

    async def no_network(*_a: Any, **_k: Any) -> Any:
        raise AssertionError("the link was used while Navide Cloud is not connected")

    monkeypatch.setattr(server_link, "links_request", no_network)
    monkeypatch.setattr(app, "credential_vault", _Untouchable())
    monkeypatch.setattr("subprocess.run", lambda *a, **k: pytest.fail(f"subprocess.run{a!r}"))
    caplog.set_level(logging.DEBUG)

    result = await getattr(mcp, tool)(**args, ctx=None)

    assert result["ok"] is False and "Navide Cloud" in result["error"]
    assert broadcasts == []
    assert [r for r in caplog.records if r.name.startswith("agent_team_backend")] == []


async def test_a_server_without_share_links_is_answered_like_no_cloud(monkeypatch, pane_caller, broadcasts) -> None:
    monkeypatch.setattr(server_link, "link_state", lambda: server_link.STATE_CONNECTED)

    async def old_server(verb: str, payload: dict) -> dict:
        return {"ok": False, "error": {"code": "UNKNOWN_TYPE", "message": "links." + verb}}

    monkeypatch.setattr(server_link, "links_request", old_server)
    result = await mcp.share_list(ctx=None)
    assert result["ok"] is False and "Navide Cloud" in result["error"] and broadcasts == []


@pytest.fixture
def ring():
    sync_keyring.ensure_account_key()
    yield
    sync_keyring.forget_account_key()


@pytest.fixture
def home(tmp_path: Path, set_home, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(tmp_path / "data"))
    (tmp_path / "home").mkdir()
    return set_home(tmp_path / "home")


@pytest.fixture
def connected(monkeypatch: pytest.MonkeyPatch) -> FakeLinks:
    fake = FakeLinks()
    monkeypatch.setattr(server_link, "link_state", lambda: server_link.STATE_CONNECTED)

    async def links_request(verb: str, payload: dict) -> dict:
        try:
            return {"ok": True, "payload": await fake.request(verb, payload)}
        except share_links.ShareRemoteError as err:
            return {"ok": False, "error": {"code": err.code, "message": str(err)}}

    monkeypatch.setattr(server_link, "links_request", links_request)
    monkeypatch.setattr(share_links, "_http_put", fake.put)
    return fake


async def test_an_agent_share_is_marked_with_its_pane_and_announced(
    ring, home, connected, pane_caller, broadcasts
) -> None:
    result = await mcp.share_create(path=str(_plan(home, "<p/>")), ctx=None)

    assert result["ok"] is True and result["url"].startswith("https://share.navide.dev/s/")
    [event] = broadcasts
    assert event["type"] == "share.created"
    assert event["payload"]["createdBy"] == "agent" and event["payload"]["pane"] == "release"
    assert "#k=" not in json.dumps(event)
    [listed] = (await mcp.share_list(ctx=None))["links"]
    assert listed["createdBy"] == "agent" and listed["pane"] == "release" and listed["agent"] == "claude"


async def test_a_key_file_is_refused_with_its_reason(ring, home, connected, pane_caller, broadcasts) -> None:
    key_file = home / ".ssh" / "id_ed25519"
    key_file.parent.mkdir()
    key_file.write_text("x")
    result = await mcp.share_create(path=str(key_file), ctx=None)
    assert result["ok"] is False and result["reason"] == "denied_name"
    assert connected.calls == [] and broadcasts == []


async def test_revoke_goes_through(ring, home, connected, pane_caller, broadcasts) -> None:
    created = await mcp.share_create(path=str(_plan(home, "<p/>")), ctx=None)
    result = await mcp.share_revoke(link_id=created["linkId"], ctx=None)
    assert result["ok"] is True
    assert connected.rows[created["linkId"]]["active"] is False


@pytest.fixture
def chat(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    from agent_team_backend.channels import share_cmds

    sent: list[dict[str, Any]] = []

    async def notify_link_created(link: dict[str, Any]) -> None:
        sent.append(link)

    monkeypatch.setattr(share_cmds, "notify_link_created", notify_link_created, raising=False)
    return sent


async def test_an_agent_share_reaches_chat_only_with_send_to_chat(
    ring, home, connected, pane_caller, broadcasts, chat
) -> None:
    await mcp.share_create(path=str(_plan(home, "<p/>")), ctx=None)
    assert chat == []
    result = await mcp.share_create(path=str(_plan(home, "<p/>")), ctx=None, send_to_chat=True)
    [link] = chat
    assert link["url"] == result["url"] and link["paneId"] == "p1" and link["createdBy"] == "agent"

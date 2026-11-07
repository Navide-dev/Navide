"""Plugin pipeline nodes (E2): the graph accepts `plugin` work nodes, and an
n8n import maps a step onto an installed plugin's node instead of an agent
slot when the Host lists one for that n8n type."""

from __future__ import annotations

from typing import Any

import pytest

from agent_team_backend import n8n_import as ni
from agent_team_backend import pipeline_graph as pg
from agent_team_backend.mcp_server import server as mcp

NOW = "2026-11-07T00:00:00Z"
HTTP = ni.BASE + "httpRequest"
PLUGIN_NODES = {HTTP: {"pluginId": "acme.http", "node": "fetch", "title": "Fetch"}}


def _graph(plugin: Any, **extra: Any) -> dict[str, Any]:
    return {
        "version": pg.GRAPH_VERSION,
        "nodes": [
            {"id": "trigger", "kind": "trigger", "position": {"x": 0, "y": 0}},
            {"id": "p", "kind": "plugin", "label": "Fetch", "position": {"x": 280, "y": 0}, "plugin": plugin, **extra},
        ],
        "edges": [{"id": "e-trigger-p", "from": "trigger", "to": "p", "kind": "main"}],
    }


def test_a_plugin_node_is_a_valid_work_node() -> None:
    assert pg.validate_graph(_graph({"pluginId": "acme.http", "node": "fetch", "input": "{{task}}"},
                                    retry={"maxTries": 2})) == []


@pytest.mark.parametrize("plugin", [
    None,
    {"pluginId": "Not An Id", "node": "fetch"},
    {"pluginId": "acme.http", "node": ""},
    {"pluginId": "acme.http", "node": "fetch", "input": 3},
    {"pluginId": "acme.http", "node": "fetch", "extra": 1},
])
def test_a_plugin_node_needs_a_well_formed_config(plugin: Any) -> None:
    assert pg.validate_graph(_graph(plugin)) != []


def test_only_plugin_nodes_carry_plugin_config() -> None:
    g = _graph({"pluginId": "acme.http", "node": "fetch"})
    g["nodes"][1]["kind"] = "gate"
    assert any("only plugin nodes" in e for e in pg.validate_graph(g))


def test_update_node_merges_plugin_config() -> None:
    g = pg.apply_graph_ops(_graph({"pluginId": "acme.http", "node": "fetch"}),
                           [{"op": "update_node", "id": "p", "plugin": {"input": "x"}}])
    assert g["nodes"][1]["plugin"] == {"pluginId": "acme.http", "node": "fetch", "input": "x"}


def _workflow() -> dict[str, Any]:
    def node(name: str, ntype: str, **extra: Any) -> dict[str, Any]:
        return {"id": name.lower(), "name": name, "type": ntype, "typeVersion": 4.2 if ntype == HTTP else 1,
                "position": [0, 0], "parameters": extra.pop("parameters", {}), **extra}

    return {
        "name": "Fixture",
        "nodes": [
            node("Start", ni.BASE + "manualTrigger"),
            node("Fetch", HTTP, parameters={"url": "https://api.example.com/items"}),
            node("Shape", ni.BASE + "set"),
        ],
        "connections": {
            "Start": {"main": [[{"node": "Fetch", "type": "main", "index": 0}]]},
            "Fetch": {"main": [[{"node": "Shape", "type": "main", "index": 0}]]},
        },
    }


def test_n8n_step_becomes_the_plugin_node_the_host_lists() -> None:
    out = ni.convert_n8n_workflow(_workflow(), imported_at=NOW, plugin_nodes=PLUGIN_NODES)
    assert pg.validate_graph(out["graph"]) == []
    plugin = [n for n in out["graph"]["nodes"] if n["kind"] == "plugin"]
    assert len(plugin) == 1
    assert plugin[0]["label"] == "Fetch"
    assert plugin[0]["plugin"]["pluginId"] == "acme.http"
    assert plugin[0]["plugin"]["node"] == "fetch"
    assert "api.example.com" in plugin[0]["plugin"]["input"]
    # The step next to it is not merged into the plugin node: it keeps an agent slot.
    assert [n["label"] for n in out["graph"]["nodes"] if n["kind"] == "slot"] == ["Shape"]
    assert out["report"]["pluginNodes"][0]["pluginId"] == "acme.http"


def test_without_a_plugin_node_the_agent_slot_stands_in() -> None:
    out = ni.convert_n8n_workflow(_workflow(), imported_at=NOW)
    assert not [n for n in out["graph"]["nodes"] if n["kind"] == "plugin"]
    assert out["report"]["pluginNodes"] == []


def test_host_answer_is_read_by_type_and_first_plugin_wins() -> None:
    answer = {"ok": True, "nodes": [
        {"pluginId": "zed.http", "node": "get", "title": "Get", "n8nTypes": [HTTP]},
        {"pluginId": "acme.http", "node": "fetch", "title": "Fetch", "n8nTypes": [HTTP, "x.y"]},
        {"pluginId": "Bad Id", "node": "n", "title": "t", "n8nTypes": ["z.z"]},
    ]}
    assert mcp._pipeline_nodes_by_type(answer) == {
        HTTP: {"pluginId": "acme.http", "node": "fetch", "title": "Fetch"},
        "x.y": {"pluginId": "acme.http", "node": "fetch", "title": "Fetch"},
    }
    assert mcp._pipeline_nodes_by_type({"ok": False}) == {}

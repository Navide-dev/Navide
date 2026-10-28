"""n8n workflow import: hand-written n8n JSON fixtures → pipeline graph.

Fixtures follow the n8n export shape (nodes[] + connections keyed by node
name). Fake secrets are built by concatenation so no literal token sits in
the source.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from agent_team_backend import n8n_import as ni
from agent_team_backend import pipeline_graph as pg

NOW = "2026-10-29T00:00:00Z"


def node(name: str, ntype: str, ver: float = 1, x: int = 0, y: int = 0, **extra: Any) -> dict:
    t = ntype if "." in ntype else ni.BASE + ntype
    return {"id": name.lower(), "name": name, "type": t, "typeVersion": ver, "position": [x, y],
            "parameters": extra.pop("parameters", {}), **extra}


def link(*pairs: tuple) -> dict:
    """(src, dst) or (src, dst, out_index) or (src, dst, out_index, type)."""
    conns: dict[str, dict[str, list]] = {}
    for p in pairs:
        src, dst = p[0], p[1]
        oi = p[2] if len(p) > 2 else 0
        ctype = p[3] if len(p) > 3 else "main"
        outs = conns.setdefault(src, {}).setdefault(ctype, [])
        while len(outs) <= oi:
            outs.append([])
        outs[oi].append({"node": dst, "type": ctype, "index": 0})
    return conns


def wf(nodes: list[dict], conns: dict, **extra: Any) -> dict:
    return {"name": extra.pop("name", "Fixture"), "nodes": nodes, "connections": conns, **extra}


def convert(w: Any, **kw: Any) -> dict:
    out = ni.convert_n8n_workflow(w, imported_at=NOW, **kw)
    assert pg.validate_graph(out["graph"]) == []
    return out


def shape(out: dict) -> dict:
    g = out["graph"]
    return {
        "nodes": [(n["id"], n["kind"], n["label"]) for n in g["nodes"]],
        "edges": sorted((e["from"], e["to"]) for e in g["edges"]),
    }


def entry(out: dict, name: str) -> dict:
    return next(e for e in out["report"]["nodes"] if e["name"] == name)


def slot(out: dict, nid: str) -> dict:
    return next(n for n in out["graph"]["nodes"] if n["id"] == nid)


# ── fixtures ─────────────────────────────────────────────────────────────
def linear() -> dict:
    return wf(
        [node("Start", "manualTrigger"),
         node("Fetch", "httpRequest", 4.2, 200, parameters={"url": "=https://api.example.com/{{ $json.id }}"}),
         node("Shape", "set", 3.4, 400),
         node("Transform", "code", 2, 600, parameters={"jsCode": "return items.map(i => i);"}),
         node("Post", "slack", 2.3, 800, parameters={"text": "done"},
              credentials={"slackApi": {"id": "17", "name": "Team Slack"}})],
        link(("Start", "Fetch"), ("Fetch", "Shape"), ("Shape", "Transform"), ("Transform", "Post")),
    )


def ai_cluster(model: str = "lmChatAnthropic") -> dict:
    lc = ni.LANGCHAIN
    return wf(
        [node("Chat", lc + "chatTrigger", 1.1),
         node("Agent", lc + "agent", 2, 200, parameters={
             "promptType": "define", "text": "={{ $json.chatInput }}",
             "options": {"systemMessage": "You triage support mail."}}),
         node("Model", lc + model, 1, 200, 200, parameters={"model": "some-model"},
              credentials={"anthropicApi": {"id": "3", "name": "Anthropic"}}),
         node("Memory", lc + "memoryBufferWindow", 1.3, 300, 200),
         node("Web", lc + "toolHttpRequest", 1.1, 400, 200, parameters={"url": "https://status.example.com"}),
         node("Parser", lc + "outputParserStructured", 1.2, 500, 200,
              parameters={"jsonSchemaExample": "{\"kind\": \"complaint\"}"}),
         node("Notify", "telegram", 1.2, 400, parameters={"text": "={{ $json.output }}"})],
        {**link(("Chat", "Agent"), ("Agent", "Notify")),
         **link(("Model", "Agent", 0, "ai_languageModel")),
         "Memory": {"ai_memory": [[{"node": "Agent", "type": "ai_memory", "index": 0}]]},
         "Web": {"ai_tool": [[{"node": "Agent", "type": "ai_tool", "index": 0}]]},
         "Parser": {"ai_outputParser": [[{"node": "Agent", "type": "ai_outputParser", "index": 0}]]}},
    )


def if_merge(big: bool = False) -> dict:
    nodes = [node("Start", "manualTrigger"),
             node("Check", "if", 2, 200, parameters={"conditions": {"combinator": "and", "conditions": []}}),
             node("Yes", "set", 3.4, 400, -100),
             node("No", "code", 2, 400, 100, parameters={"jsCode": "return [];"}),
             node("Join", "merge", 3, 600),
             node("After", "httpRequest", 4.2, 800)]
    conns = link(("Start", "Check"), ("Check", "Yes", 0), ("Check", "No", 1),
                 ("Yes", "Join"), ("No", "Join"), ("Join", "After"))
    if big:
        nodes.insert(3, node("Think", ni.LANGCHAIN + "chainLlm", 1.5, 500, -100))
        conns = link(("Start", "Check"), ("Check", "Yes", 0), ("Check", "No", 1), ("Yes", "Think"),
                     ("Think", "Join"), ("No", "Join"), ("Join", "After"))
    return wf(nodes, conns)


def loop() -> dict:
    return wf(
        [node("Start", "manualTrigger"),
         node("Rows", "googleSheets", 4.5, 200),
         node("Each", "splitInBatches", 3, 400, parameters={"options": {}}),
         node("Call", "httpRequest", 4.2, 600, 100),
         node("Fix", "code", 2, 800, 100, parameters={"jsCode": "return items;"}),
         node("Report", "slack", 2.3, 600, -100)],
        link(("Start", "Rows"), ("Rows", "Each"), ("Each", "Report", 0), ("Each", "Call", 1),
             ("Call", "Fix"), ("Fix", "Each")),
    )


def webhook() -> dict:
    return wf(
        [node("Hook", "webhook", 2, parameters={"path": "orders", "httpMethod": "POST", "responseMode": "responseNode"}),
         node("Save", "postgres", 2.5, 200),
         node("Reply", "respondToWebhook", 1.1, 400)],
        link(("Hook", "Save"), ("Save", "Reply")),
    )


def schedule() -> dict:
    return wf(
        [node("Every day", "scheduleTrigger", 1.2, parameters={"rule": {"interval": [{"field": "days"}]}}),
         node("Digest", "httpRequest", 4.2, 200)],
        link(("Every day", "Digest")),
    )


def subworkflow() -> dict:
    return wf(
        [node("Start", "manualTrigger"),
         node("Run child", "executeWorkflow", 1.2, 200, parameters={
             "source": "database", "workflowId": {"__rl": True, "mode": "id", "value": "wf-42"}})],
        link(("Start", "Run child")),
    )


def removals() -> dict:
    return wf(
        [node("Start", "manualTrigger"),
         node("Pass", "noOp", 1, 200),
         node("Old call", "httpRequest", 4.2, 400, disabled=True,
              credentials={"httpBasicAuth": {"id": "8", "name": "Legacy"}}),
         node("Shape", "set", 3.4, 600),
         node("Read me", "stickyNote", 1, 620, 20, parameters={"content": "Shape keeps only the id field."})],
        link(("Start", "Pass"), ("Pass", "Old call"), ("Old call", "Shape")),
    )


# ── structure ────────────────────────────────────────────────────────────
def test_linear_chain_collapses_into_one_slot():
    out = convert(linear())
    assert shape(out) == {
        "nodes": [("trigger", "trigger", "Start"), ("n8n-fetch", "slot", "Fetch (+3)")],
        "edges": [("trigger", "n8n-fetch")],
    }
    kick = slot(out, "n8n-fetch")["slot"]["kickoffBody"]
    for step in ("### Step 1: Fetch", "### Step 2: Shape", "### Step 3: Transform", "### Step 4: Post"):
        assert step in kick
    assert "=https://api.example.com/{{ $json.id }}" in kick  # expression kept verbatim
    assert "return items.map(i => i);" in kick  # Code node JS verbatim
    assert slot(out, "n8n-fetch")["slot"]["agentKey"] == "claude"
    stats = out["report"]["stats"]
    assert (stats["nodes"], stats["slots"], stats["triggers"]) == (5, 1, 1)
    assert stats["byCategory"] == {"native": 1, "agent": 4, "pending": 0, "unsupported": 0}
    assert entry(out, "Post")["node"] == "n8n-fetch" and "add-credential" in entry(out, "Post")["actions"]


def test_default_agent_is_the_callers():
    out = convert(linear(), default_agent="codex")
    assert slot(out, "n8n-fetch")["slot"]["agentKey"] == "codex"


@pytest.mark.parametrize("model,agent", [
    ("lmChatAnthropic", "claude"), ("lmChatOpenAi", "codex"), ("lmChatGoogleGemini", "gemini"),
    ("lmChatOllama", "kimi"),
])
def test_ai_agent_cluster_folds_into_one_slot(model, agent):
    out = convert(ai_cluster(model), default_agent="kimi")
    assert shape(out) == {
        "nodes": [("trigger", "trigger", "Chat"), ("n8n-agent", "slot", "Agent"), ("n8n-notify", "slot", "Notify")],
        "edges": [("n8n-agent", "n8n-notify"), ("trigger", "n8n-agent")],
    }
    a = slot(out, "n8n-agent")["slot"]
    assert a["agentKey"] == agent
    assert "You triage support mail." in a["kickoffBody"]
    assert "={{ $json.chatInput }}" in a["kickoffBody"]
    assert "Output contract" in a["kickoffBody"] and "complaint" in a["kickoffBody"]
    assert "Memory \"Memory\": dropped" in a["kickoffBody"]
    for sub in ("Model", "Memory", "Web", "Parser"):
        assert entry(out, sub)["result"] == "folded" and entry(out, sub)["node"] == "n8n-agent"
    assert out["report"]["stats"]["folded"] == 4
    assert "{{prev.summary}}" in slot(out, "n8n-notify")["slot"]["kickoffBody"]


def edges(out: dict) -> list:
    return sorted((e["kind"], e["from"], e["to"], e.get("when")) for e in out["graph"]["edges"])


def test_if_becomes_branch_edges_and_the_merge_is_native():
    out = convert(if_merge())
    assert shape(out)["nodes"] == [("trigger", "trigger", "Start"), ("n8n-check", "slot", "Check"),
                                   ("n8n-yes", "slot", "Yes"), ("n8n-no", "slot", "No"), ("n8n-join", "slot", "Join (+1)")]
    assert edges(out) == [
        ("branch", "n8n-check", "n8n-no", "false"), ("branch", "n8n-check", "n8n-yes", "true"),
        ("main", "n8n-no", "n8n-join", None), ("main", "n8n-yes", "n8n-join", None),
        ("main", "trigger", "n8n-check", None),
    ]
    kick = slot(out, "n8n-check")["slot"]["kickoffBody"]
    assert "---BRANCH: <value>--- with <value> one of: true, false" in kick
    assert '"combinator": "and"' in kick  # the condition, verbatim
    assert (entry(out, "Check")["category"], entry(out, "Check")["reason"]) == ("native", "branch")
    assert entry(out, "Check")["branches"] == ["true", "false"]
    assert (entry(out, "Join")["category"], entry(out, "Join")["reason"]) == ("native", "merge")


def test_a_large_branch_is_native_too():
    out = convert(if_merge(big=True))
    assert [n[0] for n in shape(out)["nodes"]] == ["trigger", "n8n-check", "n8n-yes", "n8n-no", "n8n-think", "n8n-join"]
    assert ("branch", "n8n-check", "n8n-yes", "true") in edges(out)
    assert entry(out, "Check")["category"] == "native" and entry(out, "Join")["category"] == "native"
    assert out["report"]["stats"]["byCategory"]["pending"] == 0


def test_steps_before_an_if_fold_into_its_slot_but_nothing_after_it():
    w = if_merge()
    w["nodes"].insert(1, node("Load", "httpRequest", 4.2, 100))
    w["connections"] = {**link(("Start", "Load"), ("Load", "Check")),
                        **{k: v for k, v in w["connections"].items() if k != "Start"}}
    out = convert(w)
    assert slot(out, "n8n-load")["label"] == "Load (+1)"
    assert ("branch", "n8n-load", "n8n-yes", "true") in edges(out)


def test_switch_rules_map_one_by_one_and_the_fallback_to_default():
    rules = {"values": [{"outputKey": "Refund", "renameOutput": True}, {}]}
    w = wf([node("Start", "manualTrigger"),
            node("Route", "switch", 3.2, 200, parameters={"rules": rules, "options": {"fallbackOutput": "extra"}}),
            node("A", "set", 3.4, 400, -100), node("B", "set", 3.4, 400), node("C", "set", 3.4, 400, 100)],
           link(("Start", "Route"), ("Route", "A", 0), ("Route", "B", 1), ("Route", "C", 2)))
    out = convert(w)
    assert [e for e in edges(out) if e[0] == "branch"] == [
        ("branch", "n8n-route", "n8n-a", "Refund"), ("branch", "n8n-route", "n8n-b", "1"),
        ("branch", "n8n-route", "n8n-c", "default"),
    ]
    assert "one of: Refund, 1, default" in slot(out, "n8n-route")["slot"]["kickoffBody"]


def test_two_outputs_into_one_step_keep_one_branch_and_warn():
    w = wf([node("Start", "manualTrigger"),
            node("Route", "switch", 3.2, 200, parameters={"rules": {"values": [{}, {}, {}]}}),
            node("A", "set", 3.4, 400), node("B", "set", 3.4, 400, 100)],
           link(("Start", "Route"), ("Route", "A", 0), ("Route", "A", 1), ("Route", "B", 2)))
    out = convert(w)
    assert ("branch", "n8n-route", "n8n-a", "0") in edges(out)
    assert any("only \"0\" is kept" in x for x in out["report"]["warnings"])


def test_both_if_outputs_into_one_step_is_a_plain_edge():
    w = wf([node("Start", "manualTrigger"), node("Check", "if", 2, 200), node("A", "set", 3.4, 400)],
           link(("Start", "Check"), ("Check", "A", 0), ("Check", "A", 1)))
    out = convert(w)
    assert ("main", "n8n-check", "n8n-a", None) in edges(out)


def test_an_error_output_becomes_an_error_edge():
    w = wf([node("Start", "manualTrigger"),
            node("Call", "httpRequest", 4.2, 200, onError="continueErrorOutput"),
            node("Ok", "set", 3.4, 400), node("Alert", "slack", 2.3, 400, 100)],
           link(("Start", "Call"), ("Call", "Ok", 0), ("Call", "Alert", 1)))
    out = convert(w)
    assert ("error", "n8n-call", "n8n-alert", None) in edges(out)
    assert slot(out, "n8n-call")["label"] == "Call (+1)"  # the regular output still chains
    assert entry(out, "Call")["errorOutput"] is True
    assert "error → \"Alert\"" in slot(out, "n8n-call")["slot"]["kickoffBody"]


def test_an_if_with_an_error_output():
    w = wf([node("Start", "manualTrigger"), node("Check", "if", 2, 200, onError="continueErrorOutput"),
            node("Y", "set", 3.4, 400), node("N", "set", 3.4, 400, 100), node("E", "set", 3.4, 400, 200)],
           link(("Start", "Check"), ("Check", "Y", 0), ("Check", "N", 1), ("Check", "E", 2)))
    out = convert(w)
    assert {e for e in edges(out) if e[1] == "n8n-check"} == {
        ("branch", "n8n-check", "n8n-y", "true"), ("branch", "n8n-check", "n8n-n", "false"),
        ("error", "n8n-check", "n8n-e", None)}


def test_its_own_error_workflow_becomes_error_edges():
    w = wf([node("Start", "manualTrigger"), node("Work", "httpRequest", 4.2, 200),
            node("Think", ni.LANGCHAIN + "chainLlm", 1.5, 400),
            node("On error", "errorTrigger", 1, 0, 300), node("Page", "slack", 2.3, 200, 300)],
           link(("Start", "Work"), ("Work", "Think"), ("On error", "Page")),
           id="wf-7", settings={"errorWorkflow": "wf-7"})
    out = convert(w)
    assert shape(out)["nodes"][0] == ("trigger", "trigger", "Start")
    assert edges(out) == [
        ("error", "n8n-think", "n8n-page", None), ("error", "n8n-work", "n8n-page", None),
        ("main", "n8n-work", "n8n-think", None), ("main", "trigger", "n8n-work", None),
    ]
    e = entry(out, "On error")
    assert (e["result"], e["category"], e["reason"]) == ("folded", "native", "error-workflow")


def test_another_error_workflow_is_only_a_warning():
    w = wf([node("Start", "manualTrigger"), node("Work", "set", 3.4, 200)], link(("Start", "Work")),
           id="wf-7", settings={"errorWorkflow": "wf-9"})
    out = convert(w)
    assert any("errorWorkflow names another" in x for x in out["report"]["warnings"])
    assert all(e[0] == "main" for e in edges(out))


def test_retry_settings_map_to_the_slot_and_are_capped_at_five():
    w = wf([node("Start", "manualTrigger"),
            node("Call", "httpRequest", 4.2, 200, retryOnFail=True, maxTries=8, waitBetweenTries=500_000),
            node("Think", ni.LANGCHAIN + "chainLlm", 1.5, 400, retryOnFail=True)],
           link(("Start", "Call"), ("Call", "Think")))
    out = convert(w)
    assert slot(out, "n8n-call")["retry"] == {"maxTries": 5, "waitMs": 300_000}
    assert slot(out, "n8n-think")["retry"] == {"maxTries": 3, "waitMs": 1000}
    note = entry(out, "Call")["retry"]
    assert note["capped"] is True and note["requested"] == {"maxTries": 8, "waitMs": 500_000}
    assert entry(out, "Think")["retry"]["capped"] is False
    assert any("Navide allows at most 5 tries" in x for x in out["report"]["warnings"])
    assert "retried 5 times in all" in slot(out, "n8n-call")["slot"]["kickoffBody"]


def test_a_cross_node_read_becomes_a_node_output_reference():
    w = wf([node("Start", "manualTrigger"),
            node("Lookup", ni.LANGCHAIN + "chainLlm", 1.5, 200),
            node("Mid", ni.LANGCHAIN + "chainLlm", 1.5, 400),
            node("Use", "set", 3.4, 600, parameters={"value": "={{ $('Lookup').item.json.email }}",
                                                      "old": "={{ $node[\"Mid\"].json.x }}"})],
           link(("Start", "Lookup"), ("Lookup", "Mid"), ("Mid", "Use")))
    out = convert(w)
    kick = slot(out, "n8n-use")["slot"]["kickoffBody"]
    assert "{{node.n8n-lookup.output}}" in kick and "{{node.n8n-mid.output}}" in kick
    assert "---OUTPUT-START---" in slot(out, "n8n-lookup")["slot"]["kickoffBody"]
    assert "---OUTPUT-START---" not in slot(out, "n8n-use")["slot"]["kickoffBody"]


def test_a_read_of_a_step_that_does_not_run_first_is_disclosed():
    w = wf([node("Start", "manualTrigger"), node("Check", "if", 2, 200),
            node("Y", ni.LANGCHAIN + "chainLlm", 1.5, 400), node("N", "set", 3.4, 400, 100,
                                                              parameters={"v": "={{ $('Y').item.json.a }}"})],
           link(("Start", "Check"), ("Check", "Y", 0), ("Check", "N", 1)))
    out = convert(w)
    kick = slot(out, "n8n-n")["slot"]["kickoffBody"]
    assert "does not run before this step" in kick and "{{node." not in kick


def test_steps_left_in_n8n_carry_the_n8n_mcp_hint():
    lc = ni.LANGCHAIN
    w = wf([node("Start", "manualTrigger"), node("Index", lc + "vectorStoreInMemory", 1, 200)],
           link(("Start", "Index")))
    out = convert(w)
    e = entry(out, "Index")
    assert "keep-in-n8n" in e["actions"] and e["n8nMcp"] == list(ni.N8N_MCP_STEPS)
    assert out["report"]["n8nMcp"]["nodes"] == ["Index"]
    steps = " ".join(ni.N8N_MCP_STEPS)
    assert "Settings → MCP" in steps and "Available in MCP" in steps and "does not wait" in steps
    assert "n8n's MCP server" in slot(out, "n8n-index")["slot"]["kickoffBody"]
    assert convert(linear())["report"]["n8nMcp"] is None


def test_split_in_batches_back_edge_becomes_one_loop_slot():
    out = convert(loop())
    # The loop body folds, and with no branching left the chain around it does too.
    assert shape(out) == {
        "nodes": [("trigger", "trigger", "Start"), ("n8n-rows", "slot", "Rows (+4)")],
        "edges": [("trigger", "n8n-rows")],
    }
    kick = slot(out, "n8n-rows")["slot"]["kickoffBody"]
    assert "\"Each\", \"Call\", \"Fix\" formed a loop" in kick
    assert "loop → \"Call\"" in kick and "done → \"Report\"" in kick
    for name in ("Each", "Call", "Fix"):
        assert entry(out, name)["node"] == "n8n-rows" and entry(out, name)["needsReview"]
    assert not entry(out, "Rows")["needsReview"]


def test_loop_holding_an_agent_stays_its_own_slot_between_agents():
    w = loop()
    lc = ni.LANGCHAIN
    w["nodes"][1] = node("Rows", lc + "chainLlm", 1.5, 200)
    w["nodes"][5] = node("Report", lc + "chainLlm", 1.5, 600, -100)
    out = convert(w)
    assert shape(out) == {
        "nodes": [("trigger", "trigger", "Start"), ("n8n-rows", "slot", "Rows"),
                  ("n8n-each", "slot", "Loop: Each"), ("n8n-report", "slot", "Report")],
        "edges": [("n8n-each", "n8n-report"), ("n8n-rows", "n8n-each"), ("trigger", "n8n-rows")],
    }


def test_webhook_trigger_is_pending_and_says_start_manually():
    out = convert(webhook())
    assert shape(out)["nodes"][0] == ("trigger", "trigger", "Hook")
    hook = entry(out, "Hook")
    assert (hook["category"], hook["reason"], hook["result"]) == ("pending", "webhook-trigger", "trigger")
    assert "start-manually" in hook["actions"]
    assert entry(out, "Reply")["category"] == "pending"
    assert "Navide has no webhook trigger yet" in slot(out, "n8n-save")["slot"]["kickoffBody"]


def test_schedule_trigger_is_pending():
    out = convert(schedule())
    e = entry(out, "Every day")
    assert (e["category"], e["reason"], e["result"]) == ("pending", "schedule-trigger", "trigger")
    assert shape(out)["edges"] == [("trigger", "n8n-digest")]


def test_subworkflow_reference_is_pending_and_asks_for_the_child_json():
    out = convert(subworkflow())
    e = entry(out, "Run child")
    assert e["category"] == "pending" and "paste-subworkflow" in e["actions"]
    assert "wf-42" in slot(out, "n8n-run-child")["slot"]["kickoffBody"]


def test_unknown_type_version_degrades_to_reviewed_agent_step():
    w = linear()
    w["nodes"][1]["typeVersion"] = 9
    out = convert(w)
    e = entry(out, "Fetch")
    assert (e["category"], e["needsReview"], e["reason"]) == ("agent", True, "unknown-version")
    assert "confirm-step" in e["actions"]
    assert out["report"]["stats"]["needsReview"] == 1
    assert out["report"]["slots"][0]["needsReview"] is True


def test_community_node_is_an_agent_step_needing_review():
    w = wf([node("Start", "manualTrigger"), node("Odd", "n8n-nodes-acme.widget", 1, 200)], link(("Start", "Odd")))
    out = convert(w)
    e = entry(out, "Odd")
    assert (e["category"], e["needsReview"], e["reason"]) == ("agent", True, "community-node")


def test_unknown_base_type_and_app_trigger():
    w = wf([node("New row", "airtableTrigger", 1), node("Mystery", "somethingNew", 1, 200)],
           link(("New row", "Mystery")))
    out = convert(w)
    assert entry(out, "New row")["category"] == "pending" and entry(out, "New row")["reason"] == "app-trigger"
    assert entry(out, "Mystery")["reason"] == "unknown-type" and entry(out, "Mystery")["needsReview"]


def test_disabled_noop_and_sticky_are_removed_and_reported():
    out = convert(removals())
    assert shape(out) == {
        "nodes": [("trigger", "trigger", "Start"), ("n8n-shape", "slot", "Shape")],
        "edges": [("trigger", "n8n-shape")],
    }
    assert [entry(out, n)["reason"] for n in ("Pass", "Old call", "Read me")] == ["noop", "disabled", "sticky"]
    assert all(entry(out, n)["result"] == "removed" for n in ("Pass", "Old call", "Read me"))
    assert out["report"]["stats"]["removed"] == {"disabled": 1, "noop": 1, "sticky": 1}
    assert out["report"]["description"] == "Shape keeps only the id field."
    assert "Shape keeps only the id field." in slot(out, "n8n-shape")["slot"]["kickoffBody"]
    assert out["credentials"] == []  # the disabled node's credential is not needed


def test_disabled_agent_takes_its_sub_nodes_with_it():
    w = ai_cluster()
    w["nodes"][1]["disabled"] = True
    out = convert(w)
    assert [n[0] for n in shape(out)["nodes"]] == ["trigger", "n8n-notify"]
    assert entry(out, "Model")["result"] == "removed"


def test_wait_and_send_and_wait_become_gates():
    w = wf([node("Start", "manualTrigger"),
            node("Ask", "slack", 2.3, 200, parameters={"operation": "sendAndWait", "message": "Ship it?"}),
            node("Pause", "wait", 1.1, 400, parameters={"amount": 2, "unit": "hours"}),
            node("Ship", "httpRequest", 4.2, 600)],
           link(("Start", "Ask"), ("Ask", "Pause"), ("Pause", "Ship")))
    out = convert(w)
    assert [n[1] for n in shape(out)["nodes"]] == ["trigger", "gate", "gate", "slot"]
    assert "Ship it?" in slot(out, "n8n-ask")["gate"]["prompt"]
    assert "2 hours" in slot(out, "n8n-pause")["gate"]["prompt"]
    assert out["report"]["gates"][0]["tainted"] is True


def test_no_trigger_gets_a_start_node_and_pin_data_becomes_test_input():
    w = wf([node("A", "set", 3.4), node("B", "code", 2, 200)], link(("A", "B")),
           pinData={"A": [{"json": {"id": 1}}]})
    out = convert(w)
    assert shape(out) == {"nodes": [("trigger", "trigger", "Start"), ("n8n-a", "slot", "A (+1)")],
                          "edges": [("trigger", "n8n-a")]}
    assert out["report"]["testInputs"] == {"A": [{"json": {"id": 1}}]}
    assert "pinData, test data only" in slot(out, "n8n-a")["slot"]["kickoffBody"]
    assert "pinned" not in slot(out, "n8n-a")


def test_ids_are_stable_for_non_ascii_and_colliding_names():
    w = wf([node("開始", "manualTrigger"), node("取資料", "httpRequest", 4.2, 200), node("取資料 ", "set", 3.4, 400),
            node("Gate", "wait", 1.1, 600), node("取 資料", "set", 3.4, 800)],
           link(("開始", "取資料"), ("取資料", "取資料 "), ("取資料 ", "Gate"), ("Gate", "取 資料")))
    a, b = convert(w), convert(w)
    assert shape(a) == shape(b)
    ids = [n[0] for n in shape(a)["nodes"]]
    assert len(set(ids)) == len(ids) and all(i == "trigger" or i.startswith("n8n-") for i in ids)


def test_many_agents_warn_over_the_slot_target():
    lc = ni.LANGCHAIN
    nodes = [node("Start", "manualTrigger")] + [node(f"A{i}", lc + "chainLlm", 1.5, i * 100) for i in range(10)]
    pairs = [("Start", "A0")] + [(f"A{i}", f"A{i + 1}") for i in range(9)]
    out = convert(wf(nodes, link(*pairs)))
    assert out["report"]["stats"]["slots"] == 10 and out["report"]["stats"]["overTarget"] is True
    assert any("target" in w for w in out["report"]["warnings"])


def test_accepts_json_text_and_returns_source():
    text = json.dumps(linear())
    out = convert(text)
    assert out["source"]["kind"] == "n8n" and out["source"]["importedAt"] == NOW
    assert out["source"]["json"]["nodes"][0]["name"] == "Start"


@pytest.mark.parametrize("bad", ["{", "[]", json.dumps({"nodes": []}), {"nodes": [{"name": "x"}], "connections": {}},
                                 {"nodes": [node("A", "set"), node("A", "set")], "connections": {}}])
def test_rejects_input_that_is_not_a_workflow(bad):
    with pytest.raises(ni.N8nImportError):
        ni.convert_n8n_workflow(bad)


def test_every_fixture_passes_validate_graph_and_is_tainted():
    for w in (linear(), ai_cluster(), if_merge(), if_merge(True), loop(), webhook(), schedule(), subworkflow(),
              removals()):
        assert ni.pg.validate_graph(ni.convert_n8n_workflow(w)["graph"]) == []
        out = convert(w)
        assert out["report"]["taint"]["source"] == ni.TAINT_SOURCE
        assert "Fixture" in out["report"]["taint"]["detail"]
        for s in out["report"]["slots"]:
            assert s["tainted"] is True
            assert s["kickoffBody"].startswith("[External content: imported from the n8n workflow")
            assert s["kickoffBody"] == slot(out, s["id"])["slot"]["kickoffBody"]


# ── credentials and secrets ──────────────────────────────────────────────
def test_credentials_list_type_name_nodes_without_ids():
    out = convert(ai_cluster())
    assert out["credentials"] == [{"type": "anthropicApi", "name": "Anthropic", "nodes": ["Model"]}]
    assert out["report"]["credentials"] == out["credentials"]
    assert out["source"]["json"]["nodes"][2]["credentials"] == {"anthropicApi": {"name": "Anthropic"}}
    assert '"id": "3"' not in json.dumps(out["source"]["json"]["nodes"][2]["credentials"])


def _secret_fixture() -> tuple[dict, list[str]]:
    bearer = "eyFAKE" + "tok3n" + "0123456789abcdef"
    api_key = "sk-" + "test" + "A1b2C3d4E5f6G7h8I9"
    query = "q" + "Key" + "7788990011"
    basic = "dXNlcjpw" + "YXNzd29yZA=="
    header_json = "hj" + "Secret" + "445566"
    code_key = "ck" + "Value" + "998877"
    pin_tok = "pin" + "Token" + "123123"
    gh = "ghp_" + "A" * 10 + "b" * 26
    literal_pw = "pa" + "ss" + "word9"
    nodes = [
        node("Start", "manualTrigger"),
        node("Curl import", "httpRequest", 4.2, 200, parameters={
            "url": "https://api.example.com/v1?api_key=" + query + "&page=2",
            "sendHeaders": True,
            "headerParameters": {"parameters": [
                {"name": "Authorization", "value": "Bearer " + bearer},
                {"name": "X-Api-Key", "value": api_key},
                {"name": "X-Trace", "value": "={{ $json.trace }}"},
                {"name": "Authorization", "value": "=Bearer {{ $json.token }}"},
            ]},
            "jsonHeaders": "{\"Authorization\": \"Basic " + basic + "\", \"api-key\": \"" + header_json + "\"}",
        }),
        node("Code", "code", 2, 400, parameters={"jsCode": "const apiKey = \"" + code_key + "\";\nreturn [];"}),
        node("Login", "httpRequest", 4.2, 600, parameters={"password": literal_pw, "note": "push with " + gh},
             notes="ask ops"),
    ]
    w = wf(nodes, link(("Start", "Curl import"), ("Curl import", "Code"), ("Code", "Login")),
           pinData={"Curl import": [{"json": {"token": pin_tok}}]})
    return w, [bearer, api_key, query, basic, header_json, code_key, pin_tok, gh, literal_pw]


def test_embedded_secrets_never_reach_any_output():
    w, secrets = _secret_fixture()
    out = convert(w)
    blob = json.dumps(out, ensure_ascii=False)
    for s in secrets:
        assert s not in blob
    assert "<removed: add credential for" in blob
    # References resolved at run time are not secrets.
    assert "={{ $json.trace }}" in blob and "=Bearer {{ $json.token }}" in blob
    fields = {(r["node"], r["field"]) for r in out["report"]["secretsRemoved"]}
    assert ("Curl import", "parameters.url") in fields
    assert ("Curl import", "parameters.headerParameters.parameters[0].value") in fields
    assert ("Curl import", "parameters.headerParameters.parameters[1].value") in fields
    assert ("Curl import", "parameters.jsonHeaders") in fields
    assert ("Code", "parameters.jsCode") in fields
    assert ("Login", "parameters.password") in fields
    assert ("Login", "parameters.note") in fields
    assert ("Curl import", "pinData[0].json.token") in fields
    assert all(set(r) == {"node", "field"} for r in out["report"]["secretsRemoved"])
    # The non-secret parts of a string survive.
    url = out["source"]["json"]["nodes"][1]["parameters"]["url"]
    assert url.startswith("https://api.example.com/v1?api_key=<removed:") and url.endswith("&page=2")


def test_literals_inside_expressions_and_other_key_names_are_redacted():
    in_expr = "hun" + "ter2" + "value99"
    access = "AK" + "x9" + "q" * 8
    sub_key = "4f3e" + "2d1c" + "0b9a" + "8877" + "6655"
    keyish = "zz" + "9" * 10 + "Q" * 10
    w = wf([node("Start", "manualTrigger"),
            node("Call", "httpRequest", 4.2, 200, parameters={
                "password": "={{ \"" + in_expr + "\" }}",
                "accessKey": access,
                "options": {"ocpApimSubscriptionKey": sub_key, "authHeaderValue": keyish,
                            "maxTokens": "2000", "keyword": "invoice", "sessionKey": "={{ $json.sessionId }}"},
            })],
           link(("Start", "Call")))
    out = convert(w)
    blob = json.dumps(out, ensure_ascii=False)
    for s in (in_expr, access, sub_key, keyish):
        assert s not in blob
    params = out["source"]["json"]["nodes"][1]["parameters"]
    assert params["options"]["maxTokens"] == "2000" and params["options"]["keyword"] == "invoice"
    assert params["options"]["sessionKey"] == "={{ $json.sessionId }}"


def test_secret_values_are_not_in_errors_either():
    w, secrets = _secret_fixture()
    w["nodes"].append(dict(w["nodes"][1]))  # duplicate name → rejected
    with pytest.raises(ni.N8nImportError) as err:
        ni.convert_n8n_workflow(w)
    assert not any(s in str(err.value) for s in secrets)


def test_input_is_not_mutated():
    w, _ = _secret_fixture()
    before = json.dumps(w, sort_keys=True)
    convert(w)
    assert json.dumps(w, sort_keys=True) == before

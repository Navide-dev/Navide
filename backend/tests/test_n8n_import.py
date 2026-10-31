"""n8n workflow import: hand-written n8n JSON fixtures → pipeline graph.

Fixtures follow the n8n export shape (nodes[] + connections keyed by node
name). Fake secrets are built by concatenation so no literal token sits in
the source.
"""

from __future__ import annotations

import json
from pathlib import Path
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


def if_merge(big: bool = False, check: tuple[str, float] = ("if", 2)) -> dict:
    nodes = [node("Start", "manualTrigger"),
             node("Check", *check, 200, parameters={"conditions": {"combinator": "and", "conditions": []}}),
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
    assert "report the branch you take, one of: true, false" in kick
    assert "---" + "BRANCH" not in kick  # the engine adds the signal format, with its code
    assert '"combinator": "and"' in kick  # the condition, verbatim
    assert (entry(out, "Check")["category"], entry(out, "Check")["reason"]) == ("native", "branch")
    assert entry(out, "Check")["branches"] == ["true", "false"]
    assert (entry(out, "Join")["category"], entry(out, "Join")["reason"]) == ("native", "merge")


# IF and Switch are branch edges now; these two cover what a node with several
# outputs that is neither does, where every output may hold items.
COMPARE = ("compareDatasets", 2.3)


def test_small_if_and_merge_collapse_into_one_agent_slot():
    out = convert(if_merge(check=COMPARE))
    assert shape(out) == {
        "nodes": [("trigger", "trigger", "Start"), ("n8n-check", "slot", "Check (+4)")],
        "edges": [("trigger", "n8n-check")],
    }
    kick = slot(out, "n8n-check")["slot"]["kickoffBody"]
    assert "following every output that has items" in kick
    assert "Next: output 0 → \"Yes\"; output 1 → \"No\"" in kick
    assert entry(out, "Check")["category"] == "agent"


def test_large_branch_is_pending_and_the_merge_after_it_too():
    out = convert(if_merge(big=True, check=COMPARE))
    ids = [n[0] for n in shape(out)["nodes"]]
    assert ids == ["trigger", "n8n-check", "n8n-yes", "n8n-no", "n8n-think", "n8n-join"]
    assert ("n8n-check", "n8n-yes") in shape(out)["edges"] and ("n8n-check", "n8n-no") in shape(out)["edges"]
    assert entry(out, "Check")["category"] == "pending" and entry(out, "Check")["reason"] == "branch-too-large"
    assert entry(out, "Check")["detailCode"] == "branch-too-large"
    assert entry(out, "Join")["category"] == "pending" and entry(out, "Join")["reason"] == "merge-after-branch"
    assert entry(out, "Join")["detailCode"] == "merge-after-branch"
    assert out["report"]["nodeCategories"]["n8n-join"] == "pending"
    assert entry(out, "Think")["result"] == "slot"


def test_no_agent_is_named_for_a_trigger_or_an_approval_gate():
    out = convert(linear())
    assert entry(out, "Start")["detailCode"] == "trigger-start"
    w = wf([node("Start", "manualTrigger"), node("Ok", "wait", 1.1, 200)], link(("Start", "Ok")))
    assert entry(convert(w), "Ok")["detailCode"] == "gate-approval"


def test_a_workflow_without_such_a_node_reports_neither_reason():
    # IF and Switch regions of any size, and every other golden, are as before.
    for w in (linear(), ai_cluster(), if_merge(), if_merge(True), loop(), webhook(), schedule(), subworkflow()):
        reasons = {e["reason"] for e in convert(w)["report"]["nodes"]}
        assert not reasons & {"branch-too-large", "merge-after-branch"}


@pytest.mark.parametrize("mode", ["append", "chooseBranch", None])
def test_a_merge_that_waits_for_its_inputs_is_native(mode):
    w = if_merge()
    if mode:
        w["nodes"][4]["parameters"] = {"mode": mode}
    out = convert(w)
    assert (entry(out, "Join")["category"], entry(out, "Join")["reason"]) == ("native", "merge")


@pytest.mark.parametrize("mode", ["passThrough", "wait"])
def test_a_merge_v1_pass_through_or_wait_is_a_native_join(mode):
    w = if_merge()
    w["nodes"][4]["typeVersion"] = 1
    w["nodes"][4]["parameters"] = {"mode": mode}
    out = convert(w)
    assert (entry(out, "Join")["category"], entry(out, "Join")["reason"]) == ("native", "merge")


def test_a_merge_v2_keeps_its_own_modes():
    w = if_merge()
    w["nodes"][4]["typeVersion"] = 2
    w["nodes"][4]["parameters"] = {"mode": "passThrough"}
    out = convert(w)
    assert (entry(out, "Join")["category"], entry(out, "Join")["reason"]) == ("agent", "merge-combine")


def test_a_combine_by_sql_merge_is_an_agent_step_folded_downstream():
    w = if_merge()
    sql = "SELECT * FROM input1 LEFT JOIN input2 ON input1.id = input2.id"
    w["nodes"][4]["parameters"] = {"mode": "combineBySql", "query": sql}
    out = convert(w)
    e = entry(out, "Join")
    assert (e["category"], e["reason"], e["node"]) == ("agent", "merge-combine", "n8n-join")
    assert slot(out, "n8n-join")["label"] == "Join (+1)"  # After folds in behind it
    kick = slot(out, "n8n-join")["slot"]["kickoffBody"]
    assert "Merge rule" in kick and '"combineBySql" mode' in kick and sql in kick
    assert ("main", "n8n-yes", "n8n-join", None) in edges(out)


def test_a_combine_merge_is_an_agent_step():
    w = if_merge()
    w["nodes"][4]["parameters"] = {"mode": "combine", "combineBy": "combineByFields",
                                   "fieldsToMatchString": "id"}
    out = convert(w)
    assert (entry(out, "Join")["category"], entry(out, "Join")["reason"]) == ("agent", "merge-combine")


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


@pytest.mark.parametrize("ver", [1, 2])
def test_switch_v1_v2_rules_branch_by_their_declared_output(ver):
    # Rule 0 sends to output 2, rule 1 to output 0, and no match to output 1:
    # the branch value of an edge is the output it leaves from, not the rule's
    # position in the list.
    params = {"mode": "rules", "rules": {"rules": [{"output": 2}, {"output": 0}]}, "fallbackOutput": 1}
    w = wf([node("Start", "manualTrigger"), node("Route", "switch", ver, 200, parameters=params),
            node("A", "set", 3.4, 400), node("B", "set", 3.4, 400, 100), node("C", "set", 3.4, 400, 200)],
           link(("Start", "Route"), ("Route", "A", 0), ("Route", "B", 1), ("Route", "C", 2)))
    out = convert(w)
    assert [e for e in edges(out) if e[0] == "branch"] == [
        ("branch", "n8n-route", "n8n-a", "0"), ("branch", "n8n-route", "n8n-b", "default"),
        ("branch", "n8n-route", "n8n-c", "2"),
    ]
    assert entry(out, "Route")["branches"] == ["0", "default", "2"]
    kick = slot(out, "n8n-route")["slot"]["kickoffBody"]
    assert "rule 0 → 2, rule 1 → 0, no rule matches → default" in kick


def test_switch_v1_v2_output_indices_out_of_range_are_ignored():
    # The indices come from the file: a huge one must not size anything.
    params = {"mode": "rules", "rules": {"rules": [{"output": 1000}, {"output": 0}]}, "fallbackOutput": 1000}
    w = wf([node("Start", "manualTrigger"), node("Route", "switch", 2, 200, parameters=params),
            node("A", "set", 3.4, 400), node("B", "set", 3.4, 400, 100)],
           link(("Start", "Route"), ("Route", "A", 0), ("Route", "B", 1)))
    # Rule 0 falls back to its own position, 0, as rule 1 says; no fallback.
    assert entry(convert(w), "Route")["branches"] == ["0"]


def test_switch_v1_v2_without_a_fallback_has_no_default_branch():
    params = {"mode": "rules", "rules": {"rules": [{"output": 1}, {"output": 0}]}, "fallbackOutput": -1}
    w = wf([node("Start", "manualTrigger"), node("Route", "switch", 2, 200, parameters=params),
            node("A", "set", 3.4, 400), node("B", "set", 3.4, 400, 100)],
           link(("Start", "Route"), ("Route", "A", 0), ("Route", "B", 1)))
    out = convert(w)
    assert entry(out, "Route")["branches"] == ["0", "1"]
    assert "no rule matches" not in slot(out, "n8n-route")["slot"]["kickoffBody"]


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
    assert "result as JSON" in slot(out, "n8n-lookup")["slot"]["kickoffBody"]
    assert "result as JSON" not in slot(out, "n8n-use")["slot"]["kickoffBody"]


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


def poll_loop(with_wait: bool = True) -> dict:
    nodes = [node("Start", "manualTrigger"), node("Poll", "httpRequest", 4.2, 200), node("Ready", "if", 2, 400),
             node("Use", "set", 3.4, 600, 100)]
    pairs = [("Start", "Poll"), ("Poll", "Ready"), ("Ready", "Use", 0)]
    if with_wait:
        nodes.append(node("Pause", "wait", 1.1, 600, parameters={"amount": 30, "unit": "seconds"}))
        pairs += [("Ready", "Pause", 1), ("Pause", "Poll")]
    else:
        pairs.append(("Ready", "Poll", 1))
    return wf(nodes, link(*pairs))


@pytest.mark.parametrize("with_wait", [True, False])
def test_a_poll_loop_repeats_until_its_condition_holds(with_wait):
    out = convert(poll_loop(with_wait))
    group = entry(out, "Poll")["node"]
    kick = slot(out, group)["slot"]["kickoffBody"]
    assert "one by one" not in entry(out, "Poll")["detail"]
    assert "until" in entry(out, "Poll")["detail"] and "condition" in entry(out, "Poll")["detail"]
    assert "one item (or batch) at a time" not in kick
    assert "repeat those steps until the condition that leaves the loop holds" in kick
    if with_wait:
        assert entry(out, "Pause")["node"] == group
        assert "Wait" in entry(out, "Pause")["detail"]
        assert "\"Pause\" is an n8n Wait inside the loop" in kick
        assert any("\"Pause\"" in x and "inside a loop" in x for x in out["report"]["warnings"])


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


def test_schedule_trigger_points_at_a_scheduled_pipeline_start():
    # Navide schedules pipeline runs (a pipeline_start job); the note must not
    # say it cannot.
    e = entry(convert(schedule()), "Every day")
    assert e["detailCode"] == "role-trigger-schedule"
    assert "pipeline_start" in e["detail"]
    assert "until Navide" not in e["detail"]


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


# ── sub-pipelines ────────────────────────────────────────────────────────
def subpipeline_call(**extra: Any) -> dict:
    """Execute Workflow wf-42 between two steps, failing into Alert."""
    return wf(
        [node("Start", "manualTrigger"),
         node("Prepare", "set", 3.4, 200),
         node("Run child", "executeWorkflow", 1.2, 400, onError="continueErrorOutput", retryOnFail=True,
              maxTries=2, waitBetweenTries=500, parameters={
                  "source": "database", "workflowId": {"__rl": True, "mode": "list", "value": "wf-42"},
                  "workflowInputs": {"value": {"email": "={{ $json.email }}"}}, **extra}),
         node("Report", "slack", 2.3, 600), node("Alert", "slack", 2.3, 600, 100)],
        link(("Start", "Prepare"), ("Prepare", "Run child"), ("Run child", "Report", 0), ("Run child", "Alert", 1)),
    )


def test_execute_workflow_of_a_known_pipeline_becomes_a_subpipeline_node():
    out = convert(subpipeline_call(), subpipelines={"wf-42": "pl-child"})
    assert shape(out) == {
        "nodes": [("trigger", "trigger", "Start"), ("n8n-prepare", "slot", "Prepare"),
                  ("n8n-run-child", "subpipeline", "Run child"), ("n8n-report", "slot", "Report"),
                  ("n8n-alert", "slot", "Alert")],
        "edges": [("n8n-prepare", "n8n-run-child"), ("n8n-run-child", "n8n-alert"),
                  ("n8n-run-child", "n8n-report"), ("trigger", "n8n-prepare")],
    }
    sub = slot(out, "n8n-run-child")
    assert sub["retry"] == {"maxTries": 2, "waitMs": 500}
    assert sub["subpipeline"]["pipelineId"] == "pl-child" and sub["subpipeline"]["wait"] is True
    task = sub["subpipeline"]["task"]
    assert task.startswith("[External content: imported from the n8n workflow")
    assert '"email": "={{ $json.email }}"' in task and "{{task}}" in task and "{{prev.summary}}" in task
    assert "wf-42" not in task  # the call itself is the node, not part of its task
    assert ("error", "n8n-run-child", "n8n-alert", None) in edges(out)
    e = entry(out, "Run child")
    assert (e["category"], e["reason"], e["result"], e["node"]) == ("native", "subpipeline", "subpipeline", "n8n-run-child")
    assert "paste-subworkflow" not in e["actions"] and "pl-child" in e["detail"]
    assert out["report"]["stats"]["subpipelines"] == 1
    assert out["report"]["subpipelines"][0] == {"id": "n8n-run-child", "label": "Run child", "pipelineId": "pl-child",
                                               "task": task, "tainted": True, "retry": {"maxTries": 2, "waitMs": 500}}


def test_a_sub_workflow_n8n_does_not_wait_for_still_waits():
    out = convert(subpipeline_call(options={"waitForSubWorkflow": False}), subpipelines={"wf-42": "pl-child"})
    assert "Navide always waits" in entry(out, "Run child")["detail"]


@pytest.mark.parametrize("params", [
    {"source": "database", "workflowId": "={{ $json.next }}"},  # chosen by an expression
    {"source": "parameter", "workflowJson": "{}"},  # passed as JSON
    {"source": "database", "workflowId": {"__rl": True, "mode": "id", "value": "wf-other"}},  # not imported
])
def test_a_call_navide_cannot_resolve_stays_pending(params):
    w = subworkflow()
    w["nodes"][1]["parameters"] = params
    out = convert(w, subpipelines={"wf-42": "pl-child"})
    e = entry(out, "Run child")
    assert (e["category"], e["result"]) == ("pending", "slot") and "paste-subworkflow" in e["actions"]
    assert not any(n["kind"] == "subpipeline" for n in out["graph"]["nodes"])


def test_a_recursive_call_stays_pending_without_asking_for_a_paste():
    out = convert(subworkflow(), subpipelines={"wf-42": "pl-self"}, recursive_workflows={"wf-42"})
    e = entry(out, "Run child")
    assert (e["category"], e["reason"], e["result"]) == ("pending", "recursive-subworkflow", "slot")
    assert "paste-subworkflow" not in e["actions"] and "calls this workflow back" in e["detail"]
    assert not any(n["kind"] == "subpipeline" for n in out["graph"]["nodes"])


def test_a_workflow_tool_is_named_in_the_kickoff_never_converted():
    w = ai_cluster()
    w["nodes"].append(node("Lookup tool", ni.LANGCHAIN + "toolWorkflow", 2, 300, 200, parameters={
        "source": "database", "workflowId": {"__rl": True, "mode": "id", "value": "wf-7"}}))
    w["connections"]["Lookup tool"] = {"ai_tool": [[{"node": "Agent", "type": "ai_tool", "index": 0}]]}
    unresolved = convert(w)
    e = entry(unresolved, "Lookup tool")
    assert (e["category"], e["result"]) == ("pending", "folded") and "paste-subworkflow" in e["actions"]
    out = convert(w, subpipelines={"wf-7": "pl-lookup"})
    e = entry(out, "Lookup tool")
    assert (e["category"], e["result"]) == ("pending", "folded") and "paste-subworkflow" not in e["actions"]
    assert "pl-lookup" in e["detail"]
    assert not any(n["kind"] == "subpipeline" for n in out["graph"]["nodes"])
    kick = next(s["kickoffBody"] for s in out["report"]["slots"])
    assert "imported here as the pipeline pl-lookup" in kick


def test_no_kickoff_or_sub_pipeline_task_writes_a_signal_format():
    # The engine appends the signal instructions with their per-kickoff code
    # (#752); a converted kickoff must never hold a format of its own.
    needles = ["---" + "BRANCH", "---" + "OUTPUT-", "---" + "NODE-FAILED"]
    cross = wf([node("Start", "manualTrigger"), node("Lookup", "httpRequest", 4.2, 200),
                node("Mid", "if", 2.2, 400), node("Use", "set", 3.4, 600,
                                                  parameters={"value": "={{ $('Lookup').item.json.email }}"})],
               link(("Start", "Lookup"), ("Lookup", "Mid"), ("Mid", "Use", 0)))
    outs = [convert(w) for w in (linear(), ai_cluster(), if_merge(), if_merge(True), loop(), webhook(), schedule(),
                                 subworkflow(), removals(), cross)]
    outs.append(convert(subpipeline_call(), subpipelines={"wf-42": "pl-child"}))
    texts = [s["kickoffBody"] for o in outs for s in o["report"]["slots"]]
    texts += [s["task"] for o in outs for s in o["report"]["subpipelines"]]
    assert texts and any("report the branch you take" in t for t in texts)
    for t in texts:
        assert not any(n in t for n in needles), t[:200]


NATIVE_FLOW_SIGNALS_FIXTURE = (
    Path(__file__).resolve().parents[2] / "src" / "renderer" / "src" / "lib" / "__tests__" / "fixtures"
    / "n8n-native-flow-signals.json"
)


def test_the_native_flow_signal_fixture_is_the_converters_output():
    # pipelineSignalN8nNativeFlow.test.ts runs this graph through the pipeline
    # engine: forged signals and the kickoff's echo steer nothing, signals
    # with the kickoff's code do.
    fixture = json.loads(NATIVE_FLOW_SIGNALS_FIXTURE.read_text(encoding="utf-8"))
    out = convert(fixture["workflow"])
    assert out["graph"] == fixture["graph"]
    kinds = {(e["from"], e["kind"]) for e in out["graph"]["edges"]}
    assert {("n8n-plan", "branch"), ("n8n-route", "branch"), ("n8n-plan", "error")} <= kinds
    assert "{{node.n8n-plan.output}}" in slot(out, "n8n-fast")["slot"]["kickoffBody"]


# ── translatable report ──────────────────────────────────────────────────
EN_US = Path(__file__).resolve().parents[2] / "packages" / "plugin-ui" / "src" / "foundation" / "i18n" / "locales" / "en-US.json"


def _report_corpus() -> list[dict]:
    """Conversions that between them hit every detail and warning the report can carry."""
    w_trig = wf([node("Start", "manualTrigger"), node("A", "set", 3.4, 200), node("Again", "manualTrigger", 1, 400)],
                link(("Start", "A"), ("A", "Again")))
    w_err_other = wf([node("Start", "manualTrigger"), node("A", "set", 3.4, 200)], link(("Start", "A")),
                     settings={"errorWorkflow": "elsewhere"})
    w_own_err = wf([node("Start", "manualTrigger"), node("A", "set", 3.4, 200), node("Oops", "errorTrigger", 1, 0, 300),
                    node("Tell", "slack", 2.3, 200, 300)],
                   link(("Start", "A"), ("Oops", "Tell")), id="self", settings={"errorWorkflow": "self"})
    w_retry = wf([node("Start", "manualTrigger"), node("Call", "httpRequest", 4.2, 200, retryOnFail=True, maxTries=8)],
                 link(("Start", "Call")))
    w_gate_branch = wf([node("Start", "manualTrigger"), node("Ok", "wait", 1.1, 200, onError="continueErrorOutput"),
                        node("A", "set", 3.4, 400), node("B", "set", 3.4, 400, 100)],
                       link(("Start", "Ok"), ("Ok", "A", 0), ("Ok", "B", 1)))
    w_same = wf([node("Start", "manualTrigger"),
                 node("Route", "switch", 3.2, 200, parameters={"rules": {"values": [{}, {}, {}]}}),
                 node("A", "set", 3.4, 400), node("B", "set", 3.4, 400, 100)],
                link(("Start", "Route"), ("Route", "A", 0), ("Route", "A", 1), ("Route", "B", 2)))
    w_many = wf([node("Start", "manualTrigger")] + [node(f"Ai{i}", ni.LANGCHAIN + "chainLlm", 1.5, i * 100) for i in range(10)],
                link(("Start", "Ai0"), *[(f"Ai{i}", f"Ai{i + 1}") for i in range(9)]))
    w_odd = wf([node("Start", "manualTrigger"), node("Old", "httpRequest", 9, 200), node("New", "fooBar", 1, 400),
                node("Weird", "acme.thing", 1, 600), node("Hook", "slackTrigger", 1, 0, 200),
                node("Join", "merge", 3, 800, parameters={"mode": "combine"}), node("Tool", ni.LANGCHAIN + "toolCode", 1, 0, 400),
                node("Vec", ni.LANGCHAIN + "vectorStoreInMemory", 1, 0, 500), node("Mem", ni.LANGCHAIN + "memoryBufferWindow", 1, 0, 600),
                node("Mcp", ni.LANGCHAIN + "mcpClientTool", 1, 0, 700), node("Parse", ni.LANGCHAIN + "outputParserStructured", 1, 0, 800),
                node("Other", ni.LANGCHAIN + "somethingNew", 1, 0, 900), node("Agent", ni.LANGCHAIN + "agent", 1.7, 1000),
                node("Model", ni.LANGCHAIN + "lmChatAnthropic", 1, 0, 1000), node("Answer", "respondToWebhook", 1, 1200),
                node("Helper", "set", 3.4, 0, 1100)],
               {**link(("Start", "Old"), ("Old", "New"), ("New", "Weird"), ("Weird", "Join"), ("Join", "Agent"),
                       ("Agent", "Answer"), ("Hook", "Join")),
                **link(("Tool", "Agent", 0, "ai_tool")), **{"Vec": link(("Vec", "Agent", 0, "ai_tool"))["Vec"]},
                **link(("Mem", "Agent", 0, "ai_memory")), **link(("Mcp", "Agent", 0, "ai_tool")),
                **link(("Parse", "Agent", 0, "ai_outputParser")), **link(("Model", "Agent", 0, "ai_languageModel")),
                **link(("Other", "Agent", 0, "ai_tool")), **link(("Helper", "Agent", 0, "ai_tool"))})
    sub_loop = wf([node("Start", "manualTrigger"), node("Each", "splitInBatches", 3, 200),
                   node("Run", "executeWorkflow", 1.2, 400, parameters={"workflowId": "wf-42"})],
                  link(("Start", "Each"), ("Each", "Run", 1), ("Run", "Each")))
    tool_wf = wf([node("Start", "manualTrigger"), node("Agent", ni.LANGCHAIN + "agent", 1.7, 200),
                  node("Model", ni.LANGCHAIN + "lmChatAnthropic", 1, 0, 200),
                  node("Calls", ni.LANGCHAIN + "toolWorkflow", 1, 0, 300, parameters={"workflowId": "wf-42"})],
                 {**link(("Start", "Agent")), **link(("Model", "Agent", 0, "ai_languageModel")),
                  **link(("Calls", "Agent", 0, "ai_tool"))})
    outs = [convert(w) for w in (linear(), ai_cluster(), if_merge(), if_merge(True), loop(), webhook(), schedule(),
                                 subworkflow(), removals(), poll_loop(), poll_loop(False), w_trig, w_err_other, w_own_err,
                                 w_retry, w_gate_branch, w_same, w_many, w_odd, tool_wf)]
    outs.append(convert(subpipeline_call(), subpipelines={"wf-42": "pl-child"}))
    nowait = subpipeline_call(options={"waitForSubWorkflow": False})
    outs.append(convert(nowait, subpipelines={"wf-42": "pl-child"}))
    outs.append(convert(wf([node("Oops", "errorTrigger"), node("Tell", "slack", 2.3, 200)], link(("Oops", "Tell")))))
    outs.append(convert(subpipeline_call(), subpipelines={"wf-42": "pl-child"}, recursive_workflows={"wf-42"}))
    outs.append(convert(sub_loop, subpipelines={"wf-42": "pl-child"}))
    outs.append(convert(tool_wf, subpipelines={"wf-42": "pl-child"}))
    switch_v2 = wf([node("Start", "manualTrigger"),
                    node("Route", "switch", 2, 200, parameters={"rules": {"rules": [{"output": 1}]}, "fallbackOutput": 0}),
                    node("A", "set", 3.4, 400), node("B", "set", 3.4, 400, 100)],
                   link(("Start", "Route"), ("Route", "A", 0), ("Route", "B", 1)))
    outs.append(convert(switch_v2))
    outs.append(convert(if_merge(big=True, check=COMPARE)))
    return outs


def test_every_detail_and_warning_carries_a_code_the_window_translates():
    loc = json.loads(EN_US.read_text(encoding="utf-8"))["pipelineImport"]
    details, warns = set(), set()
    for out in _report_corpus():
        rep = out["report"]
        for e in rep["nodes"]:
            assert e["detail"] and e["detailCode"] in loc["detail"], (e["name"], e["detailCode"], e["detail"])
            assert isinstance(e["detailParams"], dict)
            details.add(e["detailCode"])
        assert [w["text"] for w in rep["warningItems"]] == rep["warnings"]
        for w in rep["warningItems"]:
            assert w["code"] in loc["warning"], w
            warns.add(w["code"])
    # The corpus reaches every message the window has, so none is dead.
    assert details == set(loc["detail"]) and warns == set(loc["warning"])


def test_detail_params_carry_the_values_in_the_sentence():
    w = wf([node("Start", "manualTrigger"), node("Old", "httpRequest", 9, 200)], link(("Start", "Old")))
    e = entry(convert(w), "Old")
    assert (e["detailCode"], e["detailParams"]) == ("unknown-version", {"version": 9, "lo": 1, "hi": 4.3})
    w = if_merge()
    w["nodes"][4]["parameters"] = {"mode": "combineBySql"}
    e = entry(convert(w), "Join")
    assert (e["detailCode"], e["detailParams"]) == ("merge-combine", {"mode": "combineBySql"})


@pytest.mark.parametrize("bad, reason", [
    ("{not json", "invalid-json"), ("[]", "empty-list"), ("3", "not-object"), ('{"nodes": 1}', "no-nodes"),
    ('{"nodes": [{}], "connections": {}}', "node-shape"),
])
def test_errors_carry_a_reason_the_window_translates(bad, reason):
    loc = json.loads(EN_US.read_text(encoding="utf-8"))["pipelineImport"]["error-reason"]
    with pytest.raises(ni.N8nImportError) as exc:
        ni.import_into_store(None, bad)
    assert exc.value.reason == reason and reason in loc
    for code in ("duplicate-name", "internal", "too-large", "store-refused", "invalid"):
        assert code in loc


def test_steps_to_review_carry_the_flag_into_the_graph():
    w = wf([node("Start", "manualTrigger"), node("Old", "httpRequest", 9, 200), node("Weird", "acme.thing", 1, 400),
            node("Agent", ni.LANGCHAIN + "chainLlm", 1.5, 600), node("Ok", "set", 3.4, 800)],
           link(("Start", "Old"), ("Old", "Weird"), ("Weird", "Agent"), ("Agent", "Ok")))
    out = convert(w)
    flags = {n["id"]: n.get("needsReview") for n in out["graph"]["nodes"]}
    assert flags == {"trigger": None, "n8n-old": True, "n8n-agent": None, "n8n-ok": None}



def test_the_review_flag_survives_the_store(tmp_path):
    from agent_team_backend.stages_store import PIPELINES_FILE, StagesStore

    store = StagesStore(tmp_path / PIPELINES_FILE)
    w = wf([node("Start", "manualTrigger"), node("Old", "httpRequest", 9, 200)], link(("Start", "Old")))
    out = ni.import_into_store(store, w, dry_run=False)
    graph = store.get_graph(out["pipeline"]["id"])["graph"]
    assert next(n for n in graph["nodes"] if n["id"] == "n8n-old")["needsReview"] is True


def _if_chain(n: int) -> dict:
    nodes = [node("Start", "manualTrigger")] + [
        node(f"N{i}", "set" if i % 3 else "if", 3.4 if i % 3 else 2, i * 10) for i in range(n)]
    return wf(nodes, link(("Start", "N0"), *[(f"N{i}", f"N{i + 1}") for i in range(n - 1)]))


def test_an_if_heavy_chain_grows_about_quadratically(monkeypatch):
    # Counted, not timed, so a slow runner cannot fail it: grouping work is
    # union-find lookups. Doubling the chain must not multiply them by ~8
    # (cubic, 800 nodes took 5 s); quadratic is ~4.
    calls = {"n": 0}
    find = ni._UF.find

    def counted(self: Any, x: str) -> str:
        calls["n"] += 1
        return find(self, x)

    monkeypatch.setattr(ni._UF, "find", counted)
    counts = []
    for n in (400, 800):
        calls["n"] = 0
        ni.convert_n8n_workflow(_if_chain(n), imported_at=NOW)
        counts.append(calls["n"])
    assert counts[1] / counts[0] < 5.5, counts

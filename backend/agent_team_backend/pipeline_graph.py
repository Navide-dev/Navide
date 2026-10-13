"""Pipeline graph: nodes + edges keyed by id, the single source of truth for a
pipeline's shape once a pipeline has one.

Mirror of src/renderer/src/lib/pipelineGraph.ts — the two must agree on
layering, stage derivation, validation and edit ops. The graph subtree is
stored verbatim in camelCase (agentKey, roleKey, kickoffBody, isCommander,
maxLoops); stage slots stay snake_case, so this module converts at the
stage boundary only.

A pipeline without a graph is a legacy linear pipeline; nothing here is
applied to it unless a caller asks for its derived graph.
"""

from __future__ import annotations

import copy
from typing import Any

GRAPH_VERSION = 1
DEFAULT_MAX_LOOPS = 2
MAX_LOOPS_CEILING = 10
TRIGGER_NODE_ID = "trigger"
NODE_KINDS = ("trigger", "slot", "gate")
EDGE_KINDS = ("main", "reject")
_LAYER_DX = 280
_LANE_DY = 140

# Role declarative properties.
ROLE_PROPERTY_TYPES = ("string", "text", "template", "number", "boolean", "options")


class GraphError(ValueError):
    """Invalid graph or graph op; .errors lists every problem found."""

    def __init__(self, errors: list[str]) -> None:
        super().__init__("; ".join(errors) or "invalid graph")
        self.errors = errors


def slot_node_id(stage_id: str, slot_index: int) -> str:
    return f"n-{stage_id}-{slot_index}"


def edge_id(src: str, dst: str, kind: str = "main") -> str:
    return f"r-{src}-{dst}" if kind == "reject" else f"e-{src}-{dst}"


def _is_main(e: dict[str, Any]) -> bool:
    return (e.get("kind") or "main") == "main"


def _slot_to_graph(slot: dict[str, Any]) -> dict[str, Any]:
    out = {
        "agentKey": slot.get("agent_key", ""),
        "roleKey": slot.get("role_key", ""),
        "label": slot.get("label", ""),
        "kickoffBody": slot.get("kickoff_body", ""),
        "isCommander": bool(slot.get("is_commander", False)),
    }
    if isinstance(slot.get("params"), dict):
        out["params"] = copy.deepcopy(slot["params"])
    return out


def _slot_to_stage(slot: dict[str, Any]) -> dict[str, Any]:
    out = {
        "agent_key": slot.get("agentKey", ""),
        "role_key": slot.get("roleKey", ""),
        "label": slot.get("label", ""),
        "kickoff_body": slot.get("kickoffBody", ""),
        "is_commander": bool(slot.get("isCommander", False)),
    }
    if isinstance(slot.get("params"), dict):
        out["params"] = copy.deepcopy(slot["params"])
    return out


# set_stage_meta field (camelCase, as on the wire) → stage key (snake_case).
STAGE_META_FIELDS = {
    "title": "title",
    "shortTitle": "short_title",
    "question": "question",
    "description": "description",
    "sentinel": "sentinel",
    "allowQuestions": "allow_questions",
    "docQuery": "doc_query",
    "recommendedRoles": "recommended_roles",
}


def derive_graph_from_stages(stages: list[dict[str, Any]]) -> dict[str, Any]:
    """The graph a legacy linear pipeline implies (see the TS twin)."""
    nodes: list[dict[str, Any]] = [
        {"id": TRIGGER_NODE_ID, "kind": "trigger", "label": "Start", "position": {"x": 0, "y": 0}}
    ]
    edges: list[dict[str, Any]] = []
    prev = [TRIGGER_NODE_ID]
    for layer, stage in enumerate(stages):
        ids: list[str] = []
        for i, slot in enumerate(stage.get("slots") or []):
            nid = slot_node_id(str(stage.get("id", "")), i)
            nodes.append({
                "id": nid,
                "kind": "slot",
                "label": slot.get("label", ""),
                "position": {"x": (layer + 1) * _LAYER_DX, "y": i * _LANE_DY},
                "slot": _slot_to_graph(slot),
                "stageId": stage.get("id", ""),
            })
            ids.append(nid)
        for src in prev:
            for dst in ids:
                edges.append({"id": edge_id(src, dst), "from": src, "to": dst, "kind": "main"})
        if ids:
            prev = ids
    return {"version": GRAPH_VERSION, "nodes": nodes, "edges": edges}


def layer_graph(graph: dict[str, Any]) -> tuple[list[list[str]], list[str]]:
    """Longest-path layering over main edges → (layers, triggers)."""
    kind = {n["id"]: n.get("kind") for n in graph.get("nodes", [])}
    preds: dict[str, list[str]] = {nid: [] for nid in kind}
    for e in graph.get("edges", []):
        if _is_main(e) and e.get("from") in kind and e.get("to") in kind:
            preds[e["to"]].append(e["from"])
    depth: dict[str, float] = {}
    visiting: set[str] = set()

    def depth_of(nid: str) -> float:
        if nid in depth:
            return depth[nid]
        if nid in visiting:
            return float("nan")
        visiting.add(nid)
        if kind[nid] == "trigger":
            d: float = -1
        else:
            d = 0
            for p in preds[nid]:
                d = max(d, depth_of(p) + 1)
        visiting.discard(nid)
        depth[nid] = d
        return d

    layers: list[list[str]] = []
    triggers: list[str] = []
    for n in graph.get("nodes", []):
        d = depth_of(n["id"])
        if d != d:  # NaN: on a cycle
            continue
        if d < 0:
            triggers.append(n["id"])
            continue
        di = int(d)
        while len(layers) <= di:
            layers.append([])
        layers[di].append(n["id"])
    return [lay for lay in layers if lay], triggers


def _blank_stage(sid: str, layer: int) -> dict[str, Any]:
    return {
        "id": sid,
        "title": f"Layer {layer + 1}",
        "short_title": f"Layer {layer + 1}",
        "question": "",
        "description": "",
        "recommended_roles": [],
        "sentinel": "",
        "allow_questions": False,
        "doc_query": "",
        "slots": [],
    }


def derive_stages_from_graph(
    graph: dict[str, Any], previous: list[dict[str, Any]] | None = None, *, stamp: bool = False
) -> list[dict[str, Any]]:
    """One stage per layer holding its slot nodes (see the TS twin).

    stamp=True writes the chosen stage id onto the layer's slot nodes that
    have none (mutating `graph`), so a new layer keeps its L<n> id — and the
    metadata stored under it — the next time stages are derived."""
    by_id = {n["id"]: n for n in graph.get("nodes", [])}
    prev_by_id = {s.get("id"): s for s in (previous or [])}
    used: set[str] = set()
    out: list[dict[str, Any]] = []
    layers, _ = layer_graph(graph)
    for layer in layers:
        slot_nodes = [by_id[i] for i in layer if by_id[i].get("kind") == "slot" and by_id[i].get("slot")]
        if not slot_nodes:
            continue
        claim = next((n.get("stageId") for n in slot_nodes if n.get("stageId") and n.get("stageId") not in used), "")
        sid = claim or ""
        if not sid:
            k = len(out) + 1
            while f"L{k}" in used or f"L{k}" in prev_by_id:
                k += 1
            sid = f"L{k}"
        used.add(sid)
        if stamp:
            for n in slot_nodes:
                if not n.get("stageId"):
                    n["stageId"] = sid
        base = copy.deepcopy(prev_by_id.get(sid) or _blank_stage(sid, len(out)))
        base["id"] = sid
        base["slots"] = [_slot_to_stage(n["slot"]) for n in slot_nodes]
        out.append(base)
    return out


def is_linear_graph(graph: dict[str, Any]) -> bool:
    if any(n.get("kind") == "gate" for n in graph.get("nodes", [])):
        return False
    edges = graph.get("edges", [])
    if any(not _is_main(e) for e in edges):
        return False
    layers, triggers = layer_graph(graph)
    want: set[tuple[str, str]] = set()
    prev = triggers
    for layer in layers:
        for src in prev:
            for dst in layer:
                want.add((src, dst))
        prev = layer
    have = {(e.get("from"), e.get("to")) for e in edges}
    return len(have) == len(edges) and have == want


def _finite(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and v not in (float("inf"), float("-inf"))


def validate_graph(graph: Any) -> list[str]:
    if not isinstance(graph, dict) or not isinstance(graph.get("nodes"), list) or not isinstance(graph.get("edges"), list):
        return ["graph must have nodes[] and edges[]"]
    errors: list[str] = []
    nodes: dict[str, dict[str, Any]] = {}
    for n in graph["nodes"]:
        if not isinstance(n, dict) or not n.get("id"):
            errors.append("node without id")
            continue
        nid = str(n["id"])
        if nid in nodes:
            errors.append(f"duplicate node id {nid}")
        nodes[nid] = n
        k = n.get("kind")
        if k not in NODE_KINDS:
            errors.append(f"node {nid}: unknown kind {k}")
        slot = n.get("slot")
        if k == "slot" and (not isinstance(slot, dict) or not slot.get("agentKey") or not slot.get("label")):
            errors.append(f"slot node {nid} needs slot.agentKey and slot.label")
        if k != "slot" and slot is not None:
            errors.append(f"node {nid}: only slot nodes carry slot config")
        pos = n.get("position")
        if not isinstance(pos, dict) or not _finite(pos.get("x")) or not _finite(pos.get("y")):
            errors.append(f"node {nid} needs a numeric position")
    edge_ids: set[str] = set()
    pairs: set[tuple[str, str, str]] = set()
    succ: dict[str, list[str]] = {nid: [] for nid in nodes}
    rejects: list[dict[str, Any]] = []
    for e in graph["edges"]:
        if not isinstance(e, dict) or not e.get("id"):
            errors.append("edge without id")
            continue
        eid = str(e["id"])
        if eid in edge_ids:
            errors.append(f"duplicate edge id {eid}")
        edge_ids.add(eid)
        kind = e.get("kind") or "main"
        if kind not in EDGE_KINDS:
            errors.append(f"edge {eid}: unknown kind {kind}")
        src, dst = e.get("from"), e.get("to")
        if src not in nodes or dst not in nodes:
            errors.append(f"edge {eid} references a missing node")
            continue
        if src == dst:
            errors.append(f"edge {eid} is a self-loop")
        pair = (kind, src, dst)
        if pair in pairs:
            errors.append(f"duplicate edge {src} → {dst}")
        pairs.add(pair)
        if nodes[dst].get("kind") == "trigger":
            errors.append(f"edge {eid} points into a trigger")
        if kind == "main":
            succ[src].append(dst)
            if e.get("maxLoops") is not None:
                errors.append(f"edge {eid}: maxLoops is only for reject edges")
        else:
            if nodes[src].get("kind") == "trigger":
                errors.append(f"reject edge {eid} cannot start at a trigger")
            m = e.get("maxLoops", DEFAULT_MAX_LOOPS)
            if not isinstance(m, int) or isinstance(m, bool) or m < 1 or m > MAX_LOOPS_CEILING:
                errors.append(f"reject edge {eid}: maxLoops must be an integer 1..{MAX_LOOPS_CEILING}")
            rejects.append(e)
    # Main-edge cycle check.
    colour: dict[str, int] = {}
    cyclic = False
    for start in nodes:
        if colour.get(start):
            continue
        stack: list[list[Any]] = [[start, 0]]
        colour[start] = 1
        while stack and not cyclic:
            top = stack[-1]
            nxt_list = succ[top[0]]
            if top[1] >= len(nxt_list):
                colour[top[0]] = 2
                stack.pop()
                continue
            nxt = nxt_list[top[1]]
            top[1] += 1
            c = colour.get(nxt, 0)
            if c == 1:
                cyclic = True
            elif c == 0:
                colour[nxt] = 1
                stack.append([nxt, 0])
        if cyclic:
            break
    if cyclic:
        errors.append("main edges form a cycle; loops must use a reject edge")
    else:
        for e in rejects:
            if not _reaches(succ, e["to"], e["from"]):
                errors.append(f"reject edge {e['id']} must point to an upstream node of {e['from']}")
    return errors


def _reaches(succ: dict[str, list[str]], src: str, dst: str) -> bool:
    seen = {src}
    queue = [src]
    while queue:
        nid = queue.pop(0)
        if nid == dst:
            return True
        for n in succ.get(nid, []):
            if n not in seen:
                seen.add(n)
                queue.append(n)
    return False


def upstream_of(graph: dict[str, Any], nid: str) -> list[str]:
    return [e["from"] for e in graph.get("edges", []) if _is_main(e) and e.get("to") == nid]


def downstream_of(graph: dict[str, Any], nid: str) -> list[str]:
    return [e["to"] for e in graph.get("edges", []) if _is_main(e) and e.get("from") == nid]


def apply_graph_ops(graph: dict[str, Any], ops: list[dict[str, Any]]) -> dict[str, Any]:
    """Apply edit ops to a copy (see the TS twin). Raises GraphError."""
    g = {
        "version": graph.get("version", GRAPH_VERSION),
        "nodes": copy.deepcopy(graph.get("nodes", [])),
        "edges": copy.deepcopy(graph.get("edges", [])),
    }

    def node(nid: Any) -> dict[str, Any]:
        n = next((x for x in g["nodes"] if x.get("id") == nid), None)
        if n is None:
            raise GraphError([f"node not found: {nid}"])
        return n

    def add_edge(e: dict[str, Any]) -> None:
        if any(x.get("id") == e.get("id") for x in g["edges"]):
            raise GraphError([f"duplicate edge id {e.get('id')}"])
        g["edges"].append(e)

    def has_main(src: str, dst: str) -> bool:
        return any(_is_main(e) and e.get("from") == src and e.get("to") == dst for e in g["edges"])

    if not isinstance(ops, list):
        raise GraphError(["ops must be a list"])
    for op in ops:
        if not isinstance(op, dict):
            raise GraphError(["each op must be an object"])
        kind = op.get("op")
        if kind == "add_node":
            new = op.get("node")
            if not isinstance(new, dict) or not new.get("id"):
                raise GraphError(["add_node needs node.id"])
            if any(x.get("id") == new["id"] for x in g["nodes"]):
                raise GraphError([f"duplicate node id {new['id']}"])
            g["nodes"].append(copy.deepcopy(new))
            after = list(op.get("after") or [])
            before = list(op.get("before") or [])
            for a in after:
                node(a)
            for b in before:
                node(b)
            g["edges"] = [
                e for e in g["edges"]
                if not (_is_main(e) and e.get("from") in after and e.get("to") in before)
            ]
            for a in after:
                add_edge({"id": edge_id(a, new["id"]), "from": a, "to": new["id"], "kind": "main"})
            for b in before:
                add_edge({"id": edge_id(new["id"], b), "from": new["id"], "to": b, "kind": "main"})
        elif kind == "remove_node":
            nid = op.get("id")
            node(nid)
            ups = upstream_of(g, nid)
            downs = downstream_of(g, nid)
            g["nodes"] = [n for n in g["nodes"] if n.get("id") != nid]
            g["edges"] = [e for e in g["edges"] if e.get("from") != nid and e.get("to") != nid]
            if op.get("reconnect", True):
                for u in ups:
                    for d in downs:
                        if not has_main(u, d):
                            add_edge({"id": edge_id(u, d), "from": u, "to": d, "kind": "main"})
        elif kind == "update_node":
            n = node(op.get("id"))
            if op.get("label") is not None:
                n["label"] = op["label"]
            if op.get("slot"):
                if n.get("kind") != "slot":
                    raise GraphError([f"node {n['id']} is not a slot"])
                n["slot"] = {**(n.get("slot") or {}), **op["slot"]}
            if op.get("gate"):
                if n.get("kind") != "gate":
                    raise GraphError([f"node {n['id']} is not a gate"])
                n["gate"] = {**(n.get("gate") or {}), **op["gate"]}
        elif kind == "move_node":
            pos = op.get("position") or {}
            node(op.get("id"))["position"] = {"x": pos.get("x"), "y": pos.get("y")}
        elif kind == "add_edge":
            e = op.get("edge")
            if not isinstance(e, dict):
                raise GraphError(["add_edge needs edge"])
            node(e.get("from"))
            node(e.get("to"))
            e = dict(e)
            if not e.get("id"):
                e["id"] = edge_id(e["from"], e["to"], e.get("kind") or "main")
            add_edge(e)
        elif kind == "remove_edge":
            before_len = len(g["edges"])
            g["edges"] = [e for e in g["edges"] if e.get("id") != op.get("id")]
            if len(g["edges"]) == before_len:
                raise GraphError([f"edge not found: {op.get('id')}"])
        elif kind == "set_gate":
            n = node(op.get("id"))
            if n.get("kind") != "gate":
                raise GraphError([f"node {n['id']} is not a gate"])
            n["gate"] = {**(n.get("gate") or {}), "prompt": op.get("prompt")}
        elif kind == "set_pin":
            n = node(op.get("id"))
            if n.get("kind") != "slot":
                raise GraphError([f"only slot nodes can be pinned: {n['id']}"])
            if op.get("pinned"):
                n["pinned"] = True
            else:
                n.pop("pinned", None)
        elif kind == "set_stage_meta":
            # Stage metadata is not part of the graph; StagesStore applies it.
            pass
        else:
            raise GraphError([f"unknown graph op: {kind}"])
    return g


def validate_role_properties(props: Any) -> list[dict[str, Any]]:
    """Normalise a role's optional declarative `properties`. Raises ValueError."""
    if not isinstance(props, list):
        raise ValueError("properties must be a list")
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for p in props:
        if not isinstance(p, dict):
            raise ValueError("each property must be an object")
        name = str(p.get("name") or "").strip()
        if not name:
            raise ValueError("property name is required")
        if name in seen:
            raise ValueError(f"duplicate property name: {name}")
        seen.add(name)
        ptype = p.get("type")
        if ptype not in ROLE_PROPERTY_TYPES:
            raise ValueError(f"property {name}: type must be one of {', '.join(ROLE_PROPERTY_TYPES)}")
        if ptype == "options" and not isinstance(p.get("options"), list):
            raise ValueError(f"property {name}: options type needs an options list")
        disp = p.get("displayOptions")
        if disp is not None:
            if not isinstance(disp, dict) or set(disp) - {"show", "hide"}:
                raise ValueError(f"property {name}: displayOptions takes only show/hide")
            for cond in disp.values():
                if not isinstance(cond, dict) or not all(isinstance(v, list) for v in cond.values()):
                    raise ValueError(f"property {name}: show/hide map a field name to a list of values")
        out.append(copy.deepcopy(p))
    return out

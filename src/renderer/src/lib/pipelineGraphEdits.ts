// Editor-side translation of the two views' gestures into graph ops.
//
// The graph contract (pipelineGraph.ts) only knows nodes and edges. The
// swimlane view speaks in layers — "drop this card into column 2", "insert a
// column between 1 and 2", "swap columns" — so this module turns each gesture
// into the GraphOp list that means the same thing on the graph (plan §6.2).
// Every function is pure: it reads a graph and returns ops; the editor applies
// them as one undoable command.
import dagre from '@dagrejs/dagre'
import {
  applyGraphOps,
  edgeId,
  isLinearGraph,
  layerGraph,
  type GraphEdge,
  type GraphNode,
  type GraphOp,
  type GraphPosition,
  type PipelineGraph,
} from './pipelineGraph'

/** Rendered size of each node kind on the canvas; dagre lays out boxes. */
export const NODE_SIZE: Record<GraphNode['kind'], { w: number; h: number }> = {
  trigger: { w: 168, h: 56 },
  slot: { w: 232, h: 76 },
  gate: { w: 196, h: 68 },
}

const LAYER_DX = 300
const LANE_DY = 120

const isMain = (e: GraphEdge): boolean => (e.kind ?? 'main') === 'main'

/** A node id no node in `graph` uses yet. */
export function freshNodeId(graph: PipelineGraph, prefix = 'n'): string {
  const taken = new Set(graph.nodes.map((n) => n.id))
  for (;;) {
    const id = `${prefix}-${Math.random().toString(36).slice(2, 8)}`
    if (!taken.has(id)) return id
  }
}

/** Slot labels double as a slot's identity in the legacy stage machinery
 *  (`slot:<label>`, `to: <label>`), so a new node never reuses one. */
export function uniqueLabel(graph: PipelineGraph, wanted: string): string {
  const taken = new Set(graph.nodes.map((n) => n.slot?.label ?? n.label ?? ''))
  const base = wanted.trim() || 'Step'
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`)) return `${base} ${i}`
}

/** Layer index of every non-trigger node (-1 for triggers). */
export function layerIndex(graph: PipelineGraph): Map<string, number> {
  const { layers, triggers } = layerGraph(graph)
  const out = new Map<string, number>()
  triggers.forEach((id) => out.set(id, -1))
  layers.forEach((layer, i) => layer.forEach((id) => out.set(id, i)))
  return out
}

/** Where a node dropped into layer `layer` should sit before any re-layout. */
function positionFor(graph: PipelineGraph, layer: number): GraphPosition {
  const { layers } = layerGraph(graph)
  const count = layers[layer]?.length ?? 0
  return { x: (layer + 1) * LAYER_DX, y: count * LANE_DY }
}

/** Drop `node` into existing layer `layer` as a parallel step: upstream is
 *  every node of the layer before (or the triggers), downstream every node of
 *  the layer after. Edges are added one by one — `add_node`'s after/before
 *  form would also delete any edge already joining those two layers. */
export function opsAddToLayer(graph: PipelineGraph, layer: number, node: GraphNode): GraphOp[] {
  const { layers, triggers } = layerGraph(graph)
  const ups = layer === 0 ? triggers : (layers[layer - 1] ?? [])
  const downs = layers[layer + 1] ?? []
  const placed = { ...node, position: positionFor(graph, layer) }
  return [
    { op: 'add_node', node: placed },
    ...ups.map((from): GraphOp => ({ op: 'add_edge', edge: { id: edgeId(from, node.id), from, to: node.id, kind: 'main' } })),
    ...downs.map((to): GraphOp => ({ op: 'add_edge', edge: { id: edgeId(node.id, to), from: node.id, to, kind: 'main' } })),
  ]
}

/** Insert a new layer holding `node` in front of layer `at` (`at` ===
 *  layers.length appends). Every edge from the layer before to the layer at
 *  `at` is replaced by a path through the new node — the swimlane "+ Stage". */
export function opsInsertLayer(graph: PipelineGraph, at: number, node: GraphNode): GraphOp[] {
  const { layers, triggers } = layerGraph(graph)
  const after = at === 0 ? triggers : (layers[at - 1] ?? [])
  const before = layers[at] ?? []
  return [{ op: 'add_node', node: { ...node, position: { x: (at + 1) * LAYER_DX, y: 0 } }, after, before }]
}

/** Insert `node` on edge `edge` (the canvas "+" on a connection). */
export function opsInsertOnEdge(edge: GraphEdge, node: GraphNode): GraphOp[] {
  return [{ op: 'add_node', node, after: [edge.from], before: [edge.to] }]
}

/** Move a node to another layer, as parallel (`into`) or as a new layer in
 *  front of `target` (`newLayer`). It is a remove (upstream re-wired to
 *  downstream, so nothing is orphaned) followed by a re-add; layer numbers are
 *  read from the graph AFTER the removal, so a layer that empties out does
 *  not shift the target. */
export function opsMoveToLayer(
  graph: PipelineGraph,
  id: string,
  target: number,
  mode: 'into' | 'newLayer'
): GraphOp[] {
  const node = graph.nodes.find((n) => n.id === id)
  if (!node) return []
  const before = layerIndex(graph)
  const from = before.get(id) ?? 0
  const remove: GraphOp = { op: 'remove_node', id, reconnect: true }
  const without = applyGraphOps(graph, [remove])
  const emptied = !layerGraph(graph).layers[from]?.some((x) => x !== id)
  const shifted = emptied && from < target ? target - 1 : target
  const moved: GraphNode = { ...node }
  const add = mode === 'into'
    ? opsAddToLayer(without, shifted, moved)
    : opsInsertLayer(without, shifted, moved)
  // Re-adding with the same id must not collide with the edges the removal's
  // reconnect created (they join other nodes), so the id is safe to reuse.
  return [remove, ...add]
}

/** Swap layer `a` with layer `b` in a LINEAR graph by re-wiring the chain.
 *  Refuses (returns null) for a graph with gates, loops or partial wiring:
 *  there the column order is not a free choice, the edges are. */
export function opsReorderLayers(graph: PipelineGraph, a: number, b: number): GraphOp[] | null {
  if (!isLinearGraph(graph)) return null
  const { layers, triggers } = layerGraph(graph)
  if (a < 0 || b < 0 || a >= layers.length || b >= layers.length || a === b) return null
  const order = layers.slice()
  ;[order[a], order[b]] = [order[b], order[a]]
  const ops: GraphOp[] = graph.edges.filter(isMain).map((e) => ({ op: 'remove_edge', id: e.id }))
  let prev = triggers
  order.forEach((layer, i) => {
    for (const from of prev) for (const to of layer) {
      ops.push({ op: 'add_edge', edge: { id: edgeId(from, to), from, to, kind: 'main' } })
    }
    for (const [j, id] of layer.entries()) {
      ops.push({ op: 'move_node', id, position: { x: (i + 1) * LAYER_DX, y: j * LANE_DY } })
    }
    prev = layer
  })
  return ops
}

/** Whether a layer may be dragged left/right in the swimlane (plan §6.2: only
 *  when the graph has no branch/loop; otherwise the user is sent to the
 *  canvas, where order is expressed by edges). */
export function canReorderLayers(graph: PipelineGraph): boolean {
  return isLinearGraph(graph)
}

/** dagre layout, left to right. Only main edges rank nodes — a reject loop
 *  points backwards and would otherwise pull its target forward. Returns the
 *  move ops for nodes whose position actually changes. */
export function opsAutoLayout(graph: PipelineGraph): GraphOp[] {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'LR', nodesep: 32, ranksep: 80, marginx: 0, marginy: 0 })
  g.setDefaultEdgeLabel(() => ({}))
  for (const n of graph.nodes) {
    const size = NODE_SIZE[n.kind] ?? NODE_SIZE.slot
    g.setNode(n.id, { width: size.w, height: size.h })
  }
  for (const e of graph.edges) if (isMain(e)) g.setEdge(e.from, e.to)
  dagre.layout(g)
  const ops: GraphOp[] = []
  for (const n of graph.nodes) {
    const laid = g.node(n.id) as { x: number; y: number } | undefined
    if (!laid) continue
    const size = NODE_SIZE[n.kind] ?? NODE_SIZE.slot
    // dagre reports centres; Vue Flow positions are top-left corners.
    const x = Math.round(laid.x - size.w / 2)
    const y = Math.round(laid.y - size.h / 2)
    if (x !== Math.round(n.position.x) || y !== Math.round(n.position.y)) {
      ops.push({ op: 'move_node', id: n.id, position: { x, y } })
    }
  }
  return ops
}

// ── Swimlane badges: what the columns cannot draw ────────────────────────────

export interface LaneBadge {
  kind: 'reject' | 'skip'
  /** Edge to focus on the canvas when the badge is clicked. */
  edgeId: string
  /** Target layer (1-based for display) for reject/skip; undefined otherwise. */
  targetLayer?: number
  maxLoops?: number
}

/** Badges per node: reject loops leaving it (↺ back to layer N — for a gate
 *  that is also its pass/reject fork) and main edges that jump over a layer
 *  (⤳). These are
 *  the edges the column layout cannot express, so the swimlane marks them and
 *  hands the user to the canvas. */
export function laneBadges(graph: PipelineGraph): Map<string, LaneBadge[]> {
  const layer = layerIndex(graph)
  const out = new Map<string, LaneBadge[]>()
  const push = (id: string, b: LaneBadge): void => {
    const list = out.get(id) ?? []
    list.push(b)
    out.set(id, list)
  }
  for (const e of graph.edges) {
    const from = layer.get(e.from)
    const to = layer.get(e.to)
    if (from === undefined || to === undefined) continue
    if (!isMain(e)) {
      push(e.from, { kind: 'reject', edgeId: e.id, targetLayer: to + 1, maxLoops: e.maxLoops })
    } else if (from >= 0 && to - from > 1) {
      push(e.from, { kind: 'skip', edgeId: e.id, targetLayer: to + 1 })
    }
  }
  return out
}

// ── Placement: where a new node lands on the canvas ──────────────────────────

const GAP_X = 80 // = dagre ranksep, so placed and tidied nodes share columns
const GAP_Y = 32

/** Position a just-added node next to its neighbours, n8n-style: right of its
 *  upstream (or left of its downstream), below any sibling that shares its
 *  upstream; then push everything downstream of it right when it would
 *  overlap. Hand-arranged nodes elsewhere are left alone — a full re-layout
 *  is the explicit "Tidy up" command, never a side effect. */
export function opsPlaceNode(graph: PipelineGraph, id: string): GraphOp[] {
  const node = graph.nodes.find((n) => n.id === id)
  if (!node) return []
  const at = new Map(graph.nodes.map((n) => [n.id, n]))
  const size = NODE_SIZE[node.kind]
  const mainEdges = graph.edges.filter(isMain)
  const ups = mainEdges.filter((e) => e.to === id).map((e) => at.get(e.from)!).filter(Boolean)
  const downs = mainEdges.filter((e) => e.from === id).map((e) => at.get(e.to)!).filter(Boolean)
  const others = graph.nodes.filter((n) => n.id !== id)

  let x: number
  let y: number
  if (ups.length) {
    x = Math.max(...ups.map((u) => u.position.x + NODE_SIZE[u.kind].w)) + GAP_X
    y = ups.reduce((s, u) => s + u.position.y, 0) / ups.length
  } else if (downs.length) {
    x = Math.min(...downs.map((d) => d.position.x)) - size.w - GAP_X
    y = downs.reduce((s, d) => s + d.position.y, 0) / downs.length
  } else {
    x = others.length ? Math.max(...others.map((n) => n.position.x + NODE_SIZE[n.kind].w)) + GAP_X : 0
    y = 0
  }
  // Stack under siblings fed by the same upstream.
  const upIds = new Set(ups.map((u) => u.id))
  const siblings = others.filter((n) =>
    upIds.size > 0 && mainEdges.some((e) => e.to === n.id && upIds.has(e.from)) && Math.abs(n.position.x - x) < size.w
  )
  if (siblings.length) {
    x = Math.min(...siblings.map((s) => s.position.x))
    y = Math.max(...siblings.map((s) => s.position.y + NODE_SIZE[s.kind].h)) + GAP_Y
  }
  x = Math.round(x)
  y = Math.round(y)

  const ops: GraphOp[] = [{ op: 'move_node', id, position: { x, y } }]
  const overlaps = (n: GraphNode): boolean => {
    const s = NODE_SIZE[n.kind]
    return n.position.x < x + size.w && n.position.x + s.w > x && n.position.y < y + size.h && n.position.y + s.h > y
  }
  if (others.some(overlaps)) {
    // Make room: everything reachable downstream of the new node, at or right
    // of its column, slides one column right.
    const reach = new Set<string>()
    const queue = [id]
    while (queue.length) {
      const cur = queue.shift()!
      for (const e of mainEdges) if (e.from === cur && !reach.has(e.to)) { reach.add(e.to); queue.push(e.to) }
    }
    const shift = size.w + GAP_X
    for (const n of others) {
      if (reach.has(n.id) && n.position.x >= x - size.w / 2) {
        ops.push({ op: 'move_node', id: n.id, position: { x: n.position.x + shift, y: n.position.y } })
      }
    }
  }
  return ops
}

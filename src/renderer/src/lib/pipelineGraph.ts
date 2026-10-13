/**
 * Pipeline graph contract: one graph (nodes + edges keyed by id) is the single
 * source of truth for a pipeline's shape. The swimlane view and the free
 * canvas view both render it; `stages` are DERIVED from it by longest-path
 * layering so every legacy reader (engine blueprint, MCP stage tools, Roles
 * usage scans) keeps working.
 *
 * Persisted shape (app-data navide.db, kv "pipelines", per pipeline):
 *   { id, name, builtin, stages: [...unchanged...], graph?: PipelineGraph }
 * `graph` is optional: a pipeline without one is a legacy linear pipeline and
 * behaves exactly as before; `deriveGraphFromStages` shows it on the canvas.
 * The graph subtree is stored verbatim in the camelCase shape below (it is a
 * new subtree, so it does not follow the snake_case stage payload). The
 * backend mirror is backend/agent_team_backend/pipeline_graph.py — keep the
 * two in step.
 *
 * WS contract (backend handlers in ws_handlers.py):
 *   pipelines.graph.get   {pipeline_id}
 *     → {pipeline_id, graph, derived, stages}
 *       derived=true when the pipeline has no stored graph and `graph` was
 *       synthesised from its stages (nothing is written).
 *   pipelines.graph.set   {pipeline_id, graph, workspace_path?}
 *     → {pipeline_id, graph, stages}
 *   pipelines.graph.apply {pipeline_id, ops: GraphOp[], workspace_path?}
 *     → {pipeline_id, graph, stages}   (all ops or none)
 *   Errors: PIPELINE_RUNNING (the pipeline is the one a run in
 *   workspace_path is using), GRAPH_INVALID (error.details.errors: string[]).
 *   Broadcasts after a write: `pipeline.graph_changed` {pipeline_id, graph,
 *   stages, reason}, then the usual `stages.changed` and `pipelines.changed`.
 *
 *   pipeline.node_states  {workspace_path, nodes: Record<id, NodeRunState>}
 *     renderer → backend: the engine reports per-node run state; stored on
 *     the project (additive field) so MCP pipeline_status can read it.
 *     Broadcast: `pipeline.node_states_changed` {workspace_path, nodes, gate}.
 *
 *   Run control lives in the renderer engine and is reachable as UI commands
 *   (MCP goes through ui.invoke, like ui.pipeline.next):
 *     ui.pipeline.gate_pass  {nodeId}
 *     ui.pipeline.gate_reject   {nodeId, comment?}
 *     ui.pipeline.restart_from  {nodeId, task?}
 *   Pinning is a graph edit: op `set_pin` (persisted on the node).
 */
import type { Stage, StageSlot } from '../data/stages'

export const GRAPH_VERSION = 1
/** Default and ceiling for a reject edge's loop budget. */
export const DEFAULT_MAX_LOOPS = 2
export const MAX_LOOPS_CEILING = 10

export interface GraphPosition {
  x: number
  y: number
}

export type GraphNodeKind = 'trigger' | 'slot' | 'gate'

/** A slot node's agent configuration — the same fields a stage slot has. */
export type SlotConfig = StageSlot

export interface GateConfig {
  /** Shown to the approver ("check both implementations before review"). */
  prompt?: string
}

export interface GraphNode {
  id: string
  kind: GraphNodeKind
  label?: string
  position: GraphPosition
  /** Required for kind 'slot', absent otherwise. */
  slot?: SlotConfig
  /** Optional for kind 'gate'. */
  gate?: GateConfig
  /** The stage this node came from; used to keep stage metadata (title,
   *  sentinel, question, …) when stages are re-derived from layers. */
  stageId?: string
  /** Frozen output: reruns skip this node and reuse its last result. */
  pinned?: boolean
}

export type GraphEdgeKind = 'main' | 'reject'

export interface GraphEdge {
  id: string
  from: string
  to: string
  /** 'main' (default) is forward flow. 'reject' is a bounded loop back to an
   *  upstream node, taken when a gate is rejected (or a slot reports reject). */
  kind?: GraphEdgeKind
  /** Reject edges only: how many times the loop may be taken in one run.
   *  Defaults to DEFAULT_MAX_LOOPS; 1..MAX_LOOPS_CEILING. */
  maxLoops?: number
}

export interface PipelineGraph {
  version: number
  nodes: GraphNode[]
  edges: GraphEdge[]
}

// ── Edit operations (shared by WS pipelines.graph.apply and MCP pipeline_graph)
export type GraphOp =
  | { op: 'add_node'; node: GraphNode; after?: string[]; before?: string[] }
  | { op: 'remove_node'; id: string; reconnect?: boolean }
  | { op: 'update_node'; id: string; label?: string; slot?: Partial<SlotConfig>; gate?: GateConfig }
  | { op: 'move_node'; id: string; position: GraphPosition }
  | { op: 'add_edge'; edge: GraphEdge }
  | { op: 'remove_edge'; id: string }
  | { op: 'set_gate'; id: string; prompt?: string }
  | { op: 'set_pin'; id: string; pinned: boolean }
  | ({ op: 'set_stage_meta'; stageId: string } & StageMetaPatch)

/** Layer (stage) metadata editable through set_stage_meta. The graph does not
 *  store it: it lives on the derived stage and is kept across re-derivation
 *  via the slot nodes' stageId, so applyGraphOps treats the op as a no-op and
 *  the backend writes it onto the stage. */
export type StageMetaPatch = Partial<
  Pick<Stage, 'title' | 'shortTitle' | 'question' | 'description' | 'sentinel' | 'allowQuestions' | 'docQuery' | 'recommendedRoles'>
>

// ── Run state (per node) ─────────────────────────────────────────────────────
export type NodeRunStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'awaiting' // gate waiting for approve/reject
  | 'rejected'
  | 'failed'
  | 'skipped' // pinned node reused its frozen output this run
  | 'aborted'

export interface NodeRunState {
  status: NodeRunStatus
  startedAt?: string
  endedAt?: string
  tokens?: number
  paneId?: string
  /** How many times this node has started in the current run. */
  attempts?: number
  pinned?: boolean
  /** Last assistant reply summary, for {{prev.summary}} and pinned reuse. */
  summary?: string
}

// ── Role properties (declarative node settings form) ─────────────────────────
export type RolePropertyType = 'string' | 'text' | 'template' | 'number' | 'boolean' | 'options'

export interface RolePropertyOption {
  value: string | number | boolean
  label?: string
}

/** Field `name` → allowed values of that field. */
export type DisplayCondition = Record<string, Array<string | number | boolean>>

export interface RoleProperty {
  name: string
  type: RolePropertyType
  label?: string
  description?: string
  default?: string | number | boolean
  options?: RolePropertyOption[]
  required?: boolean
  displayOptions?: { show?: DisplayCondition; hide?: DisplayCondition }
}

/** True when `prop` should be shown given the node's current values. Every
 *  `show` field must match one of its listed values; any matching `hide`
 *  field hides it. A missing value falls back to that field's default. */
export function isPropertyVisible(
  prop: RoleProperty,
  values: Record<string, unknown>,
  all: readonly RoleProperty[] = []
): boolean {
  const valueOf = (name: string): unknown =>
    name in values ? values[name] : all.find((p) => p.name === name)?.default
  const show = prop.displayOptions?.show
  if (show) {
    for (const [field, allowed] of Object.entries(show)) {
      if (!allowed.includes(valueOf(field) as never)) return false
    }
  }
  const hide = prop.displayOptions?.hide
  if (hide) {
    for (const [field, blocked] of Object.entries(hide)) {
      if (blocked.includes(valueOf(field) as never)) return false
    }
  }
  return true
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const LAYER_DX = 280
const LANE_DY = 140

export const TRIGGER_NODE_ID = 'trigger'

export function slotNodeId(stageId: string, slotIndex: number): string {
  return `n-${stageId}-${slotIndex}`
}

export function edgeId(from: string, to: string, kind: GraphEdgeKind = 'main'): string {
  return kind === 'reject' ? `r-${from}-${to}` : `e-${from}-${to}`
}

function isMain(e: GraphEdge): boolean {
  return (e.kind ?? 'main') === 'main'
}

/** The graph a legacy linear pipeline implies: a trigger, one node per slot,
 *  and every slot of stage i wired to every slot of stage i+1. */
export function deriveGraphFromStages(stages: readonly Stage[]): PipelineGraph {
  const nodes: GraphNode[] = [
    { id: TRIGGER_NODE_ID, kind: 'trigger', label: 'Start', position: { x: 0, y: 0 } },
  ]
  const edges: GraphEdge[] = []
  let prev: string[] = [TRIGGER_NODE_ID]
  stages.forEach((stage, layer) => {
    const ids = stage.slots.map((slot, i) => {
      const id = slotNodeId(stage.id, i)
      nodes.push({
        id,
        kind: 'slot',
        label: slot.label,
        position: { x: (layer + 1) * LAYER_DX, y: i * LANE_DY },
        slot: { ...slot },
        stageId: stage.id,
      })
      return id
    })
    for (const from of prev) for (const to of ids) edges.push({ id: edgeId(from, to), from, to, kind: 'main' })
    if (ids.length) prev = ids
  })
  return { version: GRAPH_VERSION, nodes, edges }
}

export interface GraphLayers {
  /** Node ids per layer (longest-path depth), trigger nodes excluded. Within
   *  a layer, ids keep the graph's node order. */
  layers: string[][]
  triggers: string[]
}

/** Longest-path layering over main edges. Triggers are depth -1 and are
 *  reported separately, so layer 0 is the first real step (= legacy stage 0).
 *  Assumes the main edges are acyclic (see validateGraph); nodes on a cycle
 *  are dropped rather than looping. */
export function layerGraph(graph: PipelineGraph): GraphLayers {
  const kind = new Map(graph.nodes.map((n) => [n.id, n.kind]))
  const preds = new Map<string, string[]>()
  for (const n of graph.nodes) preds.set(n.id, [])
  for (const e of graph.edges) {
    if (!isMain(e) || !kind.has(e.from) || !kind.has(e.to)) continue
    preds.get(e.to)!.push(e.from)
  }
  const depth = new Map<string, number>()
  const visiting = new Set<string>()
  const depthOf = (id: string): number => {
    const known = depth.get(id)
    if (known !== undefined) return known
    if (visiting.has(id)) return Number.NaN
    visiting.add(id)
    let d: number
    if (kind.get(id) === 'trigger') d = -1
    else {
      d = 0
      for (const p of preds.get(id)!) d = Math.max(d, depthOf(p) + 1)
    }
    visiting.delete(id)
    depth.set(id, d)
    return d
  }
  const layers: string[][] = []
  const triggers: string[] = []
  for (const n of graph.nodes) {
    const d = depthOf(n.id)
    if (Number.isNaN(d)) continue
    if (d < 0) {
      triggers.push(n.id)
      continue
    }
    while (layers.length <= d) layers.push([])
    layers[d].push(n.id)
  }
  return { layers: layers.filter((l) => l.length > 0), triggers }
}

function blankStage(id: string, layer: number): Stage {
  return {
    id,
    title: `Layer ${layer + 1}`,
    shortTitle: `Layer ${layer + 1}`,
    question: '',
    description: '',
    recommendedRoles: [],
    sentinel: '',
    allowQuestions: false,
    docQuery: '',
    slots: [],
  }
}

/** Stages implied by the graph's layers: one stage per layer holding that
 *  layer's slot nodes. Stage metadata comes from `previous` via the nodes'
 *  `stageId` (first claim wins; a layer with no claimable id gets `L<n>`).
 *  Layers with no slot node (gate-only) produce no stage — a stage must have
 *  a slot; the engine reads gates from the graph itself. On write the backend
 *  also stamps the chosen id onto slot nodes without a stageId, so a new
 *  layer keeps its L<n> id (and its metadata); the stored graph it returns
 *  carries those stamps. */
export function deriveStagesFromGraph(graph: PipelineGraph, previous: readonly Stage[] = []): Stage[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const prevById = new Map(previous.map((s) => [s.id, s]))
  const used = new Set<string>()
  const out: Stage[] = []
  layerGraph(graph).layers.forEach((layer) => {
    const slotNodes = layer.map((id) => byId.get(id)!).filter((n) => n.kind === 'slot' && n.slot)
    if (!slotNodes.length) return
    const claim = slotNodes.map((n) => n.stageId).find((sid) => !!sid && !used.has(sid))
    let id = claim ?? ''
    if (!id) {
      let k = out.length + 1
      while (used.has(`L${k}`) || prevById.has(`L${k}`)) k++
      id = `L${k}`
    }
    used.add(id)
    const base = prevById.get(id) ?? blankStage(id, out.length)
    out.push({ ...base, id, slots: slotNodes.map((n) => ({ ...n.slot! })) })
  })
  return out
}

/** True when the graph has exactly the topology deriveGraphFromStages would
 *  give its derived stages: no gates, no reject edges, and every node of each
 *  layer wired to every node of the next. Such a graph can be edited through
 *  the legacy stage tools without losing anything. */
export function isLinearGraph(graph: PipelineGraph): boolean {
  if (graph.nodes.some((n) => n.kind === 'gate')) return false
  if (graph.edges.some((e) => !isMain(e))) return false
  const { layers, triggers } = layerGraph(graph)
  const want = new Set<string>()
  let prev = triggers
  for (const layer of layers) {
    for (const from of prev) for (const to of layer) want.add(`${from}\u0000${to}`)
    prev = layer
  }
  const have = new Set(graph.edges.map((e) => `${e.from}\u0000${e.to}`))
  if (have.size !== graph.edges.length || have.size !== want.size) return false
  for (const k of want) if (!have.has(k)) return false
  return true
}

/** Structural problems, empty when the graph is valid. Main edges must form
 *  a DAG; the only cycles allowed are reject edges, which must point to an
 *  upstream node of their source and carry a bounded loop count. */
export function validateGraph(graph: PipelineGraph): string[] {
  const errors: string[] = []
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    return ['graph must have nodes[] and edges[]']
  }
  const nodes = new Map<string, GraphNode>()
  for (const n of graph.nodes) {
    if (!n?.id) { errors.push('node without id'); continue }
    if (nodes.has(n.id)) errors.push(`duplicate node id ${n.id}`)
    nodes.set(n.id, n)
    if (!['trigger', 'slot', 'gate'].includes(n.kind)) errors.push(`node ${n.id}: unknown kind ${String(n.kind)}`)
    if (n.kind === 'slot' && (!n.slot || !n.slot.agentKey || !n.slot.label)) {
      errors.push(`slot node ${n.id} needs slot.agentKey and slot.label`)
    }
    if (n.kind !== 'slot' && n.slot) errors.push(`node ${n.id}: only slot nodes carry slot config`)
    if (!n.position || !Number.isFinite(n.position.x) || !Number.isFinite(n.position.y)) {
      errors.push(`node ${n.id} needs a numeric position`)
    }
  }
  const edgeIds = new Set<string>()
  const pairs = new Set<string>()
  const succ = new Map<string, string[]>()
  for (const id of nodes.keys()) succ.set(id, [])
  for (const e of graph.edges) {
    if (!e?.id) { errors.push('edge without id'); continue }
    if (edgeIds.has(e.id)) errors.push(`duplicate edge id ${e.id}`)
    edgeIds.add(e.id)
    const kind = e.kind ?? 'main'
    if (kind !== 'main' && kind !== 'reject') errors.push(`edge ${e.id}: unknown kind ${String(kind)}`)
    if (!nodes.has(e.from) || !nodes.has(e.to)) { errors.push(`edge ${e.id} references a missing node`); continue }
    if (e.from === e.to) errors.push(`edge ${e.id} is a self-loop`)
    const pair = `${kind}\u0000${e.from}\u0000${e.to}`
    if (pairs.has(pair)) errors.push(`duplicate edge ${e.from} → ${e.to}`)
    pairs.add(pair)
    if (nodes.get(e.to)!.kind === 'trigger') errors.push(`edge ${e.id} points into a trigger`)
    if (kind === 'main') succ.get(e.from)!.push(e.to)
    else {
      if (nodes.get(e.from)!.kind === 'trigger') errors.push(`reject edge ${e.id} cannot start at a trigger`)
      const m = e.maxLoops ?? DEFAULT_MAX_LOOPS
      if (!Number.isInteger(m) || m < 1 || m > MAX_LOOPS_CEILING) {
        errors.push(`reject edge ${e.id}: maxLoops must be an integer 1..${MAX_LOOPS_CEILING}`)
      }
    }
    if (kind === 'main' && e.maxLoops !== undefined) errors.push(`edge ${e.id}: maxLoops is only for reject edges`)
  }
  // Main-edge cycle check (iterative DFS, colour marking).
  const colour = new Map<string, 0 | 1 | 2>()
  let cyclic = false
  for (const start of nodes.keys()) {
    if (colour.get(start)) continue
    const stack: Array<[string, number]> = [[start, 0]]
    colour.set(start, 1)
    while (stack.length && !cyclic) {
      const top = stack[stack.length - 1]
      const next = succ.get(top[0])![top[1]++]
      if (next === undefined) { colour.set(top[0], 2); stack.pop(); continue }
      const c = colour.get(next) ?? 0
      if (c === 1) cyclic = true
      else if (c === 0) { colour.set(next, 1); stack.push([next, 0]) }
    }
    if (cyclic) break
  }
  if (cyclic) errors.push('main edges form a cycle; loops must use a reject edge')
  else {
    for (const e of graph.edges) {
      if ((e.kind ?? 'main') !== 'reject' || !nodes.has(e.from) || !nodes.has(e.to)) continue
      if (!reaches(succ, e.to, e.from)) errors.push(`reject edge ${e.id} must point to an upstream node of ${e.from}`)
    }
  }
  return errors
}

function reaches(succ: Map<string, string[]>, from: string, to: string): boolean {
  const seen = new Set<string>([from])
  const queue = [from]
  while (queue.length) {
    const id = queue.shift()!
    if (id === to) return true
    for (const n of succ.get(id) ?? []) if (!seen.has(n)) { seen.add(n); queue.push(n) }
  }
  return false
}

/** Main-edge upstream / downstream ids of a node. */
export function upstreamOf(graph: PipelineGraph, id: string): string[] {
  return graph.edges.filter((e) => isMain(e) && e.to === id).map((e) => e.from)
}
export function downstreamOf(graph: PipelineGraph, id: string): string[] {
  return graph.edges.filter((e) => isMain(e) && e.from === id).map((e) => e.to)
}

/** Apply edit ops to a copy of `graph`. Throws on an op that names a missing
 *  node/edge or a duplicate id; the result is NOT validated (call
 *  validateGraph). The backend applies the same ops with the same meaning.
 *  - add_node: `after` ids gain an edge into the node, `before` ids an edge
 *    out of it; an existing main edge after→before is replaced (insert on edge).
 *  - remove_node: drops the node and every edge touching it; with
 *    reconnect (default true) each main upstream is wired to each main
 *    downstream so the flow stays connected. */
export function applyGraphOps(graph: PipelineGraph, ops: readonly GraphOp[]): PipelineGraph {
  const g: PipelineGraph = structuredClone({ version: graph.version ?? GRAPH_VERSION, nodes: graph.nodes, edges: graph.edges })
  const node = (id: string): GraphNode => {
    const n = g.nodes.find((x) => x.id === id)
    if (!n) throw new Error(`node not found: ${id}`)
    return n
  }
  const addEdge = (e: GraphEdge): void => {
    if (g.edges.some((x) => x.id === e.id)) throw new Error(`duplicate edge id ${e.id}`)
    g.edges.push(e)
  }
  const hasMain = (from: string, to: string): boolean =>
    g.edges.some((e) => isMain(e) && e.from === from && e.to === to)
  for (const op of ops) {
    switch (op.op) {
      case 'add_node': {
        if (g.nodes.some((x) => x.id === op.node.id)) throw new Error(`duplicate node id ${op.node.id}`)
        g.nodes.push(structuredClone(op.node))
        const after = op.after ?? []
        const before = op.before ?? []
        for (const a of after) node(a)
        for (const b of before) node(b)
        g.edges = g.edges.filter((e) => !(isMain(e) && after.includes(e.from) && before.includes(e.to)))
        for (const a of after) addEdge({ id: edgeId(a, op.node.id), from: a, to: op.node.id, kind: 'main' })
        for (const b of before) addEdge({ id: edgeId(op.node.id, b), from: op.node.id, to: b, kind: 'main' })
        break
      }
      case 'remove_node': {
        node(op.id)
        const ups = upstreamOf(g, op.id)
        const downs = downstreamOf(g, op.id)
        g.nodes = g.nodes.filter((n) => n.id !== op.id)
        g.edges = g.edges.filter((e) => e.from !== op.id && e.to !== op.id)
        if (op.reconnect ?? true) {
          for (const u of ups) for (const d of downs) {
            if (!hasMain(u, d)) addEdge({ id: edgeId(u, d), from: u, to: d, kind: 'main' })
          }
        }
        break
      }
      case 'update_node': {
        const n = node(op.id)
        if (op.label !== undefined) n.label = op.label
        if (op.slot) {
          if (n.kind !== 'slot') throw new Error(`node ${op.id} is not a slot`)
          n.slot = { ...(n.slot as SlotConfig), ...op.slot }
        }
        if (op.gate) {
          if (n.kind !== 'gate') throw new Error(`node ${op.id} is not a gate`)
          n.gate = { ...n.gate, ...op.gate }
        }
        break
      }
      case 'move_node':
        node(op.id).position = { x: op.position.x, y: op.position.y }
        break
      case 'add_edge':
        node(op.edge.from)
        node(op.edge.to)
        addEdge({ ...op.edge })
        break
      case 'remove_edge': {
        const before = g.edges.length
        g.edges = g.edges.filter((e) => e.id !== op.id)
        if (g.edges.length === before) throw new Error(`edge not found: ${op.id}`)
        break
      }
      case 'set_gate': {
        const n = node(op.id)
        if (n.kind !== 'gate') throw new Error(`node ${op.id} is not a gate`)
        n.gate = { ...n.gate, prompt: op.prompt }
        break
      }
      case 'set_pin': {
        const n = node(op.id)
        if (n.kind !== 'slot') throw new Error(`only slot nodes can be pinned: ${op.id}`)
        if (op.pinned) n.pinned = true
        else delete n.pinned
        break
      }
      case 'set_stage_meta':
        break
      default:
        throw new Error(`unknown graph op: ${(op as { op: string }).op}`)
    }
  }
  return g
}

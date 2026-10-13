/**
 * DAG run scheduling over a pipeline graph — pure state, no I/O.
 *
 * Execution model (v1): layer-synchronous. The run's stages are the graph's
 * slot-bearing layers (deriveStagesFromGraph), executed in order by the
 * existing stage machinery in App.vue; a join therefore waits for ALL its
 * upstream nodes, because every upstream sits in an earlier layer. On top of
 * that this module adds what a linear stage list cannot express:
 *   - gate nodes: a pending gate whose layer precedes the next stage pauses
 *     the run until it is approved (or rejected);
 *   - reject edges: rejecting a gate follows its reject edge back to an
 *     upstream node, re-running from that node's layer, at most maxLoops times;
 *   - pins: a pinned slot node is skipped and its frozen output reused;
 *   - restart-from-node: a run may start at any node's layer.
 * A graph with none of these (every legacy pipeline) yields a plan whose
 * hooks are all no-ops, so linear runs behave exactly as before.
 */
import type { Stage } from '../data/stages'
import {
  DEFAULT_MAX_LOOPS,
  deriveGraphFromStages,
  layerGraph,
  type GraphNode,
  type NodeRunState,
  type PipelineGraph,
} from './pipelineGraph'

export interface DagPlan {
  graph: PipelineGraph
  /** [stageIndex][slotIndex] → slot node id. */
  stageNodeIds: string[][]
  /** stageIndex → graph layer index. */
  stageLayer: number[]
  nodeLayer: Record<string, number>
  gateIds: string[]
  /** Any gate, reject edge or pin — false means every hook is a no-op. */
  hasControlFlow: boolean
}

export type GateStatus = 'pending' | 'awaiting' | 'approved' | 'rejected'

export interface DagRunState {
  gates: Record<string, GateStatus>
  /** reject edge id → times taken this run. */
  loops: Record<string, number>
  nodes: Record<string, NodeRunState>
  /** stageIndex → note appended to that stage's kickoffs on its next
   *  activation (why it is being re-run). Consumed once. */
  notes: Record<number, string>
  /** True once a reject loop has sent the run back. */
  looped: boolean
}

export type RejectResult =
  | { kind: 'no-edge' }
  | { kind: 'exhausted'; edgeId: string; max: number }
  | { kind: 'loop'; edgeId: string; targetIndex: number; count: number; max: number }

/** Build the plan for a run. `graph` null (a pipeline without a stored graph)
 *  or a graph whose layers do not line up with `stages` falls back to the
 *  graph the stages imply, so the run can never disagree with its stages. */
export function buildDagPlan(graph: PipelineGraph | null, stages: readonly Stage[]): DagPlan {
  const fromStages = (): DagPlan => planFor(deriveGraphFromStages(stages), stages)!
  if (!graph) return fromStages()
  return planFor(graph, stages) ?? fromStages()
}

function planFor(graph: PipelineGraph, stages: readonly Stage[]): DagPlan | null {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const { layers } = layerGraph(graph)
  const nodeLayer: Record<string, number> = {}
  layers.forEach((layer, i) => layer.forEach((id) => { nodeLayer[id] = i }))
  const stageNodeIds: string[][] = []
  const stageLayer: number[] = []
  layers.forEach((layer, i) => {
    const slots = layer.map((id) => byId.get(id)!).filter((n) => n.kind === 'slot' && n.slot)
    if (!slots.length) return
    stageNodeIds.push(slots.map((n) => n.id))
    stageLayer.push(i)
  })
  // The stages must be the ones this graph derives: same count, same slot
  // labels in the same order.
  if (stageNodeIds.length !== stages.length) return null
  for (let s = 0; s < stages.length; s++) {
    const labels = stageNodeIds[s].map((id) => byId.get(id)!.slot!.label)
    const want = stages[s].slots.map((sl) => sl.label)
    if (labels.length !== want.length || labels.some((l, i) => l !== want[i])) return null
  }
  const gateIds = graph.nodes.filter((n) => n.kind === 'gate' && n.id in nodeLayer).map((n) => n.id)
  const hasControlFlow =
    gateIds.length > 0 ||
    graph.edges.some((e) => e.kind === 'reject') ||
    graph.nodes.some((n) => n.kind === 'slot' && n.pinned)
  return { graph, stageNodeIds, stageLayer, nodeLayer, gateIds, hasControlFlow }
}

function node(plan: DagPlan, id: string): GraphNode | undefined {
  return plan.graph.nodes.find((n) => n.id === id)
}

/** Fresh run state. Nodes before `startIndex` (restart-from-node) are
 *  'skipped' — they reuse their last output — as are pinned nodes; gates
 *  before `startLayer` (default: the start stage's layer) count as approved,
 *  so restarting AT a gate stops on that gate first. */
export function createRunState(
  plan: DagPlan,
  startIndex = 0,
  startLayer: number = plan.stageLayer[startIndex] ?? Infinity,
): DagRunState {
  const nodes: Record<string, NodeRunState> = {}
  plan.stageNodeIds.forEach((ids, s) => {
    for (const id of ids) {
      const pinned = !!node(plan, id)?.pinned
      nodes[id] = s < startIndex || pinned ? { status: 'skipped', ...(pinned ? { pinned } : {}) } : { status: 'pending' }
    }
  })
  const gates: Record<string, GateStatus> = {}
  for (const g of plan.gateIds) {
    const before = plan.nodeLayer[g] < startLayer
    gates[g] = before ? 'approved' : 'pending'
    nodes[g] = { status: before ? 'skipped' : 'pending' }
  }
  return { gates, loops: {}, nodes, notes: {}, looped: false }
}

/** Pending gates that must be resolved before stage `nextIndex` may start;
 *  nextIndex === stage count means "before the run completes". */
export function gatesBefore(plan: DagPlan, state: DagRunState, nextIndex: number): string[] {
  const limit = nextIndex < plan.stageLayer.length ? plan.stageLayer[nextIndex] : Infinity
  return plan.gateIds.filter((g) => plan.nodeLayer[g] < limit && state.gates[g] !== 'approved')
}

export function approveGate(state: DagRunState, gateId: string, at = new Date().toISOString()): void {
  state.gates[gateId] = 'approved'
  state.nodes[gateId] = { ...state.nodes[gateId], status: 'done', endedAt: at }
}

/** First stage index whose layer is at or after `layer` (stage count if none). */
function firstStageAtOrAfter(plan: DagPlan, layer: number): number {
  const i = plan.stageLayer.findIndex((l) => l >= layer)
  return i < 0 ? plan.stageLayer.length : i
}

/** Reject a gate: follow its reject edge (the first one, in graph order). */
export function rejectGate(
  plan: DagPlan,
  state: DagRunState,
  gateId: string,
  comment = '',
  at = new Date().toISOString(),
): RejectResult {
  const edge = plan.graph.edges.find((e) => e.kind === 'reject' && e.from === gateId)
  state.nodes[gateId] = { ...state.nodes[gateId], status: 'rejected', endedAt: at }
  if (!edge) {
    state.gates[gateId] = 'rejected'
    return { kind: 'no-edge' }
  }
  const max = edge.maxLoops ?? DEFAULT_MAX_LOOPS
  const count = (state.loops[edge.id] ?? 0) + 1
  if (count > max) {
    state.gates[gateId] = 'rejected'
    return { kind: 'exhausted', edgeId: edge.id, max }
  }
  state.loops[edge.id] = count
  state.looped = true
  const targetLayer = plan.nodeLayer[edge.to] ?? 0
  // Everything from the target's layer on runs again: gates go back to
  // pending, non-pinned slot nodes back to pending.
  for (const g of plan.gateIds) {
    if (plan.nodeLayer[g] >= targetLayer) {
      state.gates[g] = 'pending'
      if (g !== gateId) state.nodes[g] = { status: 'pending' }
    }
  }
  plan.stageNodeIds.forEach((ids) => {
    for (const id of ids) {
      if (plan.nodeLayer[id] >= targetLayer && !node(plan, id)?.pinned) {
        state.nodes[id] = { status: 'pending', attempts: state.nodes[id]?.attempts }
      }
    }
  })
  const targetIndex = firstStageAtOrAfter(plan, targetLayer)
  const label = node(plan, gateId)?.label || gateId
  state.notes[targetIndex] =
    `[退回重做 — 「${label}」未通過（第 ${count}/${max} 次）]` + (comment.trim() ? `\n意見：${comment.trim()}` : '')
  return { kind: 'loop', edgeId: edge.id, targetIndex, count, max }
}

/** Where a restart at `nodeId` begins: the first stage at or after the
 *  node's layer, and that layer (for createRunState). null if unknown. */
export function restartPointFor(plan: DagPlan, nodeId: string): { index: number; layer: number } | null {
  const layer = plan.nodeLayer[nodeId]
  if (layer === undefined) return null
  return { index: firstStageAtOrAfter(plan, layer), layer }
}

/** Slot labels of stage `index` whose nodes are pinned. */
export function pinnedLabels(plan: DagPlan, index: number): Set<string> {
  const out = new Set<string>()
  for (const id of plan.stageNodeIds[index] ?? []) {
    const n = node(plan, id)
    if (n?.pinned && n.slot) out.add(n.slot.label)
  }
  return out
}

/** Node id of stage `index`'s slot with this label ('' if none). */
export function slotNodeIdAt(plan: DagPlan, index: number, label: string): string {
  return (plan.stageNodeIds[index] ?? []).find((id) => node(plan, id)?.slot?.label === label) ?? ''
}

/** The slot nodes feeding `nodeId` over main edges, looking through gates and
 *  triggers (a gate passes its upstream's output on). */
export function upstreamSlotNodes(plan: DagPlan, nodeId: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const visit = (id: string): void => {
    for (const e of plan.graph.edges) {
      if ((e.kind ?? 'main') !== 'main' || e.to !== id || seen.has(e.from)) continue
      seen.add(e.from)
      const n = node(plan, e.from)
      if (n?.kind === 'slot') out.push(n.id)
      else visit(e.from)
    }
  }
  visit(nodeId)
  return out
}

export const PREV_SUMMARY_VAR = '{{prev.summary}}'

/** Replace {{prev.summary}} with the upstream nodes' summaries. Text without
 *  the variable is returned unchanged. */
export function expandPrevSummary(
  text: string,
  upstream: ReadonlyArray<{ label: string; summary: string }>,
): string {
  if (!text.includes(PREV_SUMMARY_VAR)) return text
  const value = upstream.length === 0
    ? '(no upstream output)'
    : upstream.length === 1
      ? upstream[0].summary
      : upstream.map((u) => `[${u.label}]\n${u.summary}`).join('\n\n')
  return text.split(PREV_SUMMARY_VAR).join(value)
}

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
 *   - restart-from-node: a run may start at any node's layer;
 *   - branch / error edges: a node runs only when at least one of its inputs
 *     was taken (a main edge from a finished node, a branch edge whose `when`
 *     matched, an error edge from a failed node); otherwise it is skipped
 *     ('untaken') and the skip propagates. A join waits for every input that
 *     can still arrive — in layers those all sit earlier, so it is settled by
 *     the time its stage starts. Timing therefore stays layer-synchronous: a
 *     ready node can wait for unrelated nodes of its own layer.
 * A graph with none of these (every legacy pipeline) yields a plan whose
 * hooks are all no-ops, so linear runs behave exactly as before.
 */
import type { Stage } from '../data/stages'
import {
  BRANCH_DEFAULT,
  DEFAULT_MAX_LOOPS,
  deriveGraphFromStages,
  hasBranchingEdges,
  isForwardEdge,
  layerGraph,
  type BranchWhen,
  type GraphEdge,
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
  /** Any gate, reject edge, pin or branch/error edge — false means every
   *  hook is a no-op. */
  hasControlFlow: boolean
  /** Any branch or error edge: readiness and untaken skips apply. */
  hasBranching: boolean
  /** Slot nodes that may turn out untaken (downstream of a branch or error
   *  edge, or of a slot with an error edge): not pre-spawned ahead of time. */
  conditionalIds: Set<string>
  /** Subpipeline nodes, in layer order: the run suspends at each one and
   *  runs its child pipeline before the next stage. */
  callIds: string[]
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
  /** slot node id → retries taken this run (see RetryPolicy). */
  retries: Record<string, number>
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
  const callIds = graph.nodes
    .filter((n) => n.kind === 'subpipeline' && n.id in nodeLayer)
    .map((n) => n.id)
    .sort((a, b) => nodeLayer[a] - nodeLayer[b])
  const hasBranching = hasBranchingEdges(graph)
  const hasControlFlow =
    gateIds.length > 0 ||
    callIds.length > 0 ||
    graph.edges.some((e) => e.kind === 'reject') ||
    graph.nodes.some((n) => n.kind === 'slot' && n.pinned) ||
    hasBranching
  return { graph, stageNodeIds, stageLayer, nodeLayer, gateIds, hasControlFlow, hasBranching, conditionalIds: conditionalNodes(graph), callIds }
}

function conditionalNodes(graph: PipelineGraph): Set<string> {
  const out = new Set<string>()
  if (!hasBranchingEdges(graph)) return out
  const failing = new Set(graph.edges.filter((e) => e.kind === 'error').map((e) => e.from))
  const queue = graph.edges
    .filter((e) => e.kind === 'branch' || e.kind === 'error' || (isForwardEdge(e) && failing.has(e.from)))
    .map((e) => e.to)
  while (queue.length) {
    const id = queue.shift()!
    if (out.has(id)) continue
    out.add(id)
    for (const e of graph.edges) if (isForwardEdge(e) && e.from === id) queue.push(e.to)
  }
  return out
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
  // A call before the start was made by an earlier run: its output is reused
  // (usePipelineDag.begin calls it again when no output was recorded).
  for (const c of plan.callIds) nodes[c] = { status: plan.nodeLayer[c] < startLayer ? 'skipped' : 'pending' }
  const gates: Record<string, GateStatus> = {}
  for (const g of plan.gateIds) {
    const before = plan.nodeLayer[g] < startLayer
    gates[g] = before ? 'approved' : 'pending'
    nodes[g] = { status: before ? 'skipped' : 'pending' }
  }
  return { gates, loops: {}, nodes, notes: {}, looped: false, retries: {} }
}

/** Pending gates that must be resolved before stage `nextIndex` may start;
 *  nextIndex === stage count means "before the run completes". */
export function gatesBefore(plan: DagPlan, state: DagRunState, nextIndex: number): string[] {
  const limit = nextIndex < plan.stageLayer.length ? plan.stageLayer[nextIndex] : Infinity
  return plan.gateIds.filter(
    (g) => plan.nodeLayer[g] < limit && state.gates[g] !== 'approved' && !isUntaken(state.nodes[g]),
  )
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
/** What rejecting `gateId` now would do, without doing it: follow its
 *  reject edge back ('loop'), or end the run as failed because it has none
 *  ('no-edge') or its loop budget is spent ('exhausted'). Mirrors rejectGate. */
export function rejectOutcome(plan: DagPlan, state: DagRunState, gateId: string): RejectResult['kind'] {
  const edge = plan.graph.edges.find((e) => e.kind === 'reject' && e.from === gateId)
  if (!edge) return 'no-edge'
  return (state.loops[edge.id] ?? 0) + 1 > (edge.maxLoops ?? DEFAULT_MAX_LOOPS) ? 'exhausted' : 'loop'
}

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
  for (const c of plan.callIds) {
    if (plan.nodeLayer[c] >= targetLayer) {
      state.nodes[c] = { status: 'pending', attempts: state.nodes[c]?.attempts }
      delete state.retries[c]
    }
  }
  plan.stageNodeIds.forEach((ids) => {
    for (const id of ids) {
      if (plan.nodeLayer[id] >= targetLayer && !node(plan, id)?.pinned) {
        state.nodes[id] = { status: 'pending', attempts: state.nodes[id]?.attempts }
        delete state.retries[id]
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

/** The slot nodes feeding `nodeId` over forward edges, looking through gates
 *  and triggers (a gate passes its upstream's output on). */
export function upstreamSlotNodes(plan: DagPlan, nodeId: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const visit = (id: string): void => {
    for (const e of plan.graph.edges) {
      if (!isForwardEdge(e) || e.to !== id || seen.has(e.from)) continue
      seen.add(e.from)
      const n = node(plan, e.from)
      // A subpipeline node hands on its child run's output, as a slot does.
      if (n?.kind === 'slot' || n?.kind === 'subpipeline') out.push(n.id)
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

// ── Branch / error edges ─────────────────────────────────────────────────────

/** What a finished node left behind for edge decisions, persisted across runs
 *  with its summary (pins, restart points, resume). */
export interface NodeResult {
  branch?: string
  output?: unknown
}

export function isUntaken(st: NodeRunState | undefined): boolean {
  return st?.status === 'skipped' && st.skipReason === 'untaken'
}

type EdgeTake = 'taken' | 'untaken' | 'unsettled'

function norm(v: string): string {
  return v.trim().toLowerCase()
}

/** Field `path` (dot-separated; array items by index) of a JSON value. */
export function valueAtPath(value: unknown, path: string): unknown {
  let cur = value
  for (const key of path.split('.').filter((k) => k !== '')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}

function whenMatches(when: BranchWhen | undefined, result: NodeResult): boolean {
  if (typeof when === 'string') return result.branch !== undefined && norm(when) === norm(result.branch)
  if (when && typeof when === 'object') return valueAtPath(result.output, when.path) === when.equals
  return false
}

function isDefaultWhen(when: BranchWhen | undefined): boolean {
  return typeof when === 'string' && norm(when) === BRANCH_DEFAULT
}

function edgeTake(
  plan: DagPlan,
  state: DagRunState,
  e: GraphEdge,
  resultOf: (id: string) => NodeResult,
): EdgeTake {
  const src = node(plan, e.from)
  const kind = e.kind ?? 'main'
  if (!src) return 'untaken'
  if (src.kind === 'trigger') return kind === 'main' ? 'taken' : 'untaken'
  const st = state.nodes[src.id]
  if (isUntaken(st)) return 'untaken'
  if (src.kind === 'gate') {
    if (state.gates[src.id] !== 'approved') return 'unsettled'
    return kind === 'main' ? 'taken' : 'untaken'
  }
  if (!st) return kind === 'main' ? 'taken' : 'untaken'
  if (st.status === 'failed' && st.errorRouted) return kind === 'error' ? 'taken' : 'untaken'
  if (st.status !== 'done' && st.status !== 'skipped') return 'unsettled'
  if (kind === 'main') return 'taken'
  if (kind !== 'branch') return 'untaken'
  const result = resultOf(src.id)
  if (!isDefaultWhen(e.when)) return whenMatches(e.when, result) ? 'taken' : 'untaken'
  const others = plan.graph.edges.filter((x) => x.kind === 'branch' && x.from === src.id && !isDefaultWhen(x.when))
  return others.some((x) => whenMatches(x.when, result)) ? 'untaken' : 'taken'
}

/** Mark every pending node none of whose (all settled) inputs was taken as
 *  skipped 'untaken', in layer order so the skip propagates in one pass.
 *  A no-op for a plan without branch or error edges. */
export function settleUntaken(
  plan: DagPlan,
  state: DagRunState,
  resultOf: (id: string) => NodeResult = () => ({}),
): void {
  if (!plan.hasBranching) return
  const ids = Object.keys(plan.nodeLayer).sort((a, b) => plan.nodeLayer[a] - plan.nodeLayer[b])
  for (const id of ids) {
    const n = node(plan, id)
    if (!n || n.kind === 'trigger' || state.nodes[id]?.status !== 'pending') continue
    if (n.kind === 'gate' && state.gates[id] !== 'pending') continue
    const inputs = plan.graph.edges.filter((e) => isForwardEdge(e) && e.to === id)
    if (!inputs.length) continue
    const takes = inputs.map((e) => edgeTake(plan, state, e, resultOf))
    if (takes.includes('unsettled') || takes.includes('taken')) continue
    state.nodes[id] = { status: 'skipped', skipReason: 'untaken' }
  }
}

/** Slot labels of stage `index` that settled as untaken. */
export function untakenLabels(plan: DagPlan, state: DagRunState, index: number): Set<string> {
  const out = new Set<string>()
  for (const id of plan.stageNodeIds[index] ?? []) {
    const n = node(plan, id)
    if (n?.slot && isUntaken(state.nodes[id])) out.add(n.slot.label)
  }
  return out
}

/** Slot labels of stage `index` that may still turn out untaken. */
export function conditionalLabels(plan: DagPlan, index: number): Set<string> {
  const out = new Set<string>()
  for (const id of plan.stageNodeIds[index] ?? []) {
    const n = node(plan, id)
    if (n?.slot && plan.conditionalIds.has(id)) out.add(n.slot.label)
  }
  return out
}

/** The node's retry policy, or null when it has none (or allows one try). */
export function retryPolicyOf(plan: DagPlan, nodeId: string): { maxTries: number; waitMs: number } | null {
  const r = node(plan, nodeId)?.retry
  if (!r || r.maxTries <= 1) return null
  return { maxTries: r.maxTries, waitMs: r.waitMs ?? 0 }
}

/** True for a node that reads ---NODE-FAILED---: it has an error edge or
 *  retries. Every other node ignores the signal, as before. */
export function readsFailure(plan: DagPlan, nodeId: string): boolean {
  return hasErrorEdge(plan, nodeId) || retryPolicyOf(plan, nodeId) !== null
}

export interface RetryTurn {
  /** The try about to run (2 for the first retry). */
  attempt: number
  maxTries: number
  waitMs: number
  /** Put in front of the retried kickoff. */
  note: string
}

/** Take one retry of `nodeId` after a failed try: the node goes back to
 *  pending with the failure as its error. null when it has no retry policy
 *  or its tries are spent — the caller then fails it as before. */
export function takeRetry(plan: DagPlan, state: DagRunState, nodeId: string, reason: string): RetryTurn | null {
  const policy = retryPolicyOf(plan, nodeId)
  if (!policy) return null
  const used = state.retries[nodeId] ?? 0
  if (used + 1 >= policy.maxTries) return null
  state.retries[nodeId] = used + 1
  state.nodes[nodeId] = { ...state.nodes[nodeId], status: 'pending', error: reason }
  const attempt = used + 2
  return {
    attempt,
    maxTries: policy.maxTries,
    waitMs: policy.waitMs,
    note: `[重試 第 ${attempt}/${policy.maxTries} 次 — 上次失敗：${reason}]`,
  }
}

export function hasErrorEdge(plan: DagPlan, nodeId: string): boolean {
  return plan.graph.edges.some((e) => e.kind === 'error' && e.from === nodeId)
}

export function hasBranchEdge(plan: DagPlan, nodeId: string): boolean {
  return plan.graph.edges.some((e) => e.kind === 'branch' && e.from === nodeId)
}

/** True when downstream reads this node's structured output: an object
 *  `when` on one of its branch edges, or {{node.<id>.output…}} in a kickoff. */
export function hasOutputContract(plan: DagPlan, nodeId: string): boolean {
  if (plan.graph.edges.some((e) => e.kind === 'branch' && e.from === nodeId && typeof e.when === 'object')) return true
  const ref = `{{node.${nodeId}.output`
  return plan.graph.nodes.some((n) => n.kind === 'slot' && !!n.slot?.kickoffBody?.includes(ref))
}

/** Signals a finished slot reported in its own reply. */
export interface NodeSignals {
  branch?: string
  /** Set when the slot reported ---NODE-FAILED[: reason]---. */
  failed?: string
  /** Present when an ---OUTPUT-START/END--- block was found: `value` is the
   *  parsed JSON, or null with `parseError` when it did not parse. */
  output?: { value: unknown; parseError?: string }
}

// A signal line starts the line, after optional indentation or a TUI bullet.
const LINE_HEAD = String.raw`^[ \t]*(?:[⏺●•][ \t]*)?`
/** `<value>`-style placeholders, as the kickoff hints write their examples. */
const PLACEHOLDER_RE = /^<[^<>]*>$/
const NONCE_RE = /^[0-9a-f]{16}$/

/** A fresh per-node signal code: 64 bits from the platform CSPRNG. A signal
 *  counts only with the code of the kickoff it answers (see parseNodeSignals),
 *  so text the agent merely shows (a file, a web page, an echoed template) or
 *  an earlier try's output cannot steer the run. */
export function newSignalNonce(): string {
  const bytes = new Uint8Array(8)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** The kickoff line that names the signal code. It is the kickoff's last
 *  signal line, so whatever follows its last occurrence on screen is the
 *  agent's own output (see signalsAfterKickoff). */
export function signalCodeLine(nonce: string): string {
  return `[訊號代碼] 本步驟的訊號代碼是 ${nonce}。只有帶這個代碼的訊號才算數。`
}

/** The part of a pane's screen text after the kickoff's signal-code line:
 *  the agent's own output. A TUI that echoes the kickoff (or redraws it
 *  later) moves the cut past the echo; a TUI that collapses the paste shows
 *  no code line and the text is returned whole. */
export function signalsAfterKickoff(text: string, nonce: string): string {
  if (!NONCE_RE.test(nonce)) return ''
  const at = text.lastIndexOf(`訊號代碼是 ${nonce}`)
  if (at < 0) return text
  const eol = text.indexOf('\n', at)
  return eol < 0 ? '' : text.slice(eol + 1)
}

/** Parse a slot's reply for branch / failure / output signals carrying
 *  `nonce`, the code its kickoff named: `---BRANCH:<nonce>: <value>---`,
 *  `---NODE-FAILED:<nonce>[: <reason>]---` and an `---OUTPUT-START:<nonce>---`
 *  … `---OUTPUT-END:<nonce>---` block. A signal without that code (no code, a
 *  wrong one, the kickoff's own `代碼` wording) is ignored, and so is every
 *  signal when `nonce` is not a code. The last real occurrence wins;
 *  placeholder examples are never taken as results. Callers pass the
 *  agent's turn text where the CLI has one (#733). */
export function parseNodeSignals(text: string, nonce: string): NodeSignals {
  const out: NodeSignals = {}
  if (!NONCE_RE.test(nonce)) return out
  const branchRe = new RegExp(String.raw`${LINE_HEAD}---BRANCH:${nonce}:[ \t]*(.*?)[ \t]*---[ \t]*$`, 'gm')
  const failedRe = new RegExp(String.raw`${LINE_HEAD}---NODE-FAILED:${nonce}(?::[ \t]*(.*?))?[ \t]*---[ \t]*$`, 'gm')
  const outputRe = new RegExp(
    String.raw`${LINE_HEAD}---OUTPUT-START:${nonce}---[ \t]*$([\s\S]*?)${LINE_HEAD}---OUTPUT-END:${nonce}---[ \t]*$`,
    'gm',
  )
  for (const m of text.matchAll(branchRe)) {
    const v = m[1].trim()
    if (v && !PLACEHOLDER_RE.test(v)) out.branch = v
  }
  for (const m of text.matchAll(failedRe)) {
    const v = (m[1] ?? '').trim()
    if (!PLACEHOLDER_RE.test(v)) out.failed = v || 'the agent reported a failure'
  }
  let body: string | undefined
  for (const m of text.matchAll(outputRe)) {
    const v = m[1].trim()
    if (v && !PLACEHOLDER_RE.test(v)) body = v
  }
  if (body !== undefined) {
    try {
      out.output = { value: JSON.parse(body) }
    } catch (err) {
      out.output = { value: null, parseError: err instanceof Error ? err.message : String(err) }
    }
  }
  return out
}

const NODE_OUTPUT_RE = /\{\{node\.([^.{}\s]+)\.output((?:\.[^.{}\s]+)*)\}\}/g

/** Replace {{node.<id>.output}} (the whole JSON) and
 *  {{node.<id>.output.<path>}} (one field) for ids that are nodes of the
 *  graph; a missing value expands to ''. Other text is left as it is. */
export function expandNodeOutputs(
  text: string,
  graph: PipelineGraph,
  outputOf: (id: string) => unknown,
): string {
  if (!text.includes('{{node.')) return text
  const ids = new Set(graph.nodes.map((n) => n.id))
  return text.replace(NODE_OUTPUT_RE, (whole, id: string, path: string) => {
    if (!ids.has(id)) return whole
    const v = path ? valueAtPath(outputOf(id), path.slice(1)) : outputOf(id)
    if (v === undefined || v === null) return ''
    return typeof v === 'string' ? v : JSON.stringify(v)
  })
}

/** Instructions appended to a slot's kickoff for the signals its outgoing
 *  edges need; '' for a node with no branch or error edge, no output
 *  contract and no retry (every legacy node), so its kickoff is unchanged.
 *  The formats are written with the word 代碼 where the code goes, and the
 *  code itself only on the closing signal-code line, so the kickoff never
 *  holds a signal parseNodeSignals takes — an echo of it on screen is inert. */
export function kickoffHints(plan: DagPlan, nodeId: string, nonce: string): string {
  const lines: string[] = []
  if (hasBranchEdge(plan, nodeId)) {
    const values = [...new Set(plan.graph.edges
      .filter((e) => e.kind === 'branch' && e.from === nodeId && typeof e.when === 'string' && !isDefaultWhen(e.when))
      .map((e) => (e.when as string).trim()))]
    if (values.length) {
      lines.push(`[分支回報] 完成時另起一行，從行首輸出 ---BRANCH:代碼: 值---：「代碼」換成下面的訊號代碼，「值」只能是下列之一：${values.join('、')}。`)
    }
  }
  if (hasOutputContract(plan, nodeId)) {
    lines.push('[結構化輸出] 結束前輸出一段 JSON：上一行單獨寫 ---OUTPUT-START:代碼---，下一行單獨寫 ---OUTPUT-END:代碼---（「代碼」換成下面的訊號代碼），下游節點會讀取這段 JSON。')
  }
  if (readsFailure(plan, nodeId)) {
    const then = hasErrorEdge(plan, nodeId) ? '流程會改走錯誤處理分支' : '這一步會重試'
    lines.push(`[失敗回報] 如果這一步無法完成，另起一行，從行首輸出 ---NODE-FAILED:代碼: 原因---（「代碼」換成下面的訊號代碼），再照常輸出完成標記；${then}。`)
  }
  if (!lines.length) return ''
  lines.push(signalCodeLine(nonce))
  return `\n\n${lines.join('\n')}`
}

/** Fail `nodeId` down its error edge(s). false (nothing changed) when it has
 *  none — the caller then fails the run as before. */
export function routeFailure(
  plan: DagPlan,
  state: DagRunState,
  nodeId: string,
  error: string,
  at = new Date().toISOString(),
): boolean {
  if (!hasErrorEdge(plan, nodeId)) return false
  state.nodes[nodeId] = { ...state.nodes[nodeId], status: 'failed', endedAt: at, error, errorRouted: true }
  return true
}

// ── Sub-pipelines ────────────────────────────────────────────────────────────

/** The first subpipeline node the run must call before stage `nextIndex`
 *  (nextIndex === stage count: before the run completes), or null. Only a
 *  pending call counts: done, reused, untaken and error-routed ones are past. */
export function callBefore(plan: DagPlan, state: DagRunState, nextIndex: number): string | null {
  const limit = nextIndex < plan.stageLayer.length ? plan.stageLayer[nextIndex] : Infinity
  return plan.callIds.find((c) => plan.nodeLayer[c] < limit && state.nodes[c]?.status === 'pending') ?? null
}

/** What a finished child run hands its parent's subpipeline node: the
 *  summaries of its last steps (slot nodes no forward edge leaves that ran),
 *  and their structured output — one step's as is, several as {label: output}. */
export function childResultOf(
  plan: DagPlan,
  state: DagRunState,
  summaryOf: (id: string) => string,
  outputOf: (id: string) => unknown,
): { summary: string; output: unknown } {
  const sinks = plan.stageNodeIds.flat().filter((id) => {
    const st = state.nodes[id]
    if (!st || isUntaken(st) || (st.status !== 'done' && st.status !== 'skipped')) return false
    return !plan.graph.edges.some((e) => isForwardEdge(e) && e.from === id)
  })
  const label = (id: string): string => node(plan, id)?.label || id
  const summary = sinks.length === 1
    ? summaryOf(sinks[0])
    : sinks.map((id) => `[${label(id)}]\n${summaryOf(id)}`).join('\n\n')
  const withOutput = sinks.filter((id) => outputOf(id) !== undefined)
  const output = withOutput.length === 0
    ? null
    : withOutput.length === 1 && sinks.length === 1
      ? outputOf(withOutput[0])
      : Object.fromEntries(withOutput.map((id) => [label(id), outputOf(id)]))
  return { summary, output }
}

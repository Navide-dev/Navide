import { ref, shallowRef } from 'vue'
import type { Stage } from '../data/stages'
import type { NodeRunState, PipelineGraph } from '../lib/pipelineGraph'
import {
  approveGate,
  buildDagPlan,
  createRunState,
  expandPrevSummary,
  gatesBefore,
  pinnedLabels as planPinnedLabels,
  rejectGate,
  restartPointFor,
  slotNodeIdAt,
  upstreamSlotNodes,
  type DagPlan,
  type DagRunState,
  type RejectResult,
} from '../lib/pipelineDagRun'

/** Characters of a finished slot's terminal tail kept as its summary. */
const SUMMARY_CHARS = 1200

export interface PipelineDagDeps {
  /** A request on the backend socket; resolves null on failure. Kept apart
   *  from the run's sendQuiet so node-state reporting stays a side channel. */
  send: (type: string, payload: Record<string, unknown>) => Promise<Record<string, unknown> | null>
  log: (line: string) => void
  workspacePath: () => string
}

export interface AwaitingGate {
  gateId: string
  label: string
  prompt: string
  /** The stage the run continues with once the gate is approved. */
  nextIndex: number
}

export interface NodeOutput {
  summary: string
  at: string
}

/**
 * The renderer side of the DAG engine: holds one run's plan and state, and
 * gives App.vue's stage machine the hooks it calls at its existing seams
 * (start, stage activation, slot completion, stage hand-off, end). Every hook
 * is a no-op for a plan without control flow, which is what keeps a legacy
 * linear pipeline's run identical; node states are still reported for it so
 * the canvas can show them.
 */
export function usePipelineDag(deps: PipelineDagDeps) {
  const plan = shallowRef<DagPlan | null>(null)
  const awaitingGate = ref<AwaitingGate | null>(null)
  /** Reactive mirror of the run's node states, for the canvas. */
  const nodeStates = ref<Record<string, NodeRunState>>({})
  let run: DagRunState | null = null
  let outputs: Record<string, NodeOutput> = {}
  let pendingOutputs: Record<string, NodeOutput> = {}
  let reportChain: Promise<unknown> = Promise.resolve()

  const now = (): string => new Date().toISOString()

  /** `gate` overrides what is reported as the paused gate (default: the one
   *  the run is waiting on now, or {} for none). */
  function report(gateOverride?: AwaitingGate | null): Promise<unknown> {
    if (!run) return reportChain
    const ws = deps.workspacePath()
    if (!ws) return reportChain
    nodeStates.value = { ...run.nodes }
    const current = gateOverride === undefined ? awaitingGate.value : gateOverride
    const gate = current ? { ...current } : {}
    const nodes = { ...run.nodes }
    // Serialised so the backend sees states in the order they happened.
    reportChain = reportChain.then(async () => {
      const payload: Record<string, unknown> = { workspace_path: ws, nodes, gate }
      // Outputs go out once, with whichever report sends first after they
      // were recorded; a failed report puts them back for the next one.
      const outputs = pendingOutputs
      pendingOutputs = {}
      if (Object.keys(outputs).length) payload.outputs = outputs
      const resp = await deps.send('pipeline.node_states', payload)
      if (!resp && payload.outputs) pendingOutputs = { ...outputs, ...pendingOutputs }
      return resp
    }).catch(() => null)
    return reportChain
  }

  async function loadPlan(pipelineId: string, stages: readonly Stage[]): Promise<DagPlan | null> {
    plan.value = null
    run = null
    awaitingGate.value = null
    return fetchPlan(pipelineId, stages)
  }

  async function fetchPlan(pipelineId: string, stages: readonly Stage[]): Promise<DagPlan | null> {
    const resp = await deps.send('pipelines.graph.get', pipelineId ? { pipeline_id: pipelineId } : {})
    if (!resp) {
      deps.log('DAG ✕ could not load the pipeline graph')
      return null
    }
    const graph = resp.derived ? null : (resp.graph as PipelineGraph)
    const built = buildDagPlan(graph, stages)
    if (graph && built.graph !== graph) {
      deps.log('DAG ⚠ the stored graph does not match the loaded stages — running the stages linearly')
    }
    return built
  }

  /** Load the graph and set up a run. Returns the stage index to start at
   *  (0, or the restart point's), or null when the run must not start. */
  async function begin(
    pipelineId: string,
    stages: readonly Stage[],
    opts: { startIndex?: number; fromNodeId?: string } = {},
  ): Promise<number | null> {
    const built = await loadPlan(pipelineId, stages)
    if (!built) return null
    let startIndex = opts.startIndex ?? 0
    // A fresh start owes every gate a decision, even one before stage 01
    // (right after the trigger); a resume counts the gates before its stage
    // as passed.
    let startLayer: number | undefined = opts.startIndex === undefined ? -Infinity : undefined
    if (opts.fromNodeId) {
      const point = restartPointFor(built, opts.fromNodeId)
      if (!point) {
        deps.log(`DAG ✕ restart node ${opts.fromNodeId} is not in this pipeline`)
        return null
      }
      startIndex = point.index
      startLayer = point.layer
    }
    plan.value = built
    run = createRunState(built, startIndex, startLayer ?? built.stageLayer[startIndex] ?? Infinity)
    void report()
    return startIndex
  }

  /** True when a run of this pipeline can restart at `nodeId`. Reads the
   *  graph without touching the current run, so a restart can be refused
   *  before it tears anything down. */
  async function canRestartFrom(pipelineId: string, stages: readonly Stage[], nodeId: string): Promise<boolean> {
    const built = await fetchPlan(pipelineId, stages)
    return !!built && restartPointFor(built, nodeId) !== null
  }

  /** Resume a run that was aborted while paused at `gate` (as persisted in
   *  project.node_gate): the run is set up to wait on that gate again, with
   *  the node states it had restored. Returns the stage index the gate opens
   *  onto, or null when the gate is not in this pipeline's plan any more (the
   *  caller then resumes the ordinary way). Call holdBeforeStage(it) next. */
  async function beginAtGate(
    pipelineId: string,
    stages: readonly Stage[],
    gate: { gateId?: unknown; nextIndex?: unknown },
    restored: Record<string, NodeRunState> = {},
  ): Promise<number | null> {
    const gateId = typeof gate.gateId === 'string' ? gate.gateId : ''
    const nextIndex = typeof gate.nextIndex === 'number' ? gate.nextIndex : -1
    const built = await loadPlan(pipelineId, stages)
    if (!built) return null
    if (!built.gateIds.includes(gateId) || nextIndex < 0 || nextIndex > built.stageLayer.length) {
      deps.log(`DAG ⚠ the paused gate ${gateId || '?'} is no longer in this pipeline — resuming normally`)
      return null
    }
    plan.value = built
    run = createRunState(built, nextIndex, built.nodeLayer[gateId])
    for (const [id, st] of Object.entries(restored)) {
      // Only finished work carries over; anything that was in flight is
      // what the gate is about to decide on, or runs again after it.
      if (id in run.nodes && st && (st.status === 'done' || (st.status === 'skipped' && st.pinned))) {
        run.nodes[id] = { ...st }
      }
    }
    return nextIndex
  }

  function adoptOutputs(raw: unknown): void {
    if (raw && typeof raw === 'object') outputs = { ...(raw as Record<string, NodeOutput>) }
  }

  /** True when a gate must be resolved before stage `nextIndex` (or before
   *  completion); the run then waits on awaitingGate. */
  function holdBeforeStage(nextIndex: number): boolean {
    const p = plan.value
    if (!p || !run || !p.hasControlFlow) return false
    const pending = gatesBefore(p, run, nextIndex)
    if (!pending.length) return false
    const gateId = pending[0]
    const gateNode = p.graph.nodes.find((n) => n.id === gateId)
    run.gates[gateId] = 'awaiting'
    run.nodes[gateId] = { ...run.nodes[gateId], status: 'awaiting', startedAt: run.nodes[gateId]?.startedAt ?? now() }
    awaitingGate.value = { gateId, label: gateNode?.label || gateId, prompt: gateNode?.gate?.prompt ?? '', nextIndex }
    deps.log(`◆ Gate "${awaitingGate.value.label}" — waiting for approval`)
    void report()
    return true
  }

  function approve(gateId: string): boolean {
    if (!run || awaitingGate.value?.gateId !== gateId) return false
    approveGate(run, gateId, now())
    awaitingGate.value = null
    deps.log(`◆ Gate "${gateId}" ✓ approved`)
    void report()
    return true
  }

  function reject(gateId: string, comment = ''): RejectResult | null {
    const p = plan.value
    if (!p || !run || awaitingGate.value?.gateId !== gateId) return null
    const result = rejectGate(p, run, gateId, comment, now())
    awaitingGate.value = null
    void report()
    return result
  }

  function pinnedLabels(index: number): Set<string> {
    const p = plan.value
    return p && p.hasControlFlow ? planPinnedLabels(p, index) : new Set()
  }

  /** The re-run note for this stage, consumed by its activation. */
  function takeNote(index: number): string {
    if (!run || !(index in run.notes)) return ''
    const note = run.notes[index]
    delete run.notes[index]
    return `${note}\n\n`
  }

  /** True once a reject loop has sent this run back over stages it ran. */
  function looped(): boolean {
    return !!run?.looped
  }

  function nodeId(index: number, label: string): string {
    return plan.value ? slotNodeIdAt(plan.value, index, label) : ''
  }

  function slotStarted(index: number, label: string, paneId: string): void {
    const id = nodeId(index, label)
    if (!run || !id) return
    const prev = run.nodes[id]
    run.nodes[id] = { ...prev, status: 'running', startedAt: now(), endedAt: undefined, paneId, attempts: (prev?.attempts ?? 0) + 1 }
    void report()
  }

  function slotFinished(index: number, label: string, tail: string): void {
    const id = nodeId(index, label)
    if (!run || !id) return
    const prev = run.nodes[id]
    if (prev?.status === 'skipped') return
    const trimmed = tail.trim()
    const summary = trimmed.length > SUMMARY_CHARS ? `…${trimmed.slice(-SUMMARY_CHARS)}` : trimmed
    run.nodes[id] = { ...prev, status: 'done', endedAt: now(), summary }
    if (summary) {
      outputs[id] = { summary, at: now() }
      pendingOutputs[id] = outputs[id]
    }
    void report()
  }

  function summaryOf(id: string): string {
    return run?.nodes[id]?.summary || outputs[id]?.summary || ''
  }

  /** Expand {{prev.summary}} for a slot's kickoff. */
  function expandKickoff(text: string, index: number, label: string): string {
    const p = plan.value
    const id = nodeId(index, label)
    if (!p || !id) return expandPrevSummary(text, [])
    const upstream = upstreamSlotNodes(p, id).map((up) => ({
      label: p.graph.nodes.find((n) => n.id === up)?.label || up,
      summary: summaryOf(up) || '(no output recorded)',
    }))
    return expandPrevSummary(text, upstream)
  }

  /** Context lines for earlier nodes this run did not execute (pinned or
   *  before a restart point): they have no pane, so the normal pane-based
   *  context cannot see them. '' when there are none. */
  function frozenContext(index: number): string {
    const p = plan.value
    if (!p || !run) return ''
    const lines: string[] = []
    for (let s = 0; s < index; s++) {
      for (const id of p.stageNodeIds[s] ?? []) {
        if (run.nodes[id]?.status !== 'skipped') continue
        const label = p.graph.nodes.find((n) => n.id === id)?.label || id
        lines.push(`- [📌 ${label}] ${summaryOf(id) || '(no output recorded)'}`)
      }
    }
    return lines.length ? `[沿用的前置產出（未重跑）]\n${lines.join('\n')}\n\n` : ''
  }

  /** Close the run: anything still running or awaiting takes the outcome. */
  async function end(outcome: 'completed' | 'aborted' | 'failed'): Promise<void> {
    if (!run) return
    const final: NodeRunState['status'] = outcome === 'completed' ? 'done' : outcome === 'failed' ? 'failed' : 'aborted'
    // An abort is a pause: the gate it paused on stays recorded so a resume
    // goes back to waiting on it. Any other ending clears it.
    const keptGate = outcome === 'aborted' ? awaitingGate.value : null
    for (const [id, st] of Object.entries(run.nodes)) {
      if (st.status === 'running' || st.status === 'awaiting') run.nodes[id] = { ...st, status: final, endedAt: now() }
    }
    awaitingGate.value = null
    await report(keptGate)
  }

  return {
    plan,
    awaitingGate,
    nodeStates,
    begin,
    canRestartFrom,
    beginAtGate,
    adoptOutputs,
    holdBeforeStage,
    approve,
    reject,
    pinnedLabels,
    takeNote,
    looped,
    slotStarted,
    slotFinished,
    expandKickoff,
    frozenContext,
    end,
  }
}

export type PipelineDag = ReturnType<typeof usePipelineDag>

import { ref, shallowRef } from 'vue'
import type { Stage } from '../data/stages'
import type { NodeRunState, PipelineGraph } from '../lib/pipelineGraph'
import {
  approveGate,
  buildDagPlan,
  conditionalLabels as planConditionalLabels,
  createRunState,
  expandNodeOutputs,
  expandPrevSummary,
  gatesBefore,
  hasBranchEdge,
  hasErrorEdge,
  hasOutputContract,
  isUntaken,
  kickoffHints,
  newSignalNonce,
  parseNodeSignals,
  pinnedLabels as planPinnedLabels,
  readsFailure,
  rejectGate,
  restartPointFor,
  routeFailure as planRouteFailure,
  settleUntaken,
  slotNodeIdAt,
  takeRetry,
  untakenLabels as planUntakenLabels,
  upstreamSlotNodes,
  type DagPlan,
  type DagRunState,
  type NodeResult,
  type RejectResult,
  type RetryTurn,
} from '../lib/pipelineDagRun'

/** Characters of a finished slot's terminal tail kept as its summary. */
const SUMMARY_CHARS = 1200

export interface PipelineDagDeps {
  /** A request on the backend socket; resolves null on failure. Kept apart
   *  from the run's sendQuiet so node-state reporting stays a side channel. */
  send: (type: string, payload: Record<string, unknown>) => Promise<Record<string, unknown> | null>
  log: (line: string) => void
  workspacePath: () => string
  /** Called once when the run starts waiting on a gate (not again while it
   *  keeps waiting on the same one), so the user is told the run paused. */
  onGate?: (gate: AwaitingGate) => void
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
  /** Only for a node with branch edges / an output contract (see NodeResult). */
  branch?: string
  output?: unknown
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
  /** Each node's signal code for its latest kickoff, in memory only: never
   *  reported to the backend, so pipeline_status cannot hand it out. */
  let nonces = new Map<string, string>()
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
    nonces = new Map()
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
    nonces = new Map()
    for (const [id, st] of Object.entries(restored)) {
      // Only finished work carries over; anything that was in flight is
      // what the gate is about to decide on, or runs again after it. A
      // failure taken down an error edge is finished work too.
      if (id in run.nodes && st && (st.status === 'done' || (st.status === 'skipped' && st.pinned) || (st.status === 'failed' && st.errorRouted))) {
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
    settleUntaken(p, run, resultOf)
    const pending = gatesBefore(p, run, nextIndex)
    if (!pending.length) return false
    const gateId = pending[0]
    const gateNode = p.graph.nodes.find((n) => n.id === gateId)
    const already = awaitingGate.value?.gateId === gateId
    run.gates[gateId] = 'awaiting'
    run.nodes[gateId] = { ...run.nodes[gateId], status: 'awaiting', startedAt: run.nodes[gateId]?.startedAt ?? now() }
    awaitingGate.value = { gateId, label: gateNode?.label || gateId, prompt: gateNode?.gate?.prompt ?? '', nextIndex }
    deps.log(`◆ Gate "${awaitingGate.value.label}" — waiting for approval`)
    if (!already) deps.onGate?.(awaitingGate.value)
    void report()
    return true
  }

  function approve(gateId: string): boolean {
    if (!run || awaitingGate.value?.gateId !== gateId) return false
    approveGate(run, gateId, now())
    if (plan.value) settleUntaken(plan.value, run, resultOf)
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

  /** Slot labels of stage `index` none of whose inputs was taken: skipped,
   *  with no pane and no kickoff. Empty without branch/error edges. */
  function untakenLabels(index: number): Set<string> {
    const p = plan.value
    if (!p || !run || !p.hasBranching) return new Set()
    settleUntaken(p, run, resultOf)
    void report()
    return planUntakenLabels(p, run, index)
  }

  /** Slot labels of stage `index` the look-ahead pre-spawn must leave alone:
   *  whether they run is only known once their inputs finish. */
  function conditionalLabels(index: number): Set<string> {
    const p = plan.value
    return p && p.hasBranching ? planConditionalLabels(p, index) : new Set()
  }

  /** The failure a running slot reported with ---NODE-FAILED--- carrying
   *  its signal code, or '' — always '' for a node with neither an error edge
   *  nor a retry policy, which does not read the signal. `text` is what the
   *  caller trusts as the agent's own output (signalSource). */
  function reportedFailure(index: number, label: string, text: string): string {
    const p = plan.value
    const id = nodeId(index, label)
    if (!p || !run || !id || run.nodes[id]?.status !== 'running' || !readsFailure(p, id)) return ''
    return parseNodeSignals(text, nonces.get(id) ?? '').failed ?? ''
  }

  /** The signal code of this slot's latest kickoff, or '' when its kickoff
   *  asked for no signals. */
  function signalNonce(index: number, label: string): string {
    const id = nodeId(index, label)
    return (id && nonces.get(id)) || ''
  }

  /** One more try of a failed slot, if its retry policy has one left: the
   *  node goes back to pending and the caller re-runs it after waitMs. */
  function retryAfterFailure(index: number, label: string, reason: string): RetryTurn | null {
    const p = plan.value
    const id = nodeId(index, label)
    if (!p || !run || !id) return null
    const turn = takeRetry(p, run, id, reason)
    if (!turn) return null
    deps.log(`DAG ↻ "${label}" failed (${reason}) — retrying, try ${turn.attempt}/${turn.maxTries}` + (turn.waitMs ? ` in ${turn.waitMs} ms` : ''))
    void report()
    return turn
  }

  /** True when this slot's failures go down an error edge. */
  function routesFailure(index: number, label: string): boolean {
    const p = plan.value
    const id = nodeId(index, label)
    return !!p && !!id && hasErrorEdge(p, id)
  }

  /** A failed slot with an error edge: fail its node down that edge and let
   *  the run go on. false when it has none (the run fails as before). */
  function routeFailure(index: number, label: string, error: string): boolean {
    const p = plan.value
    const id = nodeId(index, label)
    if (!p || !run || !id || !planRouteFailure(p, run, id, error, now())) return false
    deps.log(`DAG ↯ "${label}" failed — taking its error edge (${error})`)
    settleUntaken(p, run, resultOf)
    void report()
    return true
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

  /** `tail` becomes the node's summary; signals are read from `signals`
   *  (what the caller trusts as the agent's own output), or from `tail` when
   *  it is not given. Either way only signals with the node's code count. */
  function slotFinished(index: number, label: string, tail: string, signals?: string): void {
    const id = nodeId(index, label)
    if (!run || !id) return
    const prev = run.nodes[id]
    // Skipped, or already failed down its error edge (its kickoff never
    // landed): a late completion signal changes nothing.
    if (prev?.status === 'skipped' || (prev?.status === 'failed' && prev.errorRouted)) return
    const trimmed = tail.trim()
    const summary = trimmed.length > SUMMARY_CHARS ? `…${trimmed.slice(-SUMMARY_CHARS)}` : trimmed
    const p = plan.value!
    // Signals are read only for a node whose edges or readers ask for them,
    // so a legacy node's recorded state is exactly what it always was.
    const wantBranch = hasBranchEdge(p, id)
    const wantOutput = hasOutputContract(p, id)
    const wantFailure = hasErrorEdge(p, id)
    const found = wantBranch || wantOutput || wantFailure ? parseNodeSignals(signals ?? tail, nonces.get(id) ?? '') : {}
    const result: NodeResult = {}
    if (wantBranch && found.branch !== undefined) result.branch = found.branch
    if (wantOutput && found.output) {
      result.output = found.output.value
      if (found.output.parseError) deps.log(`DAG ⚠ "${label}" output is not valid JSON (${found.output.parseError}) — stored as null`)
    }
    if (wantFailure && found.failed !== undefined) {
      run.nodes[id] = { ...prev, status: 'failed', endedAt: now(), summary, error: found.failed, errorRouted: true }
      deps.log(`DAG ↯ "${label}" reported a failure — taking its error edge (${found.failed})`)
    } else {
      run.nodes[id] = { ...prev, status: 'done', endedAt: now(), summary, ...result }
    }
    if (summary || 'branch' in result || 'output' in result) {
      outputs[id] = { summary, at: now(), ...result }
      pendingOutputs[id] = outputs[id]
    }
    settleUntaken(p, run, resultOf)
    void report()
  }

  /** The slot cannot run (its kickoff never reached the agent): failed, with
   *  the reason for the canvas and pipeline_status. */
  function slotFailed(index: number, label: string, error: string): void {
    const id = nodeId(index, label)
    if (!run || !id) return
    run.nodes[id] = { ...run.nodes[id], status: 'failed', endedAt: now(), error }
    void report()
  }

  function summaryOf(id: string): string {
    return run?.nodes[id]?.summary || outputs[id]?.summary || ''
  }

  /** Branch value and structured output of a finished (or reused) node. */
  function resultOf(id: string): NodeResult {
    const st = run?.nodes[id]
    // A node that ran this run answers for itself; a reused one (pin,
    // restart point, resume) falls back to what it recorded last time.
    const live = st?.status === 'done' || st?.status === 'failed'
    const result: NodeResult = {}
    const branch = live ? st?.branch : outputs[id]?.branch
    if (branch !== undefined) result.branch = branch
    const output = live ? st?.output : outputs[id]?.output
    if (output !== undefined) result.output = output
    return result
  }

  /** Expand {{prev.summary}} and {{node.<id>.output}} for a slot's kickoff,
   *  and append the signal instructions its edges need (none for a legacy
   *  node, whose kickoff is then unchanged). */
  function expandKickoff(text: string, index: number, label: string): string {
    const p = plan.value
    const id = nodeId(index, label)
    if (!p || !id) return expandPrevSummary(text, [])
    const upstream = upstreamSlotNodes(p, id)
      .filter((up) => !isUntaken(run?.nodes[up]))
      .map((up) => ({
        label: p.graph.nodes.find((n) => n.id === up)?.label || up,
        summary: summaryOf(up) || '(no output recorded)',
      }))
    const expanded = expandNodeOutputs(expandPrevSummary(text, upstream), p.graph, (up) => resultOf(up).output)
    // A new code for every kickoff of the node: an earlier try's signals, or
    // the screen of a previous run, can never answer this one.
    const nonce = newSignalNonce()
    const hints = kickoffHints(p, id, nonce)
    if (hints) nonces.set(id, nonce)
    else nonces.delete(id)
    return expanded + hints
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
        if (run.nodes[id]?.status !== 'skipped' || isUntaken(run.nodes[id])) continue
        const label = p.graph.nodes.find((n) => n.id === id)?.label || id
        lines.push(`- [📌 ${label}] ${summaryOf(id) || '(no output recorded)'}`)
      }
    }
    return lines.length ? `[沿用的前置產出（未重跑）]\n${lines.join('\n')}\n\n` : ''
  }

  /** Close the run: anything still running or awaiting takes the outcome.
   *  `reason` is recorded as their `error` when the run failed because of
   *  something else (#448: another slot's kickoff), so they do not look broken
   *  themselves. */
  async function end(outcome: 'completed' | 'aborted' | 'failed', reason?: string): Promise<void> {
    if (!run) return
    const final: NodeRunState['status'] = outcome === 'completed' ? 'done' : outcome === 'failed' ? 'failed' : 'aborted'
    // An abort is a pause: the gate it paused on stays recorded so a resume
    // goes back to waiting on it. Any other ending clears it.
    const keptGate = outcome === 'aborted' ? awaitingGate.value : null
    for (const [id, st] of Object.entries(run.nodes)) {
      if (st.status === 'running' || st.status === 'awaiting') {
        run.nodes[id] = { ...st, status: final, endedAt: now(), ...(reason ? { error: reason } : {}) }
      }
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
    untakenLabels,
    conditionalLabels,
    routeFailure,
    reportedFailure,
    signalNonce,
    retryAfterFailure,
    routesFailure,
    takeNote,
    looped,
    slotStarted,
    slotFinished,
    slotFailed,
    expandKickoff,
    frozenContext,
    end,
  }
}

export type PipelineDag = ReturnType<typeof usePipelineDag>

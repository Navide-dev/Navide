/**
 * Drives the DAG engine's hooks through every legacy run shape (no branch or
 * error edges) and records everything they return, report and log, with
 * timestamps blanked. pipelineLegacyCompat.test.ts compares the trace with
 * pipelineLegacyCompat.expected.json, which was recorded from the engine as
 * it was before branch/error edges existed (R8: legacy runs stay identical).
 *
 * Only hooks that existed before that change are called, so the same driver
 * runs against both engines.
 */
import type { Stage } from '../../data/stages'
import type { PipelineGraph } from '../pipelineGraph'

interface GraphModule {
  applyGraphOps: (g: PipelineGraph, ops: unknown[]) => PipelineGraph
  deriveGraphFromStages: (stages: readonly Stage[]) => PipelineGraph
  deriveStagesFromGraph: (g: PipelineGraph, previous?: readonly Stage[]) => Stage[]
  isLinearGraph: (g: PipelineGraph) => boolean
  layerGraph: (g: PipelineGraph) => unknown
  validateGraph: (g: PipelineGraph) => string[]
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DagFactory = (deps: any) => any

function stage(id: string, labels: string[]): Stage {
  return {
    id, title: id, shortTitle: id, question: '', description: '', recommendedRoles: [], sentinel: '', allowQuestions: false, docQuery: '',
    slots: labels.map((label) => ({ agentKey: 'claude', roleKey: 'pm', label, kickoffBody: `do ${label}` })),
  } as Stage
}

/** A reply that also carries every new signal: a legacy node must ignore them. */
function reply(label: string): string {
  return [
    `${label} finished the work`,
    '---BRANCH: yes---',
    '---NODE-FAILED: nope---',
    '---OUTPUT-START---',
    '{"status": "ok"}',
    '---OUTPUT-END---',
    '---STAGE-DONE---',
  ].join('\n')
}

const KICKOFF = 'Context: {{prev.summary}}\nTask: {{task}}'

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g

function blank<T>(v: T): T {
  return JSON.parse(JSON.stringify(v ?? null).replace(ISO, 'T'))
}

export async function legacyTrace(graphs: GraphModule, usePipelineDag: DagFactory): Promise<Record<string, unknown>> {
  const LINEAR = [stage('01', ['a']), stage('02', ['b']), stage('03', ['c'])]
  const PARALLEL = [stage('01', ['a']), stage('02', ['b1', 'b2']), stage('03', ['c'])]
  const gated = graphs.applyGraphOps(graphs.deriveGraphFromStages(PARALLEL), [
    { op: 'add_node', node: { id: 'gate', kind: 'gate', label: 'Approve', position: { x: 0, y: 0 }, gate: { prompt: 'check it' } }, after: ['n-02-0', 'n-02-1'], before: ['n-03-0'] },
  ])
  const looping = graphs.applyGraphOps(gated, [
    { op: 'add_edge', edge: { id: 'rej', from: 'gate', to: 'n-02-0', kind: 'reject', maxLoops: 2 } },
  ])
  const pinned = graphs.applyGraphOps(graphs.deriveGraphFromStages(LINEAR), [
    { op: 'set_pin', id: 'n-01-0', pinned: true },
  ])
  const front = graphs.applyGraphOps(graphs.deriveGraphFromStages(LINEAR), [
    { op: 'add_node', node: { id: 'g0', kind: 'gate', label: 'Go?', position: { x: 0, y: 0 } }, after: ['trigger'], before: ['n-01-0'] },
  ])

  const out: Record<string, unknown> = {}

  out.graphs = Object.fromEntries(
    Object.entries({ linear: graphs.deriveGraphFromStages(LINEAR), parallel: graphs.deriveGraphFromStages(PARALLEL), gated, looping, pinned, front })
      .map(([k, g]) => [k, {
        layers: graphs.layerGraph(g),
        errors: graphs.validateGraph(g),
        linear: graphs.isLinearGraph(g),
        stages: graphs.deriveStagesFromGraph(g, PARALLEL).map((s) => [s.id, s.slots.map((sl) => sl.label)]),
      }]),
  )

  function harness(graph: PipelineGraph | null) {
    const log: string[] = []
    const reports: unknown[] = []
    const gates: unknown[] = []
    const dag = usePipelineDag({
      send: async (type: string, payload: Record<string, unknown>) => {
        if (type === 'pipelines.graph.get') return graph ? { derived: false, graph } : { derived: true }
        reports.push(blank(payload))
        return {}
      },
      log: (line: string) => log.push(line),
      workspacePath: () => '/ws',
      onGate: (g: unknown) => gates.push(blank(g)),
    })
    const steps: unknown[] = []
    /** Run stages from..to-1 the way App.vue does: hold check, then each slot. */
    const runStages = (stages: Stage[], from: number, to: number): boolean => {
      for (let i = from; i < to; i++) {
        if (dag.holdBeforeStage(i)) { steps.push(['hold', i]); return false }
        const pins = [...dag.pinnedLabels(i)]
        steps.push(['stage', i, pins, dag.takeNote(i), dag.frozenContext(i)])
        for (const slot of stages[i].slots) {
          if (pins.includes(slot.label)) continue
          steps.push(['kickoff', i, slot.label, dag.expandKickoff(KICKOFF, i, slot.label)])
          dag.slotStarted(i, slot.label, `pane-${slot.label}`)
          dag.slotFinished(i, slot.label, reply(slot.label))
        }
      }
      steps.push(['hold-end', dag.holdBeforeStage(to)])
      return true
    }
    const done = async (outcome: 'completed' | 'aborted' | 'failed' = 'completed', reason?: string) => {
      await dag.end(outcome, reason)
      await new Promise((r) => setTimeout(r, 0))
      return blank({ steps, log, gates, reports, nodeStates: dag.nodeStates.value, looped: dag.looped() })
    }
    return { dag, steps, runStages, done }
  }

  {
    const h = harness(null)
    h.steps.push(['begin', await h.dag.begin('p', LINEAR)])
    h.runStages(LINEAR, 0, 3)
    out.linear = await h.done()
  }
  {
    const stages = graphs.deriveStagesFromGraph(graphs.deriveGraphFromStages(PARALLEL), PARALLEL)
    const h = harness(graphs.deriveGraphFromStages(PARALLEL))
    h.steps.push(['begin', await h.dag.begin('p', stages)])
    h.runStages(stages, 0, 3)
    out.parallel = await h.done()
  }
  {
    const stages = graphs.deriveStagesFromGraph(gated, PARALLEL)
    const h = harness(gated)
    h.steps.push(['begin', await h.dag.begin('p', stages)])
    h.runStages(stages, 0, 3)
    h.steps.push(['approve', h.dag.approve('gate')])
    h.runStages(stages, 2, 3)
    out.gate = await h.done()
  }
  {
    const stages = graphs.deriveStagesFromGraph(looping, PARALLEL)
    const h = harness(looping)
    h.steps.push(['begin', await h.dag.begin('p', stages)])
    h.runStages(stages, 0, 3)
    for (let k = 0; k < 3; k++) {
      const r = h.dag.reject('gate', `round ${k}`)
      h.steps.push(['reject', blank(r)])
      if (r?.kind !== 'loop') break
      h.runStages(stages, r.targetIndex, 3)
    }
    out.rejectLoop = await h.done('failed')
  }
  {
    const stages = graphs.deriveStagesFromGraph(pinned, LINEAR)
    const h = harness(pinned)
    h.steps.push(['begin', await h.dag.begin('p', stages)])
    h.dag.adoptOutputs({ 'n-01-0': { summary: 'frozen a', at: '2026-01-01T00:00:00Z' } })
    h.runStages(stages, 0, 3)
    out.pin = await h.done()
  }
  {
    const stages = graphs.deriveStagesFromGraph(pinned, LINEAR)
    const h = harness(pinned)
    h.steps.push(['canRestart', await h.dag.canRestartFrom('p', stages, 'n-02-0'), await h.dag.canRestartFrom('p', stages, 'nope')])
    h.steps.push(['begin', await h.dag.begin('p', stages, { fromNodeId: 'n-02-0' })])
    h.dag.adoptOutputs({ 'n-01-0': { summary: 'old a', at: '2026-01-01T00:00:00Z' } })
    h.runStages(stages, 1, 3)
    out.restartFrom = await h.done()
  }
  {
    const h = harness(front)
    const stages = graphs.deriveStagesFromGraph(front, LINEAR)
    h.steps.push(['begin', await h.dag.begin('p', stages)])
    h.runStages(stages, 0, 3)
    h.steps.push(['approve', h.dag.approve('g0')])
    h.runStages(stages, 0, 3)
    out.frontGate = await h.done('aborted')
  }
  {
    const stages = graphs.deriveStagesFromGraph(gated, PARALLEL)
    const h = harness(gated)
    h.steps.push(['beginAtGate', await h.dag.beginAtGate('p', stages, { gateId: 'gate', nextIndex: 2 }, {
      'n-01-0': { status: 'done', summary: 'a out' },
      'n-02-0': { status: 'done', summary: 'b1 out' },
      'n-02-1': { status: 'running' },
    })])
    h.runStages(stages, 2, 3)
    h.steps.push(['approve', h.dag.approve('gate')])
    h.runStages(stages, 2, 3)
    out.resumeAtGate = await h.done()
  }
  {
    const h = harness(null)
    h.steps.push(['begin', await h.dag.begin('p', LINEAR, { startIndex: 1 })])
    h.runStages(LINEAR, 1, 3)
    out.resume = await h.done()
  }
  {
    const h = harness(graphs.deriveGraphFromStages(PARALLEL))
    h.steps.push(['begin', await h.dag.begin('p', PARALLEL)])
    h.runStages(PARALLEL, 0, 1)
    h.dag.slotStarted(1, 'b1', 'pane-b1')
    h.dag.slotStarted(1, 'b2', 'pane-b2')
    h.dag.slotFailed(1, 'b1', 'kickoff never reached the agent')
    out.kickoffFailed = await h.done('failed', 'run stopped: slot "b1" failed')
  }
  return out
}

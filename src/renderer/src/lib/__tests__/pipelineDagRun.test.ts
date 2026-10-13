import { describe, expect, it } from 'vitest'
import type { Stage } from '../../data/stages'
import { applyGraphOps, deriveGraphFromStages, deriveStagesFromGraph, type PipelineGraph } from '../pipelineGraph'
import {
  approveGate,
  buildDagPlan,
  createRunState,
  expandPrevSummary,
  gatesBefore,
  pinnedLabels,
  rejectGate,
  restartPointFor,
  upstreamSlotNodes,
} from '../pipelineDagRun'

function stage(id: string, labels: string[]): Stage {
  return {
    id, title: id, shortTitle: id, question: '', description: '', recommendedRoles: [], sentinel: '', allowQuestions: false, docQuery: '',
    slots: labels.map((label) => ({ agentKey: 'claude', roleKey: '', label, kickoffBody: '' })),
  } as Stage
}

const LEGACY = [stage('01', ['plan']), stage('02', ['fe', 'be']), stage('03', ['review'])]

/** plan → fe/be → gate → review, review rejects back to fe/be's layer. */
function gated(): { graph: PipelineGraph; stages: Stage[] } {
  const graph = applyGraphOps(deriveGraphFromStages(LEGACY), [
    { op: 'add_node', node: { id: 'gate', kind: 'gate', label: 'Approve', position: { x: 0, y: 0 } }, after: ['n-02-0', 'n-02-1'], before: ['n-03-0'] },
    { op: 'add_edge', edge: { id: 'rej', from: 'gate', to: 'n-02-0', kind: 'reject', maxLoops: 2 } },
  ])
  return { graph, stages: deriveStagesFromGraph(graph, LEGACY) }
}

describe('buildDagPlan', () => {
  it('a legacy pipeline has no control flow and one node list per stage', () => {
    const plan = buildDagPlan(null, LEGACY)
    expect(plan.hasControlFlow).toBe(false)
    expect(plan.stageNodeIds).toEqual([['n-01-0'], ['n-02-0', 'n-02-1'], ['n-03-0']])
    const state = createRunState(plan)
    for (let i = 0; i <= LEGACY.length; i++) expect(gatesBefore(plan, state, i)).toEqual([])
    expect(pinnedLabels(plan, 0).size).toBe(0)
  })

  it('falls back to the stages when the graph does not match them', () => {
    const { graph } = gated()
    const plan = buildDagPlan(graph, [stage('01', ['other'])])
    expect(plan.hasControlFlow).toBe(false)
    expect(plan.stageNodeIds).toEqual([['n-01-0']])
  })
})

describe('gates and reject loops', () => {
  it('pauses before the stage after the gate, not before', () => {
    const { graph, stages } = gated()
    const plan = buildDagPlan(graph, stages)
    expect(plan.hasControlFlow).toBe(true)
    const s = createRunState(plan)
    expect(gatesBefore(plan, s, 1)).toEqual([])
    expect(gatesBefore(plan, s, 2)).toEqual(['gate'])
    approveGate(s, 'gate')
    expect(gatesBefore(plan, s, 2)).toEqual([])
    expect(s.nodes.gate.status).toBe('done')
  })

  it('reject loops back to the target layer with a note, bounded by maxLoops', () => {
    const { graph, stages } = gated()
    const plan = buildDagPlan(graph, stages)
    const s = createRunState(plan)
    s.nodes['n-02-0'] = { status: 'done' }
    const r1 = rejectGate(plan, s, 'gate', 'tests fail')
    expect(r1).toEqual({ kind: 'loop', edgeId: 'rej', targetIndex: 1, count: 1, max: 2 })
    expect(s.nodes['n-02-0'].status).toBe('pending')
    expect(s.gates.gate).toBe('pending')
    expect(s.notes[1]).toMatch(/tests fail/)
    expect(s.looped).toBe(true)
    expect(rejectGate(plan, s, 'gate').kind).toBe('loop')
    expect(rejectGate(plan, s, 'gate')).toEqual({ kind: 'exhausted', edgeId: 'rej', max: 2 })
  })

  it('a gate without a reject edge reports no-edge', () => {
    const graph = applyGraphOps(deriveGraphFromStages(LEGACY), [
      { op: 'add_node', node: { id: 'g', kind: 'gate', position: { x: 0, y: 0 } }, after: ['n-03-0'] },
    ])
    const plan = buildDagPlan(graph, deriveStagesFromGraph(graph, LEGACY))
    const s = createRunState(plan)
    expect(gatesBefore(plan, s, 3)).toEqual(['g']) // before completion
    expect(rejectGate(plan, s, 'g')).toEqual({ kind: 'no-edge' })
  })
})

describe('pins, restart-from and upstream', () => {
  it('pinned nodes are skipped and reported per stage', () => {
    const graph = applyGraphOps(deriveGraphFromStages(LEGACY), [{ op: 'set_pin', id: 'n-02-1', pinned: true }])
    const plan = buildDagPlan(graph, LEGACY)
    expect(plan.hasControlFlow).toBe(true)
    expect([...pinnedLabels(plan, 1)]).toEqual(['be'])
    expect(createRunState(plan).nodes['n-02-1']).toEqual({ status: 'skipped', pinned: true })
  })

  it('restart-from maps a node to its stage and skips the ones before', () => {
    const { graph, stages } = gated()
    const plan = buildDagPlan(graph, stages)
    expect(restartPointFor(plan, 'n-03-0')).toEqual({ index: 2, layer: 3 })
    expect(restartPointFor(plan, 'gate')).toEqual({ index: 2, layer: 2 })
    expect(restartPointFor(plan, 'nope')).toBeNull()
    const atReview = createRunState(plan, 2, 3)
    expect(atReview.nodes['n-01-0'].status).toBe('skipped')
    expect(atReview.nodes['n-03-0'].status).toBe('pending')
    expect(gatesBefore(plan, atReview, 2)).toEqual([])
    // Restarting AT the gate stops on it before review runs.
    expect(gatesBefore(plan, createRunState(plan, 2, 2), 2)).toEqual(['gate'])
  })

  it('upstream looks through gates', () => {
    const { graph, stages } = gated()
    const plan = buildDagPlan(graph, stages)
    expect(upstreamSlotNodes(plan, 'n-03-0').sort()).toEqual(['n-02-0', 'n-02-1'])
  })

  it('expands {{prev.summary}} and leaves other text alone', () => {
    expect(expandPrevSummary('plain', [])).toBe('plain')
    expect(expandPrevSummary('do: {{prev.summary}}', [{ label: 'a', summary: 'S' }])).toBe('do: S')
    expect(expandPrevSummary('{{prev.summary}}', [{ label: 'a', summary: '1' }, { label: 'b', summary: '2' }])).toBe('[a]\n1\n\n[b]\n2')
  })
})

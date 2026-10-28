import { describe, expect, it } from 'vitest'
import { usePipelineDag } from '../../composables/usePipelineDag'
import { applyGraphOps, deriveGraphFromStages, deriveStagesFromGraph, validateGraph, type PipelineGraph } from '../pipelineGraph'
import { buildDagPlan, createRunState, kickoffHints, rejectGate, takeRetry } from '../pipelineDagRun'
import type { Stage } from '../../data/stages'

function stage(id: string, labels: string[]): Stage {
  return {
    id, title: id, shortTitle: id, question: '', description: '', recommendedRoles: [], sentinel: '', allowQuestions: false, docQuery: '',
    slots: labels.map((label) => ({ agentKey: 'claude', roleKey: '', label, kickoffBody: `do ${label}` })),
  } as Stage
}
const STAGES = [stage('01', ['a']), stage('02', ['b'])]

/** The policy written onto the node as stored, unchecked (validateGraph's input). */
function withRetry(retry: unknown): PipelineGraph {
  const g = deriveGraphFromStages(STAGES)
  g.nodes.find((n) => n.id === 'n-01-0')!.retry = retry as never
  return g
}

describe('retry policy: validation (mirrors the backend)', () => {
  it('accepts maxTries 1..5 and waitMs 0..300000 on a slot', () => {
    expect(validateGraph(withRetry({ maxTries: 5, waitMs: 300000 }))).toEqual([])
    expect(validateGraph(withRetry({ maxTries: 1 }))).toEqual([])
  })

  it.each([
    [{ maxTries: 0 }, 'node n-01-0: retry.maxTries must be an integer 1..5'],
    [{ maxTries: 6 }, 'node n-01-0: retry.maxTries must be an integer 1..5'],
    [{ maxTries: 2.5 }, 'node n-01-0: retry.maxTries must be an integer 1..5'],
    [{ maxTries: 2, waitMs: -1 }, 'node n-01-0: retry.waitMs must be an integer 0..300000'],
    [{ maxTries: 2, waitMs: 300001 }, 'node n-01-0: retry.waitMs must be an integer 0..300000'],
    [{ maxTries: 2, backoff: 2 }, 'node n-01-0: retry takes only maxTries and waitMs'],
    [[2], 'node n-01-0: retry must be {maxTries, waitMs?}'],
  ])('refuses %j', (retry, msg) => {
    expect(validateGraph(withRetry(retry))).toContain(msg)
  })

  it('only slot nodes carry retry, and set_retry with null removes it', () => {
    const g = withRetry({ maxTries: 3 })
    g.nodes[0].retry = { maxTries: 2 }
    expect(validateGraph(g)).toContain('node trigger: only slot and subpipeline nodes carry retry')
    const set = applyGraphOps(deriveGraphFromStages(STAGES), [{ op: 'set_retry', id: 'n-01-0', retry: { maxTries: 3, waitMs: 10 } }])
    expect(set.nodes.find((n) => n.id === 'n-01-0')!.retry).toEqual({ maxTries: 3, waitMs: 10 })
    const cleared = applyGraphOps(set, [{ op: 'set_retry', id: 'n-01-0', retry: null }])
    expect(cleared.nodes.find((n) => n.id === 'n-01-0')!.retry).toBeUndefined()
    expect(() => applyGraphOps(cleared, [{ op: 'set_retry', id: 'trigger', retry: { maxTries: 2 } }])).toThrow('only slot and subpipeline nodes can retry')
  })
})

describe('retry turns', () => {
  it('takes maxTries - 1 retries, then answers null', () => {
    const g = withRetry({ maxTries: 3, waitMs: 1500 })
    const plan = buildDagPlan(g, deriveStagesFromGraph(g, STAGES))
    const state = createRunState(plan)
    expect(takeRetry(plan, state, 'n-01-0', 'boom')).toMatchObject({ attempt: 2, maxTries: 3, waitMs: 1500 })
    expect(state.nodes['n-01-0']).toMatchObject({ status: 'pending', error: 'boom' })
    expect(takeRetry(plan, state, 'n-01-0', 'boom again')?.note).toBe('[重試 第 3/3 次 — 上次失敗：boom again]')
    expect(takeRetry(plan, state, 'n-01-0', 'third')).toBeNull()
    expect(takeRetry(plan, state, 'n-02-0', 'no policy')).toBeNull()
  })

  it('maxTries 1 means no retry', () => {
    const g = withRetry({ maxTries: 1 })
    const plan = buildDagPlan(g, deriveStagesFromGraph(g, STAGES))
    expect(takeRetry(plan, createRunState(plan), 'n-01-0', 'x')).toBeNull()
  })

  it('a reject loop gives the nodes it re-runs their tries back', () => {
    const g = applyGraphOps(withRetry({ maxTries: 2 }), [
      { op: 'add_node', node: { id: 'gate', kind: 'gate', position: { x: 0, y: 0 } }, after: ['n-02-0'] },
      { op: 'add_edge', edge: { id: 'rej', from: 'gate', to: 'n-01-0', kind: 'reject', maxLoops: 2 } },
    ])
    const plan = buildDagPlan(g, deriveStagesFromGraph(g, STAGES))
    const state = createRunState(plan)
    expect(takeRetry(plan, state, 'n-01-0', 'x')).not.toBeNull()
    expect(takeRetry(plan, state, 'n-01-0', 'x')).toBeNull()
    expect(rejectGate(plan, state, 'gate').kind).toBe('loop')
    expect(takeRetry(plan, state, 'n-01-0', 'x')).not.toBeNull()
  })

  it('a retrying node is told how to report a failure; a legacy node is not', () => {
    const g = withRetry({ maxTries: 2 })
    const plan = buildDagPlan(g, deriveStagesFromGraph(g, STAGES))
    expect(kickoffHints(plan, 'n-01-0')).toContain('這一步會重試')
    expect(kickoffHints(plan, 'n-02-0')).toBe('')
  })
})

describe('usePipelineDag reads ---NODE-FAILED--- only where it is asked for', () => {
  async function dagFor(graph: PipelineGraph | null) {
    const dag = usePipelineDag({
      send: async (type) => (type === 'pipelines.graph.get' ? (graph ? { derived: false, graph } : { derived: true }) : {}),
      log: () => {},
      workspacePath: () => '/ws',
    })
    await dag.begin('p', graph ? deriveStagesFromGraph(graph, STAGES) : STAGES)
    return dag
  }

  it('a legacy node never reports a failure or retries (R8)', async () => {
    const dag = await dagFor(null)
    dag.slotStarted(0, 'a', 'pane-a')
    expect(dag.reportedFailure(0, 'a', 'x\n---NODE-FAILED: broke---')).toBe('')
    expect(dag.retryAfterFailure(0, 'a', 'broke')).toBeNull()
    expect(dag.routesFailure(0, 'a')).toBe(false)
  })

  it('a retrying node reports while running, retries, and is quiet while it waits', async () => {
    const dag = await dagFor(withRetry({ maxTries: 2 }))
    expect(dag.reportedFailure(0, 'a', '---NODE-FAILED: broke---')).toBe('')
    dag.slotStarted(0, 'a', 'pane-a')
    expect(dag.reportedFailure(0, 'a', 'x\n---NODE-FAILED: broke---')).toBe('broke')
    expect(dag.retryAfterFailure(0, 'a', 'broke')).toMatchObject({ attempt: 2 })
    // Pending until the retry's kickoff: a late signal from the failed try is ignored.
    expect(dag.reportedFailure(0, 'a', '---NODE-FAILED: broke---')).toBe('')
    dag.slotStarted(0, 'a', 'pane-a')
    expect(dag.nodeStates.value['n-01-0']).toMatchObject({ status: 'running', attempts: 2 })
    expect(dag.retryAfterFailure(0, 'a', 'broke twice')).toBeNull()
  })
})

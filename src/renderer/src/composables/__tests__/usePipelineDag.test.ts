import { describe, expect, it } from 'vitest'
import { usePipelineDag, type AwaitingGate } from '../usePipelineDag'
import { applyGraphOps, deriveGraphFromStages } from '../../lib/pipelineGraph'
import type { Stage } from '../../data/stages'

const STAGES = [{
  id: '01', title: '01', shortTitle: '01', question: '', description: '', recommendedRoles: [],
  sentinel: '', allowQuestions: false, docQuery: '',
  slots: [{ agentKey: 'claude', roleKey: '', label: 'a', kickoffBody: '' }, { agentKey: 'claude', roleKey: '', label: 'b', kickoffBody: '' }],
}] as unknown as Stage[]

describe('usePipelineDag node-state reporting', () => {
  it('a slot output whose report failed is sent again with the next report', async () => {
    const reports: Array<Record<string, unknown>> = []
    let failNext = false
    const dag = usePipelineDag({
      send: async (type, payload) => {
        if (type === 'pipelines.graph.get') return { derived: true }
        if (failNext) { failNext = false; return null }
        reports.push(payload)
        return {}
      },
      log: () => {},
      workspacePath: () => '/ws',
    })
    await dag.begin('p1', STAGES)
    await new Promise((r) => setTimeout(r, 0))
    failNext = true
    dag.slotFinished(0, 'a', 'output of a')
    dag.slotFinished(0, 'b', 'output of b')
    await dag.end('completed')
    const sentOutputs = Object.assign({}, ...reports.map((r) => (r.outputs as Record<string, unknown>) ?? {}))
    expect(Object.keys(sentOutputs).sort()).toEqual(['n-01-0', 'n-01-1'])
  })

  // #448: a slot whose kickoff never landed is failed with its reason, and
  // closing the run does not overwrite either.
  it('a failed slot reports failed with its reason, and keeps both when the run ends', async () => {
    const reports: Array<Record<string, unknown>> = []
    const dag = usePipelineDag({
      send: async (type, payload) => {
        if (type === 'pipelines.graph.get') return { derived: true }
        reports.push(payload)
        return {}
      },
      log: () => {},
      workspacePath: () => '/ws',
    })
    await dag.begin('p1', STAGES)
    await new Promise((r) => setTimeout(r, 0))
    dag.slotStarted(0, 'a', 'pane-a')
    dag.slotStarted(0, 'b', 'pane-b')
    dag.slotFailed(0, 'a', 'kickoff never reached the agent')
    await dag.end('failed', 'run stopped: slot "a" failed')
    const last = reports[reports.length - 1].nodes as Record<string, { status: string; error?: string }>
    expect(last['n-01-0']).toMatchObject({ status: 'failed', error: 'kickoff never reached the agent' })
    // A sibling stopped with the run says why, instead of looking broken itself.
    expect(last['n-01-1']).toMatchObject({ status: 'failed', error: 'run stopped: slot "a" failed' })
    expect(dag.nodeStates.value['n-01-0'].error).toBe('kickoff never reached the agent')
  })
})

describe('usePipelineDag gate notice', () => {
  const TWO_STAGES = [
    { id: '01', title: '01', shortTitle: '01', sentinel: '', slots: [{ agentKey: 'claude', roleKey: '', label: 'a', kickoffBody: '' }] },
    { id: '02', title: '02', shortTitle: '02', sentinel: '', slots: [{ agentKey: 'claude', roleKey: '', label: 'b', kickoffBody: '' }] },
  ] as unknown as Stage[]

  it('tells onGate once when the run starts waiting, not again while it keeps waiting', async () => {
    const graph = applyGraphOps(deriveGraphFromStages(TWO_STAGES), [
      { op: 'add_node', node: { id: 'gate', kind: 'gate', label: 'OK?', position: { x: 0, y: 0 } }, after: ['n-01-0'], before: ['n-02-0'] },
    ])
    const gates: AwaitingGate[] = []
    const dag = usePipelineDag({
      send: async (type) => (type === 'pipelines.graph.get' ? { derived: false, graph } : {}),
      log: () => {},
      workspacePath: () => '/ws',
      onGate: (gate) => gates.push(gate),
    })
    expect(await dag.begin('p1', TWO_STAGES)).toBe(0)
    expect(dag.holdBeforeStage(1)).toBe(true)
    expect(dag.holdBeforeStage(1)).toBe(true)
    expect(gates).toEqual([{ gateId: 'gate', label: 'OK?', prompt: '', nextIndex: 1 }])
    expect(dag.approve('gate')).toBe(true)
    expect(dag.holdBeforeStage(1)).toBe(false)
    expect(gates).toHaveLength(1)
  })
})

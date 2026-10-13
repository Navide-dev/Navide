import { describe, expect, it } from 'vitest'
import { usePipelineDag } from '../usePipelineDag'
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
})

import { describe, expect, it } from 'vitest'
import { applyGraphOps, deriveStagesFromGraph, layerGraph, subpipelineCycleErrors, validateGraph, type GraphNode, type PipelineGraph } from '../pipelineGraph'

function slot(id: string): GraphNode {
  return { id, kind: 'slot', label: id, position: { x: 0, y: 0 }, slot: { agentKey: 'claude', roleKey: '', label: id, kickoffBody: '' } }
}
function sub(id: string, config: unknown): GraphNode {
  return { id, kind: 'subpipeline', label: id, position: { x: 0, y: 0 }, subpipeline: config as never }
}
/** trigger → a → call(B) → b; the backend twin is calling_graph() in test_pipeline_graph.py. */
function calling(config: unknown = { pipelineId: 'B', task: 'do {{task}}', wait: true }): PipelineGraph {
  return {
    version: 1,
    nodes: [{ id: 'trigger', kind: 'trigger', position: { x: 0, y: 0 } }, slot('a'), sub('call', config), slot('b')],
    edges: [
      { id: 'e-trigger-a', from: 'trigger', to: 'a', kind: 'main' },
      { id: 'e-a-call', from: 'a', to: 'call', kind: 'main' },
      { id: 'e-call-b', from: 'call', to: 'b', kind: 'main' },
    ],
  }
}
const empty: PipelineGraph = { version: 1, nodes: [], edges: [] }

describe('subpipeline nodes: validation (mirrors the backend)', () => {
  it('a calling graph is valid; the call is its own layer and makes no stage', () => {
    const g = calling()
    expect(validateGraph(g)).toEqual([])
    expect(layerGraph(g).layers).toEqual([['a'], ['call'], ['b']])
    expect(deriveStagesFromGraph(g).map((s) => s.slots.map((x) => x.label))).toEqual([['a'], ['b']])
    expect(validateGraph(calling({ pipelineId: 'B' }))).toEqual([])
  })

  it.each([
    [null, 'subpipeline node call needs subpipeline.pipelineId'],
    [{ pipelineId: '' }, 'subpipeline node call needs subpipeline.pipelineId'],
    [{ pipelineId: 'B', task: 3 }, 'subpipeline node call: task must be a string'],
    [{ pipelineId: 'B', wait: false }, 'subpipeline node call: wait must be true (the parent always waits)'],
    [{ pipelineId: 'B', mode: 'each' }, 'subpipeline node call: subpipeline takes only pipelineId, task and wait'],
  ])('refuses %j', (config, msg) => {
    expect(validateGraph(calling(config))).toContain(msg)
  })

  it('only subpipeline nodes carry the config; they may retry and start error edges', () => {
    const g = calling()
    g.nodes[1].subpipeline = { pipelineId: 'B' }
    expect(validateGraph(g)).toContain('node a: only subpipeline nodes carry subpipeline config')
    const ok = applyGraphOps(calling(), [
      { op: 'set_retry', id: 'call', retry: { maxTries: 2 } },
      { op: 'add_node', node: slot('alert'), after: [] },
      { op: 'add_edge', edge: { id: 'x-call-alert', from: 'call', to: 'alert', kind: 'error' } },
      { op: 'update_node', id: 'call', subpipeline: { task: 'other' } },
    ])
    expect(validateGraph(ok)).toEqual([])
    expect(ok.nodes.find((n) => n.id === 'call')!.subpipeline).toEqual({ pipelineId: 'B', task: 'other', wait: true })
    expect(() => applyGraphOps(calling(), [{ op: 'update_node', id: 'a', subpipeline: { task: 'x' } }])).toThrow('is not a subpipeline')
  })
})

describe('subpipeline cycles across pipelines (mirrors the backend)', () => {
  it('finds A → B → A once, and a self call', () => {
    const graphs = { A: calling({ pipelineId: 'B' }), B: calling({ pipelineId: 'A' }), C: calling({ pipelineId: 'C' }), D: empty }
    expect(subpipelineCycleErrors(graphs)).toEqual(['subpipeline cycle: A → B → A', 'subpipeline cycle: C → C'])
  })

  it('a chain without a loop is fine; an unknown pipeline is named', () => {
    expect(subpipelineCycleErrors({ A: calling({ pipelineId: 'B' }), B: calling({ pipelineId: 'C' }), C: empty })).toEqual([])
    expect(subpipelineCycleErrors({ A: calling({ pipelineId: 'gone' }) })).toEqual(['subpipeline node call in A names unknown pipeline gone'])
  })
})

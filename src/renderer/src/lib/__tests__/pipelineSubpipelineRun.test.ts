import { describe, expect, it } from 'vitest'
import { usePipelineDag } from '../../composables/usePipelineDag'
import { deriveStagesFromGraph, type GraphNode, type PipelineGraph } from '../pipelineGraph'

function slot(id: string, kickoffBody = ''): GraphNode {
  return { id, kind: 'slot', label: id, position: { x: 0, y: 0 }, slot: { agentKey: 'claude', roleKey: '', label: id, kickoffBody } }
}

/** trigger → a → call(child) → b, with optional retry / error edge on the call. */
function parent(opts: { retry?: number; errorEdge?: boolean; task?: string } = {}): PipelineGraph {
  const g: PipelineGraph = {
    version: 1,
    nodes: [
      { id: 'trigger', kind: 'trigger', position: { x: 0, y: 0 } },
      slot('a'),
      { id: 'call', kind: 'subpipeline', label: 'Call', position: { x: 0, y: 0 }, subpipeline: { pipelineId: 'child', task: opts.task ?? 'sub: {{task}} after {{prev.summary}}', wait: true } },
      slot('b', 'use {{prev.summary}} / {{node.call.output.n}}'),
    ],
    edges: [
      { id: 'e-trigger-a', from: 'trigger', to: 'a', kind: 'main' },
      { id: 'e-a-call', from: 'a', to: 'call', kind: 'main' },
      { id: 'e-call-b', from: 'call', to: 'b', kind: 'main' },
    ],
  }
  if (opts.retry) g.nodes[2].retry = { maxTries: opts.retry }
  if (opts.errorEdge) {
    g.nodes.push(slot('alert'))
    g.edges.push({ id: 'x-call-alert', from: 'call', to: 'alert', kind: 'error' })
  }
  return g
}

function dagFor(graph: PipelineGraph) {
  const log: string[] = []
  const reports: Array<Record<string, unknown>> = []
  const dag = usePipelineDag({
    send: async (type, payload) => {
      if (type === 'pipelines.graph.get') return { derived: false, graph }
      reports.push(payload)
      return {}
    },
    log: (l) => log.push(l),
    workspacePath: () => '/ws',
  })
  return { dag, log, reports, stages: deriveStagesFromGraph(graph) }
}

describe('a run calls its sub-pipeline between stages', () => {
  it('asks for the call after the stage before it, with the task template expanded', async () => {
    const t = dagFor(parent())
    await t.dag.begin('p', t.stages)
    expect(t.dag.nextCall(0)).toBeNull()
    t.dag.slotStarted(0, 'a', 'pane-a')
    t.dag.slotFinished(0, 'a', 'a did it')
    const call = t.dag.nextCall(1)
    expect(call).toEqual({ kind: 'call', nodeId: 'call', label: 'Call', pipelineId: 'child', task: 'sub: {{task}} after a did it', note: '' })
    t.dag.callStarted('call')
    expect(t.dag.nodeStates.value.call).toMatchObject({ status: 'running', attempts: 1 })
    expect(t.dag.nextCall(1)).toBeNull()
  })

  it('an empty template hands the child the parent task', async () => {
    const t = dagFor(parent({ task: '' }))
    await t.dag.begin('p', t.stages)
    t.dag.slotFinished(0, 'a', 'x')
    expect(t.dag.nextCall(1)).toMatchObject({ task: '{{task}}' })
  })

  it('resumes after a finished child with its result as the node output', async () => {
    const t = dagFor(parent())
    t.dag.expectCallResult('call', { status: 'done', summary: 'child said hi', output: { n: 7 } })
    t.dag.adoptCallOutputs({ call: { summary: 'child said hi', at: 'T', output: { n: 7 } }, a: { summary: 'ignored', at: 'T' } })
    expect(await t.dag.begin('p', t.stages, { startIndex: 1 })).toBe(1)
    expect(t.dag.nextCall(1)).toBeNull()
    expect(t.dag.expandKickoff('use {{prev.summary}} / {{node.call.output.n}}', 1, 'b')).toBe('use child said hi / 7')
  })

  it('a call before the resume point without a recorded output is made again', async () => {
    const t = dagFor(parent())
    await t.dag.begin('p', t.stages, { startIndex: 1 })
    expect(t.dag.nextCall(1)).toMatchObject({ kind: 'call', nodeId: 'call' })
  })

  it('a call with a recorded output is reused on resume', async () => {
    const t = dagFor(parent())
    t.dag.adoptCallOutputs({ call: { summary: 'old', at: 'T' } })
    await t.dag.begin('p', t.stages, { startIndex: 1 })
    expect(t.dag.nextCall(1)).toBeNull()
  })
})

describe('a failed child', () => {
  it('is called again while the node has tries left, with the failure in front', async () => {
    const t = dagFor(parent({ retry: 2 }))
    t.dag.expectCallResult('call', { status: 'failed', error: 'kickoff never landed', attempts: 1 })
    await t.dag.begin('p', t.stages, { startIndex: 1 })
    const again = t.dag.nextCall(1)
    expect(again).toMatchObject({ kind: 'call', nodeId: 'call', note: '[重試 第 2/2 次 — 上次失敗：kickoff never landed]' })
  })

  it('out of tries, goes down its error edge', async () => {
    const t = dagFor(parent({ retry: 2, errorEdge: true }))
    t.dag.expectCallResult('call', { status: 'failed', error: 'boom', attempts: 2 })
    await t.dag.begin('p', t.stages, { startIndex: 1 })
    expect(t.dag.nextCall(1)).toBeNull()
    expect(t.dag.nodeStates.value.call).toMatchObject({ status: 'failed', errorRouted: true })
    expect([...t.dag.untakenLabels(1)]).toEqual(['b'])
  })

  it('with neither, fails the run', async () => {
    const t = dagFor(parent())
    t.dag.expectCallResult('call', { status: 'failed', error: 'boom', attempts: 1 })
    await t.dag.begin('p', t.stages, { startIndex: 1 })
    expect(t.dag.nextCall(1)).toEqual({ kind: 'fail', nodeId: 'call', label: 'Call', reason: 'boom' })
  })
})

describe('what a child run hands back', () => {
  it('its last step\'s summary and output', async () => {
    const child: PipelineGraph = {
      version: 1,
      nodes: [{ id: 'trigger', kind: 'trigger', position: { x: 0, y: 0 } }, slot('x'), slot('y')],
      edges: [{ id: 'e-trigger-x', from: 'trigger', to: 'x', kind: 'main' }, { id: 'e-x-y', from: 'x', to: 'y', kind: 'main' }],
    }
    const t = dagFor(child)
    await t.dag.begin('c', t.stages)
    t.dag.slotFinished(0, 'x', 'first')
    t.dag.slotFinished(1, 'y', 'final words')
    expect(t.dag.childResult()).toEqual({ summary: 'final words', output: null })
  })

  it('several last steps, labelled', async () => {
    const child: PipelineGraph = {
      version: 1,
      nodes: [{ id: 'trigger', kind: 'trigger', position: { x: 0, y: 0 } }, slot('x'), slot('y')],
      edges: [{ id: 'e-trigger-x', from: 'trigger', to: 'x', kind: 'main' }, { id: 'e-trigger-y', from: 'trigger', to: 'y', kind: 'main' }],
    }
    const t = dagFor(child)
    await t.dag.begin('c', t.stages)
    t.dag.slotFinished(0, 'x', 'from x')
    t.dag.slotFinished(0, 'y', 'from y')
    expect(t.dag.childResult()).toEqual({ summary: '[x]\nfrom x\n\n[y]\nfrom y', output: null })
  })

  it('a child run knows it is one', async () => {
    const t = dagFor(parent())
    expect(t.dag.isChildRun()).toBe(false)
    t.dag.setRunStack([{ id: 'call-1', pipeline_name: 'Parent' }])
    expect(t.dag.isChildRun()).toBe(true)
    t.dag.setRunStack(undefined)
    expect(t.dag.isChildRun()).toBe(false)
  })
})

describe('a pipeline without subpipeline nodes never calls (R8)', () => {
  it('nextCall is null at every hand-off', async () => {
    const g = parent()
    g.nodes = g.nodes.filter((n) => n.id !== 'call')
    g.edges = [{ id: 'e-trigger-a', from: 'trigger', to: 'a', kind: 'main' }, { id: 'e-a-b', from: 'a', to: 'b', kind: 'main' }]
    const t = dagFor(g)
    t.dag.adoptCallOutputs({ a: { summary: 'not adopted', at: 'T' } })
    await t.dag.begin('p', t.stages, { startIndex: 1 })
    for (let i = 0; i <= 2; i++) expect(t.dag.nextCall(i)).toBeNull()
    expect(t.dag.expandKickoff('{{prev.summary}}', 1, 'b')).toBe('(no output recorded)')
  })
})

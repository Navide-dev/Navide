// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { effectScope, type EffectScope } from 'vue'
import { createMockBackend } from './mockBackend'
import { usePipelineGraphEditor } from '../usePipelineGraphEditor'
import { applyGraphOps, deriveGraphFromStages, type GraphOp, type PipelineGraph } from '../../lib/pipelineGraph'
import type { Stage } from '../../data/stages'

const stage = (id: string, label: string): Stage => ({
  id, title: id, shortTitle: id, question: '', description: '', recommendedRoles: [],
  sentinel: '', allowQuestions: false, docQuery: '',
  slots: [{ agentKey: 'claude', roleKey: 'dev', label, kickoffBody: '', isCommander: false }],
})

const seed = (): PipelineGraph => deriveGraphFromStages([stage('01', 'A'), stage('02', 'B')])
const rename = (id: string, label: string): GraphOp => ({ op: 'update_node', id, label })

/** A backend that stores one graph and applies ops the way the real one does,
 *  with switches to refuse the next write. */
function fakeServer() {
  const mock = createMockBackend('connected')
  let stored = seed()
  let refuse: { code: string; message: string } | null = null
  let refuseLeft = 0
  const original = mock.backend.send
  ;(mock.backend as { send: unknown }).send = async (type: string, payload: Record<string, unknown> = {}) => {
    await original(type, payload)
    const ok = (p: unknown) => ({ id: 't', type, ok: true, payload: p, error: null, timestamp: '' })
    const fail = (e: { code: string; message: string }) => ({ id: 't', type, ok: false, payload: null, error: e, timestamp: '' })
    if (type === 'pipelines.graph.get') return ok({ pipeline_id: 'p1', graph: stored, derived: true, stages: [] })
    if (refuse) { const e = refuse; if (--refuseLeft <= 0) refuse = null; return fail(e) }
    if (type === 'pipelines.graph.apply') stored = applyGraphOps(stored, payload.ops as GraphOp[])
    if (type === 'pipelines.graph.set') stored = payload.graph as PipelineGraph
    return ok({ pipeline_id: 'p1', graph: stored, stages: [] })
  }
  return {
    mock,
    stored: () => stored,
    refuseNext: (code = 'PIPELINE_RUNNING', times = 1) => { refuse = { code, message: 'refused' }; refuseLeft = times },
  }
}

describe('usePipelineGraphEditor', () => {
  let scope: EffectScope | undefined
  afterEach(() => { scope?.stop(); scope = undefined })

  async function setup(locked = false) {
    const server = fakeServer()
    scope = effectScope()
    const editor = scope.run(() => usePipelineGraphEditor(server.mock.backend, {
      pipelineId: () => 'p1',
      workspacePath: () => '/ws',
      locked: () => locked,
    }))!
    await editor.load()
    return { editor, server }
  }

  const label = (g: PipelineGraph | null, id: string) => g?.nodes.find((n) => n.id === id)?.label

  it('loads the graph the backend derives for a legacy pipeline', async () => {
    const { editor } = await setup()
    expect(editor.derived.value).toBe(true)
    expect(editor.graph.value?.nodes.map((n) => n.id)).toEqual(['trigger', 'n-01-0', 'n-02-0'])
  })

  it('applies an edit, sends the ops with the workspace, and makes it undoable', async () => {
    const { editor, server } = await setup()
    const result = await editor.execute('Rename', [rename('n-01-0', 'Plan')])
    expect(result.ok).toBe(true)
    expect(label(editor.graph.value, 'n-01-0')).toBe('Plan')
    const sent = server.mock.sent.find((s) => s.type === 'pipelines.graph.apply')
    expect(sent?.payload).toMatchObject({ pipeline_id: 'p1', workspace_path: '/ws' })
    expect(editor.canUndo.value).toBe(true)
    expect(editor.undoLabel.value).toBe('Rename')
  })

  it('undoes by restoring the previous graph, and redoes it', async () => {
    const { editor, server } = await setup()
    await editor.execute('Rename', [rename('n-01-0', 'Plan')])
    await editor.undo()
    expect(label(editor.graph.value, 'n-01-0')).toBe('A')
    expect(label(server.stored(), 'n-01-0')).toBe('A')
    expect(editor.canRedo.value).toBe(true)
    await editor.redo()
    expect(label(server.stored(), 'n-01-0')).toBe('Plan')
    expect(editor.canRedo.value).toBe(false)
  })

  it('rolls an optimistic edit back when the backend refuses it', async () => {
    const { editor, server } = await setup()
    server.refuseNext('PIPELINE_RUNNING')
    const result = await editor.execute('Rename', [rename('n-01-0', 'Plan')])
    expect(result).toMatchObject({ ok: false, error: { code: 'PIPELINE_RUNNING' } })
    expect(label(editor.graph.value, 'n-01-0')).toBe('A')
    expect(editor.canUndo.value).toBe(false)
  })

  it('refuses an edit that would make the graph invalid without sending it', async () => {
    const { editor, server } = await setup()
    const result = await editor.execute('Loop', [
      { op: 'add_edge', edge: { id: 'back', from: 'n-02-0', to: 'n-01-0', kind: 'main' } },
    ])
    expect(result).toMatchObject({ ok: false, error: { code: 'GRAPH_INVALID' } })
    expect(server.mock.sent.some((s) => s.type === 'pipelines.graph.apply')).toBe(false)
  })

  it('refuses every edit up front while the pipeline is running', async () => {
    const { editor, server } = await setup(true)
    const result = await editor.execute('Rename', [rename('n-01-0', 'Plan')])
    expect(result).toMatchObject({ ok: false, error: { code: 'PIPELINE_RUNNING' } })
    expect(server.mock.sent.some((s) => s.type === 'pipelines.graph.apply')).toBe(false)
  })

  it('keeps writes in order when edits are made faster than they save', async () => {
    const { editor, server } = await setup()
    const a = editor.execute('One', [rename('n-01-0', 'One')])
    const b = editor.execute('Two', [rename('n-01-0', 'Two')])
    await Promise.all([a, b])
    expect(label(server.stored(), 'n-01-0')).toBe('Two')
    expect(editor.undoLabel.value).toBe('Two')
  })

  it('refuses undo while a write is pending, so callers can tell nothing happened', async () => {
    const { editor, server } = await setup()
    await editor.execute('One', [rename('n-01-0', 'One')])
    const saving = editor.execute('Two', [rename('n-01-0', 'Two')])
    const undo = await editor.undo()
    await saving
    expect(undo).toMatchObject({ ok: false, error: { code: 'WRITE_PENDING' } })
    expect(label(server.stored(), 'n-01-0')).toBe('Two')
    expect(editor.undoLabel.value).toBe('Two')
  })

  it('adopts an external edit and drops the history it would clobber', async () => {
    const { editor, server } = await setup()
    await editor.execute('Rename', [rename('n-01-0', 'Plan')])
    const theirs = applyGraphOps(server.stored(), [rename('n-02-0', 'Review')])
    server.mock.emit('pipeline.graph_changed', { pipeline_id: 'p1', graph: theirs, stages: [], reason: 'mcp' })
    expect(label(editor.graph.value, 'n-02-0')).toBe('Review')
    expect(editor.canUndo.value).toBe(false)
    expect(editor.externalEdits.value).toBe(1)
  })

  it('ignores its own echo and other pipelines', async () => {
    const { editor, server } = await setup()
    await editor.execute('Rename', [rename('n-01-0', 'Plan')])
    server.mock.emit('pipeline.graph_changed', { pipeline_id: 'p1', graph: server.stored(), stages: [] })
    server.mock.emit('pipeline.graph_changed', { pipeline_id: 'other', graph: seed(), stages: [] })
    expect(editor.canUndo.value).toBe(true)
    expect(editor.externalEdits.value).toBe(0)
  })
  it('two queued edits that are both refused leave the saved graph on screen', async () => {
    const { editor, server } = await setup()
    server.refuseNext('PIPELINE_RUNNING', 2)
    const a = editor.execute('One', [rename('n-01-0', 'One')])
    const b = editor.execute('Two', [rename('n-02-0', 'Two')])
    const [ra, rb] = await Promise.all([a, b])
    expect(ra.ok).toBe(false)
    expect(rb.ok).toBe(false)
    // Neither edit was saved, so neither may stay on screen.
    expect(editor.graph.value).toEqual(server.stored())
  })

  it('undo after a refused edit never writes the refused edit back', async () => {
    const { editor, server } = await setup()
    server.refuseNext('PIPELINE_RUNNING', 1)
    const a = editor.execute('One', [rename('n-01-0', 'One')])
    const b = editor.execute('Two', [rename('n-02-0', 'Two')])
    await Promise.all([a, b])
    expect(label(server.stored(), 'n-01-0')).toBe('A')
    expect(editor.graph.value).toEqual(server.stored())
    expect((await editor.undo()).ok).toBe(true)
    expect(label(server.stored(), 'n-01-0')).toBe('A')
    expect(label(server.stored(), 'n-02-0')).toBe('B')
  })
})

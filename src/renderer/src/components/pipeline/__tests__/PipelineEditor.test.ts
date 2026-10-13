// @vitest-environment happy-dom
// Pipeline editor UI: the gestures each view offers must become the right
// graph ops, the inspector must generate its form from Role properties, and
// run control must reach the host's UI commands.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { effectScope, type EffectScope } from 'vue'
import { i18n, useNotify } from '@navide/plugin-ui/foundation'
import { registerCommand } from '@navide/plugin-ui/shared'
import { createMockBackend } from '../../../composables/__tests__/mockBackend'
import {
  applyGraphOps,
  type GraphNode,
  type GraphOp,
  type PipelineGraph,
  type RoleProperty,
} from '../../../lib/pipelineGraph'
import type { Role } from '../../../composables/useRoles'
import PipelineEditor from '../PipelineEditor.vue'
import PipelineInspector from '../PipelineInspector.vue'
import PipelineSwimlane from '../PipelineSwimlane.vue'
import PipelinePalette from '../PipelinePalette.vue'
import PipelineExecutions from '../PipelineExecutions.vue'
import { DND_NODE, DND_PALETTE, EMPTY_RUN, type RunSnapshot } from '../pipelineEditorModel'
import { laneBadges } from '../../../lib/pipelineGraphEdits'

i18n.global.locale.value = 'en-US'

const slot = (id: string, label: string, roleKey = 'dev', extra: Partial<GraphNode> = {}): GraphNode => ({
  id, kind: 'slot', label, position: { x: 0, y: 0 }, stageId: undefined,
  slot: { agentKey: 'claude', roleKey, label, kickoffBody: 'Do {{task}}', isCommander: false },
  ...extra,
})
const edge = (from: string, to: string, kind: 'main' | 'reject' = 'main') =>
  ({ id: `${kind === 'reject' ? 'r' : 'e'}-${from}-${to}`, from, to, kind, ...(kind === 'reject' ? { maxLoops: 2 } : {}) })

/** trigger → plan → (fe, be) → gate → review, with review ↺ fe. */
function seedGraph(): PipelineGraph {
  return {
    version: 1,
    nodes: [
      { id: 'trigger', kind: 'trigger', label: 'Start', position: { x: 0, y: 0 } },
      slot('plan', 'Plan', 'planner'),
      slot('fe', 'Frontend'),
      slot('be', 'Backend'),
      { id: 'gate', kind: 'gate', label: 'Approve', position: { x: 0, y: 0 }, gate: { prompt: 'Check both' } },
      slot('review', 'Review', 'reviewer'),
    ],
    edges: [
      edge('trigger', 'plan'), edge('plan', 'fe'), edge('plan', 'be'),
      edge('fe', 'gate'), edge('be', 'gate'), edge('gate', 'review'), edge('review', 'fe', 'reject'),
    ],
  }
}

const devProps: RoleProperty[] = [
  { name: 'doneWhen', label: 'Done when', type: 'options', default: 'turnEnd', options: [{ value: 'turnEnd' }, { value: 'message' }] },
  { name: 'reportKey', label: 'Report key', type: 'string', displayOptions: { show: { doneWhen: ['message'] } } },
  { name: 'retries', label: 'Retries', type: 'number', default: 1 },
]
const roles: Role[] = [
  { key: 'planner', label: 'Planner', one_line: 'plans', system_prompt: '#' },
  { key: 'dev', label: 'Developer', one_line: 'builds', system_prompt: '#', properties: devProps },
  { key: 'reviewer', label: 'Reviewer', one_line: 'reviews', system_prompt: '#' },
]

function graphServer(initial = seedGraph()) {
  const mock = createMockBackend('connected')
  let stored = initial
  const send = mock.backend.send
  ;(mock.backend as { send: unknown }).send = async (type: string, payload: Record<string, unknown> = {}) => {
    await send(type, payload)
    const ok = (p: unknown) => ({ id: 't', type, ok: true, payload: p, error: null, timestamp: '' })
    if (type === 'pipelines.graph.get') return ok({ pipeline_id: 'p1', graph: stored, derived: false, stages: [] })
    if (type === 'pipelines.graph.apply') {
      stored = applyGraphOps(stored, payload.ops as GraphOp[])
      return ok({ pipeline_id: 'p1', graph: stored, stages: [] })
    }
    if (type === 'pipelines.graph.set') { stored = payload.graph as PipelineGraph; return ok({ pipeline_id: 'p1', graph: stored, stages: [] }) }
    if (type === 'tokens.snapshot') return ok(tokens)
    return ok(null)
  }
  return { mock, stored: () => stored, lastOps: () => mock.sent.filter((s) => s.type === 'pipelines.graph.apply').at(-1)?.payload.ops as GraphOp[] | undefined }
}

let tokens: unknown = { workspace_path: '/ws', workspace: { current_run: null, runs: [] } }

describe('PipelineEditor', () => {
  let wrapper: VueWrapper | undefined
  let scope: EffectScope | undefined
  beforeEach(() => {
    try { localStorage.clear() } catch { /* none */ }
  })
  afterEach(() => { wrapper?.unmount(); wrapper = undefined; scope?.stop(); scope = undefined })

  async function mountEditor(opts: { run?: RunSnapshot; locked?: boolean } = {}) {
    const server = graphServer()
    scope = effectScope()
    const w = scope.run(() => mount(PipelineEditor, {
      props: { backend: server.mock.backend, pipelineId: 'p1', roles, workspacePath: '/ws', run: opts.run ?? EMPTY_RUN, locked: !!opts.locked },
      global: { plugins: [i18n], stubs: { PipelineCanvas: { name: 'PipelineCanvas', template: '<div class="canvas-stub" />' } } },
      attachTo: document.body,
    }))!
    wrapper = w
    await flushPromises()
    return { w, server }
  }

  it('starts in the swimlane with one column per layer', async () => {
    const { w } = await mountEditor()
    const titles = w.findAll('.lane .lane-title').map((t) => t.text())
    expect(titles).toEqual(['Layer 1', 'Layer 2', 'Checkpoint', 'Layer 4'])
    expect(w.findAll('.lane')[1].findAll('.lane-card')).toHaveLength(2)
  })

  it('adds a picked role as a new layer after the selected step, wired and placed', async () => {
    const { w, server } = await mountEditor()
    await w.find('.lane-card[data-node-id="plan"]').trigger('click')
    await w.findAll('.pe-palette .pp-item')[2].trigger('click') // Reviewer (sorted)
    await flushPromises()

    const ops = server.lastOps()!
    expect(ops[0]).toMatchObject({ op: 'add_node', node: { kind: 'slot', slot: { roleKey: 'reviewer', label: 'Reviewer' } }, after: ['plan'], before: ['fe', 'be'] })
    expect(ops.slice(1).every((o) => o.op === 'move_node')).toBe(true)
    // The new step is selected for configuring.
    expect(w.find('.pi-title').text()).toBe('Reviewer')
  })

  it('quick-adds a parallel step from a column\'s "+" button', async () => {
    const { w, server } = await mountEditor()
    await w.findAll('.lane')[3].find('.lane-add').trigger('click')
    await flushPromises()
    expect(w.find('.pe-quick').exists()).toBe(true)
    await w.find('.pe-quick .pp-item').trigger('click')
    await flushPromises()

    const add = server.lastOps()!.find((o) => o.op === 'add_node')!
    expect(add).toMatchObject({ op: 'add_node' })
    const added = server.stored().nodes.at(-1)!
    expect(server.stored().edges.some((e) => e.from === 'gate' && e.to === added.id)).toBe(true)
    expect(w.find('.pe-quick').exists()).toBe(false)
  })

  it('moves a card dropped on another column', async () => {
    const { w, server } = await mountEditor()
    const data = new Map<string, string>([[DND_NODE, 'be']])
    const dataTransfer = { types: [DND_NODE], getData: (k: string) => data.get(k) ?? '', dropEffect: '' }
    await w.findAll('.lane')[3].trigger('drop', { dataTransfer })
    await flushPromises()
    expect(server.lastOps()![0]).toEqual({ op: 'remove_node', id: 'be', reconnect: true })
  })

  it('refuses to reorder columns of a graph with a gate, and says where to do it', async () => {
    const { w, server } = await mountEditor()
    const before = useNotify().toasts.value.length
    await w.findAll('.lane')[0].findAll('.lane-tool')[1].trigger('click') // move right
    await flushPromises()
    expect(server.lastOps()).toBeUndefined()
    expect(useNotify().toasts.value.slice(before).at(-1)?.message).toContain('Change it on the canvas')
  })

  it('undoes and redoes with the keyboard', async () => {
    const { w, server } = await mountEditor()
    await w.find('.lane-card[data-node-id="be"]').trigger('keydown', { key: 'Delete' })
    await flushPromises()
    expect(server.stored().nodes.some((n) => n.id === 'be')).toBe(false)

    await w.find('.pe').trigger('keydown', { key: 'z', metaKey: true })
    await flushPromises()
    expect(server.stored().nodes.some((n) => n.id === 'be')).toBe(true)

    await w.find('.pe').trigger('keydown', { key: 'z', metaKey: true, shiftKey: true })
    await flushPromises()
    expect(server.stored().nodes.some((n) => n.id === 'be')).toBe(false)
  })

  it('ignores a keyboard undo made while an edit is still saving, without a toast', async () => {
    const { w, server } = await mountEditor()
    await w.find('.lane-card[data-node-id="be"]').trigger('keydown', { key: 'Delete' })
    await flushPromises()
    let release!: () => void
    const held = new Promise<void>((r) => { release = r })
    const send = server.mock.backend.send
    ;(server.mock.backend as { send: unknown }).send = async (type: string, payload: Record<string, unknown> = {}) => {
      if (type === 'pipelines.graph.apply') await held
      return send(type, payload)
    }
    await w.find('.lane-card[data-node-id="fe"]').trigger('keydown', { key: 'Delete' })
    const before = useNotify().toasts.value.length
    await w.find('.pe').trigger('keydown', { key: 'z', metaKey: true })
    await flushPromises()
    release()
    await flushPromises()
    expect(useNotify().toasts.value.slice(before)).toEqual([])
    expect(server.stored().nodes.some((n) => n.id === 'be' || n.id === 'fe')).toBe(false)
  })

  it('switches to the canvas when a loop badge is clicked and remembers the view', async () => {
    const { w } = await mountEditor()
    await w.find('.lane-card[data-node-id="review"] .pnc-badge').trigger('click')
    await flushPromises()
    expect(w.find('.canvas-stub').exists()).toBe(true)
    expect(localStorage.getItem('pipeline-editor-view')).toBe('canvas')
  })

  it('stops the view morph when it is unmounted mid-switch', async () => {
    const { w } = await mountEditor()
    await w.find('.lane-card[data-node-id="review"] .pnc-badge').trigger('click')
    w.unmount()
    wrapper = undefined
    const raf = vi.spyOn(window, 'requestAnimationFrame')
    // The stubbed canvas never reports ready, so the switch waits out its 600ms fallback.
    await new Promise((r) => setTimeout(r, 700))
    expect(raf).not.toHaveBeenCalled()
    raf.mockRestore()
  })

  it('changes a reject loop\'s retry limit as one undoable command', async () => {
    const { w, server } = await mountEditor()
    await w.findAll('.pe-seg-btn')[1].trigger('click') // canvas
    await flushPromises()
    w.findComponent({ name: 'PipelineCanvas' }).vm.$emit('select-edge', 'r-review-fe')
    await flushPromises()
    expect(w.find('.pe-edge-panel').text()).toContain('Review sends work back to Frontend')
    await w.findAll('.pe-stepper button')[1].trigger('click') // +
    await flushPromises()
    expect(server.lastOps()).toEqual([
      { op: 'remove_edge', id: 'r-review-fe' },
      { op: 'add_edge', edge: { id: 'r-review-fe', from: 'review', to: 'fe', kind: 'reject', maxLoops: 3 } },
    ])
    expect(w.find('.pe-stepper-value').text()).toBe('at most 3×')
  })

  it('locks every edit while the pipeline runs', async () => {
    const { w, server } = await mountEditor({ locked: true })
    expect(w.find('.pe-lock').exists()).toBe(true)
    expect(w.find('.lane-add').exists()).toBe(false)
    expect(w.findAll('.pe-palette .pp-item').every((b) => b.attributes('disabled') !== undefined)).toBe(true)
    await w.find('.lane-card[data-node-id="be"]').trigger('keydown', { key: 'Delete' })
    await flushPromises()
    expect(server.lastOps()).toBeUndefined()
  })

  it('passes a gate through the host command, with the node id', async () => {
    const calls: unknown[] = []
    registerCommand('ui.pipeline.gate_pass', (args) => { calls.push(args) })
    const run: RunSnapshot = { pipelineId: 'p1', state: 'running', gate: 'gate', nodes: { gate: { status: 'awaiting' } } }
    const { w } = await mountEditor({ run, locked: true })
    await w.find('.lane-card[data-node-id="gate"]').trigger('click')
    await flushPromises()
    await w.find('.pi-decision .pi-btn--primary').trigger('click')
    await flushPromises()
    expect(calls).toEqual([{ nodeId: 'gate' }])
  })

  it('reports a run command the host does not know instead of failing silently', async () => {
    const run: RunSnapshot = { pipelineId: 'p1', state: 'running', gate: 'gate', nodes: { gate: { status: 'awaiting' } } }
    const { w } = await mountEditor({ run, locked: true })
    const before = useNotify().toasts.value.length
    await w.find('.lane-card[data-node-id="gate"]').trigger('click')
    await flushPromises()
    await w.find('.pi-decision .pi-btn:not(.pi-btn--primary)').trigger('click') // send back
    await flushPromises()
    expect(useNotify().toasts.value.slice(before).at(-1)?.message).toContain('ui.pipeline.gate_reject')
  })

  it('shows a run strip with progress and what is running, in every editor view', async () => {
    const now = Date.now()
    const run: RunSnapshot = {
      pipelineId: 'p1', state: 'running', gate: null,
      nodes: {
        plan: { status: 'done' },
        fe: { status: 'running', startedAt: new Date(now - 30_000).toISOString() },
        be: { status: 'running', startedAt: new Date(now - 10_000).toISOString() },
      },
    }
    const { w } = await mountEditor({ run, locked: true })
    const strip = w.find('.pe-run')
    expect(strip.exists()).toBe(true)
    expect(strip.text()).toContain('1 of 5 steps')
    expect(strip.text()).toContain('Frontend')
    expect(strip.text()).toContain('Backend')
  })

  it('turns the run strip into a call to review a waiting gate', async () => {
    const run: RunSnapshot = { pipelineId: 'p1', state: 'running', gate: 'gate', nodes: { plan: { status: 'done' }, gate: { status: 'awaiting' } } }
    const { w } = await mountEditor({ run, locked: true })
    const strip = w.find('.pe-run')
    expect(strip.classes()).toContain('is-gate')
    expect(strip.text()).toContain('Approve')
    await strip.find('.pe-run-act').trigger('click')
    await flushPromises()
    expect(w.find('.pi-title').text()).toBe('Approve')
    expect(w.find('.pi-decision').exists()).toBe(true)
  })

  it('has no run strip for another pipeline\'s run', async () => {
    const run: RunSnapshot = { pipelineId: 'other', state: 'running', gate: null, nodes: {} }
    const { w } = await mountEditor({ run })
    expect(w.find('.pe-run').exists()).toBe(false)
  })

  it('marks the swimlane link into a running layer as live and out of a finished one as done', async () => {
    const run: RunSnapshot = { pipelineId: 'p1', state: 'running', gate: null, nodes: { plan: { status: 'done' }, fe: { status: 'running' }, be: { status: 'pending' } } }
    const { w } = await mountEditor({ run, locked: true })
    const gutters = w.findAll('.lane-gutter')
    expect(gutters[1].classes()).toContain('is-live') // plan → (fe, be)
    expect(gutters[0].classes()).toContain('is-done') // trigger → plan
    expect(gutters[2].classes()).not.toContain('is-live')
  })

  it('shows run state on the cards', async () => {
    const now = Date.now()
    const run: RunSnapshot = {
      pipelineId: 'p1', state: 'running', gate: null,
      nodes: {
        plan: { status: 'done', startedAt: new Date(now - 252_000).toISOString(), endedAt: new Date(now).toISOString(), tokens: 38_200 },
        fe: { status: 'running', startedAt: new Date(now - 30_000).toISOString() },
      },
    }
    const { w } = await mountEditor({ run, locked: true })
    const plan = w.find('.lane-card[data-node-id="plan"]')
    expect(plan.classes()).toContain('is-done')
    expect(plan.text()).toContain('4m12s')
    expect(plan.text()).toContain('38k tok')
    expect(w.find('.lane-card[data-node-id="fe"]').classes()).toContain('is-running')
  })
})

describe('PipelineInspector', () => {
  let scope: EffectScope | undefined
  afterEach(() => { scope?.stop(); scope = undefined })

  function mountInspector(node: GraphNode, extra: Record<string, unknown> = {}) {
    const mock = createMockBackend('connected')
    scope = effectScope()
    return scope.run(() => mount(PipelineInspector, {
      props: {
        backend: mock.backend, graph: seedGraph(), node, stage: null, roles,
        agentOptions: [{ key: 'claude', label: 'Claude' }, { key: 'codex', label: 'Codex' }],
        run: EMPTY_RUN, now: Date.now(), locked: false, workspacePath: '/ws', ...extra,
      },
      global: { plugins: [i18n] },
    }))!
  }

  it('builds the role\'s fields and hides the ones displayOptions rules out', () => {
    const w = mountInspector(slot('fe', 'Frontend'))
    const text = w.text()
    expect(text).toContain('Done when')
    expect(text).toContain('Retries')
    expect(text).not.toContain('Report key')
  })

  it('shows a dependent field once its condition holds', () => {
    const w = mountInspector(slot('fe', 'Frontend', 'dev', { slot: { agentKey: 'claude', roleKey: 'dev', label: 'Frontend', kickoffBody: '', isCommander: false, params: { doneWhen: 'message' } } }))
    expect(w.text()).toContain('Report key')
  })

  it('writes a field as one op carrying the whole params map', async () => {
    const node = slot('fe', 'Frontend', 'dev', { slot: { agentKey: 'claude', roleKey: 'dev', label: 'Frontend', kickoffBody: '', isCommander: false, params: { retries: 1 } } })
    const w = mountInspector(node)
    await w.findAll('.pi-seg-btn')[1].trigger('click') // doneWhen = message
    const [[label, ops]] = w.emitted('edit') as [string, GraphOp[]][]
    expect(label).toContain('doneWhen')
    expect(ops).toEqual([{ op: 'update_node', id: 'fe', slot: { params: { retries: 1, doneWhen: 'message' } } }])
  })

  it('lists what feeds the step and offers prompt variables', () => {
    const w = mountInspector(slot('fe', 'Frontend'))
    expect(w.find('.pi-inputs').text()).toContain('Plan')
    expect(w.findAll('.pi-vars .pi-var').map((b) => b.text())).toEqual(['{{task}}', '{{prev.summary}}'])
  })

  it('edits a layer through set_stage_meta with the previous value for undo', async () => {
    const stage = { id: '01', title: 'Spec', shortTitle: 'Spec', question: '', description: '', recommendedRoles: [], sentinel: '---DONE---', allowQuestions: false, docQuery: '', slots: [] }
    const w = mountInspector(slot('fe', 'x'), { node: null, stage })
    const sentinel = w.findAll('input[type="text"]')[2]
    await sentinel.setValue('---SPEC---')
    await sentinel.trigger('change')
    expect(w.emitted('stage-meta')?.[0]).toEqual(['01', { sentinel: '---SPEC---' }, { sentinel: '---DONE---' }])
  })

  it('tails the pane transcript in the live tab, polling only while open', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('terminal.history', { ok: true, text: 'line one\nline two', chunk: 0, total_chunks: 1 })
    scope = effectScope()
    const run: RunSnapshot = { pipelineId: 'p1', state: 'running', gate: null, nodes: { fe: { status: 'running', paneId: 'pane-9' } } }
    const w = scope.run(() => mount(PipelineInspector, {
      props: { backend: mock.backend, graph: seedGraph(), node: slot('fe', 'Frontend'), stage: null, roles, agentOptions: [], run, now: Date.now(), locked: true, workspacePath: '/ws' },
      global: { plugins: [i18n] },
    }))!
    expect(mock.sent.some((s) => s.type === 'terminal.history')).toBe(false)
    await w.findAll('.pi-tab')[1].trigger('click')
    await flushPromises()
    expect(mock.sent.find((s) => s.type === 'terminal.history')?.payload).toEqual({
      workspace_path: '/ws', agent_key: 'claude', pane_id: 'pane-9', max_bytes: 24_000,
    })
    expect(w.find('.pi-live').text()).toContain('line two')
    w.unmount()
  })
})

describe('PipelinePalette', () => {
  it('filters by search and picks the first match on Enter', async () => {
    const w = mount(PipelinePalette, { props: { roles }, global: { plugins: [i18n] } })
    await w.find('input').setValue('review')
    expect(w.findAll('.pp-item').map((b) => b.find('.pp-label').text())).toEqual(['Reviewer'])
    await w.find('input').trigger('keydown', { key: 'Enter' })
    expect(w.emitted('pick')?.[0]).toEqual([{ kind: 'role', roleKey: 'reviewer', label: 'Reviewer', description: 'reviews' }])
  })

  it('says nothing matches instead of showing an empty list', async () => {
    const w = mount(PipelinePalette, { props: { roles }, global: { plugins: [i18n] } })
    await w.find('input').setValue('zzz')
    expect(w.find('.pp-empty').text()).toContain('zzz')
  })

  it('carries the item as drag data', async () => {
    const w = mount(PipelinePalette, { props: { roles }, global: { plugins: [i18n] } })
    const data = new Map<string, string>()
    await w.find('.pp-item').trigger('dragstart', { dataTransfer: { setData: (k: string, v: string) => data.set(k, v), effectAllowed: '' } })
    expect(JSON.parse(data.get(DND_PALETTE)!)).toMatchObject({ kind: 'role', roleKey: 'dev' })
  })
})

describe('PipelineSwimlane', () => {
  it('emits a palette drop into a column as "into" and onto a gutter as a new layer', async () => {
    const graph = seedGraph()
    const w = mount(PipelineSwimlane, {
      props: { graph, stages: [], roleLabels: {}, agentLabels: {}, runNodes: {}, badges: laneBadges(graph), now: 0, selectedId: null, locked: false, canReorder: false },
      global: { plugins: [i18n] },
    })
    const item = JSON.stringify({ kind: 'gate', label: 'Gate', description: '' })
    const dt = { types: [DND_PALETTE], getData: (k: string) => (k === DND_PALETTE ? item : ''), dropEffect: '' }
    await w.findAll('.lane')[1].trigger('drop', { dataTransfer: dt })
    await w.findAll('.lane-gutter')[2].trigger('drop', { dataTransfer: dt })
    expect(w.emitted('drop-item')?.map((e) => e[1])).toEqual([{ mode: 'into', layer: 1 }, { mode: 'newLayer', layer: 2 }])
  })

  it('moves a card to the next layer with Alt+→', async () => {
    const graph = seedGraph()
    const w = mount(PipelineSwimlane, {
      props: { graph, stages: [], roleLabels: {}, agentLabels: {}, runNodes: {}, badges: new Map(), now: 0, selectedId: null, locked: false, canReorder: false },
      global: { plugins: [i18n] },
    })
    await w.find('.lane-card[data-node-id="plan"]').trigger('keydown', { key: 'ArrowRight', altKey: true })
    expect(w.emitted('move-node')?.[0]).toEqual(['plan', { mode: 'into', layer: 1 }])
  })
})

describe('PipelineExecutions', () => {
  it('lists only this pipeline\'s runs, newest first, and counts the unattributed ones', async () => {
    tokens = {
      workspace_path: '/ws',
      workspace: {
        current_run: null,
        runs: [
          { run_id: 'a', task: 'first', pipeline_id: 'p1', outcome: 'completed', started_at: '2026-10-06T01:00:00Z', ended_at: '2026-10-06T01:10:00Z' },
          { run_id: 'b', task: 'other pipeline', pipeline_id: 'p2', outcome: 'completed' },
          { run_id: 'c', task: 'second', pipeline_id: 'p1', outcome: 'aborted', started_at: '2026-10-07T01:00:00Z', ended_at: '2026-10-07T01:05:00Z', node_states: { plan: { status: 'done' } } },
          { run_id: 'd', task: 'legacy' },
        ],
      },
    }
    const server = graphServer()
    const scope = effectScope()
    const w = scope.run(() => mount(PipelineExecutions, {
      props: { backend: server.mock.backend, workspacePath: '/ws', pipelineId: 'p1', graph: seedGraph(), run: EMPTY_RUN, roleLabels: {}, agentLabels: {}, now: Date.now() },
      global: { plugins: [i18n], stubs: { PipelineCanvas: { props: ['runNodes'], template: '<div class="canvas-stub">{{ JSON.stringify(runNodes) }}</div>' } } },
    }))!
    await flushPromises()
    const runs = w.findAll('.px-run')
    expect(runs.map((r) => r.find('.px-run-task').text())).toEqual(['second', 'first'])
    expect(w.find('.px-head').text()).toContain('second')
    expect(w.find('.canvas-stub').text()).toContain('"plan"')
    expect(w.text()).toContain('1 older run(s)')
    scope.stop()
  })
})

describe('PipelineInspector header', () => {
  it('carries the card\'s glyph and run status, so the panel reads as that node', () => {
    const mock = createMockBackend('connected')
    const run: RunSnapshot = { pipelineId: 'p1', state: 'running', gate: null, nodes: { fe: { status: 'running' } } }
    const w = mount(PipelineInspector, {
      props: { backend: mock.backend, graph: seedGraph(), node: slot('fe', 'Frontend'), stage: null, roles, agentOptions: [], run, now: Date.now(), locked: true, workspacePath: '/ws' },
      global: { plugins: [i18n] },
    })
    expect(w.find('.pi-glyph').text()).toBe('D') // Developer
    expect(w.find('.pi-status').text()).toContain('Running')
  })
})

describe('PipelineSwimlane overflow cue', () => {
  it('says how many layers are off to the right and scrolls to them', async () => {
    const graph = seedGraph()
    const w = mount(PipelineSwimlane, {
      props: { graph, stages: [], roleLabels: {}, agentLabels: {}, runNodes: {}, badges: new Map(), now: 0, selectedId: null, locked: false, canReorder: false },
      global: { plugins: [i18n] }, attachTo: document.body,
    })
    const scroller = w.find('.lane-scroll').element as HTMLElement
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 600 })
    Object.defineProperty(scroller, 'scrollWidth', { configurable: true, value: 1500 })
    const lanes = w.findAll('.lane').map((l) => l.element as HTMLElement)
    lanes.forEach((el, i) => { Object.defineProperty(el, 'offsetLeft', { configurable: true, value: 200 + i * 290 }) })
    let scrolledTo = -1
    scroller.scrollTo = ((opts: ScrollToOptions) => { scrolledTo = Number(opts.left) }) as typeof scroller.scrollTo
    await w.find('.lane-scroll').trigger('scroll')
    await flushPromises()
    const more = w.find('.lane-more')
    expect(more.text()).toContain('2 more layers') // layers starting past 600px: 3rd (780) and 4th (1070)
    await more.trigger('click')
    expect(scrolledTo).toBeGreaterThan(0)
    w.unmount()
  })
})

describe('PipelineInspector inputs', () => {
  it('shows each upstream as its card and hands its output to the prompt', async () => {
    const mock = createMockBackend('connected')
    const w = mount(PipelineInspector, {
      props: { backend: mock.backend, graph: seedGraph(), node: slot('fe', 'Frontend'), stage: null, roles, agentOptions: [], run: EMPTY_RUN, now: Date.now(), locked: false, workspacePath: '/ws' },
      global: { plugins: [i18n] }, attachTo: document.body,
    })
    expect(w.find('.pi-input .pi-input-glyph').text()).toBe('P') // Planner
    await w.find('.pi-handoff-chip').trigger('click')
    const [, ops] = (w.emitted('edit') as [string, GraphOp[]][])[0]
    expect(ops[0]).toMatchObject({ op: 'update_node', id: 'fe', slot: { kickoffBody: expect.stringContaining('{{prev.summary}}') } })
    w.unmount()
  })
})

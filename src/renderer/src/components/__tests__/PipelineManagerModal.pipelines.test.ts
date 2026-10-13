// @vitest-environment happy-dom
// Pipeline Manager — pipelines tab. Two guarantees:
//  1. the surface is translated (it shipped with ~20 hard-coded English strings
//     that leaked through the zh-TW UI);
//  2. set-default / delete carry the host workspace, which is what lets the
//     backend refuse them while that workspace's project is running.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, effectScope, type EffectScope } from 'vue'
import { i18n, useNotify } from '@navide/plugin-ui/foundation'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import { useRoles, type Role } from '../../composables/useRoles'
import { usePipelines, type PipelineSummary } from '../../composables/usePipelines'
import { createTerminalDockStub } from '../../ports/__tests__/terminalDock.stub'
import { applyGraphOps, deriveGraphFromStages, type GraphOp, type PipelineGraph } from '../../lib/pipelineGraph'
import { stageDefToFrontend } from '../../data/stages'

vi.mock('@navide/plugin-shell', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@navide/plugin-shell')>()),
  AiCliDock: defineComponent({ name: 'AiCliDock', render: () => null }),
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PipelineManagerModal = (await import('../PipelineManagerModal.vue')).default as any

const WORKSPACE = '/Users/me/Desktop/Agent-Team'

const roles: Role[] = [
  { key: 'pm', label: 'Project Manager', one_line: 'plans', system_prompt: '# PM' },
]
const pipelines: PipelineSummary[] = [
  { id: 'default', name: 'Default', builtin: true, stage_count: 2 },
  { id: 'custom', name: 'Custom', builtin: false, stage_count: 1 },
]
const secondStage = {
  id: '02',
  title: 'Build',
  short_title: 'Build',
  question: '',
  description: '',
  recommended_roles: [],
  sentinel: '---DONE---',
  allow_questions: false,
  doc_query: '',
  slots: [
    { agent_key: 'claude', role_key: 'pm', label: 'Dev', kickoff_body: '', is_commander: false },
  ],
}
const twoSlotStage = {
  id: '01',
  title: 'Specification',
  short_title: 'Spec',
  question: '',
  description: '',
  recommended_roles: [],
  sentinel: '---DONE---',
  allow_questions: false,
  doc_query: '',
  slots: [
    { agent_key: 'claude', role_key: 'pm', label: 'Lead', kickoff_body: '', is_commander: false },
    { agent_key: 'codex', role_key: 'pm', label: 'Second', kickoff_body: '', is_commander: false },
  ],
}

/** Prose that used to be baked into the template in English. */
const HARD_CODED_ENGLISH = [
  'Pipeline Manager',
  'New Pipeline',
  'Pipeline name',
  'stage(s)',
  'Back',
  'Set as default',
  'Allow questions',
  'Pause for user answers',
  'parallel slots',
  'at least one required',
  'Designate as global manager',
  'Save slot',
  'Reset to factory stages',
  'unassigned',
]

/** Stand-in for the backend's graph handlers: one stored graph, ops applied
 *  with the shared applyGraphOps, and a switch to refuse the next write. */
function installGraphServer(mock: ReturnType<typeof createMockBackend>) {
  let stored: PipelineGraph = deriveGraphFromStages([twoSlotStage, secondStage].map(stageDefToFrontend))
  let refusal: { code: string; message: string } | Error | null = null
  const send = mock.backend.send
  ;(mock.backend as { send: unknown }).send = async (type: string, payload: Record<string, unknown> = {}, timeoutMs?: number) => {
    if (!type.startsWith('pipelines.graph.')) return send(type, payload, timeoutMs)
    await send(type, payload, timeoutMs)
    const reply = (ok: boolean, p: unknown, error: unknown = null) => ({ id: 't', type, ok, payload: p, error, timestamp: '' })
    if (type !== 'pipelines.graph.get' && refusal) {
      const r = refusal
      refusal = null
      if (r instanceof Error) throw r
      return reply(false, null, r)
    }
    if (type === 'pipelines.graph.apply') stored = applyGraphOps(stored, payload.ops as GraphOp[])
    if (type === 'pipelines.graph.set') stored = payload.graph as PipelineGraph
    return reply(true, { pipeline_id: payload.pipeline_id, graph: stored, derived: type === 'pipelines.graph.get', stages: [twoSlotStage, secondStage] })
  }
  return {
    stored: () => stored,
    refuseNext: (r: { code: string; message: string } | Error) => { refusal = r },
  }
}

describe('PipelineManagerModal — pipelines tab', () => {
  let wrapper: VueWrapper | undefined
  let scope: EffectScope | undefined

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    scope?.stop()
    scope = undefined
    i18n.global.locale.value = 'en-US'
  })

  async function open(
    options: { locale?: 'en-US' | 'zh-TW'; initialPipelineId?: string; workspacePath?: string } = {}
  ) {
    i18n.global.locale.value = options.locale ?? 'en-US'
    const mock = createMockBackend('connected')
    mock.setResponse('roles.list', { roles, path: '/data/roles.json' })
    mock.setResponse('pipelines.list', {
      pipelines,
      active_pipeline_id: 'default',
      path: '/data/pipelines.json',
    })
    mock.setResponse('stages.list', {
      stages: [twoSlotStage, secondStage],
      pipeline_id: options.initialPipelineId ?? 'default',
      path: '/data/stages.json',
    })

    const server = installGraphServer(mock)

    scope = effectScope()
    let rolesApi!: ReturnType<typeof useRoles>
    let pipelinesApi!: ReturnType<typeof usePipelines>
    scope.run(() => {
      rolesApi = useRoles(mock.backend)
      pipelinesApi = usePipelines(mock.backend)
    })
    await flushPromises()

    const w = mount(PipelineManagerModal, {
      props: {
        backend: mock.backend,
        terminalPort: createTerminalDockStub(),
        rolesApi,
        pipelinesApi,
        workspacePath: options.workspacePath ?? WORKSPACE,
        open: true,
        initialPipelineId: options.initialPipelineId,
      },
      global: { plugins: [i18n], stubs: { teleport: true } },
    })
    await flushPromises()
    wrapper = w
    return { wrapper: w, mock, pipelinesApi, server }
  }

  /** The pipelines tab body (index 0; index 1 is the roles tab). */
  const tab = (w: VueWrapper) => w.findAll('.tab-body')[0]

  it('renders the list view in the selected locale', async () => {
    const { wrapper: w } = await open({ locale: 'zh-TW' })

    expect(w.find('.title').text()).toBe(i18n.global.t('label.pipeline-manager'))
    expect(tab(w).text()).toContain(i18n.global.t('action.new-pipeline'))
    expect(tab(w).text()).toContain(i18n.global.t('label.stage-count', { count: 2 }))
    for (const literal of HARD_CODED_ENGLISH) {
      expect(w.find('.app').text()).not.toContain(literal)
    }
  })

  it('renders the pipeline editor in the selected locale', async () => {
    const { wrapper: w } = await open({ locale: 'zh-TW', initialPipelineId: 'default' })

    const text = tab(w).text()
    expect(text).toContain(i18n.global.t('pipelineEditor.toolbar.swimlane'))
    expect(text).toContain(i18n.global.t('pipelineEditor.toolbar.canvas'))
    expect(text).toContain(i18n.global.t('pipelineEditor.lane.parallel', { n: 2 }))
    expect(text).toContain(i18n.global.t('pipelineEditor.palette.agents'))
    for (const literal of HARD_CODED_ENGLISH) {
      expect(w.find('.app').text()).not.toContain(literal)
    }
  })

  it('still reads correctly in en-US (no raw keys leaking through)', async () => {
    const { wrapper: w } = await open({ locale: 'en-US', initialPipelineId: 'default' })

    expect(w.find('.title').text()).toBe('Pipeline Manager')
    expect(tab(w).text()).toContain('2 in parallel')
    expect(w.find('.app').text()).not.toMatch(/\b(label|action|hint|error|pipelineEditor)\.[a-z-]+/)
  })

  it('sends the host workspace with set-default so a running project can veto it', async () => {
    const { wrapper: w, mock } = await open({ initialPipelineId: 'custom' })
    mock.setResponse('pipelines.set_active', {
      active_pipeline_id: 'custom',
      pipelines,
    })

    const setDefault = tab(w)
      .findAll('.pl-detail-actions button')
      .find((b) => b.text().includes(i18n.global.t('action.set-as-default')))
    expect(setDefault).toBeDefined()
    await setDefault!.trigger('click')
    await flushPromises()

    expect(mock.sent.find((s) => s.type === 'pipelines.set_active')?.payload).toEqual({
      pipeline_id: 'custom',
      workspace_path: WORKSPACE,
    })
  })

  it('sends the host workspace with delete so a running project can veto it', async () => {
    const { wrapper: w, mock } = await open({ initialPipelineId: 'custom' })
    mock.setResponse('pipelines.delete', { pipelines: [pipelines[0]] })

    await tab(w).find('.pl-detail-actions .danger-icon').trigger('click')
    await flushPromises()
    // notify.confirm() parks on a host-rendered dialog; say yes for the user.
    expect(useNotify().dialog.value?.kind).toBe('confirm')
    useNotify().resolveDialog(true)
    await flushPromises()

    const sent = mock.sent.find((s) => s.type === 'pipelines.delete')
    expect(sent?.payload).toEqual({ pipeline_id: 'custom', workspace_path: WORKSPACE })
  })
  it('shows the backend reason when the delete is vetoed, not a bare "Delete failed"', async () => {
    const { wrapper: w, mock } = await open({ initialPipelineId: 'custom' })
    mock.setResponse('pipelines.delete', null, {
      ok: false,
      error: { code: 'PIPELINE_RUNNING', message: 'Cannot delete pipeline while a project is running' },
    })

    const before = useNotify().toasts.value.length
    await tab(w).find('.pl-detail-actions .danger-icon').trigger('click')
    await flushPromises()
    useNotify().resolveDialog(true)
    await flushPromises()

    const last = useNotify().toasts.value.slice(before).at(-1)
    expect(last?.type).toBe('error')
    // PIPELINE_RUNNING is a code the UI knows, so it reads in the UI language
    // instead of echoing the backend's English sentence.
    expect(last?.message).toContain('This pipeline is running, so it cannot be changed right now')
    expect(last?.message).not.toContain('Cannot delete pipeline')
  })

  it('reports a failed factory reset instead of doing nothing visible', async () => {
    const { wrapper: w, mock } = await open()
    mock.setResponse('pipelines.reset_builtin', null, {
      ok: false, error: { code: 'ERR', message: 'stages.json is read-only' },
    })

    // "Default" is the builtin row, so it carries the ↺ button.
    const before = useNotify().toasts.value.length
    await tab(w).findAll('.pl-list .icon-btn')[0].trigger('click')
    await flushPromises()
    useNotify().resolveDialog(true)
    await flushPromises()

    const last = useNotify().toasts.value.slice(before).at(-1)
    expect(last?.type).toBe('error')
    expect(last?.message).toContain('stages.json is read-only')
  })
  // ── The detail view is the graph editor ───────────────────────────────────
  // Every edit is a graph op that names the host workspace, which is what lets
  // the backend refuse it while a run in that workspace uses this pipeline.

  async function detail(workspacePath?: string) {
    return open({ initialPipelineId: 'default', workspacePath })
  }

  const sentPayload = (mock: ReturnType<typeof createMockBackend>, type: string) =>
    mock.sent.filter((s) => s.type === type).at(-1)?.payload

  /** The swimlane card for a node id. */
  const card = (w: VueWrapper, id: string) => tab(w).find(`.lane-card[data-node-id="${id}"]`)

  it('opens the pipeline as a graph and draws one column per stage', async () => {
    const { wrapper: w, mock } = await detail()
    expect(sentPayload(mock, 'pipelines.graph.get')).toEqual({ pipeline_id: 'default' })
    expect(tab(w).findAll('.lane')).toHaveLength(2)
    expect(card(w, 'n-01-0').exists()).toBe(true)
    expect(card(w, 'n-01-1').exists()).toBe(true)
    expect(card(w, 'n-02-0').exists()).toBe(true)
  })

  it('sends the workspace with a graph edit', async () => {
    const { wrapper: w, mock, server } = await detail()

    await card(w, 'n-02-0').trigger('keydown', { key: 'Delete' })
    await flushPromises()

    expect(sentPayload(mock, 'pipelines.graph.apply')).toEqual({
      pipeline_id: 'default',
      ops: [{ op: 'remove_node', id: 'n-02-0', reconnect: true }],
      workspace_path: WORKSPACE,
    })
    expect(server.stored().nodes.some((n) => n.id === 'n-02-0')).toBe(false)
    expect(card(w, 'n-02-0').exists()).toBe(false)
  })

  it('still edits when no workspace is open (empty path, guard is a no-op)', async () => {
    const { wrapper: w, mock } = await detail('')
    await card(w, 'n-02-0').trigger('keydown', { key: 'Delete' })
    await flushPromises()
    expect(sentPayload(mock, 'pipelines.graph.apply')).toMatchObject({ workspace_path: '' })
  })

  it('undoes a delete by restoring the graph it replaced', async () => {
    const { wrapper: w, mock, server } = await detail()
    await card(w, 'n-02-0').trigger('keydown', { key: 'Delete' })
    await flushPromises()

    await tab(w).findAll('.pe-bar .pe-icon')[1].trigger('click') // [palette, undo, redo]
    await flushPromises()

    expect(sentPayload(mock, 'pipelines.graph.set')).toMatchObject({ pipeline_id: 'default', workspace_path: WORKSPACE })
    expect(server.stored().nodes.some((n) => n.id === 'n-02-0')).toBe(true)
    expect(card(w, 'n-02-0').exists()).toBe(true)
  })

  it('puts a refused edit back and says why in the UI language', async () => {
    const { wrapper: w, server } = await detail()
    server.refuseNext({ code: 'PIPELINE_RUNNING', message: 'Cannot edit stages while the active pipeline is running' })
    const before = useNotify().toasts.value.length

    await card(w, 'n-02-0').trigger('keydown', { key: 'Delete' })
    await flushPromises()

    expect(card(w, 'n-02-0').exists()).toBe(true)
    const last = useNotify().toasts.value.slice(before).at(-1)
    expect(last?.type).toBe('error')
    expect(last?.message).toContain('This pipeline is running')
  })

  it('reports an edit that never reached the backend instead of swallowing it', async () => {
    const { wrapper: w, server } = await detail()
    server.refuseNext(new Error('ws not open'))
    const before = useNotify().toasts.value.length

    await card(w, 'n-02-0').trigger('keydown', { key: 'Delete' })
    await flushPromises()

    expect(card(w, 'n-02-0').exists()).toBe(true)
    expect(useNotify().toasts.value.slice(before).at(-1)?.message).toContain('ws not open')
  })

  it('sends the workspace with a stage reset', async () => {
    const { wrapper: w, mock } = await detail()
    mock.setResponse('stages.reset', { stages: [twoSlotStage] })

    await tab(w).find('.toolbar .danger-link').trigger('click')
    await flushPromises()
    await w.find('.modal .modal-card .danger').trigger('click')
    await flushPromises()

    expect(sentPayload(mock, 'stages.reset')).toEqual({
      pipeline_id: 'default',
      workspace_path: WORKSPACE,
    })
  })

  it('sends the workspace with every stage written by an import', async () => {
    const { wrapper: w, mock } = await detail()
    const openJson = vi.fn().mockResolvedValue({
      ok: true,
      content: JSON.stringify({ stages: [twoSlotStage, secondStage] }),
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).agentTeam = { openJson }

    const importBtn = tab(w).findAll('.toolbar .ghost')[1]
    await importBtn.trigger('click')
    await flushPromises()

    const imports = mock.sent.filter((s) => s.type === 'stages.upsert')
    expect(imports).toHaveLength(2)
    for (const sent of imports) {
      expect(sent.payload).toMatchObject({ pipeline_id: 'default', workspace_path: WORKSPACE })
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).agentTeam
  })

  it('sends the workspace with a builtin factory reset', async () => {
    const { wrapper: w, mock } = await open()
    mock.setResponse('pipelines.reset_builtin', { pipeline: pipelines[0], pipelines })

    await tab(w).findAll('.pl-list .icon-btn')[0].trigger('click')
    await flushPromises()
    useNotify().resolveDialog(true)
    await flushPromises()

    expect(sentPayload(mock, 'pipelines.reset_builtin')).toEqual({
      pipeline_id: 'default',
      workspace_path: WORKSPACE,
    })
  })

  it('names the first rejected stage on a partially failed import', async () => {
    const { wrapper: w, mock } = await detail()
    mock.setResponse('stages.upsert', null, {
      ok: false, error: { code: 'PIPELINE_RUNNING', message: 'Cannot edit stages while the active pipeline is running' },
    })
    const openJson = vi.fn().mockResolvedValue({
      ok: true,
      content: JSON.stringify({ stages: [twoSlotStage, secondStage] }),
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).agentTeam = { openJson }

    await tab(w).findAll('.toolbar .ghost')[1].trigger('click')
    await flushPromises()

    expect(tab(w).find('.err-msg').text()).toContain('This pipeline is running, so it cannot be changed right now')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).agentTeam
  })

  it('releases the export button and says why when saving the file throws', async () => {
    const { wrapper: w } = await detail()
    const saveJson = vi.fn().mockRejectedValue(new Error('disk full'))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).agentTeam = { saveJson }

    await tab(w).findAll('.toolbar .ghost')[0].trigger('click')
    await flushPromises()

    expect(tab(w).findAll('.toolbar .ghost')[0].attributes('disabled')).toBeUndefined()
    expect(tab(w).find('.err-msg').text()).toContain('disk full')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).agentTeam
  })

  it('locks the editor while a run in this workspace uses the pipeline', async () => {
    const { wrapper: w, mock } = await detail()
    await w.setProps({ hostRun: { state: 'running', pipelineId: 'default', workspacePath: WORKSPACE } })
    await flushPromises()

    expect(tab(w).find('.pe-lock').exists()).toBe(true)
    await card(w, 'n-02-0').trigger('keydown', { key: 'Delete' })
    await flushPromises()
    expect(mock.sent.some((s) => s.type === 'pipelines.graph.apply')).toBe(false)
    expect(card(w, 'n-02-0').exists()).toBe(true)
    // Stage-level writes are disabled up front too.
    expect(tab(w).find('.toolbar .danger-link').attributes('disabled')).toBeDefined()
  })

  it('does not lock for a run of a different pipeline', async () => {
    const { wrapper: w } = await detail()
    await w.setProps({ hostRun: { state: 'running', pipelineId: 'custom', workspacePath: WORKSPACE } })
    await flushPromises()
    expect(tab(w).find('.pe-lock').exists()).toBe(false)
  })

  it('shows a run aborted at a gate as stopped, then waiting on that gate again after resume', async () => {
    const { wrapper: w, mock } = await detail()
    // The graph gets a gate after stage 01 so there is something to wait on.
    const aborted = {
      state: 'aborted', pipeline_id: 'default',
      node_states: { 'n-01-0': { status: 'done' }, 'n-01-1': { status: 'done' } },
      node_gate: { gateId: 'n-02-0', nextIndex: 1 },
    }
    mock.setResponse('project.peek', { project: aborted })
    // The host's run ended (aborted); that state change makes the workspace
    // re-read the project record.
    await w.setProps({ hostRun: { state: 'running', pipelineId: 'default', workspacePath: WORKSPACE } })
    await w.setProps({ hostRun: { state: 'aborted', pipelineId: '', workspacePath: '' } })
    await flushPromises()

    expect(tab(w).find('.pe-lock').exists()).toBe(false)
    expect(card(w, 'n-01-0').classes()).toContain('is-done')
    // Executions offers Resume for the stopped run of this pipeline.
    await tab(w).findAll('.pe-seg-btn')[2].trigger('click')
    await flushPromises()
    expect(tab(w).find('.px-bar').text()).toContain('Resume')
    expect(tab(w).find('.px-gate').exists()).toBe(false)

    // Resume: the host run is live again and the engine reports the gate.
    await w.setProps({ hostRun: { state: 'running', pipelineId: 'default', workspacePath: WORKSPACE } })
    mock.emit('pipeline.node_states_changed', {
      workspace_path: WORKSPACE, pipeline_id: 'default', state: 'running',
      nodes: { ...aborted.node_states, 'n-02-0': { status: 'awaiting' } },
      gate: { gateId: 'n-02-0', label: 'Build', prompt: '', nextIndex: 1 },
    })
    await flushPromises()
    expect(tab(w).find('.pe-lock').exists()).toBe(true)
    // VTU's teleport stub remounts the editor on every prop change (the real
    // Teleport does not), so open the tab again before reading it.
    await tab(w).findAll('.pe-seg-btn')[2].trigger('click')
    await flushPromises()
    expect(tab(w).find('.px-gate').exists()).toBe(true)
    expect(tab(w).find('.px-bar').text()).toContain('Abort')
  })
})

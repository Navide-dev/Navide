// @vitest-environment happy-dom
// n8n import dialog: the dry run must show everything the import would
// create (report rows, every kickoff and gate prompt, credentials and the
// secrets left behind), steps needing review are disclosed but never block
// the import, and Import sends exactly the previewed text.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n, useNotify } from '@navide/plugin-ui/foundation'
import { createMockBackend } from '../../../composables/__tests__/mockBackend'
import type { GraphNode, PipelineGraph } from '../../../lib/pipelineGraph'
import N8nImportDialog from '../N8nImportDialog.vue'

i18n.global.locale.value = 'en-US'

const graph: PipelineGraph = {
  version: 1,
  nodes: [
    { id: 'trigger', kind: 'trigger', label: 'Start', position: { x: 0, y: 0 } },
    { id: 's1', kind: 'slot', label: 'Summarize mail', position: { x: 260, y: 0 }, slot: { agentKey: 'claude', roleKey: '', label: 'Summarize mail', kickoffBody: 'KICKOFF ONE', isCommander: false } },
    { id: 'g1', kind: 'gate', label: 'Approve send', position: { x: 560, y: 0 }, gate: { prompt: 'GATE PROMPT' } },
    { id: 's2', kind: 'slot', label: 'Call sub', position: { x: 860, y: 0 }, slot: { agentKey: 'claude', roleKey: '', label: 'Call sub', kickoffBody: 'KICKOFF TWO', isCommander: false } },
  ],
  edges: [
    { id: 'e1', from: 'trigger', to: 's1', kind: 'main' },
    { id: 'e2', from: 's1', to: 'g1', kind: 'main' },
    { id: 'e3', from: 'g1', to: 's2', kind: 'main' },
  ],
}

function payload(overrides: { needsReview?: number; subworkflow?: boolean } = {}) {
  const needsReview = overrides.needsReview ?? 1
  return {
    dry_run: true,
    graph,
    report: {
      workflow: 'Mail digest',
      nodes: [
        { name: 'Every morning', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, category: 'native', result: 'trigger', node: 'trigger', reason: 'trigger', detail: 'Start it manually or on a schedule.', needsReview: false, actions: ['start-manually'] },
        { name: 'Gmail', type: 'n8n-nodes-base.gmail', typeVersion: 2, category: 'agent', result: 'slot', node: 's1', reason: 'agent', detail: 'Reads mail through an MCP server.', needsReview: false, actions: ['add-credential', 'choose-mcp'] },
        { name: 'Wait for OK', type: 'n8n-nodes-base.wait', typeVersion: 1, category: 'native', result: 'gate', node: 'g1', reason: 'gate', detail: 'Becomes an approval gate.', needsReview: false, actions: [] },
        { name: 'Run sub', type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1, category: 'pending', result: 'slot', node: 's2', reason: 'subworkflow', detail: 'Calls another workflow.', needsReview: needsReview > 0, actions: overrides.subworkflow === false ? ['confirm-step'] : ['paste-subworkflow'] },
        { name: 'Note', type: 'n8n-nodes-base.stickyNote', typeVersion: 1, category: 'unsupported', result: 'removed', node: null, reason: 'sticky', detail: 'Sticky notes are dropped.', needsReview: false, actions: ['keep-in-n8n'] },
      ],
      stats: { nodes: 5, slots: 2, gates: 1, triggers: 1, byCategory: { native: 2, agent: 1, pending: 1, unsupported: 1 }, removed: { disabled: 0, noop: 0, sticky: 1 }, folded: 0, needsReview, overTarget: false },
      slots: [
        { id: 's1', label: 'Summarize mail', agentKey: 'claude', category: 'agent', nodes: ['Gmail'], needsReview: false, kickoffBody: 'KICKOFF ONE', tainted: true },
        { id: 's2', label: 'Call sub', agentKey: 'claude', category: 'pending', nodes: ['Run sub'], needsReview: true, kickoffBody: 'KICKOFF TWO', tainted: true },
      ],
      gates: [{ id: 'g1', label: 'Approve send', prompt: 'GATE PROMPT', tainted: true }],
      nodeCategories: { trigger: 'native', s1: 'agent', g1: 'native', s2: 'pending' },
      secretsRemoved: [{ node: 'Gmail', field: 'parameters.apiKey' }],
      credentials: [{ type: 'gmailOAuth2', name: 'Work mail', nodes: ['Gmail'] }],
      description: '',
      testInputs: {},
      warnings: ['Pinned data was dropped.'],
      taint: { source: 'n8n', detail: '' },
    },
    credentials: [{ type: 'gmailOAuth2', name: 'Work mail', nodes: ['Gmail'] }],
  }
}

const fitAll = vi.fn()

describe('N8nImportDialog', () => {
  let wrapper: VueWrapper | undefined
  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    delete (window as { agentTeam?: unknown }).agentTeam
  })

  function mountDialog() {
    const mock = createMockBackend('connected')
    const w = mount(N8nImportDialog, {
      props: { backend: mock.backend, open: true, workspacePath: '/ws' },
      global: {
        plugins: [i18n],
        stubs: { PipelineCanvas: { name: 'PipelineCanvas', props: ['graph', 'nodeClass'], emits: ['ready'], methods: { fitAll: () => { fitAll() } }, template: '<div class="canvas-stub" />' } },
      },
      attachTo: document.body,
    })
    wrapper = w
    return { w, mock }
  }

  async function previewWith(w: VueWrapper, mock: ReturnType<typeof createMockBackend>, p: unknown = payload()) {
    mock.setResponse('pipelines.import_n8n', p)
    await w.find('textarea').setValue('{"nodes":[],"connections":{}}')
    await w.find('.n8n-preview').trigger('click')
    await flushPromises()
  }

  it('previews with a dry run and the chosen CLI', async () => {
    const { w, mock } = mountDialog()
    await w.find('select').setValue('codex')
    await previewWith(w, mock)
    const sent = mock.sent.filter((s) => s.type === 'pipelines.import_n8n')
    expect(sent).toHaveLength(1)
    expect(sent[0].payload).toMatchObject({ json: '{"nodes":[],"connections":{}}', dry_run: true, default_agent: 'codex', workspace_path: '/ws' })
    expect(sent[0].timeoutMs).toBe(30_000)
  })

  it('shows the report rows, every kickoff and gate prompt, credentials and secret locations', async () => {
    const { w, mock } = mountDialog()
    await previewWith(w, mock)
    const rows = w.findAll('.n8n-row')
    expect(rows).toHaveLength(5)
    expect(rows[2].text()).toContain('Gmail')
    expect(rows[2].text()).toContain('gmail@2')
    expect(rows[2].text()).not.toContain('n8n-nodes-base')
    expect(rows[2].find('code').attributes('title')).toBe('n8n-nodes-base.gmail')
    expect(rows[2].text()).toContain('Summarize mail')
    expect(rows[2].text()).toContain(i18n.global.t('pipelineImport.action-code.choose-mcp'))
    expect(rows[4].text()).toContain(i18n.global.t('pipelineImport.category.unsupported'))
    const kickoffs = w.findAll('.n8n-kickoff pre').map((p) => p.text())
    expect(kickoffs).toEqual(['KICKOFF ONE', 'KICKOFF TWO'])
    expect(w.find('.n8n-gate pre').text()).toBe('GATE PROMPT')
    expect(w.find('.n8n-credentials').text()).toContain('gmailOAuth2')
    expect(w.find('.n8n-credentials').text()).toContain('Work mail')
    expect(w.find('.n8n-secrets').text()).toContain('parameters.apiKey')
    expect(w.text()).toContain('Pinned data was dropped.')
    expect(w.find('[data-testid="n8n-external"]').exists()).toBe(true)
  })

  it('shows the whole graph once the canvas is ready, and again for a new preview', async () => {
    const { w, mock } = mountDialog()
    await previewWith(w, mock, payload())
    fitAll.mockClear()
    const first = w.findComponent({ name: 'PipelineCanvas' })
    first.vm.$emit('ready')
    await flushPromises()
    expect(fitAll).toHaveBeenCalledTimes(1)
    await w.find('textarea').setValue('{"name":"other","nodes":[],"connections":{}}')
    await w.find('.n8n-preview').trigger('click')
    await flushPromises()
    expect(w.findComponent({ name: 'PipelineCanvas' }).vm).not.toBe(first.vm)
  })

  it('colors canvas nodes by category, unsupported apart from pending', async () => {
    const { w, mock } = mountDialog()
    const p = payload()
    p.report.nodeCategories = { ...p.report.nodeCategories, g1: 'unsupported' }
    await previewWith(w, mock, p)
    const nodeClass = w.findComponent({ name: 'PipelineCanvas' }).props('nodeClass') as (n: GraphNode) => string
    expect(nodeClass(graph.nodes[1])).toContain('n8n-cat--agent')
    expect(nodeClass(graph.nodes[2])).toContain('n8n-cat--unsupported')
    expect(nodeClass(graph.nodes[3])).toContain('n8n-cat--pending')
    const unsupportedRow = w.findAll('.n8n-row').find((r) => r.text().includes('Note'))!
    expect(unsupportedRow.find('.n8n-swatch').classes()).toContain('n8n-swatch--unsupported')
  })

  it('puts the rows needing review first, the rest in workflow order', async () => {
    const { w, mock } = mountDialog()
    await previewWith(w, mock)
    const names = w.findAll('.n8n-row').map((r) => r.find('td').text())
    expect(names[0]).toContain('Run sub')
    expect(names.slice(1).map((n) => n.split(' ')[0])).toEqual(['Every', 'Gmail', 'Wait', 'Note'])
  })

  it('expands a step that merged several n8n nodes to name them', async () => {
    const { w, mock } = mountDialog()
    const p = payload()
    p.report.slots[0] = { ...p.report.slots[0], label: 'Summarize mail (+1)', nodes: ['Gmail', 'Format'] }
    await previewWith(w, mock, p)
    const row = w.findAll('.n8n-row').find((r) => r.text().includes('gmail@2'))!
    const merged = row.find('details.n8n-merged')
    expect(merged.find('summary').text()).toContain('Summarize mail')
    expect(merged.text()).toContain(i18n.global.t('pipelineImport.merged-nodes', { n: 2 }, 2))
    expect(merged.findAll('li').map((li) => li.text())).toEqual(['Gmail', 'Format'])
    // A step of one node has nothing to expand.
    const single = w.findAll('.n8n-row').find((r) => r.text().includes('Run sub'))!
    expect(single.find('details.n8n-merged').exists()).toBe(false)
  })

  it('lists the called workflows and how many pipelines the import creates', async () => {
    const { w, mock } = mountDialog()
    const p = payload() as ReturnType<typeof payload> & { report: { subworkflows?: unknown } }
    p.report.subworkflows = [
      { workflowId: 'wf-b', name: 'Send reply', status: 'will-import' },
      { workflowId: 'wf-z', name: '', status: 'missing' },
    ]
    await previewWith(w, mock, p)
    const list = w.find('[data-testid="n8n-subworkflows"]')
    expect(list.text()).toContain(i18n.global.t('pipelineImport.will-create', { n: 2 }, 2))
    expect(list.text()).toContain('Send reply')
    expect(list.text()).toContain(i18n.global.t('pipelineImport.subworkflow-status.will-import'))
    expect(list.text()).toContain('wf-z')
    expect(list.text()).toContain(i18n.global.t('pipelineImport.subworkflow-status.missing'))
  })

  it('translates details, warnings and error details by their code', async () => {
    const { w, mock } = mountDialog()
    const p = payload() as ReturnType<typeof payload> & { report: { warningItems?: unknown } }
    Object.assign(p.report.nodes[1], { detailCode: 'agent-step', detailParams: {} })
    Object.assign(p.report.nodes[3], { detailCode: 'no-such-code', detailParams: {} })
    p.report.warningItems = [{ code: 'over-target', params: { slots: 9, target: 8 }, text: 'Pinned data was dropped.' }]
    await previewWith(w, mock, p)
    expect(w.text()).toContain(i18n.global.t('pipelineImport.detail.agent-step'))
    expect(w.text()).not.toContain('Reads mail through an MCP server.')
    expect(w.text()).toContain('Calls another workflow.') // unknown code: the backend's sentence
    expect(w.find('.n8n-warnings').text()).toContain(i18n.global.t('pipelineImport.warning.over-target', { slots: 9, target: 8 }))
    expect(w.find('.n8n-warnings').text()).not.toContain('Pinned data was dropped.')
    mock.setResponse('pipelines.import_n8n', null, { ok: false, error: {
      code: 'N8N_TOO_LARGE', message: 'the workflow is 6.2 MB', details: { reason: 'too-large', params: { sizeMb: 6.2, limitMb: 5 } },
    } })
    await w.find('textarea').setValue('{"other":1}')
    await w.find('.n8n-preview').trigger('click')
    await flushPromises()
    expect(w.find('.n8n-error').text()).toContain(i18n.global.t('pipelineImport.error-reason.too-large', { sizeMb: 6.2, limitMb: 5 }))
    mock.setResponse('pipelines.import_n8n', null, { ok: false, error: {
      code: 'N8N_INVALID', message: 'workflow 2: node 0 needs a name and a type', details: { reason: 'node-shape', params: { index: 0, workflow: 2 } },
    } })
    await w.find('.n8n-preview').trigger('click')
    await flushPromises()
    const detail = w.find('.n8n-error-detail').text()
    expect(detail).toBe(i18n.global.t('pipelineImport.error-in-workflow', {
      n: 2, message: i18n.global.t('pipelineImport.error-reason.node-shape', { index: 0 }) }))
  })

  it('refuses a workflow over 5 MB before sending it', async () => {
    const { w, mock } = mountDialog()
    await w.find('textarea').setValue('x'.repeat(5 * 1024 * 1024 + 1))
    await w.find('.n8n-preview').trigger('click')
    await flushPromises()
    expect(mock.sent.filter((s) => s.type === 'pipelines.import_n8n')).toHaveLength(0)
    expect(w.find('.n8n-error').text()).toContain(i18n.global.t('pipelineImport.error-reason.too-large', { sizeMb: 5, limitMb: 5 }))
  })

  it('discloses steps needing review without disabling Import', async () => {
    const { w, mock } = mountDialog()
    await previewWith(w, mock)
    const notice = w.find('[data-testid="n8n-needs-review"]')
    expect(notice.text()).toContain('1 step needs review')
    expect(w.find('.n8n-import-btn').attributes('disabled')).toBeUndefined()
  })

  it('asks for the sub-workflow only when a node needs it', async () => {
    const { w, mock } = mountDialog()
    await previewWith(w, mock)
    expect(w.find('[data-testid="n8n-subworkflow"]').exists()).toBe(true)
    await previewWith(w, mock, payload({ subworkflow: false, needsReview: 0 }))
    expect(w.find('[data-testid="n8n-subworkflow"]').exists()).toBe(false)
    expect(w.find('[data-testid="n8n-needs-review"]').exists()).toBe(false)
  })

  it('imports with dry_run false and emits the new pipeline id', async () => {
    const { w, mock } = mountDialog()
    await previewWith(w, mock)
    mock.setResponse('pipelines.import_n8n', { ...payload(), dry_run: false, pipeline: { id: 'n8n-mail' } })
    await w.find('.n8n-import-btn').trigger('click')
    await flushPromises()
    const last = mock.sent.filter((s) => s.type === 'pipelines.import_n8n').at(-1)!
    expect(last.payload).toMatchObject({ dry_run: false, default_agent: 'claude', workspace_path: '/ws' })
    expect(w.emitted('imported')?.[0]).toEqual(['n8n-mail'])
    expect(w.emitted('close')).toHaveLength(1)
  })

  it('counts "needs review" the way the banner does', async () => {
    const { w, mock } = mountDialog()
    // An unknown community node folded into an agent step: its category is
    // not "pending", but it is the step the banner asks you to review.
    const p = payload()
    p.report.stats.byCategory = { native: 2, agent: 2, pending: 0, unsupported: 1 }
    await previewWith(w, mock, p)
    expect(w.find('[data-testid="n8n-needs-review"]').text()).toContain('1 step needs review')
    expect(w.find('.n8n-categories [data-category="pending"] strong').text()).toBe('1')
  })

  it('says why Import is disabled', async () => {
    const { w, mock } = mountDialog()
    expect(w.find('.n8n-import-btn').attributes('title')).toBe(i18n.global.t('pipelineImport.import-blocked-preview'))
    await previewWith(w, mock)
    expect(w.find('.n8n-import-btn').attributes('title')).toBeUndefined()
    await w.find('textarea').setValue('{"nodes":[1],"connections":{}}')
    expect(w.find('.n8n-import-btn').attributes('title')).toBe(i18n.global.t('pipelineImport.preview-stale'))
  })

  it('says the import is done and how many steps to check', async () => {
    const { w, mock } = mountDialog()
    await previewWith(w, mock)
    const before = useNotify().toasts.value.length
    mock.setResponse('pipelines.import_n8n', { ...payload(), dry_run: false, pipeline: { id: 'n8n-mail', name: 'Mail digest (2)' } })
    await w.find('.n8n-import-btn').trigger('click')
    await flushPromises()
    const toast = useNotify().toasts.value.slice(before).at(-1)
    expect(toast?.message).toBe(i18n.global.t('pipelineImport.imported-review', { name: 'Mail digest (2)', n: 1 }, 1))
    expect(toast?.type).toBe('success')
  })

  it('opens the pipeline an earlier, timed-out import made instead of a copy', async () => {
    const { w, mock } = mountDialog()
    await previewWith(w, mock)
    const before = useNotify().toasts.value.length
    const send = mock.backend.send
    let calls = 0
    mock.backend.send = ((...args: Parameters<typeof send>) => {
      if (args[0] === 'pipelines.import_n8n' && (args[1] as { dry_run: boolean }).dry_run === false && calls++ === 0) {
        return Promise.reject(new Error('request timed out'))
      }
      return send(...args)
    }) as typeof send
    mock.setResponse('pipelines.import_n8n', { ...payload({ needsReview: 0 }), dry_run: false, reused: true, pipeline: { id: 'n8n-mail', name: 'Mail digest' } })
    await w.find('.n8n-import-btn').trigger('click')
    await flushPromises()
    expect(calls).toBe(2)
    expect(w.emitted('imported')?.[0]).toEqual(['n8n-mail'])
    expect(useNotify().toasts.value.slice(before).at(-1)?.message).toBe(
      i18n.global.t('pipelineImport.imported-reused', { name: 'Mail digest' }))
  })

  it('says a second timeout may still finish, and that Import again makes no copy', async () => {
    const { w, mock } = mountDialog()
    await previewWith(w, mock)
    mock.setRejection('pipelines.import_n8n', 'request timed out')
    await w.find('.n8n-import-btn').trigger('click')
    await flushPromises()
    expect(w.find('.n8n-error').text()).toContain(i18n.global.t('pipelineImport.import-timeout'))
    expect(w.emitted('imported')).toBeUndefined()
  })

  it('needs a fresh preview after the JSON changes', async () => {
    const { w, mock } = mountDialog()
    expect(w.find('.n8n-import-btn').attributes('disabled')).toBeDefined()
    await previewWith(w, mock)
    await w.find('textarea').setValue('{"nodes":[1],"connections":{}}')
    expect(w.find('.n8n-import-btn').attributes('disabled')).toBeDefined()
  })

  it('shows N8N_INVALID inline with the backend detail', async () => {
    const { w, mock } = mountDialog()
    mock.setResponse('pipelines.import_n8n', null, { ok: false, error: { code: 'N8N_INVALID', message: 'not valid JSON' } })
    await w.find('textarea').setValue('nope')
    await w.find('.n8n-preview').trigger('click')
    await flushPromises()
    const err = w.find('.n8n-error')
    expect(err.text()).toContain(i18n.global.t('pipelineImport.error.invalid'))
    expect(err.text()).toContain('not valid JSON')
    expect(w.find('.n8n-import-btn').attributes('disabled')).toBeDefined()
  })

  it('fills the textarea from the file chooser', async () => {
    const openJson = vi.fn().mockResolvedValue({ ok: true, content: '{"from":"file"}' })
    ;(window as { agentTeam?: unknown }).agentTeam = { openJson }
    const { w } = mountDialog()
    await w.find('.n8n-choose').trigger('click')
    await flushPromises()
    expect(openJson).toHaveBeenCalledWith({ title: i18n.global.t('pipelineImport.choose-file-title') })
    expect((w.find('textarea').element as HTMLTextAreaElement).value).toBe('{"from":"file"}')
  })
})

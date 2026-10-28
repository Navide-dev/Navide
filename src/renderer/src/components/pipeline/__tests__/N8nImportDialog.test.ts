// @vitest-environment happy-dom
// n8n import dialog: the dry run must show everything the import would
// create (report rows, every kickoff and gate prompt, credentials and the
// secrets left behind), steps needing review are disclosed but never block
// the import, and Import sends exactly the previewed text.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
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
        stubs: { PipelineCanvas: { name: 'PipelineCanvas', props: ['graph', 'nodeClass'], template: '<div class="canvas-stub" />' } },
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
    expect(rows[1].text()).toContain('Gmail')
    expect(rows[1].text()).toContain('n8n-nodes-base.gmail@2')
    expect(rows[1].text()).toContain('Summarize mail')
    expect(rows[1].text()).toContain(i18n.global.t('pipelineImport.action-code.choose-mcp'))
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

  it('colors canvas nodes by category, unsupported like pending', async () => {
    const { w, mock } = mountDialog()
    await previewWith(w, mock)
    const nodeClass = w.findComponent({ name: 'PipelineCanvas' }).props('nodeClass') as (n: GraphNode) => string
    expect(nodeClass(graph.nodes[1])).toContain('n8n-cat--agent')
    expect(nodeClass(graph.nodes[2])).toContain('n8n-cat--native')
    expect(nodeClass(graph.nodes[3])).toContain('n8n-cat--pending')
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

// @vitest-environment happy-dom
// A ROLE_IN_USE rejection names every stage slot still pointing at the role.
// The modal used to show only the backend sentence ("still used by N slots"),
// which tells the user they are blocked but not where to go and fix it.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils'
import { defineComponent, effectScope, type EffectScope } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import { useRoles, type Role } from '../../composables/useRoles'
import { usePipelines, type PipelineSummary } from '../../composables/usePipelines'
import { createTerminalDockStub } from '../../ports/__tests__/terminalDock.stub'
import { deriveGraphFromStages } from '../../lib/pipelineGraph'
import { stageDefToFrontend } from '../../data/stages'

vi.mock('@navide/plugin-shell', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@navide/plugin-shell')>()),
  AiCliDock: defineComponent({ name: 'AiCliDock', render: () => null }),
}))

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PipelineManagerModal = (await import('../PipelineManagerModal.vue')).default as any

const qa: Role = { key: 'qa', label: 'QA Engineer', one_line: 'tests it', system_prompt: '# QA' }
const pm: Role = { key: 'pm', label: 'Project Manager', one_line: 'plans', system_prompt: '# PM' }
const roles: Role[] = [pm, qa]

const pipelines: PipelineSummary[] = [
  { id: 'default', name: 'Default', builtin: true, stage_count: 2 },
  { id: 'custom', name: 'Custom', builtin: false, stage_count: 1 },
]

const stage = (id: string, title: string, slotLabel: string) => ({
  id,
  title,
  short_title: title,
  question: '',
  description: '',
  recommended_roles: [],
  sentinel: '',
  allow_questions: false,
  doc_query: '',
  slots: [{ agent_key: 'claude', role_key: 'qa', label: slotLabel, kickoff_body: '', is_commander: false }],
})

const USAGES = [
  { pipeline_id: 'default', pipeline_name: 'Default', stage_id: '02', stage_title: 'Build', slot_label: 'Lead' },
  { pipeline_id: 'custom', pipeline_name: 'Custom', stage_id: '01', stage_title: 'Spec', slot_label: 'Second' },
]

describe('PipelineManagerModal — ROLE_IN_USE usage list', () => {
  let wrapper: VueWrapper | undefined
  let scope: EffectScope | undefined

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    scope?.stop()
    scope = undefined
    i18n.global.locale.value = 'en-US'
  })

  async function open() {
    i18n.global.locale.value = 'en-US'
    const mock = createMockBackend('connected')
    mock.setResponse('roles.list', { roles, path: '/data/roles.json' })
    mock.setResponse('pipelines.list', {
      pipelines, active_pipeline_id: 'default', path: '/data/pipelines.json',
    })
    mock.setResponse('stages.list', {
      stages: [stage('01', 'Spec', 'Second'), stage('02', 'Build', 'Lead')],
      pipeline_id: 'default',
      path: '/data/stages.json',
    })

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
        workspacePath: '/tmp/ws',
        open: true,
      },
      global: { plugins: [i18n], stubs: { teleport: true } },
    })
    await flushPromises()
    wrapper = w
    await w.findAll('.tabs button')[1].trigger('click')
    await flushPromises()
    return { wrapper: w, mock }
  }

  /** The roles tab body (index 1; index 0 is the pipelines tab). */
  const tab = (w: VueWrapper): DOMWrapper<Element> => w.findAll('.tab-body')[1]

  function rejectDelete(mock: ReturnType<typeof createMockBackend>, usages = USAGES): void {
    mock.setResponse('roles.delete', null, {
      ok: false,
      error: {
        code: 'ROLE_IN_USE',
        message: "role 'qa' is still used by 2 pipeline stage slot(s)",
        details: { role_key: 'qa', usages },
      },
    })
  }

  /** Select QA (label-sorted: Project Manager, QA Engineer) and confirm delete. */
  async function deleteQa(w: VueWrapper): Promise<void> {
    await tab(w).findAll('.split-list li')[1].trigger('click')
    await flushPromises()
    await tab(w).find('.detail-head .danger').trigger('click')
    await flushPromises()
    await w.find('.modal .modal-card .danger').trigger('click')
    await flushPromises()
  }

  it('lists the blocking pipeline › stage › slot for each usage', async () => {
    const { wrapper: w, mock } = await open()
    rejectDelete(mock)

    await deleteQa(w)

    expect(tab(w).find('.err-msg').text()).toContain('still used by 2 pipeline stage slot(s)')
    const items = tab(w).findAll('.role-usage-list li')
    expect(items).toHaveLength(2)
    expect(items[0].text()).toContain('Default')
    expect(items[0].text()).toContain('Build')
    expect(items[0].text()).toContain('Lead')
    expect(items[1].text()).toContain('Custom')
    expect(items[1].text()).toContain('Spec')
    expect(items[1].text()).toContain('Second')
    expect(tab(w).text()).toContain(i18n.global.t('hint.role-in-use-list'))
  })

  it('translates the list heading', async () => {
    const { wrapper: w, mock } = await open()
    rejectDelete(mock)
    i18n.global.locale.value = 'zh-TW'
    await flushPromises()

    await deleteQa(w)

    expect(tab(w).text()).toContain(i18n.global.t('hint.role-in-use-list'))
    expect(tab(w).find('.role-usage-list').exists()).toBe(true)
  })

  it('drops the list when the next delete is rejected for another reason', async () => {
    const { wrapper: w, mock } = await open()
    rejectDelete(mock)
    await deleteQa(w)
    expect(tab(w).findAll('.role-usage-list li')).toHaveLength(2)

    mock.setResponse('roles.delete', null, {
      ok: false, error: { code: 'ERR', message: 'roles.json is read-only' },
    })
    await deleteQa(w)

    expect(tab(w).find('.err-msg').text()).toContain('roles.json is read-only')
    expect(tab(w).find('.role-usage-list').exists()).toBe(false)
  })

  it('drops the list when the user moves to another role', async () => {
    const { wrapper: w, mock } = await open()
    rejectDelete(mock)
    await deleteQa(w)
    expect(tab(w).find('.role-usage-list').exists()).toBe(true)

    await tab(w).findAll('.split-list li')[0].trigger('click')
    await flushPromises()

    expect(tab(w).find('.role-usage-list').exists()).toBe(false)
  })

  it('jumps to the offending stage when a usage is clicked', async () => {
    const { wrapper: w, mock } = await open()
    // The editor opens the pipeline as a graph; stage 02's "Lead" slot is the
    // node n-02-0 (deriveGraphFromStages' naming).
    mock.setResponse('pipelines.graph.get', {
      pipeline_id: 'default',
      graph: deriveGraphFromStages([stage('01', 'Spec', 'Second'), stage('02', 'Build', 'Lead')].map(stageDefToFrontend)),
      derived: true,
      stages: [],
    })
    rejectDelete(mock)
    await deleteQa(w)

    await tab(w).findAll('.role-usage-list button')[0].trigger('click')
    await flushPromises()

    // Landed on the pipelines tab, in Default's editor, on stage 02's slot.
    expect(w.findAll('.tabs button')[0].classes()).toContain('active')
    const pipelinesTab = w.findAll('.tab-body')[0]
    expect(pipelinesTab.find('.pl-detail-title').text()).toContain('Default')
    expect(pipelinesTab.find('.lane-card.is-selected').attributes('data-node-id')).toBe('n-02-0')
    expect(pipelinesTab.find('.pi-title').text()).toBe('Lead')
    expect(mock.sent.filter((s) => s.type === 'stages.list').at(-1)?.payload).toEqual({
      pipeline_id: 'default',
    })
  })
})

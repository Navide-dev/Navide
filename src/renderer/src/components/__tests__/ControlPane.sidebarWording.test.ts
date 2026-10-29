// @vitest-environment happy-dom
// The sidebar's run controls and pane setup line follow the UI language:
// "Next → <stage>" and the setup / role / kickoff status words used to be
// English in every locale.
import { afterEach, describe, expect, it } from 'vitest'
import { shallowMount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import ControlPane from '../ControlPane.vue'

const STAGES = [
  { id: '01', title: 'Plan', shortTitle: 'Plan', slots: [] },
  { id: '02', title: 'Review', shortTitle: 'Review', slots: [] },
]

const PANE = {
  id: 'pane-a', agentLabel: 'Claude', agentKey: 'claude', status: 'running', command: 'claude',
  origin: 'pipeline', stageId: '01', isMinimized: false, isCommander: false,
  preparationStatus: 'ready', injectionStatus: 'sent', kickoffStatus: 'unverified',
}

function mount(tab: string, opts: { locale?: 'en-US' | 'zh-TW'; pipelines?: unknown[]; state?: string } = {}): VueWrapper {
  i18n.global.locale.value = opts.locale ?? 'zh-TW'
  sessionStorage.setItem('agentTeam.sidebarTab', tab)
  return shallowMount(ControlPane as never, {
    props: {
      backendStatus: 'connected', backendUrl: '', agentSpecs: [], roles: [], stages: STAGES, panes: [PANE],
      pipeline: { state: opts.state ?? 'running', stageIndex: 0, totalStages: 2, task: '', awaitingGate: null },
      pipelines: opts.pipelines ?? [{ id: 'p1', name: 'Custom', builtin: false, stage_count: 2 }],
      activePipelineId: 'p1',
      yoloEnabled: false, analyzerModel: '',
      analyzerStatus: { available: false, version: '', defaultModel: '', models: [], benchmarkResults: [] },
      autoAnswerEnabled: false, existingProject: null, workspace: '/tmp/ws', workspaces: [],
    } as never,
    global: { plugins: [i18n] },
  })
}

const t = (key: string, args: Record<string, unknown> = {}) => i18n.global.t(key, args)

describe('ControlPane – sidebar wording follows the UI language', () => {
  let wrapper: VueWrapper | undefined
  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    sessionStorage.clear()
    i18n.global.locale.value = 'en-US'
  })

  it('labels Next with the locale string, not a hard-coded "Next →"', () => {
    wrapper = mount('pipeline')
    const next = wrapper.findAll('.pipeline-running button.primary').map((b) => b.text())
    expect(next).toContain(t('pipelineEditor.controlPane.next-stage', { stage: 'Review' }))
    expect(next.some((s) => s.startsWith('Next →'))).toBe(false)
  })

  it('words the setup, role and kickoff status of a pipeline pane in the UI language', async () => {
    wrapper = mount('agents')
    await wrapper.find('.agent-line').trigger('click')
    const line = wrapper.find('.stage-line').text()
    expect(line).toContain(t('pipelineEditor.paneStatus.setup.ready'))
    expect(line).toContain(t('pipelineEditor.paneStatus.role.sent'))
    expect(line).toContain(t('pipelineEditor.paneStatus.kickoff.unverified'))
    expect(line).not.toMatch(/setup:|role:|kickoff:/)
  })

  it('lists a builtin pipeline under its name in the UI language until it is renamed', () => {
    wrapper = mount('pipeline', {
      locale: 'en-US',
      state: 'idle',
      pipelines: [
        { id: 'default', name: '預設流程', builtin: true, stage_count: 5 },
        { id: 'maintenance', name: 'Nightly chores', builtin: true, stage_count: 2 },
      ],
    })
    expect(wrapper.findAll('.pipeline-item-name').map((n) => n.text())).toEqual(['Default Pipeline', 'Nightly chores'])
  })
})

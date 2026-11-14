// @vitest-environment happy-dom
// The sidebar's run controls say why they cannot be used: the last stage
// explains how the run ends instead of showing a Finish button that never
// works, a disabled Run names the condition holding it back, and Reset —
// which closes every pane — is styled as the destructive action it is.
import { afterEach, describe, expect, it } from 'vitest'
import { shallowMount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import ControlPane from '../ControlPane.vue'

const STAGES = [
  { id: '01', title: 'Plan', shortTitle: 'Plan', slots: [] },
  { id: '02', title: 'Review', shortTitle: 'Review', slots: [] },
]

interface CardOpts {
  state?: string
  stageIndex?: number
  backendStatus?: string
  workspace?: string
  stages?: typeof STAGES
}

function mountCard(opts: CardOpts = {}): VueWrapper {
  i18n.global.locale.value = 'en-US'
  sessionStorage.setItem('agentTeam.sidebarTab', 'pipeline')
  const stages = opts.stages ?? STAGES
  return shallowMount(ControlPane as never, {
    props: {
      backendStatus: opts.backendStatus ?? 'connected', backendUrl: '', agentSpecs: [], roles: [], stages, panes: [],
      pipeline: { state: opts.state ?? 'running', stageIndex: opts.stageIndex ?? 0, totalStages: stages.length, task: '', awaitingGate: null },
      pipelines: [{ id: 'p1', name: 'Custom', builtin: false, stage_count: stages.length }],
      activePipelineId: 'p1',
      yoloEnabled: false, analyzerModel: '',
      analyzerStatus: { available: false, version: '', defaultModel: '', models: [], benchmarkResults: [] },
      autoAnswerEnabled: false, existingProject: null, workspace: opts.workspace ?? '/tmp/ws', workspaces: [],
    } as never,
    global: { plugins: [i18n] },
  })
}

async function openDetail(w: VueWrapper): Promise<VueWrapper> {
  ;(w.vm as unknown as { openPipelineDetail: (id: string) => void }).openPipelineDetail('p1')
  await w.vm.$nextTick()
  return w
}

const runButton = (w: VueWrapper) => w.findAll('.pipeline-row button.primary').find((b) => b.text() === '▶ Run Pipeline')!
const t = (key: string) => i18n.global.t(key)

describe('ControlPane – run controls', () => {
  let wrapper: VueWrapper | undefined
  afterEach(() => { wrapper?.unmount(); wrapper = undefined; sessionStorage.clear() })

  it('explains how the last stage ends instead of a Finish button that never works', () => {
    wrapper = mountCard({ stageIndex: 1 })
    const buttons = wrapper.findAll('.pipeline-running button').map((b) => b.text())
    expect(buttons).not.toContain('Finish')
    expect(wrapper.find('.pipeline-last-stage').text()).toBe(t('pipelineEditor.controlPane.last-stage'))
  })

  it('keeps Next on an earlier stage, with no last-stage note', () => {
    wrapper = mountCard({ stageIndex: 0 })
    expect(wrapper.findAll('.pipeline-running button').some((b) => b.text().startsWith('Next'))).toBe(true)
    expect(wrapper.find('.pipeline-last-stage').exists()).toBe(false)
  })

  it('names what holds a disabled Run back', async () => {
    const cases: Array<[CardOpts, string]> = [
      [{ state: 'idle', backendStatus: 'disconnected' }, 'pipelineEditor.run.blocked-backend'],
      [{ state: 'idle', workspace: '' }, 'pipelineEditor.run.blocked-workspace'],
      [{ state: 'idle', stages: [] }, 'pipelineEditor.state.empty-title'],
      [{ state: 'idle' }, 'pipelineEditor.run.blocked-task'],
    ]
    for (const [opts, key] of cases) {
      const w = await openDetail(mountCard(opts))
      const run = runButton(w)
      expect(run.attributes('disabled')).toBeDefined()
      expect(run.attributes('title')).toBe(t(key))
      expect(w.find('.pipeline-run-blocked').text()).toBe(t(key))
      w.unmount()
    }
  })

  it('styles Reset as destructive and still hands it to the host to confirm', async () => {
    wrapper = await openDetail(mountCard({ state: 'aborted' }))
    const reset = wrapper.findAll('.pipeline-row button').find((b) => b.text() === 'Reset')!
    expect(reset.classes()).toContain('danger')
    await reset.trigger('click')
    expect(wrapper.emitted('pipeline-reset')).toHaveLength(1)
  })
})

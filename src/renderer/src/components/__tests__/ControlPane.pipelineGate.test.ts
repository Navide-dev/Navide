// @vitest-environment happy-dom
// A run paused on a gate says so on the sidebar's run card, offers the gate's
// decision there, and keeps Next disabled until it is made.
import { afterEach, describe, expect, it } from 'vitest'
import { shallowMount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import ControlPane from '../ControlPane.vue'

const STAGES = [
  { id: '01', title: 'Plan', shortTitle: 'Plan', slots: [] },
  { id: '02', title: 'Review', shortTitle: 'Review', slots: [] },
]

function mountCard(awaitingGate: { gateId: string; label: string } | null): VueWrapper {
  i18n.global.locale.value = 'en-US'
  sessionStorage.setItem('agentTeam.sidebarTab', 'pipeline')
  return shallowMount(ControlPane as never, {
    props: {
      backendStatus: 'connected', backendUrl: '', agentSpecs: [], roles: [], stages: STAGES, panes: [],
      pipeline: { state: 'running', stageIndex: 0, totalStages: 2, task: 'Ship it', awaitingGate },
      pipelines: [{ id: 'p1', name: 'Custom', builtin: false, stage_count: 2 }],
      activePipelineId: 'p1',
      yoloEnabled: false, analyzerModel: '',
      analyzerStatus: { available: false, version: '', defaultModel: '', models: [], benchmarkResults: [] },
      autoAnswerEnabled: false, existingProject: null, workspace: '/tmp/ws', workspaces: [],
    } as never,
    global: { plugins: [i18n] },
  })
}

function nextButton(wrapper: VueWrapper) {
  const btn = wrapper.findAll('.pipeline-running button.primary').find((b) => b.text().startsWith('Next'))
  if (!btn) throw new Error('no Next button')
  return btn
}

describe('ControlPane – run paused on a gate', () => {
  let wrapper: VueWrapper | undefined
  afterEach(() => { wrapper?.unmount(); wrapper = undefined; sessionStorage.clear() })

  it('names the gate and disables Next with the reason', () => {
    wrapper = mountCard({ gateId: 'g1', label: 'Design OK?' })
    expect(wrapper.find('.pipeline-gate-label').text()).toBe('Waiting for your approval at Design OK?')
    const next = nextButton(wrapper)
    expect(next.attributes('disabled')).toBeDefined()
    expect(next.attributes('title')).toBe('Approve or send back this gate before moving on to the next stage.')
    expect(wrapper.find('.pipeline-gate-why').text()).toBe('Approve or send back this gate before moving on to the next stage.')
  })

  it('approve and send back go out with the gate id', async () => {
    wrapper = mountCard({ gateId: 'g1', label: 'Design OK?' })
    await wrapper.find('.pipeline-gate-approve').trigger('click')
    await wrapper.find('.pipeline-gate-reject').trigger('click')
    expect(wrapper.emitted('pipeline-gate-approve')).toEqual([['g1']])
    expect(wrapper.emitted('pipeline-gate-reject')).toEqual([['g1']])
  })

  it('without a gate the card has no gate row and Next is enabled', () => {
    wrapper = mountCard(null)
    expect(wrapper.find('.pipeline-gate').exists()).toBe(false)
    const next = nextButton(wrapper)
    expect(next.attributes('disabled')).toBeUndefined()
    expect(next.attributes('title')).toBeUndefined()
  })
})

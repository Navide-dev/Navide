// @vitest-environment happy-dom
// PR-E E4: running a pipeline that is not the default no longer makes it the
// default, so the sidebar's run card names the run's own pipeline
// (runPipelineId), not the default one, and "open in canvas" opens that one.
import { afterEach, describe, expect, it } from 'vitest'
import { shallowMount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import ControlPane from '../ControlPane.vue'

function mountCard(runPipelineId: string): VueWrapper {
  i18n.global.locale.value = 'en-US'
  sessionStorage.setItem('agentTeam.sidebarTab', 'pipeline')
  return shallowMount(ControlPane as never, {
    props: {
      backendStatus: 'connected', backendUrl: '', agentSpecs: [], roles: [], stages: [{ id: '01', title: 'A', shortTitle: 'A', slots: [] }], panes: [],
      pipeline: { state: 'running', stageIndex: 0, totalStages: 1, task: 'nightly report', awaitingGate: null },
      pipelines: [{ id: 'default', name: 'Default', builtin: true, stage_count: 6 }, { id: 'nightly', name: 'Nightly', builtin: false, stage_count: 1 }],
      activePipelineId: 'default',
      runPipelineId,
      yoloEnabled: false, analyzerModel: '',
      analyzerStatus: { available: false, version: '', defaultModel: '', models: [], benchmarkResults: [] },
      autoAnswerEnabled: false, existingProject: null, workspace: '/tmp/ws', workspaces: [],
    } as never,
    global: { plugins: [i18n] },
  })
}

describe('ControlPane – a run of a pipeline that is not the default', () => {
  let wrapper: VueWrapper | undefined
  afterEach(() => { wrapper?.unmount(); wrapper = undefined; sessionStorage.clear() })

  it('names the run’s pipeline and opens it in the canvas', async () => {
    wrapper = mountCard('nightly')
    expect(wrapper.get('.prn-title').text()).toContain('Nightly')
    await wrapper.get('.prn-open').trigger('click')
    expect(wrapper.emitted('open-pipeline-manager')).toEqual([['nightly']])
  })

  it('falls back to the default pipeline before any run has an id', () => {
    wrapper = mountCard('')
    expect(wrapper.get('.prn-title').text()).toContain('Default')
  })
})

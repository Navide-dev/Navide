// @vitest-environment happy-dom
// The sidebar keeps a compact run card; full run control lives in the
// Pipeline workspace, so the card links straight into it for the running
// pipeline.
import { afterEach, describe, expect, it } from 'vitest'
import { shallowMount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import ControlPane from '../ControlPane.vue'

describe('ControlPane – running pipeline card', () => {
  let wrapper: VueWrapper | undefined
  afterEach(() => { wrapper?.unmount(); wrapper = undefined; sessionStorage.clear() })

  it('opens the running pipeline in the workspace', async () => {
    i18n.global.locale.value = 'en-US'
    sessionStorage.setItem('agentTeam.sidebarTab', 'pipeline')
    wrapper = shallowMount(ControlPane as never, {
      props: {
        backendStatus: 'connected', backendUrl: '', agentSpecs: [], roles: [], stages: [], panes: [],
        pipeline: { state: 'running', stageIndex: 0, totalStages: 2, task: 'Ship it' },
        pipelines: [{ id: 'p1', name: 'Custom', builtin: false, stage_count: 2 }],
        activePipelineId: 'p1',
        yoloEnabled: false, analyzerModel: '',
        analyzerStatus: { available: false, version: '', defaultModel: '', models: [], benchmarkResults: [] },
        autoAnswerEnabled: false, existingProject: null, workspace: '/tmp/ws', workspaces: [],
      } as never,
      global: { plugins: [i18n] },
    })
    const link = wrapper.find('.prn-open')
    expect(link.text()).toBe('Open in the pipeline canvas')
    await link.trigger('click')
    expect(wrapper.emitted('open-pipeline-manager')?.[0]).toEqual(['p1'])
  })
})

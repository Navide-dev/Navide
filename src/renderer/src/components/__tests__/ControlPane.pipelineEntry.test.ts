// @vitest-environment happy-dom
// The sidebar's way into pipelines (Pipeline UX D5): a labelled Manage button
// instead of a bare ⚙, and a count in steps — what the editor and Executions
// count — instead of stages, which a parallel layer or a gate makes differ.
import { afterEach, describe, expect, it } from 'vitest'
import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import ControlPane from '../ControlPane.vue'

describe('ControlPane – pipeline entry points', () => {
  let wrapper: VueWrapper | undefined
  afterEach(() => { wrapper?.unmount(); wrapper = undefined; sessionStorage.clear() })

  function mountPane() {
    i18n.global.locale.value = 'en-US'
    sessionStorage.setItem('agentTeam.sidebarTab', 'pipeline')
    wrapper = shallowMount(ControlPane as never, {
      props: {
        backendStatus: 'connected', backendUrl: '', agentSpecs: [], roles: [], stages: [], panes: [],
        pipeline: { state: 'idle', stageIndex: -1, totalStages: 0, task: '' },
        pipelines: [{ id: 'p1', name: 'Custom', builtin: false, stage_count: 2, step_count: 3 }],
        activePipelineId: 'p2',
        yoloEnabled: false, analyzerModel: '',
        analyzerStatus: { available: false, version: '', defaultModel: '', models: [], benchmarkResults: [] },
        autoAnswerEnabled: false, existingProject: null, workspace: '/tmp/ws', workspaces: [],
      } as never,
      global: { plugins: [i18n] },
    })
    return wrapper
  }

  it('names the way into the Pipeline Manager instead of showing a bare ⚙', async () => {
    const w = mountPane()
    const manage = w.get('.manage-btn')
    expect(manage.text()).toBe(i18n.global.t('action.manage-pipelines'))
    await manage.trigger('click')
    expect(w.emitted('open-pipeline-manager')?.[0]).toEqual([undefined])
  })

  it('counts a pipeline in steps, the way the editor does', async () => {
    const w = mountPane()
    expect(w.get('.pipeline-item-meta').text()).toBe(i18n.global.t('label.step-count', { count: 3 }))
    await w.get('.pipeline-item').trigger('click')
    await flushPromises()
    const header = w.get('.collapsible-header').text()
    expect(header).toContain(i18n.global.t('label.step-count', { count: 3 }))
    expect(header).not.toContain(i18n.global.t('label.stage-count', { count: 2 }))
    expect(w.get('.pipeline-detail-nav .manage-btn').text()).toBe(i18n.global.t('action.manage-pipelines'))
  })
})

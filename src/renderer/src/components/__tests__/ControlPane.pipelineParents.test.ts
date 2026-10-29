// @vitest-environment happy-dom
// A sub-pipeline's child run shows where it was called from on the sidebar's
// run card ("Parent › Child"), and each parent opens its pipeline, where its
// runs are listed.
import { afterEach, describe, expect, it } from 'vitest'
import { shallowMount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import ControlPane from '../ControlPane.vue'

function mountCard(parents?: Array<{ name: string; pipelineId: string }>): VueWrapper {
  i18n.global.locale.value = 'en-US'
  sessionStorage.setItem('agentTeam.sidebarTab', 'pipeline')
  return shallowMount(ControlPane as never, {
    props: {
      backendStatus: 'connected', backendUrl: '', agentSpecs: [], roles: [], stages: [{ id: '01', title: 'A', shortTitle: 'A', slots: [] }], panes: [],
      pipeline: { state: 'running', stageIndex: 0, totalStages: 1, task: 'sub task', awaitingGate: null, ...(parents ? { parents } : {}) },
      pipelines: [{ id: 'child', name: 'Child', builtin: false, stage_count: 1 }, { id: 'parent', name: 'Parent', builtin: false, stage_count: 2 }],
      activePipelineId: 'child',
      yoloEnabled: false, analyzerModel: '',
      analyzerStatus: { available: false, version: '', defaultModel: '', models: [], benchmarkResults: [] },
      autoAnswerEnabled: false, existingProject: null, workspace: '/tmp/ws', workspaces: [],
    } as never,
    global: { plugins: [i18n] },
  })
}

describe('ControlPane – a sub-pipeline\'s child run', () => {
  let wrapper: VueWrapper | undefined
  afterEach(() => { wrapper?.unmount(); wrapper = undefined; sessionStorage.clear() })

  it('shows Parent › Child and opens the parent pipeline', async () => {
    wrapper = mountCard([{ name: 'Parent', pipelineId: 'parent' }])
    const crumbs = wrapper.get('[data-test="run-parents"]')
    expect(crumbs.findAll('button, span').map((e) => e.text())).toEqual(['Parent', '›', 'Child'])
    await crumbs.get('.prn-crumb').trigger('click')
    expect(wrapper.emitted('open-pipeline-manager')).toEqual([['parent']])
  })

  it('a run that is no one\'s child has no breadcrumb', () => {
    wrapper = mountCard()
    expect(wrapper.find('[data-test="run-parents"]').exists()).toBe(false)
  })
})

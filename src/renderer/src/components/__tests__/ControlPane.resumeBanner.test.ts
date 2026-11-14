// @vitest-environment happy-dom
// The Resume card offers to continue the ONE unfinished run recorded in
// project.json. That run belongs to a specific pipeline, so offering it while a
// DIFFERENT pipeline is active let the user resume "stage 3" of a 5-stage
// pipeline against a 2-stage one.
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { shallowMount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import ControlPane from '../ControlPane.vue'

const stage = (id: string, shortTitle: string) => ({
  id,
  title: shortTitle,
  shortTitle,
  question: '',
  description: '',
  recommendedRoles: [],
  sentinel: '',
  allowQuestions: false,
  docQuery: '',
  slots: [{ agentKey: 'claude', roleKey: '', label: shortTitle, kickoffBody: '', isCommander: false }],
})

function existingProject(pipelineId: string, state: 'aborted' | 'running') {
  return {
    projectId: 'proj1',
    name: 'run',
    state,
    taskDescription: 'do the thing',
    currentStageIndex: 1,
    totalStages: 5,
    stagesCompleted: 2,
    nextStageIndex: 2,
    updatedAt: '2026-09-09',
    workspacePath: '/tmp/ws',
    pipelineId,
    runCount: 1,
  }
}

function mountPane(projectPipelineId: string, activePipelineId: string, state: 'aborted' | 'running' = 'aborted'): VueWrapper {
  sessionStorage.setItem('agentTeam.sidebarTab', 'pipeline')
  return shallowMount(ControlPane as never, {
    props: {
      backendStatus: 'connected',
      backendUrl: '',
      agentSpecs: [],
      roles: [],
      stages: [stage('01', 'S1'), stage('02', 'S2')],
      panes: [],
      pipeline: { state: 'idle', stageIndex: -1, totalStages: 0 },
      pipelines: [
        { id: 'pA', name: 'Five stage', builtin: false, stage_count: 5 },
        { id: 'pB', name: 'Two stage', builtin: false, stage_count: 2 },
      ],
      activePipelineId,
      yoloEnabled: false,
      analyzerModel: '',
      analyzerStatus: {
        available: false, version: '', defaultModel: '', models: [], benchmarkResults: [],
      },
      autoAnswerEnabled: false,
      existingProject: existingProject(projectPipelineId, state),
      workspace: '/tmp/ws',
      workspaces: [],
    } as never,
    global: { plugins: [i18n] },
  })
}

describe('ControlPane – Resume banner pipeline scoping', () => {
  let wrapper: VueWrapper | undefined

  beforeEach(() => {
    i18n.global.locale.value = 'en-US'
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    sessionStorage.clear()
  })

  it('shows the Resume card when the unfinished run belongs to the active pipeline', () => {
    wrapper = mountPane('pA', 'pA')
    expect(wrapper.find('.resume-card').exists()).toBe(true)
  })

  it('hides the Resume card when a DIFFERENT pipeline is active', () => {
    wrapper = mountPane('pA', 'pB')
    expect(wrapper.find('.resume-card').exists()).toBe(false)
  })

  it('still shows a legacy record that carries no pipelineId', () => {
    wrapper = mountPane('', 'pB')
    expect(wrapper.find('.resume-card').exists()).toBe(true)
  })

  // A run a Reload or crash interrupted is still stored as running: it can be
  // ended from its card, not only resumed.
  it('offers Abort on an interrupted run, and only there', async () => {
    wrapper = mountPane('pA', 'pA', 'running')
    const abort = wrapper.findAll('.resume-card button').find((b) => b.text() === 'Abort')
    expect(abort).toBeDefined()
    await abort!.trigger('click')
    expect(wrapper.emitted('pipeline-abort')).toHaveLength(1)
    wrapper.unmount()
    wrapper = mountPane('pA', 'pA')
    expect(wrapper.findAll('.resume-card button').some((b) => b.text() === 'Abort')).toBe(false)
  })
})

// @vitest-environment happy-dom
// The empty stage's "or run the pipeline" link must be the sidebar's own Run
// button by another name: same startPipeline, same canRunPipeline guard. App.vue
// is source-scanned (too large to mount, like the other App.*.test.ts files);
// ControlPane is mounted to prove the exposed pair keeps that guard.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { shallowMount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import ControlPane from '../ControlPane.vue'

const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function emptyCardBlock(): string {
  const at = appSource.indexOf('class="empty-card empty-card--idle"')
  expect(at).toBeGreaterThan(-1)
  const end = appSource.indexOf('<div v-else class="grid"', at)
  expect(end).toBeGreaterThan(at)
  return appSource.slice(at, end)
}

describe('empty stage: or run the pipeline', () => {
  it('calls the sidebar startPipeline and nothing else', () => {
    const block = emptyCardBlock()
    expect(block).toContain('@click="controlPaneRef?.startPipeline()"')
    expect(block).toContain(':disabled="!controlPaneRef?.canRunPipeline"')
    expect(block).not.toContain('onPipelineStart')
  })

  it('does not double the ▶ the wording already carries', () => {
    expect(emptyCardBlock()).not.toMatch(/▶\s*\{\{/)
  })
})

const stage = {
  id: '01', title: 'S1', shortTitle: 'S1', question: '', description: '', recommendedRoles: [],
  sentinel: '', allowQuestions: false, docQuery: '',
  slots: [{ agentKey: 'claude', roleKey: '', label: 'S1', kickoffBody: '', isCommander: false }],
}

type Exposed = { startPipeline: () => void; canRunPipeline: boolean }

describe('ControlPane exposes its own Run button guard', () => {
  let wrapper: VueWrapper | undefined

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    sessionStorage.clear()
  })

  function mountWith(task: string, workspace: string): VueWrapper {
    if (task) sessionStorage.setItem('agentTeam.pipelineTaskDescription', task)
    return shallowMount(ControlPane as never, {
      props: {
        backendStatus: 'connected', backendUrl: '', agentSpecs: [], roles: [], stages: [stage], panes: [],
        pipeline: { state: 'idle', stageIndex: 0, totalStages: 1 },
        pipelines: [], yoloEnabled: false, analyzerModel: '',
        analyzerStatus: { available: false, version: '', defaultModel: '', models: [], benchmarkResults: [] },
        autoAnswerEnabled: false, existingProject: null, workspace, workspaces: [],
      } as never,
      global: { plugins: [i18n] },
    })
  }

  it('emits pipeline-start when a workspace and a task are set', () => {
    wrapper = mountWith('Ship it', '/tmp/ws')
    const vm = wrapper.vm as unknown as Exposed
    expect(vm.canRunPipeline).toBe(true)
    vm.startPipeline()
    expect(wrapper.emitted('pipeline-start')?.[0]?.[0]).toMatchObject({ task: 'Ship it', workspacePath: '/tmp/ws' })
  })

  it('does nothing without a task, like the disabled sidebar button', () => {
    wrapper = mountWith('', '/tmp/ws')
    const vm = wrapper.vm as unknown as Exposed
    expect(vm.canRunPipeline).toBe(false)
    vm.startPipeline()
    expect(wrapper.emitted('pipeline-start')).toBeUndefined()
  })

  it('does nothing without a workspace', () => {
    wrapper = mountWith('Ship it', '')
    const vm = wrapper.vm as unknown as Exposed
    expect(vm.canRunPipeline).toBe(false)
    vm.startPipeline()
    expect(wrapper.emitted('pipeline-start')).toBeUndefined()
  })
})

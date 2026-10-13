// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { effectScope, nextTick, ref, type EffectScope } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { createMockBackend } from './mockBackend'
import { usePipelineRunState, type HostRun } from '../usePipelineRunState'

describe('usePipelineRunState', () => {
  let scope: EffectScope | undefined
  afterEach(() => { scope?.stop(); scope = undefined })

  function setup(project: Record<string, unknown> | null, host = ref<HostRun | null>(null)) {
    const mock = createMockBackend('connected')
    mock.setResponse('project.peek', { project })
    const ws = ref('/ws')
    scope = effectScope()
    const state = scope.run(() => usePipelineRunState(mock.backend, () => ws.value, () => host.value))!
    return { mock, state, ws, host }
  }

  it('seeds from the project record, so a run started elsewhere (MCP) is seen', async () => {
    const { state } = setup({ state: 'running', pipeline_id: 'p1', node_states: { a: { status: 'running' } }, node_gate: null })
    await flushPromises()
    expect(state.isRunning('p1')).toBe(true)
    expect(state.isRunning('p2')).toBe(false)
    expect(state.run.value.nodes.a.status).toBe('running')
  })

  it('follows node-state broadcasts for its own workspace only', async () => {
    const { state, mock } = setup(null)
    await flushPromises()
    mock.emit('pipeline.node_states_changed', { workspace_path: '/other', pipeline_id: 'p1', state: 'running', nodes: {} })
    expect(state.isRunning('p1')).toBe(false)
    mock.emit('pipeline.node_states_changed', { workspace_path: '/ws', pipeline_id: 'p1', state: 'running', nodes: { a: { status: 'done' } }, gate: 'g' })
    expect(state.isRunning('p1')).toBe(true)
    expect(state.run.value.gate).toBe('g')
  })

  it('locks as soon as the host window starts a run, before any broadcast', async () => {
    const host = ref<HostRun | null>({ state: 'idle', pipelineId: '', workspacePath: '' })
    const { state } = setup(null, host)
    await flushPromises()
    host.value = { state: 'running', pipelineId: 'p1', workspacePath: '/ws' }
    await nextTick()
    expect(state.isRunning('p1')).toBe(true)
  })

  it('re-reads the project when the host run ends, dropping a stale running state', async () => {
    const host = ref<HostRun | null>({ state: 'running', pipelineId: 'p1', workspacePath: '/ws' })
    const { state, mock } = setup({ state: 'running', pipeline_id: 'p1' }, host)
    await flushPromises()
    mock.setResponse('project.peek', { project: { state: 'completed', pipeline_id: 'p1' } })
    host.value = { state: 'completed', pipelineId: '', workspacePath: '' }
    await flushPromises()
    expect(state.isRunning('p1')).toBe(false)
  })
})

describe('usePipelineRunState – gate shape', () => {
  let scope: EffectScope | undefined
  afterEach(() => { scope?.stop(); scope = undefined })

  it('reads the paused gate from the engine\'s object shape, and {} as none', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('project.peek', { project: { state: 'aborted', pipeline_id: 'p1', node_gate: { gateId: 'g1', nextIndex: 2 } } })
    scope = effectScope()
    const state = scope.run(() => usePipelineRunState(mock.backend, () => '/ws'))!
    await flushPromises()
    expect(state.run.value.gate).toBe('g1')
    mock.emit('pipeline.node_states_changed', { workspace_path: '/ws', pipeline_id: 'p1', state: 'running', nodes: {}, gate: {} })
    expect(state.run.value.gate).toBeNull()
    mock.emit('pipeline.node_states_changed', { workspace_path: '/ws', pipeline_id: 'p1', state: 'running', nodes: {}, gate: { gateId: 'g2', label: 'OK?', prompt: '', nextIndex: 3 } })
    expect(state.run.value.gate).toBe('g2')
  })
})

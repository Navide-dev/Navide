import { describe, it, expect, beforeEach } from 'vitest'
import { ref } from 'vue'
import { useUiActionBus, type UiInvokeRequest } from '../useUiActionBus'
import { registerCommand } from '@navide/plugin-ui/shared'
import { _resetRegistry } from '@navide/plugin-ui/shared/testing'
import { _resetDiagnostics } from '../../lib/uiDiagnostics'
import { createMockBackend, flush } from './mockBackend'

// A command that throws an error carrying `code` (and `params`) hands both
// on in its ui.invoke.result, so an MCP caller gets an error_code it can
// branch on instead of only the English sentence (PR-E). The sentence stays.
beforeEach(() => {
  _resetRegistry()
  _resetDiagnostics()
})

function request(action: string): UiInvokeRequest {
  return { request_id: 'req-1', workspace_path: '/ws', op: 'invoke', action, args: null, global: false }
}

describe('useUiActionBus — a coded refusal keeps its code', () => {
  it('sends code and params next to the error', async () => {
    const { backend, emit, sent } = createMockBackend()
    registerCommand('refuse', () => {
      throw Object.assign(new Error('ui.pipeline.next: stage 3 of 3 is the last one'), {
        code: 'last-stage', params: { stage: 3, stages: 3 },
      })
    })
    useUiActionBus({ backend, currentWorkspace: ref('/ws'), buildSnapshot: () => ({}) })

    emit('ui.invoke.request', request('refuse'))
    await flush()

    const reply = sent.find((s) => s.type === 'ui.invoke.result')
    expect(reply?.payload).toEqual({
      request_id: 'req-1', ok: false, result: undefined,
      error: 'ui.pipeline.next: stage 3 of 3 is the last one',
      code: 'last-stage', params: { stage: 3, stages: 3 },
    })
  })

  it('adds nothing for an error without a code', async () => {
    const { backend, emit, sent } = createMockBackend()
    registerCommand('plain', () => { throw new Error('nope') })
    useUiActionBus({ backend, currentWorkspace: ref('/ws'), buildSnapshot: () => ({}) })

    emit('ui.invoke.request', request('plain'))
    await flush()

    const reply = sent.find((s) => s.type === 'ui.invoke.result')
    expect(reply?.payload).toEqual({ request_id: 'req-1', ok: false, result: undefined, error: 'nope' })
  })
})

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ref } from 'vue'
import { useUiActionBus, handleUiInvokeRequest, type UiInvokeRequest } from '../useUiActionBus'
import { registerCommand } from '@navide/plugin-ui/shared'
import { _resetRegistry } from '@navide/plugin-ui/shared/testing'
import { recordDiagnostic, _resetDiagnostics } from '../../lib/uiDiagnostics'
import { createMockBackend, flush } from './mockBackend'

beforeEach(() => {
  _resetRegistry()
  _resetDiagnostics()
})

function baseRequest(overrides: Partial<UiInvokeRequest> = {}): UiInvokeRequest {
  return {
    request_id: 'req-1',
    workspace_path: '/ws',
    op: 'invoke',
    action: null,
    args: null,
    global: false,
    ...overrides,
  }
}

describe('useUiActionBus — ownership filtering', () => {
  it('ignores a non-global request whose workspace_path does not match this window', async () => {
    const { backend, emit, sent } = createMockBackend()
    const currentWorkspace = ref('/ws-a')
    useUiActionBus({ backend, currentWorkspace, buildSnapshot: () => ({}) })

    emit('ui.invoke.request', baseRequest({ workspace_path: '/ws-b' }))
    await flush()

    expect(sent.find((s) => s.type === 'ui.invoke.result')).toBeUndefined()
  })

  it('handles a non-global request whose workspace_path matches this window', async () => {
    const { backend, emit, sent } = createMockBackend()
    const currentWorkspace = ref('/ws-a')
    registerCommand('noop', () => 'ok')
    useUiActionBus({ backend, currentWorkspace, buildSnapshot: () => ({}) })

    emit('ui.invoke.request', baseRequest({ workspace_path: '/ws-a', action: 'noop' }))
    await flush()

    const reply = sent.find((s) => s.type === 'ui.invoke.result')
    expect(reply?.payload).toEqual({ request_id: 'req-1', ok: true, result: 'ok', error: null })
  })

  it('handles a global request regardless of workspace_path', async () => {
    const { backend, emit, sent } = createMockBackend()
    const currentWorkspace = ref('/ws-a')
    registerCommand('noop', () => 'ok')
    useUiActionBus({ backend, currentWorkspace, buildSnapshot: () => ({}) })

    emit('ui.invoke.request', baseRequest({ workspace_path: '/somewhere-else', action: 'noop', global: true }))
    await flush()

    const reply = sent.find((s) => s.type === 'ui.invoke.result')
    expect(reply?.payload).toEqual({ request_id: 'req-1', ok: true, result: 'ok', error: null })
  })

  // The backend sends `addressed` to one window alone: the one hosting the pane
  // that asked. That window must answer whatever workspace it currently has
  // open — a pane whose window had switched project could otherwise never drive
  // its own UI, and the mismatch looked exactly like a hung window.
  it('handles an addressed request regardless of workspace_path', async () => {
    const { backend, emit, sent } = createMockBackend()
    const currentWorkspace = ref('/ws-a')
    registerCommand('noop', () => 'ok')
    useUiActionBus({ backend, currentWorkspace, buildSnapshot: () => ({}) })

    emit('ui.invoke.request', baseRequest({ workspace_path: '/ws-b', action: 'noop', addressed: true }))
    await flush()

    const reply = sent.find((s) => s.type === 'ui.invoke.result')
    expect(reply?.payload).toEqual({ request_id: 'req-1', ok: true, result: 'ok', error: null })
  })

  // A window can hold several workspaces with only one showing; ownership is
  // "does this window hold it", not "is it the one on screen".
  it('answers for a workspace it holds but is not currently showing', async () => {
    const { backend, emit, sent } = createMockBackend()
    const currentWorkspace = ref('/ws-a')
    registerCommand('noop', () => 'ok')
    useUiActionBus({
      backend,
      currentWorkspace,
      buildSnapshot: () => ({}),
      ownsWorkspace: (p) => p === '/ws-a' || p === '/ws-held',
    })

    emit('ui.invoke.request', baseRequest({ workspace_path: '/ws-held', action: 'noop' }))
    await flush()

    const reply = sent.find((s) => s.type === 'ui.invoke.result')
    expect(reply?.payload).toEqual({ request_id: 'req-1', ok: true, result: 'ok', error: null })
  })

  it('stays silent for a workspace it does not hold', async () => {
    const { backend, emit, sent } = createMockBackend()
    const currentWorkspace = ref('/ws-a')
    registerCommand('noop', () => 'ok')
    useUiActionBus({
      backend,
      currentWorkspace,
      buildSnapshot: () => ({}),
      ownsWorkspace: (p) => p === '/ws-a',
    })

    emit('ui.invoke.request', baseRequest({ workspace_path: '/ws-other', action: 'noop' }))
    await flush()

    expect(sent.find((s) => s.type === 'ui.invoke.result')).toBeUndefined()
  })

  // Reaching this window is not the same as being able to act on the project
  // the request names. ui.pane.create / ui.window.openGit / ui.preview.show all
  // read the window's OWN currentWorkspace, so answering one for a workspace
  // this window merely holds spawned the agent into (and persisted it under)
  // the project on screen instead — ok:true on the wrong project.
  it('refuses an addressed workspace-scoped action naming a project it is not showing', async () => {
    const { backend, emit, sent } = createMockBackend()
    const currentWorkspace = ref('/ws-a')
    const ranAgainst: string[] = []
    registerCommand('ui.pane.create', () => {
      ranAgainst.push(currentWorkspace.value)
      return 'pane-1'
    })
    useUiActionBus({ backend, currentWorkspace, buildSnapshot: () => ({}) })

    emit('ui.invoke.request', baseRequest({
      workspace_path: '/ws-held',
      action: 'ui.pane.create',
      args: { agent: 'claude' },
      addressed: true,
    }))
    await flush()

    expect(ranAgainst).toEqual([])
    const reply = sent.find((s) => s.type === 'ui.invoke.result')
    expect(reply?.payload).toMatchObject({ request_id: 'req-1', ok: false })
    // The reply names both projects: the caller has to know which window to
    // switch, and a bare "refused" reads as a bug in the action.
    expect((reply?.payload as { error: string }).error).toContain('/ws-held')
    expect((reply?.payload as { error: string }).error).toContain('/ws-a')
  })

  // Starting a pipeline reads the window's own currentWorkspace too, and it is
  // the most expensive action to get wrong: a run spawns a pane per stage slot
  // and burns quota in whichever project the window happens to be showing.
  it('refuses an addressed pipeline action naming a project it is not showing', async () => {
    const { backend, emit, sent } = createMockBackend()
    const currentWorkspace = ref('/ws-a')
    const started: string[] = []
    registerCommand('ui.pipeline.start', () => {
      started.push(currentWorkspace.value)
      return { pipelineId: 'default' }
    })
    useUiActionBus({ backend, currentWorkspace, buildSnapshot: () => ({}) })

    emit('ui.invoke.request', baseRequest({
      workspace_path: '/ws-held',
      action: 'ui.pipeline.start',
      args: { task: 'ship it' },
      addressed: true,
    }))
    await flush()

    expect(started).toEqual([])
    const reply = sent.find((s) => s.type === 'ui.invoke.result')
    expect(reply?.payload).toMatchObject({ request_id: 'req-1', ok: false })
  })

  // The other four pipeline controls read the window's own currentWorkspace
  // exactly as start and abort do — next advances the stage of whatever run is
  // on screen, reset kills every pane in it — so an addressed request naming a
  // project this window merely holds must be refused rather than run against
  // the one it is showing.
  it.each([
    'ui.pipeline.next',
    'ui.pipeline.resume',
    'ui.pipeline.reset',
    'ui.pipeline.restart',
  ])('refuses an addressed %s naming a project it is not showing', async (action) => {
    const { backend, emit, sent } = createMockBackend()
    const currentWorkspace = ref('/ws-a')
    const ranAgainst: string[] = []
    registerCommand(action, () => {
      ranAgainst.push(currentWorkspace.value)
      return {}
    })
    useUiActionBus({ backend, currentWorkspace, buildSnapshot: () => ({}) })

    emit('ui.invoke.request', baseRequest({
      workspace_path: '/ws-held',
      action,
      addressed: true,
    }))
    await flush()

    expect(ranAgainst).toEqual([])
    const reply = sent.find((s) => s.type === 'ui.invoke.result')
    expect(reply?.payload).toMatchObject({ request_id: 'req-1', ok: false })
  })

  // The permission-bypass toggle is window-wide — every spawn path reads it,
  // whichever project the pane belongs to — so it is deliberately NOT
  // workspace-scoped and must still answer an addressed request.
  it('runs the window-wide yolo setting for a project it is not showing', async () => {
    const { backend, emit, sent } = createMockBackend()
    const currentWorkspace = ref('/ws-a')
    const calls: string[] = []
    registerCommand('ui.settings.yolo', () => {
      calls.push(currentWorkspace.value)
      return { yolo: true }
    })
    useUiActionBus({ backend, currentWorkspace, buildSnapshot: () => ({}) })

    emit('ui.invoke.request', baseRequest({
      workspace_path: '/ws-held',
      action: 'ui.settings.yolo',
      addressed: true,
    }))
    await flush()

    expect(calls).toEqual(['/ws-a'])
    const reply = sent.find((s) => s.type === 'ui.invoke.result')
    expect(reply?.payload).toMatchObject({ request_id: 'req-1', ok: true })
  })

  it('refuses an addressed pipeline abort naming a project it is not showing', async () => {
    const { backend, emit, sent } = createMockBackend()
    const currentWorkspace = ref('/ws-a')
    const aborted: string[] = []
    registerCommand('ui.pipeline.abort', () => {
      aborted.push(currentWorkspace.value)
      return {}
    })
    useUiActionBus({ backend, currentWorkspace, buildSnapshot: () => ({}) })

    emit('ui.invoke.request', baseRequest({
      workspace_path: '/ws-held',
      action: 'ui.pipeline.abort',
      addressed: true,
    }))
    await flush()

    expect(aborted).toEqual([])
    const reply = sent.find((s) => s.type === 'ui.invoke.result')
    expect(reply?.payload).toMatchObject({ request_id: 'req-1', ok: false })
  })

  it('runs a workspace-scoped action addressed to the project it IS showing', async () => {
    const { backend, emit, sent } = createMockBackend()
    const currentWorkspace = ref('/ws-a')
    const ranAgainst: string[] = []
    registerCommand('ui.pane.create', () => {
      ranAgainst.push(currentWorkspace.value)
      return 'pane-1'
    })
    useUiActionBus({ backend, currentWorkspace, buildSnapshot: () => ({}) })

    emit('ui.invoke.request', baseRequest({
      workspace_path: '/ws-a',
      action: 'ui.pane.create',
      addressed: true,
    }))
    await flush()

    expect(ranAgainst).toEqual(['/ws-a'])
    expect(sent.find((s) => s.type === 'ui.invoke.result')?.payload).toMatchObject({ ok: true })
  })

  it('does not let a trailing slash make the shown project look like another one', async () => {
    const { backend, emit, sent } = createMockBackend()
    const currentWorkspace = ref('/ws-a')
    const ran: string[] = []
    registerCommand('ui.preview.show', () => { ran.push('x') })
    useUiActionBus({ backend, currentWorkspace, buildSnapshot: () => ({}) })

    emit('ui.invoke.request', baseRequest({
      workspace_path: '/ws-a/',
      action: 'ui.preview.show',
      addressed: true,
    }))
    await flush()

    expect(ran).toEqual(['x'])
    expect(sent.find((s) => s.type === 'ui.invoke.result')?.payload).toMatchObject({ ok: true })
  })

  // The other half of the same rule: a request that does NOT act on the shown
  // project keeps the wider ownership test, which is the whole point of
  // addressing a pane's own window.
  it('still answers a pane-keyed action for a workspace it is not showing', async () => {
    const { backend, emit, sent } = createMockBackend()
    const currentWorkspace = ref('/ws-a')
    registerCommand('ui.pane.getStatus', () => ({ status: 'idle' }))
    useUiActionBus({ backend, currentWorkspace, buildSnapshot: () => ({}) })

    emit('ui.invoke.request', baseRequest({
      workspace_path: '/ws-held',
      action: 'ui.pane.getStatus',
      args: { paneId: 'p1' },
      addressed: true,
    }))
    await flush()

    expect(sent.find((s) => s.type === 'ui.invoke.result')?.payload).toMatchObject({
      ok: true,
      result: { status: 'idle' },
    })
  })

  // Not addressed means some other window may have that project on screen, so
  // this one owes the same silence it owes any mismatch — an error reply here
  // would race the window that can actually do the work.
  it('stays silent on a broadcast workspace-scoped action for a held-but-not-shown project', async () => {
    const { backend, emit, sent } = createMockBackend()
    const currentWorkspace = ref('/ws-a')
    const ran: string[] = []
    registerCommand('ui.window.openGit', () => { ran.push('x') })
    useUiActionBus({
      backend,
      currentWorkspace,
      buildSnapshot: () => ({}),
      ownsWorkspace: (p) => p === '/ws-a' || p === '/ws-held',
    })

    emit('ui.invoke.request', baseRequest({ workspace_path: '/ws-held', action: 'ui.window.openGit' }))
    await flush()

    expect(ran).toEqual([])
    expect(sent.find((s) => s.type === 'ui.invoke.result')).toBeUndefined()
  })

  it('still ignores a mismatched request that is not addressed to it', async () => {
    const { backend, emit, sent } = createMockBackend()
    const currentWorkspace = ref('/ws-a')
    registerCommand('noop', () => 'ok')
    useUiActionBus({ backend, currentWorkspace, buildSnapshot: () => ({}) })

    emit('ui.invoke.request', baseRequest({ workspace_path: '/ws-b', action: 'noop', addressed: false }))
    await flush()

    expect(sent.find((s) => s.type === 'ui.invoke.result')).toBeUndefined()
  })
})

describe('handleUiInvokeRequest — op dispatch', () => {
  const currentWorkspace = ref('/ws')
  const deps = () => ({ currentWorkspace, buildSnapshot: vi.fn() })

  it('op "invoke" runs the registered command with args and replies with its result', async () => {
    const { backend, sent } = createMockBackend()
    const handler = vi.fn((args) => ({ received: args }))
    registerCommand('do.thing', handler)

    await handleUiInvokeRequest(
      baseRequest({ action: 'do.thing', args: { n: 1 }, workspace_path: '/ws' }),
      { backend, ...deps() },
    )

    expect(handler).toHaveBeenCalledWith({ n: 1 })
    const reply = sent[0]
    expect(reply.type).toBe('ui.invoke.result')
    expect(reply.payload).toEqual({ request_id: 'req-1', ok: true, result: { received: { n: 1 } }, error: null })
  })

  it('op "invoke" with an unknown action replies ok:false with an error string', async () => {
    const { backend, sent } = createMockBackend()
    await handleUiInvokeRequest(
      baseRequest({ action: 'no.such.command', workspace_path: '/ws' }),
      { backend, ...deps() },
    )
    expect(sent[0].payload).toMatchObject({ request_id: 'req-1', ok: false })
    expect((sent[0].payload as { error: string }).error).toContain('no.such.command')
  })

  it('op "invoke" with a null action replies ok:false without touching the registry', async () => {
    const { backend, sent } = createMockBackend()
    await handleUiInvokeRequest(
      baseRequest({ op: 'invoke', action: null, workspace_path: '/ws' }),
      { backend, ...deps() },
    )
    expect(sent[0].payload).toMatchObject({ ok: false })
  })

  it('op "invoke" whose handler throws replies ok:false with the thrown message, never rejecting', async () => {
    const { backend, sent } = createMockBackend()
    registerCommand('boom', () => {
      throw new Error('handler exploded')
    })
    await expect(
      handleUiInvokeRequest(
        baseRequest({ action: 'boom', workspace_path: '/ws' }),
        { backend, ...deps() },
      ),
    ).resolves.toBeUndefined()
    expect(sent[0].payload).toEqual({ request_id: 'req-1', ok: false, result: undefined, error: 'handler exploded' })
  })

  it('op "snapshot" calls the injected buildSnapshot and replies with its result', async () => {
    const { backend, sent } = createMockBackend()
    const buildSnapshot = vi.fn(async () => ({ workspace: '/ws', panes: [] }))
    await handleUiInvokeRequest(
      baseRequest({ op: 'snapshot', workspace_path: '/ws' }),
      { backend, currentWorkspace, buildSnapshot },
    )
    expect(buildSnapshot).toHaveBeenCalledTimes(1)
    expect(sent[0].payload).toEqual({
      request_id: 'req-1',
      ok: true,
      result: { workspace: '/ws', panes: [] },
      error: null,
    })
  })

  it('op "snapshot" whose buildSnapshot throws replies ok:false', async () => {
    const { backend, sent } = createMockBackend()
    const buildSnapshot = vi.fn(() => {
      throw new Error('snapshot failed')
    })
    await handleUiInvokeRequest(
      baseRequest({ op: 'snapshot', workspace_path: '/ws' }),
      { backend, currentWorkspace, buildSnapshot },
    )
    expect(sent[0].payload).toEqual({ request_id: 'req-1', ok: false, result: undefined, error: 'snapshot failed' })
  })

  it('op "list_actions" replies with every registered command id', async () => {
    const { backend, sent } = createMockBackend()
    registerCommand('a.one', () => {})
    registerCommand('a.two', () => {})
    await handleUiInvokeRequest(
      baseRequest({ op: 'list_actions', workspace_path: '/ws' }),
      { backend, ...deps() },
    )
    expect(sent[0].payload.ok).toBe(true)
    expect((sent[0].payload.result as string[]).sort()).toEqual(['a.one', 'a.two'])
  })

  it('an unknown op replies ok:false with an error string', async () => {
    const { backend, sent } = createMockBackend()
    await handleUiInvokeRequest(
      baseRequest({ op: 'bogus' as unknown as UiInvokeRequest['op'], workspace_path: '/ws' }),
      { backend, ...deps() },
    )
    expect(sent[0].payload).toMatchObject({ ok: false })
  })

  it('ignores a payload missing request_id or op entirely (no reply sent)', async () => {
    const { backend, sent } = createMockBackend()
    await handleUiInvokeRequest({ workspace_path: '/ws' }, { backend, ...deps() })
    await handleUiInvokeRequest(null, { backend, ...deps() })
    expect(sent).toHaveLength(0)
  })
})

describe('handleUiInvokeRequest — warnings from uiDiagnostics', () => {
  const currentWorkspace = ref('/ws')
  const deps = () => ({ currentWorkspace, buildSnapshot: vi.fn() })

  it('omits warnings entirely when the action recorded no diagnostics', async () => {
    const { backend, sent } = createMockBackend()
    registerCommand('noop', () => 'ok')
    await handleUiInvokeRequest(baseRequest({ action: 'noop', workspace_path: '/ws' }), { backend, ...deps() })

    expect(sent[0].payload).toEqual({ request_id: 'req-1', ok: true, result: 'ok', error: null })
    expect('warnings' in sent[0].payload).toBe(false)
  })

  it('includes warnings recorded by the command while it ran, formatted as "[code] message"', async () => {
    const { backend, sent } = createMockBackend()
    registerCommand('flaky', () => {
      recordDiagnostic({ level: 'warn', code: 'inject.resend', message: 'content not echoed — resending' })
      return 'ok'
    })
    await handleUiInvokeRequest(baseRequest({ action: 'flaky', workspace_path: '/ws' }), { backend, ...deps() })

    expect(sent[0].payload).toEqual({
      request_id: 'req-1',
      ok: true,
      result: 'ok',
      error: null,
      warnings: ['[inject.resend] content not echoed — resending']
    })
  })

  it('only reports diagnostics recorded during this action, not ones from before it started', async () => {
    const { backend, sent } = createMockBackend()
    recordDiagnostic({ level: 'error', code: 'inject.failed', message: 'stale — from an earlier action' })
    registerCommand('noop', () => 'ok')
    await handleUiInvokeRequest(baseRequest({ action: 'noop', workspace_path: '/ws' }), { backend, ...deps() })

    expect('warnings' in sent[0].payload).toBe(false)
  })
})


describe('useUiActionBus — pane-private actions (inbox)', () => {
  // ui.messaging.readIncoming / settleRead take the pane whose inbox to touch
  // from args.paneId. The backend puts the caller's own pane, from the
  // credential, in caller_pane_id; the two must agree or the action does not
  // run. Registered here as spies so the test sees whether the command ran.
  function setup(): { ran: ReturnType<typeof vi.fn>; sent: ReturnType<typeof createMockBackend>['sent']; emit: ReturnType<typeof createMockBackend>['emit'] } {
    const { backend, emit, sent } = createMockBackend()
    const ran = vi.fn(() => 'read')
    registerCommand('ui.messaging.readIncoming', ran)
    registerCommand('ui.messaging.settleRead', ran)
    useUiActionBus({ backend, currentWorkspace: ref('/ws'), buildSnapshot: () => ({}) })
    return { ran, sent, emit }
  }

  it('runs when the caller is the pane it names', async () => {
    const { ran, sent, emit } = setup()
    emit('ui.invoke.request', baseRequest({
      action: 'ui.messaging.readIncoming', args: { paneId: 'pa', limit: 5 }, caller_pane_id: 'pa', addressed: true,
    }))
    await flush()
    expect(ran).toHaveBeenCalledTimes(1)
    const reply = sent.find((s) => s.type === 'ui.invoke.result')
    expect(reply?.payload).toMatchObject({ request_id: 'req-1', ok: true, result: 'read' })
  })

  it('refuses, with the reason, when the caller names another pane', async () => {
    const { ran, sent, emit } = setup()
    for (const action of ['ui.messaging.readIncoming', 'ui.messaging.settleRead']) {
      emit('ui.invoke.request', baseRequest({
        request_id: `req-${action}`, action, args: { paneId: 'pb' }, caller_pane_id: 'pa', addressed: true,
      }))
    }
    await flush()
    expect(ran).not.toHaveBeenCalled()
    const replies = sent.filter((s) => s.type === 'ui.invoke.result')
    expect(replies).toHaveLength(2)
    for (const reply of replies) {
      expect(reply.payload).toMatchObject({ ok: false })
      expect(String((reply.payload as { error: string }).error)).toMatch(/own inbox/)
    }
  })

  it('refuses when the request carries no caller pane at all', async () => {
    // A host / external credential, or a backend build that does not send the
    // field: either way there is no pane to match, so nothing is read.
    const { ran, sent, emit } = setup()
    emit('ui.invoke.request', baseRequest({ action: 'ui.messaging.readIncoming', args: { paneId: 'pa' } }))
    emit('ui.invoke.request', baseRequest({
      request_id: 'req-2', action: 'ui.messaging.settleRead', args: { paneId: 'pa' }, caller_pane_id: '',
    }))
    await flush()
    expect(ran).not.toHaveBeenCalled()
    expect(sent.filter((s) => s.type === 'ui.invoke.result').every((s) => (s.payload as { ok: boolean }).ok === false)).toBe(true)
  })

  it('leaves every other paneId-taking action cross-pane, as before', async () => {
    // The list is explicit on purpose: focus / close / getStatus / interrupt
    // are meant to be driven from another pane.
    const { backend, emit, sent } = createMockBackend()
    const focus = vi.fn(() => 'focused')
    registerCommand('ui.pane.focus', focus)
    useUiActionBus({ backend, currentWorkspace: ref('/ws'), buildSnapshot: () => ({}) })
    emit('ui.invoke.request', baseRequest({ action: 'ui.pane.focus', args: { paneId: 'pb' }, caller_pane_id: 'pa' }))
    await flush()
    expect(focus).toHaveBeenCalledTimes(1)
    expect(sent.find((s) => s.type === 'ui.invoke.result')?.payload).toMatchObject({ ok: true, result: 'focused' })
  })
})

describe('useUiActionBus — announcing the bus to the backend', () => {
  // The backend hands a global request (ui.workspace.open) only to a window
  // that announced it runs this bus; plugin and editor windows never answer.
  it('announces ui.invoke.ready once connected, and again on every reconnect', async () => {
    const { backend, sent, status } = createMockBackend('connecting')
    const off = useUiActionBus({
      backend, currentWorkspace: ref('/ws'), buildSnapshot: () => ({}), connectionStatus: status,
    })
    await flush()
    expect(sent.filter((s) => s.type === 'ui.invoke.ready')).toHaveLength(0)

    status.value = 'connected'
    await flush()
    status.value = 'disconnected'
    await flush()
    status.value = 'connected'
    await flush()

    expect(sent.filter((s) => s.type === 'ui.invoke.ready')).toHaveLength(2)
    off()
  })

  it('announces itself as focused when the window gains focus', async () => {
    const { backend, sent, status } = createMockBackend('connected')
    const focusTarget = new EventTarget()
    const off = useUiActionBus({
      backend, currentWorkspace: ref('/ws'), buildSnapshot: () => ({}),
      connectionStatus: status, focusTarget,
    })
    await flush()

    focusTarget.dispatchEvent(new Event('focus'))
    await flush()

    const ready = sent.filter((s) => s.type === 'ui.invoke.ready')
    expect(ready.at(-1)?.payload).toEqual({ focused: true })

    off()
    focusTarget.dispatchEvent(new Event('focus'))
    await flush()
    expect(sent.filter((s) => s.type === 'ui.invoke.ready')).toHaveLength(ready.length)
  })
})

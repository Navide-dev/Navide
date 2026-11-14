// @vitest-environment happy-dom
//
// The disconnected path: what a pane does with keystrokes while the backend is
// away, and what it does with its PTY when the backend comes back.
//
// Before mockBackend could reject, none of this was reachable in a test — the
// mock always resolved, so the transport-down branches were dead code here
// while being the only code that runs when something has actually gone wrong.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { nextTick } from 'vue'
import { createMockBackend, withScope, flush } from './mockBackend'

const store = vi.hoisted(() => {
  const values = new Map<string, string>()
  values.set('terminal-last-size', JSON.stringify({ cols: 80, rows: 24 }))
  vi.stubGlobal('localStorage', {
    get length(): number { return values.size },
    key: (i: number) => Array.from(values.keys())[i] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, String(value)) },
    removeItem: (key: string) => { values.delete(key) },
    clear: () => {
      values.clear()
      values.set('terminal-last-size', JSON.stringify({ cols: 80, rows: 24 }))
    },
  })
  return values
})

/** The live `term.onData` handler, so a test can type into the pane. */
const typed = vi.hoisted(() => ({ handler: null as ((data: string) => void) | null }))
const writes = vi.hoisted(() => [] as string[])

const ctrl = vi.hoisted(() => ({
  applyFit: vi.fn(),
  sendResizeNow: vi.fn(),
  requestResizeRedraw: vi.fn(),
  // Uncapped by default: the real capCols is identity until a cap is set.
  setColsCap: vi.fn(),
  capCols: vi.fn((cols: number) => cols),
  attachObserver: vi.fn(),
  dispose: vi.fn(),
  ackedCols: 0,
  ackedRows: 0,
}))

vi.mock('../useTerminalResize', () => ({
  createResizeController: () => ctrl,
}))

vi.mock('@xterm/xterm', () => {
  class Terminal {
    cols = 80
    rows = 24
    options: Record<string, unknown> = {}
    unicode = { activeVersion: '6' }
    textarea = document.createElement('textarea')
    buffer = {
      active: { type: 'normal', viewportY: 0, baseY: 0, cursorX: 0, cursorY: 0, getLine: () => undefined },
    }
    loadAddon(): void {}
    open(): void {}
    attachCustomWheelEventHandler(): void {}
    attachCustomKeyEventHandler(): void {}
    registerLinkProvider(): { dispose(): void } {
      return { dispose(): void {} }
    }
    onResize(): { dispose(): void } {
      return { dispose(): void {} }
    }
    onData(cb: (data: string) => void): { dispose(): void } {
      typed.handler = cb
      return { dispose(): void { typed.handler = null } }
    }
    write(data?: string): void { if (typeof data === 'string') writes.push(data) }
    writeln(data?: string): void { if (typeof data === 'string') writes.push(data) }
    resize(): void {}
    focus(): void {}
    select(): void {}
    clearSelection(): void {}
    hasSelection(): boolean { return false }
    onSelectionChange(_handler: () => void): { dispose: () => void } {
      return { dispose: (): void => {} }
    }
    scrollLines(): void {}
    scrollToBottom(): void {}
    dispose(): void {}
  }
  return { Terminal }
})

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
    proposeDimensions(): { cols: number; rows: number } {
      return { cols: 80, rows: 24 }
    }
  },
}))

vi.mock('@xterm/addon-serialize', () => ({
  SerializeAddon: class {
    activate(): void {}
    dispose(): void {}
    serialize(): string { return '' }
  },
}))

import { useTerminal } from '../useTerminal'

/** A pane with a live PTY, spawned through the normal create path. */
async function spawnedPane(opts?: { onPtyLostWhileDisconnected?: () => void }) {
  const mock = createMockBackend()
  mock.setResponse('terminal.create', { terminal_session_id: 'sess-1', pid: 42 })
  mock.setResponse('terminal.reattach', { alive: ['sess-1'], dead: [] })
  const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend, opts))
  result.mount(document.createElement('div'))
  await result.spawn({ command: 'bash', cwd: '/tmp', skipReattach: true })
  await flush()
  return { mock, result, scope }
}

function inputsSent(mock: ReturnType<typeof createMockBackend>): unknown[] {
  return mock.sent.filter((s) => s.type === 'terminal.input')
}

describe('useTerminal — keystrokes while the backend is away', () => {
  afterEach(() => {
    vi.restoreAllMocks() // the staleness test stubs Date.now
    vi.clearAllMocks()
    localStorage.clear()
    writes.length = 0
    typed.handler = null
  })

  it('sends a keystroke normally while connected', async () => {
    const { mock, result, scope } = await spawnedPane()
    const before = inputsSent(mock).length

    typed.handler?.('a')

    expect(inputsSent(mock)).toHaveLength(before + 1)
    void result
    scope.stop()
  })

  // The transport would happily QUEUE these. That is the bug: on a fast
  // reconnect the whole burst lands in the TUI at once (every Enter and Ctrl-C
  // pressed at a pane that looked frozen), and on a slow one the queue's 10 s
  // timeout drops them while the reconnect backoff is still at 30 s — silently,
  // because these sends are fire-and-forget.
  it('refuses keystrokes while disconnected instead of queueing them', async () => {
    const { mock, scope } = await spawnedPane()
    const before = inputsSent(mock).length

    mock.status.value = 'disconnected'
    typed.handler?.('a')
    typed.handler?.('\r')
    typed.handler?.('\x03') // Ctrl-C

    expect(inputsSent(mock)).toHaveLength(before)
    scope.stop()
  })

  it('does not replay the refused keystrokes after reconnecting', async () => {
    const { mock, scope } = await spawnedPane()
    mock.status.value = 'disconnected'
    typed.handler?.('a')
    typed.handler?.('\r')
    const during = inputsSent(mock).length

    mock.status.value = 'connected'
    await nextTick()
    await flush()

    expect(inputsSent(mock)).toHaveLength(during)
    scope.stop()
  })

  it('accepts keystrokes again once reconnected', async () => {
    const { mock, scope } = await spawnedPane()
    mock.status.value = 'disconnected'
    typed.handler?.('a')
    mock.status.value = 'connected'
    await nextTick()
    await flush()
    const before = inputsSent(mock).length

    typed.handler?.('b')

    expect(inputsSent(mock)).toHaveLength(before + 1)
    scope.stop()
  })

  it('refuses a paste while disconnected', async () => {
    const { mock, result, scope } = await spawnedPane()
    const before = inputsSent(mock).length

    mock.status.value = 'disconnected'
    result.pasteText('hello')

    expect(inputsSent(mock)).toHaveLength(before)
    scope.stop()
  })

  // Callers stage a paste in two sends 300 ms apart (text, then the submitting
  // CR). They need to know the first half was refused, or the CR arrives alone
  // and submits whatever the prompt already held.
  it('reports whether the paste actually left', async () => {
    const { mock, result, scope } = await spawnedPane()

    expect(result.pasteText('hello')).toBe(true)
    mock.status.value = 'disconnected'
    expect(result.pasteText('hello')).toBe(false)

    scope.stop()
  })

  // The pane a user hits STOP on is precisely the one that looks frozen, so a
  // queued SIGINT would land on whatever turn is running once the socket is
  // back — possibly one that started after the reconnect.
  it('refuses an interrupt while disconnected, and does not claim it stopped', async () => {
    const { mock, result, scope } = await spawnedPane()
    const before = mock.sent.filter((s) => s.type === 'terminal.interrupt').length

    mock.status.value = 'disconnected'
    await result.interrupt()

    expect(mock.sent.filter((s) => s.type === 'terminal.interrupt')).toHaveLength(before)
    expect(result.isStopped.value).toBe(false)
    scope.stop()
  })

  // Keys typed at a pane that was still preparing are buffered by the stdin
  // gate. Sending that buffer at a moment the transport cannot carry it would
  // burn it, so it is held and flushed on the reconnect instead.
  it('holds gated input while disconnected and flushes it on reconnect', async () => {
    const { mock, result, scope } = await spawnedPane()
    result.setDisableStdin(true)
    typed.handler?.('queued')
    mock.status.value = 'disconnected'
    await nextTick() // let the watcher see the drop, not just the round trip
    const before = inputsSent(mock).length

    result.setDisableStdin(false)
    expect(inputsSent(mock)).toHaveLength(before) // held, not burned

    mock.status.value = 'connected'
    await nextTick()
    await flush()

    const after = inputsSent(mock)
    expect(after).toHaveLength(before + 1)
    expect((after[after.length - 1] as { payload: { data: string } }).payload.data).toBe('queued')
    scope.stop()
  })

  // A PTY survives an ownerless hour, so a held buffer can outlive the intent
  // behind it. Replaying one typed before a long outage would deliver the very
  // burst — every Enter included — that refusing input exists to prevent.
  it('discards a held buffer that outlived the outage', async () => {
    const { mock, result, scope } = await spawnedPane()
    result.setDisableStdin(true)
    typed.handler?.('stale')
    mock.status.value = 'disconnected'
    await nextTick()
    result.setDisableStdin(false)
    const before = inputsSent(mock).length

    const realNow = Date.now
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 61_000)
    mock.status.value = 'connected'
    await nextTick()
    await flush()

    expect(inputsSent(mock)).toHaveLength(before)
    scope.stop()
  })

  // Flushing alongside the reattach rather than after it wrote to a PTY this
  // connection had not reclaimed yet — the CLI's echo went to a dropped output
  // stream — or, when the PTY had died, emptied the buffer into a dead session.
  it('flushes held input only after the reattach has settled', async () => {
    const { mock, result, scope } = await spawnedPane()
    result.setDisableStdin(true)
    typed.handler?.('queued')
    mock.status.value = 'disconnected'
    await nextTick()
    result.setDisableStdin(false)
    mock.sent.length = 0

    mock.status.value = 'connected'
    await nextTick()
    await flush()

    const reattachAt = mock.sent.findIndex((s) => s.type === 'terminal.reattach')
    const inputAt = mock.sent.findIndex((s) => s.type === 'terminal.input')
    expect(reattachAt).toBeGreaterThanOrEqual(0)
    expect(inputAt).toBeGreaterThan(reattachAt)
    scope.stop()
  })

  // A dead PTY means the held keys have nowhere to go; they must be dropped,
  // not written into a session id that no longer resolves.
  it('drops held input when the PTY did not survive', async () => {
    const { mock, result, scope } = await spawnedPane()
    result.setDisableStdin(true)
    typed.handler?.('queued')
    mock.status.value = 'disconnected'
    await nextTick()
    result.setDisableStdin(false)
    mock.setResponse('terminal.reattach', { alive: [], dead: ['sess-1'] })
    mock.sent.length = 0

    mock.status.value = 'connected'
    await nextTick()
    await flush()

    expect(mock.sent.some((s) => s.type === 'terminal.input')).toBe(false)
    scope.stop()
  })
})

describe('useTerminal — reattach after the backend comes back', () => {
  afterEach(() => {
    vi.restoreAllMocks() // the staleness test stubs Date.now
    vi.clearAllMocks()
    localStorage.clear()
    writes.length = 0
    typed.handler = null
  })

  it('reattaches to a PTY that survived, and reports no loss', async () => {
    const onPtyLostWhileDisconnected = vi.fn()
    const { mock, scope } = await spawnedPane({ onPtyLostWhileDisconnected })

    mock.status.value = 'disconnected'
    await nextTick()
    mock.status.value = 'connected'
    await nextTick()
    await flush()

    expect(mock.sent.some((s) => s.type === 'terminal.reattach')).toBe(true)
    expect(onPtyLostWhileDisconnected).not.toHaveBeenCalled()
    scope.stop()
  })

  // A backend restart kills every PTY, so reattach answers `dead` for all of
  // them. The pane cannot resume itself (only App knows the agent and how to
  // build the vendor's resume command), so it reports the loss upward.
  it('reports a PTY that died, so the owner can resume the CLI session', async () => {
    const onPtyLostWhileDisconnected = vi.fn()
    const { mock, result, scope } = await spawnedPane({ onPtyLostWhileDisconnected })
    mock.setResponse('terminal.reattach', { alive: [], dead: ['sess-1'] })

    mock.status.value = 'disconnected'
    await nextTick()
    mock.status.value = 'connected'
    await nextTick()
    await flush()

    expect(onPtyLostWhileDisconnected).toHaveBeenCalledTimes(1)
    expect(result.status.value).toBe('exited')
    scope.stop()
  })

  // The reconnect fires the watcher before the socket is necessarily usable.
  // A rejected probe must leave the pane alone — declaring the PTY dead on a
  // failed question would kill a session that is still perfectly alive.
  it('leaves the pane alone when the reattach probe itself fails', async () => {
    const onPtyLostWhileDisconnected = vi.fn()
    const { mock, result, scope } = await spawnedPane({ onPtyLostWhileDisconnected })
    mock.setRejection('terminal.reattach')

    mock.status.value = 'disconnected'
    await nextTick()
    mock.status.value = 'connected'
    await nextTick()
    await flush()

    expect(onPtyLostWhileDisconnected).not.toHaveBeenCalled()
    expect(result.status.value).toBe('running')
    scope.stop()
  })

  // An error reply is no answer about the PTY either: the backend may be up
  // but not ready to look, and the session may well be alive. Only an explicit
  // reply that leaves the session out means it died.
  it('leaves the pane alone on WS drop + reattach error reply', async () => {
    const onPtyLostWhileDisconnected = vi.fn()
    const { mock, result, scope } = await spawnedPane({ onPtyLostWhileDisconnected })
    mock.setResponse('terminal.reattach', null, { ok: false, error: { code: 'internal', message: 'not ready' } })

    mock.status.value = 'disconnected'
    await nextTick()
    mock.status.value = 'connected'
    await nextTick()
    await flush()

    expect(onPtyLostWhileDisconnected).not.toHaveBeenCalled()
    expect(result.status.value).not.toBe('exited')
    expect(writes.some((w) => w.includes('session ended while disconnected'))).toBe(false)
    expect(mock.sent.some((s) => s.type === 'terminal.kill' || s.type === 'terminal.close')).toBe(false)
    scope.stop()
  })

  it('does not probe for a pane that never spawned', async () => {
    const mock = createMockBackend()
    const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend))
    result.mount(document.createElement('div'))

    mock.status.value = 'disconnected'
    await nextTick()
    mock.status.value = 'connected'
    await nextTick()
    await flush()

    expect(mock.sent.some((s) => s.type === 'terminal.reattach')).toBe(false)
    scope.stop()
  })
})

void store

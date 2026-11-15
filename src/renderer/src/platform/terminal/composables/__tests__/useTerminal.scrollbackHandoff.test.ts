// @vitest-environment happy-dom
// Scrollback handoff between panes: a quota-failover restart replaces a pane
// (new id, new xterm, new PTY) and the plan keeps the pane's history through
// it. The old pane serializes its buffer, the new pane replays it before its
// PTY writes — the stored-snapshot path's format and mode reset, without the
// stored snapshot (the kill's exit discards that, and it can be a minute old).
// Display only: nothing written here ever reaches a PTY.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createMockBackend, withScope } from './mockBackend'

const store = vi.hoisted(() => {
  const values = new Map<string, string>()
  // Read once at module load: without a borrowable size a spawn into a pane
  // with no measurable width parks itself and never creates its PTY.
  values.set('terminal-last-size', JSON.stringify({ cols: 80, rows: 24 }))
  vi.stubGlobal('localStorage', {
    get length(): number { return values.size },
    key: (i: number) => Array.from(values.keys())[i] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, String(value)) },
    removeItem: (key: string) => { values.delete(key) },
    clear: () => { values.clear() },
  })
  return { values }
})

// What the serializer hands back. Mutable so a test can tell one save from the
// next.
const snap = vi.hoisted(() => ({ text: 'HISTORY-1' }))
// Every write the (mock) parser has processed, in order — the "buffer".
const writes = vi.hoisted(() => ({ text: [] as string[] }))
// Writes queued but not yet processed.
const queued = vi.hoisted(() => ({ text: [] as string[] }))

const ctrl = vi.hoisted(() => ({
  applyFit: vi.fn(),
  sendResizeNow: vi.fn(),
  requestResizeRedraw: vi.fn(),
  setColsCap: vi.fn(),
  capCols: vi.fn((cols: number) => cols),
  attachObserver: vi.fn(),
  dispose: vi.fn(),
  ackedCols: 80,
  ackedRows: 24,
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
    onData(): { dispose(): void } {
      return { dispose(): void {} }
    }
    // Like the real xterm: a write is queued and lands in the buffer only
    // when the parser gets to it, after which its callback fires. A
    // serializer that reads too early therefore misses the tail.
    write(data: string | Uint8Array, cb?: () => void): void {
      const text = typeof data === 'string' ? data : new TextDecoder().decode(data)
      queued.text.push(text)
      setTimeout(() => {
        const idx = queued.text.indexOf(text)
        if (idx >= 0) queued.text.splice(idx, 1)
        writes.text.push(text)
        cb?.()
      }, 0)
    }
    writeln(data: string): void { writes.text.push(data + '\n') }
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
    // The buffer as the parser has it: the processed writes joined. `opts`
    // is recorded so a test can see whether a line cap was requested.
    serialize(opts?: { scrollback?: number }): string {
      serializeCalls.opts.push(opts ?? {})
      return snap.text || writes.text.filter((w) => !w.startsWith('\x1b')).join('')
    }
  },
}))
const serializeCalls = vi.hoisted(() => ({ opts: [] as { scrollback?: number }[] }))

import { useTerminal } from '../useTerminal'

async function spawnPane(opts: Record<string, unknown> = {}) {
  const mock = createMockBackend()
  mock.setResponse('terminal.create', { terminal_session_id: 'sess-1', pid: 42 })
  const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend))
  result.mount(document.createElement('div'))
  const spawned = result.spawn({ command: 'bash', cwd: '/tmp', ...opts })
  await vi.advanceTimersByTimeAsync(1_000)
  await spawned
  return { mock, result, scope }
}

const MODE_RESET = '\x1b[?1000l'

describe('useTerminal — scrollback handoff', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    snap.text = ''
    writes.text = []
    queued.text = []
    serializeCalls.opts = []
    store.values.forEach((_v, k) => { if (k !== 'terminal-last-size') store.values.delete(k) })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('serializeScrollback waits for the parser, so output that just arrived is in the handoff', async () => {
    const { mock, result, scope } = await spawnPane()
    mock.emit('terminal.output', { terminal_session_id: 'sess-1', data: 'first line\r\n' })
    await vi.advanceTimersByTimeAsync(200)
    // The last chunk is still inside the coalesce window when the capture
    // starts: it has been neither flushed to xterm nor parsed.
    mock.emit('terminal.output', { terminal_session_id: 'sess-1', data: 'LAST-LINE' })
    const capture = result.serializeScrollback()
    // Synchronously the parser has not run the tail yet.
    expect(writes.text.join('')).not.toContain('LAST-LINE')
    await vi.advanceTimersByTimeAsync(10)
    const payload = await capture
    expect(payload).toContain('first line')
    expect(payload).toContain('LAST-LINE')
    scope.stop()
  })

  it('a handoff takes every line xterm holds, not the stored snapshot\'s line cap', async () => {
    const { result, scope } = await spawnPane()
    const capture = result.serializeScrollback()
    await vi.advanceTimersByTimeAsync(10)
    await capture
    const last = serializeCalls.opts[serializeCalls.opts.length - 1]
    expect(last).toBeDefined()
    expect('scrollback' in last).toBe(false)
    scope.stop()
  })

  it('replays a handed-off buffer into a fresh spawn before the PTY starts, with the mode reset', async () => {
    const { mock, scope } = await spawnPane({ resumeKey: 'cli-session', restoreMode: 'fresh', isResume: true, replayScrollback: 'OLD-PANE-HISTORY' })
    await vi.advanceTimersByTimeAsync(10)
    const created = mock.sent.findIndex((s) => s.type === 'terminal.create')
    expect(created).toBeGreaterThan(-1)
    const history = writes.text.indexOf('OLD-PANE-HISTORY')
    expect(history).toBeGreaterThan(-1)
    // The old session's modes are reset right after, and a separator says
    // where the old buffer ends and the switched account begins.
    expect(writes.text[history + 1]).toContain(MODE_RESET)
    expect(writes.text[history + 2]).toContain('account switched')
    // The handoff is display only: nothing was sent to the backend as input.
    expect(mock.sent.some((s) => s.type === 'terminal.input' || s.type === 'terminal.write')).toBe(false)
    scope.stop()
  })

  it('carries quota lineage through the real fresh-create path without replacing a live terminal', async () => {
    const { mock, scope } = await spawnPane({ restoreMode: 'fresh', skipReattach: true, quotaTransactionId: 'tx-1', quotaOriginalPaneId: 'old-pane' })
    const create = mock.sent.find((s) => s.type === 'terminal.create')!
    expect(create.payload).toMatchObject({ quota_transaction_id: 'tx-1', quota_original_pane_id: 'old-pane', replaces_terminal_id: null })
    expect(mock.sent.some((s) => s.type === 'terminal.input' || s.type === 'terminal.kill')).toBe(false)
    scope.stop()
  })

  it('carries a remote container target into terminal.create, and nothing for a local pane', async () => {
    const remote = { host: 'devbox', container: 'app', network: { mode: 'host' } }
    const first = await spawnPane({ agentKey: 'claude', remote })
    expect(first.mock.sent.find((s) => s.type === 'terminal.create')!.payload.remote).toEqual(remote)
    first.scope.stop()
    const second = await spawnPane({ agentKey: 'claude' })
    expect(second.mock.sent.find((s) => s.type === 'terminal.create')!.payload).not.toHaveProperty('remote')
    second.scope.stop()
  })

  it('a fresh spawn without a handoff replays nothing — the ordinary rebuild is unchanged', async () => {
    localStorage.setItem('terminal-scroll:cli-session', 'nv1\nSTORED')
    const { scope } = await spawnPane({ resumeKey: 'cli-session', restoreMode: 'fresh', isResume: true })
    await vi.advanceTimersByTimeAsync(10)
    expect(writes.text.some((w) => w.includes('STORED') || w.includes('account switched') || w.includes('reconnected'))).toBe(false)
    scope.stop()
  })

  it('a handoff never replays twice, and yields to the stored-snapshot path on a memory resume', async () => {
    localStorage.setItem('terminal-scroll:cli-session', 'nv1\nSTORED')
    const { scope } = await spawnPane({ resumeKey: 'cli-session', restoreMode: 'memory-resume', isResume: true, replayScrollback: 'HANDOFF' })
    await vi.advanceTimersByTimeAsync(10)
    expect(writes.text.filter((w) => w === 'STORED')).toHaveLength(1)
    expect(writes.text.includes('HANDOFF')).toBe(false)
    scope.stop()
  })
})

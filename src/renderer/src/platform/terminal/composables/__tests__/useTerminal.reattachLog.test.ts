// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMockBackend, withScope } from './mockBackend'

// A spawn that reattaches to a surviving PTY never reaches terminal.create, so
// nothing opens a transcript under the pane's NEW id — yet the caller derives a
// path from that id and records it. Agent History then reads a file that was
// never created ("Failed to read log file … ENOENT") while the conversation
// sits in the log the PTY opened under its original id. The backend reports
// that path on reattach; this is where the pane adopts it.

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

const { useTerminal } = await import('../useTerminal')

const PTY_KEY = 'terminal-pty:pane-1'
const REAL_LOG = '/ws/.agent-team/manual/20260825/claude-3e3e8ef3.log'

function pane(reattachPayload: Record<string, unknown>) {
  const mock = createMockBackend()
  mock.setResponse('terminal.reattach', reattachPayload)
  localStorage.setItem(PTY_KEY, 'sess-old')
  const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend))
  result.mount(document.createElement('div'))
  return { mock, result, scope }
}

describe('useTerminal — the transcript a reattached pane adopts', () => {
  afterEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  it('adopts what the surviving PTY really runs when its bypass was dropped', async () => {
    const { result, scope } = pane({ alive: ['sess-old'], dead: [], logs: {}, bypass_dropped: { 'sess-old': 'claude --permission-mode default' } })
    expect(await result.tryReattach()).toBe(true)
    expect(result.attachedBypassDropped.value).toBe('claude --permission-mode default')
    scope.stop()
  })

  it('adopts the surviving PTY\'s real transcript path', async () => {
    const { result, scope } = pane({ alive: ['sess-old'], dead: [], logs: { 'sess-old': REAL_LOG } })
    expect(await result.tryReattach()).toBe(true)
    expect(result.attachedOutputLogFile.value).toBe(REAL_LOG)
    scope.stop()
  })

  it('stays empty when the survivor has no transcript', async () => {
    // Adopting '' would replace the caller's derived path with nothing.
    const { result, scope } = pane({ alive: ['sess-old'], dead: [], logs: {} })
    expect(await result.tryReattach()).toBe(true)
    expect(result.attachedOutputLogFile.value).toBe('')
    scope.stop()
  })

  it('stays empty when the backend reports no logs at all', async () => {
    // An older backend that predates the field: reattach still works, the pane
    // just keeps what it derived.
    const { result, scope } = pane({ alive: ['sess-old'], dead: [] })
    expect(await result.tryReattach()).toBe(true)
    expect(result.attachedOutputLogFile.value).toBe('')
    scope.stop()
  })

  it('adopts nothing when the PTY is gone', async () => {
    // A dead id falls through to a fresh spawn, which opens its own.
    const { result, scope } = pane({ alive: [], dead: ['sess-old'], logs: {} })
    expect(await result.tryReattach()).toBe(false)
    expect(result.attachedOutputLogFile.value).toBe('')
    scope.stop()
  })
})

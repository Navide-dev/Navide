// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createMockBackend, withScope } from './mockBackend'

// A restore regenerates the pane id. A vendor that pins no session id at
// launch (codex before its first turn, a plain terminal) has no resumeKey, so
// the pane's PTY id was stored under its OLD pane id — and a fresh restore,
// which skips reattach, looked only under the new one. terminal.create then
// went out with no replaces_terminal_id and every Reload Window left the old
// CLI running beside the new one.

vi.hoisted(() => {
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
})

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

const { useTerminal } = await import('../useTerminal')

async function restoreSpawn(opts: Record<string, unknown>) {
  const mock = createMockBackend()
  mock.setResponse('terminal.create', { terminal_session_id: 'pty-new', pid: 42 })
  const { result, scope } = withScope(() => useTerminal('pane-new', mock.backend))
  result.mount(document.createElement('div'))
  const spawned = result.spawn({ command: 'codex', cwd: '/tmp', agentKey: 'codex', ...opts })
  await vi.advanceTimersByTimeAsync(1_000)
  await spawned
  const create = mock.sent.find((s) => s.type === 'terminal.create')
  scope.stop()
  return (create?.payload ?? {}) as Record<string, unknown>
}

describe('useTerminal — a fresh restore replaces the PTY its former pane id ran', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => {
    vi.useRealTimers()
    localStorage.clear()
  })

  it('names the former pane\'s PTY as the one it replaces', async () => {
    localStorage.setItem('terminal-pty:pane-old', 'pty-old')
    const payload = await restoreSpawn({ restoreMode: 'fresh', skipReattach: true, replacesKey: 'pane-old' })
    expect(payload.replaces_terminal_id).toBe('pty-old')
  })

  it('prefers the PTY stored under its own key', async () => {
    localStorage.setItem('terminal-pty:pane-old', 'pty-old')
    localStorage.setItem('terminal-pty:cli-session', 'pty-own')
    const payload = await restoreSpawn({
      restoreMode: 'fresh', skipReattach: true, resumeKey: 'cli-session', replacesKey: 'pane-old',
    })
    expect(payload.replaces_terminal_id).toBe('pty-own')
  })

  it('replaces nothing when the former pane left no PTY id', async () => {
    const payload = await restoreSpawn({ restoreMode: 'fresh', skipReattach: true, replacesKey: 'pane-old' })
    expect(payload.replaces_terminal_id ?? null).toBeNull()
  })
})

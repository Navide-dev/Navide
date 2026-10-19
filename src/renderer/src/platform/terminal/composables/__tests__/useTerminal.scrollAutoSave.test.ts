// @vitest-environment happy-dom
// Scrollback used to be persisted only from onScopeDispose, which a hard page
// teardown never runs: ⌘R is Electron's `role: 'reload'` and an app restart
// drops the renderer outright, so the pane came back with nothing to replay.
// These tests pin the periodic save that fills that gap — including the gates
// that keep it from writing mid-output, writing every tick, or resurrecting a
// session that already exited — plus the app-exit save and the key rotation
// that makes a resumed pane read back what it wrote.
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
    write(): void {}
    writeln(): void {}
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
    serialize(): string { return snap.text }
  },
}))

import { useTerminal, saveAllScrollSnapshots, migrateTerminalPtyKey } from '../useTerminal'

const SNAP_FORMAT = 'nv1\n'
const SELF_KEY = 'terminal-scroll:pane-1'
const COALESCE_MS = 150   // output is coalesced ~100ms before it reaches xterm
const QUIET_MS = 3_000    // PTY silence required before an idle save
const MIN_GAP_MS = 60_000 // floor between two saves of the same pane
const TICK_MS = 1_000     // the status tick the save rides on (on-screen cadence)

function stored(key = SELF_KEY): string | null {
  return localStorage.getItem(key)
}

async function spawnPane(opts: { resumeKey?: string; isLogin?: boolean; loginProfileId?: string } = {}) {
  const mock = createMockBackend()
  mock.setResponse('terminal.create', { terminal_session_id: 'sess-1', pid: 42 })
  const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend))
  result.mount(document.createElement('div'))
  const spawned = result.spawn({ command: 'bash', cwd: '/tmp', ...opts })
  await vi.advanceTimersByTimeAsync(1_000)
  await spawned
  return { mock, result, scope }
}

/** Push a chunk through the PTY and let the coalesce window flush it. */
async function output(mock: ReturnType<typeof createMockBackend>, data: string): Promise<void> {
  mock.emit('terminal.output', { terminal_session_id: 'sess-1', data })
  await vi.advanceTimersByTimeAsync(COALESCE_MS)
}

describe('useTerminal — periodic scrollback snapshot', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    snap.text = 'HISTORY-1'
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    store.values.clear()
    store.values.set('terminal-last-size', JSON.stringify({ cols: 80, rows: 24 }))
  })

  it('saves an idle pane without waiting for teardown', async () => {
    const { mock, scope } = await spawnPane()
    await output(mock, 'first turn\r\n')

    expect(stored()).toBeNull()                      // still inside the quiet window
    await vi.advanceTimersByTimeAsync(QUIET_MS + TICK_MS)

    expect(stored()).toBe(SNAP_FORMAT + 'HISTORY-1') // saved while the pane is still alive
    scope.stop()
  })

  it('waits out the quiet window before saving', async () => {
    const { mock, scope } = await spawnPane()
    await output(mock, 'still streaming\r\n')

    await vi.advanceTimersByTimeAsync(QUIET_MS - COALESCE_MS - 500)
    expect(stored()).toBeNull()   // ticked several times, still too soon

    await vi.advanceTimersByTimeAsync(TICK_MS + 1_000)
    expect(stored()).not.toBeNull()
    scope.stop()
  })

  it('does not save while the pane reads as running', async () => {
    const { mock, scope } = await spawnPane()
    // Two chunks 2.5s apart form one continuous burst, which is what latches
    // the RUNNING badge.
    await output(mock, 'agent thinking\r\n')
    await vi.advanceTimersByTimeAsync(2_500)
    await output(mock, 'agent still working\r\n')

    // Past the quiet window, but the badge still says running: a tool call goes
    // quiet for seconds at a time and the pane is not settled yet.
    await vi.advanceTimersByTimeAsync(QUIET_MS + 500)
    expect(stored()).toBeNull()

    // Enough silence for the badge to drop back to idle.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(stored()).toBe(SNAP_FORMAT + 'HISTORY-1')
    scope.stop()
  })

  it('does not re-save within a minute of the last save', async () => {
    const { mock, scope } = await spawnPane()
    await output(mock, 'first turn\r\n')
    await vi.advanceTimersByTimeAsync(QUIET_MS + TICK_MS)
    expect(stored()).toBe(SNAP_FORMAT + 'HISTORY-1')

    snap.text = 'HISTORY-2'
    await output(mock, 'second turn\r\n')
    await vi.advanceTimersByTimeAsync(QUIET_MS + 5_000)
    expect(stored()).toBe(SNAP_FORMAT + 'HISTORY-1')  // throttled

    await vi.advanceTimersByTimeAsync(MIN_GAP_MS)
    expect(stored()).toBe(SNAP_FORMAT + 'HISTORY-2')
    scope.stop()
  })

  it('does not re-serialize when nothing arrived since the last save', async () => {
    const { mock, scope } = await spawnPane()
    await output(mock, 'first turn\r\n')
    await vi.advanceTimersByTimeAsync(QUIET_MS + TICK_MS)
    expect(stored()).toBe(SNAP_FORMAT + 'HISTORY-1')

    // A save is only worth its 9ms serialize when the buffer can have changed.
    snap.text = 'HISTORY-STALE'
    await vi.advanceTimersByTimeAsync(MIN_GAP_MS * 2)
    expect(stored()).toBe(SNAP_FORMAT + 'HISTORY-1')
    scope.stop()
  })

  it('stops saving once the session has exited', async () => {
    const { mock, scope } = await spawnPane()
    await output(mock, 'first turn\r\n')
    await vi.advanceTimersByTimeAsync(QUIET_MS + TICK_MS)
    expect(stored()).not.toBeNull()

    await output(mock, 'goodbye\r\n')
    mock.emit('terminal.exit', {
      terminal_session_id: 'sess-1',
      reason: 'process_exit',
      exit_code: 0,
    })
    expect(stored()).toBeNull()  // a finished session's scrollback is dropped

    // The periodic save must not put it back — the next pane on this key would
    // open onto a closed session's output.
    await vi.advanceTimersByTimeAsync(MIN_GAP_MS * 2)
    expect(stored()).toBeNull()
    scope.stop()
    expect(stored()).toBeNull()
  })

  it('persists every live pane on app exit, and nothing after disposal', async () => {
    const { mock, scope } = await spawnPane()
    await output(mock, 'unsaved tail\r\n')
    expect(stored()).toBeNull()  // the periodic save has not come round yet

    saveAllScrollSnapshots()     // what App.vue's beforeunload calls
    expect(stored()).toBe(SNAP_FORMAT + 'HISTORY-1')

    scope.stop()
    localStorage.removeItem(SELF_KEY)
    saveAllScrollSnapshots()     // a disposed pane is no longer registered
    expect(stored()).toBeNull()
  })

  it('follows a session-id rotation, so later saves land where the next restore reads', async () => {
    const oldKey = 'terminal-scroll:sess-old'
    const newKey = 'terminal-scroll:sess-new'
    const { mock, scope } = await spawnPane({ resumeKey: 'sess-old' })
    await output(mock, 'before the rotation\r\n')
    await vi.advanceTimersByTimeAsync(QUIET_MS + TICK_MS)
    expect(stored(oldKey)).toBe(SNAP_FORMAT + 'HISTORY-1')

    // claude --resume records a NEW session id; App.vue migrates the keys.
    migrateTerminalPtyKey('sess-old', 'sess-new')
    expect(stored(newKey)).toBe(SNAP_FORMAT + 'HISTORY-1')
    expect(stored(oldKey)).toBeNull()

    snap.text = 'HISTORY-AFTER-ROTATION'
    await output(mock, 'after the rotation\r\n')
    await vi.advanceTimersByTimeAsync(MIN_GAP_MS)
    expect(stored(newKey)).toBe(SNAP_FORMAT + 'HISTORY-AFTER-ROTATION')
    expect(stored(oldKey)).toBeNull()  // no orphan left behind
    scope.stop()
  })
})

// A CLI sign-in pane's screen holds an authorization URL or a pasted code.
// localStorage is written to disk in plain text (Local Storage/leveldb) where
// any agent with a shell can read it, so a sign-in pane is never snapshotted:
// not at idle, not at teardown, not on app exit.
describe('useTerminal — a sign-in pane is never snapshotted', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    snap.text = 'https://example.invalid/oauth?code=SIGN-IN-CODE'
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    store.values.clear()
    store.values.set('terminal-last-size', JSON.stringify({ cols: 80, rows: 24 }))
  })

  for (const opts of [{ isLogin: true }, { loginProfileId: 'p-1' }]) {
    it(`writes nothing for ${JSON.stringify(opts)}, idle, on app exit or at teardown`, async () => {
      const setItem = vi.spyOn(localStorage, 'setItem')
      const { mock, scope } = await spawnPane(opts)
      await output(mock, 'Paste code here if prompted >\r\n')
      await vi.advanceTimersByTimeAsync(QUIET_MS + MIN_GAP_MS)
      saveAllScrollSnapshots()
      scope.stop()

      expect(stored()).toBeNull()
      expect(setItem.mock.calls.filter(([key]) => String(key).startsWith('terminal-scroll:'))).toEqual([])
      expect([...store.values.values()].join('\n')).not.toContain('SIGN-IN-CODE')
    })
  }
})

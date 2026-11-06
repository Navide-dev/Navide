// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMockBackend, withScope } from './mockBackend'

vi.hoisted(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, String(value)) },
    removeItem: (key: string) => { values.delete(key) },
    clear: () => { values.clear() },
  })
})

// Output flush policy: the focused pane writes echo immediately (typing must
// not wait for a coalescing window — worst for IME input, where the whole
// commit waits on it), while unfocused panes coalesce writes so a streaming
// background agent doesn't starve the focused pane of main-thread time.
// xterm won't boot in happy-dom, so the mock records write() calls and exposes
// a real textarea element to drive focus/blur.

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

const captured = vi.hoisted(() => ({
  writes: [] as string[],
  writeCallbacks: [] as Array<() => void>,
  textarea: undefined as HTMLTextAreaElement | undefined,
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
    constructor() {
      captured.textarea = this.textarea
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
    write(data: string, callback?: () => void): void {
      captured.writes.push(data)
      if (callback) captured.writeCallbacks.push(callback)
    }
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

import { useTerminal } from '../useTerminal'

describe('useTerminal — output flush policy', () => {
  afterEach(() => {
    vi.clearAllMocks()
    captured.writes = []
    captured.writeCallbacks = []
    captured.textarea = undefined
    localStorage.clear() // drop the persisted PTY id so the next spawn is fresh
  })

  async function spawnedTerminal(onFirstOutput?: () => void) {
    const mock = createMockBackend()
    mock.setResponse('terminal.create', { terminal_session_id: 'sess-1', pid: 42 })
    const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend, { onFirstOutput }))
    result.mount(document.createElement('div'))
    await result.spawn({ command: 'bash', cwd: '/tmp' })
    captured.writes = [] // discard anything written during spawn
    return { mock, scope }
  }

  function emitOutput(mock: ReturnType<typeof createMockBackend>, data: string) {
    mock.emit('terminal.output', { terminal_session_id: 'sess-1', data })
  }

  // Windows VM 0.2.38: a CLI that printed its whole banner before the
  // terminal.create response named its PTY had every byte dropped, and every
  // injection into it then read "the pane printed nothing".
  it('replays output that arrived before the create response named this PTY', async () => {
    const mock = createMockBackend()
    mock.setResponse('terminal.create', { terminal_session_id: 'sess-1', pid: 42 })
    mock.beforeResponse.set('terminal.create', () => {
      mock.emit('terminal.output', { terminal_session_id: 'sess-1', data: 'Claude Code banner' })
      mock.emit('terminal.output', { terminal_session_id: 'sess-other', data: 'another pane' })
    })
    const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend))
    result.mount(document.createElement('div'))
    await result.spawn({ command: 'claude', cwd: '/tmp' })
    await new Promise((r) => setTimeout(r, 600))
    expect(captured.writes).toContain('Claude Code banner')
    expect(captured.writes).not.toContain('another pane')
    expect(result.cleanBytesSeen.value).toBeGreaterThan(0)
    scope.stop()
  })

  it('writes immediately while the pane textarea is focused', async () => {
    const { mock, scope } = await spawnedTerminal()
    captured.textarea!.dispatchEvent(new Event('focus'))

    emitOutput(mock, 'a')
    expect(captured.writes).toEqual(['a'])
    emitOutput(mock, '中')
    expect(captured.writes).toEqual(['a', '中'])
    scope.stop()
  })

  it('reports the first rendered PTY output exactly once', async () => {
    const onFirstOutput = vi.fn()
    const { mock, scope } = await spawnedTerminal(onFirstOutput)
    captured.textarea!.dispatchEvent(new Event('focus'))

    expect(onFirstOutput).not.toHaveBeenCalled()
    emitOutput(mock, 'first')
    emitOutput(mock, 'second')

    expect(captured.writes).toEqual(['first', 'second'])
    expect(onFirstOutput).not.toHaveBeenCalled()
    expect(captured.writeCallbacks).toHaveLength(1)
    captured.writeCallbacks[0]()
    expect(onFirstOutput).toHaveBeenCalledTimes(1)
    scope.stop()
  })

  it('coalesces output while unfocused, in arrival order', async () => {
    const { mock, scope } = await spawnedTerminal()

    emitOutput(mock, 'a')
    emitOutput(mock, 'b')
    expect(captured.writes).toEqual([]) // nothing until the coalesce window

    await new Promise((r) => setTimeout(r, 120))
    // One flush, chunk-by-chunk writes (xterm takes Uint8Array chunks as-is).
    expect(captured.writes).toEqual(['a', 'b'])
    scope.stop()
  })

  it('gaining focus flushes previously coalesced output with the new chunk', async () => {
    const { mock, scope } = await spawnedTerminal()

    emitOutput(mock, 'old')
    expect(captured.writes).toEqual([])

    captured.textarea!.dispatchEvent(new Event('focus'))
    emitOutput(mock, 'new')
    expect(captured.writes).toEqual(['old', 'new']) // order preserved, one flush
    scope.stop()
  })

  it('focus without a new chunk still flushes coalesced output via the timer', async () => {
    const { mock, scope } = await spawnedTerminal()

    emitOutput(mock, 'buffered') // arrives while unfocused → coalesced, timer armed
    captured.textarea!.dispatchEvent(new Event('focus'))
    expect(captured.writes).toEqual([]) // focus alone does not flush

    // No further output arrives — the armed 100ms timer must still fire so the
    // buffered chunk is never stranded.
    await new Promise((r) => setTimeout(r, 120))
    expect(captured.writes).toEqual(['buffered'])
    scope.stop()
  })

  it('blur returns the pane to coalescing', async () => {
    const { mock, scope } = await spawnedTerminal()
    captured.textarea!.dispatchEvent(new Event('focus'))
    captured.textarea!.dispatchEvent(new Event('blur'))

    emitOutput(mock, 'x')
    expect(captured.writes).toEqual([])
    await new Promise((r) => setTimeout(r, 120))
    expect(captured.writes).toEqual(['x'])
    scope.stop()
  })
})

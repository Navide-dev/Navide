// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMockBackend, withScope } from './mockBackend'

// useTerminal.kill must not report a refused kill as done. wsClient resolves an
// ok:false (TERMINAL_NOT_OWNED, for one) instead of rejecting it, so a kill that
// ignored its reply let onKill believe the PTY was gone — and on the callers
// that keep the pane record (idle reclaim, kill-all) nothing swept afterwards,
// so the process ran on for good. A refusal has to reject, and the pane has to
// keep the id it still owns, so a later spawn can name it as the PTY it replaces.
//
// xterm won't boot in happy-dom, so it's mocked the same way as the interrupt
// tests next door.

const captured = vi.hoisted(() => ({ dataHandler: undefined as ((d: string) => void) | undefined }))

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
    registerLinkProvider(): { dispose(): void } { return { dispose(): void {} } }
    onResize(): { dispose(): void } { return { dispose(): void {} } }
    onData(cb: (d: string) => void): { dispose(): void } {
      captured.dataHandler = cb
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
    proposeDimensions(): { cols: number; rows: number } { return { cols: 80, rows: 24 } }
  },
}))

import { useTerminal } from '../useTerminal'

describe('useTerminal — kill reports a refusal', () => {
  afterEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    captured.dataHandler = undefined
  })

  async function spawned(mock: ReturnType<typeof createMockBackend>) {
    mock.setResponse('terminal.create', { terminal_session_id: 'sess-1', pid: 42 })
    const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend))
    result.mount(document.createElement('div'))
    await result.spawn({ command: 'bash', cwd: '/tmp' })
    return { result, scope }
  }

  function remembered(): string[] {
    const ids: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key) ids.push(localStorage.getItem(key) ?? '')
    }
    return ids
  }

  it('resolves and forgets the PTY when the backend accepts the kill', async () => {
    const mock = createMockBackend()
    const { result, scope } = await spawned(mock)
    expect(remembered()).toContain('sess-1')

    await expect(result.kill()).resolves.toBeUndefined()

    expect(mock.sent.some((s) => s.type === 'terminal.kill')).toBe(true)
    expect(remembered()).not.toContain('sess-1')
    scope.stop()
  })

  it('rejects, and keeps the PTY id, when the backend refuses the kill', async () => {
    const mock = createMockBackend()
    const { result, scope } = await spawned(mock)
    mock.setResponse('terminal.kill', null, {
      ok: false,
      error: { code: 'TERMINAL_NOT_OWNED', message: 'not owned' },
    })

    await expect(result.kill()).rejects.toThrow(/TERMINAL_NOT_OWNED/)

    expect(remembered()).toContain('sess-1')
    scope.stop()
  })
})

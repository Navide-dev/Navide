// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMockBackend, withScope } from './mockBackend'

// Issue #109: a pane the backend could not wire to navide's MCP (Windows
// without symlink privilege) looked healthy while every navide tool was
// missing. The create ack now carries `wiring_warnings`, and the composable
// prints each one into the pane right after the startup-probe line — the only
// place the user was already looking.
//
// xterm won't boot in happy-dom, so it's mocked; the mock records writeln().

const writes = vi.hoisted(() => [] as string[])

const ctrl = vi.hoisted(() => ({
  applyFit: vi.fn(),
  sendResizeNow: vi.fn(),
  requestResizeRedraw: vi.fn(),
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
    onData(): { dispose(): void } { return { dispose(): void {} } }
    write(): void {}
    writeln(data?: string): void { if (typeof data === 'string') writes.push(data) }
    resize(): void {}
    focus(): void {}
    select(): void {}
    clearSelection(): void {}
    hasSelection(): boolean { return false }
    onSelectionChange(): { dispose: () => void } { return { dispose: (): void => {} } }
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

describe('useTerminal — wiring warnings from the create ack', () => {
  afterEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    writes.length = 0
  })

  async function spawned(payload: Record<string, unknown>) {
    const mock = createMockBackend()
    mock.setResponse('terminal.create', { terminal_session_id: 'sess-1', pid: 42, ...payload })
    const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend))
    result.mount(document.createElement('div'))
    await result.spawn({ command: 'agy', cwd: '/tmp' })
    return { result, scope }
  }

  it('prints every warning into the pane, after the startup probe', async () => {
    const { result, scope } = await spawned({
      startup_probe: { binary_path: '/usr/bin/agy' },
      wiring_warnings: ['navide MCP not wired: symbolic links are not available'],
    })
    expect(result.status.value).toBe('running')
    const probe = writes.findIndex((line) => line.includes('[startup probe]'))
    const mcp = writes.findIndex((line) => line.includes('[mcp] navide MCP not wired: symbolic links'))
    expect(probe).toBeGreaterThanOrEqual(0)
    expect(mcp).toBeGreaterThan(probe)
    scope.stop()
  })

  it('prints nothing extra when the ack carries no warnings', async () => {
    const { scope } = await spawned({})
    expect(writes.some((line) => line.includes('[mcp]'))).toBe(false)
    expect(writes.some((line) => line.includes('has not been tested'))).toBe(false)
    scope.stop()
  })

  it('prints the untested-version line after the probe line (version drift)', async () => {
    const note = 'Claude Code 2.1.304 is newer than the last version Navide verified (2.1.278); '
      + 'it should work, but this version has not been tested'
    const { result, scope } = await spawned({
      startup_probe: { binary_path: '/usr/bin/claude', version: '2.1.304', untested_version: note },
    })
    expect(result.status.value).toBe('running')
    const probe = writes.findIndex((line) => line.includes('[startup probe] /usr/bin/claude v2.1.304'))
    const drift = writes.findIndex((line) => line.includes(`[startup probe] ${note}`))
    expect(probe).toBeGreaterThanOrEqual(0)
    expect(drift).toBeGreaterThan(probe)
    scope.stop()
  })
})

// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMockBackend, withScope } from './mockBackend'

// After an interrupt (cli_interrupt / STOP) the badge reads 'stopped' until a
// person types into the pane. That word records the interrupt; it says nothing
// about whether the CLI is still working. The messaging gate used to read it as
// "not ready" and held every queued cli_send for as long as nobody touched the
// pane (0.2.37: 90 minutes, two panes). liveStatus is the CLI's own state
// behind the badge, which the gate reads instead.
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

describe('useTerminal — liveStatus behind the STOP badge', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    localStorage.clear()
    captured.dataHandler = undefined
  })

  async function spawnedFake() {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const mock = createMockBackend()
    mock.setResponse('terminal.create', { terminal_session_id: 'sess-1', pid: 42 })
    mock.setResponse('terminal.interrupt', { ok: true })
    const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend))
    result.mount(document.createElement('div'))
    const spawning = result.spawn({ command: 'bash', cwd: '/tmp', skipReattach: true })
    await vi.advanceTimersByTimeAsync(200)
    await spawning
    return { result, mock, scope }
  }

  async function work(mock: ReturnType<typeof createMockBackend>, from: number, chunks: number): Promise<void> {
    for (let i = from; i < from + chunks; i++) {
      mock.emit('terminal.output', { terminal_session_id: 'sess-1', data: `line ${i}: agent output\r\n` })
      await vi.advanceTimersByTimeAsync(1_500)
    }
  }

  it('reads idle once the interrupted CLI has gone quiet at its prompt', async () => {
    const { result, mock, scope } = await spawnedFake()
    await work(mock, 0, 5)
    expect(result.displayStatus.value).toBe('running')
    await result.interrupt('agent')
    expect(result.stoppedBy.value).toBe('agent')
    // The CLI repaints "Interrupted · What should Claude do instead?" and
    // stops; nothing reports a turn end for an interrupted turn.
    mock.emit('terminal.output', { terminal_session_id: 'sess-1', data: 'Interrupted · What should Claude do instead?\r\n' })
    await vi.advanceTimersByTimeAsync(11_000)
    expect(result.displayStatus.value).toBe('stopped')
    expect(result.liveStatus.value).toBe('idle')
    scope.stop()
  })

  it('still reads running while the CLI keeps working after the interrupt', async () => {
    // An interrupt the CLI did not act on: output keeps coming, so the pane is
    // busy whatever the badge says, and a message must not be typed into it.
    const { result, mock, scope } = await spawnedFake()
    await work(mock, 0, 5)
    await result.interrupt()
    await work(mock, 5, 8)
    expect(result.displayStatus.value).toBe('stopped')
    expect(result.liveStatus.value).toBe('running')
    scope.stop()
  })

  it('is the same word as displayStatus when nothing was interrupted', async () => {
    const { result, mock, scope } = await spawnedFake()
    await work(mock, 0, 5)
    expect(result.liveStatus.value).toBe(result.displayStatus.value)
    scope.stop()
  })

  it("records a STOP with no stated origin as the user's", async () => {
    const { result, scope } = await spawnedFake()
    await result.interrupt()
    expect(result.isStopped.value).toBe(true)
    expect(result.stoppedBy.value).toBe('user')
    scope.stop()
  })

  it('forgets the origin once a person types and STOP clears', async () => {
    const { result, scope } = await spawnedFake()
    await result.interrupt('agent')
    captured.dataHandler!('h')
    await vi.advanceTimersByTimeAsync(0)
    expect(result.isStopped.value).toBe(false)
    expect(result.stoppedBy.value).toBe(null)
    scope.stop()
  })

  it('treats a STOP restored without an origin as nobody\'s agent', async () => {
    const { result, scope } = await spawnedFake()
    await result.interrupt('agent')
    captured.dataHandler!('h')
    await vi.advanceTimersByTimeAsync(0)
    result.isStopped.value = true
    expect(result.stoppedBy.value).toBe(null)
    scope.stop()
  })

  it("keeps 'exited' over everything", async () => {
    const { result, scope } = await spawnedFake()
    result.isStopped.value = true
    result.status.value = 'exited'
    expect(result.liveStatus.value).toBe('exited')
    scope.stop()
  })
})

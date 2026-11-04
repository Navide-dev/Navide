// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMockBackend, withScope } from './mockBackend'

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
import { messagingGateStatus } from '../../../../lib/agentMessaging'

// 0.2.38 (plan d351f1 n9): after cli_interrupt or the menu's Interrupt, a turn
// the agent started on its own (Stop hook feedback, a schedule, a delivered
// message) left the STOP badge on. ui.status stayed 'stopped' next to
// cli_get_status busy:true, and Interrupt / Reapply Role / Reclaim stayed
// disabled. The badge now clears on the agent's next turn; a STOP a person
// pressed still holds the messaging gate until they type.
describe('useTerminal — STOP badge ends with the agent\'s next turn', () => {
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

  function gate(result: Awaited<ReturnType<typeof spawnedFake>>['result']): string | undefined {
    return messagingGateStatus(
      result.displayStatus.value, result.liveStatus.value, result.stoppedBy.value, result.stopHeldForUser.value,
    )
  }

  it('cli_interrupt, then a turn the agent starts: the badge goes back to the live status', async () => {
    const { result, mock, scope } = await spawnedFake()
    await work(mock, 0, 5)
    await result.interrupt('agent')
    await vi.advanceTimersByTimeAsync(11_000)
    expect(result.displayStatus.value).toBe('stopped')
    // The Stop hook feeds the agent its next instruction; it starts working.
    result.markAgentTurnStart(Date.now())
    await work(mock, 10, 3)
    expect(result.displayStatus.value).toBe('running')
    expect(result.stopHeldForUser.value).toBe(false)
    expect(gate(result)).toBe('running')
    scope.stop()
  })

  it('a person pressed STOP: the badge clears on the agent turn, the gate holds until they type', async () => {
    const { result, mock, scope } = await spawnedFake()
    await work(mock, 0, 5)
    await result.interrupt('user')
    await vi.advanceTimersByTimeAsync(11_000)
    result.markAgentTurnStart(Date.now())
    expect(result.displayStatus.value).not.toBe('stopped')
    // Turn over, CLI idle at its prompt: still no delivery into this pane.
    await vi.advanceTimersByTimeAsync(11_000)
    expect(result.displayStatus.value).toBe('idle')
    expect(gate(result)).toBe('stopped')
    // The person types: the hold is over.
    captured.dataHandler?.('x')
    expect(result.stopHeldForUser.value).toBe(false)
    expect(gate(result)).toBe('idle')
    scope.stop()
  })

  it('a STOP restored from disk clears on the agent turn and keeps holding the gate', async () => {
    const { result, scope } = await spawnedFake()
    await vi.advanceTimersByTimeAsync(11_000)
    result.isStopped.value = true
    result.markAgentTurnStart(Date.now())
    expect(result.displayStatus.value).not.toBe('stopped')
    expect(gate(result)).toBe('stopped')
    scope.stop()
  })

  it('ignores activity from the turn the interrupt cut off', async () => {
    const { result, mock, scope } = await spawnedFake()
    await work(mock, 0, 5)
    await result.interrupt('agent')
    // A record stamped before the interrupt, and one in its settle window.
    result.markAgentTurnStart(Date.now() - 500)
    result.markAgentTurnStart(Date.now() + 1_000)
    expect(result.displayStatus.value).toBe('stopped')
    scope.stop()
  })
})

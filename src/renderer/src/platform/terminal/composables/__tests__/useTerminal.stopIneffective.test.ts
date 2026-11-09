// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMockBackend, withScope } from './mockBackend'

// 0.2.39 Known limitation: a person pressed STOP, Claude spent the Ctrl-C on
// clearing queued input, and the turn ran on. The badge still read STOP and
// Interrupt stayed disabled, so nothing said the press had missed. A STOP now
// waits STOP_EVIDENCE_MS (5 s) for the CLI to show it acted ("[Request
// interrupted by user]", a turn end); with none while the CLI keeps working,
// the badge goes back to the live status marked "STOP not applied".
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

describe('useTerminal — a STOP the CLI did not act on', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    localStorage.clear()
    captured.dataHandler = undefined
  })

  async function spawnedFake(reportsInterrupt = true) {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const mock = createMockBackend()
    mock.setResponse('terminal.create', { terminal_session_id: 'sess-1', pid: 42 })
    mock.setResponse('terminal.interrupt', { ok: true })
    const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend, { reportsInterrupt: () => reportsInterrupt }))
    result.mount(document.createElement('div'))
    const spawning = result.spawn({ command: 'bash', cwd: '/tmp', skipReattach: true })
    await vi.advanceTimersByTimeAsync(200)
    await spawning
    return { result, mock, scope }
  }

  async function work(mock: ReturnType<typeof createMockBackend>, from: number, chunks: number): Promise<void> {
    for (let i = from; i < from + chunks; i++) {
      mock.emit('terminal.output', { terminal_session_id: 'sess-1', data: `line ${i}: agent output\r\n` })
      await vi.advanceTimersByTimeAsync(1_000)
    }
  }

  function gate(result: Awaited<ReturnType<typeof spawnedFake>>['result']): string | undefined {
    return messagingGateStatus(
      result.displayStatus.value, result.liveStatus.value, result.stoppedBy.value, result.stopHeldForUser.value,
    )
  }

  it('no evidence in 5 s while the turn runs on: "STOP not applied", Interrupt pressable again', async () => {
    const { result, mock, scope } = await spawnedFake()
    await work(mock, 0, 5)
    await result.interrupt('user')
    await work(mock, 5, 4)
    expect(result.displayStatus.value).toBe('stopped')
    expect(result.stopIneffective.value).toBe(false)
    await work(mock, 9, 2)
    expect(result.stopIneffective.value).toBe(true)
    // Interrupt is enabled for a 'running' pane (AgentList / ControlPane).
    expect(result.displayStatus.value).toBe('running')
    // The STOP is still recorded, and a person's STOP still holds the queue.
    expect(result.isStopped.value).toBe(true)
    expect(gate(result)).toBe('stopped')
    scope.stop()
  })

  it('a long tool call with no output after the STOP reads "not applied" too', async () => {
    const { result, mock, scope } = await spawnedFake()
    await work(mock, 0, 5)
    await result.interrupt('user')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(result.liveStatus.value).toBe('running')
    expect(result.stopIneffective.value).toBe(true)
    scope.stop()
  })

  it('the interrupt record inside 5 s keeps the STOP badge', async () => {
    const { result, mock, scope } = await spawnedFake()
    await work(mock, 0, 5)
    await result.interrupt('user')
    await vi.advanceTimersByTimeAsync(800)
    result.noteInterruptEvidence()
    await vi.advanceTimersByTimeAsync(11_000)
    expect(result.stopIneffective.value).toBe(false)
    expect(result.displayStatus.value).toBe('stopped')
    expect(gate(result)).toBe('stopped')
    scope.stop()
  })

  it('a turn end inside 5 s (Codex turn_aborted) keeps the STOP badge', async () => {
    const { result, mock, scope } = await spawnedFake()
    await work(mock, 0, 5)
    await result.interrupt('user')
    await vi.advanceTimersByTimeAsync(800)
    result.markTurnComplete()
    await vi.advanceTimersByTimeAsync(11_000)
    expect(result.stopIneffective.value).toBe(false)
    expect(result.displayStatus.value).toBe('stopped')
    scope.stop()
  })

  it('a late interrupt record takes "not applied" back', async () => {
    const { result, mock, scope } = await spawnedFake()
    await work(mock, 0, 5)
    await result.interrupt('user')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(result.stopIneffective.value).toBe(true)
    result.noteInterruptEvidence()
    expect(result.stopIneffective.value).toBe(false)
    expect(result.displayStatus.value).toBe('stopped')
    expect(result.stopHeldForUser.value).toBe(false)
    expect(gate(result)).toBe('stopped')
    scope.stop()
  })

  it('a person typing clears it with the STOP', async () => {
    const { result, mock, scope } = await spawnedFake()
    await work(mock, 0, 5)
    await result.interrupt('user')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(result.stopIneffective.value).toBe(true)
    captured.dataHandler!('x')
    expect(result.isStopped.value).toBe(false)
    expect(result.stopIneffective.value).toBe(false)
    expect(result.stopHeldForUser.value).toBe(false)
    expect(gate(result)).toBe('running')
    scope.stop()
  })

  it("the agent's next turn clears it by the STOP badge's rule, the gate still waits for a person", async () => {
    const { result, mock, scope } = await spawnedFake()
    await work(mock, 0, 5)
    await result.interrupt('user')
    await vi.advanceTimersByTimeAsync(5_000)
    result.markAgentTurnStart(Date.now())
    expect(result.isStopped.value).toBe(false)
    expect(result.stopIneffective.value).toBe(false)
    expect(gate(result)).toBe('stopped')
    scope.stop()
  })

  it("an agent's cli_interrupt that missed does not hold the queue", async () => {
    const { result, mock, scope } = await spawnedFake()
    await work(mock, 0, 5)
    await result.interrupt('agent')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(result.stopIneffective.value).toBe(true)
    expect(result.stopHeldForUser.value).toBe(false)
    expect(gate(result)).toBe('running')
    scope.stop()
  })

  it('a STOP on a pane already settled at its prompt stays STOP', async () => {
    const { result, mock, scope } = await spawnedFake()
    await work(mock, 0, 5)
    await vi.advanceTimersByTimeAsync(11_000)
    expect(result.liveStatus.value).toBe('idle')
    await result.interrupt('user')
    await vi.advanceTimersByTimeAsync(11_000)
    expect(result.stopIneffective.value).toBe(false)
    expect(result.displayStatus.value).toBe('stopped')
    scope.stop()
  })

  it('a CLI that reports no interrupt evidence keeps the old badge', async () => {
    const { result, mock, scope } = await spawnedFake(false)
    await work(mock, 0, 5)
    await result.interrupt('user')
    await work(mock, 5, 8)
    expect(result.stopIneffective.value).toBe(false)
    expect(result.displayStatus.value).toBe('stopped')
    scope.stop()
  })

  it('a second STOP restarts the wait', async () => {
    const { result, mock, scope } = await spawnedFake()
    await work(mock, 0, 5)
    await result.interrupt('user')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(result.stopIneffective.value).toBe(true)
    await result.interrupt('user')
    expect(result.stopIneffective.value).toBe(false)
    expect(result.displayStatus.value).toBe('stopped')
    result.noteInterruptEvidence()
    await vi.advanceTimersByTimeAsync(6_000)
    expect(result.stopIneffective.value).toBe(false)
    scope.stop()
  })
})

// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
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

const ctrl = vi.hoisted(() => ({
  applyFit: vi.fn(), sendResizeNow: vi.fn(), requestResizeRedraw: vi.fn(),
  setColsCap: vi.fn(), capCols: vi.fn((cols: number) => cols),
  attachObserver: vi.fn(), dispose: vi.fn(), ackedCols: 0, ackedRows: 0,
}))
vi.mock('../useTerminalResize', () => ({ createResizeController: () => ctrl }))

// Spy on the clean pipeline while keeping its real behaviour, so the tests can
// count passes AND compare the resulting buffer against the unbatched result.
const bufferSpy = vi.hoisted(() => ({ stripCalls: 0 }))
const captured = vi.hoisted(() => ({ textarea: undefined as HTMLTextAreaElement | undefined }))
vi.mock('../../lib/buffer', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../lib/buffer')>()
  return {
    ...mod,
    stripAnsi: (s: string) => { bufferSpy.stripCalls++; return mod.stripAnsi(s) },
  }
})

vi.mock('@xterm/xterm', () => {
  class Terminal {
    cols = 80; rows = 24
    options: Record<string, unknown> = {}
    unicode = { activeVersion: '6' }
    textarea = document.createElement('textarea')
    buffer = { active: { type: 'normal', viewportY: 0, baseY: 0, cursorX: 0, cursorY: 0, getLine: () => undefined } }
    constructor() { captured.textarea = this.textarea }
    loadAddon(): void {}
    open(): void {}
    attachCustomWheelEventHandler(): void {}
    attachCustomKeyEventHandler(): void {}
    registerLinkProvider(): { dispose(): void } { return { dispose(): void {} } }
    onResize(): { dispose(): void } { return { dispose(): void {} } }
    onData(): { dispose(): void } { return { dispose(): void {} } }
    write(_data: string | Uint8Array, callback?: () => void): void { callback?.() }
    writeln(): void {} resize(): void {} focus(): void {} select(): void {}
    clearSelection(): void {} hasSelection(): boolean { return false }
    onSelectionChange(_h: () => void): { dispose: () => void } { return { dispose: (): void => {} } }
    scrollLines(): void {} scrollToBottom(): void {} dispose(): void {}
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
import { dropTuiNoise, stripAnsi } from '../../lib/buffer'

const enc = new TextEncoder()

describe('useTerminal clean-path coalescing', () => {
  beforeEach(() => { vi.useFakeTimers(); bufferSpy.stripCalls = 0 })
  afterEach(() => { vi.useRealTimers() })

  async function spawnedTerminal() {
    const mock = createMockBackend()
    mock.setResponse('terminal.create', { terminal_session_id: 'sess-1', pid: 42 })
    const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend))
    result.mount(document.createElement('div'))
    const spawning = result.spawn({ command: 'bash', cwd: '/tmp', skipReattach: true })
    await vi.advanceTimersByTimeAsync(200)
    await spawning
    // Focus the pane: focused output is written to xterm on arrival, so every
    // chunk hits the clean queue immediately — the case the coalescing exists
    // for (a background pane is already batched by _BACKGROUND_COALESCE_MS).
    captured.textarea!.dispatchEvent(new Event('focus'))
    await vi.advanceTimersByTimeAsync(200)
    bufferSpy.stripCalls = 0
    return { mock, result, scope }
  }

  function emit(mock: ReturnType<typeof createMockBackend>, data: string | Uint8Array) {
    mock.emit('terminal.output', { terminal_session_id: 'sess-1', data })
  }

  it('cleans a burst of chunks once and matches the per-chunk result exactly', async () => {
    const { mock, result } = await spawnedTerminal()
    const full = 'hello \x1b[31mred\x1b[0m wörld ✓ 中文\r\nline two\r\n'
    const bytes = enc.encode(full)
    // Split mid-escape-sequence and mid-multi-byte-character on purpose:
    // 'ö', '✓' and '中' straddle chunk boundaries, as does "\x1b[".
    const cuts = [7, 15, 25, 27, 31]
    const chunks: Uint8Array[] = []
    let start = 0
    for (const cut of cuts) { chunks.push(bytes.slice(start, cut)); start = cut }
    chunks.push(bytes.slice(start))
    expect(chunks.length).toBe(6)

    for (const c of chunks) emit(mock, c)
    // Chunk path is O(1): nothing cleaned yet, activity clock already bumped.
    expect(bufferSpy.stripCalls).toBe(0)
    expect(result.lastRawActivityAt.value).toBeGreaterThan(0)
    expect(result.cleanBuffer.value).toBe('')

    await vi.advanceTimersByTimeAsync(60)
    expect(bufferSpy.stripCalls).toBe(1)
    expect(result.cleanBuffer.value).toBe(dropTuiNoise(stripAnsi(full)))
    expect(result.cleanBuffer.value).toContain('hello red wörld ✓ 中文')
  })

  // macOS VM 0.2.42/0.2.43: Claude Code 2.1.3xx under bypass permissions drew
  // its whole first frame with cursor moves, footer included, and the pane
  // never counted a visible byte — cli_open_agent left its task untyped.
  it('counts the first frame of a CLI that draws rows with cursor moves', async () => {
    const { mock, result } = await spawnedTerminal()
    emit(mock, enc.encode('\x1b[H Claude Code v2.1.319\r\x1b[1B Opus 5.5\r\x1b[2B❯ \r\x1b[1B ▸▸ bypass permissions on'))
    await vi.advanceTimersByTimeAsync(60)
    expect(result.cleanBytesSeen.value).toBeGreaterThan(0)
    expect(result.cleanBuffer.value).toContain('Claude Code v2.1.319')
  })

  it('flushPendingClean takes effect synchronously', async () => {
    const { mock, result } = await spawnedTerminal()
    emit(mock, enc.encode('abc'))
    emit(mock, enc.encode('def\r\n'))
    expect(result.cleanBuffer.value).toBe('')
    result.flushPendingClean()
    expect(bufferSpy.stripCalls).toBe(1)
    expect(result.cleanBuffer.value).toContain('abcdef')
    // The pending timer was cancelled: no second pass later.
    await vi.advanceTimersByTimeAsync(100)
    expect(bufferSpy.stripCalls).toBe(1)
  })

  it('markBufferPosition sees output that is still in the coalesce window', async () => {
    const { mock, result } = await spawnedTerminal()
    emit(mock, enc.encode('tail text\r\n'))
    expect(result.markBufferPosition()).toBeGreaterThan(0)
    expect(result.cleanBuffer.value).toContain('tail text')
  })

  it('does not lose the queued tail on session exit or dispose', async () => {
    const { mock, result, scope } = await spawnedTerminal()
    emit(mock, enc.encode('before exit\r\n'))
    mock.emit('terminal.exit', { terminal_session_id: 'sess-1', exit_code: 0, signal: null })
    expect(result.cleanBuffer.value).toContain('before exit')

    scope.stop()
    // Nothing throws and no timer is left behind after teardown.
    await vi.advanceTimersByTimeAsync(100)
  })

  it('markTurnComplete sees the last chunk and does not re-latch RUNNING', async () => {
    // turn_complete is a synchronous chain (App.vue → markTurnComplete →
    // judgeTurnText → onStageSlotCompleted → cleanBuffer read). The final
    // chunk of a turn typically lands within the coalesce window before it.
    const { mock, result } = await spawnedTerminal()
    // Distinct lines over > MIN_BURST_MS so the badge is genuinely RUNNING.
    for (let i = 0; i < 12; i++) {
      emit(mock, enc.encode(`line ${i}: agent output\r\n`))
      await vi.advanceTimersByTimeAsync(250)
    }
    await vi.advanceTimersByTimeAsync(1_000)
    expect(result.displayStatus.value).toBe('running')
    emit(mock, enc.encode('final answer\r\n'))
    result.markTurnComplete()
    // (a) the handoff text includes the final chunk...
    expect(result.cleanBuffer.value).toContain('final answer')
    // (b) ...and the deferred clean pass must not re-latch RUNNING after the
    // turn ended (that would hold the badge for IDLE_CONFIRM_MS).
    await vi.advanceTimersByTimeAsync(1_100)
    expect(result.displayStatus.value).not.toBe('running')
  })

  it('flushes the tail on dispose while still in the window', async () => {
    const { mock, result, scope } = await spawnedTerminal()
    emit(mock, enc.encode('before dispose\r\n'))
    expect(result.cleanBuffer.value).toBe('')
    scope.stop()
    expect(result.cleanBuffer.value).toContain('before dispose')
  })
})

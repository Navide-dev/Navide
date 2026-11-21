// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { nextTick } from 'vue'
import { createMockBackend, withScope } from './mockBackend'

// A pane publishes two signals about the person at the keyboard: whether the
// composer holds an unsent line (hasDraft) and when a real keystroke last
// arrived (lastUserKeyAt). App.vue's messaging idle gate holds delivery on
// them, because an injection is a paste plus Enter — it would submit whatever
// half-written line the composer happens to be holding.

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
  dataHandler: undefined as ((data: string) => void) | undefined,
  keyHandler: undefined as ((e: KeyboardEvent) => boolean) | undefined,
}))

vi.mock('@xterm/xterm', () => {
  class Terminal {
    cols = 80
    rows = 24
    options: Record<string, unknown> = {}
    unicode = { activeVersion: '6' }
    textarea: HTMLTextAreaElement | undefined
    getSelection(): string { return '' }
    get modes(): { mouseTrackingMode: string; bracketedPasteMode: boolean } {
      return { mouseTrackingMode: 'none', bracketedPasteMode: false }
    }
    buffer = {
      active: { type: 'normal', viewportY: 0, baseY: 0, cursorX: 0, cursorY: 0, getLine: () => undefined },
    }
    loadAddon(): void {}
    open(el: HTMLElement): void {
      this.textarea = document.createElement('textarea')
      el.appendChild(this.textarea)
    }
    attachCustomWheelEventHandler(): void {}
    attachCustomKeyEventHandler(handler: (e: KeyboardEvent) => boolean): void {
      captured.keyHandler = handler
    }
    registerLinkProvider(): { dispose(): void } { return { dispose(): void {} } }
    onResize(): { dispose(): void } { return { dispose(): void {} } }
    onData(cb: (data: string) => void): { dispose(): void } {
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

describe('useTerminal — draft and keystroke signals', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    captured.dataHandler = undefined
    localStorage.clear()
  })

  async function spawnedTerminal() {
    const mock = createMockBackend()
    mock.setResponse('terminal.create', { terminal_session_id: 'sess-1', pid: 42 })
    const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend))
    result.mount(document.createElement('div'))
    await result.spawn({ command: 'bash', cwd: '/tmp', agentKey: 'claude' })
    return { mock, scope, terminal: result }
  }

  function type(text: string): void {
    for (const ch of text) captured.dataHandler!(ch)
  }

  it('starts with no draft and no keystroke on record', async () => {
    const { scope, terminal } = await spawnedTerminal()
    expect(terminal.hasDraft.value).toBe(false)
    expect(terminal.lastUserKeyAt.value).toBe(0)
    scope.stop()
  })

  it('reports a draft while the typed line is unsent', async () => {
    const { scope, terminal } = await spawnedTerminal()
    type('review this')
    expect(terminal.hasDraft.value).toBe(true)
    scope.stop()
  })

  it('clears the draft on Enter', async () => {
    const { scope, terminal } = await spawnedTerminal()
    type('review this')
    captured.dataHandler!('\r')
    expect(terminal.hasDraft.value).toBe(false)
    scope.stop()
  })

  it('clears the draft when backspace empties the line', async () => {
    const { scope, terminal } = await spawnedTerminal()
    type('ab')
    expect(terminal.hasDraft.value).toBe(true)
    captured.dataHandler!('\x7f')
    expect(terminal.hasDraft.value).toBe(true)
    captured.dataHandler!('\x7f')
    expect(terminal.hasDraft.value).toBe(false)
    scope.stop()
  })

  it.each([
    ['Ctrl+C', '\x03'],
    ['Ctrl+U', '\x15'],
    ['Escape', '\x1b'],
  ])('clears the draft when %s empties the composer', async (_name, key) => {
    // The CLI drops the line on these; without a branch for them the buffer
    // would keep it and the pane would stay "being typed at" until the next
    // Enter — the everyday way this gate latches.
    const { scope, terminal } = await spawnedTerminal()
    type('half a thought')
    expect(terminal.hasDraft.value).toBe(true)
    captured.dataHandler!(key)
    expect(terminal.hasDraft.value).toBe(false)
    scope.stop()
  })

  it('drops one word on Ctrl+W rather than calling the line finished', async () => {
    const { scope, terminal } = await spawnedTerminal()
    type('review the diff')
    captured.dataHandler!('\x17')
    expect(terminal.hasDraft.value).toBe(true)
    captured.dataHandler!('\x17')
    captured.dataHandler!('\x17')
    expect(terminal.hasDraft.value).toBe(false)
    scope.stop()
  })

  it('leaves no residue for either mouse encoding', async () => {
    // X10 puts the button and coordinates in three PRINTABLE bytes after
    // `ESC[M`, so stripping escape sequences alone is not enough for it.
    const { scope, terminal } = await spawnedTerminal()
    captured.dataHandler!('\x1b[M !!')
    captured.dataHandler!('\x1b[<0;10;5M')
    expect(terminal.hasDraft.value).toBe(false)
    expect(terminal.lastUserKeyAt.value).toBe(0)
    scope.stop()
  })

  it('treats a whitespace-only line as no draft', async () => {
    const { scope, terminal } = await spawnedTerminal()
    type('   ')
    expect(terminal.hasDraft.value).toBe(false)
    scope.stop()
  })

  it('does not let a cursor key latch a draft that never clears', async () => {
    // The control-character sweep alone leaves "[A" in the buffer, which would
    // read as an unsent line for as long as the pane lives.
    const { scope, terminal } = await spawnedTerminal()
    captured.dataHandler!('\x1b[A')
    expect(terminal.hasDraft.value).toBe(false)
    scope.stop()
  })

  it('does not let a mouse report latch a draft, or count as typing', async () => {
    const { scope, terminal } = await spawnedTerminal()
    captured.dataHandler!('\x1b[<0;10;5M')
    expect(terminal.hasDraft.value).toBe(false)
    expect(terminal.lastUserKeyAt.value).toBe(0)
    scope.stop()
  })

  it.each([
    ['focus in', '\x1b[I'],
    ['focus out', '\x1b[O'],
  ])('does not count a %s report as typing', async (_name, report) => {
    // A CLI with focus tracking on sends these when the pane is clicked into or
    // away from. Clicking somewhere is not typing, and treating it as a
    // keystroke parks delivery for the whole hold window on a glance.
    const { scope, terminal } = await spawnedTerminal()
    captured.dataHandler!(report)
    expect(terminal.lastUserKeyAt.value).toBe(0)
    expect(terminal.hasDraft.value).toBe(false)
    scope.stop()
  })

  // Every reply @xterm/xterm 6.0.0 sends on its own, in the exact bytes it
  // emits (src/common/InputHandler.ts, src/browser/CoreBrowserTerminal.ts).
  // ConPTY asks for the cursor position (ESC[6n) as a fresh pane starts, and
  // shells and CLIs probe DA / modes / colors at startup — none of that is the
  // person at the keyboard, and counting it held cli_send for the full window.
  it.each([
    ['CPR', '\x1b[24;1R'],
    ['DECXCPR', '\x1b[?24;1R'],
    ['DSR status', '\x1b[0n'],
    ['DA1', '\x1b[?1;2c'],
    ['DA2', '\x1b[>0;276;0c'],
    ['DA3', '\x1b[=0c'],
    ['DECRPM (DEC)', '\x1b[?2004;2$y'],
    ['DECRPM (ANSI)', '\x1b[4;2$y'],
    ['DECRQSS valid', '\x1bP1$r0m\x1b\\'],
    ['DECRQSS invalid', '\x1bP0$r\x1b\\'],
    ['OSC 10 color', '\x1b]10;rgb:ffff/ffff/ffff\x1b\\'],
    ['OSC 11 color', '\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\'],
    ['OSC 4 color', '\x1b]4;1;rgb:cdcd/0000/0000\x1b\\'],
    ['window size px', '\x1b[4;480;640t'],
    ['cell size px', '\x1b[6;20;10t'],
    ['window size chars', '\x1b[8;24;80t'],
  ])('does not count an automatic %s reply as typing', async (_name, reply) => {
    const { scope, terminal } = await spawnedTerminal()
    captured.dataHandler!(reply)
    expect(terminal.lastUserKeyAt.value).toBe(0)
    expect(terminal.hasDraft.value).toBe(false)
    scope.stop()
  })

  it('still counts typing that looks report-shaped only as a prefix', async () => {
    // A paste that merely starts with reply-like bytes is still the user.
    const { scope, terminal } = await spawnedTerminal()
    captured.dataHandler!('\x1b[24;1Rhello')
    expect(terminal.lastUserKeyAt.value).toBeGreaterThan(0)
    scope.stop()
  })

  it('records a keystroke time for real typing, including Enter', async () => {
    const { scope, terminal } = await spawnedTerminal()
    type('a')
    const typed = terminal.lastUserKeyAt.value
    expect(typed).toBeGreaterThan(0)
    captured.dataHandler!('\r')
    expect(terminal.lastUserKeyAt.value).toBeGreaterThanOrEqual(typed)
    scope.stop()
  })

  it('counts a keystroke held back by the spawn-phase gate', async () => {
    // Held input is still the user typing — refusing to send it does not make
    // the person at the keyboard go away.
    const { scope, terminal } = await spawnedTerminal()
    terminal.setDisableStdin(true)
    type('a')
    expect(terminal.lastUserKeyAt.value).toBeGreaterThan(0)
    scope.stop()
  })

  it('counts a clipboard paste as an unsent draft', async () => {
    const { scope, terminal } = await spawnedTerminal()
    terminal.pasteFromClipboard('pasted but not sent')
    expect(terminal.hasDraft.value).toBe(true)
    expect(terminal.lastUserKeyAt.value).toBeGreaterThan(0)
    scope.stop()
  })

  it('leaves no draft when the paste ends in a newline', async () => {
    const { scope, terminal } = await spawnedTerminal()
    terminal.pasteFromClipboard('run it\n')
    expect(terminal.hasDraft.value).toBe(false)
    scope.stop()
  })

  // ── Keys the CLI consumes without an Enter ────────────────────────────────
  // A permission prompt or an AskUserQuestion box is answered with a bare
  // `1`/`2`/`y`. No key that empties the buffer ever follows, so without the
  // two rules below the pane reports a draft for the rest of its life: every
  // message to it stops at "someone is typing", and syncPaneBusy keeps telling
  // the backend it is busy.

  /** Feed one chunk of PTY output and wait out the background coalescing timer,
   *  which is what turns it into recorded activity. */
  async function output(mock: ReturnType<typeof createMockBackend>, data: string): Promise<void> {
    mock.emit('terminal.output', { terminal_session_id: 'sess-1', data })
    await new Promise((r) => setTimeout(r, 150))
  }

  async function parkedThenAnswered() {
    const { mock, scope, terminal } = await spawnedTerminal()
    // A byte first: a pane that has emitted nothing is still booting, and
    // displayStatus reports 'starting' whatever else is set.
    await output(mock, 'Do you want to proceed?')
    terminal.markNeedsInput()
    await nextTick()
    expect(terminal.displayStatus.value).toBe('awaiting')
    return { scope, terminal }
  }

  it('reports the draft while the pane is still parked on the prompt', async () => {
    const { scope, terminal } = await parkedThenAnswered()
    type('1')
    expect(terminal.hasDraft.value).toBe(true)
    scope.stop()
  })

  it.each([['1'], ['2'], ['y'], ['n']])(
    'clears a %s answer once the pane leaves the prompt',
    async (answer) => {
      const { scope, terminal } = await parkedThenAnswered()
      type(answer)

      // The CLI took the answer and started working.
      terminal.markTurnComplete()
      await nextTick()

      expect(terminal.displayStatus.value).not.toBe('awaiting')
      expect(terminal.hasDraft.value).toBe(false)
      scope.stop()
    },
  )

  it('keeps a real half-written line when the prompt ends on its own', async () => {
    // `idle_prompt` and the other resolved Notification types end AWAITING with
    // no answer from anyone (see cliAwaitingInput's RESOLVED_NOTIFICATION_TYPES),
    // so leaving the prompt is not proof the line was consumed. Clearing it
    // unconditionally would let the next injection submit what was left of it.
    const { scope, terminal } = await parkedThenAnswered()
    type('請幫我看一下')

    terminal.clearNeedsInput()
    await nextTick()

    expect(terminal.displayStatus.value).not.toBe('awaiting')
    expect(terminal.hasDraft.value).toBe(true)
    scope.stop()
  })

  it('clears a question answered the same way', async () => {
    const { mock, scope, terminal } = await spawnedTerminal()
    await output(mock, 'Which one?')
    terminal.markQuestion()
    await nextTick()
    expect(terminal.displayStatus.value).toBe('awaiting')
    type('2')
    expect(terminal.hasDraft.value).toBe(true)

    terminal.clearQuestion()
    await nextTick()

    expect(terminal.hasDraft.value).toBe(false)
    scope.stop()
  })

  it('keeps a line typed at a pane that was never parked', async () => {
    // The narrowness is the point: a turn ending while someone writes their
    // next prompt must not drop what they have written.
    const { scope, terminal } = await spawnedTerminal()
    type('review the diff')

    terminal.markTurnComplete()
    await nextTick()

    expect(terminal.hasDraft.value).toBe(true)
    scope.stop()
  })

  it('stops calling a minute-old line a draft', async () => {
    // Backstop for every latch the transition above does not see. The buffer
    // itself is kept — `/clear` still has to be recognisable.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { scope, terminal } = await spawnedTerminal()
      type('half a thought')
      expect(terminal.hasDraft.value).toBe(true)

      await vi.advanceTimersByTimeAsync(61_000)

      expect(terminal.hasDraft.value).toBe(false)
      scope.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('brings the draft back when the same line is typed at again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { scope, terminal } = await spawnedTerminal()
      type('half a thought')
      await vi.advanceTimersByTimeAsync(61_000)
      expect(terminal.hasDraft.value).toBe(false)

      type('!')

      expect(terminal.hasDraft.value).toBe(true)
      scope.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

// The backend counts development time off `human: true` on terminal.input.
// Only the keyboard may set it: the paste helpers are what programmatic
// injection rides, and a mouse report is the terminal talking, not the user.
describe('useTerminal — human flag on terminal.input', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    captured.dataHandler = undefined
    localStorage.clear()
  })

  async function spawnedTerminal() {
    const mock = createMockBackend()
    mock.setResponse('terminal.create', { terminal_session_id: 'sess-1', pid: 42 })
    const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend))
    result.mount(document.createElement('div'))
    await result.spawn({ command: 'bash', cwd: '/tmp', agentKey: 'claude' })
    return { mock, scope, terminal: result }
  }

  const inputs = (mock: ReturnType<typeof createMockBackend>) =>
    mock.sent.filter((s) => s.type === 'terminal.input').map((s) => s.payload)

  it('marks a keystroke as human', async () => {
    const { mock, scope } = await spawnedTerminal()
    captured.dataHandler!('a')
    captured.dataHandler!('\x1b[A')
    expect(inputs(mock)).toEqual([
      { terminal_session_id: 'sess-1', data: 'a', human: true },
      { terminal_session_id: 'sess-1', data: '\x1b[A', human: true },
    ])
    scope.stop()
  })

  it.each([
    ['SGR mouse', '\x1b[<0;10;10M'],
    ['X10 mouse', '\x1b[M !!'],
    ['focus in', '\x1b[I'],
    ['focus out', '\x1b[O'],
    ['CPR', '\x1b[24;1R'],
    ['DA1', '\x1b[?1;2c'],
  ])('sends a %s report without the flag', async (_name, report) => {
    const { mock, scope } = await spawnedTerminal()
    captured.dataHandler!(report)
    expect(inputs(mock)).toEqual([{ terminal_session_id: 'sess-1', data: report }])
    scope.stop()
  })

  it('never flags pasteText, which injection also rides', async () => {
    const { mock, scope, terminal } = await spawnedTerminal()
    expect(terminal.pasteText('review this\r')).toBe(true)
    expect(inputs(mock)).toEqual([{ terminal_session_id: 'sess-1', data: 'review this\r' }])
    scope.stop()
  })

  it('carries the flag on the gated flush when the held bytes were typed', async () => {
    const { mock, scope, terminal } = await spawnedTerminal()
    terminal.setDisableStdin(true)
    captured.dataHandler!('\x1b[I')
    captured.dataHandler!('h')
    captured.dataHandler!('i')
    expect(inputs(mock)).toEqual([])
    terminal.setDisableStdin(false)
    expect(inputs(mock)).toEqual([{ terminal_session_id: 'sess-1', data: '\x1b[Ihi', human: true }])
    scope.stop()
  })

  it('flushes a gate that only ever held terminal reports without the flag', async () => {
    const { mock, scope, terminal } = await spawnedTerminal()
    terminal.setDisableStdin(true)
    captured.dataHandler!('\x1b[<0;10;10M')
    terminal.setDisableStdin(false)
    expect(inputs(mock)).toEqual([{ terminal_session_id: 'sess-1', data: '\x1b[<0;10;10M' }])
    scope.stop()
  })
})

// Restore (lib/claudeComposer.ts) puts back what an interrupt returned to
// Claude Code's box; the box is hard-wrapped, so the pane keeps the prompt as
// it was sent.
describe('useTerminal — last submitted prompt', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    captured.dataHandler = undefined
    captured.keyHandler = undefined
    localStorage.clear()
  })

  async function spawnedTerminal() {
    const mock = createMockBackend()
    mock.setResponse('terminal.create', { terminal_session_id: 'sess-1', pid: 42 })
    const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend))
    result.mount(document.createElement('div'))
    await result.spawn({ command: 'bash', cwd: '/tmp', agentKey: 'claude' })
    return { scope, terminal: result }
  }

  function type(text: string): void {
    for (const ch of text) captured.dataHandler!(ch)
  }

  function shiftEnter(): void {
    captured.keyHandler!({
      type: 'keydown', key: 'Enter', shiftKey: true, metaKey: false, altKey: false, ctrlKey: false,
      preventDefault: () => {}, stopPropagation: () => {},
    } as unknown as KeyboardEvent)
  }

  it('is empty until something is sent, and is what Enter sent — not just the last 100 chars', async () => {
    const { scope, terminal } = await spawnedTerminal()
    expect(terminal.lastSubmittedPrompt()).toBe('')
    const long = 'x'.repeat(150)
    type(long)
    expect(terminal.lastSubmittedPrompt()).toBe('')
    captured.dataHandler!('\r')
    expect(terminal.lastSubmittedPrompt()).toBe(long)
    scope.stop()
  })

  it('keeps Shift+Enter, a trailing-backslash Enter and a paste\'s line breaks', async () => {
    const { scope, terminal } = await spawnedTerminal()
    type('first')
    shiftEnter()
    type('second\\')
    captured.dataHandler!('\r') // Claude Code: a line break, not a send
    expect(terminal.lastSubmittedPrompt()).toBe('')
    captured.dataHandler!('\x1b[200~third\rfourth\x1b[201~')
    captured.dataHandler!('\r')
    expect(terminal.lastSubmittedPrompt()).toBe('first\nsecond\nthird\nfourth')
    scope.stop()
  })

  it('follows edits, and an empty Enter or a cleared line leaves the last prompt as it was', async () => {
    const { scope, terminal } = await spawnedTerminal()
    type('fix teh')
    captured.dataHandler!('\x7f')
    captured.dataHandler!('\x7f')
    type('he bug')
    captured.dataHandler!('\r')
    expect(terminal.lastSubmittedPrompt()).toBe('fix the bug')
    type('never sent')
    captured.dataHandler!('\x15')
    captured.dataHandler!('\r')
    expect(terminal.lastSubmittedPrompt()).toBe('fix the bug')
    scope.stop()
  })

  it('never holds what Navide writes to the pane', async () => {
    const { scope, terminal } = await spawnedTerminal()
    type('my prompt')
    captured.dataHandler!('\r')
    terminal.pasteText('[Navide MSG] from: Navide指揮 hi')
    terminal.pasteText('\r')
    expect(terminal.lastSubmittedPrompt()).toBe('my prompt')
    scope.stop()
  })

  it('is forgotten when the pane goes away', async () => {
    const { scope, terminal } = await spawnedTerminal()
    type('my prompt')
    captured.dataHandler!('\r')
    scope.stop()
    expect(terminal.lastSubmittedPrompt()).toBe('')
  })
})

// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMockBackend, withScope } from './mockBackend'

// The RUNNING/idle badge is driven by useTerminal's clean-content quiescence
// heuristic: a sustained burst of CLEANED PTY output (>MIN_BURST_MS ~2s) shows
// RUNNING. Two things must NOT count as agent activity:
//   1. A repaint that replays content already on screen — a focus/click or a
//      refit makes the CLI re-emit its current frame. isRedrawReplay drops it
//      (content-level dedup, reflow-tolerant) so a mere click/resize can't flip
//      the badge to RUNNING. Genuine NEW output during a focus is not masked.
//   2. An idle CLI's own footer/cursor repaints — raw bytes that are empty
//      after ANSI/noise stripping. This is why the badge tracks CLEANED
//      content, not raw bytes: an idle Claude repainting its prompt must read
//      as idle, not RUNNING.
// These tests pin: real clean output → RUNNING (even while focused); an
// on-screen content replay → non-running; and a pure-ANSI repaint stream →
// non-running.
//
// xterm won't boot in happy-dom, so it's mocked; ctrl.requestResizeRedraw is a
// no-op stub.

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

// The keyboard: the handlers useTerminal registers on xterm's onData, so a test
// can type into the pane the way the user does.
const keyboard = vi.hoisted(() => ({ handlers: [] as Array<(data: string) => void> }))

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
    onData(handler: (data: string) => void): { dispose(): void } {
      keyboard.handlers.push(handler)
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('useTerminal — RUNNING badge vs self-triggered repaints', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    localStorage.clear()
    keyboard.handlers.length = 0
  })

  const typeKeys = (data: string): void => keyboard.handlers.at(-1)?.(data)

  async function spawned() {
    const mock = createMockBackend()
    mock.setResponse('terminal.create', { terminal_session_id: 'sess-1', pid: 42 })
    const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend))
    result.mount(document.createElement('div'))
    await result.spawn({ command: 'bash', cwd: '/tmp' })
    return { result, mock, scope }
  }

  // Feed a sub-BURST_GAP_MS (1s) stream of PTY bytes for `ms`, running `onTick`
  // before each chunk (used to keep re-arming a focus/refit grace).
  async function stream(
    mock: ReturnType<typeof createMockBackend>,
    ms: number,
    onTick?: () => void,
  ): Promise<void> {
    const deadline = Date.now() + ms
    do {
      onTick?.()
      mock.emit('terminal.output', { terminal_session_id: 'sess-1', data: '.' })
      await sleep(250)
    } while (Date.now() < deadline)
  }

  it('shows RUNNING for a genuine sustained output burst', async () => {
    const { result, mock, scope } = await spawned()
    // Sustain a burst well past MIN_BURST_MS (~2s).
    await stream(mock, 6000)
    expect(result.displayStatus.value).toBe('running')
    scope.stop()
  }, 12_000)

  it('shows RUNNING for a real burst even while the pane is repeatedly focused', async () => {
    const { result, mock, scope } = await spawned()
    // Re-focusing every tick used to arm a grace that suppressed RUNNING even
    // for genuine output. With content-level dedup, a real burst is no longer
    // masked by focus — only actual on-screen replays are dropped (next test).
    await stream(mock, 6000, () => result.focus())
    expect(result.displayStatus.value).toBe('running')
    scope.stop()
  }, 12_000)

  it('stays non-running when a focus/refit repaint replays on-screen content', async () => {
    const { result, mock, scope } = await spawned()
    // A distinctive screenful the CLI has already emitted (becomes cleanBuffer).
    const screen = 'Reading the terminal composable and wiring the new helper into place here.'
    mock.emit('terminal.output', { terminal_session_id: 'sess-1', data: screen })
    // A single chunk can never sustain a burst, so RUNNING is never latched;
    // the pause just separates it from the replay stream that follows.
    await sleep(2500)
    // User clicks / a refit fires; the CLI repaints the SAME frame verbatim over
    // and over. isRedrawReplay drops each repaint, so no RUNNING burst forms.
    const deadline = Date.now() + 6000
    do {
      result.focus()
      result.fitTerminal({ redrawAfterSettle: true })
      mock.emit('terminal.output', { terminal_session_id: 'sess-1', data: screen })
      await sleep(250)
    } while (Date.now() < deadline)
    expect(result.displayStatus.value).not.toBe('running')
    scope.stop()
  }, 12_000)

  it('stays non-running while the CLI only emits idle TUI repaints (no clean content)', async () => {
    const { result, mock, scope } = await spawned()
    // A pure erase-line + cursor-home repaint. stripAnsi removes it entirely, so
    // it carries no clean content — exactly what an idle Claude emits when it
    // repaints its prompt/cursor while waiting for input. Raw bytes keep
    // arriving (liveness stays alive) but no RUNNING burst may form.
    const deadline = Date.now() + 6000
    do {
      mock.emit('terminal.output', { terminal_session_id: 'sess-1', data: '\x1b[2K\x1b[1G' })
      await sleep(250)
    } while (Date.now() < deadline)
    expect(result.displayStatus.value).not.toBe('running')
    scope.stop()
  }, 12_000)

  // Fake-timer variant of spawned(): the hysteresis windows are 3–10s, far too
  // slow to sleep through for real.
  async function spawnedFake() {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const mock = createMockBackend()
    mock.setResponse('terminal.create', { terminal_session_id: 'sess-1', pid: 42 })
    const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend))
    result.mount(document.createElement('div'))
    const spawning = result.spawn({ command: 'bash', cwd: '/tmp', skipReattach: true })
    await vi.advanceTimersByTimeAsync(200)
    await spawning
    return { result, mock, scope }
  }

  // Distinct content per chunk: identical text would be dropped as a redraw
  // replay and never build a burst.
  async function chunkThenWait(
    mock: ReturnType<typeof createMockBackend>,
    n: number,
    gapMs: number,
  ): Promise<void> {
    mock.emit('terminal.output', { terminal_session_id: 'sess-1', data: `line ${n}: agent output\r\n` })
    await vi.advanceTimersByTimeAsync(gapMs)
  }

  it('reaches RUNNING for a choppy burst whose chunks are 1.5s apart', async () => {
    // Regression: BURST_GAP_MS used to be shorter than MIN_BURST_MS, so a gap
    // in between (here 1.5s) reset the burst start before it could ever reach
    // the threshold — the badge stayed idle forever while the agent worked.
    const { result, mock, scope } = await spawnedFake()
    for (let i = 0; i < 5; i++) await chunkThenWait(mock, i, 1_500)
    expect(result.displayStatus.value).toBe('running')
    scope.stop()
  })

  it('stays RUNNING through a 3s tool-call silence once latched', async () => {
    const { result, mock, scope } = await spawnedFake()
    for (let i = 0; i < 5; i++) await chunkThenWait(mock, i, 1_500)
    expect(result.displayStatus.value).toBe('running')
    // A tool call produces no output for seconds; the badge must not flicker.
    await vi.advanceTimersByTimeAsync(3_000)
    expect(result.displayStatus.value).toBe('running')
    scope.stop()
  })

  it('drops to idle immediately when markTurnComplete() fires', async () => {
    const { result, mock, scope } = await spawnedFake()
    for (let i = 0; i < 5; i++) await chunkThenWait(mock, i, 1_500)
    expect(result.displayStatus.value).toBe('running')
    result.markTurnComplete()
    expect(result.displayStatus.value).toBe('idle')
    scope.stop()
  })

  // ── AWAITING: parked on the user ──────────────────────────────────────────
  // A CLI sitting on a permission prompt paints the prompt once and then goes
  // silent, which the PTY heuristic alone cannot tell apart from a turn that
  // finished — both settle to idle. Claude's Notification hook is the only
  // signal that separates them, routed in as markNeedsInput().

  it('shows AWAITING when markNeedsInput() fires, overriding a latched RUNNING', async () => {
    const { result, mock, scope } = await spawnedFake()
    for (let i = 0; i < 5; i++) await chunkThenWait(mock, i, 1_500)
    expect(result.displayStatus.value).toBe('running')
    result.markNeedsInput()
    expect(result.displayStatus.value).toBe('awaiting')
    scope.stop()
  })

  it('holds AWAITING through the prompt painting itself (hook and paint race)', async () => {
    const { result, mock, scope } = await spawnedFake()
    result.markNeedsInput()
    // The prompt box is clean output and can land either side of the hook —
    // one arrives over HTTP, the other over the PTY. Inside the settle window
    // it is the prompt drawing itself, not the agent resuming.
    await chunkThenWait(mock, 1, 500)
    expect(result.displayStatus.value).toBe('awaiting')
    scope.stop()
  })

  it('stays AWAITING past the idle timeout instead of decaying to idle', async () => {
    // The whole point: silence must NOT be read as "done" here. Before this
    // state a parked pane looked exactly like a finished one after 10s.
    const { result, mock, scope } = await spawnedFake()
    for (let i = 0; i < 5; i++) await chunkThenWait(mock, i, 1_500)
    result.markNeedsInput()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(result.displayStatus.value).toBe('awaiting')
    scope.stop()
  })

  it('leaves AWAITING once real output arrives after the settle window', async () => {
    const { result, mock, scope } = await spawnedFake()
    // One chunk first: a pane that has never emitted a byte is still booting,
    // and booting outranks awaiting (a CLI that hasn't started can't be asking).
    await chunkThenWait(mock, 0, 100)
    result.markNeedsInput()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(result.displayStatus.value).toBe('awaiting')
    // The user answered and the CLI resumed.
    await chunkThenWait(mock, 1, 100)
    expect(result.displayStatus.value).not.toBe('awaiting')
    scope.stop()
  })

  // The PermissionRequest hook knows the box is open until it is answered, so
  // its wait is held: the box's own repaints past the settle window must not
  // end it, which is how a pane parked on a permission box used to decay.
  it('keeps a held AWAITING through output past the settle window', async () => {
    const { result, mock, scope } = await spawnedFake()
    await chunkThenWait(mock, 0, 100)
    result.holdNeedsInput('Bash:aaaa')
    await vi.advanceTimersByTimeAsync(5_000)
    await chunkThenWait(mock, 1, 100)
    expect(result.displayStatus.value).toBe('awaiting')
    expect(result.awaitingKind.value).toBe('permission')
    scope.stop()
  })

  it('leaves a held AWAITING once the hold is released', async () => {
    const { result, mock, scope } = await spawnedFake()
    await chunkThenWait(mock, 0, 100)
    result.holdNeedsInput('Bash:aaaa')
    expect(result.awaitingHeld()).toMatchObject({ key: 'Bash:aaaa' })
    expect(result.awaitingHeld().since).toBeGreaterThan(0)
    result.releaseNeedsInputHold()
    expect(result.awaitingHeld()).toEqual({ since: 0, key: '' })
    expect(result.displayStatus.value).not.toBe('awaiting')
    scope.stop()
  })

  it("releasing the hold leaves the Notification hook's own wait standing", async () => {
    // The same box can be reported by both hooks. Ending the hold must not wipe
    // the wait the Notification hook raised: that one still settles on output.
    const { result, mock, scope } = await spawnedFake()
    await chunkThenWait(mock, 0, 100)
    result.markNeedsInput()
    result.holdNeedsInput('Bash:aaaa')
    result.releaseNeedsInputHold()
    expect(result.displayStatus.value).toBe('awaiting')
    expect(result.permissionWaitLive()).toBe(true)
    // ...and it still ends the way it always did, on output past its settle window.
    await vi.advanceTimersByTimeAsync(5_000)
    await chunkThenWait(mock, 1, 100)
    expect(result.displayStatus.value).not.toBe('awaiting')
    expect(result.permissionWaitLive()).toBe(false)
    scope.stop()
  })

  it('leaves a held AWAITING on an authoritative turn end', async () => {
    const { result, mock, scope } = await spawnedFake()
    await chunkThenWait(mock, 0, 100)
    result.holdNeedsInput('Bash:aaaa')
    result.markTurnComplete()
    expect(result.awaitingHeld().since).toBe(0)
    expect(result.displayStatus.value).toBe('idle')
    scope.stop()
  })

  // The answering key is classified by keysAnswerPermissionBox (its own tests
  // hold the key matrix); these two pin that typing reaches it.
  it('releases a held AWAITING when an answering key is typed', async () => {
    const { result, mock, scope } = await spawnedFake()
    await chunkThenWait(mock, 0, 100)
    result.holdNeedsInput('Bash:aaaa')
    typeKeys('\r')
    expect(result.awaitingHeld().since).toBe(0)
    expect(result.displayStatus.value).not.toBe('awaiting')
    scope.stop()
  })

  it('keeps a held AWAITING through navigation', async () => {
    const { result, mock, scope } = await spawnedFake()
    await chunkThenWait(mock, 0, 100)
    result.holdNeedsInput('Bash:aaaa')
    typeKeys('\x1b[B')
    expect(result.awaitingHeld().since).toBeGreaterThan(0)
    expect(result.displayStatus.value).toBe('awaiting')
    scope.stop()
  })

  it('releases a held AWAITING on keys relayed straight to the PTY', async () => {
    // ui.pane.sendKeys writes through terminal.input, not through onData.
    const { result, mock, scope } = await spawnedFake()
    await chunkThenWait(mock, 0, 100)
    result.holdNeedsInput('Bash:aaaa')
    result.noteAnswerKeys('1')
    expect(result.awaitingHeld().since).toBe(0)
    scope.stop()
  })

  it('does not carry AWAITING across a respawn', async () => {
    // The composable outlives the PTY, so a pane rebuilt while parked on a
    // prompt would otherwise open showing a question that no longer exists.
    const { result, mock, scope } = await spawnedFake()
    await chunkThenWait(mock, 0, 100)
    result.markNeedsInput()
    result.holdNeedsInput('Bash:aaaa')
    expect(result.displayStatus.value).toBe('awaiting')

    // The PTY ends (backend exit event); spawn() only runs from a dead pane.
    result.status.value = 'exited'
    mock.setResponse('terminal.create', { terminal_session_id: 'sess-2', pid: 43 })
    const respawning = result.spawn({ command: 'bash', cwd: '/tmp', skipReattach: true })
    await vi.advanceTimersByTimeAsync(200)
    await respawning
    await chunkThenWait(mock, 1, 100)

    expect(result.displayStatus.value).not.toBe('awaiting')
    expect(result.awaitingHeld()).toEqual({ since: 0, key: '' })
    scope.stop()
  })

  it('clears AWAITING on markTurnComplete() so a stale hook cannot hold it', async () => {
    const { result, mock, scope } = await spawnedFake()
    await chunkThenWait(mock, 0, 100)
    result.markNeedsInput()
    expect(result.displayStatus.value).toBe('awaiting')
    result.markTurnComplete()
    expect(result.displayStatus.value).toBe('idle')
    scope.stop()
  })

  it('reports AWAITING once the agent asks something', async () => {
    // One badge for every way a pane parks on the user; awaitingKind is what
    // still tells the two apart for the code that needs to know.
    const { result, mock, scope } = await spawnedFake()
    for (let i = 0; i < 5; i++) await chunkThenWait(mock, i, 1_500)
    expect(result.displayStatus.value).toBe('running')
    result.markQuestion()
    expect(result.displayStatus.value).toBe('awaiting')
    expect(result.awaitingKind.value).toBe('question')
    scope.stop()
  })

  it('stays QUESTION past the idle timeout instead of decaying to idle', async () => {
    // Same failure this state exists to prevent: a pane waiting on an answer
    // is silent, and silence used to be read as "done".
    const { result, mock, scope } = await spawnedFake()
    for (let i = 0; i < 5; i++) await chunkThenWait(mock, i, 1_500)
    result.markQuestion()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(result.displayStatus.value).toBe('awaiting')
    expect(result.awaitingKind.value).toBe('question')
    scope.stop()
  })

  it('holds QUESTION over an authoritative turn end (a turn can END on a question)', async () => {
    // Claude reports turn_complete for a turn that closed on "shall I?", so
    // QUESTION has to outrank the turnCompleteAt idle path or it never shows.
    const { result, mock, scope } = await spawnedFake()
    await chunkThenWait(mock, 0, 100)
    result.markTurnComplete()
    result.markQuestion()
    expect(result.displayStatus.value).toBe('awaiting')
    expect(result.awaitingKind.value).toBe('question')
    scope.stop()
  })

  // ── DELIVERED-PENDING: a message Navide sent in, not yet consumed ────────
  // Claude Code enqueues a mid-turn message and keeps working on the current
  // turn; a long tool call paints only a spinner (stripped as TUI noise), so
  // the PTY heuristic settles to idle while a message of ours is still sitting
  // in its queue. App.vue raises this after a verified delivery and releases
  // it when the recipient's transcript shows the envelope as a user record
  // (or, for readers without user text, at the next turn end).

  it('shows RUNNING while a delivered message is still unconsumed', async () => {
    const { result, mock, scope } = await spawnedFake()
    await chunkThenWait(mock, 0, 100)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(result.displayStatus.value).toBe('idle')
    result.markDeliveredPending()
    expect(result.displayStatus.value).toBe('running')
    scope.stop()
  })

  it('outranks an authoritative turn end — claude ends the turn BEFORE dequeuing', async () => {
    const { result, mock, scope } = await spawnedFake()
    await chunkThenWait(mock, 0, 100)
    result.markDeliveredPending()
    result.markTurnComplete()
    expect(result.displayStatus.value).toBe('running')
    scope.stop()
  })

  it('returns to the PTY verdict once every delivery is consumed', async () => {
    const { result, mock, scope } = await spawnedFake()
    await chunkThenWait(mock, 0, 100)
    result.markTurnComplete()
    expect(result.displayStatus.value).toBe('idle')
    result.markDeliveredPending()
    result.markDeliveredPending()
    expect(result.displayStatus.value).toBe('running')
    result.clearDeliveredPending()
    expect(result.displayStatus.value).toBe('running')
    result.clearDeliveredPending()
    expect(result.displayStatus.value).toBe('idle')
    scope.stop()
  })

  it('clears every outstanding delivery at once when asked to', async () => {
    const { result, mock, scope } = await spawnedFake()
    await chunkThenWait(mock, 0, 100)
    result.markTurnComplete()
    result.markDeliveredPending()
    result.markDeliveredPending()
    result.clearDeliveredPending(true)
    expect(result.displayStatus.value).toBe('idle')
    scope.stop()
  })

  it('blows the fuse after 120s so a lost consume signal cannot park the badge', async () => {
    const { result, mock, scope } = await spawnedFake()
    await chunkThenWait(mock, 0, 100)
    result.markTurnComplete()
    result.markDeliveredPending()
    await vi.advanceTimersByTimeAsync(119_000)
    expect(result.displayStatus.value).toBe('running')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(result.displayStatus.value).toBe('idle')
    scope.stop()
  })

  // ── BACKGROUND TASKS: work the CLI keeps running past its turn end ──────
  // A backgrounded shell or an async subagent outlives the turn that started
  // it, and that turn still ends with a normal turn_complete. App.vue feeds
  // the transcript's start/end records in through noteBackgroundTasks.

  it('shows RUNNING while a background task outlives the turn end', async () => {
    const { result, mock, scope } = await spawnedFake()
    await chunkThenWait(mock, 0, 100)
    result.noteBackgroundTasks('start', ['bry177hz1'])
    result.markTurnComplete()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(result.displayStatus.value).toBe('running')
    result.noteBackgroundTasks('end', ['bry177hz1'])
    expect(result.displayStatus.value).toBe('idle')
    scope.stop()
  })

  it('holds RUNNING until every background task has ended', async () => {
    const { result, mock, scope } = await spawnedFake()
    await chunkThenWait(mock, 0, 100)
    result.markTurnComplete()
    result.noteBackgroundTasks('start', ['b1'])
    result.noteBackgroundTasks('start', ['a2'])
    result.noteBackgroundTasks('end', ['b1'])
    expect(result.displayStatus.value).toBe('running')
    result.noteBackgroundTasks('end', ['a2'])
    expect(result.displayStatus.value).toBe('idle')
    scope.stop()
  })

  it('ignores a start logged after its own end (a fast command)', async () => {
    // Claude writes a quick background command's completion notification
    // before the tool_result that launched it.
    const { result, mock, scope } = await spawnedFake()
    await chunkThenWait(mock, 0, 100)
    result.markTurnComplete()
    result.noteBackgroundTasks('end', ['blu0v382j'])
    result.noteBackgroundTasks('start', ['blu0v382j'])
    expect(result.displayStatus.value).toBe('idle')
    scope.stop()
  })

  it('stops holding RUNNING once a background task passes the fuse without an end', async () => {
    // A dev server killed with `kill <pid>` (or left running) writes no end record.
    const { result, mock, scope } = await spawnedFake()
    await chunkThenWait(mock, 0, 100)
    result.noteBackgroundTasks('start', ['bdev'])
    result.markTurnComplete()
    await vi.advanceTimersByTimeAsync(29 * 60_000)
    expect(result.displayStatus.value).toBe('running')
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(result.displayStatus.value).toBe('idle')
    scope.stop()
  })

  it('restarts the fuse on activity, so a watch the agent keeps checking holds RUNNING', async () => {
    // A release watcher polled for 38 minutes while the agent woke every few
    // minutes to report on it; a fuse counted from the task's start dropped the
    // badge to IDLE at 30 with the work plainly still running.
    const { result, mock, scope } = await spawnedFake()
    await chunkThenWait(mock, 0, 100)
    result.noteBackgroundTasks('start', ['bwatch'])
    result.markTurnComplete()
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    result.markTurnComplete()
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    expect(result.displayStatus.value).toBe('running')
    await vi.advanceTimersByTimeAsync(11 * 60_000)
    expect(result.displayStatus.value).toBe('idle')
    scope.stop()
  })

  it('reports live background tasks to the pipeline on the badge fuse', async () => {
    // The pipeline reads this instead of the badge: AWAITING outranks RUNNING
    // on the badge, but a slot parked on a prompt still has its work running.
    const { result, mock, scope } = await spawnedFake()
    await chunkThenWait(mock, 0, 100)
    expect(result.hasLiveBackgroundTasks()).toBe(false)
    result.noteBackgroundTasks('start', ['ae01b1c4'])
    result.markTurnComplete()
    expect(result.hasLiveBackgroundTasks()).toBe(true)
    await vi.advanceTimersByTimeAsync(31 * 60_000)
    expect(result.hasLiveBackgroundTasks()).toBe(false)
    result.noteBackgroundTasks('start', ['b2'])
    result.noteBackgroundTasks('end', ['b2'])
    expect(result.hasLiveBackgroundTasks()).toBe(false)
    scope.stop()
  })

  it('still lets AWAITING outrank a running background task', async () => {
    const { result, mock, scope } = await spawnedFake()
    await chunkThenWait(mock, 0, 100)
    result.noteBackgroundTasks('start', ['b1'])
    result.markQuestion()
    expect(result.displayStatus.value).toBe('awaiting')
    scope.stop()
  })

  it('does not let a stale delivery linger past the fuse once a new one lands', async () => {
    // Left alone, a count that survived the fuse would need TWO consume
    // signals to drain after the next delivery, holding RUNNING for a message
    // that was consumed long ago.
    const { result, mock, scope } = await spawnedFake()
    await chunkThenWait(mock, 0, 100)
    result.markTurnComplete()
    result.markDeliveredPending()
    await vi.advanceTimersByTimeAsync(130_000)
    expect(result.displayStatus.value).toBe('idle')
    result.markDeliveredPending()
    expect(result.displayStatus.value).toBe('running')
    result.clearDeliveredPending()
    expect(result.displayStatus.value).toBe('idle')
    scope.stop()
  })

  it('yields to AWAITING — a parked pane cannot consume anything', async () => {
    const { result, mock, scope } = await spawnedFake()
    await chunkThenWait(mock, 0, 100)
    result.markDeliveredPending()
    result.markNeedsInput()
    expect(result.displayStatus.value).toBe('awaiting')
    scope.stop()
  })

  it('does not carry a pending delivery across a respawn', async () => {
    const { result, mock, scope } = await spawnedFake()
    await chunkThenWait(mock, 0, 100)
    result.markTurnComplete()
    result.markDeliveredPending()
    expect(result.displayStatus.value).toBe('running')
    result.status.value = 'exited'
    mock.setResponse('terminal.create', { terminal_session_id: 'sess-2', pid: 43 })
    const respawning = result.spawn({ command: 'bash', cwd: '/tmp', skipReattach: true })
    await vi.advanceTimersByTimeAsync(200)
    await respawning
    await chunkThenWait(mock, 1, 100)
    result.markTurnComplete()
    expect(result.displayStatus.value).toBe('idle')
    scope.stop()
  })

  it('reports the permission kind when both waits are raised at once', async () => {
    // The badge is the same either way, but awaitingKind feeds the messaging
    // gate: a permission prompt blocks a tool call the agent already committed
    // to, so a pane holding one must stay out of dispatch even if a question
    // is also outstanding. The more restrictive kind wins.
    const { result, mock, scope } = await spawnedFake()
    await chunkThenWait(mock, 0, 100)
    result.markQuestion()
    result.markNeedsInput()
    expect(result.displayStatus.value).toBe('awaiting')
    expect(result.awaitingKind.value).toBe('permission')
    scope.stop()
  })

  it('classifies a painted option box as permission, whoever put it there', async () => {
    // The split is about whether a widget is on screen eating keystrokes, not
    // about who asked. Claude's AskUserQuestion box reaches markNeedsInput via
    // the screen watcher, and belongs on the permission side: injecting a
    // message into a select widget is answered-by-accident either way.
    //
    // Regression guard for the merge: before the screen watcher existed these
    // panes showed 'idle' and took dispatched work, which silently fed the
    // message to the box as its answer.
    const { result, mock, scope } = await spawnedFake()
    await chunkThenWait(mock, 0, 100)
    result.markNeedsInput()
    expect(result.displayStatus.value).toBe('awaiting')
    expect(result.awaitingKind.value).toBe('permission')
    scope.stop()
  })

  it('classifies a turn that merely ended on a question as answerable', async () => {
    // The other side of the same rule: no widget is painted, the pane is back
    // at its ordinary prompt, so a dispatched message starts a turn normally.
    const { result, mock, scope } = await spawnedFake()
    await chunkThenWait(mock, 0, 100)
    result.markQuestion()
    expect(result.displayStatus.value).toBe('awaiting')
    expect(result.awaitingKind.value).toBe('question')
    scope.stop()
  })

  it('reports no kind at all when the pane is not parked', async () => {
    const { result, mock, scope } = await spawnedFake()
    for (let i = 0; i < 5; i++) await chunkThenWait(mock, i, 1_500)
    expect(result.displayStatus.value).toBe('running')
    expect(result.awaitingKind.value).toBeNull()
    scope.stop()
  })

  it('leaves the question wait once real output arrives after the settle window', async () => {
    const { result, mock, scope } = await spawnedFake()
    await chunkThenWait(mock, 0, 100)
    result.markQuestion()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(result.displayStatus.value).toBe('awaiting')
    await chunkThenWait(mock, 1, 100)
    expect(result.displayStatus.value).not.toBe('awaiting')
    expect(result.awaitingKind.value).toBeNull()
    scope.stop()
  })

  it('clears the question wait on clearQuestion() when the answer comes back', async () => {
    const { result, mock, scope } = await spawnedFake()
    await chunkThenWait(mock, 0, 100)
    result.markQuestion()
    expect(result.displayStatus.value).toBe('awaiting')
    result.clearQuestion()
    expect(result.displayStatus.value).not.toBe('awaiting')
    scope.stop()
  })

  it('does not carry the question wait across a respawn', async () => {
    const { result, mock, scope } = await spawnedFake()
    await chunkThenWait(mock, 0, 100)
    result.markQuestion()
    expect(result.displayStatus.value).toBe('awaiting')

    result.status.value = 'exited'
    mock.setResponse('terminal.create', { terminal_session_id: 'sess-2', pid: 43 })
    const respawning = result.spawn({ command: 'bash', cwd: '/tmp', skipReattach: true })
    await vi.advanceTimersByTimeAsync(200)
    await respawning
    await chunkThenWait(mock, 1, 100)

    expect(result.displayStatus.value).not.toBe('awaiting')
    scope.stop()
  })

  it('keeps a dead pane reporting its exit rather than a question', async () => {
    // exited/error short-circuit above every parked state — a pane that is
    // gone cannot be waiting for an answer.
    const { result, mock, scope } = await spawnedFake()
    await chunkThenWait(mock, 0, 100)
    result.markQuestion()
    result.status.value = 'exited'
    expect(result.displayStatus.value).toBe('exited')
    scope.stop()
  })

  it('sets displayStatus to stopped when interrupt() or ESC is triggered, and clears on new input', async () => {
    const { result, mock, scope } = await spawned()
    expect(result.status.value).toBe('running')
    expect(result.displayStatus.value).toBe('starting')

    // Trigger interrupt
    await result.interrupt()
    expect(result.isStopped.value).toBe(true)
    expect(result.displayStatus.value).toBe('stopped')

    // User typing / reset clears stopped status
    result.isStopped.value = false
    expect(result.isStopped.value).toBe(false)

    scope.stop()
  })

  it('tracks STARTING from before create, cancels once, and ignores a late create result', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const mock = createMockBackend()
    let resolveCreate!: (value: any) => void
    let resolveCancel!: (value: any) => void
    const createReply = new Promise<any>((resolve) => { resolveCreate = resolve })
    const cancelReply = new Promise<any>((resolve) => { resolveCancel = resolve })
    const send = vi.fn((type: string, _payload?: Record<string, unknown>) => {
      if (type === 'terminal.create') return createReply
      if (type === 'terminal.create.cancel') return cancelReply
      return Promise.resolve({ ok: true, payload: null, error: null })
    })
    ;(mock.backend as any).send = send
    const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend))
    result.mount(document.createElement('div'))

    const spawnPromise = result.spawn({ command: 'bash', cwd: '/tmp', skipReattach: true })
    await Promise.resolve()
    const createCall = send.mock.calls.find(([type]) => type === 'terminal.create')
    expect(createCall).toBeTruthy()
    const generation = createCall![1]!.create_generation
    expect(typeof generation).toBe('string')
    expect(generation).not.toBe('')
    expect(result.startingStartedAt.value).toBe(1_000)
    expect(result.startingAgeMs.value).toBe(0)

    await vi.advanceTimersByTimeAsync(30_000)
    expect(result.startingAgeMs.value).toBe(30_000)

    let rollbackFinished = false
    const firstCancel = result.cancelPendingCreate().then(() => { rollbackFinished = true })
    const secondCancel = result.cancelPendingCreate()
    await Promise.resolve()
    expect(rollbackFinished).toBe(false)
    expect(send.mock.calls.filter(([type]) => type === 'terminal.create.cancel')).toEqual([
      ['terminal.create.cancel', { pane_id: 'pane-1', create_generation: generation }],
    ])

    resolveCancel({ ok: true, payload: { cancelled: true }, error: null })
    await Promise.all([firstCancel, secondCancel])
    expect(rollbackFinished).toBe(true)

    resolveCreate({
      ok: true,
      payload: { terminal_session_id: 'late-session', pid: 42 },
      error: null,
    })
    await spawnPromise
    expect(result.sessionId.value).toBe('')
    expect(result.status.value).toBe('starting')
    expect(send.mock.calls.filter(([type]) => type === 'terminal.create.cancel')).toHaveLength(1)
    scope.stop()
  })

  it('uses a new create generation after a prior terminal exits', async () => {
    const mock = createMockBackend()
    mock.setResponse('terminal.create', { terminal_session_id: 'sess-1', pid: 42 })
    const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend))
    result.mount(document.createElement('div'))
    await result.spawn({ command: 'bash', cwd: '/tmp', skipReattach: true })
    const firstGeneration = mock.sent.find((call) => call.type === 'terminal.create')?.payload.create_generation

    mock.emit('terminal.exit', { terminal_session_id: 'sess-1', exit_code: 0 })
    await result.spawn({ command: 'bash', cwd: '/tmp', skipReattach: true })
    const generations = mock.sent
      .filter((call) => call.type === 'terminal.create')
      .map((call) => call.payload.create_generation)
    expect(generations).toHaveLength(2)
    expect(generations[1]).not.toBe(firstGeneration)
    scope.stop()
  })

  it('best-effort cancels the matching generation when create fails', async () => {
    const mock = createMockBackend()
    const send = vi.fn((type: string, payload: Record<string, unknown>) => {
      if (type === 'terminal.create') return Promise.reject(new Error('request terminal.create timeout'))
      return Promise.resolve({ ok: true, payload: null, error: null })
    })
    ;(mock.backend as any).send = send
    const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend))
    result.mount(document.createElement('div'))

    await result.spawn({ command: 'bash', cwd: '/tmp', skipReattach: true })
    await Promise.resolve()
    const createGeneration = send.mock.calls.find(([type]) => type === 'terminal.create')![1].create_generation
    expect(send).toHaveBeenCalledWith('terminal.create.cancel', {
      pane_id: 'pane-1',
      create_generation: createGeneration,
    })
    expect(result.status.value).toBe('error')
    scope.stop()
  })

  it('rejects an explicit stale-create cancellation when backend rollback fails', async () => {
    const mock = createMockBackend()
    let resolveCreate!: (value: unknown) => void
    const send = vi.fn((type: string) => {
      if (type === 'terminal.create') return new Promise((resolve) => { resolveCreate = resolve })
      if (type === 'terminal.create.cancel') return Promise.reject(new Error('ws not open'))
      return Promise.resolve({ ok: true, payload: null, error: null })
    })
    ;(mock.backend as any).send = send
    const { result, scope } = withScope(() => useTerminal('pane-1', mock.backend))
    result.mount(document.createElement('div'))

    const spawnPromise = result.spawn({ command: 'bash', cwd: '/tmp', skipReattach: true })
    await Promise.resolve()
    await expect(result.cancelPendingCreate()).rejects.toThrow('terminal create cancellation failed')

    resolveCreate({ ok: true, payload: { terminal_session_id: 'late-session', pid: 42 }, error: null })
    await spawnPromise
    expect(result.sessionId.value).toBe('')
    scope.stop()
  })
})

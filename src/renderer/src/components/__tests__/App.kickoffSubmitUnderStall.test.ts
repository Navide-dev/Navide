// @vitest-environment happy-dom
// 0.2.37 Linux VM (70e669130), run 20261103-183841, pane 7240a049: the kickoff
// was pasted at 10:38:52 and logged at 10:39:16 as "not injected — echo
// placeholder, submit none, 3 Enter(s)", then "reached the input box but never
// submitted", and the run failed. Claude Code had taken it: it answered, ran
// its stop hooks for 34s ("Manifesting… (running Stop hooks… 1/2 · 34s)") and
// showed "Worked for 38s". The VM was starved of CPU; the backend's event loop
// stalled 4–6s at a time, and the screen and the turn events, which both reach
// the window through it, came late.
//
// injectText is lifted out of App.vue and run on a fake clock against a pane
// whose screen stays frozen on the collapsed paste after every Enter.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { transformWithEsbuild } from 'vite'
import * as injectEcho from '../../lib/injectEcho'
import * as submitTurnConfirm from '../../lib/submitTurnConfirm'
import * as submitStall from '../../lib/submitStall'
import { awaitTurnAfterFailure, busyLines, newBusyLine, SUBMIT_STALL_GRACE_MS } from '../../lib/submitStall'

const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function functionSource(name: string): string {
  const start = appSource.search(new RegExp(`(?:async )?function ${name}\\(`))
  expect(start, `${name} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf('\n}\n', start)
  return appSource.slice(start, end + 2)
}

const KNOWN_GLOBALS = new Set(['Promise', 'Date', 'Array', 'Map', 'Set', 'Object', 'String', 'Number', 'JSON', 'Error', 'console', 'Math', 'undefined', 'RegExp'])

async function loadInjectText(scope: Record<string, unknown>) {
  const { code } = await transformWithEsbuild(`${functionSource('injectText')}\nreturn { injectText }`, 'AppInjectStall.ts', { loader: 'ts' })
  const proxy = new Proxy(scope, {
    has: (target, key) => typeof key === 'string' && (key in target || !KNOWN_GLOBALS.has(key)),
    get: (target, key) => (key === Symbol.unscopables ? undefined : key in target ? target[key as string] : vi.fn()),
  })
  return new Function('scope', `with (scope) { return (function () {${code}})() }`)(proxy) as {
    injectText: (...args: unknown[]) => Promise<boolean>
  }
}

const KICKOFF = '[→ KICKOFF:STAGE-L2]\n' + 'work rule line\n'.repeat(56) + 'NAVIDE-WEBHOOK-DATA-7240a049>>>'
const WIDTH = 50
const row = (text: string) => `│ ${text.padEnd(WIDTH - 4)} │`
const top = `╭${'─'.repeat(WIDTH - 2)}╮`
const bottom = `╰${'─'.repeat(WIDTH - 2)}╯`

/** Claude Code with the kickoff collapsed in its box; `above` is what the
 *  transcript shows over it. */
function screenWith(above: string[]): string {
  return [...above, top, row('> [Pasted text #1 +58 lines]'), bottom, '  ⏵⏵ bypass permissions on'].join('\n')
}

interface Event { at: number; apply: (s: Stall) => void }

interface Stall {
  screen: string
  turnStartedAt: Map<string, number>
  turnCompleteAt: Map<string, number>
  lastActiveAt: Map<string, number>
}

const T0 = Date.UTC(2026, 10, 3, 10, 38, 52)

async function run(events: Event[], opts: { aboveBefore?: string[] } = {}) {
  const stall: Stall = {
    screen: screenWith(opts.aboveBefore ?? []),
    turnStartedAt: new Map(),
    turnCompleteAt: new Map(),
    // The role's turn ended before the kickoff.
    lastActiveAt: new Map([['p1', T0 - 60_000]]),
  }
  stall.turnCompleteAt.set('p1', T0 - 30_000)
  let bytes = 1_000
  let enters = 0
  const pending = [...events].sort((a, b) => a.at - b.at)
  const sleep = async (ms: number) => {
    vi.setSystemTime(Date.now() + ms)
    while (pending.length && pending[0].at <= Date.now() - T0) pending.shift()!.apply(stall)
  }
  const backend = {
    send: vi.fn(async (_type: string, payload: { data?: string }) => {
      if (payload.data === '\r') enters++
      else if (payload.data) bytes += 30 // the collapsed summary, drawn once
      return { ok: true, payload: { ok: true, pending: 0 } }
    }),
  }
  const ref = {
    sessionId: 's1',
    displayStatus: 'running',
    cleanBuffer: '',
    readScreenTail: (n: number) => stall.screen.split('\n').slice(-n).join('\n'),
    readVisibleScreen: () => stall.screen,
    terminalSize: () => ({ cols: WIDTH, rows: 40 }),
    isBracketedPasteActive: () => true,
    awaitingKind: null,
  }
  const { injectText } = await loadInjectText({
    ...injectEcho, ...submitTurnConfirm, ...submitStall,
    backend,
    paneRefs: { p1: ref },
    panes: { value: [{ id: 'p1', agentKey: 'claude' }] },
    paneCleanBytes: () => bytes,
    TERMINAL_AGENT_KEY: 'terminal',
    agentUsesBracketedPaste: () => true,
    paneMultilineRefusal: () => false,
    injectionChunks: (body: string) => [body],
    flattenForInjection: (t: string) => t,
    inputBlocks: { get: () => null, onUnblocked: () => {} },
    needsInputWait: () => false,
    // The paste echoed as its summary (App.kickoffSubmitEvidence.test.ts).
    awaitEcho: async () => ({ outcome: 'ready', echo: 'placeholder' }),
    echoTimeoutFor: () => 8_000,
    recordDiagnostic: () => {},
    sleep,
    paneTurnStartedAt: stall.turnStartedAt,
    paneTurnCompleteAt: stall.turnCompleteAt,
    paneLastActiveAt: stall.lastActiveAt,
  })
  const evidence: { echo?: unknown; submit?: unknown; enters?: number; late?: string; leftInComposer?: boolean } = {}
  const ok = await injectText('s1', KICKOFF, 'kickoff:stage-L2', true, undefined, evidence)
  return { ok, evidence, enters, elapsed: Date.now() - T0 }
}

describe('injectText under a stalled backend', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
  })
  afterEach(() => vi.useRealTimers())

  it('a turn event 12 s after the last Enter, on a frozen screen, is a submit', async () => {
    const r = await run([{
      at: 20_000,
      apply: (s) => {
        s.turnStartedAt.set('p1', T0 + 20_000)
        s.lastActiveAt.set('p1', T0 + 20_000)
      },
    }])
    expect(r.ok).toBe(true)
    expect(r.evidence.submit).toBe('turn')
    expect(r.evidence.late).toBe('turn')
    expect(r.enters).toBe(3)
  })

  it('agent activity alone, late, counts too', async () => {
    const r = await run([{ at: 25_000, apply: (s) => { s.lastActiveAt.set('p1', T0 + 25_000) } }])
    expect(r.ok).toBe(true)
    expect(r.evidence.late).toBe('turn')
  })

  it('the stop-hook spinner showing up late, with no event, is a submit', async () => {
    const r = await run([{
      at: 30_000,
      apply: (s) => { s.screen = screenWith(['✻ Manifesting… (running Stop hooks… 1/2 · 34s)']) },
    }])
    expect(r.ok).toBe(true)
    expect(r.evidence.late).toBe('busy')
    expect(r.evidence.submit).toBe('unconfirmed')
  })

  it('a screen that catches up and shows the box empty is a submit', async () => {
    const r = await run([{
      at: 15_000,
      apply: (s) => { s.screen = [top, row('>'), bottom, '  ⏵⏵ bypass permissions on'].join('\n') },
    }])
    expect(r.ok).toBe(true)
    expect(r.evidence.late).toBe('screen')
  })

  it('nothing at all — no turn event, no busy screen — is still never submitted', async () => {
    const r = await run([])
    expect(r.ok).toBe(false)
    expect(r.evidence.leftInComposer).toBe(true)
    expect(r.evidence.late).toBeUndefined()
    expect(r.enters).toBe(3)
    expect(r.elapsed).toBeGreaterThanOrEqual(SUBMIT_STALL_GRACE_MS)
  })

  it('the previous turn\'s "Worked for" line left on screen is not a submit', async () => {
    const r = await run([], { aboveBefore: ['✻ Worked for 12s'] })
    expect(r.ok).toBe(false)
  })

  it('an event after the grace window does not save it', async () => {
    const r = await run([{ at: 7_500 + SUBMIT_STALL_GRACE_MS + 5_000, apply: (s) => { s.turnStartedAt.set('p1', Date.now()) } }])
    expect(r.ok).toBe(false)
  })
})

describe('busy lines', () => {
  it.each([
    '✻ Manifesting… (running Stop hooks… 1/2 · 34s)',
    '✢ Thinking… (12s · ↓ 300 tokens · esc to interrupt)',
    '✻ Worked for 38s',
    '✻ Churned for 1m 3s',
    '• Working (5s • esc to interrupt)',
  ])('%s', (line) => {
    expect(busyLines(`some output\n${line}\n${top}`)).toHaveLength(1)
  })

  it('not ordinary transcript text', () => {
    expect(busyLines('I worked for 3 hours on it\n> [Pasted text #1 +58 lines]\nRunning tests… done')).toEqual([])
  })

  it('a line already on screen before the Enter is not new', () => {
    expect(newBusyLine(['✻ Worked for 12s'], '✻ Worked for 12s')).toBe(false)
    expect(newBusyLine(['✻ Worked for 12s'], '✻ Worked for 38s')).toBe(true)
  })
})

describe('a kickoff failed while the agent works', () => {
  it('a turn after the verdict is reported', async () => {
    let t = 0
    let started = false
    const seen = await awaitTurnAfterFailure({
      turnSeen: () => started,
      alive: () => true,
      sleep: async (ms) => { t += ms; if (t >= 20_000) started = true },
      now: () => t,
    })
    expect(seen).toBe(true)
  })

  it('no turn within the window is not', async () => {
    let t = 0
    expect(await awaitTurnAfterFailure({ turnSeen: () => false, alive: () => true, sleep: async (ms) => { t += ms }, now: () => t })).toBe(false)
  })

  it('both kickoff sites watch for it once they call the kickoff never submitted', () => {
    const held = appSource.match(/never submitted — not resending`\)\n\s*watchKickoffAfterFailure\(pane\.id, kickoffStartedAt, tag\)/g) ?? []
    expect(held).toHaveLength(2)
    expect(functionSource('watchKickoffAfterFailure')).toContain('run/agent mismatch')
  })

  it('the evidence line says when a submit was seen late', () => {
    expect(functionSource('logInjectEvidence')).toContain('taken late (')
  })
})

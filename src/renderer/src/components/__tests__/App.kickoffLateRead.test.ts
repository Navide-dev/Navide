// @vitest-environment happy-dom
// 0.2.39 Windows VM (314c8c28d), `load 12`, run 20261109-055110, pane 9eae1537:
// with every core busy the webhook-started kickoff (2472 chars) was typed at
// 05:51:17 and logged three times "not injected — echo none" about 10 s apart.
// The CLI had not read any of it yet. Each give-up typed 172 Ctrl-U to clear
// the box (82 columns), and those queued unread behind the paste too. When the
// CLI caught up it read the pastes and all 516 Ctrl-U as one paste: "Removed
// 516 invisible characters · review and press Enter to send", with two
// collapsed copies and a third inline in the box. The fourth attempt saw that
// summary ("echo placeholder"), its three Enters did not submit it, and the
// run failed with the kickoff "waiting in the input box".
//
// injectText is lifted out of App.vue and run on a fake clock against a pane
// whose CLI reads its input 60 s after it was typed, painting a little now and
// then before that (as the VM pane did between attempts 2 and 3).
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { transformWithEsbuild } from 'vite'
import * as injectEcho from '../../lib/injectEcho'
import * as submitTurnConfirm from '../../lib/submitTurnConfirm'
import * as submitStall from '../../lib/submitStall'
import { awaitEcho } from '../../lib/ptyInputBlock'
import { composerClearKeys, KICKOFF_ECHO_WAIT_MS } from '../../lib/cliCoordination'

const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function functionSource(name: string): string {
  const start = appSource.search(new RegExp(`(?:async )?function ${name}\\(`))
  expect(start, `${name} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf('\n}\n', start)
  return appSource.slice(start, end + 2)
}

const KNOWN_GLOBALS = new Set(['Promise', 'Date', 'Array', 'Map', 'Set', 'Object', 'String', 'Number', 'JSON', 'Error', 'console', 'Math', 'undefined', 'RegExp'])

async function loadInjectText(scope: Record<string, unknown>) {
  const { code } = await transformWithEsbuild(`${functionSource('injectText')}\nreturn { injectText }`, 'AppKickoffLateRead.ts', { loader: 'ts' })
  const proxy = new Proxy(scope, {
    has: (target, key) => typeof key === 'string' && (key in target || !KNOWN_GLOBALS.has(key)),
    get: (target, key) => (key === Symbol.unscopables ? undefined : key in target ? target[key as string] : vi.fn()),
  })
  return new Function('scope', `with (scope) { return (function () {${code}})() }`)(proxy) as {
    injectText: (...args: unknown[]) => Promise<boolean>
  }
}

const KICKOFF = '[→ KICKOFF:STAGE-L1]\n' + 'work rule line\n'.repeat(58) + 'NAVIDE-WEBHOOK-DATA-9eae1537>>>'
const WIDTH = 82
const row = (text: string) => `│ ${text.padEnd(WIDTH - 4)} │`
const box = (inside: string) => [`╭${'─'.repeat(WIDTH - 2)}╮`, row(inside), `╰${'─'.repeat(WIDTH - 2)}╯`, '  ⏸ manual mode on'].join('\n')
const EMPTY = box('>')
const HELD = box('> [Pasted text #1 +60 lines]')

const T0 = Date.UTC(2026, 10, 8, 21, 51, 17)
const READ_AT_MS = 60_000

async function run(echoWaitMs: number | undefined) {
  let screen = EMPTY
  let cleanBuffer = ''
  let bytes = 1_000
  const writes: string[] = []
  // Bytes the CLI has not read yet, in the order they were typed.
  const queued: string[] = []
  const turnStartedAt = new Map<string, number>()
  const lastActiveAt = new Map<string, number>([['p1', T0 - 60_000]])
  const turnCompleteAt = new Map<string, number>([['p1', T0 - 30_000]])
  const cliReads = () => {
    for (const data of queued.splice(0)) {
      if (data === '\r') {
        if (screen === HELD) {
          screen = EMPTY
          turnStartedAt.set('p1', Date.now())
          lastActiveAt.set('p1', Date.now())
        }
      } else if (!data.startsWith('\x15')) {
        screen = HELD
        cleanBuffer += '[Pasted text #1 +60 lines]'
        bytes += 30
      }
    }
  }
  const sleep = async (ms: number) => {
    const before = Date.now() - T0
    vi.setSystemTime(Date.now() + ms)
    const at = Date.now() - T0
    // A repaint every 10 s while starved: output, but not our echo.
    if (Math.floor(at / 10_000) > Math.floor(before / 10_000) && at < READ_AT_MS) bytes += 5
    if (at >= READ_AT_MS) cliReads()
  }
  const backend = {
    send: vi.fn(async (_type: string, payload: { data?: string }) => {
      if (payload.data) {
        writes.push(payload.data)
        queued.push(payload.data)
        if (Date.now() - T0 >= READ_AT_MS) cliReads()
      }
      return { ok: true, payload: { ok: true, pending: 0 } }
    }),
  }
  const ref = {
    sessionId: 's1',
    displayStatus: 'idle',
    get cleanBuffer() { return cleanBuffer },
    readScreenTail: (n: number) => screen.split('\n').slice(-n).join('\n'),
    readVisibleScreen: () => screen,
    terminalSize: () => ({ cols: WIDTH, rows: 40 }),
    isBracketedPasteActive: () => true,
    awaitingKind: null,
  }
  const { injectText } = await loadInjectText({
    ...injectEcho, ...submitTurnConfirm, ...submitStall,
    awaitEcho,
    composerClearKeys,
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
    injectFailedMessage: () => 'never echoed',
    recordDiagnostic: () => {},
    sleep,
    paneTurnStartedAt: turnStartedAt,
    paneTurnCompleteAt: turnCompleteAt,
    paneLastActiveAt: lastActiveAt,
  })
  const evidence: { echo?: unknown; submit?: unknown; enters?: number } = {}
  const ok = await injectText(
    's1', KICKOFF, 'kickoff:stage-L1', true, undefined, evidence, undefined, () => true, false, echoWaitMs,
  )
  return { ok, evidence, writes, elapsed: Date.now() - T0 }
}

describe('a pipeline kickoff on a CLI that reads its input a minute late', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
  })
  afterEach(() => vi.useRealTimers())

  it('without the kickoff echo wait it gives up first and types Ctrl-U behind the unread paste — the VM failure', async () => {
    const r = await run(undefined)
    expect(r.ok).toBe(false)
    expect(r.elapsed).toBeLessThan(READ_AT_MS)
    expect(r.writes[0]).toBe(KICKOFF)
    expect(r.writes.slice(1)).toEqual(composerClearKeys(KICKOFF, WIDTH))
  })

  it('waits for the echo, types no Ctrl-U, and submits the one copy', async () => {
    const r = await run(KICKOFF_ECHO_WAIT_MS)
    expect(r.ok).toBe(true)
    expect(r.evidence.echo).toBe('placeholder')
    expect(r.writes.filter((w) => w === KICKOFF)).toHaveLength(1)
    expect(r.writes.some((w) => w.includes('\x15'))).toBe(false)
    expect(r.evidence.submit).not.toBeNull()
    expect(r.elapsed).toBeGreaterThanOrEqual(READ_AT_MS)
  })

  it('both pipeline kickoff sites pass the echo wait', () => {
    expect(appSource.match(/false, KICKOFF_ECHO_WAIT_MS,?\n?\s*\)/g) ?? []).toHaveLength(2)
    expect(functionSource('injectPane')).toContain('prefill, echoWaitMs,')
  })
})

describe('awaitEcho with waitMs', () => {
  function deps(echoAt: number, over: Partial<Parameters<typeof awaitEcho<'tail'>>[0]> = {}) {
    let clock = 0
    let output = 0
    return {
      echoed: () => (clock >= echoAt ? 'tail' as const : null),
      outputBytes: () => output,
      aborted: () => false,
      onHold: () => {},
      sleep: async (ms: number) => { clock += ms; if (clock % 5_000 === 0) output += 3 },
      now: () => clock,
      roundMs: 6_000,
      maxSilentRounds: 2,
      ...over,
    }
  }

  it('waits through painting and silent rounds until the echo shows', async () => {
    await expect(awaitEcho(deps(70_000, { waitMs: 120_000 }))).resolves.toEqual({ outcome: 'ready', echo: 'tail' })
  })

  it('answers as its cap says once waitMs has passed', async () => {
    const d = deps(Number.POSITIVE_INFINITY, { waitMs: 30_000 })
    const result = await awaitEcho(d)
    expect(['silent', 'resend']).toContain(result.outcome)
    expect(d.now()).toBeGreaterThanOrEqual(30_000)
    expect(d.now()).toBeLessThan(30_000 + 6_000 + 200)
  })

  it('without waitMs a painting round still ends a capped watch at once', async () => {
    await expect(awaitEcho(deps(70_000))).resolves.toEqual({ outcome: 'resend' })
  })
})

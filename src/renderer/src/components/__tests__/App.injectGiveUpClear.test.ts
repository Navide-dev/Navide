// @vitest-environment happy-dom
// 0.2.37 Windows VM (8bb9ebabe, kid2): a kickoff whose echo was never seen
// gave up with a single Ctrl-U, which clears one row of Claude Code's input
// box. Three rows of the multi-row task stayed in the box, and the next Enter
// — or the next typed-in message — would have carried them.
//
// injectText is lifted out of App.vue and run against a pane that never echoes.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { transformWithEsbuild } from 'vite'
import * as injectEcho from '../../lib/injectEcho'
import { composerClearKeys } from '../../lib/cliCoordination'

const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function functionSource(name: string): string {
  const start = appSource.search(new RegExp(`(?:async )?function ${name}\\(`))
  expect(start, `${name} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf('\n}\n', start)
  return appSource.slice(start, end + 2)
}

const KNOWN_GLOBALS = new Set(['Promise', 'Date', 'Array', 'Map', 'Set', 'Object', 'String', 'Number', 'JSON', 'Error', 'console', 'Math', 'undefined', 'RegExp'])

async function loadInjectText(scope: Record<string, unknown>) {
  const { code } = await transformWithEsbuild(`${functionSource('injectText')}\nreturn { injectText }`, 'AppInjectGiveUp.ts', { loader: 'ts' })
  const proxy = new Proxy(scope, {
    has: (target, key) => typeof key === 'string' && (key in target || !KNOWN_GLOBALS.has(key)),
    get: (target, key) => (key === Symbol.unscopables ? undefined : key in target ? target[key as string] : vi.fn()),
  })
  return new Function('scope', `with (scope) { return (function () {${code}})() }`)(proxy) as {
    injectText: (...args: unknown[]) => Promise<boolean>
  }
}

const COLS = 60
const TASK = 'Fix the kickoff bug.\n' + 'A long line of instructions that wraps across the box. '.repeat(4) + '\nReport back when done.'

async function run(task: string) {
  const writes: string[] = []
  const backend = {
    send: vi.fn(async (_type: string, payload: { data?: string }) => {
      if (payload.data !== undefined) writes.push(payload.data)
      return { ok: true, payload: { ok: true, pending: 0 } }
    }),
  }
  const ref = {
    sessionId: 's1',
    displayStatus: 'idle',
    cleanBuffer: '',
    readScreenTail: () => '',
    readVisibleScreen: () => '',
    terminalSize: () => ({ cols: COLS, rows: 40 }),
    isBracketedPasteActive: () => true,
    awaitingKind: null,
  }
  const { injectText } = await loadInjectText({
    ...injectEcho,
    composerClearKeys,
    backend,
    paneRefs: { p1: ref },
    panes: { value: [{ id: 'p1', agentKey: 'claude' }] },
    paneCleanBytes: () => 1_000,
    TERMINAL_AGENT_KEY: 'terminal',
    agentUsesBracketedPaste: () => true,
    paneMultilineRefusal: () => false,
    injectionChunks: (body: string) => [body],
    flattenForInjection: (t: string) => t,
    inputBlocks: { get: () => null, onUnblocked: () => {} },
    needsInputWait: () => false,
    // The echo never shows up: the bytes went out, the check gives up.
    awaitEcho: async () => ({ outcome: 'silent' }),
    injectFailedMessage: () => 'never echoed',
    recordDiagnostic: () => {},
    sleep: async (ms: number) => { vi.setSystemTime(Date.now() + ms) },
    paneTurnStartedAt: new Map(),
    paneTurnCompleteAt: new Map(),
    paneLastActiveAt: new Map(),
  })
  const ok = await injectText('s1', task, 'agent-spawn', true)
  return { ok, writes }
}

describe('injectText giving up after its bytes went out', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.UTC(2026, 10, 4, 13, 0, 0))
  })
  afterEach(() => vi.useRealTimers())

  it('clears the whole multi-row box, not one row, and never presses Enter', async () => {
    const r = await run(TASK)
    expect(r.ok).toBe(false)
    const expected = composerClearKeys(TASK, COLS)
    expect(expected.join('').length).toBeGreaterThan(1)
    // The payload, then every Ctrl-U batch stopBeforeEnter would send.
    expect(r.writes[0]).toBe(TASK)
    expect(r.writes.slice(1)).toEqual(expected)
    expect(r.writes).not.toContain('\r')
  })

  it('splits a long task into batches of at most 32 Ctrl-U', async () => {
    const long = 'row\n'.repeat(40)
    const r = await run(long)
    const clears = r.writes.slice(1)
    expect(clears).toEqual(composerClearKeys(long, COLS))
    expect(clears.length).toBeGreaterThan(1)
    for (const keys of clears) expect(keys.length).toBeLessThanOrEqual(32)
  })
})

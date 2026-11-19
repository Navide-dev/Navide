// @vitest-environment happy-dom
// 0.2.44 Known limitation: an interrupt makes Claude Code put the prompt back
// in its input box, the next message was typed after it, and the Enter
// submitted both as one prompt (pane-to-pane messages too).
//
// injectText is lifted out of App.vue and run against a pane whose box holds
// a restored prompt; the box is cleared before anything is typed.
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { transformWithEsbuild } from 'vite'
import * as injectEcho from '../../lib/injectEcho'
import * as injectChunkSend from '../../lib/injectChunkSend'
import { clearLeftoverPrompt } from '../../lib/claudeComposer'
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
  const { code } = await transformWithEsbuild(`${functionSource('injectText')}\nreturn { injectText }`, 'AppInjectLeftover.ts', { loader: 'ts' })
  const proxy = new Proxy(scope, {
    has: (target, key) => typeof key === 'string' && (key in target || !KNOWN_GLOBALS.has(key)),
    get: (target, key) => (key === Symbol.unscopables ? undefined : key in target ? target[key as string] : vi.fn()),
  })
  return new Function('scope', `with (scope) { return (function () {${code}})() }`)(proxy) as {
    injectText: (...args: unknown[]) => Promise<boolean>
  }
}

const fixture = readFileSync(join(__dirname, '../../lib/__tests__/fixtures/claude-2.1.327-prompt.txt'), 'utf8')
const RESTORED = 'Run the release dry run and report back'
const withBox = (text: string): string => fixture.replace(/^❯.*$/m, `❯ ${text}`)

const COLS = 72
const MESSAGE = '[Navide] from Navide指揮: the CI run is green'

async function run(opts: { agentKey: string; box: string; draft?: string }) {
  const writes: string[] = []
  let screen = withBox(opts.box)
  const backend = {
    send: vi.fn(async (_type: string, payload: { data?: string }) => {
      if (payload.data !== undefined) {
        writes.push(payload.data)
        // Ctrl-U empties the box, as Claude Code does.
        if (/^\x15+$/.test(payload.data)) screen = withBox('')
      }
      return { ok: true, payload: { ok: true, pending: 0 } }
    }),
  }
  const ref = {
    sessionId: 's1',
    displayStatus: 'idle',
    cleanBuffer: '',
    readScreenTail: () => '',
    readVisibleScreen: () => screen,
    draftText: () => opts.draft ?? '',
    terminalSize: () => ({ cols: COLS, rows: 40 }),
    isBracketedPasteActive: () => true,
    awaitingKind: null,
  }
  const recordDiagnostic = vi.fn()
  const { injectText } = await loadInjectText({
    ...injectEcho,
    ...injectChunkSend,
    composerClearKeys,
    clearLeftoverPrompt,
    backend,
    paneRefs: { p1: ref },
    panes: { value: [{ id: 'p1', agentKey: opts.agentKey }] },
    paneScreenAgentKey: (p: { agentKey: string } | undefined) => p?.agentKey,
    paneClearUpdatePrompt: async () => 'none',
    paneCleanBytes: () => 1_000,
    TERMINAL_AGENT_KEY: 'terminal',
    agentUsesBracketedPaste: () => true,
    paneMultilineRefusal: () => false,
    injectionChunks: (body: string) => [body],
    flattenForInjection: (t: string) => t,
    inputBlocks: { get: () => null, onUnblocked: () => {} },
    needsInputWait: () => false,
    // Nothing after the content send matters here: give up right there.
    awaitEcho: async () => ({ outcome: 'silent' }),
    injectFailedMessage: () => 'never echoed',
    recordDiagnostic,
    sleep: async (ms: number) => { vi.setSystemTime(Date.now() + ms) },
    paneTurnStartedAt: new Map(),
    paneTurnCompleteAt: new Map(),
    paneLastActiveAt: new Map(),
  })
  await injectText('s1', MESSAGE, 'agent-msg', true)
  return { writes, recordDiagnostic }
}

describe('injectText into a Claude Code box that already holds text', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.UTC(2026, 10, 19, 19, 0, 0))
  })
  afterEach(() => vi.useRealTimers())

  it('clears a prompt the interrupt put back before typing the message', async () => {
    const r = await run({ agentKey: 'claude', box: RESTORED })
    const clears = composerClearKeys(RESTORED, COLS)
    expect(r.writes.slice(0, clears.length)).toEqual(clears)
    expect(r.writes[clears.length]).toBe(MESSAGE)
    expect(r.recordDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ code: 'inject.cleared-leftover', paneId: 'p1' }))
  })

  it('types straight in when the box is empty', async () => {
    const r = await run({ agentKey: 'claude', box: '' })
    expect(r.writes[0]).toBe(MESSAGE)
  })

  it('never clears a line the person at the keyboard is writing', async () => {
    const r = await run({ agentKey: 'claude', box: RESTORED, draft: RESTORED })
    expect(r.writes[0]).toBe(MESSAGE)
  })

  it('leaves another CLI as it was', async () => {
    const r = await run({ agentKey: 'codex', box: RESTORED })
    expect(r.writes[0]).toBe(MESSAGE)
  })
})

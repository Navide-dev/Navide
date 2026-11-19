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
import { leftoverToast } from '../../lib/leftoverToast'
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
const ENVELOPE = '[Navide MSG] from: Navide指揮 run the release dry run'

const COLS = 72
const MESSAGE = '[Navide] from Navide指揮: the CI run is green'

async function run(opts: { agentKey: string; box: string; draft?: string; injectedAt?: number; writeText?: (t: string) => Promise<void> }) {
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
  const recordDiagnostic = vi.fn()
  const insertText = vi.fn(() => true)
  const toast = vi.fn()
  const leftoverStash = new Map<string, string>()
  const ref = {
    sessionId: 's1',
    displayStatus: 'idle',
    cleanBuffer: '',
    readScreenTail: () => '',
    readVisibleScreen: () => screen,
    draftText: () => opts.draft ?? '',
    lastUserKeyAt: 1,
    insertText,
    terminalSize: () => ({ cols: COLS, rows: 40 }),
    isBracketedPasteActive: () => true,
    awaitingKind: null,
  }
  const { injectText } = await loadInjectText({
    ...injectEcho,
    ...injectChunkSend,
    composerClearKeys,
    clearLeftoverPrompt,
    leftoverToast,
    leftoverStash,
    // Navide typed last when it typed after the person's last key (1).
    paneNavideTypedLast: () => (opts.injectedAt ?? 0) > 1,
    notifyRestore: { toast },
    navigator: { clipboard: { writeText: opts.writeText ?? (async () => {}) } },
    backend,
    paneRefs: { p1: ref },
    panes: { value: [{ id: 'p1', agentKey: opts.agentKey, messagingName: 'worker' }] },
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
  return { writes, recordDiagnostic, toast, insertText, leftoverStash }
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

  it('tells the person, keeps their prompt, and Restore pastes it back without Enter', async () => {
    const r = await run({ agentKey: 'claude', box: RESTORED })
    expect(r.toast).toHaveBeenCalledOnce()
    const [, opts] = r.toast.mock.calls[0] as [string, { duration: number; action: { run: () => void }; secondaryAction: { run: () => void } }]
    expect(opts.duration).toBe(0)
    expect(r.leftoverStash.get('p1')).toBe(RESTORED)
    opts.action.run()
    expect(r.insertText).toHaveBeenCalledWith(RESTORED)
    expect(r.writes).not.toContain('\r')
    expect(r.leftoverStash.has('p1')).toBe(false)
  })

  it('Copy puts the cleared prompt on the clipboard', async () => {
    const writeText = vi.fn(async () => {})
    const r = await run({ agentKey: 'claude', box: RESTORED, writeText })
    const [, opts] = r.toast.mock.calls[0] as [string, { secondaryAction: { run: () => void } }]
    opts.secondaryAction.run()
    expect(writeText).toHaveBeenCalledWith(RESTORED)
  })

  it('clears one of Navide\'s own envelopes without a toast', async () => {
    const r = await run({ agentKey: 'claude', box: ENVELOPE })
    expect(r.writes[0]).toMatch(/^\x15+$/)
    expect(r.writes.indexOf(MESSAGE)).toBeGreaterThan(0)
    expect(r.recordDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ code: 'inject.cleared-leftover' }))
    expect(r.toast).not.toHaveBeenCalled()
    expect(r.leftoverStash.size).toBe(0)
  })

  it('clears a collapsed paste Navide typed after the last key, without a toast', async () => {
    const r = await run({ agentKey: 'claude', box: '[Pasted text #1 +12 lines]', injectedAt: 5 })
    expect(r.writes[0]).toMatch(/^\x15+$/)
    expect(r.toast).not.toHaveBeenCalled()
  })

  it('leaves a collapsed paste of the person\'s own alone', async () => {
    const r = await run({ agentKey: 'claude', box: '[Pasted text #1 +12 lines]' })
    expect(r.writes[0]).toBe(MESSAGE)
    expect(r.toast).not.toHaveBeenCalled()
  })

  it('types straight in when the box is empty', async () => {
    const r = await run({ agentKey: 'claude', box: '' })
    expect(r.writes[0]).toBe(MESSAGE)
  })

  it('never clears a line the person at the keyboard is writing', async () => {
    const r = await run({ agentKey: 'claude', box: RESTORED, draft: RESTORED })
    expect(r.writes[0]).toBe(MESSAGE)
    expect(r.toast).not.toHaveBeenCalled()
  })

  it('leaves another CLI as it was', async () => {
    const r = await run({ agentKey: 'codex', box: RESTORED })
    expect(r.writes[0]).toBe(MESSAGE)
  })
})

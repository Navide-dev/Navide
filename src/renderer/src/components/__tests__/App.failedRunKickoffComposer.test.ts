// @vitest-environment happy-dom
// 0.2.38 Linux VM (78acff197), sibcheck 2/15: the wk slot parked on a CLI
// prompt and failed the run in the same second the mgr slot's kickoff went
// out. stopFailedRunPanes pressed mgr's interrupt key while Claude Code
// (2.1.286) had started the turn but the model had not answered yet, and
// Claude Code put the whole kickoff back in the input box. The run's kickoff
// waited there for the next Enter, typed by the person or by a resume.
//
// (a) A kickoff copy found in the box gets Enter from submitHeldCopy, up to
//     three times with waits between them. A run that ends between those
//     Enters gets no further Enter, and the copy is cleared.
// (b) A sibling interrupted while its kickoff turn had not ended has the
//     kickoff the CLI put back cleared out of its box, with no Enter.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { transformWithEsbuild } from 'vite'
import { composerClearKeys, runPipelineKickoff } from '../../lib/cliCoordination'
import { framedComposerHolds, normalizeForMatch, SUBMIT_CONFIRM_MS, SUBMIT_SCREEN_LINES, TAIL_MATCH_LEN } from '../../lib/injectEcho'
import { submitHeldCopy } from '../../lib/spawnKickoff'
import { createRunSlotPanes } from '../../lib/runSlotPanes'
import * as failedRunStopLib from '../../lib/failedRunStop'
import { failedRunStop } from '../../lib/failedRunStop'

const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function functionSource(name: string): string | null {
  const start = appSource.search(new RegExp(`(?:async )?function ${name}\\(`))
  if (start < 0) return null
  const end = appSource.indexOf('\n}\n', start)
  return appSource.slice(start, end + 2)
}

const KNOWN_GLOBALS = new Set(['Promise', 'Date', 'Array', 'Map', 'Set', 'Object', 'String', 'Number', 'JSON', 'Error', 'console', 'Math', 'undefined', 'RegExp'])

async function lift<T>(names: string[], ret: string, scope: Record<string, unknown>): Promise<T> {
  const body = names.map(functionSource).filter((s): s is string => s !== null).join('\n')
  const { code } = await transformWithEsbuild(`${body}\nreturn { ${ret} }`, 'AppLifted.ts', { loader: 'ts' })
  const proxy = new Proxy(scope, {
    has: (target, key) => typeof key === 'string' && (key in target || !KNOWN_GLOBALS.has(key)),
    get: (target, key) => (key === Symbol.unscopables ? undefined : key in target ? target[key as string] : vi.fn()),
  })
  return new Function('scope', `with (scope) { return (function () {${code}})() }`)(proxy) as T
}

const KICKOFF = Array.from({ length: 12 }, (_, i) => `kickoff line ${i}: do the stage work and report back`).join('\n')
const box = (inside: string): string => `older output\n${'─'.repeat(60)}\n> ${inside}\n${'─'.repeat(60)}\n  ? for shortcuts`
const EMPTY_BOX = box('')
const HELD_BOX = box(KICKOFF.split('\n').slice(-1)[0])

const T0 = Date.UTC(2026, 10, 4, 10, 52, 50)

function keysTo(send: ReturnType<typeof vi.fn>, sid: string): string[] {
  return send.mock.calls
    .filter((c) => (c as unknown[])[0] === 'terminal.input' && ((c as unknown[])[1] as { terminal_session_id: string }).terminal_session_id === sid)
    .map((c) => ((c as unknown[])[1] as { data: string }).data)
}

describe('a failed run leaves no kickoff in an input box', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
  })
  afterEach(() => vi.useRealTimers())

  it('(a) a run marked ending between a held copy\'s Enters gets no more Enter, and the box is cleared', async () => {
    const state = { ending: false, screen: HELD_BOX, entersAfterEnd: 0 }
    const send = vi.fn(async (_type: string, payload: { data: string }) => {
      if (payload.data === '\r' && state.ending) state.entersAfterEnd++
      if (payload.data.startsWith('\x15')) state.screen = EMPTY_BOX
      return { ok: true }
    })
    const sleep = async (ms: number) => { vi.setSystemTime(Date.now() + ms) }
    const stillWanted = () => !state.ending
    const { kickoffCopyInBox } = await lift<{
      kickoffCopyInBox: (paneId: string, text: string, stillWanted?: () => boolean) => { holds: () => boolean; submit: () => Promise<boolean> }
    }>(['kickoffCopyInBox'], 'kickoffCopyInBox', {
      paneRefs: { 'pane-mgr': { sessionId: 's-mgr', readScreenTail: () => state.screen, terminalSize: () => ({ cols: 80, rows: 30 }) } },
      backend: { send },
      paneAlive: () => true,
      submitHeldCopy,
      framedComposerHolds,
      normalizeForMatch,
      composerClearKeys,
      TAIL_MATCH_LEN,
      SUBMIT_SCREEN_LINES,
      SUBMIT_CONFIRM_MS,
      sleep: async (ms: number) => {
        // The first Enter did not take; the sibling fails the run meanwhile.
        if (keysTo(send, 's-mgr').includes('\r')) state.ending = true
        await sleep(ms)
      },
      pipelineLog: vi.fn(),
    })
    const result = await runPipelineKickoff({
      inject: async () => ({ injected: false, echo: null }),
      sleep,
      paneAlive: () => true,
      copyInBox: kickoffCopyInBox('pane-mgr', KICKOFF, stillWanted),
      stillWanted,
    })
    expect(state.entersAfterEnd).toBe(0)
    expect(keysTo(send, 's-mgr').filter((k) => k.startsWith('\x15'))).toEqual(composerClearKeys(KICKOFF, 80))
    expect(result.stopped).toBe(true)
    expect(result.sent).toBe(false)
  })

  it('(b) an interrupted sibling whose kickoff the CLI put back has it cleared, with no Enter', async () => {
    const runSlots = createRunSlotPanes()
    runSlots.record(runSlots.current(), 'S1', 'wk', 'pane-wk')
    runSlots.record(runSlots.current(), 'S1', 'mgr', 'pane-mgr')
    const pipeline = { state: 'running', stageIndex: 0, workspacePath: '/ws' }
    // Before the interrupt the submitted kickoff is drawn above an empty box:
    // that is not the copy put back, and nothing is cleared for it.
    const SUBMITTED = `> ${KICKOFF.split('\n').slice(-1)[0]}\n\n* Dilly-dallying…\n${EMPTY_BOX}`
    const mgr = { sessionId: 's-mgr', displayStatus: 'idle', screen: SUBMITTED, readVisibleScreen: () => mgr.screen, readScreenTail: () => mgr.screen, terminalSize: () => ({ cols: 80, rows: 30 }) }
    const send = vi.fn(async (_type: string, payload: { data: string }) => {
      if (payload.data.startsWith('\x15')) {
        clearedWhile.push(mgr.screen)
        mgr.screen = EMPTY_BOX
      }
      return { ok: true }
    })
    const clearedWhile: string[] = []
    // Claude Code puts the kickoff back a moment after the interrupt key: at
    // the next wait, not at once, so the first read still shows the copy drawn
    // above the box. Tied to the waits, not to a real timer, so a slow runner
    // sees the same order.
    let putBackPending = false
    const onInterrupt = vi.fn(async () => {
      putBackPending = true
      return true
    })
    const log: string[] = []
    let watch: Promise<void> = Promise.resolve()
    const { failRunOnKickoff } = await lift<{
      failRunOnKickoff: (stageIndex: number, slotLabel: string, reason: string, held?: boolean, reported?: boolean, needsUser?: boolean) => Promise<void>
    }>(['failRunOnKickoff', 'stopFailedRunPanes', 'runSlotPane', 'clearInterruptedCopy'], 'failRunOnKickoff', {
      runSlots,
      panes: { value: [{ id: 'pane-wk', slotLabel: 'wk', realized: true }, { id: 'pane-mgr', slotLabel: 'mgr', realized: true }] },
      paneRefs: { 'pane-wk': { sessionId: 's-wk', displayStatus: 'awaiting' }, 'pane-mgr': mgr },
      pipeline,
      runEndingSlots: new Set<string>(),
      stagesApi: { stages: { value: [{ id: 'S1' }] } },
      pipelineDag: { retryAfterFailure: () => null, routeFailure: () => false, slotFailed: vi.fn(), end: vi.fn(async () => {}), isChildRun: () => false },
      tearDownPipelineOrchestration: () => { pipeline.state = 'aborted' },
      sendQuiet: vi.fn(async () => null),
      applyProjectPaths: vi.fn(),
      notifyRestore: { toast: vi.fn() },
      i18n: { global: { t: (k: string) => k } },
      onWorkspaceCheck: vi.fn(async () => {}),
      acp: { owns: () => false },
      stopFailedRunPanesFor: (deps: Parameters<typeof failedRunStopLib.stopFailedRunPanes>[0]) => (watch = failedRunStopLib.stopFailedRunPanes(deps)),
      failedRunStop,
      runPaneSentAt: new Map([['pane-mgr', T0 - 200]]),
      paneLastInjectedText: new Map([['pane-mgr', KICKOFF]]),
      paneTurnCompleteAt: new Map([['pane-mgr', T0 - 20_000]]),
      sleep: async (ms: number) => {
        vi.setSystemTime(Date.now() + ms)
        if (putBackPending) {
          putBackPending = false
          mgr.screen = box(KICKOFF.split('\n').slice(-1)[0])
        }
        await Promise.resolve()
      },
      onInterrupt,
      backend: { send },
      framedComposerHolds,
      composerClearKeys,
      normalizeForMatch,
      TAIL_MATCH_LEN,
      SUBMIT_SCREEN_LINES,
      pipelineLog: (line: string) => { log.push(line) },
    })
    await failRunOnKickoff(0, 'wk', 'parked on a permission prompt', false, false, true)
    await watch
    // clearInterruptedCopy is not awaited by the stop; its log line is its
    // last step, so once it is there every key it sends has been sent.
    await vi.waitFor(() => expect(log.some((l) => l.includes('cleared mgr'))).toBe(true), { timeout: 2000 })
    expect(keysTo(send, 's-mgr').filter((k) => k.startsWith('\x15'))).toEqual(composerClearKeys(KICKOFF, 80))
    expect(onInterrupt).toHaveBeenCalledWith('pane-mgr')
    expect(keysTo(send, 's-mgr')).not.toContain('\r')
    expect(clearedWhile).toEqual([box(KICKOFF.split('\n').slice(-1)[0])])
  })
})

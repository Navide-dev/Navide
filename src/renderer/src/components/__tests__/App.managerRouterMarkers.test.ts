// @vitest-environment happy-dom
// 0.2.37 package 6, Linux VM: a Manager-mode stage stayed `running` for good.
// The router never saw ---MANAGER-READY--- on the Manager's screen (it took the
// reply text at the turn end), never saw ---STAGE-DONE--- at all, forwarded the
// worker kickoff's protocol templates as an ASK and a REPORT, and sent the real
// REPORT twice. It happened without any permission prompt too.
//
// Root cause, reproduced with the same CLI (fixture below): Claude Code 2.1.316
// places every screen row with cursor moves and writes no `\n`, so the stripped
// clean buffer is one long line. A line-anchored sentinel never matches there;
// the TUI prints the submitted kickoff in full after the router's floor, so
// its templates parse as blocks; and every repaint appends the same blocks
// again. STAGE-DONE was read from the screen only, never from the reply text.
//
// App.vue cannot be mounted here, so the functions are lifted out, compiled
// and run against stubs passed by name.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { transformWithEsbuild } from 'vite'
import {
  createRedrawGuard, dropTuiNoise, findScreenSentinel, findSentinel, stripAnsi,
} from '../../platform/terminal/lib/buffer'
import { MANAGER_READY_SENTINEL, MANAGER_STAGE_DONE_SENTINEL } from '../../data/stages'
import { RUN_SLOT_STUB } from './pipelineDagTestStub'

const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')
const screens = JSON.parse(readFileSync(
  resolve(process.cwd(), 'src/renderer/src/components/__tests__/fixtures/claude-manager-mode-screen.json'), 'utf8',
)) as { manager: string[]; worker: string[] }

function functionSource(name: string): string {
  const start = appSource.search(new RegExp(`(?:async )?function ${name}\\(`))
  expect(start, `${name} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf('\n}\n', start)
  return appSource.slice(start, end + 2)
}

/** useTerminal's appendClean, chunk by chunk: what the router reads. */
function cleanBufferOf(chunks: string[]): string {
  const guard = createRedrawGuard()
  let buf = ''
  for (const chunk of chunks) {
    const cleaned = dropTuiNoise(stripAnsi(chunk))
    if (!cleaned || guard.isReplay(cleaned)) continue
    buf += cleaned
    guard.accept(cleaned)
  }
  return buf
}

async function load() {
  const names = [
    'parseContentBlocks', 'parseDispatchBlocks', 'matchWorkerByLabel', 'queueOrRouteWorkerMsg',
    'injectManagerPane', 'markManagerReady', 'routeManagerDispatch', 'finishManagerStage', 'routeManagerTurnText',
  ]
  const { code } = await transformWithEsbuild(
    [
      'const DISPATCH_RE = /---DISPATCH-START---([\\s\\S]*?)---DISPATCH-END---/g',
      'const ASK_RE = /---ASK-START---([\\s\\S]*?)---ASK-END---/g',
      'const REPORT_RE = /---REPORT-START---([\\s\\S]*?)---REPORT-END---/g',
      ...names.map(functionSource),
      'return { parseContentBlocks, queueOrRouteWorkerMsg, routeManagerTurnText, ASK_RE, REPORT_RE }',
    ].join('\n'),
    'AppManagerRouterMarkers.ts',
    { loader: 'ts' },
  )
  const router = {
    managerPaneId: 'mgr',
    workerPaneIds: new Map([['wk', 'w1']]),
    managerReady: false,
    preReadyQueue: [] as Array<{ fromLabel: string; kind: string; content: string }>,
    routedDispatches: new Set<string>(),
    routedWorkerMessages: new Set<string>(),
    finished: false,
    armedAt: Date.parse('2026-11-02T13:24:40Z'),
    managerKickoffAt: Date.parse('2026-11-02T13:24:36Z'),
    readyReminded: false,
    managerQuietSince: 0,
  }
  const injected: Array<[string, string]> = []
  const log: string[] = []
  const onPipelineNext = vi.fn(async () => {})
  const stageCompletions = new Map([[0, {}]])
  const deps: Record<string, unknown> = {
    pipeline: { state: 'running', stageIndex: 0 },
    stageRouters: new Map([[0, router]]),
    stagesApi: { stages: { value: [{ id: 'm1' }] } },
    stageCompletions,
    onPipelineNext,
    findSentinel,
    MANAGER_READY_SENTINEL,
    MANAGER_STAGE_DONE_SENTINEL,
    MANAGER_READY_REMINDER: 'reminder',
    TURN_TEXT_REPLAY_TOLERANCE_MS: 60_000,
    paneTurnStartedAt: new Map(),
    pipelineLog: (line: string) => log.push(line),
    i18n: { global: { t: (key: string) => key } },
    routerInject: async (paneId: string, text: string) => { injected.push([paneId, text]); return true },
  }
  const api = new Function(...Object.keys(deps), code)(...Object.values(deps)) as {
    parseContentBlocks: (buf: string, from: number, re: RegExp) => { items: string[]; newCursor: number }
    queueOrRouteWorkerMsg: (r: typeof router, stageId: string, msg: { fromLabel: string; kind: string; content: string }) => void
    routeManagerTurnText: (paneId: string, text: string, timestamp: string, held?: boolean) => Promise<void>
    ASK_RE: RegExp
    REPORT_RE: RegExp
  }
  return { api, router, injected, log, onPipelineNext, stageCompletions }
}

describe('Claude 2.1.316 screen: no newlines, so line anchors never match', () => {
  it('the clean buffer of a real Manager screen is a single line', () => {
    const buf = cleanBufferOf(screens.manager)
    expect(buf).toContain(MANAGER_READY_SENTINEL)
    expect(buf.includes('\n')).toBe(false)
    // The Manager printed READY, and findSentinel reads past it.
    expect(findSentinel(buf, MANAGER_READY_SENTINEL, 1)).toBe(-1)
  })

  it('the screen scan finds the READY the Manager printed', () => {
    const buf = cleanBufferOf(screens.manager)
    expect(findScreenSentinel(buf, MANAGER_READY_SENTINEL, 1)).toBeGreaterThan(-1)
  })

  it('the kickoff the TUI prints after submit does not read as READY or STAGE-DONE', () => {
    const buf = cleanBufferOf(screens.manager)
    const reply = buf.search(new RegExp(`⏺\\s*${MANAGER_READY_SENTINEL}`))
    expect(reply).toBeGreaterThan(-1)
    // Everything before the reply is the echoed kickoff, which carries both
    // sentinels (the protocol text) but no reply bullet.
    const echo = buf.slice(0, reply)
    expect(echo).toContain(MANAGER_STAGE_DONE_SENTINEL)
    expect(findScreenSentinel(echo, MANAGER_READY_SENTINEL, 1)).toBe(-1)
    expect(findScreenSentinel(buf, MANAGER_STAGE_DONE_SENTINEL, 1)).toBe(-1)
  })

  it('the Manager router scan uses the screen form for READY only', () => {
    const scan = functionSource('managerRouterScan')
    expect(scan).toContain('findScreenSentinel(buf, MANAGER_READY_SENTINEL, cursor)')
    // STAGE-DONE stays line-anchored: webhook data echoed after the floor could
    // carry a bullet-prefixed one. A no-newline screen gets it from the reply.
    expect(scan).toContain('findSentinel(buf, MANAGER_STAGE_DONE_SENTINEL, doneFrom)')
    expect(scan).not.toContain('findScreenSentinel(buf, MANAGER_STAGE_DONE_SENTINEL')
  })
})

describe('worker screen: templates are not messages, and a repaint is not a second one', () => {
  it('the protocol templates echoed with the kickoff are not parsed as ASK or REPORT', async () => {
    const t = await load()
    const buf = cleanBufferOf(screens.worker)
    // The echo really is there, twice, wrapped two ways.
    expect(buf.match(/---ASK-START---/g)?.length).toBeGreaterThanOrEqual(2)
    expect(t.api.parseContentBlocks(buf, 0, t.api.ASK_RE).items).toEqual([])
    expect(t.api.parseContentBlocks(buf, 0, t.api.REPORT_RE).items).toEqual(['worker report Y24fe56da8069'])
  })

  // Package 7, Linux VM, a 50-column worker: a repaint dropped letters from the
  // template's END marker ("REPOR-END--"), so the template's START ran on to the
  // END of the worker's real REPORT, and the whole kickoff tail between them
  // reached the Manager as one REPORT. The fixture is the forwarded text
  // verbatim (stub.log line 71); the markers around it are the ones it lost.
  it('a template whose END was mangled by a repaint does not swallow the real REPORT', async () => {
    const t = await load()
    const { forwarded } = JSON.parse(readFileSync(
      resolve(process.cwd(), 'src/renderer/src/components/__tests__/fixtures/claude-narrow-template-fragment.json'), 'utf8',
    )) as { forwarded: string }
    const buf = `---REPORT-START---  content: ${forwarded}  ---REPORT-END---`
    expect(t.api.parseContentBlocks(buf, 0, t.api.REPORT_RE).items).toEqual(['workerreportY243fbc6bea54'])
    expect(t.api.parseContentBlocks(buf, 0, t.api.ASK_RE).items).toEqual([])
  })

  it('a real message with < and > in it is still routed', async () => {
    const t = await load()
    const buf = [
      '---REPORT-START---',
      'content: <b>bold</b> works now; latency < 200ms and retries > 3 are handled',
      '---REPORT-END---',
      '---ASK-START---',
      'content: <Option A> or <Option B>?',
      '---ASK-END---',
    ].join('\n')
    expect(t.api.parseContentBlocks(buf, 0, t.api.REPORT_RE).items)
      .toEqual(['<b>bold</b> works now; latency < 200ms and retries > 3 are handled'])
    expect(t.api.parseContentBlocks(buf, 0, t.api.ASK_RE).items).toEqual(['<Option A> or <Option B>?'])
  })

  it('the same REPORT seen again after a repaint is routed once', async () => {
    const t = await load()
    t.router.managerReady = true
    t.api.queueOrRouteWorkerMsg(t.router, 'm1', { fromLabel: 'wk', kind: 'REPORT', content: 'worker report Y24fe56da8069' })
    // A repaint re-emits the row, padded differently.
    t.api.queueOrRouteWorkerMsg(t.router, 'm1', { fromLabel: 'wk', kind: 'REPORT', content: 'worker report  Y24fe56da8069 ' })
    await Promise.resolve()
    expect(t.injected.filter(([pane, text]) => pane === 'mgr' && text.includes('[→ REPORT FROM wk]'))).toHaveLength(1)
  })

  it('a held duplicate is not queued twice either', async () => {
    const t = await load()
    t.api.queueOrRouteWorkerMsg(t.router, 'm1', { fromLabel: 'wk', kind: 'REPORT', content: 'worker report Y1' })
    t.api.queueOrRouteWorkerMsg(t.router, 'm1', { fromLabel: 'wk', kind: 'REPORT', content: 'worker report Y1' })
    expect(t.router.preReadyQueue).toHaveLength(1)
    // A different message, or the same text as an ASK, still goes through.
    t.api.queueOrRouteWorkerMsg(t.router, 'm1', { fromLabel: 'wk', kind: 'ASK', content: 'worker report Y1' })
    t.api.queueOrRouteWorkerMsg(t.router, 'm1', { fromLabel: 'wk', kind: 'REPORT', content: 'worker report Y2' })
    expect(t.router.preReadyQueue).toHaveLength(3)
  })

  it('the global router drops a repeat, but not the same words from a later stage', async () => {
    const { code } = await transformWithEsbuild(
      [
        RUN_SLOT_STUB,
        'const ASK_RE = /---ASK-START---([\\s\\S]*?)---ASK-END---/g',
        'const REPORT_RE = /---REPORT-START---([\\s\\S]*?)---REPORT-END---/g',
        'const DISPATCH_RE = /---DISPATCH-START---([\\s\\S]*?)---DISPATCH-END---/g',
        functionSource('parseContentBlocks'), functionSource('parseDispatchBlocks'),
        functionSource('globalManagerRouterScan'),
        'return globalManagerRouterScan',
      ].join('\n'),
      'AppGlobalRouterRepeats.ts',
      { loader: 'ts' },
    )
    const block = '---REPORT-START---\ncontent: done\n---REPORT-END---'
    const worker = { id: 'w1', stageId: 's1', slotLabel: 'wk', realized: true, origin: 'pipeline' }
    const paneRefs: Record<string, { cleanBuffer: string }> = { mgr: { cleanBuffer: '' }, w1: { cleanBuffer: block } }
    const reports: string[] = []
    const deps: Record<string, unknown> = {
      pipeline: { state: 'running', stageIndex: 0, globalManager: { stageId: 'g', slotLabel: 'boss' } },
      globalManagerPaneId: () => 'mgr',
      panes: { value: [{ id: 'mgr', stageId: 'g', slotLabel: 'boss', realized: true, origin: 'pipeline' }, worker] },
      paneRefs,
      stageRouters: new Map(),
      rebaseGlobalRouterCursor: () => {},
      globalRouterCursors: new Map<string, number>(),
      globalRoutedMessages: new Set<string>(),
      paneTurnStartedAt: new Map<string, number>(),
      pipelineLog: () => {},
      i18n: { global: { t: (key: string) => key } },
      routerInject: async (paneId: string, text: string) => { if (paneId === 'mgr') reports.push(text); return true },
      _globalScanRunning: false,
    }
    const scan = new Function(...Object.keys(deps), code)(...Object.values(deps)) as () => Promise<void>
    await scan()
    // A repaint writes the same block again further down.
    paneRefs.w1.cleanBuffer += `\n${block}`
    await scan()
    expect(reports).toHaveLength(1)
    // The same pane, a later stage, the same short words: a new message.
    worker.stageId = 's2'
    paneRefs.w1.cleanBuffer += `\n${block}`
    await scan()
    expect(reports).toHaveLength(2)
    expect(reports[1]).toContain('(Stage s2)')
  })
})

describe('STAGE-DONE in the Manager reply text ends the stage', () => {
  it('finishes the stage once', async () => {
    const t = await load()
    t.router.managerReady = true
    await t.api.routeManagerTurnText('mgr', `${MANAGER_STAGE_DONE_SENTINEL}\nfinished`, '2026-11-02T13:26:00Z')
    await t.api.routeManagerTurnText('mgr', `${MANAGER_STAGE_DONE_SENTINEL}\nfinished`, '2026-11-02T13:26:05Z')
    expect(t.router.finished).toBe(true)
    expect(t.onPipelineNext).toHaveBeenCalledTimes(1)
    expect(t.stageCompletions.has(0)).toBe(false)
    expect(t.injected.some(([, text]) => text === 'reminder')).toBe(false)
  })

  it('a late turn end from the previous stage does not end this one', async () => {
    const t = await load()
    t.router.managerReady = true
    // One pane is Manager of both stages. The previous stage ended on its
    // screen; that turn's turn_complete arrives after this stage's kickoff was
    // sent, is held until the poll starts, and is replayed then.
    const previousTurnEnd = new Date(t.router.managerKickoffAt - 5_000).toISOString()
    await t.api.routeManagerTurnText('mgr', `${MANAGER_STAGE_DONE_SENTINEL}\nfinished`, previousTurnEnd, true)
    expect(t.router.finished).toBe(false)
    expect(t.onPipelineNext).not.toHaveBeenCalled()
  })

  it('a reply that only mentions it on a shared line does not end the stage', async () => {
    const t = await load()
    t.router.managerReady = true
    await t.api.routeManagerTurnText('mgr', `I will print ${MANAGER_STAGE_DONE_SENTINEL} when the worker is done.`, '2026-11-02T13:26:00Z')
    expect(t.router.finished).toBe(false)
    expect(t.onPipelineNext).not.toHaveBeenCalled()
  })
})

// 0.2.37 VM package 9 (Claude Code 2.1.286, Linux), 3 of 3 runs: after the
// Manager's DISPATCH the worker's REPORT reached the Manager as
// "workerreportY…" while its screen showed "worker report Y…". Claude draws a
// fresh row's blank cells by moving the cursor past them, and the stripper
// dropped those moves with every other CSI. The worker's stage log shows that
// first draw ("workerreportY965062ac8a50"), and the repaint after it lost its
// START marker, so the stripped copy was the only block the router could read.
describe('a row drawn with column moves keeps its spaces', () => {
  it('the recorded 2.1.316 status row reads with its spaces', () => {
    // From the fixture: `Churned\x1b[11Gfor\x1b[15G21s · done\x1b[26G10:04 PM`.
    expect(cleanBufferOf(screens.worker)).toContain('Churned for 21s · done 10:04 PM')
  })

  it('a REPORT drawn that way reaches the Manager with the worker\'s spaces', async () => {
    const t = await load()
    // The fixture's REPORT rows, with the blank cells skipped as package 9 drew them.
    const report = '\r\x1b[1B\x1b[38;5;231m⏺\x1b[39m\x1b[3G---REPORT-START---\x1b[K'
      + '\r\x1b[1B\x1b[3Gworker\x1b[10Greport\x1b[17GY20e0c2d8aecc\x1b[K'
      + '\r\x1b[1B\x1b[3G---REPORT-END---\x1b[K\r\x1b[2C\x1b[1Bfinished\x1b[K'
    const buf = cleanBufferOf([...screens.worker, report])
    const items = t.api.parseContentBlocks(buf, 0, t.api.REPORT_RE).items
    expect(items).toContain('worker report Y20e0c2d8aecc')
    expect(items.some((c) => c.includes('workerreport'))).toBe(false)
  })

  it('a pane that only moves its cursor still cleans to nothing', () => {
    expect(stripAnsi('\x1b[H\r\x1b[2C\x1b[37B\x1b[K\x1b[40;1H\x1b[38;29H\x1b[21C')).toBe('')
  })
})


// @vitest-environment happy-dom
// Two 0.2.37 review findings (Fable).
//
// 1. A queued kickoff: the turn ahead's turn_complete, the kickoff turn's
//    agent_active and its turn_complete arrive in one batch (a late
//    transcript, a stalled backend). All three are stamped with the time the
//    window received them, so the last end is the kickoff turn's and no
//    activity comes after it: waitForQueuedTurn answered no-own-turn 15 s
//    later, the kickoff was held and the run failed while the agent had done
//    the work, and a resume typed the kickoff again.
// 2. The routers dropped a worker's second ASK or REPORT with the same text
//    as an earlier one (two "done" REPORTs) as a repaint, and the worker
//    waited for an answer that never came.
// 3. (0.2.38) Item 2 again, without its regression: the screen keeps sending a
//    text once, so a block an earlier turn left on screen is never re-sent; a
//    later turn that prints the same text is known from its own turn text.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { transformWithEsbuild } from 'vite'
import { waitForQueuedTurn } from '../../lib/pipelineDelivery'
import { createMessagingTurnGate } from '../../lib/cliCoordination'
import { noteScreenRoute, takeScreenRoute } from '../../lib/routedBlockCredits'
import { RUN_SLOT_STUB } from './pipelineDagTestStub'

const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function functionSource(name: string): string {
  const start = appSource.search(new RegExp(`(?:async )?function ${name}\\(`))
  expect(start, `${name} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf('\n}\n', start)
  return appSource.slice(start, end + 2)
}

const T0 = Date.UTC(2026, 10, 3, 13, 0, 0)

/** A pane's turn signals as App.vue keeps them, fed one event at a time with
 *  the receipt clock, the way the agent.activity handler records them. */
function turnSignals() {
  const completeAt = new Map<string, number>()
  const activeAt = new Map<string, number>()
  const completeTimes = new Map<string, number[]>()
  return {
    completeAt, activeAt, completeTimes,
    complete: (pane: string) => {
      completeAt.set(pane, Date.now())
      completeTimes.set(pane, [...(completeTimes.get(pane) ?? []), Date.now()])
    },
    active: (pane: string) => { activeAt.set(pane, Date.now()) },
  }
}

describe('a queued kickoff whose turn arrives in one batch with the turn ahead', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
  })
  afterEach(() => vi.useRealTimers())

  async function run(batch: (s: ReturnType<typeof turnSignals>) => void) {
    const s = turnSignals()
    s.active('wk') // the turn the kickoff is queued behind
    const since = T0 + 1
    vi.setSystemTime(since)
    let polls = 0
    return waitForQueuedTurn({
      since,
      lastCompleteAt: () => s.completeAt.get('wk') ?? 0,
      lastActiveAt: () => s.activeAt.get('wk') ?? 0,
      completionsSince: (t) => (s.completeTimes.get('wk') ?? []).filter((at) => at > t).length,
      parked: () => false,
      alive: () => true,
      stillWanted: () => true,
      sleep: async (ms) => {
        vi.setSystemTime(Date.now() + ms)
        if (++polls === 20) batch(s) // 5 s in, all in one tick
      },
      now: Date.now,
    })
  }

  it('turn ahead ends → kickoff active → kickoff ends, in one tick: started', async () => {
    expect(await run((s) => { s.complete('wk'); s.active('wk'); s.complete('wk') })).toBe('started')
  })

  it('only the turn ahead ending, and nothing of the kickoff\'s: still no own turn', async () => {
    expect(await run((s) => { s.complete('wk'); s.active('wk') })).toBe('no-own-turn')
  })
})

describe('confirmQueuedKickoff counts the turn ends it has', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
  })
  afterEach(() => vi.useRealTimers())

  async function confirm(batch: (s: ReturnType<typeof turnSignals>) => void) {
    const { code } = await transformWithEsbuild(
      `const QUEUED_TURN_LINE = new Proxy({}, { get: (_t, k) => String(k) })\n${functionSource('confirmQueuedKickoff')}\nreturn confirmQueuedKickoff`,
      'AppConfirmQueued.ts', { loader: 'ts' },
    )
    const s = turnSignals()
    const log: string[] = []
    let polls = 0
    const deps: Record<string, unknown> = {
      waitForQueuedTurn,
      paneTurnCompleteAt: s.completeAt,
      paneLastActiveAt: s.activeAt,
      paneTurnCompleteTimes: s.completeTimes,
      paneParkedOnPrompt: () => false,
      paneAlive: () => true,
      sleep: async (ms: number) => {
        vi.setSystemTime(Date.now() + ms)
        if (++polls === 20) batch(s)
      },
      pipelineLog: (line: string) => log.push(line),
    }
    const fn = new Function(...Object.keys(deps), code)(...Object.values(deps)) as
      (paneId: string, since: number, tag: string, stillWanted: () => boolean) => Promise<boolean>
    s.active('wk')
    vi.setSystemTime(T0 + 1)
    const ok = await fn('wk', T0 + 1, '[wk]', () => true)
    return { ok, log }
  }

  it('the kickoff turn that arrived with the turn ahead counts as started', async () => {
    const r = await confirm((s) => { s.complete('wk'); s.active('wk'); s.complete('wk') })
    expect(r.ok).toBe(true)
  })

  it('no own turn is logged with what it saw', async () => {
    const r = await confirm((s) => { s.complete('wk') })
    expect(r.ok).toBe(false)
    expect(r.log.some((l) => l.includes('no own turn — 1 turn end(s) since the kickoff'))).toBe(true)
  })

  it('every recorded turn end is counted', () => {
    expect(appSource).toMatch(/TURN_TEXT_REPLAY_TOLERANCE_MS, paneTurnCompleteSourceAt, paneTurnCompleteTimes\n/)
  })
})

describe('the stage router: a block from an earlier turn is not sent again', () => {
  async function load() {
    const { code } = await transformWithEsbuild(
      `${functionSource('queueOrRouteWorkerMsg')}\n${functionSource('injectManagerPane')}\nreturn queueOrRouteWorkerMsg`,
      'AppRouterRepeats.ts', { loader: 'ts' },
    )
    const injected: string[] = []
    const log: string[] = []
    const paneTurnStartedAt = new Map<string, number>([['w1', T0]])
    const deps: Record<string, unknown> = {
      paneTurnStartedAt,
      noteScreenRoute,
      takeScreenRoute,
      pipelineLog: (line: string) => log.push(line),
      i18n: { global: { t: (key: string) => key } },
      routerInject: async (_pane: string, text: string) => { injected.push(text); return true },
    }
    const queue = new Function(...Object.keys(deps), code)(...Object.values(deps)) as
      (router: unknown, stageId: string, msg: { fromLabel: string; kind: string; content: string }) => void
    const router = {
      managerPaneId: 'mgr', managerReady: true, preReadyQueue: [],
      routedWorkerMessages: new Set<string>(), workerPaneIds: new Map([['wk', 'w1']]),
    }
    return { queue: (content: string) => queue(router, 's1', { fromLabel: 'wk', kind: 'REPORT', content }), injected, log, paneTurnStartedAt }
  }

  // 0.2.37 VM: the worker's first-turn ASK stayed on screen and was scanned
  // again in its next turn; a per-turn key sent it to the Manager twice.
  it('an ASK still on screen in the worker\'s next turn reaches the Manager once', async () => {
    const t = await load()
    t.queue('may I?')
    t.paneTurnStartedAt.set('w1', T0 + 60_000)
    t.queue('may I?')
    await Promise.resolve()
    expect(t.injected).toHaveLength(1)
  })

  it('a block repainted in the same turn reaches it once, and the skip is logged', async () => {
    const t = await load()
    t.queue('done')
    t.queue(' done ')
    await Promise.resolve()
    expect(t.injected).toHaveLength(1)
    expect(t.log.some((l) => l.includes('REPORT from wk skipped — a block already routed'))).toBe(true)
  })
})

describe('the global router: a block from an earlier turn is not sent again', () => {
  it('a repaint and the next turn\'s rescan both stay at one REPORT', async () => {
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
      'AppGlobalRouterTurns.ts', { loader: 'ts' },
    )
    const block = '---REPORT-START---\ncontent: done\n---REPORT-END---'
    const paneRefs: Record<string, { cleanBuffer: string }> = { mgr: { cleanBuffer: '' }, w1: { cleanBuffer: block } }
    const reports: string[] = []
    const log: string[] = []
    const paneTurnStartedAt = new Map<string, number>([['w1', T0]])
    const deps: Record<string, unknown> = {
      pipeline: { state: 'running', stageIndex: 0, globalManager: { stageId: 'g', slotLabel: 'boss' } },
      globalManagerPaneId: () => 'mgr',
      panes: { value: [
        { id: 'mgr', stageId: 'g', slotLabel: 'boss', realized: true, origin: 'pipeline' },
        { id: 'w1', stageId: 's1', slotLabel: 'wk', realized: true, origin: 'pipeline' },
      ] },
      paneRefs,
      stageRouters: new Map(),
      rebaseGlobalRouterCursor: () => {},
      globalRouterCursors: new Map<string, number>(),
      globalRoutedMessages: new Set<string>(),
      globalScreenRoutes: new Map<string, number[]>(),
      noteScreenRoute,
      paneTurnStartedAt,
      pipelineLog: (line: string) => log.push(line),
      i18n: { global: { t: (key: string) => key } },
      routerInject: async (paneId: string, text: string) => { if (paneId === 'mgr') reports.push(text); return true },
      _globalScanRunning: false,
    }
    const scan = new Function(...Object.keys(deps), code)(...Object.values(deps)) as () => Promise<void>
    await scan()
    paneRefs.w1.cleanBuffer += `\n${block}` // a repaint, same turn
    await scan()
    expect(reports).toHaveLength(1)
    expect(log.some((l) => l.includes('REPORT from wk skipped — a block already routed'))).toBe(true)
    paneTurnStartedAt.set('w1', T0 + 60_000) // the next turn rescans the block still on screen
    paneRefs.w1.cleanBuffer += `\n${block}`
    await scan()
    expect(reports).toHaveLength(1)
  })
})

const RE_SOURCE = [
  'const ASK_RE = /---ASK-START---([\\s\\S]*?)---ASK-END---/g',
  'const REPORT_RE = /---REPORT-START---([\\s\\S]*?)---REPORT-END---/g',
  'const DISPATCH_RE = /---DISPATCH-START---([\\s\\S]*?)---DISPATCH-END---/g',
]
const askBlock = (content: string) => `---ASK-START---\ncontent: ${content}\n---ASK-END---`
const reportBlock = (content: string) => `---REPORT-START---\ncontent: ${content}\n---REPORT-END---`
const at = (ms: number) => new Date(T0 + ms).toISOString()

/** The shared state both routers and routeWorkerTurnText read, as App.vue
 *  declares it. `stageRouter` set: the worker belongs to that stage router;
 *  otherwise only the global router (a global Manager) reads it. */
function routerDeps(stageRouter: unknown) {
  const sent: string[] = []
  const log: string[] = []
  const paneRefs: Record<string, { cleanBuffer: string }> = { mgr: { cleanBuffer: '' }, w1: { cleanBuffer: '' } }
  const deps: Record<string, unknown> = {
    pipeline: stageRouter
      ? { state: 'running', stageIndex: 0 }
      : { state: 'running', stageIndex: 0, globalManager: { stageId: 'g', slotLabel: 'boss' } },
    stageRouters: new Map(stageRouter ? [[0, stageRouter]] : []),
    stagesApi: { stages: { value: [{ id: 's1' }] } },
    globalRouterHandle: stageRouter ? null : 1,
    globalManagerPaneId: () => 'mgr',
    panes: { value: [
      { id: 'mgr', stageId: 'g', slotLabel: 'boss', realized: true, origin: 'pipeline' },
      { id: 'w1', stageId: 's1', slotLabel: 'wk', realized: true, origin: 'pipeline' },
    ] },
    paneRefs,
    isInjectedMessageText: () => false,
    rebaseGlobalRouterCursor: () => {},
    globalRouterCursors: new Map<string, number>(),
    globalRoutedMessages: new Set<string>(),
    globalScreenRoutes: new Map<string, number[]>(),
    workerTurnTextGate: createMessagingTurnGate(T0 - 1_000),
    workerTurnTextAt: new Map<string, number>(),
    TURN_TEXT_REPLAY_TOLERANCE_MS: 60_000,
    noteScreenRoute,
    takeScreenRoute,
    paneTurnStartedAt: new Map<string, number>(),
    pipelineLog: (line: string) => log.push(line),
    i18n: { global: { t: (key: string) => key } },
    routerInject: async (paneId: string, text: string) => { if (paneId === 'mgr') sent.push(text); return true },
    _globalScanRunning: false,
  }
  return { deps, sent, log, paneRefs }
}

async function loadRouters(withStageRouter: boolean) {
  const { code } = await transformWithEsbuild(
    [
      RUN_SLOT_STUB, ...RE_SOURCE,
      functionSource('parseContentBlocks'), functionSource('parseDispatchBlocks'),
      functionSource('queueOrRouteWorkerMsg'), functionSource('injectManagerPane'),
      functionSource('globalManagerRouterScan'), functionSource('routeWorkerTurnText'),
      'return { queueOrRouteWorkerMsg, globalManagerRouterScan, routeWorkerTurnText }',
    ].join('\n'),
    'AppRouterTurnText.ts', { loader: 'ts' },
  )
  const router = withStageRouter
    ? {
        managerPaneId: 'mgr', managerReady: true, preReadyQueue: [], armedAt: T0, finished: false,
        routedWorkerMessages: new Set<string>(), workerPaneIds: new Map([['wk', 'w1']]),
      }
    : undefined
  const { deps, sent, log, paneRefs } = routerDeps(router)
  const fns = new Function(...Object.keys(deps), code)(...Object.values(deps)) as {
    queueOrRouteWorkerMsg: (r: unknown, stageId: string, msg: { fromLabel: string; kind: string; content: string }) => void
    globalManagerRouterScan: () => Promise<void>
    routeWorkerTurnText: (paneId: string, text: string, timestamp: string) => Promise<void>
  }
  /** The worker's screen gets `block` (printed or repainted) and the router
   *  scans it, at `ms` after T0. */
  const screen = async (ms: number, kind: 'ASK' | 'REPORT', content: string) => {
    vi.setSystemTime(T0 + ms)
    if (router) {
      fns.queueOrRouteWorkerMsg(router, 's1', { fromLabel: 'wk', kind, content })
    } else {
      paneRefs.w1.cleanBuffer += `\n${kind === 'ASK' ? askBlock(content) : reportBlock(content)}`
      await fns.globalManagerRouterScan()
    }
    await Promise.resolve()
  }
  /** The worker's turn ended at `endMs` and its reader reported `text`, which
   *  reached the window at `ms`. */
  const turn = async (ms: number, text: string, endMs = ms) => {
    vi.setSystemTime(T0 + ms)
    await fns.routeWorkerTurnText('w1', text, at(endMs))
    await Promise.resolve()
  }
  const count = (kind: string) => sent.filter((t) => t.includes(`${kind} FROM wk`)).length
  return { screen, turn, sent, log, count }
}

for (const [name, withStageRouter] of [['stage router', true], ['global router', false]] as const) {
  describe(`the ${name}: a block is sent once per turn that printed it`, () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(T0)
    })
    afterEach(() => vi.useRealTimers())

    // A. A TUI repaint re-emits rows already on screen.
    it('a repaint in the same turn, before and after the turn text: once', async () => {
      const t = await loadRouters(withStageRouter)
      await t.screen(1_000, 'REPORT', 'done')
      await t.screen(1_500, 'REPORT', 'done')
      await t.turn(2_000, reportBlock('done'))
      await t.screen(3_000, 'REPORT', 'done')
      expect(t.count('REPORT')).toBe(1)
    })

    // B. 0.2.37 VM ask×3: the first turn's ASK stayed on screen and was
    // scanned again in the next turn.
    it('an ASK still on screen in the next turn is not sent again', async () => {
      const t = await loadRouters(withStageRouter)
      await t.screen(1_000, 'ASK', 'may I?')
      await t.turn(2_000, askBlock('may I?'))
      await t.screen(60_000, 'ASK', 'may I?')
      await t.screen(61_000, 'REPORT', 'finished')
      await t.turn(62_000, reportBlock('finished'))
      await t.screen(63_000, 'ASK', 'may I?')
      expect(t.count('ASK')).toBe(1)
      expect(t.count('REPORT')).toBe(1)
    })

    // C. 0.2.37 VM dup×3: the worker was asked to redo the work and printed
    // the same REPORT again; the run waited on it forever.
    it('the same REPORT printed again in a new turn is sent again', async () => {
      const t = await loadRouters(withStageRouter)
      await t.screen(1_000, 'REPORT', 'done')
      await t.turn(2_000, reportBlock('done'))
      await t.screen(60_000, 'REPORT', 'done')
      await t.turn(61_000, reportBlock('done'))
      expect(t.count('REPORT')).toBe(2)
      expect(t.log.some((l) => l.includes('REPORT from wk printed again in a new turn'))).toBe(true)
    })

    it('a turn text that arrives before the screen scan sends it, and the screen does not again', async () => {
      const t = await loadRouters(withStageRouter)
      await t.turn(1_000, reportBlock('done'))
      await t.screen(2_000, 'REPORT', 'done')
      await t.turn(60_000, reportBlock('done'))
      await t.screen(61_000, 'REPORT', 'done')
      expect(t.count('REPORT')).toBe(2)
    })

    it('a turn text that arrives late, in the next turn, is the screen\'s copy: once', async () => {
      const t = await loadRouters(withStageRouter)
      await t.screen(1_000, 'REPORT', 'done')
      await t.turn(30_000, reportBlock('done'), 2_000)
      expect(t.count('REPORT')).toBe(1)
    })

    it('one turn reported twice (hook and transcript) counts once', async () => {
      const t = await loadRouters(withStageRouter)
      await t.screen(1_000, 'REPORT', 'done')
      await t.turn(2_000, reportBlock('done'))
      await t.turn(2_500, reportBlock('done'), 2_000)
      expect(t.count('REPORT')).toBe(1)
    })

    it('one turn that prints the block twice sends it once', async () => {
      const t = await loadRouters(withStageRouter)
      await t.turn(2_000, `${reportBlock('done')}\n${reportBlock(' done ')}`)
      expect(t.count('REPORT')).toBe(1)
    })

    it('a turn from before the window booted is not taken', async () => {
      const t = await loadRouters(withStageRouter)
      await t.turn(2_000, reportBlock('done'), -3_600_000)
      expect(t.count('REPORT')).toBe(0)
    })

    // E. A vendor whose reader reports no turn text: the screen alone, text dedupe.
    it('with no turn text, the same words on screen in a later turn stay at one', async () => {
      const t = await loadRouters(withStageRouter)
      await t.screen(1_000, 'REPORT', 'done')
      await t.screen(60_000, 'REPORT', 'done')
      expect(t.count('REPORT')).toBe(1)
    })
  })
}

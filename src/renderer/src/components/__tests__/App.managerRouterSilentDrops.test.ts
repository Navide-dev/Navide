// @vitest-environment happy-dom
// #539 follow-up: three ways the stage router still lost a Manager's
// coordination without a word, each leaving every pane of the stage idle while
// the run showed `running`.
//
// 1. A reply that arrived before the router poll started (the poll waits for
//    every slot's kickoff) was returned from unread: a DISPATCH in it was gone.
// 2. A Manager that ended its turn without ---MANAGER-READY--- and without a
//    DISPATCH left the workers' REPORTs held for a line it might never print.
//    It is now reminded once, and if it then sits idle 180s with messages held,
//    they are handed over anyway. A turn end alone is not READY: a Manager can
//    end Phase-1 turns on purpose.
// 3. A DISPATCH naming no known slot, or one whose injection failed, was at
//    most a log line: the Manager believed it had dispatched.
//
// App.vue cannot be mounted here, so the functions are lifted out, compiled
// and run against stubs passed by name.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { transformWithEsbuild } from 'vite'
import { findSentinel } from '../../platform/terminal/lib/buffer'
import { MANAGER_READY_SENTINEL } from '../../data/stages'

const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function functionSource(name: string): string {
  const start = appSource.search(new RegExp(`(?:async )?function ${name}\\(`))
  expect(start, `${name} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf('\n}\n', start)
  return appSource.slice(start, end + 2)
}

const dispatchTo = (to: string): string => [
  '畫好了分鏡的解讀，現在進入控場。',
  '---DISPATCH-START---',
  `to: ${to}`,
  'message: 先畫第一張角色設定圖（豆豆），完成後回報。',
  '---DISPATCH-END---',
].join('\n')

const KICKOFF_AT = Date.parse('2026-10-24T01:37:02Z')
const iso = (offsetMs: number): string => new Date(KICKOFF_AT + offsetMs).toISOString()

async function load(opts: {
  armed?: boolean
  injectOk?: (paneId: string) => boolean
  kickoffAt?: number
  turnStartedAt?: number
  idle?: boolean
  background?: () => boolean
} = {}) {
  const names = [
    'parseDispatchBlocks', 'matchWorkerByLabel', 'injectManagerPane', 'markManagerReady',
    'routeManagerDispatch', 'routeManagerTurnText', 'managerReadyFallback', 'startRouterPoll',
  ]
  const { code } = await transformWithEsbuild(
    `const DISPATCH_RE = /---DISPATCH-START---([\\s\\S]*?)---DISPATCH-END---/g\n${names.map(functionSource).join('\n')}\nreturn { routeManagerTurnText, routeManagerDispatch, managerReadyFallback, startRouterPoll }`,
    'AppManagerRouterSilentDrops.ts',
    { loader: 'ts' },
  )
  const router = {
    managerPaneId: 'mgr',
    workerPaneIds: new Map([['畫師', 'w1'], ['審稿', 'w2']]),
    managerReady: false,
    preReadyQueue: [{ fromLabel: '畫師', kind: 'REPORT', content: 'read the rules, waiting' }],
    routedDispatches: new Set<string>(),
    earlyTurnTexts: [] as Array<{ text: string; at: number }>,
    managerKickoffAt: opts.kickoffAt ?? KICKOFF_AT,
    readyReminded: false,
    managerQuietSince: 0,
    finished: false,
    pollHandle: null as number | null,
    watchdogFired: false,
    armedAt: opts.armed === false ? 0 : KICKOFF_AT + 1_000,
  }
  const injected: Array<[string, string]> = []
  const log: string[] = []
  const deps: Record<string, unknown> = {
    pipeline: { state: 'running', stageIndex: 1 },
    paneTurnStartedAt: new Map(opts.turnStartedAt === undefined ? [] : [['mgr', opts.turnStartedAt]]),
    isPaneIdleForMessaging: () => opts.idle ?? true,
    paneBackgroundRunning: () => (opts.background ? opts.background() : false),
    MANAGER_READY_FALLBACK_MS: 180_000,
    MANAGER_READY_REMINDER: `[→ PIPELINE NOTICE]\nYour turn ended without ${MANAGER_READY_SENTINEL}.`,
    stageRouters: new Map([[1, router]]),
    stagesApi: { stages: { value: [{ id: 'storyboard' }, { id: 'illustration' }] } },
    findSentinel,
    MANAGER_READY_SENTINEL,
    TURN_TEXT_REPLAY_TOLERANCE_MS: 60_000,
    ROUTER_POLL_MS: 4_000,
    managerRouterScan: vi.fn(async () => {}),
    window: { setInterval: () => 1 },
    pipelineLog: (line: string) => log.push(line),
    injectPane: vi.fn(async (paneId: string, text: string) => {
      injected.push([paneId, text])
      return opts.injectOk ? opts.injectOk(paneId) : true
    }),
    i18n: { global: { t: (key: string, named?: Record<string, unknown>) => `${key} ${JSON.stringify(named ?? {})}` } },
  }
  const api = new Function(...Object.keys(deps), code)(...Object.values(deps)) as {
    routeManagerTurnText: (paneId: string, text: string, timestamp: string) => Promise<void>
    routeManagerDispatch: (r: typeof router, stageId: string, d: { to: string; message: string }) => Promise<void>
    managerReadyFallback: (r: typeof router, stageId: string) => Promise<void>
    startRouterPoll: (stageIndex: number) => void
  }
  return { api, router, injected, log }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

const reminders = (injected: Array<[string, string]>) =>
  injected.filter(([pane, text]) => pane === 'mgr' && text.includes('PIPELINE NOTICE'))

describe('a Manager reply before the router poll starts is held, not dropped (#539)', () => {
  it('routes a DISPATCH from a reply that arrived before the poll, once the poll starts', async () => {
    const t = await load({ armed: false })
    await t.api.routeManagerTurnText('mgr', dispatchTo('畫師'), new Date().toISOString())
    expect(t.injected.filter(([pane]) => pane === 'w1')).toEqual([])
    expect(t.log.some((l) => l.includes('held'))).toBe(true)
    t.api.startRouterPoll(1)
    await flush()
    const toWorker = t.injected.filter(([pane]) => pane === 'w1')
    expect(toWorker).toHaveLength(1)
    expect(toWorker[0][1]).toContain('先畫第一張角色設定圖')
  })

  it('does not hold a replayed historical turn', async () => {
    const t = await load({ armed: false })
    await t.api.routeManagerTurnText('mgr', dispatchTo('畫師'), '2026-10-20T09:00:00Z')
    t.api.startRouterPoll(1)
    await flush()
    expect(t.injected).toEqual([])
  })

  it('keeps each held turn\'s own time: a turn that ended before the kickoff gets no reminder on replay', async () => {
    const t = await load({ armed: false, kickoffAt: Date.now() - 5_000 })
    await t.api.routeManagerTurnText('mgr', '了解，等待任務。', new Date(Date.now() - 10_000).toISOString())
    t.api.startRouterPoll(1)
    await flush()
    expect(reminders(t.injected)).toEqual([])
    expect(t.router.managerQuietSince).toBe(0)
    expect(t.router.managerReady).toBe(false)
  })

  it('a held turn that ended after the kickoff is reminded on replay', async () => {
    const t = await load({ armed: false, kickoffAt: Date.now() - 5_000 })
    await t.api.routeManagerTurnText('mgr', '讀完守則了。', new Date(Date.now() - 1_000).toISOString())
    t.api.startRouterPoll(1)
    await flush()
    expect(reminders(t.injected)).toHaveLength(1)
  })
})

describe('a Manager turn that ends without READY is reminded, not taken as READY (#539)', () => {
  it('reminds the Manager once and keeps the REPORT held', async () => {
    const t = await load()
    await t.api.routeManagerTurnText('mgr', '讀完守則了，現在進入控場。', iso(30_000))
    expect(t.router.managerReady).toBe(false)
    expect(t.router.preReadyQueue).toHaveLength(1)
    expect(reminders(t.injected)).toHaveLength(1)
    expect(reminders(t.injected)[0][1]).toContain(MANAGER_READY_SENTINEL)
    expect(t.log.some((l) => l.includes('reminded'))).toBe(true)
  })

  it('a multi-turn Phase 1 is not taken as READY, and is reminded only once', async () => {
    const t = await load()
    await t.api.routeManagerTurnText('mgr', '先用 cli_send 問一下資料。', iso(30_000))
    await t.api.routeManagerTurnText('mgr', '背景工作跑完了，繼續畫。', iso(60_000))
    await t.api.routeManagerTurnText('mgr', '還在做我自己的部分。', iso(90_000))
    expect(t.router.managerReady).toBe(false)
    expect(reminders(t.injected)).toHaveLength(1)
    await t.api.routeManagerTurnText('mgr', `做完了\n${MANAGER_READY_SENTINEL}`, iso(120_000))
    expect(t.router.managerReady).toBe(true)
    expect(t.injected.some(([pane, text]) => pane === 'mgr' && text.includes('[→ REPORT FROM 畫師]'))).toBe(true)
  })

  it('a role turn that started before the kickoff and ended after it is not the reply (path a)', async () => {
    const t = await load({ turnStartedAt: KICKOFF_AT - 20_000 })
    await t.api.routeManagerTurnText('mgr', '了解，等待任務。', iso(5_000))
    expect(reminders(t.injected)).toEqual([])
    expect(t.router.managerQuietSince).toBe(0)
    expect(t.router.managerReady).toBe(false)
  })

  it('a late report of a turn that ended before the kickoff changes nothing (path b)', async () => {
    const t = await load()
    await t.api.routeManagerTurnText('mgr', '了解，等待任務。', iso(-3_000))
    expect(reminders(t.injected)).toEqual([])
    expect(t.router.managerQuietSince).toBe(0)
    expect(t.router.managerReady).toBe(false)
  })

  it('nothing counts before the Manager has its kickoff', async () => {
    const t = await load({ kickoffAt: 0 })
    await t.api.routeManagerTurnText('mgr', '了解，等待任務。', iso(30_000))
    expect(reminders(t.injected)).toEqual([])
  })

  it('an empty-text turn end changes nothing', async () => {
    const t = await load()
    await t.api.routeManagerTurnText('mgr', '', iso(30_000))
    expect(t.router.managerReady).toBe(false)
    expect(t.injected).toEqual([])
  })
})

describe('the idle fallback hands held messages to a Manager that never prints READY (#539)', () => {
  it('after 180s idle with messages held, says so to the Manager, then hands them over', async () => {
    const t = await load()
    await t.api.routeManagerTurnText('mgr', '讀完守則了。', iso(30_000))
    t.router.managerQuietSince = Date.now() - 181_000
    const before = t.injected.length
    await t.api.managerReadyFallback(t.router, 'illustration')
    expect(t.router.managerReady).toBe(true)
    const after = t.injected.slice(before)
    expect(after.map(([pane]) => pane)).toEqual(['mgr', 'mgr'])
    expect(after[0][1]).toContain('[→ PIPELINE NOTICE]')
    expect(after[0][1]).toContain(`No ${MANAGER_READY_SENTINEL} was seen`)
    expect(after[0][1]).toContain('timeout fallback')
    expect(after[0][1]).toContain('1 held message(s)')
    expect(after[1][1]).toContain('[→ REPORT FROM 畫師]')
    expect(t.log.some((l) => l.includes('timeout fallback') && l.includes('1 held message(s)'))).toBe(true)
    expect(t.log.some((l) => l.includes('READY') && l.includes('fallback'))).toBe(true)
  })

  it('not before 180s', async () => {
    const t = await load()
    await t.api.routeManagerTurnText('mgr', '讀完守則了。', iso(30_000))
    t.router.managerQuietSince = Date.now() - 179_000
    await t.api.managerReadyFallback(t.router, 'illustration')
    expect(t.router.managerReady).toBe(false)
  })

  it('not while the Manager is busy again', async () => {
    const t = await load({ idle: false })
    await t.api.routeManagerTurnText('mgr', '讀完守則了。', iso(30_000))
    t.router.managerQuietSince = Date.now() - 200_000
    await t.api.managerReadyFallback(t.router, 'illustration')
    expect(t.router.managerReady).toBe(false)
  })

  it('not while the Manager waits on its own background work, and once that work is done', async () => {
    let running = true
    const t = await load({ background: () => running })
    await t.api.routeManagerTurnText('mgr', '背景工作跑著，等它回來。', iso(30_000))
    t.router.managerQuietSince = Date.now() - 200_000
    await t.api.managerReadyFallback(t.router, 'illustration')
    expect(t.router.managerReady).toBe(false)
    expect(t.injected.some(([, text]) => text.includes('timeout fallback'))).toBe(false)
    running = false
    await t.api.managerReadyFallback(t.router, 'illustration')
    expect(t.router.managerReady).toBe(true)
    expect(t.injected.some(([, text]) => text.includes('timeout fallback'))).toBe(true)
  })

  it('not when no message is held', async () => {
    const t = await load()
    t.router.preReadyQueue = []
    await t.api.routeManagerTurnText('mgr', '讀完守則了。', iso(30_000))
    t.router.managerQuietSince = Date.now() - 200_000
    await t.api.managerReadyFallback(t.router, 'illustration')
    expect(t.router.managerReady).toBe(false)
  })

  it('not for a Manager that never ended a turn after its kickoff', async () => {
    const t = await load()
    await t.api.managerReadyFallback(t.router, 'illustration')
    expect(t.router.managerReady).toBe(false)
  })

  it('the router poll runs the fallback, and both kickoff paths record the Manager\'s kickoff time', () => {
    const scan = functionSource('managerRouterScan')
    expect(scan).toContain('await managerReadyFallback(router, stage.id)')
    const activate = appSource.slice(appSource.indexOf('async function activateStage('), appSource.indexOf('\nasync function spawnPipelineStage('))
    expect(activate).toContain('router.managerKickoffAt = ok ? Date.now() : 0')
    const schedule = appSource.slice(appSource.indexOf('function scheduleInjection(pane: ActivePane): void {'), appSource.indexOf('\ninterface SpawnInternal'))
    expect(schedule).toContain('managerRouter.managerKickoffAt = Date.now()')
  })
})

describe('a DISPATCH that cannot be delivered is reported to the Manager (#539)', () => {
  it('tells the Manager when no slot matches the target, naming the slots it can use', async () => {
    const t = await load()
    t.router.managerReady = true
    t.router.preReadyQueue = []
    await t.api.routeManagerTurnText('mgr', dispatchTo('配色師'), iso(30_000))
    const toManager = t.injected.filter(([pane]) => pane === 'mgr')
    expect(toManager).toHaveLength(1)
    expect(toManager[0][1]).toContain('NOT DELIVERED')
    expect(toManager[0][1]).toContain('配色師')
    expect(toManager[0][1]).toContain('畫師')
    expect(toManager[0][1]).toContain('審稿')
  })

  it('tells the Manager and logs it when the injection into the worker fails, and a resend is routed', async () => {
    let workerOk = false
    const t = await load({ injectOk: (pane) => pane !== 'w1' || workerOk })
    t.router.managerReady = true
    t.router.preReadyQueue = []
    await t.api.routeManagerTurnText('mgr', dispatchTo('畫師'), iso(30_000))
    expect(t.injected.some(([pane, text]) => pane === 'mgr' && text.includes('NOT DELIVERED') && text.includes('畫師'))).toBe(true)
    expect(t.log.some((l) => l.includes('畫師') && l.includes('not delivered'))).toBe(true)
    workerOk = true
    await t.api.routeManagerTurnText('mgr', dispatchTo('畫師'), iso(40_000))
    expect(t.injected.filter(([pane]) => pane === 'w1')).toHaveLength(2)
  })

  it('a delivered DISPATCH sends the Manager nothing', async () => {
    const t = await load()
    t.router.managerReady = true
    t.router.preReadyQueue = []
    await t.api.routeManagerTurnText('mgr', dispatchTo('畫師'), iso(30_000))
    expect(t.injected.filter(([pane]) => pane === 'mgr')).toEqual([])
  })
})

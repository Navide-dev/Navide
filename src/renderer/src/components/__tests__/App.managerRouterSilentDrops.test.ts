// @vitest-environment happy-dom
// #539 follow-up: three ways the stage router still lost a Manager's
// coordination without a word, each leaving every pane of the stage idle while
// the run showed `running`.
//
// 1. A reply that arrived before the router poll started (the poll waits for
//    every slot's kickoff) was returned from unread: a DISPATCH in it was gone.
// 2. A Manager that ended its turn without ---MANAGER-READY--- and without a
//    DISPATCH left the workers' REPORTs held for a line it would never print.
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

async function load(opts: { armed?: boolean; injectOk?: (paneId: string) => boolean; managerKickoff?: string } = {}) {
  const names = [
    'parseDispatchBlocks', 'matchWorkerByLabel', 'injectManagerPane', 'markManagerReady',
    'routeManagerDispatch', 'routeManagerTurnText', 'startRouterPoll',
  ]
  const { code } = await transformWithEsbuild(
    `const DISPATCH_RE = /---DISPATCH-START---([\\s\\S]*?)---DISPATCH-END---/g\n${names.map(functionSource).join('\n')}\nreturn { routeManagerTurnText, routeManagerDispatch, startRouterPoll }`,
    'AppManagerRouterSilentDrops.ts',
    { loader: 'ts' },
  )
  const router = {
    managerPaneId: 'mgr',
    workerPaneIds: new Map([['畫師', 'w1'], ['審稿', 'w2']]),
    managerReady: false,
    preReadyQueue: [{ fromLabel: '畫師', kind: 'REPORT', content: 'read the rules, waiting' }],
    routedDispatches: new Set<string>(),
    earlyTurnTexts: [] as string[],
    finished: false,
    pollHandle: null as number | null,
    watchdogFired: false,
    armedAt: opts.armed === false ? 0 : Date.now() - 1_000,
  }
  const injected: Array<[string, string]> = []
  const log: string[] = []
  const deps: Record<string, unknown> = {
    pipeline: { state: 'running', stageIndex: 1 },
    panes: { value: [{ id: 'mgr', kickoffStatus: opts.managerKickoff ?? 'sent' }, { id: 'w1', kickoffStatus: 'sent' }] },
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
    startRouterPoll: (stageIndex: number) => void
  }
  return { api, router, injected, log }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

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
})

describe('a Manager turn that ends without READY releases the held messages (#539)', () => {
  it('treats the end of the turn as READY and hands over the held REPORT', async () => {
    const t = await load()
    await t.api.routeManagerTurnText('mgr', '讀完守則了，現在進入控場。', new Date().toISOString())
    expect(t.router.managerReady).toBe(true)
    expect(t.router.preReadyQueue).toHaveLength(0)
    expect(t.injected.some(([pane, text]) => pane === 'mgr' && text.includes('[→ REPORT FROM 畫師]'))).toBe(true)
    expect(t.log.some((l) => l.includes('READY') && l.includes('turn ended'))).toBe(true)
  })

  it('a turn before the Manager has its kickoff (the role acknowledgement) holds on', async () => {
    const t = await load({ managerKickoff: 'pending' })
    await t.api.routeManagerTurnText('mgr', '了解，等待任務。', new Date().toISOString())
    expect(t.router.managerReady).toBe(false)
    expect(t.router.preReadyQueue).toHaveLength(1)
    expect(t.injected).toEqual([])
  })

  it('an empty-text turn end changes nothing', async () => {
    const t = await load()
    await t.api.routeManagerTurnText('mgr', '', new Date().toISOString())
    expect(t.router.managerReady).toBe(false)
    expect(t.injected).toEqual([])
  })
})

describe('a DISPATCH that cannot be delivered is reported to the Manager (#539)', () => {
  it('tells the Manager when no slot matches the target, naming the slots it can use', async () => {
    const t = await load()
    t.router.managerReady = true
    t.router.preReadyQueue = []
    await t.api.routeManagerTurnText('mgr', dispatchTo('配色師'), new Date().toISOString())
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
    await t.api.routeManagerTurnText('mgr', dispatchTo('畫師'), new Date().toISOString())
    expect(t.injected.some(([pane, text]) => pane === 'mgr' && text.includes('NOT DELIVERED') && text.includes('畫師'))).toBe(true)
    expect(t.log.some((l) => l.includes('畫師') && l.includes('not delivered'))).toBe(true)
    workerOk = true
    await t.api.routeManagerTurnText('mgr', dispatchTo('畫師'), new Date().toISOString())
    expect(t.injected.filter(([pane]) => pane === 'w1')).toHaveLength(2)
  })

  it('a delivered DISPATCH sends the Manager nothing', async () => {
    const t = await load()
    t.router.managerReady = true
    t.router.preReadyQueue = []
    await t.api.routeManagerTurnText('mgr', dispatchTo('畫師'), new Date().toISOString())
    expect(t.injected.filter(([pane]) => pane === 'mgr')).toEqual([])
  })
})

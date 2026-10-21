// @vitest-environment happy-dom
// #539: a stage-2 Manager printed a DISPATCH for 畫師 and ended its turn. The
// stage router reads DISPATCH only from the Manager's screen buffer, and that
// block never parsed there, so it was dropped without a log line. The workers'
// REPORTs meanwhile sat in the pre-READY queue, since the Manager had not
// printed ---MANAGER-READY---. All three panes went idle and the stage stayed
// `running`.
//
// The Manager's reply text (turn_complete) now feeds the same routing: a
// DISPATCH in it reaches its worker once, however many times screen and reply
// both carry it, and a DISPATCH implies READY, so the held REPORTs go out.
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

const DISPATCH = [
  '畫好了分鏡的解讀，現在進入控場。',
  '---DISPATCH-START---',
  'to: 畫師',
  'message: 先畫第一張角色設定圖（豆豆），完成後回報。',
  '---DISPATCH-END---',
].join('\n')

async function load() {
  const names = ['parseDispatchBlocks', 'matchWorkerByLabel', 'injectManagerPane', 'markManagerReady', 'routeManagerDispatch', 'routeManagerTurnText']
  const { code } = await transformWithEsbuild(
    `const DISPATCH_RE = /---DISPATCH-START---([\\s\\S]*?)---DISPATCH-END---/g\n${names.map(functionSource).join('\n')}\nreturn { routeManagerTurnText, routeManagerDispatch }`,
    'AppManagerDispatch.ts',
    { loader: 'ts' },
  )
  const router = {
    managerPaneId: 'mgr',
    workerPaneIds: new Map([['畫師', 'w1'], ['審稿', 'w2']]),
    managerReady: false,
    preReadyQueue: [{ fromLabel: '畫師', kind: 'REPORT', content: 'read the rules, waiting' }],
    routedDispatches: new Set<string>(),
    finished: false,
    armedAt: Date.parse('2026-10-21T01:37:02Z'),
  }
  const injected: Array<[string, string]> = []
  const log: string[] = []
  const deps: Record<string, unknown> = {
    pipeline: { state: 'running', stageIndex: 1 },
    stageRouters: new Map([[1, router]]),
    stagesApi: { stages: { value: [{ id: 'storyboard' }, { id: 'illustration' }] } },
    findSentinel,
    MANAGER_READY_SENTINEL,
    TURN_TEXT_REPLAY_TOLERANCE_MS: 60_000,
    pipelineLog: (line: string) => log.push(line),
    injectPane: vi.fn(async (paneId: string, text: string) => { injected.push([paneId, text]); return true }),
    i18n: { global: { t: (key: string) => key } },
  }
  const api = new Function(...Object.keys(deps), code)(...Object.values(deps)) as {
    routeManagerTurnText: (paneId: string, text: string, timestamp: string) => Promise<void>
    routeManagerDispatch: (r: typeof router, stageId: string, d: { to: string; message: string }) => Promise<void>
  }
  return { api, router, injected, log }
}

describe('a Manager DISPATCH in its reply reaches the worker (#539)', () => {
  it('routes a DISPATCH from the reply text to its worker', async () => {
    const t = await load()
    await t.api.routeManagerTurnText('mgr', DISPATCH, '2026-10-21T01:38:00Z')
    const toWorker = t.injected.filter(([pane]) => pane === 'w1')
    expect(toWorker).toHaveLength(1)
    expect(toWorker[0][1]).toContain('[→ DISPATCH FROM Manager]')
    expect(toWorker[0][1]).toContain('先畫第一張角色設定圖')
  })

  it('a DISPATCH before MANAGER-READY implies it and releases the held REPORTs', async () => {
    const t = await load()
    await t.api.routeManagerTurnText('mgr', DISPATCH, '2026-10-21T01:38:00Z')
    expect(t.router.managerReady).toBe(true)
    expect(t.router.preReadyQueue).toHaveLength(0)
    expect(t.injected.some(([pane, text]) => pane === 'mgr' && text.includes('[→ REPORT FROM 畫師]'))).toBe(true)
    expect(t.log.some((l) => l.includes('READY') && l.includes('DISPATCH'))).toBe(true)
  })

  it('a block the screen already routed is not sent a second time', async () => {
    const t = await load()
    // The screen copy: wrapped and indented by the TUI.
    await t.api.routeManagerDispatch(t.router, 'illustration', { to: '畫師', message: '先畫第一張角色設定圖（豆豆），\n  完成後回報。' })
    await t.api.routeManagerTurnText('mgr', DISPATCH, '2026-10-21T01:38:00Z')
    expect(t.injected.filter(([pane]) => pane === 'w1')).toHaveLength(1)
  })

  it('MANAGER-READY in the reply releases the held REPORTs', async () => {
    const t = await load()
    await t.api.routeManagerTurnText('mgr', `my part is done\n${MANAGER_READY_SENTINEL}`, '2026-10-21T01:38:00Z')
    expect(t.router.managerReady).toBe(true)
    expect(t.injected.some(([pane]) => pane === 'mgr')).toBe(true)
  })

  it('ignores a worker pane, a replayed old turn and a finished stage', async () => {
    const t = await load()
    await t.api.routeManagerTurnText('w1', DISPATCH, '2026-10-21T01:38:00Z')
    await t.api.routeManagerTurnText('mgr', DISPATCH, '2026-10-20T09:00:00Z')
    t.router.finished = true
    await t.api.routeManagerTurnText('mgr', DISPATCH, '2026-10-21T01:38:00Z')
    expect(t.injected).toEqual([])
    expect(t.router.managerReady).toBe(false)
  })

  it('every turn end hands the reply to the router, and the screen scan shares the routing', () => {
    const scan = functionSource('managerRouterScan')
    expect(scan.includes('await routeManagerDispatch(router, stage.id, d)')).toBe(true)
    expect(appSource.includes("void routeManagerTurnText(ev.pane_id, ev.text ?? '', ev.timestamp ?? '')")).toBe(true)
  })
})

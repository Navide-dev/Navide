// @vitest-environment happy-dom
// #539 follow-up: a pipeline with one commander makes that commander the global
// Manager too (deriveGlobalManager), so the global router and the commander's
// stage router scanned the same panes. The global router forwarded a worker's
// REPORT to the Manager at once, past the stage router's pre-READY queue (the
// reporter's "01:37:12 🎯 Global → Manager: [REPORT from 畫師]" came before
// READY), and the queued copy followed at READY. A Manager DISPATCH that parsed
// was injected by both routers. The stage router owns its own stage; the global
// router keeps routing only what crosses stages.
//
// App.vue cannot be mounted here, so the scan is lifted out, compiled and run
// against stubs passed by name.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { transformWithEsbuild } from 'vite'

const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function functionSource(name: string): string {
  const start = appSource.search(new RegExp(`(?:async )?function ${name}\\(`))
  expect(start, `${name} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf('\n}\n', start)
  return appSource.slice(start, end + 2)
}

function constLine(name: string): string {
  const m = appSource.match(new RegExp(`^const ${name} = .*$`, 'm'))
  expect(m, `${name} should exist`).not.toBeNull()
  return m![0]
}

const REPORT = '---REPORT-START---\ncontent: read the rules, waiting for the dispatch\n---REPORT-END---'
const DISPATCH = '---DISPATCH-START---\nto: 畫師\nmessage: draw the first character sheet\n---DISPATCH-END---'

async function load(opts: { managerOwnsStage: boolean }) {
  const { code } = await transformWithEsbuild(
    [
      constLine('DISPATCH_RE'), constLine('ASK_RE'), constLine('REPORT_RE'),
      functionSource('parseContentBlocks'), functionSource('parseDispatchBlocks'),
      functionSource('globalManagerRouterScan'),
      'return globalManagerRouterScan',
    ].join('\n'),
    'AppGlobalRouter.ts',
    { loader: 'ts' },
  )
  const pane = (id: string, stageId: string, slotLabel: string) => ({ id, stageId, slotLabel, realized: true, origin: 'pipeline' })
  const panes = [
    pane('mgr', 'illustration', '導演'),
    pane('w1', 'illustration', '畫師'),
    pane('w2', 'illustration', '審稿'),
    pane('old', 'storyboard', '前期導演'),
  ]
  const paneRefs: Record<string, { cleanBuffer: string }> = {
    mgr: { cleanBuffer: DISPATCH },
    w1: { cleanBuffer: REPORT },
    w2: { cleanBuffer: '' },
    old: { cleanBuffer: REPORT },
  }
  const stageRouters = new Map([[1, {
    managerPaneId: opts.managerOwnsStage ? 'mgr' : 'other',
    workerPaneIds: new Map([['畫師', 'w1'], ['審稿', 'w2']]),
  }]])
  const injected: Array<[string, string]> = []
  const deps: Record<string, unknown> = {
    pipeline: { state: 'running', stageIndex: 1, globalManager: { stageId: 'illustration', slotLabel: '導演' } },
    globalManagerPaneId: () => 'mgr',
    panes: { value: panes },
    paneRefs,
    stageRouters,
    rebaseGlobalRouterCursor: () => {},
    globalRouterCursors: new Map<string, number>(),
    pipelineLog: () => {},
    injectPane: vi.fn(async (paneId: string, text: string) => { injected.push([paneId, text]); return true }),
    i18n: { global: { t: (key: string) => key } },
    _globalScanRunning: false,
  }
  const scan = new Function(...Object.keys(deps), code)(...Object.values(deps)) as () => Promise<void>
  return { scan, injected }
}

describe('the global router leaves the stage its Manager also runs (#539)', () => {
  it('does not forward that stage\'s worker REPORTs past the stage router', async () => {
    const t = await load({ managerOwnsStage: true })
    await t.scan()
    expect(t.injected.some(([pane, text]) => pane === 'mgr' && text.includes('FROM 畫師'))).toBe(false)
  })

  it('does not inject a DISPATCH the stage router routes', async () => {
    const t = await load({ managerOwnsStage: true })
    await t.scan()
    expect(t.injected.some(([pane]) => pane === 'w1')).toBe(false)
  })

  it('still routes a worker of another stage to the global Manager', async () => {
    const t = await load({ managerOwnsStage: true })
    await t.scan()
    expect(t.injected.some(([pane, text]) => pane === 'mgr' && text.includes('FROM 前期導演'))).toBe(true)
  })

  it('routes the stage as before when its stage router has another Manager', async () => {
    const t = await load({ managerOwnsStage: false })
    await t.scan()
    expect(t.injected.some(([pane, text]) => pane === 'mgr' && text.includes('FROM 畫師'))).toBe(true)
    expect(t.injected.some(([pane]) => pane === 'w1')).toBe(true)
  })
})

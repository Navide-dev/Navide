// @vitest-environment happy-dom
// #448 (0.2.27 re-test): {{prev.summary}} carried a scrape of the upstream
// slot's terminal — spinners, the QUESTION block repeated, status and "Tip:"
// lines — because a finished slot's summary was the tail of its screen buffer.
// It is now the slot's own last reply when its reader reports one; the screen
// tail stays only for a vendor with no turn text.
//
// App.vue cannot be mounted here, so the function is lifted out, compiled and
// run against stubs passed by name.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { transformWithEsbuild } from 'vite'

const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function functionSource(name: string): string {
  const start = appSource.indexOf(`function ${name}(`)
  expect(start, `${name} should exist`).toBeGreaterThan(-1)
  const end = appSource.indexOf('\n}\n', start)
  return appSource.slice(start, end + 2)
}

const SCREEN = '✻Churned for 1m 27s · done ❯ ·Perambulating… ⎿ Tip: Share Claude Code'

async function load() {
  const { code } = await transformWithEsbuild(
    `${functionSource('slotSummarySource')}\nreturn slotSummarySource`,
    'AppPrevSummary.ts',
    { loader: 'ts' },
  )
  const deps: Record<string, unknown> = {
    paneLastReply: new Map<string, { text: string; at: number }>(),
    paneArmedAt: new Map<string, number>(),
    stageRouters: new Map<number, { armedAt: number }>(),
    paneRefs: { p1: { cleanBuffer: SCREEN } },
  }
  const fn = new Function(...Object.keys(deps), code)(...Object.values(deps)) as (paneId: string, stageIndex: number) => string
  return { fn, ...(deps as {
    paneLastReply: Map<string, { text: string; at: number }>
    paneArmedAt: Map<string, number>
    stageRouters: Map<number, { armedAt: number }>
  }) }
}

describe('{{prev.summary}} is the upstream slot\'s reply, not its screen (#448)', () => {
  it('uses the reply the slot gave after it was armed', async () => {
    const t = await load()
    t.paneArmedAt.set('p1', 1000)
    t.paneLastReply.set('p1', { text: '分鏡完成，共 12 頁。', at: 2000 })
    expect(t.fn('p1', 0)).toBe('分鏡完成，共 12 頁。')
  })

  it('uses it for a Manager-mode slot, which is armed by the stage router', async () => {
    const t = await load()
    t.stageRouters.set(1, { armedAt: 1000 })
    t.paneLastReply.set('p1', { text: 'done', at: 2000 })
    expect(t.fn('p1', 1)).toBe('done')
  })

  it('a pane kept from an earlier stage is judged by this stage\'s arm', async () => {
    const t = await load()
    t.paneArmedAt.set('p1', 1000) // the earlier stage's watcher
    t.stageRouters.set(1, { armedAt: 5000 })
    t.paneLastReply.set('p1', { text: 'stage 1 reply', at: 2000 })
    expect(t.fn('p1', 1)).toBe(SCREEN)
  })

  it('ignores a reply from an earlier task and falls back to the screen', async () => {
    const t = await load()
    t.paneArmedAt.set('p1', 5000)
    t.paneLastReply.set('p1', { text: 'role acknowledged', at: 2000 })
    expect(t.fn('p1', 0)).toBe(SCREEN)
  })

  it('keeps the screen tail for a vendor that reports no turn text', async () => {
    const t = await load()
    t.paneArmedAt.set('p1', 1000)
    expect(t.fn('p1', 0)).toBe(SCREEN)
  })

  it('a finished slot is summarised from it, and every turn end records the reply', () => {
    const finish = appSource.slice(appSource.indexOf('function onStageSlotCompleted('))
    expect(finish.slice(0, finish.indexOf('\n}\n')).includes('slotSummarySource(paneId, stageIndex)')).toBe(true)
    expect(appSource.includes('paneLastReply.set(ev.pane_id,')).toBe(true)
  })
})

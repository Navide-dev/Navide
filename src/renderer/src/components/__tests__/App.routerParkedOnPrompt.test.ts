// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { transformWithEsbuild } from 'vite'
import { describe, expect, it, vi } from 'vitest'
import { createParkedDelivery, waitUntilTurnEnds } from '../../lib/pipelineDelivery'

// 0.2.37 VM round, the run-time half of the resume bug: the stage router types
// ASK / REPORT / DISPATCH / handoff / reminder text into panes, and text typed
// into a pane parked on Claude's permission box presses Enter on "❯ 1. Yes".
// Router text now waits for the prompt to be answered, then goes out once.

const appSource = readFileSync(resolve(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')

function fn(name: string): string {
  const re = new RegExp(`\\n(async )?function ${name}\\(`)
  const m = re.exec(appSource)
  expect(m, `${name} should exist`).not.toBeNull()
  const start = m!.index + 1
  const end = appSource.indexOf('\n}\n', start)
  return appSource.slice(start, end + 2)
}

/** App.vue's real queueOrRouteWorkerMsg / injectManagerPane / markManagerReady,
 *  wired to the real delivery queue over a spy that stands for the PTY. */
async function loadRouter(parked: { value: boolean }) {
  const typed: string[] = []
  const injectPane = vi.fn(async (_paneId: string, text: string, _label?: string) => { typed.push(text); return true })
  const routerDeliveries = createParkedDelivery({
    parked: () => parked.value,
    alive: () => true,
    send: (paneId, text, label) => injectPane(paneId, text, label),
    setInterval: () => 1,
    clearInterval: () => {},
  })
  const routerInject = (paneId: string, text: string, label: string, awaitDelivery = false) =>
    routerDeliveries.deliver(paneId, text, label, { awaitDelivery })
  const { code } = await transformWithEsbuild(
    `${fn('queueOrRouteWorkerMsg')}\n${fn('injectManagerPane')}\n${fn('markManagerReady')}\n` +
      'return { queueOrRouteWorkerMsg, injectManagerPane, markManagerReady }',
    'AppRouter.ts',
    { loader: 'ts' },
  )
  const api = new Function('injectPane', 'routerInject', 'pipelineLog', 'i18n', 'paneTurnStartedAt', code)(
    injectPane, routerInject, () => {}, { global: { t: () => '' } }, new Map(),
  ) as {
    queueOrRouteWorkerMsg: (router: unknown, stageId: string, msg: unknown) => void
    markManagerReady: (router: unknown, stageId: string, how: string) => Promise<void>
  }
  return { api, typed, injectPane, routerDeliveries }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('the stage router never types into a pane parked on a CLI prompt', () => {
  it('holds an ASK while the box is up, then sends it once after the user answers', async () => {
    const parked = { value: true }
    const { api, typed, routerDeliveries } = await loadRouter(parked)
    const router = { managerPaneId: 'mgr', managerReady: true, preReadyQueue: [], routedWorkerMessages: new Set<string>(), workerPaneIds: new Map() }
    api.queueOrRouteWorkerMsg(router, '01', { kind: 'ASK', fromLabel: 'fe', content: 'which API?' })
    await flush()
    await routerDeliveries.drain()
    expect(typed).toEqual([])
    parked.value = false
    await Promise.all([routerDeliveries.drain(), routerDeliveries.drain()])
    await routerDeliveries.drain()
    expect(typed).toEqual(['[→ ASK FROM fe]\nwhich API?'])
  })

  it('keeps the held messages in order when the Manager turns READY on a box', async () => {
    const parked = { value: true }
    const { api, typed, routerDeliveries } = await loadRouter(parked)
    const router = {
      managerPaneId: 'mgr',
      managerReady: false,
      preReadyQueue: [
        { kind: 'REPORT', fromLabel: 'fe', content: 'one' },
        { kind: 'REPORT', fromLabel: 'be', content: 'two' },
      ],
    }
    await api.markManagerReady(router, '01', '')
    expect(typed).toEqual([])
    parked.value = false
    await routerDeliveries.drain()
    expect(typed).toEqual(['[→ REPORT FROM fe]\none', '[→ REPORT FROM be]\ntwo'])
  })

  it('every router send in App.vue goes through the held queue', () => {
    for (const name of [
      'injectManagerPane', 'routeManagerDispatch', 'routeManagerTurnText',
      'managerReadyFallback', 'globalManagerRouterScan', 'onStageSlotCompleted',
    ]) {
      const body = fn(name)
      expect(body, `${name} types straight into a pane`).not.toMatch(/\binjectPane\(/)
    }
    for (const name of ['injectManagerPane', 'routeManagerDispatch', 'routeManagerTurnText', 'managerReadyFallback', 'globalManagerRouterScan', 'onStageSlotCompleted']) {
      expect(fn(name), name).toContain('routerInject(')
    }
    // The handoff waits for its real delivery: the scan-window advance after it
    // must follow the echo, not the queueing.
    expect(fn('onStageSlotCompleted')).toContain('await routerInject(sibling.id, handoffMsg, `handoff:${fromLabel}→${toLabel}`, true)')
    expect(fn('routerInject')).toContain('routerDeliveries.deliver(')
    expect(appSource).toMatch(/parked: \(paneId\) => paneParkedOnPrompt\(paneId\)/)
  })

  it('a run that ends drops what it still held', () => {
    expect(fn('tearDownPipelineOrchestration')).toContain('routerDeliveries.clear()')
  })
})

describe('createParkedDelivery', () => {
  const make = (parked: { value: boolean }, alive = { value: true }) => {
    const send = vi.fn(async (_paneId: string, _text: string, _label: string) => true)
    const onDropped = vi.fn()
    const timers = { set: 0, cleared: 0 }
    const q = createParkedDelivery({
      parked: () => parked.value,
      alive: () => alive.value,
      send,
      onDropped,
      setInterval: () => { timers.set++; return 7 },
      clearInterval: () => { timers.cleared++ },
    })
    return { q, send, onDropped, timers }
  }

  it('sends at once to a pane that is not parked', async () => {
    const { q, send, timers } = make({ value: false })
    expect(await q.deliver('p', 'hi', 'ask')).toBe(true)
    expect(send).toHaveBeenCalledWith('p', 'hi', 'ask')
    expect(timers.set).toBe(0)
  })

  it('queues behind a held message even once the prompt is gone, so order holds', async () => {
    const parked = { value: true }
    const { q, send } = make(parked)
    await q.deliver('p', 'first', 'a')
    parked.value = false
    await q.deliver('p', 'second', 'b')
    expect(send).not.toHaveBeenCalled()
    await q.drain()
    expect(send.mock.calls.map((c) => c[1])).toEqual(['first', 'second'])
    expect(q.pending('p')).toBe(0)
  })

  it('awaitDelivery resolves when the text is actually typed', async () => {
    const parked = { value: true }
    const { q, send } = make(parked)
    let done = false
    const sent = q.deliver('p', 'handoff', 'h', { awaitDelivery: true }).then((v) => { done = true; return v })
    await flush()
    expect(done).toBe(false)
    parked.value = false
    await q.drain()
    expect(await sent).toBe(true)
    expect(send).toHaveBeenCalledOnce()
  })

  it('stops the poll once the queue is empty', async () => {
    const parked = { value: true }
    const { q, timers } = make(parked)
    await q.deliver('p', 'x', 'a')
    expect(timers.set).toBe(1)
    parked.value = false
    await q.drain()
    expect(timers.cleared).toBe(1)
  })

  it('a pane that closed while it waited is reported, never typed into', async () => {
    const alive = { value: true }
    const { q, send, onDropped } = make({ value: true }, alive)
    const sent = q.deliver('p', 'x', 'ask', { awaitDelivery: true })
    alive.value = false
    await q.drain()
    expect(await sent).toBe(false)
    expect(send).not.toHaveBeenCalled()
    expect(onDropped).toHaveBeenCalledWith('p', 'ask')
  })

  it('clear() while a send is in flight: the next held message is never sent', async () => {
    // A run ending mid-drain must not leak its remaining ASK / DISPATCH into
    // the run that resumes after it.
    const parked = { value: true }
    let release: (ok: boolean) => void = () => {}
    const typed: string[] = []
    const q = createParkedDelivery({
      parked: () => parked.value,
      alive: () => true,
      send: (_paneId, text) => {
        typed.push(text)
        return text === 'first' ? new Promise<boolean>((r) => { release = r }) : Promise.resolve(true)
      },
      setInterval: () => 1,
      clearInterval: () => {},
    })
    const first = q.deliver('p', 'first', 'a', { awaitDelivery: true })
    const second = q.deliver('p', 'second', 'b', { awaitDelivery: true })
    parked.value = false
    const draining = q.drain()
    await flush()
    expect(typed).toEqual(['first'])
    q.clear()
    release(true)
    await draining
    await q.drain()
    expect(typed).toEqual(['first'])
    expect(await second).toBe(false)
    // Settled once, by clear(); the late send result does not settle it again.
    expect(await first).toBe(false)
    expect(q.pending('p')).toBe(0)
  })

  it('clear() drops everything still held', async () => {
    const parked = { value: true }
    const { q, send } = make(parked)
    const sent = q.deliver('p', 'x', 'a', { awaitDelivery: true })
    q.clear()
    parked.value = false
    await q.drain()
    expect(await sent).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })
})

describe('waitUntilTurnEnds', () => {
  const base = { alive: () => true, stillWanted: () => true, parked: () => false }

  it('returns once the turn is over', async () => {
    let polls = 0
    const r = await waitUntilTurnEnds({ ...base, busy: () => polls < 3, sleep: async () => { polls++ } })
    expect(r).toBe('idle')
    expect(polls).toBe(3)
  })

  it('reports a prompt that comes up while it waits', async () => {
    let polls = 0
    const r = await waitUntilTurnEnds({ ...base, busy: () => true, parked: () => polls > 1, sleep: async () => { polls++ } })
    expect(r).toBe('parked')
  })

  it('gives up when the pane dies or the run moves on', async () => {
    expect(await waitUntilTurnEnds({ ...base, busy: () => true, alive: () => false, sleep: async () => {} })).toBe('gone')
    expect(await waitUntilTurnEnds({ ...base, busy: () => true, stillWanted: () => false, sleep: async () => {} })).toBe('moved-on')
  })
})

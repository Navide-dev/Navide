// @vitest-environment happy-dom
// useEvolve: the per-workspace badge map, the evolve.* RPC helpers, and the
// evolve.notice → announcements centre bridge.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import type { useBackend } from '../useBackend'
import {
  __resetEvolveForTest,
  evolveBadgeLabel,
  evolveBadgeState,
  evolveGet,
  evolveRunNow,
  evolveSet,
  isEvolveSystemPane,
  openEvolvePanel,
  refreshEvolveBadges,
  useEvolve,
  useEvolveBadges,
  type EvolveBadge,
  type EvolveRun,
} from '../useEvolve'
import { __resetEvolveAnnouncementsForTest, useAnnouncements } from '../useAnnouncements'

const A = '/Users/me/alpha'
const B = '/Users/me/beta'

const badge = (over: Partial<EvolveBadge> = {}): EvolveBadge => ({
  enabled: false,
  running: false,
  running_since: null,
  next_run_at: null,
  last_status: null,
  ...over,
})

const run = (over: Partial<EvolveRun> = {}): EvolveRun => ({
  id: 'r1',
  trigger: 'schedule',
  status: 'ok',
  started_at: 1_900_000_000_000,
  ended_at: null,
  pane_id: 'pane-1',
  pane_name: '自我優化-1009',
  agent: 'claude',
  tokens: 142_000,
  commits: [{ hash: 'a1b2c3d4', title: 'fix(x): y' }],
  proposals: [],
  reclaimed: true,
  ...over,
})

const calls: { type: string; payload: Record<string, unknown> }[] = []
const listeners = new Map<string, Set<(p: unknown) => void>>()
let replies: Record<string, unknown> = {}

function fakeBackend(status = 'connected'): ReturnType<typeof useBackend> {
  return {
    status: ref(status),
    send: vi.fn(async (type: string, payload: Record<string, unknown> = {}) => {
      calls.push({ type, payload })
      const body = replies[type] ?? { ok: true }
      return { id: 'r', type, ok: true, payload: body, error: null, timestamp: '' }
    }),
    on: (type: string, cb: (p: unknown) => void) => {
      let set = listeners.get(type)
      if (!set) listeners.set(type, (set = new Set()))
      set.add(cb)
      return () => set!.delete(cb)
    },
  } as unknown as ReturnType<typeof useBackend>
}

function emit(type: string, payload: unknown): void {
  for (const cb of listeners.get(type) ?? []) cb(payload)
}

describe('useEvolve', () => {
  let scope: ReturnType<typeof effectScope>

  beforeEach(() => {
    i18n.global.locale.value = 'zh-TW'
    calls.length = 0
    listeners.clear()
    replies = {}
    __resetEvolveForTest()
    __resetEvolveAnnouncementsForTest()
    scope = effectScope()
  })
  afterEach(() => scope.stop())

  it('colours the badge: running > failed (enabled only) > on > off', () => {
    expect(evolveBadgeState(undefined)).toBe('off')
    expect(evolveBadgeState(badge())).toBe('off')
    expect(evolveBadgeState(badge({ enabled: true }))).toBe('on')
    expect(evolveBadgeState(badge({ enabled: true, last_status: 'error' }))).toBe('failed')
    expect(evolveBadgeState(badge({ enabled: true, last_status: 'timeout' }))).toBe('failed')
    expect(evolveBadgeState(badge({ enabled: false, last_status: 'error' }))).toBe('off')
    expect(evolveBadgeState(badge({ enabled: true, running: true, last_status: 'error' }))).toBe('running')
  })

  it('labels the next run as a clock today, 明天 tomorrow, and minutes while running', () => {
    const now = new Date(2026, 9, 8, 10, 0).getTime()
    expect(evolveBadgeLabel(badge({ enabled: true, next_run_at: new Date(2026, 9, 8, 21, 5).getTime() }), now)).toBe('21:05')
    expect(evolveBadgeLabel(badge({ enabled: true, next_run_at: new Date(2026, 9, 9, 9, 0).getTime() }), now)).toBe('明天 09:00')
    expect(evolveBadgeLabel(badge({ enabled: true, next_run_at: new Date(2026, 9, 12, 9, 0).getTime() }), now)).toBe('10-12 09:00')
    expect(evolveBadgeLabel(badge({ running: true, running_since: now - 12 * 60_000 }), now)).toBe('執行中 12m')
    expect(evolveBadgeLabel(badge(), now)).toBe('自我優化 關')
  })

  it('reads badges for exactly the workspaces asked, once bound and connected', async () => {
    replies['evolve.badges'] = { ok: true, badges: { [A]: badge({ enabled: true }), [B]: badge() } }
    await refreshEvolveBadges([A, B])
    expect(calls).toHaveLength(0) // not bound yet
    scope.run(() => useEvolve(fakeBackend()))
    await refreshEvolveBadges([A, B, A])
    expect(calls).toEqual([{ type: 'evolve.badges', payload: { workspaces: [A, B] } }])
    const { badges } = useEvolveBadges()
    expect(badges.value[A].enabled).toBe(true)
    expect(badges.value[B].enabled).toBe(false)
  })

  it('re-reads every known workspace on reconnect', async () => {
    const backend = fakeBackend('disconnected')
    scope.run(() => useEvolve(backend))
    await refreshEvolveBadges([A])
    expect(calls).toHaveLength(0)
    backend.status.value = 'connected'
    await nextTick()
    expect(calls).toEqual([{ type: 'evolve.badges', payload: { workspaces: [A] } }])
  })

  it('evolve.changed updates only that workspace badge', () => {
    scope.run(() => useEvolve(fakeBackend()))
    emit('evolve.changed', { workspace: A, badge: badge({ running: true }) })
    const { badges } = useEvolveBadges()
    expect(badges.value[A].running).toBe(true)
    expect(badges.value[B]).toBeUndefined()
  })

  it('names the workspace on every RPC', async () => {
    const backend = fakeBackend()
    replies['evolve.get'] = { ok: true, workspace: A }
    const got = await evolveGet(backend, A)
    expect(got.ok).toBe(true)
    await evolveSet(backend, B, { enabled: true })
    await evolveRunNow(backend, A)
    expect(calls).toEqual([
      { type: 'evolve.get', payload: { workspace: A } },
      { type: 'evolve.set', payload: { workspace: B, settings: { enabled: true } } },
      { type: 'evolve.run_now', payload: { workspace: A } },
    ])
  })

  it('surfaces ok:false with the backend reason', async () => {
    replies['evolve.run_now'] = { ok: false, error: 'already running', reason: 'busy' }
    const res = await evolveRunNow(fakeBackend(), A)
    expect(res).toEqual({ ok: false, error: 'already running', reason: 'busy' })
  })

  it('opens and closes the shared panel', () => {
    const api = useEvolveBadges()
    openEvolvePanel(B)
    expect(api.panelWorkspace.value).toBe(B)
    api.closePanel()
    expect(api.panelWorkspace.value).toBeNull()
  })

  it('turns evolve.notice into announcements with pane / panel buttons', () => {
    scope.run(() => useEvolve(fakeBackend()))
    const ann = useAnnouncements()
    emit('evolve.notice', { workspace: A, kind: 'finished', run: run() })
    emit('evolve.notice', { workspace: A, kind: 'finished', run: run() }) // duplicate → one row
    emit('evolve.notice', { workspace: A, kind: 'timeout', run: run({ id: 'r2', status: 'timeout' }) })
    emit('evolve.notice', { workspace: B, kind: 'skipped', run: run({ id: 'r3', status: 'skipped', reason: 'busy' }) })
    emit('evolve.notice', { workspace: B, kind: 'bogus', run: null })
    const rows = ann.items.value.filter((i) => i.kind === 'evolve')
    expect(rows).toHaveLength(3)
    const [skipped, timeout, finished] = rows
    expect(finished.title).toBe('自我優化完成 · alpha')
    expect(finished.highlights.join(' ')).toContain('修 1 個 bug')
    expect(finished.actions).toEqual([
      { kind: 'evolve-result', workspace: A },
      { kind: 'evolve-resume-pane', workspace: A, paneId: 'pane-1' },
    ])
    expect(timeout.actions?.map((a) => a.kind)).toEqual(['evolve-open-pane', 'evolve-interrupt', 'evolve-reclaim'])
    expect(skipped.title).toBe('自我優化未執行 · beta')
    expect(skipped.highlights).toEqual(['這個 workspace 已有一次在執行'])
    expect(skipped.actions).toEqual([{ kind: 'evolve-panel', workspace: B }])
  })

  it('v1.1: over_budget is a warn row with an open-pane button and the detail', () => {
    scope.run(() => useEvolve(fakeBackend()))
    emit('evolve.notice', { workspace: A, kind: 'over_budget', run: run({ id: 'r7', status: 'running', detail: '312k / 200k' }) })
    const row = useAnnouncements().items.value.find((i) => i.kind === 'evolve')!
    expect(row.title).toBe('自我優化超出預算 · alpha')
    expect(row.highlights).toEqual(['這次執行超過 1.5 倍 token 預算，Navide 已送出一次中斷。'])
    expect(row.note).toBe('312k / 200k')
    expect(row.actions).toEqual([{ kind: 'evolve-open-pane', workspace: A, paneId: 'pane-1' }])
  })

  it('v1.2: learns evolve pane ids from evolve.badges and evolve.changed badges', async () => {
    scope.run(() => useEvolve(fakeBackend()))
    replies['evolve.badges'] = { ok: true, badges: { [A]: badge({ pane_ids: ['p-new', 'p-older'] }) } }
    await refreshEvolveBadges([A])
    emit('evolve.changed', { workspace: B, badge: badge({ running: true, pane_ids: ['p-b'] }) })
    expect(['p-new', 'p-older', 'p-b'].map(isEvolveSystemPane)).toEqual([true, true, true])
    expect(isEvolveSystemPane('p-other')).toBe(false)
  })

  it('v1.1: learns evolve pane ids from notices and get replies, by id only', async () => {
    scope.run(() => useEvolve(fakeBackend()))
    emit('evolve.notice', { workspace: A, kind: 'started', run: run({ pane_id: 'p-run' }) })
    replies['evolve.get'] = { ok: true, running: null, runs: [run({ pane_id: 'p-old' }), run({ pane_id: '' })] }
    await evolveGet(fakeBackend(), A)
    expect(isEvolveSystemPane('p-run')).toBe(true)
    expect(isEvolveSystemPane('p-old')).toBe(true)
    expect(isEvolveSystemPane('evolve-1009-0900')).toBe(false)
    expect(isEvolveSystemPane('')).toBe(false)
  })
})

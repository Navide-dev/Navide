// @vitest-environment happy-dom
// useConvenience: the convenience.* RPC helpers, the convenience.changed
// re-read, and the bridge into the announcements centre.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import type { useBackend } from '../useBackend'
import {
  __resetConvenienceForTest,
  consumeConvenienceOverviewRequest,
  convenienceHistory,
  openConvenienceOverview,
  setConvenienceAllowed,
  useConvenience,
  useConvenienceState,
  type ConvenienceFeature,
  type ConvenienceLogEntry,
} from '../useConvenience'
import {
  CONVENIENCE_UPGRADE_ID,
  __resetConvenienceAnnouncementsForTest,
  useAnnouncements,
  type Announcement,
} from '../useAnnouncements'

const feature = (over: Partial<ConvenienceFeature> = {}): ConvenienceFeature => ({
  id: 'claude.hooks',
  cli: 'claude',
  toggleable: true,
  state: 'allowed',
  reason: 'default',
  targets: [{ path: '/Users/me/.claude/settings.json', writtenAt: 1_900_000_000, present: true }],
  ...over,
})

const entry = (over: Partial<ConvenienceLogEntry> = {}): ConvenienceLogEntry => ({
  id: 7,
  at: 1_900_000_000,
  feature: 'claude.hooks',
  action: 'first',
  target: '/Users/me/.claude/settings.json',
  detail: 'wrote hooks',
  backup: '',
  notify: true,
  ...over,
})

const calls: { type: string; payload: Record<string, unknown> }[] = []
const listeners = new Map<string, Set<(p: unknown) => void>>()
let replies: Record<string, { ok: boolean; payload?: unknown; error?: { code: string; message: string } }> = {}

function fakeBackend(status = 'connected'): ReturnType<typeof useBackend> {
  return {
    status: ref(status),
    send: vi.fn(async (type: string, payload: Record<string, unknown> = {}) => {
      calls.push({ type, payload })
      const reply = replies[type] ?? { ok: true, payload: {} }
      return { id: 'r', type, ok: reply.ok, payload: reply.payload ?? null, error: reply.error ?? null, timestamp: '' }
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

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
  await nextTick()
}

function rows(): Announcement[] {
  return useAnnouncements().items.value.filter((item) => item.kind === 'convenience')
}

describe('useConvenience', () => {
  let scope: ReturnType<typeof effectScope>

  beforeEach(() => {
    i18n.global.locale.value = 'zh-TW'
    calls.length = 0
    listeners.clear()
    replies = {}
    __resetConvenienceForTest()
    __resetConvenienceAnnouncementsForTest()
    scope = effectScope()
  })

  afterEach(() => {
    scope.stop()
  })

  it('reads convenience.list on install and on every convenience.changed', async () => {
    replies['convenience.list'] = { ok: true, payload: { features: [feature()], notices: [], upgrade: null } }
    const backend = fakeBackend()
    scope.run(() => useConvenience(backend))
    await flush()
    expect(calls.map((c) => c.type)).toEqual(['convenience.list'])
    expect(useConvenienceState().features.value.map((f) => f.id)).toEqual(['claude.hooks'])

    emit('convenience.changed', { feature: 'claude.hooks' })
    await flush()
    expect(calls.map((c) => c.type)).toEqual(['convenience.list', 'convenience.list'])
  })

  it('waits for the connection, then reads on (re)connect', async () => {
    const backend = fakeBackend('starting')
    scope.run(() => useConvenience(backend))
    await flush()
    expect(calls).toEqual([])
    ;(backend.status as unknown as { value: string }).value = 'connected'
    await flush()
    expect(calls.map((c) => c.type)).toEqual(['convenience.list'])
  })

  it('unsubscribes when its scope stops', async () => {
    const backend = fakeBackend()
    scope.run(() => useConvenience(backend))
    await flush()
    scope.stop()
    emit('convenience.changed', {})
    await flush()
    expect(calls.length).toBe(1)
  })

  it('keeps the error of a failed read', async () => {
    replies['convenience.list'] = { ok: false, error: { code: 'INTERNAL', message: 'db locked' } }
    scope.run(() => useConvenience(fakeBackend()))
    await flush()
    expect(useConvenienceState().loadError.value).toBe('db locked')
  })

  it('passes feature and limit to convenience.history', async () => {
    replies['convenience.history'] = { ok: true, payload: { entries: [entry()] } }
    const res = await convenienceHistory(fakeBackend(), { feature: 'claude.hooks', limit: 50 })
    expect(calls).toEqual([{ type: 'convenience.history', payload: { feature: 'claude.hooks', limit: 50 } }])
    expect(res.ok && res.data.map((e) => e.id)).toEqual([7])
  })

  it('applies the feature convenience.set returns, then re-reads', async () => {
    replies['convenience.list'] = { ok: true, payload: { features: [feature()], notices: [], upgrade: null } }
    const backend = fakeBackend()
    scope.run(() => useConvenience(backend))
    await flush()
    replies['convenience.set'] = { ok: true, payload: { feature: feature({ state: 'off', reason: 'user' }) } }
    replies['convenience.list'] = { ok: true, payload: { features: [feature({ state: 'off', reason: 'user' })], notices: [], upgrade: null } }
    const res = await setConvenienceAllowed(backend, 'claude.hooks', false)
    expect(res.ok).toBe(true)
    expect(calls.find((c) => c.type === 'convenience.set')?.payload).toEqual({ id: 'claude.hooks', allowed: false })
    expect(useConvenienceState().features.value[0].state).toBe('off')
    await flush()
    expect(calls.filter((c) => c.type === 'convenience.list').length).toBe(2)
  })

  it('reports a refused convenience.set by its message', async () => {
    replies['convenience.set'] = { ok: false, error: { code: 'REQUIRED_FEATURE', message: 'codex.pane-homes is required' } }
    const res = await setConvenienceAllowed(fakeBackend(), 'codex.pane-homes', false)
    expect(res).toEqual({ ok: false, error: 'codex.pane-homes is required' })
  })

  it('acks the upgrade notice and drops its row', async () => {
    replies['convenience.list'] = { ok: true, payload: { features: [feature()], notices: [], upgrade: { features: ['claude.hooks'] } } }
    const api = scope.run(() => useConvenience(fakeBackend()))!
    await flush()
    expect(rows().map((r) => r.id)).toEqual([CONVENIENCE_UPGRADE_ID])
    expect(await api.ackUpgrade()).toBe(true)
    expect(calls.at(-1)).toEqual({ type: 'convenience.upgrade_ack', payload: {} })
    expect(rows()).toEqual([])
  })

  it('hands each overview request to the pane exactly once', () => {
    expect(consumeConvenienceOverviewRequest()).toBe(false)
    openConvenienceOverview()
    expect(consumeConvenienceOverviewRequest()).toBe(true)
    expect(consumeConvenienceOverviewRequest()).toBe(false)
  })
})

describe('convenience announcement rows', () => {
  beforeEach(() => {
    i18n.global.locale.value = 'zh-TW'
    __resetConvenienceAnnouncementsForTest()
  })

  it('announces a first write in the contract wording and links to the overview', () => {
    useAnnouncements().noteConvenience({ features: [feature()], notices: [entry()], upgrade: null })
    const [row] = rows()
    expect(row.id).toBe('convenience:7')
    expect(row.title).toBe(
      '已依你允許的便利功能「Claude hook：回合偵測、Navide Guard 與喚醒」，寫入 /Users/me/.claude/settings.json（為了讓 Navide 知道 Claude 何時完成回合，並讓 Navide Guard 檢查它的工具呼叫）'
    )
    expect(row.createdAt).toBe(1_900_000_000_000)
    expect(row.actions).toEqual([{ kind: 'convenience-overview' }])
  })

  it('skips log entries that do not notify', () => {
    useAnnouncements().noteConvenience({ features: [feature()], notices: [entry({ notify: false })], upgrade: null })
    expect(rows()).toEqual([])
  })

  it('marks a repair as such', () => {
    useAnnouncements().noteConvenience({ features: [feature()], notices: [entry({ action: 'repair' })], upgrade: null })
    expect(rows()[0].note).toBe('這次是補回或修復 Navide 先前寫入的內容。')
  })

  it('announces a re-add after a reset in its own words', () => {
    useAnnouncements().noteConvenience({ features: [feature()], notices: [entry({ action: 'reset' })], upgrade: null })
    const [row] = rows()
    expect(row.title).toBe(
      '重置後重新加回：已依你允許的便利功能「Claude hook：回合偵測、Navide Guard 與喚醒」，再次寫入 /Users/me/.claude/settings.json（為了讓 Navide 知道 Claude 何時完成回合，並讓 Navide Guard 檢查它的工具呼叫）'
    )
    expect(row.note).toBe('它所在的資料夾被刪除或重新建立，這算是重置，不是你移除它。要停用，請在總覽頁關閉這個功能。')
    expect(row.actions).toEqual([{ kind: 'convenience-overview' }])
  })

  it('tells a workspace left alone for safety in its own words', () => {
    useAnnouncements().noteConvenience({
      features: [feature()],
      notices: [entry({ action: 'refused-unsafe', target: '/repo/.cursor/mcp.json' })],
      upgrade: null,
    })
    const [row] = rows()
    expect(row.title).toBe(
      '/repo/.cursor/mcp.json 所在的 .cursor 指向專案資料夾外，為了安全，Navide 沒有在這裡設定便利功能「Claude hook：回合偵測、Navide Guard 與喚醒」。要使用，請把 .cursor 改成專案內的一般資料夾'
    )
    expect(row.actions).toEqual([{ kind: 'convenience-overview' }])
  })

  it('tells a skill left out for its name in its own words', () => {
    useAnnouncements().noteConvenience({
      features: [feature()],
      notices: [entry({ action: 'refused-name', target: '/repo/.cursor/skills/.navide-links' })],
      upgrade: null,
    })
    const [row] = rows()
    expect(row.title).toBe(
      'Skill「.navide-links」和 Navide 的清單檔 .navide-links 同名，Navide 沒有在 /repo/.cursor/skills 為它建立連結；改名後就會出現'
    )
    expect(row.actions).toEqual([{ kind: 'convenience-overview' }])
  })

  it('offers re-allow on a removal only while the removal keeps the feature off', () => {
    const removed = entry({ id: 9, action: 'removed' })
    useAnnouncements().noteConvenience({ features: [feature({ state: 'off', reason: 'removed' })], notices: [removed], upgrade: null })
    const [row] = rows()
    expect(row.title).toBe(
      '你移除了 /Users/me/.claude/settings.json，已關閉便利功能「Claude hook：回合偵測、Navide Guard 與喚醒」；不會再自動加回'
    )
    expect(row.actions).toEqual([{ kind: 'convenience-reallow', featureId: 'claude.hooks' }, { kind: 'convenience-overview' }])

    useAnnouncements().noteConvenience({ features: [feature()], notices: [removed], upgrade: null })
    expect(rows()[0].actions).toEqual([{ kind: 'convenience-overview' }])
  })

  it('turns an account prompt into keep / switch-back buttons until it is read', () => {
    const announcements = useAnnouncements()
    announcements.setConvenienceAgentLabel((key) => (key === 'claude' ? 'Claude Code' : key))
    announcements.noteConvenience({
      features: [],
      notices: [entry({
        id: 11, feature: 'credentials.auto-repair', action: 'prompt', target: 'claude',
        detail: JSON.stringify({ agentKey: 'claude', slotId: 'slot-a', slotLabel: 'Work', liveEmail: 'me@home.dev', slotEmail: 'me@work.dev', liveFingerprint: 'fp-b' }),
      })],
      upgrade: null,
    })
    const [row] = rows()
    expect(row.title).toBe('Claude Code 的登入在 Navide 外被換過')
    expect(row.highlights).toEqual(['目前登入：me@home.dev · Navide 原本會還原成：Work'])
    expect(row.actions).toEqual([
      { kind: 'convenience-keep-login', rowId: 'convenience:11' },
      { kind: 'convenience-switch-back', rowId: 'convenience:11', agentKey: 'claude', slotId: 'slot-a', label: 'Work', liveFingerprint: 'fp-b' },
      { kind: 'convenience-overview' },
    ])
    announcements.markRead('convenience:11')
    expect(rows()[0].actions).toEqual([{ kind: 'convenience-overview' }])
  })

  it.each([
    ['not JSON', 'live account differs'],
    ['JSON without a slotId', JSON.stringify({ agentKey: 'codex', liveEmail: 'me@home.dev' })],
    ['a null slotId', JSON.stringify({ agentKey: 'codex', slotId: null, slotLabel: 'Default' })],
    ['JSON without the live login fingerprint', JSON.stringify({ agentKey: 'codex', slotId: 'slot-a', slotLabel: 'Work' })],
  ])('never offers a switch back when the detail is %s', (_, detail) => {
    useAnnouncements().noteConvenience({
      features: [],
      notices: [entry({ id: 12, feature: 'credentials.auto-repair', action: 'prompt', target: 'codex', detail })],
      upgrade: null,
    })
    // A missing slot must never turn into a switch to Default.
    expect(rows()[0].actions).toEqual([
      { kind: 'convenience-keep-login', rowId: 'convenience:12' },
      { kind: 'convenience-overview' },
    ])
  })

  it('tells an outside sign-out as such, with only an acknowledgement', () => {
    const announcements = useAnnouncements()
    announcements.setConvenienceAgentLabel((key) => (key === 'codex' ? 'Codex' : key))
    announcements.noteConvenience({
      features: [],
      notices: [entry({
        id: 13, feature: 'credentials.auto-repair', action: 'prompt', target: 'codex live login',
        detail: JSON.stringify({ agentKey: 'codex', reason: 'logout' }),
      })],
      upgrade: null,
    })
    const [row] = rows()
    expect(row.title).toBe('你在 Navide 外登出了 Codex，Navide 沒有自動幫你登回。')
    expect(row.highlights).toEqual([])
    expect(row.actions).toEqual([{ kind: 'convenience-dismiss', rowId: 'convenience:13' }, { kind: 'convenience-overview' }])
    announcements.markRead('convenience:13')
    expect(rows()[0].actions).toEqual([{ kind: 'convenience-overview' }])
  })

  it('lists the features in use on the one-time upgrade row', () => {
    useAnnouncements().noteConvenience({ features: [], notices: [], upgrade: { features: ['claude.hooks', 'cursor.project-mcp'] } })
    const [row] = rows()
    expect(row.id).toBe(CONVENIENCE_UPGRADE_ID)
    expect(row.highlights).toEqual(['Claude hook：回合偵測、Navide Guard 與喚醒', 'Cursor 的 Navide MCP 工具'])
    expect(row.note).toBe('它們維持允許；可隨時在總覽頁關閉。')
    expect(row.actions).toEqual([{ kind: 'convenience-upgrade-ack' }, { kind: 'convenience-overview' }])
  })

  it('shows an unknown feature by its id instead of a key path', () => {
    useAnnouncements().noteConvenience({ features: [], notices: [entry({ feature: 'future.thing' })], upgrade: null })
    expect(rows()[0].title).toContain('「future.thing」')
  })
})

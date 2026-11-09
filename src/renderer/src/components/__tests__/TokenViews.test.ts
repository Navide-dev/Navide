// @vitest-environment happy-dom
// The Token panel's by-model and by-account-quota views, and the range
// helpers they share.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'
import TokenByModel from '../TokenByModel.vue'
import TokenByAccountQuota from '../TokenByAccountQuota.vue'
import { fmtUsd, rangeDays } from '../../lib/tokenViews'
import { i18n } from '@navide/plugin-ui/foundation'
import { __resetUsageForTest, initUsage } from '../../composables/useUsage'

type Handler = (raw: unknown) => void

function makeBackend(answers: Record<string, unknown>) {
  const handlers: Record<string, Handler[]> = {}
  const send = vi.fn(async (type: string, _payload?: unknown) => ({ ok: true, payload: answers[type] ?? null }))
  const backend = {
    status: ref('connected'),
    send,
    on: (ev: string, cb: Handler) => {
      ;(handlers[ev] ??= []).push(cb)
      return () => { handlers[ev] = (handlers[ev] ?? []).filter((h) => h !== cb) }
    },
  }
  return { backend, send, emit: (ev: string, raw: unknown) => (handlers[ev] ?? []).forEach((h) => h(raw)) }
}

const group = (key: string, extra: Record<string, unknown>, tokens = 100, usd = 1.5, unpriced = 0) => ({
  key, calls: 2, input: tokens, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0, output: 0,
  usd, unpriced_calls: unpriced, ...extra,
})

let wrapper: VueWrapper | null = null

beforeEach(() => {
  i18n.global.locale.value = 'en-US'
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(2026, 10, 5, 12, 0)) // Thursday 5 Nov 2026, local time
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  vi.useRealTimers()
  __resetUsageForTest()
})

describe('tokenViews helpers', () => {
  it('a week runs Monday to Sunday around today, a day is today alone', () => {
    expect(rangeDays('day')).toEqual(['2026-11-05'])
    expect(rangeDays('week')).toEqual([
      '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08',
    ])
    expect(rangeDays('week', new Date(2026, 10, 8, 23))).toEqual(rangeDays('week'))
  })

  it('a model with no priced call shows a dash, not $0', () => {
    expect(fmtUsd({ usd: 0, calls: 3, unpriced_calls: 3 })).toBe('—')
    expect(fmtUsd({ usd: 1234.5, calls: 3, unpriced_calls: 0 })).toBe('$1,235')
    expect(fmtUsd({ usd: 2.5, calls: 3, unpriced_calls: 1 })).toBe('$2.50')
  })
})

describe('TokenByModel', () => {
  it('asks for this week by day and model in the workspace folder, and lists models largest first', async () => {
    const { backend, send } = makeBackend({
      'tokens.cost_report': {
        ok: true, by: 'day_model', groups: [
          group('2026-11-02::claude-opus-5-5', { day: '2026-11-02', model: 'claude-opus-5-5' }, 300),
          group('2026-11-03::claude-opus-5-5', { day: '2026-11-03', model: 'claude-opus-5-5' }, 300),
          group('2026-11-03::mystery', { day: '2026-11-03', model: 'mystery' }, 900, 0, 2),
        ],
      },
    })
    wrapper = mount(TokenByModel, { props: { backend: backend as never, workspacePath: '/ws', range: 'week' }, global: { plugins: [i18n] } })
    await flushPromises()
    const [type, payload] = send.mock.calls[0]
    expect(type).toBe('tokens.cost_report')
    expect(payload).toMatchObject({ by: 'day_model', cwd: '/ws', since: '2026-11-02', until: '2026-11-08' })
    const rows = wrapper.findAll('[data-row="model"]')
    expect(rows.map((r) => r.attributes('data-model'))).toEqual(['mystery', 'claude-opus-5-5'])
    expect(rows[0].find('[data-part="usd"]').text()).toBe('—')
    expect(rows[1].find('[data-part="usd"]').text()).toBe('$3.00')
    expect(wrapper.findAll('[data-part="bars"] .bar-row')).toHaveLength(7)
  })

  it('a day shows the table without bars, and an empty ledger says so', async () => {
    const { backend } = makeBackend({ 'tokens.cost_report': { ok: true, by: 'day_model', groups: [] } })
    wrapper = mount(TokenByModel, { props: { backend: backend as never, workspacePath: '/ws', range: 'day' }, global: { plugins: [i18n] } })
    await flushPromises()
    expect(wrapper.find('[data-part="empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-part="bars"]').exists()).toBe(false)
  })
})

describe('TokenByAccountQuota', () => {
  const history = {
    ok: true,
    days: ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05'],
    accounts: [
      { agent_key: 'claude', profile_id: 'slot-a', windows: [
        { window_kind: 'weekly', latest: { used_percent: 45, resets_at: 1794200000, fetched_at: 1 }, peaks: [null, 10, 20, 30, 40, 45, 45] },
        { window_kind: 'weekly-model:Fable', latest: { used_percent: 95, resets_at: 1794200000, fetched_at: 1 }, peaks: [0, 0, 0, 0, 0, 0, 95] },
      ] },
      { agent_key: 'claude', profile_id: 'slot-b', windows: [
        { window_kind: 'weekly', latest: { used_percent: 75, resets_at: 1794200000, fetched_at: 1 }, peaks: [75, 75, 75, 75, 75, 75, 75] },
      ] },
    ],
  }

  it('shows each account\'s recorded windows with warn / crit levels, its tokens in range and a 7-day line', async () => {
    const { backend, send } = makeBackend({
      'tokens.quota_history': history,
      'tokens.cost_report': { ok: true, by: 'account', groups: [group('slot-b', {}, 5000), group('slot-a', {}, 1200)] },
    })
    wrapper = mount(TokenByAccountQuota, { props: { backend: backend as never, range: 'week' }, global: { plugins: [i18n] } })
    await flushPromises()
    expect(send.mock.calls.map((c) => c[0]).sort()).toEqual(['tokens.cost_report', 'tokens.quota_history'])
    const costCall = send.mock.calls.find((c) => c[0] === 'tokens.cost_report')!
    expect(costCall[1]).toMatchObject({ by: 'account', since: '2026-11-02', until: '2026-11-08' })
    expect(costCall[1]).not.toHaveProperty('cwd')

    const rows = wrapper.findAll('[data-row="quota-account"]')
    expect(rows.map((r) => r.attributes('data-account'))).toEqual(['slot-b', 'slot-a'])
    expect(rows[0].find('[data-part="tokens"]').text()).toBe('5.0k')
    const fable = rows[1].find('[data-window="weekly-model:Fable"]')
    expect(fable.text()).toContain('Weekly (Fable)')
    expect(fable.find('.window-pct').classes()).toContain('crit')
    expect(rows[0].find('.window-pct').classes()).toContain('warn')
    expect(rows[1].find('.trend polyline').attributes('points')!.split(' ')).toHaveLength(6)
  })

  it('prefers the live usage reading over the last recorded one', async () => {
    const { backend, emit } = makeBackend({
      'tokens.quota_history': history,
      'tokens.cost_report': { ok: true, by: 'account', groups: [] },
    })
    initUsage(backend as never)
    emit('usage.changed', {
      providers: {},
      accounts: { claude: { 'slot-a': { provider: 'claude', status: 'ok', planType: null, fetchedAt: '', error: null,
        windows: [{ kind: 'session', label: 'Session (5h)', usedPercent: 12, resetsAt: null }] } } },
    })
    wrapper = mount(TokenByAccountQuota, { props: { backend: backend as never, range: 'day' }, global: { plugins: [i18n] } })
    await flushPromises()
    const slotA = wrapper.find('[data-account="slot-a"]')
    expect(slotA.findAll('.window').map((w) => w.text())).toEqual(['Session (5h)12%'])
  })

  it('says when no quota has been recorded', async () => {
    const { backend } = makeBackend({
      'tokens.quota_history': { ok: true, days: [], accounts: [] },
      'tokens.cost_report': { ok: true, by: 'account', groups: [] },
    })
    wrapper = mount(TokenByAccountQuota, { props: { backend: backend as never, range: 'week' }, global: { plugins: [i18n] } })
    await flushPromises()
    expect(wrapper.find('[data-part="empty"]').text()).toBe('No quota readings recorded yet')
  })
})

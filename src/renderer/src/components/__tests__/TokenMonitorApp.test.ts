// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import TokenMonitorApp from '../../TokenMonitorApp.vue'
import type { MonitorResult } from '../../composables/useTokenMonitor'

const wire = vi.hoisted(() => ({ send: vi.fn(), initSettings: vi.fn(), settingsChanged: null as null | ((keys: string[]) => void), locale: 'en-US' }))
vi.mock('../../composables/useBackend', () => ({ useBackend: () => ({ status: ref('connected'), lastError: ref(''), send: wire.send }) }))
vi.mock('@navide/plugin-ui/shared', async importOriginal => ({ ...(await importOriginal<object>()), initSettingsBackend: wire.initSettings, settingsGet: (key: string, fallback: unknown) => key === 'agent-team:language' ? wire.locale : fallback, onSettingsChanged: (callback: (keys: string[]) => void) => { wire.settingsChanged = callback; return () => { wire.settingsChanged = null } } }))
vi.mock('../../composables/hostSettingsPort', () => ({ createHostSettingsPort: () => ({ monitorSettings: true }) }))
const wrappers: VueWrapper[] = []
function answer(): MonitorResult {
  return { ok: true, scope: 'local-claude-history', account_attribution: 'unknown',
    turns: [
      { session_id: 'abc', turn_index: 2, started_at: '2026-09-15T02:00:00Z', ended_at: null, model: 'opus', input: 10, cache_read: 20, cache_creation: 30, output: 40, total: 100, calls: 1 },
      { session_id: 'def', turn_index: 1, started_at: '2026-09-14T02:00:00Z', ended_at: null, model: 'sonnet', input: 20, cache_read: 40, cache_creation: 60, output: 80, total: 200, calls: 2 },
    ], quota: { active_slot_id: 'a', enabled: true, samples: [
      { slot_id: 'a', fetched_at: '2026-09-16T00:00:00Z', plan_type: null, windows: [{ kind: 'five_hour', label: '5h', usedPercent: 0, resetsAt: '2026-09-16T05:00:00Z' }] },
      { slot_id: 'b', fetched_at: '2026-09-16T01:00:00Z', plan_type: null, windows: [{ kind: 'five_hour', label: '5h', usedPercent: 99, resetsAt: '2026-09-16T05:00:00Z' }] },
      { slot_id: 'a', fetched_at: '2026-09-16T06:00:00Z', plan_type: null, windows: [{ kind: 'five_hour', label: '5h', usedPercent: 5, resetsAt: '2026-09-16T10:00:00Z' }] },
    ] }, coverage: { sessions_scanned: 2, sessions_available: 2, truncated: false, errors: 0 }, limitations: [] }
}
async function render() { const w = mount(TokenMonitorApp, { global: { plugins: [i18n], stubs: { WindowControls: true } } }); wrappers.push(w); await flushPromises(); return w }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-16T12:00:00Z')); i18n.global.locale.value = 'en-US'; wire.locale = 'en-US'; wire.initSettings.mockClear(); wire.send.mockReset(); wire.send.mockResolvedValue({ ok: true, payload: answer() }) })
afterEach(() => { wrappers.splice(0).forEach(w => w.unmount()); vi.useRealTimers() })
describe('Token monitor window', () => {
  it('connects settings and applies both settings and native language events', async () => {
    let languageChanged: ((locale: string) => void) | undefined
    const previous = window.agentTeam
    window.agentTeam = { onLanguageChanged: callback => { languageChanged = callback } } as typeof window.agentTeam
    try {
      const w = await render()
      expect(wire.initSettings).toHaveBeenCalledWith({ monitorSettings: true })
      wire.locale = 'zh-TW'; wire.settingsChanged?.(['agent-team:language']); await flushPromises()
      expect(w.text()).toContain('Claude Token 監測')
      languageChanged?.('en-US'); await flushPromises()
      expect(w.text()).toContain('Claude Token Monitor')
      languageChanged?.('invalid'); await flushPromises()
      expect(w.text()).toContain('Claude Token Monitor')
      w.unmount(); expect(wire.settingsChanged).toBeNull()
    } finally { window.agentTeam = previous }
  })
  it('boots in Japanese and reformats dates when the Host language changes', async () => {
    const previousUrl = window.location.href
    window.history.replaceState({}, '', '/?window=token-monitor&locale=ja-JP')
    try {
      const w = await render()
      expect(w.text()).toContain('Claude トークンモニター')
      const timestamp = new Date(answer().turns[0].started_at!)
      expect(w.get('[data-row="turn"] td').text()).toBe(timestamp.toLocaleString('ja-JP'))
      wire.locale = 'en-US'
      wire.settingsChanged?.(['agent-team:language'])
      await flushPromises()
      expect(w.get('[data-row="turn"] td').text()).toBe(timestamp.toLocaleString('en-US'))
      wire.locale = 'ja-JP'
      wire.settingsChanged?.(['agent-team:language'])
      await flushPromises()
      expect(w.text()).toContain('Claude トークンモニター')
    } finally { window.history.replaceState({}, '', previousUrl) }
  })

  it('renders accurate aggregate statistics, filters model and keeps quota resets separate', async () => {
    const w = await render()
    expect(w.get('[data-part="stats"]').text()).toContain('300')
    expect(w.get('[data-part="stats"]').text()).toContain('150')
    expect(w.findAll('[data-row="turn"]')).toHaveLength(2)
    expect(w.findAll('circle title').map(el => el.text())).toHaveLength(2)
    expect(w.findAll('circle title').some(el => el.text().endsWith(': 0%'))).toBe(true)
    expect(w.text()).toContain('Last quota observation')
    expect(w.get('[data-part="quota-slot"]').text()).toContain('Profile slot recorded at refresh: a')
    expect(w.findAll('circle title').some(el => el.text().includes('99%'))).toBe(false)
    await w.get('[data-act="model"]').setValue('opus')
    expect(w.findAll('[data-row="turn"]')).toHaveLength(1)
    expect(w.get('[data-part="stats"]').text()).toContain('100')
    expect(w.text()).toContain('Insufficient samples')
    expect(w.find('[data-part="change"]').exists()).toBe(false)
  })
  it('keeps same-reset model quota windows distinct and labels disabled polling', async () => {
    const body = answer(); body.quota.enabled = false
    body.quota.samples[0].windows.push({ kind: 'five_hour', label: 'Opus only', usedPercent: 35, resetsAt: '2026-09-16T05:00:00Z' })
    wire.send.mockResolvedValue({ ok: true, payload: body })
    const w = await render()
    expect(w.text()).toContain('Quota polling is disabled')
    expect(w.findAll('figure figcaption').some(el => el.text().includes('Opus only'))).toBe(true)
    expect(w.findAll('circle title')).toHaveLength(3)
  })
  it('paginates reset windows and keeps unknown-reset observations separate', async () => {
    const body = answer()
    body.quota.samples = Array.from({ length: 8 }, (_, index) => ({ slot_id: 'a', fetched_at: `2026-09-16T0${index}:00:00Z`, plan_type: null, windows: [{ kind: 'five_hour', label: '5h', usedPercent: index, resetsAt: null }] }))
    wire.send.mockResolvedValue({ ok: true, payload: body })
    const w = await render()
    expect(w.findAll('circle title')).toHaveLength(6)
    const nextButtons = w.findAll('button').filter(button => button.text() === 'Next')
    await nextButtons.at(-1)!.trigger('click')
    expect(w.findAll('circle title')).toHaveLength(2)
  })
  it('refreshes periodically, reloads requested days and stops after unmount', async () => {
    const w = await render()
    expect(wire.send).toHaveBeenLastCalledWith('tokens.monitor', { days: 30 })
    await w.get('[data-act="days"]').setValue('14'); await flushPromises()
    expect(wire.send).toHaveBeenLastCalledWith('tokens.monitor', { days: 14 })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(wire.send).toHaveBeenCalledTimes(3)
    w.unmount()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(wire.send).toHaveBeenCalledTimes(3)
  })
  it('ignores an old period response arriving after a newer selection', async () => {
    let resolveOld!: (value: unknown) => void
    wire.send.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve }))
    const w = await render()
    await w.get('[data-act="days"]').setValue('14'); await flushPromises()
    const stale = answer(); stale.turns = []
    resolveOld({ ok: true, payload: stale }); await flushPromises()
    expect(w.findAll('[data-row="turn"]')).toHaveLength(2)
  })
  it('exposes refresh failure without replacing prior statistics and recovers', async () => {
    const w = await render()
    wire.send.mockRejectedValueOnce(new Error('disk failed'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(w.get('[role="alert"]').text()).toBe('disk failed')
    expect(w.findAll('[data-row="turn"]')).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(w.find('[role="alert"]').exists()).toBe(false)
  })
  it('labels partial coverage, quota read errors and empty history honestly in both locales', async () => {
    const body = answer(); body.turns = []; body.coverage.truncated = true; body.quota.error = 'quota database unavailable'
    wire.send.mockResolvedValue({ ok: true, payload: body })
    const w = await render()
    expect(w.text()).toContain('Partial history')
    expect(w.text()).toContain('No local Claude turns')
    expect(w.get('[role="alert"]').text()).toBe('quota database unavailable')
    i18n.global.locale.value = 'zh-TW'; await flushPromises()
    expect(w.text()).toContain('本機 Claude 歷史')
    expect(w.text()).toContain('歷史資料不完整')
  })
})

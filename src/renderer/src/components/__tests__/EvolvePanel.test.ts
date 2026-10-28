// @vitest-environment happy-dom
// EvolvePanel: every read and write names the workspace the panel was opened
// for; one-click start sends evolve.set {enabled: true}; save sends only the
// changed fields; a non-git workspace cannot pick "fix bugs directly"; the
// pane picker lists only this workspace's CLI panes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import type { useBackend } from '../../composables/useBackend'
import {
  __resetEvolveForTest,
  type EvolveProposal,
  type EvolveSettings,
  type EvolveState,
} from '../../composables/useEvolve'
import EvolvePanel from '../EvolvePanel.vue'

const A = '/Users/me/alpha'
const B = '/Users/me/beta'

const settings = (over: Partial<EvolveSettings> = {}): EvolveSettings => ({
  enabled: false,
  at: '09:00',
  tz: 'Asia/Taipei',
  catch_up: 'once',
  mode: 'auto',
  pane_id: '',
  pane_name: '',
  agent: 'claude',
  model: '',
  effort: '',
  token_budget: 200000,
  max_runs_per_day: 2,
  max_fixes: 2,
  max_minutes: 90,
  scope: 'fix',
  extra: '',
  ledger_plan: '',
  retro_tools: true,
  retro_corrections: false,
  retro_freq: { failures: 'daily', tools: 'daily', corrections: 'daily' },
  trigger_burst: false,
  burst_minutes: 30,
  burst_count: 10,
  burst_max_per_day: 1,
  ...over,
})

function stateFor(workspace: string, over: Partial<EvolveState> = {}, s: Partial<EvolveSettings> = {}): EvolveState {
  return {
    workspace,
    settings: settings(s),
    git: { is_repo: true, root: workspace, branch: 'main', subdir: '' },
    job: null,
    running: null,
    runs: [],
    legacy: [],
    template: { version: 1, text: 'RULES v1 TEXT' },
    ...over,
  }
}

const calls: { type: string; payload: Record<string, unknown> }[] = []
let states: Record<string, EvolveState> = {}
let roster: Record<string, unknown>[] = []

function fakeBackend(): ReturnType<typeof useBackend> {
  return {
    status: ref('connected'),
    send: vi.fn(async (type: string, payload: Record<string, unknown> = {}) => {
      calls.push({ type, payload })
      const ws = payload.workspace as string
      let body: unknown = { ok: true }
      if (type === 'evolve.get') body = { ok: true, ...states[ws] }
      else if (type === 'evolve.set') {
        const cur = states[ws]
        states[ws] = { ...cur, settings: { ...cur.settings, ...(payload.settings as object) } }
        body = { ok: true, ...states[ws], disabled_legacy: (payload.settings as EvolveSettings).enabled ? cur.legacy.map((j) => j.id) : [] }
      } else if (type === 'evolve.run_now') body = { ok: true, run_id: 'r9' }
      else if (type === 'agent_msg.list') body = { panes: roster }
      return { id: 'r', type, ok: true, payload: body, error: null, timestamp: '' }
    }),
    on: () => () => {},
  } as unknown as ReturnType<typeof useBackend>
}

const specs = [
  { agentKey: 'claude', label: 'Claude Code', modelArgs: (m: string) => `--model ${m}`, effortArgs: (e: string) => `--effort ${e}`, knownEfforts: ['low', 'high'] },
  { agentKey: 'aider', label: 'Aider' },
  { agentKey: 'terminal', label: 'Terminal' },
]

async function mountPanel(workspace: string): Promise<VueWrapper> {
  const wrapper = mount(EvolvePanel, {
    props: { backend: fakeBackend(), workspace, agentSpecs: specs as never },
    global: { plugins: [i18n], stubs: { teleport: true } },
  })
  await flushPromises()
  return wrapper
}

const callsOf = (type: string) => calls.filter((c) => c.type === type)

describe('EvolvePanel', () => {
  let wrapper: VueWrapper | undefined

  beforeEach(() => {
    i18n.global.locale.value = 'zh-TW'
    calls.length = 0
    __resetEvolveForTest()
    states = { [A]: stateFor(A), [B]: stateFor(B) }
    roster = [
      { pane_id: 'p-a1', name: '指揮', workspace_path: A, agent_key: 'claude' },
      { pane_id: 'p-a2', name: 'shell', workspace_path: A, agent_key: 'terminal' },
      { pane_id: 'p-b1', name: '別人的', workspace_path: B, agent_key: 'claude' },
    ]
  })
  afterEach(() => wrapper?.unmount())

  it('reads the workspace it was opened for', async () => {
    wrapper = await mountPanel(B)
    expect(callsOf('evolve.get')).toEqual([{ type: 'evolve.get', payload: { workspace: B } }])
    expect(wrapper.get('[data-test="evolve-panel"]').attributes('data-workspace')).toBe(B)
    expect(wrapper.get('[data-test="git"]').text()).toBe('git main')
  })

  it('one-click start sends evolve.set {enabled: true} for this workspace only', async () => {
    wrapper = await mountPanel(A)
    expect(wrapper.find('[data-test="status-off"]').exists()).toBe(true)
    await wrapper.get('[data-test="enable"]').trigger('click')
    await flushPromises()
    expect(callsOf('evolve.set')).toEqual([{ type: 'evolve.set', payload: { workspace: A, settings: { enabled: true } } }])
    expect(wrapper.find('[data-test="status-on"]').exists()).toBe(true)
    expect(states[B].settings.enabled).toBe(false)
  })

  it('turning it off sends enabled: false', async () => {
    states[A] = stateFor(A, {}, { enabled: true })
    wrapper = await mountPanel(A)
    await wrapper.get('[data-test="disable"]').trigger('click')
    await flushPromises()
    expect(callsOf('evolve.set').at(-1)?.payload).toEqual({ workspace: A, settings: { enabled: false } })
  })

  it('save sends only the fields that changed', async () => {
    wrapper = await mountPanel(A)
    await wrapper.get('[data-field="at"]').setValue('07:30')
    await wrapper.get('[data-field="max_fixes"]').setValue('3')
    await wrapper.get('[data-field="extra"]').setValue('only touch docs/')
    await wrapper.get('[data-test="save"]').trigger('click')
    await flushPromises()
    expect(callsOf('evolve.set')).toEqual([
      { type: 'evolve.set', payload: { workspace: A, settings: { at: '07:30', max_fixes: 3, extra: 'only touch docs/' } } },
    ])
  })

  it('refuses to save an out-of-range budget field', async () => {
    wrapper = await mountPanel(A)
    await wrapper.get('[data-field="max_runs_per_day"]').setValue('11')
    await wrapper.get('[data-test="save"]').trigger('click')
    await flushPromises()
    expect(callsOf('evolve.set')).toHaveLength(0)
    expect(wrapper.get('[data-error="max_runs_per_day"]').text()).toContain('1–10')
  })

  it('run now names the workspace', async () => {
    wrapper = await mountPanel(B)
    await wrapper.get('[data-test="run-now"]').trigger('click')
    await flushPromises()
    expect(callsOf('evolve.run_now')).toEqual([{ type: 'evolve.run_now', payload: { workspace: B } }])
    expect(wrapper.find('[data-test="run-notice"]').exists()).toBe(true)
  })

  it('a non-git workspace cannot choose "fix bugs directly" and says why', async () => {
    states[A] = stateFor(A, { git: { is_repo: false, root: '', branch: '', subdir: '' } })
    wrapper = await mountPanel(A)
    const fix = wrapper.get('[data-field="scope-fix"]')
    expect(fix.attributes('disabled')).toBeDefined()
    expect((wrapper.get('[data-field="scope-propose"]').element as HTMLInputElement).checked).toBe(true)
    expect(wrapper.get('[data-test="scope-fix-reason"]').text()).toContain('不是 git repo')
    expect(wrapper.get('[data-test="disclosure"]').text()).toContain('.agent-team/plans/')
  })

  it('a git workspace can choose "fix bugs directly" and discloses repo and branch', async () => {
    wrapper = await mountPanel(A)
    expect(wrapper.get('[data-field="scope-fix"]').attributes('disabled')).toBeUndefined()
    expect(wrapper.get('[data-test="disclosure"]').text()).toContain(`${A} 的本機 main`)
  })

  it('lists only this workspace CLI panes and saves both id and name', async () => {
    wrapper = await mountPanel(A)
    await wrapper.get('[data-field="mode-pane"]').setValue(true)
    const opts = wrapper.get('[data-field="pane"]').findAll('option').map((o) => o.attributes('value'))
    expect(opts).toEqual(['', 'p-a1'])
    await wrapper.get('[data-field="pane"]').setValue('p-a1')
    await wrapper.get('[data-test="save"]').trigger('click')
    await flushPromises()
    expect(callsOf('evolve.set').at(-1)?.payload).toEqual({
      workspace: A,
      settings: { mode: 'pane', pane_id: 'p-a1', pane_name: '指揮' },
    })
  })

  it('offers the CLIs without the plain terminal and greys out an unsupported model', async () => {
    wrapper = await mountPanel(A)
    const agents = wrapper.get('[data-field="agent"]').findAll('option').map((o) => o.attributes('value'))
    expect(agents).toEqual(['claude', 'aider'])
    expect(wrapper.get('[data-field="effort"]').findAll('option').map((o) => o.attributes('value'))).toEqual(['', 'low', 'high'])
    await wrapper.get('[data-field="agent"]').setValue('aider')
    expect(wrapper.get('[data-field="model"]').attributes('disabled')).toBeDefined()
  })

  it('v1.1: explains a pending catch-up and never sends the read-only flag back', async () => {
    states[A] = stateFor(A, {}, { pending_catch_up: true })
    wrapper = await mountPanel(A)
    expect(wrapper.get('[data-test="pending-catch-up"]').text()).toContain('補跑')
    await wrapper.get('[data-field="at"]').setValue('08:00')
    await wrapper.get('[data-test="save"]').trigger('click')
    await flushPromises()
    expect(callsOf('evolve.set').at(-1)?.payload).toEqual({ workspace: A, settings: { at: '08:00' } })
  })

  it('shows the built-in rules on demand', async () => {
    wrapper = await mountPanel(A)
    expect(wrapper.find('[data-test="template"]').exists()).toBe(false)
    await wrapper.get('[data-test="toggle-template"]').trigger('click')
    expect(wrapper.get('[data-test="template"]').text()).toBe('RULES v1 TEXT')
  })

  it('warns about legacy jobs before enabling and reports how many it disabled', async () => {
    states[A] = stateFor(A, { legacy: [{ id: 'old1', name: 'evolve-scout', enabled: true }] })
    wrapper = await mountPanel(A)
    expect(wrapper.get('[data-test="legacy"]').text()).toContain('evolve-scout')
    await wrapper.get('[data-test="enable"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-test="legacy-disabled"]').text()).toContain('1')
  })

  it('shows the last result and up to 30 history rows', async () => {
    const runs = Array.from({ length: 35 }, (_, i) => ({
      id: `r${i}`,
      trigger: 'schedule' as const,
      status: (i === 0 ? 'ok' : 'timeout') as 'ok' | 'timeout',
      started_at: 1_900_000_000_000 - i * 86_400_000,
      ended_at: 1_900_000_000_000 - i * 86_400_000 + 2_460_000,
      pane_name: '自我優化-1008',
      tokens: 142_000,
      commits: i === 0 ? [{ hash: 'a1b2c3d4e5', title: 'fix(scheduler): x' }] : [],
      proposals: [{ rel_path: '.agent-team/plans/p.html', name: '進化提案' }],
      reclaimed: true,
    }))
    states[A] = stateFor(A, { runs })
    wrapper = await mountPanel(A)
    const last = wrapper.get('[data-test="last-result"]').text()
    expect(last).toContain('完成')
    expect(last).toContain('142k')
    expect(last).toContain('a1b2c3d fix(scheduler): x')
    expect(wrapper.get('[data-test="history"]').findAll('tbody tr')).toHaveLength(30)
  })

  it('S1: lists each proposal of the last run with its ledger status, display only', async () => {
    const run = {
      id: 'r0',
      trigger: 'schedule' as const,
      status: 'ok' as const,
      started_at: 1_900_000_000_000,
      ended_at: 1_900_000_100_000,
      tokens: 1000,
      commits: [],
      proposals: [
        { rel_path: '.agent-team/plans/a.html', name: '提案甲' },
        { rel_path: '.agent-team/plans/b.html', name: '提案乙' },
        { rel_path: '.agent-team/plans/c.html', name: '提案丙' },
      ],
      reclaimed: true,
    }
    const row = (rel_path: string, status: EvolveProposal['status'], reason = ''): EvolveProposal => ({
      id: rel_path, run_id: 'r0', rel_path, name: '', kind: '', signature: '', status, reason, pr: '',
      commits: [], created_at: 1, updated_at: 1,
    })
    states[A] = stateFor(A, {
      runs: [run],
      proposals: [
        row('.agent-team/plans/a.html', 'rejected', '太大，先不要'),
        row('.agent-team/plans/b.html', 'landed'),
        { ...row('.agent-team/plans/c.html', 'approved'), run_id: 'other-run' },
      ],
    })
    wrapper = await mountPanel(A)
    const items = wrapper.get('[data-test="last-result"]').findAll('[data-test="proposal"]')
    expect(items).toHaveLength(3)
    expect(items[0].get('[data-test="proposal-status"]').text()).toBe('已退回')
    expect(items[0].text()).toContain('理由：太大，先不要')
    expect(items[1].get('[data-test="proposal-status"]').text()).toBe('已落地')
    // A row of another run is not this proposal's status.
    expect(items[2].find('[data-test="proposal-status"]').exists()).toBe(false)
    const sentBefore = calls.length
    await items[0].get('[data-test="proposal-status"]').trigger('click')
    expect(calls.length).toBe(sentBefore)
  })

  it('S2: the retro passes are two checkboxes that disclose their budget and records', async () => {
    wrapper = await mountPanel(A)
    const tools = wrapper.get('[data-field="retro_tools"]')
    const corrections = wrapper.get('[data-field="retro_corrections"]')
    expect((tools.element as HTMLInputElement).checked).toBe(true)
    expect((corrections.element as HTMLInputElement).checked).toBe(false)
    const row = wrapper.get('[data-test="retro"]').text()
    expect(row).toContain('50k')
    expect(row).toContain('訊息紀錄')
    expect(row).toContain('review note')
    await corrections.setValue(true)
    await wrapper.get('[data-test="save"]').trigger('click')
    await flushPromises()
    expect(callsOf('evolve.set').at(-1)?.payload).toEqual({ workspace: A, settings: { retro_corrections: true } })
  })

  it('S4: shows adoption and cadence per source, and the user can raise a lowered one', async () => {
    states[A] = stateFor(
      A,
      {
        adoption: {
          failures: { proposed: 4, resolved: 3, adopted: 2, rate: 2 / 3 },
          tools: { proposed: 12, resolved: 10, adopted: 0, rate: 0 },
          corrections: { proposed: 0, resolved: 0, adopted: 0, rate: null },
        },
        cadence: { lowered: { tools: { at: 1_900_000_000_000, reason: 'the last 10 tools proposals in a row were not adopted' } } },
      },
      { retro_freq: { failures: 'daily', tools: 'weekly', corrections: 'daily' } },
    )
    wrapper = await mountPanel(A)
    const rows = wrapper.get('[data-test="cadence"]').findAll('[data-source]')
    expect(rows.map((r) => r.attributes('data-source'))).toEqual(['failures', 'tools', 'corrections'])
    expect(rows[0].text()).toContain('2 / 3')
    expect(rows[2].text()).toContain('尚無')
    expect(rows[1].get('[data-test="lowered"]').text()).toContain('10')
    expect(rows[0].find('[data-test="lowered"]').exists()).toBe(false)
    const freq = rows[1].get('select[data-field="retro_freq-tools"]')
    expect((freq.element as HTMLSelectElement).value).toBe('weekly')
    await freq.setValue('daily')
    await wrapper.get('[data-test="save"]').trigger('click')
    await flushPromises()
    expect(callsOf('evolve.set').at(-1)?.payload).toEqual({
      workspace: A,
      settings: { retro_freq: { failures: 'daily', tools: 'daily', corrections: 'daily' } },
    })
  })

  it('S4: lists landed proposals with their before / after counts and verdict', async () => {
    const landed = (rel_path: string, effect: EvolveProposal['effect'], before: number | null, after: number | null): EvolveProposal => ({
      id: rel_path, run_id: 'r', rel_path, name: rel_path, kind: 'failures:code', signature: 's', status: 'landed' as const,
      reason: '', pr: '#1', commits: [], created_at: 1, updated_at: 1, effect, effect_before: before, effect_after: after,
      effect_checked_at: before === null ? null : 2,
    })
    states[A] = stateFor(A, {
      landed: [
        landed('a.html', 'effective', 5, 0),
        landed('b.html', 'not-effective', 3, 3),
        landed('c.html', 'insufficient', 1, 0),
        landed('d.html', '', null, null),
      ],
    })
    wrapper = await mountPanel(A)
    const items = wrapper.get('[data-test="landed"]').findAll('[data-test="landed-item"]')
    expect(items).toHaveLength(4)
    expect(items[0].text()).toContain('5 → 0')
    expect(items[0].get('[data-test="effect"]').text()).toBe('見效')
    expect(items[1].get('[data-test="effect"]').text()).toBe('未見效')
    expect(items[2].get('[data-test="effect"]').text()).toBe('樣本不足')
    expect(items[3].get('[data-test="effect"]').text()).toBe('待判定')
  })

  it('S5a: the burst trigger is off by default and saves its threshold with it', async () => {
    wrapper = await mountPanel(A)
    const row = wrapper.get('[data-test="burst"]')
    const box = row.get('[data-field="trigger_burst"]')
    expect((box.element as HTMLInputElement).checked).toBe(false)
    expect(row.text()).toContain('錯誤帳本')
    await box.setValue(true)
    await flushPromises()
    await row.get('[data-field="burst_count"]').setValue(25)
    await wrapper.get('[data-test="save"]').trigger('click')
    await flushPromises()
    expect(callsOf('evolve.set').at(-1)?.payload).toEqual({
      workspace: A,
      settings: { trigger_burst: true, burst_count: 25 },
    })
  })

  it('S5a: refuses an out-of-range burst threshold', async () => {
    wrapper = await mountPanel(A)
    const row = wrapper.get('[data-test="burst"]')
    await row.get('[data-field="trigger_burst"]').setValue(true)
    await flushPromises()
    await row.get('[data-field="burst_count"]').setValue(1)
    await wrapper.get('[data-test="save"]').trigger('click')
    await flushPromises()
    expect(callsOf('evolve.set')).toHaveLength(0)
    expect(wrapper.find('[data-error="burst_count"]').text()).not.toBe('')
  })

  it('S1: an older backend without a ledger still shows the proposals', async () => {
    const run = {
      id: 'r0', trigger: 'schedule' as const, status: 'ok' as const, started_at: 1_900_000_000_000,
      tokens: 1, commits: [], proposals: [{ rel_path: '.agent-team/plans/a.html', name: '提案甲' }], reclaimed: true,
    }
    states[A] = stateFor(A, { runs: [run] })
    wrapper = await mountPanel(A)
    const items = wrapper.get('[data-test="last-result"]').findAll('[data-test="proposal"]')
    expect(items).toHaveLength(1)
    expect(items[0].text()).toContain('提案甲')
    expect(items[0].find('[data-test="proposal-status"]').exists()).toBe(false)
  })
})

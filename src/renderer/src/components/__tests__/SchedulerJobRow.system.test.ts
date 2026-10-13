// @vitest-environment happy-dom
// A system job (owner.kind 'system', workspace self-evolution) in the
// Schedule panel is read-only: lock + 「系統」 tag, no toggle / run-now / edit /
// repair / adopt / keep / retarget, and one "到 workspace 管理 →" link that
// opens that workspace's evolve panel. An ordinary job keeps every control.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import type { useBackend } from '../../composables/useBackend'
import { useSchedulerJobs } from '../../composables/useSchedulerJobs'
import { __resetEvolveForTest, useEvolveBadges } from '../../composables/useEvolve'
import type { SchedulerJob } from '../../lib/schedulerJobs'
import SchedulerJobRow from '../SchedulerJobRow.vue'

const WS = '/Users/me/Agent-Team'

function systemJob(over: Partial<SchedulerJob> = {}): SchedulerJob {
  return {
    id: 'evolve:abc',
    name: '自我優化 · Agent-Team',
    enabled: true,
    schedule: { kind: 'daily', at: '09:00', tz: 'Asia/Taipei' },
    action: { kind: 'evolve', workspace: WS } as SchedulerJob['action'],
    owner: { kind: 'system', feature: 'evolve', workspace: WS },
    // The states that would otherwise show repair / target-gone / rebound.
    state: {
      next_run_at: 1_900_000_000_000,
      consecutive_errors: 2,
      last_status: 'error',
      disabled_reason: 'target_gone',
      rebound_needs_enable: true,
    },
    owner_gone: true,
    ...over,
  }
}

function userJob(): SchedulerJob {
  return {
    id: 'u1',
    name: '每日發文監督',
    enabled: true,
    schedule: { kind: 'daily', at: '09:20', tz: 'Asia/Taipei' },
    action: { kind: 'message', workspace: WS, pane_id: 'p1', pane_name: '部署優化', text: 'hi' },
    state: { next_run_at: 1_900_000_000_000, consecutive_errors: 0, last_status: 'ok' },
  }
}

const calls: string[] = []

function fakeBackend(jobs: SchedulerJob[]): ReturnType<typeof useBackend> {
  return {
    status: ref('connected'),
    send: vi.fn(async (type: string) => {
      calls.push(type)
      const body = type === 'scheduler.list' ? { ok: true, jobs } : { ok: true }
      return { id: 'r', type, ok: true, payload: body, error: null, timestamp: '' }
    }),
    on: () => () => {},
  } as unknown as ReturnType<typeof useBackend>
}

function mountRow(job: SchedulerJob): VueWrapper {
  const Host = defineComponent({
    setup() {
      const api = useSchedulerJobs(fakeBackend([job]))
      return () => h(SchedulerJobRow, { job, api })
    },
  })
  return mount(Host, { global: { plugins: [i18n] } })
}

describe('SchedulerJobRow – system jobs are read-only', () => {
  let wrapper: VueWrapper | undefined

  beforeEach(() => {
    i18n.global.locale.value = 'zh-TW'
    calls.length = 0
    __resetEvolveForTest()
  })
  afterEach(() => wrapper?.unmount())

  it('shows a lock and the 系統 tag, and no edit / toggle / run / adopt / keep / retarget / repair', async () => {
    wrapper = mountRow(systemJob({ owner: { kind: 'system', feature: 'evolve', workspace: WS, expires_at: 1 } }))
    await flushPromises()
    expect(wrapper.find('[data-test="lock"]').exists()).toBe(true)
    expect(wrapper.get('[data-test="system-tag"]').text()).toBe('系統')
    expect(wrapper.find('button.sj-name').exists()).toBe(false)
    for (const sel of ['toggle', 'run-now', 'adopt', 'keep', 'retarget', 'repair', 'owner', 'expiry', 'target-gone', 'rebound']) {
      expect(wrapper.find(`[data-test="${sel}"]`).exists(), sel).toBe(false)
    }
    expect(wrapper.get('[data-test="target"]').text()).toBe('由 workspace 管理')
  })

  it('"到 workspace 管理 →" opens that workspace evolve panel and calls no scheduler mutation', async () => {
    wrapper = mountRow(systemJob())
    await flushPromises()
    await wrapper.get('[data-test="manage"]').trigger('click')
    expect(useEvolveBadges().panelWorkspace.value).toBe(WS)
    expect(calls.filter((c) => c !== 'scheduler.list')).toEqual([])
    expect(wrapper.emitted()).not.toHaveProperty('edit')
  })

  it('an ordinary job keeps its controls and no manage link', async () => {
    wrapper = mountRow(userJob())
    await flushPromises()
    expect(wrapper.find('[data-test="toggle"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="run-now"]').exists()).toBe(true)
    expect(wrapper.find('button.sj-name').exists()).toBe(true)
    expect(wrapper.find('[data-test="manage"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="system-tag"]').exists()).toBe(false)
  })

  it('a system job does not count as an agent job', () => {
    const Host = defineComponent({
      setup() {
        const api = useSchedulerJobs(fakeBackend([]))
        const job = systemJob()
        expect(api.isSystem(job)).toBe(true)
        expect(api.systemWorkspace(job)).toBe(WS)
        expect(api.ownerLabel(job)).toBe('')
        expect(api.expiryLabel(job)).toBe('')
        return () => h('div')
      },
    })
    wrapper = mount(Host, { global: { plugins: [i18n] } })
  })
})

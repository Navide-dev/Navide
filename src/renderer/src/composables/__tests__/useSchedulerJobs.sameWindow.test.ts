// @vitest-environment happy-dom
// O2 (0.2.42): saving a job in the Tasker tab did not reach the agent pane's
// control panel until a reload. The window holds two useSchedulerJobs
// instances (App.vue's, behind the agent console, and TaskerPanel's), and the
// backend leaves the requesting window out of its scheduler.changed broadcast:
// that window refreshes itself. TaskerPanel refreshed only its own instance,
// so the other kept the list from before the save.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import type { useBackend } from '../useBackend'
import type { SchedulerJob } from '../../lib/schedulerJobs'
import { useSchedulerJobs, type SchedulerJobsApi } from '../useSchedulerJobs'

function job(id: string): SchedulerJob {
  return {
    id,
    name: `job-${id}`,
    enabled: true,
    schedule: { kind: 'daily', at: '09:00', tz: 'UTC' },
    action: { kind: 'message', workspace: '/w', pane_id: 'p1', pane_name: 'agent', text: 'hi' },
    policy: { catch_up: 'once', max_runs_per_day: 24 },
    state: { next_run_at: 1_900_000_000_000, consecutive_errors: 0, last_status: null },
  }
}

interface Pending { resolve: (jobs: SchedulerJob[]) => void }

/** A backend whose scheduler.list answers from `stored`, or, with `hold`,
 *  waits until the test resolves it. It never broadcasts, like the backend
 *  toward the window that made the change. */
function fakeBackend(stored: { jobs: SchedulerJob[] }, held: Pending[] = [], hold = { on: false }) {
  return {
    status: ref('connected'),
    send: vi.fn(async (type: string) => {
      if (type !== 'scheduler.list') return { id: 'r', type, ok: true, payload: { ok: true }, error: null, timestamp: '' }
      const list = hold.on
        ? await new Promise<SchedulerJob[]>((resolve) => held.push({ resolve }))
        : stored.jobs
      return { id: 'r', type, ok: true, payload: { ok: true, jobs: list }, error: null, timestamp: '' }
    }),
    on: () => () => {},
  } as unknown as ReturnType<typeof useBackend>
}

const wrappers: VueWrapper[] = []
afterEach(() => {
  for (const w of wrappers.splice(0)) w.unmount()
})

function mountTwo(backend: ReturnType<typeof useBackend>): { panel: SchedulerJobsApi; tasker: SchedulerJobsApi } {
  const apis: SchedulerJobsApi[] = []
  const Host = defineComponent({
    setup() {
      apis.push(useSchedulerJobs(backend))
      return () => h('div')
    },
  })
  for (let i = 0; i < 2; i++) wrappers.push(mount(Host, { global: { plugins: [i18n] } }))
  return { panel: apis[0], tasker: apis[1] }
}

describe('useSchedulerJobs in one window', () => {
  it("a refresh after this window's save reaches every instance, not only the caller", async () => {
    const stored = { jobs: [job('a')] }
    const { panel, tasker } = mountTwo(fakeBackend(stored))
    await flushPromises()
    expect(panel.jobs.value.map((j) => j.id)).toEqual(['a'])

    // TaskerPanel's onSaved: the job is stored, then only its own instance refreshes.
    stored.jobs = [job('a'), job('b')]
    await tasker.refresh()
    await flushPromises()

    expect(tasker.jobs.value.map((j) => j.id)).toEqual(['a', 'b'])
    expect(panel.jobs.value.map((j) => j.id)).toEqual(['a', 'b'])
  })

  it('an older list still in flight does not overwrite the newer one', async () => {
    const stored = { jobs: [job('a')] }
    const held: Pending[] = []
    const hold = { on: false }
    const { panel, tasker } = mountTwo(fakeBackend(stored, held, hold))
    await flushPromises()

    hold.on = true
    const older = panel.refresh()
    const newer = tasker.refresh()
    await flushPromises()
    expect(held).toHaveLength(2)
    held[1].resolve([job('a'), job('b')])
    await newer
    held[0].resolve([job('a')])
    await older
    await flushPromises()

    expect(panel.jobs.value.map((j) => j.id)).toEqual(['a', 'b'])
    expect(tasker.jobs.value.map((j) => j.id)).toEqual(['a', 'b'])
  })

  it('an unmounted instance is no longer updated', async () => {
    const stored = { jobs: [job('a')] }
    const { panel, tasker } = mountTwo(fakeBackend(stored))
    await flushPromises()
    wrappers.shift()!.unmount()

    stored.jobs = [job('a'), job('b')]
    await tasker.refresh()
    expect(panel.jobs.value.map((j) => j.id)).toEqual(['a'])
  })
})

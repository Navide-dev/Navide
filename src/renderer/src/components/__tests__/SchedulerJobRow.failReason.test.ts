// @vitest-environment happy-dom
// A failed job says why in the UI language (PR-E, E3): the backend records
// the run's reason code (state.last_error_code) next to its English detail,
// and the row shows the translated reason, not only an English tooltip. A
// Repair the backend refuses (no window holds the workspace) and a save it
// refuses (no such pipeline) are translated by their codes the same way.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h, ref } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import type { useBackend } from '../../composables/useBackend'
import { useSchedulerJobs, type SchedulerJobsApi } from '../../composables/useSchedulerJobs'
import { schedulerFailReason, type SchedulerJob } from '../../lib/schedulerJobs'
import SchedulerJobRow from '../SchedulerJobRow.vue'

const WS = '/Users/me/Agent-Team'

function failedPipelineJob(code: string | null, detail = 'no pipeline is named "Nigthly"'): SchedulerJob {
  return {
    id: 'j1',
    name: 'nightly',
    enabled: true,
    schedule: { kind: 'daily', at: '09:00', tz: 'Asia/Taipei' },
    action: { kind: 'pipeline_start', workspace: WS, pipeline_name: 'Nigthly', task: 't' },
    state: { next_run_at: 1_900_000_000_000, consecutive_errors: 1, last_status: 'error', last_error: detail, last_error_code: code },
  }
}

function fakeBackend(jobs: SchedulerJob[], runNow: Record<string, unknown> = { ok: true }): ReturnType<typeof useBackend> {
  return {
    status: ref('connected'),
    send: vi.fn(async (type: string) => {
      const body = type === 'scheduler.list' ? { ok: true, jobs } : type === 'scheduler.run_now' ? runNow : { ok: true }
      return { id: 'r', type, ok: true, payload: body, error: null, timestamp: '' }
    }),
    on: () => () => {},
  } as unknown as ReturnType<typeof useBackend>
}

function mountRow(job: SchedulerJob, runNow?: Record<string, unknown>): { wrapper: VueWrapper; api: () => SchedulerJobsApi } {
  let api: SchedulerJobsApi | undefined
  const Host = defineComponent({
    setup() {
      api = useSchedulerJobs(fakeBackend([job], runNow))
      return () => h(SchedulerJobRow, { job, api: api! })
    },
  })
  return { wrapper: mount(Host, { global: { plugins: [i18n] } }), api: () => api! }
}

describe('SchedulerJobRow – a failed job says why, in the UI language', () => {
  let wrapper: VueWrapper | undefined

  beforeEach(() => {
    i18n.global.locale.value = 'zh-TW'
  })
  afterEach(() => wrapper?.unmount())

  it('shows the translated reason of a known code, on the row and on Repair', async () => {
    ;({ wrapper } = mountRow(failedPipelineJob('pipeline_not_found')))
    await flushPromises()
    const reason = i18n.global.t('scheduler.fail-reason.pipeline_not_found')
    expect(reason).toContain('Pipeline 不存在')
    expect(wrapper.get('[data-test="fail-reason"]').text()).toBe(reason)
    expect(wrapper.get('[data-test="repair"]').attributes('title')).toBe(reason)
  })

  it('falls back to the recorded detail for a code it has no words for', async () => {
    ;({ wrapper } = mountRow(failedPipelineJob('ui_failed', 'the window said no')))
    await flushPromises()
    expect(wrapper.get('[data-test="fail-reason"]').text()).toBe('the window said no')
  })

  it('translates a Repair the backend refuses because no window holds the workspace', async () => {
    let api: () => SchedulerJobsApi
    ;({ wrapper, api } = mountRow(failedPipelineJob('no_window'), { ok: false, error_code: 'no_window', error: 'no Navide window has /ws open' }))
    await flushPromises()
    await wrapper.get('[data-test="repair"]').trigger('click')
    await flushPromises()
    expect(api().opError.value).toBe(i18n.global.t('scheduler.fail-reason.no_window'))
  })
})

describe('schedulerFailReason', () => {
  const t = i18n.global.t
  const te = i18n.global.te

  it('reads a WS refusal code (SCHEDULER_PIPELINE_NOT_FOUND) as its reason', () => {
    i18n.global.locale.value = 'en-US'
    expect(schedulerFailReason(t, te, 'SCHEDULER_PIPELINE_NOT_FOUND', 'raw')).toBe(t('scheduler.fail-reason.pipeline_not_found'))
    expect(schedulerFailReason(t, te, 'BAD_REQUEST', 'raw')).toBe('raw')
    expect(schedulerFailReason(t, te, '', 'raw')).toBe('raw')
  })
})

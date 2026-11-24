// @vitest-environment happy-dom
// Settings → General → Scheduler: the three daily run counts live in the
// backend; each field writes only its own key, and "no cap" sends null.
import { describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import { i18n } from '@navide/plugin-ui/foundation'

import SchedulerRunsSection from '../SchedulerRunsSection.vue'
import { createMockBackend } from '../../../composables/__tests__/mockBackend'

const DEFAULTS = { max_runs_per_day: 24, agent_max_runs_per_day: 288, agent_runs_per_day: 300 }

async function mountSection(settings: Record<string, number | null> = DEFAULTS) {
  const mock = createMockBackend()
  mock.setResponse('scheduler.settings.get', { ok: true, settings })
  const w = mount(SchedulerRunsSection, { props: { backend: mock.backend }, global: { plugins: [i18n] } })
  await flushPromises()
  return { w, mock }
}

describe('Settings → Scheduler daily runs', () => {
  it('shows the backend values, the old defaults until changed', async () => {
    const { w } = await mountSection()
    expect((w.get('[data-testid="scheduler-per-job-value"]').element as HTMLInputElement).value).toBe('24')
    expect((w.get('[data-testid="scheduler-agent-job-value"]').element as HTMLInputElement).value).toBe('288')
    expect((w.get('[data-testid="scheduler-agent-total-value"]').element as HTMLInputElement).value).toBe('300')
    expect((w.get('[data-testid="scheduler-per-job-no-cap"]').element as HTMLInputElement).checked).toBe(false)
  })

  it('writes only the field that changed', async () => {
    const { w, mock } = await mountSection()
    mock.setResponse('scheduler.settings.set', { ok: true, settings: { ...DEFAULTS, max_runs_per_day: 48 } })
    await w.get('[data-testid="scheduler-per-job-value"]').setValue('48')
    await flushPromises()
    expect(mock.sent.at(-1)).toMatchObject({ type: 'scheduler.settings.set', payload: { settings: { max_runs_per_day: 48 } } })
  })

  it('does not send an out-of-range value', async () => {
    const { w, mock } = await mountSection()
    const before = mock.sent.length
    await w.get('[data-testid="scheduler-agent-job-value"]').setValue('0')
    await flushPromises()
    expect(mock.sent.length).toBe(before)
    expect((w.get('[data-testid="scheduler-agent-job-value"]').element as HTMLInputElement).value).toBe('288')
  })

  it('"no cap" sends null and hides the number; unticking restores the default', async () => {
    const { w, mock } = await mountSection()
    mock.setResponse('scheduler.settings.set', { ok: true, settings: { ...DEFAULTS, agent_runs_per_day: null } })
    await w.get('[data-testid="scheduler-agent-total-no-cap"]').setValue(true)
    await flushPromises()
    expect(mock.sent.at(-1)?.payload).toEqual({ settings: { agent_runs_per_day: null } })
    expect(w.find('[data-testid="scheduler-agent-total-value"]').exists()).toBe(false)
    mock.setResponse('scheduler.settings.set', { ok: true, settings: DEFAULTS })
    await w.get('[data-testid="scheduler-agent-total-no-cap"]').setValue(false)
    await flushPromises()
    expect(mock.sent.at(-1)?.payload).toEqual({ settings: { agent_runs_per_day: 300 } })
  })

  it('says so when saving fails', async () => {
    const { w, mock } = await mountSection()
    mock.setResponse('scheduler.settings.set', null, { ok: false, error: { code: 'BAD_REQUEST', message: 'nope' } })
    await w.get('[data-testid="scheduler-per-job-value"]').setValue('30')
    await flushPromises()
    expect(w.get('[data-testid="scheduler-runs-error"]').text()).toBe('nope')
  })
})

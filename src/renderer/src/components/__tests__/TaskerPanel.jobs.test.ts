// @vitest-environment happy-dom
// Navide's own jobs in the Tasker tab (SchedulerJobRow + useSchedulerJobs) and
// JobEditorModal — the four status lights, the failed ×N | repair pill, the ▶
// grace window, the target_gone row, same-named panes told apart by id, editor
// validation, and where a job lands among the timeline (and its fixed-interval
// tail) / other / disabled groups next to the crontab rows.
// The backend is a prop, so every assertion is on the real wire payloads.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick, ref, type Component } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import type { useBackend } from '../../composables/useBackend'
import type { SchedulerJob } from '../../lib/schedulerJobs'

const t = (key: string, params?: Record<string, unknown>): string =>
  params ? i18n.global.t(key, params) : i18n.global.t(key)

const WS = '/Users/t/proj'
const PANE_A = 'aaaaaaaa-1111-4111-8111-111111111111'
const PANE_B = 'bbbbbbbb-2222-4222-8222-222222222222'

const wire = {
  calls: [] as { type: string; payload: Record<string, unknown> }[],
  jobs: [] as SchedulerJob[],
  roster: [] as Record<string, unknown>[],
  overrides: new Map<string, unknown>(),
  envelopeErrors: new Map<string, string>(),
  listeners: new Map<string, Set<(p: unknown) => void>>(),
}

function job(id: string, over: Partial<SchedulerJob> = {}): SchedulerJob {
  return {
    id,
    name: `job-${id}`,
    enabled: true,
    schedule: { kind: 'daily', at: '09:00', tz: 'UTC' },
    action: { kind: 'message', workspace: WS, pane_id: PANE_A, pane_name: '週報', text: 'hi' },
    policy: { catch_up: 'once', max_runs_per_day: 24 },
    state: { next_run_at: 1_900_000_000_000, consecutive_errors: 0, last_status: null },
    ...over,
  }
}

function fakeBackend(): ReturnType<typeof useBackend> {
  return {
    status: ref('connected'),
    send: vi.fn(async (type: string, payload: Record<string, unknown> = {}) => {
      wire.calls.push({ type, payload })
      const envelopeError = wire.envelopeErrors.get(type)
      if (envelopeError !== undefined) {
        return { id: 'r', type, ok: false, payload: null, error: { message: envelopeError }, timestamp: '' }
      }
      const override = wire.overrides.get(type)
      let body: unknown = { ok: true }
      if (override !== undefined) body = override
      else if (type === 'scheduler.list') body = { ok: true, jobs: wire.jobs, now: Date.now() }
      else if (type === 'agent_msg.list') body = { panes: wire.roster }
      else if (type === 'scheduler.upsert')
        body = { ok: true, job: { ...(payload.job as object), id: 'new-id', state: {} } }
      else if (type === 'scheduler.run_now') body = { ok: true, enqueued: true }
      else if (type === 'executions.list')
        body = {
          platform: 'darwin',
          scanned_at: 1_770_000_000,
          crontab: {
            supported: true,
            error: null,
            entries: [
              {
                id: 'c1',
                name: 'backup-photos',
                schedule: '30 2 * * *',
                schedule_kind: 'standard',
                command: '~/bin/backup.sh',
                raw: '30 2 * * * ~/bin/backup.sh',
                enabled: true,
              },
            ],
          },
          launch_agents: { supported: true, error: null, agents: [] },
        }
      return { id: 'r', type, ok: true, payload: body, error: null, timestamp: '' }
    }),
    on: (type: string, cb: (p: unknown) => void) => {
      let set = wire.listeners.get(type)
      if (!set) {
        set = new Set()
        wire.listeners.set(type, set)
      }
      set.add(cb)
      return () => set!.delete(cb)
    },
  } as unknown as ReturnType<typeof useBackend>
}

function emit(type: string, payload: unknown): void {
  for (const cb of wire.listeners.get(type) ?? []) cb(payload)
}

const mountOpts = (backend: ReturnType<typeof useBackend>) => ({
  props: { backend },
  global: { plugins: [i18n], stubs: { teleport: true } },
})

/** Freshly imported per test: TaskerPanel caches its last scan at module scope. */
let TaskerPanel: Component

/** Mounts the panel with every group expanded, so each job row is reachable
 *  whichever group its fixture lands in (most fixtures carry no next_run_at). */
async function mountSection(): Promise<VueWrapper> {
  const wrapper = mount(TaskerPanel, mountOpts(fakeBackend()))
  await flushPromises()
  for (const btn of wrapper.findAll('.tk-group')) {
    if (btn.attributes('aria-expanded') !== 'true') await btn.trigger('click')
  }
  return wrapper
}

async function openGroup(wrapper: VueWrapper, id: string): Promise<void> {
  const btn = wrapper.get(`[data-section="${id}"] .tk-group`)
  if (btn.attributes('aria-expanded') !== 'true') await btn.trigger('click')
}

function groupOf(wrapper: VueWrapper, id: string): string | null | undefined {
  return row(wrapper, id).element.closest('[data-section]')?.getAttribute('data-section')
}

function row(wrapper: VueWrapper, id: string) {
  return wrapper.get(`[data-job-id="${id}"]`)
}
function lightOf(wrapper: VueWrapper, id: string): string | undefined {
  return row(wrapper, id).attributes('data-light')
}
/** Re-queried on every use: a wrapper held across re-renders goes stale. */
function editorOf(wrapper: VueWrapper) {
  return wrapper.get('[data-test="job-editor"]')
}
function callsOf(type: string) {
  return wire.calls.filter((c) => c.type === type)
}
/** Settles the awaited send() chain without touching (possibly fake) timers. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
  await nextTick()
}

describe('TaskerPanel — Navide jobs', () => {
  let wrapper: VueWrapper | undefined

  beforeEach(async () => {
    localStorage.clear()
    vi.resetModules()
    TaskerPanel = ((await import('../TaskerPanel.vue')) as { default: Component }).default
    wire.calls.length = 0
    wire.jobs = []
    wire.roster = []
    wire.overrides.clear()
    wire.envelopeErrors.clear()
    wire.listeners.clear()
  }, 30_000)

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    vi.useRealTimers()
  })

  it('maps job state to the four lights', async () => {
    wire.jobs = [
      job('ok', { state: { last_status: 'ok', consecutive_errors: 0 } }),
      job('run', { state: { running_at: 1, last_status: 'ok', consecutive_errors: 0 } }),
      job('err', { state: { last_status: 'error', consecutive_errors: 2 } }),
      job('skip', { state: { last_status: 'skipped', last_skip_reason: 'no_window', consecutive_errors: 0 } }),
      job('off', { enabled: false, state: { last_status: 'ok', consecutive_errors: 0 } }),
    ]
    wrapper = await mountSection()
    await openGroup(wrapper, 'disabled')
    expect(lightOf(wrapper, 'ok')).toBe('ok')
    expect(lightOf(wrapper, 'run')).toBe('running')
    expect(lightOf(wrapper, 'err')).toBe('err')
    expect(lightOf(wrapper, 'skip')).toBe('skip')
    expect(lightOf(wrapper, 'off')).toBe('off')
    // Grey carries its reason; a disabled job sits in the Disabled group.
    expect(row(wrapper, 'skip').get('[data-test="skip-tag"]').text()).toBe(t('scheduler.skip.no_window'))
    expect(groupOf(wrapper, 'off')).toBe('disabled')
  })

  it('shows the failed ×N | repair pill and repair re-runs the job', async () => {
    wire.jobs = [job('err', { state: { last_status: 'error', consecutive_errors: 3, last_error: 'timeout' } })]
    wrapper = await mountSection()
    const pill = row(wrapper, 'err').get('[data-test="fail-pill"]')
    expect(pill.text()).toContain(t('scheduler.failed', { n: 3 }))

    await pill.get('[data-test="repair"]').trigger('click')
    await flushPromises()
    expect(callsOf('scheduler.run_now').map((c) => c.payload)).toEqual([{ id: 'err' }])
    // Inside the grace window the row reads as running, not failed.
    expect(lightOf(wrapper, 'err')).toBe('running')
    expect(row(wrapper, 'err').find('[data-test="fail-pill"]').exists()).toBe(false)
  })

  it('holds orange for at most 60 s after ▶, and drops it when run_now is refused', async () => {
    wire.jobs = [job('ok', { state: { last_status: 'ok', consecutive_errors: 0, last_run_at: 1 } })]
    wrapper = await mountSection()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(1_800_000_000_000)

    await row(wrapper, 'ok').get('[data-test="run-now"]').trigger('click')
    await settle()
    expect(lightOf(wrapper, 'ok')).toBe('running')

    vi.advanceTimersByTime(59_000)
    await nextTick()
    expect(lightOf(wrapper, 'ok')).toBe('running')

    vi.advanceTimersByTime(1_001)
    await nextTick()
    expect(lightOf(wrapper, 'ok')).toBe('ok')

    // A refused run_now must not leave a fake "running" behind.
    wire.overrides.set('scheduler.run_now', { ok: false, error: 'already running' })
    await row(wrapper, 'ok').get('[data-test="run-now"]').trigger('click')
    await settle()
    expect(lightOf(wrapper, 'ok')).toBe('ok')
    expect(wrapper.get('[data-test="op-error"]').text()).toBe('already running')
  })

  it('ends the grace window early once a run that started after ▶ has finished', async () => {
    wire.jobs = [job('ok', { state: { last_status: 'ok', consecutive_errors: 0, last_run_at: 1 } })]
    wrapper = await mountSection()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(1_800_000_000_000)
    await row(wrapper, 'ok').get('[data-test="run-now"]').trigger('click')
    await settle()
    expect(lightOf(wrapper, 'ok')).toBe('running')

    emit('scheduler.changed', {
      jobs: [job('ok', { state: { last_status: 'ok', consecutive_errors: 0, last_run_at: 1_800_000_005_000 } })],
    })
    await nextTick()
    expect(lightOf(wrapper, 'ok')).toBe('ok')
  })

  it('shows a job the backend disabled for a gone target in red, with why and rebind', async () => {
    wire.jobs = [
      job('stopped', {
        enabled: false,
        state: {
          last_status: 'skipped', last_skip_reason: 'target_gone', consecutive_errors: 0,
          consecutive_target_gone: 3, disabled_reason: 'target_gone',
        },
      }),
    ]
    wrapper = await mountSection()
    const r = row(wrapper, 'stopped')
    expect(r.attributes('data-light')).toBe('err')
    expect(r.get('[data-test="target-gone"]').text()).toContain(t('scheduler.gone-disabled', { n: 3 }))
    expect(r.find('[data-test="retarget"]').exists()).toBe(true)
  })

  it('drops the red once a rebuild rebound the job, and asks to switch a stopped one back on', async () => {
    wire.jobs = [
      job('stopped', {
        enabled: false,
        state: {
          last_status: 'skipped', last_skip_reason: null, consecutive_errors: 0,
          consecutive_target_gone: 0, disabled_reason: null, rebound_from: PANE_A,
          rebound_needs_enable: true,
        },
      }),
      // Rebound, switched back on, then stopped by hand: the ask was answered.
      job('stopped-later', {
        enabled: false,
        state: { last_status: 'ok', consecutive_errors: 0, rebound_from: PANE_A, rebound_needs_enable: false },
      }),
      job('running', {
        state: {
          last_status: 'skipped', last_skip_reason: null, consecutive_errors: 0,
          consecutive_target_gone: 0, disabled_reason: null, rebound_from: PANE_A,
        },
      }),
    ]
    wrapper = await mountSection()
    const stopped = row(wrapper, 'stopped')
    expect(stopped.attributes('data-light')).toBe('off')
    expect(stopped.find('[data-test="target-gone"]').exists()).toBe(false)
    expect(stopped.get('[data-test="rebound"]').text()).toContain(t('scheduler.rebound-reenable'))
    expect(row(wrapper, 'stopped-later').find('[data-test="rebound"]').exists()).toBe(false)
    const running = row(wrapper, 'running')
    expect(running.attributes('data-light')).toBe('skip')
    expect(running.find('[data-test="target-gone"]').exists()).toBe(false)
    expect(running.find('[data-test="rebound"]').exists()).toBe(false)
  })

  it('shows a gone target and opens the editor from "retarget"', async () => {
    wire.jobs = [
      job('gone', {
        state: { last_status: 'skipped', last_skip_reason: 'target_gone', consecutive_errors: 0 },
      }),
    ]
    wire.roster = [{ pane_id: PANE_B, name: '週報', workspace_path: WS, workspace_label: 'proj', agent_key: 'claude' }]
    wrapper = await mountSection()
    const r = row(wrapper, 'gone')
    // Red, but not a failure: no failed ×N pill for a skip.
    expect(r.attributes('data-light')).toBe('err')
    expect(r.find('[data-test="fail-pill"]').exists()).toBe(false)
    expect(r.get('[data-test="target-gone"]').text()).toContain(t('scheduler.skip.target_gone'))
    expect(r.get('[data-test="retarget"]').text()).toBe(t('scheduler.retarget'))
    expect(r.find('[data-test="skip-tag"]').exists()).toBe(false)

    await r.get('[data-test="retarget"]').trigger('click')
    await flushPromises()
    expect((editorOf(wrapper).get('[data-field="name"]').element as HTMLInputElement).value).toBe('job-gone')
    // The vanished pane stays selected as its own "gone" option — never
    // silently swapped for the live pane that happens to share its name.
    const select = editorOf(wrapper).get('[data-field="target"]').element as HTMLSelectElement
    expect(select.value).toBe(PANE_A)
    expect(editorOf(wrapper).get('option[data-missing="true"]').text()).toContain('#aaaaaaaa')
  })

  it('tells same-named panes apart by id, in the picker and on the row', async () => {
    wire.roster = [
      { pane_id: PANE_A, name: '週報', workspace_path: WS, workspace_label: 'proj', agent_key: 'claude' },
      { pane_id: PANE_B, name: '週報', workspace_path: WS, workspace_label: 'proj', agent_key: 'codex' },
      { pane_id: 'cccccccc-x', name: 'other', workspace_path: '/elsewhere', workspace_label: 'elsewhere', agent_key: 'claude' },
    ]
    wrapper = await mountSection()
    await wrapper.get('[data-test="add-job"]').trigger('click')
    await flushPromises()

    await editorOf(wrapper).get('[data-field="name"]').setValue('週報整理')
    await editorOf(wrapper).get('[data-field="workspace"]').setValue(WS)
    const labels = editorOf(wrapper).findAll('[data-field="target"] option').map((o) => o.text())
    expect(labels).toContain(t('scheduler.editor.pane-option', { name: '週報', agent: 'claude', id: 'aaaaaaaa' }))
    expect(labels).toContain(t('scheduler.editor.pane-option', { name: '週報', agent: 'codex', id: 'bbbbbbbb' }))
    // Only the chosen workspace's panes are offered.
    expect(labels.some((l) => l.includes('cccccccc'))).toBe(false)

    await editorOf(wrapper).get('[data-field="target"]').setValue(PANE_B)
    await editorOf(wrapper).get('[data-field="text"]').setValue('整理昨天的 commit')
    await editorOf(wrapper).get('[data-test="save"]').trigger('click')
    await flushPromises()

    const [upsert] = callsOf('scheduler.upsert')
    const sent = upsert.payload.job as Record<string, unknown>
    expect(sent.id).toBeUndefined()
    expect(sent.action).toEqual({
      kind: 'message',
      workspace: WS,
      pane_id: PANE_B,
      pane_name: '週報',
      text: '整理昨天的 commit',
    })
    expect(wrapper.find('[data-test="job-editor"]').exists()).toBe(false)

    // The row names the pane with its short id.
    wire.jobs = [job('j', { action: { kind: 'message', workspace: WS, pane_id: PANE_B, pane_name: '週報', text: 'x' } })]
    emit('scheduler.changed', { jobs: wire.jobs })
    await nextTick()
    expect(row(wrapper, 'j').get('[data-test="target"]').text()).toBe(
      t('scheduler.target-with-id', { name: '週報', id: 'bbbbbbbb' })
    )
  })

  it('validates the editor before sending, and shows a BAD_REQUEST reason', async () => {
    wire.roster = [{ pane_id: PANE_A, name: '週報', workspace_path: WS, workspace_label: 'proj', agent_key: 'claude' }]
    wrapper = await mountSection()
    await wrapper.get('[data-test="add-job"]').trigger('click')
    await flushPromises()
    // One workspace open: preselected.
    expect((editorOf(wrapper).get('[data-field="workspace"]').element as HTMLSelectElement).value).toBe(WS)

    await editorOf(wrapper).get('[data-test="save"]').trigger('click')
    await flushPromises()
    expect(callsOf('scheduler.upsert')).toHaveLength(0)
    for (const f of ['name', 'target', 'text']) expect(editorOf(wrapper).find(`[data-error="${f}"]`).exists()).toBe(true)

    await editorOf(wrapper).get('[data-freq="every"]').trigger('click')
    await editorOf(wrapper).get('[data-field="every"]').setValue(0)
    expect(editorOf(wrapper).get('[data-error="schedule"]').text()).toBe(t('scheduler.editor.err-every', { max: 10080 }))
    await editorOf(wrapper).get('[data-field="every"]').setValue(15)
    expect(editorOf(wrapper).find('[data-error="schedule"]').exists()).toBe(false)

    await editorOf(wrapper).get('[data-freq="weekly"]').trigger('click')
    for (const d of [1, 2, 3, 4, 5]) await editorOf(wrapper).get(`[data-day="${d}"]`).trigger('click')
    expect(editorOf(wrapper).get('[data-error="schedule"]').text()).toBe(t('scheduler.editor.err-days'))
    await editorOf(wrapper).get('[data-day="3"]').trigger('click')
    await editorOf(wrapper).get('[data-field="tz"]').setValue('Not/AZone')
    expect(editorOf(wrapper).get('[data-error="schedule"]').text()).toBe(t('scheduler.editor.err-tz'))
    await editorOf(wrapper).get('[data-field="tz"]').setValue('Asia/Taipei')
    expect(editorOf(wrapper).find('[data-test="next-preview"]').exists()).toBe(true)

    await editorOf(wrapper).get('[data-field="name"]').setValue('週報')
    await editorOf(wrapper).get('[data-field="target"]').setValue(PANE_A)
    await editorOf(wrapper).get('[data-field="text"]').setValue('go')
    wire.envelopeErrors.set('scheduler.upsert', 'schedule.at must be HH:MM')
    await editorOf(wrapper).get('[data-test="save"]').trigger('click')
    await flushPromises()
    expect(callsOf('scheduler.upsert')).toHaveLength(1)
    expect((callsOf('scheduler.upsert')[0].payload.job as { schedule: unknown }).schedule).toEqual({
      kind: 'weekly',
      days: [3],
      at: '09:00',
      tz: 'Asia/Taipei',
    })
    expect(editorOf(wrapper).get('[data-test="editor-error"]').text()).toBe('schedule.at must be HH:MM')
  })

  it('describes a once job, and a spent one as done', async () => {
    const atMs = new Date(2031, 8, 24, 14, 0).getTime()
    wire.jobs = [
      job('pending', { schedule: { kind: 'once', at_ms: atMs }, state: { next_run_at: atMs, consecutive_errors: 0 } }),
      job('spent', {
        enabled: false,
        schedule: { kind: 'once', at_ms: atMs },
        state: { next_run_at: null, last_status: 'skipped', consecutive_errors: 0 },
      }),
    ]
    wrapper = await mountSection()
    await openGroup(wrapper, 'disabled')
    expect(groupOf(wrapper, 'pending')).toBe('timeline')
    expect(row(wrapper, 'pending').get('[data-test="desc"]').text()).toBe(
      t('scheduler.once-at', { time: new Date(atMs).toLocaleString(undefined, {
        month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
      }) })
    )
    expect(row(wrapper, 'spent').get('[data-test="desc"]').text()).toBe(t('scheduler.once-done'))
  })

  it('edits a once job as once, keeping its exact moment when the time is untouched', async () => {
    // A past moment with seconds: re-saving must send it back unchanged.
    const atMs = new Date(2020, 0, 2, 3, 4, 56).getTime()
    wire.jobs = [
      job('o', {
        enabled: false,
        schedule: { kind: 'once', at_ms: atMs },
        state: { next_run_at: null, last_status: 'ok', consecutive_errors: 0 },
      }),
    ]
    wire.roster = [{ pane_id: PANE_A, name: '週報', workspace_path: WS, workspace_label: 'proj', agent_key: 'claude' }]
    wrapper = await mountSection()
    await openGroup(wrapper, 'disabled')
    await row(wrapper, 'o').get('.sj-name').trigger('click')
    await flushPromises()
    expect(editorOf(wrapper).get('[data-freq="once"]').classes()).toContain('on')
    expect((editorOf(wrapper).get('[data-field="once"]').element as HTMLInputElement).value).toBe('2020-01-02T03:04')
    await editorOf(wrapper).get('[data-field="name"]').setValue('renamed')
    await editorOf(wrapper).get('[data-test="save"]').trigger('click')
    await flushPromises()
    const sent = callsOf('scheduler.upsert')[0].payload.job as { schedule: unknown; enabled: boolean }
    expect(sent.schedule).toEqual({ kind: 'once', at_ms: atMs })
    expect(sent.enabled).toBe(false)
  })

  it('creates a once job from a date and time, and refuses one in the past', async () => {
    wire.roster = [{ pane_id: PANE_A, name: '週報', workspace_path: WS, workspace_label: 'proj', agent_key: 'claude' }]
    wrapper = await mountSection()
    await wrapper.get('[data-test="add-job"]').trigger('click')
    await flushPromises()
    await editorOf(wrapper).get('[data-freq="once"]').trigger('click')
    await editorOf(wrapper).get('[data-field="name"]').setValue('wake')
    await editorOf(wrapper).get('[data-field="target"]').setValue(PANE_A)
    await editorOf(wrapper).get('[data-field="text"]').setValue('continue')
    await editorOf(wrapper).get('[data-field="once"]').setValue('2020-01-01T09:00')
    await editorOf(wrapper).get('[data-test="save"]').trigger('click')
    await flushPromises()
    expect(callsOf('scheduler.upsert')).toHaveLength(0)
    expect(editorOf(wrapper).get('[data-error="schedule"]').text()).toBe(t('scheduler.editor.err-once'))

    await editorOf(wrapper).get('[data-field="once"]').setValue('2099-09-24T14:00')
    expect(editorOf(wrapper).find('[data-test="next-preview"]').exists()).toBe(true)
    await editorOf(wrapper).get('[data-test="save"]').trigger('click')
    await flushPromises()
    expect((callsOf('scheduler.upsert')[0].payload.job as { schedule: unknown }).schedule).toEqual({
      kind: 'once',
      at_ms: new Date(2099, 8, 24, 14, 0).getTime(),
    })
  })

  it('toggles a job and re-reads the list (the broadcast skips the sender)', async () => {
    wire.jobs = [job('a')]
    wrapper = await mountSection()
    const before = callsOf('scheduler.list').length
    await row(wrapper, 'a').get('[data-test="toggle"]').trigger('click')
    await flushPromises()
    expect(callsOf('scheduler.set_enabled').map((c) => c.payload)).toEqual([{ id: 'a', enabled: false }])
    expect(callsOf('scheduler.list').length).toBe(before + 1)
  })

  it('places each job by its schedule, next to the crontab rows', async () => {
    wire.jobs = [
      job('daily'),
      job('minutely', { schedule: { kind: 'every', every_ms: 60_000 } }),
      job('off', { enabled: false }),
      job('unscheduled', { state: { consecutive_errors: 0 } }),
    ]
    wrapper = await mountSection()
    await openGroup(wrapper, 'other')
    await openGroup(wrapper, 'disabled')

    // The backend's next_run_at puts a job on the timeline, with its time.
    expect(groupOf(wrapper, 'daily')).toBe('timeline')
    expect(row(wrapper, 'daily').element.closest('.tk-item')?.querySelector('[data-test="when-col"]')).not.toBeNull()
    // A heartbeat job sits in the timeline's fixed-interval tail, shown as its interval.
    expect(groupOf(wrapper, 'minutely')).toBe('timeline')
    expect(row(wrapper, 'minutely').element.closest('.tk-item')?.querySelector('[data-test="interval-col"]')?.textContent?.trim()).toBe(
      t('executions.interval.minutes', { n: 1 })
    )
    expect(groupOf(wrapper, 'off')).toBe('disabled')
    expect(groupOf(wrapper, 'unscheduled')).toBe('other')
    // The OS rows share the same timeline.
    expect(wrapper.get('[data-section="timeline"]').find('[data-entry-id="c1"]').exists()).toBe(true)
    // Every job row names its source.
    expect(row(wrapper, 'daily').get('.sj-src').text()).toBe('Navide')
  })

  it('counts a failing job in the failure bar', async () => {
    wire.jobs = [job('err', { state: { last_status: 'error', consecutive_errors: 2, next_run_at: 1_900_000_000_000 } })]
    wrapper = await mountSection()
    expect(wrapper.get('[data-test="failing-bar"]').text()).toContain(t('executions.failing', { count: 1 }))
    await wrapper.get('[data-test="only-failing"]').trigger('click')
    expect(groupOf(wrapper, 'err')).toBe('failing')
  })

  it('tells the user to restart when the backend predates scheduler.*', async () => {
    wire.envelopeErrors.set('scheduler.list', "Unsupported message type: 'scheduler.list'")
    wrapper = await mountSection()
    const hint = wrapper.get('[data-test="jobs-error"]')
    expect(hint.text()).toContain(t('executions.backend-outdated'))
    // The raw protocol error stays reachable, and the line offers a retry.
    expect(hint.attributes('title')).toContain('scheduler.list')

    wire.envelopeErrors.clear()
    await hint.get('.tk-hint-btn').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="jobs-error"]').exists()).toBe(false)
  })

  it('shows any other list failure with its message', async () => {
    wire.envelopeErrors.set('scheduler.list', 'database is locked')
    wrapper = await mountSection()
    expect(wrapper.get('[data-test="jobs-error"] .tk-hint-text').text()).toBe(
      t('scheduler.list-failed', { message: 'database is locked' })
    )
    // No "create your first job" prompt while the list is unknown.
    expect(wrapper.find('[data-test="jobs-empty"]').exists()).toBe(false)
  })

  it('still shows Navide jobs on a platform with no crontab or launchd (win32)', async () => {
    wire.jobs = [job('a')]
    wire.overrides.set('executions.list', {
      platform: 'win32',
      scanned_at: 1_770_000_000,
      crontab: { supported: false, error: null, entries: [] },
      launch_agents: { supported: false, error: null, agents: [] },
    })
    wrapper = await mountSection()
    expect(wrapper.find('[data-test="executions-no-source"]').exists()).toBe(true)
    expect(wrapper.find('[data-entry-id]').exists()).toBe(false)
    expect(wrapper.get('[data-section="timeline"]').find('[data-job-id="a"]').exists()).toBe(true)
  })

  const AGENT = { kind: 'pane' as const, pane_id: PANE_B, pane_name: '排程功能', workspace: WS }
  const LIMITS = { agent_enabled_total: 100, agent_enabled: 1, agent_runs_per_day: 300, agent_runs_today: 12 }

  it('labels agent jobs with their creator, expiry and last editor; the user\'s carry none', async () => {
    const expires = Date.now() + 3 * 86_400_000 - 1000
    wire.jobs = [
      job('mine', { owner: { kind: 'user' } }),
      job('theirs', { owner: { ...AGENT, expires_at: expires }, updated_by: AGENT }),
      job('ext', { owner: { kind: 'external', expires_at: null }, updated_by: { kind: 'user' } }),
    ]
    wire.overrides.set('scheduler.list', { ok: true, jobs: wire.jobs, now: Date.now(), limits: LIMITS })
    wrapper = await mountSection()
    expect(row(wrapper, 'mine').find('[data-test="owner"]').exists()).toBe(false)
    expect(row(wrapper, 'mine').find('[data-test="expiry"]').exists()).toBe(false)
    const theirs = row(wrapper, 'theirs')
    expect(theirs.get('[data-test="owner"]').text()).toBe(t('scheduler.owner.agent', { name: '排程功能' }))
    expect(theirs.get('[data-test="expiry"]').text()).toContain(t('scheduler.owner.expires-in', { n: 3 }))
    expect(theirs.get('[data-test="updated-by"]').text()).toBe(
      t('scheduler.owner.updated-by', { name: '排程功能' })
    )
    const ext = row(wrapper, 'ext')
    expect(ext.get('[data-test="owner"]').text()).toBe(t('scheduler.owner.external'))
    // Kept by the user: no expiry; changed by the user: no "last changed by".
    expect(ext.find('[data-test="expiry"]').exists()).toBe(false)
    expect(ext.find('[data-test="updated-by"]').exists()).toBe(false)
    expect(wrapper.get('[data-test="agent-meter"]').text()).toBe(
      t('scheduler.limit.meter', { n: 2, max: 100, runs: 12, runsMax: 300 })
    )
    expect(wrapper.find('[data-test^="agent-limit-"]').exists()).toBe(false)
  })

  it('offers "make it mine" when the creator is gone, and "keep" on an expiring job', async () => {
    wire.jobs = [
      job('orphan', { owner: AGENT, owner_gone: true }),
      job('expiring', { owner: { ...AGENT, expires_at: Date.now() + 86_400_000 } }),
    ]
    wrapper = await mountSection()
    const orphan = row(wrapper, 'orphan')
    expect(orphan.get('[data-test="owner-gone"]').text()).toContain(t('scheduler.owner.gone'))
    const before = callsOf('scheduler.list').length
    await orphan.get('[data-test="adopt"]').trigger('click')
    await flushPromises()
    expect(callsOf('scheduler.adopt').map((c) => c.payload)).toEqual([{ id: 'orphan' }])
    expect(callsOf('scheduler.list').length).toBe(before + 1)
    await row(wrapper, 'expiring').get('[data-test="keep"]').trigger('click')
    await flushPromises()
    expect(callsOf('scheduler.keep').map((c) => c.payload)).toEqual([{ id: 'expiring' }])
  })

  it('shows the agent limit notices once agents reach them', async () => {
    wire.jobs = Array.from({ length: 100 }, (_, i) => job(`a${i}`, { owner: AGENT }))
    wire.overrides.set('scheduler.list', {
      ok: true,
      jobs: wire.jobs,
      now: Date.now(),
      limits: { ...LIMITS, agent_enabled: 100, agent_runs_today: 300 },
    })
    wrapper = await mountSection()
    expect(wrapper.get('[data-test="agent-limit-enabled"]').text()).toBe(
      t('scheduler.limit.enabled-full', { n: 100, max: 100 })
    )
    expect(wrapper.get('[data-test="agent-limit-runs"]').text()).toBe(
      t('scheduler.limit.runs-full', { runs: 300, max: 300 })
    )
    // Disabling one (the broadcast carries the new list) clears the first notice.
    emit('scheduler.changed', { jobs: [job('a0', { owner: AGENT, enabled: false }), ...wire.jobs.slice(1)] })
    await nextTick()
    expect(wrapper.find('[data-test="agent-limit-enabled"]').exists()).toBe(false)
  })
})

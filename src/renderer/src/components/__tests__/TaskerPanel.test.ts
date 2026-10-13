// @vitest-environment happy-dom
// TaskerPanel (the right-rail "Tasker" tab) — how rows are grouped into the
// timeline (with its fixed-interval tail) / other / disabled lists, row expansion, the ⋯ menu and
// the mandatory delete confirmation, one-line error reporting, and the
// executions.changed rescan. The backend is passed in as a prop, so every
// assertion is on the real wire payloads.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { ref, type Component, type Ref } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import type { useBackend } from '../../composables/useBackend'

const wire = {
  calls: [] as { type: string; payload: Record<string, unknown> }[],
  /** Per-test override of the payload returned for a given request type. */
  overrides: new Map<string, unknown>(),
  /** Types whose next response fails at the envelope level (`ok: false`). */
  envelopeErrors: new Map<string, string>(),
  listeners: new Map<string, Set<(p: unknown) => void>>(),
  /** Request type parked until the test releases it, plus its gate. */
  holdType: null as string | null,
  hold: Promise.resolve() as Promise<void>,
}

/** Park the next request of `type`; returns the release callback. The response
 *  body is captured before parking, so it carries the state of that moment. */
function holdNext(type: string): () => void {
  let release = (): void => {}
  wire.hold = new Promise<void>((resolve) => {
    release = resolve
  })
  wire.holdType = type
  return release
}

function snapshot(): Record<string, unknown> {
  return {
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
          command: '~/bin/backup-photos.sh --destination /Volumes/Archive',
          raw: '30 2 * * * ~/bin/backup-photos.sh --destination /Volumes/Archive',
          enabled: true,
        },
        {
          id: 'c2',
          name: 'warm-cache',
          schedule: '@reboot',
          schedule_kind: 'special',
          command: '~/bin/warm-cache.sh',
          raw: '@reboot ~/bin/warm-cache.sh',
          enabled: true,
        },
        {
          id: 'c3',
          name: 'old-report',
          schedule: '0 9 * * 1',
          schedule_kind: 'standard',
          command: '~/bin/weekly-report.sh',
          raw: '# [NAVIDE-DISABLED] 0 9 * * 1 ~/bin/weekly-report.sh',
          enabled: false,
        },
      ],
    },
    launch_agents: {
      supported: true,
      error: null,
      agents: [
        {
          label: 'com.syncthing.syncthing',
          name: 'Syncthing',
          plist_path: '/Users/t/Library/LaunchAgents/com.syncthing.syncthing.plist',
          plist_exists: true,
          scope: 'user',
          managed: true,
          runtime_known: true,
          loaded: true,
          running: true,
          pid: 921,
          last_exit_code: null,
          keep_alive: true,
          run_at_load: false,
          start_interval: null,
          start_calendar: [],
          comment: null,
        },
        {
          label: 'local.nightly.index',
          name: 'Nightly Index',
          plist_path: '/Users/t/Library/LaunchAgents/local.nightly.index.plist',
          plist_exists: true,
          scope: 'user',
          managed: true,
          runtime_known: true,
          loaded: true,
          running: false,
          pid: null,
          last_exit_code: 78,
          keep_alive: false,
          run_at_load: false,
          start_interval: null,
          start_calendar: [{ Hour: 3, Minute: 0 }],
          comment: null,
        },
        {
          label: 'local.legacy.backup',
          name: 'Legacy Backup',
          plist_path: '/Users/t/Library/LaunchAgents/local.legacy.backup.plist',
          plist_exists: true,
          scope: 'user',
          managed: true,
          runtime_known: true,
          loaded: false,
          running: false,
          pid: null,
          last_exit_code: 0,
          keep_alive: false,
          run_at_load: true,
          start_interval: null,
          start_calendar: [],
          comment: null,
        },
        {
          // /Library/LaunchAgents is bootstrapped into gui/$UID, so launchctl
          // can see it: read-only, but with a real state.
          label: 'com.vendor.updater',
          name: 'Vendor Updater',
          plist_path: '/Library/LaunchAgents/com.vendor.updater.plist',
          plist_exists: true,
          scope: 'system-agent',
          managed: false,
          runtime_known: true,
          loaded: true,
          running: true,
          pid: 400,
          last_exit_code: null,
          keep_alive: true,
          run_at_load: false,
          start_interval: null,
          start_calendar: [],
          comment: null,
        },
        {
          // A system daemon: invisible to `launchctl list` without root, so
          // every runtime field is null rather than false.
          label: 'com.vendor.daemon',
          name: 'Vendor Daemon',
          plist_path: '/Library/LaunchDaemons/com.vendor.daemon.plist',
          plist_exists: true,
          scope: 'system-daemon',
          managed: false,
          runtime_known: false,
          loaded: null,
          running: null,
          pid: null,
          last_exit_code: null,
          keep_alive: true,
          run_at_load: false,
          start_interval: null,
          start_calendar: [],
          comment: null,
        },
        {
          // …and a daemon `launchctl list` *can* see: a daemon's runtime state
          // is not always unknown, so the Daemons section must not hardcode it.
          label: 'com.vendor.visible',
          name: 'Visible Daemon',
          plist_path: '/Library/LaunchDaemons/com.vendor.visible.plist',
          plist_exists: true,
          scope: 'system-daemon',
          managed: false,
          runtime_known: true,
          loaded: true,
          running: true,
          pid: 77,
          last_exit_code: null,
          keep_alive: true,
          run_at_load: false,
          start_interval: null,
          start_calendar: [],
          comment: null,
        },
      ],
    },
  }
}

function fakeBackend(): ReturnType<typeof useBackend> {
  return {
    status: ref('connected'),
    wsUrl: ref(''),
    httpUrl: ref(''),
    shell: ref(''),
    port: ref(0),
    pid: ref(0),
    lastError: ref(''),
    send: vi.fn(async (type: string, payload: Record<string, unknown> = {}) => {
      wire.calls.push({ type, payload })
      const override = wire.overrides.get(type)
      const body =
        override !== undefined ? override : type === 'executions.list' ? snapshot() : { ok: true }
      const envelopeError = wire.envelopeErrors.get(type)
      if (wire.holdType === type) {
        wire.holdType = null
        await wire.hold
      }
      if (envelopeError !== undefined) {
        return {
          id: 'r',
          type,
          ok: false,
          payload: null,
          error: { message: envelopeError },
          timestamp: '',
        }
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
    restart: vi.fn(),
    stop: vi.fn(),
  } as unknown as ReturnType<typeof useBackend>
}

/** Freshly imported per test — see the module reset in `beforeEach`. */
let TaskerPanel: Component

async function mountPanel(
  backend: ReturnType<typeof useBackend> = fakeBackend()
): Promise<VueWrapper> {
  const wrapper = mount(TaskerPanel, {
    props: { backend },
    global: { plugins: [i18n], stubs: { teleport: true } },
  })
  await flushPromises()
  return wrapper
}

function section(wrapper: VueWrapper, id: string) {
  return wrapper.get(`[data-section="${id}"]`)
}
/** Expand a collapsible group (other / disabled start closed). */
async function openGroup(wrapper: VueWrapper, id: string): Promise<void> {
  const btn = section(wrapper, id).get('.tk-group')
  if (btn.attributes('aria-expanded') !== 'true') await btn.trigger('click')
}
async function openAllGroups(wrapper: VueWrapper): Promise<void> {
  for (const id of ['other', 'disabled']) {
    if (wrapper.find(`[data-section="${id}"]`).exists()) await openGroup(wrapper, id)
  }
}
function cronIds(wrapper: VueWrapper): (string | undefined)[] {
  return wrapper.findAll('[data-entry-id]').map((el) => el.attributes('data-entry-id'))
}
function labelsIn(el: ReturnType<VueWrapper['get']>): (string | undefined)[] {
  return el.findAll('[data-agent-label]').map((r) => r.attributes('data-agent-label'))
}
function agentRow(wrapper: VueWrapper, label: string) {
  return wrapper.get(`[data-agent-label="${label}"]`)
}
function cronRow(wrapper: VueWrapper, id: string) {
  return wrapper.get(`[data-entry-id="${id}"]`)
}
/** Removal lives behind the row's ⋯ menu. */
async function clickRemove(row: ReturnType<VueWrapper['get']>): Promise<void> {
  await row.get('.tk-act-more').trigger('click')
  await row.get('.tk-act-remove').trigger('click')
}

describe('TaskerPanel', () => {
  let wrapper: VueWrapper | undefined

  beforeEach(async () => {
    wire.calls.length = 0
    wire.overrides.clear()
    wire.envelopeErrors.clear()
    wire.listeners.clear()
    wire.holdType = null
    wire.hold = Promise.resolve()
    localStorage.clear()
    // The panel keeps its last scan at module scope so remounting the rail tab
    // doesn't shell out again; a fresh module per test starts that cache empty.
    vi.resetModules()
    TaskerPanel = ((await import('../TaskerPanel.vue')) as { default: Component }).default
    // A fresh module graph is transformed on the first import; under a loaded
    // machine that alone can exceed the 10s default.
  }, 30_000)

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    vi.useRealTimers()
  })

  // ── grouping ─────────────────────────────────────────────────────────────

  it('scans on mount and sorts every row into the group its schedule allows', async () => {
    // The order below holds only while both 02:30 and 03:00 are still ahead
    // today; between them (CI ran at 02:44) 02:30 rolls over to tomorrow and
    // the rows swap. Pin the clock to midday so the expectation is exact.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 5, 15, 12, 0, 0))
    wrapper = await mountPanel()
    expect(wire.calls.filter((c) => c.type === 'executions.list')).toHaveLength(1)

    // Exactly computable next runs: the daily crontab line (02:30) and the
    // calendar LaunchAgent (03:00), soonest first.
    const timeline = section(wrapper, 'timeline')
    expect(timeline.findAll('.tk-item').map((el) => el.attributes('data-kind'))).toEqual([
      'crontab',
      'launchagent',
    ])
    expect(cronIds(wrapper)).toEqual(['c1'])
    expect(labelsIn(timeline)).toEqual(['local.nightly.index'])
    expect(timeline.findAll('[data-test="when-col"]').map((el) => el.text())).toEqual([
      expect.stringContaining('02:30'),
      expect.stringContaining('03:00'),
    ])

    // Always-on, on-demand and unknowable schedules start collapsed, with a count.
    const other = section(wrapper, 'other')
    expect(other.get('.tk-group').attributes('aria-expanded')).toBe('false')
    expect(other.get('.tk-count').text()).toBe('5')
    expect(labelsIn(other)).toEqual([])

    await openAllGroups(wrapper)
    expect(cronIds(wrapper).sort()).toEqual(['c1', 'c2', 'c3'])
    expect(labelsIn(section(wrapper, 'other')).sort()).toEqual([
      'com.syncthing.syncthing',
      'com.vendor.daemon',
      'com.vendor.updater',
      'com.vendor.visible',
    ])
    // Disabled: the switched-off crontab line and the unloaded agent.
    expect(labelsIn(section(wrapper, 'disabled'))).toEqual(['local.legacy.backup'])
    expect(section(wrapper, 'disabled').find('[data-entry-id="c3"]').exists()).toBe(true)
  })

  it('heads each day of the timeline once', async () => {
    wrapper = await mountPanel()
    const buckets = section(wrapper, 'timeline').findAll('.tk-bucket').map((el) => el.attributes('data-bucket'))
    expect(buckets.length).toBeGreaterThanOrEqual(1)
    expect(new Set(buckets).size).toBe(buckets.length)
  })

  it('puts a StartInterval job below the fixed-interval divider, never on the clock', async () => {
    const snap = snapshot()
    ;(snap.launch_agents as { agents: Record<string, unknown>[] }).agents[0].keep_alive = false
    ;(snap.launch_agents as { agents: Record<string, unknown>[] }).agents[0].start_interval = 1800
    wire.overrides.set('executions.list', snap)
    wrapper = await mountPanel()

    expect(wrapper.find('[data-section="recurring"]').exists()).toBe(false)
    const timeline = section(wrapper, 'timeline')
    const buckets = timeline.findAll('.tk-bucket').map((el) => el.attributes('data-bucket'))
    // The divider comes after every dated bucket.
    expect(buckets[buckets.length - 1]).toBe('interval')
    const item = timeline.findAll('.tk-item').find((el) => el.find('[data-agent-label="com.syncthing.syncthing"]').exists())!
    expect(item.find('[data-test="when-col"]').exists()).toBe(false)
    expect(item.get('[data-test="interval-col"]').text()).toBe(i18n.global.t('executions.interval.minutes', { n: 30 }))
  })

  it('never leaves the timeline empty when everything runs on an interval', async () => {
    // The reported machine: no Navide job, every launchd job on StartInterval,
    // one every-minute crontab line.
    const snap = snapshot()
    const cron = snap.crontab as { entries: Record<string, unknown>[] }
    cron.entries = [{ ...cron.entries[0], id: 'artisan', name: 'artisan', schedule: '* * * * *' }]
    const la = snap.launch_agents as { agents: Record<string, unknown>[] }
    const base = { ...la.agents[1], start_calendar: [], last_exit_code: 0 }
    la.agents = [
      { ...base, label: 'x.hourly', name: 'hourly', plist_path: '/h', start_interval: 3600 },
      { ...base, label: 'x.half', name: 'half', plist_path: '/m', start_interval: 1800, last_exit_code: 3 },
      { ...base, label: 'x.fast', name: 'fast', plist_path: '/f', start_interval: 30 },
    ]
    wire.overrides.set('executions.list', snap)
    wrapper = await mountPanel()

    const timeline = section(wrapper, 'timeline')
    expect(timeline.find('.tk-empty').exists()).toBe(false)
    const order = timeline
      .findAll('.tk-item')
      .map((el) => el.get('[data-agent-label], [data-entry-id]'))
      .map((el) => el.attributes('data-agent-label') ?? el.attributes('data-entry-id'))
    expect(order).toEqual(['x.fast', 'artisan', 'x.half', 'x.hourly'])
    // A failing interval row keeps its exit badge and red edge.
    const half = timeline.findAll('.tk-item')[2]
    expect(half.classes()).toContain('failing')
    expect(half.find('.tk-tag.exit').exists()).toBe(true)
  })

  it('remembers which groups the user opened', async () => {
    wrapper = await mountPanel()
    await openGroup(wrapper, 'other')
    expect(localStorage.getItem('tasker.group.other')).toBe('1')
    wrapper.unmount()

    wrapper = await mountPanel()
    expect(section(wrapper, 'other').get('.tk-group').attributes('aria-expanded')).toBe('true')
  })

  it('shows a failure bar and a flat failures-only list across all groups', async () => {
    const snap = snapshot()
    const agents = (snap.launch_agents as { agents: Record<string, unknown>[] }).agents
    // A failing system agent sits in the collapsed "other" group.
    agents[3].last_exit_code = 2
    wire.overrides.set('executions.list', snap)
    wrapper = await mountPanel()

    const bar = wrapper.get('[data-test="failing-bar"]')
    expect(bar.text()).toContain(i18n.global.t('executions.failing', { count: 2 }))
    // The collapsed group still says it hides a failure.
    expect(section(wrapper, 'other').find('.tk-group-err').exists()).toBe(true)

    await bar.get('[data-test="only-failing"]').trigger('click')
    expect(wrapper.find('[data-section="timeline"]').exists()).toBe(false)
    expect(labelsIn(section(wrapper, 'failing')).sort()).toEqual(['com.vendor.updater', 'local.nightly.index'])

    await wrapper.get('[data-test="only-failing"]').trigger('click')
    expect(wrapper.find('[data-section="timeline"]').exists()).toBe(true)
  })

  it('shows no failure bar when nothing is failing', async () => {
    const snap = snapshot()
    ;(snap.launch_agents as { agents: Record<string, unknown>[] }).agents[1].last_exit_code = 0
    wire.overrides.set('executions.list', snap)
    wrapper = await mountPanel()
    expect(wrapper.find('[data-test="failing-bar"]').exists()).toBe(false)
  })

  it('says when nothing is scheduled ahead, and offers to create the first job', async () => {
    const snap = snapshot()
    ;(snap.crontab as { entries: unknown[] }).entries = []
    ;(snap.launch_agents as { agents: unknown[] }).agents = []
    wire.overrides.set('executions.list', snap)
    wrapper = await mountPanel()

    expect(section(wrapper, 'timeline').get('.tk-empty').text()).toBe(i18n.global.t('executions.timeline.empty'))
    expect(wrapper.get('[data-test="jobs-empty"]').text()).toContain(i18n.global.t('scheduler.empty'))
    // Empty groups are not rendered at all.
    expect(wrapper.find('[data-section="other"]').exists()).toBe(false)
  })

  // ── launchd rows ─────────────────────────────────────────────────────────

  it('tells same-named launchd jobs apart by their vendor', async () => {
    const snap = snapshot()
    const base = (snap.launch_agents as { agents: Record<string, unknown>[] }).agents[0]
    ;(snap.launch_agents as { agents: Record<string, unknown>[] }).agents = [
      { ...base, label: 'com.google.GoogleUpdater.wake', name: 'wake', plist_path: '/u/g.plist' },
      { ...base, label: 'com.citrolabs.EgoUpdater.wake', name: 'wake', plist_path: '/u/c.plist' },
      { ...base, label: 'com.example.sync', name: 'sync', plist_path: '/u/s.plist' },
    ]
    wire.overrides.set('executions.list', snap)
    wrapper = await mountPanel()
    await openAllGroups(wrapper)

    expect(agentRow(wrapper, 'com.google.GoogleUpdater.wake').get('.tk-name').text()).toBe('google · wake')
    expect(agentRow(wrapper, 'com.citrolabs.EgoUpdater.wake').get('.tk-name').text()).toBe('citrolabs · wake')
    expect(agentRow(wrapper, 'com.example.sync').get('.tk-name').text()).toBe('sync')
  })

  it('does not hardcode a daemon as unknown when launchctl can see it', async () => {
    wrapper = await mountPanel()
    await openGroup(wrapper, 'other')

    const visible = agentRow(wrapper, 'com.vendor.visible')
    expect(visible.get('.tk-dot').classes()).toEqual(['tk-dot'])
    expect(visible.text()).toContain(i18n.global.t('executions.tag.pid', { pid: 77 }))

    const unknown = agentRow(wrapper, 'com.vendor.daemon')
    expect(unknown.get('.tk-dot').classes()).toEqual(['tk-dot', 'unknown'])
  })

  it('expands and collapses rows independently', async () => {
    wrapper = await mountPanel()
    await openGroup(wrapper, 'other')

    const agent = agentRow(wrapper, 'com.vendor.updater')
    const daemon = agentRow(wrapper, 'com.vendor.daemon')

    await agent.get('.tk-row-head').trigger('click')
    await daemon.get('.tk-row-head').trigger('click')
    expect(agent.find('.tk-detail').exists()).toBe(true)
    expect(daemon.get('.tk-detail').text()).toContain('/Library/LaunchDaemons/com.vendor.daemon.plist')

    await daemon.get('.tk-row-head').trigger('click')
    expect(daemon.find('.tk-detail').exists()).toBe(false)
    expect(agent.find('.tk-detail').exists()).toBe(true)
  })

  it('gives read-only rows no action buttons at all', async () => {
    wrapper = await mountPanel()
    await openGroup(wrapper, 'other')

    const managed = agentRow(wrapper, 'com.syncthing.syncthing')
    expect(managed.find('.tk-act-toggle').exists()).toBe(true)
    expect(managed.find('.tk-act-more').exists()).toBe(true)

    for (const label of ['com.vendor.updater', 'com.vendor.daemon', 'com.vendor.visible']) {
      expect(agentRow(wrapper, label).findAll('.tk-act')).toHaveLength(0)
    }
  })

  it('never calls an unknown state "stopped", nor fades it', async () => {
    wrapper = await mountPanel()
    await openGroup(wrapper, 'other')
    const stopped = i18n.global.t('executions.state.not-loaded')
    const unknown = i18n.global.t('executions.state.unknown')

    const row = agentRow(wrapper, 'com.vendor.daemon')
    await row.get('.tk-row-head').trigger('click')
    expect(row.text()).not.toContain(stopped)
    expect(row.get('.tk-detail').text()).toContain(unknown)
    expect(row.get('.tk-dot').classes()).toEqual(['tk-dot', 'unknown'])
    expect(row.element.closest('.tk-item')?.classList.contains('off')).toBe(false)
  })

  it('fades only the rows in the Disabled group', async () => {
    wrapper = await mountPanel()
    await openAllGroups(wrapper)
    const faded = wrapper.findAll('.tk-item.off')
    expect(faded.length).toBe(2)
    for (const el of faded) expect(el.element.closest('[data-section]')?.getAttribute('data-section')).toBe('disabled')
  })

  it('tags each system row with its scope and leaves user rows untagged', async () => {
    wrapper = await mountPanel()
    await openGroup(wrapper, 'other')

    const tagsOf = (label: string): string[] =>
      agentRow(wrapper!, label).findAll('.tk-tag.scope').map((el) => el.text())

    expect(tagsOf('com.syncthing.syncthing')).toEqual([])
    expect(tagsOf('com.vendor.updater')).toEqual([i18n.global.t('executions.scope.system-agent')])
    expect(tagsOf('com.vendor.daemon')).toEqual([i18n.global.t('executions.scope.system-daemon')])

    const row = agentRow(wrapper, 'com.vendor.updater')
    await row.get('.tk-row-head').trigger('click')
    const detail = row.get('.tk-detail').text()
    expect(detail).toContain(i18n.global.t('executions.scope.system-agent'))
    expect(detail).toContain('/Library/LaunchAgents/com.vendor.updater.plist')
  })

  it('keeps the same label registered in two directories as two rows', async () => {
    const twins = snapshot()
    const label = 'com.google.keystone.agent'
    const base = (twins.launch_agents as { agents: Record<string, unknown>[] }).agents[0]
    ;(twins.launch_agents as { agents: Record<string, unknown>[] }).agents = [
      { ...base, label, name: 'Keystone', plist_path: `/Users/t/Library/LaunchAgents/${label}.plist` },
      {
        ...base,
        label,
        name: 'Keystone',
        plist_path: `/Library/LaunchAgents/${label}.plist`,
        scope: 'system-agent',
        managed: false,
      },
    ]
    wire.overrides.set('executions.list', twins)
    wrapper = await mountPanel()
    await openGroup(wrapper, 'other')

    expect(labelsIn(section(wrapper, 'other'))).toEqual([label, label])
    const rows = section(wrapper, 'other').findAll('[data-agent-key]')
    await rows[0].get('.tk-row-head').trigger('click')
    expect(rows[0].find('.tk-detail').exists()).toBe(true)
    expect(rows[1].find('.tk-detail').exists()).toBe(false)
    // Only the user copy is actionable; the scope tag tells the two apart.
    expect(rows[0].findAll('.tk-act')).toHaveLength(2)
    expect(rows[1].findAll('.tk-act')).toHaveLength(0)
    expect(rows[1].find('.tk-tag.scope').exists()).toBe(true)
  })

  it('describes an agent with no trigger as on demand, not a dash', async () => {
    const snap = snapshot()
    const a = (snap.launch_agents as { agents: Record<string, unknown>[] }).agents[0]
    a.keep_alive = false
    wire.overrides.set('executions.list', snap)
    wrapper = await mountPanel()
    await openGroup(wrapper, 'other')
    expect(agentRow(wrapper, 'com.syncthing.syncthing').get('.tk-desc').text()).toBe(
      i18n.global.t('executions.agent.unknown')
    )
    expect(i18n.global.t('executions.agent.unknown')).not.toBe('—')
  })

  it('reveals a LaunchAgent label and plist path when its row is expanded', async () => {
    wrapper = await mountPanel()
    const row = agentRow(wrapper, 'local.nightly.index')

    expect(row.find('.tk-detail').exists()).toBe(false)
    await row.get('.tk-row-head').trigger('click')

    const detail = row.get('.tk-detail')
    expect(detail.text()).toContain('local.nightly.index')
    expect(detail.text()).toContain('/Users/t/Library/LaunchAgents/local.nightly.index.plist')
  })

  // ── crontab rows ─────────────────────────────────────────────────────────

  it('collapses a crontab row by default and reveals command + raw when expanded', async () => {
    wrapper = await mountPanel()
    const row = cronRow(wrapper, 'c1')

    expect(row.find('.tk-detail').exists()).toBe(false)
    expect(row.text()).not.toContain('/Volumes/Archive')

    await row.get('.tk-row-head').trigger('click')
    const detail = row.get('.tk-detail')
    expect(detail.text()).toContain('~/bin/backup-photos.sh --destination /Volumes/Archive')
    expect(detail.text()).toContain('30 2 * * * ~/bin/backup-photos.sh --destination /Volumes/Archive')

    await row.get('.tk-row-head').trigger('click')
    expect(row.find('.tk-detail').exists()).toBe(false)
  })

  it('words an every-minute crontab line instead of showing the raw fields', async () => {
    const snap = snapshot()
    const e = (snap.crontab as { entries: Record<string, unknown>[] }).entries[0]
    e.schedule = '* * * * *'
    wire.overrides.set('executions.list', snap)
    wrapper = await mountPanel()

    // Every minute is a heartbeat: below the fixed-interval divider, no clock.
    const row = section(wrapper, 'timeline').get('[data-entry-id="c1"]')
    expect(row.get('.tk-desc').text()).toBe(i18n.global.t('executions.cron.every-minute'))
  })

  it('toggles a crontab entry with its raw line as the target', async () => {
    wrapper = await mountPanel()

    await cronRow(wrapper, 'c1').get('.tk-act-toggle').trigger('click')
    await flushPromises()

    const toggles = wire.calls.filter((c) => c.type === 'executions.set_enabled')
    expect(toggles).toHaveLength(1)
    expect(toggles[0].payload).toEqual({
      kind: 'crontab',
      target: '30 2 * * * ~/bin/backup-photos.sh --destination /Volumes/Archive',
      enabled: false,
    })
    // A successful mutation rescans.
    expect(wire.calls.filter((c) => c.type === 'executions.list')).toHaveLength(2)
  })

  // ── removal ──────────────────────────────────────────────────────────────

  it('keeps Remove behind the ⋯ menu, not on the row', async () => {
    wrapper = await mountPanel()
    const row = cronRow(wrapper, 'c1')
    expect(row.find('.tk-act-remove').exists()).toBe(false)

    await row.get('.tk-act-more').trigger('click')
    expect(row.find('.tk-menu .tk-act-remove').exists()).toBe(true)

    // A click anywhere else closes it.
    window.dispatchEvent(new Event('click'))
    await flushPromises()
    expect(row.find('.tk-menu').exists()).toBe(false)
  })

  it('never removes a crontab entry without a confirmation', async () => {
    wrapper = await mountPanel()
    const row = cronRow(wrapper, 'c1')

    await clickRemove(row)
    expect(wire.calls.filter((c) => c.type === 'executions.remove')).toHaveLength(0)
    expect(row.find('.tk-menu').exists()).toBe(false)

    const confirm = row.get('.tk-confirm')
    expect(confirm.text()).toContain('30 2 * * * ~/bin/backup-photos.sh --destination /Volumes/Archive')

    await confirm.get('.tk-confirm-ok').trigger('click')
    await flushPromises()

    const removals = wire.calls.filter((c) => c.type === 'executions.remove')
    expect(removals).toHaveLength(1)
    expect(removals[0].payload).toEqual({
      kind: 'crontab',
      target: '30 2 * * * ~/bin/backup-photos.sh --destination /Volumes/Archive',
    })
  })

  it('cancelling the confirmation sends nothing', async () => {
    wrapper = await mountPanel()
    const row = cronRow(wrapper, 'c1')

    await clickRemove(row)
    await row.get('.tk-confirm .tk-confirm-cancel').trigger('click')

    expect(row.find('.tk-confirm').exists()).toBe(false)
    expect(wire.calls.filter((c) => c.type === 'executions.remove')).toHaveLength(0)
  })

  it('confirms a LaunchAgent removal with its label and plist path', async () => {
    wrapper = await mountPanel()
    const row = agentRow(wrapper, 'local.nightly.index')

    await clickRemove(row)
    expect(wire.calls.filter((c) => c.type === 'executions.remove')).toHaveLength(0)

    const confirm = row.get('.tk-confirm')
    expect(confirm.text()).toContain('local.nightly.index')
    expect(confirm.text()).toContain('/Users/t/Library/LaunchAgents/local.nightly.index.plist')

    await confirm.get('.tk-confirm-ok').trigger('click')
    await flushPromises()

    const removals = wire.calls.filter((c) => c.type === 'executions.remove')
    expect(removals).toHaveLength(1)
    expect(removals[0].payload).toEqual({ kind: 'launchagent', target: 'local.nightly.index' })
  })

  it('confirms only the clicked row when two crontab lines are identical', async () => {
    const twins = snapshot()
    const raw = '0 * * * * ~/bin/twin.sh'
    const twin = (id: string) => ({
      id,
      name: 'twin',
      schedule: '0 * * * *',
      schedule_kind: 'standard',
      command: '~/bin/twin.sh',
      raw,
      enabled: true,
    })
    ;(twins.crontab as Record<string, unknown>).entries = [twin('abc123-0'), twin('abc123-1')]
    wire.overrides.set('executions.list', twins)
    wrapper = await mountPanel()

    await clickRemove(cronRow(wrapper, 'abc123-1'))

    expect(wrapper.findAll('.tk-confirm')).toHaveLength(1)
    expect(cronRow(wrapper, 'abc123-1').find('.tk-confirm').exists()).toBe(true)
    expect(cronRow(wrapper, 'abc123-0').find('.tk-confirm').exists()).toBe(false)
  })

  it('disables the confirmation OK while another mutation is in flight', async () => {
    wrapper = await mountPanel()
    await openGroup(wrapper, 'other')

    const row = cronRow(wrapper, 'c1')
    await clickRemove(row)
    expect(row.get('.tk-confirm-ok').attributes('disabled')).toBeUndefined()

    const releaseToggle = holdNext('executions.set_enabled')
    await cronRow(wrapper, 'c2').get('.tk-act-toggle').trigger('click')
    await flushPromises()

    expect(row.get('.tk-confirm-ok').attributes('disabled')).toBeDefined()

    releaseToggle()
    await flushPromises()
  })

  // ── errors ───────────────────────────────────────────────────────────────

  it('surfaces an ok:false error as one inline line for the source that failed', async () => {
    wrapper = await mountPanel()
    await openGroup(wrapper, 'other')
    wire.overrides.set('executions.set_enabled', {
      ok: false,
      error: 'Boot-out failed: 5: Input/output error',
    })

    await agentRow(wrapper, 'com.syncthing.syncthing').get('.tk-act-toggle').trigger('click')
    await flushPromises()

    const err = wrapper.get('[data-error-section="launchagent"]')
    expect(err.text()).toContain('Boot-out failed: 5: Input/output error')
    // The full message stays reachable when the line is cut: hover shows it.
    expect(err.get('.tk-hint-text').attributes('data-truncate')).toBe('')
    expect(err.classes()).toContain('tk-hint')
    // A failed mutation must not claim success by rescanning.
    expect(wire.calls.filter((c) => c.type === 'executions.list')).toHaveLength(1)
    expect(wrapper.find('[data-error-section="crontab"]').exists()).toBe(false)
  })

  it('keeps an unread error through a broadcast refresh but clears it on rescan', async () => {
    wrapper = await mountPanel()
    await openGroup(wrapper, 'other')
    wire.overrides.set('executions.set_enabled', { ok: false, error: 'Boot-out failed' })

    await agentRow(wrapper, 'com.syncthing.syncthing').get('.tk-act-toggle').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-error-section="launchagent"]').exists()).toBe(true)

    wire.listeners.get('executions.changed')?.forEach((cb) => cb(undefined))
    await flushPromises()
    expect(wrapper.find('[data-error-section="launchagent"]').exists()).toBe(true)

    await wrapper.get('.tk-rescan').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-error-section="launchagent"]').exists()).toBe(false)
  })

  it('surfaces an envelope-level failure of a mutation', async () => {
    wrapper = await mountPanel()
    wire.envelopeErrors.set('executions.set_enabled', 'backend disconnected')

    await cronRow(wrapper, 'c1').get('.tk-act-toggle').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-error-section="crontab"]').text()).toContain('backend disconnected')
    expect(wire.calls.filter((c) => c.type === 'executions.list')).toHaveLength(1)
  })

  it('surfaces a failed scan as one line with a retry', async () => {
    wire.envelopeErrors.set('executions.list', 'session closed')
    wrapper = await mountPanel()

    const hint = wrapper.get('.tk-scan-error')
    expect(hint.text()).toContain('session closed')
    wire.envelopeErrors.clear()
    await hint.get('.tk-hint-btn').trigger('click')
    await flushPromises()
    expect(wrapper.find('.tk-scan-error').exists()).toBe(false)
  })

  it('shows a source-level scan error reported by the backend', async () => {
    const broken = snapshot()
    ;(broken.crontab as Record<string, unknown>) = {
      supported: true,
      error: 'crontab: permission denied',
      entries: [],
    }
    wire.overrides.set('executions.list', broken)
    wrapper = await mountPanel()

    expect(wrapper.get('[data-error-source="crontab"]').text()).toContain('permission denied')
  })

  // ── platforms ────────────────────────────────────────────────────────────

  it('names an unsupported source in one line instead of showing it empty', async () => {
    const unsupported = snapshot()
    unsupported.platform = 'linux'
    ;(unsupported.launch_agents as Record<string, unknown>) = { supported: false, error: null, agents: [] }
    wire.overrides.set('executions.list', unsupported)
    wrapper = await mountPanel()

    expect(wrapper.find('[data-unsupported="launchagent"]').exists()).toBe(true)
    expect(wrapper.find('[data-unsupported="crontab"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="executions-no-source"]').exists()).toBe(false)
    expect(cronIds(wrapper)).toContain('c1')
  })

  // Windows: neither source exists. One platform-level line must say the panel
  // is not broken, instead of naming crontab and launchd to a Windows user.
  it('replaces the per-source notes with one platform note when no source is supported', async () => {
    const none = snapshot()
    none.platform = 'win32'
    ;(none.crontab as Record<string, unknown>) = { supported: false, error: null, entries: [] }
    ;(none.launch_agents as Record<string, unknown>) = { supported: false, error: null, agents: [] }
    wire.overrides.set('executions.list', none)
    wrapper = await mountPanel()

    const note = wrapper.find('[data-test="executions-no-source"]')
    expect(note.exists()).toBe(true)
    expect(note.text()).toContain('Nothing to list on this platform')
    expect(note.text()).toContain('Task Scheduler')
    expect(wrapper.find('.tk-unsupported').exists()).toBe(false)
    // Navide's own jobs still have their timeline.
    expect(wrapper.find('[data-section="timeline"]').exists()).toBe(true)
  })

  it('renders no untranslated i18n keys, including expanded, menu and confirming rows', async () => {
    const snap = snapshot()
    ;(snap.launch_agents as { agents: Record<string, unknown>[] }).agents[0].start_interval = 300
    wire.overrides.set('executions.list', snap)
    wrapper = await mountPanel()
    await openAllGroups(wrapper)

    await cronRow(wrapper, 'c1').get('.tk-row-head').trigger('click')
    await agentRow(wrapper, 'local.nightly.index').get('.tk-row-head').trigger('click')
    await agentRow(wrapper, 'com.vendor.daemon').get('.tk-row-head').trigger('click')
    expect(wrapper.findAll('.tk-detail')).toHaveLength(3)
    for (const id of ['timeline', 'other', 'disabled']) {
      expect(wrapper.find(`[data-section="${id}"]`).exists()).toBe(true)
    }
    expect(wrapper.find('[data-test="failing-bar"]').exists()).toBe(true)
    // vue-i18n only warns on a missing key and renders the key itself.
    expect(wrapper.html()).not.toContain('executions.')
    expect(wrapper.html()).not.toContain('scheduler.')

    await cronRow(wrapper, 'c1').get('.tk-act-more').trigger('click')
    expect(wrapper.html()).not.toContain('executions.')
    await cronRow(wrapper, 'c1').get('.tk-act-remove').trigger('click')
    expect(wrapper.findAll('.tk-confirm')).toHaveLength(1)
    expect(wrapper.html()).not.toContain('executions.')

    await clickRemove(agentRow(wrapper, 'local.nightly.index'))
    expect(wrapper.html()).not.toContain('executions.')

    await wrapper.get('[data-test="only-failing"]').trigger('click')
    expect(wrapper.html()).not.toContain('executions.')
  })

  // ── scanning ─────────────────────────────────────────────────────────────

  it('rescans when the backend broadcasts executions.changed', async () => {
    wrapper = await mountPanel()
    expect(wire.calls.filter((c) => c.type === 'executions.list')).toHaveLength(1)

    wire.listeners.get('executions.changed')?.forEach((cb) => cb(undefined))
    await flushPromises()

    expect(wire.calls.filter((c) => c.type === 'executions.list')).toHaveLength(2)
  })

  it('discards a scan that started before a mutation and landed after it', async () => {
    wrapper = await mountPanel()

    const releaseStaleScan = holdNext('executions.list')
    await wrapper.get('.tk-rescan').trigger('click')

    const disabled = snapshot()
    const entries = (disabled.crontab as { entries: Record<string, unknown>[] }).entries
    entries[0].id = 'c1-off'
    entries[0].enabled = false
    entries[0].raw = `# [NAVIDE-DISABLED] ${entries[0].raw}`
    wire.overrides.set('executions.list', disabled)

    await cronRow(wrapper, 'c1').get('.tk-act-toggle').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-entry-id="c1"]').exists()).toBe(false)

    releaseStaleScan()
    await flushPromises()
    expect(wrapper.find('[data-entry-id="c1"]').exists()).toBe(false)
  })

  it('reuses the cached scan when the panel is remounted', async () => {
    wrapper = await mountPanel()
    wrapper.unmount()

    wrapper = await mountPanel()

    expect(wire.calls.filter((c) => c.type === 'executions.list')).toHaveLength(1)
    expect(cronIds(wrapper)).toEqual(['c1'])
  })

  it('forgets expanded rows whose ids disappeared from the latest scan', async () => {
    wrapper = await mountPanel()
    await cronRow(wrapper, 'c1').get('.tk-row-head').trigger('click')
    expect(cronRow(wrapper, 'c1').find('.tk-detail').exists()).toBe(true)

    const renamed = snapshot()
    const entries = (renamed.crontab as { entries: Record<string, unknown>[] }).entries
    entries[0].id = 'c1-renamed'
    wire.overrides.set('executions.list', renamed)
    await wrapper.get('.tk-rescan').trigger('click')
    await flushPromises()

    expect(cronRow(wrapper, 'c1-renamed').find('.tk-detail').exists()).toBe(false)
    wire.overrides.delete('executions.list')
    await wrapper.get('.tk-rescan').trigger('click')
    await flushPromises()
    expect(cronRow(wrapper, 'c1').find('.tk-detail').exists()).toBe(false)
  })

  it('stops listening for executions.changed once unmounted', async () => {
    wrapper = await mountPanel()
    wrapper.unmount()
    wrapper = undefined

    wire.listeners.get('executions.changed')?.forEach((cb) => cb(undefined))
    await flushPromises()

    expect(wire.calls.filter((c) => c.type === 'executions.list')).toHaveLength(1)
  })

  // Regression: the panel mounts with the app when Tasker was the last active
  // tab, i.e. while the backend is still starting. Scanning then would burn the
  // client timeout and, with no retry, leave the panel permanently empty.
  it('does not scan before the backend is connected', async () => {
    const backend = fakeBackend()
    ;(backend.status as Ref<string>).value = 'starting'

    wrapper = await mountPanel(backend)

    expect(wire.calls.filter((c) => c.type === 'executions.list')).toHaveLength(0)
    expect(wire.calls.filter((c) => c.type === 'scheduler.list')).toHaveLength(0)
    expect(wrapper.find('.tk-scan-error').exists()).toBe(false)
  })

  it('scans once the backend reaches connected, with no user action', async () => {
    const backend = fakeBackend()
    const status = backend.status as Ref<string>
    status.value = 'starting'
    wrapper = await mountPanel(backend)

    status.value = 'connected'
    await flushPromises()

    expect(wire.calls.filter((c) => c.type === 'executions.list')).toHaveLength(1)
    expect(wire.calls.filter((c) => c.type === 'scheduler.list')).toHaveLength(1)
    expect(cronIds(wrapper)).toEqual(['c1'])
  })

  it('rescans after a reconnect', async () => {
    const backend = fakeBackend()
    const status = backend.status as Ref<string>
    wrapper = await mountPanel(backend)
    expect(wire.calls.filter((c) => c.type === 'executions.list')).toHaveLength(1)

    status.value = 'disconnected'
    await flushPromises()
    status.value = 'connected'
    await flushPromises()

    expect(wire.calls.filter((c) => c.type === 'executions.list')).toHaveLength(2)
  })

  it('gives the shelling-out RPCs more budget than the client default', async () => {
    const backend = fakeBackend()
    wrapper = await mountPanel(backend)

    const send = backend.send as unknown as { mock: { calls: unknown[][] } }
    const timeout = send.mock.calls.find((a) => a[0] === 'executions.list')?.[2]
    expect(typeof timeout).toBe('number')
    expect(timeout as number).toBeGreaterThan(10_000)
  })
})

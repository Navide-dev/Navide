// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import UsageBadge from '../UsageBadge.vue'
import { i18n } from '@navide/plugin-ui/foundation'
import type { UsageSnapshot } from '../../composables/useUsage'
import {
  cliAccountSwitchKey,
  createCliAccountSwitchHandler,
  type CliAccountIdentity,
  type CliAccountSwitchHandler,
  type CliProfile,
  type SetDefaultResult,
  type useCliProfiles,
} from '../../composables/useCliProfiles'

// Mock boundary: keep useUsage's pure formatters real, replace the singleton
// readers (usageFor) and the backend call (refreshUsage) with controllable fns.
const usage = vi.hoisted(() => ({
  usageFor: vi.fn<(agentKey: string | undefined | null) => UsageSnapshot | undefined>(),
  accountUsageFor:
    vi.fn<
      (agentKey: string | undefined | null, profileId: string | null) => UsageSnapshot | undefined
    >(),
  refreshUsage: vi.fn(),
}))
vi.mock('../../composables/useUsage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../composables/useUsage')>()
  return {
    ...actual,
    usageFor: usage.usageFor,
    accountUsageFor: usage.accountUsageFor,
    refreshUsage: usage.refreshUsage,
  }
})

const notify = vi.hoisted(() => ({
  toast: vi.fn(),
  alert: vi.fn(),
  confirm: vi.fn(),
  prompt: vi.fn(),
}))
vi.mock('@navide/plugin-ui/foundation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@navide/plugin-ui/foundation')>()),
  useNotify: () => notify,
}))

const executeCommand = vi.hoisted(() => vi.fn(() => true))
vi.mock('@navide/plugin-ui/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@navide/plugin-ui/shared')>()),
  executeCommand,
}))

function snapshot(over: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    provider: 'claude',
    status: 'ok',
    planType: 'max',
    windows: [{ kind: 'session', label: 'Session', usedPercent: 30, resetsAt: null }],
    fetchedAt: '2026-07-25T00:00:00Z',
    error: null,
    ...over,
  }
}

function profile(id: string, name: string): CliProfile {
  return { id, agentKey: 'claude', name, createdAt: '2026-07-01T00:00:00Z' }
}

type FakeCliProfiles = ReturnType<typeof makeCliProfiles>['fake']

// Fake object mimicking the subset of useCliProfiles() UsageBadge reads.
function makeCliProfiles(
  opts: {
    profiles?: CliProfile[]
    defaultId?: string | null
    identities?: Record<string, CliAccountIdentity>
    /** The user's alias for the built-in Default slot of this agent. */
    defaultName?: string
    setDefault?: ReturnType<typeof vi.fn>
    rename?: ReturnType<typeof vi.fn>
  } = {},
) {
  const profiles = opts.profiles ?? []
  const setDefault =
    opts.setDefault ?? vi.fn(async (): Promise<SetDefaultResult> => ({ ok: true }))
  const rename = opts.rename ?? vi.fn(async (): Promise<CliProfile | null> => null)
  const fake = {
    error: ref(''),
    hasProfiles: vi.fn(() => profiles.length > 0),
    profilesForAgent: vi.fn(() => profiles),
    defaultProfileId: vi.fn(() => opts.defaultId ?? null),
    findProfile: vi.fn((id: string | null | undefined) =>
      id ? profiles.find((p) => p.id === id) : undefined,
    ),
    setDefault,
    rename,
    identityFor: vi.fn(
      (_agent: string, profileId: string | null): CliAccountIdentity | null =>
        opts.identities?.[profileId ?? '__default__'] ?? null,
    ),
    aliasFor: vi.fn((_agent: string, profileId: string | null | undefined) => {
      if (profileId && profileId !== '__default__') {
        const profile = profiles.find((p) => p.id === profileId)
        return profile?.nameIsCustom ? profile.name : undefined
      }
      return opts.defaultName || undefined
    }),
  }
  return { fake, setDefault, rename }
}

function mountBadge(
  cliProfiles: FakeCliProfiles,
  opts: { switchHandler?: CliAccountSwitchHandler; attach?: boolean } = {},
): VueWrapper {
  return mount(UsageBadge, {
    props: {
      agentKey: 'claude',
      cliProfiles: cliProfiles as unknown as ReturnType<typeof useCliProfiles>,
    },
    // Only the dismissal tests need a real document tree: events dispatched on
    // a detached node never reach the document-level listeners.
    ...(opts.attach ? { attachTo: document.body } : {}),
    // Teleport is stubbed so the popover renders inside the wrapper.
    global: {
      plugins: [i18n],
      stubs: { teleport: true },
      // Mimic the main window providing the quiescence-aware switch handler.
      provide: opts.switchHandler
        ? { [cliAccountSwitchKey as symbol]: opts.switchHandler }
        : {},
    },
  })
}

/** Hover the badge and advance past the 150ms open delay. */
async function openPopover(wrapper: VueWrapper): Promise<void> {
  await wrapper.find('.usage-badge').trigger('mouseenter')
  await vi.advanceTimersByTimeAsync(200)
  await nextTick()
}

/** Flush chained microtasks from async click handlers (no timers involved). */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
  await nextTick()
}

let wrapper: VueWrapper | undefined

beforeAll(() => {
  i18n.global.locale.value = 'en-US'
})

beforeEach(() => {
  vi.useFakeTimers()
  usage.usageFor.mockReset()
  usage.accountUsageFor.mockReset()
  usage.refreshUsage.mockClear()
  notify.alert.mockClear()
  notify.confirm.mockReset()
  executeCommand.mockClear()
})

afterEach(() => {
  wrapper?.unmount()
  wrapper = undefined
  vi.useRealTimers()
})

describe('UsageBadge – badge rendering', () => {
  it('shows the formatted remaining percent when usage data is present', () => {
    usage.usageFor.mockReturnValue(snapshot()) // 30% used → 70% left
    wrapper = mountBadge(makeCliProfiles().fake)
    const badge = wrapper.find('.usage-badge')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('70%')
    expect(badge.classes()).toContain('ok')
  })

  it('applies the crit tier class when remaining quota is low', () => {
    usage.usageFor.mockReturnValue(
      snapshot({ windows: [{ kind: 'session', label: 'Session', usedPercent: 92, resetsAt: null }] }),
    )
    wrapper = mountBadge(makeCliProfiles().fake)
    const badge = wrapper.find('.usage-badge')
    expect(badge.text()).toBe('8%')
    expect(badge.classes()).toContain('crit')
  })

  it('shows the warning glyph when credentials are expired', () => {
    usage.usageFor.mockReturnValue(snapshot({ status: 'expired', windows: [] }))
    wrapper = mountBadge(makeCliProfiles().fake)
    const badge = wrapper.find('.usage-badge')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('⚠')
  })

  it('surfaces a missing Claude CLI instead of rendering nothing', () => {
    // No binary means no reading and no cached figure to fall back to, so
    // every other branch of `visible` is false — without its own the badge
    // would hide the one failure the user can fix.
    usage.usageFor.mockReturnValue(snapshot({ status: 'cli-missing', windows: [] }))
    wrapper = mountBadge(makeCliProfiles().fake)
    const badge = wrapper.find('.usage-badge')
    expect(badge.exists()).toBe(true)
    expect(badge.text()).toBe('⚠')
    expect(badge.attributes('title')).toContain('PATH')
  })

  it('says to open a pane, not that it failed, when the credential store is unverified', async () => {
    usage.usageFor.mockReturnValue(
      snapshot({
        status: 'unverified',
        windows: [],
        error: 'kilo: open a standard CLI pane to verify its credential store first',
      }),
    )
    wrapper = mountBadge(makeCliProfiles().fake)
    const badge = wrapper.find('.usage-badge')
    expect(badge.exists()).toBe(true)
    expect(badge.attributes('title')).toContain('Not verified yet')
    await openPopover(wrapper)
    const pop = wrapper.find('.usage-pop')
    expect(pop.text()).toContain('Not verified yet')
    expect(pop.find('.usage-pop-reason').exists()).toBe(false)
  })

  it('renders nothing when the agent has no usage snapshot', () => {
    usage.usageFor.mockReturnValue(undefined)
    wrapper = mountBadge(makeCliProfiles().fake)
    expect(wrapper.find('.usage-badge').exists()).toBe(false)
  })

  it('keeps cached quota visible and marks its refresh state', async () => {
    usage.usageFor.mockReturnValue(
      snapshot({
        stale: true,
        lastSuccessAt: '2026-07-25T00:00:00Z',
        refreshStatus: 'rate-limited',
      }),
    )
    wrapper = mountBadge(makeCliProfiles().fake)
    const badge = wrapper.get('.usage-badge')
    expect(badge.text()).toContain('70%')
    expect(badge.text()).toContain('cached')
    expect(badge.classes()).toContain('cached')

    await openPopover(wrapper)
    expect(wrapper.get('.usage-pop-cached').text()).toContain('rate limited')
  })

  it('shows why the last refresh failed, not just that it did', async () => {
    // "unavailable" is one word for a timed-out probe, a dead token and a CLI
    // too old to understand `-p /usage`. The snapshot has carried the real
    // sentence all along and nothing rendered it, so a loaded machine timing
    // out read on screen as a broken account.
    usage.usageFor.mockReturnValue(
      snapshot({
        stale: true,
        lastSuccessAt: '2026-07-25T00:00:00Z',
        refreshStatus: 'unavailable',
        error: 'claude -p /usage timed out after 180s',
      }),
    )
    wrapper = mountBadge(makeCliProfiles().fake)

    await openPopover(wrapper)
    expect(wrapper.get('.usage-pop-reason').text()).toContain('timed out after 180s')
  })

  it('does not offer a stale reason while the next read is in flight', async () => {
    // The error belongs to the read that already finished. Showing it next to
    // "reading now" would attribute a failure to the attempt still running.
    usage.usageFor.mockReturnValue(
      snapshot({
        stale: true,
        refreshPending: true,
        lastSuccessAt: '2026-07-25T00:00:00Z',
        refreshStatus: 'unavailable',
        error: 'claude -p /usage timed out after 180s',
      }),
    )
    wrapper = mountBadge(makeCliProfiles().fake)

    await openPopover(wrapper)
    expect(wrapper.find('.usage-pop-reason').exists()).toBe(false)
  })

  it('stays quiet when a healthy reading carries no error', async () => {
    usage.usageFor.mockReturnValue(snapshot({ error: null }))
    wrapper = mountBadge(makeCliProfiles().fake)

    await openPopover(wrapper)
    expect(wrapper.find('.usage-pop-reason').exists()).toBe(false)
  })

  it('says a read is in flight rather than passing the old figure off as new', async () => {
    // The account just changed. The number on the badge is the incoming
    // account's PREVIOUS reading and the real one is tens of seconds away —
    // without saying so the badge looks like the switch did nothing.
    usage.usageFor.mockReturnValue(
      snapshot({
        stale: true,
        refreshPending: true,
        lastSuccessAt: '2026-07-25T00:00:00Z',
        refreshStatus: 'not-measured',
      }),
    )
    wrapper = mountBadge(makeCliProfiles().fake)
    const badge = wrapper.get('.usage-badge')
    expect(badge.text()).toContain('70%')
    expect(badge.text()).toContain('reading')
    expect(badge.text()).not.toContain('cached')
    expect(badge.classes()).toContain('pending')
    expect(badge.attributes('title')).toContain('just became active')

    await openPopover(wrapper)
    expect(wrapper.get('.usage-pop-pending').text()).toContain('Reading this account')
  })

  it('stays on screen while a read runs for an account that has no figure yet', async () => {
    // REGRESSION: switching onto a never-polled account produces a snapshot
    // with no percent, no staleness and no error. That combination used to
    // fail every term of `visible`, so the badge unmounted the instant the
    // user switched — the exact "did that do anything?" reading the pending
    // state exists to prevent.
    usage.usageFor.mockReturnValue(
      snapshot({ status: 'not-measured', refreshPending: true, windows: [] }),
    )
    wrapper = mountBadge(makeCliProfiles().fake)

    const badge = wrapper.get('.usage-badge')
    expect(badge.text()).toContain('reading')
    expect(badge.text()).not.toContain('⚠')
    expect(badge.classes()).toContain('pending')
  })

  it('still warns rather than saying "reading" when the credentials expired', async () => {
    // A fault the user can act on outranks a wait they only have to sit out.
    usage.usageFor.mockReturnValue(
      snapshot({ status: 'expired', refreshPending: true, windows: [] }),
    )
    wrapper = mountBadge(makeCliProfiles().fake)
    expect(wrapper.get('.usage-badge').text()).toBe('⚠')
  })

  it('does not present cached remaining quota after the reset has passed', async () => {
    usage.usageFor.mockReturnValue(
      snapshot({
        stale: true,
        staleExpired: true,
        refreshStatus: 'unavailable',
        windows: [
          { kind: 'session', label: 'Session', usedPercent: 30, resetsAt: null, expired: true },
        ],
      }),
    )
    wrapper = mountBadge(makeCliProfiles().fake)
    expect(wrapper.get('.usage-badge').text()).toBe('⚠')

    await openPopover(wrapper)
    expect(wrapper.get('.usage-pop-expired').text()).toContain('Cached quota reset has passed')
    expect(wrapper.find('.usage-bar').exists()).toBe(false)
  })
})

describe('UsageBadge – popover account list', () => {
  it('hides the switch section when the agent has no extra profiles', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    wrapper = mountBadge(makeCliProfiles().fake)
    await openPopover(wrapper)
    expect(wrapper.find('.usage-pop').exists()).toBe(true)
    expect(wrapper.find('.usage-pop-switch-title').exists()).toBe(false)
    expect(wrapper.find('.usage-acct-list').exists()).toBe(false)
    // The "Add / Manage Accounts…" entry is always available.
    expect(wrapper.find('.usage-acct-manage').exists()).toBe(true)
  })

  it('lists the Default row plus every profile, labeled by identity email', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    const { fake } = makeCliProfiles({
      profiles: [profile('p1', 'Work'), profile('p2', 'Side')],
      identities: { p1: { email: 'work@example.com', signedIn: true } },
    })
    wrapper = mountBadge(fake)
    await openPopover(wrapper)
    const rows = wrapper.findAll('.usage-acct')
    expect(rows).toHaveLength(3)
    expect(rows[0].text()).toContain('Default (built-in)')
    expect(rows[1].text()).toContain('work@example.com') // identity email wins
    expect(rows[2].text()).toContain('Side') // fallback to profile name
  })

  it('marks the row matching defaultProfileId as active with a tick', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    const { fake } = makeCliProfiles({
      profiles: [profile('p1', 'Work'), profile('p2', 'Side')],
      defaultId: 'p2',
    })
    wrapper = mountBadge(fake)
    await openPopover(wrapper)
    const rows = wrapper.findAll('.usage-acct')
    expect(rows[0].classes()).not.toContain('active')
    expect(rows[1].classes()).not.toContain('active')
    expect(rows[2].classes()).toContain('active')
    expect(rows[2].find('.usage-acct-tick').exists()).toBe(true)
    expect(rows[0].find('.usage-acct-tick').exists()).toBe(false)
  })

  it('marks the Default row active when no default profile is set', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    const { fake } = makeCliProfiles({ profiles: [profile('p1', 'Work')], defaultId: null })
    wrapper = mountBadge(fake)
    await openPopover(wrapper)
    const rows = wrapper.findAll('.usage-acct')
    expect(rows[0].classes()).toContain('active')
    expect(rows[0].find('.usage-acct-tick').exists()).toBe(true)
    expect(rows[1].classes()).not.toContain('active')
  })

  it('shows each row remaining percent from its own account slot', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    usage.accountUsageFor.mockImplementation((_agent, profileId) =>
      profileId === 'p1'
        ? snapshot({
            windows: [{ kind: 'session', label: 'Session', usedPercent: 90, resetsAt: null }],
          })
        : snapshot(), // default slot: 30% used → 70% left
    )
    wrapper = mountBadge(makeCliProfiles({ profiles: [profile('p1', 'Work')] }).fake)
    await openPopover(wrapper)
    const pcts = wrapper.findAll('.usage-acct-pct')
    expect(pcts.map((p) => p.text())).toEqual(['70%', '10%'])
    expect(pcts[1].classes()).toContain('crit')
  })

  it('shows a signed-out row as signed out, never as leftover quota', async () => {
    // An account with no stored credentials keeps whatever was last cached for
    // it. Rendering that number advertises quota for something that cannot run
    // — the row must say it is signed out instead.
    usage.usageFor.mockReturnValue(snapshot())
    usage.accountUsageFor.mockReturnValue(snapshot({ stale: true }))
    wrapper = mountBadge(
      makeCliProfiles({
        profiles: [profile('p1', 'Work')],
        identities: {
          __default__: { email: null, signedIn: false },
          p1: { email: 'work@example.com', signedIn: true },
        },
      }).fake,
    )
    await openPopover(wrapper)

    const rows = wrapper.findAll('.usage-acct')
    expect(rows[0].find('.usage-acct-out').exists()).toBe(true)
    expect(rows[0].find('.usage-acct-pct').exists()).toBe(false)
    // The signed-in row is untouched.
    expect(rows[1].find('.usage-acct-out').exists()).toBe(false)
    expect(rows[1].find('.usage-acct-pct').text()).toBe('~70%')
  })

  it('marks a row whose numbers came from cache, and leaves live rows plain', async () => {
    // A parked slot that could not be polled falls back to its last good
    // numbers — possibly days old. The row must not read as a live quota.
    usage.usageFor.mockReturnValue(snapshot())
    usage.accountUsageFor.mockImplementation((_agent, profileId) =>
      profileId === 'p1'
        ? snapshot({ stale: true, lastSuccessAt: '2026-07-20T00:00:00Z' })
        : snapshot(),
    )
    wrapper = mountBadge(makeCliProfiles({ profiles: [profile('p1', 'Work')] }).fake)
    await openPopover(wrapper)
    const pcts = wrapper.findAll('.usage-acct-pct')
    expect(pcts[0].classes()).not.toContain('stale')
    expect(pcts[0].text()).toBe('70%')
    expect(pcts[0].attributes('title')).toBe('')
    expect(pcts[1].classes()).toContain('stale')
    expect(pcts[1].text()).toBe('~70%')
    expect(pcts[1].attributes('title')).toContain('Cached')
  })

  it("tells a row's in-flight read apart from the age of its numbers", async () => {
    // Both rows are stale; only one is being read. The tooltip on that one has
    // to explain the wait, not date the figure — dating it says "this is as
    // good as it gets", which is the opposite of what is happening.
    usage.usageFor.mockReturnValue(snapshot())
    usage.accountUsageFor.mockImplementation((_agent, profileId) =>
      profileId === 'p1'
        ? snapshot({ stale: true, refreshPending: true })
        : snapshot({ stale: true, lastSuccessAt: '2026-07-20T00:00:00Z' }),
    )
    wrapper = mountBadge(makeCliProfiles({ profiles: [profile('p1', 'Work')] }).fake)
    await openPopover(wrapper)

    const pcts = wrapper.findAll('.usage-acct-pct')
    expect(pcts[0].attributes('title')).toContain('Cached')
    expect(pcts[1].attributes('title')).toContain('just became active')
  })

  it('marks a mid-read row that has no percent to show', async () => {
    // The tooltip hangs off the percent span, so an account with no reading of
    // its own — the one most likely to be mid-read — rendered a blank row.
    usage.usageFor.mockReturnValue(snapshot())
    usage.accountUsageFor.mockImplementation((_agent, profileId) =>
      profileId === 'p1'
        ? snapshot({ status: 'not-measured', refreshPending: true, windows: [] })
        : snapshot(),
    )
    wrapper = mountBadge(makeCliProfiles({ profiles: [profile('p1', 'Work')] }).fake)
    await openPopover(wrapper)

    const pcts = wrapper.findAll('.usage-acct-pct')
    expect(pcts[1].text()).toBe('reading')
    expect(pcts[1].attributes('title')).toContain('just became active')
  })

  it('omits the row percent when a slot has no fetched snapshot', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    usage.accountUsageFor.mockReturnValue(undefined)
    wrapper = mountBadge(makeCliProfiles({ profiles: [profile('p1', 'Work')] }).fake)
    await openPopover(wrapper)
    expect(wrapper.findAll('.usage-acct-pct')).toHaveLength(0)
  })

  it('renders no account list at all when the agent has no extra profiles', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    wrapper = mountBadge(makeCliProfiles().fake)
    await openPopover(wrapper)
    expect(wrapper.find('.usage-acct-list').exists()).toBe(false)
    expect(wrapper.findAll('.usage-acct')).toHaveLength(0)
  })
})

describe('UsageBadge – selectProfile', () => {
  it('switches to a profile: setDefault(agent, id) then refreshUsage', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    const { fake, setDefault } = makeCliProfiles({
      profiles: [profile('p1', 'Work')],
      defaultId: null,
    })
    wrapper = mountBadge(fake)
    await openPopover(wrapper)
    await wrapper.findAll('.usage-acct')[1].trigger('click')
    await settle()
    expect(setDefault).toHaveBeenCalledTimes(1)
    expect(setDefault).toHaveBeenCalledWith('claude', 'p1')
    expect(usage.refreshUsage).toHaveBeenCalledTimes(1)
  })

  it('switches back to Default: setDefault(agent, null) then refreshUsage', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    const { fake, setDefault } = makeCliProfiles({
      profiles: [profile('p1', 'Work')],
      defaultId: 'p1',
    })
    wrapper = mountBadge(fake)
    await openPopover(wrapper)
    await wrapper.findAll('.usage-acct')[0].trigger('click')
    await settle()
    expect(setDefault).toHaveBeenCalledTimes(1)
    expect(setDefault).toHaveBeenCalledWith('claude', null)
    expect(usage.refreshUsage).toHaveBeenCalledTimes(1)
  })

  it('marks the target row busy and drops competing clicks until it settles', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    let release: (res: { ok: boolean }) => void = () => {}
    const setDefault = vi.fn(
      () => new Promise<{ ok: boolean }>((resolve) => { release = resolve }),
    )
    const { fake } = makeCliProfiles({
      profiles: [profile('p1', 'Work'), profile('p2', 'Personal')],
      defaultId: null,
      setDefault,
    })
    wrapper = mountBadge(fake)
    await openPopover(wrapper)
    // Re-query after every render: a DOMWrapper captured earlier does not see
    // children added by a later patch.
    const rows = (): ReturnType<VueWrapper['findAll']> => wrapper!.findAll('.usage-acct')
    await rows()[1].trigger('click')
    await settle()

    // In flight: spinner on the clicked row only, every row unclickable.
    expect(wrapper.findAll('.usage-acct-spin')).toHaveLength(1)
    expect(rows()[1].find('.usage-acct-spin').exists()).toBe(true)
    expect(rows().every((r) => r.attributes('disabled') !== undefined)).toBe(true)
    await rows()[2].trigger('click')
    await settle()
    expect(setDefault).toHaveBeenCalledTimes(1)

    release({ ok: true })
    await settle()
    expect(wrapper.findAll('.usage-acct-spin')).toHaveLength(0)
    expect(rows()[1].attributes('disabled')).toBeUndefined()
    expect(usage.refreshUsage).toHaveBeenCalledTimes(1)
  })

  it('releases the busy row when the switch fails', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    const setDefault = vi.fn().mockResolvedValue({ ok: false, message: 'switch failed' })
    const { fake } = makeCliProfiles({
      profiles: [profile('p1', 'Work')],
      defaultId: null,
      setDefault,
    })
    wrapper = mountBadge(fake)
    await openPopover(wrapper)
    await wrapper.findAll('.usage-acct')[1].trigger('click')
    await settle()

    expect(wrapper.findAll('.usage-acct-spin')).toHaveLength(0)
    // A second attempt is possible after the failure — the guard is not sticky.
    await wrapper.findAll('.usage-acct')[1].trigger('click')
    await settle()
    expect(setDefault).toHaveBeenCalledTimes(2)
  })

  it('clicking the already-active row is a no-op', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    const { fake, setDefault } = makeCliProfiles({
      profiles: [profile('p1', 'Work')],
      defaultId: 'p1',
    })
    wrapper = mountBadge(fake)
    await openPopover(wrapper)
    await wrapper.findAll('.usage-acct')[1].trigger('click')
    await settle()
    expect(setDefault).not.toHaveBeenCalled()
    expect(usage.refreshUsage).not.toHaveBeenCalled()
  })

  it('failure with a message shows an alert and skips the refresh', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    const setDefault = vi.fn().mockResolvedValue({ ok: false, message: 'switch failed' })
    const { fake } = makeCliProfiles({
      profiles: [profile('p1', 'Work')],
      defaultId: null,
      setDefault,
    })
    wrapper = mountBadge(fake)
    await openPopover(wrapper)
    await wrapper.findAll('.usage-acct')[1].trigger('click')
    await settle()
    expect(notify.alert).toHaveBeenCalledTimes(1)
    expect(notify.alert.mock.calls[0][0]).toBe('switch failed')
    expect(notify.confirm).not.toHaveBeenCalled()
    expect(usage.refreshUsage).not.toHaveBeenCalled()
  })
})

describe('UsageBadge – quiescence switch handler', () => {
  it('routes the switch through the provided handler instead of setDefault', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    const { fake, setDefault } = makeCliProfiles({
      profiles: [profile('p1', 'Work')],
      defaultId: null,
    })
    const handler = vi.fn(async (): Promise<SetDefaultResult> => ({ ok: true }))
    wrapper = mountBadge(fake, { switchHandler: handler })
    await openPopover(wrapper)
    await wrapper.findAll('.usage-acct')[1].trigger('click')
    await settle()
    expect(handler).toHaveBeenCalledWith('claude', 'p1')
    expect(setDefault).not.toHaveBeenCalled()
    expect(usage.refreshUsage).toHaveBeenCalledTimes(1)
  })

  it('blocked switch: confirm accepted → forced setDefault → usage refreshed', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    const setDefault = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, code: 'PANES_RUNNING', count: 2, message: 'in use' })
      .mockResolvedValueOnce({ ok: true })
    const { fake } = makeCliProfiles({
      profiles: [profile('p1', 'Work')],
      defaultId: null,
      setDefault,
    })
    notify.confirm.mockResolvedValue(true)
    const handler = createCliAccountSwitchHandler(
      { setDefault: fake.setDefault as unknown as ReturnType<typeof useCliProfiles>['setDefault'] },
      {
        confirm: (message, opts) => notify.confirm(message, opts) as Promise<boolean>,
        agentLabel: () => 'Claude Code',
        startLogin: () => {},
      },
    )
    wrapper = mountBadge(fake, { switchHandler: handler })
    await openPopover(wrapper)
    await wrapper.findAll('.usage-acct')[1].trigger('click')
    await settle()
    expect(notify.confirm).toHaveBeenCalledTimes(1)
    expect(setDefault).toHaveBeenNthCalledWith(1, 'claude', 'p1')
    expect(setDefault).toHaveBeenNthCalledWith(2, 'claude', 'p1', { force: true })
    expect(notify.alert).not.toHaveBeenCalled()
    expect(usage.refreshUsage).toHaveBeenCalledTimes(1)
  })

  it('blocked switch: declined confirm switches nothing and stays silent', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    const setDefault = vi
      .fn()
      .mockResolvedValue({ ok: false, code: 'PANES_RUNNING', count: 2, message: 'in use' })
    const { fake } = makeCliProfiles({
      profiles: [profile('p1', 'Work')],
      defaultId: null,
      setDefault,
    })
    notify.confirm.mockResolvedValue(false)
    const handler = createCliAccountSwitchHandler(
      { setDefault: fake.setDefault as unknown as ReturnType<typeof useCliProfiles>['setDefault'] },
      {
        confirm: (message, opts) => notify.confirm(message, opts) as Promise<boolean>,
        agentLabel: () => 'Claude Code',
        startLogin: () => {},
      },
    )
    wrapper = mountBadge(fake, { switchHandler: handler })
    await openPopover(wrapper)
    await wrapper.findAll('.usage-acct')[1].trigger('click')
    await settle()
    expect(setDefault).toHaveBeenCalledTimes(1)
    expect(notify.alert).not.toHaveBeenCalled()
    expect(usage.refreshUsage).not.toHaveBeenCalled()
  })

  it('without a handler, a PANES_RUNNING failure alerts its message (no force)', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    const setDefault = vi
      .fn()
      .mockResolvedValue({ ok: false, code: 'PANES_RUNNING', count: 1, message: 'panes running' })
    const { fake } = makeCliProfiles({
      profiles: [profile('p1', 'Work')],
      defaultId: null,
      setDefault,
    })
    wrapper = mountBadge(fake)
    await openPopover(wrapper)
    await wrapper.findAll('.usage-acct')[1].trigger('click')
    await settle()
    expect(setDefault).toHaveBeenCalledTimes(1)
    expect(setDefault).toHaveBeenCalledWith('claude', 'p1')
    expect(notify.alert).toHaveBeenCalledTimes(1)
    expect(notify.alert.mock.calls[0][0]).toBe('panes running')
    expect(usage.refreshUsage).not.toHaveBeenCalled()
  })
})

describe('UsageBadge – popover placement', () => {
  it('flips above the badge when the drop-down would run off the bottom', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    const heightSpy = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(200)
    const rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      top: 700,
      bottom: 720,
      left: 100,
      right: 140,
      width: 40,
      height: 20,
      x: 100,
      y: 700,
      toJSON: () => ({}),
    } as DOMRect)

    wrapper = mountBadge(makeCliProfiles().fake)
    await openPopover(wrapper)
    await nextTick()

    // 720 + 6 + 200 overflows the 768px viewport → top = 700 - 6 - 200.
    expect(wrapper.find('.usage-pop').attributes('style')).toContain('top: 494px')
    heightSpy.mockRestore()
    rectSpy.mockRestore()
  })

  it('keeps the drop-down placement when there is room below', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    const heightSpy = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(200)
    const rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      top: 40,
      bottom: 60,
      left: 100,
      right: 140,
      width: 40,
      height: 20,
      x: 100,
      y: 40,
      toJSON: () => ({}),
    } as DOMRect)

    wrapper = mountBadge(makeCliProfiles().fake)
    await openPopover(wrapper)
    await nextTick()

    expect(wrapper.find('.usage-pop').attributes('style')).toContain('top: 66px')
    heightSpy.mockRestore()
    rectSpy.mockRestore()
  })

  // The provisional clamp uses the CSS `width` alone; padding and border make
  // the rendered panel wider than that, so a badge near the right edge used to
  // land a panel that spilled past the window and got clipped by it.
  it('re-clamps against the rendered width, not the CSS width', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    const heightSpy = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(200)
    const widthSpy = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(286)
    const rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      top: 40,
      bottom: 60,
      left: 900,
      right: 940,
      width: 40,
      height: 20,
      x: 900,
      y: 40,
      toJSON: () => ({}),
    } as DOMRect)

    wrapper = mountBadge(makeCliProfiles().fake)
    await openPopover(wrapper)
    await nextTick()

    // 1024 - 286 - 8, so the right edge lands on the 8px margin rather than
    // 26px past the window edge.
    expect(wrapper.find('.usage-pop').attributes('style')).toContain('left: 730px')
    heightSpy.mockRestore()
    widthSpy.mockRestore()
    rectSpy.mockRestore()
  })
})

describe('UsageBadge – popover dismissal', () => {
  // Hover-only dismissal stranded the panel over the UI whenever a mouseleave
  // was missed (window blur, re-render under the cursor) — GitHub issue #17.
  it('closes on Escape', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    wrapper = mountBadge(makeCliProfiles().fake)
    await openPopover(wrapper)
    expect(wrapper.find('.usage-pop').exists()).toBe(true)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(wrapper.find('.usage-pop').exists()).toBe(false)
  })

  it('ignores keys other than Escape', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    wrapper = mountBadge(makeCliProfiles().fake)
    await openPopover(wrapper)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    await nextTick()
    expect(wrapper.find('.usage-pop').exists()).toBe(true)
  })

  it('closes on a pointerdown outside the popover', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    wrapper = mountBadge(makeCliProfiles().fake)
    await openPopover(wrapper)

    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await nextTick()
    expect(wrapper.find('.usage-pop').exists()).toBe(false)
  })

  it('stays open on a pointerdown inside the popover', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    wrapper = mountBadge(makeCliProfiles({ profiles: [profile('p1', 'A account')] }).fake, {
      attach: true,
    })
    await openPopover(wrapper)

    wrapper.find('.usage-acct').element.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await nextTick()
    expect(wrapper.find('.usage-pop').exists()).toBe(true)
  })

  it('stays open on a pointerdown on the badge itself', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    wrapper = mountBadge(makeCliProfiles().fake, { attach: true })
    await openPopover(wrapper)

    wrapper.find('.usage-badge').element.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await nextTick()
    expect(wrapper.find('.usage-pop').exists()).toBe(true)
  })

  it('closes when the window loses focus', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    wrapper = mountBadge(makeCliProfiles().fake)
    await openPopover(wrapper)

    window.dispatchEvent(new Event('blur'))
    await nextTick()
    expect(wrapper.find('.usage-pop').exists()).toBe(false)
  })

  it('drops the document listeners when the popover closes', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    wrapper = mountBadge(makeCliProfiles().fake)
    await openPopover(wrapper)

    const removeSpy = vi.spyOn(document, 'removeEventListener')
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(removeSpy).toHaveBeenCalledWith('keydown', expect.any(Function), true)
    expect(removeSpy).toHaveBeenCalledWith('pointerdown', expect.any(Function), true)
    removeSpy.mockRestore()
  })

  it('drops the document listeners when unmounted while open', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    const w = mountBadge(makeCliProfiles().fake)
    await openPopover(w)

    const removeSpy = vi.spyOn(document, 'removeEventListener')
    w.unmount()
    expect(removeSpy).toHaveBeenCalledWith('keydown', expect.any(Function), true)
    removeSpy.mockRestore()
  })
})

describe('UsageBadge – manage accounts', () => {
  it('opens Settings › Accounts via the command registry', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    wrapper = mountBadge(makeCliProfiles().fake)
    await openPopover(wrapper)
    await wrapper.find('.usage-acct-manage').trigger('click')
    expect(executeCommand).toHaveBeenCalledWith('workbench.action.openSettingsAccounts')
    // Popover closes so the settings modal opens on top unobstructed.
    expect(wrapper.find('.usage-pop').exists()).toBe(false)
  })
})

describe('UsageBadge – quota spent', () => {
  const spent = (): UsageSnapshot =>
    snapshot({
      windows: [
        { kind: 'session', label: 'Session', usedPercent: 100, resetsAt: '2026-07-25T05:00:00Z' },
      ],
    })

  it('reads differently from "under 1% left"', async () => {
    // The whole point of the state: 0.4% left still runs and used to print the
    // same red figure as a quota that is gone.
    usage.usageFor.mockReturnValue(
      snapshot({ windows: [{ kind: 'session', label: 'S', usedPercent: 99.6, resetsAt: null }] }),
    )
    wrapper = mountBadge(makeCliProfiles().fake)
    expect(wrapper.find('.usage-badge').classes()).not.toContain('exhausted')
    expect(wrapper.find('.usage-badge').text()).toContain('<1%')

    wrapper.unmount()
    usage.usageFor.mockReturnValue(spent())
    wrapper = mountBadge(makeCliProfiles().fake)
    expect(wrapper.find('.usage-badge').classes()).toContain('exhausted')
    expect(wrapper.find('.usage-badge').text()).toContain('spent')
  })

  it('says when the quota comes back, in the badge tooltip and the popover', async () => {
    vi.setSystemTime(Date.parse('2026-07-25T02:00:00Z'))
    usage.usageFor.mockReturnValue(spent())
    wrapper = mountBadge(makeCliProfiles().fake)
    expect(wrapper.find('.usage-badge').attributes('title')).toContain('3h')

    await openPopover(wrapper)
    expect(wrapper.find('.usage-pop-exhausted').text()).toContain('3h')
  })

  it('points at the account list, the only thing that gets work moving again', async () => {
    usage.usageFor.mockReturnValue(spent())
    wrapper = mountBadge(
      makeCliProfiles({ profiles: [profile('p1', 'Work')], defaultId: null }).fake,
    )
    await openPopover(wrapper)
    expect(wrapper.find('.usage-pop-switch-title').classes()).toContain('crit')
  })
})

describe('UsageBadge – quota spent, mid-switch', () => {
  it('keeps the "reading" caveat so the old account\'s exhaustion is not pinned on the new one', () => {
    usage.usageFor.mockReturnValue(
      snapshot({
        windows: [{ kind: 'session', label: 'S', usedPercent: 100, resetsAt: null }],
        refreshPending: true,
      }),
    )
    wrapper = mountBadge(makeCliProfiles().fake)
    const badge = wrapper.find('.usage-badge')
    expect(badge.classes()).toContain('exhausted')
    expect(badge.find('small').text()).toBe('reading')
  })
})

describe('UsageBadge – account name section', () => {
  const custom = (id: string, name: string): CliProfile => ({ ...profile(id, name), nameIsCustom: true })

  it('puts the account name in its own section of the same pill, tinting only the figure', () => {
    usage.usageFor.mockReturnValue(
      snapshot({ windows: [{ kind: 'session', label: 'S', usedPercent: 92, resetsAt: null }] }),
    )
    wrapper = mountBadge(makeCliProfiles({ profiles: [custom('p1', 'Work')], defaultId: 'p1' }).fake)

    const badge = wrapper.get('.usage-badge')
    expect(badge.get('.usage-badge-name-text').text()).toBe('Work')
    expect(badge.get('.usage-badge-num').text()).toBe('8%')
    // The account is not "critical" — its quota is.
    expect(badge.classes()).not.toContain('crit')
    expect(badge.classes()).toContain('has-name')
    expect(badge.get('.usage-badge-num').classes()).toContain('crit')
  })

  it('falls back to the email local part, with the whole address in the tooltip', () => {
    usage.usageFor.mockReturnValue(snapshot())
    wrapper = mountBadge(
      makeCliProfiles({
        profiles: [profile('p1', 'Account 2')],
        defaultId: 'p1',
        identities: { p1: { email: 'neil@nerdtechnic.com', signedIn: true } },
      }).fake,
    )

    const name = wrapper.get('.usage-badge-name')
    expect(name.get('.usage-badge-name-text').text()).toBe('neil')
    expect(name.attributes('title')).toContain('neil@nerdtechnic.com')
    // The narrow-pane form is rendered too — CSS cannot shorten text.
    expect(name.get('.usage-badge-name-initial').text()).toBe('N')
  })

  it('names the built-in Default by the alias the user gave it', () => {
    usage.usageFor.mockReturnValue(snapshot())
    wrapper = mountBadge(makeCliProfiles({ defaultId: null, defaultName: 'Main' }).fake)

    expect(wrapper.get('.usage-badge-name-text').text()).toBe('Main')
  })

  it('shows nothing extra when there is no alias, no email and no second account', () => {
    usage.usageFor.mockReturnValue(snapshot())
    wrapper = mountBadge(makeCliProfiles().fake)

    // Exactly the pill it has always been: no name section, no wrapper around
    // the figure, the tier still on the badge itself.
    const badge = wrapper.get('.usage-badge')
    expect(badge.find('.usage-badge-name').exists()).toBe(false)
    expect(badge.find('.usage-badge-num').exists()).toBe(false)
    expect(badge.classes()).not.toContain('has-name')
    expect(badge.classes()).toContain('ok')
    expect(badge.text()).toBe('70%')
  })

  it('keeps the whole pill dashed mid-switch: the name is the new account, the figure the old one', () => {
    usage.usageFor.mockReturnValue(snapshot({ refreshPending: true }))
    wrapper = mountBadge(makeCliProfiles({ profiles: [custom('p1', 'Spare')], defaultId: 'p1' }).fake)

    const badge = wrapper.get('.usage-badge')
    expect(badge.classes()).toContain('pending')
    expect(badge.get('.usage-badge-name-text').text()).toBe('Spare')
    expect(badge.get('.usage-badge-num').find('small').text()).toBe('reading')
  })

  it('a spent quota fills the figure only, so the account reads as "this one ran out"', () => {
    usage.usageFor.mockReturnValue(
      snapshot({ windows: [{ kind: 'session', label: 'S', usedPercent: 100, resetsAt: null }] }),
    )
    wrapper = mountBadge(makeCliProfiles({ profiles: [custom('p1', 'Work')], defaultId: 'p1' }).fake)

    const badge = wrapper.get('.usage-badge')
    expect(badge.classes()).not.toContain('exhausted')
    expect(badge.get('.usage-badge-num').classes()).toContain('exhausted')
    expect(badge.get('.usage-badge-num').text()).toContain('spent')
  })
})

describe('UsageBadge – renaming from the account list', () => {
  it('renames a profile slot from its row', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    const { fake, rename } = makeCliProfiles({ profiles: [profile('p1', 'Account 2')], defaultId: null })
    wrapper = mountBadge(fake)
    await openPopover(wrapper)

    await wrapper.findAll('.usage-acct-row')[1].get('.usage-acct-edit').trigger('click')
    const input = wrapper.get('input.usage-acct-rename')
    await input.setValue('Work')
    await input.trigger('keydown.enter')
    await settle()

    expect(rename).toHaveBeenCalledWith('p1', 'Work', 'claude')
  })

  it('renames the built-in Default, which has no profile record of its own', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    const { fake, rename } = makeCliProfiles({ profiles: [profile('p1', 'Account 2')], defaultId: 'p1' })
    wrapper = mountBadge(fake)
    await openPopover(wrapper)

    await wrapper.findAll('.usage-acct-row')[0].get('.usage-acct-edit').trigger('click')
    const input = wrapper.get('input.usage-acct-rename')
    await input.setValue('Main')
    await input.trigger('keydown.enter')
    await settle()

    expect(rename).toHaveBeenCalledWith('__default__', 'Main', 'claude')
  })

  it('Esc closes the field without renaming — including the blur it causes', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    const { fake, rename } = makeCliProfiles({ profiles: [profile('p1', 'Account 2')], defaultId: null })
    wrapper = mountBadge(fake)
    await openPopover(wrapper)

    await wrapper.findAll('.usage-acct-row')[1].get('.usage-acct-edit').trigger('click')
    const input = wrapper.get('input.usage-acct-rename')
    await input.setValue('Work')
    await input.trigger('keydown.esc')
    await input.trigger('blur')
    await settle()

    expect(rename).not.toHaveBeenCalled()
    expect(wrapper.find('input.usage-acct-rename').exists()).toBe(false)
  })

  it('the field starts from the alias, not the generated name', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    const named: CliProfile = { ...profile('p1', 'Work'), nameIsCustom: true }
    const { fake } = makeCliProfiles({ profiles: [named], defaultId: null })
    wrapper = mountBadge(fake)
    await openPopover(wrapper)

    await wrapper.findAll('.usage-acct-row')[1].get('.usage-acct-edit').trigger('click')
    expect((wrapper.get('input.usage-acct-rename').element as HTMLInputElement).value).toBe('Work')
  })
})

describe('UsageBadge – rename failures and focus', () => {
  /** Open the pencil of the first profile row and type into its field. */
  async function editFirstProfile(w: VueWrapper, value: string) {
    await w.findAll('.usage-acct-row')[1].get('.usage-acct-edit').trigger('click')
    const input = w.get('input.usage-acct-rename')
    await input.setValue(value)
    return input
  }

  it('keeps the field and its draft and alerts when the rename fails', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    const { fake } = makeCliProfiles({ profiles: [profile('p1', 'Account 2')], defaultId: null })
    fake.rename.mockImplementation(async () => {
      fake.error.value = 'account name is longer than 64 characters'
      return null
    })
    wrapper = mountBadge(fake)
    await openPopover(wrapper)

    const input = await editFirstProfile(wrapper, 'Work')
    await input.trigger('keydown.enter')
    await settle()

    expect(notify.alert).toHaveBeenCalledWith(
      'account name is longer than 64 characters',
      expect.objectContaining({ title: expect.any(String) }),
    )
    const field = wrapper.find('input.usage-acct-rename')
    expect(field.exists()).toBe(true)
    expect((field.element as HTMLInputElement).value).toBe('Work')
  })

  it('closes the field after renaming the built-in Default, whose reply carries no profile', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    const { fake } = makeCliProfiles({ profiles: [profile('p1', 'Account 2')], defaultId: 'p1' })
    wrapper = mountBadge(fake)
    await openPopover(wrapper)

    await wrapper.findAll('.usage-acct-row')[0].get('.usage-acct-edit').trigger('click')
    const input = wrapper.get('input.usage-acct-rename')
    await input.setValue('Main')
    await input.trigger('keydown.enter')
    await settle()

    expect(notify.alert).not.toHaveBeenCalled()
    expect(wrapper.find('input.usage-acct-rename').exists()).toBe(false)
  })

  it('stays open when the pointer leaves while a row is being renamed', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    const { fake } = makeCliProfiles({ profiles: [profile('p1', 'Account 2')], defaultId: null })
    wrapper = mountBadge(fake)
    await openPopover(wrapper)

    await editFirstProfile(wrapper, 'Wo')
    await wrapper.get('.usage-pop').trigger('mouseleave')
    await vi.advanceTimersByTimeAsync(500)
    await nextTick()

    expect(wrapper.find('.usage-pop').exists()).toBe(true)
    expect(wrapper.find('input.usage-acct-rename').exists()).toBe(true)
  })

  it('Esc in the rename field cancels the rename but keeps the popover open', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    const { fake, rename } = makeCliProfiles({ profiles: [profile('p1', 'Account 2')], defaultId: null })
    wrapper = mountBadge(fake, { attach: true })
    await openPopover(wrapper)

    await editFirstProfile(wrapper, 'Work')
    // Dispatched on the attached field so the document-level Esc listener sees it too.
    wrapper
      .get('input.usage-acct-rename')
      .element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await settle()

    expect(rename).not.toHaveBeenCalled()
    expect(wrapper.find('input.usage-acct-rename').exists()).toBe(false)
    expect(wrapper.find('.usage-pop').exists()).toBe(true)
  })

  it('caps both rename fields at 64 characters', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    const { fake } = makeCliProfiles({ profiles: [profile('p1', 'Account 2')], defaultId: null })
    wrapper = mountBadge(fake)
    await openPopover(wrapper)

    await wrapper.findAll('.usage-acct-row')[0].get('.usage-acct-edit').trigger('click')
    expect(wrapper.get('input.usage-acct-rename').attributes('maxlength')).toBe('64')
    await wrapper.get('input.usage-acct-rename').trigger('keydown.esc')
    await editFirstProfile(wrapper, 'x')
    expect(wrapper.get('input.usage-acct-rename').attributes('maxlength')).toBe('64')
  })
})

describe('UsageBadge – telling same-named accounts apart', () => {
  it('shows the email under a row that has a custom name', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    const { fake } = makeCliProfiles({
      profiles: [
        { ...profile('p1', 'Work'), nameIsCustom: true },
        { ...profile('p2', 'Work'), nameIsCustom: true },
      ],
      defaultId: null,
      defaultName: 'Home',
      identities: {
        __default__: { email: 'me@home.com', signedIn: true },
        p1: { email: 'a@work.com', signedIn: true },
        p2: { email: 'b@work.com', signedIn: true },
      },
    })
    wrapper = mountBadge(fake)
    await openPopover(wrapper)

    const rows = wrapper.findAll('.usage-acct-row')
    expect(rows[0].get('.usage-acct-email').text()).toBe('me@home.com')
    expect(rows[1].get('.usage-acct-name').text()).toBe('Work')
    expect(rows[1].get('.usage-acct-email').text()).toBe('a@work.com')
    expect(rows[2].get('.usage-acct-email').text()).toBe('b@work.com')
  })

  it('adds no email line when the row already reads as its email', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    const { fake } = makeCliProfiles({
      profiles: [profile('p1', 'Account 2')],
      defaultId: null,
      identities: { p1: { email: 'a@work.com', signedIn: true } },
    })
    wrapper = mountBadge(fake)
    await openPopover(wrapper)

    expect(wrapper.findAll('.usage-acct-row')[1].get('.usage-acct-name').text()).toBe('a@work.com')
    expect(wrapper.find('.usage-acct-email').exists()).toBe(false)
  })
})

describe('UsageBadge – clearing an alias', () => {
  /** A fake whose rename does what the backend does with an empty name: the
   *  custom flag goes and the generated "Account N" comes back. Reactive, so
   *  the chip and the row re-read it. */
  function makeClearableProfiles(opts: { identities?: Record<string, CliAccountIdentity> } = {}) {
    const profiles = ref<CliProfile[]>([{ ...profile('p1', 'Work'), nameIsCustom: true }])
    const rename = vi.fn(async (id: string, name: string): Promise<CliProfile | null> => {
      const next: CliProfile = name
        ? { ...profile(id, name), nameIsCustom: true }
        : profile(id, 'Account 2')
      profiles.value = profiles.value.map((p) => (p.id === id ? next : p))
      return next
    })
    const fake = {
      error: ref(''),
      hasProfiles: vi.fn(() => profiles.value.length > 0),
      profilesForAgent: vi.fn(() => profiles.value),
      defaultProfileId: vi.fn(() => 'p1'),
      findProfile: vi.fn((id: string | null | undefined) =>
        id ? profiles.value.find((p) => p.id === id) : undefined,
      ),
      setDefault: vi.fn(async (): Promise<SetDefaultResult> => ({ ok: true })),
      rename,
      identityFor: vi.fn(
        (_agent: string, profileId: string | null): CliAccountIdentity | null =>
          opts.identities?.[profileId ?? '__default__'] ?? null,
      ),
      aliasFor: vi.fn((_agent: string, profileId: string | null | undefined) => {
        if (profileId && profileId !== '__default__') {
          const p = profiles.value.find((x) => x.id === profileId)
          return p?.nameIsCustom ? p.name : undefined
        }
        return undefined
      }),
    }
    return { fake, rename }
  }

  /** Clear the field of the first profile row and submit. */
  async function clearAlias(w: VueWrapper): Promise<void> {
    await w.findAll('.usage-acct-row')[1].get('.usage-acct-edit').trigger('click')
    const input = w.get('input.usage-acct-rename')
    await input.setValue('')
    await input.trigger('keydown.enter')
    await settle()
    await nextTick()
  }

  it('sends an empty name and falls back to the signed-in email', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    const { fake, rename } = makeClearableProfiles({
      identities: { p1: { email: 'neil@nerdtechnic.com', signedIn: true } },
    })
    wrapper = mountBadge(fake)
    expect(wrapper.get('.usage-badge-name-text').text()).toBe('Work')
    await openPopover(wrapper)

    await clearAlias(wrapper)

    expect(rename).toHaveBeenCalledWith('p1', '', 'claude')
    // Header chip: the local part. Popover row: the whole address.
    expect(wrapper.get('.usage-badge-name-text').text()).toBe('neil')
    expect(wrapper.findAll('.usage-acct-name')[1].text()).toBe('neil@nerdtechnic.com')
  })

  it('falls back to the regenerated name for a vendor that exposes no email', async () => {
    usage.usageFor.mockReturnValue(snapshot())
    const { fake, rename } = makeClearableProfiles()
    wrapper = mountBadge(fake)
    await openPopover(wrapper)

    await clearAlias(wrapper)

    expect(rename).toHaveBeenCalledWith('p1', '', 'claude')
    expect(wrapper.get('.usage-badge-name-text').text()).toBe('Account 2')
    expect(wrapper.findAll('.usage-acct-name')[1].text()).toBe('Account 2')
  })
})

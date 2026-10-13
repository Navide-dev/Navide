// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import UsageBadge from '../UsageBadge.vue'
import { i18n } from '@navide/plugin-ui/foundation'
import type { UsageSnapshot } from '../../composables/useUsage'
import {
  cliAccountDirActionsKey,
  cliAccountSwitchKey,
  type CliAccountDir,
  type CliAccountDirActions,
  type CliProfile,
  type useCliProfiles,
} from '../../composables/useCliProfiles'

// Option A of the per-account config dir plan: the list chooses the account
// NEW panes use; a pane on an account with its own config dir shows that
// account; "continue" reopens one pane on another account; an account with
// no dir login yet says so and offers the sign-in.

const usage = vi.hoisted(() => ({
  usageFor: vi.fn<(agentKey: string | undefined | null) => UsageSnapshot | undefined>(),
  accountUsageFor:
    vi.fn<(agentKey: string | undefined | null, profileId: string | null) => UsageSnapshot | undefined>(),
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

const notify = vi.hoisted(() => ({ toast: vi.fn(), alert: vi.fn(), confirm: vi.fn(), prompt: vi.fn() }))
vi.mock('@navide/plugin-ui/foundation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@navide/plugin-ui/foundation')>()),
  useNotify: () => notify,
}))

function snap(used: number): UsageSnapshot {
  return {
    provider: 'claude',
    status: 'ok',
    planType: 'max',
    windows: [{ kind: 'session', label: 'Session', usedPercent: used, resetsAt: null }],
    fetchedAt: '2026-10-07T00:00:00Z',
    error: null,
  }
}

const A = { id: 'aaaa', agentKey: 'claude', name: 'A', createdAt: '' } as CliProfile
const B = { id: 'bbbb', agentKey: 'claude', name: 'B', createdAt: '' } as CliProfile
const C = { id: 'cccc', agentKey: 'claude', name: 'C', createdAt: '' } as CliProfile

function makeProfiles(opts: {
  liveDefault?: string | null
  paneDefault?: string
  dirs?: Record<string, CliAccountDir>
}) {
  const paneDefaults = ref<Record<string, string>>(opts.paneDefault ? { claude: opts.paneDefault } : {})
  const setDefault = vi.fn(async () => ({ ok: true }))
  const setPaneDefault = vi.fn(async (_agent: string, id: string | null) => {
    paneDefaults.value = id ? { claude: id } : {}
    return { ok: true }
  })
  const emails: Record<string, string> = { aaaa: 'a@x.com', bbbb: 'b@x.com', cccc: 'c@x.com' }
  const fake = {
    error: ref(''),
    hasProfiles: () => true,
    profilesForAgent: () => [A, B, C],
    defaultProfileId: () => opts.liveDefault ?? null,
    findProfile: (id: string | null | undefined) => [A, B, C].find((p) => p.id === id),
    setDefault,
    setPaneDefault,
    paneDefaults,
    rename: vi.fn(),
    identityFor: (_a: string, id: string | null) =>
      id && emails[id] ? { email: emails[id], signedIn: true } : { email: null, signedIn: false },
    aliasFor: () => undefined,
    accountDirFor: (_a: string, id: string | null | undefined) => (id ? opts.dirs?.[id] ?? null : null),
    newPaneProfileId: () => paneDefaults.value.claude || opts.liveDefault || null,
  }
  return { fake, setDefault, setPaneDefault }
}

function mountBadge(
  fake: ReturnType<typeof makeProfiles>['fake'],
  props: { paneId?: string; paneProfileId?: string } = {},
  provide: { actions?: CliAccountDirActions; switchHandler?: unknown } = {},
): VueWrapper {
  return mount(UsageBadge, {
    props: {
      agentKey: 'claude',
      cliProfiles: fake as unknown as ReturnType<typeof useCliProfiles>,
      ...props,
    },
    global: {
      plugins: [i18n],
      stubs: { teleport: true },
      provide: {
        ...(provide.actions ? { [cliAccountDirActionsKey as symbol]: provide.actions } : {}),
        ...(provide.switchHandler ? { [cliAccountSwitchKey as symbol]: provide.switchHandler } : {}),
      },
    },
  })
}

async function open(wrapper: VueWrapper): Promise<void> {
  await wrapper.find('.usage-badge').trigger('mouseenter')
  vi.advanceTimersByTime(200)
  await nextTick()
}

function row(wrapper: VueWrapper, email: string) {
  const r = wrapper.findAll('.usage-acct-row').find((el) => el.text().includes(email))
  if (!r) throw new Error(`no row for ${email}`)
  return r
}

beforeEach(() => {
  vi.useFakeTimers()
  usage.usageFor.mockReset().mockReturnValue(snap(50))
  usage.accountUsageFor.mockReset().mockImplementation((_a, id) =>
    id === 'bbbb' ? snap(10) : id === 'cccc' ? snap(60) : snap(50))
  usage.refreshUsage.mockReset()
  notify.alert.mockReset()
})

describe('UsageBadge – a pane on an account with its own config dir', () => {
  it('shows that account and its own figure, not the live default', () => {
    const { fake } = makeProfiles({
      liveDefault: 'aaaa',
      dirs: { bbbb: { signedIn: true, email: 'b@x.com' } },
    })
    const w = mountBadge(fake, { paneId: 'p1', paneProfileId: 'bbbb' })
    // The chip shows the address's local part; the tooltip carries all of it.
    expect(w.find('.usage-badge-name-text').text()).toBe('b')
    expect(w.find('.usage-badge-name').attributes('title')).toContain('b@x.com')
    expect(w.find('.usage-badge-num').text()).toContain('90%')
  })

  it('a pane on the live credential keeps the live account and figure', () => {
    const { fake } = makeProfiles({ liveDefault: 'aaaa' })
    const w = mountBadge(fake, { paneId: 'p1', paneProfileId: 'cccc' })
    expect(w.find('.usage-badge-name').attributes('title')).toContain('a@x.com')
    expect(w.find('.usage-badge-num').text()).toContain('50%')
  })
})

describe('UsageBadge – choosing the account for new panes', () => {
  it('titles the list as the new-pane account and ticks the pane default', async () => {
    const { fake } = makeProfiles({
      liveDefault: 'aaaa',
      paneDefault: 'bbbb',
      dirs: { bbbb: { signedIn: true, email: 'b@x.com' } },
    })
    const w = mountBadge(fake)
    await open(w)
    expect(w.find('.usage-pop-switch-title').text()).toBe(i18n.global.t('usage.pane-default-title'))
    expect(row(w, 'b@x.com').find('.usage-acct-tick').exists()).toBe(true)
    expect(row(w, 'a@x.com').find('.usage-acct-tick').exists()).toBe(false)
  })

  it('choosing an account with its own dir sets the pane default and swaps nothing', async () => {
    const { fake, setDefault, setPaneDefault } = makeProfiles({
      liveDefault: 'aaaa',
      dirs: { bbbb: { signedIn: true, email: 'b@x.com' } },
    })
    const switchHandler = vi.fn(async () => ({ ok: true }))
    const w = mountBadge(fake, {}, { switchHandler })
    await open(w)
    await row(w, 'b@x.com').find('.usage-acct').trigger('click')
    await vi.runAllTimersAsync()
    expect(setPaneDefault).toHaveBeenCalledWith('claude', 'bbbb')
    expect(setDefault).not.toHaveBeenCalled()
    expect(switchHandler).not.toHaveBeenCalled()
  })

  it('choosing an account without a dir login clears the pane default, then switches as before', async () => {
    const { fake, setPaneDefault } = makeProfiles({
      liveDefault: 'aaaa',
      paneDefault: 'bbbb',
      dirs: { bbbb: { signedIn: true, email: 'b@x.com' } },
    })
    const switchHandler = vi.fn(async () => ({ ok: true }))
    const w = mountBadge(fake, {}, { switchHandler })
    await open(w)
    await row(w, 'c@x.com').find('.usage-acct').trigger('click')
    await vi.runAllTimersAsync()
    expect(setPaneDefault).toHaveBeenCalledWith('claude', null)
    expect(switchHandler).toHaveBeenCalledWith('claude', 'cccc')
  })

  it('choosing the live owner while a pane default is set only clears the choice', async () => {
    const { fake, setPaneDefault } = makeProfiles({
      liveDefault: 'aaaa',
      paneDefault: 'bbbb',
      dirs: { bbbb: { signedIn: true, email: 'b@x.com' } },
    })
    const switchHandler = vi.fn(async () => ({ ok: true }))
    const w = mountBadge(fake, {}, { switchHandler })
    await open(w)
    await row(w, 'a@x.com').find('.usage-acct').trigger('click')
    await vi.runAllTimersAsync()
    expect(setPaneDefault).toHaveBeenCalledWith('claude', null)
    expect(switchHandler).not.toHaveBeenCalled()
  })
})

describe('UsageBadge – per-pane continue and sign-in', () => {
  function actions(): CliAccountDirActions & { continueWith: ReturnType<typeof vi.fn>; signIn: ReturnType<typeof vi.fn> } {
    return { continueWith: vi.fn(async () => {}), signIn: vi.fn() }
  }

  it('offers "continue" on another account with its own dir and hands it the pane', async () => {
    const { fake } = makeProfiles({
      liveDefault: 'aaaa',
      dirs: {
        bbbb: { signedIn: true, email: 'b@x.com' },
        cccc: { signedIn: true, email: 'c@x.com' },
      },
    })
    const act = actions()
    const w = mountBadge(fake, { paneId: 'p1', paneProfileId: 'bbbb' }, { actions: act })
    await open(w)
    expect(row(w, 'b@x.com').find('.usage-acct-continue').exists()).toBe(false)
    await row(w, 'c@x.com').find('.usage-acct-continue').trigger('click')
    expect(act.continueWith).toHaveBeenCalledWith('p1', 'cccc')
  })

  it('tells an account without a dir login to sign in, and starts that sign-in', async () => {
    const { fake } = makeProfiles({
      liveDefault: 'aaaa',
      dirs: { bbbb: { signedIn: true, email: 'b@x.com' }, cccc: { signedIn: false, email: null } },
    })
    const act = actions()
    const w = mountBadge(fake, { paneId: 'p1', paneProfileId: 'bbbb' }, { actions: act })
    await open(w)
    const signIn = row(w, 'c@x.com').find('.usage-acct-signin')
    expect(signIn.exists()).toBe(true)
    expect(row(w, 'c@x.com').find('.usage-acct-continue').exists()).toBe(false)
    await signIn.trigger('click')
    expect(act.signIn).toHaveBeenCalledWith('claude', 'cccc')
  })

  it('offers neither without the main window actions', async () => {
    const { fake } = makeProfiles({
      liveDefault: 'aaaa',
      dirs: { cccc: { signedIn: true, email: 'c@x.com' } },
    })
    const w = mountBadge(fake, { paneId: 'p1', paneProfileId: 'aaaa' })
    await open(w)
    expect(w.find('.usage-acct-continue').exists()).toBe(false)
    expect(w.find('.usage-acct-signin').exists()).toBe(false)
  })
})

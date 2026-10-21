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
import { accountFollowKey, type AccountFollowActions } from '../../lib/accountFollowPanes'

// Scheme B of the account menu redesign (plan_8debb8): in the main window,
// once some claude account runs on its own config dir, a click on a row only
// chooses the default account; the panes marked "follow" move with it through
// the window's follow batch, every other pane stays where it is, and the menu
// never swaps the live credential. Without the follow actions (other windows)
// or without any account dir, the menu is exactly what it was on main.

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
const shared = vi.hoisted(() => ({ executeCommand: vi.fn() }))
vi.mock('@navide/plugin-ui/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@navide/plugin-ui/shared')>()),
  executeCommand: shared.executeCommand,
}))

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
  provide: { actions?: CliAccountDirActions; switchHandler?: unknown; follow?: AccountFollowActions } = {},
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
        ...(provide.follow ? { [accountFollowKey as symbol]: provide.follow } : {}),
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

function actions(): CliAccountDirActions & { continueWith: ReturnType<typeof vi.fn>; signIn: ReturnType<typeof vi.fn> } {
  return { continueWith: vi.fn(async () => {}), signIn: vi.fn() }
}

function follow(
  opts: { count?: number; plan?: string[] | null } = {},
): AccountFollowActions & { plan: ReturnType<typeof vi.fn>; move: ReturnType<typeof vi.fn> } {
  return {
    followingCount: () => opts.count ?? 0,
    plan: vi.fn(async () => (opts.plan === undefined ? [] : opts.plan)),
    move: vi.fn(async () => {}),
  }
}

// b signed in inside its own dir, c did not, a is the live credential.
const DIRS = {
  bbbb: { signedIn: true, email: 'b@x.com' },
  cccc: { signedIn: false, email: null },
}

function mountB(opts: { liveDefault?: string | null; paneDefault?: string; follow?: ReturnType<typeof follow> } = {}) {
  const profiles = makeProfiles({ liveDefault: opts.liveDefault === undefined ? 'aaaa' : opts.liveDefault, paneDefault: opts.paneDefault, dirs: DIRS })
  const switchHandler = vi.fn(async () => ({ ok: true }))
  const act = actions()
  const fol = opts.follow ?? follow()
  const w = mountBadge(profiles.fake, { paneId: 'p1', paneProfileId: 'aaaa' }, { actions: act, switchHandler, follow: fol })
  return { w, act, fol, switchHandler, ...profiles }
}

beforeEach(() => {
  shared.executeCommand.mockReset()
})

describe('UsageBadge – scheme B: the list chooses the default account', () => {
  it('titles the list as the default account and says how many panes follow it', async () => {
    const { w } = mountB({ follow: follow({ count: 3 }) })
    await open(w)
    expect(w.find('.usage-pop-switch-title').text()).toBe(i18n.global.t('usage.follow-default-title'))
    expect(w.find('.usage-acct-follow-hint').text()).toBe(i18n.global.t('usage.follow-hint', { count: 3 }))
  })

  it('explains the follow toggle when no pane follows yet', async () => {
    const { w } = mountB()
    await open(w)
    expect(w.find('.usage-acct-follow-hint').text()).toBe(i18n.global.t('usage.follow-hint-none'))
  })

  it('has no "Continue" and no separate "Sign In" button on any row', async () => {
    const { w } = mountB()
    await open(w)
    expect(w.find('.usage-acct-continue').exists()).toBe(false)
    expect(w.find('.usage-acct-signin').exists()).toBe(false)
  })

  it('choosing an account with its own dir sets the default and moves only the following panes', async () => {
    const fol = follow({ plan: ['p2', 'p3'] })
    const { w, setPaneDefault, setDefault, switchHandler, act } = mountB({ follow: fol })
    await open(w)
    await row(w, 'b@x.com').find('.usage-acct').trigger('click')
    await vi.runAllTimersAsync()
    expect(fol.plan).toHaveBeenCalledWith('bbbb')
    expect(setPaneDefault).toHaveBeenCalledWith('claude', 'bbbb')
    expect(fol.move).toHaveBeenCalledWith(['p2', 'p3'], 'bbbb')
    // Never a live swap, never this pane on its own.
    expect(switchHandler).not.toHaveBeenCalled()
    expect(setDefault).not.toHaveBeenCalled()
    expect(act.continueWith).not.toHaveBeenCalled()
  })

  it('with no pane following, only the default changes', async () => {
    const fol = follow({ plan: [] })
    const { w, setPaneDefault, switchHandler } = mountB({ follow: fol })
    await open(w)
    await row(w, 'b@x.com').find('.usage-acct').trigger('click')
    await vi.runAllTimersAsync()
    expect(setPaneDefault).toHaveBeenCalledWith('claude', 'bbbb')
    expect(fol.move).not.toHaveBeenCalled()
    expect(switchHandler).not.toHaveBeenCalled()
  })

  it('a cancelled running-pane confirm changes nothing', async () => {
    const fol = follow({ plan: null })
    const { w, setPaneDefault, switchHandler } = mountB({ follow: fol })
    await open(w)
    await row(w, 'b@x.com').find('.usage-acct').trigger('click')
    await vi.runAllTimersAsync()
    expect(fol.plan).toHaveBeenCalledWith('bbbb')
    expect(setPaneDefault).not.toHaveBeenCalled()
    expect(fol.move).not.toHaveBeenCalled()
    expect(switchHandler).not.toHaveBeenCalled()
  })

  it('choosing the live account clears the pane default and moves followers onto it, without a swap', async () => {
    const fol = follow({ plan: ['p2'] })
    const { w, setPaneDefault, switchHandler, setDefault } = mountB({ paneDefault: 'bbbb', follow: fol })
    await open(w)
    await row(w, 'a@x.com').find('.usage-acct').trigger('click')
    await vi.runAllTimersAsync()
    expect(fol.plan).toHaveBeenCalledWith('aaaa')
    expect(setPaneDefault).toHaveBeenCalledWith('claude', null)
    expect(fol.move).toHaveBeenCalledWith(['p2'], 'aaaa')
    expect(switchHandler).not.toHaveBeenCalled()
    expect(setDefault).not.toHaveBeenCalled()
  })

  it('an account not signed in inside its own dir says so, and its row starts the sign-in', async () => {
    const fol = follow()
    const { w, act, setPaneDefault, switchHandler } = mountB({ follow: fol })
    await open(w)
    const r = row(w, 'c@x.com')
    expect(r.find('.usage-acct-need').text()).toBe(i18n.global.t('account-follow.needs-dir-sign-in'))
    await r.find('.usage-acct').trigger('click')
    await vi.runAllTimersAsync()
    expect(act.signIn).toHaveBeenCalledWith('claude', 'cccc')
    expect(fol.plan).not.toHaveBeenCalled()
    expect(setPaneDefault).not.toHaveBeenCalled()
    expect(switchHandler).not.toHaveBeenCalled()
  })

  it('the built-in Default, when it is not the live login, points to account settings instead of swapping', async () => {
    const fol = follow()
    const { w, setPaneDefault, switchHandler } = mountB({ follow: fol })
    await open(w)
    const r = w.findAll('.usage-acct-row')[0]
    expect(r.find('.usage-acct-need').text()).toBe(i18n.global.t('account-follow.default-needs-switch'))
    await r.find('.usage-acct').trigger('click')
    await vi.runAllTimersAsync()
    expect(shared.executeCommand).toHaveBeenCalledWith('workbench.action.openSettingsAccounts')
    expect(fol.plan).not.toHaveBeenCalled()
    expect(setPaneDefault).not.toHaveBeenCalled()
    expect(switchHandler).not.toHaveBeenCalled()
  })

  it('the built-in Default, when it is the live login, is chosen like any landable account', async () => {
    const fol = follow({ plan: ['p2'] })
    const { w, setPaneDefault, switchHandler } = mountB({ liveDefault: null, paneDefault: 'bbbb', follow: fol })
    await open(w)
    await w.findAll('.usage-acct-row')[0].find('.usage-acct').trigger('click')
    await vi.runAllTimersAsync()
    expect(fol.plan).toHaveBeenCalledWith('__default__')
    expect(setPaneDefault).toHaveBeenCalledWith('claude', null)
    expect(fol.move).toHaveBeenCalledWith(['p2'], '__default__')
    expect(switchHandler).not.toHaveBeenCalled()
  })
})

describe('UsageBadge – scheme B not in effect: the menu is what it was on main', () => {
  it('with no account dir signed in, a row still switches the live credential', async () => {
    const { fake, setPaneDefault } = makeProfiles({ liveDefault: 'aaaa' })
    const switchHandler = vi.fn(async () => ({ ok: true }))
    const fol = follow()
    const w = mountBadge(fake, { paneId: 'p1', paneProfileId: 'aaaa' }, { actions: actions(), switchHandler, follow: fol })
    await open(w)
    expect(w.find('.usage-pop-switch-title').text()).toBe(i18n.global.t('usage.switch-title'))
    expect(w.find('.usage-acct-follow-hint').exists()).toBe(false)
    // The sign-in offer an account without a dir login always had.
    expect(row(w, 'c@x.com').find('.usage-acct-signin').exists()).toBe(true)
    await row(w, 'c@x.com').find('.usage-acct').trigger('click')
    await vi.runAllTimersAsync()
    expect(switchHandler).toHaveBeenCalledWith('claude', 'cccc')
    expect(setPaneDefault).not.toHaveBeenCalled()
    expect(fol.plan).not.toHaveBeenCalled()
  })

  it('without the follow actions (other windows), account dirs keep the old list with "Continue"', async () => {
    const { fake } = makeProfiles({
      liveDefault: 'aaaa',
      dirs: { bbbb: { signedIn: true, email: 'b@x.com' }, cccc: { signedIn: true, email: 'c@x.com' } },
    })
    const act = actions()
    const w = mountBadge(fake, { paneId: 'p1', paneProfileId: 'bbbb' }, { actions: act })
    await open(w)
    expect(w.find('.usage-pop-switch-title').text()).toBe(i18n.global.t('usage.pane-default-title'))
    await row(w, 'c@x.com').find('.usage-acct-continue').trigger('click')
    expect(act.continueWith).toHaveBeenCalledWith('p1', 'cccc')
  })

  it('for a CLI other than claude nothing changes', async () => {
    const { fake } = makeProfiles({ liveDefault: 'aaaa', dirs: DIRS })
    const switchHandler = vi.fn(async () => ({ ok: true }))
    const fol = follow()
    const w = mount(UsageBadge, {
      props: { agentKey: 'codex', cliProfiles: fake as unknown as ReturnType<typeof useCliProfiles> },
      global: {
        plugins: [i18n],
        stubs: { teleport: true },
        provide: {
          [cliAccountDirActionsKey as symbol]: actions(),
          [cliAccountSwitchKey as symbol]: switchHandler,
          [accountFollowKey as symbol]: fol,
        },
      },
    })
    await open(w)
    expect(w.find('.usage-acct-follow-hint').exists()).toBe(false)
    expect(w.find('.usage-acct-need').exists()).toBe(false)
  })
})

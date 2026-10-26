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
import {
  accountFollowKey,
  accountPinKey,
  type AccountFollowActions,
  type AccountPinActions,
} from '../../lib/accountFollowPanes'

// Scheme A of plan claude_f1bf4b: in the main window, once some claude
// account runs on its own config dir, a row click swaps the live credential
// (the v0.2.15 path) — every following pane moves on its next turn, nothing
// restarts, nothing asks to sign in again. Fixed panes stay; the list says how
// many and offers to make them all follow, only when clicked. Without any
// account dir, or outside the main window, the list is exactly main's.

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
  props: { paneId?: string; paneProfileId?: string; paneFollow?: 'follow' | 'fixed' } = {},
  provide: { actions?: CliAccountDirActions; switchHandler?: unknown; follow?: AccountFollowActions; pins?: AccountPinActions } = {},
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
        ...(provide.pins ? { [accountPinKey as symbol]: provide.pins } : {}),
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

function follow(): AccountFollowActions & { plan: ReturnType<typeof vi.fn>; move: ReturnType<typeof vi.fn> } {
  return { followingCount: () => 0, plan: vi.fn(async () => []), move: vi.fn(async () => {}) }
}

function pins(fixed = 0): AccountPinActions & { unpinAll: ReturnType<typeof vi.fn>; movePane: ReturnType<typeof vi.fn> } {
  return { fixedCount: () => fixed, unpinAll: vi.fn(async () => {}), movePane: vi.fn(async () => {}) }
}

// a = live credential; b signed in inside its own dir; c did not.
const DIRS = {
  bbbb: { signedIn: true, email: 'b@x.com' },
  cccc: { signedIn: false, email: null },
}

// The main window provides all of these.
function mountA(opts: { paneDefault?: string; fixed?: number } = {}) {
  const profiles = makeProfiles({ liveDefault: 'aaaa', paneDefault: opts.paneDefault, dirs: DIRS })
  const switchHandler = vi.fn(async () => ({ ok: true }))
  const act = actions()
  const fol = follow()
  const pin = pins(opts.fixed ?? 0)
  const w = mountBadge(profiles.fake, { paneId: 'p1', paneProfileId: 'aaaa' }, {
    actions: act, switchHandler, follow: fol, pins: pin,
  })
  return { w, act, fol, pin, switchHandler, ...profiles }
}

beforeEach(() => {
  shared.executeCommand.mockReset()
})

describe('UsageBadge – scheme A: a row swaps the live credential', () => {
  it('an account signed in inside its own dir is switched to live, not only chosen for new panes', async () => {
    const { w, switchHandler, setPaneDefault, fol } = mountA()
    await open(w)
    await row(w, 'b@x.com').find('.usage-acct').trigger('click')
    await vi.runAllTimersAsync()
    expect(switchHandler).toHaveBeenCalledWith('claude', 'bbbb')
    expect(setPaneDefault).not.toHaveBeenCalled()
    // #194's follow batch is not part of this path.
    expect(fol.plan).not.toHaveBeenCalled()
    expect(fol.move).not.toHaveBeenCalled()
  })

  it('an account without a dir login is switched to live as well, with no sign-in asked', async () => {
    const { w, switchHandler, act } = mountA()
    await open(w)
    await row(w, 'c@x.com').find('.usage-acct').trigger('click')
    await vi.runAllTimersAsync()
    expect(switchHandler).toHaveBeenCalledWith('claude', 'cccc')
    expect(act.signIn).not.toHaveBeenCalled()
  })

  it('a pane default left from before is cleared, then the account is switched to live', async () => {
    const { w, switchHandler, setPaneDefault } = mountA({ paneDefault: 'bbbb' })
    await open(w)
    await row(w, 'b@x.com').find('.usage-acct').trigger('click')
    await vi.runAllTimersAsync()
    expect(setPaneDefault).toHaveBeenCalledWith('claude', null)
    expect(switchHandler).toHaveBeenCalledWith('claude', 'bbbb')
  })

  it('ticks the live account, not a stale pane default', async () => {
    const { w } = mountA({ paneDefault: 'bbbb' })
    await open(w)
    expect(row(w, 'a@x.com').find('.usage-acct-tick').exists()).toBe(true)
    expect(row(w, 'b@x.com').find('.usage-acct-tick').exists()).toBe(false)
    expect(w.find('.usage-pop-switch-title').text()).toBe(i18n.global.t('usage.switch-title'))
  })

  it('shows no "Continue", no separate "Sign In" and no "needs sign-in" chip', async () => {
    const { w } = mountA()
    await open(w)
    expect(w.find('.usage-acct-continue').exists()).toBe(false)
    expect(w.find('.usage-acct-signin').exists()).toBe(false)
    expect(w.find('.usage-acct-need').exists()).toBe(false)
    expect(w.find('.usage-acct-follow-hint').exists()).toBe(false)
  })
})

describe('UsageBadge – scheme A: fixed panes and "make all follow"', () => {
  it('says nothing about fixed panes when there are none', async () => {
    const { w } = mountA({ fixed: 0 })
    await open(w)
    expect(w.find('.usage-acct-pin-hint').exists()).toBe(false)
    expect(w.find('.usage-acct-unpin').exists()).toBe(false)
  })

  it('says how many panes are fixed and offers to make them all follow', async () => {
    const { w } = mountA({ fixed: 3 })
    await open(w)
    expect(w.find('.usage-acct-pin-hint').text()).toContain(i18n.global.t('usage.pinned-hint', { count: 3 }))
    expect(w.find('.usage-acct-unpin').text()).toBe(i18n.global.t('usage.unpin-all'))
  })

  it('makes them follow only when the button is clicked', async () => {
    const { w, pin, switchHandler } = mountA({ fixed: 2 })
    await open(w)
    await vi.runAllTimersAsync()
    expect(pin.unpinAll).not.toHaveBeenCalled()
    await w.find('.usage-acct-unpin').trigger('click')
    await vi.runAllTimersAsync()
    expect(pin.unpinAll).toHaveBeenCalledTimes(1)
    expect(switchHandler).not.toHaveBeenCalled()
  })
})

describe('UsageBadge – scheme A not in effect: exactly main', () => {
  it('with no account dir, a row switches live and the Sign in offer stays', async () => {
    const { fake, setPaneDefault } = makeProfiles({ liveDefault: 'aaaa' })
    const switchHandler = vi.fn(async () => ({ ok: true }))
    const pin = pins(4)
    const w = mountBadge(fake, { paneId: 'p1', paneProfileId: 'aaaa' }, {
      actions: actions(), switchHandler, follow: follow(), pins: pin,
    })
    await open(w)
    expect(w.find('.usage-pop-switch-title').text()).toBe(i18n.global.t('usage.switch-title'))
    expect(row(w, 'c@x.com').find('.usage-acct-signin').exists()).toBe(true)
    expect(w.find('.usage-acct-pin-hint').exists()).toBe(false)
    await row(w, 'c@x.com').find('.usage-acct').trigger('click')
    await vi.runAllTimersAsync()
    expect(switchHandler).toHaveBeenCalledWith('claude', 'cccc')
    expect(setPaneDefault).not.toHaveBeenCalled()
  })

  it('without the pin actions (other windows), a dir account is still only chosen for new panes', async () => {
    const { fake, setPaneDefault } = makeProfiles({ liveDefault: 'aaaa', dirs: DIRS })
    const switchHandler = vi.fn(async () => ({ ok: true }))
    const w = mountBadge(fake, {}, { switchHandler })
    await open(w)
    await row(w, 'b@x.com').find('.usage-acct').trigger('click')
    await vi.runAllTimersAsync()
    expect(setPaneDefault).toHaveBeenCalledWith('claude', 'bbbb')
    expect(switchHandler).not.toHaveBeenCalled()
  })
})

describe('UsageBadge – this pane\'s "follow account switch" toggle', () => {
  function mountPaneFollow(paneFollow?: 'follow' | 'fixed') {
    const profiles = makeProfiles({ liveDefault: 'aaaa', dirs: DIRS })
    return mountBadge(profiles.fake, { paneId: 'p1', paneProfileId: 'aaaa', paneFollow }, {
      actions: actions(), switchHandler: vi.fn(async () => ({ ok: true })), follow: follow(), pins: pins(1),
    })
  }

  it('is absent when the window does not offer the flag for this pane', async () => {
    const w = mountPaneFollow(undefined)
    await open(w)
    expect(w.find('[data-testid="pane-follow-switch"]').exists()).toBe(false)
  })

  it('sits above the account list, on for a following pane, with its label and hint', async () => {
    const w = mountPaneFollow('follow')
    await open(w)
    const sw = w.get('[data-testid="pane-follow-switch"]')
    expect(sw.attributes('role')).toBe('switch')
    expect(sw.attributes('aria-checked')).toBe('true')
    const rowEl = w.get('.usage-pane-follow')
    expect(rowEl.text()).toContain(i18n.global.t('account-follow.follow-switch-label'))
    expect(rowEl.text()).toContain(i18n.global.t('account-follow.follow-switch-hint'))
    const html = w.html()
    expect(html.indexOf('usage-pane-follow')).toBeLessThan(html.indexOf('usage-acct-list'))
  })

  it('is off for a fixed pane', async () => {
    const w = mountPaneFollow('fixed')
    await open(w)
    expect(w.get('[data-testid="pane-follow-switch"]').attributes('aria-checked')).toBe('false')
  })

  it('asks the pane to flip the flag on click, and touches nothing else', async () => {
    const profiles = makeProfiles({ liveDefault: 'aaaa', dirs: DIRS })
    const switchHandler = vi.fn(async () => ({ ok: true }))
    const fol = follow()
    const pin = pins(1)
    const w = mountBadge(profiles.fake, { paneId: 'p1', paneProfileId: 'aaaa', paneFollow: 'follow' }, {
      actions: actions(), switchHandler, follow: fol, pins: pin,
    })
    await open(w)
    await w.get('[data-testid="pane-follow-switch"]').trigger('click')
    await w.setProps({ paneFollow: 'fixed' })
    await w.get('[data-testid="pane-follow-switch"]').trigger('click')
    await vi.runAllTimersAsync()
    expect(w.emitted('toggle-pane-follow')).toHaveLength(2)
    expect(switchHandler).not.toHaveBeenCalled()
    expect(profiles.setDefault).not.toHaveBeenCalled()
    expect(pin.unpinAll).not.toHaveBeenCalled()
    expect(fol.move).not.toHaveBeenCalled()
  })
})

describe('UsageBadge – follow off: a row moves only this pane', () => {
  // A fixed pane running in b's own dir; a is the live credential with no
  // dir login; b and c are both signed in inside their own dirs.
  function mountFixed(opts: { paneFollow?: 'follow' | 'fixed'; paneProfileId?: string; pins?: boolean } = {}) {
    const profiles = makeProfiles({
      liveDefault: 'aaaa',
      dirs: { bbbb: { signedIn: true, email: 'b@x.com' }, cccc: { signedIn: true, email: 'c@x.com' } },
    })
    const switchHandler = vi.fn(async () => ({ ok: true }))
    const act = actions()
    const fol = follow()
    const pin = pins(1)
    const w = mountBadge(
      profiles.fake,
      { paneId: 'p1', paneProfileId: opts.paneProfileId ?? 'bbbb', paneFollow: opts.paneFollow ?? 'fixed' },
      { actions: act, switchHandler, follow: fol, ...(opts.pins === false ? {} : { pins: pin }) },
    )
    return { w, act, fol, pin, switchHandler, ...profiles }
  }

  it('a dir account moves only this pane: no live switch, default unchanged, no follow batch', async () => {
    const { w, pin, switchHandler, setDefault, setPaneDefault, fol } = mountFixed()
    await open(w)
    await row(w, 'c@x.com').find('.usage-acct').trigger('click')
    await vi.runAllTimersAsync()
    expect(pin.movePane).toHaveBeenCalledWith('p1', 'cccc')
    expect(switchHandler).not.toHaveBeenCalled()
    expect(setDefault).not.toHaveBeenCalled()
    expect(setPaneDefault).not.toHaveBeenCalled()
    expect(fol.plan).not.toHaveBeenCalled()
    expect(fol.move).not.toHaveBeenCalled()
  })

  it('the account this pane already runs on does nothing', async () => {
    const { w, pin, switchHandler } = mountFixed()
    await open(w)
    await row(w, 'b@x.com').find('.usage-acct').trigger('click')
    await vi.runAllTimersAsync()
    expect(pin.movePane).not.toHaveBeenCalled()
    expect(switchHandler).not.toHaveBeenCalled()
  })

  it('an account with no dir login starts that sign-in, and nothing else', async () => {
    const { w, pin, act, switchHandler } = mountFixed()
    await open(w)
    await row(w, 'a@x.com').find('.usage-acct').trigger('click')
    await vi.runAllTimersAsync()
    expect(act.signIn).toHaveBeenCalledWith('claude', 'aaaa')
    expect(pin.movePane).not.toHaveBeenCalled()
    expect(switchHandler).not.toHaveBeenCalled()
  })

  it('the built-in Default is refused: it has no folder of its own', async () => {
    const { w, pin, switchHandler, setPaneDefault } = mountFixed()
    await open(w)
    const def = w.findAll('.usage-acct-row')[0]
    await def.find('.usage-acct').trigger('click')
    await vi.runAllTimersAsync()
    expect(notify.alert).toHaveBeenCalledWith(i18n.global.t('account-follow.pin-default-refused'), expect.anything())
    expect(pin.movePane).not.toHaveBeenCalled()
    expect(switchHandler).not.toHaveBeenCalled()
    expect(setPaneDefault).not.toHaveBeenCalled()
  })

  it('follow on: unchanged — the row switches the live account, this pane is not moved alone', async () => {
    const { w, pin, switchHandler } = mountFixed({ paneFollow: 'follow', paneProfileId: 'aaaa' })
    await open(w)
    await row(w, 'b@x.com').find('.usage-acct').trigger('click')
    await vi.runAllTimersAsync()
    expect(switchHandler).toHaveBeenCalledWith('claude', 'bbbb')
    expect(pin.movePane).not.toHaveBeenCalled()
  })

  it('without the pin actions (scheme A not in effect), a fixed pane keeps the old list', async () => {
    const { w, switchHandler, setPaneDefault, fol } = mountFixed({ pins: false })
    await open(w)
    await row(w, 'c@x.com').find('.usage-acct').trigger('click')
    await vi.runAllTimersAsync()
    // Scheme B (follow actions, no pins): the row chooses the default.
    expect(fol.plan).toHaveBeenCalledWith('cccc')
    expect(setPaneDefault).toHaveBeenCalledWith('claude', 'cccc')
    expect(switchHandler).not.toHaveBeenCalled()
  })
})

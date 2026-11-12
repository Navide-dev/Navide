// @vitest-environment happy-dom
// The quota popover states what happens when this account runs out: the
// failover policy (the same backend value Settings writes), who an automatic
// switch would pick next and how many automatic switches are left. The rows
// below it stay manual.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import UsageBadge from '../UsageBadge.vue'
import { i18n } from '@navide/plugin-ui/foundation'
import type { UsageSnapshot } from '../../composables/useUsage'
import type { CliProfile, useCliProfiles } from '../../composables/useCliProfiles'
import type { FailoverCandidate, FailoverMode, FailoverState } from '../../composables/useQuotaFailover'

const usage = vi.hoisted(() => ({
  usageFor: vi.fn<(agentKey: string | undefined | null) => UsageSnapshot | undefined>(),
}))
vi.mock('../../composables/useUsage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../composables/useUsage')>()
  return { ...actual, usageFor: usage.usageFor, accountUsageFor: usage.usageFor, refreshUsage: vi.fn() }
})

const shared = vi.hoisted(() => ({ executeCommand: vi.fn() }))
vi.mock('@navide/plugin-ui/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@navide/plugin-ui/shared')>()),
  executeCommand: shared.executeCommand,
}))

const fo = vi.hoisted(() => ({
  state: null as unknown as import('vue').Ref<FailoverState | null>,
  candidates: [] as FailoverCandidate[] | null,
  previewCandidates: vi.fn(),
  setPolicy: vi.fn(),
}))
vi.mock('../../composables/useQuotaFailover', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../composables/useQuotaFailover')>()
  const { ref: vref } = await import('vue')
  fo.state = vref<FailoverState | null>(null)
  return {
    ...actual,
    useQuotaFailover: () => ({
      state: fo.state,
      capabilityFor: (k: string) => fo.state.value?.capabilities[k],
      budgetFor: (k: string) => Object.values(fo.state.value?.budget ?? {}).find((b) => b.agentKey === k),
      previewCandidates: fo.previewCandidates,
      setPolicy: fo.setPolicy,
    }),
  }
})

function snap(): UsageSnapshot {
  return {
    provider: 'claude',
    status: 'ok',
    planType: 'max',
    windows: [{ kind: 'session', label: 'Session', usedPercent: 97, resetsAt: null }],
    fetchedAt: '2026-11-12T00:00:00Z',
    error: null,
  }
}

function state(mode: FailoverMode, used = 1): FailoverState {
  return {
    policy: { mode, updatedAt: null },
    capabilities: {
      claude: {
        agentKey: 'claude', supported: true, switchMode: 'hot', authScope: 'claude', evidence: 'live',
        resume: 'native', scopes: [], hasSlots: true, todo: '',
      },
    },
    budget: {
      claude: { agentKey: 'claude', authScope: 'claude', used, limit: 3, windowSec: 18000, minGapSec: 600, nextAllowedAt: null },
    },
    epochs: {},
    incidents: [],
    transactions: [],
  }
}

const A = { id: 'aaaa', agentKey: 'claude', name: 'A', createdAt: '' } as CliProfile
const B = { id: 'bbbb', agentKey: 'claude', name: 'B', createdAt: '' } as CliProfile

function profiles(hasProfiles = true) {
  return {
    error: ref(''),
    hasProfiles: () => hasProfiles,
    profilesForAgent: () => [A, B],
    defaultProfileId: () => 'aaaa',
    findProfile: (id: string | null | undefined) => [A, B].find((p) => p.id === id),
    setDefault: vi.fn(),
    setPaneDefault: vi.fn(),
    paneDefaults: ref({}),
    rename: vi.fn(),
    identityFor: (_a: string, id: string | null) =>
      id === 'bbbb' ? { email: 'b@example.com', signedIn: true } : { email: 'a@example.com', signedIn: true },
    aliasFor: (_a: string, id: string | null) => (id === 'bbbb' ? 'Account B' : id === 'aaaa' ? 'Account A' : undefined),
    accountDirFor: () => null,
    newPaneProfileId: () => 'aaaa',
  }
}

function mountBadge(hasProfiles = true): VueWrapper {
  return mount(UsageBadge, {
    props: { agentKey: 'claude', cliProfiles: profiles(hasProfiles) as unknown as ReturnType<typeof useCliProfiles> },
    global: { plugins: [i18n], stubs: { teleport: true } },
  })
}

async function open(wrapper: VueWrapper): Promise<void> {
  await wrapper.find('.usage-badge').trigger('mouseenter')
  vi.advanceTimersByTime(200)
  await nextTick()
  await flushPromises()
}

const candB: FailoverCandidate = {
  slotId: 'bbbb', tier: 'fresh-headroom', loginState: 'ok', excluded: null, headroom: 82, fetchedAt: null,
}
const current: FailoverCandidate = { ...candB, slotId: 'aaaa', excluded: 'current' }

beforeEach(() => {
  vi.useFakeTimers()
  usage.usageFor.mockReset().mockReturnValue(snap())
  fo.state.value = null
  fo.previewCandidates.mockReset().mockImplementation(async () => [current, candB])
  fo.setPolicy.mockReset().mockImplementation(async (mode: FailoverMode) => {
    fo.state.value = state(mode)
    return true
  })
  shared.executeCommand.mockReset()
})

describe('UsageBadge ▸ when quota runs out', () => {
  it('in auto mode names the next account and the automatic switches left', async () => {
    fo.state.value = state('auto', 1)
    const w = mountBadge()
    await open(w)
    expect((w.get('[data-testid="pop-failover-mode"]').element as HTMLSelectElement).value).toBe('auto')
    const next = w.get('[data-testid="pop-failover-next"]').text()
    expect(next).toContain(i18n.global.t('usage.auto-switch-next', { name: 'Account B' }))
    expect(next).toContain(i18n.global.t('usage.auto-switch-left', { n: 2 }))
    expect(fo.previewCandidates).toHaveBeenCalledWith('claude')
    expect(w.find('[data-testid="pop-failover-note"]').exists()).toBe(false)
  })

  it('in notify mode says nothing switches by itself, without a budget', async () => {
    fo.state.value = state('notify')
    const w = mountBadge()
    await open(w)
    expect(w.get('[data-testid="pop-failover-note"]').text()).toBe(i18n.global.t('usage.auto-switch-notify-only'))
    expect(w.get('[data-testid="pop-failover-next"]').text()).not.toContain(i18n.global.t('usage.auto-switch-left', { n: 2 }))
  })

  it('in off mode reads no candidates', async () => {
    fo.state.value = state('off')
    const w = mountBadge()
    await open(w)
    expect(w.get('[data-testid="pop-failover-note"]').text()).toBe(i18n.global.t('usage.auto-switch-off-only'))
    expect(w.find('[data-testid="pop-failover-next"]').exists()).toBe(false)
    expect(fo.previewCandidates).not.toHaveBeenCalled()
  })

  it('says so when no other account has quota', async () => {
    fo.state.value = state('auto')
    fo.previewCandidates.mockResolvedValue([current, { ...candB, excluded: 'exhausted' }])
    const w = mountBadge()
    await open(w)
    expect(w.get('[data-testid="pop-failover-next"]').text()).toContain(i18n.global.t('usage.auto-switch-next-none'))
  })

  it('writes a mode change through the shared failover policy', async () => {
    fo.state.value = state('notify')
    const w = mountBadge()
    await open(w)
    await w.get('[data-testid="pop-failover-mode"]').setValue('auto')
    await flushPromises()
    expect(fo.setPolicy).toHaveBeenCalledWith('auto')
    expect(w.get('[data-testid="pop-failover-next"]').text()).toContain(i18n.global.t('usage.auto-switch-left', { n: 2 }))
  })

  it('ignores a value outside off/notify/auto', async () => {
    fo.state.value = state('notify')
    const w = mountBadge()
    await open(w)
    const select = w.get('[data-testid="pop-failover-mode"]')
    ;(select.element as HTMLSelectElement).value = 'always'
    await select.trigger('change')
    expect(fo.setPolicy).not.toHaveBeenCalled()
  })

  it('opens Settings ▸ Accounts at the auto-continue card', async () => {
    fo.state.value = state('auto')
    const w = mountBadge()
    await open(w)
    await w.get('[data-testid="pop-failover-open"]').trigger('click')
    expect(shared.executeCommand).toHaveBeenCalledWith('workbench.action.openSettingsAccounts', { section: 'accounts-auto-switch' })
  })

  it('is absent before the backend answered, and for a CLI with a single account', async () => {
    const w = mountBadge()
    await open(w)
    expect(w.find('[data-testid="pop-failover"]').exists()).toBe(false)
    fo.state.value = state('auto')
    const single = mountBadge(false)
    await open(single)
    expect(single.find('[data-testid="pop-failover"]').exists()).toBe(false)
  })
})

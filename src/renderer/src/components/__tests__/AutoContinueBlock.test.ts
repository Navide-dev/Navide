// @vitest-environment happy-dom
// Settings ▸ Accounts, above the list (plan 0-2-42_eb5049, placement A): the
// failover mode (the same policy General writes), the next account, the order,
// the switch log and any switch parked behind busy panes, which can be called off.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import AutoContinueBlock from '../accounts/AutoContinueBlock.vue'
import {
  publishQueuedAccountSwitches,
  setQueuedAccountSwitchCanceller,
} from '../../composables/useQueuedAccountSwitches'
import type { FailoverCandidate, FailoverMode, FailoverState } from '../../composables/useQuotaFailover'

const fo = vi.hoisted(() => ({
  state: null as unknown as import('vue').Ref<FailoverState | null>,
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

const accounts = {
  identityFor: () => null,
  findProfile: (id: string | null | undefined) => (id === 'bbbb' ? { name: 'Account B' } : undefined),
}
const candB: FailoverCandidate = {
  slotId: 'bbbb', tier: 'fresh-headroom', loginState: 'ok', excluded: null, headroom: 82.4, fetchedAt: null,
}

function mountBlock(entries: unknown[] | null = []) {
  const send = vi.fn(async () => {
    if (entries === null) throw new Error('no handler')
    return { payload: { entries } }
  })
  const wrapper = mount(AutoContinueBlock, {
    props: { agentKey: 'claude', accounts, backend: { send } as never },
    global: { plugins: [i18n] },
  })
  return { wrapper, send }
}

const t = i18n.global.t

beforeEach(() => {
  fo.state.value = null
  fo.previewCandidates.mockReset().mockResolvedValue([{ ...candB, slotId: '__default__', excluded: 'current' }, candB])
  fo.setPolicy.mockReset().mockImplementation(async (mode: FailoverMode) => {
    fo.state.value = state(mode)
    return true
  })
  publishQueuedAccountSwitches([])
  setQueuedAccountSwitchCanceller(null)
})

describe('AutoContinueBlock', () => {
  it('shows the mode, the next account with its quota, the budget, the order and the log count', async () => {
    fo.state.value = state('auto', 1)
    const { wrapper, send } = mountBlock([{}, {}])
    await flushPromises()
    expect((wrapper.get('[data-testid="auto-continue-mode"]').element as HTMLSelectElement).value).toBe('auto')
    expect(wrapper.get('[data-testid="auto-continue-next"]').text()).toBe(t('usage.auto-switch-next-headroom', { name: 'Account B', pct: 82 }))
    expect(wrapper.get('[data-testid="auto-continue-left"]').text()).toBe(t('usage.auto-switch-left', { n: 2 }))
    expect(wrapper.text()).toContain(t('usage.auto-switch-order'))
    expect(wrapper.get('[data-testid="auto-continue-log"]').text()).toBe(t('usage.auto-switch-log', { n: 2 }))
    expect(send).toHaveBeenCalledWith('account_switch_log.list', { limit: 200 })
  })

  it('in notify mode says nothing switches by itself; off reads no candidates', async () => {
    fo.state.value = state('notify')
    const { wrapper } = mountBlock()
    await flushPromises()
    expect(wrapper.get('[data-testid="auto-continue-note"]').text()).toBe(t('usage.auto-switch-notify-only'))
    expect(wrapper.find('[data-testid="auto-continue-next"]').exists()).toBe(true)

    fo.previewCandidates.mockClear()
    fo.state.value = state('off')
    await flushPromises()
    expect(wrapper.get('[data-testid="auto-continue-note"]').text()).toBe(t('usage.auto-switch-off-only'))
    expect(wrapper.find('[data-testid="auto-continue-next"]').exists()).toBe(false)
    expect(fo.previewCandidates).not.toHaveBeenCalled()
  })

  it('says so when no other account has quota', async () => {
    fo.state.value = state('auto')
    fo.previewCandidates.mockResolvedValue([{ ...candB, excluded: 'exhausted' }])
    const { wrapper } = mountBlock()
    await flushPromises()
    expect(wrapper.get('[data-testid="auto-continue-next"]').text()).toBe(t('usage.auto-switch-next-none'))
  })

  it('writes a mode change through the shared failover policy, and ignores anything else', async () => {
    fo.state.value = state('notify')
    const { wrapper } = mountBlock()
    await flushPromises()
    const select = wrapper.get('[data-testid="auto-continue-mode"]')
    ;(select.element as HTMLSelectElement).value = 'always'
    await select.trigger('change')
    expect(fo.setPolicy).not.toHaveBeenCalled()
    await select.setValue('auto')
    await flushPromises()
    expect(fo.setPolicy).toHaveBeenCalledWith('auto')
  })

  it('lists parked switches and calls one off', async () => {
    fo.state.value = state('auto')
    const cancel = vi.fn()
    setQueuedAccountSwitchCanceller(cancel)
    publishQueuedAccountSwitches([
      { key: 'agent:claude', agentKey: 'claude', to: 'Account B', waiting: 3 },
      { key: 'pane:p1', agentKey: 'claude', to: 'Account B', paneName: 'builder', waiting: 1 },
    ])
    const { wrapper } = mountBlock()
    await flushPromises()
    const rows = wrapper.findAll('[data-testid="auto-continue-queued"]')
    expect(rows.map((r) => r.find('.ac-queued-text').text())).toEqual([
      t('usage.auto-switch-queued', { to: 'Account B', n: 3 }),
      t('usage.auto-switch-queued-pane', { to: 'Account B', pane: 'builder' }),
    ])
    await rows[1].get('[data-testid="auto-continue-cancel"]').trigger('click')
    expect(cancel).toHaveBeenCalledWith('pane:p1')
  })

  it('leaves the log link out when the log cannot be read', async () => {
    fo.state.value = state('auto')
    const { wrapper } = mountBlock(null)
    await flushPromises()
    expect(wrapper.find('[data-testid="auto-continue-log"]').exists()).toBe(false)
  })
})

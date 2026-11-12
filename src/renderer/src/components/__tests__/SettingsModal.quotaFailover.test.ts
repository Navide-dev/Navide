// @vitest-environment happy-dom
// Settings ▸ General ▸ "Account switch when quota runs out": the off/notify/
// auto policy is the backend's persisted value (read from the failover
// singleton, written through set_policy), and the per-CLI table shows what
// each vendor declared — switch mode, resume, "not verified", platform — as
// facts, never as a decision to disable anything.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import { CLI_AGENT_SPECS } from '@navide/plugin-shell'
import { __resetSettingsForTest } from '@navide/plugin-ui/shared/testing'
import SettingsModal from '../SettingsModal.vue'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import { loadCliAgentPrefsFromProject } from '../../composables/useCliAgentPrefs'
import { usePushChannelPrefs } from '../../composables/usePushChannelPrefs'
import { useQuotaFailover, type FailoverState } from '../../composables/useQuotaFailover'
import { __resetQuotaAnnouncementsForTest } from '../../composables/useAnnouncements'
import { setPlatformId } from '../../../../shared/osplat'

type ModalProps = InstanceType<typeof SettingsModal>['$props']

function failoverState(patch: Partial<FailoverState> = {}): FailoverState {
  const caps: FailoverState['capabilities'] = {}
  for (const spec of CLI_AGENT_SPECS) {
    caps[spec.agentKey] = {
      agentKey: spec.agentKey,
      supported: spec.agentKey !== 'aider',
      switchMode: spec.agentKey === 'claude' ? 'hot' : spec.agentKey === 'aider' ? 'unsupported' : 'restart',
      authScope: spec.agentKey,
      evidence: spec.agentKey === 'claude' ? 'live' : 'source',
      resume: spec.agentKey === 'mcode' ? 'none' : 'native',
      scopes: [],
      platforms: spec.agentKey === 'cursor' ? ['darwin'] : ['darwin', 'linux', 'win32'],
      hasSlots: true,
      todo: spec.agentKey === 'aider' ? 'no distinguishable exhaustion notice' : '',
    }
  }
  return {
    policy: { mode: 'notify', updatedAt: null },
    capabilities: caps,
    budget: {},
    epochs: {},
    incidents: [],
    transactions: [],
    ...patch,
  }
}

describe('Settings ▸ quota failover policy and capability table', { timeout: 15000 }, () => {
  let wrapper: VueWrapper | undefined
  const failover = useQuotaFailover()

  beforeEach(() => {
    __resetSettingsForTest()
    __resetQuotaAnnouncementsForTest()
    failover.__resetQuotaFailoverForTest()
    loadCliAgentPrefsFromProject([], [])
    usePushChannelPrefs().pushDisabled.value = []
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {})
    // The table compares declared platforms against the one it draws for;
    // run as linux on every runner so the cursor row's darwin-only
    // declaration reads the same everywhere.
    setPlatformId('linux')
  })

  afterEach(() => {
    wrapper?.unmount()
    failover.__resetQuotaFailoverForTest()
    document.body.replaceChildren()
    vi.restoreAllMocks()
  })

  async function mountGeneral(state: FailoverState | null, before?: (mock: ReturnType<typeof createMockBackend>) => void) {
    const mock = createMockBackend('connected')
    before?.(mock)
    mock.setResponse('onboarding.status', {
      deps: [], models: [], model_catalog: [], complete: true,
      gate: {}, cli_health: { entries: [], findings: [], needs_attention: false },
    })
    if (state) {
      mock.setResponse('quota_failover.get_state', state)
      mock.setResponse('quota_failover.set_policy', { ...state, policy: { mode: 'auto', updatedAt: '2026-09-21T10:00:00.000Z' } })
      failover.initQuotaFailover(mock.backend, {
        ownsPane: () => false,
        paneReadiness: () => ({ ready: false, reason: 'refused' }),
        restartPane: async () => ({ outcome: 'failed', reason: 'test' }),
        openNewConversation: async () => ({ outcome: 'failed', reason: 'test' }),
        confirmNewConversation: async () => false,
        confirmLiveIsCurrent: async () => false,
        paneTermId: () => null,
        paneSessionId: () => null,
        agentLabel: (k) => k,
        slotLabel: (_k, s) => s,
        onSwitchCommitted: () => {},
        onIncidentReady: () => {},
        onSwitchRefused: () => {},
      })
      await flushPromises()
    }
    wrapper = shallowMount(SettingsModal, {
      attachTo: document.body,
      props: {
        backend: mock.backend,
        initialTab: 'general',
        rolesApi: {} as ModalProps['rolesApi'],
        stagesApi: {} as ModalProps['stagesApi'],
        analyzerApi: {
          analyzerSettings: ref({ backend: 'ollama' }), health: ref(null), pulling: ref(false), pullProgress: ref(null),
          pullError: ref(''), models: ref([]), benchmarking: ref(false), benchmarkProgress: ref(null), benchmarkResults: ref([]),
        } as unknown as ModalProps['analyzerApi'],
        cliProfilesApi: {
          identityFor: () => null,
          profilesForAgent: () => [],
          findProfile: (id: string | null | undefined) => (id === 'bbbb' ? { name: 'Account B' } : undefined),
        } as unknown as ModalProps['cliProfilesApi'],
      },
      global: {
        plugins: [i18n],
        stubs: {
          Teleport: true,
          SettingsSection: { template: '<section><slot /></section>' },
          SettingsCard: { template: '<div><slot /></div>' },
          SettingRow: { template: '<div><slot /><slot name="description" /><slot name="control" /></div>' },
        },
      },
    })
    await flushPromises()
    return mock
  }

  it('shows the persisted policy and writes a change through set_policy, never to ui_settings', async () => {
    const mock = await mountGeneral(failoverState())
    const select = wrapper!.get('[data-testid="quota-failover-mode"]')
    expect((select.element as HTMLSelectElement).value).toBe('notify')
    expect(select.findAll('option').map((o) => o.attributes('value'))).toEqual(['off', 'notify', 'auto'])
    // Every option is a real translation.
    expect(select.text()).not.toContain('usage.')

    await select.setValue('auto')
    await flushPromises()
    const call = mock.sent.find((s) => s.type === 'quota_failover.set_policy')
    expect(call?.payload).toEqual({ mode: 'auto' })
    expect((select.element as HTMLSelectElement).value).toBe('auto')
    expect(mock.sent.some((s) => s.type.startsWith('settings.') && JSON.stringify(s.payload).includes('autoSwitch'))).toBe(false)
  })

  it('a value outside off/notify/auto is ignored', async () => {
    const mock = await mountGeneral(failoverState())
    const select = wrapper!.get('[data-testid="quota-failover-mode"]')
    ;(select.element as HTMLSelectElement).value = 'always'
    await select.trigger('change')
    await flushPromises()
    expect(mock.sent.some((s) => s.type === 'quota_failover.set_policy')).toBe(false)
  })

  it('lists every registry CLI with its declared switch mode, resume and evidence / platform as information', async () => {
    await mountGeneral(failoverState())
    const rows = wrapper!.findAll('[data-failover-agent]')
    expect(rows.map((r) => r.attributes('data-failover-agent'))).toEqual(CLI_AGENT_SPECS.map((s) => s.agentKey))
    const text = (key: string) => rows.find((r) => r.attributes('data-failover-agent') === key)!.text()
    // Claude: hot, verified live → no tag.
    expect(text('claude')).toContain(i18n.global.t('usage.failover-switch-hot'))
    expect(text('claude')).not.toContain(i18n.global.t('usage.failover-unverified'))
    // Codex: restart, source evidence → "not verified", but still listed as supported.
    expect(text('codex')).toContain(i18n.global.t('usage.failover-switch-restart'))
    expect(text('codex')).toContain(i18n.global.t('usage.failover-unverified'))
    // Cursor: declared for darwin only; this test runs as linux.
    expect(text('cursor')).toContain(i18n.global.t('usage.failover-platform-unsupported'))
    expect(text('claude')).not.toContain(i18n.global.t('usage.failover-platform-unsupported'))
    // mcode: no native resume → new conversation.
    expect(text('mcode')).toContain(i18n.global.t('usage.failover-resume-none'))
    // aider: not available, with the backend's reason verbatim.
    expect(text('aider')).toContain(i18n.global.t('usage.failover-switch-unsupported'))
    expect(text('aider')).toContain('no distinguishable exhaustion notice')
    expect(wrapper!.get('[data-settings-section="general-quota-failover-caps"]').html()).not.toContain('usage.failover')
  })

  it('shows the backend note for a CLI with no account switch in the UI language', async () => {
    const state = failoverState()
    state.capabilities.aider = { ...state.capabilities.aider, todo: 'no account-switch adapter' }
    const original = i18n.global.locale.value
    i18n.global.locale.value = 'zh-TW'
    try {
      await mountGeneral(state)
      const aider = wrapper!.get('[data-failover-agent="aider"]')
      expect(aider.text()).toContain('尚無帳號切換轉接器')
      expect(aider.text()).not.toContain('no account-switch adapter')
    } finally {
      i18n.global.locale.value = original
    }
  })

  it('warns when the audit record cannot be written (automatic switching paused)', async () => {
    await mountGeneral(failoverState({ auditDegraded: 'disk full' }))
    expect(wrapper!.get('.failover-warn').text()).toBe(i18n.global.t('usage.failover-audit-degraded'))
  })

  it('renders only the disabled selector until the backend has answered', async () => {
    await mountGeneral(null)
    const select = wrapper!.get('[data-testid="quota-failover-mode"]')
    expect((select.element as HTMLSelectElement).disabled).toBe(true)
    expect(wrapper!.findAll('[data-failover-agent]')).toHaveLength(0)
  })

  it('is reachable through settings search', async () => {
    await mountGeneral(failoverState())
    await wrapper!.get('.s-search-input').setValue('quota')
    const hit = wrapper!.findAll('.s-search-result').find((r) => r.text().includes(i18n.global.t('settings.search.item.general-quota-failover.title')))
    expect(hit).toBeDefined()
  })
  it('keeps the policy in place and adds one line: the next account and the way to Accounts', async () => {
    await mountGeneral(failoverState(), (mock) => {
      mock.setResponse('quota_failover.candidates', {
        candidates: [
          { slotId: '__default__', tier: 'fresh-headroom', loginState: 'ok', excluded: 'current', headroom: 3, fetchedAt: null },
          { slotId: 'bbbb', tier: 'fresh-headroom', loginState: 'ok', excluded: null, headroom: 82, fetchedAt: null },
        ],
      })
    })
    const row = wrapper!.get('[data-settings-section="general-quota-failover"]')
    expect(row.find('[data-testid="quota-failover-mode"]').exists()).toBe(true)
    expect(wrapper!.find('[data-settings-section="general-quota-failover-loop"]').exists()).toBe(true)
    const line = row.get('[data-testid="general-failover-next"]')
    expect(line.text()).toContain(i18n.global.t('usage.auto-switch-next-headroom', { name: 'Account B', pct: 82 }))
    await line.get('[data-testid="general-failover-goto"]').trigger('click')
    await flushPromises()
    expect((wrapper!.get('[data-settings-section="accounts"]').element as HTMLElement).style.display).not.toBe('none')
  })
})

// @vitest-environment happy-dom
// Settings ▸ General ▸ "Move pinned panes along when switching Claude
// accounts" (agentTeam.accounts.followSwitch): off by default, written to the
// renderer settings store only, and reachable through settings search.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import { CLI_AGENT_SPECS } from '@navide/plugin-shell'
import { __resetSettingsForTest } from '@navide/plugin-ui/shared/testing'
import { settingsGet } from '@navide/plugin-ui/shared'
import { ACCOUNT_FOLLOW_SWITCH_SETTING_KEY } from '../../lib/accountFollowSwitch'
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

describe('Settings ▸ follow-switch flag', { timeout: 15000 }, () => {
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

  async function mountGeneral(state: FailoverState | null) {
    const mock = createMockBackend('connected')
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
        cliProfilesApi: { identityFor: () => null, profilesForAgent: () => [] } as unknown as ModalProps['cliProfilesApi'],
      },
      global: {
        plugins: [i18n],
        stubs: {
          Teleport: true,
          SettingsSection: { template: '<section><slot /></section>' },
          SettingsCard: { template: '<div><slot /></div>' },
          SettingRow: { template: '<div><slot /><slot name="control" /></div>' },
        },
      },
    })
    await flushPromises()
    return mock
  }

  it('is off by default and writes the flag when turned on', async () => {
    const mock = await mountGeneral(failoverState())
    const toggle = wrapper!.findComponent('[data-testid="account-follow-switch"]')
    expect(toggle.exists()).toBe(true)
    expect(toggle.props('modelValue')).toBe(false)
    toggle.vm.$emit('update:modelValue', true)
    await flushPromises()
    expect(settingsGet(ACCOUNT_FOLLOW_SWITCH_SETTING_KEY, false)).toBe(true)
    // A renderer preference: nothing reaches the backend.
    expect(mock.sent.some((m) => String(m.type).includes('follow'))).toBe(false)
  })

  it('is reachable through settings search', async () => {
    await mountGeneral(failoverState())
    await wrapper!.get('.s-search-input').setValue('pinned')
    const hit = wrapper!.findAll('.s-search-result').find((r) => r.text().includes(i18n.global.t('settings.search.item.general-account-follow-switch.title')))
    expect(hit).toBeDefined()
  })
})

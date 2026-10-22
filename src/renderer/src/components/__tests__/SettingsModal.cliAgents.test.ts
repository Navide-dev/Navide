// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import { CLI_AGENT_SPECS, cliCommandKey, cliEnvKey, cliModelKey, cliPermissionKey, parseCliEnvOverride, parseCliModelDefault } from '@navide/plugin-shell'
import { settingsGet, settingsSet } from '@navide/plugin-ui/shared'
import { __resetSettingsForTest } from '@navide/plugin-ui/shared/testing'
import SettingsModal from '../SettingsModal.vue'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import { loadCliAgentPrefsFromProject, useCliAgentPrefs } from '../../composables/useCliAgentPrefs'
import { useSettings } from '../../composables/useSettings'
import { usePushChannelPrefs } from '../../composables/usePushChannelPrefs'

type ModalProps = InstanceType<typeof SettingsModal>['$props']

describe('Settings CLI agent cards and drawer', { timeout: 15000 }, () => {
  let wrapper: VueWrapper | undefined
  let scrollTarget: HTMLElement | undefined

  beforeEach(() => {
    __resetSettingsForTest()
    loadCliAgentPrefsFromProject([], [])
    usePushChannelPrefs().pushDisabled.value = []
    scrollTarget = undefined
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function (this: HTMLElement) {
      scrollTarget = this
    })
  })

  afterEach(() => {
    wrapper?.unmount()
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  async function mountModal(
    initialTab: ModalProps['initialTab'] = 'cliAgents',
    renderSettings = false,
    binaryOverrides: Record<string, string> = {},
  ) {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', {
      deps: CLI_AGENT_SPECS.map((spec) => ({
        id: spec.agentKey, label: spec.label, group: 'agent_cli',
        status: spec.agentKey === 'codex' ? 'missing' : 'ok', version: '1.0.0',
        optional: true, can_install: true,
        binary_override: binaryOverrides[spec.agentKey] ?? '',
      })),
      models: [], model_catalog: [], complete: true,
      gate: {}, cli_health: { entries: [], findings: [], needs_attention: false },
    })
    wrapper = shallowMount(SettingsModal, {
      attachTo: document.body,
      props: {
        backend: mock.backend,
        initialTab,
        rolesApi: {} as ModalProps['rolesApi'],
        stagesApi: {} as ModalProps['stagesApi'],
        analyzerApi: {
          analyzerSettings: ref({ backend: 'ollama' }),
          health: ref(null),
          pulling: ref(false),
          pullProgress: ref(null),
          pullError: ref(''),
          models: ref([{ name: 'test-model', size: 0 }]),
          benchmarking: ref(false),
          benchmarkProgress: ref(null),
          benchmarkResults: ref([]),
        } as unknown as ModalProps['analyzerApi'],
        cliProfilesApi: {
          identityFor: () => null,
          profilesForAgent: () => [],
        } as unknown as ModalProps['cliProfilesApi'],
      },
      global: {
        plugins: [i18n],
        stubs: { Teleport: true, ...(renderSettings ? {
          SettingsSection: { template: '<section><slot /></section>' },
          SettingsCard: { template: '<div><slot /></div>' },
          SettingRow: { template: '<div><slot /><slot name="control" /></div>' },
        } : {}) },
      },
    })
    await flushPromises()
    return mock
  }

  it('keeps the native language choices on their own page and routes Japanese search there', async () => {
    const settings = useSettings()
    const previous = settings.language.value
    settings.setLanguage('en-US', { broadcast: false })
    try {
      await mountModal('appearance', true)
      const languageRow = wrapper!.get('[data-settings-section="appearance-language"]')
      expect(languageRow.isVisible()).toBe(false)
      const languageButtons = wrapper!.findAll('.ap-lang-btn')
      expect(languageButtons.map(button => button.text().replace('✓', '').trim()))
        .toEqual(['繁體中文', 'English', '日本語', '한국어 Beta', '简体中文 Beta', 'Deutsch Beta', 'Español (España) Beta'])
      // Only the new languages carry the Beta badge.
      expect(languageButtons.map(button => button.find('.scope-badge').exists()))
        .toEqual([false, false, false, true, true, true, true])
      await wrapper!.get('.s-search-input').setValue('Japanese')
      const result = wrapper!.findAll('.s-search-result').find(item => item.text().includes('Language'))!
      expect(result).toBeDefined()
      await result.trigger('click')
      expect(languageRow.isVisible()).toBe(true)
      expect(wrapper!.get('.s-search-input').element).toHaveProperty('value', '')
      for (const [index, locale] of ['zh-TW', 'en-US', 'ja-JP'].entries()) {
        await wrapper!.findAll('.ap-lang-btn')[index].trigger('click')
        expect(settings.language.value).toBe(locale)
        expect(settingsGet('agent-team:language', '')).toBe(locale)
        settings.loadLanguage({ language: 'en-US' })
        expect(settings.language.value).toBe(locale)
      }
      await wrapper!.setProps({ initialTab: 'language' })
      await wrapper!.setProps({ initialTab: 'appearance' })
      const currentLanguageRow = wrapper!.get('[data-settings-section="appearance-language"]')
      expect(currentLanguageRow.element.isConnected).toBe(true)
      expect(currentLanguageRow.isVisible()).toBe(false)
    } finally { settings.setLanguage(previous, { broadcast: false }) }
  })

  it('formats the last successful update check using the active interface locale', async () => {
    const settings = useSettings()
    const previous = settings.language.value
    const previousBridge = window.agentTeam
    const checkedAt = '2026-09-21T03:04:05Z'
    window.agentTeam = { ...previousBridge, updater: {
      onStateChanged: () => () => {},
      getState: async () => ({ status: 'idle', currentVersion: '0.2.8', checkedAt, lastCheckFailure: { count: 1, message: 'offline' } }),
    } } as unknown as typeof window.agentTeam
    try {
      settings.setLanguage('ja-JP', { broadcast: false })
      await mountModal('updates', true)
      expect(wrapper!.text()).toContain(new Date(checkedAt).toLocaleString('ja-JP'))
      settings.setLanguage('en-US', { broadcast: false })
      await wrapper!.vm.$nextTick()
      expect(wrapper!.text()).toContain(new Date(checkedAt).toLocaleString('en-US'))
    } finally { settings.setLanguage(previous, { broadcast: false }); window.agentTeam = previousBridge }
  })

  it('renders the registry as cards with no editor open initially', async () => {
    await mountModal()
    expect(wrapper!.findAll('.cli-agent-card')).toHaveLength(CLI_AGENT_SPECS.length)
    expect(wrapper!.find('.cli-agent-drawer').exists()).toBe(false)
    expect(wrapper!.get('.cli-agent-card[data-agent-key="claude"] .cli-card-status').text())
      .toContain(i18n.global.t('settings.cliAgents.chip.push', { kind: CLI_AGENT_SPECS.find((spec) => spec.agentKey === 'claude')!.pushChannel!.kind }))
    expect(wrapper!.get('.cli-agent-card[data-agent-key="codex"] .cli-card-status').text())
      .toContain(i18n.global.t('settings.cliAgents.chip.no-push'))
  })

  it('shows the custom-binary chip from the backend override, not a legacy setting', async () => {
    // The renderer no longer stores the override; a leftover value must not
    // light the chip, and the backend's pick must.
    const other = CLI_AGENT_SPECS.find((spec) => spec.agentKey !== 'claude')!.agentKey
    settingsSet(`agentTeam.cliBinary.${other}`, '/legacy/other')
    await mountModal('cliAgents', false, { claude: '/b/claude' })
    const chip = i18n.global.t('settings.cliAgents.chip.custom-binary')

    await openAgent('claude')
    expect(wrapper!.get('.cli-agent-chips').text()).toContain(chip)

    await openAgent(other)
    expect(wrapper!.get('.cli-agent-chips').text()).not.toContain(chip)
  })

  async function openAgent(key: string) {
    await wrapper!.get(`.cli-agent-card[data-agent-key="${key}"] .cli-agent-manage`).trigger('click')
    await flushPromises()
  }

  async function expectScrolledTo(section: string) {
    await vi.waitFor(() => {
      expect(scrollTarget).toBe(wrapper!.get(`[data-settings-section="${section}"]`).element)
    })
  }

  function field(labelKey: string) {
    return wrapper!.get(`.cli-agent-drawer [aria-label="${i18n.global.t(labelKey)}"]`)
  }

  it('filters cards without changing the saved order and disables reorder while filtered', async () => {
    await mountModal()
    const { order, disabled } = useCliAgentPrefs()
    const initialOrder = [...order.value]
    disabled.value = ['claude']
    await wrapper!.get('[data-cli-filter="enabled"]').trigger('click')
    expect(wrapper!.find('.cli-agent-card[data-agent-key="claude"]').exists()).toBe(false)
    expect(wrapper!.get('.cli-agent-card').attributes('draggable')).toBe('false')

    await wrapper!.get('[data-cli-filter="attention"]').trigger('click')
    expect(wrapper!.findAll('.cli-agent-card').map((card) => card.attributes('data-agent-key'))).toEqual(['codex'])

    await wrapper!.get('[data-cli-filter="all"]').trigger('click')
    await wrapper!.get('.cli-agent-filter-search').setValue('Claude')
    expect(wrapper!.findAll('.cli-agent-card').map((card) => card.attributes('data-agent-key'))).toEqual(['claude'])
    expect(order.value).toEqual(initialOrder)
    await wrapper!.get('.cli-agent-filter-search').setValue('')
    expect(wrapper!.get('.cli-agent-card').attributes('draggable')).toBe('true')
  })

  it('protects the last enabled agent while allowing another one to be enabled', async () => {
    loadCliAgentPrefsFromProject([], CLI_AGENT_SPECS.map((spec) => spec.agentKey).filter((key) => key !== 'claude'))
    await mountModal()
    const enabled = wrapper!.get('.cli-agent-card[data-agent-key="claude"] input[type="checkbox"]')
    expect(enabled.attributes('disabled')).toBeDefined()
    await wrapper!.get('.cli-agent-card[data-agent-key="codex"] input[type="checkbox"]').setValue(true)
    expect(useCliAgentPrefs().disabled.value).not.toContain('codex')
    expect(wrapper!.get('.cli-agent-card[data-agent-key="claude"] input[type="checkbox"]').attributes('disabled')).toBeUndefined()
  })

  it('persists drag reordering and rejects drag/drop while filtered', async () => {
    await mountModal()
    const keys = wrapper!.findAll('.cli-agent-card').map((card) => card.attributes('data-agent-key'))
    await wrapper!.get(`.cli-agent-card[data-agent-key="${keys[1]}"]`).trigger('dragstart')
    await wrapper!.get(`.cli-agent-card[data-agent-key="${keys[0]}"]`).trigger('dragover')
    await wrapper!.get(`.cli-agent-card[data-agent-key="${keys[0]}"]`).trigger('drop')
    expect(useCliAgentPrefs().order.value.slice(0, 2)).toEqual([keys[1], keys[0]])
    expect(JSON.parse(settingsGet('agentTeam.cliAgents.order', '[]')).slice(0, 2)).toEqual([keys[1], keys[0]])
    const savedOrder = [...useCliAgentPrefs().order.value]
    await wrapper!.get('[data-cli-filter="enabled"]').trigger('click')
    await wrapper!.get(`.cli-agent-card[data-agent-key="${keys[0]}"]`).trigger('dragstart')
    await wrapper!.get(`.cli-agent-card[data-agent-key="${keys[1]}"]`).trigger('drop')
    expect(useCliAgentPrefs().order.value).toEqual(savedOrder)
    expect(JSON.parse(settingsGet('agentTeam.cliAgents.order', '[]'))).toEqual(savedOrder)
  })

  it('places the drag handle before the card title and removes the bottom reorder controls', async () => {
    await mountModal()
    for (const card of wrapper!.findAll('.cli-agent-card')) {
      const heading = card.get('.cli-card-heading')
      expect(heading.element.firstElementChild).toBe(heading.get('.cli-agent-grip').element)
      expect(card.find('.cli-card-order').exists()).toBe(false)
      expect(card.findAll('button').map((button) => button.text())).not.toContain('↑')
      expect(card.findAll('button').map((button) => button.text())).not.toContain('↓')
    }
  })

  it('shows every agent setting section together without tabs or overview jump buttons', async () => {
    await mountModal()
    await openAgent('claude')
    const content = wrapper!.get('.cli-drawer-content')
    expect(content.findAll(':scope > section').map((section) => section.attributes('id'))).toEqual([
      'cli-panel-overview', 'cli-panel-launch', 'cli-panel-permissions', 'cli-panel-push', 'cli-panel-install',
    ])
    expect(content.findAll(':scope > section').every((section) => section.isVisible())).toBe(true)
    expect(wrapper!.find('.cli-agent-drawer [role="tablist"]').exists()).toBe(false)
    expect(wrapper!.find('.cli-overview-links').exists()).toBe(false)
  })

  it('closes the drawer before Settings on Escape and returns focus to the opening card', async () => {
    await mountModal()
    await openAgent('claude')
    expect(wrapper!.get('.cli-agent-drawer').attributes('role')).toBe('dialog')
    expect(document.activeElement).toBe(wrapper!.get('.cli-drawer-close').element)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(wrapper!.find('.cli-agent-drawer').exists()).toBe(false)
    expect(wrapper!.emitted('close')).toBeUndefined()
    expect(document.activeElement).toBe(wrapper!.get('.cli-agent-card[data-agent-key="claude"] .cli-agent-manage').element)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(wrapper!.emitted('close')).toHaveLength(1)
  })

  it('saves launch edits only to the selected agent and clears unfinished env drafts when switching', async () => {
    settingsSet(cliCommandKey('codex'), 'codex --existing')
    await mountModal()
    await openAgent('claude')
    await field('settings.cliLaunch.model-label').setValue('my-model')
    await field('settings.cliLaunch.command-label').setValue('claude --custom')
    await field('settings.cliLaunch.env-col-name').setValue('TEAM_TEST')
    await field('settings.cliLaunch.env-col-value').setValue('claude-value')
    await wrapper!.get('.env-add').trigger('click')
    expect(settingsGet(cliCommandKey('claude'), '')).toBe('claude --custom')
    expect(parseCliModelDefault(settingsGet(cliModelKey('claude'), null)).model).toBe('my-model')
    expect(parseCliEnvOverride(settingsGet(cliEnvKey('claude'), null))).toEqual([{ name: 'TEAM_TEST', value: 'claude-value' }])
    expect(settingsGet(cliCommandKey('codex'), '')).toBe('codex --existing')

    await field('settings.cliLaunch.env-col-name').setValue('UNSAVED')
    await wrapper!.get('.cli-drawer-close').trigger('click')
    await openAgent('codex')
    expect((field('settings.cliLaunch.env-col-name').element as HTMLInputElement).value).toBe('')
    expect((field('settings.cliLaunch.command-label').element as HTMLInputElement).value).toBe('codex --existing')
    expect(wrapper!.find('.env-name').exists()).toBe(false)
  })

  it('wraps keyboard focus within the visible drawer controls', async () => {
    await mountModal()
    await openAgent('claude')
    const first = wrapper!.get('.cli-drawer-close').element as HTMLButtonElement
    const last = wrapper!.get('#cli-panel-push input[type="checkbox"]').element as HTMLInputElement
    last.focus()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(first)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(last)
  })

  it('opens the last selected agent and scrolls to an externally requested section', async () => {
    await mountModal()
    await openAgent('codex')
    await wrapper!.get('.cli-drawer-close').trigger('click')
    await (wrapper!.vm as unknown as { setSection: (tab: string, section: string) => Promise<void> })
      .setSection('cliAgents', 'cli-agents-launch')
    await flushPromises()
    expect(wrapper!.get('.cli-agent-drawer').attributes('data-agent-key')).toBe('codex')
    await expectScrolledTo('cli-agents-launch')
  })

  it('opens the launch editor from Settings search even before any agent has been selected', async () => {
    await mountModal()
    await wrapper!.get('.s-search-input').setValue('launch')
    const result = wrapper!.findAll('.s-search-result').find((entry) =>
      entry.text().includes(i18n.global.t('settings.search.item.cli-agents-launch.title')),
    )
    expect(result).toBeDefined()
    await result!.trigger('click')
    await flushPromises()
    expect(wrapper!.get('.cli-agent-drawer').attributes('data-agent-key')).toBe(CLI_AGENT_SPECS[0].agentKey)
    await expectScrolledTo('cli-agents-launch')
    expect((wrapper!.get('.s-search-input').element as HTMLInputElement).value).toBe('')
  })

  it.each([
    { query: 'Copilot launch', agentKey: 'copilot', section: 'launch', order: [] },
    { query: 'Copilot launch', agentKey: 'copilot', section: 'launch', order: ['pi', 'copilot'] },
    { query: 'Codex push', agentKey: 'codex', section: 'push', order: ['claude', 'codex'] },
  ])('routes "$query" to its named agent with roster order $order', async ({ query, agentKey, section, order }) => {
    loadCliAgentPrefsFromProject(order, [])
    await mountModal()
    await wrapper!.get('.s-search-input').setValue(query)
    const result = wrapper!.findAll('.s-search-result').find((entry) =>
      entry.text().includes(i18n.global.t(`settings.search.item.cli-agents-${section}.title`)),
    )
    expect(result).toBeDefined()
    await result!.trigger('click')
    await flushPromises()
    expect(wrapper!.get('.cli-agent-drawer').attributes('data-agent-key')).toBe(agentKey)
    await expectScrolledTo(`cli-agents-${section}`)
    if (section === 'push') {
      expect(wrapper!.get('#cli-panel-push').text()).toContain(i18n.global.t('settings.cliAgents.no-push-channel'))
      expect(wrapper!.find('#cli-panel-push input[type="checkbox"]').exists()).toBe(false)
    }
  })

  it.each([
    { section: 'permissions', previousAgent: 'claude', expectedAgent: 'claude' },
    { section: 'push', previousAgent: 'codex', expectedAgent: 'claude' },
  ])('uses a capable agent for a generic $section search after selecting $previousAgent', async ({ section, previousAgent, expectedAgent }) => {
    loadCliAgentPrefsFromProject(['pi', 'copilot', 'claude'], [])
    await mountModal()
    await openAgent(previousAgent)
    await wrapper!.get('.cli-drawer-close').trigger('click')
    await wrapper!.get('.s-search-input').setValue(section)
    const result = wrapper!.findAll('.s-search-result').find((entry) =>
      entry.text().includes(i18n.global.t(`settings.search.item.cli-agents-${section}.title`)),
    )
    expect(result).toBeDefined()
    await result!.trigger('click')
    await flushPromises()
    expect(wrapper!.get('.cli-agent-drawer').attributes('data-agent-key')).toBe(expectedAgent)
    await expectScrolledTo(`cli-agents-${section}`)
  })

  it('shows unsupported capability explanations without controls that write unusable settings', async () => {
    await mountModal()
    await openAgent('aider')
    expect(wrapper!.find(`.cli-agent-drawer [aria-label="${i18n.global.t('settings.cliLaunch.model-label')}"]`).exists()).toBe(false)
    expect(wrapper!.find('#cli-panel-push input[type="checkbox"]').exists()).toBe(false)
    expect(wrapper!.get('.cli-agent-drawer').text()).not.toContain('settings.cliCards.')
  })

  it('keeps permission and push changes scoped to the selected agent', async () => {
    await mountModal()
    await openAgent('claude')
    await wrapper!.get('#cli-panel-permissions .perm-select').setValue('force-off')
    expect(settingsGet(cliPermissionKey('claude'), null)).toBe('force-off')
    expect(settingsGet(cliPermissionKey('codex'), null)).toBeNull()
    await wrapper!.get('#cli-panel-push input[type="checkbox"]').setValue(false)
    expect(settingsGet('pushChannelsDisabled', [])).toEqual(['claude'])
    await wrapper!.get('.cli-drawer-close').trigger('click')
    expect(wrapper!.get('.cli-agent-card[data-agent-key="claude"] .cli-card-status').text())
      .toContain(i18n.global.t('settings.cliAgents.chip.push-off'))
    await openAgent('qwen')
    expect((wrapper!.get('#cli-panel-push input[type="checkbox"]').element as HTMLInputElement).checked).toBe(true)
  })
})

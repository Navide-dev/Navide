// @vitest-environment happy-dom
// Settings ▸ General ▸ Experimental features ▸ "Remote container panes"
// (remoteDevcontainerExperimental): off by default, written to the settings
// store the backend reads, and reachable through settings search.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, shallowMount, type VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import { __resetSettingsForTest } from '@navide/plugin-ui/shared/testing'
import { settingsGet } from '@navide/plugin-ui/shared'
import SettingsModal from '../SettingsModal.vue'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import { REMOTE_DEVCONTAINER_KEY, setRemoteDevcontainerEnabled } from '../../composables/useRemoteDevcontainerPrefs'

type ModalProps = InstanceType<typeof SettingsModal>['$props']

describe('Settings ▸ remote container panes switch', { timeout: 15000 }, () => {
  let wrapper: VueWrapper | undefined

  beforeEach(() => {
    __resetSettingsForTest()
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {})
  })

  afterEach(() => {
    wrapper?.unmount()
    setRemoteDevcontainerEnabled(false)
    document.body.replaceChildren()
    vi.restoreAllMocks()
  })

  async function mountGeneral() {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', {
      deps: [], models: [], model_catalog: [], complete: true,
      gate: {}, cli_health: { entries: [], findings: [], needs_attention: false },
    })
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
          SettingRow: { props: ['title', 'description'], template: '<div class="row" :data-title="title"><slot /><slot name="control" /></div>' },
        },
      },
    })
    await flushPromises()
    return mock
  }

  it('is off by default and writes the key when turned on', async () => {
    await mountGeneral()
    const toggle = wrapper!.findComponent('[data-testid="remote-devcontainer-experimental"]') as VueWrapper
    expect(toggle.exists()).toBe(true)
    expect((toggle.props() as { modelValue?: boolean }).modelValue).toBe(false)
    const row = toggle.element.closest('.row') as HTMLElement
    expect(row.dataset.title).toContain(i18n.global.t('remoteDevcontainer.experimental-title'))
    toggle.vm.$emit('update:modelValue', true)
    await flushPromises()
    expect(settingsGet(REMOTE_DEVCONTAINER_KEY, false)).toBe(true)
  })

  it('is reachable through settings search', async () => {
    await mountGeneral()
    await wrapper!.get('.s-search-input').setValue('docker')
    const hit = wrapper!.findAll('.s-search-result').find((r) => r.text().includes(i18n.global.t('settings.search.item.general-experimental.title')))
    expect(hit).toBeDefined()
  })
})

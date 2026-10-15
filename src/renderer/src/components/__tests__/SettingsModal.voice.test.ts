// @vitest-environment happy-dom
// Settings ▸ Voice Input: voice input is a page of its own, not a block at the
// bottom of General, and the model row states sizes in one unit.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, shallowMount, type VueWrapper } from '@vue/test-utils'
import { ref } from 'vue'
import { i18n } from '@navide/plugin-ui/foundation'
import { __resetSettingsForTest } from '@navide/plugin-ui/shared/testing'
import SettingsModal from '../SettingsModal.vue'
import VoiceSettingsSection from '../settings/VoiceSettingsSection.vue'
import KeyboardShortcutsEditor from '../KeyboardShortcutsEditor.vue'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import { useVoiceSettings } from '../../voice/voiceSettings'
import { platformId, setPlatformId } from '../../../../shared/osplat'

type ModalProps = InstanceType<typeof SettingsModal>['$props']

// The real model file: 147,951,465 bytes, which the hint calls "about 148 MB".
const MODEL_BYTES = 147_951_465

describe('Settings ▸ Voice Input tab', { timeout: 15000 }, () => {
  let wrapper: VueWrapper | undefined

  beforeEach(() => {
    __resetSettingsForTest()
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {})
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    document.body.replaceChildren()
    vi.restoreAllMocks()
  })

  async function mountModal(initialTab: ModalProps['initialTab']) {
    const mock = createMockBackend('connected')
    mock.setResponse('onboarding.status', {
      deps: [], models: [], model_catalog: [], complete: true,
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
          analyzerSettings: ref({ backend: 'ollama' }), health: ref(null), pulling: ref(false), pullProgress: ref(null),
          pullError: ref(''), models: ref([]), benchmarking: ref(false), benchmarkProgress: ref(null), benchmarkResults: ref([]),
        } as unknown as ModalProps['analyzerApi'],
        cliProfilesApi: { identityFor: () => null, profilesForAgent: () => [] } as unknown as ModalProps['cliProfilesApi'],
      },
      global: { plugins: [i18n], stubs: { Teleport: true } },
    })
    await flushPromises()
  }

  it('renders VoiceSettingsSection in the Voice tab body', async () => {
    await mountModal('voice')
    const body = wrapper!.get('[data-settings-section="voice"]')
    expect(body.findComponent(VoiceSettingsSection).exists()).toBe(true)
    expect(body.isVisible()).toBe(true)
    // Readback lives inside VoiceSettingsSection (tested below), not as a
    // second block of the modal's own.
    expect(wrapper!.find('[data-settings-section="voice-readback"]').exists()).toBe(false)
  })

  it('renders it exactly once, and not in General', async () => {
    await mountModal('general')
    expect(wrapper!.findAllComponents(VoiceSettingsSection)).toHaveLength(1)
    const general = wrapper!.get('.appearance-body')
    expect(general.findComponent(VoiceSettingsSection).exists()).toBe(false)
  })

  it('opens Shortcuts filtered to the command the Voice tab links to, and forgets it on leaving', async () => {
    await mountModal('voice')
    const section = wrapper!.getComponent(VoiceSettingsSection)
    section.vm.$emit('open-shortcuts', 'workbench.action.holdToTalk')
    await flushPromises()
    expect(wrapper!.get('[data-settings-section="keybindings"]').isVisible()).toBe(true)
    expect(wrapper!.getComponent(KeyboardShortcutsEditor).props('initialQuery')).toBe('workbench.action.holdToTalk')

    const exposed = wrapper!.vm as unknown as { setTab: (tab: string) => void }
    exposed.setTab('voice')
    await flushPromises()
    exposed.setTab('keybindings')
    await flushPromises()
    expect(wrapper!.getComponent(KeyboardShortcutsEditor).props('initialQuery')).toBe('')
  })

  it('has a nav label in every locale', () => {
    for (const locale of ['en-US', 'ja-JP', 'zh-TW'] as const) {
      expect(i18n.global.t('settings.nav.voice', {}, { locale })).not.toBe('settings.nav.voice')
    }
    expect(i18n.global.t('settings.nav.voice', {}, { locale: 'zh-TW' })).toBe('語音輸入')
    expect(i18n.global.t('settings.nav.voice', {}, { locale: 'ja-JP' })).toBe('音声入力')
    expect(i18n.global.t('settings.nav.voice', {}, { locale: 'en-US' })).toBe('Voice Input')
  })
})

describe('VoiceSettingsSection model sizes', () => {
  let wrapper: VueWrapper | undefined

  beforeEach(() => {
    __resetSettingsForTest()
    i18n.global.locale.value = 'en-US'
    useVoiceSettings().setVoiceInputEnabled(true)
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    useVoiceSettings().setVoiceInputEnabled(false)
  })

  it('reports download progress in the decimal MB the hint uses', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('voice.status', { ok: true, sidecar: 'ok', model: { present: false }, gpu: true })
    wrapper = mount(VoiceSettingsSection, {
      props: { backend: mock.backend },
      global: { plugins: [i18n] },
    })
    await flushPromises()
    expect(wrapper.text()).toContain('about 148 MB')

    mock.emit('voice.model.progress', { bytes: 73_000_000, total: MODEL_BYTES, done: false })
    await flushPromises()
    expect(wrapper.text()).toContain('73.0 / 148.0 MB')
    expect(wrapper.text()).not.toContain('141.1')
  })

  it('states a present model in the same unit', async () => {
    const mock = createMockBackend('connected')
    mock.setResponse('voice.status', { ok: true, sidecar: 'ok', model: { present: true, bytes: MODEL_BYTES }, gpu: true })
    wrapper = mount(VoiceSettingsSection, {
      props: { backend: mock.backend },
      global: { plugins: [i18n] },
    })
    await flushPromises()
    expect(wrapper.text()).toContain('148.0 MB')
  })
})

describe('VoiceSettingsSection microphone device', () => {
  let wrapper: VueWrapper | undefined
  let media: {
    enumerateDevices: ReturnType<typeof vi.fn>
    addEventListener: ReturnType<typeof vi.fn>
    removeEventListener: ReturnType<typeof vi.fn>
    getUserMedia: ReturnType<typeof vi.fn>
  }

  const dev = (deviceId: string, label: string, kind = 'audioinput') => ({ deviceId, label, kind, groupId: 'g' })

  beforeEach(() => {
    __resetSettingsForTest()
    i18n.global.locale.value = 'en-US'
    useVoiceSettings().setVoiceInputDevice('', '')
    media = {
      enumerateDevices: vi.fn(async () => [
        dev('default', 'Default - MacBook Mic'),
        dev('communications', 'Communications'),
        dev('mac', 'MacBook Mic'),
        dev('usb', 'USB Mic'),
        dev('cam', 'FaceTime Camera', 'videoinput'),
      ]),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getUserMedia: vi.fn(),
    }
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: media })
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    useVoiceSettings().setVoiceInputEnabled(false)
    useVoiceSettings().setVoiceInputDevice('', '')
    delete (navigator as { mediaDevices?: unknown }).mediaDevices
  })

  async function mountSection() {
    const mock = createMockBackend('connected')
    mock.setResponse('voice.status', { ok: true, sidecar: 'ok', model: { present: true, bytes: MODEL_BYTES }, gpu: true })
    wrapper = mount(VoiceSettingsSection, { props: { backend: mock.backend }, global: { plugins: [i18n] } })
    await flushPromises()
    return wrapper
  }

  const optionTexts = (w: VueWrapper) => w.findAll('[data-settings-section="voice-device"] option').map((o) => o.text())

  it('voice input OFF: no device row and not a single mediaDevices call', async () => {
    useVoiceSettings().setVoiceInputEnabled(false)
    const w = await mountSection()
    expect(w.find('[data-settings-section="voice-device"]').exists()).toBe(false)
    expect(media.enumerateDevices).not.toHaveBeenCalled()
    expect(media.addEventListener).not.toHaveBeenCalled()
    expect(media.getUserMedia).not.toHaveBeenCalled()
  })

  it('voice input ON: lists audio inputs after System default, without the default/communications aliases', async () => {
    useVoiceSettings().setVoiceInputEnabled(true)
    const w = await mountSection()
    expect(optionTexts(w)).toEqual(['System default', 'MacBook Mic', 'USB Mic'])
    expect((w.get('[data-settings-section="voice-device"] select').element as HTMLSelectElement).value).toBe('')
    expect(media.addEventListener).toHaveBeenCalledWith('devicechange', expect.any(Function))
    expect(media.getUserMedia).not.toHaveBeenCalled()
  })

  it('numbers unnamed devices and says when names will appear', async () => {
    media.enumerateDevices.mockResolvedValue([dev('a', ''), dev('b', '')])
    useVoiceSettings().setVoiceInputEnabled(true)
    const w = await mountSection()
    expect(optionTexts(w)).toEqual(['System default', 'Microphone 1', 'Microphone 2'])
    expect(w.get('[data-settings-section="voice-device"]').text()).toContain('Device names appear after the first voice use')
    expect(media.getUserMedia).not.toHaveBeenCalled()
  })

  it('recording mode: hidden while off; three choices with hold-tap default; choosing one saves it', async () => {
    useVoiceSettings().setVoiceInputEnabled(false)
    const off = await mountSection()
    expect(off.find('[data-settings-section="voice-mode"]').exists()).toBe(false)
    off.unmount()

    useVoiceSettings().setVoiceInputEnabled(true)
    const w = await mountSection()
    const select = w.get('[data-settings-section="voice-mode"] select')
    expect((select.element as HTMLSelectElement).value).toBe('hold-tap')
    expect(select.findAll('option').map((o) => o.attributes('value'))).toEqual(['hold-tap', 'hold', 'toggle'])
    expect(select.findAll('option').every((o) => !o.text().startsWith('settings.'))).toBe(true)
    await select.setValue('toggle')
    expect(useVoiceSettings().voiceRecordingMode.value).toBe('toggle')
    expect(w.get('[data-settings-section="voice-mode"]').text()).toContain('again to insert the text')
    useVoiceSettings().setVoiceRecordingMode('hold-tap')
  })

  it('Chinese output: hidden while off; Traditional (Taiwan) by default; choosing one saves it', async () => {
    useVoiceSettings().setVoiceInputEnabled(false)
    const off = await mountSection()
    expect(off.find('[data-settings-section="voice-script"]').exists()).toBe(false)
    off.unmount()

    useVoiceSettings().setVoiceInputEnabled(true)
    const w = await mountSection()
    const select = w.get('[data-settings-section="voice-script"] select')
    expect((select.element as HTMLSelectElement).value).toBe('hant-tw')
    expect(select.findAll('option').map((o) => o.text())).toEqual(['Traditional (Taiwan)', 'Simplified', 'No conversion'])
    await select.setValue('none')
    expect(useVoiceSettings().voiceScript.value).toBe('none')
    useVoiceSettings().setVoiceScript('hant-tw')
  })

  it('choosing a device saves its id and label', async () => {
    useVoiceSettings().setVoiceInputEnabled(true)
    const w = await mountSection()
    await w.get('[data-settings-section="voice-device"] select').setValue('usb')
    expect(useVoiceSettings().voiceInputDeviceId.value).toBe('usb')
    expect(useVoiceSettings().voiceInputDeviceLabel.value).toBe('USB Mic')
  })

  it('a saved device that is gone shows as not connected, with the system default used', async () => {
    useVoiceSettings().setVoiceInputDevice('old', 'Studio Mic')
    useVoiceSettings().setVoiceInputEnabled(true)
    const w = await mountSection()
    const row = w.get('[data-settings-section="voice-device"]')
    const missing = row.findAll('option').at(-1)!
    expect(missing.text()).toBe('Studio Mic (not connected)')
    expect(missing.attributes('disabled')).toBeDefined()
    expect(row.text()).toContain('the system default will be used')
    expect(useVoiceSettings().voiceInputDeviceId.value).toBe('old')
  })

  it('re-finds a saved device by label when its id differs (another origin)', async () => {
    useVoiceSettings().setVoiceInputDevice('id-from-dev-origin', 'USB Mic')
    useVoiceSettings().setVoiceInputEnabled(true)
    const w = await mountSection()
    expect(useVoiceSettings().voiceInputDeviceId.value).toBe('usb')
    expect(optionTexts(w)).toEqual(['System default', 'MacBook Mic', 'USB Mic'])
    expect((w.get('[data-settings-section="voice-device"] select').element as HTMLSelectElement).value).toBe('usb')
  })

  it('re-lists on devicechange, and stops listening when turned off or unmounted', async () => {
    useVoiceSettings().setVoiceInputEnabled(true)
    const w = await mountSection()
    const handler = media.addEventListener.mock.calls[0][1] as () => void
    media.enumerateDevices.mockResolvedValue([dev('usb', 'USB Mic')])
    handler()
    await flushPromises()
    expect(optionTexts(w)).toEqual(['System default', 'USB Mic'])

    useVoiceSettings().setVoiceInputEnabled(false)
    await flushPromises()
    expect(media.removeEventListener).toHaveBeenCalledWith('devicechange', handler)

    useVoiceSettings().setVoiceInputEnabled(true)
    await flushPromises()
    expect(media.addEventListener).toHaveBeenCalledTimes(2)
    w.unmount()
    wrapper = undefined
    expect(media.removeEventListener).toHaveBeenCalledTimes(2)
  })
})

describe('VoiceSettingsSection read aloud', () => {
  let wrapper: VueWrapper | undefined
  const speak = vi.fn()
  const cancel = vi.fn()

  beforeEach(() => {
    __resetSettingsForTest()
    speak.mockReset()
    cancel.mockReset()
    vi.stubGlobal('speechSynthesis', {
      getVoices: () => [
        { name: 'Samantha', lang: 'en-US', voiceURI: 'samantha', localService: true },
        { name: 'Daniel', lang: 'en-GB', voiceURI: 'daniel', localService: true },
        { name: 'Kyoko', lang: 'ja-JP', voiceURI: 'kyoko', localService: true },
      ],
      speak,
      cancel,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
    vi.stubGlobal('SpeechSynthesisUtterance', class { text: string; lang = ''; voice: unknown = null; rate = 1; onend: unknown = null; onerror: unknown = null; constructor(t: string) { this.text = t } })
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    vi.unstubAllGlobals()
  })

  async function mountSection() {
    const mock = createMockBackend('connected')
    mock.setResponse('voice.status', { ok: true, sidecar: 'ok', model: { present: true, bytes: MODEL_BYTES }, gpu: true })
    wrapper = mount(VoiceSettingsSection, { props: { backend: mock.backend }, global: { plugins: [i18n] } })
    await flushPromises()
    return wrapper
  }

  it('is off by default: one switch, nothing spoken, no voice/rate rows', async () => {
    const w = await mountSection()
    expect(useVoiceSettings().voiceReadbackEnabled.value).toBe(false)
    const row = w.get('[data-settings-section="voice-readback"]')
    expect(row.text()).toContain('Read replies aloud')
    expect(w.find('[data-settings-section="voice-readback-voice"]').exists()).toBe(false)
    expect(w.find('[data-settings-section="voice-readback-rate"]').exists()).toBe(false)
    expect(speak).not.toHaveBeenCalled()
  })

  it('is independent of voice input', async () => {
    useVoiceSettings().setVoiceInputEnabled(false)
    useVoiceSettings().setVoiceReadbackEnabled(true)
    const w = await mountSection()
    expect(w.find('[data-settings-section="voice-readback-voice"]').exists()).toBe(true)
  })

  it('on: voices of the UI language with Auto first; choosing one and the rate saves them', async () => {
    useVoiceSettings().setVoiceReadbackEnabled(true)
    const w = await mountSection()
    const voice = w.get('[data-settings-section="voice-readback-voice"] select')
    expect(voice.findAll('option').map((o) => o.attributes('value'))).toEqual(['', 'samantha', 'daniel'])
    await voice.setValue('daniel')
    expect(useVoiceSettings().voiceReadbackVoice.value).toBe('daniel')
    const rate = w.get('[data-settings-section="voice-readback-rate"] select')
    await rate.setValue('1.2')
    expect(useVoiceSettings().voiceReadbackRate.value).toBe(1.2)
  })

  it('preview speaks a sample line with the chosen voice', async () => {
    useVoiceSettings().setVoiceReadbackEnabled(true)
    useVoiceSettings().setVoiceReadbackVoice('daniel')
    const w = await mountSection()
    await w.get('[data-settings-section="voice-readback-preview"] button').trigger('click')
    expect(speak).toHaveBeenCalledTimes(1)
    const u = speak.mock.calls[0][0] as { text: string; voice: { voiceURI: string } }
    expect(u.text).toContain('Navide')
    expect(u.voice.voiceURI).toBe('daniel')
  })

  it('no speech synthesizer (e.g. Linux without voices): the block is not shown', async () => {
    vi.unstubAllGlobals()
    vi.stubGlobal('speechSynthesis', undefined)
    const w = await mountSection()
    expect(w.find('[data-settings-section="voice-readback"]').exists()).toBe(false)
  })
})

describe('VoiceSettingsSection read aloud — voice model and engine rows', () => {
  let wrapper: VueWrapper | undefined
  let voices: Array<{ name: string; lang: string; voiceURI: string; localService: boolean }>
  const openSpoken = vi.fn(async () => ({ ok: true }))

  beforeEach(() => {
    __resetSettingsForTest()
    voices = [{ name: 'Samantha', lang: 'en-US', voiceURI: 'com.apple.voice.compact.en-US.Samantha', localService: true }]
    openSpoken.mockClear()
    vi.stubGlobal('speechSynthesis', {
      getVoices: () => voices,
      speak: vi.fn(),
      cancel: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
    vi.stubGlobal('SpeechSynthesisUtterance', class { constructor(public text: string) {} })
    vi.stubGlobal('navigator', { ...navigator, platform: 'MacIntel', userAgent: 'Macintosh' })
    ;(window as unknown as { agentTeam?: unknown }).agentTeam = { openSpokenContentSettings: openSpoken }
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    vi.unstubAllGlobals()
    delete (window as unknown as { agentTeam?: unknown }).agentTeam
  })

  async function mountSection() {
    const mock = createMockBackend('connected')
    mock.setResponse('voice.status', { ok: true, sidecar: 'ok', model: { present: true, bytes: MODEL_BYTES }, gpu: true })
    wrapper = mount(VoiceSettingsSection, { props: { backend: mock.backend }, global: { plugins: [i18n] } })
    await flushPromises()
    return wrapper
  }

  it('off: neither row is shown', async () => {
    useVoiceSettings().setVoiceReadbackEnabled(false)
    const w = await mountSection()
    expect(w.find('[data-settings-section="voice-readback-model"]').exists()).toBe(false)
    expect(w.find('[data-settings-section="voice-readback-engine"]').exists()).toBe(false)
  })

  it('preferred voice missing: Not installed, says what is used, Download opens Spoken Content with a hint', async () => {
    useVoiceSettings().setVoiceReadbackEnabled(true)
    const w = await mountSection()
    const row = w.get('[data-settings-section="voice-readback-model"]')
    expect(row.text()).toContain('Ava (Premium)')
    expect(row.text()).toContain('Not installed')
    expect(row.text()).toContain('Samantha')
    const download = row.get('[data-testid="readback-model-download"]')
    expect(download.attributes('disabled')).toBeUndefined()
    await download.trigger('click')
    await flushPromises()
    expect(openSpoken).toHaveBeenCalledTimes(1)
    expect(w.get('[data-settings-section="voice-readback-model"]').text()).toContain('Manage Voices')
  })

  it('Re-check re-reads the voices: once installed it is Ready and Download is greyed out', async () => {
    useVoiceSettings().setVoiceReadbackEnabled(true)
    const w = await mountSection()
    voices = [...voices, { name: 'Ava (Premium)', lang: 'en-US', voiceURI: 'com.apple.voice.premium.en-US.Ava', localService: true }]
    await w.get('[data-testid="readback-model-recheck"]').trigger('click')
    const row = w.get('[data-settings-section="voice-readback-model"]')
    expect(row.text()).toContain('Ready')
    expect(row.get('[data-testid="readback-model-download"]').attributes('disabled')).toBeDefined()
  })

  it('engine row: system voice ready, or no voices', async () => {
    useVoiceSettings().setVoiceReadbackEnabled(true)
    const w = await mountSection()
    expect(w.get('[data-settings-section="voice-readback-engine"]').text()).toContain('System voice · Ready')
    voices = []
    await w.get('[data-testid="readback-model-recheck"]').trigger('click')
    expect(w.get('[data-settings-section="voice-readback-engine"]').text()).toContain('No voices')
  })

  it('off macOS: no Download button, a short note instead', async () => {
    vi.stubGlobal('navigator', { ...navigator, platform: 'Win32', userAgent: 'Windows NT 10.0' })
    useVoiceSettings().setVoiceReadbackEnabled(true)
    const w = await mountSection()
    const row = w.get('[data-settings-section="voice-readback-model"]')
    expect(row.find('[data-testid="readback-model-download"]').exists()).toBe(false)
    expect(row.text()).toContain("operating system's speech settings")
  })

  describe('voice row hint names the right settings', () => {
    const BASELINE = platformId()
    afterEach(() => setPlatformId(BASELINE))

    const voiceRow = (w: VueWrapper) => w.get('[data-settings-section="voice-readback-voice"]').text()

    it('macOS points at Spoken Content', async () => {
      setPlatformId('darwin')
      useVoiceSettings().setVoiceReadbackEnabled(true)
      expect(voiceRow(await mountSection())).toContain('System Settings › Accessibility › Spoken Content')
    })

    it('Windows points at the Windows speech settings, not the macOS path', async () => {
      vi.stubGlobal('navigator', { ...navigator, platform: 'Win32', userAgent: 'Windows NT 10.0' })
      setPlatformId('win32')
      useVoiceSettings().setVoiceReadbackEnabled(true)
      const text = voiceRow(await mountSection())
      expect(text).toContain('Settings › Time & language › Speech')
      expect(text).not.toContain('Spoken Content')
    })

    it('Linux names no macOS path', async () => {
      vi.stubGlobal('navigator', { ...navigator, platform: 'Linux aarch64', userAgent: 'X11; Linux' })
      setPlatformId('linux')
      useVoiceSettings().setVoiceReadbackEnabled(true)
      const text = voiceRow(await mountSection())
      expect(text).toContain("operating system's speech settings")
      expect(text).not.toContain('Spoken Content')
    })
  })
})

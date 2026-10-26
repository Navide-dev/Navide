// @vitest-environment happy-dom
// Settings ▸ Voice Input: the Model row (a file) and the Engine row (the
// sidecar process) are separate statuses, the engine one driven by what the
// backend reports and polled only while the section is shown with voice on.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import { __resetSettingsForTest } from '@navide/plugin-ui/shared/testing'
import VoiceSettingsSection from '../settings/VoiceSettingsSection.vue'
import { createMockBackend } from '../../composables/__tests__/mockBackend'
import { useVoiceSettings } from '../../voice/voiceSettings'

const MODEL_BYTES = 147_951_465
const present = { present: true, bytes: MODEL_BYTES }

describe('VoiceSettingsSection — model and engine rows', () => {
  let wrapper: VueWrapper | undefined

  beforeEach(() => {
    vi.useFakeTimers()
    __resetSettingsForTest()
    i18n.global.locale.value = 'en-US'
    useVoiceSettings().setVoiceInputEnabled(true)
  })
  afterEach(() => {
    wrapper?.unmount()
    wrapper = undefined
    useVoiceSettings().setVoiceInputEnabled(false)
    vi.useRealTimers()
  })

  async function mountWith(status: Record<string, unknown>) {
    const mock = createMockBackend('connected')
    mock.setResponse('voice.status', { ok: true, sidecar: 'ok', model: present, gpu: null, running: false, starting: false, error: null, ...status })
    wrapper = mount(VoiceSettingsSection, { props: { backend: mock.backend }, global: { plugins: [i18n] } })
    await flushPromises()
    return mock
  }
  const model = () => wrapper!.get('[data-settings-section="voice-model"]').text()
  const engine = () => wrapper!.get('[data-settings-section="voice-engine"]').text()

  it('a downloaded model does not read as a running engine', async () => {
    await mountWith({})
    expect(model()).toContain('Ready (148.0 MB)')
    expect(model()).not.toContain('GPU')
    expect(engine()).toContain('Not running')
    expect(engine()).toContain('starts automatically when you press the shortcut')
    expect(engine()).toContain('Start Now')
  })

  it('engine states: starting, running on GPU / CPU, failed with the backend reason and Retry', async () => {
    await mountWith({ starting: true })
    expect(engine()).toContain('Starting…')
    expect(wrapper!.find('[data-settings-section="voice-engine"] button').exists()).toBe(false)
    wrapper!.unmount()
    await mountWith({ running: true, gpu: true })
    expect(engine()).toContain('Running · GPU')
    wrapper!.unmount()
    await mountWith({ running: true, gpu: false })
    expect(engine()).toContain('Running · CPU')
    wrapper!.unmount()
    await mountWith({ error: 'sidecar exited before ready (code 1)' })
    expect(engine()).toContain('Could not start: sidecar exited before ready (code 1)')
    expect(engine()).toContain('Retry')
  })

  it('without the model the engine waits for it; the model row offers Download, and Retry after a failure', async () => {
    const mock = await mountWith({ model: { present: false } })
    expect(engine()).toContain('Waiting for the speech model')
    expect(model()).toContain('Model not downloaded')
    mock.emit('voice.model.progress', { bytes: 0, total: 0, done: true, error: 'HTTP 403' })
    await flushPromises()
    expect(model()).toContain('Download failed: HTTP 403')
    expect(wrapper!.get('[data-settings-section="voice-model"]').text()).toContain('Retry Download')
  })

  it('"Start Now" sends voice.prewarm and re-reads the status', async () => {
    const mock = await mountWith({})
    mock.setResponse('voice.prewarm', { ok: true })
    await wrapper!.get('[data-settings-section="voice-engine"] button').trigger('click')
    await flushPromises()
    expect(mock.sent.map((s) => s.type)).toContain('voice.prewarm')
    expect(mock.sent.filter((s) => s.type === 'voice.status').length).toBeGreaterThanOrEqual(2)
  })

  it('a refused start shows the reason from the backend', async () => {
    const mock = await mountWith({})
    mock.setResponse('voice.prewarm', { ok: false, reason: 'sidecar-failed' })
    await wrapper!.get('[data-settings-section="voice-engine"] button').trigger('click')
    await flushPromises()
    expect(engine()).toContain('Could not start:')
    expect(engine()).toContain('Retry')
  })

  it('polls voice.status while shown and voice is on; stops when it is switched off or the section goes', async () => {
    const mock = await mountWith({})
    const count = () => mock.sent.filter((s) => s.type === 'voice.status').length
    const before = count()
    await vi.advanceTimersByTimeAsync(6_000)
    expect(count()).toBeGreaterThanOrEqual(before + 3)
    useVoiceSettings().setVoiceInputEnabled(false)
    await flushPromises()
    const off = count()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(count()).toBe(off)
    useVoiceSettings().setVoiceInputEnabled(true)
    await flushPromises()
    wrapper!.unmount()
    wrapper = undefined
    const gone = count()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(count()).toBe(gone)
  })

  it('voice OFF: nothing is sent to the backend', async () => {
    useVoiceSettings().setVoiceInputEnabled(false)
    const mock = await mountWith({})
    await vi.advanceTimersByTimeAsync(10_000)
    expect(mock.sent).toEqual([])
  })
})

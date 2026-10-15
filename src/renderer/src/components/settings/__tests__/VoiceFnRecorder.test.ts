// @vitest-environment happy-dom
// Recording fn (🌐) as the dictation key — through the native helper's events,
// since no KeyboardEvent carries fn — and the rule that no key press while
// recording goes unanswered: recorded, or a visible reason why not.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import { getUserRules, initKeybindingsPort, setUserRules } from '@navide/plugin-ui/shared'
import { __resetSettingsForTest, _resetKeybindingsState } from '@navide/plugin-ui/shared/testing'
import VoiceSettingsSection from '../VoiceSettingsSection.vue'
import KeyboardShortcutsEditor from '../../KeyboardShortcutsEditor.vue'
import { createMockBackend } from '../../../composables/__tests__/mockBackend'
import { HOLD_TO_TALK_COMMAND, useVoiceSettings } from '../../../voice/voiceSettings'
import type { FnKeyApi, FnKeyEventType, FnKeyStatus } from '../../../../../shared/fnKey'

const WHEN = 'paneStage && voiceInput && !modalOpen'
// Any ordinary command row: a modifier by itself is not a key there.
const OTHER_COMMAND = 'workbench.action.findInFiles'

let write: ReturnType<typeof vi.fn>
const wrappers: VueWrapper[] = []

function fnApi(status: FnKeyStatus) {
  let onEvent: ((e: { type: FnKeyEventType }) => void) | null = null
  let onStatus: ((s: FnKeyStatus) => void) | null = null
  const api = {
    subscribe: vi.fn(async () => status),
    unsubscribe: vi.fn(async () => {}),
    status: vi.fn(async () => status),
    requestPermission: vi.fn(async () => ({ phase: 'ready' as const, fnUsage: 0 })),
    openSettings: vi.fn(async () => ({ ok: true })),
    onEvent: vi.fn((h: (e: { type: FnKeyEventType }) => void) => {
      onEvent = h
      return () => {
        onEvent = null
      }
    }),
    onStatus: vi.fn((h: (s: FnKeyStatus) => void) => {
      onStatus = h
      return () => {
        onStatus = null
      }
    }),
  } satisfies FnKeyApi
  return {
    api,
    emit: (type: FnKeyEventType) => onEvent?.({ type }),
    push: (s: FnKeyStatus) => onStatus?.(s),
    listening: () => onEvent !== null,
  }
}

const onMac = (mac: boolean) => vi.spyOn(navigator, 'platform', 'get').mockReturnValue(mac ? 'MacIntel' : 'Win32')

function mountSection(): VueWrapper {
  const mock = createMockBackend('connected')
  mock.setResponse('voice.status', { ok: true, sidecar: 'ok', model: { present: true, bytes: 1 }, gpu: true })
  const w = mount(VoiceSettingsSection, { props: { backend: mock.backend }, attachTo: document.body, global: { plugins: [i18n] } })
  wrappers.push(w)
  return w
}

function mountEditor(): VueWrapper {
  const w = mount(KeyboardShortcutsEditor, { props: { initialQuery: HOLD_TO_TALK_COMMAND }, attachTo: document.body, global: { plugins: [i18n] } })
  wrappers.push(w)
  return w
}

function key(type: 'keydown' | 'keyup', init: KeyboardEventInit): void {
  window.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }))
}

async function startRecording(w: VueWrapper): Promise<void> {
  await w.get('[data-testid="voice-shortcut-change"]').trigger('click')
  await flushPromises()
}

const bound = () => getUserRules().filter((r) => !r.command.startsWith('-'))
const text = (w: VueWrapper, id: string) => w.get(`[data-testid="${id}"]`).text()

beforeEach(() => {
  __resetSettingsForTest()
  _resetKeybindingsState()
  i18n.global.locale.value = 'en-US'
  write = vi.fn().mockResolvedValue({ ok: true })
  initKeybindingsPort({ read: async () => ({ ok: true, content: '[]' }), write: (c) => write(c), onChanged: () => () => {} })
  useVoiceSettings().setVoiceInputEnabled(true)
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
})

afterEach(() => {
  while (wrappers.length) wrappers.pop()!.unmount()
  useVoiceSettings().setVoiceInputEnabled(false)
  useVoiceSettings().setVoiceFnKeyEnabled(false)
  initKeybindingsPort({})
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('recording fn in Settings → Voice Input → Shortcut', () => {
  it('a lone fn press, seen by the helper, records and saves "fn"', async () => {
    onMac(true)
    const fn = fnApi({ phase: 'ready', fnUsage: 0 })
    vi.stubGlobal('agentTeam', { fnKey: fn.api })
    const w = mountSection()
    expect(fn.api.subscribe).not.toHaveBeenCalled()
    await startRecording(w)
    expect(fn.api.subscribe).toHaveBeenCalledTimes(1)
    expect(text(w, 'key-recorder-listening')).toContain('fn (🌐) works too')
    fn.emit('down')
    fn.emit('up')
    await flushPromises()
    expect(w.get('.vs-recording').text()).toContain('fn 🌐')
    expect(w.find('[data-testid="voice-shortcut-warning"]').exists()).toBe(false)
    await w.get('[data-testid="voice-shortcut-save"]').trigger('click')
    await flushPromises()
    expect(bound()).toEqual([{ key: 'fn', command: HOLD_TO_TALK_COMMAND, when: WHEN }])
    expect(write).toHaveBeenCalledTimes(1)
    expect(w.get('[data-testid="voice-shortcut-keys"]').text()).toContain('fn 🌐')
    // Recording is over: the recorder's own subscription is released.
    expect(fn.api.unsubscribe).toHaveBeenCalledTimes(1)
    expect(fn.listening()).toBe(false)
  })

  it('fn + another key (fn+Delete) is not recorded as fn: the key it made is, and it is refused with the reason', async () => {
    onMac(true)
    const fn = fnApi({ phase: 'ready', fnUsage: 0 })
    vi.stubGlobal('agentTeam', { fnKey: fn.api })
    const w = mountSection()
    await startRecording(w)
    fn.emit('down')
    key('keydown', { key: 'Delete', code: 'Delete' })
    fn.emit('chord')
    await flushPromises()
    expect(w.get('.vs-recording').text()).not.toContain('fn')
    // Answered on the press, before Save.
    expect(text(w, 'voice-shortcut-warning')).toContain('types or edits in the CLI')
    expect(w.find('[data-testid="voice-shortcut-suggestions"]').exists()).toBe(true)
    await w.get('[data-testid="voice-shortcut-save"]').trigger('click')
    await flushPromises()
    expect(getUserRules()).toEqual([])
  })

  it('fn + arrow records nothing for fn either (a chord never comes back up as fn)', async () => {
    onMac(true)
    const fn = fnApi({ phase: 'ready', fnUsage: 0 })
    vi.stubGlobal('agentTeam', { fnKey: fn.api })
    const w = mountSection()
    await startRecording(w)
    fn.emit('down')
    fn.emit('chord')
    fn.emit('up')
    await flushPromises()
    expect(w.get('.vs-recording').text()).toContain('Listening')
  })

  it('a fn press while another app is in front is not recorded', async () => {
    onMac(true)
    vi.mocked(document.hasFocus).mockReturnValue(false)
    const fn = fnApi({ phase: 'ready', fnUsage: 0 })
    vi.stubGlobal('agentTeam', { fnKey: fn.api })
    const w = mountSection()
    await startRecording(w)
    fn.emit('down')
    fn.emit('up')
    await flushPromises()
    expect(w.get('.vs-recording').text()).toContain('Listening')
  })

  it('no Input Monitoring: the recorder says fn cannot be seen and offers System Settings and a re-check', async () => {
    onMac(true)
    const fn = fnApi({ phase: 'no-permission', fnUsage: null })
    vi.stubGlobal('agentTeam', { fnKey: fn.api })
    const w = mountSection()
    await startRecording(w)
    expect(text(w, 'key-recorder-fn-status')).toContain('Input Monitoring')
    await w.get('[data-testid="key-recorder-fn-open"]').trigger('click')
    expect(fn.api.openSettings).toHaveBeenCalledWith('input-monitoring')
    await w.get('[data-testid="key-recorder-fn-check"]').trigger('click')
    await flushPromises()
    expect(fn.api.requestPermission).toHaveBeenCalled()
    expect(w.find('[data-testid="key-recorder-fn-status"]').exists()).toBe(false)
  })

  it('a permission request with no answer is shown, with System Settings and a re-check', async () => {
    onMac(true)
    const fn = fnApi({ phase: 'request-failed', fnUsage: null })
    vi.stubGlobal('agentTeam', { fnKey: fn.api })
    const w = mountSection()
    await startRecording(w)
    expect(text(w, 'key-recorder-fn-status')).toContain('did not answer')
    expect(w.find('[data-testid="key-recorder-fn-check"]').exists()).toBe(true)
  })

  it('the helper losing access mid-recording is shown as it happens', async () => {
    onMac(true)
    const fn = fnApi({ phase: 'starting', fnUsage: null })
    vi.stubGlobal('agentTeam', { fnKey: fn.api })
    const w = mountSection()
    await startRecording(w)
    expect(text(w, 'key-recorder-fn-status')).toContain('Starting')
    fn.push({ phase: 'no-permission', fnUsage: null })
    await flushPromises()
    expect(text(w, 'key-recorder-fn-status')).toContain('Input Monitoring')
  })

  it('a missing helper (a checkout that never built it) says so and can be retried', async () => {
    onMac(true)
    const fn = fnApi({ phase: 'missing', fnUsage: null })
    vi.stubGlobal('agentTeam', { fnKey: fn.api })
    const w = mountSection()
    await startRecording(w)
    expect(text(w, 'key-recorder-fn-status')).toContain('pnpm build:fn-key')
    await w.get('[data-testid="key-recorder-fn-retry"]').trigger('click')
    await flushPromises()
    expect(fn.api.unsubscribe).toHaveBeenCalledTimes(1)
    expect(fn.api.subscribe).toHaveBeenCalledTimes(2)
  })

  it('off macOS: the recorder says fn cannot be detected here, and nothing is subscribed', async () => {
    onMac(false)
    const fn = fnApi({ phase: 'unsupported', fnUsage: null })
    vi.stubGlobal('agentTeam', { fnKey: fn.api })
    const w = mountSection()
    await startRecording(w)
    expect(text(w, 'key-recorder-listening')).toContain('cannot be detected on this system')
    expect(fn.api.subscribe).not.toHaveBeenCalled()
  })

  it('Esc abandons the recording and releases the helper', async () => {
    onMac(true)
    const fn = fnApi({ phase: 'ready', fnUsage: 0 })
    vi.stubGlobal('agentTeam', { fnKey: fn.api })
    const w = mountSection()
    await startRecording(w)
    key('keydown', { key: 'Escape', code: 'Escape' })
    await flushPromises()
    expect(w.find('[data-testid="key-recorder-feedback"]').exists()).toBe(false)
    expect(fn.api.unsubscribe).toHaveBeenCalledTimes(1)
  })
})

describe('no key press goes unanswered while recording', () => {
  beforeEach(() => {
    onMac(true)
    vi.stubGlobal('agentTeam', { fnKey: fnApi({ phase: 'ready', fnUsage: 0 }).api })
  })

  it('an IME composing keeps its key, and the recorder says so', async () => {
    const w = mountSection()
    await startRecording(w)
    key('keydown', { key: 'Process', code: 'KeyA', isComposing: true })
    await flushPromises()
    expect(text(w, 'key-recorder-notice')).toContain('input method')
  })

  it('a key with no usable name says it cannot be recorded', async () => {
    const w = mountSection()
    await startRecording(w)
    key('keydown', { key: 'Unidentified', code: '' })
    await flushPromises()
    expect(text(w, 'key-recorder-notice')).toContain('cannot be recorded')
  })

  it('a modifier going down says what happens next, and letting go records it', async () => {
    const w = mountSection()
    await startRecording(w)
    key('keydown', { key: 'Alt', code: 'AltRight', altKey: true })
    await flushPromises()
    expect(text(w, 'key-recorder-notice')).toContain('let go of it to use it by itself')
    key('keyup', { key: 'Alt', code: 'AltRight' })
    await flushPromises()
    expect(w.find('[data-testid="key-recorder-notice"]').exists()).toBe(false)
    expect(w.find('.vs-recording kbd').exists()).toBe(true)
  })

  it('a ⌘ combination refused in a hold mode is answered on the press', async () => {
    useVoiceSettings().setVoiceRecordingMode('hold')
    const w = mountSection()
    await startRecording(w)
    key('keydown', { key: 'j', code: 'KeyJ', metaKey: true, shiftKey: true })
    await flushPromises()
    expect(w.find('[data-testid="voice-shortcut-warning"]').exists()).toBe(true)
  })

  it('Shortcuts tab: a modifier by itself on an ordinary command row says why it is not a key', async () => {
    const editor = mountEditorFor(OTHER_COMMAND)
    await editor.get('.kse-add').trigger('click')
    key('keydown', { key: 'Alt', code: 'AltRight', altKey: true })
    await flushPromises()
    expect(text(editor, 'key-recorder-notice')).toContain('press a key to go with it')
    key('keyup', { key: 'Alt', code: 'AltRight' })
    await flushPromises()
    expect(text(editor, 'key-recorder-notice')).toContain('cannot be this command')
    // Not a hold-to-talk row: fn is not listened for.
    expect(editor.find('[data-testid="key-recorder-fn-status"]').exists()).toBe(false)
  })
})

function mountEditorFor(command: string): VueWrapper {
  const w = mount(KeyboardShortcutsEditor, { props: { initialQuery: command }, attachTo: document.body, global: { plugins: [i18n] } })
  wrappers.push(w)
  return w
}

describe('Shortcuts tab: the hold-to-talk row takes fn too', () => {
  it('records fn from the helper and binds it', async () => {
    onMac(true)
    const fn = fnApi({ phase: 'ready', fnUsage: 0 })
    vi.stubGlobal('agentTeam', { fnKey: fn.api })
    const w = mountEditor()
    const row = w.findAll('tbody tr').find((r) => r.find('.kse-id').text() === HOLD_TO_TALK_COMMAND)!
    await row.get('.kse-add').trigger('click')
    await flushPromises()
    expect(fn.api.subscribe).toHaveBeenCalledTimes(1)
    expect(text(w, 'key-recorder-listening')).toContain('fn (🌐) works too')
    fn.emit('down')
    fn.emit('up')
    await flushPromises()
    await row.get('.kse-recorder .kse-mini').trigger('click')
    await flushPromises()
    expect(bound()).toContainEqual({ key: 'fn', command: HOLD_TO_TALK_COMMAND, when: WHEN })
    expect(fn.api.unsubscribe).toHaveBeenCalledTimes(1)
  })
})

describe('the old "Use the fn (🌐) key" switch', () => {
  it('becomes fn bound next to the current key, and the switch is turned off', async () => {
    onMac(true)
    vi.stubGlobal('agentTeam', { fnKey: fnApi({ phase: 'ready', fnUsage: 0 }).api })
    useVoiceSettings().setVoiceFnKeyEnabled(true)
    const w = mountSection()
    await flushPromises()
    expect(bound()).toEqual([{ key: 'fn', command: HOLD_TO_TALK_COMMAND, when: WHEN }])
    expect(write).toHaveBeenCalledTimes(1)
    expect(useVoiceSettings().voiceFnKeyEnabled.value).toBe(false)
    const shown = w.get('[data-testid="voice-shortcut-keys"]').text()
    expect(shown).toContain('fn 🌐')
    expect(shown).toContain('M')
  })

  it('a failed write keeps the switch on (it still counts as fn bound) and says so', async () => {
    onMac(true)
    vi.stubGlobal('agentTeam', { fnKey: fnApi({ phase: 'ready', fnUsage: 0 }).api })
    write.mockResolvedValue({ ok: false, error: 'disk full' })
    useVoiceSettings().setVoiceFnKeyEnabled(true)
    const w = mountSection()
    await flushPromises()
    expect(useVoiceSettings().voiceFnKeyEnabled.value).toBe(true)
    expect(text(w, 'voice-shortcut-warning')).toContain('disk full')
  })

  it('already bound to fn: only the switch is turned off', async () => {
    onMac(true)
    vi.stubGlobal('agentTeam', { fnKey: fnApi({ phase: 'ready', fnUsage: 0 }).api })
    useVoiceSettings().setVoiceFnKeyEnabled(true)
    setUserRules([{ key: 'fn', command: HOLD_TO_TALK_COMMAND, when: WHEN }])
    mountSection()
    await flushPromises()
    expect(write).not.toHaveBeenCalled()
    expect(useVoiceSettings().voiceFnKeyEnabled.value).toBe(false)
  })
})

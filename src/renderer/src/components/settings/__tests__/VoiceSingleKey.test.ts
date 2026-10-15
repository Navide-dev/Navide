// @vitest-environment happy-dom
// Settings ▸ Voice Input: a single key as the dictation key (a function key,
// one modifier by itself), the keys it refuses, and the fn (🌐) status row.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { i18n } from '@navide/plugin-ui/foundation'
import { getUserRules, keySpecToTokens, initKeybindingsPort, setUserRules } from '@navide/plugin-ui/shared'
import { __resetSettingsForTest, _resetKeybindingsState } from '@navide/plugin-ui/shared/testing'
import VoiceSettingsSection from '../VoiceSettingsSection.vue'
import KeyboardShortcutsEditor from '../../KeyboardShortcutsEditor.vue'
import { createMockBackend } from '../../../composables/__tests__/mockBackend'
import { HOLD_TO_TALK_COMMAND, useVoiceSettings } from '../../../voice/voiceSettings'
import { fnSubscribeFailed } from '../../../voice/voiceWiring'
import type { FnKeyApi, FnKeyStatus } from '../../../../../shared/fnKey'

const WHEN = 'paneStage && voiceInput && !modalOpen'

let write: ReturnType<typeof vi.fn>
const wrappers: VueWrapper[] = []

function mountSection(): VueWrapper {
  const mock = createMockBackend('connected')
  mock.setResponse('voice.status', { ok: true, sidecar: 'ok', model: { present: true, bytes: 1 }, gpu: true })
  const w = mount(VoiceSettingsSection, { props: { backend: mock.backend }, attachTo: document.body, global: { plugins: [i18n] } })
  wrappers.push(w)
  return w
}

function key(type: 'keydown' | 'keyup', init: KeyboardEventInit): void {
  window.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }))
}

async function record(w: VueWrapper, keys: Array<['keydown' | 'keyup', KeyboardEventInit]>): Promise<void> {
  await w.get('[data-testid="voice-shortcut-change"]').trigger('click')
  for (const [type, init] of keys) key(type, init)
  await flushPromises()
  await w.get('[data-testid="voice-shortcut-save"]').trigger('click')
  await flushPromises()
}

const caps = (spec: string) => keySpecToTokens(spec).flat().join('')
const shownKeys = (w: VueWrapper) => w.get('[data-testid="voice-shortcut-keys"]').text().replace(/\s+/g, '')
const bound = () => getUserRules().filter((r) => !r.command.startsWith('-'))

beforeEach(() => {
  __resetSettingsForTest()
  _resetKeybindingsState()
  i18n.global.locale.value = 'en-US'
  write = vi.fn().mockResolvedValue({ ok: true })
  initKeybindingsPort({ read: async () => ({ ok: true, content: '[]' }), write: (c) => write(c), onChanged: () => () => {} })
  useVoiceSettings().setVoiceInputEnabled(true)
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

describe('single-key dictation shortcut', () => {
  it('accepts a function key on its own, and the Shortcuts tab shows it', async () => {
    const w = mountSection()
    await record(w, [['keydown', { key: 'F13', code: 'F13' }]])
    expect(bound()).toEqual([{ key: 'f13', command: HOLD_TO_TALK_COMMAND, when: WHEN }])
    expect(shownKeys(w)).toBe('F13')

    const editor = mount(KeyboardShortcutsEditor, { props: { initialQuery: HOLD_TO_TALK_COMMAND }, attachTo: document.body, global: { plugins: [i18n] } })
    wrappers.push(editor)
    const row = editor.findAll('tbody tr').find((r) => r.find('.kse-id').text() === HOLD_TO_TALK_COMMAND)!
    expect(row.find('.kse-chip-keys').text().replace(/\s+/g, '')).toBe('F13')
  })

  it('accepts Right Option pressed and released by itself', async () => {
    const w = mountSection()
    await record(w, [
      ['keydown', { key: 'Alt', code: 'AltRight', altKey: true }],
      ['keyup', { key: 'Alt', code: 'AltRight' }],
    ])
    expect(bound()).toEqual([{ key: 'rightalt', command: HOLD_TO_TALK_COMMAND, when: WHEN }])
    expect(shownKeys(w)).toBe(caps('rightalt').replace(/\s+/g, ''))
    expect(w.find('[data-testid="voice-shortcut-warning"]').exists()).toBe(false)
  })

  it('a modifier used in a combination records the combination, not the modifier', async () => {
    const w = mountSection()
    await record(w, [
      ['keydown', { key: 'Alt', code: 'AltRight', altKey: true }],
      ['keydown', { key: '˙', code: 'KeyH', altKey: true, ctrlKey: true }],
      ['keyup', { key: 'Alt', code: 'AltRight', ctrlKey: true }],
    ])
    expect(bound()).toEqual([{ key: 'ctrl+alt+h', command: HOLD_TO_TALK_COMMAND, when: WHEN }])
  })

  it.each([
    [{ key: 'a', code: 'KeyA' }],
    [{ key: '5', code: 'Digit5' }],
    [{ key: ' ', code: 'Space' }],
    [{ key: ',', code: 'Comma' }],
    [{ key: 'Enter', code: 'Enter' }],
    [{ key: 'Tab', code: 'Tab' }],
    [{ key: 'Backspace', code: 'Backspace' }],
    [{ key: 'A', code: 'KeyA', shiftKey: true }],
  ])('refuses a key that types (%o) and says why', async (init) => {
    const w = mountSection()
    await record(w, [['keydown', init]])
    expect(getUserRules()).toEqual([])
    expect(write).not.toHaveBeenCalled()
    expect(w.get('[data-testid="voice-shortcut-warning"]').text()).toContain('types or edits in the CLI')
  })

  it.each([
    ['MetaRight', 'rightcmd'],
    ['MetaLeft', 'leftcmd'],
  ])('accepts ⌘ (%s) pressed and released by itself, in every recording mode, and the Shortcuts tab shows it', async (code, spec) => {
    for (const mode of ['hold-tap', 'hold', 'toggle'] as const) {
      useVoiceSettings().setVoiceRecordingMode(mode)
      const w = mountSection()
      await record(w, [
        ['keydown', { key: 'Meta', code, metaKey: true }],
        ['keyup', { key: 'Meta', code }],
      ])
      expect(bound(), mode).toEqual([{ key: spec, command: HOLD_TO_TALK_COMMAND, when: WHEN }])
      expect(shownKeys(w)).toBe(caps(spec).replace(/\s+/g, ''))
      expect(w.find('[data-testid="voice-shortcut-warning"]').exists(), mode).toBe(false)
    }
    const editor = mount(KeyboardShortcutsEditor, { props: { initialQuery: HOLD_TO_TALK_COMMAND }, attachTo: document.body, global: { plugins: [i18n] } })
    wrappers.push(editor)
    const row = editor.findAll('tbody tr').find((r) => r.find('.kse-id').text() === HOLD_TO_TALK_COMMAND)!
    expect(row.find('.kse-chip-keys').text().replace(/\s+/g, '')).toBe(caps(spec).replace(/\s+/g, ''))
  })
})

describe('fn (🌐) key row', () => {
  function fnApi(status: FnKeyStatus) {
    let push: ((s: FnKeyStatus) => void) | null = null
    const api = {
      subscribe: vi.fn(async () => status),
      unsubscribe: vi.fn(async () => {}),
      status: vi.fn(async () => status),
      requestPermission: vi.fn(async () => ({ phase: 'ready' as const, fnUsage: 0 })),
      openSettings: vi.fn(async () => ({ ok: true })),
      onEvent: vi.fn(() => () => {}),
      onStatus: vi.fn((h: (s: FnKeyStatus) => void) => {
        push = h
        return () => {
          push = null
        }
      }),
    } satisfies FnKeyApi
    return { api, push: (s: FnKeyStatus) => push?.(s) }
  }
  const onMac = (mac: boolean) => vi.spyOn(navigator, 'platform', 'get').mockReturnValue(mac ? 'MacIntel' : 'Win32')

  it('is hidden off macOS', async () => {
    onMac(false)
    vi.stubGlobal('agentTeam', { fnKey: fnApi({ phase: 'off', fnUsage: null }).api })
    const w = mountSection()
    await flushPromises()
    expect(w.find('[data-settings-section="voice-fn-key"]').exists()).toBe(false)
  })

  it('on macOS: hidden until the dictation shortcut is fn, then shows the helper state', async () => {
    onMac(true)
    const fn = fnApi({ phase: 'starting', fnUsage: null })
    vi.stubGlobal('agentTeam', { fnKey: fn.api })
    const w = mountSection()
    await flushPromises()
    expect(w.find('[data-settings-section="voice-fn-key"]').exists()).toBe(false)
    expect(w.find('[data-settings-section="voice-fn-key"] [role="switch"]').exists()).toBe(false)
    setUserRules([{ key: 'fn', command: HOLD_TO_TALK_COMMAND, when: WHEN }])
    await flushPromises()
    expect(w.find('[data-settings-section="voice-fn-key"]').exists()).toBe(true)
    expect(w.get('[data-testid="voice-fn-status"]').text()).toContain('Starting')
  })

  it('a missing helper says so and offers a retry', async () => {
    onMac(true)
    const fn = fnApi({ phase: 'missing', fnUsage: null })
    vi.stubGlobal('agentTeam', { fnKey: fn.api })
    setUserRules([{ key: 'fn', command: HOLD_TO_TALK_COMMAND, when: WHEN }])
    const w = mountSection()
    await flushPromises()
    expect(w.get('[data-testid="voice-fn-status"]').text()).toContain('pnpm build:fn-key')
    expect(w.get('[data-testid="voice-fn-status"] button').text()).toBe('Try again')
  })

  it('no permission: explains and offers System Settings and a re-check', async () => {
    onMac(true)
    const fn = fnApi({ phase: 'no-permission', fnUsage: null })
    vi.stubGlobal('agentTeam', { fnKey: fn.api })
    useVoiceSettings().setVoiceFnKeyEnabled(true)
    const w = mountSection()
    await flushPromises()
    expect(w.get('[data-testid="voice-fn-status"]').text()).toContain('Input Monitoring')
    await w.get('[data-testid="voice-fn-check"]').trigger('click')
    await flushPromises()
    expect(fn.api.requestPermission).toHaveBeenCalled()
    expect(w.get('[data-testid="voice-fn-status"]').text()).toContain('ready')
  })

  it('a permission request that got no answer says so and still offers System Settings and a re-check', async () => {
    onMac(true)
    const fn = fnApi({ phase: 'request-failed', fnUsage: null })
    vi.stubGlobal('agentTeam', { fnKey: fn.api })
    setUserRules([{ key: 'fn', command: HOLD_TO_TALK_COMMAND, when: WHEN }])
    const w = mountSection()
    await flushPromises()
    expect(w.get('[data-testid="voice-fn-status"]').text()).toContain('did not answer')
    expect(w.find('[data-testid="voice-fn-check"]').exists()).toBe(true)
  })

  it('voice wiring failing to subscribe shows the helper as not running, and a retry clears it', async () => {
    onMac(true)
    const fn = fnApi({ phase: 'ready', fnUsage: 0 })
    vi.stubGlobal('agentTeam', { fnKey: fn.api })
    setUserRules([{ key: 'fn', command: HOLD_TO_TALK_COMMAND, when: WHEN }])
    fnSubscribeFailed.value = true
    try {
      const w = mountSection()
      await flushPromises()
      expect(w.get('[data-testid="voice-fn-status"]').text()).toContain('could not run')
      await w.get('[data-testid="voice-fn-status"] button').trigger('click')
      await flushPromises()
      expect(fn.api.subscribe).toHaveBeenCalled()
      expect(w.get('[data-testid="voice-fn-status"]').text()).toContain('ready')
    } finally {
      fnSubscribeFailed.value = false
    }
  })

  it('warns when macOS also acts on 🌐, and not when it is set to Do Nothing', async () => {
    onMac(true)
    const fn = fnApi({ phase: 'ready', fnUsage: 1 })
    vi.stubGlobal('agentTeam', { fnKey: fn.api })
    useVoiceSettings().setVoiceFnKeyEnabled(true)
    const w = mountSection()
    await flushPromises()
    expect(w.get('[data-testid="voice-fn-usage"]').text()).toContain('changes the input source')
    fn.push({ phase: 'ready', fnUsage: 0 })
    await flushPromises()
    expect(w.find('[data-testid="voice-fn-usage"]').exists()).toBe(false)
  })
})

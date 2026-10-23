// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { transpileModule } from 'typescript'
import { i18n, resolveAvailableUiLocale } from '@navide/plugin-ui/foundation'
import { initSettingsBackend, seedSettings, settingsGet, settingsReadiness } from '@navide/plugin-ui/shared'
import { __resetSettingsForTest } from '@navide/plugin-ui/shared/testing'
import { createMockBackend } from './mockBackend'
import { defaultHealthCheckTimeoutSec, ensureLanguageSettingsSubscription, useSettings } from '../useSettings'
import { platformId, setPlatformId, type PlatformId } from '../../../../shared/osplat'

const LANGUAGE_KEY = 'agent-team:language'

describe('useSettings — health-check timeout', () => {
  beforeEach(() => {
    // Module-level singleton — reset to a known baseline before each test.
    const { setHealthCheckTimeoutSec } = useSettings()
    setHealthCheckTimeoutSec(45)
    window.agentTeam = undefined as unknown as typeof window.agentTeam
  })

  it('defaults to 45 seconds', () => {
    const { healthCheckTimeoutSec } = useSettings()
    expect(healthCheckTimeoutSec.value).toBe(45)
  })

  it.each<[PlatformId, number]>([
    ['linux', 120],
    ['darwin', 45],
    ['win32', 120],
  ])('the %s default matches main (%is)', (platform, expected) => {
    const original = platformId()
    setPlatformId(platform)
    try {
      expect(defaultHealthCheckTimeoutSec()).toBe(expected)
    } finally {
      setPlatformId(original)
    }
  })

  it('loadHealthCheckTimeoutSec adopts the value read via IPC', async () => {
    window.agentTeam = {
      readHealthCheckTimeout: vi.fn().mockResolvedValue({ ok: true, timeoutSec: 90 }),
    } as unknown as typeof window.agentTeam
    const { loadHealthCheckTimeoutSec, healthCheckTimeoutSec } = useSettings()
    await loadHealthCheckTimeoutSec()
    expect(healthCheckTimeoutSec.value).toBe(90)
  })

  it('loadHealthCheckTimeoutSec keeps the current value when IPC is unavailable', async () => {
    const { loadHealthCheckTimeoutSec, healthCheckTimeoutSec } = useSettings()
    await loadHealthCheckTimeoutSec()
    expect(healthCheckTimeoutSec.value).toBe(45)
  })

  it('loadHealthCheckTimeoutSec keeps the current value when the read fails', async () => {
    window.agentTeam = {
      readHealthCheckTimeout: vi.fn().mockRejectedValue(new Error('ipc down')),
    } as unknown as typeof window.agentTeam
    const { loadHealthCheckTimeoutSec, healthCheckTimeoutSec } = useSettings()
    await expect(loadHealthCheckTimeoutSec()).resolves.toBeUndefined()
    expect(healthCheckTimeoutSec.value).toBe(45)
  })

  it('setHealthCheckTimeoutSec clamps below the 15s floor and persists via IPC', () => {
    const write = vi.fn().mockResolvedValue({ ok: true })
    window.agentTeam = { writeHealthCheckTimeout: write } as unknown as typeof window.agentTeam
    const { setHealthCheckTimeoutSec, healthCheckTimeoutSec } = useSettings()
    setHealthCheckTimeoutSec(5)
    expect(healthCheckTimeoutSec.value).toBe(15)
    expect(write).toHaveBeenCalledWith(15)
  })

  it('setHealthCheckTimeoutSec clamps above the 120s ceiling', () => {
    const write = vi.fn().mockResolvedValue({ ok: true })
    window.agentTeam = { writeHealthCheckTimeout: write } as unknown as typeof window.agentTeam
    const { setHealthCheckTimeoutSec, healthCheckTimeoutSec } = useSettings()
    setHealthCheckTimeoutSec(999)
    expect(healthCheckTimeoutSec.value).toBe(120)
    expect(write).toHaveBeenCalledWith(120)
  })

  it('setHealthCheckTimeoutSec rounds and accepts an in-range value', () => {
    const write = vi.fn().mockResolvedValue({ ok: true })
    window.agentTeam = { writeHealthCheckTimeout: write } as unknown as typeof window.agentTeam
    const { setHealthCheckTimeoutSec, healthCheckTimeoutSec } = useSettings()
    setHealthCheckTimeoutSec(60.4)
    expect(healthCheckTimeoutSec.value).toBe(60)
    expect(write).toHaveBeenCalledWith(60)
  })
})

describe('useSettings — language bootstrap and persistence', () => {
  beforeEach(() => {
    __resetSettingsForTest()
    ensureLanguageSettingsSubscription()
    window.agentTeam = undefined as unknown as typeof window.agentTeam
  })

  afterEach(() => {
    delete (globalThis as typeof globalThis & { __navideSettingsBootstrap?: unknown }).__navideSettingsBootstrap
    __resetSettingsForTest()
  })

  it.each(['ja-JP', '"ja-JP"'])('loads persisted Japanese %s without overwriting it with a workspace fallback', (raw) => {
    seedSettings({ [LANGUAGE_KEY]: raw })
    const settings = useSettings()
    settings.loadLanguage({ language: 'en-US' })
    expect(settings.language.value).toBe('ja-JP')
    expect(i18n.global.locale.value).toBe('ja-JP')
  })

  it('persists and broadcasts Japanese, then follows another window back to English', async () => {
    const { backend, emit, sent } = createMockBackend('connected')
    initSettingsBackend(backend)
    const broadcast = vi.fn()
    window.agentTeam = { broadcastLanguageChange: broadcast } as unknown as typeof window.agentTeam
    const settings = useSettings()
    settings.setLanguage('en-US', { broadcast: false })
    settings.setLanguage('ja-JP')
    expect(settingsGet(LANGUAGE_KEY, null)).toBe('ja-JP')
    expect(broadcast).toHaveBeenCalledWith('ja-JP')
    await vi.waitFor(() => expect(sent.some(call => call.type === 'ui.settings.set')).toBe(true))
    emit('ui.settings_changed', { settings: { [LANGUAGE_KEY]: 'en-US' } })
    expect(settings.language.value).toBe('en-US')
    expect(i18n.global.locale.value).toBe('en-US')
  })

  it('follows a Japanese system language before a preference exists', () => {
    const language = vi.spyOn(navigator, 'language', 'get').mockReturnValue('ja')
    try {
      useSettings().loadLanguage()
      expect(i18n.global.locale.value).toBe('ja-JP')
      expect(settingsGet(LANGUAGE_KEY, null)).toBeNull()
    } finally { language.mockRestore() }
  })

  it.each([
    ['ko-KR', 'ko-KR'],
    ['zh-CN', 'zh-CN'],
    ['zh-Hans', 'zh-CN'],
    ['fr-FR', 'en-US'],
    ['it-IT', 'en-US'],
    ['zh-HK', 'zh-TW'],
  ])('maps system language %s to an available locale (%s)', (system, expected) => {
    const language = vi.spyOn(navigator, 'language', 'get').mockReturnValue(system)
    try {
      useSettings().loadLanguage()
      expect(i18n.global.locale.value).toBe(expected)
      expect(settingsGet(LANGUAGE_KEY, null)).toBeNull()
    } finally { language.mockRestore() }
  })

  it('ignores a saved locale that has no catalog yet', () => {
    seedSettings({ 'agent-team:language': 'fr-FR' })
    const language = vi.spyOn(navigator, 'language', 'get').mockReturnValue('ja-JP')
    try {
      useSettings().loadLanguage()
      expect(i18n.global.locale.value).toBe('ja-JP')
    } finally { language.mockRestore() }
  })

  it('keeps <html lang> on the active locale', async () => {
    useSettings().setLanguage('ja-JP', { broadcast: false })
    await vi.waitFor(() => expect(document.documentElement.lang).toBe('ja-JP'))
    useSettings().setLanguage('zh-TW', { broadcast: false })
    await vi.waitFor(() => expect(document.documentElement.lang).toBe('zh-TW'))
  })

  it('loads language from bootstrap settings cache and sets i18n locale', () => {
    seedSettings({ 'agent-team:language': 'zh-TW' })
    const { language, loadLanguage } = useSettings()
    loadLanguage()
    expect(language.value).toBe('zh-TW')
    expect(i18n.global.locale.value).toBe('zh-TW')
  })

  it('handles JSON-encoded locale string from persisted settings', () => {
    seedSettings({ 'agent-team:language': '"zh-TW"' })
    const { language, loadLanguage } = useSettings()
    loadLanguage()
    expect(language.value).toBe('zh-TW')
    expect(i18n.global.locale.value).toBe('zh-TW')
  })

  it('setLanguage persists to settings cache and broadcasts change via IPC', () => {
    const broadcast = vi.fn()
    window.agentTeam = { broadcastLanguageChange: broadcast } as unknown as typeof window.agentTeam
    const { language, setLanguage } = useSettings()

    setLanguage('en-US')
    expect(language.value).toBe('en-US')
    expect(i18n.global.locale.value).toBe('en-US')
    expect(settingsGet('agent-team:language', null)).toBe('en-US')
    expect(broadcast).toHaveBeenCalledWith('en-US')
  })

  it('setLanguage with broadcast: false persists without calling broadcastLanguageChange', () => {
    const broadcast = vi.fn()
    window.agentTeam = { broadcastLanguageChange: broadcast } as unknown as typeof window.agentTeam
    const { language, setLanguage } = useSettings()

    setLanguage('zh-TW', { broadcast: false })
    expect(language.value).toBe('zh-TW')
    expect(i18n.global.locale.value).toBe('zh-TW')
    expect(settingsGet('agent-team:language', null)).toBe('zh-TW')
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('setLanguage ignores unsupported locales and does not broadcast', () => {
    const broadcast = vi.fn()
    window.agentTeam = { broadcastLanguageChange: broadcast } as unknown as typeof window.agentTeam
    const { language, setLanguage } = useSettings()

    setLanguage('zh-TW')
    broadcast.mockClear()

    setLanguage('it-IT')
    expect(language.value).toBe('zh-TW')
    // A recognized UI locale without a registered catalog is rejected too.
    setLanguage('fr-FR')
    expect(language.value).toBe('zh-TW')
    expect(i18n.global.locale.value).toBe('zh-TW')
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('setLanguage does not re-broadcast when locale is already current', () => {
    const broadcast = vi.fn()
    window.agentTeam = { broadcastLanguageChange: broadcast } as unknown as typeof window.agentTeam
    const { setLanguage } = useSettings()

    setLanguage('en-US')
    expect(broadcast).toHaveBeenCalledTimes(1)

    setLanguage('en-US')
    expect(broadcast).toHaveBeenCalledTimes(1)
  })

  it('first launch with no choice anywhere follows the system locale and persists nothing', () => {
    // A fresh project's backend backup is "" (never chosen). Adopting it as a
    // choice is what used to flip an English first launch to zh-TW on restart.
    const { language, loadLanguage } = useSettings()
    loadLanguage({ language: '' })
    const system = /^zh-(TW|HK|MO|Hant)/i.test(navigator.language) ? 'zh-TW' : /^ja/i.test(navigator.language) ? 'ja-JP' : 'en-US'
    expect(language.value).toBe(system)
    expect(i18n.global.locale.value).toBe(language.value)
    expect(settingsGet('agent-team:language', null)).toBeNull()
  })

  it('adopts backendFallback when settings cache is empty', () => {
    const { language, loadLanguage } = useSettings()
    loadLanguage({ language: 'en-US' })
    expect(language.value).toBe('en-US')
    expect(i18n.global.locale.value).toBe('en-US')
    expect(settingsGet('agent-team:language', null)).toBe('en-US')
  })

  it('updates language and i18n locale when settings change externally', () => {
    const { backend, emit } = createMockBackend('connected')
    initSettingsBackend(backend)
    seedSettings({ 'agent-team:language': 'zh-TW' })
    const { language, loadLanguage } = useSettings()
    loadLanguage()
    expect(language.value).toBe('zh-TW')

    emit('ui.settings_changed', { settings: { 'agent-team:language': 'en-US' } })
    expect(language.value).toBe('en-US')
    expect(i18n.global.locale.value).toBe('en-US')
  })

  it.each(['zh-TW', 'en-US', 'ja-JP', '"ja-JP"'])('executes the actual %s renderer bootstrap before root mounting', (raw) => {
    const bootstrapSettings = { [LANGUAGE_KEY]: raw }
    seedSettings(bootstrapSettings)
    const source = readFileSync(resolve('src/renderer/src/hostMount.ts'), 'utf8')
    const start = source.indexOf('const bootstrapLocaleRaw =')
    const end = source.indexOf('// Theme token layers', start)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeLessThan(source.indexOf('loadRoot()'))
    const run = new Function('bootstrapSettings', 'i18n', 'resolveAvailableUiLocale', transpileModule(source.slice(start, end), {}).outputText)
    run(bootstrapSettings, i18n, resolveAvailableUiLocale)
    const expected = raw.replaceAll('"', '')
    expect(i18n.global.locale.value).toBe(expected)
    useSettings().loadLanguage()
    expect(useSettings().language.value).toBe(expected)
    expect(settingsGet(LANGUAGE_KEY, null)).toBe(raw)
  })
})

describe('useSettings — language fallback promotion', () => {
  beforeEach(() => {
    __resetSettingsForTest()
  })

  it('promotes the workspace fallback once the store is authoritative', () => {
    const { loadLanguage, language } = useSettings()
    loadLanguage({ language: 'en-US' })
    expect(language.value).toBe('en-US')
    expect(settingsGet(LANGUAGE_KEY, null)).toBe('en-US')
  })

  it('does not promote the workspace fallback before the snapshot lands', () => {
    // An empty cache here means the snapshot is still in flight, not that the
    // user has no language. Writing the workspace's dormant backup now buries
    // the real preference permanently: a pending key beats the server value in
    // reconcile, so nothing later corrects it.
    settingsReadiness.status = 'pending'
    try {
      const { loadLanguage, language } = useSettings()
      loadLanguage({ language: 'en-US' })
      // Applied to the UI, but not written back.
      expect(language.value).toBe('en-US')
      expect(settingsGet(LANGUAGE_KEY, null)).toBeNull()
    } finally {
      settingsReadiness.status = 'ready'
    }
  })

  it('leaves an explicit change writable while the snapshot is in flight', () => {
    // setLanguage is the user acting, not a fallback being guessed — it must
    // still be recorded (the settings module holds the write until ready).
    settingsReadiness.status = 'pending'
    try {
      const { setLanguage } = useSettings()
      setLanguage('en-US')
      expect(settingsGet(LANGUAGE_KEY, null)).toBe('en-US')
    } finally {
      settingsReadiness.status = 'ready'
    }
  })
})

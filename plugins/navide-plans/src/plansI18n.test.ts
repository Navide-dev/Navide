import { createI18n } from 'vue-i18n'
import { describe, expect, it, vi } from 'vitest'
import {
  installPlansMessages,
  parsePlansLocaleFromQuery,
  extractLocaleFromSettingsEvent,
  bindPlansLocale,
  bootstrapPlansI18n,
} from './plansI18n'
import { PluginBackendError } from '@navide/plugin-sdk'
import { backendErrorMessage, KNOWN_BACKEND_ERROR_KEYS } from './backend'
import enUS from './locales/en-US.json'
import zhTW from './locales/zh-TW.json'
import jaJP from './locales/ja-JP.json'

function collectLeafKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  const keys: string[] = []
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      keys.push(...collectLeafKeys(value as Record<string, unknown>, fullKey))
    } else {
      keys.push(fullKey)
    }
  }
  return keys
}

describe('Plans i18n bootstrap', () => {
  it('renders Japanese package messages from the query and follows only Host locale updates', () => {
    const i18n = createI18n({ legacy: false, locale: 'en-US', fallbackLocale: 'zh-TW', messages: { 'en-US': enUS, 'zh-TW': zhTW, 'ja-JP': jaJP } })
    expect(bootstrapPlansI18n(i18n, '?locale=ja-JP')).toBe('ja-JP')
    expect(i18n.global.t('pane.plans.v2.no-workspace')).toBe('ワークスペースが選択されていません')
    let listener!: (payload: unknown) => void
    const dispose = bindPlansLocale(i18n, (_event, cb) => { listener = cb; return () => {} })
    listener({ source: 'plugin-storage', settings: { 'agent-team:language': 'en-US' } })
    expect(i18n.global.locale.value).toBe('ja-JP')
    listener({ source: 'host', settings: { 'agent-team:language': 'en-US' } })
    expect(i18n.global.t('pane.plans.v2.no-workspace')).toBe('No workspace selected')
    listener({ source: 'host', settings: { 'agent-team:language': 'ja-JP' } })
    expect(i18n.global.locale.value).toBe('ja-JP')
    dispose()
  })

  it('adds package-owned messages without replacing shared messages', () => {
    const i18n = createI18n({
      legacy: false,
      locale: 'en-US',
      fallbackLocale: 'zh-TW',
      messages: {
        'en-US': {
          action: { cancel: 'Cancel' },
          'ai-cli': { start: 'Start' },
          pane: { git: { title: 'SOURCE CONTROL' } },
        },
        'zh-TW': {
          action: { cancel: '取消' },
          'ai-cli': { start: '啟動' },
          pane: { git: { title: '原始碼控制' } },
        },
      },
    })

    installPlansMessages((locale, messages) => {
      i18n.global.mergeLocaleMessage(locale, messages)
    })

    expect(i18n.global.t('pane.plans.title')).toBe('Plans')
    expect(i18n.global.t('pane.git.title')).toBe('SOURCE CONTROL')
    expect(i18n.global.t('action.cancel')).toBe('Cancel')
    expect(i18n.global.t('ai-cli.start')).toBe('Start')
    i18n.global.locale.value = 'zh-TW'
    expect(i18n.global.t('pane.plans.title')).toBe('計畫')
    expect(i18n.global.t('pane.git.title')).toBe('原始碼控制')
    expect(i18n.global.t('action.cancel')).toBe('取消')
    expect(i18n.global.t('ai-cli.start')).toBe('啟動')
  })

  it('bootstraps locale from query before mount without reading localStorage', () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    let localStorageGetterAccessed = false
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        localStorageGetterAccessed = true
        throw new Error('localStorage must not be accessed during bootstrap')
      },
    })

    try {
      const i18n = createI18n({
        legacy: false,
        locale: 'en-US',
        fallbackLocale: 'zh-TW',
        messages: { 'en-US': {}, 'zh-TW': {} },
      })

      // Query contains zh-TW -> initial locale set to zh-TW
      const bootstrapZh = bootstrapPlansI18n(i18n, '?workspace_path=%2Fworkspace&locale=zh-TW&contribution=left')
      expect(bootstrapZh).toBe('zh-TW')
      expect(i18n.global.locale.value).toBe('zh-TW')

      // Query contains en-US -> initial locale set to en-US
      const bootstrapEn = bootstrapPlansI18n(i18n, '?workspace_path=%2Fworkspace&locale=en-US&contribution=window')
      expect(bootstrapEn).toBe('en-US')
      expect(i18n.global.locale.value).toBe('en-US')

      // Invalid or missing query fails closed to zh-TW
      expect(parsePlansLocaleFromQuery('?workspace_path=%2Fworkspace&locale=fr-FR')).toBe('zh-TW')
      expect(parsePlansLocaleFromQuery('?workspace_path=%2Fworkspace')).toBe('zh-TW')
      expect(parsePlansLocaleFromQuery('')).toBe('zh-TW')

      expect(localStorageGetterAccessed).toBe(false)
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(globalThis, 'localStorage', originalDescriptor)
      } else {
        // @ts-expect-error cleanup injected property
        delete globalThis.localStorage
      }
    }
  })

  it('switches mounted contribution locale in response to Host-owned ui.settings_changed event', () => {
    const i18n = createI18n({
      legacy: false,
      locale: 'en-US',
      fallbackLocale: 'zh-TW',
      messages: { 'en-US': {}, 'zh-TW': {} },
    })

    let listener: ((payload: unknown) => void) | null = null
    const unsubscribe = vi.fn()
    const subscribeMock = vi.fn((event: string, cb: (payload: unknown) => void) => {
      expect(event).toBe('ui.settings_changed')
      listener = cb
      return unsubscribe
    })

    const dispose = bindPlansLocale(i18n, subscribeMock)
    expect(subscribeMock).toHaveBeenCalledWith('ui.settings_changed', expect.any(Function))
    expect(listener).not.toBeNull()

    // Host broadcast switches locale to zh-TW
    listener!({
      source: 'host',
      settings: {
        'agent-team:language': 'zh-TW',
      },
    })
    expect(i18n.global.locale.value).toBe('zh-TW')

    // Host broadcast switches locale back to en-US
    listener!({
      source: 'host',
      settings: {
        'agent-team:language': 'en-US',
      },
    })
    expect(i18n.global.locale.value).toBe('en-US')

    // Non-Host source is ignored
    listener!({
      source: 'plugin-storage',
      settings: {
        'agent-team:language': 'zh-TW',
      },
    })
    expect(i18n.global.locale.value).toBe('en-US')

    // Missing source is ignored
    listener!({
      settings: {
        'agent-team:language': 'zh-TW',
      },
    })
    expect(i18n.global.locale.value).toBe('en-US')

    // Invalid locale value is ignored
    listener!({
      source: 'host',
      settings: {
        'agent-team:language': 'invalid-locale',
      },
    })
    expect(i18n.global.locale.value).toBe('en-US')

    // Dispose cleans up listener
    dispose()
    expect(unsubscribe).toHaveBeenCalled()
  })

  it('extracts locale safely from Host-owned settings event', () => {
    expect(extractLocaleFromSettingsEvent({
      source: 'host',
      settings: { 'agent-team:language': 'zh-TW' },
    })).toBe('zh-TW')

    expect(extractLocaleFromSettingsEvent({
      source: 'host',
      settings: { 'agent-team:language': 'en-US' },
    })).toBe('en-US')

    expect(extractLocaleFromSettingsEvent({
      source: 'plugin-storage',
      settings: { 'agent-team:language': 'zh-TW' },
    })).toBeNull()

    expect(extractLocaleFromSettingsEvent({
      settings: { 'agent-team:language': 'zh-TW' },
    })).toBeNull()

    expect(extractLocaleFromSettingsEvent({
      source: 'host',
      settings: { 'agent-team:language': 'fr-FR' },
    })).toBeNull()

    expect(extractLocaleFromSettingsEvent(null)).toBeNull()
    expect(extractLocaleFromSettingsEvent({})).toBeNull()
    expect(extractLocaleFromSettingsEvent({ source: 'host', settings: null })).toBeNull()
  })

  it('preserves translation key parity between en-US and zh-TW', () => {
    const enKeys = collectLeafKeys(enUS).sort()
    const zhKeys = collectLeafKeys(zhTW).sort()

    expect(enKeys).toEqual(zhKeys)
    expect(collectLeafKeys(jaJP).sort()).toEqual(enKeys)
    expect(enKeys.length).toBeGreaterThan(0)
  })

  it('proves real entry ordering: bootstrap applies Host locale before mount and host events update active locale', () => {
    // Replicates the entrypoint sequence from index.ts:
    // 1. bootstrapPlansI18n(i18n, search)
    // 2. bindPlansLocale(i18n, subscribeHostEvent)
    // 3. mount app
    const i18n = createI18n({
      legacy: false,
      locale: 'en-US',
      fallbackLocale: 'zh-TW',
      messages: {
        'en-US': { pane: { plans: { title: 'Plans' } } },
        'zh-TW': { pane: { plans: { title: '計畫' } } },
      },
    })

    let hostListener: ((payload: unknown) => void) | null = null
    const subscribeMock = vi.fn((event: string, cb: (payload: unknown) => void) => {
      if (event === 'ui.settings_changed') {
        hostListener = cb
      }
      return () => {}
    })

    // Step 1: Bootstrap from entry query before any component mounting
    const initialQuery = '?workspace_path=%2Fworkspace&locale=zh-TW&contribution=left'
    const bootLocale = bootstrapPlansI18n(i18n, initialQuery)
    expect(bootLocale).toBe('zh-TW')
    expect(i18n.global.locale.value).toBe('zh-TW')

    // Step 2: Bind locale listener to host events
    bindPlansLocale(i18n, subscribeMock)
    expect(subscribeMock).toHaveBeenCalledWith('ui.settings_changed', expect.any(Function))
    expect(hostListener).not.toBeNull()

    // Step 3: Before mount (or during mount), the messages and locale are fully initialized to Host locale
    expect(i18n.global.t('pane.plans.title')).toBe('計畫')

    // Step 4: Live host event switches locale from zh-TW to en-US
    hostListener!({
      source: 'host',
      settings: { 'agent-team:language': 'en-US' },
    })
    expect(i18n.global.locale.value).toBe('en-US')
    expect(i18n.global.t('pane.plans.title')).toBe('Plans')

    // Step 5: Live host event switches back to zh-TW
    hostListener!({
      source: 'host',
      settings: { 'agent-team:language': 'zh-TW' },
    })
    expect(i18n.global.locale.value).toBe('zh-TW')
    expect(i18n.global.t('pane.plans.title')).toBe('計畫')
  })
})

describe('backendErrorMessage localization', () => {
  const i18n = createI18n({
    legacy: false,
    locale: 'zh-TW',
    fallbackLocale: 'en-US',
    messages: {
      'en-US': enUS,
      'zh-TW': zhTW,
    },
  })

  it('translates all known backend error codes into zh-TW and en-US', () => {
    for (const [code, expectedKey] of Object.entries(KNOWN_BACKEND_ERROR_KEYS)) {
      const err = new PluginBackendError(code, 'Raw fallback message')

      // Test zh-TW
      i18n.global.locale.value = 'zh-TW'
      const zhMessage = backendErrorMessage(err, {
        t: (k, params) => i18n.global.t(k, params ?? {}),
        te: (k) => i18n.global.te(k),
      })
      expect(zhMessage).toBe(i18n.global.t(expectedKey))
      expect(zhMessage).not.toContain('Raw fallback message')
      expect(zhMessage).not.toBe(expectedKey)

      // Test en-US
      i18n.global.locale.value = 'en-US'
      const enMessage = backendErrorMessage(err, {
        t: (k, params) => i18n.global.t(k, params ?? {}),
        te: (k) => i18n.global.te(k),
      })
      expect(enMessage).toBe(i18n.global.t(expectedKey))
      expect(enMessage).not.toContain('Raw fallback message')
      expect(enMessage).not.toBe(expectedKey)
    }
  })

  it('translates BACKEND_ERROR to localized message', () => {
    const err = new PluginBackendError('BACKEND_ERROR', 'child plugin failure')
    i18n.global.locale.value = 'zh-TW'
    expect(
      backendErrorMessage(err, {
        t: (k, params) => i18n.global.t(k, params ?? {}),
        te: (k) => i18n.global.te(k),
      }),
    ).toBe('Navide 外掛後端執行失敗。')

    i18n.global.locale.value = 'en-US'
    expect(
      backendErrorMessage(err, {
        t: (k, params) => i18n.global.t(k, params ?? {}),
        te: (k) => i18n.global.te(k),
      }),
    ).toBe('Navide plugin backend request failed.')
  })

  it('translates BACKEND_UNAVAILABLE to localized message', () => {
    const err = new PluginBackendError('BACKEND_UNAVAILABLE', 'offline')
    i18n.global.locale.value = 'zh-TW'
    expect(
      backendErrorMessage(err, {
        t: (k, params) => i18n.global.t(k, params ?? {}),
        te: (k) => i18n.global.te(k),
      }),
    ).toBe('後端服務目前無法使用。')

    i18n.global.locale.value = 'en-US'
    expect(
      backendErrorMessage(err, {
        t: (k, params) => i18n.global.t(k, params ?? {}),
        te: (k) => i18n.global.te(k),
      }),
    ).toBe('Backend service is currently unavailable.')
  })

  it('translates unknown error code to localized generic fallback with code', () => {
    const err = new PluginBackendError('UNKNOWN_NEW_ERROR_99', 'something bad')
    i18n.global.locale.value = 'zh-TW'
    expect(
      backendErrorMessage(err, {
        t: (k, params) => i18n.global.t(k, params ?? {}),
        te: (k) => i18n.global.te(k),
      }),
    ).toBe('未知後端錯誤（UNKNOWN_NEW_ERROR_99）')

    i18n.global.locale.value = 'en-US'
    expect(
      backendErrorMessage(err, {
        t: (k, params) => i18n.global.t(k, params ?? {}),
        te: (k) => i18n.global.te(k),
      }),
    ).toBe('Unknown backend error (UNKNOWN_NEW_ERROR_99)')
  })

  it('falls back to code: message when i18n is not provided', () => {
    const err = new PluginBackendError('BACKEND_UNAVAILABLE', 'daemon not responding')
    expect(backendErrorMessage(err)).toBe('BACKEND_UNAVAILABLE: daemon not responding')
  })

  it('formats non-PluginBackendError standard Error or string', () => {
    expect(backendErrorMessage(new Error('native err'))).toBe('native err')
    expect(backendErrorMessage('plain failure')).toBe('plain failure')
  })
})

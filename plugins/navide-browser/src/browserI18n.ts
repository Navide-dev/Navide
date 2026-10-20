import enUS from './locales/en-US.json'
import zhTW from './locales/zh-TW.json'
import jaJP from './locales/ja-JP.json'

export type SupportedBrowserLocale = 'en-US' | 'zh-TW' | 'ja-JP'
export const SUPPORTED_BROWSER_LOCALES: readonly SupportedBrowserLocale[] = ['en-US', 'zh-TW', 'ja-JP'] as const

type MergeLocaleMessage = (locale: string, messages: Record<string, unknown>) => void

export function installBrowserMessages(mergeLocaleMessage: MergeLocaleMessage): void {
  mergeLocaleMessage('en-US', enUS)
  mergeLocaleMessage('zh-TW', zhTW)
  mergeLocaleMessage('ja-JP', jaJP)
}

export function resolveBrowserLocale(value: unknown): SupportedBrowserLocale {
  return value === 'zh-TW' || value === 'en-US' || value === 'ja-JP' ? value : 'zh-TW'
}

export function parseBrowserLocaleFromQuery(queryOrSearch: string): SupportedBrowserLocale {
  const search = queryOrSearch.startsWith('?') ? queryOrSearch : `?${queryOrSearch}`
  const params = new URLSearchParams(search)
  return resolveBrowserLocale(params.get('locale'))
}

export function extractLocaleFromSettingsEvent(payload: unknown): SupportedBrowserLocale | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const record = payload as Record<string, unknown>
  if (record.source !== 'host') return null
  const settings = record.settings
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return null
  const language = (settings as Record<string, unknown>)['agent-team:language']
  if (language === 'zh-TW' || language === 'en-US' || language === 'ja-JP') {
    return language
  }
  return null
}

export interface BrowserI18nTarget {
  global: {
    locale: { value: string } | string
    mergeLocaleMessage?: MergeLocaleMessage
  }
}

export function setBrowserI18nLocale(i18nInstance: BrowserI18nTarget, locale: SupportedBrowserLocale): void {
  if (typeof i18nInstance.global.locale === 'object' && i18nInstance.global.locale !== null) {
    i18nInstance.global.locale.value = locale
  } else {
    (i18nInstance.global as unknown as { locale: string }).locale = locale
  }
}

export function bindBrowserLocale(
  i18nInstance: BrowserI18nTarget,
  subscribeEvent: (type: string, listener: (payload: unknown) => void) => () => void,
): () => void {
  return subscribeEvent('ui.settings_changed', (payload) => {
    const nextLocale = extractLocaleFromSettingsEvent(payload)
    if (nextLocale) {
      setBrowserI18nLocale(i18nInstance, nextLocale)
    }
  })
}

export function bootstrapBrowserI18n(
  i18nInstance: BrowserI18nTarget,
  queryOrSearch: string,
): SupportedBrowserLocale {
  if (typeof i18nInstance.global.mergeLocaleMessage === 'function') {
    installBrowserMessages((locale, messages) => {
      i18nInstance.global.mergeLocaleMessage!(locale, messages)
    })
  }
  const locale = parseBrowserLocaleFromQuery(queryOrSearch)
  setBrowserI18nLocale(i18nInstance, locale)
  return locale
}

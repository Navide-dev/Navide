import enUS from './locales/en-US.json'
import zhTW from './locales/zh-TW.json'
import jaJP from './locales/ja-JP.json'
import koKR from './locales/ko-KR.json'
import zhCN from './locales/zh-CN.json'
import deDE from './locales/de-DE.json'
import esES from './locales/es-ES.json'
import frFR from './locales/fr-FR.json'
import { isUiLocale } from '@navide/plugin-ui/foundation'

// This plugin's catalogs. Adding a language: import its JSON above and add
// one entry here (the locale must be listed in UI_LOCALES).
const BROWSER_MESSAGES = {
  'en-US': enUS,
  'zh-TW': zhTW,
  'ja-JP': jaJP,
  'ko-KR': koKR,
  'zh-CN': zhCN,
  'de-DE': deDE,
  'es-ES': esES,
  'fr-FR': frFR,
}

export type SupportedBrowserLocale = keyof typeof BROWSER_MESSAGES
export const SUPPORTED_BROWSER_LOCALES: readonly SupportedBrowserLocale[] = Object.keys(BROWSER_MESSAGES) as SupportedBrowserLocale[]

type MergeLocaleMessage = (locale: string, messages: Record<string, unknown>) => void

export function installBrowserMessages(mergeLocaleMessage: MergeLocaleMessage): void {
  for (const locale of SUPPORTED_BROWSER_LOCALES) mergeLocaleMessage(locale, BROWSER_MESSAGES[locale])
}

function isBrowserLocale(value: unknown): value is SupportedBrowserLocale {
  return typeof value === 'string' && (SUPPORTED_BROWSER_LOCALES as readonly string[]).includes(value)
}

/**
 * A locale with a catalog here → itself; any other UI locale → en-US; a value
 * that is not a UI locale at all keeps the historical zh-TW default.
 */
export function resolveBrowserLocale(value: unknown): SupportedBrowserLocale {
  if (isBrowserLocale(value)) return value
  return isUiLocale(value) ? 'en-US' : 'zh-TW'
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
  return isUiLocale(language) ? resolveBrowserLocale(language) : null
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

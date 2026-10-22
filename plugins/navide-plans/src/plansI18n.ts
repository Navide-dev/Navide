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
const PLANS_MESSAGES = {
  'en-US': enUS,
  'zh-TW': zhTW,
  'ja-JP': jaJP,
  'ko-KR': koKR,
  'zh-CN': zhCN,
  'de-DE': deDE,
  'es-ES': esES,
  'fr-FR': frFR,
}

export type SupportedPlansLocale = keyof typeof PLANS_MESSAGES
export const SUPPORTED_PLANS_LOCALES: readonly SupportedPlansLocale[] = Object.keys(PLANS_MESSAGES) as SupportedPlansLocale[]

type MergeLocaleMessage = (locale: string, messages: Record<string, unknown>) => void

export function installPlansMessages(mergeLocaleMessage: MergeLocaleMessage): void {
  for (const locale of SUPPORTED_PLANS_LOCALES) mergeLocaleMessage(locale, PLANS_MESSAGES[locale])
}

function isPlansLocale(value: unknown): value is SupportedPlansLocale {
  return typeof value === 'string' && (SUPPORTED_PLANS_LOCALES as readonly string[]).includes(value)
}

/**
 * A locale with a catalog here → itself; any other UI locale → en-US; a value
 * that is not a UI locale at all keeps the historical zh-TW default.
 */
export function resolvePlansLocale(value: unknown): SupportedPlansLocale {
  if (isPlansLocale(value)) return value
  return isUiLocale(value) ? 'en-US' : 'zh-TW'
}

export function parsePlansLocaleFromQuery(queryOrSearch: string): SupportedPlansLocale {
  const search = queryOrSearch.startsWith('?') ? queryOrSearch : `?${queryOrSearch}`
  const params = new URLSearchParams(search)
  return resolvePlansLocale(params.get('locale'))
}

export function extractLocaleFromSettingsEvent(payload: unknown): SupportedPlansLocale | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const record = payload as Record<string, unknown>
  if (record.source !== 'host') return null
  const settings = record.settings
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) return null
  const language = (settings as Record<string, unknown>)['agent-team:language']
  return isUiLocale(language) ? resolvePlansLocale(language) : null
}

export interface PlansI18nTarget {
  global: {
    locale: { value: string } | string
    mergeLocaleMessage?: MergeLocaleMessage
  }
}

export function setPlansI18nLocale(i18nInstance: PlansI18nTarget, locale: SupportedPlansLocale): void {
  if (typeof i18nInstance.global.locale === 'object' && i18nInstance.global.locale !== null) {
    i18nInstance.global.locale.value = locale
  } else {
    (i18nInstance.global as unknown as { locale: string }).locale = locale
  }
}

export function bindPlansLocale(
  i18nInstance: PlansI18nTarget,
  subscribeEvent: (type: string, listener: (payload: unknown) => void) => () => void,
): () => void {
  return subscribeEvent('ui.settings_changed', (payload) => {
    const nextLocale = extractLocaleFromSettingsEvent(payload)
    if (nextLocale) {
      setPlansI18nLocale(i18nInstance, nextLocale)
    }
  })
}

export function bootstrapPlansI18n(
  i18nInstance: PlansI18nTarget,
  queryOrSearch: string,
): SupportedPlansLocale {
  if (typeof i18nInstance.global.mergeLocaleMessage === 'function') {
    installPlansMessages((locale, messages) => {
      i18nInstance.global.mergeLocaleMessage!(locale, messages)
    })
  }
  const locale = parsePlansLocaleFromQuery(queryOrSearch)
  setPlansI18nLocale(i18nInstance, locale)
  return locale
}

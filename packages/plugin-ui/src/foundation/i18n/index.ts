/// <reference types="vite/client" />
import { watch } from 'vue'
import { createI18n } from 'vue-i18n'
import zhTW from './locales/zh-TW.json'
import enUS from './locales/en-US.json'
import jaJP from './locales/ja-JP.json'
import koKR from './locales/ko-KR.json'
import zhCN from './locales/zh-CN.json'
import deDE from './locales/de-DE.json'
import esES from './locales/es-ES.json'
import { settingsGet } from '../../shared'
import {
  UI_LOCALE_FALLBACK,
  UI_PLURAL_RULES,
  isUiLocale,
  normalizeSystemLocale,
  resolveAvailableLocale,
  type UiLocale,
} from './uiLocales'

const LANGUAGE_KEY = 'agent-team:language'

// Adding a UI language: import its JSON above and add one entry here. The
// locale must already be listed in UI_LOCALES (./uiLocales.ts); it then shows
// up in the language pickers and in system-language detection automatically.
const messages = {
  'zh-TW': zhTW,
  'en-US': enUS,
  'ja-JP': jaJP,
  'ko-KR': koKR,
  'zh-CN': zhCN,
  'de-DE': deDE,
  'es-ES': esES,
}

/** A UI locale that has a catalog registered in this build. */
export type AvailableUiLocale = keyof typeof messages & UiLocale

/** UI locales that have a catalog registered in this build, in registration order. */
export const AVAILABLE_UI_LOCALES: readonly AvailableUiLocale[] =
  Object.keys(messages).filter(isUiLocale) as AvailableUiLocale[]

/** True for a UI locale that has a registered catalog. */
export function isAvailableUiLocale(value: unknown): value is AvailableUiLocale {
  return isUiLocale(value) && (AVAILABLE_UI_LOCALES as readonly string[]).includes(value)
}

/**
 * The locale to render for a requested value: itself when its catalog is
 * registered, en-US for a recognized locale without one, null for anything
 * that is not a UI locale at all (callers keep their current locale then).
 */
export function resolveAvailableUiLocale(value: unknown): AvailableUiLocale | null {
  if (!isUiLocale(value)) return null
  return resolveAvailableLocale(value, AVAILABLE_UI_LOCALES) as AvailableUiLocale
}

/** Detect the locale for the given OS/browser tag, limited to registered catalogs. */
export function detectUiLocale(systemLocale: string | null | undefined): AvailableUiLocale {
  return resolveAvailableLocale(normalizeSystemLocale(systemLocale), AVAILABLE_UI_LOCALES) as AvailableUiLocale
}

function getInitialLocale(): string {
  // Synchronous read from the bootstrap-seeded settings cache — available
  // before first paint, so the initial locale never flashes.
  const saved = settingsGet<string | null>(LANGUAGE_KEY, null)
  if (isAvailableUiLocale(saved)) return saved
  return detectUiLocale(typeof navigator === 'undefined' ? null : navigator.language)
}

function createInstance() {
  return createI18n({
    legacy: false,
    locale: getInitialLocale(),
    fallbackLocale: UI_LOCALE_FALLBACK,
    pluralRules: UI_PLURAL_RULES,
    messages,
  })
}

// Vite HMR re-runs this module whenever a locale file is edited. A second
// createI18n() would leave the app rendering through the instance main.ts
// installed while later importers (useSettings) switch the locale on the new
// one, so picking a language would stop reaching the screen. Keep the
// installed instance across reloads and only swap in the edited messages.
const hotData = import.meta.hot?.data as { i18n?: unknown; langWatch?: boolean } | undefined
export const i18n: ReturnType<typeof createInstance> =
  (hotData?.i18n as ReturnType<typeof createInstance> | undefined) ?? createInstance()
if (hotData) {
  hotData.i18n = i18n
  for (const [locale, bundle] of Object.entries(messages)) i18n.global.setLocaleMessage(locale, bundle)
}

// Keep <html lang> on the active locale so the browser picks CJK glyphs for
// the right script (zh-CN vs zh-TW vs ja-JP) and :lang() font stacks apply.
if (!hotData?.langWatch && typeof document !== 'undefined') {
  watch(
    () => i18n.global.locale.value,
    (locale) => { document.documentElement.lang = locale },
    { immediate: true },
  )
  if (hotData) hotData.langWatch = true
}

export { default as enUSMessages } from './locales/en-US.json'
export { default as zhTWMessages } from './locales/zh-TW.json'
export { default as jaJPMessages } from './locales/ja-JP.json'

export {
  BETA_UI_LOCALES,
  UI_LOCALES,
  UI_LOCALE_FALLBACK,
  UI_PLURAL_RULES,
  formatList,
  isBetaUiLocale,
  isSingular,
  isUiLocale,
  normalizeSystemLocale,
  pluralCategory,
  resolveAvailableLocale,
} from './uiLocales'
export type { UiLocale } from './uiLocales'

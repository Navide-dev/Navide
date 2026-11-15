// The Git plugin's own UI strings, merged into the shared @navide/plugin-ui i18n
// instance when this module is first imported. packages/plugin-ui keeps only
// the strings its own components use, so a Host-only string change touches
// no plugin (see scripts/official-plugin-fingerprints.mjs).
import { i18n } from '@navide/plugin-ui/foundation'
import enUS from './locales/en-US.json'
import zhTW from './locales/zh-TW.json'
import jaJP from './locales/ja-JP.json'
import koKR from './locales/ko-KR.json'
import zhCN from './locales/zh-CN.json'
import deDE from './locales/de-DE.json'
import esES from './locales/es-ES.json'
import frFR from './locales/fr-FR.json'
import ptBR from './locales/pt-BR.json'
import ruRU from './locales/ru-RU.json'
import viVN from './locales/vi-VN.json'

// Adding a language: import its JSON above and add one entry here (the locale
// must be listed in UI_LOCALES).
const GIT_MESSAGES = {
  'en-US': enUS,
  'zh-TW': zhTW,
  'ja-JP': jaJP,
  'ko-KR': koKR,
  'zh-CN': zhCN,
  'de-DE': deDE,
  'es-ES': esES,
  'fr-FR': frFR,
  'pt-BR': ptBR,
  'ru-RU': ruRU,
  'vi-VN': viVN,
}

for (const [locale, messages] of Object.entries(GIT_MESSAGES)) {
  i18n.global.mergeLocaleMessage(locale, messages)
}

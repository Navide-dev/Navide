import { hostStrings, type HostStringTable, type SupportedLocale } from './hostLocale'

/**
 * The main-process dialog shown when the user (or a plugin button) asks for a
 * built-in Navide plugin they disabled. Main has no i18n of its own (see
 * menuStrings.ts); the wording follows the renderer's
 * settings.extensions.builtinDisabledTooltip and the glossary.
 */
const STRINGS: HostStringTable<{ title: string; message: (name: string) => string }> = {
  'en-US': {
    title: 'Navide plugin disabled',
    message: (name) => `Navide plugin ${name} is disabled. Enable it in Settings → Extensions.`,
  },
  'zh-TW': {
    title: 'Navide 外掛已停用',
    message: (name) => `Navide 外掛 ${name} 已停用，請在「設定 → 擴充」重新啟用。`,
  },
  'ja-JP': {
    title: 'Navide プラグインは無効です',
    message: (name) => `Navide プラグイン ${name} は無効です。「設定 → 拡張機能」で有効にしてください。`,
  },
}

export function builtinPluginDisabledDialog(
  locale: SupportedLocale,
  name: string,
): { title: string; message: string } {
  const strings = hostStrings(STRINGS, locale)
  return { title: strings.title, message: strings.message(name) }
}

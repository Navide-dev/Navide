import { getLocales } from 'expo-localization'
import enUS from './locales/en-US.json'
import zhTW from './locales/zh-TW.json'
import paneStatus from './generated/paneStatus.json'

type Catalog = Record<string, unknown>
const CATALOGS: Record<string, Catalog> = { 'en-US': enUS, 'zh-TW': zhTW }
const STATUS = paneStatus as Record<string, Record<string, string>>
const FALLBACK = 'en-US'

function pickLocale(): string {
  for (const l of getLocales()) {
    const tag = l.languageTag
    if (CATALOGS[tag] || STATUS[tag]) return tag
    // zh-Hant-TW / zh-Hant → zh-TW; zh-Hans → zh-CN
    if (l.languageCode === 'zh') return l.languageScriptCode === 'Hans' ? 'zh-CN' : 'zh-TW'
    const byLang = Object.keys(STATUS).find((k) => k.startsWith(`${l.languageCode}-`))
    if (byLang) return byLang
  }
  return FALLBACK
}

export const locale = pickLocale()

function lookup(catalog: Catalog | undefined, key: string): string | undefined {
  let node: unknown = catalog
  for (const part of key.split('.')) {
    if (!node || typeof node !== 'object') return undefined
    node = (node as Catalog)[part]
  }
  return typeof node === 'string' ? node : undefined
}

/** Same `{name}` placeholder syntax as the desktop catalogs. */
export function t(key: string, params: Record<string, string> = {}): string {
  const text = lookup(CATALOGS[locale], key) ?? lookup(CATALOGS[FALLBACK], key) ?? key
  return text.replace(/\{(\w+)\}/g, (m, name: string) => params[name] ?? m)
}

/** The desktop's own word for a pane status, in the user's language. */
export function statusLabel(status: string): string {
  return STATUS[locale]?.[status] ?? STATUS[FALLBACK]?.[status] ?? status
}

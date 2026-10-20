// Single source of truth for the UI languages Navide knows about.
//
// Pure TypeScript (no Vue, no DOM) so the Electron main process can import it
// by relative path, the same way it reaches packages/plugin-contracts.
//
// A locale listed here is *recognized*; it is only *shown* once a catalog for
// it is registered (see AVAILABLE_UI_LOCALES in ./index.ts). Detection results
// always pass through resolveAvailableLocale() so a recognized locale without
// a catalog lands on en-US instead of an empty UI.

export const UI_LOCALES = [
  'en-US',
  'zh-TW',
  'ja-JP',
  'zh-CN',
  'ko-KR',
  'es-ES',
  'fr-FR',
  'de-DE',
  'pt-BR',
  'ru-RU',
  'vi-VN',
] as const

export type UiLocale = (typeof UI_LOCALES)[number]

/** Locales whose translations are machine-generated and await native review. */
export const BETA_UI_LOCALES: readonly UiLocale[] = [
  'zh-CN',
  'ko-KR',
  'es-ES',
  'fr-FR',
  'de-DE',
  'pt-BR',
  'ru-RU',
  'vi-VN',
] as const

const UI_LOCALE_SET: ReadonlySet<string> = new Set(UI_LOCALES)
const BETA_UI_LOCALE_SET: ReadonlySet<string> = new Set(BETA_UI_LOCALES)

export function isUiLocale(value: unknown): value is UiLocale {
  return typeof value === 'string' && UI_LOCALE_SET.has(value)
}

export function isBetaUiLocale(value: unknown): boolean {
  return typeof value === 'string' && BETA_UI_LOCALE_SET.has(value)
}

/**
 * Map an OS/browser language tag to a UI locale. Order matters: the
 * Traditional Chinese regions are checked before the Simplified ones so a
 * bare `zh` lands on Simplified Chinese while zh-HK/zh-MO stay Traditional.
 * Anything unrecognized (or empty) becomes en-US.
 */
export function normalizeSystemLocale(raw: string | null | undefined): UiLocale {
  if (typeof raw !== 'string') return 'en-US'
  const tag = raw.trim().replace(/_/g, '-')
  if (!tag) return 'en-US'
  if (/^zh-(TW|HK|MO|Hant)(-|$)/i.test(tag)) return 'zh-TW'
  if (/^zh(-|$)/i.test(tag)) return 'zh-CN'
  if (/^en(-|$)/i.test(tag)) return 'en-US'
  if (/^ja(-|$)/i.test(tag)) return 'ja-JP'
  if (/^ko(-|$)/i.test(tag)) return 'ko-KR'
  if (/^es(-|$)/i.test(tag)) return 'es-ES'
  if (/^fr(-|$)/i.test(tag)) return 'fr-FR'
  if (/^de(-|$)/i.test(tag)) return 'de-DE'
  if (/^pt(-|$)/i.test(tag)) return 'pt-BR'
  if (/^ru(-|$)/i.test(tag)) return 'ru-RU'
  if (/^vi(-|$)/i.test(tag)) return 'vi-VN'
  return 'en-US'
}

/** Return `locale` when a catalog exists for it, otherwise en-US. */
export function resolveAvailableLocale(locale: string, available: readonly string[]): string {
  return available.includes(locale) ? locale : 'en-US'
}

/**
 * vue-i18n `fallbackLocale` (object form). New locales fall back to en-US;
 * en-US, zh-TW and ja-JP keep the historical global fallback of zh-TW.
 *
 * vue-i18n (@intlify/core-base fallbackWithLocaleChain) always appends the
 * `default` block at the end of every chain, so ko-KR resolves as
 * ko-KR → en-US → en → zh-TW → zh. zh-TW is reached only for a key the en-US
 * catalog also lacks, which is exactly what an en-US user sees today.
 */
export const UI_LOCALE_FALLBACK: Record<string, string[]> = {
  ...Object.fromEntries(BETA_UI_LOCALES.map((locale) => [locale, ['en-US']])),
  default: ['zh-TW'],
}

type PluralRule = (choice: number, choicesLength: number, orgRule?: PluralRule) => number

const pluralRulesCache = new Map<string, Intl.PluralRules>()
function pluralCategory(locale: string, n: number): Intl.LDMLPluralRule {
  let rules = pluralRulesCache.get(locale)
  if (!rules) {
    rules = new Intl.PluralRules(locale)
    pluralRulesCache.set(locale, rules)
  }
  return rules.select(n)
}

// Mirrors vue-i18n's built-in rule, used when a message's form count is not
// one the locale-specific rule understands.
function defaultPluralIndex(choice: number, choicesLength: number): number {
  const n = Math.abs(choice)
  if (choicesLength === 2) return n === 1 ? 0 : 1
  return Math.min(n, 2)
}

/**
 * Russian pipe-form convention:
 *   - an en-US message with 2 forms (`one | other`) is translated with 3 forms
 *     `one | few | many`  (1 файл | 2 файла | 5 файлов);
 *   - an en-US message with 3 forms (`zero | one | other`) is translated with
 *     4 forms `zero | one | few | many`.
 * Fractions (CLDR "other") use the `few` form.
 */
function russianPluralIndex(choice: number, choicesLength: number): number {
  const n = Math.abs(choice)
  const category = pluralCategory('ru-RU', n)
  const index = category === 'one' ? 0 : category === 'many' ? 2 : 1
  if (choicesLength === 3) return index
  if (choicesLength === 4) return n === 0 ? 0 : index + 1
  return defaultPluralIndex(choice, choicesLength)
}

/**
 * French and Brazilian Portuguese treat 0 as singular (CLDR "one" covers 0
 * and 1), unlike vue-i18n's English-shaped default for 2-form messages.
 */
function zeroIsSingularPluralIndex(locale: string): PluralRule {
  return (choice, choicesLength) => {
    if (choicesLength !== 2) return defaultPluralIndex(choice, choicesLength)
    return pluralCategory(locale, Math.abs(choice)) === 'one' ? 0 : 1
  }
}

/** vue-i18n `pluralRules` for locales whose CLDR rules differ from its default. */
export const UI_PLURAL_RULES: Record<string, PluralRule> = {
  'ru-RU': russianPluralIndex,
  'fr-FR': zeroIsSingularPluralIndex('fr-FR'),
  'pt-BR': zeroIsSingularPluralIndex('pt-BR'),
}

/** Join items with the locale's list conventions (Intl.ListFormat). */
export function formatList(
  items: readonly string[],
  locale: string,
  type: 'conjunction' | 'disjunction' | 'unit' = 'conjunction',
): string {
  try {
    return new Intl.ListFormat(locale, { style: 'long', type }).format(items)
  } catch {
    return items.join(', ')
  }
}

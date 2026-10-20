import { formatList } from '@navide/plugin-ui/foundation'
import type { ManifestDisclosure } from '../../../shared/pluginDisclosure'

type Translate = (key: string, values?: Record<string, unknown>) => string

/** A list in the reader's language. en-US, zh-TW and ja-JP keep their
 *  established "a, b" / "a、b" joins; every other locale uses Intl.ListFormat. */
export function disclosureList(locale: string, values: unknown): string {
  const items = Array.isArray(values) ? values.map(String) : []
  if (locale === 'en-US') return items.join(', ')
  if (locale === 'zh-TW' || locale === 'ja-JP') return items.join('、')
  return formatList(items, locale)
}

/** The summary clauses of a disclosure (contract 3.2), each worded from its
 *  i18n template, never from text the publisher wrote. */
export function disclosureClauses(t: Translate, locale: string, disclosure: ManifestDisclosure): string[] {
  return disclosure.summary.clauses.map((clause) => {
    const p = clause.params as Record<string, unknown>
    if (clause.key === 'files') return t(`pluginDisclosure.summary.files.${String(p.access)}`)
    if (clause.key === 'shell') {
      return t(`pluginDisclosure.summary.shell.${String(p.mode)}`, { executables: disclosureList(locale, p.executables) })
    }
    if (clause.key === 'agentTools') return t('pluginDisclosure.summary.agentTools', p)
    return t(`pluginDisclosure.summary.${clause.key}`)
  })
}

/** The one-line plain summary every card opens with (D1, D5). */
export function disclosureSummaryLine(t: Translate, locale: string, disclosure: ManifestDisclosure): string {
  return disclosureClauses(t, locale, disclosure).join(/^(zh|ja)(-|$)/i.test(locale) ? '；' : '; ')
}

import { i18n } from '@navide/plugin-ui/foundation'

// User-facing words for convenience features (docs/en-US/convenience-features.md).
// The backend sends registry ids only; every name, benefit and cost lives in
// the locale files under `convenience.feature.<key>`, where the key is the id
// with dots replaced (vue-i18n reads dots as nesting).

export type ConvenienceTextPart = 'name' | 'benefit' | 'purpose' | 'writes' | 'cost'

export function convenienceFeatureKey(id: string): string {
  return id.replace(/\./g, '_')
}

/** A feature's localized text. An id this build does not know (a newer
 *  backend) shows its raw id as the name and nothing for the other parts,
 *  rather than a vue-i18n key path. */
export function convenienceText(id: string, part: ConvenienceTextPart): string {
  const key = `convenience.feature.${convenienceFeatureKey(id)}.${part}`
  if (i18n.global.te(key)) return i18n.global.t(key)
  return part === 'name' ? id : ''
}

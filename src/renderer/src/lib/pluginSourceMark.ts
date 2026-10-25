import type { PluginSource } from '../../../shared/pluginSource'
import { revealInvisibleText as reveal } from '../../../shared/pluginAgentTools'

/** The badge text of a source. A test build prints its expiry as YYYY-MM-DD,
 *  or says the expiry is unknown when the Host sent none. Its review depends
 *  on how the user joined the test (`via`): an invite build had the automated
 *  scan only; a public test code had a light human review of the code, never
 *  of this version. Past its expiry it says so (the user kept it, D3). */
export function pluginSourceLabel(
  t: (key: string, params?: Record<string, unknown>) => string,
  source: PluginSource,
  expiresAt?: string | null,
  via?: 'invite' | 'code' | null,
  now: number = Date.now()
): string {
  const date = (expiresAt ?? '').slice(0, 10)
  if (source !== 'testplace') return t(`pluginDisclosure.source.${source}`, { date })
  if (!date) return t('pluginDisclosure.source.testplaceNoExpiry')
  if (isTestplaceExpired(expiresAt, now)) return t('pluginDisclosure.source.testplaceExpired', { date })
  if (via === 'invite') return t('pluginDisclosure.source.testplaceInvite', { date })
  if (via === 'code') return t('pluginDisclosure.source.testplaceCode', { date })
  return t('pluginDisclosure.source.testplace', { date })
}

/** True once a test build's signed expiry has passed. */
export function isTestplaceExpired(expiresAt: string | null | undefined, now: number = Date.now()): boolean {
  const at = expiresAt ? Date.parse(expiresAt) : NaN
  return Number.isFinite(at) && at <= now
}

/** Whole days left before a test build expires, when that is 7 or fewer (D3: remind from 7 days). */
export function testplaceDaysLeft(expiresAt: string | null | undefined, now: number = Date.now()): number | null {
  const at = expiresAt ? Date.parse(expiresAt) : NaN
  if (!Number.isFinite(at) || at <= now) return null
  const days = Math.ceil((at - now) / 86_400_000)
  return days <= 7 ? days : null
}

/** Sources that keep a mark in the renderer chrome around a plugin view (DX
 *  report §10.4/§10.5): anything that is neither a reviewed Marketplace stable
 *  release nor shipped with Navide. The mark sits outside the guest, so the
 *  plugin's own content cannot cover or imitate it. */
export function chromeSourceMark(source: PluginSource | undefined): PluginSource | null {
  return source && source !== 'marketplace' && source !== 'factory-bundled' ? source : null
}

/** Sources whose publisher id nothing vouches for, as in PluginSourceBadge. */
const SELF_DECLARED: readonly PluginSource[] = ['local-unsigned', 'developer-unpacked']

export interface PluginDisclosureSubject {
  title: string
  pluginId: string
  source?: PluginSource
  expiresAt?: string | null
  testplaceVia?: 'invite' | 'code' | null
}

/** Disclosure for a plugin control in Navide's chrome: its title alone is the
 *  plugin's to choose, so the hover text and accessible name also say it is a
 *  Navide plugin and give its id, publisher and, when the package has one, its
 *  source. A publisher read off an unsigned or unknown package is only
 *  self-declared. */
export function pluginDisclosureTitle(
  t: (key: string, params?: Record<string, unknown>) => string,
  subject: PluginDisclosureSubject
): string {
  const publisher = reveal(subject.pluginId.split('.')[0])
  const parts = [
    t('stageTab.plugin-tab', { title: reveal(subject.title) }),
    reveal(subject.pluginId),
    t('pluginDisclosure.source.publisher', {
      publisher: !subject.source || SELF_DECLARED.includes(subject.source)
        ? t('pluginDisclosure.source.selfDeclared', { publisher })
        : publisher,
    }),
  ]
  if (subject.source) parts.push(pluginSourceLabel(t, subject.source, subject.expiresAt, subject.testplaceVia))
  return parts.join(' · ')
}

const SKIPPED_LEADING = /^[\p{Z}\p{Cc}\p{Cf}]+/u
const LATIN = /\p{Script=Latin}/u

/** What an icon-less plugin button shows: the first user-perceived character
 *  of its title (a whole emoji or CJK character, never half a surrogate pair),
 *  upper-cased when Latin, so two icon-less plugins can be told apart. Leading
 *  spaces and invisible characters are skipped; ◇ remains for a title with
 *  nothing visible in it. */
export function pluginIconFallback(title: string): string {
  const text = title.replace(SKIPPED_LEADING, '')
  const first = new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)[Symbol.iterator]().next()
  if (first.done) return '◇'
  return LATIN.test(first.value.segment) ? first.value.segment.toUpperCase() : first.value.segment
}

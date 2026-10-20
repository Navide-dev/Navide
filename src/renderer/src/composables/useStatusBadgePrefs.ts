// User customization of the pane status badges: what each status is called, in
// each language, and which colour it is painted.
//
// Module-scoped singleton refs, for the same reason useCliAgentPrefs is one —
// settingsGet() is not reactive, so the settings page (writer) and every badge
// surface (readers) have to share one ref for an edit to show up live.
//
// Persistence is the per-user KV (ui_settings), not the workspace: a status
// vocabulary is how one person reads their panes, and it should not change when
// they switch projects. The value is a JSON string, matching how every other
// settings-backed object in this app is stored.
//
// Storage shape — only what differs from the default is written, so a status
// the user never touched keeps following the shipped default even if that
// default changes in a later version:
//   { "idle": { "labelZh": "待命", "color": "cyan" }, "error": { "color": "pink" } }
// zh-TW, en-US and ja-JP labels keep their original fields (labelZh / labelEn
// / labelJa), so an older version still reads them; labels for every other UI
// locale go in a `labels` map keyed by locale:
//   { "idle": { "labelEn": "Ready", "labels": { "ko-KR": "대기" } } }
// In memory every label lives in `labels`, whichever field it was stored in.

import { computed, ref } from 'vue'

import { isUiLocale, type UiLocale } from '@navide/plugin-ui/foundation'
import { onSettingsChanged, settingsGet, settingsSet } from '@navide/plugin-ui/shared'

import type { PaneStatusValue } from '../lib/paneStatusLabel'
import {
  DEFAULT_STATUS_COLORS,
  isPaneStatusValue,
  isStatusColorKey,
  STATUS_COLOR_PALETTE,
  type StatusColorKey,
} from '../lib/statusBadgePalette'

const STORAGE_KEY = 'agentTeam.statusBadges'

export type StatusBadgeLabels = Partial<Record<UiLocale, string>>

/** One status's overrides. Every field is optional: an absent field means
 *  "use the shipped default", which is what makes a partial edit survive a
 *  change to the defaults. */
export interface StatusBadgePref {
  /** Label per UI locale. Blank/absent → the i18n string. */
  labels?: StatusBadgeLabels
  /** Palette colour. Absent or unknown → DEFAULT_STATUS_COLORS. */
  color?: StatusColorKey
}

/** A change to one status. The legacy per-language fields are accepted as
 *  shorthands for `labels['zh-TW' | 'en-US' | 'ja-JP']`; `labels` entries are
 *  merged one locale at a time. */
export interface StatusBadgePrefPatch {
  labels?: StatusBadgeLabels
  labelZh?: string
  labelEn?: string
  labelJa?: string
  color?: StatusColorKey
}

export type StatusBadgePrefs = Partial<Record<PaneStatusValue, StatusBadgePref>>

/** The stored field each original locale keeps, for older versions to read. */
const LEGACY_LABEL_FIELDS = [
  ['zh-TW', 'labelZh'],
  ['en-US', 'labelEn'],
  ['ja-JP', 'labelJa'],
] as const satisfies readonly (readonly [UiLocale, string])[]

function cleanLabels(raw: unknown): StatusBadgeLabels {
  const labels: StatusBadgeLabels = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return labels
  for (const [locale, label] of Object.entries(raw as Record<string, unknown>)) {
    if (isUiLocale(locale) && typeof label === 'string' && label.trim()) labels[locale] = label.trim()
  }
  return labels
}

/** Drop anything we do not recognise rather than repairing it. A settings blob
 *  written by a newer version (or hand-edited) must degrade to the defaults, not
 *  to a badge painted `var(--undefined)` or labelled `[object Object]`. */
function sanitize(raw: unknown): StatusBadgePrefs {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: StatusBadgePrefs = {}
  for (const [status, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isPaneStatusValue(status)) continue
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const entry = value as Record<string, unknown>
    const pref: StatusBadgePref = {}
    const labels = cleanLabels(entry.labels)
    // The legacy fields are authoritative for their locales: an older version
    // that edited them rewrote the entry without `labels`.
    for (const [locale, field] of LEGACY_LABEL_FIELDS) {
      const legacy = entry[field]
      if (typeof legacy === 'string' && legacy.trim()) labels[locale] = legacy.trim()
    }
    if (Object.keys(labels).length) pref.labels = labels
    if (isStatusColorKey(entry.color)) pref.color = entry.color
    if (pref.labels || pref.color) out[status] = pref
  }
  return out
}

/** The stored shape: original locales in their legacy fields, the rest in
 *  `labels`. Field order matches what earlier versions wrote. */
function serialize(prefs: StatusBadgePrefs): string {
  const out: Record<string, Record<string, unknown>> = {}
  for (const [status, pref] of Object.entries(prefs)) {
    if (!pref) continue
    const entry: Record<string, unknown> = {}
    const rest: StatusBadgeLabels = { ...pref.labels }
    for (const [locale, field] of LEGACY_LABEL_FIELDS) {
      if (rest[locale]) entry[field] = rest[locale]
      delete rest[locale]
    }
    if (Object.keys(rest).length) entry.labels = rest
    if (pref.color) entry.color = pref.color
    out[status] = entry
  }
  return JSON.stringify(out)
}

function load(): StatusBadgePrefs {
  try {
    return sanitize(JSON.parse(settingsGet(STORAGE_KEY, '')))
  } catch {
    // no/blank/corrupt setting → no overrides, i.e. shipped defaults
    return {}
  }
}

const prefs = ref<StatusBadgePrefs>(load())

/** Last string this window wrote or read back. Comparing the serialized value
 *  — rather than raising a boolean flag — is what stops a broadcast we caused
 *  from re-entering as a remote change; the same guard useLayoutStore uses. */
let lastSynced = serialize(prefs.value)

function persist(next: StatusBadgePrefs): void {
  const serialized = serialize(next)
  if (serialized === lastSynced) return
  lastSynced = serialized
  settingsSet(STORAGE_KEY, serialized)
}

// Another window editing the same preference must repaint this one's badges;
// they are the same user looking at the same vocabulary.
onSettingsChanged((keys) => {
  if (!keys.includes(STORAGE_KEY)) return
  const incoming = load()
  const serialized = serialize(incoming)
  if (serialized === lastSynced) return
  lastSynced = serialized
  prefs.value = incoming
})

/** The colour a status is painted in, override first. */
export function statusBadgeColorKey(status: PaneStatusValue): StatusColorKey {
  return prefs.value[status]?.color ?? DEFAULT_STATUS_COLORS[status]
}

/** Inline CSS variables for a status badge, or `undefined` when the status is
 *  at its default colour.
 *
 *  Returning nothing for the default case is deliberate: the surface's own
 *  `[data-status]` rule then paints it, unchanged, and the surfaces keep
 *  working with no override layer present at all (plugin windows, tests, the
 *  first frame before settings load). Only a customized status carries inline
 *  style. */
export function statusBadgeStyle(
  status: PaneStatusValue
): Record<string, string> | undefined {
  const custom = prefs.value[status]?.color
  if (!custom || !isStatusColorKey(custom)) return undefined
  const spec = STATUS_COLOR_PALETTE[custom]
  return { '--status-badge-bg': spec.bg, '--status-badge-fg': spec.fg }
}

/** The user's label for a status in `locale`, or '' when they have not set one.
 *  Blank is meaningful — it is how the settings page clears an override back to
 *  the translated default.
 *
 *  zh-TW, en-US and ja-JP only ever use their own label (as they always have).
 *  Any other locale uses its own label, else the en-US one, else the zh-TW one. */
export function statusBadgeLabelOverride(status: PaneStatusValue, locale: string): string {
  const labels = prefs.value[status]?.labels
  if (!labels || !isUiLocale(locale)) return ''
  const own = labels[locale]?.trim()
  if (own) return own
  if (LEGACY_LABEL_FIELDS.some(([legacy]) => legacy === locale)) return ''
  return labels['en-US']?.trim() || labels['zh-TW']?.trim() || ''
}

/** Set one field of one status. An empty label or the default colour removes
 *  the override instead of storing it, so the blob never accumulates entries
 *  that say "same as default". */
export function setStatusBadgePref(
  status: PaneStatusValue,
  patch: StatusBadgePrefPatch
): void {
  const next: StatusBadgePrefs = { ...prefs.value }
  const current = next[status]
  const labels: Record<string, string | undefined> = { ...current?.labels, ...patch.labels }
  for (const [locale, field] of LEGACY_LABEL_FIELDS) {
    if (field in patch) labels[locale] = patch[field]
  }
  const merged: StatusBadgePref = { ...current }
  if ('color' in patch) merged.color = patch.color
  const cleaned = cleanLabels(labels)
  if (Object.keys(cleaned).length) merged.labels = cleaned
  else delete merged.labels
  if (!merged.color || merged.color === DEFAULT_STATUS_COLORS[status]) delete merged.color

  if (merged.labels || merged.color) next[status] = merged
  else delete next[status]

  prefs.value = next
  persist(next)
}

/** Drop every override for one status. */
export function resetStatusBadgePref(status: PaneStatusValue): void {
  if (!prefs.value[status]) return
  const next: StatusBadgePrefs = { ...prefs.value }
  delete next[status]
  prefs.value = next
  persist(next)
}

/** Drop every override, restoring the shipped vocabulary and palette. */
export function resetAllStatusBadgePrefs(): void {
  if (!Object.keys(prefs.value).length) return
  prefs.value = {}
  persist({})
}

/** Test seam: reload from settings. Production code never needs this — the
 *  settings broadcast keeps the ref current. */
export function __reloadStatusBadgePrefsForTest(): void {
  prefs.value = load()
  lastSynced = serialize(prefs.value)
}

export function useStatusBadgePrefs() {
  return {
    prefs,
    hasOverrides: computed(() => Object.keys(prefs.value).length > 0),
    setStatusBadgePref,
    resetStatusBadgePref,
    resetAllStatusBadgePrefs,
  }
}

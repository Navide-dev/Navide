// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

// In-memory settings backend, so a write can be read back the way it will be in
// the app; the listener is captured so a "another window changed this" broadcast
// can be replayed.
//
// vi.hoisted, not plain consts: the module under test subscribes at import time,
// and both the mock factory and the import are hoisted above a `const` — which
// makes the store unreachable when the factory first runs.
const h = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  listener: null as ((keys: string[]) => void) | null,
}))

vi.mock('@navide/plugin-ui/shared', () => ({
  settingsGet: (key: string, fallback: unknown) =>
    h.store.has(key) ? h.store.get(key) : fallback,
  settingsSet: (key: string, value: unknown) => {
    h.store.set(key, value)
  },
  onSettingsChanged: (cb: (keys: string[]) => void) => {
    h.listener = cb
    return () => {
      h.listener = null
    }
  },
}))

const store = h.store

import {
  __reloadStatusBadgePrefsForTest,
  resetAllStatusBadgePrefs,
  resetStatusBadgePref,
  setStatusBadgePref,
  statusBadgeLabelOverride,
  statusBadgeStyle,
  useStatusBadgePrefs,
} from '../useStatusBadgePrefs'
import { DEFAULT_STATUS_COLORS, STATUS_COLOR_PALETTE } from '../../lib/statusBadgePalette'

const KEY = 'agentTeam.statusBadges'

function seed(value: unknown): void {
  store.set(KEY, typeof value === 'string' ? value : JSON.stringify(value))
  __reloadStatusBadgePrefsForTest()
}

describe('useStatusBadgePrefs', () => {
  beforeEach(() => {
    store.clear()
    __reloadStatusBadgePrefsForTest()
  })

  it('paints nothing inline while a status is at its default colour', () => {
    // The surface's own [data-status] rule is the default look. Emitting inline
    // variables for every status would mean the palette has to reproduce all of
    // them exactly, and a pane would render wrong wherever settings had not
    // loaded yet.
    expect(statusBadgeStyle('idle')).toBeUndefined()
  })

  it('supplies both badge variables once a status is recoloured', () => {
    setStatusBadgePref('idle', { color: 'cyan' })
    expect(statusBadgeStyle('idle')).toEqual({
      '--status-badge-bg': STATUS_COLOR_PALETTE.cyan.bg,
      '--status-badge-fg': STATUS_COLOR_PALETTE.cyan.fg,
    })
  })

  it('returns the label for the matching locale only', () => {
    setStatusBadgePref('idle', { labelZh: '待命', labelEn: 'Ready' })
    expect(statusBadgeLabelOverride('idle', 'zh-TW')).toBe('待命')
    expect(statusBadgeLabelOverride('idle', 'en-US')).toBe('Ready')
    expect(statusBadgeLabelOverride('idle', 'ja-JP')).toBe('')
    // A status with only one language customized leaves the other translated.
    setStatusBadgePref('error', { labelZh: '壞了' })
    expect(statusBadgeLabelOverride('error', 'en-US')).toBe('')
  })

  it('persists, reloads, synchronizes and clears Japanese without altering older language overrides', () => {
    seed({ idle: { labelZh: '待命', labelEn: 'Ready' } })
    setStatusBadgePref('idle', { labelJa: '待機' })
    __reloadStatusBadgePrefsForTest()
    expect(statusBadgeLabelOverride('idle', 'ja-JP')).toBe('待機')
    expect(statusBadgeLabelOverride('idle', 'en-US')).toBe('Ready')
    expect(statusBadgeLabelOverride('idle', 'zh-TW')).toBe('待命')
    setStatusBadgePref('idle', { labelJa: '  ' })
    expect(JSON.parse(String(store.get(KEY)))).toEqual({ idle: { labelZh: '待命', labelEn: 'Ready' } })
    store.set(KEY, JSON.stringify({ idle: { labelJa: '準備完了' } }))
    h.listener?.([KEY])
    expect(statusBadgeLabelOverride('idle', 'ja-JP')).toBe('準備完了')
    expect(statusBadgeLabelOverride('idle', 'en-US')).toBe('')
    setStatusBadgePref('idle', { labelJa: '' })
    expect(JSON.parse(String(store.get(KEY)))).toEqual({})
  })

  it('reads legacy per-language fields into the labels map', () => {
    seed({ idle: { labelZh: '待命', labelEn: 'Ready', labelJa: '待機', color: 'cyan' } })
    expect(useStatusBadgePrefs().prefs.value.idle).toEqual({
      labels: { 'zh-TW': '待命', 'en-US': 'Ready', 'ja-JP': '待機' },
      color: 'cyan',
    })
  })

  it('stores a later language in `labels` and keeps the original three in their legacy fields', () => {
    setStatusBadgePref('idle', { labels: { 'en-US': 'Ready', 'ko-KR': '대기' } })
    expect(JSON.parse(String(store.get(KEY)))).toEqual({ idle: { labelEn: 'Ready', labels: { 'ko-KR': '대기' } } })
    __reloadStatusBadgePrefsForTest()
    expect(statusBadgeLabelOverride('idle', 'ko-KR')).toBe('대기')
    expect(statusBadgeLabelOverride('idle', 'en-US')).toBe('Ready')
    setStatusBadgePref('idle', { labels: { 'ko-KR': '' } })
    expect(JSON.parse(String(store.get(KEY)))).toEqual({ idle: { labelEn: 'Ready' } })
  })

  it('drops unknown locales in a stored labels map', () => {
    seed({ idle: { labels: { 'it-IT': 'Pronto', 'de-DE': 'Bereit' } } })
    expect(useStatusBadgePrefs().prefs.value.idle).toEqual({ labels: { 'de-DE': 'Bereit' } })
  })

  it('falls back to en-US then zh-TW only for a later language', () => {
    setStatusBadgePref('idle', { labelZh: '待命' })
    // zh-CN is not zh-TW: no prefix match, it only reaches zh-TW as last resort.
    expect(statusBadgeLabelOverride('idle', 'zh-CN')).toBe('待命')
    setStatusBadgePref('idle', { labelEn: 'Ready' })
    expect(statusBadgeLabelOverride('idle', 'zh-CN')).toBe('Ready')
    expect(statusBadgeLabelOverride('idle', 'ko-KR')).toBe('Ready')
    // The original three keep exact matching.
    expect(statusBadgeLabelOverride('idle', 'ja-JP')).toBe('')
    expect(statusBadgeLabelOverride('idle', 'it-IT')).toBe('')
  })

  it('stores nothing for a choice that equals the shipped default', () => {
    // Otherwise the blob fills up with entries that say "same as default", and
    // a status the user never meant to pin stops following a later change to
    // the defaults.
    setStatusBadgePref('running', { color: DEFAULT_STATUS_COLORS.running })
    expect(store.get(KEY)).toBeUndefined()
    expect(statusBadgeStyle('running')).toBeUndefined()
  })

  it('treats a blank label as clearing the override, not as a name', () => {
    setStatusBadgePref('idle', { labelZh: '待命' })
    expect(statusBadgeLabelOverride('idle', 'zh-TW')).toBe('待命')
    setStatusBadgePref('idle', { labelZh: '   ' })
    expect(statusBadgeLabelOverride('idle', 'zh-TW')).toBe('')
    expect(JSON.parse(String(store.get(KEY)))).toEqual({})
  })

  it('keeps the other fields when one is edited', () => {
    setStatusBadgePref('idle', { labelZh: '待命' })
    setStatusBadgePref('idle', { color: 'pink' })
    expect(statusBadgeLabelOverride('idle', 'zh-TW')).toBe('待命')
    expect(statusBadgeStyle('idle')).toEqual({
      '--status-badge-bg': STATUS_COLOR_PALETTE.pink.bg,
      '--status-badge-fg': STATUS_COLOR_PALETTE.pink.fg,
    })
  })

  it('resets one status without touching the rest', () => {
    setStatusBadgePref('idle', { color: 'pink' })
    setStatusBadgePref('error', { color: 'cyan' })
    resetStatusBadgePref('idle')
    expect(statusBadgeStyle('idle')).toBeUndefined()
    expect(statusBadgeStyle('error')).toBeDefined()
  })

  it('resets everything at once', () => {
    setStatusBadgePref('idle', { color: 'pink', labelEn: 'Ready' })
    setStatusBadgePref('error', { color: 'cyan' })
    resetAllStatusBadgePrefs()
    expect(JSON.parse(String(store.get(KEY)))).toEqual({})
    expect(useStatusBadgePrefs().hasOverrides.value).toBe(false)
  })

  it('drops values it does not recognise instead of repairing them', () => {
    // A blob from a newer build, or a hand-edited one. Anything unknown must
    // land on the shipped default rather than on a var() that paints nothing.
    seed({
      idle: { color: 'chartreuse', labelZh: '待命' },
      question: { color: 'pink' }, // retired status
      error: 'red', // not an object
      awaiting: { color: 'purple' },
    })
    expect(statusBadgeStyle('idle')).toBeUndefined() // unknown colour ignored
    expect(statusBadgeLabelOverride('idle', 'zh-TW')).toBe('待命') // valid field kept
    expect(statusBadgeStyle('error')).toBeUndefined()
    expect(statusBadgeStyle('awaiting')).toEqual({
      '--status-badge-bg': STATUS_COLOR_PALETTE.purple.bg,
      '--status-badge-fg': STATUS_COLOR_PALETTE.purple.fg,
    })
  })

  it('survives a corrupt setting', () => {
    seed('{not json')
    expect(useStatusBadgePrefs().hasOverrides.value).toBe(false)
    expect(statusBadgeStyle('idle')).toBeUndefined()
  })

  it('repaints when another window changes the same preference', () => {
    expect(h.listener).toBeTruthy()
    store.set(KEY, JSON.stringify({ idle: { color: 'red' } }))
    h.listener?.([KEY])
    expect(statusBadgeStyle('idle')).toEqual({
      '--status-badge-bg': STATUS_COLOR_PALETTE.red.bg,
      '--status-badge-fg': STATUS_COLOR_PALETTE.red.fg,
    })
  })

  it('ignores a broadcast about some other setting', () => {
    setStatusBadgePref('idle', { color: 'pink' })
    store.set(KEY, JSON.stringify({ idle: { color: 'red' } }))
    h.listener?.(['agentTeam.layout'])
    expect(statusBadgeStyle('idle')).toEqual({
      '--status-badge-bg': STATUS_COLOR_PALETTE.pink.bg,
      '--status-badge-fg': STATUS_COLOR_PALETTE.pink.fg,
    })
  })
})

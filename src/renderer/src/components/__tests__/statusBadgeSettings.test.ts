// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { i18n } from '@navide/plugin-ui/foundation'

import {
  PANE_STATUS_ORDER,
  STATUS_COLOR_KEYS,
} from '../../lib/statusBadgePalette'

// SettingsModal cannot be mounted in a test — it needs backend, stages and
// analyzer scaffolding — so its wiring is checked as source, the same way
// SettingsModal.idleReclaim.test.ts checks its own. Four of the six wiring
// points are silent when missed: a nav item with no body renders an empty
// panel, a body with no `overflow-y` rule simply refuses to scroll.

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), 'utf8')
}

const settings = read('src/renderer/src/components/SettingsModal.vue')

describe('status badge settings tab is wired into SettingsModal', () => {
  it('declares the tab in the Tab union', () => {
    expect(settings).toContain("'statusBadges'")
  })

  it('has a scope note, which the Tab Record requires', () => {
    // settingsScopeNotes is a complete Record<Exclude<Tab,'help'>, …>; a
    // missing entry fails typecheck, so this is a faster signal than tsc.
    expect(settings).toMatch(/statusBadges:\s*\{\s*scope:/)
  })

  it('has a nav item that selects the tab', () => {
    expect(settings).toContain("activeTab === 'statusBadges'")
    expect(settings).toContain("activeTab = 'statusBadges'")
  })

  it('renders the pane in a body section', () => {
    expect(settings).toContain('<StatusBadgeSettingsPane')
    expect(settings).toContain('data-settings-section="statusBadges"')
  })

  it('is findable from the settings search', () => {
    // Every other tab is indexed; one that is not simply never comes back as a
    // result, with no error to notice.
    const item = settings.slice(settings.indexOf("id: 'status-badges'"))
    expect(item.slice(0, 260)).toContain("tab: 'statusBadges'")
    expect(item.slice(0, 260)).toContain("section: 'statusBadges'")
  })

  it('gives the body a scroll rule of its own', () => {
    // .s-body is overflow:hidden with no padding; a tab that forgets its own
    // rule renders a list that cannot be scrolled to the end.
    const rule = settings.slice(settings.indexOf('.status-badges-body'))
    expect(rule.slice(0, 120)).toContain('overflow-y: auto')
  })
})

describe('status badge settings strings', () => {
  const KEYS = [
    'settings.nav.statusBadges',
    'statusBadges.intro',
    'statusBadges.note',
    'statusBadges.row-only',
    'statusBadges.reset-one',
    'statusBadges.reset-all',
    'statusBadges.col.status',
    'statusBadges.col.color',
    ...PANE_STATUS_ORDER.map((s) => `statusBadges.when.${s}`),
    ...STATUS_COLOR_KEYS.map((c) => `statusBadges.color.${c}`),
  ]

  it.each(['en-US', 'zh-TW'] as const)('has every string it renders in %s', (locale) => {
    for (const key of KEYS) {
      expect(i18n.global.t(key, {}, { locale }), `${key} missing in ${locale}`).not.toBe(key)
    }
  })

  it('describes when every status appears, so none is unexplained', () => {
    // The nine rows are the whole vocabulary; a row with no "when" text is a
    // status the user has to guess the meaning of before recolouring it.
    expect(KEYS.filter((k) => k.startsWith('statusBadges.when.'))).toHaveLength(
      PANE_STATUS_ORDER.length
    )
  })
})

describe('every status surface resolves its label through the shared resolver', () => {
  // The point of paneStatusLabelText is that a rename lands everywhere at once.
  // A surface left on the raw i18n key silently opts out of user labels, and
  // looks correct until someone renames a status.
  const SURFACES = [
    'src/renderer/src/components/TerminalPane.vue',
    'src/renderer/src/components/AgentList.vue',
    'src/renderer/src/components/ControlPane.vue',
    'src/renderer/src/components/ResourceSummaryPanel.vue',
    'src/renderer/src/App.vue',
  ]

  it.each(SURFACES)('%s prints resolved text, not a raw key lookup', (file) => {
    const source = read(file)
    expect(source).toContain('paneStatusLabelText')
    // `$t(paneStatusLabelKey(...))` and `i18n.global.t(paneStatusLabelKey(...))`
    // are the two shapes that bypass the override.
    expect(source).not.toMatch(/\$t\(\s*paneStatusLabelKey\(/)
    expect(source).not.toMatch(/i18n\.global\.t\(\s*paneStatusLabelKey\(/)
  })
})

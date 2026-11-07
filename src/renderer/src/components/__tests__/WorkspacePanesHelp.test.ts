// @vitest-environment happy-dom
import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { i18n } from '@navide/plugin-ui/foundation'

import WorkspacePanesHelp from '../WorkspacePanesHelp.vue'
import { expectNoChineseText } from './helpLocaleAssertions'
const HTML_ADVISORY = '[intlify] Detected HTML in '

function unexpectedWarnings(warn: ReturnType<typeof vi.spyOn>): unknown[][] {
  return warn.mock.calls.filter(([first]) => !String(first).startsWith(HTML_ADVISORY))
}

function mountHelp(): VueWrapper {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return mount(WorkspacePanesHelp as any, { global: { plugins: [i18n] } })
}

// Row counts per table, in document order.
const TABLE_ROWS = [6, 4, 3, 5, 3, 4, 15]

// Every interface label this topic quotes, paired with the key the product
// renders it from. The topic must print whatever that key says — in either
// locale — so a label renamed in the product can never leave a second, stale
// wording behind in the manual. `params` is for the labels that carry a count;
// the topic writes N where the interface substitutes a number.
const QUOTED_LABELS: ReadonlyArray<{ key: string; params?: Record<string, string> }> = [
  { key: 'action.browse' },                    // welcome card
  { key: 'action.new-workspace' },
  { key: 'action.open-home' },
  { key: 'action.open-in-default-editor' },    // recent-entry context menu
  { key: 'action.reveal-in-finder' },
  { key: 'action.copy-path' },
  { key: 'label.all-workspaces' },             // workspace-rail flyout
  { key: 'label.select-role' },                // ＋ menu
  { key: 'label.manual-spawn' },
  { key: 'action.focus' },                     // pane context menu
  { key: 'action.rename' },
  { key: 'action.send-message' },
  { key: 'action.interrupt' },
  { key: 'action.reapply-role' },
  { key: 'action.remove' },
  { key: 'action.remove-children', params: { count: 'N' } },
  { key: 'action.restore' },                   // expanded docked row
  { key: 'pane.terminal.click-to-resume' },    // placeholder card
  { key: 'action.interrupt-selected' },        // batch context menu
  { key: 'action.rebuild-selected' },
  { key: 'action.minimize-selected' },
  { key: 'action.restore-selected' },
  { key: 'action.remove-selected' },
  { key: 'action.open-in-finder' },            // workspace-row context menu
  { key: 'action.reclaim-workspace' },
  { key: 'action.close-workspace' },
  { key: 'action.close-workspace-and-panes' },
  { key: 'label.agents' },                     // the views, named as the UI names them
  { key: 'label.pipeline' },
  { key: 'label.explorer' },
  { key: 'label.git' },
  { key: 'label.plans' },
  { key: 'label.history' },
  { key: 'label.time' },
  { key: 'label.tokens' },
  { key: 'label.tasker' },
  { key: 'label.messages' },
  { key: 'label.preview' },
  { key: 'layout.preset.default' },            // Settings ▸ Layout
  { key: 'layout.preset.focus' },
  { key: 'layout.preset.bottom-panel' },
  { key: 'layout.reset' },
  { key: 'settings.nav.layout' },
  { key: 'announce.mark-all-read' },           // status-bar popovers
  { key: 'updater.download' },
  { key: 'updater.install' },
  { key: 'announce.load-more', params: { count: 'N' } },
  { key: 'resource.reclaim-action', params: { count: 'N' } },
  { key: 'action.fold-workspace-hint' },       // sidebar fold shortcut
]

// The four stage-mode buttons are glyph-only; the topic takes their name from
// the part of the tooltip before the dash, so the separator has to be there.
const VIEW_MODE_KEYS = [
  'label.view-mode-grid',
  'label.view-mode-sidebar',
  'label.view-mode-spotlight',
  'label.view-mode-fullscreen',
]

function quotesEveryLabel(text: string): void {
  const missing: string[] = []
  for (const { key, params } of QUOTED_LABELS) {
    const label = i18n.global.t(key, params ?? {})
    // A dropped placeholder renders as nothing, not as a literal {count} —
    // the double space it leaves behind is the only visible trace.
    expect(label, `${key} lost a placeholder`).not.toContain('  ')
    if (!text.includes(label)) missing.push(`${key} → "${label}"`)
  }
  expect(missing, `labels the topic no longer quotes as the UI writes them:\n${missing.join('\n')}`)
    .toEqual([])
}

describe('WorkspacePanesHelp', () => {
  const originalLocale = i18n.global.locale.value
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    i18n.global.locale.value = originalLocale
    warn.mockRestore()
  })

  it('renders entirely in English under en-US', () => {
    i18n.global.locale.value = 'en-US'
    const wrapper = mountHelp()

    const text = wrapper.text()
    expectNoChineseText(text)
    expect(text).toContain('Three terms')
    expect(text).toContain('Shortcut quick reference')
    expect(wrapper.findAll('.wph-h2')).toHaveLength(8)
    expect(wrapper.findAll('.wph-table').map((t) => t.findAll('tbody tr').length)).toEqual(
      TABLE_ROWS,
    )

    expect(unexpectedWarnings(warn)).toEqual([])
  })

  it('renders the Traditional Chinese prose under zh-TW', () => {
    i18n.global.locale.value = 'zh-TW'
    const wrapper = mountHelp()

    const text = wrapper.text()
    expect(text).toContain('三個名詞')
    expect(text).toContain('閒置自動回收')
    expect(text).toContain('快捷鍵速查')
    // The interface labels the prose quotes turn Chinese along with it.
    expect(text).toContain('傳送訊息')
    expect(text).toContain('關閉工作區與其中的分格')
    expect(text).toContain('格狀')
    expect(text).toContain('排程')
    expect(wrapper.findAll('.wph-h2')).toHaveLength(8)
    expect(wrapper.findAll('.wph-table').map((t) => t.findAll('tbody tr').length)).toEqual(
      TABLE_ROWS,
    )

    expect(unexpectedWarnings(warn)).toEqual([])
  })

  it('draws both mock screenshots, in the locale being rendered', () => {
    i18n.global.locale.value = 'en-US'
    const wrapper = mountHelp()

    // Two figures: the window anatomy and the group/grid pair.
    const figures = wrapper.findAll('.mk-fig')
    expect(figures).toHaveLength(2)
    // Five marked regions on the first, four on the second.
    expect(figures.map((f) => f.findAll('.mk-fig-legend li').length)).toEqual([5, 4])
    // Each figure draws the same six sidebar rows and three panes.
    expect(figures.map((f) => f.findAll('.mk-row').length)).toEqual([6, 6])
    expect(figures.map((f) => f.findAll('.mk-pane').length)).toEqual([3, 3])
    // Only the first carries window chrome; the second is a zoom on the stage.
    expect(figures.map((f) => f.findAll('.mk-win-status').length)).toEqual([1, 0])

    // Every word inside a mock is a locale lookup, so the pictures have to
    // turn English along with the prose around them.
    const mockText = figures.map((f) => f.text()).join(' ')
    expectNoChineseText(mockText)
    expect(mockText).toContain('Status bar')
    expect(mockText).toContain('running')

    expect(unexpectedWarnings(warn)).toEqual([])
  })

  it('renders the mock labels in Traditional Chinese under zh-TW', () => {
    i18n.global.locale.value = 'zh-TW'
    const wrapper = mountHelp()

    const mockText = wrapper.findAll('.mk-fig').map((f) => f.text()).join(' ')
    expect(mockText).toContain('狀態列')
    expect(mockText).toContain('執行中')
    // Sample project and pane names stay identical in both locales.
    expect(mockText).toContain('my-project')

    expect(unexpectedWarnings(warn)).toEqual([])
  })

  it('quotes every interface label exactly as the product writes it, in both locales', () => {
    for (const locale of ['en-US', 'zh-TW'] as const) {
      i18n.global.locale.value = locale
      quotesEveryLabel(mountHelp().text())
    }

    expect(unexpectedWarnings(warn)).toEqual([])
  })

  it('names the stage modes from the tooltips the buttons themselves carry', () => {
    for (const locale of ['en-US', 'zh-TW'] as const) {
      i18n.global.locale.value = locale
      const text = mountHelp().text()
      for (const key of VIEW_MODE_KEYS) {
        const tooltip = i18n.global.t(key)
        expect(tooltip, `${key} (${locale}) lost its "name — description" shape`).toContain(' — ')
        expect(text).toContain(tooltip.split(' — ')[0])
      }
    }

    expect(unexpectedWarnings(warn)).toEqual([])
  })

  it('injects the inline markup from the locale strings', () => {
    i18n.global.locale.value = 'en-US'
    const wrapper = mountHelp()

    // `.wph-list` items are v-html, so their <code>/<strong> come from the
    // locale strings rather than the template.
    expect(wrapper.find('.wph-list code').exists()).toBe(true)
    expect(wrapper.find('.wph-list strong').exists()).toBe(true)
    expect(wrapper.find('.wph-list kbd.wph-kbd').exists()).toBe(true)
    expect(wrapper.find('.wph-card .wph-p code').exists()).toBe(true)
    expect(wrapper.find('.wph-p em').exists()).toBe(true)

    expect(unexpectedWarnings(warn)).toEqual([])
  })
})

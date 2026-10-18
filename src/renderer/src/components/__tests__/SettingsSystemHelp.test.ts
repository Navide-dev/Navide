// @vitest-environment happy-dom
import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { i18n } from '@navide/plugin-ui/foundation'

import SettingsSystemHelp from '../SettingsSystemHelp.vue'
import { expectNoChineseText } from './helpLocaleAssertions'

// The help topic is prose from the locale files plus static tables that keep
// only their row keys. vue-i18n reports every problem — a missing key, a
// message that failed to compile (an unescaped `{`, `@` or `|`) — through
// console.warn, so the spy is the assertion that every key exists and every
// string parsed cleanly. The one warning that is expected is intlify's
// "Detected HTML in … message" advisory: the prose deliberately carries inline
// markup for v-html, exactly like the existing hint.* strings, so that
// advisory is filtered out before asserting.
const HTML_ADVISORY = '[intlify] Detected HTML in '

// The Language row keeps native names in all three interface languages.
// These two Han strings therefore belong in the English rendering.
const LITERAL_OPTIONS = ['繁體中文', '日本語']

// Row counts per table, in template order.
// The first table is the settings nav: twenty-five pages in five groups,
// counted from SettingsModal.vue's `.s-nav-group` blocks rather than from the
// prose. The last one is section 8's which-surface-is-which table.
const TABLE_ROWS = [24, 15, 9, 4, 3, 6, 2, 6, 3, 8, 4, 10, 3]

function unexpectedWarnings(warn: ReturnType<typeof vi.spyOn>): unknown[][] {
  return warn.mock.calls.filter(([first]) => !String(first).startsWith(HTML_ADVISORY))
}

function mountHelp(): VueWrapper {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return mount(SettingsSystemHelp as any, { global: { plugins: [i18n] } })
}

function rowCounts(wrapper: VueWrapper): number[] {
  return wrapper.findAll('.syh-table').map((t) => t.findAll('tbody tr').length)
}

describe('SettingsSystemHelp', () => {
  const originalLocale = i18n.global.locale.value
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    i18n.global.locale.value = originalLocale
    warn.mockRestore()
  })

  it('renders entirely in English under en-US', { timeout: 30_000 }, () => {
    i18n.global.locale.value = 'en-US'
    const wrapper = mountHelp()

    const text = wrapper.text()
    for (const option of LITERAL_OPTIONS) expect(text).toContain(option)
    expectNoChineseText(text, { allowLiterals: LITERAL_OPTIONS })
    expect(text).toContain('Settings overview')
    expect(text).toContain('Resources and upkeep')
    expect(text).toContain('Token Monitor')
    expect(text).toContain('Status badges')
    expect(text).toContain('Confirm before closing a pane')
    expect(text).toContain('Pipeline Manager')
    expect(wrapper.findAll('.syh-h2')).toHaveLength(9)
    expect(rowCounts(wrapper)).toEqual(TABLE_ROWS)

    // Placeholder prose, not interpolations — the escapes must survive.
    expect(text).toContain('{file}')
    expect(text).toContain('{device}')
    expect(text).toContain('v{version} ready')
    // A bare `@` has to be escaped in the message too.
    expect(text).toContain('@')
    expect(unexpectedWarnings(warn)).toEqual([])
  })

  it('renders the Traditional Chinese prose under zh-TW', () => {
    i18n.global.locale.value = 'zh-TW'
    const wrapper = mountHelp()

    const text = wrapper.text()
    expect(text).toContain('設定總覽')
    expect(text).toContain('技能、Prompt 技能、記憶')
    expect(text).toContain('資源與維護')
    expect(text).toContain('Token 監看')
    // Table labels now read the product's own keys, so they translate too.
    expect(text).toContain('狀態徽章')
    expect(text).toContain('關閉 pane 前確認')
    expect(text).toContain('流程管理')
    expect(wrapper.findAll('.syh-h2')).toHaveLength(9)
    expect(rowCounts(wrapper)).toEqual(TABLE_ROWS)

    expect(text).toContain('{file}')
    expect(text).toContain('{裝置}')
    expect(text).toContain('v{版本} ready')
    expect(text).toContain('@')
    expect(unexpectedWarnings(warn)).toEqual([])
  })

  it('draws both mock screenshots, in the locale being rendered', () => {
    i18n.global.locale.value = 'en-US'
    const wrapper = mountHelp()

    const figures = wrapper.findAll('.mk-fig')
    expect(figures).toHaveLength(2)
    expect(figures.map((f) => f.findAll('.mk-fig-legend li').length)).toEqual([3, 3])
    // The nav picture draws the real sidebar: five groups, twenty-four pages.
    expect(figures[0].findAll('.mk-set-grouptitle')).toHaveLength(5)
    expect(figures[0].findAll('.mk-set-navitem')).toHaveLength(24)
    // ...and the search box with the two hits it drops down.
    expect(figures[0].findAll('.mk-set-result')).toHaveLength(2)
    // The resource picture: a header row plus one row per pane.
    expect(figures[1].findAll('.mk-stat')).toHaveLength(4)
    expect(figures[1].findAll('.mk-stat-trend svg')).toHaveLength(3)

    // Assert the pictures actually rendered text BEFORE checking it is not
    // Chinese: a figure that failed to render passes expectNoChineseText for
    // the wrong reason.
    const mockText = figures.map((f) => f.text()).join(' ')
    expect(mockText.length).toBeGreaterThan(200)
    expectNoChineseText(mockText)
    // The box shows the typed query, the way the real one does once it has
    // something in it; the placeholder only shows while it is empty.
    expect(mockText).toContain('reclaim')
    expect(mockText).toContain('Marketplace')
    expect(mockText).toContain('Resource Manager')

    expect(unexpectedWarnings(warn)).toEqual([])
  })

  it.each([
    ['en-US', 'Extensions'],
    ['zh-TW', '擴充'],
    ['ja-JP', '拡張機能'],
  ] as const)('draws Credentials and Extensions under Agent Assets in %s', (locale, extensionsLabel) => {
    i18n.global.locale.value = locale
    const wrapper = mountHelp()
    const t = (key: string) => i18n.global.t(key)

    // Group titles and nav items are flat siblings in the mock, so a group
    // runs from its title to the next one.
    const groups: { title: string; items: string[] }[] = []
    for (const el of wrapper.findAll('.mk-fig')[0].findAll('.mk-set-grouptitle, .mk-set-navitem')) {
      if (el.classes('mk-set-grouptitle')) groups.push({ title: el.text(), items: [] })
      else groups[groups.length - 1].items.push(el.text())
    }
    const group = (key: string) => groups.find((g) => g.title === t(key))?.items

    expect(t('settings.nav.cliExtensions')).toBe(extensionsLabel)
    expect(group('settings.nav.group.integration')).toEqual(
      ['mcp', 'skills', 'prompts', 'memory', 'credentials', 'cliExtensions'].map((k) => t(`settings.nav.${k}`))
    )
    expect(group('settings.nav.group.accountsAgents')).toEqual(
      ['settings.nav.accounts', 'settings.nav.cliAgents', 'settings.nav.analyzer', 'guard.nav', 'channels.nav'].map(t)
    )
    expect(group('settings.nav.group.navidePlugins')).toEqual(
      ['settings.nav.crossDevice', 'settings.nav.extensions', 'settings.nav.marketplace'].map(t)
    )
    expect(unexpectedWarnings(warn)).toEqual([])
  })

  it('renders the mock labels in Traditional Chinese under zh-TW', () => {
    i18n.global.locale.value = 'zh-TW'
    const wrapper = mountHelp()

    const mockText = wrapper.findAll('.mk-fig').map((f) => f.text()).join(' ')
    expect(mockText.length).toBeGreaterThan(200)
    expect(mockText).toContain('reclaim')
    expect(mockText).toContain('市集')
    expect(mockText).toContain('資源控管')
    // Pane names and figures are the same in both locales.
    expect(mockText).toContain('reviewer')

    expect(unexpectedWarnings(warn)).toEqual([])
  })

  it('injects the inline markup from the locale strings', () => {
    i18n.global.locale.value = 'en-US'
    const wrapper = mountHelp()

    expect(wrapper.findAll('kbd.syh-kbd').length).toBeGreaterThan(0)
    expect(wrapper.find('.syh-p strong').exists()).toBe(true)
    expect(wrapper.find('.syh-p code').exists()).toBe(true)
    expect(wrapper.find('.syh-list li strong').exists()).toBe(true)
    expect(wrapper.find('.syh-callout-text kbd.syh-kbd').exists()).toBe(true)
    expect(unexpectedWarnings(warn)).toEqual([])
  })
})

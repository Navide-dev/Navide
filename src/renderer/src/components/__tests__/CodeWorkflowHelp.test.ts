// @vitest-environment happy-dom
import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { i18n } from '@navide/plugin-ui/foundation'

import CodeWorkflowHelp from '../CodeWorkflowHelp.vue'
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

// Row counts per table, in template order.
const TABLE_ROWS = [5, 6, 7, 4, 5, 4, 14, 11, 22]

function unexpectedWarnings(warn: ReturnType<typeof vi.spyOn>): unknown[][] {
  return warn.mock.calls.filter(([first]) => !String(first).startsWith(HTML_ADVISORY))
}

function mountHelp(): VueWrapper {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return mount(CodeWorkflowHelp as any, { global: { plugins: [i18n] } })
}

function rowCounts(wrapper: VueWrapper): number[] {
  return wrapper.findAll('.cwh-table').map((t) => t.findAll('tbody tr').length)
}

describe('CodeWorkflowHelp', () => {
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
    expect(text).toContain('The three work surfaces')
    expect(text).toContain('Shortcut cheat sheet')
    expect(wrapper.findAll('.cwh-h2')).toHaveLength(10)
    expect(rowCounts(wrapper)).toEqual(TABLE_ROWS)

    // Placeholder prose, not interpolations — the escapes must survive.
    expect(text).toContain('{done}/{total} done')
    expect(text).toContain('{file}')
    expect(unexpectedWarnings(warn)).toEqual([])
  })

  it('renders the Traditional Chinese prose under zh-TW', () => {
    i18n.global.locale.value = 'zh-TW'
    const wrapper = mountHelp()

    const text = wrapper.text()
    expect(text).toContain('三個工作面')
    expect(text).toContain('Git：暫存與提交')
    expect(text).toContain('快捷鍵速查')
    expect(wrapper.findAll('.cwh-h2')).toHaveLength(10)
    expect(rowCounts(wrapper)).toEqual(TABLE_ROWS)

    expect(text).toContain('{done}/{total} done')
    expect(text).toContain('{file}')
    expect(unexpectedWarnings(warn)).toEqual([])
  })

  it('draws the three mock screenshots, in the locale being rendered', () => {
    i18n.global.locale.value = 'en-US'
    const wrapper = mountHelp()

    const figures = wrapper.findAll('.mk-fig')
    expect(figures).toHaveLength(3)
    expect(figures.map((f) => f.findAll('.mk-fig-legend li').length)).toEqual([3, 3, 3])
    // Git panel rows, then one diff body per remaining figure.
    expect(figures.map((f) => f.findAll('.mk-frow').length)).toEqual([6, 0, 0])
    expect(figures.map((f) => f.findAll('.mk-diff').length)).toEqual([0, 1, 1])
    // Only the file diff is side by side.
    expect(figures.map((f) => f.findAll('.mk-diff-split').length)).toEqual([0, 0, 1])

    const mockText = figures.map((f) => f.text()).join(' ')
    expectNoChineseText(mockText)
    expect(mockText).toContain('Staged Changes')
    expect(mockText).toContain('Accept Theirs')
    expect(mockText).toContain('Stage Hunk')

    expect(unexpectedWarnings(warn)).toEqual([])
  })

  it('renders the mock labels in Traditional Chinese under zh-TW', () => {
    i18n.global.locale.value = 'zh-TW'
    const wrapper = mountHelp()

    const mockText = wrapper.findAll('.mk-fig').map((f) => f.text()).join(' ')
    expect(mockText).toContain('已暫存的變更')
    expect(mockText).toContain('採用他們的版本')
    expect(mockText).toContain('暫存此區塊')
    // The conflict apply button is localized in the product, so the mock
    // follows it; paths and hunk headers are the same in both locales.
    expect(mockText).toContain('套用並暫存')
    expect(mockText).toContain('@@ -12,7 +12,9 @@')

    expect(unexpectedWarnings(warn)).toEqual([])
  })

  it('injects the inline markup from the locale strings', () => {
    i18n.global.locale.value = 'en-US'
    const wrapper = mountHelp()

    expect(wrapper.findAll('kbd.cwh-kbd').length).toBeGreaterThan(0)
    expect(wrapper.find('.cwh-p strong').exists()).toBe(true)
    expect(wrapper.find('.cwh-p code').exists()).toBe(true)
    expect(wrapper.find('.cwh-callout-text kbd.cwh-kbd').exists()).toBe(true)
    expect(unexpectedWarnings(warn)).toEqual([])
  })
})

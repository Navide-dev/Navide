// @vitest-environment happy-dom
import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { i18n } from '@navide/plugin-ui/foundation'

import IconReferenceHelp from '../IconReferenceHelp.vue'
import { expectNoChineseText } from './helpLocaleAssertions'
const HTML_ADVISORY = '[intlify] Detected HTML in '

// Row counts per table, in document order.
const TABLE_ROWS = [7, 9, 11, 21, 3, 4, 7, 3, 6, 7, 7, 8, 8, 13, 11, 9, 6, 7, 4, 8, 4, 3, 24]

function unexpectedWarnings(warn: ReturnType<typeof vi.spyOn>): unknown[][] {
  return warn.mock.calls.filter(([first]) => !String(first).startsWith(HTML_ADVISORY))
}

function mountHelp(): VueWrapper {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return mount(IconReferenceHelp as any, { global: { plugins: [i18n] } })
}

function tableRowCounts(wrapper: VueWrapper): number[] {
  return wrapper.findAll('.irh-table').map((t) => t.findAll('tbody tr').length)
}

describe('IconReferenceHelp', () => {
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
    expect(text).toContain('Sidebar')
    expect(text).toContain('Status colors and marks')
    expect(text).toContain('How to use this table')
    expectNoChineseText(text)

    expect(wrapper.findAll('.irh-h2')).toHaveLength(9)
    expect(tableRowCounts(wrapper)).toEqual(TABLE_ROWS)

    // The chapter locator. Its own text is checked separately: the page-wide
    // Chinese check would still pass if the picture failed to render at all.
    const figures = wrapper.findAll('.mk-fig')
    expect(figures).toHaveLength(1)
    expect(figures[0].text().trim()).not.toBe('')
    expectNoChineseText(figures[0].text())

    expect(unexpectedWarnings(warn)).toEqual([])
  })

  it('renders the Traditional Chinese prose under zh-TW', () => {
    i18n.global.locale.value = 'zh-TW'
    const wrapper = mountHelp()

    const text = wrapper.text()
    expect(text).toContain('怎麼用這張表')
    expect(text).toContain('狀態色與記號')
    expect(text).toContain('三態，不是兩態')

    expect(wrapper.findAll('.irh-h2')).toHaveLength(9)
    expect(tableRowCounts(wrapper)).toEqual(TABLE_ROWS)

    expect(unexpectedWarnings(warn)).toEqual([])
  })

  it('keeps the icon cells and the inline markup from the locale strings', () => {
    i18n.global.locale.value = 'en-US'
    const wrapper = mountHelp()

    // Icon cells stay in the template, so the shapes must still be there.
    expect(wrapper.findAll('.irh-icocell svg.irh-ic').length).toBeGreaterThan(0)
    expect(wrapper.findAll('.irh-icocell .irh-glyph').length).toBeGreaterThan(0)
    expect(wrapper.findAll('.irh-dot')).toHaveLength(8)
    expect(wrapper.findAll('.irh-sq')).toHaveLength(4)

    // …while the prose cells come through v-html.
    expect(wrapper.find('.irh-intro code').exists()).toBe(true)
    expect(wrapper.find('.irh-table td strong').exists()).toBe(true)
    expect(wrapper.find('.irh-table td em').exists()).toBe(true)
    expect(wrapper.find('.irh-p strong').exists()).toBe(true)
    expect(wrapper.find('.irh-callout-text code').exists()).toBe(true)

    expect(unexpectedWarnings(warn)).toEqual([])
  })
})

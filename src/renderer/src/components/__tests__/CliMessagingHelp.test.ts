// @vitest-environment happy-dom
import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { i18n } from '@navide/plugin-ui/foundation'

import CliMessagingHelp from '../CliMessagingHelp.vue'
import { expectNoChineseText } from './helpLocaleAssertions'

// The help topic is prose from the locale files plus a static coverage table.
// vue-i18n reports every problem — a missing key, a message that failed to
// compile (an unescaped `{`, `@` or `|`) — through console.warn, so the spy is
// the assertion that every key exists and every string parsed cleanly. The one
// warning that is expected is intlify's "Detected HTML in … message" advisory:
// the prose deliberately carries inline markup for v-html, exactly like the
// existing hint.* strings, so that advisory is filtered out before asserting.
const HTML_ADVISORY = '[intlify] Detected HTML in '

function unexpectedWarnings(warn: ReturnType<typeof vi.spyOn>): unknown[][] {
  return warn.mock.calls.filter(([first]) => !String(first).startsWith(HTML_ADVISORY))
}

function mountHelp(): VueWrapper {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return mount(CliMessagingHelp as any, { global: { plugins: [i18n] } })
}

describe('CliMessagingHelp', () => {
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
    expect(text).toContain('How it works')
    expect(text).toContain('Which CLIs can send')
    expect(text).toContain('Known limits')
    expect(wrapper.findAll('.cmh-h2')).toHaveLength(13)

    const tables = wrapper.findAll('.cmh-table')
    expect(tables).toHaveLength(5)
    expect(tables[0].findAll('tbody tr')).toHaveLength(19) // coverage: one row per CLI spec
    expect(tables[1].findAll('tbody tr')).toHaveLength(5) // addressing
    expect(tables[2].findAll('tbody tr')).toHaveLength(3) // spawn guidelines
    expect(tables[3].findAll('tbody tr')).toHaveLength(4) // guardrails
    expect(tables[4].findAll('tbody tr')).toHaveLength(9) // troubleshooting

    // The two mock screenshots. Their own text is checked separately: the
    // page-wide Chinese check would still pass if a picture failed to render
    // at all, and a mock's labels are the easiest place to leave a hard-coded
    // string behind. Selectors are the two components' own root classes, not
    // a class other topics' mocks might share.
    const figures = wrapper.findAll('.mk-fig')
    expect(figures).toHaveLength(2)
    expect(wrapper.findAll('.mk-env')).toHaveLength(1) // the receiving pane
    expect(wrapper.findAll('.mk-msglog-row')).toHaveLength(3) // the messages panel
    for (const figure of figures) {
      expect(figure.text().trim()).not.toBe('')
      expectNoChineseText(figure.text())
    }
    // The envelope is quoted from the real constant, not retyped.
    expect(wrapper.find('.mk-env').text()).toContain('[Navide MSG] from:')

    // `@` is literal prose, not an i18n linked-message marker — the escape must survive.
    expect(text).toContain('@')
    expect(unexpectedWarnings(warn)).toEqual([])
  })

  it('renders the Traditional Chinese prose under zh-TW', () => {
    i18n.global.locale.value = 'zh-TW'
    const wrapper = mountHelp()

    const text = wrapper.text()
    expect(text).toContain('怎麼運作')
    expect(text).toContain('哪些 CLI 送得出訊息')
    expect(text).toContain('已知限制')
    expect(text).toContain('僅輸出協定')
    expect(wrapper.findAll('.cmh-h2')).toHaveLength(13)
    expect(wrapper.findAll('.cmh-table').at(0)!.findAll('tbody tr')).toHaveLength(19)
    expect(wrapper.findAll('.mk-fig')).toHaveLength(2)

    expect(text).toContain('@')
    expect(unexpectedWarnings(warn)).toEqual([])
  })

  it('injects the inline markup from the locale strings', () => {
    i18n.global.locale.value = 'en-US'
    const wrapper = mountHelp()

    expect(wrapper.find('.cmh-intro strong').exists()).toBe(true)
    expect(wrapper.find('.cmh-callout-text em').exists()).toBe(true)
    expect(wrapper.find('.cmh-list code').exists()).toBe(true)
    expect(wrapper.findAll('.cmh-list strong').length).toBeGreaterThan(0)
    expect(unexpectedWarnings(warn)).toEqual([])
  })
})

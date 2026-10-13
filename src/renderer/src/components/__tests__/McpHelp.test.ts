// @vitest-environment happy-dom
import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { i18n } from '@navide/plugin-ui/foundation'

import McpHelp from '../McpHelp.vue'
import { expectNoChineseText } from './helpLocaleAssertions'

// The help topic is prose from the locale files plus the static tool tables.
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
  return mount(McpHelp as any, { global: { plugins: [i18n] } })
}

describe('McpHelp', () => {
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
    expect(text).toContain('Navide provides tools')
    expect(text).toContain('Direction 2: Navide consuming external MCP')
    expect(text).toContain('When something goes wrong')
    expect(wrapper.findAll('.mh-h2')).toHaveLength(5)
    expect(wrapper.findAll('.mh-h3')).toHaveLength(6)
    expect(wrapper.findAll('.mh-dir')).toHaveLength(3)

    const tables = wrapper.findAll('.mh-table')
    expect(tables).toHaveLength(7)
    expect(tables[0].findAll('tbody tr')).toHaveLength(6) // plan tools
    expect(tables[1].findAll('tbody tr')).toHaveLength(31) // workspace tools
    // The graph-pipeline tools sit with the other pipeline tools.
    const workspaceNames = tables[1].findAll('tbody tr td:first-child').map((td) => td.text())
    expect(workspaceNames).toEqual(expect.arrayContaining(['pipeline_graph', 'pipeline_gate', 'pipeline_restart_from']))
    expect(workspaceNames.indexOf('pipeline_graph')).toBe(workspaceNames.indexOf('pipeline_define') + 1)
    expect(tables[2].findAll('tbody tr')).toHaveLength(4) // preview tools
    expect(tables[3].findAll('tbody tr')).toHaveLength(22) // cli tools
    expect(tables[4].findAll('tbody tr')).toHaveLength(4) // ui tools
    expect(tables[5].findAll('tbody tr')).toHaveLength(5) // comparison
    expect(tables[5].findAll('tbody tr')).toHaveLength(5) // troubleshooting
    expect(wrapper.findAll('.mh-list li')).toHaveLength(5) // built-in catalog

    // The two mock screenshots. Their own text is checked separately: the
    // page-wide Chinese check above would still pass if a picture failed to
    // render at all, and a mock's labels are the easiest place to leave a
    // hard-coded string behind.
    const figures = wrapper.findAll('.mk-fig')
    expect(figures).toHaveLength(2)
    expect(wrapper.findAll('.mk-set')).toHaveLength(1) // Settings → MCP
    expect(wrapper.findAll('.mh-mock-pair .mk-win')).toHaveLength(2) // two workspaces
    for (const figure of figures) {
      expect(figure.text().trim()).not.toBe('')
      expectNoChineseText(figure.text())
    }

    expect(unexpectedWarnings(warn)).toEqual([])
  })

  it('renders the Traditional Chinese prose under zh-TW', () => {
    i18n.global.locale.value = 'zh-TW'
    const wrapper = mountHelp()

    const text = wrapper.text()
    expect(text).toContain('方向一：Navide 提供給 CLI agent 的工具')
    expect(text).toContain('哪些 CLI 接得到')
    expect(text).toContain('出問題時')
    expect(wrapper.findAll('.mh-h2')).toHaveLength(5)
    expect(wrapper.findAll('.mh-dir')).toHaveLength(3)
    expect(wrapper.findAll('.mh-table').at(3)!.findAll('tbody tr')).toHaveLength(22)
    expect(wrapper.findAll('.mk-fig')).toHaveLength(2)

    expect(unexpectedWarnings(warn)).toEqual([])
  })

  it('injects the inline markup from the locale strings', () => {
    i18n.global.locale.value = 'en-US'
    const wrapper = mountHelp()

    expect(wrapper.find('.mh-intro strong').exists()).toBe(true)
    expect(wrapper.find('.mh-dir-text strong').exists()).toBe(true)
    expect(wrapper.find('.mh-note code').exists()).toBe(true)
    expect(wrapper.find('.mh-list li code').exists()).toBe(true)
    expect(wrapper.find('.mh-warn p strong').exists()).toBe(true)
    expect(unexpectedWarnings(warn)).toEqual([])
  })
})

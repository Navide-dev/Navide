// @vitest-environment happy-dom
import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { i18n } from '@navide/plugin-ui/foundation'

import CliAgentsHelp from '../CliAgentsHelp.vue'
import { expectNoChineseText } from './helpLocaleAssertions'

// The help topic is prose from the locale files plus a static vendor table.
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
  return mount(CliAgentsHelp as any, { global: { plugins: [i18n] } })
}

describe('CliAgentsHelp', () => {
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
    expect(text).toContain('Supported CLIs')
    expect(text).toContain('Troubleshooting')
    expect(wrapper.findAll('.cah-h2')).toHaveLength(9)
    expect(wrapper.findAll('.cah-table').at(0)!.findAll('tbody tr')).toHaveLength(16)

    // `{CLI}` is placeholder prose, not an interpolation — the escape must survive.
    expect(text).toContain('{CLI}')
    expect(unexpectedWarnings(warn)).toEqual([])
  })

  it('renders the Traditional Chinese prose under zh-TW', () => {
    i18n.global.locale.value = 'zh-TW'
    const wrapper = mountHelp()

    const text = wrapper.text()
    expect(text).toContain('支援哪些 CLI')
    expect(text).toContain('疑難排解')
    expect(text).toContain('取得 Session ID 中')
    expect(wrapper.findAll('.cah-h2')).toHaveLength(9)
    expect(wrapper.findAll('.cah-table').at(0)!.findAll('tbody tr')).toHaveLength(16)

    expect(text).toContain('{CLI}')
    expect(unexpectedWarnings(warn)).toEqual([])
  })

  it('draws the four mock screenshots, in the locale being rendered', () => {
    i18n.global.locale.value = 'en-US'
    const wrapper = mountHelp()

    const figures = wrapper.findAll('.mk-fig')
    expect(figures).toHaveLength(4)
    // Three marked regions per picture; the settings one also marks the
    // launch-override accordion, which the list and permission rows sit around.
    expect(figures.map((f) => f.findAll('.mk-fig-legend li').length)).toEqual([3, 3, 4, 3])
    // + menu, install dialog, settings rows, quota bars — one per figure.
    expect(figures.map((f) => f.findAll('.mk-menu').length)).toEqual([1, 0, 0, 0])
    expect(figures.map((f) => f.findAll('.mk-dlg').length)).toEqual([0, 1, 0, 0])
    // Settings: three cards, then the drawer's four launch-override rows and
    // its two permission rows (the global switch and this CLI's own row).
    expect(figures.map((f) => f.findAll('.mk-frow').length)).toEqual([0, 4, 9, 2])
    expect(figures.map((f) => f.findAll('.mk-meter').length)).toEqual([0, 0, 0, 2])

    // The pictures reuse the product's own strings, so they turn English with
    // everything else.
    const mockText = figures.map((f) => f.text()).join(' ')
    expectNoChineseText(mockText)
    expect(mockText).toContain('not installed')
    expect(mockText).toContain('Follow global')
    expect(mockText).toContain('npm install -g @anthropic-ai/claude-code')

    expect(unexpectedWarnings(warn)).toEqual([])
  })

  it('renders the mock labels in Traditional Chinese under zh-TW', () => {
    i18n.global.locale.value = 'zh-TW'
    const wrapper = mountHelp()

    const mockText = wrapper.findAll('.mk-fig').map((f) => f.text()).join(' ')
    expect(mockText).toContain('（未安裝）')
    expect(mockText).toContain('跟隨全域')
    expect(mockText).toContain('即將執行的指令')
    // Vendor names and commands are identical in both locales.
    expect(mockText).toContain('Claude Code')

    expect(unexpectedWarnings(warn)).toEqual([])
  })

  // review-524 MEDIUM-1: Goose has no bypass flag because it approves tools by
  // itself by default; its row must not read like the CLIs that ask first.
  it.each([
    ['en-US', 'GOOSE_MODE=auto', "Navide's Guard does not cover Goose"],
    ['zh-TW', 'GOOSE_MODE=auto', 'Navide 的 Guard'],
    ['ja-JP', 'GOOSE_MODE=auto', 'Navide の Guard'],
  ] as const)('says Goose approves tools by itself unless GOOSE_MODE asks (%s)', (locale, mode, guard) => {
    i18n.global.locale.value = locale
    const row = mountHelp().findAll('tbody tr').find((tr) => tr.text().includes('Goose (AAIF)'))!
    const flagCell = row.findAll('td')[2].text()
    expect(flagCell).toContain(mode)
    expect(flagCell).toContain('approve')
    expect(flagCell).toContain('smart_approve')
    expect(flagCell).toContain(guard)
    expect(unexpectedWarnings(warn)).toEqual([])
  })

  it('names the sign-in command each vendor actually runs', () => {
    i18n.global.locale.value = 'en-US'
    const wrapper = mountHelp()

    const table = wrapper.findAll('.cah-table').at(0)!
    expect(table.findAll('thead th')).toHaveLength(6)
    expect(table.findAll('thead th').at(5)!.text()).toBe('Sign-in command')

    // Mirrors `login_command_args` in backend/agent_team_backend/cli_vendors/.
    // A vendor that declares none launches normally, so the cell says so
    // instead of showing a command the sign-in button never runs.
    const cells = table.findAll('tbody tr').map((row) => row.findAll('td').at(5)!)
    const rendered = cells.map((c) => c.text())
    expect(rendered).toEqual([
      'claude auth login',
      'codex login',
      'Inside the CLI',
      'grok login',
      'kimi login',
      'opencode auth login',
      'Inside the CLI',
      'kilo auth login',
      'Inside the CLI',
      'copilot login',
      'Inside the CLI',
      'Inside the CLI',
      'muse login',
      'Inside the CLI',
      'mcode login',
      'Inside the CLI',
    ])
    // A real command is typeset as one; the fallback is prose, not a command.
    expect(cells.map((c) => c.find('code').exists())).toEqual([
      true, true, false, true, true, true, false, true, false, true, false, false, true, false,
      true, false,
    ])

    expect(unexpectedWarnings(warn)).toEqual([])
  })

  it('translates the sign-in column under zh-TW', () => {
    i18n.global.locale.value = 'zh-TW'
    const wrapper = mountHelp()

    const table = wrapper.findAll('.cah-table').at(0)!
    expect(table.findAll('thead th').at(5)!.text()).toBe('登入指令')
    const rendered = table.findAll('tbody tr').map((row) => row.findAll('td').at(5)!.text())
    // Commands stay verbatim; only the fallback is prose and gets translated.
    expect(rendered.at(0)).toBe('claude auth login')
    expect(rendered.at(2)).toBe('在 CLI 內登入')
    expect(rendered.at(3)).toBe('grok login')

    expect(unexpectedWarnings(warn)).toEqual([])
  })

  it('injects the inline markup from the locale strings', () => {
    i18n.global.locale.value = 'en-US'
    const wrapper = mountHelp()

    expect(wrapper.findAll('kbd.cah-kbd').length).toBeGreaterThan(0)
    expect(wrapper.find('.cah-p strong').exists()).toBe(true)
    expect(wrapper.find('.cah-p code').exists()).toBe(true)
    expect(unexpectedWarnings(warn)).toEqual([])
  })
})

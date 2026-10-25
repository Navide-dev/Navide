import { describe, expect, it } from 'vitest'
import { i18n } from '@navide/plugin-ui/foundation'
import { pluginDisclosureTitle, pluginIconFallback } from '../pluginSourceMark'

// An icon-less plugin button used to show one fixed ◇, so two of them side by
// side (Mini-IDE and a local devmap in the v0.2.30 title bar) could only be
// told apart by hovering.
describe('pluginIconFallback', () => {
  it.each([
    ['Mini-IDE', 'M'],
    ['files', 'F'],
    ['ñandú', 'Ñ'],
    ['開發地圖', '開'],
    ['한국어', '한'],
  ])('shows the first character of %s', (title, glyph) => {
    expect(pluginIconFallback(title)).toBe(glyph)
  })

  it('keeps a surrogate-pair emoji whole', () => {
    expect(pluginIconFallback('🧭 Map')).toBe('🧭')
  })

  it('keeps a joined emoji sequence whole', () => {
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}'
    expect(pluginIconFallback(`${family} Family`)).toBe(family)
  })

  it('upper-cases only Latin letters', () => {
    expect(pluginIconFallback('αβ')).toBe('α')
  })

  it('skips leading spaces and invisible characters', () => {
    expect(pluginIconFallback(' ​⁦git')).toBe('G')
  })

  it('keeps ◇ for a title with nothing visible in it', () => {
    expect(pluginIconFallback('')).toBe('◇')
    expect(pluginIconFallback(' ​ ')).toBe('◇')
  })
})

describe('pluginDisclosureTitle', () => {
  const t = i18n.global.t as (key: string, params?: Record<string, unknown>) => string
  const withEnglish = (run: () => void) => {
    const saved = i18n.global.locale.value
    i18n.global.locale.value = 'en-US'
    try { run() } finally { i18n.global.locale.value = saved }
  }

  it('calls an unsigned package\'s publisher self-declared and names its source', () => {
    withEnglish(() => {
      expect(pluginDisclosureTitle(t, { title: '開發地圖', pluginId: 'nerdtechnic.devmap', source: 'local-unsigned' }))
        .toBe('Navide plugin: 開發地圖 · nerdtechnic.devmap · Publisher: Self-declared: nerdtechnic · Local file, not reviewed by Navide, unsigned')
    })
  })

  it('names a built-in package\'s publisher plainly', () => {
    withEnglish(() => {
      expect(pluginDisclosureTitle(t, { title: 'Mini-IDE', pluginId: 'navide.mini-ide', source: 'factory-bundled' }))
        .toBe('Navide plugin: Mini-IDE · navide.mini-ide · Publisher: navide · Built into Navide')
    })
  })

  it('treats a package without a known source as self-declared', () => {
    withEnglish(() => {
      expect(pluginDisclosureTitle(t, { title: 'Files', pluginId: 'acme.files' }))
        .toBe('Navide plugin: Files · acme.files · Publisher: Self-declared: acme')
    })
  })

  it('reveals invisible characters in the plugin\'s own text', () => {
    withEnglish(() => {
      expect(pluginDisclosureTitle(t, { title: 'Git‮', pluginId: 'acme.files' }))
        .toContain('Navide plugin: Git\\u{202e}')
    })
  })
})

// @vitest-environment happy-dom
// Native controls on the plugin pages follow the theme: a light theme must
// never get dark checkboxes (regression R1 of the Marketplace review).
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const read = (path: string) => readFileSync(join(root, path), 'utf8')
const tokens = [
  'packages/plugin-ui/src/foundation/styles/tokens/semantic.css',
  'packages/plugin-ui/src/foundation/styles/tokens/themes/light.css',
  'packages/plugin-ui/src/foundation/styles/tokens/themes/dark-midnight.css',
  'packages/plugin-ui/src/foundation/styles/tokens/themes/high-contrast.css',
].map(read).join('\n')

const SURFACES: Array<[string, string]> = [
  ['src/renderer/src/components/MarketplacePane.vue', 'marketplace-pane'],
  ['src/renderer/src/components/ExtensionsPane.vue', 'extensions-pane'],
  ['src/renderer/src/components/NativeBackendPanel.vue', 'native-backends'],
]

function colorSchemeOf(className: string): string {
  const el = document.createElement('div')
  el.className = className
  document.body.append(el)
  return getComputedStyle(el).colorScheme
}

describe('plugin pages follow the theme for native controls', () => {
  afterEach(() => {
    document.head.innerHTML = ''
    document.body.innerHTML = ''
    delete document.documentElement.dataset.theme
  })

  for (const [file, className] of SURFACES) {
    it(`${className} declares the theme's colour scheme, not a fixed one`, () => {
      const source = read(file)
      expect(source).toContain('color-scheme: var(--nv-color-scheme)')
      expect(source).not.toMatch(/color-scheme:\s*(dark|light)\b/)
    })
  }

  it('resolves to light under the light theme and dark under the dark ones', () => {
    const style = document.createElement('style')
    style.textContent = `${tokens}\n${SURFACES.map(([, c]) => `.${c}`).join(', ')} { color-scheme: var(--nv-color-scheme); }`
    document.head.append(style)

    document.documentElement.dataset.theme = 'light'
    for (const [, className] of SURFACES) expect(colorSchemeOf(className)).toBe('light')

    for (const theme of ['dark-github', 'dark-midnight', 'high-contrast']) {
      document.documentElement.dataset.theme = theme
      for (const [, className] of SURFACES) expect(colorSchemeOf(className)).toBe('dark')
    }
  })
})

// The Marketplace page follows the Appearance setting through design tokens:
// every token it reads must be defined under each built-in theme, or the
// page silently falls back to unstyled colours on that theme.
describe('Marketplace page tokens under every built-in theme', () => {
  const THEMES = ['dark-github', 'dark-midnight', 'dark-forest', 'light', 'high-contrast']
  const tokenDir = 'packages/plugin-ui/src/foundation/styles/tokens'
  const allTokens = [
    `${tokenDir}/base.css`,
    `${tokenDir}/semantic.css`,
    ...THEMES.filter((t) => t !== 'dark-github').map((t) => `${tokenDir}/themes/${t}.css`),
  ]
    .map(read)
    .join('\n')

  // Tokens read without a fallback by the Marketplace page's own styles.
  const used = [
    'src/renderer/src/components/MarketplacePane.vue',
    'src/renderer/src/components/MarketplaceScreenshot.vue',
  ].flatMap((file) => {
    const source = read(file)
    const style = source.slice(source.indexOf('<style'))
    return [...style.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)].map((m) => m[1])
  })
  const tokensUsed = [...new Set(used)].sort()

  afterEach(() => {
    document.head.innerHTML = ''
    delete document.documentElement.dataset.theme
  })

  function valueUnder(theme: string, token: string): string {
    document.documentElement.dataset.theme = theme
    return getComputedStyle(document.documentElement).getPropertyValue(token).trim()
  }

  it('reads tokens at all (the scan found the page styles)', () => {
    expect(tokensUsed.length).toBeGreaterThan(20)
    for (const key of ['--bg-subtle', '--accent-fg', '--risk-fg', '--trust-signed-fg', '--danger-bright', '--text-primary']) {
      expect(tokensUsed).toContain(key)
    }
  })

  for (const theme of THEMES) {
    it(`defines every token the page reads under ${theme}`, () => {
      const style = document.createElement('style')
      style.textContent = allTokens
      document.head.append(style)
      const missing = tokensUsed.filter((token) => valueUnder(theme, token) === '')
      expect(missing).toEqual([])
    })
  }

  it('changes the page colours with the theme', () => {
    const style = document.createElement('style')
    style.textContent = allTokens
    document.head.append(style)
    for (const token of ['--bg-subtle', '--text-primary', '--accent-fg']) {
      expect(valueUnder('light', token)).not.toBe(valueUnder('dark-github', token))
    }
  })
})

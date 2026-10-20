import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// docs/en-US/glossary.md: Navide's own packages are "Navide plugins" sold in the
// "Navide Marketplace"; an AI CLI's own add-ons are "CLI extensions". In the UI
// none of these words may stand alone, because each one already means
// something else to somebody: the CLIs call their own things plugins,
// extensions and marketplaces too.
const localeDirs = [
  'packages/plugin-ui/src/foundation/i18n/locales',
  'plugins/navide-plans/src/locales',
  'plugins/navide-browser/src/locales'
]

const TERMS: Record<string, RegExp> = {
  'en-US': /\b(?:plugins?|extensions?|marketplaces?)\b/gi,
  'zh-TW': /外掛|擴充|插件|市集/g,
  'ja-JP': /プラグイン|拡張(?!子)|マーケット(?:プレイス)?/g
}

// A term is qualified when it directly follows one of these.
const QUALIFIERS = [
  'Navide', 'CLI', 'Claude', 'Codex', 'Copilot', 'Cursor', 'Grok', 'Droid', 'Kimi', 'Kilo',
  'Muse', 'MiniMax', 'Antigravity', 'opencode', 'OpenCode', 'Pi', 'Qwen'
]

// Words that are never right, prefix or not.
const BANNED: Record<string, RegExp> = {
  'zh-TW': /插件|外掛程式|擴充功能/g,
  'en-US': /\bextension packs?\b/gi,
  'ja-JP': /拡張機能/g
}

// Legitimate uses that are not about either kind of package.
const ALLOWED_PHRASES = [/\bfile extensions?\b/gi]

// The one exception (the user's call, 2026-10-11): the Settings page listing
// CLI extensions is named "Extensions" on its own. Its name may stand bare as
// the page's label and search title, and when prose points at that page.
const CLI_EXTENSIONS_PAGE: Record<string, string> = { 'en-US': 'Extensions', 'zh-TW': '擴充', 'ja-JP': '拡張機能' }
const CLI_EXTENSIONS_PAGE_KEYS = ['settings.nav.cliExtensions', 'settings.search.item.cliExtensions.title']
const CLI_EXTENSIONS_PAGE_REF: Record<string, RegExp> = {
  'en-US': /\bSettings → Extensions\b/g,
  'zh-TW': /「設定 → 擴充」/g,
  'ja-JP': /「設定 → 拡張機能」/g
}

function leaves(value: unknown, prefix = ''): Array<[string, string]> {
  if (typeof value === 'string') return [[prefix, value]]
  if (!value || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, child]) => leaves(child, prefix ? `${prefix}.${key}` : key))
}

function prose(text: string): string {
  let out = text
    .replace(/<code>[\s\S]*?<\/code>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/[^\s<>\u0080-\uffff]*[/\\][^\s<>\u0080-\uffff]*/g, ' ') // paths and URLs
  for (const phrase of ALLOWED_PHRASES) out = out.replace(phrase, ' ')
  return out
}

function violations(locale: string, text: string, key = ''): string[] {
  if (CLI_EXTENSIONS_PAGE_KEYS.includes(key) && text === CLI_EXTENSIONS_PAGE[locale]) return []
  const body = prose(text).replace(CLI_EXTENSIONS_PAGE_REF[locale], ' ')
  const found: string[] = []
  for (const match of body.matchAll(BANNED[locale])) found.push(`banned "${match[0]}"`)
  for (const match of body.matchAll(TERMS[locale])) {
    const before = body.slice(0, match.index).trimEnd()
    if (!QUALIFIERS.some((qualifier) => before.endsWith(qualifier))) found.push(`bare "${match[0]}"`)
  }
  return found
}

describe('glossary: plugin, extension and marketplace terms always carry a prefix', () => {
  for (const dir of localeDirs) {
    const files = readdirSync(resolve(dir)).filter((name) => /^(en-US|zh-TW|ja-JP)\.json$/.test(name))
    it.each(files)(`${dir}/%s`, (fileName) => {
      const locale = fileName.replace(/\.json$/, '')
      const strings = leaves(JSON.parse(readFileSync(resolve(dir, fileName), 'utf8')))
      const problems = strings.flatMap(([key, text]) =>
        violations(locale, text, key).map((problem) => `${key}: ${problem} in "${text.slice(0, 80)}"`)
      )
      expect(problems, problems.join('\n')).toEqual([])
    })
  }

  it('accepts qualified terms and file extensions', () => {
    expect(violations('en-US', 'Install a Navide plugin from the Navide Marketplace')).toEqual([])
    expect(violations('en-US', 'Decided from its file extension alone')).toEqual([])
    expect(violations('zh-TW', '第三方 Navide 外掛與 CLI 擴充')).toEqual([])
    expect(violations('en-US', 'Allow third-party extensions')).toEqual(['bare "extensions"'])
    expect(violations('ja-JP', '拡張子と Navide プラグイン')).toEqual([])
  })

  it('lets the CLI extensions page, and nothing else, carry its bare name', () => {
    expect(violations('en-US', 'Extensions', 'settings.nav.cliExtensions')).toEqual([])
    expect(violations('zh-TW', '擴充', 'settings.search.item.cliExtensions.title')).toEqual([])
    expect(violations('ja-JP', '拡張機能', 'settings.nav.cliExtensions')).toEqual([])
    expect(violations('en-US', 'the same inventory Settings → Extensions shows')).toEqual([])
    expect(violations('zh-TW', '跟「設定 → 擴充」看到的是同一份')).toEqual([])
    expect(violations('en-US', 'Extensions', 'settings.nav.extensions')).toEqual(['bare "Extensions"'])
    expect(violations('ja-JP', '拡張機能', 'settings.nav.marketplace')).toContain('banned "拡張機能"')
    expect(violations('zh-TW', '安裝擴充')).toEqual(['bare "擴充"'])
  })

  it('rejects bare and banned terms', () => {
    expect(violations('en-US', 'Restart Plugin')).toEqual(['bare "Plugin"'])
    expect(violations('zh-TW', '此插件')).toContain('banned "插件"')
    expect(violations('ja-JP', 'マーケットプレイス')).toEqual(['bare "マーケットプレイス"'])
  })
})

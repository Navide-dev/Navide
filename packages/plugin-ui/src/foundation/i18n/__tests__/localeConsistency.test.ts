import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AVAILABLE_UI_LOCALES } from '../index'

// Per-message checks of every translated catalog against en-US. Key parity
// (locales.test) says a translation exists; these say it still works: the
// same placeholders and linked messages, the same markup, and the number of
// plural forms the locale's rule reads (uiLocales.ts UI_PLURAL_RULES). For
// ko-KR these were checked by a script outside the repo; six more languages
// are coming, so they are tests now.
const localeDirs = [
  'packages/plugin-ui/src/foundation/i18n/locales',
  'plugins/navide-plans/src/locales',
  'plugins/navide-browser/src/locales'
]

// Where each catalog folder is registered, for the "a file is a registered
// language" check. The host's registry is AVAILABLE_UI_LOCALES itself.
const pluginRegistries: Record<string, string> = {
  'plugins/navide-plans/src/locales': 'plugins/navide-plans/src/plansI18n.ts',
  'plugins/navide-browser/src/locales': 'plugins/navide-browser/src/browserI18n.ts'
}

// Locales translated after this check existed: their catalogs must not carry
// English text that was simply left in place (see untranslated below).
const NEW_LOCALES = ['es-ES', 'fr-FR', 'de-DE', 'pt-BR', 'ru-RU', 'vi-VN']

// Words a translation keeps in English (docs/en-US/glossary.md "What stays",
// RESEARCH-i18n-native-conventions decisions): a value made only of these,
// placeholders, numbers and punctuation may equal the en-US one.
const KEEP_ENGLISH = new Set(
  [
    'Navide', 'AI', 'agent', 'agents', 'Agent', 'Agents', 'pane', 'panes', 'Pane', 'Panes', 'CLI', 'CLIs',
    'MCP', 'API', 'APIs', 'URL', 'URLs', 'ID', 'IDs', 'JSON', 'YAML', 'HTML', 'CSS', 'SSH', 'HTTP', 'HTTPS',
    'Git', 'GitHub', 'GitLab', 'git', 'commit', 'Commit', 'branch', 'Branch', 'push', 'Push', 'pull', 'Pull',
    'merge', 'Merge', 'rebase', 'Rebase', 'stash', 'Stash', 'diff', 'Diff', 'token', 'tokens', 'Token', 'Tokens',
    'prompt', 'Prompt', 'skill', 'skills', 'Skill', 'Skills', 'Plan', 'Plans', 'Registry', 'Testplace', 'Beta',
    'Claude', 'Codex', 'Gemini', 'OpenCode', 'Cursor', 'Telegram', 'Discord', 'Slack', 'LINE', 'macOS', 'Windows',
    'Linux', 'OK', 'PDF', 'PNG', 'SVG', 'Markdown', 'Mermaid', 'Shift', 'Ctrl', 'Alt', 'Cmd', 'Tab', 'Esc', 'Enter'
  ]
)

const UNTRANSLATED_ALLOWLIST: Record<string, string[]> = JSON.parse(
  readFileSync(resolve('packages/plugin-ui/src/foundation/i18n/__tests__/untranslatedAllowlist.json'), 'utf8')
)

// Whether an en-US value is a name, path, branch, version or command that a
// translation keeps as is — not English left behind. Deliberately narrow:
// anything that could be a word ("save", "Saving…", "Re-detect", "STAGED",
// "{count} files") is prose and gets the word check.
const ANY_SPACE = /[\s\u00A0\u2000-\u200B\u202F\u205F\u3000]/
// Sample values the help pages show (a branch, two project folders); a plain
// lowercase word cannot be told from one by its shape.
const SAMPLE_VALUES = new Set(['main', 'my-project', 'navide-web'])

export function isValueToken(token: string): boolean {
  if (!token || ANY_SPACE.test(token) || /\{[^{}]*\}/.test(token)) return false
  if (SAMPLE_VALUES.has(token)) return true
  // Sentence punctuation is not a value marker: "Cancelled." "Unbind?" "Loading…"
  const bare = token.replace(/[…:.?!]+$/, '')
  if (bare !== token && !/[0-9./_~*<]/.test(bare)) return false
  if (/^[A-Z]{1,5}$/.test(bare)) return true
  return /[0-9./_~*<]/.test(bare) || bare.startsWith('-')
}

export function isValue(text: string): boolean {
  const t = withoutLiterals(text).trim()
  // Exactly one <code> span and nothing else: a value only if what it quotes is one.
  const code = /^<code>([^<]*)<\/code>$/.exec(t)
  return isValueToken(code ? code[1].trim() : t)
}

function leaves(value: unknown, prefix = ''): Array<[string, string]> {
  if (typeof value === 'string') return [[prefix, value]]
  if (!value || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, child]) => leaves(child, prefix ? `${prefix}.${key}` : key))
}

function catalog(dir: string, locale: string): Map<string, string> {
  return new Map(leaves(JSON.parse(readFileSync(resolve(dir, `${locale}.json`), 'utf8'))))
}

function localesIn(dir: string): string[] {
  return readdirSync(resolve(dir))
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.replace(/\.json$/, ''))
    .sort()
}

// {'|'} {'{'} {'@'} and the like are literal characters, not placeholders.
const withoutLiterals = (text: string): string => text.replace(/\{'[^']*'\}/g, '')

// Compared as sets: each plural form repeats its placeholders, and a locale
// with fewer forms (ja, ko, zh) repeats them fewer times.
const distinct = (items: string[]): string[] => [...new Set(items)].sort()

function placeholders(text: string): string[] {
  return distinct([...withoutLiterals(text).matchAll(/\{\s*([^{}\s]+)\s*\}/g)].map((m) => m[1]))
}

function linked(text: string): string[] {
  return distinct([...withoutLiterals(text).matchAll(/@(?:\.\w+)?:[\w.\-]+/g)].map((m) => m[0]))
}

// HTML only: `<pane name>` is a literal placeholder for the reader, and a
// translation renders it in its own language.
const HTML_TAGS = new Set([
  'a', 'b', 'br', 'code', 'div', 'em', 'i', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 's', 'small', 'span',
  'strong', 'sub', 'sup', 'u', 'ul'
])

const ITALICS = new Set(['em', 'i'])

// Existing translations that quote two button names where en-US bolds them
// (zh-TW 「…」, zh-CN “…”): only <strong> is waived, and only for this key.
const MARKUP_EXCEPTIONS: Record<string, Record<string, string[]>> = {
  'zh-TW': { 'settings.help.crossPlatform.s1.callout.text': ['strong', '/strong'] },
  'zh-CN': { 'settings.help.crossPlatform.s1.callout.text': ['strong', '/strong'] }
}

function tags(text: string): string[] {
  return distinct(
    [...text.matchAll(/<(\/?)([a-zA-Z][\w-]*)\b[^>]*>/g)]
      .filter((m) => HTML_TAGS.has(m[2].toLowerCase()))
      .map((m) => `${m[1]}${m[2].toLowerCase()}`)
  )
}

function pluralForms(text: string): number {
  return withoutLiterals(text).replace(/\{[^{}]*\}/g, '').split('|').length
}

/** Form counts a translation may have for an en-US message with `enForms` forms. */
function expectedForms(locale: string, enForms: number): number[] {
  // uiLocales.ts russianPluralIndex: one|other → one|few|many, zero|one|other → zero|one|few|many.
  if (locale === 'ru-RU') return [enForms + 1]
  // A language with no singular (CLDR has only "other": ja, ko, zh, vi) may
  // say it once, or keep en-US's forms with the same text.
  if (!new Intl.PluralRules(locale).resolvedOptions().pluralCategories.includes('one')) return [1, enForms]
  return [enForms]
}

describe('translated catalogs keep each message working', () => {
  for (const dir of localeDirs) {
    const en = catalog(dir, 'en-US')
    for (const locale of localesIn(dir).filter((name) => name !== 'en-US')) {
      describe(`${dir}/${locale}`, () => {
        const translated = catalog(dir, locale)
        const mismatches = (check: (text: string) => unknown): string[] =>
          [...en].flatMap(([key, enText]) => {
            const text = translated.get(key)
            if (text === undefined) return []
            const want = JSON.stringify(check(enText))
            const got = JSON.stringify(check(text))
            return want === got ? [] : [`${key}: en-US ${want}, ${locale} ${got}`]
          })

        it('has the same placeholders as en-US', () => {
          const bad = mismatches(placeholders)
          expect(bad, bad.join('\n')).toEqual([])
        })

        it('has the same linked messages as en-US', () => {
          const bad = mismatches(linked)
          expect(bad, bad.join('\n')).toEqual([])
        })

        it('keeps the markup en-US has', () => {
          // A translation may add emphasis, and may render italics its own way
          // (zh-TW quotes 「…」 instead of <em>); it must not drop a link,
          // code, strong text or any other tag.
          const bad = [...en].flatMap(([key, enText]) => {
            const text = translated.get(key)
            if (text === undefined) return []
            const have = new Set(tags(text))
            const waived = MARKUP_EXCEPTIONS[locale]?.[key] ?? []
            const missing = tags(enText).filter(
              (tag) => !ITALICS.has(tag.replace('/', '')) && !waived.includes(tag) && !have.has(tag)
            )
            return missing.length ? [`${key}: missing ${missing.join(' ')}`] : []
          })
          expect(bad, bad.join('\n')).toEqual([])
        })

        const exceptionsHere = Object.entries(MARKUP_EXCEPTIONS[locale] ?? {}).filter(([key]) => en.has(key))
        if (exceptionsHere.length) {
          it('still needs each markup exception', () => {
            // An exception the catalog no longer needs must be deleted, not kept forever.
            for (const [key, waived] of exceptionsHere) {
              const have = new Set(tags(translated.get(key) ?? ''))
              expect(waived.some((tag) => tags(en.get(key) ?? '').includes(tag) && !have.has(tag)), key).toBe(true)
            }
          })
        }

        it('has the plural forms its plural rule reads', () => {
          const bad = [...en].flatMap(([key, enText]) => {
            const text = translated.get(key)
            const enForms = pluralForms(enText)
            if (text === undefined || enForms < 2) return []
            const want = expectedForms(locale, enForms)
            const got = pluralForms(text)
            return want.includes(got) ? [] : [`${key}: ${got} forms, expected ${want.join(' or ')} (en-US has ${enForms})`]
          })
          expect(bad, bad.join('\n')).toEqual([])
        })

        if (NEW_LOCALES.includes(locale)) {
          it('leaves no English text in place', () => {
            const allowed = new Set(UNTRANSLATED_ALLOWLIST[locale] ?? [])
            const bad = [...en].flatMap(([key, enText]) => {
              if (translated.get(key) !== enText || allowed.has(key) || isValue(enText)) return []
              const words = withoutLiterals(enText)
                .replace(/\{[^{}]*\}/g, ' ')
                .replace(/<[^>]*>/g, ' ')
                .match(/[A-Za-z][A-Za-z'’-]*/g) ?? []
              return words.every((word) => KEEP_ENGLISH.has(word)) ? [] : [key]
            })
            expect(bad, `same as en-US: ${bad.join(', ')}`).toEqual([])
          })
        }
      })
    }
  }
})

describe('every catalog file is a registered language', () => {
  it('in the host', () => {
    expect([...AVAILABLE_UI_LOCALES].sort()).toEqual(localesIn(localeDirs[0]))
  })

  it.each(Object.entries(pluginRegistries))('in %s', (dir, registry) => {
    const source = readFileSync(resolve(registry), 'utf8')
    const block = source.slice(source.indexOf('_MESSAGES = {'), source.indexOf('}', source.indexOf('_MESSAGES = {')))
    const registered = [...block.matchAll(/'([a-z]{2}-[A-Z]{2})':/g)].map((m) => m[1]).sort()
    expect(registered).toEqual(localesIn(dir))
  })
})

describe('isValue: what the untranslated check may skip', () => {
  it.each([
    ['main', true], ['my-project', true], ['navide-web', true], ['v0.2.0', true], ['README.md', true],
    ['--flag', true], ['~/.codex-panes/', true], ['Node.js', true], ['<code>git status --short</code>', false],
    ['<code>~/.claude</code>', true], ['OK', true], ['API', true],
    // Prose the review found exempted by the earlier rule: every one must be checked.
    ['Save', false], ['Save…', false], ['save', false], ['Saving…', false], ['Loading…', false],
    ['Cancelled.', false], ['Unbind?', false], ['Testing:', false], ['(optional)', false],
    ['{count} files', false], ['until {date}', false], ['Status: {status}', false], ['{pct} left', false],
    ['running', false], ['failed', false], ['memory', false], ['Re-detect', false], ['Built-in', false],
    ['read-only', false], ['STAGED', false], ['CONFLICT', false], ['Save\u00a0all', false],
    ['<code>Save your changes now</code>', false], ['<code>a</code> Click here to continue <code>b</code>', false],
  ])('%s → value: %s', (text, expected) => {
    expect(isValue(text)).toBe(expected)
  })
})

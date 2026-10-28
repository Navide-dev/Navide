import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { UI_LOCALES } from '../uiLocales'

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

// A term is qualified when one of these sits next to it (where depends on the
// locale, see Position).
const QUALIFIERS = [
  'Navide', 'CLI', 'Claude', 'Codex', 'Copilot', 'Cursor', 'Grok', 'Droid', 'Kimi', 'Kilo',
  'Muse', 'MiniMax', 'Antigravity', 'opencode', 'OpenCode', 'Pi', 'Qwen'
]

// Where the qualifier goes relative to the term:
//   before  "Navide plugin", "Navide 外掛", "CLI 확장", "Navide Marketplace"
//   after   "complemento de Navide", "plugin Navide", "расширение CLI"
//           (optionally through one of the locale's connector words)
//   hyphen  "Navide-Plug-in", "CLI-Erweiterung"
type Position = 'before' | 'after' | 'hyphen'

interface TermRule {
  pattern: RegExp
  positions: Position[]
  /** Narrower qualifier list for this term (default: QUALIFIERS). */
  qualifiers?: string[]
}

interface LocaleRules {
  /** Words that must always carry a qualifier. */
  terms: TermRule[]
  /** Words that are never right, qualifier or not. */
  banned: RegExp[]
  /** Legitimate uses that are not about either kind of package ("file extension"). */
  allowed: RegExp[]
  /** Connector words allowed between a term and an `after` qualifier. */
  connectors?: string[]
  /** The Settings page listing CLI extensions, and prose pointing at it. */
  page: { name: string; ref: RegExp }
}

// Matching is Unicode-safe: text and patterns are NFC-normalized, and word
// boundaries are "no letter, digit or underscore next to it" in any script
// (`\b` only knows ASCII, so it splits "extensão" and "плагин"; the underscore
// keeps identifiers such as AGENT_TEAM_MARKETPLACE_URL out, as `\b` did).
// Scripts without spaces (zh, ja, ko — Korean attaches particles to the noun)
// match unbounded.
const B = '(?<![\\p{L}\\p{N}_])'
const E = '(?![\\p{L}\\p{N}_])'
const word = (source: string, flags = 'giu'): RegExp => new RegExp(`${B}(?:${source})${E}`.normalize('NFC'), flags)
const bare = (source: string, flags = 'gu'): RegExp => new RegExp(source.normalize('NFC'), flags)
const pageRef = (name: string): RegExp => word(`→\\s*${name}`, 'gu')

const RULES: Record<string, LocaleRules> = {
  'en-US': {
    terms: [{ pattern: word('plugins?|extensions?|marketplaces?'), positions: ['before'] }],
    banned: [word('extension packs?')],
    allowed: [word('file extensions?')],
    page: { name: 'Extensions', ref: word('Settings → Extensions', 'gu') }
  },
  'zh-TW': {
    terms: [{ pattern: bare('外掛|擴充|插件|市集'), positions: ['before'] }],
    banned: [bare('插件|外掛程式|擴充功能')],
    allowed: [],
    page: { name: '擴充', ref: bare('「設定 → 擴充」') }
  },
  'ja-JP': {
    terms: [{ pattern: bare('プラグイン|拡張(?!子)|マーケット(?:プレイス)?'), positions: ['before'] }],
    banned: [bare('拡張機能')],
    allowed: [],
    page: { name: '拡張機能', ref: bare('「設定 → 拡張機能」') }
  },
  'zh-CN': {
    terms: [
      { pattern: bare('插件'), positions: ['before'], qualifiers: ['Navide'] },
      { pattern: bare('扩展(?!名)|市场'), positions: ['before'] }
    ],
    banned: [bare('外挂|扩展程序')],
    allowed: [],
    page: { name: '扩展', ref: pageRef('扩展') }
  },
  'ko-KR': {
    // 확장 also means "expand"; UI "expand" is 펼치기, so a bare 확장 is wrong
    // either way. 확장자 is "file extension".
    terms: [{ pattern: bare('플러그인|확장(?!자)|마켓(?:플레이스)?'), positions: ['before'] }],
    banned: [],
    allowed: [],
    page: { name: '확장', ref: pageRef('확장') }
  },
  'es-ES': {
    terms: [
      { pattern: word('complementos?|extensi(?:ón|ones)'), positions: ['after'] },
      { pattern: word('marketplaces?'), positions: ['before'] }
    ],
    banned: [word('suplementos?|add-?ons?|paquetes? de extensiones')],
    allowed: [word('extensi(?:ón|ones) de archivos?')],
    connectors: ['de'],
    page: { name: 'Extensiones', ref: pageRef('Extensiones') }
  },
  'fr-FR': {
    terms: [
      // "before" admits the vendor badge "Claude plugin", kept in English.
      { pattern: word('plugins?'), positions: ['after', 'before'] },
      { pattern: word('extensions?'), positions: ['after'] },
      { pattern: word('marketplaces?'), positions: ['after', 'before'] }
    ],
    // The user's decision: French UI says IA, never AI (case-sensitive, so "j’ai" passes).
    banned: [word('modules? complémentaires?|compléments?|greffons?|plugiciels?'), word('AI', 'gu')],
    allowed: [word('extensions? de fichiers?')],
    page: { name: 'Extensions', ref: pageRef('Extensions') }
  },
  'de-DE': {
    terms: [
      { pattern: word('plug-?ins?'), positions: ['hyphen', 'before'] },
      { pattern: word('erweiterung(?:en)?'), positions: ['hyphen'] },
      // The German noun counts too: a bare "Marktplatz" is the Marketplace unqualified.
      { pattern: word('marketplaces?|marktpl(?:atz|ätze)'), positions: ['before'] }
    ],
    banned: [word('add-?ons?|erweiterungspakete?')],
    allowed: [],
    page: { name: 'Erweiterungen', ref: pageRef('Erweiterungen') }
  },
  'pt-BR': {
    terms: [
      { pattern: word('plug-?ins?|extens(?:ão|ões)'), positions: ['after'] },
      { pattern: word('marketplaces?'), positions: ['before'] }
    ],
    banned: [word('complementos?|suplementos?|add-?ons?|pacotes? de extensões')],
    allowed: [word('extens(?:ão|ões) de arquivos?')],
    connectors: ['do', 'de'],
    page: { name: 'Extensões', ref: pageRef('Extensões') }
  },
  'ru-RU': {
    terms: [
      { pattern: word('плагин(?:а|у|ом|е|ы|ов|ам|ами|ах)?|расширени(?:е|я|ю|ем|и|й|ям|ями|ях)'), positions: ['after'] },
      { pattern: word('marketplaces?'), positions: ['before'] }
    ],
    banned: [word('аддон(?:а|у|ом|е|ы|ов|ам|ами|ах)?|надстройк(?:а|и|е|у|ой|ам|ами|ах)?')],
    allowed: [word('расширени(?:е|я|ю|ем|и|й|ям|ями|ях) файл(?:а|ов)?')],
    page: { name: 'Расширения', ref: pageRef('Расширения') }
  },
  'vi-VN': {
    terms: [
      { pattern: word('plugins?'), positions: ['after', 'before'] },
      { pattern: word('tiện ích mở rộng'), positions: ['after'] },
      { pattern: word('marketplaces?'), positions: ['before'] }
    ],
    banned: [word('add-?ons?')],
    allowed: [],
    page: { name: 'Tiện ích mở rộng', ref: pageRef('Tiện ích mở rộng') }
  }
}

// The one exception (the user's call, 2026-10-11): the Settings page listing
// CLI extensions is named "Extensions" on its own. Its name may stand bare as
// the page's label and search title, and when prose points at that page:
// "Settings → Extensions", or help prose quoting the label as <em>Extensions</em>.
const CLI_EXTENSIONS_PAGE_KEYS = ['settings.nav.cliExtensions', 'settings.search.item.cliExtensions.title']

function leaves(value: unknown, prefix = ''): Array<[string, string]> {
  if (typeof value === 'string') return [[prefix, value]]
  if (!value || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, child]) => leaves(child, prefix ? `${prefix}.${key}` : key))
}

function prose(text: string, rules: LocaleRules): string {
  let out = text
    .replace(/<code>[\s\S]*?<\/code>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/[^\s<>\u0080-￿]*[/\\][^\s<>\u0080-￿]*/g, ' ') // paths and URLs
  for (const phrase of rules.allowed) out = out.replace(phrase, ' ')
  return out
}

const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function qualified(body: string, start: number, end: number, rule: TermRule, rules: LocaleRules): boolean {
  const qualifiers = rule.qualifiers ?? QUALIFIERS
  const before = body.slice(0, start)
  return rule.positions.some((position) => {
    if (position === 'before') return qualifiers.some((q) => before.trimEnd().endsWith(q))
    if (position === 'hyphen') return before.endsWith('-') && qualifiers.some((q) => before.slice(0, -1).endsWith(q))
    const connectors = (rules.connectors ?? []).map(escape).join('|')
    const after = new RegExp(
      `^\\s+(?:(?:${connectors || '(?!)'})\\s+)?(?:${qualifiers.map(escape).join('|')})${E}`,
      'u'
    )
    return after.test(body.slice(end))
  })
}

function violations(locale: string, text: string, key = ''): string[] {
  const rules = RULES[locale]
  if (!rules) throw new Error(`no glossary rules for locale "${locale}": add them to RULES in glossary.test.ts`)
  const normalized = text.normalize('NFC')
  if (CLI_EXTENSIONS_PAGE_KEYS.includes(key) && normalized === rules.page.name.normalize('NFC')) return []
  const quoted = new RegExp(`<em>${escape(rules.page.name.normalize('NFC'))}</em>`, 'gu')
  const body = prose(normalized.replace(quoted, ' '), rules).replace(rules.page.ref, ' ')
  const found: string[] = []
  for (const banned of rules.banned) for (const match of body.matchAll(banned)) found.push(`banned "${match[0]}"`)
  for (const rule of rules.terms) {
    for (const match of body.matchAll(rule.pattern)) {
      const start = match.index ?? 0
      if (!qualified(body, start, start + match[0].length, rule, rules)) found.push(`bare "${match[0]}"`)
    }
  }
  return found
}

const localeFiles = (dir: string): string[] => readdirSync(resolve(dir)).filter((name) => name.endsWith('.json'))
const readStrings = (dir: string, fileName: string): Array<[string, string]> =>
  leaves(JSON.parse(readFileSync(resolve(dir, fileName), 'utf8')))

describe('glossary: plugin, extension and marketplace terms always carry a prefix', () => {
  it('has a rule set for every UI locale, and only those', () => {
    expect(Object.keys(RULES).sort()).toEqual([...UI_LOCALES].sort())
  })

  for (const dir of localeDirs) {
    // Every locale file present is checked; one without a rule set fails here.
    it.each(localeFiles(dir))(`${dir}/%s`, (fileName) => {
      const locale = fileName.replace(/\.json$/, '')
      expect(RULES[locale], `no glossary rules for ${dir}/${fileName}: add a RULES entry`).toBeDefined()
      const problems = readStrings(dir, fileName).flatMap(([key, text]) =>
        violations(locale, text, key).map((problem) => `${key}: ${problem} in "${text.slice(0, 80)}"`)
      )
      expect(problems, problems.join('\n')).toEqual([])
    })
  }

  it('fails loudly for a locale without rules', () => {
    expect(() => violations('it-IT', 'plugin')).toThrow(/no glossary rules for locale "it-IT"/)
  })

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
    expect(violations('en-US', '<em>Memory</em> and <em>Extensions</em> are listed')).toEqual([])
    expect(violations('ja-JP', '<em>メモリ</em>と<em>拡張機能</em>の行')).toEqual([])
    expect(violations('en-US', 'Extensions are listed')).toEqual(['bare "Extensions"'])
    expect(violations('en-US', 'Extensions', 'settings.nav.extensions')).toEqual(['bare "Extensions"'])
    expect(violations('ja-JP', '拡張機能', 'settings.nav.marketplace')).toContain('banned "拡張機能"')
    expect(violations('zh-TW', '安裝擴充')).toEqual(['bare "擴充"'])
  })

  it('rejects bare and banned terms', () => {
    expect(violations('en-US', 'Restart Plugin')).toEqual(['bare "Plugin"'])
    expect(violations('zh-TW', '此插件')).toContain('banned "插件"')
    expect(violations('ja-JP', 'マーケットプレイス')).toEqual(['bare "マーケットプレイス"'])
    expect(violations('en-US', 'Install an extension pack')).toEqual(['banned "extension pack"', 'bare "extension"'])
    expect(violations('zh-TW', 'Navide 外掛程式')).toEqual(['banned "外掛程式"'])
    expect(violations('ja-JP', '拡張を入れる')).toEqual(['bare "拡張"'])
    expect(violations('en-US', 'Claude plugin, Codex hook')).toEqual([])
  })

  it.each([
    ['zh-CN', '安装 Navide 插件，浏览 Navide 市场，管理 CLI 扩展和扩展名'],
    ['ko-KR', 'Navide 플러그인을 Navide 마켓플레이스에서 설치하고 CLI 확장과 에이전트 자산을 펼치기'],
    ['es-ES', 'Instala un complemento de Navide desde Navide Marketplace; la extensión de CLI y la extensión de archivo'],
    ['fr-FR', 'Installer un plugin Navide depuis la Marketplace Navide ou le Navide Marketplace, une extension CLI, une extension de fichier, un Claude plugin'],
    ['de-DE', 'Navide-Plug-ins aus dem Navide Marketplace, CLI-Erweiterungen, die Dateiendung, ein Claude plugin'],
    ['pt-BR', 'Instale um plug-in do Navide no Navide Marketplace; a extensão de CLI e a extensão de arquivo'],
    ['ru-RU', 'Установите плагин Navide из Navide Marketplace; плагины Navide, плагином Navide, расширения CLI, расширением CLI, расширение файла'],
    ['vi-VN', 'Cài plugin Navide từ Navide Marketplace, tiện ích mở rộng CLI, Claude plugin']
  ])('%s: accepts the approved terms', (locale, text) => {
    expect(violations(locale, text)).toEqual([])
  })

  it.each([
    ['zh-CN', '安装插件', ['bare "插件"']],
    ['zh-CN', 'CLI 插件', ['bare "插件"']],
    ['zh-CN', '外挂与扩展程序', ['banned "外挂"', 'banned "扩展程序"', 'bare "扩展"']],
    ['zh-CN', '打开市场', ['bare "市场"']],
    ['ko-KR', '플러그인 설치', ['bare "플러그인"']],
    ['ko-KR', '모두 확장하기', ['bare "확장"']],
    ['ko-KR', '마켓플레이스', ['bare "마켓플레이스"']],
    ['es-ES', 'Instala un complemento', ['bare "complemento"']],
    ['es-ES', 'un suplemento o add-on', ['banned "suplemento"', 'banned "add-on"']],
    ['es-ES', 'un paquete de extensiones', ['banned "paquete de extensiones"', 'bare "extensiones"']],
    ['es-ES', 'Navide complemento', ['bare "complemento"']],
    ['fr-FR', 'un module complémentaire', ['banned "module complémentaire"']],
    ['fr-FR', 'un greffon, un plugiciel, un complément', ['banned "greffon"', 'banned "plugiciel"', 'banned "complément"']],
    ['fr-FR', 'Activer les extensions', ['bare "extensions"']],
    ['fr-FR', 'Expliquer avec l’AI', ['banned "AI"']],
    ['de-DE', 'Plug-in installieren', ['bare "Plug-in"']],
    ['de-DE', 'Erweiterung und Add-on', ['banned "Add-on"', 'bare "Erweiterung"']],
    ['de-DE', 'ein Erweiterungspaket', ['banned "Erweiterungspaket"']],
    ['de-DE', 'Im Marktplatz suchen', ['bare "Marktplatz"']],
    ['pt-BR', 'um complemento ou suplemento', ['banned "complemento"', 'banned "suplemento"']],
    ['pt-BR', 'um pacote de extensões', ['banned "pacote de extensões"', 'bare "extensões"']],
    ['pt-BR', 'Instalar extensão', ['bare "extensão"']],
    ['ru-RU', 'Установить плагин', ['bare "плагин"']],
    ['ru-RU', 'аддон или надстройка', ['banned "аддон"', 'banned "надстройка"']],
    ['ru-RU', 'Включить расширения', ['bare "расширения"']],
    ['vi-VN', 'Cài plugin', ['bare "plugin"']],
    ['vi-VN', 'Cài add-on', ['banned "add-on"']],
    ['vi-VN', 'Bật tiện ích mở rộng', ['bare "tiện ích mở rộng"']]
  ] as const)('%s: flags %s', (locale, text, expected) => {
    expect(violations(locale, text)).toEqual(expected)
  })

  it.each([
    ['zh-CN', '扩展'],
    ['ko-KR', '확장'],
    ['es-ES', 'Extensiones'],
    ['fr-FR', 'Extensions'],
    ['de-DE', 'Erweiterungen'],
    ['pt-BR', 'Extensões'],
    ['ru-RU', 'Расширения'],
    ['vi-VN', 'Tiện ích mở rộng']
  ])('%s: the CLI extensions page may be named %s', (locale, name) => {
    expect(violations(locale, name, 'settings.nav.cliExtensions')).toEqual([])
    expect(violations(locale, `Mở → ${name}`)).toEqual([])
    expect(violations(locale, name, 'settings.nav.extensions')).not.toEqual([])
  })

  describe('Unicode-safe matching', () => {
    it('matches accented Latin and Cyrillic words whole, case-insensitively', () => {
      expect(violations('pt-BR', 'EXTENSÃO e extensões')).toEqual(['bare "EXTENSÃO"', 'bare "extensões"'])
      expect(violations('ru-RU', 'ПЛАГИН')).toEqual(['bare "ПЛАГИН"'])
      expect(violations('ru-RU', 'Плагины Navide')).toEqual([])
    })

    it('matches Vietnamese in both NFC and NFD input', () => {
      const nfc = 'Bật tiện ích mở rộng'.normalize('NFC')
      const nfd = nfc.normalize('NFD')
      expect(nfd).not.toBe(nfc)
      expect(violations('vi-VN', nfc)).toEqual(['bare "tiện ích mở rộng"'])
      expect(violations('vi-VN', nfd)).toEqual(['bare "tiện ích mở rộng"'])
      expect(violations('vi-VN', 'tiện ích mở rộng CLI'.normalize('NFD'))).toEqual([])
    })

    it('reads German hyphen compounds', () => {
      expect(violations('de-DE', 'Navide-Plug-in')).toEqual([])
      expect(violations('de-DE', 'CLI-Erweiterungen')).toEqual([])
      expect(violations('de-DE', 'Foo-Erweiterung')).toEqual(['bare "Erweiterung"'])
    })

    it('does not match a term or banned word inside a longer word', () => {
      expect(violations('fr-FR', 'des informations complémentaires')).toEqual([])
      expect(violations('pt-BR', 'para complementar o texto')).toEqual([])
      expect(violations('de-DE', 'die Browsererweiterung')).toEqual([])
      expect(violations('ru-RU', 'плагиновый')).toEqual([])
      expect(violations('en-US', 'Unpluginable')).toEqual([])
    })
  })
})

// vi-VN text must already be NFC: the same word in NFD looks identical but
// fails string comparison, search and the checks above.
describe('vi-VN strings are NFC', () => {
  for (const dir of localeDirs) {
    it.skipIf(!existsSync(resolve(dir, 'vi-VN.json')))(`${dir}/vi-VN.json`, () => {
      const notNfc = readStrings(dir, 'vi-VN.json')
        .filter(([, text]) => text !== text.normalize('NFC'))
        .map(([key]) => key)
      expect(notNfc, `not NFC: ${notNfc.join(', ')}`).toEqual([])
    })
  }
})

// French puts a no-break space (U+00A0, or the narrow U+202F) before : ; ? !
// Only punctuation that ends a word is checked: the mark must follow a letter
// or digit (directly or after an ordinary space) and be followed by
// whitespace or the end. That leaves alone `{placeholders}` (stripped), URLs
// and paths (stripped), HTML tags and <code> (stripped) and code-like tokens
// such as `key:value`, `10:30`, `?q=` or `!=`, where the mark is mid-token.
function frenchPunctuationProblems(text: string): string[] {
  const body = text
    // The inter-CLI protocol lines are typed literally: "to:" / "from:" take no space.
    .replace(/---MSG-START---\s*to:|\[Navide MSG\]\s*from:/g, ' ')
    .replace(/<code>[\s\S]*?<\/code>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ')
    .replace(/[^\s<>\u0080-￿]*[/\\][^\s<>\u0080-￿]*/g, ' ')
  return [...body.matchAll(/[\p{L}\p{N}] ?([:;?!])(?=\s|$)/gu)].map((match) => match[0])
}

describe('fr-FR puts a no-break space before : ; ? !', () => {
  for (const dir of localeDirs) {
    it.skipIf(!existsSync(resolve(dir, 'fr-FR.json')))(`${dir}/fr-FR.json`, () => {
      const problems = readStrings(dir, 'fr-FR.json').flatMap(([key, text]) =>
        frenchPunctuationProblems(text).map((hit) => `${key}: "${hit}"`)
      )
      expect(problems, problems.join('\n')).toEqual([])
    })
  }

  it('checks word-final marks and leaves placeholders, URLs and code alone', () => {
    expect(frenchPunctuationProblems('Supprimer ? Oui ! Note : ok')).toEqual([])
    expect(frenchPunctuationProblems('Supprimer ? Oui!')).toEqual(['r ?', 'i!'])
    expect(frenchPunctuationProblems('Erreur: {error}')).toEqual(['r:'])
    expect(frenchPunctuationProblems('{count}? voir https://navide.dev/a?b=1 et `a: b` à 10:30')).toEqual([])
    expect(frenchPunctuationProblems('Première ligne\u00a0: ---MSG-START--- to: architect')).toEqual([])
    expect(frenchPunctuationProblems('[Navide MSG] from: x, puis Note: y')).toEqual(['e:'])
  })
})

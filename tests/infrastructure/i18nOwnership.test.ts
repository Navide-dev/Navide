import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// Each catalog folder belongs to one owner, and an owner renders only its own
// strings plus the shared @navide/plugin-ui ones (the Host merges its catalog
// in src/renderer/src/i18n/hostMessages.ts, each plugin in its own entry).
// So a key the Host references must not live only in a plugin's catalog, and
// a plugin must not reference a Host-only key: that string would render as
// its raw key in the shipped plugin. A Host-only string, in turn, lives
// outside packages/plugin-ui, which is what keeps it out of every plugin's
// fingerprint (scripts/official-plugin-fingerprints.mjs).
const UI = 'packages/plugin-ui/src/foundation/i18n/locales'
const OWNERS: Array<{ name: string; sources: RegExp; catalogs: string[] }> = [
  { name: 'Host', sources: /^src\//, catalogs: [UI, 'src/renderer/src/i18n/locales'] },
  { name: '@navide/plugin-ui', sources: /^packages\/plugin-(ui|contracts|sdk)\//, catalogs: [UI] },
  { name: 'navide-git', sources: /^plugins\/navide-git\//, catalogs: [UI, 'plugins/navide-git/src/locales'] },
  { name: 'navide-mini-ide', sources: /^plugins\/navide-mini-ide\//, catalogs: [UI, 'plugins/navide-mini-ide/src/locales'] },
  { name: 'navide-plans', sources: /^plugins\/navide-plans\//, catalogs: [UI, 'plugins/navide-plans/src/locales'] },
  { name: 'navide-browser', sources: /^plugins\/navide-browser\//, catalogs: [UI, 'plugins/navide-browser/src/locales'] },
]
const ALL_CATALOGS = [...new Set(OWNERS.flatMap(({ catalogs }) => catalogs))]

/** Every leaf and every subtree path, so `t(\`a.${x}\`)` style prefixes count too. */
function paths(dir: string): Set<string> {
  const found = new Set<string>()
  const walk = (value: unknown, prefix: string): void => {
    if (prefix) found.add(prefix)
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) walk(child, prefix ? `${prefix}.${key}` : key)
    }
  }
  walk(JSON.parse(readFileSync(resolve(dir, 'en-US.json'), 'utf8')), '')
  return found
}

const isTest = (file: string): boolean =>
  /(__tests__|\/tests?\/|\.test\.|\.spec\.|\/testing\.ts$|test-fixtures)/.test(file) || file.startsWith('tests/')

// A key-shaped token right after a quote and closed by one. Quotes are not
// paired, so neither an apostrophe in prose nor "$t('a.b')" in a template
// attribute hides a key.
const KEY_TOKEN = /(?<=['"`])([A-Za-z][\w-]*(?:\.[\w-]+)+)(?=['"`])/g

describe('i18n catalog ownership', () => {
  const known = new Set(ALL_CATALOGS.flatMap((dir) => [...paths(dir)]))
  const sources = execFileSync('git', ['ls-files', '-z', '--', 'src', 'packages', 'plugins'], { encoding: 'utf8' })
    .split('\0')
    .filter((file) => /\.(ts|vue|tsx|js|mjs)$/.test(file) && !isTest(file))

  it.each(OWNERS)('$name references only strings it ships', ({ sources: pattern, catalogs }) => {
    const own = new Set(catalogs.flatMap((dir) => [...paths(dir)]))
    const missing = sources.filter((file) => pattern.test(file)).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(KEY_TOKEN)]
        .map(([, key]) => key)
        .filter((key) => known.has(key) && !own.has(key))
        .map((key) => `${file}: ${key}`)
    )
    expect([...new Set(missing)], [...new Set(missing)].join('\n')).toEqual([])
  })

  it('names every catalog folder in the repository', () => {
    const folders = execFileSync('git', ['ls-files', '--', '*/locales/en-US.json'], { encoding: 'utf8' })
      .split('\n').filter(Boolean).map((file) => file.replace(/\/en-US\.json$/, ''))
      .filter((dir) => readdirSync(resolve(dir)).length > 1)
    expect(folders.filter((dir) => !ALL_CATALOGS.includes(dir))).toEqual([])
  })
})

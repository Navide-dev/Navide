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
  { name: 'navide-mini-ide', sources: /^plugins\/navide-mini-ide\//, catalogs: [UI, 'plugins/navide-mini-ide/src/locales'] },
  { name: 'navide-plans', sources: /^plugins\/navide-plans\//, catalogs: [UI, 'plugins/navide-plans/src/locales'] },
  { name: 'navide-browser', sources: /^plugins\/navide-browser\//, catalogs: [UI, 'plugins/navide-browser/src/locales'] },
]
const ALL_CATALOGS = [...new Set(OWNERS.flatMap(({ catalogs }) => catalogs))]
// First-party plugins built in their own repositories still show these
// plugin-ui strings (navide.git: Navide-dev/navide-git). Update the list when
// the pinned version starts or stops using one.
const EXTERNAL_OWNERS = JSON.parse(
  readFileSync(resolve('tests/infrastructure/externalPluginUiKeys.json'), 'utf8'),
) as Record<string, string[]>

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
// The static head of a template key, `t(\`a.b.${x}\`)` -> "a.b.".
const KEY_PREFIX = /(?<=`)([A-Za-z][\w-]*(?:\.[\w-]+)*\.?)(?=\$\{)/g

/** The catalog leaves one owner's sources reference, exactly or by a template prefix. */
function referenced(files: string[], leaves: string[]): Set<string> {
  const used = new Set<string>()
  const leafSet = new Set(leaves)
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const [, key] of text.matchAll(KEY_TOKEN)) {
      if (leafSet.has(key)) used.add(key)
      else for (const leaf of leaves) if (leaf.startsWith(`${key}.`)) used.add(leaf)
    }
    for (const [, prefix] of text.matchAll(KEY_PREFIX)) {
      // A bare namespace (`git.${op}`) is a message type far more often than a key.
      if (!prefix.includes('.') || /^[^.]+\.$/.test(prefix)) continue
      for (const leaf of leaves) if (leaf.startsWith(prefix)) used.add(leaf)
    }
  }
  return used
}

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

  it('keeps in @navide/plugin-ui only strings more than one owner shows', () => {
    // A string only the Host (or only one plugin) shows belongs in that owner's
    // catalog: in plugin-ui it would move every plugin's fingerprint.
    const leaves = [...paths(UI)].filter((path) => {
      let value: unknown = JSON.parse(readFileSync(resolve(UI, 'en-US.json'), 'utf8'))
      for (const part of path.split('.')) value = (value as Record<string, unknown>)[part]
      return typeof value === 'string'
    })
    const users = new Map<string, string[]>()
    for (const { name, sources: pattern } of OWNERS) {
      for (const key of referenced(sources.filter((file) => pattern.test(file)), leaves)) {
        users.set(key, [...(users.get(key) ?? []), name])
      }
    }
    for (const [name, keys] of Object.entries(EXTERNAL_OWNERS)) {
      expect(keys.filter((key) => !leaves.includes(key)), `${name} lists strings plugin-ui does not have`).toEqual([])
      for (const key of keys) users.set(key, [...(users.get(key) ?? []), name])
    }
    const misplaced = leaves
      .map((key) => [key, users.get(key) ?? []] as const)
      .filter(([, owners]) => owners.length === 1 && owners[0] !== '@navide/plugin-ui')
      .map(([key, owners]) => `${key}: only ${owners[0]} uses it`)
    expect(misplaced, misplaced.join('\n')).toEqual([])
  })

  it('names every catalog folder in the repository', () => {
    const folders = execFileSync('git', ['ls-files', '--', '*/locales/en-US.json'], { encoding: 'utf8' })
      .split('\n').filter(Boolean).map((file) => file.replace(/\/en-US\.json$/, ''))
      .filter((dir) => readdirSync(resolve(dir)).length > 1)
    expect(folders.filter((dir) => !ALL_CATALOGS.includes(dir))).toEqual([])
  })
})
